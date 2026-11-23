#!/usr/bin/env node
/**
 * Match firm profiles missing digit streets to SEC company_tickers.json by name,
 * then pull addresses.business from data.sec.gov submissions.
 *
 * Usage:
 *   node scripts/backfill-firm-hq-sec.mjs
 *   node scripts/backfill-firm-hq-sec.mjs --limit 200 --concurrency 4
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { getProfile, addLocation } = await import('../src/lib/research/profiles/store.ts');
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const limit = getArgNum('--limit', 500);
const concurrency = Math.min(6, Math.max(1, getArgNum('--concurrency', 3)));
const CORPUS = 'sec-edgar-submissions';
const UA = 'Mozilla/5.0 (compatible; ai-research-tool/1.0; +https://localhost; firm-hq-backfill)';

function normName(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|lp|the|group|holdings)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const tickersPath = '/tmp/firm-hq/company_tickers.json';
if (!fs.existsSync(tickersPath)) {
	const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`tickers ${res.status}`);
	fs.mkdirSync('/tmp/firm-hq', { recursive: true });
	fs.writeFileSync(tickersPath, await res.text());
}
const tickersObj = JSON.parse(fs.readFileSync(tickersPath, 'utf8'));
/** @type {Map<string, {cik:string, title:string, ticker:string}>} */
const byNorm = new Map();
for (const row of Object.values(tickersObj)) {
	const n = normName(row.title);
	if (!n || n.length < 3) continue;
	if (!byNorm.has(n)) byNorm.set(n, { cik: String(row.cik_str), title: row.title, ticker: row.ticker });
}

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
const missing = db
	.prepare(
		`
SELECT p.slug, p.name
FROM profiles p
WHERE p.profile_type='firm'
  AND NOT EXISTS (
    SELECT 1 FROM profile_locations l WHERE l.profile_id=p.id AND l.raw GLOB '*[0-9]*'
  )
`,
	)
	.all();

const matched = [];
for (const m of missing) {
	const n = normName(m.name);
	const hit = byNorm.get(n);
	if (hit) matched.push({ ...m, ...hit });
}
console.log(JSON.stringify({ missing: missing.length, matched: matched.length, limit }, null, 2));
const queue = matched.slice(0, limit);

async function fetchAddr(cik) {
	const pad = String(cik).replace(/\D/g, '').padStart(10, '0');
	const url = `https://data.sec.gov/submissions/CIK${pad}.json`;
	const res = await fetch(url, { headers: { 'User-Agent': UA } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`${res.status}`);
	const j = await res.json();
	const b = j.addresses?.business || j.addresses?.mailing;
	if (!b?.street1) return null;
	const parts = [b.street1, b.street2, b.city, b.stateOrCountry, b.zipCode].filter(Boolean);
	const uniq = [];
	for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
	let hq = uniq.join(', ');
	hq = hq.replace(/, ([A-Z]{2}), (\d)/, ', $1 $2');
	return /\d/.test(hq) ? hq : null;
}

let withStreet = 0;
let noAddress = 0;
let errors = 0;
let i = 0;

async function worker() {
	while (i < queue.length) {
		const idx = i++;
		const row = queue[idx];
		try {
			const hq = await fetchAddr(row.cik);
			if (!hq) {
				noAddress += 1;
				console.log('NOADDR', row.slug, row.ticker);
			} else {
				const p = getProfile(row.slug);
				const parts = parseAddressParts(hq);
				addLocation({
					profileId: p.id,
					raw: hq,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country || 'US',
					role: 'hq',
					sourceCorpus: CORPUS,
				});
				withStreet += 1;
				console.log('OK', row.slug, '=>', hq);
			}
		} catch (e) {
			errors += 1;
			console.log('ERR', row.slug, e.message);
		}
		await new Promise((r) => setTimeout(r, 150));
		if ((idx + 1) % 25 === 0) {
			console.log(JSON.stringify({ processed: idx + 1, withStreet, noAddress, errors, remaining: queue.length - idx - 1 }));
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(JSON.stringify({ done: true, processed: queue.length, withStreet, noAddress, errors }, null, 2));
