import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarlightIntelScene } from './starlightIntelScene.js';
import { normalizeIntelAnswer } from '../sources/intel.js';

/** The slice of a Cesium viewer the scene touches, recording every call. */
function fakeViewer() {
  const calls = [];
  const sources = [];
  return {
    calls,
    sources,
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source, destroy) => {
        calls.push(['remove', source.name, destroy]);
        sources.splice(sources.indexOf(source), 1);
      },
    },
    camera: {
      cancelFlight: () => calls.push(['cancelFlight']),
      flyToBoundingSphere: (sphere, options) =>
        calls.push(['frame', Math.round(sphere.radius), Math.round(options.offset.range)]),
    },
    scene: { requestRender: () => calls.push(['render']) },
    isDestroyed: () => false,
  };
}

const ANSWER = normalizeIntelAnswer({
  citations: [
    { id: 'dc-1', label: 'STACK NVA01A', kind: 'datacenter', lat: 39.0047, lon: -77.4418 },
    { id: 'dc-2', label: 'IAD40', kind: 'datacenter', lat: 39.0065, lon: -77.4673 },
    { id: 'lp-1', label: 'Virginia Beach', kind: 'landing-point', lat: 36.85, lon: -75.98 },
  ],
  place: { kind: 'place', name: 'Woodbridge', lat: 38.6582, lon: -77.2497 },
  actions: [{ type: 'frame', ids: ['dc-1', 'dc-2', 'lp-1'] }, { type: 'place', kind: 'place', name: 'Woodbridge', lat: 38.6582, lon: -77.2497 }],
});

test('an answer becomes one marker per citation and a ring around the place', () => {
  const viewer = fakeViewer();
  const scene = createStarlightIntelScene({ viewer, flyTo: () => {} });
  assert.equal(viewer.sources.length, 1);
  scene.show(ANSWER);
  const entities = viewer.sources[0].entities.values;
  assert.equal(entities.length, 4);
  const ring = entities.find((entity) => entity.id === 'starlight-intel:place');
  assert.ok(ring.ellipse, 'the place is a ring');
  assert.equal(ring.ellipse.semiMajorAxis.getValue(), 1500, 'a town gets the minimum ring');
  const markers = entities.filter((entity) => entity.point);
  assert.deepEqual(markers.map((entity) => entity.name), ['STACK NVA01A', 'IAD40', 'Virginia Beach']);
  assert.notDeepEqual(
    markers[0].point.color.getValue(),
    markers[2].point.color.getValue(),
    'datacenters and landing points differ in colour',
  );
  scene.show(normalizeIntelAnswer(null));
  assert.equal(viewer.sources[0].entities.values.length, 0, 'an empty answer clears the globe');
});

test('a frame action frames every cited site; a fly action flies to one and highlights it', () => {
  const viewer = fakeViewer();
  const flights = [];
  const scene = createStarlightIntelScene({ viewer, flyTo: (_viewer, target) => flights.push(target.id ?? target) });
  scene.show(ANSWER);
  scene.act(ANSWER.actions);
  const frame = viewer.calls.find((call) => call[0] === 'frame');
  assert.ok(frame, 'the camera framed the set');
  assert.ok(frame[1] > 100_000, `the sphere spans Virginia, radius ${frame[1]} m`);
  assert.deepEqual(flights, []);

  scene.act([{ type: 'fly', id: 'dc-2' }]);
  assert.deepEqual(flights, ['dc-2']);
  const focused = viewer.sources[0].entities.getById('starlight-intel:dc-2');
  assert.equal(focused.point.pixelSize.getValue(), 16, 'the flown-to site is highlighted');
  const other = viewer.sources[0].entities.getById('starlight-intel:dc-1');
  assert.equal(other.point.pixelSize.getValue(), 11);
});

test('a place with no citations flies the camera to the place at a height that fits it', () => {
  const viewer = fakeViewer();
  const flights = [];
  const scene = createStarlightIntelScene({ viewer, flyTo: (_viewer, target) => flights.push(target) });
  scene.show(normalizeIntelAnswer({ citations: [], place: { kind: 'region', name: 'Virginia', lat: 37.9, lon: -78.3, radiusKm: 443 } }));
  scene.act([{ type: 'place', kind: 'region', name: 'Virginia', lat: 37.9, lon: -78.3, radiusKm: 443 }]);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].alt, 443 * 1800);
  assert.equal(viewer.sources[0].entities.values.length, 0, 'a 443 km ring would fill the frame, so none is drawn');
});

test('destroy removes the data source from the viewer', () => {
  const viewer = fakeViewer();
  const scene = createStarlightIntelScene({ viewer, flyTo: () => {} });
  scene.destroy();
  assert.deepEqual(viewer.calls.at(-1), ['remove', 'starlight-intel', true]);
  assert.equal(viewer.sources.length, 0);
});
