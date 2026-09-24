import * as Cesium from 'cesium';
import { flyToCoordinate } from '../camera.js';

/**
 * What an intel answer looks like on the globe: a marker and label per cited
 * record, a ring around the place the question was resolved to, and the
 * camera moved the way the service proposed — to one site, or framing them
 * all. Everything lives in one data source so an answer replaces the last
 * and disabling the layer removes it whole.
 */

const DATA_SOURCE_NAME = 'starlight-intel';

const COLORS = Object.freeze({
  datacenter: Cesium.Color.fromCssColorString('#38d9ff'),
  'landing-point': Cesium.Color.fromCssColorString('#ffb347'),
  other: Cesium.Color.fromCssColorString('#c8f7ff'),
  place: Cesium.Color.fromCssColorString('#7cffb2'),
  focus: Cesium.Color.WHITE,
});

/** Smallest ring drawn around a resolved town, so a point still reads as an area. */
const MIN_PLACE_RADIUS_M = 1500;
/** Smallest sphere the camera frames, so two adjacent sites are not a wall of pixels. */
const MIN_FRAME_RADIUS_M = 2500;
/** Above this a region ring would fill the frame; the camera shows the sites instead. */
const MAX_PLACE_RING_M = 400_000;
const FRAME_PITCH_DEG = -45;
/** Sites farther than this from the resolved place are keyword strays; leave them out of the frame. */
const FRAME_NEAR_KM = 12;
/** Always frame at least this many of the nearest sites, even when all are far. */
const FRAME_MIN_SITES = 3;

const kmBetween = (a, b) =>
  Cesium.Cartesian3.distance(position(a), position(b)) / 1000;

/** Keep the framed sites near the place the question named, nearest first. */
export function nearPlace(citations, place, nearKm = FRAME_NEAR_KM, minSites = FRAME_MIN_SITES) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return citations;
  const ranked = citations
    .map((c) => ({ c, km: kmBetween(c, place) }))
    .sort((a, b) => a.km - b.km);
  const near = ranked.filter((r) => r.km <= nearKm);
  // Anything near the town wins outright; only when nothing is near do the
  // nearest few stand in, so the operator still sees where the answer points.
  return (near.length ? near : ranked.slice(0, minSites)).map((r) => r.c);
}
const FRAME_DURATION_S = 2.6;

const LABEL_FONT = '13px "JetBrains Mono", "IBM Plex Mono", monospace';

/** Markers must show through 3D buildings and terrain: depth-test them never. */
const ALWAYS_ON_TOP = Number.POSITIVE_INFINITY;

const position = (entry) =>
  Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat, 0);

/**
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {Function} [options.flyTo] Camera flight for one site; injectable for tests.
 */
export function createStarlightIntelScene({ viewer, flyTo = flyToCoordinate }) {
  if (!viewer) throw new TypeError('A viewer is required');
  const dataSource = new Cesium.CustomDataSource(DATA_SOURCE_NAME);
  viewer.dataSources.add(dataSource);
  let shown = { citations: [], place: null };
  let focusedId = '';

  const requestRender = () => {
    viewer.scene?.requestRender?.();
  };

  const markerFor = (citation, focused) => {
    const color = COLORS[citation.kind] ?? COLORS.other;
    return {
      id: `${DATA_SOURCE_NAME}:${citation.id}`,
      name: citation.label || citation.id,
      position: position(citation),
      point: {
        pixelSize: focused ? 16 : 11,
        color: focused ? COLORS.focus : color,
        outlineColor: focused ? color : Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: focused ? 4 : 2,
        disableDepthTestDistance: ALWAYS_ON_TOP,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: citation.label || citation.id,
        font: LABEL_FONT,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: focused ? COLORS.focus : color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: ALWAYS_ON_TOP,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(2000, 1.0, 300_000, 0.55),
      },
    };
  };

  const ringFor = (place) => {
    const radius = Math.max(MIN_PLACE_RADIUS_M, (place.radiusKm || 0) * 1000);
    if (radius > MAX_PLACE_RING_M) return null;
    return {
      id: `${DATA_SOURCE_NAME}:place`,
      name: place.name,
      position: position(place),
      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius,
        material: COLORS.place.withAlpha(0.08),
        outline: true,
        outlineColor: COLORS.place.withAlpha(0.9),
        outlineWidth: 2,
        height: 0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: place.name,
        font: LABEL_FONT,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: COLORS.place,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        pixelOffset: new Cesium.Cartesian2(0, 22),
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        disableDepthTestDistance: ALWAYS_ON_TOP,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    };
  };

  const paint = () => {
    dataSource.entities.removeAll();
    if (shown.place) {
      const ring = ringFor(shown.place);
      if (ring) dataSource.entities.add(ring);
    }
    for (const citation of shown.citations)
      dataSource.entities.add(markerFor(citation, citation.id === focusedId));
    requestRender();
  };

  /** Frame a set of citations: every site in view, from the same oblique angle as a single-site flight. */
  const frame = (citations) => {
    if (!citations.length) return;
    if (citations.length === 1) {
      flyTo(viewer, citations[0]);
      return;
    }
    const sphere = Cesium.BoundingSphere.fromPoints(citations.map(position));
    sphere.radius = Math.max(MIN_FRAME_RADIUS_M, sphere.radius);
    viewer.camera.cancelFlight?.();
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(FRAME_PITCH_DEG),
        sphere.radius * 2.6,
      ),
      duration: FRAME_DURATION_S,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  };

  return {
    /**
     * Show an answer: its citations and the place it was resolved to. An
     * empty answer clears the globe.
     * @param {{citations: object[], place: object|null}} answer
     */
    show(answer) {
      shown = {
        citations: Array.isArray(answer?.citations) ? answer.citations : [],
        place: answer?.place ?? null,
      };
      focusedId = '';
      paint();
    },

    /**
     * Carry out the service's camera proposals for the answer on show.
     * Unknown ids were already dropped by the normaliser; an action naming
     * nothing on the globe is ignored.
     * @param {object[]} actions
     */
    act(actions = []) {
      const byId = new Map(
        shown.citations.map((citation) => [citation.id, citation]),
      );
      const place = actions.find((action) => action.type === 'place') ?? shown.place;
      for (const action of actions) {
        if (action.type === 'fly' && byId.has(action.id)) {
          this.focus(action.id);
          flyTo(viewer, byId.get(action.id));
          return;
        }
        if (action.type === 'frame') {
          const sites = action.ids.map((id) => byId.get(id)).filter(Boolean);
          frame(nearPlace(sites, place));
          return;
        }
      }
      // Only a place, and nothing found there: show the operator where it looked.
      const placeAction = actions.find((action) => action.type === 'place');
      if (placeAction && !shown.citations.length)
        flyTo(viewer, {
          lat: placeAction.lat,
          lon: placeAction.lon,
          alt: Math.max(4000, (placeAction.radiusKm || 0) * 1800),
        });
    },

    /** Highlight one citation, as when the operator clicks it. */
    focus(id) {
      if (focusedId === id) return;
      focusedId = id;
      paint();
    },

    clear() {
      shown = { citations: [], place: null };
      focusedId = '';
      paint();
    },

    destroy() {
      if (!viewer.isDestroyed?.()) viewer.dataSources.remove(dataSource, true);
    },
  };
}
