# GeoNames gazetteer slice

Offline place lookup for the Starlight Local Intel service
(`services/intel/src/gazetteer.js`): "Woodbridge, Virginia" resolves to a
coordinate, and every corpus record is labelled with its nearest town, region
and country at build time, with no network dependency.

| File             | Source dump             | Rows    | Columns kept                                                              |
| ---------------- | ----------------------- | ------- | ------------------------------------------------------------------------- |
| `places.tsv.gz`  | `cities1000.zip`        | 171,013 | geonameid, name, ascii name, lat, lon, country, admin1, admin2, population |
| `admin1.tsv`     | `admin1CodesASCII.txt`  | 3,865   | code (`US.VA`), name                                                      |
| `admin2.tsv`     | `admin2Codes.txt`       | ~19,000 | code (`GB.ENG.C6`), name — only codes some place uses                     |
| `countries.tsv`  | `countryInfo.txt`       | 252     | ISO code, name                                                            |

**Source:** GeoNames (https://www.geonames.org), daily dumps at
https://download.geonames.org/export/dump/, fetched 2026-09-22. Populated
places with a population of 1,000 or more (`cities1000`), feature class `P`.

**License:** Creative Commons Attribution 4.0 (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/. Attribution: "Data from
GeoNames (geonames.org), CC BY 4.0". See DATA_SOURCES.md and the in-app Data
attribution popover (`src/data/dataCredits.js`).

**Curation:** `services/intel/scripts/slim-geonames.mjs` keeps seven of the
dump's nineteen columns (alternate names alone are two thirds of the bytes),
rounds coordinates to four decimals (~11 m) and drops non-populated-place
rows. 32 MB of dump becomes a 3.8 MB gzip. To refresh:

```sh
curl -O https://download.geonames.org/export/dump/cities1000.zip && unzip cities1000.zip
curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
curl -O https://download.geonames.org/export/dump/admin2Codes.txt
curl -O https://download.geonames.org/export/dump/countryInfo.txt
node services/intel/scripts/slim-geonames.mjs --cities cities1000.txt \
  --admin1 admin1CodesASCII.txt --admin2 admin2Codes.txt \
  --countries countryInfo.txt --out src/data/local_data/geonames
```
