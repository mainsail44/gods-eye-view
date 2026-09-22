// Vector index over the corpus, embedded by the local runtime.
//
// The index is built once per (corpus checksum, model) and cached on disk,
// so a restart costs a file read rather than six thousand embedding calls.
// Vectors are float32 and compared by cosine; at this corpus size a linear
// scan is a few milliseconds and needs no approximate-nearest-neighbour
// structure.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Records embedded per runtime call. Ollama batches internally; 64 keeps requests small. */
const BATCH = 64;

/** Bytes the runtime is allowed to send back per batch: 64 × 4096 dims × 12 chars. */
const MAX_RESPONSE_CHARS = 64 * 4096 * 12;

const l2normalize = (vector) => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / norm);
};

/** Cosine similarity of two unit vectors of equal length. */
export const dot = (a, b) => {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
};

/** The text a record is embedded from: label first, then the sentence text. */
export const embeddingText = (record) =>
  `${record.label ?? ''}. ${record.text ?? ''}`.trim();

/**
 * Embed texts through the OpenAI-compatible endpoint.
 * @returns {Promise<Float32Array[]>} Unit vectors, in input order.
 */
export async function embedTexts({
  runtimeUrl,
  model,
  texts,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (!texts.length) return [];
  const url = `${String(runtimeUrl).replace(/\/+$/, '')}/v1/embeddings`;
  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const input = texts.slice(start, start + BATCH);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal,
    });
    if (!response.ok)
      throw new Error(
        `embeddings runtime returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS)
      throw new Error('embeddings response too large');
    const payload = JSON.parse(text);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    if (data.length !== input.length)
      throw new Error(
        `embeddings runtime returned ${data.length} vectors for ${input.length} inputs`,
      );
    // The API allows any order; `index` says which input a vector belongs to.
    const ordered = new Array(input.length);
    for (const item of data) {
      const at = Number.isInteger(item?.index) ? item.index : ordered.indexOf(undefined);
      if (!Array.isArray(item?.embedding)) throw new Error('embedding is not an array');
      ordered[at] = l2normalize(item.embedding);
    }
    if (ordered.some((vector) => !vector)) throw new Error('embedding missing');
    vectors.push(...ordered);
  }
  return vectors;
}

/** Cache file for one corpus and model, keyed so a rebuild of either misses. */
export const cachePath = (directory, checksum, model) =>
  path.join(
    directory,
    `embeddings-${checksum.slice(0, 16)}-${String(model).replace(/[^a-z0-9._-]+/gi, '_')}.json`,
  );

const encode = (vectors) =>
  vectors.map((vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64'));

const decode = (encoded) =>
  encoded.map((text) => {
    const buffer = Buffer.from(text, 'base64');
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  });

/**
 * Build, or reload from cache, the vector index for a corpus.
 * @param {object} options
 * @param {object[]} options.corpus Records in the order the index will use.
 * @param {string} options.checksum Corpus checksum; part of the cache key.
 * @param {string} options.model Embedding model name.
 * @param {string} options.runtimeUrl OpenAI-compatible runtime base URL.
 * @param {string} [options.cacheDir] Directory for the cache file; none disables caching.
 * @param {Function} [options.fetchImpl]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{model: string, dims: number, size: number, search: Function, embedQuery: Function, fromCache: boolean}>}
 */
export async function buildEmbeddingIndex({
  corpus,
  checksum,
  model,
  runtimeUrl,
  cacheDir = '',
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
}) {
  const file = cacheDir ? cachePath(cacheDir, checksum, model) : '';
  let vectors = null;
  let fromCache = false;
  if (file) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (
        cached?.checksum === checksum &&
        cached?.model === model &&
        Array.isArray(cached?.vectors) &&
        cached.vectors.length === corpus.length
      ) {
        vectors = decode(cached.vectors);
        fromCache = true;
      }
    } catch {
      // No cache, or an unreadable one: embed afresh below.
    }
  }
  if (!vectors) {
    vectors = [];
    const texts = corpus.map(embeddingText);
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      vectors.push(
        ...(await embedTexts({ runtimeUrl, model, texts: batch, fetchImpl, signal })),
      );
      onProgress(vectors.length, texts.length);
    }
    if (file) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ checksum, model, dims: vectors[0]?.length ?? 0, vectors: encode(vectors) }),
      );
    }
  }
  const dims = vectors[0]?.length ?? 0;
  return {
    model,
    dims,
    size: vectors.length,
    fromCache,
    /** Embed one question with the same model; a unit vector. */
    async embedQuery(question) {
      const [vector] = await embedTexts({ runtimeUrl, model, texts: [question], fetchImpl });
      return vector;
    },
    /**
     * The `k` most similar records to a unit vector.
     * @returns {{index: number, similarity: number}[]} Best first.
     */
    search(query, k = 50) {
      if (!query || query.length !== dims) return [];
      const scored = [];
      for (let index = 0; index < vectors.length; index += 1)
        scored.push({ index, similarity: dot(query, vectors[index]) });
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, k);
    },
  };
}
