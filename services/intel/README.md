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

That starts three containers: the app, this service with its corpus built into
the image, and a deterministic stub runtime. Nothing is mounted from the host —
the corpus is produced during `podman build`, so the checksum `/health` reports
describes exactly the data inside the image.

## Answering with a real model

The stub exists so the deployment is testable without a GPU. To answer with a
real model, run an OpenAI-compatible runtime on the machine (Ollama, vLLM,
llama.cpp) and set three values in `.env`:

```sh
INTEL_RUNTIME_URL=http://host.containers.internal:11434
INTEL_MODEL=<a model your runtime has already pulled>
INTEL_RUNTIME=ollama
```

Then `podman compose --profile intel up -d --force-recreate`. No file is
edited and no image is rebuilt. `INTEL_RUNTIME_URL` is where your questions and
the retrieved records are sent, so point it only at hardware you control.

A model that reasons before it answers takes 20-60 seconds on a workstation
GPU. The app waits 120 seconds by default; `STARLIGHT_INTEL_TIMEOUT_MS` changes
that.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port, default 8080 |
| `INTEL_MODEL` | Model name reported by `/health` and sent to the runtime |
| `INTEL_RUNTIME_URL` | OpenAI-compatible runtime base URL (Ollama, vLLM, llama.cpp) |
| `INTEL_RUNTIME` | Runtime label reported by `/health` |
| `INTEL_CORPUS` | Path to the corpus JSON array, default `/app/corpus/corpus.json` |
| `INTEL_EGRESS` | `auto` to measure it, or a fixed `blocked` / `allowed` / `unknown` |
| `INTEL_EGRESS_PROBE` | `host:port` the `auto` check dials, default `1.1.1.1:443` |

Endpoints: `GET /health`, `POST /query`.

### What `egress` means

`auto` makes the service open one TCP connection at startup to
`INTEL_EGRESS_PROBE` and report `allowed` if it connects and `blocked` if it
cannot. It is a measurement, not a promise: `blocked` means this container had
no route to the public internet when it started.

The compose network is routable by default, so a runtime on the host is
reachable and `/health` reports `allowed`. For a deployment that is provably
cut off, add `internal: true` to the `intel` network in `compose.yaml` — the
model runtime must then live inside that network, which the stub does and a
runtime on the host does not.

## The corpus

`services/intel/scripts/build-corpus.mjs` turns the two bundled datasets into
one JSON array of records:

```sh
node services/intel/scripts/build-corpus.mjs --out /tmp/corpus.json
```

6,268 records: 4,351 datacenters and 1,917 submarine cable landing points. Each
record is `{ id, kind, label, lat, lon, text, source }`. Retrieval is term
overlap over `label` and `text`, weighted towards rare terms, so `text` carries
what an operator would ask about — including, for every datacenter, the nearest
cable landing point and its great-circle distance, computed at build time. That
precomputed join is what lets "which datacenters are near the Marseille landing
point" be answered without a geospatial query.

The build is deterministic: the same inputs produce byte-identical output, so
the checksum on `/health` identifies the data and not the build. The generated
file is an artifact and is never committed — `podman build` produces it, and so
does the command above for local work.

### Data licences

The corpus is derived from two bundled datasets, and every record names its
source. Redistributing a built corpus carries both obligations with it:

- **Datacenters** — © OpenStreetMap contributors, under the
  [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/).
  Attribution and share-alike required.
- **Submarine cable landing points** — © TeleGeography,
  [submarinecablemap.com](https://www.submarinecablemap.com/), under
  [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
  **Non-commercial.** Commercial use means either obtaining a commercial
  licence from TeleGeography, or dropping the dataset: remove
  `src/data/local_data/telegeography_submarine_cables/` and the line in
  `services/intel/Containerfile` that copies it, and build with
  `--landing-points` pointing at an empty `FeatureCollection`. The corpus is
  then datacenters alone, without the landing-point join.

See each source directory's `README.md` and the repository's `DATA_SOURCES.md`.

## The stub runtime

`services/intel/test/stub-runtime.mjs` implements `POST
/v1/chat/completions` and answers from the request alone: the number of records
it was shown and the first of their ids. The same question always produces the
same bytes, which is what lets a browser test assert on an answer. Every answer
opens with `Starlight stub runtime (no model)`, so a stub reply can never be
mistaken for a model's in a demo or a screenshot.

```sh
PORT=11434 node services/intel/test/stub-runtime.mjs
```
