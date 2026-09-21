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

/** An OpenAI chat-completion response, with no field that varies per call. */
export function stubCompletion(body) {
  const content = stubAnswer(body);
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
