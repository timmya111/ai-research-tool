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

## Bryan County real-time monitor

Logs new filings from [okcountyrecords.com/real-time/bryan](https://okcountyrecords.com/real-time/bryan) into the knowledge project **Bryan County**, including **detail-page** fields (grantor, grantee, book, pages, fees, legal).

Detail/feed HTML parsers are adapted from [ok-bryan-county-notify](https://github.com/timmya111/ok-bryan-county-notify). Pages are fetched through **FlareSolverr** (Docker) so Cloudflare is solved without a desktop browser/login window.

```bash
docker run -d --name flaresolverr -p 8191:8191 --restart unless-stopped \
  --dns 8.8.8.8 --dns 1.1.1.1 \
  ghcr.io/flaresolverr/flaresolverr:latest
pnpm add -D jsdom   # if needed
pnpm dev            # app must be on :3333
BRYAN_MONITOR_ONCE=1 pnpm bryan:monitor   # one poll
pnpm bryan:monitor                        # every 60s (default)
```

If FlareSolverr starts failing with `ERR_NAME_NOT_RESOLVED`, recreate the container with the `--dns` flags above (`docker rm -f flaresolverr` then re-run).

| Env | Default | Purpose |
| --- | --- | --- |
| `RESEARCH_APP_URL` | `http://127.0.0.1:3333` | Knowledge ingest target |
| `FLARESOLVERR_URL` | `http://127.0.0.1:8191` | FlareSolverr base URL |
| `BRYAN_MONITOR_INTERVAL_MS` | `60000` | Poll interval |
| `BRYAN_MONITOR_ONCE` | `0` | Set `1` for a single poll |
| `BRYAN_MONITOR_DETAIL_LIMIT` | `5` | Max new detail pages per poll |

Seen IDs live in `.data/monitors/bryan-seen.json`. Ask the research tool (project **Bryan County**, Auto-retrieve on) about new MTGs, grantors, etc.

### 2026 YTD historical backfill

Search result pages already include grantor/grantee/legal/book. Paginate and ingest:

```bash
# resumes from .data/monitors/bryan-2026-backfill.json
pnpm bryan:backfill:2026
BRYAN_BACKFILL_MAX_PAGES=5 pnpm bryan:backfill:2026   # smoke
BRYAN_BACKFILL_START=2026-01-01 BRYAN_BACKFILL_END=2026-11-16 pnpm bryan:backfill:2026
```

~9.6k Bryan filings in 2026 YTD (~642 pages × 15). Progress checkpoint: `.data/monitors/bryan-2026-backfill.json`.

Ingest API: `POST /api/monitors/bryan/ingest` with `{ filings: BryanFilingDetail[] }`.

### Instrument / document type glossary

OKCountyRecords stores a short **instrument-type code** on each filing (often truncated in their UI). The research app keeps that code in each Bryan knowledge note as `Type: …`.

**Naming patterns**

| Pattern | Meaning |
| --- | --- |
| `REL …` | Release of the thing that follows (lien/mortgage cleared) |
| `ASSN` / `ASSGMENT` | Assignment (transfer of rights in an existing instrument) |
| `AMEND` / `MOD` | Amendment or modification |
| `…-CORR` / `CORR …` | Corrected re-recording of a prior instrument |
| `AFF` / `AFFI` | Affidavit |
| `2ND` / `3RD` | Second / third of that instrument class |

**Core types you asked about**

| Code | Definition |
| --- | --- |
| **MTG** | **Mortgage** — lien securing a loan against real property (borrower typically grantor; lender grantee). |
| **WD** | **Warranty deed** — deed transferring ownership with warranties of clear title. |
| **REL MTG** | **Release of mortgage** — lender releases the mortgage lien after payoff (or partial release context). |
| **UCC** | **Uniform Commercial Code financing statement** — personal-property / fixture security-interest filing (UCC-1 style), not a land deed. |

**Complete codes seen in the Bryan County 2026 knowledge store**

Counts are approximate from the local project at glossary authoring time (~9.4k docs, 172 distinct codes). Definitions are the conventional Oklahoma / real-property expansions for these OKCR abbreviations (OKCR’s own dropdown often shows only the truncated code).

| Code | ~Count | Definition |
| --- | ---: | --- |
| `2ND MTG` | 1 | Second mortgage |
| `ADD CHAN` | 3 | Addendum / change (to a prior instrument) |
| `ADMIN DEED` | 2 | Administrator’s deed (estate conveyance) |
| `AFF HEIRSHIP` | 115 | Affidavit of heirship |
| `AFF J T CORRECT` | 3 | Corrected affidavit of joint tenancy |
| `AFF SUCC TRUSTE` | 10 | Affidavit of successor trustee |
| `AFF.JT` | 162 | Affidavit of joint tenancy |
| `AFFI FOR TODD` | 30 | Affidavit for transfer-on-death deed (TODD) |
| `AFFI OF IDENTIT` | 12 | Affidavit of identity |
| `AFFI OF MARITAL` | 2 | Affidavit of marital status |
| `AFFI OF MARKETA` | 82 | Affidavit of marketable title |
| `AFFI OF NAME CH` | 3 | Affidavit of name change |
| `AFFI OF SCRIVEN` | 5 | Scrivener’s affidavit (clerical correction) |
| `AFFI OF TRUST` | 1 | Affidavit of trust |
| `AFFI TERM LIFE` | 3 | Affidavit terminating life estate |
| `AFFID` | 90 | Affidavit (generic) |
| `AGREE` | 41 | Agreement |
| `ALLT PAT` | 3 | Allotment / patent (land patent related) |
| `AMEND AGREEMENT` | 3 | Amended agreement |
| `AMEND COVENANTS` | 4 | Amended covenants / restrictions |
| `AMEND MEMO TRUS` | 2 | Amended memorandum of trust |
| `AMEND PHY LN` | 1 | Amended physicians / physical lien |
| `AMEND RESTRICTI` | 1 | Amended restrictions |
| `AMEND TO MORTGA` | 1 | Amendment to mortgage |
| `AMEND UCC` | 1 | UCC amendment |
| `AMENDED MTG` | 2 | Amended mortgage |
| `AMENDED NOTI` | 1 | Amended notice |
| `APPT OF TRUSTEE` | 1 | Appointment of trustee |
| `ASSGMENT` | 148 | Assignment |
| `ASSN CORR` | 8 | Corrected assignment |
| `ASSN MTG` | 124 | Assignment of mortgage |
| `ASSN OF LEASE` | 36 | Assignment of lease |
| `ASSN REN` | 108 | Assignment of rents |
| `ASSN REN CORR` | 1 | Corrected assignment of rents |
| `ASSUMPTION AGRE` | 1 | Assumption agreement |
| `BOND` | 1 | Bond |
| `CERT OF TRUST` | 7 | Certificate of trust |
| `CERT SUCC TRUST` | 2 | Certificate of successor trustee |
| `CERTIFIC` | 1 | Certificate (generic) |
| `CON DEED` | 3 | Conservator’s deed / condominium deed (context-dependent; often conservator) |
| `CONTRACT` | 2 | Contract |
| `CONVEY` | 1 | Conveyance |
| `CONVEYAN` | 1 | Conveyance |
| `CORR AFFIDAVIT` | 4 | Corrected affidavit |
| `CORR DEED` | 8 | Corrected deed |
| `CORR LIEN` | 1 | Corrected lien |
| `CORR MEMO TRUST` | 1 | Corrected memorandum of trust |
| `COUNTY DEED` | 1 | County deed |
| `COVENANT` | 3 | Covenant |
| `DECLARAT` | 1 | Declaration |
| `DECREE` | 4 | Decree (court) |
| `DEED` | 88 | Deed (generic) |
| `DEED IN LIEU OF` | 1 | Deed in lieu of foreclosure |
| `DEED OF TRUST` | 4 | Deed of trust |
| `DEFAULT JUDG` | 2 | Default judgment |
| `DISCHARGE` | 2 | Discharge |
| `DISMISAL` | 3 | Dismissal |
| `DISTRIBUTE DEED` | 1 | Distribution deed (estate) |
| `DIVORCE` | 14 | Divorce decree / related filing |
| `EASE` | 145 | Easement |
| `EASE-CORR` | 3 | Corrected easement |
| `EASEMENT/NC` | 2 | Easement (non-certified / NC series) |
| `FEDERAL LIEN` | 9 | Federal tax / federal lien |
| `Fict Names` | 19 | Fictitious name filing |
| `GIFT DEED` | 1 | Gift deed |
| `IRS LIEN` | 2 | IRS tax lien |
| `J.ENTRY` | 21 | Journal entry (court) |
| `JUDG` | 328 | Judgment |
| `JUDGE-NF` | 14 | Judgment (non-final / related court judgment code) |
| `LEASE` | 9 | Lease |
| `LIEN` | 35 | Lien (generic) |
| `LIEN REL` | 17 | Lien release |
| `LIS PEND` | 25 | Lis pendens (notice of pending lawsuit affecting title) |
| `MD` | 91 | Mineral deed |
| `MD CORR` | 2 | Corrected mineral deed |
| `MEC LIEN` | 13 | Mechanics’ / materialmen’s lien |
| `MEMO` | 24 | Memorandum |
| `MEMO LEASE AGRE` | 2 | Memorandum of lease agreement |
| `MEMO OF LEAS` | 12 | Memorandum of lease |
| `MEMO OF SUC TRU` | 2 | Memorandum of successor trustee |
| `MEMO TRU` | 61 | Memorandum of trust |
| `MEMO TRUST AMEN` | 1 | Amended memorandum of trust |
| `MERGER` | 1 | Merger |
| `MIN CONVEY` | 18 | Mineral conveyance |
| `MOD AGRE` | 16 | Modification agreement |
| `MOD DEED OF TRU` | 1 | Modification of deed of trust |
| `MOD MTG.` | 143 | Modification of mortgage |
| `MTG` | 1279 | **Mortgage** |
| `MTG DEED` | 1 | Mortgage deed |
| `MTG-CORR` | 16 | Corrected mortgage |
| `NOTICE` | 56 | Notice |
| `NOTICE OF DECRE` | 3 | Notice of decree |
| `NOTICE OF FRAUDULENT CONVEYANCE` | 1 | Notice of fraudulent conveyance |
| `OGL LEAS` | 458 | Oil & gas lease |
| `OGL-CORR` | 2 | Corrected oil & gas lease |
| `OPTION` | 3 | Option |
| `ORDER` | 102 | Court / administrative order |
| `ORDER AMENDED` | 5 | Amended order |
| `ORDER NUNC P` | 4 | Order nunc pro tunc |
| `ORDIANCE` | 23 | Ordinance |
| `PAR ASSN` | 1 | Partial assignment |
| `PAR REL` | 79 | Partial release |
| `PAR REL CORR` | 2 | Corrected partial release |
| `PER REP DEED` | 21 | Personal representative’s deed |
| `PHY LIEN` | 89 | Physicians lien (medical lien against recovery / property interest) |
| `PLAT` | 14 | Plat (subdivision map) |
| `POW ATTY` | 56 | Power of attorney |
| `QCD` | 423 | **Quitclaim deed** — transfers interest with few/no title warranties |
| `QCD-CORR` | 30 | Corrected quitclaim deed |
| `QCMD` | 59 | Quitclaim mineral deed |
| `QCMD-CORR` | 1 | Corrected quitclaim mineral deed |
| `QUIET TI` | 1 | Quiet title |
| `R-OF-W` | 71 | Right-of-way |
| `RATIF OGL` | 13 | Ratification of oil & gas lease |
| `RATIFIC` | 9 | Ratification |
| `RECONVEY` | 7 | Reconveyance |
| `REL` | 248 | Release (generic) |
| `REL AMEND MORT` | 5 | Release of amended mortgage |
| `REL EASE` | 2 | Release of easement |
| `REL JUDGE NC` | 5 | Release of judgment (NC series) |
| `REL JUDJ` | 103 | Release of judgment |
| `REL LIS PEND` | 23 | Release of lis pendens |
| `REL MTG` | 935 | **Release of mortgage** |
| `REL MTG CORR` | 2 | Corrected release of mortgage |
| `REL PHY LIEN` | 62 | Release of physicians lien |
| `REL TAX WARR` | 631 | Release of tax warrant |
| `RENEWAL` | 138 | Renewal |
| `RENEWAL / NC` | 4 | Renewal (NC series) |
| `RENEWED NOTICE` | 1 | Renewed notice |
| `RES CONV` | 2 | Restrictive covenant / reservation conveyance (context-dependent) |
| `RESALE DEED` | 13 | Resale deed (often tax-resale) |
| `RESIGNATION TRU` | 1 | Resignation of trustee |
| `RESOLUT` | 3 | Resolution |
| `RESTRICT` | 1 | Restrictions |
| `REV POA` | 3 | Revocation of power of attorney |
| `REV TODD` | 1 | Revocation of transfer-on-death deed |
| `REVOC` | 1 | Revocation |
| `REVOC OF TODD` | 10 | Revocation of transfer-on-death deed |
| `SAME NAME AFFID` | 1 | Same-name affidavit |
| `SATISFACTION` | 18 | Satisfaction (of mortgage/lien) |
| `SCRIVENERS AFFI` | 3 | Scrivener’s affidavit |
| `SHERF D` | 17 | Sheriff’s deed |
| `SHERR DEED CORR` | 2 | Corrected sheriff’s deed |
| `STATMENT` | 1 | Statement |
| `STIP INT` | 1 | Stipulation of interest |
| `SUB AGRE` | 6 | Subordination agreement |
| `SUB MTG` | 5 | Subordination of mortgage / subordinate mortgage |
| `TAX WAR` | 756 | Tax warrant |
| `TERM` | 2 | Termination |
| `TERM LE` | 1 | Termination of lease |
| `TR D DEED` | 126 | Trustee’s deed |
| `TR D DEED CORR` | 6 | Corrected trustee’s deed |
| `TR DEATH MD` | 1 | Transfer-on-death mineral deed |
| `TREAS TRANSCRIP` | 1 | Treasurer’s transcript |
| `TRUSTEE DEED` | 20 | Trustee’s deed |
| `TRUSTEE QCMD` | 1 | Trustee quitclaim mineral deed |
| `TRUSTEES MD` | 1 | Trustee’s mineral deed |
| `UCC` | 68 | **UCC financing statement** |
| `UCC AMEND` | 20 | UCC amendment |
| `UCC ASSN` | 5 | UCC assignment |
| `UCC CORR` | 1 | Corrected UCC |
| `UCC REL` | 19 | UCC release / termination-related release |
| `UCC-CONT` | 6 | UCC continuation |
| `UNEMP TW` | 2 | Unemployment tax warrant / related tax warrant code |
| `UNKNOWN` | 5 | Type missing / unparsed in stored note |
| `VACATIO` | 1 | Vacation (e.g. of plat/easement/street) |
| `WAIVER L` | 1 | Waiver of lien |
| `WAVIER OF INTER` | 4 | Waiver of interest |
| `WD` | 1090 | **Warranty deed** |
| `WD AMENDED` | 1 | Amended warranty deed |
| `WD-CORR` | 27 | Corrected warranty deed |
| `WITHDRAW` | 11 | Withdrawal |

OKCountyRecords’ Bryan search UI lists **~455** instrument-type codes site-wide; only codes that appear in ingested filings are listed above. Truncated labels (e.g. `AFFI OF IDENTIT`) are shown exactly as stored.

## Notes

- Cloud Ollama tags (`*:cloud`) are filtered out of the picker.
- Skip paid cloud models; this app is meant for free local models.
- No dependency on a local FINRA dev server (`:4444`).
