/**
 * Catalog entry for the Starlight Local Intel component. It owns no globe
 * geometry: the manager's enable gate simply starts and stops the panel.
 *
 * This task registers the layer into the catalog one commit before the panel
 * object is supplied, so `panel` is legitimately absent in between (and if a
 * shell ever fails to construct one). Every panel call is therefore optional
 * rather than assumed.
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
      if (enabled) panel?.enable();
      else panel?.disable();
    },

    destroy() {
      panel?.disable();
    },
  };
}
