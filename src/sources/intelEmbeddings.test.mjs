import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildEmbeddingIndex,
  cachePath,
  embedTexts,
  embeddingText,
} from '../../services/intel/src/embeddings.js';
import { stubEmbeddings } from '../../services/intel/test/stub-runtime.mjs';

/** A runtime that embeds like the stub and counts its calls. */
const runtime = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, inputs: body.input.length, model: body.model });
    return new Response(JSON.stringify(stubEmbeddings(body)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
};

const CORPUS = [
  { id: 'a', label: 'Equinix MRS1', text: 'datacenters. located in Marseille, France.' },
  { id: 'b', label: 'STACK NVA01A', text: 'datacenters. located in Sterling, Virginia.' },
  { id: 'c', label: 'Skewjack', text: 'submarine cable landing points. located in Sennen, England.' },
];

test('texts are embedded through /v1/embeddings as unit vectors, in order', async () => {
  const { calls, fetchImpl } = runtime();
  const vectors = await embedTexts({
    runtimeUrl: 'http://runtime/',
    model: 'embed',
    texts: ['marseille france', 'sterling virginia'],
    fetchImpl,
  });
  assert.equal(calls[0].url, 'http://runtime/v1/embeddings');
  assert.equal(calls[0].model, 'embed');
  assert.equal(vectors.length, 2);
  const norm = Math.sqrt(vectors[0].reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4, `unit length, got ${norm}`);
});

test('the index finds the record closest in meaning and caches itself', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intel-embed-'));
  try {
    const { calls, fetchImpl } = runtime();
    const index = await buildEmbeddingIndex({
      corpus: CORPUS,
      checksum: 'abc123',
      model: 'embed',
      runtimeUrl: 'http://runtime',
      cacheDir: directory,
      fetchImpl,
    });
    assert.equal(index.size, 3);
    assert.equal(index.fromCache, false);
    assert.equal(calls.length, 1, 'three records fit one batch');
    const query = await index.embedQuery('landing point in England');
    const [best] = index.search(query, 1);
    assert.equal(CORPUS[best.index].id, 'c');
    assert.deepEqual(await readdir(directory), [
      path.basename(cachePath(directory, 'abc123', 'embed')),
    ]);

    // A second build with the same corpus and model reads the cache.
    const again = runtime();
    const reloaded = await buildEmbeddingIndex({
      corpus: CORPUS,
      checksum: 'abc123',
      model: 'embed',
      runtimeUrl: 'http://runtime',
      cacheDir: directory,
      fetchImpl: again.fetchImpl,
    });
    assert.equal(reloaded.fromCache, true);
    assert.equal(again.calls.length, 0);
    assert.equal(reloaded.search(query, 1)[0].index, best.index);

    // A different corpus checksum misses the cache.
    const changed = await buildEmbeddingIndex({
      corpus: CORPUS,
      checksum: 'def456',
      model: 'embed',
      runtimeUrl: 'http://runtime',
      cacheDir: directory,
      fetchImpl: again.fetchImpl,
    });
    assert.equal(changed.fromCache, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a runtime that returns the wrong number of vectors is an error, not a silent gap', async () => {
  await assert.rejects(
    embedTexts({
      runtimeUrl: 'http://runtime',
      model: 'embed',
      texts: ['one', 'two'],
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 }),
    }),
    /1 vectors for 2 inputs/,
  );
  await assert.rejects(
    embedTexts({ runtimeUrl: 'http://runtime', model: 'embed', texts: ['one'], fetchImpl: async () => new Response('down', { status: 503 }) }),
    /503/,
  );
});

test('a record is embedded from its label and text', () => {
  assert.equal(embeddingText(CORPUS[0]), 'Equinix MRS1. datacenters. located in Marseille, France.');
});
