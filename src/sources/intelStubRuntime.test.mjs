import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUB_MARKER,
  createStubRuntimeHandler,
  stubAnswer,
  stubCompletion,
} from '../../services/intel/test/stub-runtime.mjs';

/** A request body shaped exactly as services/intel/src/index.js sends it. */
const request = (records, question = 'where is it') => ({
  model: 'starlight-stub',
  messages: [
    { role: 'system', content: 'Answer only from the records provided.' },
    {
      role: 'user',
      content: `Records:\n${records
        .map(
          (record) =>
            `- ${record.id}: ${record.label} (${record.lat}, ${record.lon}) ${record.text}`,
        )
        .join('\n')}\n\nQuestion: ${question}`,
    },
  ],
});

const RECORDS = [
  {
    id: 'dc-1',
    label: 'Site A',
    lat: 1,
    lon: 2,
    text: 'datacenters. name: A.',
  },
  {
    id: 'lp-b',
    label: 'Bay, Nowhere',
    lat: 3,
    lon: 4,
    text: 'landing points.',
  },
  {
    id: 'dc-3',
    label: 'Site C',
    lat: 5,
    lon: 6,
    text: 'datacenters. name: C.',
  },
  {
    id: 'dc-4',
    label: 'Site D',
    lat: 7,
    lon: 8,
    text: 'datacenters. name: D.',
  },
];

const invoke = (handler, { method = 'POST', url, body }) =>
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
        if (event === 'data' && body !== undefined)
          listener(Buffer.from(JSON.stringify(body)));
        if (event === 'end') listener();
        return this;
      },
    };
    void handler(req, res);
  });

test('the answer names itself as a stub and reports what it was shown', () => {
  const answer = stubAnswer(request(RECORDS));
  assert.ok(answer.startsWith(STUB_MARKER));
  assert.match(answer, /no model/i);
  assert.equal(
    answer,
    `${STUB_MARKER}: answering from 4 local records. ` +
      'Top records: dc-1, lp-b, dc-3.',
  );
});

test('the answer is deterministic and varies only with the records shown', () => {
  assert.equal(stubAnswer(request(RECORDS)), stubAnswer(request(RECORDS)));
  assert.equal(
    stubAnswer(request(RECORDS, 'a different question')),
    stubAnswer(request(RECORDS)),
  );
  assert.notEqual(
    stubAnswer(request(RECORDS.slice(0, 1))),
    stubAnswer(request(RECORDS)),
  );
  assert.match(
    stubAnswer(request(RECORDS.slice(0, 1))),
    /from 1 local record\. Top records: dc-1\./,
  );
});

test('an empty or malformed request still answers without throwing', () => {
  assert.match(stubAnswer({}), /from 0 local records\. Top records: none\./);
  assert.match(stubAnswer(null), /Top records: none\./);
  assert.match(
    stubAnswer({ messages: [{ role: 'user', content: null }] }),
    /Top records: none\./,
  );
});

test('the response is shaped like an OpenAI chat completion', () => {
  const payload = stubCompletion(request(RECORDS));
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'starlight-stub');
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  // What services/intel/src/index.js reads.
  assert.equal(
    payload.choices[0].message.content,
    stubAnswer(request(RECORDS)),
  );
  // Nothing varies per call, not even the timestamp or the id.
  assert.deepEqual(payload, stubCompletion(request(RECORDS)));
  assert.match(payload.id, /^chatcmpl-stub-[0-9a-f]{12}$/);
});

test('POST /v1/chat/completions returns the completion as JSON', async () => {
  const handler = createStubRuntimeHandler();
  const { status, body } = await invoke(handler, {
    url: '/v1/chat/completions',
    body: request(RECORDS),
  });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), stubCompletion(request(RECORDS)));
});

test('health answers, and other routes are 404', async () => {
  const handler = createStubRuntimeHandler();
  const health = await invoke(handler, { method: 'GET', url: '/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, stub: true });

  const missing = await invoke(handler, { method: 'GET', url: '/v1/models' });
  assert.equal(missing.status, 404);
});
