#!/usr/bin/env node
/**
 * Cluster related news_rss historic_events, fact-check key claims against
 * local kiwix Wikipedia, merge same-topic cards, and rewrite the survivor
 * summary as a condensed timeline (bullets) plus wiki notes.
 *
 *   pnpm news:rss:consolidate
 *   NEWS_RSS_CONSOLIDATE_DRY_RUN=1 pnpm news:rss:consolidate
 *   NEWS_RSS_CONSOLIDATE_ONLY=critical-minerals,coast-guard-stem pnpm news:rss:consolidate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const OUT_PATH = path.join(ROOT, '.data', 'monitors', 'news-rss-consolidate.json');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const KIWIX = String(process.env.KIWIX_SERVE_ORIGIN || process.env.RESEARCH_KIWIX_ORIGIN || 'http://127.0.0.1:8765').replace(
	/\/$/,
	'',
);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_CONSOLIDATE_DRY_RUN || ''));
const ONLY = String(process.env.NEWS_RSS_CONSOLIDATE_ONLY || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

/** @typedef {{ id: string, slug: string, name: string, startDate: string|null, endDate: string|null, summary: string, feed: string|null, sourceUrl: string|null, metadata: Record<string, unknown> }} NewsProfile */

/** Curated strong clusters / duplicate pairs for first pass. */
const CLUSTERS = [
	{
		id: 'critical-minerals',
		canonicalName: 'US Critical Minerals policy & USGS science (2024–2025)',
		wikiQueries: ['United States critical materials list', 'Critical raw materials', 'USGS critical minerals'],
		// Name-only: avoid soft summary hits (Halloween minerals story, permitting bills, etc.)
		memberNameRe: /critical minerals?/i,
		matchNameOnly: true,
		excludeNameRe: /halloween|kobold|permitting reform|guided by geosciences/i,
	},
	{
		id: 'sea-turtles-cold-stun',
		canonicalName: 'Cold-stunned sea turtle rescues (USGS)',
		wikiQueries: ['Cold-stunning', "Kemp's ridley sea turtle", 'Sea turtle cold stun'],
		memberNameRe: /sea turtle/i,
	},
	{
		id: 'coast-guard-stem',
		canonicalName: 'Coast Guard Academy STEM building ($155M Whiting-Turner)',
		wikiQueries: ['United States Coast Guard Academy', 'New London Connecticut'],
		memberNameRe: /coast guard.*stem|stem.*coast guard|whiting-turner.*coast guard/i,
	},
	{
		id: 'federal-contractors-white-house',
		canonicalName: 'Federal contractors directed to clear congressional responses with White House',
		wikiQueries: ['Executive privilege', 'Federal Acquisition Regulation'],
		memberNameRe:
			/federal contractors.*(congress|white house)|white house before responding to congress|congressional inquir/i,
		excludeNameRe: /e-verify|everify/i,
	},
	{
		id: 'lien-bond-claims-tx',
		canonicalName: 'Texas lien & bond claim monthly deadlines',
		wikiQueries: ['Mechanic\'s lien', 'Surety bond', 'Texas Property Code'],
		memberNameRe: /lien and bond claims/i,
	},
	{
		id: 'loma-prieta-anniversary',
		canonicalName: 'Loma Prieta earthquake anniversary / preparedness notes',
		wikiQueries: ['1989 Loma Prieta earthquake'],
		memberNameRe: /loma prieta/i,
		// single-card ok — still fact-check + timeline rewrite
		minMembers: 1,
	},
	{
		id: 'hudson-tunnel-tbm',
		canonicalName: 'Hudson Tunnel Project — TBM launch progress',
		wikiQueries: ['Gateway Program (Northeast Corridor)', 'North River Tunnels', 'Hudson Tunnel'],
		memberNameRe: /hudson tunnel|palisades tunnel/i,
		minMembers: 1,
	},
];

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function stripTags(s) {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function loadNewsProfiles() {
	const db = new DatabaseSync(PROFILES_DB, { readonly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, slug, name, start_date, end_date, summary, metadata_json
         FROM profiles
         WHERE metadata_json LIKE '%newsFeedId%'
            OR metadata_json LIKE '%"news_rss"%'`,
			)
			.all();
		return rows.map((r) => {
			let metadata = {};
			try {
				metadata = JSON.parse(r.metadata_json || '{}');
			} catch {
				metadata = {};
			}
			return {
				id: r.id,
				slug: r.slug,
				name: r.name,
				startDate: r.start_date || null,
				endDate: r.end_date || null,
				summary: r.summary || '',
				feed: metadata.newsFeedId || null,
				sourceUrl: metadata.sourceUrl || null,
				metadata,
			};
		});
	} finally {
		db.close?.();
	}
}

async function wikiSearch(query, limit = 4) {
	const url = new URL(`${KIWIX}/search`);
	url.searchParams.set('pattern', query);
	url.searchParams.set('format', 'xml');
	url.searchParams.set('pageLength', String(limit));
	const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`kiwix HTTP ${res.status}`);
	const xml = await res.text();
	const hits = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
		const block = m[1];
		const title = stripTags((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
		const link = stripTags((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
		const snippet = stripTags((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '').slice(
			0,
			280,
		);
		if (title) hits.push({ title, link, snippet });
		if (hits.length >= limit) break;
	}
	return hits;
}

function firstSentences(text, maxChars = 280) {
	const clean = String(text || '')
		.replace(/\s+/g, ' ')
		.replace(/^Tagged with:.*$/gim, '')
		.trim();
	if (!clean) return '';
	const parts = clean.split(/(?<=[.!?])\s+/);
	let out = '';
	for (const p of parts) {
		if (!p) continue;
		if (!out) {
			out = p;
			if (out.length >= 80) break;
			continue;
		}
		if ((out + ' ' + p).length > maxChars) break;
		out = `${out} ${p}`;
		if (out.length >= 140) break;
	}
	return out.slice(0, maxChars).trim();
}

function pickBullet(profile) {
	const date = profile.startDate || 'undated';
	const claim = firstSentences(profile.summary, 220) || profile.name;
	const src = profile.feed ? ` [${profile.feed}]` : '';
	return `- **${date}** — ${claim}${src}`;
}

function buildTimelineSummary({ cluster, members, wikiNotes }) {
	const sorted = [...members].sort((a, b) =>
		String(a.startDate || '9999').localeCompare(String(b.startDate || '9999')),
	);
	const start = sorted[0]?.startDate || null;
	const end = sorted[sorted.length - 1]?.startDate || null;
	const bullets = sorted.map(pickBullet);
	const sources = sorted
		.map((m) => m.sourceUrl)
		.filter(Boolean)
		.slice(0, 12);

	const lines = [
		`${cluster.canonicalName}.`,
		'',
		'## Timeline',
		...bullets,
		'',
		'## Local Wikipedia cross-check',
		...(wikiNotes.length
			? wikiNotes.map((w) => `- **${w.title}** — ${w.snippet || '(no snippet)'}${w.link ? ` (${KIWIX}${w.link.startsWith('/') ? w.link : `/${w.link}`})` : ''}`)
			: ['- No strong local-wiki hits for the queried topic labels.']),
		'',
		'## Source articles',
		...sources.map((u) => `- ${u}`),
		'',
		`Consolidated from ${sorted.length} news_rss card(s); prose reduced to dated bullets.`,
	];

	return {
		summary: lines.join('\n').slice(0, 120_000),
		startDate: start,
		endDate: end && end !== start ? end : null,
		sorted,
	};
}

async function apiJson(pathname, { method = 'GET', body } = {}) {
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `${method} ${pathname} → HTTP ${res.status}`);
	}
	return data;
}

async function mergeInto(keepId, mergeId) {
	return apiJson('/api/profiles/merge', {
		method: 'POST',
		body: { keepId, mergeId },
	});
}

async function patchProfile(id, patch) {
	return apiJson(`/api/profiles/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body: patch,
	});
}

async function addTimeline(id, entry) {
	return apiJson(`/api/profiles/${encodeURIComponent(id)}/timeline`, {
		method: 'POST',
		body: entry,
	});
}

function selectMembers(all, cluster) {
	return all.filter((p) => {
		const nameHit = cluster.memberNameRe ? cluster.memberNameRe.test(p.name) : true;
		const summaryHit = cluster.memberNameRe ? cluster.memberNameRe.test(p.summary) : true;
		if (cluster.matchNameOnly) {
			if (!nameHit) return false;
		} else if (cluster.memberNameRe && !nameHit && !summaryHit) {
			return false;
		}
		if (cluster.excludeNameRe && (cluster.excludeNameRe.test(p.name) || cluster.excludeNameRe.test(p.summary))) {
			return false;
		}
		return true;
	});
}

function isUsefulWikiHit(hit, cluster) {
	const t = String(hit.title || '').toLowerCase();
	if (!t) return false;
	if (/\bsong\b|\balbum\b|\bfilm\b|\bepisode\b|\bdisambiguation\b/.test(t)) return false;
	// Prefer hits that share a topical token with the cluster id / canonical name
	const tokens = String(cluster.canonicalName || cluster.id)
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 5);
	if (!tokens.length) return true;
	return tokens.some((tok) => t.includes(tok) || String(hit.snippet || '').toLowerCase().includes(tok));
}

function pickCanonical(members, cluster) {
	// Prefer USGS final-list / broadest dated span / longest summary as keep
	const scored = members.map((m) => {
		let score = (m.summary || '').length;
		if (/final 2025 list of critical minerals/i.test(m.name)) score += 50_000;
		if (/coast guard academy stem/i.test(m.name) && /whiting-turner/i.test(m.name)) score += 20_000;
		if (/white house before responding/i.test(m.name)) score += 10_000;
		if (m.feed === 'usgs-science-snippet') score += 500;
		return { m, score };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored[0].m;
}

async function consolidateCluster(cluster, all) {
	const minMembers = cluster.minMembers ?? 2;
	const members = selectMembers(all, cluster);
	if (members.length < minMembers) {
		return { id: cluster.id, status: 'skip', reason: `members=${members.length} < ${minMembers}` };
	}

	const wikiNotes = [];
	for (const q of cluster.wikiQueries || []) {
		try {
			const hits = await wikiSearch(q, 5);
			for (const h of hits) {
				if (!isUsefulWikiHit(h, cluster)) continue;
				if (wikiNotes.some((w) => w.title === h.title)) continue;
				wikiNotes.push(h);
				if (wikiNotes.length >= 4) break;
			}
		} catch (err) {
			wikiNotes.push({
				title: `Wiki search failed: ${q}`,
				snippet: err instanceof Error ? err.message : String(err),
				link: '',
			});
		}
		await sleep(80);
		if (wikiNotes.length >= 4) break;
	}

	const { summary, startDate, endDate, sorted } = buildTimelineSummary({
		cluster,
		members,
		wikiNotes: wikiNotes.slice(0, 6),
	});
	const keep = pickCanonical(members, cluster);
	const mergeIds = members.filter((m) => m.id !== keep.id).map((m) => m.id);

	console.log(
		`[consolidate] ${cluster.id}: members=${members.length} keep=${keep.slug} merge=${mergeIds.length} wiki=${wikiNotes.length}`,
	);
	for (const m of sorted) {
		console.log(`  - ${m.startDate || '----'} ${m.name.slice(0, 80)}`);
	}

	if (DRY_RUN) {
		console.log(`[consolidate] DRY summary preview (${summary.length}c):\n${summary.slice(0, 900)}\n…\n`);
		return {
			id: cluster.id,
			status: 'dry_run',
			keepId: keep.id,
			keepSlug: keep.slug,
			mergeIds,
			memberNames: sorted.map((m) => m.name),
			wikiTitles: wikiNotes.map((w) => w.title),
			summaryChars: summary.length,
		};
	}

	// Merge others into keep (left-to-right)
	for (const mid of mergeIds) {
		try {
			await mergeInto(keep.id, mid);
			console.log(`[consolidate] merged ${mid} → ${keep.id}`);
			await sleep(100);
		} catch (err) {
			console.error(`[consolidate] merge fail ${mid}:`, err instanceof Error ? err.message : err);
		}
	}

	await patchProfile(keep.id, {
		name: cluster.canonicalName,
		summary,
		startDate,
		endDate,
		metadata: {
			topicClusterId: cluster.id,
			topicConsolidatedAt: new Date().toISOString(),
			topicMemberCount: members.length,
			wikiFactCheck: wikiNotes.slice(0, 6).map((w) => ({
				title: w.title,
				snippet: w.snippet,
				link: w.link,
			})),
			newsBucket: keep.metadata?.newsBucket || null,
			newsRegion: keep.metadata?.newsRegion || null,
			corpora: [
				...new Set([
					...((keep.metadata?.corpora || [])),
					'news_rss',
					'topic_consolidated',
					`cluster:${cluster.id}`,
				]),
			],
		},
	});

	// Timeline entries (one per source article)
	for (const m of sorted) {
		try {
			await addTimeline(keep.id, {
				title: m.name,
				summary: firstSentences(m.summary, 400),
				eventDate: m.startDate,
				angle: 'general',
				entryKind: 'observation',
				sourceCorpus: `news_rss:${m.feed || 'unknown'}`,
				sourceUrl: m.sourceUrl,
				sourceRef: m.sourceUrl || m.slug,
			});
			await sleep(60);
		} catch (err) {
			console.error(`[consolidate] timeline fail ${m.slug}:`, err instanceof Error ? err.message : err);
		}
	}

	return {
		id: cluster.id,
		status: 'ok',
		keepId: keep.id,
		keepSlug: keep.slug,
		merged: mergeIds.length,
		wikiTitles: wikiNotes.map((w) => w.title),
		summaryChars: summary.length,
	};
}

async function main() {
	const all = loadNewsProfiles();
	const clusters = ONLY.length ? CLUSTERS.filter((c) => ONLY.includes(c.id)) : CLUSTERS;
	console.log(`[consolidate] news_profiles=${all.length} clusters=${clusters.length} dryRun=${DRY_RUN} kiwix=${KIWIX}`);

	const results = [];
	for (const cluster of clusters) {
		try {
			results.push(await consolidateCluster(cluster, all));
		} catch (err) {
			console.error(`[consolidate] cluster ${cluster.id} failed:`, err);
			results.push({
				id: cluster.id,
				status: 'error',
				error: err instanceof Error ? err.message : String(err),
			});
		}
		await sleep(150);
	}

	const report = {
		finishedAt: new Date().toISOString(),
		dryRun: DRY_RUN,
		results,
	};
	fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
	fs.writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`[consolidate] done → ${OUT_PATH}`);
	console.log(
		results
			.map((r) => `${r.id}:${r.status}${r.merged != null ? `(merged=${r.merged})` : ''}`)
			.join(' | '),
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
