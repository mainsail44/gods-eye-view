import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createIntelHandler } from './server.js';
import { probeEgress } from './egress.js';
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
 * Sent as `reasoning_effort` when set. Unset sends nothing, so a runtime that
 * rejects unknown fields is unaffected. On a model that reasons before it
 * answers this is the difference between a 30-second answer and an
 * 80-second one.
 */
const REASONING_EFFORT = process.env.INTEL_REASONING_EFFORT || '';

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
    return fail(`the corpus at ${file} is not a usable JSON array: ${error.message}`);
  }
}

const corpus = await loadCorpus(CORPUS_PATH);
const egress = EGRESS === 'auto' ? await probeEgress(EGRESS_PROBE) : EGRESS;
if (EGRESS === 'auto')
  console.log(`[intel] egress ${egress} - probed ${EGRESS_PROBE}`);

/** Ask the local runtime to answer strictly from the retrieved records. */
async function answer({ question, records }) {
  const context = records
    .map(
      (record) =>
        `- ${record.id}: ${record.label} (${record.lat}, ${record.lon}) ${record.text ?? ''}`,
    )
    .join('\n');
  const response = await fetch(intelUrl(RUNTIME_URL, '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
      messages: [
        {
          role: 'system',
          content:
            'Answer only from the records provided. If they do not contain the answer, say so. Never invent a location.',
        },
        { role: 'user', content: `Records:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  // A runtime that rejects the call (a model name it does not have, say) must
  // surface as an error, not as an empty answer bubble in the panel.
  if (!response.ok)
    throw new Error(
      `runtime ${RUNTIME_URL} returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  const payload = await response.json();
  return {
    answer: payload?.choices?.[0]?.message?.content ?? '',
    citations: records.map((record) => ({
      id: record.id,
      label: record.label,
      lat: record.lat,
      lon: record.lon,
    })),
  };
}

const handler = createIntelHandler({
  corpus,
  model: MODEL,
  runtime: RUNTIME,
  egress,
  answer,
});

createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error(`[intel] request failed: ${error?.message ?? error}`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(
    `[intel] listening on ${PORT} - model ${MODEL} - runtime ${RUNTIME_URL} - ` +
      `corpus ${corpus.length} records - egress ${egress}`,
  );
});
