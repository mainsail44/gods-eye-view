# Starlight Local Intel core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a locally-hosted AI that answers questions about God's Eye View's bundled geospatial data, exposed as a "Starlight Local Intel" component the operator can toggle on and off from the interface.

**Architecture:** A standalone `starlight-intel` service (its own OCI image, scheduled by Starlight) exposes an OpenAI-compatible passthrough, a grounded `/query`, and a `/health` reporting model, corpus checksum, and egress state. God's Eye View talks to it through a server-side provider proxy and renders it as a toggleable HUD component registered through the existing layer-state plumbing.

**Tech Stack:** Node.js 24.14+, Vite 6 provider-plugin middleware, plain ES modules, `node:test` for unit tests, Podman for the service image.

**Spec:** `docs/superpowers/specs/2026-09-17-starlight-sovereign-intel-design.md`

## Global Constraints

- Node.js `>=24.14.0 <25 || >=26 <27` — matches `package.json` engines.
- `npm test` discovers `*.test.mjs` **only under `src/`** (see `scripts/run-unit-tests.mjs`, `discoverUnitTestFiles`). A test placed under `server/` or `services/` will not run. Put every test for this plan under `src/`, importing across directories where needed.
- Every entry in `package.json` `exports` must be classified in exactly one group in `scripts/package-boundaries.json`, or `npm run check:boundaries` throws "Every package export must belong to exactly one boundary group".
- `npm run check:boundaries` must stay green. It builds each export group and rejects imports outside its declared ownership.
- No emoji anywhere in product UI or copy — brand rule, non-negotiable.
- Sentence case in UI copy. Exception: the proper product name "Starlight Local Intel" keeps its casing.
- Banned words in any user-visible copy: unlock, empower, supercharge, revolutionize, blazing fast, next-gen, journey.
- Never imply Mainsail hosts anything. Starlight is software the customer runs.
- Run `npm run format` before each commit; the repo gates on `npm run format:check` with Prettier 3.9.6.
- Commit messages carry NO `Co-Authored-By:` trailers and no AI attribution of any kind.
- New `*.test.mjs` files must be added to `scripts/format-scope.json`; `scripts/format.mjs` excludes them from auto-discovery, so they otherwise escape the formatting gate.
- A module belongs in a `scripts/package-boundaries.json` group only if that group actually imports it.

---

### Task 1: Configurable model endpoint

Proves the answer path can leave the cloud before any new service exists. After this task, pointing `OPENAI_BASE_URL` at a local OpenAI-compatible runtime makes the existing HUD summary local.

**Files:**
- Create: `src/sources/intelEndpoint.js`
- Create: `src/sources/intelEndpoint.test.mjs`
- Modify: `server/providers/openai/hud-summary.js:54`
- Modify: `server/providers/openai/realtime.js:19`
- Modify: `.env.container.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveIntelBaseUrl(value: string) => string` (normalized origin with no trailing slash; throws `TypeError` when not absolute http/https), `intelUrl(baseUrl: string, path: string) => string`.

- [ ] **Step 1: Write the failing test**

Create `src/sources/intelEndpoint.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntelBaseUrl, intelUrl } from './intelEndpoint.js';

test('strips a trailing slash from the base URL', () => {
  assert.equal(resolveIntelBaseUrl('http://intel.local:8080/'), 'http://intel.local:8080');
});

test('keeps a path prefix intact', () => {
  assert.equal(resolveIntelBaseUrl('http://intel.local/v1/'), 'http://intel.local/v1');
});

test('rejects a relative or non-http base URL', () => {
  assert.throws(() => resolveIntelBaseUrl('/v1'), TypeError);
  assert.throws(() => resolveIntelBaseUrl('ftp://intel.local'), TypeError);
  assert.throws(() => resolveIntelBaseUrl(''), TypeError);
});

test('joins a path onto the base exactly once', () => {
  assert.equal(intelUrl('http://intel.local', '/query'), 'http://intel.local/query');
  assert.equal(intelUrl('http://intel.local/', 'query'), 'http://intel.local/query');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/sources/intelEndpoint.test.mjs`
Expected: FAIL — `Cannot find module` for `./intelEndpoint.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sources/intelEndpoint.js`:

```js
/** Normalize a local inference base URL to an absolute origin with no trailing slash. */
export function resolveIntelBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new TypeError('An intel base URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`Intel base URL must be absolute: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new TypeError(`Intel base URL must be http or https: ${raw}`);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Join a request path onto a normalized base URL exactly once. */
export function intelUrl(baseUrl, path) {
  const base = resolveIntelBaseUrl(baseUrl);
  return `${base}/${String(path ?? '').replace(/^\/+/, '')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/sources/intelEndpoint.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Honor the base URL in the existing OpenAI providers**

In `server/providers/openai/hud-summary.js`, add at the top of the file:

```js
import { intelUrl } from '../../../src/sources/intelEndpoint.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
```

Then at line 54, change the fetch target from the literal `'https://api.openai.com/v1/responses'` to:

```js
intelUrl(OPENAI_BASE, '/v1/responses')
```

In `server/providers/openai/realtime.js`, add the same import, then change the default parameter at line 19 from the literal string to:

```js
  endpoint = intelUrl(
    process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    '/v1/realtime/client_secrets',
  ),
```

- [ ] **Step 6: Document the variable**

In `.env.container.example`, add under the server-side key section:

```
# Point model calls at any OpenAI-compatible runtime (Ollama, vLLM,
# llama.cpp). Leave unset to use OpenAI.
OPENAI_BASE_URL=
```

- [ ] **Step 7: Verify nothing regressed**

Run: `npm test`
Expected: PASS, including the 4 new tests.

Run: `npm run check:boundaries`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
npm run format
git add src/sources/intelEndpoint.js src/sources/intelEndpoint.test.mjs \
        server/providers/openai/hud-summary.js server/providers/openai/realtime.js \
        .env.container.example
git commit -m "feat: allow model calls to target a local OpenAI-compatible runtime"
```

---

### Task 2: Intel response contract

Pure, browser-safe normalization of what the service returns. Everything downstream depends on these shapes, and malformed responses get rejected here rather than in the UI.

**Files:**
- Create: `src/sources/intel.js`
- Create: `src/sources/intel.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `INTEL_HEALTH_PATH = '/health'`, `INTEL_QUERY_PATH = '/query'`
  - `normalizeIntelHealth(raw: unknown) => { ok: boolean, model: string, runtime: string, corpusVersion: string, corpusChecksum: string, egress: 'blocked'|'allowed'|'unknown', attestation: 'verified'|'unverified'|'unavailable' }` (frozen)
  - `normalizeIntelAnswer(raw: unknown) => { answer: string, citations: Array<{ id: string, label: string, lat: number, lon: number }>, actions: unknown[] }` (frozen)
  - `buildIntelQueryBody(question: string, options?: { limit?: number }) => { question: string, limit: number }`

- [ ] **Step 1: Write the failing test**

Create `src/sources/intel.test.mjs`:

```js
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
    limit: 8,
  });
  assert.equal(buildIntelQueryBody('q', { limit: 999 }).limit, 50);
  assert.equal(buildIntelQueryBody('q', { limit: 0 }).limit, 1);
});

test('rejects a blank question', () => {
  assert.throws(() => buildIntelQueryBody('   '), TypeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/sources/intel.test.mjs`
Expected: FAIL — `Cannot find module` for `./intel.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sources/intel.js`:

```js
export const INTEL_HEALTH_PATH = '/health';
export const INTEL_QUERY_PATH = '/query';

const EGRESS_STATES = new Set(['blocked', 'allowed']);
const ATTESTATION_STATES = new Set(['verified', 'unverified']);
const MAX_ANSWER_CHARS = 4000;
const MAX_CITATIONS = 50;

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Normalize the service health payload; anything unusable reports not ok. */
export function normalizeIntelHealth(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const model = text(source.model, 120);
  const runtime = text(source.runtime, 120);
  const corpus =
    source.corpus && typeof source.corpus === 'object' ? source.corpus : {};
  const egress = text(source.egress, 16);
  const attestation = text(source.attestation, 16);
  return Object.freeze({
    ok: Boolean(model),
    model,
    runtime,
    corpusVersion: text(corpus.version, 64),
    corpusChecksum: text(corpus.checksum, 128),
    egress: EGRESS_STATES.has(egress) ? egress : 'unknown',
    attestation: ATTESTATION_STATES.has(attestation)
      ? attestation
      : 'unavailable',
  });
}

const citation = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const id = text(entry.id, 120);
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!id) return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  return Object.freeze({ id, label: text(entry.label, 200), lat, lon });
};

/** Normalize an answer, discarding citations that cannot be placed on the globe. */
export function normalizeIntelAnswer(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const citations = Array.isArray(source.citations) ? source.citations : [];
  return Object.freeze({
    answer: text(source.answer, MAX_ANSWER_CHARS),
    citations: Object.freeze(
      citations.slice(0, MAX_CITATIONS).map(citation).filter(Boolean),
    ),
    actions: Object.freeze(
      Array.isArray(source.actions) ? [...source.actions] : [],
    ),
  });
}

/** Build a bounded query body; a blank question is a programming error. */
export function buildIntelQueryBody(question, { limit = 8 } = {}) {
  const trimmed = text(question, 500);
  if (!trimmed) throw new TypeError('A question is required');
  // `Number(limit) || 8` would swallow a caller's explicit 0 and widen the
  // request to 8; clamp a finite value instead, however small.
  const requested = Number(limit);
  const bounded = Number.isFinite(requested)
    ? Math.min(50, Math.max(1, Math.trunc(requested)))
    : 8;
  return { question: trimmed, limit: bounded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/sources/intel.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/sources/intel.js src/sources/intel.test.mjs
git commit -m "feat: add intel service response contract"
```

---

### Task 3: Intel service — corpus and retrieval mode

The service's two pure decisions: which corpus answered (checksum) and which retrieval mode a question needs. Built first because they are testable without a model.

**Files:**
- Create: `services/intel/src/corpus.js`
- Create: `src/sources/intelCorpus.test.mjs` (under `src/` so `npm test` discovers it — see Global Constraints)

**Interfaces:**
- Consumes: nothing.
- Produces: `corpusChecksum(records: Array<object>) => string` (sha256 hex, order-independent), `selectRetrievalMode(question: string) => 'metric' | 'document'`.

- [ ] **Step 1: Write the failing test**

Create `src/sources/intelCorpus.test.mjs`:

```js
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
  assert.equal(selectRetrievalMode('what is the average snr over europe'), 'metric');
  assert.equal(selectRetrievalMode('show propagation paths in the last hour'), 'metric');
});

test('place questions route to document retrieval', () => {
  assert.equal(
    selectRetrievalMode('which datacenters are near a cable landing'),
    'document',
  );
  assert.equal(selectRetrievalMode(''), 'document');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/sources/intelCorpus.test.mjs`
Expected: FAIL — cannot find `services/intel/src/corpus.js`.

- [ ] **Step 3: Write minimal implementation**

Create `services/intel/src/corpus.js`:

```js
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
  return METRIC_HINTS.some((hint) => value.includes(hint)) ? 'metric' : 'document';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/sources/intelCorpus.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add services/intel/src/corpus.js src/sources/intelCorpus.test.mjs
git commit -m "feat: add intel corpus checksum and retrieval mode selection"
```

---

### Task 4: Intel service — HTTP surface and image

The service itself: health, grounded query, and its own Containerfile so Starlight can schedule it independently of the application.

**Files:**
- Create: `services/intel/src/server.js`
- Create: `services/intel/src/index.js`
- Create: `services/intel/Containerfile`
- Create: `services/intel/README.md`
- Create: `src/sources/intelServer.test.mjs`

**Interfaces:**
- Consumes: `corpusChecksum`, `selectRetrievalMode` (Task 3); `intelUrl` (Task 1).
- Produces: `createIntelHandler({ corpus, model, runtime, egress, attestation, answer }) => (req, res) => Promise<void>`, where `answer({ question, mode, records }) => Promise<{ answer: string, citations: Array }>`.

- [ ] **Step 1: Write the failing test**

Create `src/sources/intelServer.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelHandler } from '../../services/intel/src/server.js';

const RECORDS = [
  { id: 'dc-1', label: 'Site A', lat: 51.5, lon: -0.12, text: 'london datacenter' },
  { id: 'dc-2', label: 'Site B', lat: 40.7, lon: -74.0, text: 'new york datacenter' },
];

const invoke = (handler, { method = 'GET', url = '/health', body = null } = {}) =>
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
        if (event === 'data' && body) listener(Buffer.from(JSON.stringify(body)));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/sources/intelServer.test.mjs`
Expected: FAIL — cannot find `services/intel/src/server.js`.

- [ ] **Step 3: Write minimal implementation**

Create `services/intel/src/server.js`:

```js
import { corpusChecksum, selectRetrievalMode } from './corpus.js';

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve(null);
      }
    });
  });

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

/** Rank corpus records by naive term overlap; sufficient before embeddings. */
function retrieve(corpus, question, limit) {
  const terms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!terms.length) return [];
  return corpus
    .map((record) => {
      const haystack = `${record.label ?? ''} ${record.text ?? ''}`.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { record, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.record);
}

/**
 * Build the request handler. `answer` performs model inference and is injected
 * so routing and the decline-on-empty rule stay testable without a model.
 */
export function createIntelHandler({
  corpus = [],
  model,
  runtime,
  egress = 'unknown',
  attestation = 'unavailable',
  answer,
}) {
  const checksum = corpusChecksum(corpus);
  const version = new Date().toISOString().slice(0, 10);

  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        model,
        runtime,
        egress,
        attestation,
        corpus: { version, checksum, records: corpus.length },
      });
    }

    if (req.method === 'POST' && path === '/query') {
      const body = await readBody(req);
      const question = String(body?.question ?? '').trim();
      if (!question) return send(res, 400, { error: 'A question is required' });
      const requested = Number(body?.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(50, Math.max(1, Math.trunc(requested)))
        : 8;
      const mode = selectRetrievalMode(question);
      const records = retrieve(corpus, question, limit);

      // Declining beats guessing: an unsupported answer is worse than none.
      if (!records.length) {
        return send(res, 200, {
          answer: 'No matching records in the local corpus.',
          citations: [],
          actions: [],
          corpus: { version, checksum },
        });
      }

      const result = await answer({ question, mode, records });
      return send(res, 200, {
        answer: String(result?.answer ?? ''),
        citations: Array.isArray(result?.citations) ? result.citations : [],
        actions: Array.isArray(result?.actions) ? result.actions : [],
        corpus: { version, checksum },
      });
    }

    return send(res, 404, { error: 'Not found' });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/sources/intelServer.test.mjs`
Expected: PASS, 4 tests.

**Bounds (added after review):** the handler caps the request body at 64 KB
(65536 bytes, replying 413), the question at 2000 characters (replying 400),
and the number of distinct scored terms in `retrieve()` at 50. Each limit is a
named constant. Without them a 14 MB body parses and a 5000-term question
blocks the event loop for seconds, stalling every concurrent request. The
application proxy's own 500-character question cap sits well inside these.

- [ ] **Step 5: Add the entrypoint**

Create `services/intel/src/index.js`:

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createIntelHandler } from './server.js';
import { intelUrl } from '../../../src/sources/intelEndpoint.js';

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.INTEL_MODEL || 'unknown';
const RUNTIME_URL = process.env.INTEL_RUNTIME_URL || 'http://127.0.0.1:11434';
const RUNTIME = process.env.INTEL_RUNTIME || 'openai-compatible';
const CORPUS_PATH = process.env.INTEL_CORPUS || '/app/corpus/corpus.json';
const EGRESS = process.env.INTEL_EGRESS || 'unknown';

const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));

/** Ask the local runtime to answer strictly from the retrieved records. */
async function answer({ question, records }) {
  const context = records
    .map(
      (record) =>
        `- ${record.id}: ${record.label} (${record.lat}, ${record.lon}) ${record.text ?? ''}`,
    )
    .join('\n');
  const response = await fetch(intelUrl(RUNTIME_URL, '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Answer only from the records provided. If they do not contain the answer, say so. Never invent a location.',
        },
        { role: 'user', content: `Records:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  const payload = await response.json();
  return {
    answer: payload?.choices?.[0]?.message?.content ?? '',
    citations: records.map((record) => ({
      id: record.id,
      label: record.label,
      lat: record.lat,
      lon: record.lon,
    })),
  };
}

const handler = createIntelHandler({
  corpus,
  model: MODEL,
  runtime: RUNTIME,
  egress: EGRESS,
  answer,
});

createServer((req, res) => {
  handler(req, res).catch(() => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[intel] listening on ${PORT} - model ${MODEL} - egress ${EGRESS}`);
});
```

- [ ] **Step 6: Add the image and its README**

Create `services/intel/Containerfile`:

```dockerfile
# Starlight Local Intel - retrieval and inference service.
#
#   podman build -t starlight-intel -f services/intel/Containerfile .
#   podman run --rm -p 8080:8080 -v ./corpus:/app/corpus:ro \
#     -e INTEL_MODEL=<model> -e INTEL_RUNTIME_URL=<runtime> starlight-intel
#
# Build context is the repository root: the service shares
# src/sources/intelEndpoint.js with the application.

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app

COPY services/intel/src /app/services/intel/src
COPY src/sources/intelEndpoint.js /app/src/sources/intelEndpoint.js

ENV NODE_ENV=production \
    PORT=8080 \
    INTEL_CORPUS=/app/corpus/corpus.json

EXPOSE 8080
USER node

CMD ["node", "/app/services/intel/src/index.js"]
```

Create `services/intel/README.md`:

```markdown
# Starlight Local Intel service

Retrieval and inference over a local corpus. Runs as a Starlight workload; the
application reaches it through `/api/intel/*` and the browser never talks to it
directly.

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port, default 8080 |
| `INTEL_MODEL` | Model name reported by `/health` and sent to the runtime |
| `INTEL_RUNTIME_URL` | OpenAI-compatible runtime base URL (Ollama, vLLM, llama.cpp) |
| `INTEL_RUNTIME` | Runtime label reported by `/health` |
| `INTEL_CORPUS` | Path to the corpus JSON array |
| `INTEL_EGRESS` | `blocked` or `allowed`, reported by `/health` |

Endpoints: `GET /health`, `POST /query`.
```

- [ ] **Step 7: Verify the suite**

Run: `npm test`
Expected: PASS, including the new service tests.

- [ ] **Step 8: Commit**

```bash
npm run format
git add services/intel src/sources/intelServer.test.mjs
git commit -m "feat: add starlight-intel service with health and grounded query"
```

---

### Task 5: Application provider proxy

The browser never learns the service URL. This proxy is the only thing that talks to it.

**Files:**
- Create: `server/providers/sovereign.js`
- Create: `src/sources/sovereignProxy.test.mjs`
- Modify: `server/providers/local.js`
- Modify: `package.json` (`exports`)
- Modify: `scripts/package-boundaries.json`

**Interfaces:**
- Consumes: `intelUrl` (Task 1); `INTEL_HEALTH_PATH`, `INTEL_QUERY_PATH`, `buildIntelQueryBody` (Task 2).
- Produces: `createSovereignMiddleware({ baseUrl, timeoutMs, fetchImpl }) => (req, res, next) => Promise<void>`, `sovereignIntelProxy(options) => { name, configureServer, configurePreviewServer }`.

- [ ] **Step 1: Write the failing test**

Create `src/sources/sovereignProxy.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSovereignMiddleware } from '../../server/providers/sovereign.js';

const invoke = (middleware, { method = 'GET', url = '/health', body = null } = {}) =>
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
        if (event === 'data' && body) listener(Buffer.from(JSON.stringify(body)));
        if (event === 'end') listener();
        return this;
      },
    };
    void middleware(req, res, () => resolve({ status: 404, body: '' }));
  });

test('forwards health to the configured service', async () => {
  let requested = '';
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'local-model', runtime: 'llama.cpp' }),
      };
    },
  });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(requested, 'http://intel.local:8080/health');
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).model, 'local-model');
});

test('reports a degraded state when the service is unreachable', async () => {
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(status, 503);
  assert.equal(JSON.parse(body).ok, false);
});

test('reports degraded rather than throwing when no service is configured', async () => {
  const middleware = createSovereignMiddleware({ baseUrl: '' });
  const { status, body } = await invoke(middleware, { url: '/health' });
  assert.equal(status, 503);
  assert.match(JSON.parse(body).reason, /not configured/i);
});

test('forwards a query body', async () => {
  let sent = null;
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ answer: 'ok', citations: [] }) };
    },
  });
  const { status } = await invoke(middleware, {
    method: 'POST',
    url: '/query',
    body: { question: 'where are the cables', limit: 5 },
  });
  assert.equal(status, 200);
  assert.equal(sent.url, 'http://intel.local:8080/query');
  assert.equal(sent.body.question, 'where are the cables');
  assert.equal(sent.body.limit, 5);
});

test('a blank question never reaches the service', async () => {
  let called = false;
  const middleware = createSovereignMiddleware({
    baseUrl: 'http://intel.local:8080',
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const { status } = await invoke(middleware, {
    method: 'POST',
    url: '/query',
    body: { question: '  ' },
  });
  assert.equal(status, 400);
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/sources/sovereignProxy.test.mjs`
Expected: FAIL — cannot find `server/providers/sovereign.js`.

- [ ] **Step 3: Write minimal implementation**

Create `server/providers/sovereign.js`:

```js
import { intelUrl } from '../../src/sources/intelEndpoint.js';
import {
  INTEL_HEALTH_PATH,
  INTEL_QUERY_PATH,
  buildIntelQueryBody,
} from '../../src/sources/intel.js';

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve(null);
      }
    });
  });

/**
 * Bridge the browser to the intel service. An unreachable service is a
 * degraded state, not an error: the map keeps working without it.
 */
export function createSovereignMiddleware({
  baseUrl = process.env.STARLIGHT_INTEL_URL || '',
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function middleware(req, res, next) {
    const path = String(req.url || '').split('?')[0];
    const isHealth = req.method === 'GET' && path === INTEL_HEALTH_PATH;
    const isQuery = req.method === 'POST' && path === INTEL_QUERY_PATH;
    if (!isHealth && !isQuery) return next();

    if (!baseUrl)
      return send(res, 503, { ok: false, reason: 'Intel service is not configured' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      if (isHealth) {
        response = await fetchImpl(intelUrl(baseUrl, INTEL_HEALTH_PATH), {
          signal: controller.signal,
        });
      } else {
        const body = await readBody(req);
        let payload;
        try {
          payload = buildIntelQueryBody(body?.question, { limit: body?.limit });
        } catch {
          return send(res, 400, { error: 'A question is required' });
        }
        response = await fetchImpl(intelUrl(baseUrl, INTEL_QUERY_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      }
      return send(res, response.status ?? 200, await response.json());
    } catch {
      return send(res, 503, { ok: false, reason: 'Intel service unreachable' });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function sovereignIntelProxy(options = {}) {
  const middleware = createSovereignMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/intel', middleware);
  };
  return {
    name: 'sovereign-intel-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/sources/sovereignProxy.test.mjs`
Expected: PASS, 5 tests.

**Bound (added after review):** the proxy's `readBody` caps the browser's
request body at 64 KB (65536 bytes, a named constant matching the service),
stopping accumulation as chunks arrive, and the middleware replies 413 without
contacting the service. The proxy runs inside the process serving production
traffic, so unbounded buffering there is worse than in the service itself.

- [ ] **Step 5: Register the provider**

In `server/providers/local.js`, add alongside the other imports:

```js
import { sovereignIntelProxy } from './sovereign.js';
```

and add `sovereignIntelProxy(),` to the array returned by `localProviderPlugins()`, immediately before `keySetupEndpoint(),`.

- [ ] **Step 6: Declare the export and its boundary**

In `package.json`, add to `exports`:

```json
    "./server/providers/sovereign": {
      "node": "./server/providers/sovereign.js"
    },
```

In `scripts/package-boundaries.json`, add a new group:

```json
  "sovereign-provider": {
    "runtime": "node",
    "exports": ["./server/providers/sovereign"],
    "modules": [
      "server/providers/sovereign.js",
      "src/sources/intel.js",
      "src/sources/intelEndpoint.js"
    ],
    "external": []
  }
```

- [ ] **Step 7: Verify the gates**

Run: `npm run check:boundaries`
Expected: exit 0. A failure naming "Every package export must belong to exactly one boundary group" means `package.json` and `package-boundaries.json` disagree.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run format
git add server/providers/sovereign.js src/sources/sovereignProxy.test.mjs \
        server/providers/local.js package.json scripts/package-boundaries.json
git commit -m "feat: proxy the intel service behind /api/intel"
```

---

### Task 6: Starlight Local Intel panel behavior

> **Superseded reference code.** The implementation below was found defective in
> review and must not be transcribed again. It let `disable()` leave an in-flight
> query running, let results that resolved after `disable()` write state and fire
> `onCite`, and let `enable(); disable(); enable();` start two poll loops. The
> shipped module (`src/ui/starlightIntel.js`) is authoritative: a generation
> counter incremented by both `enable()` and `disable()`, plus a per-`ask()`
> controller identity check, each compared after every await in both the success
> and catch paths before any state write, render, `onCite`, or timer re-arm. Tests
> for this module only count if they fail against the code they claim to catch.

The component's behavior, independent of the DOM it renders into. The decisive rule: disabled means no network traffic at all.

**Files:**
- Create: `src/ui/starlightIntel.js`
- Create: `src/ui/starlightIntel.test.mjs`

**Interfaces:**
- Consumes: `normalizeIntelHealth`, `normalizeIntelAnswer`, `buildIntelQueryBody` (Task 2).
- Produces: `createStarlightIntelPanel({ transport, pollMs?, onRender?, onCite? }) => { enable(): void, disable(): void, ask(question: string): Promise<void>, state(): { enabled, health, answer, status } }`, where `transport = { health(signal), query(body, signal) }`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/starlightIntel.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarlightIntelPanel } from './starlightIntel.js';

const transportStub = () => {
  const calls = { health: 0, query: 0 };
  return {
    calls,
    async health() {
      calls.health += 1;
      return { model: 'local-model', runtime: 'llama.cpp', egress: 'blocked' };
    },
    async query() {
      calls.query += 1;
      return {
        answer: 'Two sites.',
        citations: [{ id: 'dc-1', label: 'A', lat: 1, lon: 2 }],
      };
    },
  };
};

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

test('a disabled panel issues no requests', async () => {
  const transport = transportStub();
  const panel = createStarlightIntelPanel({ transport });
  await panel.ask('where are the cables');
  assert.equal(transport.calls.health, 0);
  assert.equal(transport.calls.query, 0);
});

test('enabling polls health once immediately', async () => {
  const transport = transportStub();
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  assert.equal(transport.calls.health, 1);
  assert.equal(panel.state().health.model, 'local-model');
  panel.disable();
});

test('asking while enabled records the answer and its citations', async () => {
  const transport = transportStub();
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  await panel.ask('where are the cables');
  assert.equal(transport.calls.query, 1);
  assert.equal(panel.state().answer.answer, 'Two sites.');
  assert.equal(panel.state().answer.citations[0].id, 'dc-1');
  panel.disable();
});

test('disabling clears health and stops further polling', async () => {
  const transport = transportStub();
  const panel = createStarlightIntelPanel({ transport, pollMs: 1 });
  panel.enable();
  await settle();
  panel.disable();
  const after = transport.calls.health;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(transport.calls.health, after);
  assert.equal(panel.state().health.ok, false);
});

test('an unreachable service degrades instead of throwing', async () => {
  const panel = createStarlightIntelPanel({
    transport: {
      async health() {
        throw new Error('unreachable');
      },
      async query() {
        throw new Error('unreachable');
      },
    },
  });
  panel.enable();
  await settle();
  assert.equal(panel.state().health.ok, false);
  await panel.ask('anything');
  assert.match(panel.state().status, /unavailable/i);
  panel.disable();
});

test('citations are reported to the host for camera moves', async () => {
  const seen = [];
  const panel = createStarlightIntelPanel({
    transport: transportStub(),
    onCite: (cite) => seen.push(cite.id),
  });
  panel.enable();
  await settle();
  await panel.ask('where');
  assert.deepEqual(seen, ['dc-1']);
  panel.disable();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/ui/starlightIntel.test.mjs`
Expected: FAIL — cannot find `./starlightIntel.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/starlightIntel.js`:

```js
import {
  normalizeIntelHealth,
  normalizeIntelAnswer,
  buildIntelQueryBody,
} from '../sources/intel.js';

const OFFLINE = normalizeIntelHealth(null);
const EMPTY = normalizeIntelAnswer(null);

/**
 * Behavior of the Starlight Local Intel component. Disabled is genuinely off:
 * polling stops, in-flight work aborts, and nothing reaches the network.
 */
export function createStarlightIntelPanel({
  transport,
  pollMs = 5_000,
  onRender = () => {},
  onCite = () => {},
}) {
  let enabled = false;
  let timer = null;
  let controller = null;
  let health = OFFLINE;
  let answer = EMPTY;
  let status = 'Disabled';

  const render = () => onRender({ enabled, health, answer, status });

  const poll = async () => {
    if (!enabled) return;
    controller = new AbortController();
    try {
      health = normalizeIntelHealth(await transport.health(controller.signal));
      status = health.ok ? 'Local' : 'Intel service unavailable';
    } catch {
      health = OFFLINE;
      status = 'Intel service unavailable';
    }
    if (!enabled) return;
    render();
    timer = setTimeout(poll, pollMs);
  };

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      status = 'Connecting';
      render();
      void poll();
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
      health = OFFLINE;
      answer = EMPTY;
      status = 'Disabled';
      render();
    },

    async ask(question) {
      if (!enabled) return;
      let body;
      try {
        body = buildIntelQueryBody(question);
      } catch {
        status = 'Ask a question first';
        render();
        return;
      }
      status = 'Thinking';
      render();
      const queryController = new AbortController();
      try {
        answer = normalizeIntelAnswer(
          await transport.query(body, queryController.signal),
        );
        status = health.ok ? 'Local' : 'Local (health unknown)';
        for (const cite of answer.citations) onCite(cite);
      } catch {
        answer = EMPTY;
        status = 'Intel service unavailable';
      }
      render();
    },

    state() {
      return { enabled, health, answer, status };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/ui/starlightIntel.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/ui/starlightIntel.js src/ui/starlightIntel.test.mjs
git commit -m "feat: add Starlight Local Intel panel behavior"
```

---

### Task 7: Register the component as a toggleable layer

> **Corrected layer contract.** The interface below was wrong as first written:
> it gave the layer only `init`, `setLifecyclePresentation` and `destroy`. The
> lifecycle manager (`src/data/lifecycle.js`) calls `init(viewer)`,
> `enable(viewer, { signal })`, `update(viewer, { signal })` and `disable()` with
> no `typeof` guard, so toggling the layer threw and left it in a stuck state.
> The shipped layer (`src/app/layers/starlightIntel.js`) is authoritative:
> `enable()` starts the panel and returns true, `disable()` stops it, `update()`
> is a no-op returning true, `updateInterval` stays 0, and there is deliberately
> NO `setLifecyclePresentation` — the manager fires that hook on every state
> transition, including mid-enable with `enabled: false`, which would flap the
> panel. Every panel call is optional, so a layer built with no panel is inert.

Uses the existing layer-state registry so the toggle appears in Data Layers, persists locally, and travels in share links.

**Files:**
- Create: `src/app/layers/starlightIntel.js`
- Create: `src/app/layers/starlightIntel.test.mjs`
- Modify: `src/data/layerState.js` (`LAYER_STATE_REGISTRY`)
- Modify: `src/app/catalog.js` (`CONTROL_LAYER_IDS`)
- Modify: `src/app/constructCatalog.js`

**Interfaces:**
- Consumes: the panel object from Task 6 (`enable()`, `disable()`).
- Produces: `createApplicationStarlightIntel({ panel }) => { id: 'starlight-intel', name: 'Starlight Local Intel', icon: '◆', source: 'Starlight', updateInterval: 0, init(): void, setLifecyclePresentation({ enabled }): void, destroy(): void }`.

Token `k` is free. `src/data/layerState.js` currently uses a, b, c, d, e, f, g, h, i, j, m, n, p, q, r, s, t, u, v, w, x, z. Do not reuse a token — `LAYER_STATE_REGISTRY` is indexed by token and a duplicate collides silently in share links.

- [ ] **Step 1: Write the failing test**

Create `src/app/layers/starlightIntel.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationStarlightIntel } from './starlightIntel.js';
import { LAYER_STATE_REGISTRY } from '../../data/layerState.js';

const panelStub = () => {
  const calls = [];
  return {
    calls,
    enable: () => calls.push('enable'),
    disable: () => calls.push('disable'),
  };
};

test('exposes the catalog contract', () => {
  const layer = createApplicationStarlightIntel({ panel: panelStub() });
  assert.equal(layer.id, 'starlight-intel');
  assert.equal(layer.name, 'Starlight Local Intel');
  assert.equal(typeof layer.setLifecyclePresentation, 'function');
});

test('lifecycle presentation drives the panel', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  layer.setLifecyclePresentation({ enabled: true });
  layer.setLifecyclePresentation({ enabled: false });
  assert.deepEqual(panel.calls, ['enable', 'disable']);
});

test('destroy stops the panel', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  layer.destroy();
  assert.deepEqual(panel.calls, ['disable']);
});

test('is registered for state serialization with a unique token', () => {
  const entry = LAYER_STATE_REGISTRY.find((item) => item.id === 'starlight-intel');
  assert.ok(entry, 'starlight-intel must be in LAYER_STATE_REGISTRY');
  assert.equal(entry.disposition, 'enabled-only');
  const tokens = LAYER_STATE_REGISTRY.map((item) => item.token);
  assert.equal(new Set(tokens).size, tokens.length, 'layer tokens must be unique');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/app/layers/starlightIntel.test.mjs`
Expected: FAIL — cannot find `./starlightIntel.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/layers/starlightIntel.js`:

```js
/**
 * Catalog entry for the Starlight Local Intel component. It owns no globe
 * geometry: the manager's enable gate simply starts and stops the panel.
 */
export function createApplicationStarlightIntel({ panel }) {
  return {
    id: 'starlight-intel',

    name: 'Starlight Local Intel',

    icon: '◆',

    source: 'Starlight',

    updateInterval: 0,

    init() {},

    setLifecyclePresentation({ enabled = false } = {}) {
      if (enabled) panel.enable();
      else panel.disable();
    },

    destroy() {
      panel.disable();
    },
  };
}
```

- [ ] **Step 4: Add the registry entry**

In `src/data/layerState.js`, inside `LAYER_STATE_REGISTRY`, add in alphabetical position by id (after the `satellites` entry):

```js
  Object.freeze({
    id: 'starlight-intel',
    token: 'k',
    disposition: 'enabled-only',
  }),
```

- [ ] **Step 5: Add the control mapping and construct the layer**

In `src/app/catalog.js`, add to `CONTROL_LAYER_IDS`:

```js
  starlightIntelLayer: 'starlight-intel',
```

In `src/app/constructCatalog.js`, add the import:

```js
import { createApplicationStarlightIntel } from './layers/starlightIntel.js';
```

Add `starlightIntelPanel` to the options object `createApplicationCatalog` destructures, and include `createApplicationStarlightIntel({ panel: starlightIntelPanel })` in the constructed layer list.

- [ ] **Step 6: Run tests**

Run: `node --test src/app/layers/starlightIntel.test.mjs`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/app/layers/starlightIntel.js src/app/layers/starlightIntel.test.mjs \
        src/data/layerState.js src/app/catalog.js src/app/constructCatalog.js
git commit -m "feat: register Starlight Local Intel as a toggleable layer"
```

---

### Task 8: Render the panel and verify end to end

> **Corrected wiring.** Two instructions below were wrong as first written.
> (1) The template marker belongs in `index.html`, beside the other
> `<!-- gev:template ... -->` markers — the expander makes one pass over
> `index.html` only, so a marker nested inside `scene-chrome.html` never expands.
> (2) The composition root is `src/standalone/application.js`, not
> `src/ui/applicationShell.js`: the catalog is built there inside `createScene`
> via `createStandaloneCatalog` (`src/standalone/catalog.js`), which must pass
> `starlightIntelPanel` through to `createApplicationCatalog`. DOM binding lives
> in its own small module rather than in the shell. The layer no longer has a
> `setLifecyclePresentation` hook (see Task 7); the manager's `enable()` /
> `disable()` calls drive the panel.

**Files:**
- Create: `src/ui/templates/starlight-intel.html`
- Modify: `build/application-html.js` (`APPLICATION_TEMPLATES`)
- Modify: `src/ui/templates/scene-chrome.html`
- Modify: `src/ui/styles/overlays.css`
- Modify: `src/ui/applicationShell.js`
- Modify: `.env.container.example`
- Modify: `compose.yaml`

**Interfaces:**
- Consumes: everything above.
- Produces: no new module API.

- [ ] **Step 1: Add the template**

Create `src/ui/templates/starlight-intel.html`:

```html
<div id="starlight-intel" class="starlight-intel" hidden>
  <div class="starlight-intel-head">
    <span class="starlight-intel-title">Starlight Local Intel</span>
    <span class="starlight-intel-status" data-intel-status>Disabled</span>
  </div>
  <div class="starlight-intel-meta" data-intel-meta></div>
  <form class="starlight-intel-ask" data-intel-form>
    <input
      type="text"
      data-intel-input
      placeholder="Ask about the local data"
      autocomplete="off"
    />
    <button type="submit">Ask</button>
  </form>
  <div class="starlight-intel-answer" data-intel-answer></div>
  <ul class="starlight-intel-citations" data-intel-citations></ul>
</div>
```

- [ ] **Step 2: Register the template name**

In `build/application-html.js`, add `'starlight-intel'` to the `APPLICATION_TEMPLATES` array. A template not listed there throws `Unknown application template` at build time.

In `src/ui/templates/scene-chrome.html`, add on its own line where the panel should appear:

```html
  <!-- gev:template starlight-intel -->
```

- [ ] **Step 3: Style the panel**

Append to `src/ui/styles/overlays.css`:

```css
/* Starlight Local Intel */
.starlight-intel {
  position: absolute;
  right: 20px;
  bottom: 150px;
  width: min(360px, calc(100vw - 40px));
  padding: 12px;
  border: 1px solid var(--hud-border);
  background: rgba(0, 0, 0, 0.62);
  font-size: 12px;
  pointer-events: auto;
}

.starlight-intel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.starlight-intel-title {
  font-weight: 600;
  letter-spacing: 1px;
}

.starlight-intel-status {
  opacity: 0.7;
}

.starlight-intel-meta {
  opacity: 0.6;
  font-size: 11px;
  margin-bottom: 8px;
}

.starlight-intel-ask {
  display: flex;
  gap: 6px;
}

.starlight-intel-ask input {
  flex: 1;
  min-width: 0;
}

.starlight-intel-answer {
  margin-top: 8px;
  line-height: 1.4;
}

.starlight-intel-citations {
  margin: 8px 0 0;
  padding-left: 16px;
}
```

- [ ] **Step 4: Wire the panel to the DOM**

In `src/ui/applicationShell.js`, construct the panel and pass it to the catalog. The transport calls the proxy, never the service:

```js
import { createStarlightIntelPanel } from './starlightIntel.js';

const intelTransport = {
  async health(signal) {
    const response = await fetch('/api/intel/health', { signal });
    return response.json();
  },
  async query(body, signal) {
    const response = await fetch('/api/intel/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return response.json();
  },
};

const intelElement = document.getElementById('starlight-intel');

/** Paint panel state; hidden when the component is toggled off. */
function renderStarlightIntel({ enabled, health, answer, status }) {
  if (!intelElement) return;
  intelElement.hidden = !enabled;
  intelElement.querySelector('[data-intel-status]').textContent = status;
  intelElement.querySelector('[data-intel-meta]').textContent = health.ok
    ? `${health.model} - corpus ${health.corpusVersion || 'unknown'} - egress ${health.egress}`
    : '';
  intelElement.querySelector('[data-intel-answer]').textContent = answer.answer;
  const list = intelElement.querySelector('[data-intel-citations]');
  list.replaceChildren();
  for (const cite of answer.citations) {
    const item = document.createElement('li');
    item.textContent = cite.label || cite.id;
    item.addEventListener('click', () => flyToCitation(cite));
    list.append(item);
  }
}

const starlightIntelPanel = createStarlightIntelPanel({
  transport: intelTransport,
  onRender: renderStarlightIntel,
});

intelElement?.querySelector('[data-intel-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = intelElement.querySelector('[data-intel-input]');
  void starlightIntelPanel.ask(input.value);
  input.value = '';
});
```

`flyToCitation({ lat, lon })` uses the shell's existing camera helper — the same one the search result handler calls to move the camera to a coordinate. Pass `starlightIntelPanel` into `createApplicationCatalog` as the `starlightIntelPanel` option added in Task 7.

- [ ] **Step 5: Document the service URL and compose the services**

In `.env.container.example`, add under the server-side section:

```
# Starlight Local Intel service, reached only from the server side.
STARLIGHT_INTEL_URL=http://starlight-intel:8080
```

In `compose.yaml`, add:

```yaml
  starlight-intel:
    image: localhost/starlight-intel:latest
    build:
      context: .
      dockerfile: services/intel/Containerfile
    env_file:
      - path: .env
        required: false
    volumes:
      - ./corpus:/app/corpus:ro
    restart: unless-stopped
```

- [ ] **Step 6: Verify the suite and the gates**

Run: `npm test`
Expected: PASS.

Run: `npm run check:boundaries`
Expected: exit 0.

Run: `npm run format:check`
Expected: PASS.

- [ ] **Step 7: Verify in the running application**

```bash
podman compose up -d --build --force-recreate
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173/api/intel/health
```

Expected: `503` with `{"ok":false,...}` when no intel service is reachable — the degraded path, not a crash. With the service running, expect `200` and a model name.

Open `http://localhost:4173`, open the Data Layers panel, and confirm:

1. "Starlight Local Intel" appears in the list.
2. Toggling it on shows the panel; toggling it off hides it and stops traffic. Check the browser network tab: no `/api/intel/*` requests while off.
3. The share URL changes when the layer is enabled, and reopening that URL restores it enabled.

**Note:** `podman compose up -d --build` rebuilds the image but leaves the old container running. `--force-recreate` is required to see code changes.

- [ ] **Step 8: Commit**

```bash
npm run format
git add src/ui/templates/starlight-intel.html build/application-html.js \
        src/ui/templates/scene-chrome.html src/ui/styles/overlays.css \
        src/ui/applicationShell.js .env.container.example compose.yaml
git commit -m "feat: render the Starlight Local Intel panel in the HUD"
```

---

## Verification checklist

Phase 1 core is done when all of these hold:

- [ ] `npm test` passes, including every test added by this plan.
- [ ] `npm run check:boundaries` exits 0.
- [ ] `npm run format:check` passes.
- [ ] "Starlight Local Intel" toggles on and off from the Data Layers panel.
- [ ] Disabled, the component issues no `/api/intel/*` requests.
- [ ] With the service running, a question over the local corpus returns an answer whose citations move the camera.
- [ ] With the service stopped, the panel reports unavailable and the map still works.
- [ ] The enabled state survives a page reload and travels in a share URL.
- [ ] Pulling the host's network connection changes none of the above.

## Out of scope for this plan

- SatNOGS and WSPR layers — plan 2.
- The corpus build step. This plan reads a prepared `corpus/corpus.json`;
  generating it from `datacenters-*.geojsonl`, the bundled cable data, and
  military installations is the first task of plan 2.
- Voice. The transport and service endpoints are the seam a future speech path
  reuses; nothing here forecloses it. Handy needs no integration: with the ask
  input focused, its dictation lands in the same field a keyboard would fill.
- Executing model-proposed map actions. The contract carries an `actions` array
  end to end, but phase 1 executes none of them — citations move the camera
  instead. Validating actions against `src/voice/actionSchemas.js` before
  execution is required by the spec and lands with the first task that actually
  runs them; do not execute an unvalidated action to close that gap early.
