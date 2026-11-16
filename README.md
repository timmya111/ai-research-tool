# AI Research Tool

Standalone local research assistant extracted from the Local AI stack in `finra-sec-data-visualizer-canvas`.

It keeps:

- Ollama chat UI
- Adaptive auto model routing (single specialist or tools/fetch + reason → merge)
- Tool calling (`fetch_url`, `current_time`, `inspect_canvas_graph`)
- Live FINRA app API fetch (Vercel host allowlisted)
- Canvas snapshot attach from the live graph (postMessage window or pasted JSON)
- Localhost-only guard by default

Redis/firm-roster specialist tools stay in the FINRA app’s `/local-ai` page.

## Quick start

1. Install deps: `pnpm install`
2. Run [Ollama](https://ollama.com) locally and pull a chat model, e.g. `ollama pull qwen2.5:7b`
3. Start the app: `pnpm dev` (http://localhost:3333)
4. Ask questions on the home page

## Live FINRA app

Default origin: `https://finra-sec-data-visualizer-canvas.vercel.app`

### API queries

Paste allowlisted URLs into chat; the agent uses `fetch_url`. Built-in hosts include the live visualizer, BrokerCheck, and AdviserInfo.

Example: `https://finra-sec-data-visualizer-canvas.vercel.app/api/finra/health`

### Canvas share

Canvas state lives in the browser on the live app origin, so this tool cannot read it silently.

1. **Connect live graph** — opens/reuses a window to the live app; with the graph loaded, **Refresh canvas** requests a snapshot via `postMessage` (needs the FINRA app build that accepts `localhost:3333`).
2. **Paste snapshot** — on the live graph, use **Copy canvas**, then **Paste snapshot** here and Apply.
3. Check **Question about node graph** so the agent calls `inspect_canvas_graph`.

## Env

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Ollama base URL (default `http://127.0.0.1:11434`) |
| `ALLOW_LOCAL_AI` | Set `1` to allow non-localhost access |
| `RESEARCH_FETCH_HOSTS` | Extra comma-separated hosts for `fetch_url` |
| `RESEARCH_OPEN_FETCH` | Set `1` to allow any public https host (private IPs still blocked) |
| `NEXT_PUBLIC_FINRA_APP_ORIGIN` | Live visualizer origin for Connect + postMessage |

## API

- `GET /api/status` — Ollama reachability + free local models
- `POST /api/chat` — `{ question, model?, history?, availableModels?, aboutNodeGraph?, canvasSnapshot? }`

## Notes

- Cloud Ollama tags (`*:cloud`) are filtered out of the picker.
- Skip paid cloud models; this app is meant for free local models.
- No dependency on a local FINRA dev server (`:4444`).
