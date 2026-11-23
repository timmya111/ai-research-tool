#!/usr/bin/env node
/**
 * Backfill firm streets from SEC IAPD Form ADV Part 2A brochure PDFs.
 * Targets firm profiles with finra_crd that still lack digit-bearing locations.
 *
 * Usage:
 *   node scripts/backfill-firm-hq-adv.mjs --limit 200 --concurrency 3
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
const CORPUS = 'sec-iapd-adv-brochure';
// Brochure CDN 404s bot-like UAs; use a normal browser UA + Referer.
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const FETCH_HEADERS = {
	'User-Agent': UA,
	Accept: '*/*',
	Referer: 'https://adviserinfo.sec.gov/',
};
const TMP = '/tmp/firm-hq-adv';
fs.mkdirSync(TMP, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
const activeOnly = argv.includes('--active-ia-only') || !argv.includes('--all-crd');
const rows = db
	.prepare(
		`
SELECT p.slug, p.name, pi.value AS crd
FROM profiles p
JOIN profile_identifiers pi ON pi.profile_id=p.id AND pi.scheme='finra_crd'
WHERE p.profile_type='firm'
  AND NOT EXISTS (
    SELECT 1 FROM profile_locations l WHERE l.profile_id=p.id AND l.raw GLOB '*[0-9]*'
  )
  AND (
    ? = 0 OR json_extract(p.metadata_json,'$.finraIaScope') = 'ACTIVE'
  )
ORDER BY
  CASE WHEN json_extract(p.metadata_json,'$.finraIaScope') = 'ACTIVE' THEN 0 ELSE 1 END,
  p.name
LIMIT ?
`,
	)
	.all(activeOnly ? 1 : 0, limit);

console.log(JSON.stringify({ queue: rows.length, limit, concurrency }, null, 2));

function extractStreetFromText(text) {
	const lines = String(text || '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, 60);
	const streetRe =
		/^\d+\s+\S|\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|boulevard|blvd\.?|lane|ln\.?|way|court|ct\.?|plaza|parkway|pkwy\.?|highway|hwy\.?|suite|ste\.?|floor|fl\.?|circle|cir\.?|place|pl\.?|trail|tr\.?)\b/i;
	const junkRe =
		/form adv|brochure|item\s+\d|crd\b|sec\b|www\.|https?:|phone|fax|email|dated:|telephone|faxsimile|part\s*2|cover page|qualifications|business practices/i;
	const cityStateRe = /^([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/\d/.test(line)) continue;
		if (!streetRe.test(line)) continue;
		if (junkRe.test(line)) continue;
		const next = lines[i + 1] || '';
		const cityState = next.match(cityStateRe);
		if (cityState) {
			return `${line.replace(/,\s*$/, '')}, ${cityState[1].trim()}, ${cityState[2]} ${cityState[3]}`;
		}
		// same-line city state zip
		const same = line.match(/^(.+?),\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/);
		if (same) return `${same[1].trim()}, ${same[2].trim()}, ${same[3]} ${same[4]}`;
		// Headquarters: / Principal Office: then street, then city
		const prev = (lines[i - 1] || '').toLowerCase();
		if (/headquarters|principal office|main office|address/.test(prev) && cityStateRe.test(next)) {
			const cs = next.match(cityStateRe);
			return `${line.replace(/,\s*$/, '')}, ${cs[1].trim()}, ${cs[2]} ${cs[3]}`;
		}
	}
	return null;
}

async function firmIaPayload(crd) {
	const url = `https://api.adviserinfo.sec.gov/search/firm/${crd}`;
	const res = await fetch(url, { headers: { ...FETCH_HEADERS, Accept: 'application/json' } });
	if (!res.ok) return null;
	const j = await res.json();
	const hit = j?.hits?.hits?.[0]?._source?.iacontent;
	if (!hit) return null;
	try {
		return typeof hit === 'string' ? JSON.parse(hit) : hit;
	} catch {
		return null;
	}
}

function hqFromIaAddress(content) {
	const b = content?.iaFirmAddressDetails?.officeAddress || content?.iaFirmAddressDetails?.mailingAddress;
	if (!b?.street1 || !/\d/.test(b.street1)) return null;
	const parts = [b.street1, b.street2, b.city, b.state, b.postalCode || b.zipCode || b.zip].filter(Boolean);
	const uniq = [];
	for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
	let hq = uniq.join(', ');
	hq = hq.replace(/, ([A-Z]{2}), (\d)/, ', $1 $2');
	return /\d/.test(hq) ? hq : null;
}

async function fetchPdfText(url, tag) {
	const res = await fetch(url, { headers: FETCH_HEADERS });
	if (!res.ok) return '';
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') return '';
	const pdfPath = path.join(TMP, `${tag}-${process.pid}-${Date.now()}.pdf`);
	fs.writeFileSync(pdfPath, buf);
	try {
		return execFileSync('pdftotext', ['-layout', '-f', '1', '-l', '3', pdfPath, '-'], {
			encoding: 'utf8',
			maxBuffer: 2_000_000,
		});
	} catch {
		return '';
	} finally {
		try {
			fs.unlinkSync(pdfPath);
		} catch {}
	}
}

async function brochureText(brochureId) {
	return fetchPdfText(
		`https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=${brochureId}`,
		`br-${brochureId}`,
	);
}

async function part1Text(crd) {
	return fetchPdfText(
		`https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`,
		`p1-${crd}`,
	);
}

let i = 0;
let withStreet = 0;
let noBrochure = 0;
let noStreet = 0;
let errors = 0;

async function worker() {
	while (i < rows.length) {
		const idx = i++;
		const row = rows[idx];
		try {
			const content = await firmIaPayload(row.crd);
			let hq = content ? hqFromIaAddress(content) : null;
			if (!hq && content) {
				const ids = (content?.brochures?.brochuredetails || [])
					.map((d) => d.brochureVersionID)
					.filter(Boolean);
				for (const id of ids.slice(0, 3)) {
					const pdfTxt = await brochureText(id);
					hq = extractStreetFromText(pdfTxt);
					if (hq) break;
					await new Promise((r) => setTimeout(r, 120));
				}
			}
			// Part 1 ADV PDF fallback (principal office fields often empty in text,
			// but Schedule D / other offices sometimes carry streets).
			if (!hq) {
				const p1 = await part1Text(row.crd);
				hq = extractStreetFromText(p1);
			}
			if (!hq) {
				if (!content || !(content?.brochures?.brochuredetails || []).length) noBrochure += 1;
				else noStreet += 1;
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
		await new Promise((r) => setTimeout(r, 200));
		if ((idx + 1) % 25 === 0 || idx + 1 === rows.length) {
			console.log(
				JSON.stringify({
					processed: idx + 1,
					withStreet,
					noBrochure,
					noStreet,
					errors,
					remaining: rows.length - idx - 1,
				}),
			);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(JSON.stringify({ done: true, processed: rows.length, withStreet, noBrochure, noStreet, errors }, null, 2));
