#!/usr/bin/env node
/**
 * Full-site resumable crawler for Imperial War Museums (https://www.iwm.org.uk/)
 * seeded from /history/first-world-war/timeline-of-conflict-since-1914, /history hubs,
 * and https://www.iwm.org.uk/sitemap.xml.
 *
 * Respects robots.txt Disallow rules and avoids infinite catalog/search traps
 * (/collections/search, /collections/item/object/*), while following all /history/*,
 * /research/*, /learning/*, /iwm-institute/*, /memorials/*, /podcasts/*, /visits/*,
 * /events/*, /corporate/*, /partnerships/*, /about/*, and /collections/* editorial pages.
 *
 * Output: .data/iwm-site/
 *   - pages/<hash12>.html
 *   - digests/<hash12>.md
 *   - catalog.json
 *   - structure.json
 *   - pdfs.json
 *   - OVERVIEW.md
 *
 * Usage:
 *   node scripts/iwm-site-corpus.mjs
 *   IWM_MAX_PAGES=5000 IWM_SLEEP_MS=250 node scripts/iwm-site-corpus.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'iwm-site');
const PAGES_DIR = path.join(OUT, 'pages');
const DIGESTS_DIR = path.join(OUT, 'digests');
const CATALOG_PATH = path.join(OUT, 'catalog.json');
const STRUCTURE_PATH = path.join(OUT, 'structure.json');
const PDFS_PATH = path.join(OUT, 'pdfs.json');
const OVERVIEW_PATH = path.join(OUT, 'OVERVIEW.md');

const BASE_HOST = 'www.iwm.org.uk';
const BASE_URL = `https://${BASE_HOST}`;
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SLEEP_MS = Math.max(50, Number(process.env.IWM_SLEEP_MS || 250));
const MAX_PAGES = Math.max(10, Number(process.env.IWM_MAX_PAGES || 15000));
const INCLUDE_OBJECTS = process.env.IWM_INCLUDE_OBJECTS === '1';

const DISALLOW_PREFIXES = [
	'/core/',
	'/profiles/',
	'/admin/',
	'/comment/',
	'/filter/',
	'/node/add',
	'/search',
	'/user/',
	'/media/oembed',
	'/index.php/',
	'/collections/search',
	'/form/',
	'/webform/',
	'/thank-you',
];

const SKIP_EXT_RE =
	/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|woff|woff2|ttf|eot|mp4|mp3|wav|ogg|webm|zip|gz|tar|xml|json|ics|vcf)$/i;

function ensureDirs() {
	fs.mkdirSync(PAGES_DIR, { recursive: true });
	fs.mkdirSync(DIGESTS_DIR, { recursive: true });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function urlHash(u) {
	return crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);
}

function normalizeUrl(raw, baseUrl = BASE_URL) {
	if (!raw) return null;
	const trimmed = String(raw).trim();
	if (!trimmed || /^(mailto:|tel:|javascript:|#)/i.test(trimmed)) return null;
	let u;
	try {
		u = new URL(trimmed, baseUrl);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	if (u.hostname !== BASE_HOST && u.hostname !== 'iwm.org.uk') return null;
	u.protocol = 'https:';
	u.hostname = BASE_HOST;
	u.hash = '';

	// Strip tracking params; keep only ?page=N (bounded <= 80) on listing paths
	const pageParam = u.searchParams.get('page');
	u.search = '';
	if (pageParam != null && /^\d+$/.test(pageParam)) {
		const pn = Number(pageParam);
		if (pn >= 1 && pn <= 80 && /^\/(history|research|learning|iwm-institute|podcasts|events|memorials)/.test(u.pathname)) {
			u.searchParams.set('page', String(pn));
		}
	}

	// Clean trailing slash except root
	if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
		u.pathname = u.pathname.slice(0, -1);
	}

	const p = u.pathname;
	if (SKIP_EXT_RE.test(p)) return null;
	for (const bad of DISALLOW_PREFIXES) {
		if (p === bad || p.startsWith(bad)) return null;
	}
	if (!INCLUDE_OBJECTS && (p.startsWith('/collections/item/object/') || p.startsWith('/collections/listing/object-'))) {
		return null;
	}
	return u.toString();
}

function sectionOf(u) {
	try {
		const seg = new URL(u).pathname.split('/').filter(Boolean)[0] || 'root';
		return seg.toLowerCase();
	} catch {
		return 'other';
	}
}

function priorityOf(u) {
	const sec = sectionOf(u);
	if (sec === 'history') return 0;
	if (sec === 'research' || sec === 'iwm-institute' || sec === 'institute') return 1;
	if (sec === 'learning' || sec === 'memorials' || sec === 'podcasts') return 2;
	if (sec === 'collections') return 3;
	return 4;
}

function curlFetch(url) {
	return execFileSync(
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
		{ encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
	);
}

function parsePage(html, url) {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const title = (doc.querySelector('h1')?.textContent || doc.title || '')
		.replace(/\s+/g, ' ')
		.trim();

	const outLinks = [];
	const pdfLinks = [];
	const seenLinks = new Set();

	for (const a of doc.querySelectorAll('a[href]')) {
		const rawHref = a.getAttribute('href');
		if (!rawHref) continue;
		if (/\.pdf(?:[?#]|$)/i.test(rawHref)) {
			try {
				const pu = new URL(rawHref, url).toString();
				pdfLinks.push({ url: pu, text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 140), from: url });
			} catch {
				/* ignore */
			}
			continue;
		}
		const norm = normalizeUrl(rawHref, url);
		if (norm && !seenLinks.has(norm)) {
			seenLinks.add(norm);
			outLinks.push(norm);
		}
	}

	const main = doc.querySelector('main') || doc.querySelector('article') || doc.body;
	for (const el of main.querySelectorAll('script, style, nav, footer, form, iframe, svg')) {
		el.remove();
	}

	const headings = [...main.querySelectorAll('h1, h2, h3')]
		.map((h) => h.textContent.replace(/\s+/g, ' ').trim())
		.filter(
			(t) =>
				t &&
				!/^(related content|about iwm|commercial services|keep in touch|legal|iwm books|iwm online shop)$/i.test(
					t,
				),
		)
		.slice(0, 30);

	const paragraphs = [];
	const seenP = new Set();
	for (const p of main.querySelectorAll('p, li, blockquote')) {
		if (p.closest('.block-iwm-related-content, .related-content, footer, nav')) continue;
		const txt = p.textContent.replace(/\s+/g, ' ').trim();
		if (txt.length < 25) continue;
		if (/^Explore our award-winning|^Inspired by people’s stories of war|cookie/i.test(txt)) continue;
		if (seenP.has(txt)) continue;
		seenP.add(txt);
		paragraphs.push(txt);
	}

	const text = paragraphs.join('\n\n');
	const datedMentions = [];
	const dmSeen = new Set();
	for (const m of text.matchAll(
		/\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:18|19|20)\d{2})\b/g,
	)) {
		if (!dmSeen.has(m[1])) {
			dmSeen.add(m[1]);
			datedMentions.push(m[1]);
		}
	}

	const years = [...new Set([...text.matchAll(/\b((?:18|19|20)\d{2})\b/g)].map((m) => m[1]))].slice(0, 30);

	return {
		title,
		headings,
		paragraphs: paragraphs.slice(0, 120),
		textChars: text.length,
		datedMentions: datedMentions.slice(0, 30),
		years,
		outLinks,
		pdfLinks,
	};
}

function loadCatalog() {
	if (fs.existsSync(CATALOG_PATH)) {
		try {
			return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
		} catch {
			/* fresh */
		}
	}
	return {
		version: 1,
		base: BASE_URL,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		pages: {},
		pdfs: {},
	};
}

function saveCheckpoint(catalog, queueSize) {
	catalog.updatedAt = new Date().toISOString();
	fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

	const bySection = {};
	let okCount = 0;
	let errCount = 0;
	let totalChars = 0;
	for (const [u, info] of Object.entries(catalog.pages)) {
		const sec = info.section || sectionOf(u);
		bySection[sec] = (bySection[sec] || 0) + 1;
		if (info.ok) {
			okCount += 1;
			totalChars += Number(info.textChars || 0);
		} else {
			errCount += 1;
		}
	}

	const pdfList = Object.values(catalog.pdfs || {});
	fs.writeFileSync(PDFS_PATH, JSON.stringify(pdfList, null, 2));

	const structure = {
		base: BASE_URL,
		updatedAt: catalog.updatedAt,
		crawledTotal: Object.keys(catalog.pages).length,
		okCount,
		errCount,
		remainingQueue: queueSize,
		totalTextChars: totalChars,
		pdfCount: pdfList.length,
		bySection,
	};
	fs.writeFileSync(STRUCTURE_PATH, JSON.stringify(structure, null, 2));

	const topSections = Object.entries(bySection)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `| \`/${k}\` | ${v} |`)
		.join('\n');

	const overview = `# Imperial War Museums (www.iwm.org.uk) Full-Site Corpus

- **Updated:** ${catalog.updatedAt}
- **Crawled pages:** ${okCount} OK (${errCount} errors), queue remaining: ${queueSize}
- **Total extracted text:** ${(totalChars / 1_000_000).toFixed(2)} MB
- **Discovered PDFs:** ${pdfList.length}

## Pages by Section

| Section | Pages |
| --- | ---: |
${topSections}
`;
	fs.writeFileSync(OVERVIEW_PATH, overview, 'utf8');
}

async function main() {
	ensureDirs();
	const catalog = loadCatalog();

	// Priority queues (0 = /history, 1 = /research & institute, 2 = learning/memorials/podcasts, 3 = collections, 4 = rest)
	const buckets = [[], [], [], [], []];
	const queued = new Set(Object.keys(catalog.pages));

	function enqueue(rawUrl) {
		const u = normalizeUrl(rawUrl);
		if (!u || queued.has(u)) return;
		queued.add(u);
		buckets[priorityOf(u)].push(u);
	}

	// Re-enqueue outLinks from already-crawled pages so resuming never loses the frontier!
	for (const info of Object.values(catalog.pages)) {
		if (Array.isArray(info.discoveredLinks)) {
			for (const l of info.discoveredLinks) enqueue(l);
		}
	}

	// Priority seeds
	const seeds = [
		`${BASE_URL}/history/first-world-war/timeline-of-conflict-since-1914`,
		`${BASE_URL}/history`,
		`${BASE_URL}/history/first-world-war`,
		`${BASE_URL}/history/second-world-war`,
		`${BASE_URL}/history/cold-war`,
		`${BASE_URL}/history/contemporary-conflict`,
		`${BASE_URL}/history/iwm`,
		`${BASE_URL}/research`,
		`${BASE_URL}/learning`,
		`${BASE_URL}/iwm-institute`,
		`${BASE_URL}/memorials`,
		`${BASE_URL}/podcasts`,
		`${BASE_URL}/collections`,
		`${BASE_URL}/`,
	];
	for (const s of seeds) enqueue(s);

	// Seed from sitemap.xml
	try {
		const sm = curlFetch(`${BASE_URL}/sitemap.xml`);
		const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
		for (const loc of locs) enqueue(loc);
		console.log(`[iwm-site] seeded ${locs.length} URLs from sitemap.xml`);
	} catch (err) {
		console.warn(`[iwm-site] sitemap.xml seed failed: ${err.message}`);
	}

	const queueSize = () => buckets.reduce((acc, b) => acc + b.length, 0);
	const dequeue = () => {
		for (const b of buckets) {
			if (b.length > 0) return b.shift();
		}
		return null;
	};

	console.log(
		`[iwm-site] start already_crawled=${Object.keys(catalog.pages).length} initial_queue=${queueSize()} max_pages=${MAX_PAGES}`,
	);

	let fetchedThisRun = 0;
	let consecutiveErrors = 0;

	while (Object.keys(catalog.pages).length < MAX_PAGES) {
		const url = dequeue();
		if (!url) break;
		if (catalog.pages[url]) continue;

		const h = urlHash(url);
		const pageFile = path.join(PAGES_DIR, `${h}.html`);
		const digestFile = path.join(DIGESTS_DIR, `${h}.md`);
		const sec = sectionOf(url);

		let html = null;
		let fromCache = false;
		if (fs.existsSync(pageFile) && fs.statSync(pageFile).size > 400) {
			html = fs.readFileSync(pageFile, 'utf8');
			fromCache = true;
		} else {
			try {
				html = curlFetch(url);
				fs.writeFileSync(pageFile, html, 'utf8');
				consecutiveErrors = 0;
			} catch (err) {
				const msg = String(err.message || err).slice(0, 180);
				catalog.pages[url] = {
					ok: false,
					section: sec,
					error: msg,
					at: new Date().toISOString(),
				};
				consecutiveErrors += 1;
				console.warn(`[iwm-site] ERR (${consecutiveErrors}) ${url}: ${msg}`);
				if (consecutiveErrors >= 15) {
					console.warn('[iwm-site] 15 consecutive errors; cooling down 60s');
					await sleep(60000);
					consecutiveErrors = 0;
				} else {
					await sleep(Math.min(5000, SLEEP_MS * 4));
				}
				continue;
			}
		}

		try {
			const parsed = parsePage(html, url);
			const md = [
				`# ${parsed.title || url}`,
				'',
				`- **URL:** ${url}`,
				`- **Section:** ${sec}`,
				parsed.headings.length ? `- **Headings:** ${parsed.headings.join(' | ')}` : '',
				parsed.datedMentions.length
					? `- **Dated mentions:** ${parsed.datedMentions.join('; ')}`
					: '',
				parsed.years.length ? `- **Years:** ${parsed.years.join(', ')}` : '',
				'',
				...parsed.paragraphs.map((p) => `${p}\n`),
			]
				.filter((l) => l !== undefined)
				.join('\n');
			fs.writeFileSync(digestFile, md, 'utf8');

			for (const l of parsed.outLinks) enqueue(l);
			for (const pdf of parsed.pdfLinks) {
				if (!catalog.pdfs[pdf.url]) catalog.pdfs[pdf.url] = pdf;
			}

			catalog.pages[url] = {
				ok: true,
				section: sec,
				title: parsed.title,
				path: `pages/${h}.html`,
				digest: `digests/${h}.md`,
				bytes: Buffer.byteLength(html, 'utf8'),
				textChars: parsed.textChars,
				outLinks: parsed.outLinks.length,
				datedMentionsCount: parsed.datedMentions.length,
				years: parsed.years.slice(0, 12),
				discoveredLinks: parsed.outLinks.slice(0, 120),
				at: new Date().toISOString(),
			};

			fetchedThisRun += 1;
			if (fetchedThisRun % 25 === 0) {
				saveCheckpoint(catalog, queueSize());
				console.log(
					`[iwm-site] progress crawled=${Object.keys(catalog.pages).length} queue=${queueSize()} pdfs=${Object.keys(catalog.pdfs).length} last=${sec}/${h} (${parsed.textChars} chars)`,
				);
			}
		} catch (err) {
			catalog.pages[url] = {
				ok: false,
				section: sec,
				error: `parse: ${String(err.message || err).slice(0, 160)}`,
				at: new Date().toISOString(),
			};
		}

		if (!fromCache) await sleep(SLEEP_MS);
	}

	saveCheckpoint(catalog, queueSize());
	console.log(
		`[iwm-site] COMPLETE crawled=${Object.keys(catalog.pages).length} remaining_queue=${queueSize()} pdfs=${Object.keys(catalog.pdfs).length}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
