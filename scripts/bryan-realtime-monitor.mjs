#!/usr/bin/env node
/**
 * Poll Bryan County real-time filings, enrich each new item from its detail
 * page, and POST into the local research knowledge store.
 *
 * Parsers adapted from https://github.com/timmya111/ok-bryan-county-notify
 * (exact #instrument-feed / #detail / parties / fees selectors).
 *
 * HTML is fetched via FlareSolverr (solves Cloudflare without a desktop login UI):
 *   docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
 *
 * Usage:
 *   BRYAN_MONITOR_ONCE=1 pnpm bryan:monitor
 *   pnpm bryan:monitor
 */
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const REALTIME_URL = process.env.BRYAN_REALTIME_URL || 'https://okcountyrecords.com/real-time/bryan';
const APP_URL = (process.env.RESEARCH_APP_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const FLARESOLVERR_URL = (process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');
const INTERVAL_MS = Math.max(15_000, Number(process.env.BRYAN_MONITOR_INTERVAL_MS) || 60_000);
const ONCE = process.env.BRYAN_MONITOR_ONCE === '1';
const DETAIL_LIMIT = Math.max(1, Math.min(20, Number(process.env.BRYAN_MONITOR_DETAIL_LIMIT) || 5));
const STATE_DIR = process.env.BRYAN_MONITOR_STATE_DIR || path.join(process.cwd(), '.data', 'monitors');
const SEEN_PATH = path.join(STATE_DIR, 'bryan-seen.json');
const DETAIL_TIMEOUT_MS = Math.max(30_000, Number(process.env.BRYAN_MONITOR_DETAIL_TIMEOUT_MS) || 120_000);

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractAbsoluteUrl(href, sourceUrl) {
	if (!href) return null;
	try {
		return new URL(href, sourceUrl).toString();
	} catch {
		return href;
	}
}

function parseNumber(value) {
	const digits = String(value || '').replace(/[^\d]/g, '');
	return digits ? Number(digits) : null;
}

function loadSeen() {
	try {
		const raw = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
		return new Set(Array.isArray(raw?.ids) ? raw.ids.map(String) : []);
	} catch {
		return new Set();
	}
}

function saveSeen(seen) {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const ids = [...seen].slice(-5000);
	fs.writeFileSync(SEEN_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), ids }, null, 2));
}

/** Exact feed parser from ok-bryan-county-notify */
function parseRealTimeFeed(feedRoot, sourceUrl) {
	const list = feedRoot?.querySelector('ul#instrument-feed');
	if (!list) return [];

	return Array.from(list.querySelectorAll('li'))
		.slice(0, 50)
		.map((li) => {
			const instrumentType = normalizeText(li.querySelector('.instrument-type')?.textContent || '');
			const siteName = normalizeText(li.querySelector('.site-name')?.textContent || '');
			const linkEl = li.querySelector('.instrument-detail-link a[href]');
			const instrumentIdText = normalizeText(linkEl?.textContent || '');
			const imagesText = normalizeText(li.querySelector('.instrument-images')?.textContent || '');
			const href = extractAbsoluteUrl(linkEl?.getAttribute('href'), sourceUrl);
			const m = href ? href.match(/\/detail\/([^/]+)\/([^/]+)\/(\d+)/) : null;
			return {
				id: String(li.id || m?.[3] || ''),
				site: m?.[1] || 'bryan',
				instrumentNo: m?.[2] || '',
				instrument: instrumentIdText,
				docType: instrumentType || 'UNKNOWN',
				images: parseNumber(imagesText),
				href,
				county: siteName ? `${siteName} County` : 'Bryan County',
				feedItemHash: li.getAttribute('data-hash') || null,
			};
		})
		.filter((item) => item.id && item.href);
}

/** Detail parser from ok-bryan-county-notify */
function parseDetailPage(document, sourceUrl) {
	const section = document.getElementById('detail');
	if (!section) return null;

	const instrumentType =
		normalizeText(
			Array.from(section.querySelector('#primary-details h2')?.childNodes ?? [])
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent)
				.join(''),
		) || null;

	const primaryFields = {};
	for (const tr of section.querySelectorAll('#primary-details table tr')) {
		const label = normalizeText(tr.querySelector('th')?.textContent || '');
		const value = normalizeText(tr.querySelector('td')?.textContent || '');
		if (label && value) primaryFields[label] = value;
	}

	const secondaryFields = {};
	for (const tr of section.querySelectorAll('#secondary-details table tr')) {
		const label = normalizeText(tr.querySelector('th')?.textContent || '');
		const value = normalizeText(tr.querySelector('td')?.textContent || '');
		if (label && value) secondaryFields[label] = value;
	}

	const county =
		normalizeText(
			Array.from(section.querySelector('#secondary-details h3')?.childNodes ?? [])
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent)
				.join(''),
		) || null;

	const feeMap = {};
	for (const tr of section.querySelectorAll('#detail-fees table tr')) {
		const label = normalizeText(tr.querySelector('th')?.textContent || '');
		const value = normalizeText(tr.querySelector('td')?.textContent || '');
		if (label && value) feeMap[label] = value;
	}

	const parties = [];
	for (const li of section.querySelectorAll('#detail-people > ul > li')) {
		const role = normalizeText(li.querySelector('.label')?.textContent || '');
		const names = Array.from(li.querySelectorAll('.people-type-list li'))
			.map((n) =>
				normalizeText(
					Array.from(n.childNodes)
						.filter((cn) => cn.nodeType === 3)
						.map((cn) => cn.textContent)
						.join(''),
				),
			)
			.filter(Boolean);
		if (role && names.length) parties.push({ role, names });
	}

	const legalDescriptions = Array.from(section.querySelectorAll('#detail-legals ul li'))
		.map((li) =>
			normalizeText(
				Array.from(li.childNodes)
					.filter((n) => n.nodeType === 3)
					.map((n) => n.textContent)
					.join(''),
			),
		)
		.filter(Boolean);

	const partyByRole = (role) => {
		const want = role.toLowerCase();
		const hit = parties.find((p) => {
			const have = p.role.toLowerCase();
			return have === want || have === `${want}s` || have.replace(/s$/, '') === want;
		});
		return hit ? hit.names.join('; ') : null;
	};

	return {
		instrumentType,
		instrumentId: secondaryFields.Instrument || null,
		county,
		book: primaryFields.Book || null,
		pages: primaryFields.Pages || null,
		recorded: secondaryFields.Recorded || feeMap['Recorded on'] || null,
		instrumentDate: feeMap['Instrument date'] || null,
		filingFees: feeMap['Filing Fees'] || null,
		mortgageAmount: feeMap['Mortgage amount'] || null,
		consideration: feeMap['Consideration amount'] || null,
		grantor: partyByRole('Grantor'),
		grantee: partyByRole('Grantee'),
		legal: legalDescriptions.join('; ') || null,
		sourceUrl,
	};
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

async function fetchHtml(url, { timeout = DETAIL_TIMEOUT_MS } = {}) {
	const session = await ensureFlareSession();
	const data = await flareRequest('request.get', {
		url,
		session,
		maxTimeout: timeout,
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

async function scrapeFeed() {
	const html = await fetchHtml(REALTIME_URL, { timeout: DETAIL_TIMEOUT_MS });
	const dom = new JSDOM(html);
	const feedRoot = dom.window.document.getElementById('real-time-feed');
	const items = parseRealTimeFeed(feedRoot, REALTIME_URL);
	log(`feed items=${items.length}`);
	return items;
}

async function scrapeDetail(feedItem) {
	const html = await fetchHtml(feedItem.href);
	const dom = new JSDOM(html);
	const parsed = parseDetailPage(dom.window.document, feedItem.href);
	if (!parsed) {
		throw new Error('Could not parse detail page (#detail missing)');
	}
	return {
		id: feedItem.id,
		site: feedItem.site,
		instrumentNo: feedItem.instrumentNo,
		instrument: parsed.instrumentId || feedItem.instrument,
		docType: parsed.instrumentType || feedItem.docType,
		images: feedItem.images,
		href: feedItem.href,
		county: parsed.county || feedItem.county,
		recorded: parsed.recorded,
		instrumentDate: parsed.instrumentDate,
		book: parsed.book,
		pages: parsed.pages,
		grantor: parsed.grantor,
		grantee: parsed.grantee,
		legal: parsed.legal,
		filingFees: parsed.filingFees,
		mortgageAmount: parsed.mortgageAmount,
		consideration: parsed.consideration,
		scrapedAt: new Date().toISOString(),
	};
}

async function postFilings(filings) {
	const res = await fetch(`${APP_URL}/api/monitors/bryan/ingest`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ filings }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `ingest HTTP ${res.status}`);
	}
	return data;
}

async function pollOnce(seen) {
	const feed = await scrapeFeed();
	const fresh = feed.filter((f) => f.id && !seen.has(f.id));
	if (!fresh.length) {
		log('no new filings');
		return { newCount: 0 };
	}

	log(`new filings=${fresh.length} (detail fetch up to ${DETAIL_LIMIT})`);
	const toFetch = fresh.slice(0, DETAIL_LIMIT);
	const filings = [];
	for (const item of toFetch) {
		try {
			const detail = await scrapeDetail(item);
			filings.push(detail);
			log(
				`detail ${detail.instrument} ${detail.docType} grantor=${detail.grantor} grantee=${detail.grantee} book=${detail.book}`,
			);
		} catch (error) {
			log(`detail failed ${item.instrument}:`, error instanceof Error ? error.message : error);
		}
	}

	if (!filings.length) return { newCount: 0 };

	const result = await postFilings(filings);
	for (const f of filings) seen.add(f.id);
	saveSeen(seen);
	log(`ingest saved=${result.saved} skipped=${result.skipped} projectId=${result.projectId}`);
	return { newCount: result.saved, result };
}

async function main() {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const seen = loadSeen();
	log(
		`starting Bryan monitor (FlareSolverr + notify parsers) → ${APP_URL} flare=${FLARESOLVERR_URL} once=${ONCE} seen=${seen.size}`,
	);

	// health check
	const health = await fetch(`${FLARESOLVERR_URL}/health`).then((r) => r.json()).catch(() => null);
	if (!health || health.status !== 'ok') {
		throw new Error(
			`FlareSolverr not reachable at ${FLARESOLVERR_URL}. Start with:\n` +
				`  docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest`,
		);
	}

	try {
		await pollOnce(seen);
		if (ONCE) return;
		for (;;) {
			await sleep(INTERVAL_MS);
			try {
				await pollOnce(seen);
			} catch (error) {
				log('poll error:', error instanceof Error ? error.message : error);
			}
		}
	} finally {
		if (flareSessionId) {
			await flareRequest('sessions.destroy', { session: flareSessionId }).catch(() => {});
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
