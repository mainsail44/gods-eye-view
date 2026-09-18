import { corpusChecksum, selectRetrievalMode } from './corpus.js';

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve(null);
      }
    });
  });

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

/** Rank corpus records by naive term overlap; sufficient before embeddings. */
function retrieve(corpus, question, limit) {
  const terms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!terms.length) return [];
  return corpus
    .map((record) => {
      const haystack = `${record.label ?? ''} ${record.text ?? ''}`.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { record, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.record);
}

/**
 * Build the request handler. `answer` performs model inference and is injected
 * so routing and the decline-on-empty rule stay testable without a model.
 */
export function createIntelHandler({
  corpus = [],
  model,
  runtime,
  egress = 'unknown',
  attestation = 'unavailable',
  answer,
}) {
  const checksum = corpusChecksum(corpus);
  const version = new Date().toISOString().slice(0, 10);

  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        model,
        runtime,
        egress,
        attestation,
        corpus: { version, checksum, records: corpus.length },
      });
    }

    if (req.method === 'POST' && path === '/query') {
      const body = await readBody(req);
      const question = String(body?.question ?? '').trim();
      if (!question) return send(res, 400, { error: 'A question is required' });
      const requested = Number(body?.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(50, Math.max(1, Math.trunc(requested)))
        : 8;
      const mode = selectRetrievalMode(question);
      const records = retrieve(corpus, question, limit);

      // Declining beats guessing: an unsupported answer is worse than none.
      if (!records.length) {
        return send(res, 200, {
          answer: 'No matching records in the local corpus.',
          citations: [],
          actions: [],
          corpus: { version, checksum },
        });
      }

      const result = await answer({ question, mode, records });
      return send(res, 200, {
        answer: String(result?.answer ?? ''),
        citations: Array.isArray(result?.citations) ? result.citations : [],
        actions: Array.isArray(result?.actions) ? result.actions : [],
        corpus: { version, checksum },
      });
    }

    return send(res, 404, { error: 'Not found' });
  };
}
