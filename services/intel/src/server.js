import { corpusChecksum, selectRetrievalMode } from './corpus.js';

/** Reject a request body larger than this before it is ever parsed. */
const MAX_BODY_BYTES = 65536; // 64 KB
/** Reject a question longer than this before any retrieval work runs. */
const MAX_QUESTION_LENGTH = 2000;
/** Cap the distinct terms scored per record, regardless of question length. */
const MAX_QUERY_TERMS = 50;

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

/**
 * Rank corpus records by term overlap; sufficient before embeddings. Terms are
 * weighted by how rare they are, because every datacenter record carries the
 * words "nearest cable landing point": counting each match equally lets that
 * boilerplate outvote the place name the question actually turns on. The
 * weight stays strictly positive, so any matching term still counts as a
 * match and an empty retrieval still means nothing matched at all.
 */
function retrieve(corpus, question, limit) {
  const rawTerms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const terms = [...new Set(rawTerms)].slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return [];
  const haystacks = corpus.map((record) =>
    `${record.label ?? ''} ${record.text ?? ''}`.toLowerCase(),
  );
  const weights = terms.map((term) => {
    const matches = haystacks.reduce(
      (total, haystack) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return Math.log(1 + corpus.length / (1 + matches));
  });
  return corpus
    .map((record, index) => {
      const haystack = haystacks[index];
      const score = terms.reduce(
        (total, term, position) =>
          total + (haystack.includes(term) ? weights[position] : 0),
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
      if (body === TOO_LARGE) return send(res, 413, { error: 'Request body too large' });
      const question = String(body?.question ?? '').trim();
      if (!question) return send(res, 400, { error: 'A question is required' });
      if (question.length > MAX_QUESTION_LENGTH)
        return send(res, 400, { error: 'Question too long' });
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
