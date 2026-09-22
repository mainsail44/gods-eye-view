#!/usr/bin/env node
// Deterministic stand-in for an OpenAI-compatible model runtime.
//
//   PORT=11434 node services/intel/test/stub-runtime.mjs
//
// It exists so the intel service can be deployed and asserted against without
// a GPU or a model download: the same question always produces the same bytes.
// Every answer names itself as a stub, so a stub reply can never be mistaken
// for a model's in a demo or a screenshot.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The phrase every stub answer opens with; browser assertions match on it. */
export const STUB_MARKER = 'Starlight stub runtime (no model)';

/** Cap the request body: generous for retrieved records, bounded all the same. */
const MAX_BODY_BYTES = 1_048_576;

/** Record ids as the intel service formats them: `- <id>: <label> ...`. */
function recordIds(body) {
  const content = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((message) => message?.role === 'user')
    .map((message) => String(message?.content ?? ''))
    .join('\n');
  return [...content.matchAll(/^- ([^\s:]+):/gm)].map((match) => match[1]);
}

/**
 * The answer text. Derived only from what the request showed the stub — the
 * number of records and the first ids — so an assertion can be exact.
 */
export function stubAnswer(body) {
  const ids = recordIds(body);
  const top = ids.slice(0, 3);
  return (
    `${STUB_MARKER}: answering from ${ids.length} local ` +
    `${ids.length === 1 ? 'record' : 'records'}. ` +
    `Top records: ${top.length ? top.join(', ') : 'none'}.`
  );
}

/** Dimensions of the stub's embeddings; enough buckets that unrelated texts rarely collide. */
export const STUB_EMBED_DIMS = 64;

/** FNV-1a over a token, so the same word always lands in the same bucket. */
const bucket = (token) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % STUB_EMBED_DIMS;
};

/**
 * A deterministic bag-of-words vector: each word adds one to its bucket and
 * the result is unit length. Texts that share words are close, texts that
 * share none are (nearly) orthogonal — enough for retrieval to be exercised
 * and asserted without a model.
 */
export function stubEmbedding(text) {
  const vector = new Array(STUB_EMBED_DIMS).fill(0);
  for (const token of String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean))
    vector[bucket(token)] += 1;
  const norm =
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Math.round((value / norm) * 1e6) / 1e6);
}

/** An OpenAI embeddings response for one or many inputs, in input order. */
export function stubEmbeddings(body) {
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  return {
    object: 'list',
    model: String(body?.model ?? 'starlight-stub-embed'),
    data: inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: stubEmbedding(text),
    })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

/**
 * What the stub says when asked for JSON against a schema. The reader's
 * schema gets an empty reading — the stub understands nothing, and says so
 * by leaving every field blank — and the answer schema gets the same stub
 * prose as before, naming the first records as the ones it "used" so the
 * camera actions are exercised. Any other schema gets an empty object.
 */
export function stubStructured(body) {
  const schema = body?.response_format?.json_schema;
  const name = String(schema?.name ?? '');
  if (name === 'question_reading')
    return {
      place: '',
      region: '',
      country: '',
      entity_type: 'any',
      operator: '',
      intent: 'other',
      radius_km: 0,
    };
  if (name === 'grounded_answer') {
    const ids = recordIds(body);
    return {
      answer: stubAnswer(body),
      used_ids: ids.slice(0, 3),
      camera: ids.length > 1 ? 'frame_all' : ids.length ? 'site' : 'none',
      focus_id: ids[0] ?? '',
    };
  }
  return {};
}

/** An OpenAI chat-completion response, with no field that varies per call. */
export function stubCompletion(body) {
  const content =
    body?.response_format?.type === 'json_schema'
      ? JSON.stringify(stubStructured(body))
      : stubAnswer(body);
  const id = createHash('sha256')
    .update(`${body?.model ?? ''}\n${content}`)
    .digest('hex')
    .slice(0, 12);
  return {
    id: `chatcmpl-stub-${id}`,
    object: 'chat.completion',
    // Fixed, not Date.now(): a response must be byte-identical across runs.
    created: 0,
    model: String(body?.model ?? 'starlight-stub'),
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

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
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) return resolve(null);
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

/** Request handler for the stub, exported so tests need no socket. */
export function createStubRuntimeHandler() {
  return async function handle(req, res) {
    const url = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/health')
      return send(res, 200, { ok: true, stub: true });
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const body = await readBody(req);
      if (body === null)
        return send(res, 400, { error: 'Invalid request body' });
      return send(res, 200, stubCompletion(body));
    }
    if (req.method === 'POST' && url === '/v1/embeddings') {
      const body = await readBody(req);
      if (body === null)
        return send(res, 400, { error: 'Invalid request body' });
      return send(res, 200, stubEmbeddings(body));
    }
    return send(res, 404, { error: 'Not found' });
  };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  const port = Number(process.env.PORT || 11434);
  const handler = createStubRuntimeHandler();
  createServer((req, res) => {
    handler(req, res).catch(() => send(res, 500, { error: 'Internal error' }));
  }).listen(port, '0.0.0.0', () => {
    console.log(`[intel-stub] deterministic stub runtime listening on ${port}`);
  });
}
