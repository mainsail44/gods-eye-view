import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusChecksum, selectRetrievalMode } from './corpus.js';
import { CIPHER, isEnvelope, open as openEnvelope, seal } from './qryptCipher.js';

// The intel side of the quantum-derived link key: the same 32 bytes the app
// holds, re-derived here by Qrypt BLAST gen_sync from non-secret metadata
// (scripts/qrypt-intel-key.sh). Read per call so a rotation needs no restart.
const QRYPT_KEY_DIR = process.env.INTEL_QRYPT_KEY_DIR || '';
export function readQryptIntelKey(dir = QRYPT_KEY_DIR) {
  if (!dir) return null;
  try {
    const key = readFileSync(join(dir, 'intel.key'), 'utf8').trim();
    let status = {};
    try {
      status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    } catch {
      /* informational */
    }
    return key ? { key, status } : null;
  } catch {
    return null;
  }
}


import { EMPTY_READING, isEmptyReading } from './reader.js';
import { indexCorpus, retrieveHybrid } from './retrieval.js';

/** Reject a request body larger than this before it is ever parsed. */
const MAX_BODY_BYTES = 65536; // 64 KB
/** Reject a question longer than this before any retrieval work runs. */
const MAX_QUESTION_LENGTH = 2000;

/** Sentinel distinguishing "body exceeded the size cap" from invalid JSON or an empty body. */
const TOO_LARGE = Symbol('too-large');

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating as soon as the cap is crossed; drop what we have.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) return resolve(TOO_LARGE);
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

const sendPlain = (res, status, payload, headers = {}) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
};

/** What the panel shows and flies to for one record. */
export const citationOf = (record) => ({
  id: record.id,
  label: record.label,
  kind: record.kind ?? '',
  lat: record.lat,
  lon: record.lon,
  ...(record.operator ? { operator: record.operator } : {}),
  ...(record.city ? { city: record.city } : {}),
  ...(record.region ? { region: record.region } : {}),
  ...(record.country ? { country: record.country } : {}),
  ...(record.why ? { why: record.why } : {}),
});

/** The place a question was resolved to, as the panel marks it. */
export const placeOf = (place) =>
  place
    ? {
        kind: place.kind,
        name: place.name,
        region: place.region ?? '',
        country: place.country ?? '',
        lat: place.lat,
        lon: place.lon,
        ...(place.radiusKm ? { radiusKm: place.radiusKm } : {}),
        confidence: place.confidence ?? 'exact',
      }
    : null;

/**
 * What the globe should do with an answer. The model says whether one record
 * is the answer or several are; the service turns that into actions the
 * application understands, never trusting an id the model did not get.
 * @param {{camera?: string, focusId?: string}} verdict From the model.
 * @param {object[]} citations In the order they will be shown.
 * @param {object|null} place The resolved place, if any.
 */
export function deriveActions(verdict, citations, place) {
  const actions = [];
  const ids = new Set(citations.map((citation) => citation.id));
  const camera = verdict?.camera ?? '';
  const focus = ids.has(verdict?.focusId) ? verdict.focusId : citations[0]?.id;
  if (camera === 'site' && focus) actions.push({ type: 'fly', id: focus });
  else if (camera === 'frame_all' && citations.length)
    actions.push({ type: 'frame', ids: citations.map((citation) => citation.id) });
  else if (camera !== 'none' && citations.length > 1)
    actions.push({ type: 'frame', ids: citations.map((citation) => citation.id) });
  else if (camera !== 'none' && focus) actions.push({ type: 'fly', id: focus });
  if (place) actions.push({ type: 'place', ...placeOf(place) });
  return actions;
}

const describeReading = (reading) =>
  [
    [reading.place, reading.region, reading.country].filter(Boolean).join(', ') ||
      'no place',
    reading.entityType === 'any' ? 'any record' : `${reading.entityType}s`,
    reading.operator && `operator ${reading.operator}`,
    reading.intent,
    reading.radiusKm ? `${reading.radiusKm} km` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const describePlace = (place) =>
  place
    ? `${[place.name, place.region, place.country].filter(Boolean).join(', ')} ` +
      `(${place.lat.toFixed(2)}, ${place.lon.toFixed(2)})` +
      (place.radiusKm ? ` ±${place.radiusKm} km` : '') +
      (place.confidence === 'ambiguous' ? ' — assumed' : '')
    : 'no place resolved';

/**
 * Build the request handler. `answer` performs model inference and is injected
 * so routing and the decline-on-empty rule stay testable without a model.
 *
 * @param {object} options
 * @param {object[]} options.corpus
 * @param {string} options.model Answering model, reported on /health.
 * @param {string} options.runtime
 * @param {string} [options.egress]
 * @param {string} [options.attestation]
 * @param {Function} options.answer `({question, mode, records, reading, place}) => {answer, usedIds?, camera?, focusId?, model?}`
 * @param {Function} [options.reader] `(question) => {reading, source, ms}`; none skips reading.
 * @param {string} [options.readerModel] Reported on /health.
 * @param {object} [options.gazetteer] From gazetteer.js; none skips place resolution.
 * @param {() => object|null} [options.embeddings] The vector index once built; null until then.
 * @param {() => object} [options.embeddingsStatus] For /health while the index builds.
 */
export function createIntelHandler({
  corpus = [],
  model,
  runtime,
  egress = 'unknown',
  attestation = 'unavailable',
  answer,
  reader = null,
  readerModel = '',
  gazetteer = null,
  embeddings = () => null,
  embeddingsStatus = () => null,
}) {
  const checksum = corpusChecksum(corpus);
  const version = new Date().toISOString().slice(0, 10);
  const postings = indexCorpus(corpus);

  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    // Replies on a keyed link go back inside the same AES-256-GCM envelope.
    const send = (target, status, payload) =>
      target.__qryptKey
        ? sendPlain(target, status, seal(payload, target.__qryptKey), { 'X-Qrypt-Cipher': CIPHER })
        : sendPlain(target, status, payload);

    if (req.method === 'GET' && path === '/health') {
      const index = embeddings();
      const qk = readQryptIntelKey();
      return send(res, 200, {
        qrypt: qk
          ? {
              fingerprint: qk.status.fingerprint || '',
              rotated_at: qk.status.rotated_at || '',
              origin: qk.status.origin || '',
              sources: qk.status.sources ?? 0,
              sdk: qk.status.sdk || '',
              cipher: CIPHER,
              required: true,
            }
          : { required: false },
        model,
        runtime,
        egress,
        attestation,
        corpus: { version, checksum, records: corpus.length },
        reader: { model: reader ? readerModel || model : null },
        embeddings: index
          ? { model: index.model, ready: true, indexed: index.size, dims: index.dims }
          : (embeddingsStatus() ?? { model: null, ready: false, indexed: 0 }),
        gazetteer: { places: gazetteer?.size ?? 0 },
      });
    }

    if (req.method === 'POST' && path === '/query') {
      const qk = readQryptIntelKey();
      let body = await readBody(req);
      if (qk) {
        // A keyed link only accepts sealed queries; a wrong key cannot open them.
        const payload = isEnvelope(body) ? openEnvelope(body, qk.key) : null;
        if (!payload)
          return send(res, 401, { error: 'Quantum link key missing or mismatched' });
        body = payload;
        res.__qryptKey = qk.key;
      }
      if (body === TOO_LARGE)
        return send(res, 413, { error: 'Request body too large' });
      const question = String(body?.question ?? '').trim();
      if (!question) return send(res, 400, { error: 'A question is required' });
      if (question.length > MAX_QUESTION_LENGTH)
        return send(res, 400, { error: 'Question too long' });
      const requested = Number(body?.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(50, Math.max(1, Math.trunc(requested)))
        : 5;
      const mode = selectRetrievalMode(question);
      const trace = [];

      // 1. The model reads the question.
      const read = reader
        ? await reader(question)
        : { reading: EMPTY_READING, source: 'none', ms: 0 };
      const reading = read.reading ?? EMPTY_READING;
      if (reader)
        trace.push({
          step: 'read',
          ms: read.ms,
          detail: read.source === 'model' ? describeReading(reading) : `no reading (${read.error ?? read.source})`,
        });

      // 2. The gazetteer places it.
      let place = null;
      if (gazetteer && !isEmptyReading(reading)) {
        const started = Date.now();
        place = gazetteer.resolve(reading) ?? null;
        trace.push({ step: 'resolve', ms: Date.now() - started, detail: describePlace(place) });
      }

      // 3. Meaning, words and distance find the records.
      const started = Date.now();
      let similar = null;
      const index = embeddings();
      if (index) {
        try {
          similar = index.search(await index.embedQuery(question), 50);
        } catch {
          similar = null;
        }
      }
      const retrieved = retrieveHybrid({
        corpus,
        postings,
        question,
        reading,
        place,
        similar,
        limit,
      });
      const records = retrieved.records;
      trace.push({
        step: 'retrieve',
        ms: Date.now() - started,
        detail:
          `${records.length} of ${corpus.length} records` +
          (retrieved.signals.length ? ` · ${retrieved.signals.join(' + ')}` : '') +
          (retrieved.radiusKm ? ` · within ${Math.round(retrieved.radiusKm)} km` : ''),
      });

      const common = {
        reading,
        place: placeOf(place),
        trace,
        corpus: { version, checksum },
      };

      // Declining beats guessing: an unsupported answer is worse than none.
      if (!records.length) {
        return send(res, 200, {
          answer: place
            ? `No matching records within ${Math.round(retrieved.radiusKm ?? 0)} km of ${place.name}.`
            : 'No matching records in the local corpus.',
          citations: [],
          actions: place ? [{ type: 'place', ...placeOf(place) }] : [],
          ...common,
        });
      }

      // 4. The model answers from them and says which ones it used.
      const answering = Date.now();
      const result = await answer({ question, mode, records, reading, place });
      const usedIds = Array.isArray(result?.usedIds) ? result.usedIds : [];
      const byId = new Map(records.map((record) => [record.id, record]));
      // The records the model relied on lead; the rest of the retrieval
      // follows, so a citation the model ignored is still reachable.
      const ordered = [
        ...usedIds.map((id) => byId.get(id)).filter(Boolean),
        ...records.filter((record) => !usedIds.includes(record.id)),
      ];
      const citations = ordered.map(citationOf);
      trace.push({
        step: 'answer',
        ms: Date.now() - answering,
        detail: `${result?.model ?? model} · ${usedIds.filter((id) => byId.has(id)).length || records.length} records used`,
      });
      return send(res, 200, {
        answer: String(result?.answer ?? ''),
        citations,
        actions: deriveActions(result, citations, place),
        ...common,
      });
    }

    return send(res, 404, { error: 'Not found' });
  };
}
