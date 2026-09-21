import test from 'node:test';
import assert from 'node:assert/strict';
import { createSovereignMiddleware } from '../../server/providers/sovereign.js';

const invoke = (
  middleware,
  { method = 'GET', url = '/health', body = null, rawChunks = null } = {},
) =>
  new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(payload) {
        if (payload) chunks.push(payload);
        resolve({ status: this.statusCode, body: chunks.join('') });
      },
    };
    const dataChunks =
      rawChunks || (body ? [Buffer.from(JSON.stringify(body))] : []);
    const req = {
      method,
      url,
      on(event, listener) {
        if (event === 'data') for (const chunk of dataChunks) listener(chunk);
        if (event === 'end') listener();
        return this;
      },
    };
    void middleware(req, res, () => resolve({ status: 404, body: '' }));
  });

test('forwards health to the configured service', async () => {
  let requested = '';
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'local-model', runtime: 'llama.cpp' }),
      };
    },
  });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(requested, 'http://intel.local:8080/health');
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).model, 'local-model');
});

test('reports a degraded state when the service is unreachable', async () => {
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(status, 503);
  assert.equal(JSON.parse(body).ok, false);
});

test('reports degraded rather than throwing when no service is configured', async () => {
  const middleware = createSovereignMiddleware({ baseUrl: '' });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(status, 503);
  assert.match(JSON.parse(body).reason, /not configured/i);
});

test('forwards a query body', async () => {
  let sent = null;
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: 'ok', citations: [] }),
      };
    },
  });
  const { status } = await invoke(middleware, {
    method: 'POST',
    url: '/query',
    body: { question: 'where are the cables', limit: 5 },
  });
  assert.equal(status, 200);
  assert.equal(sent.url, 'http://intel.local:8080/query');
  assert.equal(sent.body.question, 'where are the cables');
  assert.equal(sent.body.limit, 5);
});

test('a blank question never reaches the service', async () => {
  let called = false;
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const { status } = await invoke(middleware, {
    method: 'POST',
    url: '/query',
    body: { question: '  ' },
  });
  assert.equal(status, 400);
  assert.equal(called, false);
});

test('an oversized request body is rejected without reaching the service', async () => {
  let called = false;
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  // 65536 bytes is the limit; deliver more than that across several chunks
  // to exercise the accumulate-as-it-arrives path, not a single huge chunk.
  const chunkSize = 8192;
  const chunkCount = 9; // 9 * 8192 = 73728 bytes, over the 65536 cap
  const rawChunks = Array.from({ length: chunkCount }, () =>
    Buffer.alloc(chunkSize, 'a'),
  );
  const { status } = await invoke(middleware, {
    method: 'POST',
    url: '/query',
    rawChunks,
  });
  assert.equal(status, 413);
  assert.equal(called, false);
});

test('a slow local model is given a minute, and the budget is configurable', async () => {
  // A reasoning model answers in tens of seconds; the default must not abort
  // it, and an operator must be able to shorten or lengthen the wait.
  const deadline = (options) =>
    new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve('aborted'));
    });
  const slow = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async (url, options) => {
      // Resolve after a tick: the default budget must still be pending.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(options.signal.aborted, false);
      return { ok: true, status: 200, json: async () => ({ model: 'slow' }) };
    },
  });
  assert.equal((await invoke(slow, { url: '/health' })).status, 200);

  const previous = process.env.STARLIGHT_INTEL_TIMEOUT_MS;
  process.env.STARLIGHT_INTEL_TIMEOUT_MS = '5';
  try {
    const impatient = createSovereignMiddleware({
      baseUrl: 'http://intel.local:8080',
      fetchImpl: async (url, options) => {
        await deadline(options);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    const { status, body } = await invoke(impatient, { url: '/health' });
    assert.equal(status, 503);
    assert.match(JSON.parse(body).reason, /unreachable/i);
  } finally {
    if (previous === undefined) delete process.env.STARLIGHT_INTEL_TIMEOUT_MS;
    else process.env.STARLIGHT_INTEL_TIMEOUT_MS = previous;
  }
});
