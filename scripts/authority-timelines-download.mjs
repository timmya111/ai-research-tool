#!/usr/bin/env node
/**
 * Download + normalize authority promo/press/EO events → .data/authority-timelines/
 *
 * Usage:
 *   node scripts/authority-timelines-download.mjs
 *   START_YEAR=2024 FR_MAX_PAGES=20 node scripts/authority-timelines-download.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	OUT,
	ensureDir,
	sleep,
	loadGazetteer,
	normalizeEvent,
	upsertEvents,
	fetchText,
	eoRelevant,
	sha1,
} from './lib/authority-timelines.mjs';

const START_YEAR = Number(process.env.START_YEAR || 2016);
const SLEEP_MS = Number(process.env.AUTHORITY_SLEEP_MS || 500);
const FR_MAX_PAGES = Number(process.env.FR_MAX_PAGES || 40);
const FR_PER_PAGE = 100;

function stripCdata(s) {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseRssItems(xml) {
	const items = [];
	for (const block of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
		const b = block[1];
		const title = stripCdata((b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
		const link = stripCdata((b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
		const pub = stripCdata((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
		const desc = stripCdata((b.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
		if (!title || !link) continue;
		const d = pub ? new Date(pub) : null;
		const date = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
		items.push({ title, url: link, date, summary: desc });
	}
	return items;
}

function saveRaw(sourceId, name, body) {
	const dir = path.join(OUT, 'raw', sourceId);
	ensureDir(dir);
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return path.relative(OUT, file);
}

async function ingestIceRss(gazetteer) {
	const url = 'https://www.ice.gov/rss/ice-breaking-news';
	const res = await fetchText(url);
	const rawPath = saveRaw('ice-rss', `breaking-${new Date().toISOString().slice(0, 10)}.xml`, res.text);
	if (!res.ok) {
		console.warn(`[ice-rss] HTTP ${res.status}`);
		return [];
	}
	const events = [];
	for (const item of parseRssItems(res.text)) {
		if (item.date && Number(item.date.slice(0, 4)) < START_YEAR) continue;
		events.push(
			normalizeEvent(
				{
					agency: 'ICE',
					date: item.date || new Date().toISOString().slice(0, 10),
					dateKind: 'published',
					title: item.title,
					summary: item.summary,
					url: item.url,
					source: 'ice.gov',
					rawPath,
				},
				gazetteer,
			),
		);
	}
	console.log(`[ice-rss] ${events.length} events`);
	return events;
}

async function ingestDhsPress(gazetteer) {
	const events = [];
	// First page + a few "all news" style pages if linked
	const seeds = [
		'https://www.dhs.gov/news-releases/press-releases',
		'https://www.dhs.gov/all-news-updates',
		'https://www.dhs.gov/making-america-safe-again',
	];
	const seenUrl = new Set();

	for (const seed of seeds) {
		const res = await fetchText(seed);
		const day = new Date().toISOString().slice(0, 10);
		const rawPath = saveRaw('dhs-press', `${sha1(seed)}-${day}.html`, res.text);
		if (!res.ok) {
			console.warn(`[dhs] ${seed} → HTTP ${res.status}`);
			continue;
		}
		const isPromoHub = /making-america-safe-again/i.test(seed);
		const hrefs = new Set();
		for (const m of res.text.matchAll(/href="((?:https:\/\/www\.dhs\.gov)?\/news\/\d{4}\/\d{2}\/\d{2}\/[^"]+)"/g)) {
			hrefs.add(m[1].startsWith('http') ? m[1] : `https://www.dhs.gov${m[1]}`);
		}
		// Promo hub also lists ice.gov / dhs titles as text — capture list items with dates
		for (const m of res.text.matchAll(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4}):\s*([^<\n]+)/g,
		)) {
			const title = stripTags(m[4]).trim();
			if (title.length < 12) continue;
			const dt = new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`);
			const date = Number.isNaN(dt.getTime()) ? `${m[3]}-01-01` : dt.toISOString().slice(0, 10);
			if (Number(date.slice(0, 4)) < START_YEAR) continue;
			const fakeUrl = `${seed}#${sha1(title + date)}`;
			if (seenUrl.has(fakeUrl)) continue;
			seenUrl.add(fakeUrl);
			events.push(
				normalizeEvent(
					{
						agency: 'DHS',
						date,
						dateKind: 'published',
						title,
						url: fakeUrl,
						source: 'dhs.gov',
						materialType: isPromoHub ? 'promo_campaign' : undefined,
						rawPath,
					},
					gazetteer,
				),
			);
		}

		for (const href of hrefs) {
			if (seenUrl.has(href)) continue;
			seenUrl.add(href);
			const dm = href.match(/\/news\/(\d{4})\/(\d{2})\/(\d{2})\//);
			const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '';
			if (date && Number(dm[1]) < START_YEAR) continue;
			const slug = href.split('/').pop().replace(/-/g, ' ');
			const title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
			events.push(
				normalizeEvent(
					{
						agency: 'DHS',
						date: date || new Date().toISOString().slice(0, 10),
						dateKind: 'published',
						title,
						url: href,
						source: 'dhs.gov',
						materialType: isPromoHub ? 'promo_campaign' : undefined,
						rawPath,
					},
					gazetteer,
				),
			);
		}
		await sleep(SLEEP_MS);
	}
	console.log(`[dhs] ${events.length} events`);
	return events;
}

function stripTags(s) {
	return String(s || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

async function ingestFederalRegisterEos(gazetteer) {
	const events = [];
	let page = 1;
	let totalPages = 1;
	while (page <= Math.min(totalPages, FR_MAX_PAGES)) {
		const u = new URL('https://www.federalregister.gov/api/v1/documents.json');
		u.searchParams.append('conditions[type][]', 'PRESDOCU');
		u.searchParams.append('conditions[presidential_document_type][]', 'executive_order');
		u.searchParams.set('order', 'newest');
		u.searchParams.set('per_page', String(FR_PER_PAGE));
		u.searchParams.set('page', String(page));
		const res = await fetchText(u.toString(), {
			headers: { accept: 'application/json' },
		});
		saveRaw('wh-eo', `fr-eo-page-${page}.json`, res.text);
		if (!res.ok) {
			console.warn(`[fr-eo] page ${page} HTTP ${res.status}`);
			break;
		}
		let data;
		try {
			data = JSON.parse(res.text);
		} catch {
			console.warn(`[fr-eo] bad JSON page ${page}`);
			break;
		}
		totalPages = Number(data.total_pages || 1);
		const results = data.results || [];
		if (!results.length) break;
		let stop = false;
		for (const r of results) {
			const title = r.title || '';
			const abstract = r.abstract || '';
			const signing = (r.signing_date || r.publication_date || '').slice(0, 10);
			if (signing && Number(signing.slice(0, 4)) < START_YEAR) {
				stop = true;
				continue;
			}
			if (!eoRelevant(title, abstract)) continue;
			events.push(
				normalizeEvent(
					{
						agency: 'WH',
						date: signing,
						dateKind: 'signed',
						title,
						summary: abstract,
						url: r.html_url || r.pdf_url || u.toString(),
						source: 'federalregister.gov',
						materialType: 'signed_directive',
						audience: 'domestic',
						topics: ['executive_order'],
					},
					gazetteer,
				),
			);
		}
		console.log(`[fr-eo] page ${page}/${totalPages} kept_running_total=${events.length}`);
		if (stop && results.every((r) => Number(String(r.signing_date || r.publication_date || '9999').slice(0, 4)) < START_YEAR)) {
			break;
		}
		page += 1;
		await sleep(SLEEP_MS);
	}
	console.log(`[fr-eo] ${events.length} relevant EOs since ${START_YEAR}`);
	return events;
}

async function ingestDeaStub() {
	const url = 'https://www.dea.gov/what-we-do/news/press-releases';
	const res = await fetchText(url);
	saveRaw('dea-press', `probe-${Date.now()}.html`, res.text);
	if (!res.ok) {
		console.warn(`[dea] blocked or failed HTTP ${res.status} — Playwright fallback later`);
		ensureDir(path.join(OUT, 'raw', 'dea-press'));
		fs.writeFileSync(
			path.join(OUT, 'raw', 'dea-press', 'STATUS.json'),
			JSON.stringify(
				{
					ok: false,
					status: res.status,
					url,
					at: new Date().toISOString(),
					note: 'Akamai/Edge 403 for non-browser clients; use Playwright enrich pass.',
				},
				null,
				2,
			),
		);
		return [];
	}
	return [];
}

function splitByAgencyAndYear(events) {
	const byAgency = new Map();
	const byYear = new Map();
	for (const e of events) {
		if (!byAgency.has(e.agency)) byAgency.set(e.agency, []);
		byAgency.get(e.agency).push(e);
		const y = String(e.date || '').slice(0, 4) || 'unknown';
		if (!byYear.has(y)) byYear.set(y, []);
		byYear.get(y).push(e);
	}
	ensureDir(path.join(OUT, 'events', 'by-agency'));
	ensureDir(path.join(OUT, 'events', 'by-year'));
	for (const [agency, rows] of byAgency) {
		fs.writeFileSync(path.join(OUT, 'events', 'by-agency', `${agency}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	}
	for (const [year, rows] of byYear) {
		fs.writeFileSync(path.join(OUT, 'events', 'by-year', `${year}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	}
}

async function main() {
	ensureDir(OUT);
	const gazetteer = loadGazetteer();
	const incoming = [];
	incoming.push(...(await ingestIceRss(gazetteer)));
	await sleep(SLEEP_MS);
	incoming.push(...(await ingestDhsPress(gazetteer)));
	await sleep(SLEEP_MS);
	incoming.push(...(await ingestFederalRegisterEos(gazetteer)));
	await sleep(SLEEP_MS);
	incoming.push(...(await ingestDeaStub()));

	const eventsPath = path.join(OUT, 'events', 'events.jsonl');
	const stats = upsertEvents(eventsPath, incoming);
	const all = JSON.parse(
		`[${fs
			.readFileSync(eventsPath, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.join(',')}]`,
	);
	splitByAgencyAndYear(all);

	const corridor = all.filter((e) => (e.geos || []).some((g) => g.corridor)).length;
	console.log(
		`[authority] upsert total=${stats.total} added=${stats.added} updated=${stats.updated} corridor_tagged=${corridor}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
