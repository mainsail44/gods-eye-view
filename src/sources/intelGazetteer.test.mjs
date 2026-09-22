import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGazetteer,
  normalizeName,
} from '../../services/intel/src/gazetteer.js';
import {
  PLACES_HEADER,
  slimPlaces,
  slimAdmin1,
  slimAdmin2,
  slimCountries,
} from '../../services/intel/src/gazetteerBuild.js';

// A slice of GeoNames small enough to reason about: two Woodbridges, the
// town of Virginia in South Africa, Ashburn and Sterling near the IAD
// campuses, Frankfurt am Main, and Paris twice.
const PLACES = [
  PLACES_HEADER,
  '4794457\tWoodbridge\tWoodbridge\t38.6582\t-77.2497\tUS\tVA\t\t4055',
  '12750392\tWoodbridge\tWoodbridge\t33.6772\t-117.7944\tUS\tCA\t\t24966',
  '2633671\tWoodbridge\tWoodbridge\t52.0933\t1.3204\tGB\tENG\t\t11200',
  '967476\tVirginia\tVirginia\t-28.1039\t26.8659\tZA\t03\t\t122502',
  '4744870\tAshburn\tAshburn\t39.0437\t-77.4875\tUS\tVA\t\t43511',
  '4787534\tSterling\tSterling\t39.0062\t-77.4286\tUS\tVA\t\t30872',
  '4791259\tVirginia Beach\tVirginia Beach\t36.8529\t-75.978\tUS\tVA\t\t459470',
  '4671654\tAustin\tAustin\t30.2672\t-97.7431\tUS\tTX\t\t974447',
  '2925533\tFrankfurt am Main\tFrankfurt am Main\t50.1155\t8.6842\tDE\t05\t\t650000',
  '2988507\tParis\tParis\t48.8534\t2.3488\tFR\t11\t\t2138551',
  '4717560\tParis\tParis\t33.6609\t-95.5555\tUS\tTX\t\t24710',
  '2995469\tSaint-Étienne\tSaint-Etienne\t45.4339\t4.39\tFR\t84\t\t172565',
  '2640377\tPenzance\tPenzance\t50.1186\t-5.5371\tGB\tENG\tC6\t16336',
  '2635412\tTruro\tTruro\t50.2632\t-5.051\tGB\tENG\tC6\t20920',
  '2649387\tFalmouth\tFalmouth\t50.1527\t-5.0659\tGB\tENG\tC6\t22000',
  '2652594\tCornwall\tCornwall\t45.0181\t-74.7286\tCA\t08\t\t46340',
].join('\n');

const ADMIN2 = ['GB.ENG.C6\tCornwall', 'JM.12.811\tCornwall'].join('\n');

const ADMIN1 = [
  'US.VA\tVirginia',
  'US.CA\tCalifornia',
  'US.TX\tTexas',
  'GB.ENG\tEngland',
  'ZA.03\tFree State',
  'DE.05\tHesse',
  'FR.11\tÎle-de-France',
  'FR.84\tAuvergne-Rhône-Alpes',
].join('\n');

const COUNTRIES = [
  'US\tUnited States',
  'GB\tUnited Kingdom',
  'ZA\tSouth Africa',
  'DE\tGermany',
  'FR\tFrance',
].join('\n');

const gazetteer = () =>
  createGazetteer({ places: PLACES, admin1: ADMIN1, admin2: ADMIN2, countries: COUNTRIES });

test('names are matched without case, accents or punctuation', () => {
  assert.equal(normalizeName('Saint-Étienne'), 'saint etienne');
  const found = gazetteer().resolve({ place: 'saint etienne' });
  assert.equal(found?.name, 'Saint-Étienne');
});

test('a place with a region hint resolves to that region, not the biggest namesake', () => {
  const g = gazetteer();
  const inline = g.resolve({ place: 'Woodbridge, Virginia' });
  assert.equal(inline?.kind, 'place');
  assert.equal(inline?.lat, 38.6582);
  assert.equal(inline?.confidence, 'exact');
  const hinted = g.resolve({ place: 'Woodbridge', region: 'VA', country: 'USA' });
  assert.equal(hinted?.lat, 38.6582);
  const british = g.resolve({ place: 'Woodbridge', country: 'UK' });
  assert.equal(british?.countryCode, 'GB');
});

test('without hints the most populous namesake wins and is marked ambiguous', () => {
  const found = gazetteer().resolve({ place: 'Woodbridge' });
  assert.equal(found?.region, 'California');
  assert.equal(found?.confidence, 'ambiguous');
  assert.equal(gazetteer().resolve({ place: 'Austin' })?.confidence, 'exact');
});

test('a region name means the region unless the hints say otherwise', () => {
  const g = gazetteer();
  const state = g.resolve({ place: 'Virginia' });
  assert.equal(state?.kind, 'region');
  assert.equal(state?.country, 'United States');
  assert.ok(state.radiusKm >= 25, 'a region carries a radius');
  const town = g.resolve({ place: 'Virginia', country: 'South Africa' });
  assert.equal(town?.kind, 'place');
  assert.equal(town?.countryCode, 'ZA');
});

test('a qualified region falls back to the region itself', () => {
  const found = gazetteer().resolve({ place: 'Northern Virginia' });
  assert.equal(found?.kind, 'region');
  assert.equal(found?.name, 'Virginia');
});

test('a country resolves with a radius, and unknown places resolve to null', () => {
  const g = gazetteer();
  const country = g.resolve({ place: 'France' });
  assert.equal(country?.kind, 'country');
  assert.equal(country?.countryCode, 'FR');
  assert.equal(g.resolve({ place: 'Nowhere Springs' }), null);
  assert.equal(g.resolve({}), null);
});

test('the head of a qualified name is indexed too', () => {
  assert.equal(gazetteer().resolve({ place: 'Frankfurt' })?.name, 'Frankfurt am Main');
  assert.equal(gazetteer().resolve({ place: 'Paris, Texas' })?.regionCode, 'US.TX');
});

test('nearest returns the closest populated place with its distance', () => {
  const near = gazetteer().nearest(39.0064, -77.4672);
  assert.equal(near?.name, 'Sterling');
  assert.equal(near?.region, 'Virginia');
  assert.ok(near.km > 3 && near.km < 4, `distance ${near.km}`);
  assert.equal(gazetteer().nearest(0, -30), null, 'mid-ocean has no place');
  assert.equal(gazetteer().nearest('x', 1), null);
});

test('slimming keeps populated places and seven columns', () => {
  const raw = [
    '4794457\tWoodbridge\tWoodbridge\tWoodbridge,Вудбридж\t38.65817\t-77.2497\tP\tPPL\tUS\t\tVA\t153\t\t\t4055\t\t60\tAmerica/New_York\t2011-05-14',
    '6252001\tUnited States\tUnited States\t\t39.76\t-98.5\tA\tPCLI\tUS\t\t00\t\t\t\t327167434\t\t\tAmerica/Chicago\t2019-09-05',
    'garbage line',
  ].join('\n');
  const lines = slimPlaces(raw);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '4794457\tWoodbridge\tWoodbridge\t38.6582\t-77.2497\tUS\tVA\t153\t4055');
  assert.deepEqual(
    slimAdmin2('GB.ENG.C6\tCornwall\tCornwall\t2652355\nUS.VA.153\tPrince William County\tPrince William County\t4785\nZZ.1.2\tUnused\tUnused\t1\n', lines),
    ['US.VA.153\tPrince William County'],
  );
  assert.deepEqual(slimAdmin1('US.VA\tVirginia\tVirginia\t6254928\n'), ['US.VA\tVirginia']);
  assert.deepEqual(
    slimCountries('# comment\nUS\tUSA\t840\tUS\tUnited States\tWashington\n'),
    ['US\tUnited States'],
  );
});

test('a county resolves to a district inside its state, and outranks a town of the same name', () => {
  const county = gazetteer().resolve({ place: 'Cornwall' });
  assert.equal(county?.kind, 'district', 'an area with a radius, not a membership');
  assert.equal(county?.name, 'Cornwall');
  assert.equal(county?.region, 'England', 'records in Cornwall are labelled England');
  assert.equal(county?.countryCode, 'GB');
  assert.ok(county.lat > 50.1 && county.lat < 50.3 && county.lon < -5.0, 'centred among its towns');
  assert.ok(county.radiusKm >= 25);
  const town = gazetteer().resolve({ place: 'Cornwall', country: 'Canada' });
  assert.equal(town?.kind, 'place');
  assert.equal(town?.countryCode, 'CA');
});
