import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIntelHealth,
  normalizeIntelAnswer,
  buildIntelQueryBody,
} from './intel.js';

test('normalizes a healthy response', () => {
  const health = normalizeIntelHealth({
    model: 'local-model',
    runtime: 'llama.cpp',
    corpus: { version: '2026.09.1', checksum: 'abc123' },
    egress: 'blocked',
    attestation: 'verified',
  });
  assert.equal(health.ok, true);
  assert.equal(health.model, 'local-model');
  assert.equal(health.corpusVersion, '2026.09.1');
  assert.equal(health.corpusChecksum, 'abc123');
  assert.equal(health.egress, 'blocked');
  assert.equal(health.attestation, 'verified');
});

test('an unusable health payload is not ok', () => {
  assert.equal(normalizeIntelHealth(null).ok, false);
  assert.equal(normalizeIntelHealth({}).ok, false);
  assert.equal(normalizeIntelHealth({ model: '   ' }).ok, false);
});

test('unknown egress and attestation values fall back rather than pass through', () => {
  const health = normalizeIntelHealth({
    model: 'm',
    runtime: 'r',
    egress: 'maybe',
    attestation: 'sort-of',
  });
  assert.equal(health.egress, 'unknown');
  assert.equal(health.attestation, 'unavailable');
});

test('keeps only citations with usable coordinates', () => {
  const answer = normalizeIntelAnswer({
    answer: 'Two sites match.',
    citations: [
      { id: 'dc-1', label: 'Site A', lat: 51.5, lon: -0.12 },
      { id: 'dc-2', label: 'Site B', lat: 999, lon: 0 },
      { id: '', label: 'No id', lat: 1, lon: 1 },
      null,
    ],
  });
  assert.equal(answer.answer, 'Two sites match.');
  assert.equal(answer.citations.length, 1);
  assert.equal(answer.citations[0].id, 'dc-1');
});

test('an empty answer is preserved rather than invented', () => {
  const answer = normalizeIntelAnswer({ answer: '', citations: [] });
  assert.equal(answer.answer, '');
  assert.deepEqual([...answer.citations], []);
});

test('builds a bounded query body', () => {
  assert.deepEqual(buildIntelQueryBody('  where are the cables?  '), {
    question: 'where are the cables?',
    limit: 5,
  });
  assert.equal(buildIntelQueryBody('q', { limit: 999 }).limit, 50);
  assert.equal(buildIntelQueryBody('q', { limit: 0 }).limit, 1);
});

test('rejects a blank question', () => {
  assert.throws(() => buildIntelQueryBody('   '), TypeError);
});

test('preserves symbol characters in text', () => {
  const answer = normalizeIntelAnswer({
    answer: 'Temperature is 25°C with a →northward trend and +5% increase',
    citations: [{ id: 'test', label: 'Site @ 10°N, 20°E', lat: 10, lon: 20 }],
  });
  assert.equal(
    answer.answer,
    'Temperature is 25°C with a →northward trend and +5% increase',
  );
  assert.equal(answer.citations[0].label, 'Site @ 10°N, 20°E');
});

test('removes control characters from text', () => {
  const answer = normalizeIntelAnswer({
    answer: 'Alert:\x00Data\x1Fcorrupted',
    citations: [{ id: 'test', label: 'Site\x08Name', lat: 0, lon: 0 }],
  });
  assert.equal(answer.answer, 'Alert: Data corrupted');
  assert.equal(answer.citations[0].label, 'Site Name');
});

// --- The AI-native answer: reading, place, actions and trace.

test('actions may only name citations the answer carries', () => {
  const answer = normalizeIntelAnswer({
    citations: [
      {
        id: 'dc-1',
        label: 'A',
        kind: 'datacenter',
        lat: 1,
        lon: 2,
        city: 'Sterling',
        region: 'Virginia',
        why: { km: 12.3, terms: ['virginia'] },
      },
      { id: 'dc-2', label: 'B', kind: 'nonsense', lat: 3, lon: 4 },
    ],
    actions: [
      { type: 'fly', id: 'dc-zzz' },
      { type: 'frame', ids: ['dc-1', 'dc-zzz', 'dc-2', 'dc-1'] },
      {
        type: 'place',
        kind: 'region',
        name: 'Virginia',
        lat: 37.9,
        lon: -78.3,
        radiusKm: 443,
        confidence: 'exact',
      },
      { type: 'explode' },
    ],
  });
  assert.deepEqual(answer.actions, [
    { type: 'frame', ids: ['dc-1', 'dc-2'] },
    {
      type: 'place',
      kind: 'region',
      name: 'Virginia',
      region: '',
      country: '',
      lat: 37.9,
      lon: -78.3,
      radiusKm: 443,
      confidence: 'exact',
    },
  ]);
  assert.equal(answer.citations[0].city, 'Sterling');
  assert.equal(answer.citations[0].kind, 'datacenter');
  assert.deepEqual(answer.citations[0].why, { km: 12.3, terms: ['virginia'] });
  assert.equal(
    answer.citations[1].kind,
    '',
    'an unknown kind is blank, not passed through',
  );
});

test('the reading, the place and the trace are bounded and typed', () => {
  const answer = normalizeIntelAnswer({
    reading: {
      place: 'Woodbridge',
      region: 'Virginia',
      entityType: 'datacenter',
      intent: 'list_in_place',
      radiusKm: '40',
    },
    place: {
      kind: 'place',
      name: 'Woodbridge',
      region: 'Virginia',
      country: 'United States',
      lat: 38.66,
      lon: -77.25,
      confidence: 'ambiguous',
    },
    trace: [
      { step: 'read', ms: 2400, detail: 'Woodbridge, Virginia' },
      { step: 'retrieve', ms: '3', detail: 'x'.repeat(400) },
      { ms: 1 },
    ],
  });
  assert.equal(answer.reading.place, 'Woodbridge');
  assert.equal(answer.reading.radiusKm, 40);
  assert.equal(answer.place.confidence, 'ambiguous');
  assert.equal(answer.place.radiusKm, 0);
  assert.equal(answer.trace.length, 2);
  assert.equal(answer.trace[1].detail.length, 200);
  const bare = normalizeIntelAnswer(null);
  assert.equal(bare.place, null);
  assert.deepEqual(bare.trace, []);
  assert.deepEqual(bare.actions, []);
  assert.equal(bare.reading.intent, '');
});

test('health carries the reader, the vector index and the gazetteer', () => {
  const health = normalizeIntelHealth({
    model: 'gemma4:12b',
    reader: { model: 'gemma4:12b' },
    embeddings: { model: 'embeddinggemma', ready: false, indexed: 1200 },
    gazetteer: { places: 171013 },
    corpus: { records: 6268 },
  });
  assert.equal(health.readerModel, 'gemma4:12b');
  assert.equal(health.embeddingModel, 'embeddinggemma');
  assert.equal(health.embeddingsReady, false);
  assert.equal(health.embeddingsIndexed, 1200);
  assert.equal(health.gazetteerPlaces, 171013);
  assert.equal(health.corpusRecords, 6268);
});
