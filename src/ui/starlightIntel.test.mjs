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

test('disable() aborts an in-flight query', async () => {
  let queryResolve;
  let aborted = false;
  const transport = {
    async health() {
      return { model: 'local-model', runtime: 'llama.cpp', egress: 'blocked' };
    },
    async query(body, signal) {
      return new Promise((resolve) => {
        queryResolve = resolve;
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });
    },
  };
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  const askPromise = panel.ask('test');
  await settle();
  panel.disable();
  await settle();
  // The signal should be aborted
  assert.equal(aborted, true);
  queryResolve?.({
    answer: 'test',
    citations: [],
  });
  await askPromise;
  // Verify answer was not written
  assert.equal(panel.state().answer.answer, '');
  assert.deepEqual(panel.state().answer.citations, []);
});

test('a query resolving after disable() changes nothing', async () => {
  let queryResolve;
  let renderCount = 0;
  const onRender = () => {
    renderCount += 1;
  };
  const transport = {
    async health() {
      return { model: 'local-model', runtime: 'llama.cpp', egress: 'blocked' };
    },
    async query(body, signal) {
      return new Promise((resolve) => {
        queryResolve = resolve;
      });
    },
  };
  const seen = [];
  const panel = createStarlightIntelPanel({
    transport,
    onRender,
    onCite: (cite) => seen.push(cite.id),
  });
  panel.enable();
  await settle();
  renderCount = 0; // Reset to count only after enable
  const askPromise = panel.ask('test');
  await settle();
  const renderCountBeforeDisable = renderCount;
  panel.disable();
  await settle();
  const renderCountAfterDisable = renderCount;
  queryResolve?.({
    answer: 'late result',
    citations: [{ id: 'late-cite', label: 'L', lat: 1, lon: 2 }],
  });
  await askPromise;
  await settle();
  // Verify answer was not written
  assert.equal(panel.state().answer.answer, '');
  assert.deepEqual(panel.state().answer.citations, []);
  // Verify onCite was not called for stale result
  assert.deepEqual(seen, []);
  // Verify no render calls happened after the disable render
  assert.equal(renderCount, renderCountAfterDisable);
});

test('a healthy health response after disable does not overwrite offline state', async () => {
  let healthResolve;
  const transport = {
    async health(signal) {
      return new Promise((resolve) => {
        healthResolve = resolve;
      });
    },
    async query() {
      return { answer: 'test', citations: [] };
    },
  };
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  // First health call pending
  assert.equal(panel.state().health.ok, false);
  panel.disable();
  await settle();
  // After disable, health is offline and status is Disabled
  assert.equal(panel.state().health.ok, false);
  assert.equal(panel.state().status, 'Disabled');
  const statusBefore = panel.state().status;
  // Resolve the stale health call with good health
  healthResolve?.({ model: 'ok', runtime: 'llama.cpp', egress: 'blocked' });
  await settle();
  // State should NOT change — health still offline, status unchanged
  assert.equal(panel.state().health.ok, false);
  assert.equal(panel.state().status, statusBefore);
});

test('a rejected health call after disable does not change state', async () => {
  let healthReject;
  const transport = {
    async health(signal) {
      return new Promise((resolve, reject) => {
        healthReject = reject;
      });
    },
    async query() {
      return { answer: 'test', citations: [] };
    },
  };
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  // First health call pending
  panel.disable();
  await settle();
  // After disable, health is offline, status is Disabled
  assert.equal(panel.state().health.ok, false);
  assert.equal(panel.state().status, 'Disabled');
  const statusBefore = panel.state().status;
  // Reject the stale health call
  healthReject?.(new Error('stale rejection'));
  await settle();
  // State should NOT change — health still offline, status unchanged
  assert.equal(panel.state().health.ok, false);
  assert.equal(panel.state().status, statusBefore);
});

test('enable/disable/enable does not double the loop', async () => {
  const calls = [];
  const pendingResolvers = new Map();
  const transport = {
    async health(signal) {
      const callNum = calls.length + 1;
      calls.push({ num: callNum, resolved: false });
      return new Promise((resolve, reject) => {
        pendingResolvers.set(callNum, { resolve, reject });
      });
    },
    async query() {
      return { answer: 'test', citations: [] };
    },
  };
  const panel = createStarlightIntelPanel({ transport, pollMs: 5 });
  // First enable: health call #1 pending
  panel.enable();
  await settle();
  assert.equal(calls.length, 1);
  // Disable: clears generation and stops polling
  panel.disable();
  await settle();
  // Second enable: health call #2 pending
  panel.enable();
  await settle();
  assert.equal(calls.length, 2);
  // Now resolve the first (stale) health call
  pendingResolvers
    .get(1)
    .resolve({ model: 'stale', runtime: 'llama.cpp', egress: 'blocked' });
  await settle();
  // Wait past pollMs to see if another call is scheduled
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Should still be 2 calls, not 3 — stale resolution did not re-arm the loop
  assert.equal(calls.length, 2);
  // Now resolve call #2 to let the active loop proceed
  pendingResolvers
    .get(2)
    .resolve({ model: 'ok', runtime: 'llama.cpp', egress: 'blocked' });
  await settle();
  // Wait for the next poll to be scheduled
  await new Promise((resolve) => setTimeout(resolve, 15));
  // Should now be 3 calls: the new poll was scheduled
  assert.equal(calls.length, 3);
  panel.disable();
});

test('first ask resolves late, second resolves first — second wins', async () => {
  const cites = [];
  let query1Resolve;
  let query2Resolve;
  let callCount = 0;
  const transport = {
    async health() {
      return { model: 'local-model', runtime: 'llama.cpp', egress: 'blocked' };
    },
    async query(body, signal) {
      callCount += 1;
      const myCall = callCount;
      return new Promise((resolve) => {
        if (myCall === 1) {
          query1Resolve = resolve;
        } else {
          query2Resolve = resolve;
        }
      });
    },
  };
  const panel = createStarlightIntelPanel({
    transport,
    onCite: (c) => cites.push(c.id),
  });
  panel.enable();
  await settle();
  const ask1 = panel.ask('first');
  await settle();
  const ask2 = panel.ask('second');
  await settle();
  // Resolve second query first
  query2Resolve?.({
    answer: 'second answer',
    citations: [{ id: 'cite-2', label: 'C', lat: 3, lon: 4 }],
  });
  await ask2;
  await settle();
  assert.equal(panel.state().answer.answer, 'second answer');
  assert.deepEqual(cites, ['cite-2']);
  // Now resolve first query late
  query1Resolve?.({
    answer: 'first answer',
    citations: [{ id: 'cite-1', label: 'C', lat: 1, lon: 2 }],
  });
  await ask1;
  await settle();
  // Second answer should still be on screen
  assert.equal(panel.state().answer.answer, 'second answer');
  // First citation should NOT have fired
  assert.deepEqual(cites, ['cite-2']);
  panel.disable();
});

test('first ask rejects late after second resolved — second answer preserved', async () => {
  let query1Resolve;
  let query1Reject;
  let query2Resolve;
  let callCount = 0;
  const transport = {
    async health() {
      return { model: 'local-model', runtime: 'llama.cpp', egress: 'blocked' };
    },
    async query(body, signal) {
      callCount += 1;
      const myCall = callCount;
      return new Promise((resolve, reject) => {
        if (myCall === 1) {
          query1Resolve = resolve;
          query1Reject = reject;
        } else {
          query2Resolve = resolve;
        }
      });
    },
  };
  const panel = createStarlightIntelPanel({ transport });
  panel.enable();
  await settle();
  const ask1 = panel.ask('first');
  await settle();
  const ask2 = panel.ask('second');
  await settle();
  // Resolve second query
  query2Resolve?.({
    answer: 'second answer',
    citations: [],
  });
  await ask2;
  await settle();
  assert.equal(panel.state().answer.answer, 'second answer');
  const goodStatus = panel.state().status;
  // Now reject first query late
  query1Reject?.(new Error('first failed'));
  await ask1;
  await settle();
  // Second answer should still be on screen
  assert.equal(panel.state().answer.answer, 'second answer');
  // Status should NOT be set to unavailable
  assert.equal(panel.state().status, goodStatus);
  panel.disable();
});

test('the whole answer reaches the host before its citations, and the empty answer on disable', async () => {
  const events = [];
  const panel = createStarlightIntelPanel({
    transport: {
      health: async () => ({ model: 'm' }),
      query: async () => ({
        answer: 'two sites',
        citations: [
          { id: 'dc-1', lat: 1, lon: 2 },
          { id: 'dc-2', lat: 3, lon: 4 },
        ],
        actions: [{ type: 'frame', ids: ['dc-1', 'dc-2'] }],
      }),
    },
    onAnswer: (answer) =>
      events.push(
        `answer:${answer.citations.length}:${answer.actions.map((a) => a.type).join(',')}`,
      ),
    onCite: (cite) => events.push(`cite:${cite.id}`),
  });
  panel.enable();
  await panel.ask('where');
  assert.deepEqual(events, ['answer:2:frame', 'cite:dc-1', 'cite:dc-2']);
  panel.disable();
  assert.deepEqual(events.at(-1), 'answer:0:');
});
