# AI Research Tool

Standalone local research assistant extracted from the Local AI stack in `finra-sec-data-visualizer-canvas`.

It keeps:

- Ollama chat UI
- Adaptive auto model routing (single specialist or tools/fetch + reason → merge)
- Tool calling (`fetch_url`, `current_time`)
- Localhost-only guard by default

FINRA/graph/Redis-specific tools and canvas snapshot wiring were removed.

## Quick start

1. Install deps: `pnpm install`
2. Run [Ollama](https://ollama.com) locally and pull a chat model, e.g. `ollama pull qwen2.5:7b`
3. Start the app: `pnpm dev` (http://localhost:3333)
4. Ask questions on the home page

## Env

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Ollama base URL (default `http://127.0.0.1:11434`) |
| `ALLOW_LOCAL_AI` | Set `1` to allow non-localhost access |
| `RESEARCH_FETCH_HOSTS` | Extra comma-separated hosts for `fetch_url` |
| `RESEARCH_OPEN_FETCH` | Set `1` to allow any public https host (private IPs still blocked) |

## API

- `GET /api/status` — Ollama reachability + free local models
- `POST /api/chat` — `{ question, model?, history?, availableModels? }`

## Notes

- Cloud Ollama tags (`*:cloud`) are filtered out of the picker.
- Skip paid cloud models; this app is meant for free local models.
