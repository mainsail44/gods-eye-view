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

/** A corpus shaped like the real one: same boilerplate, different places. */
const rankingCorpus = () => [
  {
    id: 'dc-far',
    kind: 'datacenter',
    label: 'Lyon Interxion',
    lat: 45.8,
    lon: 4.8,
    text: 'datacenters. name: Lyon Interxion. operator: Digital Realty. nearest cable landing point: Marseille, France (283.5 km).',
    nearestKm: 283.5,
  },
  {
    id: 'dc-near',
    kind: 'datacenter',
    label: 'Marseille Nedelec',
    lat: 43.3,
    lon: 5.4,
    text: 'datacenters. name: Marseille Nedelec. operator: Equinix. nearest cable landing point: Marseille, France (1.1 km).',
    nearestKm: 1.1,
  },
  {
    id: 'dc-brondby',
    kind: 'datacenter',
    label: 'Brondby site',
    lat: 55.6,
    lon: 12.4,
    text: 'datacenters. name: Brondby site. operator: Interxion. nearest cable landing point: Brondby, Denmark (2.0 km).',
    nearestKm: 2,
  },
  {
    id: 'lp-marseille-france',
    kind: 'landing-point',
    label: 'Marseille, France',
    lat: 43.3,
    lon: 5.3,
    text: 'submarine cable landing points. name: Marseille, France.',
  },
];

const citationIds = async (corpus, question, limit) => {
  const handler = createIntelHandler({
    corpus,
    model: 'local-model',
    runtime: 'llama.cpp',
    answer: async ({ records }) => ({
      answer: '',
      citations: records.map((record) => ({ id: record.id })),
    }),
  });
  const { body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question, limit },
  });
  return JSON.parse(body).citations.map((citation) => citation.id);
};

test('"near" means near: tied records are ordered by stored distance', async () => {
  // Both Marseille datacenters match exactly the same terms. Without the
  // distance the 283 km one came first, purely because of its id.
  assert.deepEqual(
    await citationIds(
      rankingCorpus(),
      'which datacenters are near the Marseille landing point?',
      2,
    ),
    ['dc-near', 'dc-far'],
  );
});

test('a term only matches whole words, so "by" is not inside "Brondby"', async () => {
  // "operated" and "by" are noise; matching them as substrings once buried
  // every Equinix record under sites whose town happens to contain "by".
  assert.deepEqual(
    await citationIds(rankingCorpus(), 'datacenters operated by Equinix', 1),
    ['dc-near'],
  );
});

test('a question of nothing but stopwords retrieves nothing', async () => {
  const ids = await citationIds(rankingCorpus(), 'which are the ones in at of');
  assert.deepEqual(ids, []);
});

test('singular and plural still find each other', async () => {
  const ids = await citationIds(rankingCorpus(), 'datacenter', 4);
  assert.equal(ids.length, 3, 'all three datacenters, not the landing point');
  assert.ok(!ids.includes('lp-marseille-france'));
  assert.deepEqual(
    await citationIds(rankingCorpus(), 'submarine cable landing point', 1),
    ['lp-marseille-france'],
  );
});

test('the place itself outranks a datacenter it would otherwise tie with', async () => {
  const ids = await citationIds(rankingCorpus(), 'landing points in France', 2);
  assert.equal(ids[0], 'lp-marseille-france');
});

test('a place name does not retrieve a record that merely begins with it', async () => {
  // "Virginia" once matched "Virgin Media" — a record in Cornwall — because
  // a term matched any token it was a prefix of. Only plural suffixes may differ.
  const corpus = [
    ...rankingCorpus(),
    {
      id: 'dc-virgin-media',
      kind: 'datacenter',
      label: 'Virgin Media',
      lat: 50.07,
      lon: -5.68,
      text: 'datacenters. name: Virgin Media. nearest cable landing point: Skewjack (0.6 km).',
      nearestKm: 0.6,
    },
    {
      id: 'dc-nova',
      kind: 'datacenter',
      label: 'STACK NVA01A - Northern Virginia',
      lat: 39.0,
      lon: -77.44,
      text: 'datacenters. name: STACK NVA01A - Northern Virginia. nearest cable landing point: Virginia Beach (250.0 km).',
      nearestKm: 250,
    },
  ];
  assert.deepEqual(await citationIds(corpus, 'Virginia', 5), ['dc-nova']);
  assert.deepEqual(await citationIds(corpus, 'Virgin', 5), ['dc-virgin-media']);
});

// --- The AI-native pipeline: reader, gazetteer, vectors and camera actions.

import { deriveActions } from '../../services/intel/src/server.js';

const query = async (handler, question, limit = 5) => {
  const { body } = await invoke(handler, {
    method: 'POST',
    url: '/query',
    body: { question, limit },
  });
  return JSON.parse(body);
};

const VIRGINIA_CORPUS = () => [
  ...rankingCorpus(),
  {
    id: 'dc-stack',
    kind: 'datacenter',
    label: 'STACK NVA01A',
    lat: 39.0047,
    lon: -77.4418,
    city: 'Sterling',
    region: 'Virginia',
    country: 'United States',
    text: 'datacenters. name: STACK NVA01A. located in Sterling, Virginia, United States.',
    nearestKm: 218,
  },
  {
    id: 'dc-virgin',
    kind: 'datacenter',
    label: 'Virgin Media',
    lat: 50.0698,
    lon: -5.6771,
    city: 'Sennen',
    region: 'England',
    country: 'United Kingdom',
    text: 'datacenters. operator: Virgin Media. located in Sennen, England, United Kingdom.',
    nearestKm: 0.7,
  },
];

test('the reader, the gazetteer and the model each leave a step in the trace', async () => {
  const seen = {};
  const handler = createIntelHandler({
    corpus: VIRGINIA_CORPUS(),
    model: 'answer-model',
    runtime: 'test',
    reader: async () => ({
      reading: {
        place: 'Woodbridge',
        region: 'Virginia',
        country: '',
        entityType: 'datacenter',
        operator: '',
        intent: 'list_in_place',
        radiusKm: 0,
      },
      source: 'model',
      ms: 7,
    }),
    readerModel: 'reader-model',
    gazetteer: {
      size: 1,
      resolve: (reading) =>
        reading.place === 'Woodbridge'
          ? {
              kind: 'place',
              name: 'Woodbridge',
              region: 'Virginia',
              country: 'United States',
              lat: 38.6582,
              lon: -77.2497,
              confidence: 'exact',
            }
          : null,
    },
    answer: async ({ records, place }) => {
      seen.place = place;
      seen.records = records;
      return {
        answer: 'STACK NVA01A is the nearest.',
        usedIds: ['dc-stack'],
        camera: 'site',
        focusId: 'dc-stack',
        model: 'answer-model',
      };
    },
  });
  const body = await query(
    handler,
    'what datacenters are in Woodbridge, Virginia',
  );
  assert.equal(body.answer, 'STACK NVA01A is the nearest.');
  assert.deepEqual(
    body.citations.map((citation) => citation.id),
    ['dc-stack'],
  );
  assert.equal(body.citations[0].city, 'Sterling');
  assert.ok(
    body.citations[0].why.km > 40 && body.citations[0].why.km < 50,
    `distance ${body.citations[0].why.km}`,
  );
  assert.equal(body.place.name, 'Woodbridge');
  assert.equal(body.reading.place, 'Woodbridge');
  assert.deepEqual(
    body.trace.map((step) => step.step),
    ['read', 'resolve', 'retrieve', 'answer'],
  );
  assert.match(
    body.trace[0].detail,
    /Woodbridge, Virginia · datacenters · list_in_place/,
  );
  assert.match(
    body.trace[1].detail,
    /Woodbridge, Virginia, United States \(38\.66, -77\.25\)/,
  );
  assert.match(
    body.trace[2].detail,
    /1 of 6 records · keywords \+ place · within 75 km/,
  );
  assert.deepEqual(body.actions, [
    { type: 'fly', id: 'dc-stack' },
    {
      type: 'place',
      kind: 'place',
      name: 'Woodbridge',
      region: 'Virginia',
      country: 'United States',
      lat: 38.6582,
      lon: -77.2497,
      confidence: 'exact',
    },
  ]);
  assert.equal(seen.place.name, 'Woodbridge');
  assert.equal(
    seen.records[0].why.km,
    body.citations[0].why.km,
    'the model is told the distance',
  );
});

test('a place with nothing near it declines, naming the place and the reach', async () => {
  const handler = createIntelHandler({
    corpus: VIRGINIA_CORPUS(),
    model: 'm',
    runtime: 'test',
    reader: async () => ({
      reading: {
        place: 'Perth',
        region: '',
        country: 'Australia',
        entityType: 'datacenter',
        operator: '',
        intent: 'list_in_place',
        radiusKm: 0,
      },
      source: 'model',
      ms: 1,
    }),
    gazetteer: {
      size: 1,
      resolve: () => ({
        kind: 'place',
        name: 'Perth',
        region: 'Western Australia',
        country: 'Australia',
        lat: -31.95,
        lon: 115.86,
        confidence: 'exact',
      }),
    },
    answer: async () => {
      throw new Error('must not be asked');
    },
  });
  const body = await query(handler, 'datacenters in Perth');
  assert.equal(body.answer, 'No matching records within 75 km of Perth.');
  assert.deepEqual(body.citations, []);
  assert.equal(body.actions[0].type, 'place');
});

test('a model that ignores the used ids still gets its citations in retrieval order', async () => {
  const handler = createIntelHandler({
    corpus: VIRGINIA_CORPUS(),
    model: 'm',
    runtime: 'test',
    answer: async () => ({
      answer: 'prose only',
      usedIds: [],
      camera: '',
      focusId: '',
    }),
  });
  const body = await query(handler, 'Virgin Media');
  assert.deepEqual(
    body.citations.map((citation) => citation.id),
    ['dc-virgin'],
  );
  assert.deepEqual(body.actions, [{ type: 'fly', id: 'dc-virgin' }]);
  assert.deepEqual(
    body.trace.map((step) => step.step),
    ['retrieve', 'answer'],
    'no reader, no gazetteer: no such steps',
  );
});

test('vectors join the retrieval once the index is ready', async () => {
  const corpus = VIRGINIA_CORPUS();
  const index = {
    model: 'embed',
    size: corpus.length,
    dims: 2,
    embedQuery: async () => new Float32Array([1, 0]),
    search: () => [
      {
        index: corpus.findIndex((record) => record.id === 'dc-virgin'),
        similarity: 0.9,
      },
    ],
  };
  const handler = createIntelHandler({
    corpus,
    model: 'm',
    runtime: 'test',
    embeddings: () => index,
    answer: async () => ({
      answer: 'x',
      usedIds: [],
      camera: 'none',
      focusId: '',
    }),
  });
  const body = await query(handler, 'the cable station on the Cornish coast');
  assert.equal(body.citations[0].id, 'dc-virgin');
  assert.equal(body.citations[0].why.similarity, 0.9);
  assert.match(body.trace[0].detail, /vectors/);
  assert.deepEqual(body.actions, [], 'camera none means no action');
});

test('health reports the reader, the vector index and the gazetteer', async () => {
  const handler = createIntelHandler({
    corpus: RECORDS,
    model: 'm',
    runtime: 'test',
    reader: async () => ({}),
    readerModel: 'r',
    gazetteer: { size: 42, resolve: () => null },
    embeddings: () => null,
    embeddingsStatus: () => ({
      model: 'embed',
      ready: false,
      indexed: 10,
      total: 2,
    }),
    answer: async () => ({}),
  });
  const health = JSON.parse((await invoke(handler)).body);
  assert.deepEqual(health.reader, { model: 'r' });
  assert.deepEqual(health.embeddings, {
    model: 'embed',
    ready: false,
    indexed: 10,
    total: 2,
  });
  assert.deepEqual(health.gazetteer, { places: 42 });
});

test('camera actions never point at an id the model was not shown', () => {
  const citations = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    deriveActions({ camera: 'site', focusId: 'zzz' }, citations, null),
    [{ type: 'fly', id: 'a' }],
  );
  assert.deepEqual(deriveActions({ camera: 'frame_all' }, citations, null), [
    { type: 'frame', ids: ['a', 'b'] },
  ]);
  assert.deepEqual(deriveActions({ camera: 'none' }, citations, null), []);
  assert.deepEqual(deriveActions({}, [{ id: 'a' }], null), [
    { type: 'fly', id: 'a' },
  ]);
  assert.deepEqual(deriveActions({}, [], null), []);
});
