// Geodesy shared by the corpus build, the gazetteer and retrieval.

/** Mean Earth radius (IUGG), in kilometres. */
export const EARTH_RADIUS_KM = 6371.0088;

export const toRadians = (degrees) => (degrees * Math.PI) / 180;

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

/** A finite coordinate pair inside the valid ranges, or null. */
export function coordinate(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  return { lat: latitude, lon: longitude };
}
