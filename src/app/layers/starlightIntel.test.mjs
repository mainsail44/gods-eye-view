import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationStarlightIntel } from './starlightIntel.js';
import { LAYER_STATE_REGISTRY } from '../../data/layerState.js';
import { LayerLifecycle } from '../../data/lifecycle.js';

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
  assert.equal(typeof layer.init, 'function');
  assert.equal(typeof layer.enable, 'function');
  assert.equal(typeof layer.update, 'function');
  assert.equal(typeof layer.disable, 'function');
  // The manager's optional presentation hook must NOT be implemented — see
  // the module comment: it fires on transitional states too, and would
  // double-drive the panel alongside enable()/disable().
  assert.equal('setLifecyclePresentation' in layer, false);
});

test('enable() drives the panel on and reports success', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  const result = layer.enable();
  assert.notEqual(result, false);
  assert.deepEqual(panel.calls, ['enable']);
});

test('disable() drives the panel off and reports success', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  const result = layer.disable();
  assert.notEqual(result, false);
  assert.deepEqual(panel.calls, ['disable']);
});

test('update() is a no-op that reports success', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  const result = layer.update();
  assert.notEqual(result, false);
  assert.deepEqual(panel.calls, []);
});

test('destroy stops the panel', () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  layer.destroy();
  assert.deepEqual(panel.calls, ['disable']);
});

test('is registered for state serialization with a unique token', () => {
  const entry = LAYER_STATE_REGISTRY.find(
    (item) => item.id === 'starlight-intel',
  );
  assert.ok(entry, 'starlight-intel must be in LAYER_STATE_REGISTRY');
  assert.equal(entry.disposition, 'enabled-only');
  const tokens = LAYER_STATE_REGISTRY.map((item) => item.token);
  assert.equal(
    new Set(tokens).size,
    tokens.length,
    'layer tokens must be unique',
  );
});

test('a missing panel is a no-op rather than a throw', () => {
  const withEmptyOptions = createApplicationStarlightIntel({});
  assert.doesNotThrow(() => {
    withEmptyOptions.enable();
    withEmptyOptions.update();
    withEmptyOptions.disable();
    withEmptyOptions.destroy();
  });

  const withExplicitUndefined = createApplicationStarlightIntel({
    panel: undefined,
  });
  assert.doesNotThrow(() => {
    withExplicitUndefined.enable();
    withExplicitUndefined.update();
    withExplicitUndefined.disable();
    withExplicitUndefined.destroy();
  });
});

test('a real LayerLifecycle can enable and disable the layer end to end', async () => {
  const panel = panelStub();
  const layer = createApplicationStarlightIntel({ panel });
  const manager = new LayerLifecycle({});
  manager.register(layer);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const enabled = await manager.setEnabled('starlight-intel', true, {
      origin: 'user',
    });
    assert.equal(enabled, true);
    assert.deepEqual(panel.calls, ['enable']);

    const disabled = await manager.setEnabled('starlight-intel', false, {
      origin: 'user',
    });
    assert.equal(disabled, true);
    assert.deepEqual(panel.calls, ['enable', 'disable']);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
    await manager.destroyLayer('starlight-intel');
  }
});
