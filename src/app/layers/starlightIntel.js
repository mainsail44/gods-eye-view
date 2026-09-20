/**
 * Catalog entry for the Starlight Local Intel component. It owns no globe
 * geometry: the manager's real lifecycle gate (init/enable/update/disable —
 * every one called unguarded, see src/data/lifecycle.js) simply starts and
 * stops the panel. `setLifecyclePresentation` is deliberately NOT
 * implemented here: the manager also calls that optional hook on every
 * transitional lifecycle state, including mid-enable with `enabled: false`
 * before settlement, and driving the panel from both it and enable()/
 * disable() would toggle the panel on/off/on for a single click.
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

    enable() {
      panel?.enable();
      return true;
    },

    /** No globe data to refresh; the panel owns its own asks and state. */
    update() {
      return true;
    },

    disable() {
      panel?.disable();
    },

    destroy() {
      panel?.disable();
    },
  };
}
