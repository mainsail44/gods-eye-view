#!/usr/bin/env node
// Build the Starlight Local Intel corpus from the bundled GeoJSON sources.
//
//   node services/intel/scripts/build-corpus.mjs --out /tmp/corpus.json
//
// Run from the repository root, or pass explicit source paths. The generated
// file is a build artifact: the Containerfile produces it during `podman
// build` and it is never committed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildCorpusRecords, serializeCorpus } from '../src/buildCorpus.js';
import { corpusChecksum } from '../src/corpus.js';
import { createGazetteer } from '../src/gazetteer.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DEFAULTS = {
  datacenters: 'src/data/local_data/datacenters/datacenters.geojsonl',
  'landing-points':
    'src/data/local_data/telegeography_submarine_cables/landing-point-geo.json',
  gazetteer: 'src/data/local_data/geonames',
};

/** Parse `--name value` pairs; anything else is a usage error. */
function parseArguments(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined)
      throw new Error(
        'Usage: build-corpus.mjs --out <file> [--datacenters <file>] [--landing-points <file>] [--gazetteer <dir>|none]',
      );
    options[flag.slice(2)] = value;
  }
  if (!options.out) throw new Error('An --out path is required');
  return options;
}

/** Read newline-delimited GeoJSON; a malformed line is a build failure. */
async function readGeoJsonLines(file) {
  const text = await readFile(file, 'utf8');
  const features = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      features.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `${file}:${index + 1} is not valid JSON: ${error.message}`,
      );
    }
  }
  return features;
}

async function readFeatureCollection(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed?.features))
    throw new Error(`${file} is not a GeoJSON FeatureCollection`);
  return parsed.features;
}

const resolve = (file) =>
  path.isAbsolute(file) ? file : path.join(ROOT, file);

/** The vendored GeoNames slice; `--gazetteer none` builds without places. */
async function readGazetteer(directory) {
  if (!directory || directory === 'none') return null;
  const [places, admin1, admin2, countries] = await Promise.all([
    readFile(path.join(directory, 'places.tsv.gz')).then((buffer) =>
      gunzipSync(buffer).toString('utf8'),
    ),
    readFile(path.join(directory, 'admin1.tsv'), 'utf8'),
    // Districts are optional: an older slice without them still builds.
    readFile(path.join(directory, 'admin2.tsv'), 'utf8').catch(() => ''),
    readFile(path.join(directory, 'countries.tsv'), 'utf8'),
  ]);
  return createGazetteer({ places, admin1, admin2, countries });
}

async function main(argv) {
  const started = Date.now();
  const options = parseArguments(argv);
  const [datacenters, landingPoints, gazetteer] = await Promise.all([
    readGeoJsonLines(resolve(options.datacenters)),
    readFeatureCollection(resolve(options['landing-points'])),
    readGazetteer(
      options.gazetteer === 'none' ? 'none' : resolve(options.gazetteer),
    ),
  ]);

  const skips = new Map();
  const records = buildCorpusRecords(
    { datacenters, landingPoints },
    {
      onSkip: ({ reason }) => skips.set(reason, (skips.get(reason) ?? 0) + 1),
      gazetteer,
    },
  );
  const serialized = serializeCorpus(records);
  const out = path.resolve(process.cwd(), options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, serialized);

  const counts = records.reduce(
    (totals, record) =>
      totals.set(record.kind, (totals.get(record.kind) ?? 0) + 1),
    new Map(),
  );
  console.log(
    `[corpus] ${records.length} records ` +
      `(${[...counts].map(([kind, count]) => `${kind}: ${count}`).join(', ')}) ` +
      `-> ${out} ${Buffer.byteLength(serialized)} bytes in ${Date.now() - started} ms`,
  );
  console.log(`[corpus] checksum ${corpusChecksum(records)}`);
  console.log(
    `[corpus] places: ${gazetteer ? `${gazetteer.size} gazetteer entries` : 'none (built without a gazetteer)'}`,
  );
  for (const [reason, count] of [...skips].sort())
    console.log(`[corpus] skipped ${count}: ${reason}`);
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[corpus] build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
