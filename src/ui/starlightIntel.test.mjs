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
