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
