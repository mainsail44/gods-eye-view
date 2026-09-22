#!/usr/bin/env node
/**
 * Produce the vendored gazetteer under src/data/local_data/geonames/ from the
 * raw GeoNames dumps. Run once when refreshing the data; the outputs are
 * committed so the container build needs no network.
 *
 *   node services/intel/scripts/slim-geonames.mjs \
 *     --cities cities1000.txt --admin1 admin1CodesASCII.txt \
 *     --countries countryInfo.txt --out src/data/local_data/geonames
 *
 * The raw dump carries nineteen columns per place; the service needs seven.
 * Dropping the rest (alternate names alone are two thirds of the bytes) takes
 * the 32 MB dump to a ~4 MB gzip that Git can carry comfortably.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  PLACES_HEADER,
  slimPlaces,
  slimAdmin1,
  slimAdmin2,
  slimCountries,
} from '../src/gazetteerBuild.js';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined)
      throw new Error(
        'Usage: slim-geonames.mjs --cities <file> --admin1 <file> --admin2 <file> --countries <file> --out <dir>',
      );
    options[flag.slice(2)] = value;
  }
  for (const key of ['cities', 'admin1', 'admin2', 'countries', 'out'])
    if (!options[key]) throw new Error(`--${key} is required`);
  return options;
}

const options = parseArguments(process.argv.slice(2));
const [cities, admin1, admin2, countries] = await Promise.all([
  readFile(options.cities, 'utf8'),
  readFile(options.admin1, 'utf8'),
  readFile(options.admin2, 'utf8'),
  readFile(options.countries, 'utf8'),
]);
await mkdir(options.out, { recursive: true });
const placeLines = slimPlaces(cities);
const places = `${PLACES_HEADER}\n${placeLines.join('\n')}\n`;
await writeFile(
  path.join(options.out, 'places.tsv.gz'),
  gzipSync(places, { level: 9 }),
);
await writeFile(
  path.join(options.out, 'admin1.tsv'),
  `${slimAdmin1(admin1).join('\n')}\n`,
);
const admin2Lines = slimAdmin2(admin2, placeLines);
await writeFile(
  path.join(options.out, 'admin2.tsv'),
  `${admin2Lines.join('\n')}\n`,
);
await writeFile(
  path.join(options.out, 'countries.tsv'),
  `${slimCountries(countries).join('\n')}\n`,
);
console.log(
  `[geonames] ${placeLines.length} places, ` +
    `${slimAdmin1(admin1).length} admin1 regions, ` +
    `${admin2Lines.length} admin2 districts, ` +
    `${slimCountries(countries).length} countries -> ${options.out}`,
);
