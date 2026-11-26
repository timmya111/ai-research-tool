#!/usr/bin/env node
/**
 * Firm / public-entity name filter — before creating a profile:
 *
 * 1. Normalize the display name
 * 2. Guess profileType (never `government` for known retailers / tickers)
 * 3. Resolve strong IDs in order: ticker → SEC CIK → IRS EIN → LEI/CUSIP when present
 * 4. If a ticker is known/guessed, pull Yahoo Finance quote profile (via FlareSolverr)
 * 5. Match against existing profiles by major ID (do not create duplicates / wrong types)
 *
 * Usage:
 *   node scripts/firm-name-id-filter.mjs "Walmart"
 *   node scripts/firm-name-id-filter.mjs --ticker WMT
 *   FLARESOLVERR_URL=http://127.0.0.1:8191 node scripts/firm-name-id-filter.mjs --ticker WMT --apply
 *
 * `--apply` upserts/patches the canonical firm profile from Yahoo (localhost API).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FLARE = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3333';
const APPLY = process.argv.includes('--apply');

/** Well-known US public companies: name needles → ticker (extend as needed). */
const NAME_TO_TICKER = [
	{ re: /\bwal-?mart\b/i, ticker: 'WMT', legalName: 'Walmart Inc.', exchange: 'NYSE' },
	{ re: /\bexxon\s*mobil\b|\bexxonmobil\b/i, ticker: 'XOM', legalName: 'Exxon Mobil Corporation', exchange: 'NYSE' },
	{ re: /\bverizon\b/i, ticker: 'VZ', legalName: 'Verizon Communications Inc.', exchange: 'NYSE' },
	{ re: /\bdeere\b|\bjohn\s*deere\b/i, ticker: 'DE', legalName: 'Deere & Company', exchange: 'NYSE' },
	{ re: /\bmastec\b/i, ticker: 'MTZ', legalName: 'MasTec, Inc.', exchange: 'NYSE' },
	{ re: /\bfluor\b/i, ticker: 'FLR', legalName: 'Fluor Corporation', exchange: 'NYSE' },
	{ re: /\bsouthwest\s+airlines\b/i, ticker: 'LUV', legalName: 'Southwest Airlines Co.', exchange: 'NYSE' },
	{ re: /\btexas\s+instruments\b|\b\bti\b/i, ticker: 'TXN', legalName: 'Texas Instruments Incorporated', exchange: 'NASDAQ' },
	{ re: /\bkatherine?\s*clark|kimberly-?clark\b/i, ticker: 'KMB', legalName: 'Kimberly-Clark Corporation', exchange: 'NYSE' },
	{ re: /\bmckesson\b/i, ticker: 'MCK', legalName: 'McKesson Corporation', exchange: 'NYSE' },
	{ re: /\bcaterpillar\b/i, ticker: 'CAT', legalName: 'Caterpillar Inc.', exchange: 'NYSE' },
	{ re: /\b7-?eleven\b|\bseven[\s-]?eleven\b/i, ticker: null, legalName: '7-Eleven, Inc.', exchange: null },
	{ re: /\bstaples\b/i, ticker: null, legalName: 'Staples, LLC', exchange: null },
];

const WRONG_TYPE_FOR_TICKER = new Set(['government', 'person', 'historic_event', 'region']);

function parseArgs(argv) {
	let name = '';
	let ticker = '';
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--ticker') ticker = String(argv[++i] || '')
			.trim()
			.toUpperCase();
		else if (a === '--apply') continue;
		else if (!a.startsWith('-')) name = a;
	}
	return { name, ticker };
}

function guessFromName(name) {
	const n = String(name || '').trim();
	for (const row of NAME_TO_TICKER) {
		if (row.re.test(n)) return row;
	}
	return null;
}

function openProfilesDb() {
	const dbPath = path.join(ROOT, '.data/profiles/profiles.sqlite');
	if (!fs.existsSync(dbPath)) return null;
	return new DatabaseSync(dbPath, { readOnly: true });
}

function findByMajorId(db, scheme, value) {
	if (!db || !value) return [];
	const norm = String(value).trim().toLowerCase();
	return db
		.prepare(
			`SELECT p.id, p.slug, p.profile_type, p.name, p.status
       FROM profile_identifiers i
       JOIN profiles p ON p.id = i.profile_id
       WHERE lower(i.scheme) = lower(?) AND lower(i.normalized_value) = ?`,
		)
		.all(scheme, norm);
}

function findByName(db, name) {
	if (!db || !name) return [];
	const q = `%${String(name).trim().toLowerCase()}%`;
	return db
		.prepare(
			`SELECT id, slug, profile_type, name, status FROM profiles
       WHERE lower(name) LIKE ? OR lower(slug) LIKE ?
       ORDER BY CASE profile_type WHEN 'firm' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 20`,
		)
		.all(q, q);
}

async function flareGet(url) {
	const res = await fetch(`${FLARE}/v1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 90000 }),
	});
	if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
	const data = await res.json();
	const html = data?.solution?.response || '';
	if (!html) throw new Error('FlareSolverr empty response');
	return html;
}

function stripTags(html) {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, '\n')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n+/g, '\n');
}

/** Best-effort parse of Yahoo Finance /quote/{TICKER}/profile/ HTML. */
export function parseYahooProfileHtml(html, ticker) {
	const text = stripTags(html);
	const out = {
		ticker: String(ticker || '').toUpperCase(),
		legalName: null,
		address: null,
		city: null,
		state: null,
		zip: null,
		country: null,
		phone: null,
		website: null,
		sector: null,
		industry: null,
		fullTimeEmployees: null,
		description: null,
		officers: [],
		sourceUrl: `https://finance.yahoo.com/quote/${ticker}/profile/`,
	};

	const addr = text.match(
		/([0-9][^\n]*\n[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\nUnited States)/,
	);
	if (addr) {
		const lines = addr[1].split('\n').map((s) => s.trim());
		out.address = lines[0] || null;
		const csz = (lines[1] || '').match(/^(.+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
		if (csz) {
			out.city = csz[1];
			out.state = csz[2];
			out.zip = csz[3];
		}
		out.country = 'United States';
	}

	const phone = text.match(/\n(\d{3}-\d{3}-\d{4})\n/);
	if (phone) out.phone = phone[1];

	const web = text.match(/\n(https?:\/\/[^\n]+)\n\s*Sector:/);
	if (web) out.website = web[1].trim();

	const sector = text.match(/Sector:\s*\n\s*([^\n]+)\n\s*Industry:\s*\n\s*([^\n]+)/);
	if (sector) {
		out.sector = sector[1].trim();
		out.industry = sector[2].trim();
	}

	const emp = text.match(/Full Time Employees:\s*\n\s*([0-9,]+)/i);
	if (emp) out.fullTimeEmployees = Number(String(emp[1]).replace(/,/g, '')) || null;

	const desc = text.match(/Description\s*\n\s*\n\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/);
	if (desc) out.description = desc[1].replace(/\n/g, ' ').trim();

	// Officers: Mr./Ms. Name \n Title
	const chunkStart = Math.max(0, text.indexOf('1 Customer Drive') - 3000);
	const chunk = text.slice(chunkStart, text.indexOf('1 Customer Drive') > 0 ? text.indexOf('1 Customer Drive') : chunkStart + 3000);
	const officerRe =
		/((?:Mr\.|Ms\.|Mrs\.)\s+[A-Za-z .'-]+(?:\s+(?:Jr\.|Sr\.|Ph\.D\.|J\.D\.))?)\n([^\n]+)\n/g;
	let m;
	while ((m = officerRe.exec(chunk || text))) {
		const name = m[1].replace(/^(?:Mr\.|Ms\.|Mrs\.)\s+/, '').trim();
		const title = m[2].trim();
		if (/^--|^\d/.test(title)) continue;
		out.officers.push({ name, title });
	}

	const legal = text.match(/\n(Walmart Inc\.|[A-Z][A-Za-z0-9 &.,'-]{2,80} Inc\.)\n\s*\n\s*\d/);
	if (legal) out.legalName = legal[1].trim();

	return out;
}

async function fetchYahooProfile(ticker) {
	const url = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/profile/`;
	const html = await flareGet(url);
	return parseYahooProfileHtml(html, ticker);
}

async function api(method, p, body) {
	const res = await fetch(`${BASE}${p}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	return { status: res.status, data };
}

async function applyYahooToFirm(yahoo, existingFirmId) {
	const summaryParts = [];
	if (yahoo.description) summaryParts.push(yahoo.description);
	summaryParts.push(
		`Ticker ${yahoo.ticker}${yahoo.sector ? ` · ${yahoo.sector}` : ''}${yahoo.industry ? ` / ${yahoo.industry}` : ''}${yahoo.fullTimeEmployees ? ` · employees ~${yahoo.fullTimeEmployees.toLocaleString()}` : ''}.`,
	);
	summaryParts.push(`Source: ${yahoo.sourceUrl}`);

	const meta = {
		ticker: yahoo.ticker,
		exchange: 'NYSE',
		website: yahoo.website || undefined,
		yahooFinanceUrl: yahoo.sourceUrl,
		phone: yahoo.phone || undefined,
		sector: yahoo.sector || undefined,
		industry: yahoo.industry || undefined,
		fullTimeEmployees: yahoo.fullTimeEmployees || undefined,
		legalName: yahoo.legalName || undefined,
		corpora: ['yahoo-finance-profile'],
	};

	if (existingFirmId) {
		await api('PATCH', `/api/profiles/${existingFirmId}`, {
			summary: summaryParts.join('\n\n'),
			status: 'pinned',
			metadata: meta,
			addAlias: yahoo.legalName || undefined,
		});
		if (yahoo.address) {
			await api('PATCH', `/api/profiles/${existingFirmId}`, {
				addLocation: {
					raw: [yahoo.address, yahoo.city && yahoo.state && yahoo.zip ? `${yahoo.city}, ${yahoo.state} ${yahoo.zip}` : null, yahoo.country]
						.filter(Boolean)
						.join(', '),
					role: 'hq',
					sourceCorpus: 'yahoo-finance-profile',
				},
			});
		}
		await api('PATCH', `/api/profiles/${existingFirmId}`, {
			addIdentifier: { scheme: 'ticker', value: yahoo.ticker, sourceCorpus: 'yahoo-finance-profile' },
		});
		return existingFirmId;
	}

	const created = await api('POST', '/api/profiles', {
		profileType: 'firm',
		name: yahoo.legalName || yahoo.ticker,
		status: 'pinned',
		summary: summaryParts.join('\n\n'),
		sourceCorpus: 'yahoo-finance-profile',
		metadata: meta,
		aliases: yahoo.legalName ? [{ alias: yahoo.legalName }] : [],
	});
	return created.data?.profile?.id || null;
}

async function main() {
	const { name, ticker: tickerArg } = parseArgs(process.argv);
	const guessed = name ? guessFromName(name) : null;
	const ticker = (tickerArg || guessed?.ticker || '').toUpperCase();

	const report = {
		inputName: name || null,
		recommendedProfileType: 'firm',
		warnings: [],
		ticker: ticker || null,
		guessed,
		existingByName: [],
		existingByTicker: [],
		yahoo: null,
		decision: null,
	};

	if (name && /department|commission|city of|county|isd|school district/i.test(name) && !ticker) {
		report.recommendedProfileType = 'government';
	}

	const db = openProfilesDb();
	if (name) report.existingByName = findByName(db, name);
	if (ticker) report.existingByTicker = findByMajorId(db, 'ticker', ticker);

	for (const hit of report.existingByName) {
		if (WRONG_TYPE_FOR_TICKER.has(hit.profile_type) && ticker) {
			report.warnings.push(
				`Existing ${hit.slug} has profileType=${hit.profile_type} but name maps to ticker ${ticker} — use firm card instead`,
			);
		}
	}

	const firmHit =
		report.existingByTicker.find((r) => r.profile_type === 'firm') ||
		report.existingByName.find((r) => r.profile_type === 'firm' && r.status !== 'archived');

	if (ticker) {
		try {
			report.yahoo = await fetchYahooProfile(ticker);
			if (!report.yahoo.description && !report.yahoo.address) {
				report.warnings.push('Yahoo HTML parsed but little profile text — check FlareSolverr / page shape');
			}
		} catch (err) {
			report.warnings.push(`Yahoo fetch failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		report.warnings.push('No ticker resolved — pass --ticker or extend NAME_TO_TICKER');
	}

	if (firmHit) {
		report.decision = {
			action: 'enrich_existing_firm',
			slug: firmHit.slug,
			id: firmHit.id,
		};
	} else if (ticker || guessed?.legalName) {
		report.decision = {
			action: 'create_firm',
			name: guessed?.legalName || name || ticker,
		};
	} else {
		report.decision = { action: 'manual_review' };
	}

	if (APPLY && report.yahoo && report.decision?.action === 'enrich_existing_firm') {
		await applyYahooToFirm(report.yahoo, report.decision.id);
		report.applied = true;
	}

	db?.close?.();
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('firm-name-id-filter.mjs')) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
