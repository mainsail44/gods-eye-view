import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intelUrl } from '../../src/sources/intelEndpoint.js';
import { CIPHER, isEnvelope, open as openEnvelope, seal } from '../../services/intel/src/qryptCipher.js';
import {
  INTEL_HEALTH_PATH,
  INTEL_QUERY_PATH,
  buildIntelQueryBody,
} from '../../src/sources/intel.js';

// Matches the intel service's own request body cap (see server/providers
// for the service's 413 threshold); kept in sync deliberately.
const MAX_REQUEST_BODY_BYTES = 65536;
const BODY_TOO_LARGE = Symbol('sovereign-body-too-large');

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

// Bounds memory use as chunks arrive rather than buffering an oversized
// body in full: this proxy runs inside the process that serves production
// traffic, so an unbounded accumulation here is a shared-process risk.
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) return resolve(BODY_TOO_LARGE);
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
            : {},
        );
      } catch {
        resolve(null);
      }
    });
  });

// A local model that reasons before answering is slow: a grounded question
// against gemma4:e4b on a workstation GPU takes 20-60 s, so the old 10 s
// budget turned a working answer into a 503. Override with
// STARLIGHT_INTEL_TIMEOUT_MS when a runtime is faster or slower than that.
const DEFAULT_TIMEOUT_MS = 120_000;

// The app side of the quantum-derived link key: 32 bytes from Qrypt BLAST
// (gen_init_otp), written by scripts/qrypt-intel-key.sh and mounted read-only.
// Read per call so a rotation needs no restart. Absent key = unsecured link.
const QRYPT_KEY_DIR = process.env.QRYPT_KEY_DIR || '';
export function readQryptAppKey(dir = QRYPT_KEY_DIR) {
  if (!dir) return null;
  try {
    const key = readFileSync(join(dir, 'app.key'), 'utf8').trim();
    let status = {};
    try {
      status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    } catch {
      /* status is informational */
    }
    return key ? { key, status } : null;
  } catch {
    return null;
  }
}

/** Fold the link-key state into the intel service's health report. */
export function describeQryptLink(health, app) {
  const remote = health?.qrypt && typeof health.qrypt === 'object' ? health.qrypt : {};
  const st = app?.status || {};
  const appFp = st.fingerprint || '';
  const intelFp = remote.fingerprint || '';
  const status = !app || !intelFp ? 'unsecured' : appFp && appFp === intelFp ? 'secure' : 'mismatch';
  return {
    ...remote,
    status,
    app_fingerprint: appFp,
    cipher: status === 'secure' ? remote.cipher || CIPHER : 'none',
    rotated_at: st.rotated_at || remote.rotated_at || '',
    next_rotation_at: st.next_rotation_at || '',
    origin: st.origin || remote.origin || '',
    region: st.region || '',
    sources: st.sources ?? remote.sources ?? 0,
    sources_detail: Array.isArray(st.sources_detail) ? st.sources_detail.slice(0, 16) : [],
    key_bits: st.key_bits || 256,
    metadata_bytes: st.metadata_bytes || 0,
    ttl: st.ttl || 0,
    init_ms: st.init_ms || 0,
    sync_ms: st.sync_ms || 0,
    sdk: st.sdk || remote.sdk || '',
    protocol: st.protocol || '',
  };
}

/** Positive, finite milliseconds from the environment, or the default. */
function configuredTimeoutMs(value = process.env.STARLIGHT_INTEL_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Bridge the browser to the intel service. An unreachable service is a
 * degraded state, not an error: the map keeps working without it.
 */
export function createSovereignMiddleware({
  baseUrl = process.env.STARLIGHT_INTEL_URL || '',
  timeoutMs = configuredTimeoutMs(),
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function middleware(req, res, next) {
    const path = String(req.url || '').split('?')[0];
    const isHealth = req.method === 'GET' && path === INTEL_HEALTH_PATH;
    const isQuery = req.method === 'POST' && path === INTEL_QUERY_PATH;
    if (!isHealth && !isQuery) return next();

    if (!baseUrl)
      return send(res, 503, {
        ok: false,
        reason: 'Intel service is not configured',
      });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      if (isHealth) {
        response = await fetchImpl(intelUrl(baseUrl, INTEL_HEALTH_PATH), {
          signal: controller.signal,
        });
        const health = await response.json();
        if (health && typeof health === 'object')
          health.qrypt = describeQryptLink(health, readQryptAppKey());
        return send(res, response.status ?? 200, health);
      } else {
        const body = await readBody(req);
        if (body === BODY_TOO_LARGE)
          return send(res, 413, { error: 'Request body too large' });
        let payload;
        try {
          payload = buildIntelQueryBody(body?.question, { limit: body?.limit });
        } catch {
          return send(res, 400, { error: 'A question is required' });
        }
        // With a link key the query travels sealed under AES-256-GCM and the
        // answer comes back the same way; without one it is plain JSON.
        const app = readQryptAppKey();
        response = await fetchImpl(intelUrl(baseUrl, INTEL_QUERY_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(app ? seal(payload, app.key) : payload),
          signal: controller.signal,
        });
        let answer = await response.json();
        if (isEnvelope(answer)) {
          answer = app ? openEnvelope(answer, app.key) : null;
          if (!answer)
            return send(res, 502, { error: 'Could not open the sealed intel answer' });
        }
        return send(res, response.status ?? 200, answer);
      }
      return send(res, response.status ?? 200, await response.json());
    } catch {
      return send(res, 503, { ok: false, reason: 'Intel service unreachable' });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function sovereignIntelProxy(options = {}) {
  const middleware = createSovereignMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/intel', middleware);
  };
  return {
    name: 'sovereign-intel-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
