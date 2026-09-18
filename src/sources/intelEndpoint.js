/** Normalize a local inference base URL to an absolute origin with no trailing slash. */
export function resolveIntelBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new TypeError('An intel base URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`Intel base URL must be absolute: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new TypeError(`Intel base URL must be http or https: ${raw}`);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Join a request path onto a normalized base URL exactly once. */
export function intelUrl(baseUrl, path) {
  const base = resolveIntelBaseUrl(baseUrl);
  return `${base}/${String(path ?? '').replace(/^\/+/, '')}`;
}
