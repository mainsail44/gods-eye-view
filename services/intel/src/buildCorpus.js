// Corpus construction for Starlight Local Intel.
//
// Pure: GeoJSON features in, corpus records out. All file access lives in
// services/intel/scripts/build-corpus.mjs so this stays unit-testable against
// small synthetic fixtures.

/** Attribution carried by every datacenter record (see the source README). */
export const DATACENTER_SOURCE = 'OpenStreetMap contributors, ODbL 1.0';

/** Attribution carried by every landing-point record (see the source README). */
export const LANDING_POINT_SOURCE =
  'TeleGeography submarinecablemap.com, CC BY-NC-SA 3.0';

/** Mean Earth radius (IUGG), in kilometres. */
const EARTH_RADIUS_KM = 6371.0088;

/** Coordinates are stored at ~0.1 m precision so the output stays stable. */
const COORDINATE_DECIMALS = 6;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Round to a fixed precision, never emitting -0, so output is byte-stable. */
function round(value, decimals) {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * A GeoJSON position is usable only when both ordinates are finite numbers.
 * Deliberately not coercing: `Number(null)` is 0, which would place a broken
 * feature off the coast of Ghana instead of skipping it.
 */
function position(value) {
  if (!Array.isArray(value)) return null;
  const [lon, lat] = value;
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

/** Unweighted mean of usable positions; null when none are usable. */
function meanPosition(positions) {
  let lon = 0;
  let lat = 0;
  let count = 0;
  for (const value of positions) {
    const point = position(value);
    if (!point) continue;
    lon += point.lon;
    lat += point.lat;
    count += 1;
  }
  return count ? { lon: lon / count, lat: lat / count } : null;
}

/**
 * Shoelace centroid of one ring, with its signed area. Degenerate rings (a
 * repeated point, two points, zero area) give area 0 and are handled by the
 * caller rather than producing NaN here.
 */
function ringCentroid(ring) {
  if (!Array.isArray(ring)) return null;
  const points = ring.map(position).filter(Boolean);
  if (points.length < 3) return null;
  let twiceArea = 0;
  let lon = 0;
  let lat = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.lon * next.lat - next.lon * current.lat;
    twiceArea += cross;
    lon += (current.lon + next.lon) * cross;
    lat += (current.lat + next.lat) * cross;
  }
  const area = twiceArea / 2;
  if (!Number.isFinite(area) || area === 0) return { area: 0, points };
  return { area, lon: lon / (6 * area), lat: lat / (6 * area), points };
}

/** Outer rings of a Polygon or MultiPolygon; holes do not move the centroid enough to matter here. */
function outerRings(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates?.[0]];
  if (geometry.type === 'MultiPolygon')
    return (
      Array.isArray(geometry.coordinates) ? geometry.coordinates : []
    ).map((polygon) => polygon?.[0]);
  return [];
}

/**
 * Representative point for a feature's geometry, or null when it has no
 * usable coordinate. Area-weighted across the outer rings of a MultiPolygon;
 * a zero-area footprint falls back to the mean of its vertices, so a
 * degenerate building outline still yields a finite location instead of NaN.
 */
export function centroid(geometry) {
  const type = geometry?.type;
  if (type === 'Point') {
    const point = position(geometry.coordinates);
    return point ? { lat: point.lat, lon: point.lon } : null;
  }
  if (type === 'MultiPoint') {
    const point = meanPosition(
      Array.isArray(geometry.coordinates) ? geometry.coordinates : [],
    );
    return point ? { lat: point.lat, lon: point.lon } : null;
  }
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null;

  const rings = outerRings(geometry).map(ringCentroid).filter(Boolean);
  if (!rings.length) return null;
  let weight = 0;
  let lon = 0;
  let lat = 0;
  for (const ring of rings) {
    const area = Math.abs(ring.area);
    if (!area) continue;
    weight += area;
    lon += ring.lon * area;
    lat += ring.lat * area;
  }
  if (weight > 0) return { lat: lat / weight, lon: lon / weight };

  const fallback = meanPosition(
    rings.flatMap((ring) => ring.points.map((point) => [point.lon, point.lat])),
  );
  return fallback ? { lat: fallback.lat, lon: fallback.lon } : null;
}

/** Great-circle distance in kilometres between two {lat, lon} points. */
export function haversineKm(from, to) {
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Nearest landing-point record to a location. 4351 x 1917 comparisons run in
 * well under a second, so no spatial index earns its complexity here. Ties
 * break on record id so the join is deterministic.
 */
export function nearestLandingPoint(location, landingPoints) {
  let best = null;
  let bestKm = Infinity;
  for (const record of landingPoints) {
    const km = haversineKm(location, record);
    if (km < bestKm || (km === bestKm && best && record.id < best.id)) {
      best = record;
      bestKm = km;
    }
  }
  return best ? { record: best, km: bestKm } : null;
}

/** Join the non-empty parts of a record's text into one sentence-per-part line. */
const sentences = (parts) => `${parts.filter(Boolean).join('. ')}.`;

function landingPointRecord(feature) {
  const properties = feature?.properties ?? {};
  const id = properties.id == null ? '' : String(properties.id).trim();
  if (!id) return { skip: 'landing point has no id' };
  const point = centroid(feature?.geometry);
  if (!point) return { skip: 'landing point has no usable coordinate' };
  const name = String(properties.name ?? '').trim();
  return {
    record: {
      id: `lp-${id}`,
      kind: 'landing-point',
      label: name || id,
      lat: round(point.lat, COORDINATE_DECIMALS),
      lon: round(point.lon, COORDINATE_DECIMALS),
      // The plural leads so that both "landing point" and "landing points"
      // match the retriever's substring term test.
      text: sentences([
        'submarine cable landing points',
        name && `name: ${name}`,
      ]),
      source: LANDING_POINT_SOURCE,
    },
  };
}

function datacenterRecord(feature, landingPoints) {
  const properties = feature?.properties ?? {};
  const osmId =
    properties.osm_id == null ? '' : String(properties.osm_id).trim();
  if (!osmId) return { skip: 'datacenter has no osm_id' };
  const point = centroid(feature?.geometry);
  if (!point) return { skip: 'datacenter has no usable coordinate' };
  const tags = properties.tags ?? {};
  const name = String(tags.name ?? '').trim();
  const operator = String(tags.operator ?? '').trim();
  const lat = round(point.lat, COORDINATE_DECIMALS);
  const lon = round(point.lon, COORDINATE_DECIMALS);
  // Precomputed at build time: it is what lets plain term overlap answer
  // "which datacenters are near the <place> landing point".
  const nearest = nearestLandingPoint({ lat, lon }, landingPoints);
  return {
    record: {
      id: `dc-${osmId}`,
      kind: 'datacenter',
      label: name || operator || `Datacenter ${osmId}`,
      lat,
      lon,
      text: sentences([
        'datacenters',
        name && `name: ${name}`,
        operator && `operator: ${operator}`,
        nearest &&
          `nearest cable landing point: ${nearest.record.label} (${nearest.km.toFixed(1)} km)`,
      ]),
      source: DATACENTER_SOURCE,
    },
  };
}

/**
 * Build the corpus from the bundled GeoJSON. Landing points are built first
 * because every datacenter record cites its nearest one. Output is sorted by
 * id and rounded to fixed precision, so the same inputs always produce the
 * same bytes — the checksum /health reports depends on it.
 *
 * @param {{ datacenters?: object[], landingPoints?: object[] }} sources
 * @param {{ onSkip?: (skip: { kind: string, reason: string }) => void }} options
 * @returns {object[]}
 */
export function buildCorpusRecords(
  { datacenters = [], landingPoints = [] } = {},
  { onSkip } = {},
) {
  const records = [];
  const ids = new Set();
  const add = (record) => {
    if (ids.has(record.id))
      throw new Error(`Duplicate corpus record id: ${record.id}`);
    ids.add(record.id);
    records.push(record);
  };
  const skipped = (kind, reason) => onSkip?.({ kind, reason });

  const landingRecords = [];
  for (const feature of landingPoints) {
    const { record, skip } = landingPointRecord(feature);
    if (!record) {
      skipped('landing-point', skip);
      continue;
    }
    add(record);
    landingRecords.push(record);
  }

  for (const feature of datacenters) {
    const { record, skip } = datacenterRecord(feature, landingRecords);
    if (!record) {
      skipped('datacenter', skip);
      continue;
    }
    add(record);
  }

  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Serialize a built corpus to the exact bytes the service reads. */
export function serializeCorpus(records) {
  return `${JSON.stringify(records)}\n`;
}
