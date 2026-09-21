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

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

/**
 * Words that carry no information about which record is wanted. They neither
 * match nor count: `by` inside "Brondby" and "Bygby" once matched 52 records,
 * which made it look rarer — and so worth more — than "equinix".
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'by',
  'for',
  'in',
  'is',
  'near',
  'nearest',
  'of',
  'on',
  'operated',
  'show',
  'that',
  'the',
  'to',
  'what',
  'which',
  'with',
]);

/** Below this length a query term must equal a token; prefixes match above it. */
const MIN_PREFIX_LENGTH = 3;

const tokenize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * One token matches another when either is a prefix of the other, so
 * datacenter/datacenters and point/points match without `includes()` letting a
 * term match the middle of an unrelated word.
 */
const tokenMatches = (token, term) => {
  if (token === term) return true;
  if (Math.min(token.length, term.length) < MIN_PREFIX_LENGTH) return false;
  return token.startsWith(term) || term.startsWith(token);
};

/**
 * Index the corpus once, at startup. Each record becomes a set of tokens, and
 * each token keeps the records it appears in, so a query costs one pass over
 * the vocabulary rather than a substring scan of every record.
 */
function indexCorpus(corpus) {
  const postings = new Map();
  corpus.forEach((record, index) => {
    for (const token of new Set(
      tokenize(`${record.label ?? ''} ${record.text ?? ''}`),
    )) {
      if (STOPWORDS.has(token)) continue;
      const seen = postings.get(token);
      if (seen) seen.push(index);
      else postings.set(token, [index]);
    }
  });
  return postings;
}

/**
 * Distance used to order records that tie on relevance. A landing point has
 * none: it is the place being asked about, so it sorts as if at zero, ahead of
 * a datacenter it would otherwise tie with.
 */
const distance = (record) =>
  Number.isFinite(record?.nearestKm) ? record.nearestKm : 0;

/**
 * Rank corpus records by term overlap; sufficient before embeddings. Terms are
 * weighted by how rare they are, because every datacenter record carries the
 * words "cable landing point": counting each match equally lets that
 * boilerplate outvote the place name the question actually turns on. The
 * weight stays strictly positive, so any matching term still counts as a match
 * and an empty retrieval still means nothing matched at all.
 *
 * Records that tie — every datacenter whose nearest landing point is Marseille
 * scores identically — are ordered by that stored distance, so "near the
 * Marseille landing point" answers with the ones actually near it.
 */
function retrieve(corpus, postings, question, limit) {
  const terms = [...new Set(tokenize(question))]
    .filter((term) => !STOPWORDS.has(term))
    .slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return [];

  const scores = new Map();
  for (const term of terms) {
    const matched = new Set();
    for (const [token, records] of postings) {
      if (tokenMatches(token, term))
        for (const index of records) matched.add(index);
    }
    if (!matched.size) continue;
    const weight = Math.log(1 + corpus.length / (1 + matched.size));
    for (const index of matched)
      scores.set(index, (scores.get(index) ?? 0) + weight);
  }

  return [...scores]
    .map(([index, score]) => ({ record: corpus[index], score }))
    .sort(
      (a, b) => b.score - a.score || distance(a.record) - distance(b.record),
    )
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
  const postings = indexCorpus(corpus);

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
      const records = retrieve(corpus, postings, question, limit);

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
