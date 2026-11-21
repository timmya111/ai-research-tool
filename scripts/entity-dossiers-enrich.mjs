#!/usr/bin/env node
/**
 * Light enrich: SEC company tickers → CIK + company name via data.sec.gov
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'entity-dossiers');
const UA = 'ai-research-tool/1.0 (local research; entity enrich)';

const TICKERS = {
	PLTR: 'palantir',
	HAL: 'halliburton',
	TTWO: 'rockstar-games',
	RTX: 'rockwell-collins',
	TSLA: 'elon-musk',
	PG: 'bucket-gamble',
};

async function fetchJson(url) {
	const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
	const text = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return JSON.parse(text);
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

async function main() {
	ensureDir(path.join(OUT, 'raw', 'sec'));
	const map = await fetchJson('https://www.sec.gov/files/company_tickers.json');
	fs.writeFileSync(path.join(OUT, 'raw', 'sec', 'company_tickers.json'), JSON.stringify(map));
	const byTicker = {};
	for (const row of Object.values(map)) {
		byTicker[String(row.ticker || '').toUpperCase()] = row;
	}

	const now = new Date().toISOString();
	for (const [ticker, slug] of Object.entries(TICKERS)) {
		const row = byTicker[ticker];
		if (!row) {
			console.warn(`[enrich] ticker ${ticker} not in SEC map`);
			continue;
		}
		const cik = String(row.cik_str).padStart(10, '0');
		const dossierPath = path.join(OUT, 'dossiers', `${slug}.json`);
		const bucketPath = path.join(OUT, 'buckets', `${slug}.json`);
		const target = fs.existsSync(dossierPath) ? dossierPath : bucketPath;
		if (!fs.existsSync(target)) {
			console.warn(`[enrich] missing ${slug}`);
			continue;
		}
		const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
		doc.businesses = doc.businesses || [];
		const label = row.title;
		const existing = doc.businesses.find((b) => String(b.ticker || '').toUpperCase() === ticker);
		if (existing) {
			existing.cik = cik;
			existing.name = existing.name || label;
		} else {
			doc.businesses.push({ name: label, ticker, cik, role: 'sec_issuer' });
		}
		doc.links = doc.links || [];
		const secUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
		if (!doc.links.some((l) => l.url === secUrl)) {
			doc.links.push({ label: `SEC EDGAR ${ticker}`, url: secUrl });
		}
		doc.sources = doc.sources || [];
		doc.sources.push({ url: 'https://www.sec.gov/files/company_tickers.json', fetchedAt: now, note: `${ticker}→CIK ${cik}` });
		doc.updatedAt = now;
		fs.writeFileSync(target, JSON.stringify(doc, null, 2));
		console.log(`[enrich] ${slug} ${ticker} CIK=${cik} ${label}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
