# Starlight sovereign intel — design

Date: 2026-09-17
Status: approved for phase 1 implementation planning

## 1. Purpose

Turn God's Eye View into a demonstration that Starlight runs VMs, containers,
and AI on infrastructure the customer owns. The proof is a single claim, shown
rather than asserted: **this application answered a real question about real
data, and nothing left the box.**

The audience is defense and national-security buyers who operate satellites and
ground stations. The demonstration must survive the network cable being pulled.

### Positioning constraint

Starlight is software the customer installs and runs. Nothing in this work may
imply Mainsail provides infrastructure, capacity, or uptime. The demonstration
runs on hardware the customer brings.

### Goals

- Local inference over a local corpus, with no cloud dependency on the answer path.
- Visible, verifiable sovereignty: the operator can see which model answered,
  over which corpus, and whether egress was possible.
- Geolocated RF and signals analysis relevant to satellite and ground-station
  operators.
- The AI runs as a Starlight workload, not as part of the application.
- The capability is operator-toggleable from the interface, so it can be shown
  being switched on and off.

### Non-goals

- Replacing the existing OpenAI voice path in phase 1. The architecture leaves a
  socket for it; the work is deferred.
- Hosting anything. No Mainsail-operated services.
- Decoding transmissions whose interception is legally constrained.

## 2. Architecture

Two artifacts and one interface between them.

### 2.1 `starlight-intel` service

A standalone OCI image, scheduled by Starlight, independently migratable.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible passthrough to the chosen runtime |
| `POST /query` | Grounded question answering over the local corpus |
| `GET /health` | Model, runtime, corpus version and checksum, attestation state, egress status |

The OpenAI-compatible surface is what keeps the hardware decision open: Ollama,
vLLM, and llama.cpp all speak this dialect, so the runtime can change without
touching application code.

Internal units, each independently testable:

- **Corpus loader** — reads the versioned index artifact, exposes a checksum.
- **Retriever** — two modes, see §4.
- **Prompt assembly** — builds grounded prompts, enforces citation requirements.
- **Action validator** — validates model-proposed map actions against the
  existing schema before they are returned.

### 2.2 God's Eye View as client

GEV gains no inference logic. It gains a proxy, a source module, and two UI
surfaces.

- `server/providers/sovereign.js`, registered in `server/providers/local.js`
  alongside the existing provider proxies, exposing `/api/intel/query` and
  `/api/intel/health`. The service URL is server-side only; the browser never
  learns it.
- A client fetch module under `src/sources/`, keeping `npm run check:boundaries`
  green. Import direction rules are enforced by CI and are not negotiable.
- An "ask the map" panel, and a sovereignty indicator in the HUD.

### 2.3 Speech input

Handy (local Whisper/Parakeet dictation) is already in use and requires no
integration: it pastes transcribed text into the focused field. With the "ask
the map" input focused, Handy **is** the voice interface. No realtime pipeline,
no latency risk, no new dependency.

A spoken-reply TTS leg and a true realtime path remain possible later against
the same service endpoints.

### 2.4 Starlight Local Intel — HUD component

The sovereign AI must be a thing the operator can switch on and off from the
interface, not a background behavior. It is registered as **Starlight Local
Intel**: a toggleable component in the heads-up display, carried by the same
plumbing every other layer uses rather than a bespoke control.

**Registration.** A control entry `starlightIntelLayer -> 'starlight-intel'` in
`CONTROL_LAYER_IDS` (`src/app/catalog.js`), a catalog entry constructed in
`src/app/constructCatalog.js`, and serialization metadata in
`LAYER_STATE_REGISTRY` (`src/data/layerState.js`) with the `enabled-only`
disposition. Using the existing registry means the toggle appears in the Data
Layers panel, persists to local storage, and travels in share links for free —
a demonstration can be handed over as a URL with the component already on.

**Rendered surface.** When enabled the HUD shows a panel with:

- A status line: model, runtime, corpus version and checksum, egress state, and
  attestation state when available. This is the sovereignty indicator from §7,
  living inside the component rather than floating separately.
- The ask-the-map input, which is also the Handy dictation target (§2.3).
- The last answer with its citations, each citation selectable to fly the camera
  to the cited feature.

**Toggle semantics.** Off is genuinely off, not hidden: health polling stops,
any in-flight query is aborted, and no request reaches the intel service. The
map itself is unaffected in either state. This matters for the demonstration —
toggling the component off and on is how the operator shows that the local AI is
a discrete, schedulable capability rather than something baked into the app.

**Naming.** The component reads "Starlight Local Intel" in the interface.
Sentence case elsewhere per the brand guide; this is a proper product name and
keeps its casing.

## 3. Data flow

```
Handy (local STT)
  → "ask the map" input
  → GEV client → /api/intel/query (server-side proxy)
  → starlight-intel: retrieve → prompt → local model
  → { answer, citations[], actions[] }
  → GEV validates actions against the existing gevActions schema
  → map flies / highlights / toggles layers
  → HUD: answer + "answered locally · <model> · corpus <version> · egress blocked"
```

`src/voice/actionSchemas.js` and `src/voice/gevActions.js` already define the
structured verbs the cloud voice path drives. The local model targets those same
schemas. Map manipulation therefore works from day one, and the later voice work
reuses this call path unchanged.

## 4. Corpus and retrieval

Signals are not documents. Retrieval has two modes and the model selects between
them by tool call — the same mechanism `gevActions` already uses.

**Document retrieval** covers static geospatial data already bundled with the
application: submarine cables and landing points, the datacenter and dam
`geojsonl` sets, military installations, and Natural Earth regions. Geospatial
prefilter (bounding box or radius) narrows candidates, then attribute and text
matching ranks them. No external data is required, which is what makes the
air-gapped demonstration honest.

**Metric query** covers time-series signal data (§5). The retriever returns
aggregates, not rows.

Every citation carries a source identifier and the corpus version. The corpus is
built as a versioned, checksummed artifact so the interface can state which
corpus produced an answer — the same signed-artifact argument Starlight already
makes elsewhere.

## 5. RF and signals capabilities

Phase 1 sources, verified available and open on 2026-09-17. Later phases
(GNSS interference derivation, IQ classification) are out of scope for this
document and get their own specs.

### SatNOGS ground stations and passes

`network.satnogs.org/api/stations/` requires no authentication and returns
coordinates, antenna bands and frequency ranges, observation counts, and success
rates. `db.satnogs.org/api/satellites/` and `/transmitters/` are likewise open
and carry downlink frequencies, modes, and baud rates. The telemetry frames
endpoint requires an account and is out of scope.

Ground stations render as a globe layer. Pass prediction uses `satellite.js`,
already a project dependency. The question this answers — *which of my stations
sees this satellite in the next six hours, and which pass has the best maximum
elevation* — is the daily work of the target customer.

### WSPR propagation

`wspr.live` exposes a public ClickHouse SQL endpoint. Each row is a measured RF
path between two known coordinates with frequency and signal-to-noise ratio,
updating every two minutes with a multi-year archive. Paths render as arcs.

This is the corpus for anomaly detection: regional signal-to-noise collapse or
unexpected path openings, attributable to ionospheric and solar conditions.

### Already RF-derived

ADS-B (1090 MHz) and AIS (162 MHz) are existing layers and are signals data.
Labelling them accurately costs nothing and strengthens the story.

## 6. Failure behavior

Air-gap is a normal operating state, not an error, and the interface must say so.

| Condition | Behavior |
| --- | --- |
| Intel service unreachable | Panel shows degraded state, sovereignty indicator reads offline, map remains fully functional |
| Model timeout | Return citations without a synthesized answer |
| Retrieval empty | State that nothing matched. Never synthesize an unsupported answer |
| Upstream RF source unreachable | Layer reports staleness with last-known timestamp, consistent with existing layer behavior |

For a defense audience a confident wrong answer is worse than no answer. The
system declines rather than guesses.

## 7. Sovereignty proof

The demonstration is only a demonstration if it is verifiable.

- `GET /health` reports model, runtime, corpus version and checksum, and egress
  status; the Starlight Local Intel component (§2.4) polls it while enabled.
- Pulling the network cable is the proof. Cloud-dependent layers visibly fail —
  they should — while local answers continue. Reconnection reconciles.
- Optional and high value for this audience: run inference inside a confidential
  compute enclave and surface attestation state in the same indicator.

## 8. Testing

- Unit tests for retrieval, action validation, and pass prediction via
  `scripts/run-unit-tests.mjs`, following existing repository conventions.
- Contract tests against recorded SatNOGS and wspr.live fixtures so the suite
  runs offline.
- `npm run check:boundaries` stays green; import direction rules are enforced.
- A staged air-gap test asserting degraded-state behavior rather than crashes.
- Layer-state round-trip tests for the Starlight Local Intel toggle, covering
  local storage and share-link restoration, matching existing layer coverage.
- A test asserting that the disabled component issues no network requests.

## 9. Risks and open questions

| Risk | Handling |
| --- | --- |
| Local model drives `gevActions` schemas unreliably | Validate every action before execution; measure early in implementation |
| Retrieval quality over geojson attributes is poor | Start with geospatial prefilter plus attribute match; add embeddings only if measured need |
| Hardware undecided | OpenAI-compatible interface defers the choice; revisit before phase 3 GPU work |
| Upstream licensing | GEV is MIT but carries required attributions (Cesium ion, Google, TfL). Review before customer-facing use |

## 10. Phasing

| Phase | Contents | Spec |
| --- | --- | --- |
| 1 | Intel service, Starlight Local Intel HUD component, SatNOGS stations and passes, WSPR propagation | This document |
| Later | GNSS interference derivation, IQ modulation classification | Own specs, not yet written |

Phase 1 ships an env-configurable base URL first, as an early checkpoint that
proves the answer path is local before the service is complete.
