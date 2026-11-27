#!/usr/bin/env node
/**
 * Crawl named entities (people, firms, government agencies, nonprofits, universities,
 * hospitals) from existing articles / historic_event profiles, verify external IDs
 * (Wikipedia/Wikidata), and run STRONG ID + FUZZY NAME MATCHING via identity.ts:
 *
 *  - Strong ID match (Wikidata QID, URL, CRD, CIK, EIN, ticker) OR validated fuzzy/exact
 *    name + corroboration match → UPDATE the existing profile (add identifiers/locations/
 *    employment/article link + timeline entry; upgrade summary to milestone timeline if sparse).
 *  - Ambiguous name-only collision with a different existing person/org → DO NOT corrupt
 *    the existing card; create a clearly disambiguated profile when verified, or skip safely.
 *  - No existing match → CREATE a new profile with a grounded lead + ## Timeline summary,
 *    external identifiers, article link, and employment link (when stated in the article).
 *
 * Usage:
 *   pnpm profiles:crawl:articles -- --limit=20
 *   pnpm profiles:crawl:articles -- --slug=historic_event:news-bureau-of-prisons-...
 *   pnpm profiles:crawl:articles -- --limit=15 --dry-run
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const {
	addAlias,
	addIdentifier,
	addLocation,
	addPersonEmployment,
	getProfileDetail,
	upsertProfileLink,
	upsertTimelineEntry,
} = await import('@/lib/research/profiles/store');
const { buildProfileIdentityContext, evaluateIdentityMatch } = await import('@/lib/research/profiles/identity');
const { classifyOrgType, makeProfileSlug, normalizeIsoDate, normalizeText, stripLegalSuffixes } = await import(
	'@/lib/research/profiles/normalize'
);

const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const MONITOR_PATH = path.join(ROOT, '.data', 'monitors', 'crawl-article-entities.json');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const OLLAMA_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const UA = 'AI-Research-Tool/1.0 (local research; +http://localhost:3333)';

const argv = process.argv.slice(2);
function argVal(prefix, fallback = null) {
	const eq = argv.find((a) => a.startsWith(`${prefix}=`));
	if (eq) return eq.slice(prefix.length + 1);
	const idx = argv.indexOf(prefix);
	if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
	return fallback;
}

const LIMIT = Math.max(1, Number(argVal('--limit', '20')) || 20);
const SINGLE_SLUG = argVal('--slug', null);
const MODEL = argVal('--model', process.env.CRAWL_ENTITY_MODEL || 'qwen2.5:7b');
const MAX_ENTITIES_PER_ARTICLE = Math.max(2, Number(argVal('--max-entities', '8')) || 8);
const FORCE = argv.includes('--force');
const DRY_RUN = argv.includes('--dry-run');

const VALID_ENTITY_TYPES = new Set(['person', 'firm', 'government', 'nonprofit', 'education', 'medical_hospital']);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}) {
	const res = await fetch(url, {
		...opts,
		headers: {
			'User-Agent': UA,
			Accept: 'application/json',
			...(opts.headers || {}),
		},
		signal: AbortSignal.timeout(opts.timeoutMs || 20_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function apiJson(pathname, { method = 'GET', body } = {}) {
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(60_000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `${method} ${pathname} → HTTP ${res.status}`);
	}
	return data;
}

function selectArticlesToCrawl() {
	const db = new DatabaseSync(PROFILES_DB, { readOnly: true });
	try {
		if (SINGLE_SLUG) {
			const row = db
				.prepare(`SELECT id, slug, name, start_date, summary, metadata_json FROM profiles WHERE slug = ? OR id = ?`)
				.get(SINGLE_SLUG, SINGLE_SLUG);
			return row ? [row] : [];
		}

		const where = [
			`p.profile_type = 'historic_event'`,
			`p.status IN ('active', 'pinned')`,
			`length(trim(coalesce(p.summary, ''))) >= 600`,
			`(json_extract(p.metadata_json, '$.newsFeedId') IS NOT NULL OR p.slug LIKE 'historic_event:news-%')`,
		];
		if (!FORCE) {
			where.push(`coalesce(p.metadata_json, '') NOT LIKE '%"entityCrawledAt"%'`);
		}

		return db
			.prepare(
				`SELECT p.id, p.slug, p.name, p.start_date, p.summary, p.metadata_json,
                (SELECT count(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_cnt
         FROM profiles p
         WHERE ${where.join(' AND ')}
         ORDER BY link_cnt ASC, p.created_at DESC
         LIMIT ?`,
			)
			.all(LIMIT);
	} finally {
		db.close();
	}
}

const NEWS_OUTLET_SKIP_RE =
	/^(?:bbc|bbc news|un news|federal news network|reuters|associated press|ap news|enr|engineering news-record|defense daily|breaking defense|defense one|construction dive|construction exec|construction executive|ground engineering|the guardian|new york times|washington post|bloomberg|cnn|fox news|nbc news|cbs news|abc news|npr|al jazeera)$/i;

const GEO_OR_CONCEPT_SKIP_RE =
	/\b(?:strait of|gulf of|sea of|bay of|river|ocean|canal|routes?|corridor|highway|ring road|peninsula|territory|region|neighbourhood|neighborhood|city centre|parliamentary bloc|coalition government|stock exchange index|small island economies|least developed countries|developing countries|regional public prosecutor|public prosecutor|prosecutors?|state-owned media|local authorities)\b/i;

const HOSPITAL_NAME_CUE_RE =
	/\b(?:hospital|medical|clinic|health|cancer|infirmary|sanatorium|centre|center|veterans affairs|va\b|children'?s|memorial|general|university medical)\b/i;

const EDUCATION_NAME_CUE_RE =
	/\b(?:university|college|institute of technology|school|academy|polytechnic|seminary|faculty|conservatory|mit\b|caltech|eth\b)\b/i;

function refineEntityType(entity, wikiHit) {
	if (entity.profileType === 'person') return 'person';
	const name = entity.name;
	const wikiLead = String(wikiHit?.extract || '').slice(0, 280).toLowerCase();

	// Guard against misclassified hospitals/universities
	if (entity.profileType === 'medical_hospital' && !HOSPITAL_NAME_CUE_RE.test(name) && !/\bhospital|medical center|clinic\b/.test(wikiLead)) {
		return classifyOrgType(name);
	}
	if (entity.profileType === 'education' && !EDUCATION_NAME_CUE_RE.test(name) && !/\buniversity|college|school\b/.test(wikiLead)) {
		return classifyOrgType(name);
	}
	// Stock exchanges, airlines, corporations are firms
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

async function extractEntitiesFromArticle(article) {
	const artMeta = (() => {
		try {
			return JSON.parse(article.metadata_json || '{}');
		} catch {
			return {};
		}
	})();
	const bylineNorm = normalizeText(String(artMeta?.articleByline || '').replace(/^by\s+/i, ''));

	const prompt = `Extract the most important NAMED actors (specific people, companies/firms, government agencies/courts/military, nonprofits/unions/associations, universities, and hospitals) who are SUBJECTS of this article.

Rules:
- Extract up to ${MAX_ENTITIES_PER_ARTICLE} concrete, specifically named actors.
- EXCLUDE: generic groups ("employees", "judges", "protesters", "officials", "regulators", "media"), countries/cities/regions/waterways/trade routes ("Strait of Hormuz", "South-South container routes", "Gaza"), and the news publisher or article reporter/byline ("BBC", "UN News", "Federal News Network", "Reuters", etc.).
- For people, include full name (first + last name). Do not include reporters/interviewers who merely wrote or conducted the interview.
- Use full official names when present (e.g., "Norwegian Air Shuttle" not just "Norwegian"; "Federal Bureau of Prisons" not just "BOP").
- Classify each entity strictly as one of: person, firm, government, nonprofit, education, medical_hospital.
  (Note: airlines, stock exchanges, banks, defense contractors, tech companies -> firm; courts, agencies, ministries, military branches -> government; unions, advocacy groups, UN bodies/foundations -> nonprofit or government; hospitals -> medical_hospital ONLY if an actual hospital/clinic.)
- Output STRICT JSON only: {"entities":[{"name":"...","profileType":"person|firm|government|nonprofit|education|medical_hospital","role":"concise role/title in article or null","affiliation":"employer/parent org name or null","location":"city/state/country if stated or null","milestone":"1-2 sentence factual claim about this entity from this article","relationType":"participated_in|affiliated_with|mentioned_in"}]}

Article Title: ${article.name}
Article Date: ${article.start_date || 'unknown'}
Article Text:
${String(article.summary || '').slice(0, 6500)}`;

	const res = await fetch(`${OLLAMA_URL}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			stream: false,
			format: 'json',
			keep_alive: '30m',
			options: { num_ctx: 12288, temperature: 0.1 },
			messages: [
				{
					role: 'system',
					content: 'You are a precise NER and entity extraction engine. Output valid JSON only.',
				},
				{ role: 'user', content: prompt },
			],
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`Ollama NER HTTP ${res.status}`);
	const data = await res.json();
	const raw = String(data?.message?.content || '').trim();
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const m = raw.match(/\{[\s\S]*\}/);
		parsed = m ? JSON.parse(m[0]) : { entities: [] };
	}
	const list = Array.isArray(parsed?.entities) ? parsed.entities : [];
	const seen = new Set();
	const out = [];
	for (const item of list) {
		const name = String(item?.name || '').replace(/\s+/g, ' ').trim();
		const profileType = String(item?.profileType || '').trim().toLowerCase();
		if (!name || name.length < 3 || name.length > 120) continue;
		if (!VALID_ENTITY_TYPES.has(profileType)) continue;
		if (NEWS_OUTLET_SKIP_RE.test(name)) continue;
		if (GEO_OR_CONCEPT_SKIP_RE.test(name)) continue;
		if (profileType === 'person') {
			if (!/\s/.test(name)) continue;
			if (bylineNorm && normalizeText(name) === bylineNorm) continue;
			if (/\b(?:reporter|correspondent|journalist|interviewer|editor)\b/i.test(String(item?.role || ''))) continue;
		}
		if (/^(?:the\s+)?(?:united states|u\.s\.|uk|britain|israel|egypt|texas|oklahoma|china|russia|iran|europe|eu|european union|gaza|cairo|norwegian|american|british|israeli|egyptian|swiss|north korean)$/i.test(name)) {
			continue;
		}
		const key = `${profileType === 'person' ? 'person' : 'org'}:${normalizeText(name)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			name,
			profileType,
			role: item?.role ? String(item.role).trim().slice(0, 140) : null,
			affiliation: item?.affiliation ? String(item.affiliation).trim().slice(0, 140) : null,
			location: item?.location ? String(item.location).trim().slice(0, 120) : null,
			milestone: String(item?.milestone || '').replace(/\s+/g, ' ').trim().slice(0, 420),
			relationType: ['participated_in', 'affiliated_with', 'mentioned_in'].includes(String(item?.relationType))
				? String(item.relationType)
				: 'mentioned_in',
		});
		if (out.length >= MAX_ENTITIES_PER_ARTICLE) break;
	}
	return out;
}

async function lookupExternalWikiId(entity) {
	try {
		const search = await fetchJson(
			`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(entity.name)}&srlimit=3&format=json`,
			{ timeoutMs: 10_000 },
		);
		const hits = search?.query?.search || [];
		const targetNorm = normalizeText(entity.name);
		const targetStripped = stripLegalSuffixes(entity.name);

		for (const hit of hits) {
			const title = String(hit.title || '');
			if (!title || /^List of /i.test(title)) continue;
			const titleNorm = normalizeText(title.replace(/\s*\([^)]*\)\s*$/, ''));
			const titleStripped = stripLegalSuffixes(title.replace(/\s*\([^)]*\)\s*$/, ''));
			const closeTitle =
				titleNorm === targetNorm ||
				titleStripped === targetStripped ||
				titleNorm.replace(/^the /, '') === targetNorm.replace(/^the /, '');
			if (!closeTitle) continue;

			const data = await fetchJson(
				`https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=wikibase_item&explaintext=1&exintro=1&titles=${encodeURIComponent(title)}&format=json&redirects=1`,
				{ timeoutMs: 10_000 },
			);
			const page = Object.values(data?.query?.pages || {})[0];
			if (!page || page.missing != null || !page.extract) continue;
			const extract = String(page.extract).trim();
			if (/may refer to:/i.test(extract.slice(0, 200)) || extract.length < 80) continue;

			// For people, require some contextual overlap (affiliation / role / location / major political/public figure)
			if (entity.profileType === 'person') {
				const hay = extract.toLowerCase();
				const cues = [entity.affiliation, entity.role, entity.location]
					.filter(Boolean)
					.flatMap((c) => normalizeText(c).split(' '))
					.filter((w) => w.length >= 4 && !/^(?:president|director|vice|chief|staff|officer|member|senior|former|policy|programs|committee|court|judge|minister|prime)$/.test(w));
				const cueHit = cues.length === 0 || cues.some((w) => hay.includes(w));
				if (!cueHit) continue;
			}

			const qid = page?.pageprops?.wikibase_item || null;
			let inception = null;
			if (qid) {
				try {
					const wd = await fetchJson(
						`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=claims&format=json`,
						{ timeoutMs: 10_000 },
					);
					const claims = wd?.entities?.[qid]?.claims || {};
					const rawT =
						claims.P571?.[0]?.mainsnak?.datavalue?.value?.time ||
						claims.P569?.[0]?.mainsnak?.datavalue?.value?.time ||
						null;
					const m = rawT && String(rawT).match(/^\+?(\d{4})-(\d{2})-(\d{2})/);
					if (m) inception = m[2] === '00' ? m[1] : m[3] === '00' ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
				} catch {
					/* optional */
				}
			}
			return {
				title: page.title,
				url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
				qid,
				extract,
				inception,
			};
		}
	} catch {
		/* best effort */
	}
	return null;
}

/**
 * Find best matching existing profile using:
 *  1) Exact external ID match (wikidata QID / Wikipedia URL)
 *  2) Exact / fuzzy name + alias search evaluated via identity.ts (`evaluateIdentityMatch`)
 */
function findMatchingProfile(entity, wikiHit, article) {
	const db = new DatabaseSync(PROFILES_DB, { readOnly: true });
	try {
		const candidateIds = new Set();

		// 1. Exact Wikidata QID or URL match
		if (wikiHit?.qid) {
			const rows = db
				.prepare(
					`SELECT profile_id FROM profile_identifiers
           WHERE scheme = 'wikidata' AND upper(value) = upper(?) LIMIT 5`,
				)
				.all(wikiHit.qid);
			for (const r of rows) candidateIds.add(String(r.profile_id));
		}
		if (wikiHit?.url) {
			const rows = db
				.prepare(
					`SELECT profile_id FROM profile_identifiers
           WHERE scheme = 'url' AND lower(value) = lower(?) LIMIT 5`,
				)
				.all(wikiHit.url);
			for (const r of rows) candidateIds.add(String(r.profile_id));
		}

		// 2. Exact slug / normalized_name / alias match
		const norm = normalizeText(entity.name);
		const stripped = stripLegalSuffixes(entity.name);
		const expectedSlug = makeProfileSlug(entity.profileType, entity.name);

		const bySlugOrName = db
			.prepare(
				`SELECT id FROM profiles
         WHERE status IN ('active', 'pinned')
           AND (slug = ? OR normalized_name = ? OR normalized_name = ?)
         LIMIT 12`,
			)
			.all(expectedSlug, norm, stripped);
		for (const r of bySlugOrName) candidateIds.add(String(r.id));

		const byAlias = db
			.prepare(
				`SELECT pa.profile_id FROM profile_aliases pa
         JOIN profiles p ON p.id = pa.profile_id
         WHERE p.status IN ('active', 'pinned')
           AND (pa.normalized_alias = ? OR pa.normalized_alias = ?)
         LIMIT 12`,
			)
			.all(norm, stripped);
		for (const r of byAlias) candidateIds.add(String(r.profile_id));

		// 3. Fuzzy token search (surname for people; across ALL org types for non-people so we never create cross-type duplicates!)
		const tokens = norm.split(' ').filter((t) => t.length >= 4);
		if (tokens.length >= 1) {
			const keyTok = entity.profileType === 'person' ? tokens[tokens.length - 1] : tokens[0];
			const fuzzyRows =
				entity.profileType === 'person'
					? db
							.prepare(
								`SELECT id FROM profiles
                 WHERE status IN ('active', 'pinned')
                   AND profile_type = 'person'
                   AND normalized_name LIKE ?
                 LIMIT 25`,
							)
							.all(`%${keyTok}%`)
					: db
							.prepare(
								`SELECT id FROM profiles
                 WHERE status IN ('active', 'pinned')
                   AND profile_type IN ('firm','government','nonprofit','education','medical_hospital')
                   AND normalized_name LIKE ?
                 LIMIT 30`,
							)
							.all(`%${keyTok}%`);
			for (const r of fuzzyRows) candidateIds.add(String(r.id));
		}

		if (candidateIds.size === 0) return { outcome: 'none' };

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
			candidateText: `${entity.name} ${entity.role || ''} ${entity.affiliation || ''} ${entity.location || ''} ${entity.milestone || ''} ${wikiHit?.extract || ''} ${article.name}`,
		};

		let bestMatch = null;
		let ambiguousHit = null;

		for (const pid of candidateIds) {
			const detail = getProfileDetail(pid);
			if (!detail) continue;
			// Do not merge a person into a firm or vice-versa
			if (entity.profileType === 'person' && detail.profile.profileType !== 'person') continue;
			if (entity.profileType !== 'person' && detail.profile.profileType === 'person') continue;

			const idCtx = buildProfileIdentityContext(detail);
			const evalRes = evaluateIdentityMatch(idCtx, candInput);
			const hasSharedId = evalRes.corroborations.some((c) => c.kind === 'shared_identifier');
			const exactName =
				normalizeText(detail.profile.name) === norm ||
				stripLegalSuffixes(detail.profile.name) === stripped;

			// Strong match criteria:
			//  A) Exact shared external ID (Wikidata/URL/etc.) + compatible name/type
			//  B) identity.ts `validated_merge` (strong ID or fuzzy/exact name + corroboration)
			//  C) Exact org/agency/university/hospital/nonprofit name with compatible org category & zero date/ID conflict
			const isStrongMatch =
				(hasSharedId && !evalRes.dateConflict) ||
				evalRes.decision === 'validated_merge' ||
				(entity.profileType !== 'person' &&
					exactName &&
					detail.profile.profileType !== 'person' &&
					detail.profile.profileType !== 'historic_event' &&
					!evalRes.dateConflict);

			if (isStrongMatch) {
				if (!bestMatch || evalRes.score > bestMatch.evalRes.score || (hasSharedId && !bestMatch.hasSharedId)) {
					bestMatch = { detail, evalRes, hasSharedId };
				}
			} else if (evalRes.decision === 'name_only_note' || exactName) {
				if (!ambiguousHit || evalRes.score > ambiguousHit.evalRes.score) {
					ambiguousHit = { detail, evalRes };
				}
			}
		}

		if (bestMatch) {
			return {
				outcome: 'strong_match',
				detail: bestMatch.detail,
				evalRes: bestMatch.evalRes,
				hasSharedId: bestMatch.hasSharedId,
			};
		}
		if (ambiguousHit) {
			return {
				outcome: 'ambiguous_collision',
				detail: ambiguousHit.detail,
				evalRes: ambiguousHit.evalRes,
			};
		}
		return { outcome: 'none' };
	} finally {
		db.close();
	}
}

function buildInitialEntitySummary(entity, wikiHit, article) {
	const articleDate = article.start_date || 'Undated';
	const leadParts = [];
	if (wikiHit?.extract) {
		const sents = wikiHit.extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
		if (sents) leadParts.push(sents);
	}
	if (!leadParts.length) {
		const roleBit = entity.role ? ` — ${entity.role}` : '';
		const affBit =
			entity.affiliation && (!entity.role || !entity.role.toLowerCase().includes(entity.affiliation.toLowerCase()))
				? ` (${entity.affiliation})`
				: '';
		const locBit = entity.location ? `, based in ${entity.location}` : '';
		leadParts.push(`${entity.name}${roleBit}${affBit}${locBit}.`);
	}

	const timelineBullets = [];
	if (entity.milestone) {
		timelineBullets.push(`- **${articleDate}** — ${entity.milestone}`);
	}
	if (wikiHit?.inception) {
		const verb = entity.profileType === 'person' ? 'Born' : 'Founded / established';
		timelineBullets.push(`- **${wikiHit.inception}** — ${verb} (${wikiHit.title}).`);
	}

	const lines = [leadParts.join(' '), '', '## Timeline', ...timelineBullets];
	const sources = [];
	if (wikiHit?.url) sources.push(`- ${wikiHit.url}`);
	const artMeta = (() => {
		try {
			return JSON.parse(article.metadata_json || '{}');
		} catch {
			return {};
		}
	})();
	if (artMeta?.sourceUrl) sources.push(`- ${artMeta.sourceUrl}`);
	if (sources.length) {
		lines.push('', '## Sources', ...sources);
	}
	return `${lines.join('\n').trim()}\n`;
}

async function createOrUpdateEntity(entity, wikiHit, article) {
	const match = findMatchingProfile(entity, wikiHit, article);
	const artMeta = (() => {
		try {
			return JSON.parse(article.metadata_json || '{}');
		} catch {
			return {};
		}
	})();
	const articleUrl = artMeta?.sourceUrl || null;
	const articleDate = article.start_date || null;

	if (match.outcome === 'strong_match') {
		const existing = match.detail.profile;
		if (DRY_RUN) {
			return {
				action: 'dry_update',
				name: entity.name,
				profileType: entity.profileType,
				matchedSlug: existing.slug,
				matchReason: match.hasSharedId ? 'shared_identifier' : match.evalRes.decision,
				score: match.evalRes.score,
			};
		}

		// 1. Add missing verified identifiers / location
		if (wikiHit?.qid && !match.detail.identifiers.some((i) => i.scheme === 'wikidata')) {
			addIdentifier({ profileId: existing.id, scheme: 'wikidata', value: wikiHit.qid, sourceCorpus: 'article-entity-crawl' });
		}
		if (wikiHit?.url && !match.detail.identifiers.some((i) => i.scheme === 'url' && /wikipedia\.org/i.test(i.value))) {
			addIdentifier({ profileId: existing.id, scheme: 'url', value: wikiHit.url, sourceCorpus: 'article-entity-crawl' });
		}
		if (entity.location && match.detail.locations.length === 0) {
			addLocation({ profileId: existing.id, raw: entity.location, role: 'associated', sourceCorpus: 'article-entity-crawl' });
		}
		if (normalizeText(entity.name) !== normalizeText(existing.name)) {
			addAlias({ profileId: existing.id, alias: entity.name, aliasKind: 'name', sourceCorpus: 'article-entity-crawl' });
		}

		// 2. Link entity ↔ source article
		upsertProfileLink({
			fromProfileId: existing.id,
			toProfileId: article.id,
			relationType: entity.relationType,
			roleLabel: entity.role,
			startDate: articleDate,
			status: 'observed',
			confidence: Math.max(0.8, Math.min(0.98, match.evalRes.score || 0.85)),
			sourceCorpus: 'article-entity-crawl',
			evidenceNote: entity.milestone || `Mentioned in ${article.name}`,
		});

		// 3. Record employment if person + affiliation mentioned
		if (existing.profileType === 'person' && entity.affiliation) {
			try {
				addPersonEmployment({
					personIdOrSlug: existing.id,
					orgName: entity.affiliation,
					role: entity.role,
					location: entity.location,
					notes: entity.milestone,
					sourceCorpus: 'article-entity-crawl',
				});
			} catch {
				/* non-fatal */
			}
		}

		// 4. Add dated timeline entry from the article
		if (entity.milestone) {
			upsertTimelineEntry({
				profileId: existing.id,
				eventDate: articleDate,
				title: article.name.slice(0, 180),
				summary: entity.milestone.slice(0, 600),
				angle: 'general',
				entryKind: 'observation',
				sourceCorpus: 'article-entity-crawl',
				dedupeHint: `${article.id}|${entity.name}`,
				confidence: 0.9,
				metadata: { linkedProfileId: article.id, sourceUrl: articleUrl },
			});
		}

		// 5. If existing summary is sparse (< 220 chars) and doesn't have ## Timeline, upgrade it!
		if (String(existing.summary || '').trim().length < 220 && !String(existing.summary || '').includes('## Timeline')) {
			const upgraded = buildInitialEntitySummary(entity, wikiHit, article);
			await apiJson(`/api/profiles/${encodeURIComponent(existing.id)}`, {
				method: 'PATCH',
				body: {
					summary: upgraded,
					...(!existing.startDate && wikiHit?.inception ? { startDate: normalizeIsoDate(wikiHit.inception).date } : {}),
					ollamaReorderTimeline: false,
				},
			}).catch(() => {});
		}

		return {
			action: 'updated',
			name: entity.name,
			profileType: existing.profileType,
			slug: existing.slug,
			matchReason: match.hasSharedId ? 'shared_identifier' : match.evalRes.decision,
			score: Number((match.evalRes.score || 0).toFixed(2)),
		};
	}

	// Ambiguous name-only collision on a person (e.g., an existing FINRA broker shares the name with a news official):
	// Do NOT overwrite the existing card! Create a disambiguated slug using their affiliation/role when clear,
	// otherwise skip safely.
	let customSlug = undefined;
	if (match.outcome === 'ambiguous_collision') {
		if (entity.profileType === 'person' && entity.affiliation) {
			customSlug = makeProfileSlug('person', `${entity.name} ${entity.affiliation.split(/\s+/).slice(0, 2).join(' ')}`);
		} else {
			return {
				action: 'skipped_ambiguous',
				name: entity.name,
				profileType: entity.profileType,
				existingSlug: match.detail.profile.slug,
				reason: match.evalRes.missingValidationHint || match.evalRes.rationale,
			};
		}
	}

	if (DRY_RUN) {
		return {
			action: 'dry_create',
			name: entity.name,
			profileType: entity.profileType,
			slug: customSlug || makeProfileSlug(entity.profileType, entity.name),
			qid: wikiHit?.qid || null,
		};
	}

	const summary = buildInitialEntitySummary(entity, wikiHit, article);
	const identifiers = [];
	if (wikiHit?.qid) identifiers.push({ scheme: 'wikidata', value: wikiHit.qid });
	if (wikiHit?.url) identifiers.push({ scheme: 'url', value: wikiHit.url });

	const created = await apiJson('/api/profiles', {
		method: 'POST',
		body: {
			profileType: entity.profileType,
			name: entity.name,
			slug: customSlug,
			status: 'active',
			summary,
			startDate: wikiHit?.inception ? normalizeIsoDate(wikiHit.inception).date : null,
			identifiers,
			locations: entity.location ? [{ raw: entity.location }] : [],
			sourceCorpus: 'article-entity-crawl',
			skipAutoResearch: true,
			metadata: {
				crawledFromArticleSlug: article.slug,
				crawledRole: entity.role,
				crawledAffiliation: entity.affiliation,
				overviewStyle: 'lead_plus_timeline_rail',
				formatMode: 'dated_expressive',
			},
		},
	});

	const newProfile = created?.profile;
	if (newProfile?.id) {
		upsertProfileLink({
			fromProfileId: newProfile.id,
			toProfileId: article.id,
			relationType: entity.relationType,
			roleLabel: entity.role,
			startDate: articleDate,
			status: 'observed',
			confidence: 0.9,
			sourceCorpus: 'article-entity-crawl',
			evidenceNote: entity.milestone || `Extracted from ${article.name}`,
		});
		if (newProfile.profileType === 'person' && entity.affiliation) {
			try {
				addPersonEmployment({
					personIdOrSlug: newProfile.id,
					orgName: entity.affiliation,
					role: entity.role,
					location: entity.location,
					notes: entity.milestone,
					sourceCorpus: 'article-entity-crawl',
				});
			} catch {
				/* non-fatal */
			}
		}
	}

	return {
		action: 'created',
		name: entity.name,
		profileType: newProfile?.profileType || entity.profileType,
		slug: newProfile?.slug || customSlug || null,
		qid: wikiHit?.qid || null,
	};
}

async function main() {
	const articles = selectArticlesToCrawl();
	console.log(`[crawl-entities] articles=${articles.length} model=${MODEL} dryRun=${DRY_RUN}`);
	fs.mkdirSync(path.dirname(MONITOR_PATH), { recursive: true });

	const report = {
		startedAt: new Date().toISOString(),
		model: MODEL,
		dryRun: DRY_RUN,
		articlesProcessed: 0,
		entitiesExtracted: 0,
		created: 0,
		updated: 0,
		skippedAmbiguous: 0,
		errors: 0,
		articles: [],
	};

	for (let i = 0; i < articles.length; i++) {
		const article = articles[i];
		process.stdout.write(`[crawl-entities] (${i + 1}/${articles.length}) ${article.slug.slice(0, 56)} … `);
		const artLog = { slug: article.slug, name: article.name, entities: [] };
		try {
			const entities = await extractEntitiesFromArticle(article);
			report.entitiesExtracted += entities.length;
			let c = 0;
			let u = 0;
			let s = 0;
			for (const ent of entities) {
				try {
					const wikiHit = await lookupExternalWikiId(ent);
					ent.profileType = refineEntityType(ent, wikiHit);
					const outcome = await createOrUpdateEntity(ent, wikiHit, article);
					artLog.entities.push(outcome);
					if (outcome.action === 'created' || outcome.action === 'dry_create') {
						report.created += 1;
						c += 1;
					} else if (outcome.action === 'updated' || outcome.action === 'dry_update') {
						report.updated += 1;
						u += 1;
					} else if (outcome.action === 'skipped_ambiguous') {
						report.skippedAmbiguous += 1;
						s += 1;
					}
					await sleep(100);
				} catch (entErr) {
					report.errors += 1;
					artLog.entities.push({
						name: ent.name,
						action: 'error',
						error: entErr instanceof Error ? entErr.message : String(entErr),
					});
				}
			}
			if (!DRY_RUN) {
				await apiJson(`/api/profiles/${encodeURIComponent(article.id)}`, {
					method: 'PATCH',
					body: {
						syncTimelineFromSummary: false,
						metadata: {
							entityCrawledAt: new Date().toISOString(),
							entityCrawlCount: entities.length,
						},
					},
				}).catch(() => {});
			}
			report.articlesProcessed += 1;
			console.log(`entities=${entities.length} created=${c} updated=${u} ambiguous=${s}`);
		} catch (err) {
			report.errors += 1;
			artLog.error = err instanceof Error ? err.message : String(err);
			console.log(`ERROR ${artLog.error}`);
		}
		report.articles.push(artLog);
		fs.writeFileSync(MONITOR_PATH, JSON.stringify(report, null, 2));
		await sleep(150);
	}

	report.finishedAt = new Date().toISOString();
	fs.writeFileSync(MONITOR_PATH, JSON.stringify(report, null, 2));
	console.log(
		`[crawl-entities] done articles=${report.articlesProcessed} extracted=${report.entitiesExtracted} created=${report.created} updated=${report.updated} ambiguous=${report.skippedAmbiguous} errors=${report.errors} → .data/monitors/crawl-article-entities.json`,
	);
}

main().catch((err) => {
	console.error('[crawl-entities] fatal', err);
	process.exit(1);
});
