#!/usr/bin/env node
/**
 * Download and structure the Imperial War Museums "Timeline of conflict since 1914"
 * (https://www.iwm.org.uk/history/first-world-war/timeline-of-conflict-since-1914)
 * plus all linked IWM /history/* conflict overview pages.
 *
 * Output: .data/iwm-conflict-timeline/
 *   - raw/timeline-of-conflict-since-1914.html
 *   - raw/articles/<slug>.html
 *   - articles/<slug>.md
 *   - events/events.jsonl
 *   - entities/entities.json
 *   - entities/summary.json
 *   - digests/EXTRACT.md
 *   - README.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'iwm-conflict-timeline');
const BASE_URL = 'https://www.iwm.org.uk';
const SOURCE_URL = `${BASE_URL}/history/first-world-war/timeline-of-conflict-since-1914`;
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function slugify(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function absUrl(href) {
	if (!href) return null;
	if (/^https?:\/\//i.test(href)) return href;
	if (href.startsWith('/')) return `${BASE_URL}${href}`;
	return `${BASE_URL}/${href}`;
}

async function fetchHtml(url, cachePath) {
	if (cachePath && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 500) {
		return fs.readFileSync(cachePath, 'utf8');
	}
	const html = execFileSync(
		'curl',
		[
			'-sS',
			'-L',
			'-f',
			'--max-time',
			'25',
			'-A',
			UA,
			'-H',
			'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'-H',
			'Accept-Language: en-GB,en;q=0.9',
			url,
		],
		{ encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 },
	);
	if (cachePath) {
		ensureDir(path.dirname(cachePath));
		fs.writeFileSync(cachePath, html, 'utf8');
	}
	return html;
}

function parseConflictLine(text) {
	const clean = text.replace(/\s+/g, ' ').trim();
	// Matches:
	//   "Boer War, 1899 to 1902"
	//   "Kenya Emergency, 1952 to1960"
	//   "Third Afghan War, 1919"
	//   "Israeli-Palestinian Conflict, 1948 onwards"
	//   "Ukraine Conflict, 2014 to date"
	const m = clean.match(
		/^(.+?),\s*(\d{4})(?:\s*(?:to|–|-)\s*(\d{4}|date)|\s+(onwards|present))?$/i,
	);
	if (!m) return null;
	const name = m[1].replace(/^['‘’"]+|['‘’"]+$/g, '').trim();
	const startYear = Number(m[2]);
	const rawEnd = m[3] || m[4] || '';
	const ongoing = /^(date|onwards|present)$/i.test(rawEnd);
	const endYear = /^\d{4}$/.test(rawEnd) ? Number(rawEnd) : ongoing ? null : startYear;
	const dateLabel = ongoing
		? `${startYear} to date`
		: endYear && endYear !== startYear
			? `${startYear}–${endYear}`
			: `${startYear}`;
	return { name, startYear, endYear, ongoing, dateLabel };
}

function extractArticleContent(html, url) {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const title = (doc.querySelector('h1')?.textContent || doc.title || '').replace(/\s+/g, ' ').trim();
	const main = doc.querySelector('main') || doc.querySelector('article') || doc.body;

	// Remove script, style, nav, footer, shop promos
	for (const el of main.querySelectorAll('script, style, nav, footer, form, iframe, svg')) {
		el.remove();
	}

	const headings = [...main.querySelectorAll('h2, h3')]
		.map((h) => h.textContent.replace(/\s+/g, ' ').trim())
		.filter((t) => t && !/^(related content|about iwm|commercial services|keep in touch|legal|iwm books|iwm online shop)$/i.test(t));

	const paragraphs = [];
	const seen = new Set();
	for (const p of main.querySelectorAll('p, li')) {
		// Skip footer/shop/promo boilerplate
		if (p.closest('.block-iwm-related-content, .related-content, footer, nav')) continue;
		const txt = p.textContent.replace(/\s+/g, ' ').trim();
		if (txt.length < 30) continue;
		if (/^Explore our award-winning|^Inspired by people’s stories of war|cookie/i.test(txt)) continue;
		if (seen.has(txt)) continue;
		seen.add(txt);
		paragraphs.push(txt);
	}

	const fullText = paragraphs.join('\n\n');
	// Extract specific full dates mentioned in the article (e.g. "28 June 1914", "1 September 1939")
	const datedMentions = [];
	const dateRe =
		/\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:18|19|20)\d{2})\b/g;
	const dmSeen = new Set();
	for (const match of fullText.matchAll(dateRe)) {
		const d = match[1];
		if (!dmSeen.has(d)) {
			dmSeen.add(d);
			datedMentions.push(d);
		}
	}

	return {
		url,
		title,
		headings: headings.slice(0, 25),
		paragraphs: paragraphs.slice(0, 60),
		summary: paragraphs.slice(0, 3).join(' ').slice(0, 700),
		excerpt: fullText.slice(0, 4000),
		charCount: fullText.length,
		datedMentions: datedMentions.slice(0, 30),
	};
}

const REGION_PATTERNS = [
	['United Kingdom', /\b(britain|british|uk|united kingdom|england|northern ireland|falklands)\b/i],
	['Europe', /\b(europe|france|germany|poland|belgium|spain|bosnia|kosovo|ukraine|russia|cyprus|ireland)\b/i],
	['Middle East', /\b(palestine|israel|suez|egypt|aden|yemen|iraq|syria|gulf|kuwait|isis|middle east)\b/i],
	['South & East Asia', /\b(india|afghan|malay|yangtze|china|korea|vietnam|brunei|indonesia|asia)\b/i],
	['Africa', /\b(boer|south africa|kenya|mau mau|sierra leone|libya|egypt)\b/i],
	['South Atlantic', /\b(falklands|argentina)\b/i],
	['Global', /\b(first world war|second world war|cold war|global coalition)\b/i],
];

function extractRegions(text) {
	const out = [];
	for (const [label, re] of REGION_PATTERNS) {
		if (re.test(text)) out.push(label);
	}
	return out;
}

async function main() {
	ensureDir(path.join(OUT, 'raw', 'articles'));
	ensureDir(path.join(OUT, 'articles'));
	ensureDir(path.join(OUT, 'events'));
	ensureDir(path.join(OUT, 'entities'));
	ensureDir(path.join(OUT, 'digests'));

	const rawMainPath = path.join(OUT, 'raw', 'timeline-of-conflict-since-1914.html');
	const html = await fetchHtml(SOURCE_URL, rawMainPath);
	const dom = new JSDOM(html);
	const doc = dom.window.document;

	const introParagraphs = [];
	const conflicts = [];
	const relatedLinks = [];

	const mainPs = [...doc.querySelectorAll('main p')];
	for (const p of mainPs) {
		const text = p.textContent.replace(/\s+/g, ' ').trim();
		if (!text) continue;
		if (
			/^Conflict took place|^The following list highlights|^While each conflict is described/i.test(
				text,
			)
		) {
			introParagraphs.push(text);
			continue;
		}
		const parsed = parseConflictLine(text);
		if (parsed) {
			const a = p.querySelector('a');
			const href = a ? absUrl(a.getAttribute('href')) : null;
			conflicts.push({
				...parsed,
				rawLine: text,
				articleUrl: href && href.includes('/history/') ? href : null,
			});
		}
	}

	// Also grab the 3 IWM related-content links on the page
	for (const a of doc.querySelectorAll('main a')) {
		const href = absUrl(a.getAttribute('href'));
		if (!href || !href.startsWith(`${BASE_URL}/history/`)) continue;
		const label = a.textContent.replace(/\s+/g, ' ').trim();
		if (
			/\/history\/(iwm\/creation|second-world-war\/causes|first-world-war\/outbreak)$/.test(href) &&
			!relatedLinks.some((r) => r.url === href)
		) {
			relatedLinks.push({ label: label || href.split('/').pop(), url: href });
		}
	}

	// Collect unique linked IWM /history/* article URLs
	const uniqueArticleUrls = [
		...new Set([
			...conflicts.map((c) => c.articleUrl).filter(Boolean),
			...relatedLinks.map((r) => r.url),
		]),
	];

	console.log(
		`[iwm] parsed conflicts=${conflicts.length} linked_articles=${uniqueArticleUrls.length}`,
	);

	const articlesByUrl = new Map();
	for (let idx = 0; idx < uniqueArticleUrls.length; idx++) {
		const url = uniqueArticleUrls[idx];
		const slug = slugify(new URL(url).pathname.replace(/^\/history\//, '')) || `article-${idx + 1}`;
		const cacheFile = path.join(OUT, 'raw', 'articles', `${slug}.html`);
		const wasCached = fs.existsSync(cacheFile);
		try {
			const artHtml = await fetchHtml(url, cacheFile);
			const parsed = extractArticleContent(artHtml, url);
			parsed.slug = slug;
			articlesByUrl.set(url, parsed);

			// Write clean markdown digest for each linked article
			const md = [
				`# ${parsed.title}`,
				'',
				`- **Source:** ${url}`,
				`- **Sections:** ${parsed.headings.join(' | ') || '(none)'}`,
				parsed.datedMentions.length
					? `- **Dated mentions:** ${parsed.datedMentions.join('; ')}`
					: '',
				'',
				...parsed.paragraphs.map((para) => `${para}\n`),
			]
				.filter((line) => line !== undefined)
				.join('\n');
			fs.writeFileSync(path.join(OUT, 'articles', `${slug}.md`), md, 'utf8');
			console.log(
				`[iwm] (${idx + 1}/${uniqueArticleUrls.length}) ${slug} chars=${parsed.charCount} dates=${parsed.datedMentions.length}`,
			);
			if (!wasCached) await sleep(350);
		} catch (err) {
			console.warn(`[iwm] WARN failed ${url}: ${err.message}`);
		}
	}

	// Build events.jsonl (36 conflicts + 3 related context articles)
	const events = [];
	const regionIndex = new Map();

	for (let i = 0; i < conflicts.length; i++) {
		const c = conflicts[i];
		const art = c.articleUrl ? articlesByUrl.get(c.articleUrl) : null;
		const id = `iwm-conflict-${String(i + 1).padStart(3, '0')}`;
		const hay = `${c.name} ${art?.summary || ''}`;
		const regions = extractRegions(hay);

		const ev = {
			id,
			kind: 'conflict',
			title: c.name,
			start_year: c.startYear,
			end_year: c.endYear,
			date: String(c.startYear),
			end_date: c.endYear ? String(c.endYear) : null,
			ongoing: c.ongoing,
			date_label: c.dateLabel,
			raw_line: c.rawLine,
			source_url: SOURCE_URL,
			article_url: c.articleUrl,
			article_slug: art?.slug || null,
			article_title: art?.title || null,
			summary:
				art?.summary ||
				`${c.name} (${c.dateLabel}) — listed in Imperial War Museums' Timeline of Conflict Since 1914.`,
			headings: art?.headings || [],
			dated_mentions: art?.datedMentions || [],
			regions,
			article_chars: art?.charCount || 0,
		};
		events.push(ev);

		for (const reg of regions) {
			const list = regionIndex.get(reg) || [];
			list.push(id);
			regionIndex.set(reg, list);
		}
	}

	for (let i = 0; i < relatedLinks.length; i++) {
		const r = relatedLinks[i];
		const art = articlesByUrl.get(r.url);
		if (!art) continue;
		const id = `iwm-related-${String(i + 1).padStart(2, '0')}`;
		const yearGuess = /1917|creation/i.test(art.title + art.summary)
			? 1917
			: /second world war/i.test(art.title)
				? 1939
				: 1914;
		events.push({
			id,
			kind: 'related_context',
			title: art.title || r.label,
			start_year: yearGuess,
			end_year: yearGuess,
			date: String(yearGuess),
			end_date: null,
			ongoing: false,
			date_label: String(yearGuess),
			raw_line: art.title,
			source_url: SOURCE_URL,
			article_url: r.url,
			article_slug: art.slug,
			article_title: art.title,
			summary: art.summary,
			headings: art.headings,
			dated_mentions: art.datedMentions,
			regions: extractRegions(`${art.title} ${art.summary}`),
			article_chars: art.charCount,
		});
	}

	fs.writeFileSync(
		path.join(OUT, 'events', 'events.jsonl'),
		events.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf8',
	);

	// Entities / region rollup
	const entities = [...regionIndex.entries()].map(([name, event_ids]) => ({
		type: 'region',
		name,
		event_ids,
	}));
	fs.writeFileSync(
		path.join(OUT, 'entities', 'entities.json'),
		JSON.stringify(entities, null, 2) + '\n',
		'utf8',
	);

	const summary = {
		source: SOURCE_URL,
		fetchedAt: new Date().toISOString(),
		introParagraphs,
		conflictCount: conflicts.length,
		relatedArticleCount: relatedLinks.length,
		fetchedArticleCount: articlesByUrl.size,
		dateRange: {
			minYear: Math.min(...conflicts.map((c) => c.startYear)),
			maxYear: Math.max(...conflicts.map((c) => c.endYear || c.startYear)),
			ongoingCount: conflicts.filter((c) => c.ongoing).length,
		},
		regions: entities.map((e) => ({ name: e.name, count: e.event_ids.length })),
	};
	fs.writeFileSync(
		path.join(OUT, 'entities', 'summary.json'),
		JSON.stringify(summary, null, 2) + '\n',
		'utf8',
	);

	// Human-readable EXTRACT.md
	const extractMd = [
		'# Timeline of Conflict Since 1914 — Imperial War Museums (IWM)',
		'',
		`- **Source:** ${SOURCE_URL}`,
		`- **Fetched:** ${summary.fetchedAt}`,
		`- **Conflicts:** ${conflicts.length} (${summary.dateRange.minYear}–present, ${summary.dateRange.ongoingCount} ongoing)`,
		`- **Linked IWM History Articles Captured:** ${articlesByUrl.size}`,
		'',
		'## Overview (IWM)',
		'',
		...introParagraphs.map((p) => `${p}\n`),
		'## Chronological Conflict Table',
		'',
		'| # | Conflict | Dates | Regions | Linked IWM Article |',
		'| --- | --- | --- | --- | --- |',
		...events
			.filter((e) => e.kind === 'conflict')
			.map(
				(e, idx) =>
					`| ${idx + 1} | **${e.title}** | ${e.date_label} | ${e.regions.join(', ')} | ${e.article_url ? `[${e.article_title || e.article_slug}](${e.article_url})` : '—'} |`,
			),
		'',
		'## Summaries & Key Dates',
		'',
		...events.map((e) =>
			[
				`### ${e.title} (${e.date_label})`,
				e.article_url ? `- **Article:** ${e.article_url}` : `- **Source:** ${SOURCE_URL}`,
				e.dated_mentions.length ? `- **Key dates:** ${e.dated_mentions.slice(0, 10).join('; ')}` : '',
				'',
				e.summary,
				'',
			]
				.filter((x) => x !== undefined)
				.join('\n'),
		),
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'digests', 'EXTRACT.md'), extractMd, 'utf8');

	const readme = `# Imperial War Museums — Timeline of Conflict Since 1914 (local)

Source: ${SOURCE_URL}

## Layout
- \`raw/timeline-of-conflict-since-1914.html\` — root IWM timeline page
- \`raw/articles/*.html\` — ${articlesByUrl.size} linked IWM \`/history/*\` overview pages
- \`articles/*.md\` — clean markdown extracts of every linked IWM history page
- \`events/events.jsonl\` — ${conflicts.length} conflicts (1899–present) + ${relatedLinks.length} related IWM context articles
- \`entities/entities.json\` & \`entities/summary.json\` — region rollups & counts
- \`digests/EXTRACT.md\` — full chronological table & article summaries

## Search & Alignment
- Agent tool: \`search_iwm_conflict_timeline\`
- Entity Profiles & Alignment: ingested via \`pnpm profiles:backfill\` onto \`subject_matter:iwm-timeline-of-conflict-since-1914\` + 36 \`historic_event\` profiles + \`nonprofit:imperial-war-museums-iwm\`.
`;
	fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

	console.log(`[iwm] DONE events=${events.length} articles=${articlesByUrl.size} out=${OUT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
