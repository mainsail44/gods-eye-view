// Retrieval: which records a question is about.
//
// Three signals, fused: where the question points (the gazetteer-resolved
// place, scored by distance), what it means (cosine similarity of the
// question's embedding to each record's), and the words it uses (term
// overlap, weighted by rarity). Any signal may be absent — no place named,
// no embedding model configured — and the fusion degrades to what remains,
// down to the plain term overlap the service started with.

import { haversineKm } from './geo.js';

/** Cap the distinct terms scored per record, regardless of question length. */
export const MAX_QUERY_TERMS = 50;

/** Default reach of "in" or "near" a place, when the question gives none. */
export const DEFAULT_RADIUS_KM = 75;

/** Records a signal proposes before fusion; enough for any sensible `limit`. */
const CANDIDATES = 50;

/**
 * Words that carry no information about which record is wanted. They neither
 * match nor count: `by` inside "Brondby" and "Bygby" once matched 52 records,
 * which made it look rarer — and so worth more — than "equinix".
 */
export const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'by',
  'for',
  'in',
  'is',
  'near',
  'nearest',
  'of',
  'on',
  'operated',
  'show',
  'that',
  'the',
  'to',
  'what',
  'which',
  'with',
  'located',
]);

/**
 * The only inflection the matcher forgives: a token and a term that differ by
 * a plural suffix. datacenter/datacenters and point/points must find each
 * other; nothing else may. A general prefix rule let "Virginia" retrieve
 * "Virgin Media" — a Cornish record — for a question about Virginia, USA.
 */
const PLURAL_SUFFIXES = ['s', 'es'];

export const tokenize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * One token matches another when they are equal or differ only by a plural
 * suffix, so datacenter/datacenters and point/points match without a place
 * name matching whatever word it happens to begin.
 */
export const tokenMatches = (token, term) => {
  if (token === term) return true;
  const [short, long] =
    token.length < term.length ? [token, term] : [term, token];
  return PLURAL_SUFFIXES.some((suffix) => long === short + suffix);
};

/**
 * Index the corpus once, at startup. Each record becomes a set of tokens, and
 * each token keeps the records it appears in, so a query costs one pass over
 * the vocabulary rather than a substring scan of every record.
 */
export function indexCorpus(corpus) {
  const postings = new Map();
  corpus.forEach((record, index) => {
    for (const token of new Set(
      tokenize(`${record.label ?? ''} ${record.text ?? ''}`),
    )) {
      if (STOPWORDS.has(token)) continue;
      const seen = postings.get(token);
      if (seen) seen.push(index);
      else postings.set(token, [index]);
    }
  });
  return postings;
}

/**
 * Distance used to order records that tie on relevance. A landing point has
 * none: it is the place being asked about, so it sorts as if at zero, ahead of
 * a datacenter it would otherwise tie with.
 */
const nearestKm = (record) =>
  Number.isFinite(record?.nearestKm) ? record.nearestKm : 0;

/**
 * Score corpus records by term overlap. Terms are weighted by how rare they
 * are, because every datacenter record carries the words "cable landing
 * point": counting each match equally lets that boilerplate outvote the place
 * name the question actually turns on. The weight stays strictly positive, so
 * any matching term still counts as a match and an empty result still means
 * nothing matched at all.
 * @returns {Map<number, {score: number, terms: string[]}>} By record index.
 */
export function keywordScores(corpus, postings, question) {
  const terms = [...new Set(tokenize(question))]
    .filter((term) => !STOPWORDS.has(term))
    .slice(0, MAX_QUERY_TERMS);
  const scores = new Map();
  if (!terms.length) return scores;
  for (const term of terms) {
    const matched = new Set();
    for (const [token, records] of postings) {
      if (tokenMatches(token, term))
        for (const index of records) matched.add(index);
    }
    if (!matched.size) continue;
    const weight = Math.log(1 + corpus.length / (1 + matched.size));
    for (const index of matched) {
      const entry = scores.get(index) ?? { score: 0, terms: [] };
      entry.score += weight;
      entry.terms.push(term);
      scores.set(index, entry);
    }
  }
  return scores;
}

/**
 * Rank corpus records by term overlap alone: the retrieval the service
 * started with, kept for callers and tests that want exactly that.
 */
export function retrieveByKeywords(corpus, postings, question, limit) {
  return [...keywordScores(corpus, postings, question)]
    .map(([index, { score }]) => ({ record: corpus[index], score }))
    .sort(
      (a, b) =>
        b.score - a.score || nearestKm(a.record) - nearestKm(b.record),
    )
    .slice(0, limit)
    .map((entry) => entry.record);
}

const operatorMatches = (record, operator) => {
  const wanted = tokenize(operator).filter((term) => !STOPWORDS.has(term));
  if (!wanted.length) return false;
  const have = new Set(tokenize(`${record.operator ?? ''} ${record.label ?? ''}`));
  return wanted.every((term) => [...have].some((token) => tokenMatches(token, term)));
};

/**
 * Fuse the signals into one ranking.
 *
 * @param {object} options
 * @param {object[]} options.corpus
 * @param {Map} options.postings From indexCorpus.
 * @param {string} options.question
 * @param {object} options.reading From reader.js (normalised).
 * @param {null|{lat:number,lon:number,radiusKm?:number,kind:string}} options.place
 *   The gazetteer's resolution of the reading, if any.
 * @param {null|{index:number,similarity:number}[]} options.similar
 *   Nearest records by embedding, best first, if an index exists.
 * @param {number} options.limit
 * @returns {{records: object[], signals: string[]}} Records carry a `why`.
 */
export function retrieveHybrid({
  corpus,
  postings,
  question,
  reading,
  place = null,
  similar = null,
  limit = 5,
}) {
  const signals = [];
  const candidates = new Map(); // index -> partial scores

  // Kind and operator narrow the corpus before any signal ranks it, so
  // "the nearest Equinix site" is the nearest among Equinix sites, not the
  // Equinix site nearest among the fifty closest records of any kind. A
  // filter that would leave nothing is dropped rather than applied.
  const entityType = reading?.entityType ?? 'any';
  const operator = reading?.operator ?? '';
  let pool = corpus.map((record, index) => index);
  if (entityType !== 'any') {
    const kept = pool.filter((index) => corpus[index].kind === entityType);
    if (kept.length) pool = kept;
  }
  if (operator) {
    const kept = pool.filter((index) => operatorMatches(corpus[index], operator));
    if (kept.length) {
      pool = kept;
      signals.push('operator');
    }
  }
  // A region or a country is not a point: a record is in Virginia because
  // the corpus build said so, not because it lies within some radius of
  // Virginia's middle. Distance to the centre then only orders the pool.
  if (place && (place.kind === 'region' || place.kind === 'country')) {
    const kept = pool.filter((index) => {
      const record = corpus[index];
      if (place.countryCode && record.countryCode !== place.countryCode) return false;
      if (place.kind === 'region' && place.region && record.region !== place.region) return false;
      return true;
    });
    if (kept.length) {
      pool = kept;
      signals.push(place.kind);
    }
  }
  const inPool = new Set(pool);
  const byMembership = signals.includes('region') || signals.includes('country');

  const touch = (index) => {
    let entry = candidates.get(index);
    if (!entry) {
      entry = { geo: 0, vec: 0, kw: 0, km: null, terms: [], similarity: null };
      candidates.set(index, entry);
    }
    return entry;
  };

  // Words.
  const keyword = keywordScores(corpus, postings, question);
  let maxKw = 0;
  for (const { score } of keyword.values()) maxKw = Math.max(maxKw, score);
  if (keyword.size) {
    signals.push('keywords');
    for (const [index, { score, terms }] of keyword) {
      if (!inPool.has(index)) continue;
      const entry = touch(index);
      entry.kw = score / maxKw;
      entry.terms = terms;
    }
  }

  // Meaning.
  if (similar?.length) {
    signals.push('vectors');
    for (const { index, similarity } of similar
      .filter((entry) => inPool.has(entry.index))
      .slice(0, CANDIDATES)) {
      const entry = touch(index);
      entry.vec = Math.max(0, similarity);
      entry.similarity = similarity;
    }
  }

  // Place. Every record within reach becomes a candidate, so a site whose
  // name says nothing about where it is still surfaces for a question about
  // where it is.
  const radiusKm =
    reading?.radiusKm ||
    (place?.kind === 'place' ? DEFAULT_RADIUS_KM : place?.radiusKm) ||
    DEFAULT_RADIUS_KM;
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    signals.push('place');
    const nearestIntent = reading?.intent === 'nearest_to';
    // A "nearest" question has no radius: the answer may be far away. Nor
    // does membership of a region: every record in it is in reach.
    const reach = nearestIntent || byMembership ? Infinity : radiusKm;
    const within = [];
    for (const index of pool) {
      const record = corpus[index];
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) continue;
      const km = haversineKm(place, record);
      if (km <= reach) within.push({ index, km });
    }
    within.sort((a, b) => a.km - b.km);
    for (const { index, km } of within.slice(0, nearestIntent ? CANDIDATES : CANDIDATES * 4)) {
      const entry = touch(index);
      entry.km = km;
      if (nearestIntent) entry.geo = 1 / (1 + km / 50);
      else if (byMembership) entry.geo = 0.5 + 0.5 * Math.max(0, 1 - km / radiusKm);
      else entry.geo = Math.max(0, 1 - km / radiusKm);
    }
    // Candidates that came in by words or meaning still get a distance.
    for (const [index, entry] of candidates)
      if (entry.km === null) entry.km = haversineKm(place, corpus[index]);
  }

  let ranked = [...candidates].map(([index, entry]) => ({ index, entry, record: corpus[index] }));

  const hasPlace = signals.includes('place');
  const hasVectors = signals.includes('vectors');
  const weights = hasPlace
    ? { geo: 0.55, vec: hasVectors ? 0.25 : 0, kw: hasVectors ? 0.2 : 0.45 }
    : { geo: 0, vec: hasVectors ? 0.6 : 0, kw: hasVectors ? 0.4 : 1 };

  for (const item of ranked) {
    const { entry } = item;
    item.score =
      weights.geo * entry.geo + weights.vec * entry.vec + weights.kw * entry.kw;
  }
  // A place question wants what is at the place; a candidate beyond reach
  // that only matched a word or a meaning is noise, not an answer.
  if (hasPlace && reading?.intent !== 'nearest_to')
    ranked = ranked.filter(({ entry }) => entry.geo > 0);

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.km ?? Infinity) - (b.entry.km ?? Infinity) ||
      nearestKm(a.record) - nearestKm(b.record),
  );

  const records = ranked.slice(0, limit).map(({ record, entry, score }) => ({
    ...record,
    why: {
      score: Math.round(score * 1000) / 1000,
      ...(entry.km !== null ? { km: Math.round(entry.km * 10) / 10 } : {}),
      ...(entry.terms.length ? { terms: entry.terms } : {}),
      ...(entry.similarity !== null
        ? { similarity: Math.round(entry.similarity * 1000) / 1000 }
        : {}),
    },
  }));
  // A "nearest" question had no reach to report, nor does membership of a region.
  const reported =
    hasPlace && reading?.intent !== 'nearest_to' && !byMembership ? radiusKm : null;
  return { records, signals, radiusKm: reported };
}
