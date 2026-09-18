import test from 'node:test';
import assert from 'node:assert/strict';
import {
  corpusChecksum,
  selectRetrievalMode,
} from '../../services/intel/src/corpus.js';

test('checksum is stable regardless of record order', () => {
  const a = [
    { id: '1', name: 'A' },
    { id: '2', name: 'B' },
  ];
  const b = [
    { id: '2', name: 'B' },
    { id: '1', name: 'A' },
  ];
  assert.equal(corpusChecksum(a), corpusChecksum(b));
});

test('checksum changes when content changes', () => {
  assert.notEqual(
    corpusChecksum([{ id: '1', name: 'A' }]),
    corpusChecksum([{ id: '1', name: 'B' }]),
  );
});

test('checksum is a hex digest', () => {
  assert.match(corpusChecksum([{ id: '1' }]), /^[0-9a-f]{64}$/);
});

test('signal questions route to metric retrieval', () => {
  assert.equal(
    selectRetrievalMode('what is the average snr over europe'),
    'metric',
  );
  assert.equal(
    selectRetrievalMode('show propagation paths in the last hour'),
    'metric',
  );
});

test('place questions route to document retrieval', () => {
  assert.equal(
    selectRetrievalMode('which datacenters are near a cable landing'),
    'document',
  );
  assert.equal(selectRetrievalMode(''), 'document');
});
