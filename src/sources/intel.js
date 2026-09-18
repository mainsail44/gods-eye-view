export const INTEL_HEALTH_PATH = '/health';
export const INTEL_QUERY_PATH = '/query';

const EGRESS_STATES = new Set(['blocked', 'allowed']);
const ATTESTATION_STATES = new Set(['verified', 'unverified']);
const MAX_ANSWER_CHARS = 4000;
const MAX_CITATIONS = 50;

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Normalize the service health payload; anything unusable reports not ok. */
export function normalizeIntelHealth(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const model = text(source.model, 120);
  const runtime = text(source.runtime, 120);
  const corpus =
    source.corpus && typeof source.corpus === 'object' ? source.corpus : {};
  const egress = text(source.egress, 16);
  const attestation = text(source.attestation, 16);
  return Object.freeze({
    ok: Boolean(model),
    model,
    runtime,
    corpusVersion: text(corpus.version, 64),
    corpusChecksum: text(corpus.checksum, 128),
    egress: EGRESS_STATES.has(egress) ? egress : 'unknown',
    attestation: ATTESTATION_STATES.has(attestation)
      ? attestation
      : 'unavailable',
  });
}

const citation = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const id = text(entry.id, 120);
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!id) return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  return Object.freeze({ id, label: text(entry.label, 200), lat, lon });
};

/** Normalize an answer, discarding citations that cannot be placed on the globe. */
export function normalizeIntelAnswer(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const citations = Array.isArray(source.citations) ? source.citations : [];
  return Object.freeze({
    answer: text(source.answer, MAX_ANSWER_CHARS),
    citations: Object.freeze(
      citations.slice(0, MAX_CITATIONS).map(citation).filter(Boolean),
    ),
    actions: Object.freeze(
      Array.isArray(source.actions) ? [...source.actions] : [],
    ),
  });
}

/** Build a bounded query body; a blank question is a programming error. */
export function buildIntelQueryBody(question, { limit = 8 } = {}) {
  const trimmed = text(question, 500);
  if (!trimmed) throw new TypeError('A question is required');
  // `Number(limit) || 8` would swallow a caller's explicit 0 and widen the
  // request to 8; clamp a finite value instead, however small.
  const requested = Number(limit);
  const bounded = Number.isFinite(requested)
    ? Math.min(50, Math.max(1, Math.trunc(requested)))
    : 8;
  return { question: trimmed, limit: bounded };
}
