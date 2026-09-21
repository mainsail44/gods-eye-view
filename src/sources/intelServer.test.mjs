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

test('a body over 64 KB is rejected before parsing', async () => {
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
    body: { question: 'london', padding: 'x'.repeat(70000) },
  });
  assert.equal(status, 413);
  const payload = JSON.parse(body);
  assert.match(payload.error, /too large/i);
  assert.equal(modelCalled, false);
});

test('a question over 2000 characters is rejected', async () => {
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
    body: { question: 'x'.repeat(2001) },
  });
  assert.equal(status, 400);
  const payload = JSON.parse(body);
  assert.match(payload.error, /too long/i);
  assert.equal(modelCalled, false);
});

test('a question with more than 50 distinct terms still retrieves correctly', async () => {
  const fillers = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(' ');
  const question = `london ${fillers}`;
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'local-model',
    runtime: 'llama.cpp',
    answer: async ({ records }) => ({
      answer: `Matched ${records.length} record(s).`,
      citations: records.map((record) => ({ id: record.id })),
    }),
  });
  const { status, body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question },
  });
  assert.equal(status, 200);
  const payload = JSON.parse(body);
  assert.equal(payload.citations[0].id, 'dc-1');
});

test('a rare term outranks boilerplate every record shares', async () => {
  // Every datacenter record carries "nearest cable landing point", so the
  // place name is the only term that separates them.
  const text = (place) =>
    `datacenters. nearest cable landing point: ${place} (2.0 km).`;
  const handler = createIntelHandler({
    corpus: [
      {
        id: 'dc-b',
        label: 'Bravo',
        lat: 53.4,
        lon: 6.8,
        text: text('Eemshaven, Netherlands'),
      },
      {
        id: 'dc-c',
        label: 'Charlie',
        lat: 53.4,
        lon: 6.9,
        text: text('Eemshaven, Netherlands'),
      },
      {
        id: 'dc-a',
        label: 'Alpha',
        lat: 43.3,
        lon: 5.4,
        text: text('Marseille, France'),
      },
    ],
    model: 'local-model',
    runtime: 'llama.cpp',
    answer: async ({ records }) => ({
      answer: `Matched ${records.length} record(s).`,
      citations: records.map((record) => ({ id: record.id })),
    }),
  });
  const { status, body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: {
      question: 'which datacenters are near the marseille landing point',
      limit: 1,
    },
  });
  assert.equal(status, 200);
  assert.deepEqual(
    JSON.parse(body).citations.map((citation) => citation.id),
    ['dc-a'],
  );
});
