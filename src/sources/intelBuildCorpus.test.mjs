import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorpusRecords,
  centroid,
  haversineKm,
  nearestLandingPoint,
  serializeCorpus,
} from '../../services/intel/src/buildCorpus.js';

const datacenter = (osmId, geometry, tags = {}) => ({
  type: 'Feature',
  geometry,
  properties: { osm_id: osmId, type: 'data_center', tags },
});

const landingPoint = (id, name, coordinates) => ({
  type: 'Feature',
  properties: { id, name },
  geometry: { type: 'Point', coordinates },
});

const square = (lon, lat, size) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ],
});

test('centroid of a Polygon is the centre of its outer ring', () => {
  const point = centroid(square(10, 20, 2));
  assert.ok(Math.abs(point.lon - 11) < 1e-9);
  assert.ok(Math.abs(point.lat - 21) < 1e-9);
});

test('centroid of a MultiPolygon is weighted by area', () => {
  const point = centroid({
    type: 'MultiPolygon',
    coordinates: [square(0, 0, 2).coordinates, square(10, 0, 1).coordinates],
  });
  // Areas 4 and 1: (1 * 4 + 10.5 * 1) / 5.
  assert.ok(Math.abs(point.lon - 2.9) < 1e-9);
  assert.ok(Math.abs(point.lat - 0.9) < 1e-9);
});

test('a zero-area footprint falls back to the mean of its vertices', () => {
  const point = centroid({
    type: 'Polygon',
    coordinates: [
      [
        [4, 8],
        [4, 8],
        [4, 8],
        [4, 8],
      ],
    ],
  });
  assert.deepEqual(point, { lat: 8, lon: 4 });
});

test('unusable geometry yields null rather than NaN', () => {
  for (const geometry of [
    null,
    undefined,
    { type: 'Polygon', coordinates: [[]] },
    { type: 'Polygon', coordinates: [[['x', 'y']]] },
    { type: 'Point', coordinates: [Number.NaN, 5] },
    { type: 'GeometryCollection', geometries: [] },
  ]) {
    assert.equal(centroid(geometry), null);
  }
});

test('features with unusable geometry are skipped, never emitted as NaN', () => {
  const reasons = [];
  const records = buildCorpusRecords(
    {
      datacenters: [
        datacenter(1, square(0, 0, 1), { name: 'Kept' }),
        datacenter(2, { type: 'Polygon', coordinates: [[]] }, { name: 'Lost' }),
        datacenter(null, square(0, 0, 1), { name: 'No id' }),
      ],
      landingPoints: [
        landingPoint('a', 'Alpha, Nowhere', [0, 0]),
        landingPoint('b', 'Broken, Nowhere', [null, 0]),
      ],
    },
    { onSkip: ({ kind, reason }) => reasons.push(`${kind}: ${reason}`) },
  );
  assert.deepEqual(
    records.map((record) => record.id),
    ['dc-1', 'lp-a'],
  );
  assert.ok(records.every((record) => Number.isFinite(record.lat)));
  assert.ok(records.every((record) => Number.isFinite(record.lon)));
  assert.equal(reasons.length, 3);
  assert.ok(reasons.some((reason) => reason.includes('no osm_id')));
  assert.ok(reasons.some((reason) => reason.includes('no usable coordinate')));
});

test('record ids are stable, prefixed per kind and unique', () => {
  const records = buildCorpusRecords({
    datacenters: [datacenter(42, square(1, 1, 1))],
    landingPoints: [landingPoint('42', 'Forty Two, Nowhere', [1, 1])],
  });
  assert.deepEqual(
    records.map((record) => record.id),
    ['dc-42', 'lp-42'],
  );
  assert.deepEqual(
    records.map((record) => record.kind),
    ['datacenter', 'landing-point'],
  );
});

test('a duplicate id is a build error, not a silent overwrite', () => {
  assert.throws(
    () =>
      buildCorpusRecords({
        datacenters: [
          datacenter(7, square(0, 0, 1)),
          datacenter('7', square(5, 5, 1)),
        ],
        landingPoints: [],
      }),
    /Duplicate corpus record id: dc-7/,
  );
});

test('haversine matches known great-circle distances', () => {
  // One degree of latitude is ~111.195 km on the mean-radius sphere.
  assert.ok(
    Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111.195) <
      0.01,
  );
  // London to Paris, ~343 km.
  const km = haversineKm(
    { lat: 51.5074, lon: -0.1278 },
    { lat: 48.8566, lon: 2.3522 },
  );
  assert.ok(km > 342 && km < 345, `unexpected distance ${km}`);
  assert.equal(haversineKm({ lat: 5, lon: 5 }, { lat: 5, lon: 5 }), 0);
});

test('the nearest landing point wins, with ties broken by id', () => {
  const points = [
    { id: 'lp-far', lat: 10, lon: 0 },
    { id: 'lp-near', lat: 1, lon: 0 },
  ];
  const nearest = nearestLandingPoint({ lat: 0, lon: 0 }, points);
  assert.equal(nearest.record.id, 'lp-near');
  assert.ok(Math.abs(nearest.km - 111.195) < 0.01);

  const tied = nearestLandingPoint({ lat: 0, lon: 0 }, [
    { id: 'lp-b', lat: 0, lon: 1 },
    { id: 'lp-a', lat: 1, lon: 0 },
  ]);
  assert.equal(tied.record.id, 'lp-a');
  assert.equal(nearestLandingPoint({ lat: 0, lon: 0 }, []), null);
});

test('datacenter text carries the precomputed nearest landing point', () => {
  const [record] = buildCorpusRecords({
    datacenters: [
      datacenter(99, square(-0.001, 0.999, 0.002), {
        name: 'Equator One',
        operator: 'Example Networks',
      }),
    ],
    landingPoints: [
      landingPoint('near-place', 'Near Place, Nowhere', [0, 0]),
      landingPoint('far-place', 'Far Place, Elsewhere', [40, 40]),
    ],
  }).filter((entry) => entry.kind === 'datacenter');
  assert.equal(record.label, 'Equator One');
  assert.match(record.text, /^datacenters\. name: Equator One\./);
  assert.match(record.text, /operator: Example Networks/);
  assert.match(
    record.text,
    /nearest cable landing point: Near Place, Nowhere \(111\.2 km\)\.$/,
  );
  assert.match(record.source, /OpenStreetMap/);
});

test('a landing point carries its name, which includes the country', () => {
  const [record] = buildCorpusRecords({
    datacenters: [],
    landingPoints: [
      landingPoint('nybor-denmark', 'Nybor, Denmark', [10.8, 55.3]),
    ],
  });
  assert.equal(record.kind, 'landing-point');
  assert.equal(record.label, 'Nybor, Denmark');
  assert.equal(
    record.text,
    'submarine cable landing points. name: Nybor, Denmark.',
  );
  assert.match(record.source, /TeleGeography/);
});

test('a datacenter without a name falls back to operator, then to its id', () => {
  const records = buildCorpusRecords({
    datacenters: [
      datacenter(1, square(0, 0, 1), { operator: 'Example Networks' }),
      datacenter(2, square(0, 0, 1)),
    ],
    landingPoints: [],
  });
  assert.deepEqual(
    records.map((record) => record.label),
    ['Example Networks', 'Datacenter 2'],
  );
});

test('the same input twice produces identical bytes', () => {
  const sources = () => ({
    datacenters: [
      datacenter(2, square(3, 4, 1), { name: 'Second' }),
      datacenter(1, square(-3, -4, 1), { name: 'First' }),
    ],
    landingPoints: [
      landingPoint('b', 'Beta, Nowhere', [3.5, 4.5]),
      landingPoint('a', 'Alpha, Nowhere', [-3.5, -4.5]),
    ],
  });
  const first = serializeCorpus(buildCorpusRecords(sources()));
  const second = serializeCorpus(buildCorpusRecords(sources()));
  assert.equal(first, second);

  // Reordered input is the same corpus: records sort by id.
  const reordered = sources();
  reordered.datacenters.reverse();
  reordered.landingPoints.reverse();
  assert.equal(serializeCorpus(buildCorpusRecords(reordered)), first);
  assert.match(first, /\n$/);
  assert.deepEqual(
    JSON.parse(first).map((record) => record.id),
    ['dc-1', 'dc-2', 'lp-a', 'lp-b'],
  );
});

test('coordinates are rounded to a fixed precision and never negative zero', () => {
  const [record] = buildCorpusRecords({
    datacenters: [],
    landingPoints: [
      landingPoint('p', 'Precise, Nowhere', [1.2345678912, -0.0000001]),
    ],
  });
  assert.equal(record.lon, 1.234568);
  assert.ok(Object.is(record.lat, 0));
  assert.equal(JSON.stringify(record.lat), '0');
});

test('a tiny footprint far from the origin centres inside itself', () => {
  // The real Flexential Las Vegas building: 12.9 m across at longitude -115.
  // Summing the shoelace terms on raw lon/lat cancelled badly enough to put
  // this centroid 595 m outside its own walls, and the camera flies here.
  const ring = [
    [-115.143190402, 36.168619082],
    [-115.143144721, 36.168688233],
    [-115.143098704, 36.168668451],
    [-115.143144469, 36.168599217],
    [-115.143190402, 36.168619082],
  ];
  const point = centroid({ type: 'Polygon', coordinates: [ring] });
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  assert.ok(
    point.lon >= Math.min(...lons) && point.lon <= Math.max(...lons),
    `lon ${point.lon} outside the footprint`,
  );
  assert.ok(
    point.lat >= Math.min(...lats) && point.lat <= Math.max(...lats),
    `lat ${point.lat} outside the footprint`,
  );
  assert.ok(
    haversineKm(
      { lat: point.lat, lon: point.lon },
      { lat: 36.168644, lon: -115.143145 },
    ) < 0.005,
    'centroid moved away from the building',
  );
});

test('a datacenter carries its landing-point distance as a number', () => {
  const records = buildCorpusRecords({
    datacenters: [
      datacenter(1, square(-0.001, 0.999, 0.002), { name: 'Close' }),
      datacenter(2, square(9.999, 0.999, 0.002), { name: 'Far' }),
    ],
    landingPoints: [landingPoint('p', 'Near Place, Nowhere', [0, 0])],
  });
  const [close, far, landing] = records;
  assert.equal(close.nearestKm, 111.2);
  assert.match(close.text, /\(111\.2 km\)/);
  assert.ok(far.nearestKm > close.nearestKm);
  // The place itself has no distance: it is what the others are measured from.
  assert.equal(landing.kind, 'landing-point');
  assert.equal('nearestKm' in landing, false);
});
