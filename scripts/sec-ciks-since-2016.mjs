#!/usr/bin/env node
/**
 * Build the SEC EDGAR registrant CIK universe for filings since 2016.
 *
 * Downloads quarterly master.gz full-index files (2016 Q1 → current quarter),
 * extracts unique CIKs + latest company name + first/last filing dates + counts,
 * and writes:
 *   .data/sec/ciks-since-2016.json
 *   .data/sec/ciks-since-2016.csv
 *   .data/sec/ciks-since-2016.meta.json
 * Cached indexes: .data/sec/full-index/{YEAR}/QTR{N}/master.gz
 *
 * Usage:
 *   node scripts/sec-ciks-since-2016.mjs
 *   node scripts/sec-ciks-since-2016.mjs --from 2016 --concurrency 2
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.data', 'sec');
const INDEX_DIR = path.join(OUT_DIR, 'full-index');

const UA =
	'Mozilla/5.0 (compatible; ai-research-tool/1.0; +https://localhost; sec-cik-universe)';
const BASE = 'https://www.sec.gov/Archives/edgar/full-index';

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const fromYear = getArgNum('--from', 2016);
const concurrency = Math.min(4, Math.max(1, getArgNum('--concurrency', 2)));
const force = argv.includes('--force');

function padCik(cik) {
	return String(cik || '')
		.replace(/\D/g, '')
		.padStart(10, '0');
}

function listQuarters(startYear) {
	const now = new Date();
	const yNow = now.getUTCFullYear();
	const qNow = Math.floor(now.getUTCMonth() / 3) + 1;
	/** @type {Array<{year:number,qtr:number}>} */
	const out = [];
	for (let year = startYear; year <= yNow; year++) {
		for (let qtr = 1; qtr <= 4; qtr++) {
			if (year === yNow && qtr > qNow) break;
			out.push({ year, qtr });
		}
	}
	return out;
}

async function fetchMasterGz(year, qtr) {
	const dir = path.join(INDEX_DIR, String(year), `QTR${qtr}`);
	const dest = path.join(dir, 'master.gz');
	if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 10_000) {
		return { path: dest, cached: true, bytes: fs.statSync(dest).size };
	}
	fs.mkdirSync(dir, { recursive: true });
	const url = `${BASE}/${year}/QTR${qtr}/master.gz`;
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
	if (res.status === 404) {
		return { path: null, cached: false, missing: true, status: 404 };
	}
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(dest, buf);
	return { path: dest, cached: false, bytes: buf.length };
}

/**
 * @param {Buffer} gz
 * @param {Map<string,{cik:string,name:string,firstFiled:string,lastFiled:string,filings:number,forms:Set<string>}>} byCik
 * @param {{year:number,qtr:number}} q
 */
function parseMasterGzInto(gz, byCik, q) {
	const text = gunzipSyncCached(gz).toString('utf8');
	const lines = text.split(/\r?\n/);
	let dataStarted = false;
	let rows = 0;
	for (const line of lines) {
		if (!dataStarted) {
			if (line.startsWith('CIK|Company Name|Form Type|Date Filed|')) {
				dataStarted = true;
			} else if (line.startsWith('-----')) {
				dataStarted = true;
			}
			continue;
		}
		if (!line || line.startsWith('-')) continue;
		const parts = line.split('|');
		if (parts.length < 4) continue;
		const cikRaw = parts[0].trim();
		if (!/^\d+$/.test(cikRaw)) continue;
		const cik = padCik(cikRaw);
		const name = parts[1].trim();
		const form = parts[2].trim();
		const filed = parts[3].trim(); // YYYY-MM-DD
		rows += 1;
		const prev = byCik.get(cik);
		if (!prev) {
			byCik.set(cik, {
				cik,
				name,
				firstFiled: filed,
				lastFiled: filed,
				filings: 1,
				forms: new Set(form ? [form] : []),
				quarters: new Set([`${q.year}Q${q.qtr}`]),
			});
		} else {
			prev.filings += 1;
			if (name) prev.name = name; // keep latest-seen name
			if (filed && (!prev.firstFiled || filed < prev.firstFiled)) prev.firstFiled = filed;
			if (filed && (!prev.lastFiled || filed > prev.lastFiled)) prev.lastFiled = filed;
			if (form) prev.forms.add(form);
			prev.quarters.add(`${q.year}Q${q.qtr}`);
		}
	}
	return rows;
}

/** Simple sync gunzip via zlib - master.gz fits in memory (~5–15MB uncompressed ~30MB). */
function gunzipSyncCached(gz) {
	return zlib.gunzipSync(gz);
}

const quarters = listQuarters(fromYear);
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(
	JSON.stringify(
		{
			fromYear,
			quarters: quarters.length,
			concurrency,
			outDir: OUT_DIR,
			force,
		},
		null,
		2,
	),
);

/** @type {Map<string, any>} */
const byCik = new Map();
let downloaded = 0;
let cached = 0;
let missing = 0;
let errors = 0;
let filingRows = 0;
let qi = 0;

async function worker() {
	while (qi < quarters.length) {
		const idx = qi++;
		const q = quarters[idx];
		const label = `${q.year}Q${q.qtr}`;
		try {
			const got = await fetchMasterGz(q.year, q.qtr);
			if (got.missing) {
				missing += 1;
				console.log('MISSING', label);
			} else {
				if (got.cached) cached += 1;
				else downloaded += 1;
				const buf = fs.readFileSync(got.path);
				const rows = parseMasterGzInto(buf, byCik, q);
				filingRows += rows;
				console.log(
					'OK',
					label,
					got.cached ? 'cache' : 'fetch',
					`bytes=${got.bytes}`,
					`rows=${rows}`,
					`uniqueCiks=${byCik.size}`,
				);
			}
		} catch (e) {
			errors += 1;
			console.log('ERR', label, e.message);
			// backoff on rate limit
			await new Promise((r) => setTimeout(r, 2000));
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const records = [...byCik.values()]
	.map((r) => ({
		cik: r.cik,
		name: r.name,
		firstFiled: r.firstFiled,
		lastFiled: r.lastFiled,
		filings: r.filings,
		formCount: r.forms.size,
		forms: [...r.forms].sort().slice(0, 40),
		quarterCount: r.quarters.size,
	}))
	.sort((a, b) => a.cik.localeCompare(b.cik));

const jsonPath = path.join(OUT_DIR, 'ciks-since-2016.json');
const csvPath = path.join(OUT_DIR, 'ciks-since-2016.csv');
const metaPath = path.join(OUT_DIR, 'ciks-since-2016.meta.json');

fs.writeFileSync(jsonPath, JSON.stringify(records));
const csvHeader = 'cik,name,firstFiled,lastFiled,filings,formCount,quarterCount\n';
const csvBody = records
	.map((r) => {
		const name = String(r.name || '').replace(/"/g, '""');
		return `${r.cik},"${name}",${r.firstFiled},${r.lastFiled},${r.filings},${r.formCount},${r.quarterCount}`;
	})
	.join('\n');
fs.writeFileSync(csvPath, csvHeader + csvBody + '\n');

const meta = {
	generatedAt: new Date().toISOString(),
	fromYear,
	through: quarters[quarters.length - 1],
	quartersAttempted: quarters.length,
	downloaded,
	cached,
	missing,
	errors,
	filingRows,
	uniqueCiks: records.length,
	paths: {
		json: path.relative(ROOT, jsonPath),
		csv: path.relative(ROOT, csvPath),
		indexes: path.relative(ROOT, INDEX_DIR),
	},
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

console.log(JSON.stringify({ done: true, ...meta }, null, 2));
console.log('sample', JSON.stringify(records.slice(0, 3), null, 2));
