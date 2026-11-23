#!/usr/bin/env node
/**
 * Backfill firm street HQs from FINRA BrokerCheck firm PDFs (Main Office Location).
 * Targets firm profiles with finra_crd that still lack digit-bearing locations.
 *
 * Usage:
 *   node scripts/backfill-firm-hq-brokercheck.mjs --limit 500 --concurrency 4
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [path.join(ROOT, 'src', `${rel}.ts`), path.join(ROOT, 'src', rel, 'index.ts')]) {
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
const concurrency = Math.min(4, Math.max(1, getArgNum('--concurrency', 2)));
const delayMs = getArgNum('--delay-ms', 450);
const CORPUS = 'finra-brokercheck-main-office';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const TMP = '/tmp/firm-hq-brokercheck';
fs.mkdirSync(TMP, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
// Prefer ordinary CRDs (skip synthetic 1_000_000+ placeholders). Name order avoids
// burning the rate limit on the same empty historic high-link PDFs every run.
const rows = db
	.prepare(
		`
SELECT p.slug, p.name, pi.value AS crd,
  (SELECT COUNT(*) FROM profile_links WHERE from_profile_id=p.id OR to_profile_id=p.id) AS link_n
FROM profiles p
JOIN profile_identifiers pi ON pi.profile_id=p.id AND pi.scheme='finra_crd'
WHERE p.profile_type='firm'
  AND CAST(pi.value AS INTEGER) BETWEEN 1 AND 999999
  AND NOT EXISTS (
    SELECT 1 FROM profile_locations l WHERE l.profile_id=p.id AND l.raw GLOB '*[0-9]*'
  )
ORDER BY
  CASE WHEN CAST(pi.value AS INTEGER) < 100000 THEN 0 ELSE 1 END,
  p.name
LIMIT ?
`,
	)
	.all(limit);

console.log(JSON.stringify({ queue: rows.length, limit, concurrency, delayMs }, null, 2));

function leftCol(line) {
	const parts = String(line || '')
		.trim()
		.split(/\s{2,}/);
	return (parts[0] || '').trim();
}

function extractMainOffice(txt) {
	const lines = String(txt || '').split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/Main Office Location/i.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return null;
	const streetParts = [];
	let city = null;
	for (let i = start; i < Math.min(start + 14, lines.length); i++) {
		const left = leftCol(lines[i]);
		if (!left) continue;
		if (/^(Mailing Address|Business Telephone|Firm Profile|Phone|SEC#|CRD#)/i.test(left)) break;
		if (/^(This firm|Disclosure|Report Summary|Firm History|Firm Operations|Are there)/i.test(left)) continue;
		const m = left.match(/^([A-Z][A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
		if (m) {
			city = `${m[1].trim()}, ${m[2]} ${m[3]}`;
			break;
		}
		if (
			/\d/.test(left) ||
			/\b(AVE|AVENUE|ST|STREET|RD|ROAD|BLVD|DRIVE|DR|WAY|PLAZA|PARK|BROADWAY|SQUARE|FLOOR|SUITE|BLDG|BUILDING|CENTER|CENTRE|LANE|LN|COURT|CT|CIRCLE|PLACE|PL|TRAIL)\b/i.test(
				left,
			)
		) {
			streetParts.push(left.replace(/,\s*$/, ''));
		}
	}
	if (!streetParts.length || !city) return null;
	const hq = [...streetParts, city].join(', ');
	return /\d/.test(hq) ? hq : null;
}

async function pdfMainOffice(crd) {
	const url = `https://files.brokercheck.finra.org/firm/firm_${crd}.pdf`;
	let res = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://brokercheck.finra.org/' },
		});
		if (res.status !== 403 && res.status !== 429) break;
		await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) * (attempt + 1)));
	}
	if (!res || !res.ok) {
		if (res && (res.status === 403 || res.status === 429)) return { hq: null, forbidden: true };
		return { hq: null, forbidden: false };
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 500 || buf.slice(0, 4).toString() !== '%PDF') {
		return { hq: null, forbidden: false };
	}
	const pdfPath = path.join(TMP, `${crd}-${process.pid}-${Date.now()}.pdf`);
	fs.writeFileSync(pdfPath, buf);
	try {
		// Newer BrokerCheck PDFs put Main Office on the report-summary page,
		// which is often PDF page 3 after the TOC; older ones put it on page 1.
		const txt = execFileSync('pdftotext', ['-layout', '-f', '1', '-l', '4', pdfPath, '-'], {
			encoding: 'utf8',
			maxBuffer: 4_000_000,
		});
		return { hq: extractMainOffice(txt), forbidden: false };
	} catch {
		return { hq: null, forbidden: false };
	} finally {
		try {
			fs.unlinkSync(pdfPath);
		} catch {}
	}
}

let i = 0;
let withStreet = 0;
let noStreet = 0;
let forbidden = 0;
let errors = 0;

async function worker() {
	while (i < rows.length) {
		const idx = i++;
		const row = rows[idx];
		try {
			const result = await pdfMainOffice(row.crd);
			if (result.forbidden) {
				forbidden += 1;
				noStreet += 1;
			} else if (!result.hq) {
				noStreet += 1;
			} else {
				const p = getProfile(row.slug);
				const parts = parseAddressParts(result.hq);
				addLocation({
					profileId: p.id,
					raw: result.hq,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country || 'US',
					role: 'hq',
					sourceCorpus: CORPUS,
				});
				withStreet += 1;
				console.log('OK', row.slug, '=>', result.hq);
			}
		} catch (e) {
			errors += 1;
			console.log('ERR', row.slug, e.message);
		}
		await new Promise((r) => setTimeout(r, delayMs));
		if ((idx + 1) % 25 === 0 || idx + 1 === rows.length) {
			console.log(
				JSON.stringify({
					processed: idx + 1,
					withStreet,
					noStreet,
					forbidden,
					errors,
					remaining: rows.length - idx - 1,
				}),
			);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(
	JSON.stringify(
		{ done: true, processed: rows.length, withStreet, noStreet, forbidden, errors },
		null,
		2,
	),
);
