# AI Research Tool

Standalone local research assistant extracted from the Local AI stack in `finra-sec-data-visualizer-canvas`.

It keeps:

- Ollama chat UI
- Adaptive auto model routing (single specialist or tools/fetch + reason → merge)
- Tool calling (`fetch_url`, `current_time`, `inspect_canvas_graph`, `search_knowledge`)
- Live FINRA app API fetch (Vercel host allowlisted)
- Canvas snapshot attach from the live graph (postMessage window or pasted JSON)
- Localhost-only guard by default

Redis/firm-roster specialist tools stay in the FINRA app’s `/local-ai` page.

## Quick start

1. **Node.js ≥ 22.13** (uses built-in `node:sqlite` for the knowledge store)
2. Install deps: `pnpm install`
3. Run [Ollama](https://ollama.com) locally and pull a chat model, e.g. `ollama pull qwen2.5:7b`
4. Optional for knowledge/RAG: `ollama pull nomic-embed-text`
5. Start the app: `pnpm dev` (http://localhost:3333)
6. Ask questions on the home page

Local knowledge store (SQLite under `.data/knowledge/`): project picker + notes browser; **Remember answers** / **Save fetches** / **Auto-retrieve** toggles (off by default); optional “Save N fetches?” toast; **Reindex** when the embed model changes; agent `search_knowledge`. Design: [`docs/knowledge-store-design.md`](docs/knowledge-store-design.md). Smoke: `pnpm knowledge:smoke`.

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
| `RESEARCH_DATA_DIR` | Absolute or relative knowledge store root (default `.data/knowledge`) |
| `RESEARCH_EMBED_MODEL` | Ollama embed model (default `nomic-embed-text`) |
| `RESEARCH_EMBED_CONCURRENCY` | Parallel embeds during ingest (default `4`) |
| `RESEARCH_KNOWLEDGE_REMOTE` | With `ALLOW_LOCAL_AI=1`, expose `/api/knowledge` off loopback (**dangerous**) |
| `RESEARCH_RAG_AUTO` | Set `1` to auto-inject knowledge snippets into every chat (default off) |
| `RESEARCH_RAG_TOP_K` | Snippet count for auto-retrieve (default `4`) |

## API

- `GET /api/status` — Ollama reachability + free local models + knowledge summary (path/counts on loopback only)
- `POST /api/chat` — `{ question, model?, history?, availableModels?, aboutNodeGraph?, canvasSnapshot?, projectId?, persistChat?, persistFetches?, ragAuto? }`
  - `persistChat` / `persistFetches` default **off**; when on, ingest runs after the response via `after()` (does not fail the chat)
  - `ragAuto` overrides `RESEARCH_RAG_AUTO` for that request
- `GET/POST /api/knowledge/projects` — list / create projects
- `PATCH/DELETE /api/knowledge/projects/[id]` — rename / delete project (cannot delete the last one)
- `GET/POST /api/knowledge` — list docs (`?projectId=`) / create note `{ projectId, text, title? }`
- `GET/DELETE /api/knowledge/[id]` — get / delete document
- `POST /api/knowledge/search` — `{ projectId, query, limit?, sourceType? }`
- `POST /api/knowledge/chat` — per-turn save `{ projectId, question, answer, toolTrace? }`
- `POST /api/knowledge/fetches` — save fetch bodies from `{ projectId, toolTrace }` (toast confirm)
- `POST /api/knowledge/reindex` — re-embed chunks `{ projectId? }` (omit for all)

Knowledge routes are **localhost-only** unless both `RESEARCH_KNOWLEDGE_REMOTE=1` and `ALLOW_LOCAL_AI=1`. Wipe store: delete the folder shown in `status.knowledge.path` (default `.data/knowledge/`).

## Notes

- Cloud Ollama tags (`*:cloud`) are filtered out of the picker.
- Skip paid cloud models; this app is meant for free local models.
- No dependency on a local FINRA dev server (`:4444`).
