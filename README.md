# AI Research Tool

Local research workspace (port **3333**) for turning news, filings, and web sources into structured **entity profiles**—people, firms, governments, nonprofits, historic events—with timelines, locations, identifiers, and linked relationships.

**Build profiles automatically** from news events and other material by:

- **AI Chat** — paste an article, RSS digest, press release, or filing excerpt and ask the model to create or update profiles (`search_profiles` / `upsert_profile`). The agent extracts names, dates, roles, addresses, and links them into the Profiles store.
- **Profiles dashboard** — browse and edit the same entities at `/profiles` (Overview, Timeline, Connections, Locations). Seed from imported news topics, land deeds, or bulk scripts, then refine in the UI.

Under the hood: Ollama chat, a local SQLite knowledge store (RAG), Profiles SQLite, and download/ingest pipelines for Oklahoma / Texas public records and related corpora (all under `.data/`).

### Profiles dashboard

![Profiles overview — firm card with aliases, HQ, identifiers, and summary](docs/images/profiles-overview.jpg)

![Profiles timeline — career chapters, nested employment, and disclosure events](docs/images/profiles-timeline.jpg)

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 22.13** | Uses built-in `node:sqlite` |
| **pnpm** | `packageManager` is `pnpm@11.3.0` |
| **[Ollama](https://ollama.com)** | Local chat + embeddings |
| **Docker** (optional) | FlareSolverr for OKCountyRecords / Cloudflare pages |
| **Python 3 + [uv](https://github.com/astral-sh/uv)** (optional) | Research Drive OCR, Digital Earth / PQW / META25 / Physics Congress crawlers |
| **Playwright** (optional) | Dallas deeds, some authority scrapers (`pnpm exec playwright install`) |

---

## Quick start (chat only)

```bash
pnpm install
ollama pull ornith:latest          # or another chat model in the picker
ollama pull nomic-embed-text       # optional; needed for knowledge embeddings / RAG
cp .env.example .env.local         # edit if needed
pnpm dev                           # http://localhost:3333
```

- **Chat** (`/`) — ask questions or paste news/filings and request profile upserts  
- **Profiles** (`/profiles`) — browse Overview + Timeline cards (screenshots above)

Smoke the knowledge store: `pnpm knowledge:smoke`.

---

## First-time setup checklist

1. Install Node deps: `pnpm install`
2. Start Ollama and pull at least one chat model (+ `nomic-embed-text` for RAG)
3. Copy `.env.example` → `.env.local` (defaults are fine for loopback-only use)
4. Start the app: `pnpm dev` (must be on **:3333** for most ingest scripts)
5. For Oklahoma land records / Yahoo enrich: start **FlareSolverr** (below)
6. Download only the corpora you need (tables below), then ingest while the app is running
7. In the UI: pick the matching knowledge **project**, turn on **Auto-retrieve** when asking about that corpus

### FlareSolverr (OKCR / Cloudflare)

```bash
docker run -d --name flaresolverr -p 8191:8191 --restart unless-stopped \
  --dns 8.8.8.8 --dns 1.1.1.1 \
  ghcr.io/flaresolverr/flaresolverr:latest
```

Health: `curl -fsS http://127.0.0.1:8191/health`. If DNS breaks (`ERR_NAME_NOT_RESOLVED`), recreate with the `--dns` flags above.

### Python venv (OCR + site corpora)

```bash
pnpm bryan:monitor:setup
# installs into .venv-monitors from scripts/requirements-bryan.txt
# later: uv pip install --python .venv-monitors/bin/python <pkg>
```

---

## External data: download & ingest

**Pattern:** most pipelines write files under `.data/<name>/`, then POST into the knowledge store via the running app on `:3333`. Agent tools (`search_*`) read those projects or `.data` folders.

Unless noted, run **download/crawl first**, then **ingest** with `pnpm dev` already up.

### Recommended starter set

| Goal | Commands | Knowledge project / path |
| --- | --- | --- |
| Bryan County deeds (live) | FlareSolverr + `BRYAN_MONITOR_ONCE=1 pnpm bryan:monitor` | **Bryan County** |
| OK / TX earthquakes | `pnpm seismic:download && pnpm seismic:ingest` | **OK TX Seismic** → `.data/seismic/` |
| OK / TX tornadoes | `pnpm tornado:download && pnpm tornado:ingest` | **OK TX Tornadoes** → `.data/tornadoes/` |
| Profiles seed (optional) | `pnpm profiles:backfill` | Profiles SQLite → `.data/profiles/` |

### Oklahoma County Records (OKCR)

Requires FlareSolverr + app on `:3333`. Results-table scrapes include grantor/grantee/legal/book (legal may show `N more…` until enriched from the detail page).

| Script | Purpose |
| --- | --- |
| `pnpm bryan:monitor` | Real-time Bryan poll (detail pages) |
| `pnpm bryan:backfill:2026` | Bryan 2026 YTD search pages |
| `pnpm bryan:backfill:2016-current` | Bryan historical range |
| `pnpm okcr:backfill:county` | Single county (`OKCR_SITE=…`, date range env) |
| `pnpm okcr:backfill:east-i35` | East-of-I-35 county orchestrator |
| `pnpm okcr:backfill:rest-ok` | Rest-of-OK orchestrator |
| `pnpm okcr:enrich-legals` | Expand truncated `N more…` legals from detail pages (`PROFILE_SLUG=firm:…`) |
| `pnpm profiles:associate-deeds` | Link OKCR instruments to firm/person profiles |

Checkpoints: `.data/monitors/{site}-backfill-*.json`, `bryan-seen.json`.  
Ingest API: `POST /api/monitors/bryan/ingest` with `{ filings: [...] , projectName? }`.  
Instrument codes: [`docs/okcr-instrument-glossary.md`](docs/okcr-instrument-glossary.md).

Useful env: `RESEARCH_APP_URL`, `FLARESOLVERR_URL`, `OKCR_SITES`, `OKCR_FROM_SITE`, `OKCR_FROM_YEAR`, `BRYAN_BACKFILL_START`, `BRYAN_BACKFILL_END`, `BRYAN_BACKFILL_MAX_PAGES`.

### Dallas County deeds (TX publicsearch)

```bash
pnpm dallas:download    # → .data/dallas-deeds/  (Playwright)
pnpm dallas:ingest      # → knowledge project "Dallas County Deeds"
```

### Seismic & tornadoes

```bash
pnpm seismic:download && pnpm seismic:ingest   # USGS ComCat M≥2.5 since 2016, OK+TX
pnpm tornado:download && pnpm tornado:ingest   # SPC tracks + NCEI narratives since 2016
```

### Authority timelines & entity dossiers

```bash
pnpm authority:download      # ICE / CBP / DHS / WH / etc. → .data/authority-timelines/
pnpm authority:dea           # DEA via Playwright when needed
pnpm authority:aggregate
pnpm authority:ingest        # knowledge project "Authority Initiatives"

pnpm entities:seed && pnpm entities:enrich && pnpm entities:link
pnpm entities:digest && pnpm entities:ingest   # "Entity Dossiers"
```

### Research Drive (local folder mirror)

Stage files under `.data/research-drive/` (manual sync; Drive folder is auth-walled).

```bash
pnpm research-drive:ocr          # digests → .data/research-drive/ocr/
pnpm research-drive:ocr:once     # smoke (--limit 5)
pnpm research-drive:ingest       # knowledge project "Research Drive"
pnpm research-drive:translate-thai
```

Serve a single file in-app: `GET /api/research-drive/file?path=…`.

### TWDB Trinity Aquifer

```bash
pnpm twdb:trinity                # download + organize + ingest
pnpm twdb:trinity:restructure    # layout only
pnpm twdb:trinity:ingest         # ingest only → searchable via search_twdb_trinity
```

### Site corpora (Python crawlers)

Use `.venv-monitors` (see setup above). Typical flags: `--crawl-only` / `--pages-only`, `--assets-only`, `--videos-only`, `--ingest-only`.

| Corpus | Commands | Data dir |
| --- | --- | --- |
| Digital Earth / ISDE | `pnpm digitalearth:crawl` … `pnpm digitalearth:all` / `:ingest` | `.data/digitalearth-isde/` |
| Petersburg Quantum Weeks | `pnpm pqw:pages` … `pnpm pqw:all` / `:ingest` | `.data/pqw-itmo/` |
| META 2025 | `pnpm meta25:crawl` … `pnpm meta25:all` / `:ingest` | `.data/meta25/` |
| Physics Congress 2026 | `pnpm physics-congress:pages` … `:all` / `:ingest` | `.data/physics-congress/` |
| Photonic quantum | `pnpm photonic-quantum:ingest` | (ingest helper) |
| IWM conflict timeline | `pnpm iwm:build` / `pnpm iwm:crawl` | `.data/iwm-conflict-timeline/` |
| Regional history | `pnpm regional:build` | `.data/regional-history/` |

### News RSS

```bash
pnpm news:rss                    # one pass
pnpm news:rss:loop               # long-running
pnpm news:rss:backfill-full
pnpm news:rss:consolidate
pnpm news:rss:format
pnpm news:rss:tx-ok-crime        # TX/OK crime feed catalog
pnpm tx-ok-crime:ingest
```

### YouTube / concealment scrubs & questions playlist

Scrub artifacts live under `.data/concealment-scrubs/`. MindUnveiled OCR: `pnpm mu:ocr` / `pnpm mu:ocr:once`.

```bash
pnpm questions:monitor:seed      # mark current playlist IDs seen
pnpm questions:monitor:once      # one daily check
pnpm questions:monitor           # 24h loop
```

### Offline Wikipedia (Kiwix)

```bash
# After a ZIM exists under .data/wikipedia/ (large download; see run_wikipedia_zim_download.sh)
pnpm wikipedia:serve             # kiwix-serve on :8765
```

Agent tool: `search_wikipedia`. Env: `KIWIX_SERVE_ORIGIN` / `RESEARCH_KIWIX_ORIGIN` (default `http://127.0.0.1:8765`).

### Chat history imports

```bash
pnpm grok-qa:import              # → knowledge "Grok Q&A"
pnpm gemini-qa:import            # → knowledge "Gemini Q&A"
```

### Profiles from news (chat or dashboard)

1. Ingest news into knowledge (`pnpm news:rss`, topic consolidate/format, or paste text in chat).
2. In **AI Chat**, select the news project (optional Auto-retrieve) and ask to create profiles for named people/orgs, or paste the article and say “upsert profiles with employment dates and HQ.”
3. Open **Profiles** to review Overview (aliases, identifiers, summary) and Timeline (career chapters, events). Edit links, locations, and timeline rows in the dashboard as needed.

### Profiles bulk imports

Many one-shot seeders exist as `pnpm profiles:import-*` (hospitals, oil companies, nonprofits, cabinets, dynasties, etc.). Enrichment:

```bash
pnpm profiles:backfill
pnpm profiles:enrich
pnpm profiles:align
pnpm profiles:associate-deeds
pnpm profiles:download-free-org-bulk
pnpm profiles:backfill-org-free-enrich
pnpm sec:ciks-since-2016
pnpm firm:id-filter
```

Land deeds on a profile overview: `GET/POST /api/profiles/{id|slug}/land-deeds`.

---

## HTTP API (built-in)

Base URL: `http://127.0.0.1:3333`. Knowledge and most write routes are **localhost-only** unless `ALLOW_LOCAL_AI=1` and (for knowledge) `RESEARCH_KNOWLEDGE_REMOTE=1`.

### Status & chat

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Ollama reachability, models, knowledge summary |
| `POST` | `/api/chat` | Research chat `{ question, model?, history?, projectId?, persistChat?, persistFetches?, ragAuto?, aboutNodeGraph?, canvasSnapshot? }` |
| `GET` `PUT` `DELETE` | `/api/chat/session` | Chat session persistence |

### Knowledge store

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/api/knowledge/projects` | List / create projects |
| `PATCH` `DELETE` | `/api/knowledge/projects/[id]` | Rename / delete |
| `GET` `POST` | `/api/knowledge` | List docs (`?projectId=`) / create note |
| `GET` `DELETE` | `/api/knowledge/[id]` | Get / delete document |
| `POST` | `/api/knowledge/search` | `{ projectId, query, limit?, sourceType? }` |
| `POST` | `/api/knowledge/chat` | Persist Q&A turn |
| `POST` | `/api/knowledge/fetches` | Persist fetch_url bodies from toolTrace |
| `POST` | `/api/knowledge/attachments` | Attach files into knowledge |
| `POST` | `/api/knowledge/reindex` | Re-embed `{ projectId? }` |

Wipe store: delete the folder from `GET /api/status` → `knowledge.path` (default `.data/knowledge/`).

### Monitors & charts

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/monitors/bryan/ingest` | Batch-ingest OKCR filings into a knowledge project |
| `POST` | `/api/charts` | Create chart artifact |
| `GET` | `/api/charts/[id]` | Serve chart image (PNG default) |

### Profiles

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/api/profiles` | Search / create profiles (`?q=`) |
| `GET` `PATCH` `DELETE` | `/api/profiles/[id]` | Detail by id or slug (e.g. `firm:bok-financial-corporation`) |
| `GET` `POST` | `/api/profiles/[id]/timeline` | Timeline entries |
| `POST` | `/api/profiles/[id]/employment` | Employment spans |
| `GET` | `/api/profiles/[id]/disclosures` | FINRA disclosure panel data |
| `POST` | `/api/profiles/[id]/enrich` | Enrich one profile |
| `POST` | `/api/profiles/[id]/finra-dates` | Backfill FINRA employment dates |
| `GET` `POST` | `/api/profiles/[id]/land-deeds` | Preview / write `## Land Deeds` from OKCR |
| `GET` `POST` | `/api/profiles/[id]/legal-docs` | Legal-doc corpus for a profile |
| `GET` | `/api/profiles/[id]/nearby` | Nearby entities / locations |
| `POST` `PATCH` `DELETE` | `/api/profiles/links` | Connected-profile links |
| `GET` `PATCH` | `/api/profiles/alignments` | Alignment evidence |
| `POST` | `/api/profiles/enrich` | Bulk enrich |
| `GET` `POST` | `/api/profiles/finra-sync` | FINRA sync helpers |
| `POST` | `/api/profiles/merge` | Merge duplicate profiles |
| `POST` | `/api/profiles/sync` | Sync connections / summary helpers |
| `POST` | `/api/profiles/resolve-historic-events` | Resolve historic_event peers |

### Research Drive files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/research-drive/file` | Stream a file under `.data/research-drive/` |

---

## Agent tools (chat)

The model can call tools such as: `fetch_url`, `current_time`, `search_knowledge`, `search_profiles`, `upsert_profile`, `search_finra_sidecar`, `lookup_brokercheck`, `lookup_firm_connections`, `inspect_canvas_graph`, `chart_filings`, `make_logo`, `search_authority_timelines`, `search_entity_dossiers`, `search_concealment_scrubs`, `search_wikipedia`, `search_twdb_trinity`, `search_digital_earth`, `search_pqw_itmo`, `search_meta25`, `search_physics_congress`, `search_cdc_covid_timeline`, `search_dod_covid_timeline`, `search_iwm_conflict_timeline`, `search_regional_history`, `search_gemini_qa`.

Design notes: [`docs/knowledge-store-design.md`](docs/knowledge-store-design.md), [`docs/entity-alignment-design.md`](docs/entity-alignment-design.md).

---

## UI routes

| Path | Purpose |
| --- | --- |
| `/` | Research chat + knowledge panel |
| `/profiles` | Entity profiles browser |
| `/profiles/firm/<slug>` | Firm profile (slug without `firm:` prefix in path) |
| `/profiles/person/<slug>` | Person profile |

---

## Environment variables

See `.env.example` for the full list. Common ones:

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Default `http://127.0.0.1:11434` |
| `RESEARCH_OLLAMA_NUM_CTX` | Chat/tools context (default `32768`) |
| `RESEARCH_TOOL_RESULT_MAX_CHARS` | Cap tool JSON fed to the model (default `8000`) |
| `RESEARCH_FACTCHECK` | `bespoke-minicheck` post-check (`1`/`0`) |
| `ALLOW_LOCAL_AI` | Allow non-localhost access when `1` |
| `RESEARCH_FETCH_HOSTS` | Extra `fetch_url` hosts |
| `RESEARCH_OPEN_FETCH` | `1` = any public HTTPS host (default on); private IPs still blocked |
| `NEXT_PUBLIC_FINRA_APP_ORIGIN` | Live FINRA visualizer origin |
| `RESEARCH_DATA_DIR` | Knowledge root (default `.data/knowledge`) |
| `RESEARCH_EMBED_MODEL` | Default `nomic-embed-text` |
| `RESEARCH_RAG_AUTO` / `RESEARCH_RAG_TOP_K` | Auto-inject knowledge into chat |
| `RESEARCH_KNOWLEDGE_REMOTE` | Expose `/api/knowledge` off loopback (**dangerous**) |
| `FLARESOLVERR_URL` | Default `http://127.0.0.1:8191` |
| `RESEARCH_APP_URL` | Ingest target for monitors (default `http://127.0.0.1:3333`) |
| `KIWIX_SERVE_ORIGIN` | Offline Wikipedia (default `http://127.0.0.1:8765`) |

---

## Data layout (local)

| Path | Contents |
| --- | --- |
| `.data/knowledge/` | SQLite knowledge store + embeddings |
| `.data/profiles/` | Profiles SQLite |
| `.data/monitors/` | OKCR / Bryan / RSS checkpoints |
| `.data/seismic/`, `.data/tornadoes/`, `.data/dallas-deeds/` | Mirror downloads |
| `.data/authority-timelines/`, `.data/entity-dossiers/` | Authority / dossier corpora |
| `.data/research-drive/` | User research files + OCR digests |
| `.data/concealment-scrubs/` | YouTube scrub outputs |
| `.data/wikipedia/` | Kiwix ZIM files |
| `.data/charts/` | Generated chart images |
| `.data/INVENTORY_2016_current.md` | Local inventory notes |

---

## Notes

- Cloud Ollama tags (`*:cloud`) are filtered out of the picker; prefer free local models.
- OKCR results-table legals can end with `N more…`; enrich with `pnpm okcr:enrich-legals` or open the instrument detail page.
- News RSS digests (`pnpm news:rss*`) land in knowledge projects you can select in chat, then ask the model to promote people/orgs into Profiles.
- Long-running jobs may use wrappers under `~/.grok/long-running-background-tasks/` (optional; not required for a fresh clone).
