import { intelUrl } from '../../src/sources/intelEndpoint.js';
import {
  INTEL_HEALTH_PATH,
  INTEL_QUERY_PATH,
  buildIntelQueryBody,
} from '../../src/sources/intel.js';

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
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
