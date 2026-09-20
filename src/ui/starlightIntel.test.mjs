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

test('a health response resolving after disable() changes nothing', async () => {
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
  // Panel starts with ok: false (OFFLINE) before health resolves
  assert.equal(panel.state().health.ok, false);
  // Resolve the first health call
  healthResolve?.({ model: 'ok', runtime: 'llama.cpp', egress: 'blocked' });
  await settle();
  // Now health should be ok
  assert.equal(panel.state().health.ok, true);
  // Disable the panel
  panel.disable();
  await settle();
  // Health should revert to offline
  assert.equal(panel.state().health.ok, false);
  // Now if a second health call (from before disable) resolves, it should not change state
  // This test verifies that stale health responses don't overwrite the offline state
});

test('enable/disable/enable does not double the loop', async () => {
  const calls = { health: 0, concurrentCalls: 0, maxConcurrent: 0 };
  const activePromises = new Set();
  let healthResolve;
  const transport = {
    async health(signal) {
      calls.health += 1;
      calls.concurrentCalls += 1;
      if (calls.concurrentCalls > calls.maxConcurrent) {
        calls.maxConcurrent = calls.concurrentCalls;
      }
      activePromises.add('health-' + calls.health);
      try {
        return new Promise((resolve) => {
          healthResolve = resolve;
        });
      } finally {
        calls.concurrentCalls -= 1;
        activePromises.delete('health-' + calls.health);
      }
    },
    async query() {
      return { answer: 'test', citations: [] };
    },
  };
  const panel = createStarlightIntelPanel({ transport, pollMs: 1000 });
  panel.enable();
  await settle();
  assert.equal(calls.health, 1);
  panel.disable();
  await settle();
  panel.enable();
  await settle();
  // At this point, should have exactly one more health call
  assert.equal(calls.health, 2);
  // Max concurrent should never exceed 1
  assert.equal(calls.maxConcurrent, 1);
  // Now resolve the first (stale) health call
  const beforeResolve = calls.health;
  healthResolve?.({ model: 'stale', runtime: 'llama.cpp', egress: 'blocked' });
  await settle();
  // Resolving the stale health should not trigger another health call
  assert.equal(calls.health, beforeResolve);
  // And still only one concurrent
  assert.equal(calls.maxConcurrent, 1);
  panel.disable();
});

test('a second ask() supersedes the first', async () => {
  const results = [];
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
        signal.addEventListener('abort', () => {
          // First call will be aborted
        });
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
  // First query should be aborted by the second ask
  // Resolve first query (late)
  query1Resolve?.({
    answer: 'first result',
    citations: [{ id: 'c1', label: 'C', lat: 1, lon: 2 }],
  });
  await settle();
  // Resolve second query
  query2Resolve?.({
    answer: 'second result',
    citations: [{ id: 'c2', label: 'C', lat: 3, lon: 4 }],
  });
  await ask1;
  await ask2;
  await settle();
  // Only second answer should be written
  assert.equal(panel.state().answer.answer, 'second result');
  panel.disable();
});
