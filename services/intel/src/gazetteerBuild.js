// Slimming of the raw GeoNames dumps into the vendored gazetteer files.
//
// Pure: dump text in, TSV lines out. The file handling lives in
// services/intel/scripts/slim-geonames.mjs so this stays unit-testable.

/** Column order of places.tsv, as written and as the gazetteer reads it. */
export const PLACES_HEADER = [
  'geonameid',
  'name',
  'ascii',
  'lat',
  'lon',
  'country',
  'admin1',
  'admin2',
  'population',
].join('\t');

/** GeoNames feature codes that are administrative seats or ordinary places. */
const POPULATED_PLACE = /^PPL/;

/** Round to four decimals (~11 m), never emitting -0, so output is byte-stable. */
const coordinate = (value) => {
  const rounded = Math.round(Number(value) * 1e4) / 1e4;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** Tabs and newlines cannot appear inside a field; drop any that do. */
const field = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/**
 * Keep one line per populated place, seven columns of the nineteen.
 * @param {string} dump The cities1000.txt text.
 * @returns {string[]} TSV lines, in the dump's order.
 */
export function slimPlaces(dump) {
  const lines = [];
  for (const raw of String(dump ?? '').split('\n')) {
    if (!raw) continue;
    const columns = raw.split('\t');
    if (columns.length < 15) continue;
    const [
      geonameid,
      name,
      ascii,
      ,
      lat,
      lon,
      featureClass,
      featureCode,
      country,
      ,
      admin1,
      admin2,
      ,
      ,
      population,
    ] = columns;
    if (featureClass !== 'P' || !POPULATED_PLACE.test(featureCode)) continue;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)))
      continue;
    lines.push(
      [
        field(geonameid),
        field(name),
        field(ascii),
        coordinate(lat),
        coordinate(lon),
        field(country),
        field(admin1),
        field(admin2),
        String(Math.max(0, Math.trunc(Number(population)) || 0)),
      ].join('\t'),
    );
  }
  return lines;
}

/**
 * `GB.ENG.C6<tab>Cornwall<tab>Cornwall<tab>2652355` becomes
 * `GB.ENG.C6<tab>Cornwall`, for the codes some place actually uses: the
 * full table is 47,000 rows and most name districts with no city in the
 * dump. Counties, departments and provinces are what questions name.
 * @param {string} dump The admin2Codes.txt text.
 * @param {string[]} placeLines Output of slimPlaces, to learn which codes are used.
 * @returns {string[]}
 */
export function slimAdmin2(dump, placeLines) {
  const used = new Set();
  for (const line of placeLines) {
    const [, , , , , country, admin1, admin2] = line.split('\t');
    if (admin2) used.add(`${country}.${admin1}.${admin2}`);
  }
  const lines = [];
  for (const raw of String(dump ?? '').split('\n')) {
    if (!raw) continue;
    const [code, name] = raw.split('\t');
    if (!code || !name || !used.has(code)) continue;
    lines.push(`${field(code)}\t${field(name)}`);
  }
  return lines;
}

/**
 * `US.VA<tab>Virginia<tab>Virginia<tab>6254928` becomes `US.VA<tab>Virginia`.
 * @param {string} dump The admin1CodesASCII.txt text.
 * @returns {string[]}
 */
export function slimAdmin1(dump) {
  const lines = [];
  for (const raw of String(dump ?? '').split('\n')) {
    if (!raw) continue;
    const [code, name] = raw.split('\t');
    if (!code || !name) continue;
    lines.push(`${field(code)}\t${field(name)}`);
  }
  return lines;
}

/**
 * `US<tab>USA<tab>840<tab>US<tab>United States ...` becomes
 * `US<tab>United States`. Comment lines are skipped.
 * @param {string} dump The countryInfo.txt text.
 * @returns {string[]}
 */
export function slimCountries(dump) {
  const lines = [];
  for (const raw of String(dump ?? '').split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    const columns = raw.split('\t');
    const [iso, , , , name] = columns;
    if (!iso || !name) continue;
    lines.push(`${field(iso)}\t${field(name)}`);
  }
  return lines;
}
