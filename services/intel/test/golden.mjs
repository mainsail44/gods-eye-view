#!/usr/bin/env node
/**
 * Golden questions for Starlight Local Intel, run against a live service.
 *
 *   node services/intel/test/golden.mjs                      # via the app proxy
 *   INTEL_URL=http://localhost:8080 node services/intel/test/golden.mjs
 *
 * Each case says what a correct retrieval looks like — the place the question
 * must resolve to, how far its citations may be from it, names that must or
 * must not appear — without pinning the model's prose, which varies. A case
 * that fails is a retrieval regression, or a data gap worth knowing about.
 * Exit status is the number of failures, so CI and a shell loop can use it.
 */
import { haversineKm } from '../src/geo.js';

const BASE = (process.env.INTEL_URL || 'http://localhost:4173/api/intel').replace(/\/+$/, '');

const CASES = [
  {
    question: 'what datacenters are in Woodbridge, Virginia',
    place: /^Woodbridge$/,
    region: 'Virginia',
    withinKm: 75,
    mustNotCite: /virgin media/i,
    minCitations: 3,
  },
  {
    question: 'what datacenters are in Northern Virginia',
    region: 'Virginia',
    withinKm: 450,
    minCitations: 5,
  },
  {
    question: 'what is near Austin',
    place: /^Austin$/,
    withinKm: 75,
    mustCite: /austin/i,
  },
  {
    question: 'which Equinix sites are closest to the Marseille cable landing',
    place: /^Marseille$/,
    mustCite: /equinix/i,
    intent: 'nearest_to',
  },
  {
    question: 'datacenters in Marseille',
    place: /^Marseille$/,
    withinKm: 30,
    minCitations: 5,
  },
  {
    question: 'submarine cable landing points in Cornwall',
    kind: 'landing-point',
    mustCite: /skewjack|porthcurno|bude|sennen|land/i,
  },
  {
    question: 'how many Digital Realty datacenters are in Frankfurt',
    place: /^Frankfurt/,
    withinKm: 40,
    mustCite: /digital realty|interxion/i,
  },
  {
    question: 'what is the nearest cable landing point to Denver',
    place: /^Denver$/,
    kind: 'landing-point',
    intent: 'nearest_to',
    minCitations: 1,
  },
  {
    question: 'datacenters in Perth, Australia',
    place: /^Perth$/,
    region: 'Western Australia',
    withinKm: 75,
  },
  {
    question: 'Virgin Media',
    mustCite: /virgin media/i,
  },
];

const query = async (question) => {
  const response = await fetch(`${BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, limit: 5 }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
};

let failures = 0;
const health = await fetch(`${BASE}/health`).then((response) => response.json());
console.log(
  `service: ${health.model} · reader ${health.reader?.model ?? 'off'} · ` +
    `vectors ${health.embeddings?.ready ? health.embeddings.model : 'not ready'} · ` +
    `gazetteer ${health.gazetteer?.places ?? 0} places · corpus ${health.corpus?.records}`,
);
for (const testCase of CASES) {
  const started = Date.now();
  let body;
  try {
    body = await query(testCase.question);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${testCase.question}\n      request failed: ${error.message}`);
    continue;
  }
  const problems = [];
  const citations = body.citations ?? [];
  const labels = citations.map((citation) => citation.label);
  if (testCase.place && !testCase.place.test(body.place?.name ?? ''))
    problems.push(`place resolved to ${body.place?.name ?? 'nothing'}`);
  if (testCase.region && body.place?.region !== testCase.region)
    problems.push(`region ${body.place?.region ?? 'none'}, wanted ${testCase.region}`);
  if (testCase.intent && body.reading?.intent !== testCase.intent)
    problems.push(`intent ${body.reading?.intent}, wanted ${testCase.intent}`);
  if (testCase.kind) {
    const wrong = citations.filter((citation) => citation.kind !== testCase.kind);
    if (wrong.length) problems.push(`${wrong.length} citations are not ${testCase.kind}`);
  }
  if (testCase.withinKm && body.place) {
    const far = citations.filter((citation) => haversineKm(body.place, citation) > testCase.withinKm);
    if (far.length)
      problems.push(`${far.length} citations beyond ${testCase.withinKm} km: ${far.map((c) => c.label).join(', ')}`);
  }
  if (testCase.minCitations && citations.length < testCase.minCitations)
    problems.push(`${citations.length} citations, wanted ${testCase.minCitations}`);
  if (testCase.mustCite && !labels.some((label) => testCase.mustCite.test(label)))
    problems.push(`no citation matches ${testCase.mustCite}`);
  if (testCase.mustNotCite && labels.some((label) => testCase.mustNotCite.test(label)))
    problems.push(`a citation matches ${testCase.mustNotCite}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (problems.length) {
    failures += 1;
    console.log(`FAIL  ${testCase.question}  (${seconds} s)`);
    for (const problem of problems) console.log(`      ${problem}`);
    console.log(`      cited: ${labels.join(' | ') || 'nothing'}`);
  } else {
    console.log(`PASS  ${testCase.question}  (${seconds} s)`);
    console.log(`      ${(body.answer ?? '').slice(0, 140)}`);
  }
}
console.log(`\n${CASES.length - failures} of ${CASES.length} passed`);
process.exit(failures);
