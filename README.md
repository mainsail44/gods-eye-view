# God's Eye View + Starlight Local Intel

A real-time 3D globe (Cesium, in the browser) with live aircraft, ships,
satellites, fires and infrastructure layers, plus **Starlight Local Intel**: a
toggleable HUD layer that answers plain-English questions about the map's
bundled data using a model running on your own hardware. Nothing leaves the
machine. Answers carry clickable citations that fly the camera to each place.

This fork is a demonstration of running the app and its AI as containers on
local hardware. It is demo-grade by design, not a hardened service.

- Upstream project: <https://github.com/bilawalsidhu/gods-eye-view>
- This fork: <https://github.com/mainsail44/gods-eye-view>

## What you get

Three containers, started from one `compose.yaml`:

| Service              | What it is                                                                                                                                                                                                                                                                                      | Port             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `gods-eye-view`      | The globe app. Serves the UI and proxies every data source, including the intel service, so the browser never talks to a backend directly.                                                                                                                                                      | 4173             |
| `starlight-intel`    | The AI service. Holds a 6,268-record corpus (4,351 datacenters + 1,917 submarine-cable landing points) built into the image, retrieves the records relevant to a question, and asks a model runtime to answer from those records only. Declines without calling the model when nothing matches. | 8080 (internal)  |
| `intel-runtime-stub` | A deterministic fake model for testing without a GPU. Its answers say they are from a stub. Replaced by a real model via `.env`.                                                                                                                                                                | 11434 (internal) |

The second and third only start under the `intel` compose profile.

## Requirements

- **Podman** (Docker also works; use `docker compose` in place of `podman compose`).
- **Node.js 24.14+ or 26.x** only if you want to run tests or a dev server outside containers. Not needed to run the stack.
- For a real model: **Ollama 0.34 or newer** installed on the host (not in a container). Older Ollama cannot pull Gemma 4.
- Hardware: the app itself is light. The model is the cost. `gemma4:e4b` runs in ~3.2 GB of GPU/unified memory; `gemma4:12b` wants ~10 GB.

## Setup

### 1. Clone

```sh
git clone https://github.com/mainsail44/gods-eye-view.git
cd gods-eye-view
```

`main` contains everything. The bundled datacenter and landing-point data ship
in the repo (`src/data/local_data/`), so no data download is needed.

### 2. Install a model runtime and pull a model

Ollama, on the host machine:

```sh
# macOS
brew install ollama && brew services start ollama
# Linux
curl -fsSL https://ollama.com/install.sh | sh

ollama --version        # must be 0.34 or newer
ollama pull gemma4:e4b  # ~9.6 GB download, 3.2 GB resident
```

Verify it answers before involving the app:

```sh
ollama run gemma4:e4b "Reply with exactly: ok"
```

Models to consider (all pulled the same way):

| Model        | Memory  | Notes                                                                                   |
| ------------ | ------- | --------------------------------------------------------------------------------------- |
| `gemma4:e4b` | ~3.2 GB | Verified for this demo. Warm answers in 4–8 s on an Apple M4; faster on a discrete GPU. |
| `gemma4:12b` | ~10 GB  | Better answers if you have the memory (e.g. an NVIDIA GB10 or a 24 GB+ GPU).            |
| `gemma4:e2b` | ~2 GB   | For small machines. Weaker answers.                                                     |

Do **not** use `gemma4:cloud`. That tag runs inference on Ollama's servers,
which defeats the point of a local, sovereign deployment.

Any other OpenAI-compatible runtime (vLLM, llama.cpp server) works too; the
service only ever calls `POST /v1/chat/completions`.

### 3. Create `.env`

```sh
cp .env.container.example .env
```

Then edit `.env`. For the intel service, set these four lines:

```sh
INTEL_RUNTIME_URL=http://host.containers.internal:11434
INTEL_MODEL=gemma4:e4b
INTEL_RUNTIME=ollama
INTEL_REASONING_EFFORT=none
```

`host.containers.internal` is how a container reaches Ollama on the host under
Podman. If `/api/intel/health` later reports the service unreachable, use the
host's LAN IP instead and make Ollama listen on it
(`OLLAMA_HOST=0.0.0.0` in Ollama's environment).

Everything else in `.env` is optional. The globe works with no keys at all; the
two that matter most for the visuals are free:

| Key                   | Purpose                           | Get it                                                         |
| --------------------- | --------------------------------- | -------------------------------------------------------------- |
| `CESIUM_ION_TOKEN`    | Terrain and Cesium-hosted imagery | <https://cesium.com/ion>                                       |
| `GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles    | <https://console.cloud.google.com/> (enable the Map Tiles API) |

`.env` is gitignored. Nothing in it is baked into an image: server-side keys are
read at run time, and the two browser-side keys above are injected into the
built assets when the app container starts.

### 4. Build and start

```sh
podman compose --profile intel up -d --build
```

The `--profile intel` flag is required. Without it only the globe app starts and
the intel layer reports the service unavailable.

After any code change, add `--force-recreate`; without it podman-compose
rebuilds the image but keeps the old container running.

### 5. Check it

```sh
podman ps                                       # three containers
curl -s http://localhost:4173/api/intel/health   # model, record count, corpus checksum
```

A healthy response looks like:

```json
{
  "model": "gemma4:e4b",
  "runtime": "ollama",
  "egress": "allowed",
  "corpus": {
    "version": "2026-09-21",
    "checksum": "aad1f88c…",
    "records": 6268
  }
}
```

Then open <http://localhost:4173>.

The first question after startup takes 30–60 s while the model loads. The
service then keeps it resident (a tiny ping every 4 minutes), so later answers
take a few seconds. Ask a throwaway question before an audience arrives.

## Using it

1. In the app, open **Data Layers** (left side; click the header to expand).
2. Scroll to the bottom. Under **Other layers**, switch on **◆ Starlight Local Intel**.
3. A panel appears above the bottom dock. Its status line shows the model, the
   corpus version and checksum, and whether the service has outbound network
   access.
4. Type a question and press Enter. Questions that work well:
   - `which datacenters are near the Marseille landing point?`
   - `datacenters operated by Equinix`
   - `landing points in Denmark`
   - `which AWS datacenters are in the local data?`
5. Click a citation under the answer to fly the camera to that place.
6. Ask something unrelated (`zzqx vorpal snark`) to see it decline: the fixed
   answer "No matching records in the local corpus." comes back instantly and
   the model is never called.
7. Switch the layer off: the panel disappears and all traffic to the service stops.

The toggle state persists across reloads and travels in the share URL (`l=k`).

## Switching between the stub and a real model

Remove or blank the four `INTEL_*` lines in `.env` to use the deterministic
stub, or set them to use a real model, then:

```sh
podman compose --profile intel up -d --force-recreate
```

No rebuild is needed. To change models, change `INTEL_MODEL` to any tag Ollama
has pulled.

## Stopping

```sh
podman compose --profile intel down
```

Plain `podman compose down` leaves the intel containers running.

## Configuration reference

All read from `.env`. Defaults apply when unset.

| Variable                     | Default                       | Meaning                                                                                                                                                     |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTEL_RUNTIME_URL`          | the stub                      | OpenAI-compatible runtime the service sends questions to. Point it only at hardware you control.                                                            |
| `INTEL_MODEL`                | `starlight-stub`              | Model name sent to the runtime and shown in the HUD.                                                                                                        |
| `INTEL_RUNTIME`              | `stub`                        | Label shown in `/health` (`ollama`, `vllm`, …).                                                                                                             |
| `INTEL_REASONING_EFFORT`     | `none`                        | Sent as OpenAI's `reasoning_effort`. `none` cuts Gemma's answer time from ~80 s to a few seconds. Set to empty to send no such field.                       |
| `INTEL_MODEL_RECORDS`        | `5`                           | How many retrieved records the model is shown. The panel cites five regardless.                                                                             |
| `INTEL_KEEP_WARM_MS`         | `240000`                      | Interval of the keep-resident ping. `0` disables it.                                                                                                        |
| `INTEL_EGRESS`               | `auto`                        | `auto` measures at startup with one TCP connect and reports `allowed`, `blocked` or `unknown`. Set `blocked`/`allowed`/`unknown` to assert without probing. |
| `STARLIGHT_INTEL_URL`        | `http://starlight-intel:8080` | Where the app's proxy finds the service.                                                                                                                    |
| `STARLIGHT_INTEL_TIMEOUT_MS` | `120000`                      | How long the app waits for an answer.                                                                                                                       |

More detail, including how retrieval ranks records and what `egress` means, is
in [`services/intel/README.md`](services/intel/README.md).

## How it works

```
browser ──/api/intel/*──▶ gods-eye-view (proxy) ──▶ starlight-intel ──▶ model runtime
                                                      │
                                                corpus.json (in image)
```

- The corpus is built at `podman build` time from the bundled GeoJSON in
  `src/data/local_data/` by `services/intel/scripts/build-corpus.mjs`. Each
  datacenter record carries its nearest cable landing point and the distance,
  precomputed, so "near" questions work with plain text retrieval. The corpus
  checksum shown in the HUD identifies exactly which data answered.
- Retrieval is keyword matching, weighted by how rare each word is in the corpus,
  with ties broken by distance. There is no vector database; 6,000 records scan
  in well under a second.
- The model receives only the retrieved records and a prompt telling it to
  answer from them alone, in at most three sentences. If nothing matches, the
  model is never called.
- The browser never learns the service or runtime address; only the app's
  server-side proxy talks to them.

## Development (outside containers)

```sh
npm ci
npm test                    # unit suite
npm run check:boundaries    # import-direction and package-boundary gates
npm run format:check
npm run build
npm run dev                 # Vite dev server on :4173 with all provider proxies
```

Design spec and implementation plan for the intel feature:
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Data and licences

- **Datacenters**: OpenStreetMap contributors, ODbL 1.0.
- **Submarine cable landing points**: © TeleGeography, submarinecablemap.com,
  **CC BY-NC-SA 3.0 — non-commercial**. Remove `src/data/local_data/telegeography_submarine_cables/`
  or obtain a licence before any commercial use.
- Full terms for every bundled and live source: [`DATA_SOURCES.md`](DATA_SOURCES.md).

The application code is MIT licensed ([`LICENSE`](LICENSE)). God's Eye View is
by [Bilawal Sidhu](https://github.com/bilawalsidhu) and
[Sameh Khamis](https://github.com/samehkhamis) at [Halfpixel](https://halfpixel.ai);
see the upstream repository for the full project.

> [!IMPORTANT]
> This is an exploratory visualization of public and third-party data. Data may
> be delayed, incomplete, modeled, inferred, or wrong. Do not use it for
> navigation, emergency response, or any safety-critical or operational purpose.
