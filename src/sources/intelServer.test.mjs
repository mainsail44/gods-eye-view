import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelHandler } from '../../services/intel/src/server.js';

const RECORDS = [
  {
    id: 'dc-1',
    label: 'Site A',
    lat: 51.5,
    lon: -0.12,
    text: 'london datacenter',
  },
  {
    id: 'dc-2',
    label: 'Site B',
    lat: 40.7,
    lon: -74.0,
    text: 'new york datacenter',
  },
];

const invoke = (
  handler,
  { method = 'GET', url = '/health', body = null } = {},
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
    const req = {
      method,
      url,
      on(event, listener) {
        if (event === 'data' && body)
          listener(Buffer.from(JSON.stringify(body)));
        if (event === 'end') listener();
        return this;
      },
    };
    void handler(req, res);
  });

test('health reports model, runtime and corpus checksum', async () => {
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'local-model',
    runtime: 'llama.cpp',
    egress: 'blocked',
    answer: async () => ({ answer: '', citations: [] }),
  });
  const { status, body } = await invoke(handler, { url: '/health' });
  assert.equal(status, 200);
  const payload = JSON.parse(body);
  assert.equal(payload.model, 'local-model');
  assert.equal(payload.runtime, 'llama.cpp');
  assert.equal(payload.egress, 'blocked');
  assert.match(payload.corpus.checksum, /^[0-9a-f]{64}$/);
});

test('query returns the answer with citations drawn from the corpus', async () => {
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'local-model',
    runtime: 'llama.cpp',
    answer: async ({ question, mode, records }) => {
      assert.equal(mode, 'document');
      assert.ok(question.includes('london'));
      return {
        answer: `Matched ${records.length} record(s).`,
        citations: records.map((record) => ({
          id: record.id,
          label: record.label,
          lat: record.lat,
          lon: record.lon,
        })),
      };
    },
  });
  const { status, body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question: 'which london datacenter', limit: 5 },
  });
  assert.equal(status, 200);
  const payload = JSON.parse(body);
  assert.ok(payload.answer.startsWith('Matched'));
  assert.equal(payload.citations[0].id, 'dc-1');
});

test('an empty retrieval declines rather than inventing an answer', async () => {
  let modelCalled = false;
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'local-model',
    runtime: 'llama.cpp',
    answer: async () => {
      modelCalled = true;
      return { answer: 'should not happen', citations: [] };
    },
  });
  const { status, body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question: 'antarctic volcano telemetry' },
  });
  assert.equal(status, 200);
  const payload = JSON.parse(body);
  assert.equal(modelCalled, false);
  assert.equal(payload.citations.length, 0);
  assert.match(payload.answer, /no matching/i);
});

test('a blank question is rejected', async () => {
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'm',
    runtime: 'r',
    answer: async () => ({ answer: '', citations: [] }),
  });
  const { status } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question: '   ' },
  });
  assert.equal(status, 400);
});
