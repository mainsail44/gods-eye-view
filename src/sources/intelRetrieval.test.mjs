import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexCorpus,
  retrieveHybrid,
  retrieveByKeywords,
  tokenMatches,
} from '../../services/intel/src/retrieval.js';
import { normalizeReading } from '../../services/intel/src/reader.js';

// Northern Virginia, Richmond, Cornwall and Marseille: enough geography that
// a place question and a word question want different records.
const CORPUS = [
  {
    id: 'dc-iad40',
    kind: 'datacenter',
    label: 'Digital Realty Northern Virginia IAD40',
    operator: 'Digital Realty',
    lat: 39.0065,
    lon: -77.4673,
    city: 'Sterling',
    region: 'Virginia',
    country: 'United States',
    text: 'datacenters. name: Digital Realty Northern Virginia IAD40. operator: Digital Realty. located in Sterling, Virginia, United States. nearest cable landing point: Ocean City, MD (219.5 km).',
    nearestKm: 219.5,
  },
  {
    id: 'dc-stack',
    kind: 'datacenter',
    label: 'STACK NVA01A',
    operator: 'STACK Infrastructure',
    lat: 39.0047,
    lon: -77.4418,
    city: 'Sterling',
    region: 'Virginia',
    country: 'United States',
    text: 'datacenters. name: STACK NVA01A. operator: STACK Infrastructure. located in Sterling, Virginia, United States. nearest cable landing point: Ocean City, MD (218.0 km).',
    nearestKm: 218,
  },
  {
    id: 'dc-henrico',
    kind: 'datacenter',
    label: 'Meta Henrico Data Center',
    operator: 'Meta',
    lat: 37.4778,
    lon: -77.2265,
    city: 'Sandston',
    region: 'Virginia',
    country: 'United States',
    text: 'datacenters. name: Meta Henrico Data Center. operator: Meta. located in Sandston, Virginia, United States. nearest cable landing point: Virginia Beach (140.0 km).',
    nearestKm: 140,
  },
  {
    id: 'dc-virgin',
    kind: 'datacenter',
    label: 'Virgin Media',
    operator: 'Virgin Media',
    lat: 50.0698,
    lon: -5.6771,
    city: 'Sennen',
    region: 'England',
    country: 'United Kingdom',
    text: 'datacenters. operator: Virgin Media. located in Sennen, England, United Kingdom. nearest cable landing point: Skewjack (0.7 km).',
    nearestKm: 0.7,
  },
  {
    id: 'lp-marseille',
    kind: 'landing-point',
    label: 'Marseille, France',
    lat: 43.297,
    lon: 5.3811,
    city: 'Marseille',
    region: "Provence-Alpes-Côte d'Azur",
    country: 'France',
    text: 'submarine cable landing points. name: Marseille, France. located in Marseille, France.',
  },
  {
    id: 'dc-marseille',
    kind: 'datacenter',
    label: 'Equinix MRS1',
    operator: 'Equinix',
    lat: 43.31,
    lon: 5.37,
    city: 'Marseille',
    region: "Provence-Alpes-Côte d'Azur",
    country: 'France',
    text: 'datacenters. name: Equinix MRS1. operator: Equinix. located in Marseille, France. nearest cable landing point: Marseille, France (1.6 km).',
    nearestKm: 1.6,
  },
];

const postings = indexCorpus(CORPUS);
const WOODBRIDGE = { kind: 'place', name: 'Woodbridge', lat: 38.6582, lon: -77.2497 };
const ids = (result) => result.records.map((record) => record.id);

test('a term matches only itself or its plural', () => {
  assert.ok(tokenMatches('datacenter', 'datacenters'));
  assert.ok(tokenMatches('points', 'point'));
  assert.ok(!tokenMatches('virgin', 'virginia'));
  assert.ok(!tokenMatches('brondby', 'by'));
});

test('keyword-only retrieval is the service as it was', () => {
  assert.deepEqual(retrieveByKeywords(CORPUS, postings, 'Virgin', 5), [CORPUS[3]]);
  assert.deepEqual(retrieveByKeywords(CORPUS, postings, 'the of', 5), []);
});

test('a place question ranks by distance, not by which record shares a word', () => {
  const reading = normalizeReading({ place: 'Woodbridge', region: 'Virginia', intent: 'list_in_place', entity_type: 'datacenter' });
  const result = retrieveHybrid({
    corpus: CORPUS,
    postings,
    question: 'what datacenters are near Woodbridge, Virginia',
    reading,
    place: WOODBRIDGE,
    limit: 5,
  });
  assert.deepEqual(ids(result), ['dc-stack', 'dc-iad40'], 'the two within 75 km, nearest first');
  assert.ok(result.signals.includes('place'));
  assert.equal(result.radiusKm, 75);
  assert.ok(result.records[0].why.km < result.records[1].why.km);
  assert.ok(!ids(result).includes('dc-virgin'), 'Virginia never reaches Virgin Media');
});

test('a stated radius widens the reach', () => {
  const reading = normalizeReading({ place: 'Woodbridge', region: 'Virginia', intent: 'list_in_place', radius_km: 200 });
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'datacenters within 200 km of Woodbridge', reading, place: WOODBRIDGE, limit: 5 });
  assert.deepEqual(ids(result), ['dc-stack', 'dc-iad40', 'dc-henrico']);
  assert.equal(result.radiusKm, 200);
});

test('a "nearest" question has no radius and sorts by distance', () => {
  const reading = normalizeReading({ place: 'Woodbridge', region: 'Virginia', intent: 'nearest_to', entity_type: 'landing-point' });
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'nearest landing point to Woodbridge', reading, place: WOODBRIDGE, limit: 2 });
  assert.deepEqual(ids(result), ['lp-marseille'], 'the only landing point, however far');
});

test('an operator narrows to that operator when any match', () => {
  const reading = normalizeReading({ place: 'Virginia', operator: 'Digital Realty', intent: 'operator' });
  const region = { kind: 'region', name: 'Virginia', lat: 37.9, lon: -78.3, radiusKm: 443 };
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'Digital Realty sites in Virginia', reading, place: region, limit: 5 });
  assert.deepEqual(ids(result), ['dc-iad40']);
  assert.ok(result.signals.includes('operator'));
});

test('vectors rank when no place is named', () => {
  const reading = normalizeReading({ intent: 'other' });
  // Pretend the embedding model found Marseille closest in meaning.
  const similar = [
    { index: 5, similarity: 0.91 },
    { index: 4, similarity: 0.88 },
    { index: 0, similarity: 0.2 },
  ];
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'the Mediterranean hub', reading, similar, limit: 2 });
  assert.deepEqual(ids(result), ['dc-marseille', 'lp-marseille']);
  assert.deepEqual(result.signals, ['vectors']);
  assert.equal(result.records[0].why.similarity, 0.91);
});

test('with nothing to go on, nothing is retrieved', () => {
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'and the of', reading: normalizeReading({}), limit: 5 });
  assert.deepEqual(ids(result), []);
  assert.deepEqual(result.signals, []);
});

test('a region is membership, not a radius: every record labelled with it is in reach', () => {
  const reading = normalizeReading({ region: 'Virginia', country: 'United States', entity_type: 'datacenter', intent: 'list_in_place' });
  // A centre far from Northern Virginia with a radius that would exclude it.
  const region = { kind: 'region', name: 'Virginia', region: 'Virginia', countryCode: 'US', lat: 36.9, lon: -76.0, radiusKm: 100 };
  const corpusWithCodes = CORPUS.map((record) => ({ ...record, countryCode: record.country === 'United States' ? 'US' : record.country === 'France' ? 'FR' : 'GB' }));
  const result = retrieveHybrid({ corpus: corpusWithCodes, postings: indexCorpus(corpusWithCodes), question: 'datacenters in Virginia', reading, place: region, limit: 5 });
  assert.deepEqual(ids(result).sort(), ['dc-henrico', 'dc-iad40', 'dc-stack']);
  assert.ok(result.signals.includes('region'));
  assert.equal(result.radiusKm, null, 'no reach to report');
});

test('a place question never cites beyond reach, however similar in meaning', () => {
  const reading = normalizeReading({ place: 'Woodbridge', region: 'Virginia', intent: 'list_in_place' });
  const similar = [{ index: 3, similarity: 0.95 }]; // Virgin Media, in Cornwall
  const result = retrieveHybrid({ corpus: CORPUS, postings, question: 'datacenters near Woodbridge', reading, place: WOODBRIDGE, similar, limit: 5 });
  assert.ok(!ids(result).includes('dc-virgin'));
});
