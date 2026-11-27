/**
 * Automatic background validation, API/RSS cross-check, internet crawl (websites, PDFs,
 * data layers), Ollama "auto" milestone synthesis, and named-entity discovery pipeline.
 *
 * Triggered asynchronously via Next.js `after(...)` whenever a profile is created
 * (`POST /api/profiles`) or updated (`PATCH /api/profiles/[id]`).
 *
 * Stages:
 *  1) Local validation: enrichProfile (Kiwix/Wiki, BrokerCheck, Knowledge SQLite, Bryan UCC,
 *     Free Org Enrich) + duplicate/alignment check + local RSS historic_event cross-linking.
 *  2) External APIs & RSS: Wikipedia Action API + Wikidata Entity API + ProPublica Nonprofits
 *     + recent RSS feed index matches.
 *  3) Internet crawl: SearXNG targeted queries for websites, PDFs, and GIS/data layers,
 *     crawled via `runResearchTool('fetch_url', { url, maxPdfs: 3 })` (extracts HTML, PDFs,
 *     JSON/GeoJSON/ArcGIS data layers).
 *  4) Ollama "auto" model synthesis (via existing `orchestrator.ts` `routeResearchModel` +
 *     optional `runResearchAgent({ model: 'auto' })` fallback): extracts grounded dated
 *     milestones and named entities across all profile categories.
 *  5) Timeline & entity graph update: adds dated milestones to `timeline_entries` (and
 *     upgrades sparse Overview summaries into lead + ## Timeline), then runs Strong ID +
 *     Fuzzy Name Matching (`identity.ts`) on every discovered entity to either UPDATE an
 *     existing profile or CREATE a new linked profile with its own milestone timeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { enrichProfile } from '@/lib/research/profiles/enrich';
import {
	buildProfileIdentityContext,
	evaluateIdentityMatch,
	hasStrongLocationAlignments,
} from '@/lib/research/profiles/identity';
import {
	classifyOrgType,
	makeProfileSlug,
	normalizeIsoDate,
	normalizeText,
	sha256Key,
	stripLegalSuffixes,
} from '@/lib/research/profiles/normalize';
import {
	addAlias,
	addIdentifier,
	addLocation,
	addPersonEmployment,
	findExistingOrgByNameOrAlias,
	getProfile,
	getProfileDetail,
	updateProfileFields,
	upsertAlignmentCandidate,
	upsertProfile,
	upsertProfileLink,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import {
	ensureSummaryTimelineNewestFirst,
	syncSummaryTimelineToEntries,
} from '@/lib/research/profiles/syncSummaryTimeline';
import { summaryAlreadyHasTimelinedView } from '@/lib/research/profiles/historicEventTimeline';
import type {
	ProfileDetail,
	ProfileRelationType,
	ProfileType,
} from '@/lib/research/profiles/types';
import {
	assistantMessageText,
	ollamaChat,
	ollamaTags,
} from '@/lib/research/ollama';
import {
	RESEARCH_AUTO_MODEL,
	routeResearchModel,
} from '@/lib/research/orchestrator';
import { runResearchAgent } from '@/lib/research/agent';
import { runResearchTool } from '@/lib/research/tools';
import { searchWeb, type WebSearchHit } from '@/lib/research/webSearch';

const UA = 'AI-Research-Tool/1.0 (local research; +http://localhost:3333)';
const PIPELINE_CORPUS = 'auto-profile-pipeline';
const COOLDOWN_MS = Math.max(15_000, Number(process.env.AUTO_RESEARCH_COOLDOWN_MS || 90_000));
const MAX_CRAWL_URLS = Math.max(1, Math.min(6, Number(process.env.AUTO_RESEARCH_MAX_URLS || 4)));
const MAX_ENTITIES = Math.max(2, Math.min(12, Number(process.env.AUTO_RESEARCH_MAX_ENTITIES || 8)));

const VALID_ENTITY_TYPES = new Set<ProfileType>([
	'person',
	'firm',
	'government',
	'nonprofit',
	'education',
	'medical_hospital',
	'historic_event',
]);

const NEWS_OUTLET_SKIP_RE =
	/^(?:bbc|bbc news|un news|federal news network|reuters|associated press|ap news|enr|engineering news-record|defense daily|breaking defense|defense one|construction dive|construction exec|construction executive|ground engineering|the guardian|new york times|washington post|bloomberg|cnn|fox news|nbc news|cbs news|abc news|npr|al jazeera|wikipedia|wikidata)$/i;

const GEO_OR_CONCEPT_SKIP_RE =
	/\b(?:strait of|gulf of|sea of|bay of|river|ocean|canal|routes?|corridor|highway|ring road|peninsula|territory|region|neighbourhood|neighborhood|city centre|parliamentary bloc|coalition government|stock exchange index|small island economies|least developed countries|developing countries|regional public prosecutor|public prosecutor|prosecutors?|state-owned media|local authorities)\b/i;

const HOSPITAL_NAME_CUE_RE =
	/\b(?:hospital|medical|clinic|health|cancer|infirmary|sanatorium|centre|center|veterans affairs|va\b|children'?s|memorial|general|university medical)\b/i;

const EDUCATION_NAME_CUE_RE =
	/\b(?:university|college|institute of technology|school|academy|polytechnic|seminary|faculty|conservatory|mit\b|caltech|eth\b)\b/i;

const DATA_LAYER_URL_RE =
	/(?:\.geojson|\.json|\.csv|\.kml|\.kmz|\.shp|arcgis|mapserver|featureserver|wms|wfs|data\.gov|opendata|hub\.arcgis|catalog\.data|census\.gov\/data|usgs\.gov.*\/fdsnws|sec\.gov\/Archives\/edgar)/i;

const PDF_URL_RE = /\.pdf(?:$|\?|#)/i;

export type AutoResearchStatus = {
	status: 'queued' | 'running' | 'completed' | 'failed';
	trigger: 'create' | 'update' | 'manual';
	startedAt: string;
	finishedAt?: string;
	model?: string | null;
	stages: {
		localValidation: {
			enrichValidatedSources: number;
			duplicateAlignments: number;
			rssEventsLinked: number;
			rssFeedHits: number;
		};
		apiLookup: {
			wikipedia: boolean;
			wikidataQid: string | null;
			propublica: boolean;
		};
		internetCrawl: {
			queriesRun: number;
			urlsCrawled: number;
			pdfsExtracted: number;
			dataLayersFound: number;
			milestonesAdded: number;
			agentFallbackUsed: boolean;
		};
		entitiesDiscovered: {
			extracted: number;
			matchedUpdated: number;
			created: number;
			skippedAmbiguous: number;
			slugs: string[];
		};
		summaryUpgraded: boolean;
	};
	error?: string | null;
};

type GlobalPipelineState = {
	running: Set<string>;
	lastFinishedAt: Map<string, number>;
};

function getGlobalState(): GlobalPipelineState {
	const g = globalThis as unknown as { __autoResearchPipelineState?: GlobalPipelineState };
	if (!g.__autoResearchPipelineState) {
		g.__autoResearchPipelineState = {
			running: new Set<string>(),
			lastFinishedAt: new Map<string, number>(),
		};
	}
	return g.__autoResearchPipelineState;
}

/** Check whether a pipeline run should be queued for this profile (dedupe + cooldown). */
export function shouldScheduleAutoResearch(
	profileId: string,
	opts: { force?: boolean } = {},
): boolean {
	if (/^(0|false|no|off)$/i.test(String(process.env.AUTO_PROFILE_RESEARCH ?? '1'))) {
		return false;
	}
	const state = getGlobalState();
	if (state.running.has(profileId)) return false;
	if (!opts.force) {
		const last = state.lastFinishedAt.get(profileId);
		if (last != null && Date.now() - last < COOLDOWN_MS) return false;
	}
	return true;
}

async function fetchJsonSafe(url: string, timeoutMs = 15_000): Promise<unknown | null> {
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

type WikiHit = {
	title: string;
	url: string;
	qid: string | null;
	extract: string;
	inception: string | null;
	dissolved: string | null;
};

async function fetchWikidataClaims(qid: string): Promise<{
	enwikiTitle: string | null;
	description: string | null;
	inception: string | null;
	dissolved: string | null;
} | null> {
	if (!qid || !/^Q\d+$/i.test(qid)) return null;
	const data = (await fetchJsonSafe(
		`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=descriptions|claims|sitelinks&languages=en&format=json`,
		12_000,
	)) as Record<string, unknown> | null;
	const entities = (data?.entities || {}) as Record<string, Record<string, unknown>>;
	const ent = entities[qid.toUpperCase()];
	if (!ent) return null;
	const sitelinks = ent.sitelinks as Record<string, { title?: string }> | undefined;
	const descriptions = ent.descriptions as Record<string, { value?: string }> | undefined;
	const claims = ent.claims as Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>> | undefined;
	const claimTime = (prop: string): string | null => {
		const raw = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.time;
		if (!raw) return null;
		const m = String(raw).match(/^\+?(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return null;
		if (m[2] === '00') return m[1]!;
		if (m[3] === '00') return `${m[1]}-${m[2]}`;
		return `${m[1]}-${m[2]}-${m[3]}`;
	};
	return {
		enwikiTitle: sitelinks?.enwiki?.title || null,
		description: descriptions?.en?.value || null,
		inception: claimTime('P571') || claimTime('P569') || claimTime('P580') || claimTime('P585'),
		dissolved: claimTime('P576') || claimTime('P570') || claimTime('P582'),
	};
}

async function fetchWikipediaByTitle(title: string, introOnly = false): Promise<WikiHit | null> {
	if (!title) return null;
	const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=wikibase_item&explaintext=1${introOnly ? '&exintro=1' : '&exsectionformat=plain'}&titles=${encodeURIComponent(title)}&format=json&redirects=1`;
	const data = (await fetchJsonSafe(url, 15_000)) as { query?: { pages?: Record<string, Record<string, unknown>> } } | null;
	const pages = data?.query?.pages || {};
	const page = Object.values(pages)[0];
	if (!page || page.missing != null || !page.extract) return null;
	const extract = String(page.extract || '').trim();
	if (extract.length < 80 || /may refer to:/i.test(extract.slice(0, 220))) return null;
	const qid = ((page.pageprops as Record<string, unknown> | undefined)?.wikibase_item as string | undefined) || null;
	const wd = qid ? await fetchWikidataClaims(qid) : null;
	const resolvedTitle = String(page.title || title);
	return {
		title: resolvedTitle,
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, '_'))}`,
		qid,
		extract,
		inception: wd?.inception || null,
		dissolved: wd?.dissolved || null,
	};
}

async function lookupVerifiedWikipediaForProfile(detail: ProfileDetail): Promise<WikiHit | null> {
	const idCtx = buildProfileIdentityContext(detail);
	const existingQid = detail.identifiers.find((i) => i.scheme === 'wikidata')?.value || null;
	if (existingQid) {
		const wd = await fetchWikidataClaims(existingQid);
		if (wd?.enwikiTitle) {
			const hit = await fetchWikipediaByTitle(wd.enwikiTitle);
			if (hit) return hit;
		}
	}
	const existingWikiUrl = detail.identifiers.find(
		(i) => i.scheme === 'url' && /en\.wikipedia\.org\/wiki\//i.test(i.value) && !/\/wiki\/List_of_/i.test(i.value),
	)?.value;
	if (existingWikiUrl) {
		const m = existingWikiUrl.match(/\/wiki\/([^#?]+)/i);
		if (m) {
			const hit = await fetchWikipediaByTitle(decodeURIComponent(m[1]!).replace(/_/g, ' '));
			if (hit) return hit;
		}
	}

	const cleanName = detail.profile.name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
	if (cleanName.length < 3) return null;
	const search = (await fetchJsonSafe(
		`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanName)}&srlimit=3&format=json`,
		10_000,
	)) as { query?: { search?: Array<{ title?: string }> } } | null;
	const hits = search?.query?.search || [];
	for (const h of hits) {
		const title = String(h.title || '').trim();
		if (!title || /^List of /i.test(title)) continue;
		const art = await fetchWikipediaByTitle(title);
		if (!art) continue;
		const evalRes = evaluateIdentityMatch(idCtx, {
			candidateName: art.title,
			candidateIdentifiers: art.qid ? [{ scheme: 'wikidata', value: art.qid }] : [],
			candidateText: art.extract.slice(0, 2400),
		});
		const normTitle = normalizeText(art.title.replace(/\s*\([^)]*\)\s*$/, ''));
		const normName = normalizeText(cleanName);
		const exactTitle =
			normTitle === normName || normTitle.replace(/^the /, '') === normName.replace(/^the /, '');
		if (
			evalRes.decision === 'validated_merge' ||
			(exactTitle && !evalRes.dateConflict && detail.profile.profileType !== 'person') ||
			(exactTitle && !evalRes.dateConflict && detail.profile.profileType === 'person' && evalRes.score >= 0.45)
		) {
			return art;
		}
	}
	return null;
}

async function lookupProPublica(detail: ProfileDetail): Promise<{
	name: string;
	ein: string;
	city?: string;
	state?: string;
	rulingDate?: string;
	assets?: number;
	income?: number;
	url: string;
} | null> {
	if (detail.profile.profileType !== 'nonprofit') return null;
	const einIdent = detail.identifiers.find((i) => i.scheme === 'irs_ein')?.value || null;
	const digits = einIdent ? einIdent.replace(/\D/g, '') : '';
	if (digits.length !== 9) return null;
	const data = (await fetchJsonSafe(
		`https://projects.propublica.org/nonprofits/api/v2/organizations/${digits}.json`,
		10_000,
	)) as { organization?: Record<string, unknown> } | null;
	const org = data?.organization;
	if (!org?.name) return null;
	return {
		name: String(org.name),
		ein: `${digits.slice(0, 2)}-${digits.slice(2)}`,
		city: org.city ? String(org.city) : undefined,
		state: org.state ? String(org.state) : undefined,
		rulingDate: org.ruling_date ? String(org.ruling_date) : undefined,
		assets: typeof org.asset_amount === 'number' ? org.asset_amount : undefined,
		income: typeof org.income_amount === 'number' ? org.income_amount : undefined,
		url: `https://projects.propublica.org/nonprofits/organizations/${digits}`,
	};
}

/** Stage 1a: Check local profiles.sqlite for duplicate/alias alignments + matching RSS historic_events. */
function runLocalDbCrossChecks(detail: ProfileDetail): {
	duplicateAlignments: number;
	rssEventsLinked: number;
	rssExcerpts: string[];
} {
	const db = getProfilesDb();
	const p = detail.profile;
	const idCtx = buildProfileIdentityContext(detail);
	let duplicateAlignments = 0;
	let rssEventsLinked = 0;
	const rssExcerpts: string[] = [];

	const norm = normalizeText(p.name);
	const stripped = stripLegalSuffixes(p.name);

	// 1. Check potential duplicate profiles (shared external IDs or matching normalized names)
	const dupIds = new Set<string>();
	for (const ident of detail.identifiers) {
		if (!['wikidata', 'finra_crd', 'sec_cik', 'irs_ein', 'ticker', 'ror', 'orcid'].includes(ident.scheme)) continue;
		const rows = db
			.prepare(
				`SELECT profile_id FROM profile_identifiers
         WHERE scheme = ? AND normalized_value = ? AND profile_id != ?
         LIMIT 5`,
			)
			.all(ident.scheme, ident.normalizedValue, p.id) as Array<{ profile_id?: string }>;
		for (const r of rows) if (r.profile_id) dupIds.add(String(r.profile_id));
	}
	if (norm.length >= 4) {
		const nameRows = db
			.prepare(
				`SELECT id FROM profiles
         WHERE id != ? AND status IN ('active', 'pinned')
           AND (normalized_name = ? OR normalized_name = ?)
         LIMIT 8`,
			)
			.all(p.id, norm, stripped) as Array<{ id?: string }>;
		for (const r of nameRows) if (r.id) dupIds.add(String(r.id));
	}

	for (const peerId of dupIds) {
		const peer = getProfileDetail(peerId);
		if (!peer) continue;
		if (p.profileType === 'person' && peer.profile.profileType !== 'person') continue;
		if (p.profileType !== 'person' && peer.profile.profileType === 'person') continue;
		const evalRes = evaluateIdentityMatch(idCtx, {
			candidateName: peer.profile.name,
			candidateAliases: peer.aliases.map((a) => a.alias),
			candidateIdentifiers: peer.identifiers.map((i) => ({ scheme: i.scheme, value: i.value })),
			candidateLocations: peer.locations.map((l) => l.raw),
			candidateStartDate: peer.profile.startDate,
			candidateEndDate: peer.profile.endDate,
			candidateText: `${peer.profile.name} ${peer.profile.summary.slice(0, 800)}`,
		});
		if (evalRes.decision === 'reject') continue;
		const hasSharedId = evalRes.corroborations.some((c) => c.kind === 'shared_identifier');
		const alignKind = hasSharedId
			? 'shared_identifier'
			: evalRes.decision === 'validated_merge'
				? 'same_entity_alias'
				: 'possible_match_name_only';
		const [leftId, rightId] = [p.id, peer.profile.id].sort();
		upsertAlignmentCandidate({
			dedupeKey: sha256Key([PIPELINE_CORPUS, alignKind, leftId, rightId]),
			leftProfileId: p.id,
			rightProfileId: peer.profile.id,
			alignmentKind: alignKind,
			score: evalRes.score,
			cautionTier: hasSharedId || evalRes.decision === 'validated_merge' ? 'stronger_indicator' : 'closer_look',
			rationale: `Auto-validation check: ${evalRes.rationale}`,
			evidence: [
				{
					corpus: PIPELINE_CORPUS,
					label: `Identity validation (${evalRes.decision})`,
					snippet: evalRes.corroborations.map((c) => c.detail).join('; ') || evalRes.rationale,
				},
			],
		});
		duplicateAlignments += 1;
	}

	// 2. Cross-check local RSS historic_event cards mentioning this profile
	if (p.profileType !== 'historic_event' && p.name.trim().length >= 5) {
		const needle = p.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
		const shortNeedle = stripLegalSuffixes(needle);
		const searchTerms = [...new Set([needle, shortNeedle].filter((t) => t.length >= 5))].slice(0, 2);
		const seenEvent = new Set<string>();
		for (const term of searchTerms) {
			const rows = db
				.prepare(
					`SELECT id, slug, name, start_date, substr(summary, 1, 600) AS summary, metadata_json
           FROM profiles
           WHERE profile_type = 'historic_event'
             AND status IN ('active', 'pinned')
             AND (metadata_json LIKE '%newsFeedId%' OR slug LIKE 'historic_event:news-%')
             AND (lower(name) LIKE ? OR lower(summary) LIKE ?)
           ORDER BY COALESCE(start_date, '') DESC
           LIMIT 8`,
				)
				.all(`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`) as Array<{
				id: string;
				slug: string;
				name: string;
				start_date: string | null;
				summary: string;
				metadata_json: string | null;
			}>;
			for (const ev of rows) {
				if (seenEvent.has(ev.id)) continue;
				// Require word-boundary match so short names don't substring-collide
				const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const wb = new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i');
				if (!wb.test(`${ev.name}\n${ev.summary}`)) continue;
				seenEvent.add(ev.id);

				let evUrl: string | null = null;
				try {
					evUrl = (JSON.parse(ev.metadata_json || '{}') as { sourceUrl?: string }).sourceUrl || null;
				} catch {
					evUrl = null;
				}
				upsertProfileLink({
					fromProfileId: p.id,
					toProfileId: ev.id,
					relationType: 'mentioned_in',
					startDate: ev.start_date,
					status: 'observed',
					confidence: 0.85,
					sourceCorpus: PIPELINE_CORPUS,
					evidenceNote: `Matched local RSS event: ${ev.name}`,
				});
				upsertTimelineEntry({
					profileId: p.id,
					eventDate: ev.start_date,
					title: ev.name.slice(0, 180),
					summary: ev.summary.replace(/\s+/g, ' ').trim().slice(0, 420),
					angle: 'general',
					entryKind: 'observation',
					sourceCorpus: PIPELINE_CORPUS,
					dedupeHint: `rss-event|${ev.id}`,
					confidence: 0.85,
					metadata: { linkedProfileId: ev.id, sourceUrl: evUrl, sourceKind: 'rss' },
				});
				rssEventsLinked += 1;
				rssExcerpts.push(
					`[Local RSS Event ${ev.start_date || 'undated'}] ${ev.name}${evUrl ? ` (${evUrl})` : ''}: ${ev.summary.replace(/\s+/g, ' ').slice(0, 320)}`,
				);
			}
		}
	}

	return { duplicateAlignments, rssEventsLinked, rssExcerpts };
}

/** Check recently seen RSS feed state files under .data/news-feeds/*-state.json for matches. */
function checkLocalRssStateFiles(profileName: string): Array<{ title: string; url: string; at: string; feedId: string }> {
	const needle = profileName.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
	if (needle.length < 5) return [];
	const dir = path.join(process.cwd(), '.data', 'news-feeds');
	if (!fs.existsSync(dir)) return [];
	const hits: Array<{ title: string; url: string; at: string; feedId: string }> = [];
	try {
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith('-state.json')) continue;
			const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
				seenUrls?: Record<string, { title?: string; at?: string; feedId?: string }>;
			};
			for (const [url, info] of Object.entries(raw.seenUrls || {})) {
				const title = String(info?.title || '');
				if (title.toLowerCase().includes(needle)) {
					hits.push({
						title,
						url,
						at: String(info?.at || '').slice(0, 10),
						feedId: String(info?.feedId || 'rss'),
					});
					if (hits.length >= 6) return hits;
				}
			}
		}
	} catch {
		/* best effort */
	}
	return hits;
}

type CrawledResource = {
	url: string;
	title: string;
	kind: 'website' | 'pdf' | 'data_layer';
	excerpt: string;
	pdfsExtracted: number;
};

/** Stage 3: Live internet crawl via SearXNG + existing `fetch_url` (websites, PDFs, data layers). */
async function crawlInternetForProfile(detail: ProfileDetail): Promise<{
	queriesRun: number;
	resources: CrawledResource[];
	pdfsExtracted: number;
	dataLayersFound: number;
}> {
	const name = detail.profile.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
	const locHint = detail.locations[0]?.city || detail.locations[0]?.state || '';
	const quoted = `"${name.replace(/"/g, '')}"`;

	const queries: Array<{ q: string; preferKind: 'website' | 'pdf' | 'data_layer' }> = [
		{ q: `${quoted} ${locHint} history timeline official`.replace(/\s+/g, ' ').trim(), preferKind: 'website' },
		{ q: `${quoted} ${locHint} filetype:pdf OR "annual report" OR "filing" OR "press release"`.replace(/\s+/g, ' ').trim(), preferKind: 'pdf' },
		{
			q: `${quoted} ${locHint} ("geojson" OR "arcgis" OR "mapserver" OR "featureserver" OR "dataset" OR "data.gov" OR "registry")`.replace(/\s+/g, ' ').trim(),
			preferKind: 'data_layer',
		},
	];

	const candidateUrls: Array<{ hit: WebSearchHit; kind: 'website' | 'pdf' | 'data_layer' }> = [];
	const seenUrl = new Set<string>();
	let queriesRun = 0;

	for (const item of queries) {
		queriesRun += 1;
		const res = await searchWeb({ query: item.q, limit: 5 });
		if (!res.ok || !res.hits.length) continue;
		for (const hit of res.hits) {
			const cleanUrl = hit.url.split('#')[0] || hit.url;
			if (!cleanUrl || seenUrl.has(cleanUrl)) continue;
			// Skip Wikipedia (already checked directly) and noisy social walls
			if (/(?:wikipedia\.org|wikidata\.org|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com\/in\/)/i.test(cleanUrl)) {
				continue;
			}
			seenUrl.add(cleanUrl);
			const detectedKind: 'website' | 'pdf' | 'data_layer' = PDF_URL_RE.test(cleanUrl)
				? 'pdf'
				: DATA_LAYER_URL_RE.test(cleanUrl)
					? 'data_layer'
					: item.preferKind === 'data_layer' && /\b(?:gis|geojson|arcgis|dataset|shapefile|map layer|data portal|api)\b/i.test(`${hit.title} ${hit.snippet}`)
						? 'data_layer'
						: 'website';
			candidateUrls.push({ hit, kind: detectedKind });
		}
	}

	// Pick a balanced mix: up to 1 PDF, 1 data layer, and 2 primary websites (total <= MAX_CRAWL_URLS)
	const picked: Array<{ hit: WebSearchHit; kind: 'website' | 'pdf' | 'data_layer' }> = [];
	const takeFirst = (kind: 'website' | 'pdf' | 'data_layer', count: number) => {
		let taken = 0;
		for (const c of candidateUrls) {
			if (c.kind !== kind || picked.includes(c)) continue;
			picked.push(c);
			taken += 1;
			if (taken >= count || picked.length >= MAX_CRAWL_URLS) break;
		}
	};
	takeFirst('pdf', 1);
	takeFirst('data_layer', 1);
	takeFirst('website', MAX_CRAWL_URLS);
	for (const c of candidateUrls) {
		if (picked.length >= MAX_CRAWL_URLS) break;
		if (!picked.includes(c)) picked.push(c);
	}

	const resources: CrawledResource[] = [];
	let totalPdfs = 0;
	let totalDataLayers = 0;

	for (const item of picked) {
		try {
			const fetched = await runResearchTool('fetch_url', {
				url: item.hit.url,
				maxPdfs: 2,
			});
			const payload = (fetched.result || {}) as Record<string, unknown>;
			const contentType = String(payload.contentType || '');
			const isPdf = item.kind === 'pdf' || /application\/pdf/i.test(contentType);
			const isDataLayer =
				item.kind === 'data_layer' ||
				/application\/(?:geo\+)?json|text\/csv/i.test(contentType) ||
				DATA_LAYER_URL_RE.test(item.hit.url);

			const pdfDownloads = Array.isArray(payload.pdfDownloads)
				? (payload.pdfDownloads as Array<Record<string, unknown>>)
				: [];
			const pdfExcerpts = pdfDownloads
				.map((d) => String(d.textPreview || d.text || '').trim())
				.filter((t) => t.length >= 40)
				.slice(0, 2);

			const pdfCount = (isPdf ? 1 : 0) + pdfDownloads.length;
			totalPdfs += pdfCount;
			if (isDataLayer) totalDataLayers += 1;

			const bodyText = String(payload.text || payload.body || payload.preview || item.hit.snippet || '')
				.replace(/\s+/g, ' ')
				.trim();
			const combinedExcerpt = [bodyText.slice(0, 1800), ...pdfExcerpts.map((p) => `[PDF] ${p.slice(0, 900)}`)]
				.filter(Boolean)
				.join('\n')
				.slice(0, 2400);

			if (combinedExcerpt.length >= 60) {
				resources.push({
					url: item.hit.url,
					title: String(payload.title || item.hit.title || item.hit.url),
					kind: isPdf ? 'pdf' : isDataLayer ? 'data_layer' : 'website',
					excerpt: combinedExcerpt,
					pdfsExtracted: pdfCount,
				});
			}
		} catch {
			if (item.hit.snippet.length >= 50) {
				resources.push({
					url: item.hit.url,
					title: item.hit.title,
					kind: item.kind,
					excerpt: item.hit.snippet,
					pdfsExtracted: 0,
				});
			}
		}
	}

	return {
		queriesRun,
		resources,
		pdfsExtracted: totalPdfs,
		dataLayersFound: totalDataLayers,
	};
}

type SynthesizedMilestone = {
	date: string;
	title: string;
	summary: string;
	sourceUrl?: string | null;
	sourceKind?: string | null;
};

type DiscoveredEntity = {
	name: string;
	profileType: ProfileType;
	role: string | null;
	affiliation: string | null;
	location: string | null;
	milestone: string;
	relationType: ProfileRelationType;
};

function refineEntityType(entity: DiscoveredEntity, wikiHit: WikiHit | null): ProfileType {
	if (entity.profileType === 'person' || entity.profileType === 'historic_event') return entity.profileType;
	const name = entity.name;
	const wikiLead = String(wikiHit?.extract || '').slice(0, 280).toLowerCase();
	if (entity.profileType === 'medical_hospital' && !HOSPITAL_NAME_CUE_RE.test(name) && !/\bhospital|medical center|clinic\b/.test(wikiLead)) {
		return classifyOrgType(name);
	}
	if (entity.profileType === 'education' && !EDUCATION_NAME_CUE_RE.test(name) && !/\buniversity|college|school\b/.test(wikiLead)) {
		return classifyOrgType(name);
	}
	if (/\b(?:stock exchange|airways|airlines?|corporation|company|inc\.?|llc|ltd\.?|plc|group|capital|ventures|partners|technologies|solutions|systems|data centers?|grid|energy|space)\b/i.test(name)) {
		return 'firm';
	}
	if (/\b(?:stock exchange|airline|public company|private company|corporation|multinational|conglomerate)\b/.test(wikiLead)) {
		return 'firm';
	}
	if (/\b(?:united nations|federal agency|government agency|executive department|ministry|district court|court of appeals|supreme court|commission|bureau|office of personnel|administration|force|army|navy|air force|marines|police department)\b/i.test(`${name} ${wikiLead}`)) {
		return 'government';
	}
	if (/\b(?:trade union|labor union|labour union|federation of|association|foundation|charity|nonprofit|non-profit)\b/i.test(`${name} ${wikiLead}`)) {
		return 'nonprofit';
	}
	return entity.profileType;
}

/** Stage 4: Use the existing Ollama "auto"-routed model to extract grounded milestones & discovered entities. */
async function extractMilestonesAndEntitiesWithAutoModel(
	detail: ProfileDetail,
	evidenceBundle: string,
	model: string,
): Promise<{
	lead: string;
	milestones: SynthesizedMilestone[];
	entities: DiscoveredEntity[];
}> {
	const p = detail.profile;
	const prompt = `Analyze the verified research material below for "${p.name}" (profile type: ${p.profileType}).

Return STRICT JSON ONLY with this exact shape:
{
  "lead": "Concise 2-3 sentence overview paragraph grounded ONLY in the material below.",
  "milestones": [
    {
      "date": "YYYY or Month YYYY or Month DD, YYYY (real dates from the sources only)",
      "title": "Short milestone headline (<= 100 chars)",
      "summary": "1-2 sentence grounded factual milestone",
      "sourceUrl": "exact URL from sources or null",
      "sourceKind": "website|pdf|data_layer|api|rss|local"
    }
  ],
  "entities": [
    {
      "name": "Specific named person, firm, agency, nonprofit, university, hospital, or historic event mentioned in the profile or crawled sources (NEVER the profile itself, NEVER generic groups, countries/cities, or news outlets)",
      "profileType": "person|firm|government|nonprofit|education|medical_hospital|historic_event",
      "role": "concise role/title or null",
      "affiliation": "employer/parent org or null",
      "location": "city/state/country if stated or null",
      "milestone": "1-2 sentence factual connection/claim involving this entity",
      "relationType": "participated_in|affiliated_with|business_tie|employed_by|mentioned_in"
    }
  ]
}

Rules:
- Milestones: extract 3 to 8 dated milestones sorted NEWEST first. NEVER invent dates or facts.
- Entities: extract up to ${MAX_ENTITIES} specifically named actors/events (full names for people). Exclude "${p.name}" itself.
- Output ONLY valid JSON (no markdown fences, no commentary).

=== VERIFIED RESEARCH MATERIAL ===
${evidenceBundle.slice(0, 10_500)}`;

	const { message } = await ollamaChat({
		model,
		numCtx: 12288,
		messages: [
			{
				role: 'system',
				content:
					'You are a careful local research analyst. Never hallucinate dates or facts. Output valid JSON only.',
			},
			{ role: 'user', content: prompt },
		],
	});

	let raw = assistantMessageText(message).trim();
	if (/^```/.test(raw)) {
		raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		const m = raw.match(/\{[\s\S]*\}/);
		if (m) {
			try {
				parsed = JSON.parse(m[0]) as Record<string, unknown>;
			} catch {
				parsed = {};
			}
		}
	}

	const lead = typeof parsed.lead === 'string' ? parsed.lead.replace(/\s+/g, ' ').trim() : '';
	const rawMilestones = Array.isArray(parsed.milestones) ? parsed.milestones : [];
	const milestones: SynthesizedMilestone[] = [];
	const seenM = new Set<string>();
	for (const m of rawMilestones as Array<Record<string, unknown>>) {
		const date = String(m?.date || '').trim();
		const title = String(m?.title || '').replace(/\s+/g, ' ').trim();
		const summary = String(m?.summary || '').replace(/\s+/g, ' ').trim();
		if (!date || (!title && !summary)) continue;
		if (!/\b(?:1[6-9]|20)\d{2}\b/.test(date)) continue;
		const key = `${date.toLowerCase()}|${(title || summary).toLowerCase().slice(0, 50)}`;
		if (seenM.has(key)) continue;
		seenM.add(key);
		milestones.push({
			date,
			title: (title || summary).slice(0, 160),
			summary: (summary || title).slice(0, 600),
			sourceUrl: typeof m?.sourceUrl === 'string' && /^https?:\/\//i.test(m.sourceUrl) ? m.sourceUrl : null,
			sourceKind: typeof m?.sourceKind === 'string' ? m.sourceKind : null,
		});
		if (milestones.length >= 10) break;
	}

	const selfNorm = normalizeText(p.name);
	const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
	const entities: DiscoveredEntity[] = [];
	const seenE = new Set<string>();
	for (const item of rawEntities as Array<Record<string, unknown>>) {
		const name = String(item?.name || '').replace(/\s+/g, ' ').trim();
		const pType = String(item?.profileType || '').trim().toLowerCase() as ProfileType;
		if (!name || name.length < 3 || name.length > 120) continue;
		if (!VALID_ENTITY_TYPES.has(pType)) continue;
		if (normalizeText(name) === selfNorm) continue;
		if (NEWS_OUTLET_SKIP_RE.test(name) || GEO_OR_CONCEPT_SKIP_RE.test(name)) continue;
		if (pType === 'person' && !/\s/.test(name)) continue;
		if (
			/^(?:the\s+)?(?:united states|u\.s\.|uk|britain|israel|egypt|texas|oklahoma|china|russia|iran|europe|eu|european union|gaza|cairo)$/i.test(
				name,
			)
		) {
			continue;
		}
		const key = `${pType === 'person' ? 'person' : 'org'}:${normalizeText(name)}`;
		if (seenE.has(key)) continue;
		seenE.add(key);
		const relRaw = String(item?.relationType || 'mentioned_in').trim().toLowerCase();
		const relationType: ProfileRelationType = (
			['participated_in', 'affiliated_with', 'business_tie', 'employed_by', 'mentioned_in'].includes(relRaw)
				? relRaw
				: 'mentioned_in'
		) as ProfileRelationType;
		entities.push({
			name,
			profileType: pType,
			role: item?.role ? String(item.role).trim().slice(0, 140) : null,
			affiliation: item?.affiliation ? String(item.affiliation).trim().slice(0, 140) : null,
			location: item?.location ? String(item.location).trim().slice(0, 120) : null,
			milestone: String(item?.milestone || '').replace(/\s+/g, ' ').trim().slice(0, 420),
			relationType,
		});
		if (entities.length >= MAX_ENTITIES) break;
	}

	return { lead, milestones, entities };
}

/** Stage 5: Match discovered entity via strong ID + fuzzy name (`identity.ts`), then update or create. */
async function matchUpdateOrCreateDiscoveredEntity(
	entity: DiscoveredEntity,
	parentDetail: ProfileDetail,
): Promise<{
	action: 'updated' | 'created' | 'skipped_ambiguous';
	slug: string | null;
}> {
	const db = getProfilesDb();
	// Quick Wikipedia/Wikidata ID lookup for strong ID matching
	let wikiHit: WikiHit | null = null;
	try {
		const search = (await fetchJsonSafe(
			`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(entity.name)}&srlimit=2&format=json`,
			8_000,
		)) as { query?: { search?: Array<{ title?: string }> } } | null;
		const normName = normalizeText(entity.name);
		const strippedName = stripLegalSuffixes(entity.name);
		for (const h of search?.query?.search || []) {
			const t = String(h.title || '').trim();
			if (!t || /^List of /i.test(t)) continue;
			const tn = normalizeText(t.replace(/\s*\([^)]*\)\s*$/, ''));
			const ts = stripLegalSuffixes(t.replace(/\s*\([^)]*\)\s*$/, ''));
			if (tn === normName || ts === strippedName || tn.replace(/^the /, '') === normName.replace(/^the /, '')) {
				const art = await fetchWikipediaByTitle(t, true);
				if (art) {
					if (entity.profileType === 'person') {
						const hay = art.extract.toLowerCase();
						const cues = [entity.affiliation, entity.role, entity.location]
							.filter(Boolean)
							.flatMap((c) => normalizeText(String(c)).split(' '))
							.filter((w) => w.length >= 4 && !/^(?:president|director|vice|chief|staff|officer|member|senior|former)$/.test(w));
						if (cues.length > 0 && !cues.some((w) => hay.includes(w))) continue;
					}
					wikiHit = art;
					break;
				}
			}
		}
	} catch {
		/* best effort */
	}

	entity.profileType = refineEntityType(entity, wikiHit);

	const candidateIds = new Set<string>();
	if (wikiHit?.qid) {
		const rows = db
			.prepare(`SELECT profile_id FROM profile_identifiers WHERE scheme = 'wikidata' AND upper(value) = upper(?) LIMIT 5`)
			.all(wikiHit.qid) as Array<{ profile_id?: string }>;
		for (const r of rows) if (r.profile_id) candidateIds.add(String(r.profile_id));
	}
	if (wikiHit?.url) {
		const rows = db
			.prepare(`SELECT profile_id FROM profile_identifiers WHERE scheme = 'url' AND lower(value) = lower(?) LIMIT 5`)
			.all(wikiHit.url) as Array<{ profile_id?: string }>;
		for (const r of rows) if (r.profile_id) candidateIds.add(String(r.profile_id));
	}

	const norm = normalizeText(entity.name);
	const stripped = stripLegalSuffixes(entity.name);
	const expectedSlug = makeProfileSlug(entity.profileType, entity.name);

	const exactRows = db
		.prepare(
			`SELECT id FROM profiles
       WHERE status IN ('active', 'pinned')
         AND id != ?
         AND (slug = ? OR normalized_name = ? OR normalized_name = ?)
       LIMIT 10`,
		)
		.all(parentDetail.profile.id, expectedSlug, norm, stripped) as Array<{ id?: string }>;
	for (const r of exactRows) if (r.id) candidateIds.add(String(r.id));

	const aliasRows = db
		.prepare(
			`SELECT pa.profile_id FROM profile_aliases pa
       JOIN profiles p ON p.id = pa.profile_id
       WHERE p.status IN ('active', 'pinned')
         AND p.id != ?
         AND (pa.normalized_alias = ? OR pa.normalized_alias = ?)
       LIMIT 10`,
		)
		.all(parentDetail.profile.id, norm, stripped) as Array<{ profile_id?: string }>;
	for (const r of aliasRows) if (r.profile_id) candidateIds.add(String(r.profile_id));

	if (entity.profileType !== 'person' && entity.profileType !== 'historic_event') {
		const orgHit = findExistingOrgByNameOrAlias(entity.name, entity.profileType);
		if (orgHit && orgHit.id !== parentDetail.profile.id) {
			candidateIds.add(orgHit.id);
		}
	}

	const tokens = norm.split(' ').filter((t) => t.length >= 3);
	if (tokens.length > 0) {
		const keyTok = entity.profileType === 'person' ? tokens[tokens.length - 1]! : tokens[0]!;
		const fuzzyRows = (
			entity.profileType === 'person'
				? db
						.prepare(
							`SELECT id FROM profiles WHERE status IN ('active','pinned') AND id != ? AND profile_type = 'person' AND normalized_name LIKE ? LIMIT 20`,
						)
						.all(parentDetail.profile.id, `%${keyTok}%`)
				: db
						.prepare(
							`SELECT id FROM profiles WHERE status IN ('active','pinned') AND id != ? AND profile_type IN ('firm','government','nonprofit','education','medical_hospital','historic_event') AND normalized_name LIKE ? LIMIT 25`,
						)
						.all(parentDetail.profile.id, `%${keyTok}%`)
		) as Array<{ id?: string }>;
		for (const r of fuzzyRows) if (r.id) candidateIds.add(String(r.id));
	}

	const candInput = {
		candidateName: entity.name,
		candidateAliases: wikiHit?.title && wikiHit.title !== entity.name ? [wikiHit.title] : [],
		candidateIdentifiers: [
			...(wikiHit?.qid ? [{ scheme: 'wikidata', value: wikiHit.qid }] : []),
			...(wikiHit?.url ? [{ scheme: 'url', value: wikiHit.url }] : []),
		],
		candidateLocations: entity.location ? [entity.location] : [],
		candidateFirms: entity.affiliation ? [entity.affiliation] : [],
		candidateInstitutions: entity.affiliation ? [entity.affiliation] : [],
		candidateStartDate: wikiHit?.inception || null,
		candidateText: `${entity.name} ${entity.role || ''} ${entity.affiliation || ''} ${entity.location || ''} ${entity.milestone} ${wikiHit?.extract || ''} ${parentDetail.profile.name}`,
	};

	let bestMatch: {
		detail: ProfileDetail;
		score: number;
		hasSharedId: boolean;
		evalRes: ReturnType<typeof evaluateIdentityMatch>;
	} | null = null;
	let ambiguousDetail: ProfileDetail | null = null;

	for (const pid of candidateIds) {
		const detail = getProfileDetail(pid);
		if (!detail) continue;
		if (entity.profileType === 'person' && detail.profile.profileType !== 'person') continue;
		if (entity.profileType !== 'person' && detail.profile.profileType === 'person') continue;
		const idCtx = buildProfileIdentityContext(detail);
		const evalRes = evaluateIdentityMatch(idCtx, candInput);
		const hasSharedId = evalRes.corroborations.some((c) => c.kind === 'shared_identifier');
		const exactName =
			normalizeText(detail.profile.name) === norm ||
			stripLegalSuffixes(detail.profile.name) === stripped;
		const isStrong =
			(hasSharedId && !evalRes.dateConflict) ||
			evalRes.decision === 'validated_merge' ||
			(entity.profileType !== 'person' && (exactName || evalRes.nameMatch === 'exact_name') && !evalRes.dateConflict);
		if (isStrong) {
			if (!bestMatch || evalRes.score > bestMatch.score || (hasSharedId && !bestMatch.hasSharedId)) {
				bestMatch = { detail, score: evalRes.score, hasSharedId, evalRes };
			}
		} else if (evalRes.decision === 'name_only_note' || exactName) {
			ambiguousDetail = detail;
		}
	}

	const eventDate = parentDetail.profile.startDate || null;

	if (bestMatch) {
		const existing = bestMatch.detail.profile;
		const allowLocationUpdate = hasStrongLocationAlignments(bestMatch.evalRes, 2);
		if (wikiHit?.qid && !bestMatch.detail.identifiers.some((i) => i.scheme === 'wikidata')) {
			addIdentifier({ profileId: existing.id, scheme: 'wikidata', value: wikiHit.qid, sourceCorpus: PIPELINE_CORPUS });
		}
		if (wikiHit?.url && !bestMatch.detail.identifiers.some((i) => i.scheme === 'url' && /wikipedia\.org/i.test(i.value))) {
			addIdentifier({ profileId: existing.id, scheme: 'url', value: wikiHit.url, sourceCorpus: PIPELINE_CORPUS });
		}
		if (entity.location && allowLocationUpdate && bestMatch.detail.locations.length === 0) {
			addLocation({ profileId: existing.id, raw: entity.location, role: 'associated', sourceCorpus: PIPELINE_CORPUS });
		}
		if (normalizeText(entity.name) !== normalizeText(existing.name)) {
			addAlias({ profileId: existing.id, alias: entity.name, aliasKind: 'name', sourceCorpus: PIPELINE_CORPUS });
		}
		upsertProfileLink({
			fromProfileId: existing.id,
			toProfileId: parentDetail.profile.id,
			relationType: entity.relationType,
			roleLabel: entity.role,
			startDate: eventDate,
			status: 'observed',
			confidence: Math.max(0.8, Math.min(0.98, bestMatch.score || 0.85)),
			sourceCorpus: PIPELINE_CORPUS,
			evidenceNote: entity.milestone || `Discovered from ${parentDetail.profile.name}`,
		});
		if (existing.profileType === 'person' && entity.affiliation) {
			try {
				addPersonEmployment({
					personIdOrSlug: existing.id,
					orgName: entity.affiliation,
					role: entity.role,
					location: entity.location,
					notes: entity.milestone,
					sourceCorpus: PIPELINE_CORPUS,
					skipLocationUpdate: !allowLocationUpdate,
					skipOrgLocationUpdate: true,
				});
			} catch {
				/* non-fatal */
			}
		}
		if (entity.milestone) {
			upsertTimelineEntry({
				profileId: existing.id,
				eventDate,
				title: parentDetail.profile.name.slice(0, 180),
				summary: entity.milestone.slice(0, 600),
				angle: 'general',
				entryKind: 'observation',
				sourceCorpus: PIPELINE_CORPUS,
				dedupeHint: `${parentDetail.profile.id}|${entity.name}`,
				confidence: 0.88,
				metadata: { linkedProfileId: parentDetail.profile.id },
			});
		}
		return { action: 'updated', slug: existing.slug };
	}

	let customSlug: string | undefined;
	if (ambiguousDetail) {
		if (entity.profileType === 'person' && entity.affiliation) {
			customSlug = makeProfileSlug(
				'person',
				`${entity.name} ${entity.affiliation.split(/\s+/).slice(0, 2).join(' ')}`,
			);
		} else {
			return { action: 'skipped_ambiguous', slug: ambiguousDetail.profile.slug };
		}
	}

	// Build grounded lead + ## Timeline summary for newly discovered profile
	const lead =
		wikiHit?.extract
			? wikiHit.extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim()
			: `${entity.name}${entity.role ? ` — ${entity.role}` : ''}${entity.affiliation ? ` (${entity.affiliation})` : ''}${entity.location ? `, ${entity.location}` : ''}.`;
	const bullets: string[] = [];
	if (entity.milestone) {
		bullets.push(`- **${eventDate || 'Undated'}** — ${entity.milestone}`);
	}
	if (wikiHit?.inception) {
		const verb = entity.profileType === 'person' ? 'Born' : 'Founded / established';
		bullets.push(`- **${wikiHit.inception}** — ${verb} (${wikiHit.title}).`);
	}
	const summaryLines = [lead, '', '## Timeline', ...(bullets.length ? bullets : [`- **${eventDate || 'Undated'}** — Associated with ${parentDetail.profile.name}.`])];
	if (wikiHit?.url) {
		summaryLines.push('', '## Sources', `- ${wikiHit.url}`);
	}
	const newSummary = `${summaryLines.join('\n').trim()}\n`;

	const created = upsertProfile({
		profileType: entity.profileType,
		name: entity.name,
		slug: customSlug,
		status: 'active',
		summary: newSummary,
		startDate: wikiHit?.inception ? normalizeIsoDate(wikiHit.inception).date : null,
		sourceCorpus: PIPELINE_CORPUS,
		metadata: {
			discoveredFromProfileSlug: parentDetail.profile.slug,
			discoveredRole: entity.role,
			discoveredAffiliation: entity.affiliation,
			overviewStyle: 'lead_plus_timeline_rail',
			formatMode: 'dated_expressive',
		},
	});
	if (wikiHit?.qid) addIdentifier({ profileId: created.id, scheme: 'wikidata', value: wikiHit.qid, sourceCorpus: PIPELINE_CORPUS });
	if (wikiHit?.url) addIdentifier({ profileId: created.id, scheme: 'url', value: wikiHit.url, sourceCorpus: PIPELINE_CORPUS });
	if (entity.location) addLocation({ profileId: created.id, raw: entity.location, role: 'associated', sourceCorpus: PIPELINE_CORPUS });

	upsertProfileLink({
		fromProfileId: created.id,
		toProfileId: parentDetail.profile.id,
		relationType: entity.relationType,
		roleLabel: entity.role,
		startDate: eventDate,
		status: 'observed',
		confidence: 0.88,
		sourceCorpus: PIPELINE_CORPUS,
		evidenceNote: entity.milestone || `Discovered from ${parentDetail.profile.name}`,
	});
	if (created.profileType === 'person' && entity.affiliation) {
		try {
			addPersonEmployment({
				personIdOrSlug: created.id,
				orgName: entity.affiliation,
				role: entity.role,
				location: entity.location,
				notes: entity.milestone,
				sourceCorpus: PIPELINE_CORPUS,
				skipOrgLocationUpdate: true,
			});
		} catch {
			/* non-fatal */
		}
	}
	syncSummaryTimelineToEntries(created.id, { summary: newSummary });
	return { action: 'created', slug: created.slug };
}

function saveStatusMetadata(profileId: string, status: AutoResearchStatus): void {
	try {
		updateProfileFields(profileId, {
			metadata: {
				autoResearch: status,
			},
		});
	} catch {
		/* best effort */
	}
}

/**
 * Execute the full automatic validation + API/RSS + internet crawl + Ollama "auto"
 * milestone & entity discovery pipeline for a created or updated profile.
 */
export async function runAutoProfileResearchPipeline(
	profileId: string,
	opts: { trigger?: 'create' | 'update' | 'manual'; force?: boolean } = {},
): Promise<AutoResearchStatus | null> {
	const state = getGlobalState();
	if (state.running.has(profileId)) return null;
	state.running.add(profileId);

	const status: AutoResearchStatus = {
		status: 'running',
		trigger: opts.trigger || 'update',
		startedAt: new Date().toISOString(),
		model: null,
		stages: {
			localValidation: {
				enrichValidatedSources: 0,
				duplicateAlignments: 0,
				rssEventsLinked: 0,
				rssFeedHits: 0,
			},
			apiLookup: {
				wikipedia: false,
				wikidataQid: null,
				propublica: false,
			},
			internetCrawl: {
				queriesRun: 0,
				urlsCrawled: 0,
				pdfsExtracted: 0,
				dataLayersFound: 0,
				milestonesAdded: 0,
				agentFallbackUsed: false,
			},
			entitiesDiscovered: {
				extracted: 0,
				matchedUpdated: 0,
				created: 0,
				skippedAmbiguous: 0,
				slugs: [],
			},
			summaryUpgraded: false,
		},
		error: null,
	};

	saveStatusMetadata(profileId, status);

	try {
		let detail = getProfileDetail(profileId);
		if (!detail) {
			status.status = 'failed';
			status.error = 'Profile not found';
			status.finishedAt = new Date().toISOString();
			return status;
		}

		// 1. Resolve "auto" Ollama model using existing orchestrator
		const tags = await ollamaTags();
		const route = await routeResearchModel({
			question: `Research and extract dated milestones and named entities for ${detail.profile.name}`,
			availableModels: tags.models,
		});
		const autoModel = route.model;
		status.model = autoModel;

		// 2. Stage 1 — Local validation checks (built-in enrichProfile + DB duplicate/RSS cross-checks)
		try {
			const enrichReport = await enrichProfile(profileId, {
				includeWikipedia: true,
				includeBrokercheck: true,
				includeKnowledge: true,
				includeBryanUcc: true,
				includeFreeOrgEnrich: true,
			});
			status.stages.localValidation.enrichValidatedSources = enrichReport?.validatedSources ?? 0;
		} catch {
			/* continue even if one local source errors */
		}

		detail = getProfileDetail(profileId) || detail;
		const localCross = runLocalDbCrossChecks(detail);
		status.stages.localValidation.duplicateAlignments = localCross.duplicateAlignments;
		status.stages.localValidation.rssEventsLinked = localCross.rssEventsLinked;

		const rssStateHits = checkLocalRssStateFiles(detail.profile.name);
		status.stages.localValidation.rssFeedHits = rssStateHits.length;

		// 3. Stage 2 — External APIs (Wikipedia / Wikidata / ProPublica)
		const wikiHit = await lookupVerifiedWikipediaForProfile(detail);
		if (wikiHit) {
			status.stages.apiLookup.wikipedia = true;
			status.stages.apiLookup.wikidataQid = wikiHit.qid;
			if (wikiHit.qid && !detail.identifiers.some((i) => i.scheme === 'wikidata')) {
				addIdentifier({ profileId, scheme: 'wikidata', value: wikiHit.qid, sourceCorpus: PIPELINE_CORPUS });
			}
			if (!detail.identifiers.some((i) => i.scheme === 'url' && /wikipedia\.org/i.test(i.value))) {
				addIdentifier({ profileId, scheme: 'url', value: wikiHit.url, sourceCorpus: PIPELINE_CORPUS });
			}
			if (!detail.profile.startDate && wikiHit.inception) {
				const normStart = normalizeIsoDate(wikiHit.inception).date;
				if (normStart) updateProfileFields(profileId, { startDate: normStart });
			}
			if (!detail.profile.endDate && wikiHit.dissolved) {
				const normEnd = normalizeIsoDate(wikiHit.dissolved).date;
				if (normEnd) updateProfileFields(profileId, { endDate: normEnd });
			}
		}

		const pp = await lookupProPublica(detail);
		if (pp) status.stages.apiLookup.propublica = true;

		// 4. Stage 3 — New Internet Crawl for websites, PDFs, and data layers
		const crawl = await crawlInternetForProfile(detail);
		status.stages.internetCrawl.queriesRun = crawl.queriesRun;
		status.stages.internetCrawl.urlsCrawled = crawl.resources.length;
		status.stages.internetCrawl.pdfsExtracted = crawl.pdfsExtracted;
		status.stages.internetCrawl.dataLayersFound = crawl.dataLayersFound;

		// Assemble grounded evidence bundle for Ollama "auto" extraction
		detail = getProfileDetail(profileId) || detail;
		const bundleParts: string[] = [
			`Profile Name: ${detail.profile.name}`,
			`Profile Type: ${detail.profile.profileType}`,
		];
		if (detail.profile.startDate) bundleParts.push(`Start Date: ${detail.profile.startDate}`);
		if (detail.profile.endDate) bundleParts.push(`End Date: ${detail.profile.endDate}`);
		if (detail.profile.summary.trim()) {
			bundleParts.push(`Current Profile Summary:\n${detail.profile.summary.slice(0, 3200)}`);
		}
		if (detail.locations.length) {
			bundleParts.push(`Locations: ${detail.locations.slice(0, 5).map((l) => l.raw).join('; ')}`);
		}
		if (wikiHit) {
			bundleParts.push(`Wikipedia (${wikiHit.title} — ${wikiHit.url}):\n${wikiHit.extract.slice(0, 3500)}`);
		}
		if (pp) {
			bundleParts.push(
				`ProPublica Nonprofits (EIN ${pp.ein}, ${pp.url}): ${pp.name}, ${pp.city || ''}, ${pp.state || ''}, ruling=${pp.rulingDate || 'n/a'}, assets=${pp.assets ?? 'n/a'}`,
			);
		}
		if (localCross.rssExcerpts.length) {
			bundleParts.push(`Local RSS Events:\n${localCross.rssExcerpts.join('\n')}`);
		}
		if (rssStateHits.length) {
			bundleParts.push(
				`Recent RSS Feed Matches:\n${rssStateHits.map((r) => `- [${r.at} | ${r.feedId}] ${r.title} (${r.url})`).join('\n')}`,
			);
		}
		if (crawl.resources.length) {
			bundleParts.push(
				`Crawled Internet Resources (Websites / PDFs / Data Layers):\n${crawl.resources
					.map((r) => `--- [${r.kind.toUpperCase()}] ${r.title} (${r.url}) ---\n${r.excerpt}`)
					.join('\n\n')}`,
			);
		}

		// Optional AI App "auto" Research Agent fallback when evidence is still thin
		if (!wikiHit && crawl.resources.length === 0 && detail.profile.summary.trim().length < 240) {
			try {
				const agentRes = await runResearchAgent({
					question: `Research "${detail.profile.name}" (${detail.profile.profileType}). Find verified dates, key milestones, official websites, PDFs, or datasets, and key connected people or organizations. Cite only verified facts and URLs.`,
					model: RESEARCH_AUTO_MODEL,
				});
				if (agentRes.ok && agentRes.answer && agentRes.answer.length >= 120) {
					status.stages.internetCrawl.agentFallbackUsed = true;
					bundleParts.push(`AI App Auto Research Agent Findings:\n${agentRes.answer.slice(0, 2600)}`);
				}
			} catch {
				/* non-fatal */
			}
		}

		// 5. Stage 4 — Ollama "auto" extraction of milestones & discovered named entities
		const extracted = await extractMilestonesAndEntitiesWithAutoModel(
			detail,
			bundleParts.join('\n\n'),
			autoModel,
		);

		// Add discovered dated milestones to timeline_entries
		for (const m of extracted.milestones) {
			const normDate = normalizeIsoDate(m.date).date;
			upsertTimelineEntry({
				profileId,
				eventDate: normDate,
				title: m.title,
				summary: m.summary,
				angle: 'general',
				entryKind: 'observation',
				sourceCorpus: PIPELINE_CORPUS,
				dedupeHint: `${normDate || m.date}|${m.title.slice(0, 70)}`,
				confidence: 0.88,
				metadata: {
					sourceUrl: m.sourceUrl || null,
					sourceKind: m.sourceKind || 'website',
					rawDateLabel: m.date,
				},
			});
			status.stages.internetCrawl.milestonesAdded += 1;
		}

		// Upgrade Overview summary into lead + ## Timeline ONLY if it is currently sparse (< 260c or no ## Timeline)
		const latestBeforeUpgrade = getProfile(profileId);
		const currentSum = String(latestBeforeUpgrade?.summary || '').trim();
		const needsSummaryUpgrade =
			extracted.milestones.length >= 2 &&
			(currentSum.length < 260 || !summaryAlreadyHasTimelinedView(currentSum));
		if (needsSummaryUpgrade && latestBeforeUpgrade) {
			const leadText = extracted.lead || currentSum || `${latestBeforeUpgrade.name}.`;
			const tlLines = extracted.milestones.map((m) => `- **${m.date}** — ${m.summary}`);
			const srcUrls = [
				...new Set([
					...(wikiHit?.url ? [wikiHit.url] : []),
					...(pp?.url ? [pp.url] : []),
					...crawl.resources.map((r) => r.url),
					...extracted.milestones.map((m) => m.sourceUrl).filter((u): u is string => Boolean(u)),
				]),
			].slice(0, 6);
			const nextSummaryLines = [leadText, '', '## Timeline', ...tlLines];
			if (srcUrls.length) {
				nextSummaryLines.push('', '## Sources', ...srcUrls.map((u) => `- ${u}`));
			}
			const nextRaw = `${nextSummaryLines.join('\n').trim()}\n`;
			const reordered = await ensureSummaryTimelineNewestFirst(nextRaw, { useOllama: false });
			updateProfileFields(profileId, {
				summary: reordered.summary,
				metadata: {
					overviewStyle: 'lead_plus_timeline_rail',
					formatMode: 'dated_expressive',
				},
			});
			syncSummaryTimelineToEntries(profileId, { summary: reordered.summary });
			status.stages.summaryUpgraded = true;
		}

		// 6. Stage 5 — Strong ID + Fuzzy Name Matching → update or create profiles for discovered names
		detail = getProfileDetail(profileId) || detail;
		status.stages.entitiesDiscovered.extracted = extracted.entities.length;
		for (const ent of extracted.entities) {
			try {
				const res = await matchUpdateOrCreateDiscoveredEntity(ent, detail);
				if (res.action === 'updated') {
					status.stages.entitiesDiscovered.matchedUpdated += 1;
					if (res.slug) status.stages.entitiesDiscovered.slugs.push(res.slug);
				} else if (res.action === 'created') {
					status.stages.entitiesDiscovered.created += 1;
					if (res.slug) status.stages.entitiesDiscovered.slugs.push(res.slug);
				} else {
					status.stages.entitiesDiscovered.skippedAmbiguous += 1;
				}
			} catch {
				/* continue on single entity failure */
			}
		}

		status.status = 'completed';
		status.finishedAt = new Date().toISOString();
		saveStatusMetadata(profileId, status);
		return status;
	} catch (error: unknown) {
		status.status = 'failed';
		status.error = error instanceof Error ? error.message : String(error);
		status.finishedAt = new Date().toISOString();
		saveStatusMetadata(profileId, status);
		return status;
	} finally {
		state.running.delete(profileId);
		state.lastFinishedAt.set(profileId, Date.now());
	}
}
