export const INTEL_HEALTH_PATH = '/health';
export const INTEL_QUERY_PATH = '/query';

const EGRESS_STATES = new Set(['blocked', 'allowed']);
const ATTESTATION_STATES = new Set(['verified', 'unverified']);
const MAX_ANSWER_CHARS = 4000;
const MAX_CITATIONS = 50;
const MAX_TRACE_STEPS = 12;
const ACTION_TYPES = new Set(['fly', 'frame', 'place']);
const PLACE_KINDS = new Set(['place', 'district', 'region', 'country']);

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const number = (value, { min = -Infinity, max = Infinity } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
};

const point = (lat, lon) => {
  const latitude = number(lat);
  const longitude = number(lon);
  if (latitude === null || Math.abs(latitude) > 90) return null;
  if (longitude === null || Math.abs(longitude) > 180) return null;
  return { lat: latitude, lon: longitude };
};

/** Normalize the service health payload; anything unusable reports not ok. */
export function normalizeIntelHealth(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const model = text(source.model, 120);
  const runtime = text(source.runtime, 120);
  const corpus =
    source.corpus && typeof source.corpus === 'object' ? source.corpus : {};
  const reader =
    source.reader && typeof source.reader === 'object' ? source.reader : {};
  const embeddings =
    source.embeddings && typeof source.embeddings === 'object'
      ? source.embeddings
      : {};
  const gazetteer =
    source.gazetteer && typeof source.gazetteer === 'object'
      ? source.gazetteer
      : {};
  const egress = text(source.egress, 16);
  const attestation = text(source.attestation, 16);
  return Object.freeze({
    ok: Boolean(model),
    model,
    runtime,
    corpusVersion: text(corpus.version, 64),
    corpusChecksum: text(corpus.checksum, 128),
    corpusRecords: number(corpus.records, { min: 0 }) ?? 0,
    readerModel: text(reader.model, 120),
    embeddingModel: text(embeddings.model, 120),
    embeddingsReady: embeddings.ready === true,
    embeddingsIndexed: number(embeddings.indexed, { min: 0 }) ?? 0,
    gazetteerPlaces: number(gazetteer.places, { min: 0 }) ?? 0,
    egress: EGRESS_STATES.has(egress) ? egress : 'unknown',
    attestation: ATTESTATION_STATES.has(attestation)
      ? attestation
      : 'unavailable',
  });
}

/** Why a record was retrieved, as the service explains it. */
const why = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const km = number(entry.km, { min: 0 });
  const similarity = number(entry.similarity, { min: -1, max: 1 });
  const terms = Array.isArray(entry.terms)
    ? entry.terms
        .map((term) => text(term, 40))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  return Object.freeze({
    ...(km !== null ? { km } : {}),
    ...(similarity !== null ? { similarity } : {}),
    ...(terms.length ? { terms: Object.freeze(terms) } : {}),
  });
};

const citation = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const id = text(entry.id, 120);
  const at = point(entry.lat, entry.lon);
  if (!id || !at) return null;
  const kind = text(entry.kind, 24);
  return Object.freeze({
    id,
    label: text(entry.label, 200),
    kind:
      kind === 'landing-point'
        ? 'landing-point'
        : kind === 'datacenter'
          ? 'datacenter'
          : '',
    lat: at.lat,
    lon: at.lon,
    operator: text(entry.operator, 120),
    city: text(entry.city, 80),
    region: text(entry.region, 80),
    country: text(entry.country, 80),
    why: why(entry.why),
  });
};

/** The place the question was resolved to, if the service resolved one. */
export const normalizeIntelPlace = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const at = point(entry.lat, entry.lon);
  const name = text(entry.name, 120);
  if (!at || !name) return null;
  const kind = text(entry.kind, 16);
  const radiusKm = number(entry.radiusKm, { min: 0, max: 20000 });
  return Object.freeze({
    kind: PLACE_KINDS.has(kind) ? kind : 'place',
    name,
    region: text(entry.region, 80),
    country: text(entry.country, 80),
    lat: at.lat,
    lon: at.lon,
    radiusKm: radiusKm ?? 0,
    confidence:
      text(entry.confidence, 16) === 'ambiguous' ? 'ambiguous' : 'exact',
  });
};

/**
 * A camera or marker action the service proposes. Ids are kept only when
 * they name a citation in the same answer, so an action can never send the
 * camera to a record the operator cannot see.
 */
const action = (entry, citationIds) => {
  if (!entry || typeof entry !== 'object') return null;
  const type = text(entry.type, 16);
  if (!ACTION_TYPES.has(type)) return null;
  if (type === 'fly') {
    const id = text(entry.id, 120);
    return citationIds.has(id) ? Object.freeze({ type, id }) : null;
  }
  if (type === 'frame') {
    const ids = (Array.isArray(entry.ids) ? entry.ids : [])
      .map((id) => text(id, 120))
      .filter((id) => citationIds.has(id));
    return ids.length
      ? Object.freeze({ type, ids: Object.freeze([...new Set(ids)]) })
      : null;
  }
  const place = normalizeIntelPlace(entry);
  return place ? Object.freeze({ type, ...place }) : null;
};

/** How the service read the question, for the panel to show its working. */
const reading = (entry) => {
  const source = entry && typeof entry === 'object' ? entry : {};
  return Object.freeze({
    place: text(source.place, 120),
    region: text(source.region, 120),
    country: text(source.country, 120),
    entityType: text(source.entityType, 20),
    operator: text(source.operator, 120),
    intent: text(source.intent, 20),
    radiusKm: number(source.radiusKm, { min: 0, max: 20000 }) ?? 0,
  });
};

const traceStep = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const step = text(entry.step, 16);
  if (!step) return null;
  return Object.freeze({
    step,
    ms: number(entry.ms, { min: 0 }) ?? 0,
    detail: text(entry.detail, 200),
  });
};

/** Normalize an answer, discarding citations that cannot be placed on the globe. */
export function normalizeIntelAnswer(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const citations = Object.freeze(
    (Array.isArray(source.citations) ? source.citations : [])
      .slice(0, MAX_CITATIONS)
      .map(citation)
      .filter(Boolean),
  );
  const citationIds = new Set(citations.map((entry) => entry.id));
  const actions = Object.freeze(
    (Array.isArray(source.actions) ? source.actions : [])
      .map((entry) => action(entry, citationIds))
      .filter(Boolean),
  );
  return Object.freeze({
    answer: text(source.answer, MAX_ANSWER_CHARS),
    citations,
    actions,
    reading: reading(source.reading),
    place: normalizeIntelPlace(source.place),
    trace: Object.freeze(
      (Array.isArray(source.trace) ? source.trace : [])
        .slice(0, MAX_TRACE_STEPS)
        .map(traceStep)
        .filter(Boolean),
    ),
  });
}

/**
 * Build a bounded query body; a blank question is a programming error. Five
 * records, not eight: a local model answers in proportion to what it is shown,
 * and the three extra records doubled the wait for an answer nobody read.
 */
export function buildIntelQueryBody(question, { limit = 5 } = {}) {
  const trimmed = text(question, 500);
  if (!trimmed) throw new TypeError('A question is required');
  // `Number(limit) || 5` would swallow a caller's explicit 0 and widen the
  // request to 5; clamp a finite value instead, however small.
  const requested = Number(limit);
  const bounded = Number.isFinite(requested)
    ? Math.min(50, Math.max(1, Math.trunc(requested)))
    : 5;
  return { question: trimmed, limit: bounded };
}
