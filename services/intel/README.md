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
INTEL_REASONING_EFFORT=none
```

Then `podman compose --profile intel up -d --force-recreate`. No file is
edited and no image is rebuilt. `INTEL_RUNTIME_URL` is where your questions and
the retrieved records are sent, so point it only at hardware you control.

### Latency

A model that reasons before it answers spends most of its time reasoning, not
retrieving. The prompt is small — 593 tokens for a question over eight records
— and the reply was the cost. Two settings account for almost all of the wait,
measured against a local 4B model on a workstation GPU:

| Setting | Warm latency | Completion tokens |
| --- | --- | --- |
| eight records, no `reasoning_effort` | 79-83 s | ~700 |
| eight records, `reasoning_effort: none` | 17 s | 199 |
| five records, `reasoning_effort: none` | 4-7 s | ~110 |

Both are defaults now. `INTEL_REASONING_EFFORT` is sent as the standard OpenAI
`reasoning_effort` field and defaults to `none`; setting it to an empty string
sends no such field at all, for a runtime that rejects it. The retrieval limit
defaults to five records, because the model answers in proportion to what it is
shown.

Capping `max_tokens` instead does not work: the reasoning consumes the budget
and the response comes back empty with `finish_reason: length`. Ollama's
`think: false` is accepted over the OpenAI-compatible endpoint and ignored, and
so is `keep_alive` — which is why the service keeps the model resident itself,
with one tiny completion at startup and another every `INTEL_KEEP_WARM_MS`
(240 s by default, inside Ollama's five-minute idle eviction; 0 never pings).
Those requests are fire-and-forget: they never block startup or `/health`, and
a runtime that is not up yet is simply tried again.

The app waits 120 seconds for an answer by default;
`STARLIGHT_INTEL_TIMEOUT_MS` changes that.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port, default 8080 |
| `INTEL_MODEL` | Model name reported by `/health` and sent to the runtime |
| `INTEL_RUNTIME_URL` | OpenAI-compatible runtime base URL (Ollama, vLLM, llama.cpp) |
| `INTEL_RUNTIME` | Runtime label reported by `/health` |
| `INTEL_CORPUS` | Path to the corpus JSON array, default `/app/corpus/corpus.json` |
| `INTEL_REASONING_EFFORT` | Sent as `reasoning_effort`, default `none`; empty sends nothing |
| `INTEL_KEEP_WARM_MS` | How often to nudge the runtime so the model stays loaded, default 240000 |
| `INTEL_EGRESS` | `auto` to measure it, or a fixed `blocked` / `allowed` / `unknown` |
| `INTEL_EGRESS_PROBE` | `host:port` the `auto` check dials, default `1.1.1.1:443` |

Endpoints: `GET /health`, `POST /query`.

### What `egress` means

`auto` makes the service open one TCP connection at startup to
`INTEL_EGRESS_PROBE`, with a two-second timeout that cannot hold up startup. It
is a measurement, not a promise: `blocked` means this container had no route to
the public internet when it started.

Only an inability to connect out reads as `blocked` — the connection refused,
the host or network unreachable, the connection reset, or the attempt dropped
in silence, which is what an egress firewall looks like from inside. A failure
that says nothing about routing reads as `unknown` instead: a name that will
not resolve, a socket the container is not permitted to open, or an error the
service does not recognise. A machine without DNS is not a machine without
egress, and `/health` should not claim otherwise.

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
record is `{ id, kind, label, lat, lon, text, source }`, and a datacenter also
carries `nearestKm`. `text` holds what an operator would ask about — including,
for every datacenter, the nearest cable landing point and its great-circle
distance, computed at build time. That precomputed join is what lets "which
datacenters are near the Marseille landing point" be answered without a
geospatial query.

### How retrieval ranks

Records are indexed once at startup into tokens, and a question's terms match a
token when either is a prefix of the other — so datacenter finds datacenters,
but `by` no longer matches the middle of "Brondby". Terms are weighted by how
rare they are, and a short list of words that separate nothing (the, of, by,
near, operated, which) neither match nor count.

Records that tie are ordered by `nearestKm`. Every datacenter whose nearest
landing point is Marseille matches exactly the same terms, so without that
"near the Marseille landing point" answered with sites 300 km away. A landing
point has no distance and sorts as if at zero: it is the place being asked
about, so it comes ahead of a datacenter it would otherwise tie with.

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
