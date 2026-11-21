#!/usr/bin/env node
/**
 * DEA press-release enrich via Playwright (Akamai blocks plain fetch).
 *
 * Usage:
 *   node scripts/authority-timelines-dea-playwright.mjs
 *   START_YEAR=2024 DEA_MAX_PAGES=30 node scripts/authority-timelines-dea-playwright.mjs
 *   HEADED=1 node scripts/authority-timelines-dea-playwright.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
	OUT,
	ensureDir,
	sleep,
	loadGazetteer,
	normalizeEvent,
	upsertEvents,
	sha1,
} from './lib/authority-timelines.mjs';

chromium.use(StealthPlugin());

const START_YEAR = Number(process.env.START_YEAR || 2016);
const SLEEP_MS = Number(process.env.AUTHORITY_SLEEP_MS || 750);
const DEA_MAX_PAGES = Number(process.env.DEA_MAX_PAGES || 250);
const DEA_ARCHIVE_MAX_PAGES = Number(process.env.DEA_ARCHIVE_MAX_PAGES || 200);
const HEADED = process.env.HEADED === '1';
const RAW_DIR = path.join(OUT, 'raw', 'dea-press');
const LIST_URL = 'https://www.dea.gov/what-we-do/news/press-releases';
const ALT_LIST_URL = 'https://www.dea.gov/press-releases';
const ARCHIVE_URL = 'https://www.dea.gov/what-we-do/news/press-releases/archive';

function writeStatus(payload) {
	ensureDir(RAW_DIR);
	fs.writeFileSync(path.join(RAW_DIR, 'STATUS.json'), JSON.stringify(payload, null, 2) + '\n');
}

function absUrl(href) {
	if (!href) return '';
	if (href.startsWith('http')) return href;
	return `https://www.dea.gov${href.startsWith('/') ? '' : '/'}${href}`;
}

function parseListingHtml(html) {
	const items = [];
	const seen = new Set();
	for (const m of html.matchAll(
		/<h3 class="teaser__heading">\s*<a href="(\/press-releases\/(\d{4})\/(\d{2})\/(\d{2})\/[^"]+)">([\s\S]*?)<\/a>/gi,
	)) {
		const url = absUrl(m[1]);
		if (seen.has(url)) continue;
		seen.add(url);
		const date = `${m[2]}-${m[3]}-${m[4]}`;
		const title = String(m[5] || '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (title.length < 8) continue;
		items.push({ title, url, date });
	}
	// Fallback: bare article hrefs if teaser markup shifts
	if (!items.length) {
		for (const m of html.matchAll(/href="(\/press-releases\/(\d{4})\/(\d{2})\/(\d{2})\/[^"]+)"/gi)) {
			const url = absUrl(m[1]);
			if (seen.has(url)) continue;
			seen.add(url);
			const date = `${m[2]}-${m[3]}-${m[4]}`;
			const slug = m[1].split('/').pop().replace(/-/g, ' ');
			const title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
			items.push({ title, url, date });
		}
	}
	return items;
}

function maxPager(html) {
	const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
	return pages.length ? Math.max(...pages) : 0;
}

function discoverYears(html, fallbackYears) {
	const found = new Set();
	for (const m of html.matchAll(/press_year%3A(\d{4})/gi)) found.add(Number(m[1]));
	for (const m of html.matchAll(/press_year:(\d{4})/gi)) found.add(Number(m[1]));
	for (const y of fallbackYears) found.add(y);
	return [...found].filter((y) => y >= START_YEAR).sort((a, b) => b - a);
}

async function openBrowser() {
	const browser = await chromium.launch({
		headless: !HEADED,
		args: ['--disable-blink-features=AutomationControlled'],
	});
	const context = await browser.newContext({
		userAgent:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
		viewport: { width: 1400, height: 900 },
		locale: 'en-US',
	});
	const page = await context.newPage();
	return { browser, page };
}

async function fetchPage(page, url, { retries = 3 } = {}) {
	let lastErr;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
			await page.waitForTimeout(1200);
			const html = await page.content();
			return { status: res?.status() || 0, html, finalUrl: page.url() };
		} catch (err) {
			lastErr = err;
			console.warn(`[dea] goto fail attempt ${attempt}/${retries}: ${String(err.message || err).slice(0, 160)}`);
			await sleep(1500 * attempt);
		}
	}
	throw lastErr;
}

async function crawlListing(page, gazetteer, { label, baseUrl, maxPages, year }) {
	const events = [];
	const seen = new Set();
	let hardMax = maxPages;
	for (let p = 0; p < hardMax; p += 1) {
		let url;
		if (year != null) {
			url =
				p === 0
					? `${LIST_URL}?f%5B0%5D=press_year%3A${year}`
					: `${LIST_URL}?f%5B0%5D=press_year%3A${year}&page=${p}`;
		} else {
			url = p === 0 ? baseUrl : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${p}`;
		}
		let status;
		let html;
		try {
			({ status, html } = await fetchPage(page, url));
		} catch (err) {
			console.warn(`[dea] giving up on ${url}: ${String(err.message || err).slice(0, 160)}`);
			break;
		}
		const rawName = `${label}${year != null ? `-${year}` : ''}-p${p}-${Date.now()}.html`;
		fs.writeFileSync(path.join(RAW_DIR, rawName), html);
		if (status && status >= 400) {
			console.warn(`[dea] ${url} → HTTP ${status}`);
			break;
		}
		if (p === 0) {
			const pagerMax = maxPager(html);
			hardMax = Math.min(maxPages, pagerMax > 0 ? pagerMax + 1 : maxPages);
		}
		const items = parseListingHtml(html);
		if (!items.length) {
			console.log(`[dea] ${label}${year != null ? ` ${year}` : ''} p${p} empty — stop`);
			break;
		}
		let kept = 0;
		let old = 0;
		for (const item of items) {
			const y = Number(String(item.date).slice(0, 4));
			if (y && y < START_YEAR) {
				old += 1;
				continue;
			}
			if (seen.has(item.url)) continue;
			seen.add(item.url);
			kept += 1;
			events.push(
				normalizeEvent(
					{
						agency: 'DEA',
						date: item.date,
						dateKind: 'published',
						title: item.title,
						url: item.url,
						source: 'dea.gov',
						rawPath: path.relative(OUT, path.join(RAW_DIR, rawName)),
					},
					gazetteer,
				),
			);
		}
		console.log(
			`[dea] ${label}${year != null ? ` ${year}` : ''} p${p}/${hardMax - 1} items=${items.length} kept=${kept}`,
		);
		if (old && old === items.length) break;
		if (items.length < 3) break;
		await sleep(SLEEP_MS);
	}
	return events;
}

async function main() {
	ensureDir(RAW_DIR);
	const gazetteer = loadGazetteer();
	let browser;
	const incoming = [];
	try {
		const session = await openBrowser();
		browser = session.browser;
		const { page } = session;

		const seed = await fetchPage(page, LIST_URL);
		fs.writeFileSync(path.join(RAW_DIR, `probe-${Date.now()}.html`), seed.html);
		if (!seed.status || seed.status >= 400) {
			// try alt list
			const alt = await fetchPage(page, ALT_LIST_URL);
			fs.writeFileSync(path.join(RAW_DIR, `probe-alt-${Date.now()}.html`), alt.html);
			if (!alt.status || alt.status >= 400) {
				writeStatus({
					ok: false,
					status: alt.status || seed.status || 0,
					url: LIST_URL,
					at: new Date().toISOString(),
					note: 'Playwright could not load DEA press listings',
				});
				throw new Error(`DEA listing blocked HTTP ${alt.status || seed.status}`);
			}
		}

		const years = discoverYears(seed.html, [
			new Date().getUTCFullYear(),
			new Date().getUTCFullYear() - 1,
		]);
		console.log(`[dea] years=${years.join(',') || '(none)'} maxPages=${DEA_MAX_PAGES}`);

		if (years.length) {
			for (const year of years) {
				incoming.push(
					...(await crawlListing(page, gazetteer, {
						label: 'year',
						baseUrl: LIST_URL,
						maxPages: DEA_MAX_PAGES,
						year,
					})),
				);
			}
		}
		// Unfiltered listings paginate more reliably than year facets under Akamai.
		incoming.push(
			...(await crawlListing(page, gazetteer, {
				label: 'list',
				baseUrl: LIST_URL,
				maxPages: DEA_MAX_PAGES,
				year: null,
			})),
		);
		incoming.push(
			...(await crawlListing(page, gazetteer, {
				label: 'alt',
				baseUrl: ALT_LIST_URL,
				maxPages: Math.min(DEA_MAX_PAGES, 80),
				year: null,
			})),
		);

		// Deeper archive for years before the facet list (often only recent years).
		if (START_YEAR < Math.min(...(years.length ? years : [new Date().getUTCFullYear()]))) {
			incoming.push(
				...(await crawlListing(page, gazetteer, {
					label: 'archive',
					baseUrl: ARCHIVE_URL,
					maxPages: DEA_ARCHIVE_MAX_PAGES,
					year: null,
				})),
			);
		}

		const eventsPath = path.join(OUT, 'events', 'events.jsonl');
		const stats = upsertEvents(eventsPath, incoming);
		const byAgencyPath = path.join(OUT, 'events', 'by-agency');
		ensureDir(byAgencyPath);
		const all = fs.existsSync(eventsPath)
			? fs
					.readFileSync(eventsPath, 'utf8')
					.trim()
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
		const dea = all.filter((e) => e.agency === 'DEA');
		fs.writeFileSync(
			path.join(byAgencyPath, 'DEA.jsonl'),
			dea.map((r) => JSON.stringify(r)).join('\n') + (dea.length ? '\n' : ''),
		);

		writeStatus({
			ok: true,
			status: 200,
			url: LIST_URL,
			at: new Date().toISOString(),
			fetched: incoming.length,
			upsert: stats,
			years,
			note: 'Playwright stealth enrich',
		});
		console.log(
			`[dea] done fetched=${incoming.length} upsert total=${stats.total} added=${stats.added} updated=${stats.updated} dea_rows=${dea.length}`,
		);
	} catch (err) {
		// Persist whatever was collected before the failure.
		if (incoming.length) {
			try {
				const eventsPath = path.join(OUT, 'events', 'events.jsonl');
				const stats = upsertEvents(eventsPath, incoming);
				console.warn(`[dea] partial upsert fetched=${incoming.length} total=${stats.total}`);
			} catch (upsertErr) {
				console.warn(`[dea] partial upsert failed: ${String(upsertErr.message || upsertErr).slice(0, 160)}`);
			}
		}
		writeStatus({
			ok: false,
			status: 0,
			url: LIST_URL,
			at: new Date().toISOString(),
			fetched: incoming.length,
			note: String(err?.message || err).slice(0, 400),
			sha: sha1(String(err?.message || err)),
		});
		throw err;
	} finally {
		if (browser) await browser.close().catch(() => {});
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
