# Starlight Local Intel service

Retrieval and inference over a local corpus, on hardware you run. The
application reaches it through `/api/intel/*` and the browser never talks to it
directly. Questions, the records retrieved for them and the model's answer stay
on the machine the service and its runtime are deployed on.

## Run it

```sh
podman compose --profile intel up -d --build   # app + intel + stub runtime
curl http://localhost:4173/api/intel/health
```

That starts three containers: the app, this service with its corpus and
gazetteer built into the image, and a deterministic stub runtime. Nothing is
mounted from the host except one named volume for the vector index cache —
the corpus is produced during `podman build`, so the checksum `/health`
reports describes exactly the data inside the image.

## How a question is answered

```
question ──▶ 1. read ──▶ 2. place ──▶ 3. retrieve ──▶ 4. answer ──▶ panel + globe
             model       gazetteer     place + vectors   model, as JSON
             (JSON)      (offline)     + words           with used ids
```

1. **Read.** The model is asked, through the runtime's JSON-schema output, what
   the question is about: the place it names, the region and country, the
   kind of record (datacenter, landing point, any), an operator, its intent
   (list in a place, nearest to, operator, count, other) and any distance it
   states. It is never asked for coordinates: the model that reads
   "Woodbridge, Virginia" perfectly places it 20 km off.
2. **Place.** A vendored GeoNames slice (171,000 populated places, 3,900
   states and provinces, 33,000 counties and districts, 252 countries)
   resolves the reading to a coordinate, offline. A state resolves as
   membership — every record the corpus build labelled "Virginia" — and a
   town, county or country as a centre with a radius.
3. **Retrieve.** Kind and operator narrow the corpus first. Then three signals
   are fused: distance to the place (or membership of the region), cosine
   similarity of the question's embedding to each record's, and term overlap
   weighted by rarity. Any signal may be absent — no place named, no
   embedding model configured — and the fusion degrades to what remains,
   down to the plain term overlap the service started with. A place question
   never cites beyond its reach; a "nearest" question has none.
4. **Answer.** The model is shown the retrieved records, each with its
   distance from the place asked about, and answers as JSON: the prose, the
   ids of the records it relied on, and whether the globe should fly to one
   site or frame them all. The citations lead with the records it used; the
   service turns its verdict into camera actions, never trusting an id it
   was not shown.

The response carries the reading, the resolved place, the citations with
their town and distance, the actions, and a trace of the four steps with
timings, which the panel shows beneath the answer. On the GB10 with
gemma4:12b for reading and answering and embeddinggemma for vectors, a
question answers in 7–10 s warm: about 2.5 s to read, under 50 ms to place
and retrieve, and the rest to answer.

## Answering with a real model

The stub exists so the deployment is testable without a GPU. To answer with
a real model, run an OpenAI-compatible runtime on the machine (Ollama, vLLM,
llama.cpp) and set these in `.env`:

```sh
INTEL_RUNTIME_URL=http://host.containers.internal:11434
INTEL_MODEL=gemma4:12b          # reads and answers; must follow a JSON schema
INTEL_EMBED_MODEL=embeddinggemma # `ollama pull embeddinggemma`; empty disables vectors
INTEL_RUNTIME=ollama
INTEL_REASONING_EFFORT=none
```

Then `podman compose --profile intel up -d --force-recreate`. No file is
edited and no image is rebuilt. `INTEL_RUNTIME_URL` is where your questions,
the retrieved records and the corpus text for embedding are sent, so point it
only at hardware you control.

The reading and answering model must honour `response_format` with a JSON
schema. gemma4:12b does; gemma4:e4b ignores it and answers in prose, in which
case the service falls back to an empty reading (retrieval by words alone)
and takes the prose as the answer with citations in retrieval order. The
golden set below tells you within a minute whether a model is up to it.

### The vector index

On first start with `INTEL_EMBED_MODEL` set, the service embeds every record
through `/v1/embeddings` in the background — 6,268 records take about 30 s
with embeddinggemma on a GB10 — and writes the index to `/app/cache`, which
compose mounts as the `intel-cache` volume. Later starts read it back in
milliseconds. The cache is keyed by corpus checksum and model, so a rebuilt
corpus or a changed model re-embeds. Until the index is ready, retrieval runs
on place and words and `/health` reports `embeddings.ready: false` with the
count so far.

### Latency

A model that reasons before it answers spends most of its time reasoning, not
retrieving. `INTEL_REASONING_EFFORT` is sent as the standard OpenAI
`reasoning_effort` field and defaults to `none`; setting it to an empty
string sends no such field at all, for a runtime that rejects it. The
retrieval limit defaults to five records, and `INTEL_MODEL_RECORDS` caps how
many of them the model is shown however many the panel cites, because the
model answers in proportion to what it is given.

Ollama ignores `keep_alive` over its OpenAI-compatible endpoint, which is why
the service keeps the model resident itself, with one tiny completion at
startup and another every `INTEL_KEEP_WARM_MS` (240 s by default, inside
Ollama's five-minute idle eviction; 0 never pings). Those requests are
fire-and-forget: they never block startup or `/health`.

The app waits 120 seconds for an answer by default;
`STARLIGHT_INTEL_TIMEOUT_MS` changes that.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port, default 8080 |
| `INTEL_MODEL` | Answering model, reported by `/health` and sent to the runtime |
| `INTEL_READER_MODEL` | Model that reads the question; defaults to `INTEL_MODEL`, empty skips reading |
| `INTEL_EMBED_MODEL` | Embedding model for the vector index; empty disables vectors |
| `INTEL_EMBED_CACHE` | Directory for the cached index, default `/app/cache` |
| `INTEL_GAZETTEER` | Directory of the vendored GeoNames slice, default `/app/gazetteer`; empty disables places |
| `INTEL_RUNTIME_URL` | OpenAI-compatible runtime base URL (Ollama, vLLM, llama.cpp) |
| `INTEL_RUNTIME` | Runtime label reported by `/health` |
| `INTEL_CORPUS` | Path to the corpus JSON array, default `/app/corpus/corpus.json` |
| `INTEL_REASONING_EFFORT` | Sent as `reasoning_effort`, default `none`; empty sends nothing |
| `INTEL_KEEP_WARM_MS` | How often to nudge the runtime so the model stays loaded, default 240000 |
| `INTEL_MODEL_RECORDS` | How many retrieved records the model is shown, default 5 |
| `INTEL_EGRESS` | `auto` to measure it, or a fixed `blocked` / `allowed` / `unknown` |
| `INTEL_EGRESS_PROBE` | `host:port` the `auto` check dials, default `1.1.1.1:443` |

Endpoints: `GET /health`, `POST /query` with `{ question, limit }`.

### What `egress` means

`auto` makes the service open one TCP connection at startup to
`INTEL_EGRESS_PROBE`, with a two-second timeout that cannot hold up startup. It
is a measurement, not a promise: `blocked` means this container had no route to
the public internet when it started. Only an inability to connect out reads as
`blocked`; a failure that says nothing about routing (no DNS, a socket the
container may not open) reads as `unknown`.

The compose network is routable by default, so a runtime on the host is
reachable and `/health` reports `allowed`. For a deployment that is provably
cut off, add `internal: true` to the `intel` network in `compose.yaml` — the
model runtime must then live inside that network, which the stub does and a
runtime on the host does not.

## The corpus

`services/intel/scripts/build-corpus.mjs` turns the bundled datasets into one
JSON array of records, labelling each with its nearest town from the
gazetteer:

```sh
node services/intel/scripts/build-corpus.mjs --out /tmp/corpus.json
```

6,268 records: 4,351 datacenters and 1,917 submarine cable landing points.
Each record is `{ id, kind, label, lat, lon, city, region, country,
countryCode, text, source }`; a datacenter also carries `operator` and
`nearestKm`. `text` holds what an operator would ask about: the name,
operator, website domain and floors where OpenStreetMap has them, "located
in Sterling, Virginia, United States", and for every datacenter the nearest
cable landing point with its distance. An unnamed site is labelled
"Datacenter near <town>" rather than by its OpenStreetMap number.

The build is deterministic: the same inputs produce byte-identical output, so
the checksum on `/health` identifies the data and not the build. The generated
file is an artifact and is never committed.

### The gazetteer

`src/data/local_data/geonames/` holds a seven-column slice of GeoNames
(CC BY 4.0), produced by `services/intel/scripts/slim-geonames.mjs`; the
folder README records the fetch and the slimming. Names match without case,
accents or punctuation; "Frankfurt" finds Frankfurt am Main; a hint such as
"Virginia" or "UK" picks among namesakes, and an unhinted namesake of
comparable size is reported as `ambiguous` so the panel can say which one it
assumed. "Northern Virginia" strips its qualifier and resolves to the state.

### Data licences

- **Datacenters** — © OpenStreetMap contributors,
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Attribution and
  share-alike required.
- **Submarine cable landing points** — © TeleGeography,
  [submarinecablemap.com](https://www.submarinecablemap.com/),
  [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
  **Non-commercial.** For commercial use obtain a licence or drop the
  dataset: remove `src/data/local_data/telegeography_submarine_cables/` and
  the line in `services/intel/Containerfile` that copies it, and build with
  `--landing-points` pointing at an empty `FeatureCollection`.
- **Places** — [GeoNames](https://www.geonames.org),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution
  required; it is registered in the app's Data attribution popover.

See each source directory's `README.md` and the repository's `DATA_SOURCES.md`.

## Testing

Unit tests live beside the application's under `src/sources/intel*.test.mjs`
and run with `npm test`: the gazetteer, the corpus build, the reader, the
embedding index, retrieval fusion, the request handler and the stub.

`services/intel/test/golden.mjs` asks a live service ten questions and checks
what a correct retrieval looks like — the place resolved, how far citations
may be from it, names that must or must not appear — without pinning the
model's prose:

```sh
node services/intel/test/golden.mjs                       # via the app on :4173
INTEL_URL=http://localhost:8080 node services/intel/test/golden.mjs
```

Its exit status is the number of failures. Run it after changing the model,
the corpus or retrieval; a failure is a regression or a data gap worth
knowing about before a demo.

## The stub runtime

`services/intel/test/stub-runtime.mjs` implements `POST /v1/chat/completions`
and `POST /v1/embeddings` from the request alone, so the whole pipeline runs
and can be asserted without a GPU. Asked for JSON against the reading schema
it returns an empty reading; against the answer schema it returns its usual
prose naming the first records as the ones it used, so the camera actions
are exercised too. Embeddings are deterministic bag-of-words vectors: texts
that share words are close. Every answer opens with `Starlight stub runtime
(no model)`, so a stub reply can never be mistaken for a model's.

```sh
PORT=11434 node services/intel/test/stub-runtime.mjs
```
