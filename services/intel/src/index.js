import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createIntelHandler } from './server.js';
import { intelUrl } from '../../../src/sources/intelEndpoint.js';

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.INTEL_MODEL || 'unknown';
const RUNTIME_URL = process.env.INTEL_RUNTIME_URL || 'http://127.0.0.1:11434';
const RUNTIME = process.env.INTEL_RUNTIME || 'openai-compatible';
const CORPUS_PATH = process.env.INTEL_CORPUS || '/app/corpus/corpus.json';
const EGRESS = process.env.INTEL_EGRESS || 'unknown';

const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));

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
  egress: EGRESS,
  answer,
});

createServer((req, res) => {
  handler(req, res).catch(() => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[intel] listening on ${PORT} - model ${MODEL} - egress ${EGRESS}`);
});
