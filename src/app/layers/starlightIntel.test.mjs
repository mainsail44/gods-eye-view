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
    withEmptyOptions.setLifecyclePresentation({ enabled: true });
    withEmptyOptions.setLifecyclePresentation({ enabled: false });
    withEmptyOptions.destroy();
  });

  const withExplicitUndefined = createApplicationStarlightIntel({
    panel: undefined,
  });
  assert.doesNotThrow(() => {
    withExplicitUndefined.setLifecyclePresentation({ enabled: true });
    withExplicitUndefined.setLifecyclePresentation({ enabled: false });
    withExplicitUndefined.destroy();
  });
});
