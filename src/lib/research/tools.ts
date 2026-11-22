import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createBryanFilingChart, createLogo } from '@/lib/research/charts';
import { inspectCanvasSnapshot, type CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { lookupBrokercheckIndividual } from '@/lib/research/brokercheckLookup';
import { lookupFirmConnections } from '@/lib/research/firmConnectionsLookup';
import { searchAuthorityTimelines } from '@/lib/research/authorityTimelineSearch';
import { searchCdcCovidTimeline } from '@/lib/research/cdcCovidTimelineSearch';
import { searchConcealmentScrubs } from '@/lib/research/concealmentScrubSearch';
import { searchDodCovidTimeline } from '@/lib/research/dodCovidTimelineSearch';
import { searchEntityDossiers } from '@/lib/research/entityDossierSearch';
import { searchGeminiQa } from '@/lib/research/geminiQaSearch';
import { searchFinraSidecar } from '@/lib/research/finraSidecarSearch';
import { searchDigitalEarth } from '@/lib/research/digitalEarthSearch';
import { searchMeta25 } from '@/lib/research/meta25Search';
import { searchPhysicsCongress } from '@/lib/research/physicsCongressSearch';
import { searchPqwItmo } from '@/lib/research/pqwItmoSearch';
import { searchTwdbTrinity } from '@/lib/research/twdbTrinitySearch';
import { searchWikipedia } from '@/lib/research/wikipediaSearch';
import {
	findProfileAlignmentsTool,
	getProfileTimelineTool,
	searchProfilesTool,
} from '@/lib/research/profileAlignmentTools';
import { ensureDefaultProject, listProjects } from '@/lib/research/knowledge/projects';
import { retrieve } from '@/lib/research/knowledge/retrieve';
import type { KnowledgeSourceType } from '@/lib/research/knowledge/types';

export type ResearchToolName =
	| 'fetch_url'
	| 'current_time'
	| 'inspect_canvas_graph'
	| 'search_finra_sidecar'
	| 'lookup_brokercheck'
	| 'lookup_firm_connections'
	| 'search_authority_timelines'
	| 'search_cdc_covid_timeline'
	| 'search_dod_covid_timeline'
	| 'search_gemini_qa'
	| 'search_entity_dossiers'
	| 'search_profiles'
	| 'get_profile_timeline'
	| 'find_profile_alignments'
	| 'search_concealment_scrubs'
	| 'search_twdb_trinity'
	| 'search_digital_earth'
	| 'search_pqw_itmo'
	| 'search_meta25'
	| 'search_physics_congress'
	| 'search_wikipedia'
	| 'search_knowledge'
	| 'chart_filings'
	| 'make_logo';

export type ResearchToolContext = {
	canvasSnapshot?: CanvasSnapshot | null;
	projectId?: string | null;
};

export const RESEARCH_TOOL_DEFINITIONS = [
	{
		type: 'function' as const,
		function: {
			name: 'search_profiles',
			description:
				'Search the unified canonical Entity Profile & Alignment store (.data/profiles/profiles.sqlite) spanning people, firms, universities, non-profits, government agencies, subject matters, and historic events across ALL local corpora (entity dossiers, FINRA rosters, WEF AMNC, CDC/DoD COVID timelines, authority timelines, physics/quantum/metamaterials conferences, TWDB aquifer, USGS seismic, NOAA tornadoes, and county deeds). Pass slug for full dossier with aliases, identifiers, locations, links, and alignments.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keyword, name, alias, CRD, ticker, or topic query' },
					slug: {
						type: 'string',
						description: 'Exact profile id or slug (e.g. subject_matter:covid-19-pandemic-response, firm:halliburton)',
					},
					profileType: {
						type: 'string',
						description:
							'Optional filter: person | firm | university | nonprofit | agency | subject_matter | historic_event | actors | narratives | all',
					},
					corpus: {
						type: 'string',
						description: 'Optional source corpus filter (e.g. wef-amnc, finra-rosters, cdc-covid-timeline, dod-covid-timeline)',
					},
					geo: { type: 'string', description: 'Optional location filter (city, county, state, or country)' },
					status: { type: 'string', description: 'Optional: pinned | active | candidate | archived' },
					limit: { type: 'number', description: 'Max hits (default 15, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'get_profile_timeline',
			description:
				'Retrieve the merged multi-source timeline for any profile (especially a subject_matter or historic_event), grouped by source angle (civilian_health, defense_dod, law_enforcement, land_records, academic_research, geophysical, policy, etc.). Automatically detects chronological timeline gaps and returns cross-source gap-fill leads from other corpora and knowledge.sqlite.',
			parameters: {
				type: 'object',
				properties: {
					profile: {
						type: 'string',
						description: 'Profile id, slug, or name (e.g. subject_matter:covid-19-pandemic-response or "Authority Initiatives")',
					},
					from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
					to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
					angle: {
						type: 'string',
						description:
							'Optional angle filter: civilian_health | defense_dod | regulatory_finra | law_enforcement | land_records | academic_research | geophysical | corporate | policy',
					},
					corpus: { type: 'string', description: 'Optional corpus filter' },
					minGapDays: { type: 'number', description: 'Minimum days to flag a timeline gap (default 30)' },
					detectGaps: { type: 'boolean', description: 'Detect chronological gaps & surface gap-fill leads (default true)' },
					fillFromKnowledge: { type: 'boolean', description: 'Also search knowledge.sqlite for gap-fill leads (default true)' },
					limit: { type: 'number', description: 'Max timeline entries to return (default 35, max 80)' },
				},
				required: ['profile'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'find_profile_alignments',
			description:
				'Query cross-source alignment candidates discovered across all corpora: shared identifiers (CRD/CIK/ticker), alias overlaps, multi-corpus mentions, shared affiliations, geo-temporal co-occurrences, multi-angle overlaps, and county-filing FTS matches from knowledge.sqlite. Results carry caution tiers (observation | closer_look | stronger_indicator) and user triage status (proposed | confirmed | dismissed).',
			parameters: {
				type: 'object',
				properties: {
					profile: { type: 'string', description: 'Optional profile id, slug, or name to scope alignments' },
					kind: {
						type: 'string',
						description:
							'Optional: same_entity_alias | shared_identifier | cross_source_mention | timeline_gap_bridge | co_occurrence_time_geo | shared_affiliation | county_filing_match | angle_comparison',
					},
					status: { type: 'string', description: 'Optional: proposed | confirmed | dismissed' },
					cautionTier: { type: 'string', description: 'Optional: observation | closer_look | stronger_indicator' },
					minScore: { type: 'number', description: 'Optional minimum confidence score 0..1' },
					limit: { type: 'number', description: 'Max hits (default 20, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'chart_filings',
			description:
				'Build a shareable chart image of Bryan County OKCountyRecords filings from the local knowledge store (counts over time or by document type). Default format is PNG for easy online sharing. Use format=jpeg for JPG, or format=svg only when the user wants a vector/logo-style export. Returns an imageUrl to embed as markdown ![title](url).',
			parameters: {
				type: 'object',
				properties: {
					kind: {
						type: 'string',
						description: 'volume (default: counts over time) | by_type (document type breakdown)',
					},
					period: {
						type: 'string',
						description: 'For volume charts: day | week | month (default month)',
					},
					from: {
						type: 'string',
						description: 'Optional start date YYYY-MM-DD or YYYY-MM',
					},
					to: {
						type: 'string',
						description: 'Optional end date YYYY-MM-DD or YYYY-MM',
					},
					docType: {
						type: 'string',
						description: 'Optional instrument filter, e.g. MTG, WD, REL MTG, UCC',
					},
					format: {
						type: 'string',
						description: 'png (default, shareable) | jpeg | svg (vector; prefer make_logo for logos)',
					},
					projectId: {
						type: 'string',
						description:
							'Optional UUID or project name. Prefer omitting this so the active request project is used.',
					},
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'make_logo',
			description:
				'Create a simple wordmark/logo image. Default format is SVG (vector) for logos. Pass format=png or jpeg when the user wants a raster logo to share online. Returns an imageUrl to embed as markdown.',
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Primary logo text / wordmark' },
					subtitle: { type: 'string', description: 'Optional secondary line' },
					format: {
						type: 'string',
						description: 'svg (default for logos) | png | jpeg',
					},
				},
				required: ['text'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_knowledge',
			description:
				'Search the local knowledge store for the active project (saved chats with tool digests, fetched pages, notes). Use for prior Q&A, CRDs, URLs, or notes. Local disk only.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Natural language or keyword query' },
					limit: { type: 'number', description: 'Max hits (default 5, max 12)' },
					sourceType: {
						type: 'string',
						description: 'Optional filter: chat | fetch | note | file | image | any (default any)',
					},
					projectId: {
						type: 'string',
						description: 'Optional; defaults to the active project from the request context',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_finra_sidecar',
			description:
				'Search the production FINRA/SEC visualizer flat-file search index (gzip sidecars via /api/finra/search and /api/finra/sec-search). Use for CRD / person / firm name lookup across the full shipped corpus — not only nodes on the current canvas. Returns identity + current employers only (often empty when Inactive). For full employment / registration history use lookup_brokercheck. Prefer this for FINRA identity; use inspect_canvas_graph only for what is on-screen.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Person/firm name or numeric CRD to look up',
					},
					registry: {
						type: 'string',
						description: 'finra | sec | both (default both)',
					},
					entity: {
						type: 'string',
						description: 'individual | firm | both (default both)',
					},
					limit: {
						type: 'number',
						description: 'Max hits to return (default 8, max 25)',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lookup_brokercheck',
			description:
				'Fetch full BrokerCheck individual detail by numeric CRD: previous + current employment history, exams, disclosure flags, and scopes. Also pulls AdviserInfo when available. Use whenever the user asks for employment history, registration history, firms worked at, exams, or BrokerCheck detail for a CRD. Does NOT require the node-graph checkbox or a canvas snapshot.',
			parameters: {
				type: 'object',
				properties: {
					crd: {
						type: 'string',
						description: 'Numeric CRD, e.g. 1085996',
					},
					includeAdviserInfo: {
						type: 'boolean',
						description: 'Also fetch AdviserInfo SEC IA detail (default true)',
					},
				},
				required: ['crd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lookup_firm_connections',
			description:
				'List all broker/person CRDs connected to a firm from the live FINRA SEC visualizer API (/api/finra/firm/{id}/connections). Use for firm roster / connections / “who works at” / “all CRD connections for firm X” questions. Does NOT require opening the live graph or checking “Question about node graph”. Returns totals plus a page of Name :: CRD# rows; full roster is also saved under .data/finra-rosters/.',
			parameters: {
				type: 'object',
				properties: {
					firmCrd: {
						type: 'string',
						description: 'Numeric firm CRD, e.g. 291361',
					},
					bucket: {
						type: 'string',
						description: 'current | previous | all (default all)',
					},
					limit: {
						type: 'number',
						description: 'Max people to return inline (default 50, max 500)',
					},
					offset: {
						type: 'number',
						description: 'Skip this many matched rows for pagination (default 0)',
					},
					query: {
						type: 'string',
						description: 'Optional name/CRD/address substring filter',
					},
					saveFull: {
						type: 'boolean',
						description: 'Write full roster JSON+Markdown under .data/finra-rosters/ (default true)',
					},
				},
				required: ['firmCrd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_authority_timelines',
			description:
				'Search the local Authority Initiatives timeline (.data/authority-timelines): ICE/DHS/DEA/WH EO promo and signed-directive events with domestic/international audience tags and OK–TX corridor geos. Use for agency promo timelines, EO alignment, heavy-focus cities/counties. Source-linked leads only.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Keywords (agency names, cities, ops, EO topics)',
					},
					agency: {
						type: 'string',
						description: 'Optional agency filter: ICE | DHS | DEA | WH | CBP | FBI | DOD | NGB',
					},
					from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
					to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
					materialType: {
						type: 'string',
						description:
							'Optional: promo_campaign | press_release | signed_directive | joint_operation | recruitment | international_outreach | other',
					},
					corridorOnly: {
						type: 'boolean',
						description: 'If true, only events tagged with OK–TX corridor geos',
					},
					limit: { type: 'number', description: 'Max hits (default 12, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_cdc_covid_timeline',
			description:
				'Search the local CDC Museum COVID-19 timeline (.data/cdc-covid-timeline): dated events for diseases, variants/strains, vaccines, treatments/therapeutics, pharma/companies, named persons, agencies, and funding/$ figures as worded on the CDC page. Use for COVID chronology, Warp Speed, Remdesivir pricing, Omicron/Delta, Moderna/Pfizer/J&J/AstraZeneca. CDC narrative leads only — not a full SEC/pharma P&L corpus. No literal “superstrain” term on this page; use entityType=variant.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Keywords (vaccine, Omicron, Pfizer, Remdesivir, Fauci, CARES, …)',
					},
					from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
					to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
					entityType: {
						type: 'string',
						description:
							'Optional: company | person | vaccine | treatment | variant | disease | org',
					},
					entity: {
						type: 'string',
						description: 'Optional entity name substring (e.g. Moderna, Omicron, Fauci)',
					},
					financialsOnly: {
						type: 'boolean',
						description: 'If true, only events with dollar/funding mentions',
					},
					limit: { type: 'number', description: 'Max event hits (default 12, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_dod_covid_timeline',
			description:
				'Search the local DoD / War.gov Coronavirus Response Timeline (.data/dod-covid-timeline): DOD Response, Federal Response, Virus Progression, and Vaccine filter events (Force Health Protection, mandates, Warp Speed, USNORTHCOM/FEMA/DLA support, vaccine EUAs). Pair with search_cdc_covid_timeline for civilian CDC narrative. Live war.gov is often Akamai-blocked; corpus from Wayback. Institutional leads only.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Keywords (mandate, Warp Speed, NORTHCOM, Pfizer, Omicron, …)',
					},
					from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
					to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
					category: {
						type: 'string',
						description: 'Optional: dod | fed | virus | vaccine (or full labels)',
					},
					entityType: {
						type: 'string',
						description:
							'Optional: company | person | vaccine | treatment | variant | disease | org',
					},
					entity: {
						type: 'string',
						description: 'Optional entity name substring',
					},
					financialsOnly: {
						type: 'boolean',
						description: 'If true, only events with dollar/funding mentions',
					},
					limit: { type: 'number', description: 'Max event hits (default 12, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_gemini_qa',
			description:
				'Search local Gemini / Google Takeout Q&A under .data/gemini-qa (conversation digests). Use for prior Gemini chats the user imported. If corpusConversations=0, the Takeout likely only had empty Gemini stubs — ask for My Activity→Gemini Apps export or chat JSON/MD. Also search_knowledge on project “Gemini Q&A” after ingest.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords from prior Gemini chats' },
					limit: { type: 'number', description: 'Max hits (default 10, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_entity_dossiers',
			description:
				'Search local entity dossiers / alias buckets / edges (.data/entity-dossiers): people, orgs, places (Karp, Thiel, Palantir, Halliburton, Campion Trail, Rockefeller hub, …) cross-linked to authority events. Use for business details, aliases, and entity↔authority edges. Do not invent conspiracy links.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Name / org / place / ticker keywords' },
					slug: {
						type: 'string',
						description: 'Exact dossier slug, e.g. alex-karp, palantir, campion-trail-dallas',
					},
					kind: {
						type: 'string',
						description: 'Optional: person | org | family_hub | place | alias_bucket',
					},
					status: {
						type: 'string',
						description: 'Optional: pinned | candidate | rejected',
					},
					includeBuckets: {
						type: 'boolean',
						description: 'Include open alias buckets (default true)',
					},
					includeEdges: {
						type: 'boolean',
						description: 'Include related edges (default true)',
					},
					limit: { type: 'number', description: 'Max dossier hits (default 12, max 40)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_wikipedia',
			description:
				'Search the local offline English Wikipedia ZIM via kiwix-serve (default http://127.0.0.1:8765). Use for encyclopedia background when the ZIM is downloaded and the server is running. Returns titles + snippets only.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search pattern' },
					limit: { type: 'number', description: 'Max hits (default 8, max 25)' },
					start: { type: 'number', description: 'Pagination offset (0-based, default 0)' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_digital_earth',
			description:
				'Search the local Digital Earth ISDE corpus (.data/digitalearth-isde): crawled site pages, PDFs, data-layer/GIS references, and lecture videos with English transcripts/translations. Use for ISDE / Digital Earth / Big Earth Data / GHSL questions.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords' },
					kind: {
						type: 'string',
						description: 'Optional: page | pdf | video | data_layer | any (default any)',
					},
					limit: { type: 'number', description: 'Max hits (default 8, max 30)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_pqw_itmo',
			description:
				'Search the local Petersburg Quantum Weeks / PQW ITMO 2026 corpus (.data/pqw-itmo): EN/RU site pages, program/speakers, Book of Abstracts and program PDFs. Use for pqw.itmo.ru / quantum weeks / ISCTP school questions.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords (speaker, topic, fee, …)' },
					kind: {
						type: 'string',
						description: 'Optional: page | pdf | speaker | any (default any)',
					},
					limit: { type: 'number', description: 'Max hits (default 8, max 30)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_meta25',
			description:
				'Search the local META 2025 conference archive (.data/meta25): Malaga metamaterials/photonic crystals/plasmonics program, plenaries, sessions, proceedings PDF, and META 2025 talks with English transcripts. Excludes META 2026/2027 promotional material.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords (speaker, plenary, session, …)' },
					kind: {
						type: 'string',
						description: 'Optional: page | pdf | video | speaker | any (default any)',
					},
					limit: { type: 'number', description: 'Max hits (default 8, max 30)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_physics_congress',
			description:
				'Search the local Physics Congress 2026 archive (.data/physics-congress): Nazarbayev University / Astana site pages, plenary speakers, Dynamics Days, KPS, ISOS2026, program docs/PDFs from Google Drive. Use for physics-congress.kz questions.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords (speaker, track, venue, …)' },
					kind: {
						type: 'string',
						description: 'Optional: page | pdf | speaker | doc | any (default any)',
					},
					limit: { type: 'number', description: 'Max hits (default 8, max 30)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_twdb_trinity',
			description:
				'Search the local TWDB Trinity Aquifer PDF corpus (.data/twdb-trinity-aquifer): GAMs, advisory reports, GMPs, water-level/hydraulic studies. Filters: docType, GMA, topic, year. Logs retrieval feedback so facet structure improves over time. Prefer this for Trinity aquifer / TWDB Texas groundwater questions once the corpus is built.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords (aquifer unit, county, DFC, water levels, …)' },
					docType: {
						type: 'string',
						description: 'Optional: gam | advisory | report | gmp | water_level | hydraulic | org | other',
					},
					gma: { type: 'string', description: 'Optional GMA id, e.g. 8 or GMA-8' },
					topic: {
						type: 'string',
						description:
							'Optional topic: water_levels | recharge | pumping | quality | management | geology',
					},
					year: { type: 'number', description: 'Optional year filter' },
					limit: { type: 'number', description: 'Max hits (default 8, max 30)' },
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_concealment_scrubs',
			description:
				'Search the local YouTube concealment-scrub archive (.data/concealment-scrubs): ControlAltHistory, MindUnveiled, eyes_wideopen, dig.archaeology, FRESHboosters, PhilipThompson, HiddenAmuraKa, UTDGeoscienceStudio, TheMysteryAbyss, FallOfCivilizations, TimelineWorldHistory, EpicHistoryTV, HistoryMatters, GlobalHistoryScope, DrJoanneFreeman, AncientLives, SilkRoadAsianHistory, SparkDocs, OttomanHistory, HistorysMysteries-WWI, playlist-PLo7mt, plus deep SCRUB-01…05 notes and MindUnveiled OCR digests. Use for YouTube videos the user added, captions/cards, timeline anchors, naming/hiding patterns. Pass timelinesOnly=true to prefer Timeline sections. Claims are narration/OCR leads — not verified facts. Do NOT say you lack YouTube access when this archive exists.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Title / topic / person / year keywords (e.g. Falklands, Marconi, timeline)',
					},
					channel: {
						type: 'string',
						description:
							'Optional channel filter: ControlAltHistory | MindUnveiled | eyes_wideopen | dig.archaeology | FRESHboosters | PhilipThompson | PLo7mt',
					},
					videoId: {
						type: 'string',
						description: 'Exact YouTube video id (11 chars) or youtu.be URL',
					},
					timelinesOnly: {
						type: 'boolean',
						description: 'Prefer/extract Timeline anchors / year sections (default false)',
					},
					includeOcr: {
						type: 'boolean',
						description: 'Also search MindUnveiled on-screen OCR digests (default false)',
					},
					limit: { type: 'number', description: 'Max hits (default 6, max 20)' },
					maxCharsPerHit: {
						type: 'number',
						description: 'Max characters of excerpt per hit (default 4500)',
					},
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'inspect_canvas_graph',
			description:
				"Inspect the user's FINRA canvas graph snapshot (nodes/links from the live graph window or pasted JSON). Use for questions about what is on the graph right now. Actions: summary, list_people, list_firms, selection_log, neighbors, dual_on_canvas, search. For full CRD corpus search use search_finra_sidecar instead.",
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						description:
							'summary | list_people | list_firms | selection_log | neighbors | dual_on_canvas | search',
					},
					query: { type: 'string', description: 'Optional name/CRD filter for list/search actions' },
					nodeId: { type: 'string', description: 'Node id for neighbors, e.g. person:5417517 or firm:2525' },
					limit: { type: 'number', description: 'Max rows to return (default 40)' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'fetch_url',
			description:
				'GET any public http(s) URL the user pasted (HTML page, API JSON, or PDF). Extracts readable text; for HTML also discovers linked PDFs, downloads them under .data/fetched/pdfs/, and extracts text with pdftotext. Private/local hosts stay blocked unless allowlisted. Use whenever the user pastes a link (e.g. pubs.usgs.gov).',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
					maxChars: {
						type: 'number',
						description: 'Max characters of body/text to return (default 12000, max 48000)',
					},
					downloadPdfs: {
						type: 'boolean',
						description:
							'When the URL is an HTML page, also download linked PDFs (default true). Ignored for direct PDF URLs (always saved).',
					},
					maxPdfs: {
						type: 'number',
						description:
							'Max linked PDFs to download from an HTML page (default: all discovered up to 20, hard max 40)',
					},
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'current_time',
			description: 'Return the current date and time in ISO and local string forms (server timezone).',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
];

const FETCH_URL_DEFAULT_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	'::1',
	'en.wikipedia.org',
	'www.wikipedia.org',
	'raw.githubusercontent.com',
	'github.com',
	'api.github.com',
	'docs.x.ai',
	'arxiv.org',
	'export.arxiv.org',
	'finra-sec-data-visualizer-canvas.vercel.app',
	'brokercheck.finra.org',
	'api.brokercheck.finra.org',
	'files.brokercheck.finra.org',
	'adviserinfo.sec.gov',
	'api.adviserinfo.sec.gov',
	'okcountyrecords.com',
	'www.okcountyrecords.com',
	'earthquake.usgs.gov',
	'www.earthquake.usgs.gov',
	'pubs.usgs.gov',
	'www.pubs.usgs.gov',
	'usgs.gov',
	'www.usgs.gov',
	'spc.noaa.gov',
	'www.spc.noaa.gov',
	'ncei.noaa.gov',
	'www.ncei.noaa.gov',
]);
const FETCH_URL_MAX_BYTES = 512_000;
const FETCH_PDF_MAX_BYTES = 40 * 1024 * 1024;
const FETCH_URL_TIMEOUT_MS = 45_000;
const FETCHED_ROOT = path.join(process.cwd(), '.data', 'fetched');

function fetchUrlAllowedHosts(): Set<string> {
	const hosts = new Set(FETCH_URL_DEFAULT_HOSTS);
	const extra = String(process.env.RESEARCH_FETCH_HOSTS || process.env.LOCAL_AI_FETCH_HOSTS || '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	for (const h of extra) hosts.add(h);
	return hosts;
}

function openFetchEnabled(): boolean {
	// Default ON so pasted URLs work; set RESEARCH_OPEN_FETCH=0 to require allowlist only.
	const raw = String(process.env.RESEARCH_OPEN_FETCH || process.env.ALLOW_OPEN_FETCH || '1')
		.trim()
		.toLowerCase();
	return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function normalizeFetchHost(hostname: string): string {
	return String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
}

function isPrivateOrLocalHostname(hostname: string): boolean {
	const host = normalizeFetchHost(hostname);
	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
	if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
	if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
	if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;
	return false;
}

function isFetchUrlAllowed(url: URL): { ok: true } | { ok: false; error: string } {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'only http(s) URLs are allowed' };
	}
	if (url.username || url.password) {
		return { ok: false, error: 'URLs with credentials are not allowed' };
	}
	const host = normalizeFetchHost(url.hostname);
	const allowlist = fetchUrlAllowedHosts();
	if (allowlist.has(host) || allowlist.has(url.hostname.toLowerCase())) {
		return { ok: true };
	}
	if (openFetchEnabled()) {
		if (isPrivateOrLocalHostname(host) && !allowlist.has(host)) {
			return {
				ok: false,
				error: `private/local host blocked even with open fetch: ${url.hostname}. Add it to RESEARCH_FETCH_HOSTS.`,
			};
		}
		return { ok: true };
	}
	return {
		ok: false,
		error: `host not allowlisted: ${url.hostname}. Add hosts via RESEARCH_FETCH_HOSTS, or set RESEARCH_OPEN_FETCH=1 for public https.`,
	};
}

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function ensureFetchedDirs() {
	fs.mkdirSync(path.join(FETCHED_ROOT, 'pdfs'), { recursive: true });
	fs.mkdirSync(path.join(FETCHED_ROOT, 'pages'), { recursive: true });
}

function safeFetchedName(url: string, ext: string): string {
	const u = new URL(url);
	const base = path.basename(u.pathname) || 'download';
	const cleaned = base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'download';
	const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
	const hasExt = /\.[a-z0-9]{2,8}$/i.test(cleaned);
	return hasExt ? `${hash}-${cleaned}` : `${hash}-${cleaned}${ext}`;
}

function extractPdfTextFromBuffer(buffer: Buffer): string {
	const result = spawnSync('pdftotext', ['-layout', '-nopgbrk', '-', '-'], {
		input: buffer,
		encoding: 'buffer',
		maxBuffer: 24 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const err = String(result.stderr || result.error || 'pdftotext failed');
		throw new Error(`PDF text extract failed: ${err.slice(0, 240)}`);
	}
	return Buffer.from(result.stdout || []).toString('utf8').trim();
}

function isPdfPayload(contentType: string, url: string, buf: Buffer): boolean {
	if (contentType.includes('pdf')) return true;
	if (/\.pdf(\?|#|$)/i.test(url)) return true;
	return buf.subarray(0, 5).toString('utf8') === '%PDF-';
}

function discoverPdfLinks(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (href: string) => {
		try {
			const abs = new URL(href, baseUrl).href;
			if (!/\.pdf(\?|#|$)/i.test(abs)) return;
			if (seen.has(abs)) return;
			seen.add(abs);
			out.push(abs);
		} catch {
			/* ignore */
		}
	};
	for (const m of html.matchAll(/citation_pdf_url["']\s+content=["']([^"']+)["']/gi)) {
		push(m[1]);
	}
	for (const m of html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)) {
		push(m[1]);
	}
	// Prefer main report-like PDFs first
	out.sort((a, b) => {
		const score = (u: string) => {
			const n = u.toLowerCase();
			if (/report\.pdf|main\.pdf|full[-_]?text|document\.pdf/.test(n)) return 0;
			if (/plate|figure|map|suppl/.test(n)) return 2;
			return 1;
		};
		return score(a) - score(b);
	});
	return out;
}

async function httpGetBuffer(
	url: string,
	maxBytes: number,
	timeoutMs = FETCH_URL_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; contentType: string; finalUrl: string; buf: Buffer }> {
	const parsed = new URL(url);
	const allowed = isFetchUrlAllowed(parsed);
	if (allowed.ok === false) {
		throw new Error(allowed.error);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(parsed.href, {
			method: 'GET',
			redirect: 'follow',
			cache: 'no-store',
			signal: controller.signal,
			headers: {
				Accept: 'application/pdf,application/json,text/plain,text/html;q=0.9,*/*;q=0.8',
				'User-Agent': 'ai-research-tool-fetch/1.1',
			},
		});
		const finalUrl = new URL(res.url);
		const finalAllowed = isFetchUrlAllowed(finalUrl);
		if (!finalAllowed.ok) {
			throw new Error(`redirect landed on disallowed host: ${finalUrl.hostname}`);
		}
		const contentType = String(res.headers.get('content-type') || '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > maxBytes) {
			throw new Error(`response too large (${buf.length} bytes > ${maxBytes})`);
		}
		return {
			ok: res.ok,
			status: res.status,
			contentType,
			finalUrl: finalUrl.href,
			buf,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function saveAndExtractPdf(
	pdfUrl: string,
	maxChars: number,
	prefetched?: { buf: Buffer; contentType: string; finalUrl: string; status: number; ok: boolean },
): Promise<Record<string, unknown>> {
	ensureFetchedDirs();
	const got =
		prefetched ||
		(await httpGetBuffer(pdfUrl, FETCH_PDF_MAX_BYTES, 90_000));
	if (!got.ok) {
		return { ok: false, url: pdfUrl, status: got.status, error: `HTTP ${got.status}` };
	}
	if (!isPdfPayload(got.contentType, got.finalUrl, got.buf)) {
		return {
			ok: false,
			url: pdfUrl,
			finalUrl: got.finalUrl,
			error: `not a PDF (content-type=${got.contentType || 'unknown'})`,
		};
	}
	const fileName = safeFetchedName(got.finalUrl, '.pdf');
	const savedPath = path.join(FETCHED_ROOT, 'pdfs', fileName);
	fs.writeFileSync(savedPath, got.buf);
	let text = '';
	let extractError: string | undefined;
	try {
		text = extractPdfTextFromBuffer(got.buf);
	} catch (e: unknown) {
		extractError = e instanceof Error ? e.message : String(e);
	}
	const { text: excerpt, truncated } = truncateChars(text, maxChars);
	return {
		ok: true,
		url: pdfUrl,
		finalUrl: got.finalUrl,
		status: got.status,
		contentType: got.contentType || 'application/pdf',
		byteLength: got.buf.length,
		savedPath: path.relative(process.cwd(), savedPath),
		textChars: text.length,
		truncated,
		excerpt,
		extractError,
	};
}

async function fetchUrlForResearch(
	rawUrl: unknown,
	maxCharsRaw: unknown,
	downloadPdfsRaw?: unknown,
	maxPdfsRaw?: unknown,
): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const maxChars = Math.max(1000, Math.min(48_000, Number(maxCharsRaw) || 12_000));
	const downloadPdfs = downloadPdfsRaw === undefined ? true : Boolean(downloadPdfsRaw);
	// Default: pull all discovered PDFs (cap 20). Explicit 0 disables linked downloads.
	const maxPdfs =
		maxPdfsRaw === undefined || maxPdfsRaw === null || maxPdfsRaw === ''
			? 20
			: Math.max(0, Math.min(40, Number(maxPdfsRaw) || 0));
	let parsed: URL;
	try {
		parsed = new URL(String(rawUrl || '').trim());
	} catch {
		return { ok: false, result: { error: 'invalid URL' } };
	}
	const allowed = isFetchUrlAllowed(parsed);
	if (allowed.ok === false) {
		return { ok: false, result: { error: allowed.error, url: parsed.href } };
	}

	try {
		const directPdf = /\.pdf(\?|#|$)/i.test(parsed.pathname) || /\.pdf(\?|#|$)/i.test(parsed.href);
		if (directPdf) {
			const pdf = await saveAndExtractPdf(parsed.href, maxChars);
			return {
				ok: Boolean(pdf.ok),
				result: {
					ok: Boolean(pdf.ok),
					kind: 'pdf',
					requestedUrl: parsed.href,
					...pdf,
					hint: pdf.ok
						? 'PDF saved under .data/fetched/pdfs/ and text extracted with pdftotext.'
						: undefined,
				},
			};
		}

		const got = await httpGetBuffer(
			parsed.href,
			Math.max(FETCH_URL_MAX_BYTES, FETCH_PDF_MAX_BYTES),
			FETCH_URL_TIMEOUT_MS,
		);
		if (isPdfPayload(got.contentType, got.finalUrl, got.buf)) {
			const pdf = await saveAndExtractPdf(got.finalUrl, maxChars, got);
			return {
				ok: Boolean(pdf.ok),
				result: {
					ok: Boolean(pdf.ok),
					kind: 'pdf',
					requestedUrl: parsed.href,
					...pdf,
				},
			};
		}

		const contentType = got.contentType;
		const byteTruncated = got.buf.length > FETCH_URL_MAX_BYTES;
		const slice = byteTruncated ? got.buf.subarray(0, FETCH_URL_MAX_BYTES) : got.buf;
		const rawText = slice.toString('utf8');

		let kind: 'json' | 'text' | 'html' = 'text';
		let body: unknown = rawText;
		const looksJson = contentType.includes('json') || /^\s*[{[]/.test(rawText);
		if (looksJson) {
			try {
				body = JSON.parse(rawText);
				kind = 'json';
			} catch {
				kind = 'text';
				body = rawText;
			}
		} else if (contentType.includes('html') || /^\s*</.test(rawText)) {
			kind = 'html';
			body = htmlToReadableText(rawText);
		}

		const serialized = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
		const { text, truncated } = truncateChars(serialized, maxChars);
		let returnedBody: unknown = text;
		if (kind === 'json') {
			try {
				returnedBody = JSON.parse(text);
			} catch {
				returnedBody = text;
			}
		}

		ensureFetchedDirs();
		const pageName = safeFetchedName(got.finalUrl, kind === 'html' ? '.html' : '.txt');
		const pagePath = path.join(FETCHED_ROOT, 'pages', pageName);
		try {
			fs.writeFileSync(pagePath, kind === 'html' ? got.buf : Buffer.from(serialized, 'utf8'));
		} catch {
			/* non-fatal */
		}

		const discoveredPdfs = kind === 'html' ? discoverPdfLinks(rawText, got.finalUrl) : [];
		const pdfDownloads: Record<string, unknown>[] = [];
		if (kind === 'html' && downloadPdfs && maxPdfs > 0) {
			for (const pdfUrl of discoveredPdfs.slice(0, maxPdfs)) {
				try {
					pdfDownloads.push(await saveAndExtractPdf(pdfUrl, Math.min(maxChars, 16_000)));
				} catch (e: unknown) {
					pdfDownloads.push({
						ok: false,
						url: pdfUrl,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}

		return {
			ok: got.ok,
			result: {
				ok: got.ok,
				status: got.status,
				contentType: contentType || null,
				kind,
				requestedUrl: parsed.href,
				finalUrl: got.finalUrl,
				byteLength: got.buf.length,
				truncated: truncated || byteTruncated,
				body: returnedBody,
				savedPagePath: path.relative(process.cwd(), pagePath),
				discoveredPdfCount: discoveredPdfs.length,
				discoveredPdfs: discoveredPdfs.slice(0, 20),
				pdfDownloads,
				hint:
					truncated || byteTruncated
						? 'Body truncated for model context; PDFs (if any) are saved under .data/fetched/pdfs/.'
						: pdfDownloads.length
							? 'Page text plus downloaded PDF excerpts. Full PDFs saved under .data/fetched/pdfs/.'
							: discoveredPdfs.length
								? 'Page has PDF links; pass downloadPdfs=true (default) or raise maxPdfs to pull more.'
								: undefined,
			},
		};
	} catch (e: unknown) {
		const err = e as { name?: string; message?: string };
		const message =
			err?.name === 'AbortError' ? `timeout after ${FETCH_URL_TIMEOUT_MS}ms` : err?.message || String(e);
		return { ok: false, result: { error: message, url: parsed.href } };
	}
}

function resolveProjectId(args: Record<string, unknown>, context: ResearchToolContext): string {
	const candidates = [
		String(args.projectId || '').trim(),
		String(context.projectId || '').trim(),
	].filter(Boolean);

	const projects = listProjects();
	for (const raw of candidates) {
		const byId = projects.find((p) => p.id === raw);
		if (byId) return byId.id;
		const byName = projects.find((p) => p.name.toLowerCase() === raw.toLowerCase());
		if (byName) return byName.id;
		// Tolerate "BryanCounty" / "bryan_county" style labels from the model
		const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
		const byCompact = projects.find((p) => p.name.toLowerCase().replace(/[\s_-]+/g, '') === compact);
		if (byCompact) return byCompact.id;
	}

	const queryHint = String(args.query || args.q || '').toLowerCase();
	const tornado = projects.find((p) => /tornado/i.test(p.name));
	if (
		tornado &&
		/\b(tornado|tornadoes|tornadic|ef[0-5]|efu|spc|ncei|storm events)\b/i.test(queryHint)
	) {
		return tornado.id;
	}
	const seismic = projects.find((p) => /seismic/i.test(p.name));
	if (
		seismic &&
		/\b(seismic|earthquake|earthquakes|comcat|usgs|magnitude|quake)\b/i.test(queryHint)
	) {
		return seismic.id;
	}

	const bryan = projects.find((p) => p.name.toLowerCase() === 'bryan county');
	if (bryan) return bryan.id;
	return ensureDefaultProject().id;
}

async function runSearchKnowledge(
	args: Record<string, unknown>,
	context: ResearchToolContext,
): Promise<{ ok: boolean; result: unknown }> {
	const query = String(args.query || '').trim();
	if (!query) {
		return { ok: false, result: { error: 'query required' } };
	}

	let projectId: string;
	try {
		projectId = resolveProjectId(args, context);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { error: `projectId required (${message})` } };
	}

	const sourceTypeRaw = String(args.sourceType || 'any').trim().toLowerCase();
	const sourceType = (
		['chat', 'fetch', 'note', 'file', 'image', 'any'].includes(sourceTypeRaw)
			? sourceTypeRaw
			: 'any'
	) as KnowledgeSourceType | 'any';

	try {
		const hits = await retrieve(query, {
			projectId,
			limit: args.limit as number | undefined,
			sourceType,
		});
		const snippetMax = (() => {
			const n = Number(process.env.RESEARCH_SEARCH_SNIPPET_CHARS || 400);
			if (!Number.isFinite(n)) return 400;
			return Math.max(120, Math.min(800, Math.floor(n)));
		})();
		const payloadMax = (() => {
			const n = Number(process.env.RESEARCH_TOOL_RESULT_MAX_CHARS || 8000);
			if (!Number.isFinite(n)) return 8000;
			return Math.max(1500, Math.min(48_000, Math.floor(n)));
		})();

		const compactSnippet = (text: string) => {
			const one = String(text || '').trim();
			if (one.length <= snippetMax) return one;
			return `${one.slice(0, snippetMax - 1)}…`;
		};

		let mapped = hits.map((h) => ({
			title: h.title,
			sourceType: h.sourceType,
			url: h.url,
			snippet: compactSnippet(h.snippet),
			score: Number(h.score?.toFixed?.(4) ?? h.score),
			documentId: h.documentId,
			chunkId: h.chunkId,
		}));

		let truncatedHits = false;
		while (mapped.length > 1 && JSON.stringify(mapped).length > payloadMax - 400) {
			mapped = mapped.slice(0, -1);
			truncatedHits = true;
		}
		if (mapped.length === 1 && JSON.stringify(mapped).length > payloadMax - 400) {
			mapped = [
				{
					...mapped[0]!,
					snippet: compactSnippet(mapped[0]!.snippet.slice(0, Math.max(120, snippetMax / 2))),
				},
			];
			truncatedHits = true;
		}

		return {
			ok: true,
			result: {
				ok: true,
				query,
				projectId,
				returned: mapped.length,
				hits: mapped,
				hint:
					hits.length === 0
						? 'No local knowledge hits. Save notes or enable persist flags (later PRs), or ask without relying on prior memory.'
						: truncatedHits
							? `Truncated to ${mapped.length} of ${hits.length} hits for model context; narrow the query for more detail.`
							: undefined,
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message, query, projectId } };
	}
}

async function runChartFilings(
	args: Record<string, unknown>,
	context: ResearchToolContext,
): Promise<{ ok: boolean; result: unknown }> {
	try {
		const projectId = resolveProjectId(args, context);
		const chart = await createBryanFilingChart({
			projectId,
			period: args.period as string | undefined,
			kind: args.kind as string | undefined,
			from: args.from != null ? String(args.from) : null,
			to: args.to != null ? String(args.to) : null,
			docType: args.docType != null ? String(args.docType) : null,
			limitBuckets: args.limitBuckets as number | undefined,
			limitTypes: args.limitTypes as number | undefined,
			format: args.format as string | undefined,
		});
		return { ok: true, result: chart };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

async function runMakeLogo(args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }> {
	try {
		const logo = await createLogo({
			text: String(args.text || ''),
			subtitle: args.subtitle != null ? String(args.subtitle) : null,
			format: args.format as string | undefined,
		});
		return { ok: true, result: logo };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export async function runResearchTool(
	name: string,
	args: Record<string, unknown>,
	context: ResearchToolContext = {},
): Promise<{ ok: boolean; result: unknown }> {
	const tool = String(name || '').trim() as ResearchToolName;

	if (tool === 'search_knowledge') {
		return runSearchKnowledge(args, context);
	}

	if (tool === 'chart_filings') {
		return runChartFilings(args, context);
	}

	if (tool === 'make_logo') {
		return runMakeLogo(args);
	}

	if (tool === 'inspect_canvas_graph') {
		const inspected = inspectCanvasSnapshot(context.canvasSnapshot, args);
		return { ok: inspected.ok, result: inspected.result };
	}

	if (tool === 'search_finra_sidecar') {
		return searchFinraSidecar(args);
	}

	if (tool === 'lookup_brokercheck') {
		return lookupBrokercheckIndividual({
			crd: args.crd != null ? String(args.crd) : undefined,
			includeAdviserInfo:
				args.includeAdviserInfo === undefined ? undefined : Boolean(args.includeAdviserInfo),
		});
	}

	if (tool === 'lookup_firm_connections') {
		return lookupFirmConnections({
			firmCrd: args.firmCrd != null ? String(args.firmCrd) : undefined,
			bucket: args.bucket != null ? String(args.bucket) : undefined,
			limit: args.limit as number | undefined,
			offset: args.offset as number | undefined,
			query: args.query != null ? String(args.query) : undefined,
			saveFull: args.saveFull === undefined ? undefined : Boolean(args.saveFull),
		});
	}

	if (tool === 'search_authority_timelines') {
		return searchAuthorityTimelines({
			query: args.query != null ? String(args.query) : undefined,
			agency: args.agency != null ? String(args.agency) : undefined,
			from: args.from != null ? String(args.from) : undefined,
			to: args.to != null ? String(args.to) : undefined,
			materialType: args.materialType != null ? String(args.materialType) : undefined,
			corridorOnly: args.corridorOnly === undefined ? undefined : Boolean(args.corridorOnly),
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_cdc_covid_timeline') {
		return searchCdcCovidTimeline({
			query: args.query != null ? String(args.query) : undefined,
			from: args.from != null ? String(args.from) : undefined,
			to: args.to != null ? String(args.to) : undefined,
			entityType: args.entityType != null ? String(args.entityType) : undefined,
			entity: args.entity != null ? String(args.entity) : undefined,
			financialsOnly: args.financialsOnly === undefined ? undefined : Boolean(args.financialsOnly),
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_dod_covid_timeline') {
		return searchDodCovidTimeline({
			query: args.query != null ? String(args.query) : undefined,
			from: args.from != null ? String(args.from) : undefined,
			to: args.to != null ? String(args.to) : undefined,
			category: args.category != null ? String(args.category) : undefined,
			entityType: args.entityType != null ? String(args.entityType) : undefined,
			entity: args.entity != null ? String(args.entity) : undefined,
			financialsOnly: args.financialsOnly === undefined ? undefined : Boolean(args.financialsOnly),
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_gemini_qa') {
		return searchGeminiQa({
			query: args.query != null ? String(args.query) : undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_entity_dossiers') {
		return searchEntityDossiers({
			query: args.query != null ? String(args.query) : undefined,
			slug: args.slug != null ? String(args.slug) : undefined,
			kind: args.kind != null ? String(args.kind) : undefined,
			status: args.status != null ? String(args.status) : undefined,
			includeBuckets: args.includeBuckets === undefined ? undefined : Boolean(args.includeBuckets),
			includeEdges: args.includeEdges === undefined ? undefined : Boolean(args.includeEdges),
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_profiles') {
		return searchProfilesTool({
			query: args.query != null ? String(args.query) : undefined,
			slug: args.slug != null ? String(args.slug) : undefined,
			profileType: args.profileType != null ? String(args.profileType) : undefined,
			corpus: args.corpus != null ? String(args.corpus) : undefined,
			geo: args.geo != null ? String(args.geo) : undefined,
			status: args.status != null ? String(args.status) : undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'get_profile_timeline') {
		return getProfileTimelineTool({
			profile: args.profile != null ? String(args.profile) : undefined,
			from: args.from != null ? String(args.from) : undefined,
			to: args.to != null ? String(args.to) : undefined,
			angle: args.angle != null ? String(args.angle) : undefined,
			corpus: args.corpus != null ? String(args.corpus) : undefined,
			minGapDays: args.minGapDays as number | undefined,
			detectGaps: args.detectGaps === undefined ? undefined : Boolean(args.detectGaps),
			fillFromKnowledge:
				args.fillFromKnowledge === undefined ? undefined : Boolean(args.fillFromKnowledge),
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'find_profile_alignments') {
		return findProfileAlignmentsTool({
			profile: args.profile != null ? String(args.profile) : undefined,
			kind: args.kind != null ? String(args.kind) : undefined,
			status: args.status != null ? String(args.status) : undefined,
			cautionTier: args.cautionTier != null ? String(args.cautionTier) : undefined,
			minScore: args.minScore as number | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_wikipedia') {
		return searchWikipedia({
			query: args.query != null ? String(args.query) : undefined,
			limit: args.limit as number | undefined,
			start: args.start as number | undefined,
		});
	}

	if (tool === 'search_concealment_scrubs') {
		return searchConcealmentScrubs({
			query: args.query != null ? String(args.query) : undefined,
			channel: args.channel != null ? String(args.channel) : undefined,
			videoId: args.videoId != null ? String(args.videoId) : undefined,
			timelinesOnly: args.timelinesOnly === undefined ? undefined : Boolean(args.timelinesOnly),
			includeOcr: args.includeOcr === undefined ? undefined : Boolean(args.includeOcr),
			limit: args.limit as number | undefined,
			maxCharsPerHit: args.maxCharsPerHit as number | undefined,
		});
	}

	if (tool === 'search_twdb_trinity') {
		return searchTwdbTrinity({
			query: args.query != null ? String(args.query) : undefined,
			docType: args.docType != null ? String(args.docType) : undefined,
			gma: args.gma != null ? String(args.gma) : undefined,
			topic: args.topic != null ? String(args.topic) : undefined,
			year: args.year as number | string | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_digital_earth') {
		return searchDigitalEarth({
			query: args.query != null ? String(args.query) : undefined,
			kind: args.kind as 'page' | 'pdf' | 'video' | 'data_layer' | 'any' | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_pqw_itmo') {
		return searchPqwItmo({
			query: args.query != null ? String(args.query) : undefined,
			kind: args.kind as 'page' | 'pdf' | 'speaker' | 'any' | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_meta25') {
		return searchMeta25({
			query: args.query != null ? String(args.query) : undefined,
			kind: args.kind as 'page' | 'pdf' | 'video' | 'speaker' | 'any' | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'search_physics_congress') {
		return searchPhysicsCongress({
			query: args.query != null ? String(args.query) : undefined,
			kind: args.kind as 'page' | 'pdf' | 'speaker' | 'doc' | 'any' | undefined,
			limit: args.limit as number | undefined,
		});
	}

	if (tool === 'current_time') {
		const now = new Date();
		return {
			ok: true,
			result: {
				iso: now.toISOString(),
				local: now.toString(),
				timezoneOffsetMinutes: now.getTimezoneOffset(),
				unixMs: now.getTime(),
			},
		};
	}

	if (tool === 'fetch_url') {
		const fetched = await fetchUrlForResearch(
			args.url,
			args.maxChars,
			args.downloadPdfs,
			args.maxPdfs,
		);
		return { ok: fetched.ok, result: fetched.result };
	}

	return { ok: false, result: { error: `unknown tool: ${name}` } };
}
