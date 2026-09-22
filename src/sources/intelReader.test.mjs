import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READING_SCHEMA,
  normalizeReading,
  isEmptyReading,
  readQuestion,
} from '../../services/intel/src/reader.js';

const completion = (content) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

test('a reading is validated field by field', () => {
  const reading = normalizeReading({
    place: '  Woodbridge ',
    region: 'Virginia',
    country: 'USA',
    entity_type: 'datacenter',
    operator: '',
    intent: 'list_in_place',
    radius_km: '25',
  });
  assert.deepEqual(reading, {
    place: 'Woodbridge',
    region: 'Virginia',
    country: 'USA',
    entityType: 'datacenter',
    operator: '',
    intent: 'list_in_place',
    radiusKm: 25,
  });
  assert.equal(isEmptyReading(reading), false);
});

test('unknown enum values and bad numbers fall back to safe defaults', () => {
  const reading = normalizeReading({
    entity_type: 'satellite',
    intent: 'destroy',
    radius_km: -4,
    place: 'x'.repeat(500),
  });
  assert.equal(reading.entityType, 'any');
  assert.equal(reading.intent, 'other');
  assert.equal(reading.radiusKm, 0);
  assert.equal(reading.place.length, 120);
  assert.equal(isEmptyReading(normalizeReading(null)), true);
});

test('the model is asked through response_format with the reading schema', async () => {
  const calls = [];
  const result = await readQuestion({
    question: 'what datacenters are in Woodbridge, Virginia',
    runtimeUrl: 'http://runtime/',
    model: 'reader-model',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return completion(
        JSON.stringify({
          place: 'Woodbridge',
          region: 'Virginia',
          country: 'United States',
          entity_type: 'datacenter',
          operator: '',
          intent: 'list_in_place',
          radius_km: 0,
        }),
      );
    },
  });
  assert.equal(calls[0].url, 'http://runtime/v1/chat/completions');
  assert.equal(calls[0].body.model, 'reader-model');
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].body.reasoning_effort, 'none');
  assert.deepEqual(calls[0].body.response_format, {
    type: 'json_schema',
    json_schema: READING_SCHEMA,
  });
  assert.equal(result.source, 'model');
  assert.equal(result.reading.place, 'Woodbridge');
  assert.equal(result.reading.intent, 'list_in_place');
});

test('a runtime that answers in prose, errors, or is absent yields the empty reading', async () => {
  const prose = await readQuestion({
    question: 'q',
    runtimeUrl: 'http://runtime',
    model: 'm',
    fetchImpl: async () => completion('Woodbridge is in Virginia.'),
  });
  assert.equal(prose.source, 'fallback');
  assert.equal(isEmptyReading(prose.reading), true);
  assert.match(prose.error, /JSON/);

  const failing = await readQuestion({
    question: 'q',
    runtimeUrl: 'http://runtime',
    model: 'm',
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(failing.source, 'fallback');
  assert.match(failing.error, /500/);

  const off = await readQuestion({ question: 'q', runtimeUrl: '', model: '' });
  assert.equal(off.source, 'fallback');
  assert.equal(off.ms, 0);
});
