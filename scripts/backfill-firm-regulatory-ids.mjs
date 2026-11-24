#!/usr/bin/env node
/**
 * Backfill Official Regulatory Identifiers for public firm profiles via SEC EDGAR:
 *   sec_cik, ticker (+ exchange meta), irs_ein, sic/sicDescription meta.
 * CUSIP is not in bulk EDGAR submissions — apply curated map when known.
 *
 * Match order: existing sec_cik → metadata cik → ticker id/meta → exact normalized name
 * against company_tickers.json, then enrich from data.sec.gov/submissions.
 *
 * Usage:
 *   node scripts/backfill-firm-regulatory-ids.mjs
 *   node scripts/backfill-firm-regulatory-ids.mjs --limit 300 --concurrency 3 --dry-run
 *   node scripts/backfill-firm-regulatory-ids.mjs --crd-only --limit 2000
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

const { getProfile, addIdentifier, addAlias, updateProfileFields } = await import(
	'../src/lib/research/profiles/store.ts'
);

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const limit = getArgNum('--limit', 500);
const concurrency = Math.min(6, Math.max(1, getArgNum('--concurrency', 3)));
const dryRun = argv.includes('--dry-run');
/** Only firm profiles that already have a FINRA CRD identifier. */
const crdOnly = argv.includes('--crd-only');
const CORPUS = 'sec-edgar-submissions';
const UA =
	'Mozilla/5.0 (compatible; ai-research-tool/1.0; +https://localhost; firm-regulatory-ids)';

/** Curated CUSIPs (not in EDGAR submissions bulk). Key = zero-padded CIK. */
const CURATED_CUSIP_BY_CIK = {
	'0000045012': '406216101', // Halliburton HAL
	'0000320193': '037833100', // Apple AAPL
	'0000789019': '594918104', // Microsoft MSFT
	'0001318605': '88160R101', // Tesla TSLA
	'0001321655': '69608A108', // Palantir PLTR
	'0000886982': '38141G104', // Goldman Sachs GS
	'0000078003': '717081103', // Pfizer PFE
	'0001467858': '37045V100', // General Motors GM
	'0000010456': '459200101', // IBM
	'0001018724': '023135106', // Amazon AMZN
	'0001652044': '02079K305', // Alphabet GOOGL class C often 02079K107 — use Class A common
	'0001045810': '67066G104', // NVIDIA NVDA
	'0001067983': '084670702', // Berkshire Hathaway BRK.B
	'0000101829': '75513E101', // RTX
	'0000946581': '874054109', // Take-Two TTWO
};

function normName(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(
			/\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|lp|the|group|holdings)\b/g,
			' ',
		)
		.replace(/\s+/g, ' ')
		.trim();
}

function padCik(cik) {
	return String(cik || '')
		.replace(/\D/g, '')
		.padStart(10, '0');
}

function formatEin(raw) {
	const digits = String(raw || '').replace(/\D/g, '');
	if (digits.length !== 9) return null;
	// SEC placeholder for non-US / unknown EIN
	if (digits === '000000000') return null;
	return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

const tickersPath = '/tmp/firm-hq/company_tickers.json';
if (!fs.existsSync(tickersPath) || fs.statSync(tickersPath).size < 50_000) {
	const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
		headers: { 'User-Agent': UA, Accept: 'application/json' },
	});
	if (!res.ok) throw new Error(`tickers ${res.status}`);
	fs.mkdirSync('/tmp/firm-hq', { recursive: true });
	fs.writeFileSync(tickersPath, await res.text());
}
const tickersObj = JSON.parse(fs.readFileSync(tickersPath, 'utf8'));
/** @type {Map<string, {cik:string, title:string, ticker:string}>} */
const byNorm = new Map();
/** @type {Map<string, {cik:string, title:string, ticker:string}>} */
const byTicker = new Map();
for (const row of Object.values(tickersObj)) {
	const cik = padCik(row.cik_str);
	const ticker = String(row.ticker || '')
		.trim()
		.toUpperCase();
	const entry = { cik, title: row.title, ticker };
	const n = normName(row.title);
	if (n && n.length >= 3 && !byNorm.has(n)) byNorm.set(n, entry);
	if (ticker && !byTicker.has(ticker)) byTicker.set(ticker, entry);
}

const dbPath = path.join(ROOT, '.data/profiles/profiles.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const firms = db
	.prepare(
		crdOnly
			? `
SELECT p.id, p.slug, p.name, p.metadata_json,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='sec_cik' LIMIT 1) AS sec_cik,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='ticker' LIMIT 1) AS ticker_id,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='irs_ein' LIMIT 1) AS ein_id,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='cusip' LIMIT 1) AS cusip_id
FROM profiles p
WHERE p.profile_type='firm'
  AND EXISTS (
    SELECT 1 FROM profile_identifiers c
    WHERE c.profile_id = p.id AND c.scheme = 'finra_crd'
  )
`
			: `
SELECT p.id, p.slug, p.name, p.metadata_json,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='sec_cik' LIMIT 1) AS sec_cik,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='ticker' LIMIT 1) AS ticker_id,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='irs_ein' LIMIT 1) AS ein_id,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='cusip' LIMIT 1) AS cusip_id
FROM profiles p
WHERE p.profile_type='firm'
`,
	)
	.all();

/** @type {Array<{id:string,slug:string,name:string,cik:string,matchVia:string,hasEin:boolean,hasCusip:boolean,meta:Record<string,unknown>}>} */
const queue = [];
const seen = new Set();

for (const f of firms) {
	let meta = {};
	try {
		meta = JSON.parse(f.metadata_json || '{}') || {};
	} catch {
		meta = {};
	}
	let cik = null;
	let matchVia = null;

	if (f.sec_cik) {
		cik = padCik(f.sec_cik);
		matchVia = 'sec_cik';
	} else if (meta.cik) {
		cik = padCik(meta.cik);
		matchVia = 'meta_cik';
	} else {
		const tick = String(f.ticker_id || meta.ticker || '')
			.trim()
			.toUpperCase()
			.split(/[\s(/]/)[0];
		if (tick && byTicker.has(tick)) {
			cik = byTicker.get(tick).cik;
			matchVia = 'ticker';
		} else {
			const hit = byNorm.get(normName(f.name));
			if (hit) {
				cik = hit.cik;
				matchVia = 'name';
			}
		}
	}

	if (!cik) continue;
	if (seen.has(f.id)) continue;
	seen.add(f.id);

	const curatedCusip = CURATED_CUSIP_BY_CIK[cik] || null;
	const needsEnrich =
		!f.sec_cik ||
		!f.ein_id ||
		!f.ticker_id ||
		meta.sic == null ||
		!meta.exchange ||
		(curatedCusip && !f.cusip_id);
	if (!needsEnrich) continue;

	queue.push({
		id: f.id,
		slug: f.slug,
		name: f.name,
		cik,
		matchVia,
		meta,
	});
}

console.log(
	JSON.stringify(
		{
			firms: firms.length,
			matched: queue.length,
			limit,
			dryRun,
			crdOnly,
			concurrency,
			tickerUniverse: Object.keys(tickersObj).length,
		},
		null,
		2,
	),
);

const work = queue.slice(0, limit);

async function fetchSubmissions(cik) {
	const pad = padCik(cik);
	const url = `https://data.sec.gov/submissions/CIK${pad}.json`;
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`submissions ${res.status}`);
	return res.json();
}

let ok = 0;
let skipped = 0;
let errors = 0;
let i = 0;

async function worker() {
	while (i < work.length) {
		const idx = i++;
		const row = work[idx];
		try {
			const sub = await fetchSubmissions(row.cik);
			if (!sub) {
				skipped += 1;
				console.log('NOSUB', row.slug, row.cik);
			} else {
				const cik = padCik(sub.cik || row.cik);
				const ein = formatEin(sub.ein);
				const tickers = Array.isArray(sub.tickers) ? sub.tickers : [];
				const exchanges = Array.isArray(sub.exchanges) ? sub.exchanges : [];
				const ticker = String(tickers[0] || '')
					.trim()
					.toUpperCase();
				const exchange = String(exchanges[0] || '')
					.trim()
					.toUpperCase();
				const sic = sub.sic != null ? String(sub.sic).trim() : null;
				const sicDescription =
					typeof sub.sicDescription === 'string' ? sub.sicDescription.trim() : null;
				const cusip = CURATED_CUSIP_BY_CIK[cik] || null;

				const metaPatch = {
					cik,
					corpora: Array.isArray(row.meta.corpora)
						? Array.from(new Set([...row.meta.corpora, CORPUS]))
						: [CORPUS],
				};
				if (ticker) metaPatch.ticker = ticker;
				if (exchange) metaPatch.exchange = exchange;
				if (sic) metaPatch.sic = sic;
				if (sicDescription) metaPatch.sicDescription = sicDescription;
				if (ein) metaPatch.ein = ein;
				if (cusip) metaPatch.cusip = cusip;

				if (!dryRun) {
					const prof = getProfile(row.slug);
					if (!prof) throw new Error('missing profile');
					updateProfileFields(prof.id, { metadata: metaPatch });
					addIdentifier({
						profileId: prof.id,
						scheme: 'sec_cik',
						value: cik,
						sourceCorpus: CORPUS,
					});
					if (ticker) {
						addIdentifier({
							profileId: prof.id,
							scheme: 'ticker',
							value: ticker,
							sourceCorpus: CORPUS,
						});
						addAlias({
							profileId: prof.id,
							alias: ticker,
							aliasKind: 'ticker',
							sourceCorpus: CORPUS,
						});
					}
					if (ein) {
						addIdentifier({
							profileId: prof.id,
							scheme: 'irs_ein',
							value: ein,
							sourceCorpus: CORPUS,
						});
					}
					if (cusip) {
						addIdentifier({
							profileId: prof.id,
							scheme: 'cusip',
							value: cusip,
							sourceCorpus: 'cusip-curated',
						});
					}
				}

				ok += 1;
				console.log(
					'OK',
					row.slug,
					row.matchVia,
					'=>',
					JSON.stringify({
						cik,
						ticker: ticker || null,
						exchange: exchange || null,
						ein: ein || null,
						sic: sic || null,
						cusip: cusip || null,
					}),
				);
			}
		} catch (e) {
			errors += 1;
			console.log('ERR', row.slug, e.message);
		}
		await new Promise((r) => setTimeout(r, 160));
		if ((idx + 1) % 25 === 0) {
			console.log(
				JSON.stringify({
					processed: idx + 1,
					ok,
					skipped,
					errors,
					remaining: work.length - idx - 1,
				}),
			);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(
	JSON.stringify({ done: true, processed: work.length, ok, skipped, errors, dryRun }, null, 2),
);
