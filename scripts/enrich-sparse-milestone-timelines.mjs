#!/usr/bin/env node
/**
 * Enrich profiles with sparse summaries (< 1 paragraph / missing ## Timeline) using:
 *  - Existing DB profile metadata, links, identifiers, and timeline entries
 *  - Built-in app enrichment (POST /api/profiles/:id/enrich) & Free Org Enrich
 *  - Wikipedia Action API + Wikidata Entity API (strictly verified via identity.ts)
 *  - ProPublica Nonprofit Explorer API (nonprofits)
 *  - Local Knowledge SQLite FTS (2.26M docs)
 *  - Local SearXNG web search (http://127.0.0.1:8888)
 *  - AI App Research Agent (POST /api/chat) for thin/niche profiles (--use-chat-agent or automatic fallback)
 *  - Local Ollama synthesis into lead + newest-first ## Timeline milestones
 *
 * Saves via PATCH /api/profiles/:id so Overview Timeline & Timeline tab stay in sync.
 *
 * Usage:
 *   pnpm profiles:enrich:milestones -- --limit=40
 *   pnpm profiles:enrich:milestones -- --type=government --limit=25
 *   pnpm profiles:enrich:milestones -- --pinned-only --limit=50 --use-chat-agent
 *   pnpm profiles:enrich:milestones -- --slug=education:carnegie-mellon-university --force
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

const { getProfileDetail } = await import('@/lib/research/profiles/store');
const { buildProfileIdentityContext, evaluateIdentityMatch } = await import('@/lib/research/profiles/identity');
const { normalizeIsoDate, normalizeText } = await import('@/lib/research/profiles/normalize');

const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const KNOWLEDGE_DB = path.join(ROOT, '.data', 'knowledge', 'knowledge.sqlite');
const MONITOR_PATH = path.join(ROOT, '.data', 'monitors', 'sparse-milestone-enrich.json');

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const OLLAMA_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const SEARXNG_URL = String(process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const UA = 'AI-Research-Tool/1.0 (local research; +http://localhost:3333)';

const argv = process.argv.slice(2);
function argVal(prefix, fallback = null) {
	const eq = argv.find((a) => a.startsWith(`${prefix}=`));
	if (eq) return eq.slice(prefix.length + 1);
	const idx = argv.indexOf(prefix);
	if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
	return fallback;
}

const LIMIT = Math.max(1, Number(argVal('--limit', '35')) || 35);
const TYPE_FILTER = argVal('--type', 'all');
const SINGLE_SLUG = argVal('--slug', null);
const MODEL = argVal('--model', process.env.SPARSE_ENRICH_MODEL || 'qwen2.5:7b');
const CHAT_MODEL = argVal('--chat-model', process.env.SPARSE_CHAT_MODEL || 'ornith:latest');
const PINNED_ONLY = argv.includes('--pinned-only');
const INCLUDE_FINRA = argv.includes('--include-finra');
const FORCE = argv.includes('--force');
const DRY_RUN = argv.includes('--dry-run');
const USE_CHAT_AGENT = argv.includes('--use-chat-agent');
const CHAT_FALLBACK = !argv.includes('--no-chat-fallback');
const MAX_SUMMARY_LEN = Math.max(120, Number(argVal('--max-len', '280')) || 280);

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
		signal: AbortSignal.timeout(opts.timeoutMs || 25_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function isAggregateOrMetaListProfile(name, slug) {
	const n = String(name || '').trim();
	const s = String(slug || '').trim();
	if (/^List of /i.test(n)) return true;
	if (/^(?:Independent agencies, tribunals|Quasi-official organizations|Executive departments|Legislative branch|Judicial branch)$/i.test(n)) {
		return true;
	}
	if (/^historic_event:auth-/i.test(s)) return true;
	return false;
}

function selectSparseTargets() {
	const db = new DatabaseSync(PROFILES_DB, { readOnly: true });
	try {
		if (SINGLE_SLUG) {
			const row = db
				.prepare(`SELECT id, slug, profile_type, name, status, start_date, end_date, summary, metadata_json FROM profiles WHERE slug = ? OR id = ?`)
				.get(SINGLE_SLUG, SINGLE_SLUG);
			return row ? [row] : [];
		}

		const where = [
			`p.status IN (${PINNED_ONLY ? `'pinned'` : `'pinned', 'active'`})`,
			`(length(trim(coalesce(p.summary, ''))) < ? OR (p.summary NOT LIKE '%## Timeline%' AND length(trim(coalesce(p.summary, ''))) < ?))`,
		];
		const params = [MAX_SUMMARY_LEN, MAX_SUMMARY_LEN];

		if (!INCLUDE_FINRA) {
			where.push(`coalesce(p.summary, '') NOT LIKE 'FINRA/SEC registered%'`);
			where.push(`coalesce(p.metadata_json, '') NOT LIKE '%"finra-visualizer"%'`);
			where.push(`coalesce(p.metadata_json, '') NOT LIKE '%"finra_brokercheck"%'`);
		}
		if (!FORCE) {
			where.push(`coalesce(p.metadata_json, '') NOT LIKE '%"sparseTimelineEnrichedAt"%'`);
		}

		if (TYPE_FILTER && TYPE_FILTER !== 'all') {
			where.push(`p.profile_type = ?`);
			params.push(TYPE_FILTER);
			const rows = db
				.prepare(
					`SELECT p.id, p.slug, p.profile_type, p.name, p.status, p.start_date, p.end_date, p.summary, p.metadata_json,
                  (SELECT count(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_cnt,
                  (SELECT count(*) FROM timeline_entries te WHERE te.profile_id = p.id) AS tl_cnt
           FROM profiles p
           WHERE ${where.join(' AND ')}
           ORDER BY
             CASE WHEN p.status = 'pinned' THEN 0 ELSE 1 END ASC,
             link_cnt DESC,
             tl_cnt DESC,
             p.updated_at DESC
           LIMIT ?`,
				)
				.all(...params, LIMIT * 2);
			return rows.filter((r) => !isAggregateOrMetaListProfile(r.name, r.slug)).slice(0, LIMIT);
		}

		// When TYPE_FILTER === 'all', pull top candidates PER profile type and round-robin interleave
		const order = ['region', 'historic_event', 'government', 'education', 'nonprofit', 'medical_hospital', 'firm', 'person'];
		const perTypeLimit = Math.max(8, Math.ceil(LIMIT / 2));
		const byType = new Map();
		for (const t of order) {
			const rows = db
				.prepare(
					`SELECT p.id, p.slug, p.profile_type, p.name, p.status, p.start_date, p.end_date, p.summary, p.metadata_json,
                  (SELECT count(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_cnt,
                  (SELECT count(*) FROM timeline_entries te WHERE te.profile_id = p.id) AS tl_cnt
           FROM profiles p
           WHERE ${where.join(' AND ')} AND p.profile_type = ?
           ORDER BY
             CASE WHEN p.status = 'pinned' THEN 0 ELSE 1 END ASC,
             link_cnt DESC,
             tl_cnt DESC,
             p.updated_at DESC
           LIMIT ?`,
				)
				.all(...params, t, perTypeLimit)
				.filter((r) => !isAggregateOrMetaListProfile(r.name, r.slug));
			if (rows.length) byType.set(t, rows);
		}

		const picked = [];
		let round = 0;
		while (picked.length < LIMIT) {
			let added = 0;
			for (const t of order) {
				const list = byType.get(t);
				if (list && round < list.length) {
					picked.push(list[round]);
					added += 1;
					if (picked.length >= LIMIT) break;
				}
			}
			if (added === 0) break;
			round += 1;
		}
		return picked;
	} finally {
		db.close();
	}
}

async function fetchWikidataEntity(qid) {
	if (!qid || !/^Q\d+$/i.test(qid)) return null;
	try {
		const data = await fetchJson(
			`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=labels|descriptions|claims|sitelinks&languages=en&format=json`,
			{ timeoutMs: 15_000 },
		);
		const ent = data?.entities?.[qid.toUpperCase()];
		if (!ent) return null;
		const enwikiTitle = ent?.sitelinks?.enwiki?.title || null;
		const description = ent?.descriptions?.en?.value || null;
		const claimTime = (prop) => {
			const v = ent?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.time;
			if (!v) return null;
			const m = String(v).match(/^\+?(\d{4})-(\d{2})-(\d{2})/);
			if (!m) return null;
			if (m[2] === '00') return m[1];
			if (m[3] === '00') return `${m[1]}-${m[2]}`;
			return `${m[1]}-${m[2]}-${m[3]}`;
		};
		const inception = claimTime('P571') || claimTime('P569') || claimTime('P580') || claimTime('P585');
		const dissolved = claimTime('P576') || claimTime('P570') || claimTime('P582');
		return { qid: qid.toUpperCase(), enwikiTitle, description, inception, dissolved };
	} catch {
		return null;
	}
}

async function fetchWikipediaArticleByTitle(title) {
	if (!title) return null;
	try {
		const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=wikibase_item&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(title)}&format=json&redirects=1`;
		const data = await fetchJson(url, { timeoutMs: 18_000 });
		const pages = data?.query?.pages || {};
		const page = Object.values(pages)[0];
		if (!page || page.missing != null || !page.extract) return null;
		const extract = String(page.extract || '').trim();
		if (extract.length < 120) return null;
		if (/may refer to:/i.test(extract.slice(0, 220))) return null;
		return {
			title: page.title,
			url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
			qid: page?.pageprops?.wikibase_item || null,
			extract,
		};
	} catch {
		return null;
	}
}

function selectRelevantWikipediaChunks(extract, maxChars = 6800) {
	const text = String(extract || '').trim();
	if (text.length <= maxChars) return text;
	// Keep intro + History / Background / Career / Timeline / Recent sections
	const parts = text.split(/\n{2,}/);
	const out = [];
	let len = 0;
	// Always keep first 5 paragraphs (lead + early overview)
	for (let i = 0; i < Math.min(5, parts.length); i++) {
		if (len + parts[i].length > maxChars * 0.55) break;
		out.push(parts[i]);
		len += parts[i].length + 2;
	}
	// Then scan for high-value chronological paragraphs (years/dates)
	for (let i = 5; i < parts.length; i++) {
		const p = parts[i].trim();
		if (p.length < 40) continue;
		if (/^(?:See also|References|External links|Further reading|Notes|Bibliography|Gallery)$/i.test(p)) break;
		const yearCount = (p.match(/\b(?:1[7-9]|20)\d{2}\b/g) || []).length;
		if (yearCount === 0 && !/^(?:History|Background|Career|Early life|Timeline|Founding|Origins|Operations|Development|Legacy|Recent)/i.test(p)) {
			continue;
		}
		if (len + p.length > maxChars) break;
		out.push(p);
		len += p.length + 2;
	}
	return out.join('\n\n').slice(0, maxChars);
}

async function lookupWikipediaForProfile(detail, idCtx) {
	const existingQid = detail.identifiers.find((i) => i.scheme === 'wikidata')?.value || null;
	const existingWikiUrl = detail.identifiers.find(
		(i) => i.scheme === 'url' && /en\.wikipedia\.org\/wiki\//i.test(i.value) && !/\/wiki\/List_of_/i.test(i.value),
	)?.value;

	let wiki = null;
	let wikidata = null;

	if (existingQid) {
		wikidata = await fetchWikidataEntity(existingQid);
		if (wikidata?.enwikiTitle) {
			wiki = await fetchWikipediaArticleByTitle(wikidata.enwikiTitle);
		}
	}

	if (!wiki && existingWikiUrl) {
		const m = existingWikiUrl.match(/\/wiki\/([^#?]+)/i);
		if (m) {
			wiki = await fetchWikipediaArticleByTitle(decodeURIComponent(m[1]).replace(/_/g, ' '));
		}
	}

	if (!wiki) {
		// Clean query name (drop trailing parentheticals like "(ICE)" for cleaner search)
		const cleanName = detail.profile.name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
		const queries = [detail.profile.name, cleanName].filter((v, i, a) => v.length >= 3 && a.indexOf(v) === i);
		for (const q of queries) {
			try {
				const search = await fetchJson(
					`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json`,
					{ timeoutMs: 12_000 },
				);
				const hits = search?.query?.search || [];
				for (const hit of hits) {
					const title = String(hit.title || '');
					if (!title || /^List of /i.test(title)) continue;
					const art = await fetchWikipediaArticleByTitle(title);
					if (!art) continue;
					// Verify identity match before accepting!
					const evalRes = evaluateIdentityMatch(idCtx, {
						candidateName: art.title,
						candidateIdentifiers: art.qid ? [{ scheme: 'wikidata', value: art.qid }] : [],
						candidateText: art.extract.slice(0, 2500),
					});
					const normTitle = normalizeText(art.title);
					const normProf = normalizeText(cleanName);
					const exactTitle =
						normTitle === normProf ||
						normTitle === normalizeText(detail.profile.name) ||
						normTitle.replace(/^the /, '') === normProf.replace(/^the /, '');

					// Accept if identity.ts validates merge OR exact title match for non-person orgs/events/regions without date conflict
					if (
						evalRes.decision === 'validated_merge' ||
						(exactTitle && !evalRes.dateConflict && detail.profile.profileType !== 'person') ||
						(exactTitle && !evalRes.dateConflict && detail.profile.profileType === 'person' && evalRes.score >= 0.45)
					) {
						wiki = art;
						if (!wikidata && art.qid) wikidata = await fetchWikidataEntity(art.qid);
						break;
					}
				}
				if (wiki) break;
			} catch {
				/* ignore search error */
			}
		}
	}

	return { wiki, wikidata };
}

async function lookupProPublicaNonprofit(detail) {
	if (detail.profile.profileType !== 'nonprofit') return null;
	const einIdent = detail.identifiers.find((i) => i.scheme === 'irs_ein')?.value || null;
	try {
		if (einIdent) {
			const digits = einIdent.replace(/\D/g, '');
			if (digits.length === 9) {
				const data = await fetchJson(`https://projects.propublica.org/nonprofits/api/v2/organizations/${digits}.json`, {
					timeoutMs: 12_000,
				});
				const org = data?.organization;
				if (org?.name) {
					return {
						name: org.name,
						ein: `${digits.slice(0, 2)}-${digits.slice(2)}`,
						city: org.city,
						state: org.state,
						rulingDate: org.ruling_date,
						assetAmount: org.asset_amount,
						incomeAmount: org.income_amount,
						nteeCode: org.ntee_code,
						url: `https://projects.propublica.org/nonprofits/organizations/${digits}`,
					};
				}
			}
		}
	} catch {
		/* best effort */
	}
	return null;
}

function searchLocalKnowledge(name, limit = 4) {
	if (!fs.existsSync(KNOWLEDGE_DB)) return [];
	const clean = String(name || '').replace(/"/g, '').trim();
	if (clean.length < 4) return [];
	let kdb;
	try {
		kdb = new DatabaseSync(KNOWLEDGE_DB, { readOnly: true });
		const rows = kdb
			.prepare(
				`SELECT d.title, d.url, p.name AS project_name, substr(c.text, 1, 380) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         JOIN projects p ON p.id = d.project_id
         WHERE chunks_fts MATCH ?
         LIMIT ?`,
			)
			.all(`"${clean}"`, limit * 2);
		const seen = new Set();
		const out = [];
		for (const r of rows) {
			const key = `${r.title}|${r.project_name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				title: String(r.title || ''),
				project: String(r.project_name || ''),
				url: r.url ? String(r.url) : null,
				snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
			});
			if (out.length >= limit) break;
		}
		return out;
	} catch {
		return [];
	} finally {
		kdb?.close?.();
	}
}

async function searchSearxng(name, profileType, locationHint) {
	const typeCue =
		profileType === 'education' ? 'university history founded'
		: profileType === 'medical_hospital' ? 'hospital history founded'
		: profileType === 'government' ? 'agency history established'
		: profileType === 'nonprofit' ? 'foundation organization history founded'
		: profileType === 'firm' ? 'company history founded'
		: profileType === 'historic_event' ? 'timeline history'
		: 'biography career';
	const q = `"${name.replace(/"/g, '')}" ${locationHint || ''} ${typeCue}`.replace(/\s+/g, ' ').trim();
	try {
		const data = await fetchJson(`${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json`, {
			timeoutMs: 12_000,
		});
		const results = Array.isArray(data?.results) ? data.results : [];
		return results.slice(0, 6).map((r) => ({
			title: String(r.title || ''),
			url: String(r.url || ''),
			content: String(r.content || '').replace(/\s+/g, ' ').trim(),
		}));
	} catch {
		return [];
	}
}

async function queryAiAppChatAgent(detail) {
	const p = detail.profile;
	const loc = detail.locations[0]?.raw || '';
	const idStr = detail.identifiers.slice(0, 4).map((i) => `${i.scheme}:${i.value}`).join(', ');
	const question = `Research "${p.name}" (profile type: ${p.profileType}${loc ? `, location: ${loc}` : ''}${idStr ? `, identifiers: ${idStr}` : ''}).
Provide ONLY factual, verifiable information with specific dates/years:
1) A concise 2-3 sentence overview paragraph.
2) A "## Timeline" section with 4-8 dated milestone bullets formatted as "- **DATE** — concise factual milestone" sorted newest to oldest.
Do NOT invent dates or facts; if only a few dated milestones are verifiable, include only those.`;

	try {
		const res = await fetch(`${BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				question,
				model: CHAT_MODEL,
				persistChat: false,
				persistFetches: false,
			}),
			signal: AbortSignal.timeout(90_000),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data?.ok || !data?.answer) return null;
		return {
			answer: String(data.answer).trim(),
			model: data.model || CHAT_MODEL,
			toolCount: Array.isArray(data.toolTrace) ? data.toolTrace.length : 0,
		};
	} catch {
		return null;
	}
}

async function synthesizeMilestoneSummary(detail, evidenceBundle) {
	const p = detail.profile;
	const prompt = `You are writing an encyclopedic profile summary for "${p.name}" (type: ${p.profileType}).

Using ONLY the verified source material below, write a clean markdown profile summary with this EXACT structure:
1. First, ONE concise lead paragraph (2-3 sentences, plain prose, no heading) summarizing who/what "${p.name}" is, its core role/mission, location, and significance.
2. Then a blank line and the heading: ## Timeline
3. Under ## Timeline, write 4 to 9 dated milestone bullets sorted NEWEST date on top to OLDEST date on bottom.
   - Bullet format: - **DATE** — concise factual milestone (1-2 sentences).
   - Use real dates from the sources: YYYY, Month YYYY, or Month DD, YYYY (e.g. **2024**, **December 2022**, **March 16, 1940**).
   - Do NOT invent any dates, statistics, or facts that are not in the source material.
   - Do NOT include meta commentary, disclaimers about being an AI, or placeholder bullets.
4. If verified source URLs exist below, finish with a blank line, ## Sources, and bulleted URLs (max 4).

Output ONLY the markdown summary (no code fences, no preamble).

=== VERIFIED SOURCE MATERIAL ===
${evidenceBundle.slice(0, 9500)}`;

	const res = await fetch(`${OLLAMA_URL}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			stream: false,
			keep_alive: '30m',
			options: { num_ctx: 12288, temperature: 0.15 },
			messages: [
				{
					role: 'system',
					content:
						'You are a meticulous research editor. Never hallucinate facts or dates. Output clean markdown only.',
				},
				{ role: 'user', content: prompt },
			],
		}),
		signal: AbortSignal.timeout(75_000),
	});
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw new Error(`Ollama HTTP ${res.status}: ${txt.slice(0, 160)}`);
	}
	const data = await res.json();
	let text = String(data?.message?.content || '').trim();
	if (/^```/.test(text)) {
		text = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}
	return text;
}

function validateMilestoneSummary(md) {
	const s = String(md || '').trim();
	if (s.length < 220) return { ok: false, reason: 'too_short' };
	if (!/^##\s+Timeline\b/m.test(s)) return { ok: false, reason: 'missing_timeline_heading' };
	const timelinePart = s.split(/^##\s+Timeline\b/m)[1] || '';
	const beforeNext = timelinePart.split(/^##\s+/m)[0] || '';
	const bullets = beforeNext
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /^[-*•]\s+\*\*[^*]+\*\*\s*[—–:\-]\s+\S/.test(l));
	if (bullets.length < 2) return { ok: false, reason: `too_few_dated_bullets(${bullets.length})` };
	if (/\b(?:I cannot|I don't have enough|as an AI|no verified information available)\b/i.test(s)) {
		return { ok: false, reason: 'refusal_text' };
	}
	return { ok: true, bulletCount: bullets.length };
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

async function processProfile(row) {
	const detail = getProfileDetail(row.id);
	if (!detail) return { slug: row.slug, status: 'missing' };

	const idCtx = buildProfileIdentityContext(detail);
	const sourcesUsed = [];
	const sourceUrls = [];
	const parts = [];

	// 1. Existing DB facts
	parts.push(`Profile Name: ${detail.profile.name}`);
	parts.push(`Type: ${detail.profile.profileType}`);
	if (detail.profile.startDate) parts.push(`Start Date: ${detail.profile.startDate}`);
	if (detail.profile.endDate) parts.push(`End Date: ${detail.profile.endDate}`);
	if (detail.profile.summary?.trim()) parts.push(`Existing Summary: ${detail.profile.summary.trim()}`);
	if (detail.locations.length) {
		parts.push(`Locations: ${detail.locations.slice(0, 5).map((l) => l.raw).join('; ')}`);
	}
	if (detail.identifiers.length) {
		parts.push(`Identifiers: ${detail.identifiers.slice(0, 6).map((i) => `${i.scheme}=${i.value}`).join(', ')}`);
	}
	if (detail.links.length) {
		const linkSnips = detail.links.slice(0, 12).map((l) => {
			const peer = l.fromProfileId === detail.profile.id ? l.toName : l.fromName;
			const dates = [l.startDate, l.endDate].filter(Boolean).join('–');
			return `${l.relationType}: ${peer}${l.roleLabel ? ` (${l.roleLabel})` : ''}${dates ? ` [${dates}]` : ''}`;
		});
		parts.push(`Connected Profiles:\n- ${linkSnips.join('\n- ')}`);
	}

	// Pull existing timeline_entries from DB (great for agencies/events with existing entries!)
	{
		const db = new DatabaseSync(PROFILES_DB, { readOnly: true });
		try {
			const te = db
				.prepare(
					`SELECT event_date, title, substr(summary, 1, 220) AS summary, source_corpus
           FROM timeline_entries
           WHERE profile_id = ? AND event_date IS NOT NULL
           ORDER BY event_date DESC
           LIMIT 12`,
				)
				.all(detail.profile.id);
			if (te.length) {
				sourcesUsed.push('profiles_db_timeline');
				parts.push(
					`Existing DB Timeline Entries:\n${te
						.map((e) => `- ${e.event_date}: ${e.title}${e.summary ? ` — ${e.summary}` : ''}`)
						.join('\n')}`,
				);
			}
		} finally {
			db.close();
		}
	}

	// 2. Wikipedia + Wikidata (strictly identity-verified)
	const { wiki, wikidata } = await lookupWikipediaForProfile(detail, idCtx);
	if (wikidata) {
		sourcesUsed.push(`wikidata:${wikidata.qid}`);
		parts.push(
			`Wikidata (${wikidata.qid}): ${wikidata.description || ''}${wikidata.inception ? ` | inception/born: ${wikidata.inception}` : ''}${wikidata.dissolved ? ` | dissolved/died: ${wikidata.dissolved}` : ''}`,
		);
	}
	if (wiki) {
		sourcesUsed.push('wikipedia');
		sourceUrls.push(wiki.url);
		parts.push(`Wikipedia (${wiki.title} — ${wiki.url}):\n${selectRelevantWikipediaChunks(wiki.extract, 6000)}`);
	}

	// 3. ProPublica Nonprofit API
	const pp = await lookupProPublicaNonprofit(detail);
	if (pp) {
		sourcesUsed.push('propublica_nonprofits');
		sourceUrls.push(pp.url);
		parts.push(
			`ProPublica Nonprofit Explorer (EIN ${pp.ein}): ${pp.name}, ${pp.city || ''}, ${pp.state || ''}, ruling date: ${pp.rulingDate || 'n/a'}, assets: ${pp.assetAmount ?? 'n/a'}, income: ${pp.incomeAmount ?? 'n/a'}`,
		);
	}

	// 4. Local Knowledge SQLite
	const kHits = searchLocalKnowledge(detail.profile.name, 4);
	if (kHits.length) {
		sourcesUsed.push('local_knowledge');
		parts.push(
			`Local Knowledge Store Hits:\n${kHits
				.map((h) => `- [${h.project}] ${h.title}: ${h.snippet}`)
				.join('\n')}`,
		);
	}

	// 5. SearXNG web search when Wikipedia didn't hit
	if (!wiki) {
		const locHint = detail.locations[0]?.city || detail.locations[0]?.state || '';
		const webHits = await searchSearxng(detail.profile.name, detail.profile.profileType, locHint);
		if (webHits.length) {
			sourcesUsed.push('searxng');
			for (const h of webHits.slice(0, 3)) {
				if (h.url) sourceUrls.push(h.url);
			}
			parts.push(
				`Web Search Snippets (SearXNG):\n${webHits
					.map((h) => `- ${h.title} (${h.url}): ${h.content}`)
					.join('\n')}`,
			);
		}
	}

	// 6. AI App Research Agent (POST /api/chat) if requested or if deterministic evidence is thin
	const rawEvidenceLen = parts.join('\n\n').length;
	if (USE_CHAT_AGENT || (CHAT_FALLBACK && !wiki && rawEvidenceLen < 900)) {
		const agentRes = await queryAiAppChatAgent(detail);
		if (agentRes?.answer && agentRes.answer.length >= 160) {
			sourcesUsed.push(`ai_app_chat_agent:${agentRes.model}`);
			parts.push(`AI App Research Agent Notes:\n${agentRes.answer.slice(0, 3200)}`);
		}
	}

	if (sourceUrls.length) {
		parts.push(`Verified Source URLs:\n${[...new Set(sourceUrls)].slice(0, 5).map((u) => `- ${u}`).join('\n')}`);
	}

	const bundle = parts.join('\n\n');
	if (bundle.length < 350) {
		return { slug: detail.profile.slug, status: 'skipped_thin_evidence', sourcesUsed };
	}

	// 7. Synthesize lead + ## Timeline milestones via Ollama
	const synthesized = await synthesizeMilestoneSummary(detail, bundle);
	const check = validateMilestoneSummary(synthesized);
	if (!check.ok) {
		return {
			slug: detail.profile.slug,
			status: 'rejected_output',
			reason: check.reason,
			sourcesUsed,
		};
	}

	if (DRY_RUN) {
		return {
			slug: detail.profile.slug,
			status: 'dry_run',
			bullets: check.bulletCount,
			chars: synthesized.length,
			sourcesUsed,
			preview: synthesized.slice(0, 600),
		};
	}

	// 8. Save via PATCH /api/profiles/:id (auto-sorts newest-first & syncs timeline_entries!)
	const inferredStart =
		detail.profile.startDate ||
		(wikidata?.inception ? normalizeIsoDate(wikidata.inception).date : null) ||
		undefined;
	const inferredEnd =
		detail.profile.endDate ||
		(wikidata?.dissolved ? normalizeIsoDate(wikidata.dissolved).date : null) ||
		undefined;

	const patchBody = {
		summary: synthesized,
		...(inferredStart && !detail.profile.startDate ? { startDate: inferredStart } : {}),
		...(inferredEnd && !detail.profile.endDate ? { endDate: inferredEnd } : {}),
		ollamaReorderTimeline: false,
		skipAutoResearch: true,
		metadata: {
			overviewStyle: 'lead_plus_timeline_rail',
			formatMode: 'dated_expressive',
			sparseTimelineEnrichedAt: new Date().toISOString(),
			sparseTimelineSources: sourcesUsed,
			sparseTimelineModel: MODEL,
		},
	};

	const patched = await apiJson(`/api/profiles/${encodeURIComponent(detail.profile.id)}`, {
		method: 'PATCH',
		body: patchBody,
	});

	// Attach newly verified Wikidata QID or Wikipedia URL identifier if missing
	const hasQid = detail.identifiers.some((i) => i.scheme === 'wikidata');
	const newQid = wikidata?.qid || wiki?.qid || null;
	if (!hasQid && newQid) {
		await apiJson(`/api/profiles/${encodeURIComponent(detail.profile.id)}`, {
			method: 'PATCH',
			body: { addIdentifier: { scheme: 'wikidata', value: newQid }, syncTimelineFromSummary: false },
		}).catch(() => {});
	}
	const hasWikiUrl = detail.identifiers.some((i) => i.scheme === 'url' && /wikipedia\.org/i.test(i.value));
	if (!hasWikiUrl && wiki?.url) {
		await apiJson(`/api/profiles/${encodeURIComponent(detail.profile.id)}`, {
			method: 'PATCH',
			body: { addIdentifier: { scheme: 'url', value: wiki.url }, syncTimelineFromSummary: false },
		}).catch(() => {});
	}

	return {
		slug: detail.profile.slug,
		profileType: detail.profile.profileType,
		status: 'enriched',
		bullets: check.bulletCount,
		syncedTimeline: patched?.timelineSync?.upsertedOwn ?? 0,
		chars: synthesized.length,
		sourcesUsed,
	};
}

async function main() {
	const targets = selectSparseTargets();
	console.log(
		`[sparse-enrich] targets=${targets.length} type=${TYPE_FILTER} pinnedOnly=${PINNED_ONLY} model=${MODEL} useChatAgent=${USE_CHAT_AGENT} dryRun=${DRY_RUN}`,
	);
	fs.mkdirSync(path.dirname(MONITOR_PATH), { recursive: true });

	const report = {
		startedAt: new Date().toISOString(),
		model: MODEL,
		typeFilter: TYPE_FILTER,
		pinnedOnly: PINNED_ONLY,
		dryRun: DRY_RUN,
		totalTargets: targets.length,
		enriched: 0,
		skipped: 0,
		errors: 0,
		results: [],
	};

	for (let i = 0; i < targets.length; i++) {
		const row = targets[i];
		process.stdout.write(`[sparse-enrich] (${i + 1}/${targets.length}) ${row.slug.slice(0, 56)} … `);
		try {
			const res = await processProfile(row);
			report.results.push(res);
			if (res.status === 'enriched' || res.status === 'dry_run') {
				report.enriched += 1;
				console.log(`${res.status} bullets=${res.bullets} synced=${res.syncedTimeline ?? '-'} sources=${(res.sourcesUsed || []).join(',')}`);
			} else {
				report.skipped += 1;
				console.log(`${res.status}${res.reason ? ` (${res.reason})` : ''}`);
			}
		} catch (err) {
			report.errors += 1;
			const msg = err instanceof Error ? err.message : String(err);
			report.results.push({ slug: row.slug, status: 'error', error: msg });
			console.log(`ERROR ${msg}`);
		}
		fs.writeFileSync(MONITOR_PATH, JSON.stringify(report, null, 2));
		await sleep(150);
	}

	report.finishedAt = new Date().toISOString();
	fs.writeFileSync(MONITOR_PATH, JSON.stringify(report, null, 2));
	console.log(
		`[sparse-enrich] done enriched=${report.enriched} skipped=${report.skipped} errors=${report.errors} → .data/monitors/sparse-milestone-enrich.json`,
	);
}

main().catch((err) => {
	console.error('[sparse-enrich] fatal', err);
	process.exit(1);
});
