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
