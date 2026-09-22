// Offline gazetteer over the vendored GeoNames places.
//
// Two questions, both answered without a network: "where is Woodbridge,
// Virginia?" (resolve) and "what is this coordinate near?" (nearest). The
// model that reads a question is good at naming the place it is about and
// bad at placing it — gemma4:12b put Woodbridge, Virginia 20 km off — so the
// coordinates always come from here and never from the model.

import { haversineKm, coordinate } from './geo.js';

/** Grid cell size, in degrees, for the nearest-place index. */
const CELL_DEG = 1;
/** Rings of cells searched around a coordinate before giving up (3° ≈ 330 km). */
const MAX_RINGS = 3;
/** A region resolves to its places' spread, capped so a country is not a hemisphere. */
const MAX_REGION_RADIUS_KM = 600;
const MIN_REGION_RADIUS_KM = 25;

/**
 * Names people use for countries that GeoNames spells differently. Values are
 * ISO 3166-1 alpha-2 codes.
 */
const COUNTRY_ALIASES = new Map([
  ['us', 'US'],
  ['usa', 'US'],
  ['u s', 'US'],
  ['u s a', 'US'],
  ['america', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['britain', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['holland', 'NL'],
  ['the netherlands', 'NL'],
  ['uae', 'AE'],
  ['korea', 'KR'],
  ['south korea', 'KR'],
  ['russia', 'RU'],
  ['czechia', 'CZ'],
  ['czech republic', 'CZ'],
]);

/** Leading qualifiers that name a part of a place rather than a place. */
const QUALIFIER =
  /^(?:northern|southern|eastern|western|central|greater|metro|metropolitan|downtown|north|south|east|west|the)\s+/i;

/** Trailing "am Main", "upon Avon", "sur Mer" qualifiers, dropped for the head index. */
const SUFFIX =
  /\s+(?:am|an der|an|auf der|auf|bei|im|in der|upon|on|sur|sous|de la|del|de|di)\s+.+$/i;

/** Lowercase, strip diacritics, collapse punctuation: "Saint-Étienne" → "saint etienne". */
export const normalizeName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const parseTsv = (text) =>
  String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));

const cellKey = (lat, lon) =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

/**
 * Build the gazetteer from the vendored files' text.
 * @param {{places: string, admin1?: string, countries?: string}} files
 */
export function createGazetteer({
  places,
  admin1 = '',
  admin2 = '',
  countries = '',
}) {
  const admin1Names = new Map(); // "US.VA" -> "Virginia"
  for (const [code, name] of parseTsv(admin1)) if (code && name) admin1Names.set(code, name);
  // "GB.ENG.C6" -> "Cornwall": counties, departments, provinces. A question
  // names these as often as it names a state, and they are not places.
  const admin2Names = new Map();
  for (const [code, name] of parseTsv(admin2)) if (code && name) admin2Names.set(code, name);
  const countryNames = new Map(); // "US" -> "United States"
  for (const [code, name] of parseTsv(countries)) if (code && name) countryNames.set(code, name);

  const byName = new Map(); // normalized name -> entries
  const byCell = new Map(); // grid cell -> entries
  const byRegion = new Map(); // "US.VA" -> entries
  const byCountry = new Map(); // "US" -> entries
  const regionByName = new Map(); // normalized region name -> ["US.VA", ...]
  const countryByName = new Map(); // normalized country name -> "US"
  const entries = [];

  const rows = parseTsv(places);
  const header = rows[0]?.[0] === 'geonameid' ? rows[0] : null;
  const start = header ? 1 : 0;
  // Older files carry no admin2 column; read by header, not by position.
  const columns = header ?? ['geonameid', 'name', 'ascii', 'lat', 'lon', 'country', 'admin1', 'population'];
  const at = Object.fromEntries(columns.map((column, index) => [column, index]));
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index];
    const id = row[at.geonameid];
    const name = row[at.name];
    const ascii = row[at.ascii];
    const country = row[at.country] ?? '';
    const admin1Code = row[at.admin1] ?? '';
    const admin2Code = at.admin2 === undefined ? '' : (row[at.admin2] ?? '');
    const population = row[at.population];
    const point = coordinate(row[at.lat], row[at.lon]);
    if (!point || !name) continue;
    const regionCode = admin1Code ? `${country}.${admin1Code}` : '';
    const districtCode = regionCode && admin2Code ? `${regionCode}.${admin2Code}` : '';
    const entry = Object.freeze({
      id: String(id),
      name,
      lat: point.lat,
      lon: point.lon,
      countryCode: country,
      country: countryNames.get(country) ?? country,
      regionCode,
      region: admin1Names.get(regionCode) ?? admin1Code ?? '',
      districtCode,
      population: Number(population) || 0,
    });
    entries.push(entry);
    // "Frankfurt am Main" is asked about as "Frankfurt", "Stratford-upon-Avon"
    // as "Stratford": index the head of a qualified name as well as the whole.
    const heads = [name, ascii].map((value) =>
      normalizeName(String(value).replace(/\s*\(.*$/, '').replace(SUFFIX, '')),
    );
    for (const key of new Set([normalizeName(name), normalizeName(ascii), ...heads])) {
      if (!key) continue;
      const list = byName.get(key);
      if (list) list.push(entry);
      else byName.set(key, [entry]);
    }
    const cell = cellKey(entry.lat, entry.lon);
    const cellList = byCell.get(cell);
    if (cellList) cellList.push(entry);
    else byCell.set(cell, [entry]);
    for (const code of [regionCode, districtCode]) {
      if (!code) continue;
      const regionList = byRegion.get(code);
      if (regionList) regionList.push(entry);
      else byRegion.set(code, [entry]);
    }
    const countryList = byCountry.get(country);
    if (countryList) countryList.push(entry);
    else byCountry.set(country, [entry]);
  }
  // States before counties: "Virginia" the state outranks any district of
  // the same name, because the list keeps insertion order and the first
  // compatible code wins.
  for (const names of [admin1Names, admin2Names]) {
    for (const [code, name] of names) {
      if (!byRegion.has(code)) continue;
      const key = normalizeName(name);
      const list = regionByName.get(key);
      if (list) list.push(code);
      else regionByName.set(key, [code]);
    }
  }
  const regionLabel = (code) => admin2Names.get(code) ?? admin1Names.get(code) ?? code;
  for (const [code, name] of countryNames)
    countryByName.set(normalizeName(name), code);
  for (const [alias, code] of COUNTRY_ALIASES) countryByName.set(alias, code);

  const regionPopulations = new Map();
  /** Sum of a region's places' populations, memoised. */
  const regionPopulation = (code) => {
    if (!regionPopulations.has(code)) {
      let total = 0;
      for (const entry of byRegion.get(code) ?? []) total += entry.population;
      regionPopulations.set(code, total);
    }
    return regionPopulations.get(code);
  };

  const countryCodeFor = (hint) => {
    const key = normalizeName(hint);
    if (!key) return '';
    if (key.length === 2 && countryNames.has(key.toUpperCase()))
      return key.toUpperCase();
    return countryByName.get(key) ?? '';
  };

  const regionMatches = (entry, hint) => {
    const key = normalizeName(hint);
    if (!key) return false;
    if (normalizeName(entry.region) === key) return true;
    // "VA" as well as "Virginia"; only the code's own part, not "US.VA".
    return entry.regionCode.split('.')[1]?.toLowerCase() === key;
  };

  /** Centre and spread of a set of places, weighted by population. */
  const spread = (list) => {
    let weight = 0;
    let lat = 0;
    let lon = 0;
    for (const entry of list) {
      const w = Math.log10(entry.population + 10);
      weight += w;
      lat += entry.lat * w;
      lon += entry.lon * w;
    }
    const centre = { lat: lat / weight, lon: lon / weight };
    let radius = 0;
    for (const entry of list)
      radius = Math.max(radius, haversineKm(centre, entry));
    return {
      ...centre,
      radiusKm: Math.min(
        MAX_REGION_RADIUS_KM,
        Math.max(MIN_REGION_RADIUS_KM, Math.round(radius)),
      ),
    };
  };

  const resolveRegion = (name, countryHint) => {
    const codes = regionByName.get(normalizeName(name)) ?? [];
    const wanted = countryCodeFor(countryHint);
    const code =
      codes.find((candidate) => !wanted || candidate.startsWith(`${wanted}.`)) ??
      null;
    if (!code) return null;
    const list = byRegion.get(code);
    if (!list?.length) return null;
    const [cc, admin1Code] = code.split('.');
    // A county's records are labelled with the state's name, so a county
    // resolves with its state as `region` and its own name as `name`.
    const stateCode = admin1Code ? `${cc}.${admin1Code}` : '';
    // A state is membership — records are labelled with it — but a county
    // is an area: records only say "England", so a county resolves as a
    // district, a centre with a radius, and retrieval works by distance.
    const isDistrict = code.split('.').length > 2;
    return {
      kind: isDistrict ? 'district' : 'region',
      name: regionLabel(code),
      region: admin1Names.get(stateCode) ?? regionLabel(code),
      regionCode: code,
      country: countryNames.get(cc) ?? cc,
      countryCode: cc,
      ...spread(list),
      confidence: 'exact',
    };
  };

  const resolveCountry = (name) => {
    const code = countryCodeFor(name);
    const list = code ? byCountry.get(code) : null;
    if (!list?.length) return null;
    return {
      kind: 'country',
      name: countryNames.get(code) ?? code,
      region: '',
      regionCode: '',
      country: countryNames.get(code) ?? code,
      countryCode: code,
      ...spread(list),
      confidence: 'exact',
    };
  };

  return {
    /** Number of places indexed. */
    size: entries.length,

    /**
     * Resolve what a question is about. `place` may carry its own hints
     * ("Woodbridge, Virginia"); explicit `region` and `country` hints win
     * ties. Falls back from a place to a region to a country, so "Virginia"
     * and "France" resolve too, with a radius covering their places.
     * @returns {null|{kind:string,name:string,lat:number,lon:number,radiusKm?:number,confidence:string}}
     */
    resolve({ place = '', region = '', country = '' } = {}) {
      const parts = String(place)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const name = parts[0] ?? '';
      const hints = [...parts.slice(1), region, country].filter(Boolean);
      if (!name) {
        return (
          (region && (resolveRegion(region, country) ?? null)) ||
          (country && resolveCountry(country)) ||
          null
        );
      }
      const countryHint = country || hints.find(countryCodeFor) || '';
      const candidates = byName.get(normalizeName(name)) ?? [];
      // A name that is also a region's — "Virginia" — means the region when
      // the hints say so, or when nothing says otherwise and the region is
      // a big one. The town of Virginia, South Africa has 122,000 people and
      // would otherwise win on population alone.
      const asRegion = resolveRegion(name, countryHint);
      if (asRegion) {
        const wantsRegion =
          normalizeName(region) === normalizeName(name) ||
          (countryHint && countryCodeFor(countryHint) === asRegion.countryCode);
        const bigRegion =
          !hints.length &&
          regionPopulation(asRegion.regionCode) > (candidates[0]?.population ?? 0);
        if (wantsRegion || bigRegion || !candidates.length) return asRegion;
      }
      if (!candidates.length) {
        // "Northern Virginia", "Greater Manchester", "downtown Austin".
        const stripped = name.replace(QUALIFIER, '').trim();
        if (stripped && stripped !== name)
          return this.resolve({ place: [stripped, ...parts.slice(1)].join(', '), region, country });
        return (
          resolveCountry(name) ??
          (region ? resolveRegion(region, country) : null) ??
          (country ? resolveCountry(country) : null)
        );
      }
      const scored = candidates.map((entry) => {
        let score = 0;
        for (const hint of hints) {
          if (regionMatches(entry, hint)) score += 3;
          const code = countryCodeFor(hint);
          if (code && code === entry.countryCode) score += 2;
        }
        return { entry, score };
      });
      scored.sort(
        (a, b) =>
          b.score - a.score || b.entry.population - a.entry.population,
      );
      const best = scored[0];
      const rival = scored[1];
      // Unhinted, with a namesake of comparable size: the caller should say
      // which one it took, because the question may have meant the other.
      const ambiguous =
        rival &&
        rival.score === best.score &&
        hints.length === 0 &&
        rival.entry.population >= best.entry.population / 5;
      return {
        kind: 'place',
        name: best.entry.name,
        region: best.entry.region,
        regionCode: best.entry.regionCode,
        country: best.entry.country,
        countryCode: best.entry.countryCode,
        lat: best.entry.lat,
        lon: best.entry.lon,
        population: best.entry.population,
        confidence: ambiguous ? 'ambiguous' : 'exact',
      };
    },

    /**
     * The nearest populated place to a coordinate, with its distance.
     * @returns {null|{name:string,region:string,country:string,countryCode:string,km:number}}
     */
    nearest(lat, lon) {
      const point = coordinate(lat, lon);
      if (!point) return null;
      const row = Math.floor(point.lat / CELL_DEG);
      const column = Math.floor(point.lon / CELL_DEG);
      let best = null;
      let bestKm = Infinity;
      for (let ring = 0; ring <= MAX_RINGS; ring += 1) {
        for (let dr = -ring; dr <= ring; dr += 1) {
          for (let dc = -ring; dc <= ring; dc += 1) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
            const list = byCell.get(`${row + dr}:${column + dc}`);
            if (!list) continue;
            for (const entry of list) {
              const km = haversineKm(point, entry);
              if (km < bestKm) {
                best = entry;
                bestKm = km;
              }
            }
          }
        }
        // Anything in a farther ring is at least (ring × cell) away at the
        // equator; once the best is closer than that, the search is over.
        if (best && bestKm < ring * CELL_DEG * 111 * 0.5) break;
      }
      if (!best) return null;
      return {
        name: best.name,
        region: best.region,
        country: best.country,
        countryCode: best.countryCode,
        lat: best.lat,
        lon: best.lon,
        km: Math.round(bestKm * 10) / 10,
      };
    },
  };
}
