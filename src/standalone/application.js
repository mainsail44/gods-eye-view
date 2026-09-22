import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../locations.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { createStarlightIntelPanel } from '../ui/starlightIntel.js';
import { createStarlightIntelView } from '../ui/starlightIntelView.js';
import { createStarlightIntelScene } from '../ui/starlightIntelScene.js';
import { flyToCoordinate } from '../camera.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

// The browser reaches the intel service only through the server-side proxy,
// which holds the service URL. No intel request ever names the service.
const INTEL_API = '/api/intel';

const intelTransport = {
  async health(signal) {
    const response = await fetch(`${INTEL_API}/health`, { signal });
    return response.json();
  },
  async query(body, signal) {
    const response = await fetch(`${INTEL_API}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return response.json();
  },
};

/**
 * Bind the Starlight Local Intel markup to a panel the catalog layer drives.
 * An answer is drawn on the globe as a whole — markers for its citations, a
 * ring around the place it resolved, one camera move the service proposed —
 * and a click on a citation flies to that site. The camera is never driven
 * from `onCite`, which fires once per citation and would race the flights.
 * @param {object} viewer Cesium viewer supplying the camera.
 * @param {Function} defer Registers teardown with the owning component.
 * @returns {object|undefined} The panel, when the markup is present.
 */
function createStarlightIntel(viewer, defer) {
  const element = document.getElementById('starlight-intel');
  if (!element) return undefined;
  // Below 1200px the centre lane between the two rails no longer clears the
  // left stack — the panel is 360px wide and centred, the stack's right edge a
  // constant 412px — and at 720px and under the HUD tiles the whole viewport,
  // so there is nothing left to float over at all. Joining the right rail lets
  // the stylesheet drop the panel into that rail's own column at those widths
  // instead of overlapping it; from 1200px up it stays fixed and centred, out
  // of the rail's flow entirely. Layers already attach panels here
  // at runtime; see src/layers/launches/panel.js. Where it sits in the column
  // is decided by CSS `order`, not by this insertion point, because the shell
  // rearranges the rail's own panels during startup.
  document.getElementById('right-context-rail')?.prepend(element);
  let panel;
  const scene = createStarlightIntelScene({ viewer });
  const view = createStarlightIntelView({
    element,
    onAsk: (question) => void panel.ask(question),
    onCiteClick: (citation) => {
      scene.focus(citation.id);
      flyToCoordinate(viewer, citation);
    },
  });
  panel = createStarlightIntelPanel({
    transport: intelTransport,
    onRender: (state) => view.render(state),
    onAnswer: (answer) => {
      scene.show(answer);
      scene.act(answer.actions);
    },
  });
  defer(() => {
    panel.disable();
    scene.destroy();
  });
  view.render(panel.state());
  return panel;
}

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  return createApplication({
    createScene: async (context) => {
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      const scene = await createStandaloneScene({
        ...context,
        googleApiKey,
        cesiumToken,
        loaderStatus,
      });
      catalog = createStandaloneCatalog({
        nepalBoundaryResolver: (signal) =>
          scene.operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            signal,
            placeSearch,
          ),
        starlightIntelPanel: createStarlightIntel(scene.viewer, context.defer),
        signal: context.signal,
        surface: scene.operations.surface,
      });
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
      }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration, catalog }),
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen, placeSearch, voice }),
  });
}
