#!/usr/bin/env node
/**
 * Backfill one OKCountyRecords county for a recorded-date range from search
 * result pages (grantor/grantee/legal/book included — no per-detail fetch).
 *
 * Env:
 *   OKCR_SITE          required site slug (e.g. cherokee, bryan)
 *   OKCR_PROJECT_NAME  knowledge project name (default: "{Site} County")
 *   OKCR_COUNTY_LABEL  display county on notes (default: "{Site} County")
 *   OKCR_BACKFILL_START / OKCR_BACKFILL_END  YYYY-MM-DD (default 2026-01-01 → today)
 *   OKCR_BACKFILL_MAX_PAGES  0 = all
 *   OKCR_BACKFILL_STATE      override checkpoint path
 *   RESEARCH_APP_URL, FLARESOLVERR_URL
 *
 * Usage:
 *   OKCR_SITE=cherokee OKCR_BACKFILL_MAX_PAGES=1 node scripts/okcr-county-backfill.mjs
 *   OKCR_SITE=cherokee OKCR_BACKFILL_START=2016-01-01 OKCR_BACKFILL_END=2016-12-31 node scripts/okcr-county-backfill.mjs
 */
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const APP_URL = (process.env.RESEARCH_APP_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const FLARESOLVERR_URL = (process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');

const SITE = String(process.env.OKCR_SITE || '')
	.trim()
	.toLowerCase()
	.replace(/[^a-z0-9_-]/g, '');
if (!SITE) {
	console.error('OKCR_SITE is required (e.g. cherokee)');
	process.exit(1);
}

function titleCaseSite(site) {
	if (site === 'leflore') return 'Le Flore';
	if (site === 'mccurtain') return 'McCurtain';
	if (site === 'mcintosh') return 'McIntosh';
	if (site === 'mcclain') return 'McClain';
	return site.charAt(0).toUpperCase() + site.slice(1);
}

const COUNTY_LABEL =
	process.env.OKCR_COUNTY_LABEL ||
	`${titleCaseSite(SITE)} County`;
const PROJECT_NAME = process.env.OKCR_PROJECT_NAME || COUNTY_LABEL;

const START = process.env.OKCR_BACKFILL_START || process.env.BRYAN_BACKFILL_START || '2026-01-01';
const END =
	process.env.OKCR_BACKFILL_END ||
	process.env.BRYAN_BACKFILL_END ||
	new Date().toISOString().slice(0, 10);
const MAX_PAGES = Math.max(
	0,
	Number(process.env.OKCR_BACKFILL_MAX_PAGES || process.env.BRYAN_BACKFILL_MAX_PAGES) || 0,
);
const BATCH_SIZE = Math.max(
	1,
	Math.min(50, Number(process.env.OKCR_BACKFILL_BATCH || process.env.BRYAN_BACKFILL_BATCH) || 15),
);
const STATE_DIR =
	process.env.OKCR_MONITOR_STATE_DIR ||
	process.env.BRYAN_MONITOR_STATE_DIR ||
	path.join(process.cwd(), '.data', 'monitors');
const STATE_PATH =
	process.env.OKCR_BACKFILL_STATE ||
	path.join(STATE_DIR, `${SITE}-backfill-${START}_${END}.json`);
const PAGE_TIMEOUT_MS = Math.max(
	30_000,
	Number(process.env.OKCR_BACKFILL_TIMEOUT_MS || process.env.BRYAN_BACKFILL_TIMEOUT_MS) || 180_000,
);
const PAGE_DELAY_MS = Math.max(
	0,
	Number(process.env.OKCR_BACKFILL_DELAY_MS || process.env.BRYAN_BACKFILL_DELAY_MS) || 1500,
);
const EMPTY_BACKOFF_MS = Math.max(
	5_000,
	Number(process.env.OKCR_BACKFILL_EMPTY_BACKOFF_MS || process.env.BRYAN_BACKFILL_EMPTY_BACKOFF_MS) ||
		45_000,
);

function log(...args) {
	console.log(new Date().toISOString(), `[${SITE}]`, ...args);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function resultsUrl(page) {
	return `https://okcountyrecords.com/results/site=${SITE}:recorded_start=${START}:recorded_end=${END}/page-${page}`;
}

function loadState() {
	try {
		return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	} catch {
		return {
			site: SITE,
			projectName: PROJECT_NAME,
			start: START,
			end: END,
			nextPage: 1,
			totalPages: null,
			totalResults: null,
			processedIds: [],
			saved: 0,
			skipped: 0,
			errors: 0,
			updatedAt: null,
		};
	}
}

function saveState(state) {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	if (state.processedIds.length > 20000) {
		state.processedIds = state.processedIds.slice(-15000);
	}
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

let flareSessionId = null;

async function flareRequest(cmd, extra = {}) {
	const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd, ...extra }),
	});
	const data = await res.json();
	if (data.status !== 'ok') {
		throw new Error(data.message || `FlareSolverr ${cmd} failed`);
	}
	return data;
}

async function ensureFlareSession() {
	if (flareSessionId) return flareSessionId;
	const created = await flareRequest('sessions.create');
	flareSessionId = created.session;
	log(`FlareSolverr session=${flareSessionId}`);
	return flareSessionId;
}

async function fetchHtml(url) {
	const session = await ensureFlareSession();
	const data = await flareRequest('request.get', {
		url,
		session,
		maxTimeout: PAGE_TIMEOUT_MS,
	});
	const html = data.solution?.response || '';
	const status = data.solution?.status;
	if (!html || status >= 400) {
		throw new Error(`fetch failed status=${status} len=${html.length}`);
	}
	if (/just a moment|attention required/i.test(html.slice(0, 2000))) {
		throw new Error('Cloudflare challenge HTML returned');
	}
	return html;
}

function parseResultsPage(html, pageUrl) {
	const doc = new JSDOM(html).window.document;
	const bodyText = doc.body?.textContent || '';
	const totalMatch = bodyText.match(/([\d,]+)\s+results?/i);
	const totalResults = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;

	let totalPages = null;
	const pageNums = [...doc.querySelectorAll('a[href*="/page-"]')]
		.map((a) => {
			const m = (a.getAttribute('href') || '').match(/\/page-(\d+)/);
			return m ? Number(m[1]) : null;
		})
		.filter((n) => Number.isFinite(n));
	if (pageNums.length) totalPages = Math.max(...pageNums);

	const table = doc.querySelector('table');
	const filings = [];
	if (!table) return { filings, totalResults, totalPages, htmlLen: html.length };

	const headerCells = [...table.querySelectorAll('thead th')].map((th) => normalizeText(th.textContent));
	const headers =
		headerCells.length > 0
			? headerCells
			: [
					'County',
					'Recorded',
					'Instrument',
					'Type',
					'Book',
					'Page(s)',
					'Grantor',
					'Grantee',
					'Legal Description',
					'Images',
				];

	const idx = (name) => {
		const i = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
		return i >= 0 ? i : headers.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
	};

	const rowEls = table.querySelectorAll('tbody tr');
	const rows = rowEls.length ? rowEls : table.querySelectorAll('tr');
	for (const tr of rows) {
		if (tr.querySelector('th')) continue;
		const a = tr.querySelector('a[href*="/detail/"]');
		if (!a) continue;
		let href = a.getAttribute('href') || '';
		if (href.startsWith('/')) href = `https://okcountyrecords.com${href}`;
		const m = href.match(/\/detail\/([^/]+)\/([^/]+)\/(\d+)/);
		if (!m) continue;

		const cells = [...tr.querySelectorAll('td')].map((td) => normalizeText(td.textContent));
		const get = (name) => {
			const i = idx(name);
			return i >= 0 ? cells[i] || null : null;
		};

		const imagesRaw = get('Images') || '';
		const imagesMatch = imagesRaw.match(/(\d+)/);
		const instrumentNo = m[2];
		const instrumentCell = get('Instrument') || instrumentNo;
		const instrument = instrumentCell.startsWith('I-') ? instrumentCell : `I-${instrumentCell}`;
		const countyCell = get('County');
		const county = countyCell
			? /county$/i.test(countyCell)
				? countyCell
				: `${countyCell} County`
			: COUNTY_LABEL;

		filings.push({
			id: m[3],
			site: m[1],
			instrumentNo,
			instrument,
			docType: get('Type') || 'UNKNOWN',
			images: imagesMatch ? Number(imagesMatch[1]) : null,
			href,
			county,
			recorded: get('Recorded'),
			instrumentDate: null,
			book: get('Book'),
			pages: get('Page(s)') || get('Pages'),
			grantor: get('Grantor'),
			grantee: get('Grantee'),
			legal: get('Legal Description') || get('Legal'),
			filingFees: null,
			mortgageAmount: null,
			consideration: null,
			scrapedAt: new Date().toISOString(),
			sourcePage: pageUrl,
		});
	}

	return { filings, totalResults, totalPages, htmlLen: html.length };
}

async function postFilings(filings) {
	const res = await fetch(`${APP_URL}/api/monitors/bryan/ingest`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ filings, projectName: PROJECT_NAME }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `ingest HTTP ${res.status}`);
	}
	return data;
}

async function main() {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const health = await fetch(`${FLARESOLVERR_URL}/health`)
		.then((r) => r.json())
		.catch(() => null);
	if (!health || health.status !== 'ok') {
		throw new Error(`FlareSolverr not reachable at ${FLARESOLVERR_URL}`);
	}

	const state = loadState();
	if (state.start !== START || state.end !== END || state.site !== SITE) {
		state.site = SITE;
		state.projectName = PROJECT_NAME;
		state.start = START;
		state.end = END;
		state.nextPage = 1;
		state.totalPages = null;
		state.totalResults = null;
	}
	state.projectName = PROJECT_NAME;

	const processed = new Set(state.processedIds.map(String));
	log(
		`starting backfill project=${PROJECT_NAME} range=${START}→${END} state=${STATE_PATH} nextPage=${state.nextPage} saved=${state.saved} skipped=${state.skipped}`,
	);

	let page = state.nextPage || 1;
	let pagesDone = 0;
	let emptyStreak = 0;

	try {
		while (true) {
			if (MAX_PAGES > 0 && pagesDone >= MAX_PAGES) {
				log(`stopped after MAX_PAGES=${MAX_PAGES}`);
				break;
			}
			if (state.totalPages && page > state.totalPages) {
				log(`completed all pages (totalPages=${state.totalPages})`);
				break;
			}

			const url = resultsUrl(page);
			log(`page ${page} ${url}`);
			let parsed = null;
			let fetchAttempts = 0;
			while (true) {
				fetchAttempts += 1;
				try {
					const html = await fetchHtml(url);
					parsed = parseResultsPage(html, url);
					if (parsed.totalResults != null) state.totalResults = parsed.totalResults;
					if (parsed.totalPages != null) state.totalPages = parsed.totalPages;

					const pastEnd = state.totalPages != null && page > state.totalPages;
					const expectMore = !pastEnd;

					if (!parsed.filings.length && expectMore) {
						log(
							`page ${page} empty attempt=${fetchAttempts} htmlLen=${parsed.htmlLen} — backing off ${EMPTY_BACKOFF_MS}ms`,
						);
						if (flareSessionId) {
							await flareRequest('sessions.destroy', { session: flareSessionId }).catch(() => {});
							flareSessionId = null;
						}
						saveState(state);
						await sleep(EMPTY_BACKOFF_MS);
						if (fetchAttempts % 5 === 0) {
							log(`page ${page} extended cool-down 120s`);
							await sleep(120_000);
						}
						continue;
					}
					break;
				} catch (error) {
					log(`page ${page} fetch error attempt=${fetchAttempts}:`, error instanceof Error ? error.message : error);
					state.errors += 1;
					saveState(state);
					if (flareSessionId) {
						await flareRequest('sessions.destroy', { session: flareSessionId }).catch(() => {});
						flareSessionId = null;
					}
					await sleep(Math.min(120_000, 5000 * fetchAttempts));
				}
			}

			const fresh = parsed.filings.filter((f) => f.id && !processed.has(f.id));
			log(
				`page ${page}: rows=${parsed.filings.length} new=${fresh.length} totalResults=${state.totalResults} totalPages=${state.totalPages}`,
			);

			if (!parsed.filings.length) {
				emptyStreak += 1;
				const pastEnd = state.totalPages != null && page > state.totalPages;
				if (pastEnd || emptyStreak >= 3) {
					log(pastEnd ? `past totalPages=${state.totalPages} — done` : 'confirmed end of results');
					break;
				}
			} else {
				emptyStreak = 0;
			}

			for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
				const batch = fresh.slice(i, i + BATCH_SIZE);
				try {
					const result = await postFilings(batch);
					state.saved += result.saved || 0;
					state.skipped += result.skipped || 0;
					for (const f of batch) {
						processed.add(f.id);
						state.processedIds.push(f.id);
					}
					log(`ingest batch saved=${result.saved} skipped=${result.skipped} cumulativeSaved=${state.saved}`);
				} catch (error) {
					state.errors += 1;
					log(`ingest error:`, error instanceof Error ? error.message : error);
					await sleep(2000);
				}
			}

			page += 1;
			pagesDone += 1;
			state.nextPage = page;
			saveState(state);
			if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
		}
	} finally {
		saveState(state);
		if (flareSessionId) {
			await flareRequest('sessions.destroy', { session: flareSessionId }).catch(() => {});
		}
	}

	log(
		`done saved=${state.saved} skipped=${state.skipped} errors=${state.errors} nextPage=${state.nextPage} totalResults=${state.totalResults}`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
