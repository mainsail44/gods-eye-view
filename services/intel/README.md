# Starlight Local Intel service

Retrieval and inference over a local corpus. Runs as a Starlight workload; the
application reaches it through `/api/intel/*` and the browser never talks to it
directly.

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port, default 8080 |
| `INTEL_MODEL` | Model name reported by `/health` and sent to the runtime |
| `INTEL_RUNTIME_URL` | OpenAI-compatible runtime base URL (Ollama, vLLM, llama.cpp) |
| `INTEL_RUNTIME` | Runtime label reported by `/health` |
| `INTEL_CORPUS` | Path to the corpus JSON array |
| `INTEL_EGRESS` | `blocked` or `allowed`, reported by `/health` |

Endpoints: `GET /health`, `POST /query`.
