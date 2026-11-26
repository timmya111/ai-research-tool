#!/usr/bin/env node
/**
 * Day-by-day official public record index from a Tyler self-service site.
 *
 *   TYLER_HOST=kaufmancountytx-web.tylerhost.net TYLER_SEARCH=DOCSEARCH1008S7 \
 *   DEEDS_OUT=kaufman-deeds COUNTY_LABEL="Kaufman County" \
 *   node scripts/tx-tyler-deeds-download.mjs
 *
 * Writes .data/<DEEDS_OUT>/records/RP/YYYY/YYYY-MM-DD.jsonl plus state.json.
 * Index rows only. Does not open the paid document-image cart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COUNTY_LABEL = String(process.env.COUNTY_LABEL || 'County').trim() || 'County';
const HOST = String(process.env.TYLER_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
const SEARCH = String(process.env.TYLER_SEARCH || '').trim();
const OUT = path.join(ROOT, '.data', String(process.env.DEEDS_OUT || '').trim());
const RECORDS = path.join(OUT, 'records', 'RP');
const STATE_PATH = path.join(OUT, 'state.json');
const BASE = `https://${HOST}`;
const START = String(process.env.START || '2016-01-01');
const END = String(process.env.END || todayISO());
const DAY_DELAY_MS = Number(process.env.TYLER_DAY_DELAY_MS || 400);
const PAGE_DELAY_MS = Number(process.env.TYLER_PAGE_DELAY_MS || 250);
const MAX_RETRIES = Number(process.env.TYLER_MAX_RETRIES || 5);

if (!HOST || !SEARCH || !process.env.DEEDS_OUT) {
	console.error('TYLER_HOST, TYLER_SEARCH, and DEEDS_OUT are required');
	process.exit(1);
}

const cookies = new Map();

function todayISO() {
	const d = new Date();
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function parseISO(iso) {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function formatISO(d) {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function eachDay(start, end) {
	const days = [];
	for (let t = parseISO(start).getTime(); t <= parseISO(end).getTime(); t += 86_400_000) {
		days.push(formatISO(new Date(t)));
	}
	return days;
}

function tylerDate(iso) {
	const [y, m, d] = iso.split('-').map(Number);
	return `${m}/${d}/${y}`;
}

function dayFile(iso) {
	return path.join(RECORDS, iso.slice(0, 4), `${iso}.jsonl`);
}

function loadState() {
	if (!fs.existsSync(STATE_PATH)) {
		return {
			source: 'tyler',
			host: HOST,
			searchId: SEARCH,
			start: START,
			end: END,
			nextDate: START,
			completedDays: 0,
			savedDocs: 0,
			errors: [],
			updatedAt: null,
		};
	}
	return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function storeCookies(res) {
	const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
	for (const line of lines) {
		const pair = line.split(';', 1)[0];
		const i = pair.indexOf('=');
		if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
	}
}

async function request(pathname, { method = 'GET', body = null, headers = {}, accept = 'text/html' } = {}) {
	const res = await fetch(BASE + pathname, {
		method,
		redirect: 'manual',
		headers: {
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
			Accept: accept,
			Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
			...headers,
		},
		body,
	});
	storeCookies(res);
	const text = await res.text();
	if (res.status >= 400) {
		throw new Error(`${method} ${pathname} HTTP ${res.status}`);
	}
	return text;
}

async function acceptDisclaimer() {
	await request('/web/user/disclaimer');
	const body = await request('/web/user/disclaimer', {
		method: 'POST',
		body: '{}',
		accept: 'application/json',
		headers: { 'Content-Type': 'application/json', ajaxRequest: 'true' },
	});
	if (!body.includes('true')) throw new Error(`disclaimer was not accepted: ${body.slice(0, 80)}`);
}

function decode(s) {
	return s
		.replace(/&nbsp;/g, ' ')
		.replace(/&#149;/g, '•')
		.replace(/&amp;/g, '&')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function strip(html) {
	return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseRows(html) {
	const rows = [];
	const parts = html.split('<li class="ss-search-row"');
	for (const part of parts.slice(1)) {
		const chunk = part;
		const id = (chunk.match(/data-documentid="([^"]+)"/) || [])[1] || '';
		const h1 = (chunk.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || '';
		const head = strip(h1).split('•').map((s) => s.trim()).filter(Boolean);
		const columns = {};
		for (const block of chunk.match(/<ul class="selfServiceSearchResultColumn[\s\S]*?<\/ul>/g) || []) {
			const lis = [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1])).filter(Boolean);
			if (!lis.length) continue;
			const label = lis[0].replace(/\s*\(\d+\)\s*$/, '').trim();
			columns[label] = lis.slice(1);
		}
		rows.push({
			id,
			docNumber: head[0] || '',
			bookVolumePage: head[1] || '',
			docType: head[2] || '',
			recordedDate: (columns['Recording Date'] || [])[0] || '',
			grantor: columns.Grantor || [],
			grantee: columns.Grantee || [],
			legal: columns['Legal Description'] || [],
		});
	}
	return rows;
}

function resultSummary(html) {
	const m = html.match(/Showing page\s+(\d+)\s+of\s+(\d+)\s+for\s+([\d,]+)\s+Total Results/i);
	if (m) return { page: Number(m[1]), pages: Number(m[2]), total: Number(m[3].replace(/,/g, '')) };
	if (/No results/i.test(html)) return { page: 1, pages: 0, total: 0 };
	return null;
}

async function searchDay(iso) {
	const form = await request(`/web/search/${SEARCH}`);
	const startName = (form.match(/name="(field_[^"]*StartDate)"/) || [])[1];
	const endName = (form.match(/name="(field_[^"]*EndDate)"/) || [])[1];
	if (!startName || !endName) throw new Error('recording date fields not on the search form');
	const posted = await request(`/web/searchPost/${SEARCH}`, {
		method: 'POST',
		accept: 'application/json',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			ajaxRequest: 'true',
		},
		body: new URLSearchParams({
			[startName]: tylerDate(iso),
			[endName]: tylerDate(iso),
		}).toString(),
	});
	if (!posted.trim().startsWith('{')) throw new Error(`searchPost was not JSON: ${posted.slice(0, 120)}`);
	const meta = JSON.parse(posted);
	const messages = meta.validationMessages || {};
	if (Object.keys(messages).length) throw new Error(`search rejected: ${JSON.stringify(messages).slice(0, 240)}`);
	let pages = Number(meta.totalPages || 0);
	if (!pages) return [];
	const docs = [];
	const seen = new Set();
	for (let page = 1; page <= pages; page += 1) {
		if (page > 1) await sleep(PAGE_DELAY_MS);
		const html = await request(`/web/searchResults/${SEARCH}?page=${page}`, {
			headers: { ajaxRequest: 'true' },
		});
		const summary = resultSummary(html);
		if (!summary) throw new Error(`results page ${page} had no total`);
		if (summary.pages > pages) pages = summary.pages;
		for (const row of parseRows(html)) {
			if (!row.id || seen.has(row.id)) continue;
			seen.add(row.id);
			docs.push(row);
		}
	}
	return docs;
}

async function withRetry(fn) {
	let last;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			console.warn(`[retry] attempt=${attempt}: ${String(err).slice(0, 180)}`);
			await sleep(1500 * attempt);
			try {
				await acceptDisclaimer();
			} catch (err2) {
				console.warn(`[session] disclaimer refresh failed: ${String(err2).slice(0, 160)}`);
			}
		}
	}
	throw last;
}

async function main() {
	fs.mkdirSync(RECORDS, { recursive: true });
	const state = loadState();
	state.originalStart = state.originalStart || state.start || START;
	state.start = state.originalStart;
	state.host = HOST;
	state.searchId = SEARCH;
	state.source = 'tyler';
	if (process.env.END) state.end = END;
	else if (!state.end || parseISO(END) > parseISO(state.end)) state.end = END;
	const runStart = process.env.START ? START : state.nextDate || state.start || START;
	state.nextDate = runStart;
	saveState(state);
	console.log(`${COUNTY_LABEL} tyler index: host=${HOST} search=${SEARCH} ${runStart} → ${state.end}`);
	await acceptDisclaimer();

	for (const iso of eachDay(runStart, state.end)) {
		const file = dayFile(iso);
		if (fs.existsSync(file)) {
			state.nextDate = formatISO(new Date(parseISO(iso).getTime() + 86_400_000));
			saveState(state);
			continue;
		}
		let docs;
		try {
			docs = await withRetry(() => searchDay(iso));
		} catch (err) {
			const msg = String(err).slice(0, 300);
			console.error(`[error] ${iso}: ${msg}`);
			state.errors = (state.errors || []).slice(-40);
			state.errors.push({ at: new Date().toISOString(), iso, error: msg });
			saveState(state);
			await sleep(DAY_DELAY_MS);
			continue;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.partial`;
		fs.writeFileSync(tmp, docs.map((d) => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : ''));
		fs.renameSync(tmp, file);
		state.savedDocs += docs.length;
		state.completedDays += 1;
		state.nextDate = formatISO(new Date(parseISO(iso).getTime() + 86_400_000));
		saveState(state);
		console.log(`[ok] ${iso} saved=${docs.length}`);
		await sleep(DAY_DELAY_MS);
	}
	console.log(`DONE savedDocs=${state.savedDocs} completedDays=${state.completedDays}`);
}

main().catch((err) => {
	console.error('FATAL', err);
	process.exit(1);
});
