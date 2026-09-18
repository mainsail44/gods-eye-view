import { createHash } from 'node:crypto';

/** Stable key ordering so the digest depends on content, not serialization order. */
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
};

/** Digest a corpus so an answer can name exactly which data produced it. */
export function corpusChecksum(records) {
  const rows = (Array.isArray(records) ? records : [])
    .map((record) => JSON.stringify(stable(record)))
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

const METRIC_HINTS = [
  'snr',
  'signal',
  'propagation',
  'noise floor',
  'dx spot',
  'dx spots',
  'over time',
  'last hour',
  'last day',
  'average snr',
  'average signal',
];

/** Signals are aggregates, places are documents; the retriever needs to know which. */
export function selectRetrievalMode(question) {
  const value = String(question ?? '').toLowerCase();
  const pattern = new RegExp(
    '\\b(?:' +
      METRIC_HINTS.map((hint) =>
        hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ).join('|') +
      ')\\b',
  );
  return pattern.test(value) ? 'metric' : 'document';
}
