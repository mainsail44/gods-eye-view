import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createIntelHandler } from './server.js';
import { probeEgress } from './egress.js';
import { corpusChecksum } from './corpus.js';
import { createGazetteer } from './gazetteer.js';
import { buildEmbeddingIndex } from './embeddings.js';
import { readQuestion } from './reader.js';
import { intelUrl } from '../../../src/sources/intelEndpoint.js';

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.INTEL_MODEL || 'unknown';
const RUNTIME_URL = process.env.INTEL_RUNTIME_URL || 'http://127.0.0.1:11434';
const RUNTIME = process.env.INTEL_RUNTIME || 'openai-compatible';
const CORPUS_PATH = process.env.INTEL_CORPUS || '/app/corpus/corpus.json';
const EGRESS = process.env.INTEL_EGRESS || 'unknown';
/** Address the `auto` egress check dials; never contacted otherwise. */
const EGRESS_PROBE = process.env.INTEL_EGRESS_PROBE || '1.1.1.1:443';
/**
 * Sent as the standard `reasoning_effort` field. A local model that reasons
 * before answering spends most of its time there — 80 seconds against 17 for
 * the same grounded answer — so `none` is the default. Set the variable to an
 * empty string to send no such field at all, for a runtime that rejects it.
 */
const REASONING_EFFORT = process.env.INTEL_REASONING_EFFORT ?? 'none';
/**
 * How often to nudge the runtime so the model stays resident. Ollama evicts
 * after five idle minutes and ignores `keep_alive` over its OpenAI-compatible
 * endpoint, and a cold first answer costs the better part of a minute. Set 0
 * to never ping.
 */
const KEEP_WARM_MS = Number(process.env.INTEL_KEEP_WARM_MS ?? 240_000);
/**
 * How many records the model is shown, however many the panel cites. It
 * answers in proportion to what it is given, and the citation list beneath the
 * answer is what the operator actually clicks.
 */
const MODEL_RECORDS = Number(process.env.INTEL_MODEL_RECORDS ?? 5);
/**
 * The model that reads the question before retrieval. Defaults to the
 * answering model; set to an empty string to skip reading altogether.
 */
const READER_MODEL = process.env.INTEL_READER_MODEL ?? MODEL;
/**
 * The embedding model behind the vector index. Empty disables vectors:
 * retrieval then runs on place and words alone.
 */
const EMBED_MODEL = process.env.INTEL_EMBED_MODEL ?? '';
/** Where the vector index is cached between restarts; a compose volume. */
const EMBED_CACHE = process.env.INTEL_EMBED_CACHE ?? '/app/cache';
/** The vendored GeoNames slice; empty disables place resolution. */
const GAZETTEER_DIR = process.env.INTEL_GAZETTEER ?? '/app/gazetteer';

/**
 * The model's brief. Without the sentences about ids and coordinates it
 * echoed every record back with its id and coordinates — a 94-second answer
 * nobody could read, when the interface was already showing those records as
 * clickable sources. It now also says which records it used and how the
 * globe should frame them, so the camera follows the answer.
 */
const SYSTEM_PROMPT = [
  'You answer questions about local infrastructure records — datacenters and submarine cable landing points.',
  'Answer only from the records provided; never invent a location.',
  'Write at most three short sentences of plain prose, naming the sites that matter and giving distances where they help.',
  'Never list record ids or coordinates, and never repeat the records back: the interface already shows them as sources beneath your answer.',
  'If the records do not answer the question, say so plainly in one sentence and mention the closest thing they do show.',
  'Reply as JSON with: answer (the prose); used_ids (the ids of the records your answer relies on, most relevant first, empty if none); camera ("site" when one record is the answer, "frame_all" when several are, "none" when the records do not answer); focus_id (the id to centre on when camera is "site", else an empty string).',
].join(' ');

const ANSWER_SCHEMA = {
  name: 'grounded_answer',
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      used_ids: { type: 'array', items: { type: 'string' } },
      camera: { type: 'string', enum: ['site', 'frame_all', 'none'] },
      focus_id: { type: 'string' },
    },
    required: ['answer', 'used_ids', 'camera', 'focus_id'],
  },
};

/** Exit with one readable line: a stack trace teaches a container operator nothing. */
function fail(message) {
  console.error(`[intel] ${message}`);
  process.exit(1);
}

/** Read the corpus baked into the image, failing loudly but legibly. */
async function loadCorpus(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return fail(
      `cannot read the corpus at ${file} (${error.code ?? error.message}). ` +
        'It is built into the image; rebuild with `podman compose --profile intel build`.',
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed;
  } catch (error) {
    return fail(
      `the corpus at ${file} is not a usable JSON array: ${error.message}`,
    );
  }
}

/** The gazetteer is optional at runtime: without it, no place resolution. */
async function loadGazetteer(directory) {
  if (!directory) return null;
  try {
    const [places, admin1, admin2, countries] = await Promise.all([
      readFile(path.join(directory, 'places.tsv.gz')).then((buffer) =>
        gunzipSync(buffer).toString('utf8'),
      ),
      readFile(path.join(directory, 'admin1.tsv'), 'utf8'),
      // Districts are optional: an older slice without them still serves.
      readFile(path.join(directory, 'admin2.tsv'), 'utf8').catch(() => ''),
      readFile(path.join(directory, 'countries.tsv'), 'utf8'),
    ]);
    return createGazetteer({ places, admin1, admin2, countries });
  } catch (error) {
    console.error(
      `[intel] no gazetteer at ${directory} (${error.code ?? error.message}); place resolution is off`,
    );
    return null;
  }
}

const corpus = await loadCorpus(CORPUS_PATH);
const checksum = corpusChecksum(corpus);
const gazetteer = await loadGazetteer(GAZETTEER_DIR);
const egress = EGRESS === 'auto' ? await probeEgress(EGRESS_PROBE) : EGRESS;
if (EGRESS === 'auto')
  console.log(`[intel] egress ${egress} - probed ${EGRESS_PROBE}`);

/** One request body, so the warm-up and a real question agree on the model. */
const completionBody = (messages, extra = {}) =>
  JSON.stringify({
    model: MODEL,
    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
    ...extra,
    messages,
  });

const completionsUrl = () => intelUrl(RUNTIME_URL, '/v1/chat/completions');

/** Questions in flight; the keep-warm ping stays out of their way. */
let answering = 0;

/**
 * Load the model before anyone asks, and keep it loaded. Fire and forget: it
 * never blocks startup or /health, and a runtime that is not up yet simply
 * gets tried again on the next tick.
 */
function keepWarm() {
  if (answering) return;
  fetch(completionsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: completionBody([{ role: 'user', content: 'ok' }], { max_tokens: 1 }),
  }).catch(() => {});
}

/**
 * The vector index, built in the background after the server is listening so
 * a cold start never delays /health. Served from the cache volume on every
 * later start. Until it is ready, retrieval runs on place and words.
 */
let embeddingIndex = null;
const embeddingStatus = { model: EMBED_MODEL || null, ready: false, indexed: 0, total: corpus.length };
async function buildVectors() {
  if (!EMBED_MODEL) return;
  const started = Date.now();
  try {
    embeddingIndex = await buildEmbeddingIndex({
      corpus,
      checksum,
      model: EMBED_MODEL,
      runtimeUrl: RUNTIME_URL,
      cacheDir: EMBED_CACHE,
      onProgress: (done) => {
        embeddingStatus.indexed = done;
      },
    });
    embeddingStatus.ready = true;
    embeddingStatus.indexed = embeddingIndex.size;
    console.log(
      `[intel] vectors ready - ${embeddingIndex.size} records x ${embeddingIndex.dims} dims ` +
        `(${embeddingIndex.fromCache ? 'from cache' : 'embedded'}) in ${Date.now() - started} ms`,
    );
  } catch (error) {
    embeddingStatus.error = String(error?.message ?? error).slice(0, 200);
    console.error(`[intel] vectors unavailable: ${embeddingStatus.error}; retrying in 60 s`);
    setTimeout(buildVectors, 60_000).unref();
  }
}

/** A record as the model sees it: what it is, where it is, how far from the place asked about. */
const describeRecord = (record, place) =>
  `- ${record.id}: ${record.label} - ${record.text ?? ''}` +
  (place && Number.isFinite(record.why?.km)
    ? ` [${record.why.km} km from ${place.name}]`
    : '');

/**
 * Ask the local runtime to answer strictly from the retrieved records, as
 * JSON that also names the records it used. A runtime that answers in prose
 * instead — the schema ignored, or unsupported — still yields an answer: the
 * prose is taken as is and the citations fall back to the retrieval order.
 */
async function answer({ question, records, place }) {
  const context = records
    .slice(0, MODEL_RECORDS)
    .map((record) => describeRecord(record, place))
    .join('\n');
  const asked = place
    ? `Question: ${question}\n(The place asked about resolved to ${[place.name, place.region, place.country].filter(Boolean).join(', ')}.)`
    : `Question: ${question}`;
  answering += 1;
  const response = await fetch(completionsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: completionBody(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Records:\n${context}\n\n${asked}` },
      ],
      { response_format: { type: 'json_schema', json_schema: ANSWER_SCHEMA } },
    ),
  }).finally(() => {
    answering -= 1;
  });
  // A runtime that rejects the call (a model name it does not have, say) must
  // surface as an error, not as an empty answer bubble in the panel.
  if (!response.ok)
    throw new Error(
      `runtime ${RUNTIME_URL} returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content ?? '');
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.answer !== 'string')
      throw new Error('not a grounded answer');
    return {
      answer: parsed.answer,
      usedIds: Array.isArray(parsed.used_ids) ? parsed.used_ids.map(String) : [],
      camera: parsed.camera,
      focusId: String(parsed.focus_id ?? ''),
      model: MODEL,
    };
  } catch {
    return { answer: content, usedIds: [], camera: '', focusId: '', model: MODEL };
  }
}

const reader = READER_MODEL
  ? (question) =>
      readQuestion({
        question,
        runtimeUrl: RUNTIME_URL,
        model: READER_MODEL,
        reasoningEffort: REASONING_EFFORT,
      })
  : null;

const handler = createIntelHandler({
  corpus,
  model: MODEL,
  runtime: RUNTIME,
  egress,
  answer,
  reader,
  readerModel: READER_MODEL,
  gazetteer,
  embeddings: () => embeddingIndex,
  embeddingsStatus: () => embeddingStatus,
});

createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error(`[intel] request failed: ${error?.message ?? error}`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
}).listen(PORT, '0.0.0.0', () => {
  keepWarm();
  if (KEEP_WARM_MS > 0) setInterval(keepWarm, KEEP_WARM_MS).unref();
  void buildVectors();
  console.log(
    `[intel] listening on ${PORT} - model ${MODEL} - reader ${READER_MODEL || 'off'} - ` +
      `vectors ${EMBED_MODEL || 'off'} - runtime ${RUNTIME_URL} - ` +
      `corpus ${corpus.length} records - gazetteer ${gazetteer ? `${gazetteer.size} places` : 'off'} - egress ${egress}`,
  );
});
