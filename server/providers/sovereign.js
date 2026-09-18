import { intelUrl } from '../../src/sources/intelEndpoint.js';
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

/**
 * Bridge the browser to the intel service. An unreachable service is a
 * degraded state, not an error: the map keeps working without it.
 */
export function createSovereignMiddleware({
  baseUrl = process.env.STARLIGHT_INTEL_URL || '',
  timeoutMs = 10_000,
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
        response = await fetchImpl(intelUrl(baseUrl, INTEL_QUERY_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
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
