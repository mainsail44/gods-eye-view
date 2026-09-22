import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createStarlightIntelView,
  describeIntelHealth,
} from './starlightIntelView.js';
import {
  normalizeIntelAnswer,
  normalizeIntelHealth,
} from '../sources/intel.js';

function makeNode(tagName = 'div') {
  const node = {
    tagName,
    type: '',
    className: '',
    hidden: false,
    textContent: '',
    value: '',
    children: [],
    listeners: {},
    addEventListener(type, handler) {
      (node.listeners[type] ||= []).push(handler);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...next) {
      node.children = next;
    },
    dispatch(type, event = {}) {
      for (const handler of node.listeners[type] || []) handler(event);
    },
  };
  return node;
}

function fixture() {
  const nodes = {
    '[data-intel-status]': makeNode('span'),
    '[data-intel-meta]': makeNode('p'),
    '[data-intel-answer]': makeNode('p'),
    '[data-intel-citations]': makeNode('ul'),
    '[data-intel-form]': makeNode('form'),
    '[data-intel-input]': makeNode('input'),
  };
  const element = makeNode('section');
  element.hidden = true;
  element.querySelector = (selector) => nodes[selector] ?? null;
  element.ownerDocument = { createElement: (tag) => makeNode(tag) };
  return { element, nodes };
}

const HEALTHY = normalizeIntelHealth({
  model: 'qwen2.5-7b-instruct',
  runtime: 'openai-compatible',
  corpus: { version: '2026-09-20', checksum: 'a1b2c3d4e5f6a7b8' },
  egress: 'blocked',
  attestation: 'verified',
});

test('health describes the model, corpus and egress on one middle-dot line', () => {
  assert.equal(
    describeIntelHealth(HEALTHY),
    'qwen2.5-7b-instruct · corpus 2026-09-20 a1b2c3d4 · egress blocked',
  );
  assert.equal(
    describeIntelHealth(
      normalizeIntelHealth({ model: 'local-model', egress: 'blocked' }),
    ),
    'local-model · corpus unknown · egress blocked',
  );
  // A service that is not reporting has nothing truthful to say.
  assert.equal(describeIntelHealth(normalizeIntelHealth(null)), '');
  assert.equal(describeIntelHealth(undefined), '');
});

test('the view hides while disabled and paints the panel once enabled', () => {
  const { element, nodes } = fixture();
  const view = createStarlightIntelView({ element });
  view.render({
    enabled: false,
    health: normalizeIntelHealth(null),
    answer: normalizeIntelAnswer(null),
    status: 'Disabled',
  });
  assert.equal(element.hidden, true);
  assert.equal(nodes['[data-intel-status]'].textContent, 'Disabled');
  assert.equal(nodes['[data-intel-meta]'].textContent, '');
  assert.equal(nodes['[data-intel-answer]'].textContent, '');

  view.render({
    enabled: true,
    health: HEALTHY,
    answer: normalizeIntelAnswer({ answer: 'Two sites match.' }),
    status: 'Local',
  });
  assert.equal(element.hidden, false);
  assert.equal(nodes['[data-intel-status]'].textContent, 'Local');
  assert.match(nodes['[data-intel-meta]'].textContent, /^qwen2\.5-7b-instruct/);
  assert.equal(nodes['[data-intel-answer]'].textContent, 'Two sites match.');
});

test('citations become keyboard-operable buttons that report the clicked entry', () => {
  const { element, nodes } = fixture();
  const clicked = [];
  const view = createStarlightIntelView({
    element,
    onCiteClick: (citation) => clicked.push(citation),
  });
  const answer = normalizeIntelAnswer({
    answer: 'Two sites match.',
    citations: [
      { id: 'dc-1', label: 'Ashburn campus', lat: 39.04, lon: -77.49 },
      { id: 'dc-2', lat: 53.35, lon: -6.26 },
    ],
  });
  view.render({ enabled: true, health: HEALTHY, answer, status: 'Local' });

  const list = nodes['[data-intel-citations]'];
  assert.equal(list.children.length, 2);
  const buttons = list.children.map((item) => item.children[0]);
  assert.deepEqual(
    buttons.map((button) => button.tagName),
    ['button', 'button'],
  );
  assert.deepEqual(
    buttons.map((button) => button.type),
    ['button', 'button'],
  );
  // A citation with no label still needs something to click; the id serves.
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ['Ashburn campus', 'dc-2'],
  );

  buttons[1].dispatch('click');
  assert.deepEqual(clicked, [answer.citations[1]]);

  // A later answer replaces the list rather than appending to it.
  view.render({
    enabled: true,
    health: HEALTHY,
    answer: normalizeIntelAnswer({ answer: 'No match.' }),
    status: 'Local',
  });
  assert.equal(list.children.length, 0);
});

test('markup text arrives only as text, never as markup', () => {
  const { element, nodes } = fixture();
  const view = createStarlightIntelView({ element });
  const hostile = '<img src=x onerror="alert(1)">';
  view.render({
    enabled: true,
    health: HEALTHY,
    answer: normalizeIntelAnswer({
      answer: hostile,
      citations: [{ id: 'dc-1', label: hostile, lat: 1, lon: 2 }],
    }),
    status: 'Local',
  });
  assert.equal(nodes['[data-intel-answer]'].textContent, hostile);
  assert.equal(
    nodes['[data-intel-citations]'].children[0].children[0].textContent,
    hostile,
  );
  const source = readFileSync(
    new URL('./starlightIntelView.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('submitting the form hands over the question and clears the field', () => {
  const { element, nodes } = fixture();
  const asked = [];
  createStarlightIntelView({
    element,
    onAsk: (question) => asked.push(question),
  });
  nodes['[data-intel-input]'].value = 'which cables land in Mombasa?';
  let prevented = false;
  nodes['[data-intel-form]'].dispatch('submit', {
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(asked, ['which cables land in Mombasa?']);
  assert.equal(nodes['[data-intel-input]'].value, '');
});

test('missing markup is a construction error, not a silent no-op', () => {
  assert.throws(() => createStarlightIntelView({}), /element is required/);
  const { element } = fixture();
  const complete = element.querySelector;
  element.querySelector = (selector) =>
    selector === '[data-intel-citations]' ? null : complete(selector);
  assert.throws(
    () => createStarlightIntelView({ element }),
    /missing \[data-intel-citations\]/,
  );
});

test('a repaint with the same answer keeps the citation buttons in place', () => {
  const { element, nodes } = fixture();
  const view = createStarlightIntelView({ element });
  const answer = normalizeIntelAnswer({
    answer: 'One site matches.',
    citations: [
      { id: 'dc-1', label: 'Ashburn campus', lat: 39.04, lon: -77.49 },
    ],
  });
  view.render({ enabled: true, health: HEALTHY, answer, status: 'Local' });
  const list = nodes['[data-intel-citations]'];
  const before = list.children[0];

  // The health poll repaints every few seconds with the same answer object;
  // a click or keyboard focus on a citation must survive that repaint.
  view.render({ enabled: true, health: HEALTHY, answer, status: 'Local' });
  assert.equal(list.children[0], before);

  // A genuinely new answer still rebuilds the list.
  const next = normalizeIntelAnswer({ answer: 'None.', citations: [] });
  view.render({
    enabled: true,
    health: HEALTHY,
    answer: next,
    status: 'Local',
  });
  assert.equal(list.children.length, 0);
});

// --- The reading line, citation details and the trace.

import {
  describeIntelReading,
  describeIntelCitation,
  describeIntelStep,
} from './starlightIntelView.js';

function fullFixture() {
  const { element, nodes } = fixture();
  nodes['[data-intel-reading]'] = makeNode('p');
  nodes['[data-intel-trace]'] = makeNode('ol');
  return { element, nodes };
}

test('the reading line says where the question was placed', () => {
  assert.equal(
    describeIntelReading({
      reading: {
        place: 'Woodbridge',
        region: 'Virginia',
        entityType: 'datacenter',
        operator: '',
        radiusKm: 0,
      },
      place: {
        name: 'Woodbridge',
        region: 'Virginia',
        country: 'United States',
        radiusKm: 0,
        confidence: 'exact',
      },
    }),
    'Placed Woodbridge, Virginia, United States · datacenters',
  );
  assert.equal(
    describeIntelReading({
      reading: {
        place: 'Atlantis',
        region: '',
        country: '',
        entityType: 'any',
        operator: 'Equinix',
        radiusKm: 50,
      },
      place: null,
    }),
    'Read as Atlantis, not in the gazetteer · Equinix · within 50 km',
  );
  assert.equal(
    describeIntelReading({
      reading: {
        place: '',
        region: 'Virginia',
        entityType: 'any',
        operator: '',
      },
      place: {
        name: 'Virginia',
        region: 'Virginia',
        country: 'United States',
        radiusKm: 443,
        confidence: 'ambiguous',
      },
    }),
    'Assumed Virginia, Virginia, United States (±443 km)',
  );
  assert.equal(describeIntelReading({ reading: {}, place: null }), '');
});

test('a citation detail names its town and distance, and a step its timing', () => {
  assert.equal(
    describeIntelCitation({
      kind: 'datacenter',
      city: 'Sterling',
      region: 'Virginia',
      why: { km: 44.1 },
    }),
    'Sterling, Virginia · 44.1 km',
  );
  assert.equal(
    describeIntelCitation({
      kind: 'landing-point',
      country: 'France',
      why: {},
    }),
    'landing point · France',
  );
  assert.equal(
    describeIntelStep({ step: 'read', ms: 2400, detail: 'Woodbridge' }),
    'Read 2.4 s · Woodbridge',
  );
  assert.equal(
    describeIntelStep({ step: 'retrieve', ms: 3, detail: '' }),
    'Retrieve 3 ms',
  );
});

test('reading and trace nodes are painted when present and hidden when empty', () => {
  const { element, nodes } = fullFixture();
  const view = createStarlightIntelView({ element });
  const answer = normalizeIntelAnswer({
    answer: 'STACK NVA01A is nearest.',
    citations: [
      {
        id: 'dc-1',
        label: 'STACK NVA01A',
        kind: 'datacenter',
        lat: 39,
        lon: -77.4,
        city: 'Sterling',
        region: 'Virginia',
        why: { km: 44.1 },
      },
    ],
    reading: {
      place: 'Woodbridge',
      region: 'Virginia',
      entityType: 'datacenter',
    },
    place: {
      kind: 'place',
      name: 'Woodbridge',
      region: 'Virginia',
      country: 'United States',
      lat: 38.66,
      lon: -77.25,
    },
    trace: [
      { step: 'read', ms: 2400, detail: 'Woodbridge, Virginia' },
      { step: 'answer', ms: 3100, detail: 'gemma4:12b · 1 records used' },
    ],
  });
  view.render({ enabled: true, health: HEALTHY, answer, status: 'Local' });
  assert.equal(nodes['[data-intel-reading]'].hidden, false);
  assert.match(
    nodes['[data-intel-reading]'].textContent,
    /^Placed Woodbridge, Virginia, United States/,
  );
  assert.equal(nodes['[data-intel-trace]'].hidden, false);
  assert.deepEqual(
    nodes['[data-intel-trace]'].children.map((item) => item.textContent),
    ['Read 2.4 s', 'Answer 3.1 s'],
    'timings on the strip',
  );
  assert.deepEqual(
    nodes['[data-intel-trace]'].children.map((item) => item.title),
    ['Woodbridge, Virginia', 'gemma4:12b · 1 records used'],
    'details a hover away',
  );
  const [item] = nodes['[data-intel-citations]'].children;
  assert.equal(item.children[1].tagName, 'small');
  assert.equal(item.children[1].textContent, 'Sterling, Virginia · 44.1 km');

  view.render({
    enabled: true,
    health: HEALTHY,
    answer: normalizeIntelAnswer(null),
    status: 'Local',
  });
  assert.equal(nodes['[data-intel-reading]'].hidden, true);
  assert.equal(nodes['[data-intel-trace]'].hidden, true);
  assert.deepEqual(nodes['[data-intel-trace]'].children, []);
});

test('health describes the vector index once it is ready', () => {
  const indexing = normalizeIntelHealth({
    model: 'm',
    corpus: { version: 'v' },
    egress: 'blocked',
    embeddings: { model: 'embeddinggemma', ready: false, indexed: 500 },
  });
  assert.match(describeIntelHealth(indexing), /vectors indexing 500/);
  const ready = normalizeIntelHealth({
    model: 'm',
    corpus: { version: 'v' },
    egress: 'blocked',
    embeddings: { model: 'embeddinggemma', ready: true, indexed: 6268 },
  });
  assert.match(describeIntelHealth(ready), /vectors embeddinggemma/);
});
