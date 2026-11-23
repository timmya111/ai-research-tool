#!/usr/bin/env node
/**
 * Backfill firm street HQs via DuckDuckGo HTML + optional company URL contact pages.
 * Targets firm profiles that still lack digit-bearing locations (prefer no-CRD / high-link).
 *
 * Usage:
 *   node scripts/backfill-firm-hq-web.mjs --limit 200 --concurrency 2
 *   node scripts/backfill-firm-hq-web.mjs --no-crd-only --limit 500
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
const limit = getArgNum('--limit', 200);
const concurrency = Math.min(3, Math.max(1, getArgNum('--concurrency', 2)));
const noCrdOnly = argv.includes('--no-crd-only');
const CORPUS = 'firm-hq-web-search';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
const rows = db
	.prepare(
		`
SELECT p.slug, p.name,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='url' LIMIT 1) AS url,
  (SELECT COUNT(*) FROM profile_links WHERE from_profile_id=p.id OR to_profile_id=p.id) AS link_n,
  (SELECT value FROM profile_identifiers WHERE profile_id=p.id AND scheme='finra_crd' LIMIT 1) AS crd
FROM profiles p
WHERE p.profile_type='firm'
  AND NOT EXISTS (
    SELECT 1 FROM profile_locations l WHERE l.profile_id=p.id AND l.raw GLOB '*[0-9]*'
  )
  AND (? = 0 OR NOT EXISTS (
    SELECT 1 FROM profile_identifiers i WHERE i.profile_id=p.id AND i.scheme='finra_crd'
  ))
ORDER BY link_n DESC, p.name
LIMIT ?
`,
	)
	.all(noCrdOnly ? 1 : 0, limit);

console.log(JSON.stringify({ queue: rows.length, limit, concurrency, noCrdOnly }, null, 2));

const CITY_STATE_ZIP =
	/([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/;
const STREET_LINE =
	/(\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .#'-]{2,60}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Way|Court|Ct\.?|Plaza|Parkway|Pkwy\.?|Highway|Hwy\.?|Circle|Cir\.?|Place|Pl\.?|Trail|Tr\.?|Square|Sq\.?)(?:\s*,?\s*(?:Suite|Ste\.?|Floor|Fl\.?|#)\s*[A-Za-z0-9-]+)?)/i;

function decodeHtml(s) {
	return String(s || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractHqFromText(text, firmName) {
	const t = decodeHtml(text);
	// Prefer "Headquarters: STREET, City, ST ZIP" / "Corporate Office" patterns
	const labeled =
		/(?:headquarters|head office|corporate office|principal office|main office|located at|address)\s*[:\-]?\s*([^.]{10,120})/gi;
	let m;
	while ((m = labeled.exec(t))) {
		const chunk = m[1];
		const sm = chunk.match(STREET_LINE);
		const cm = chunk.match(CITY_STATE_ZIP);
		if (sm && cm) {
			return `${sm[1].trim()}, ${cm[1].trim()}, ${cm[2]} ${cm[3]}`;
		}
		const same = chunk.match(
			new RegExp(STREET_LINE.source + '[^,\\n]{0,40}' + CITY_STATE_ZIP.source, 'i'),
		);
		if (same) return `${same[1].trim()}, ${same[2].trim()}, ${same[3]} ${same[4]}`;
	}
	// Generic street + nearby city/state/zip within ~80 chars
	const streetMatches = [...t.matchAll(new RegExp(STREET_LINE.source, 'gi'))].slice(0, 8);
	for (const sm of streetMatches) {
		const after = t.slice(sm.index, sm.index + sm[0].length + 80);
		const cm = after.match(CITY_STATE_ZIP);
		if (cm) {
			const hq = `${sm[1].trim()}, ${cm[1].trim()}, ${cm[2]} ${cm[3]}`;
			// skip obvious non-HQ noise
			if (/p\.?\s*o\.?\s*box/i.test(hq)) continue;
			if (firmName && /wikipedia|linkedin|facebook|yelp/i.test(after.slice(0, 40))) continue;
			return hq;
		}
	}
	return null;
}

async function ddgSearch(query) {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, {
		headers: {
			'User-Agent': UA,
			Accept: 'text/html',
		},
	});
	if (!res.ok) return '';
	return await res.text();
}

async function fetchText(url) {
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'text/html' },
			redirect: 'follow',
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return '';
		const ct = res.headers.get('content-type') || '';
		if (!/html|text|xml/i.test(ct) && ct) return '';
		const html = await res.text();
		return html.slice(0, 120_000);
	} catch {
		return '';
	}
}

function contactUrls(base) {
	if (!base) return [];
	try {
		const u = new URL(base.startsWith('http') ? base : `https://${base}`);
		const origin = u.origin;
		return [
			origin + '/',
			origin + '/contact',
			origin + '/contact-us',
			origin + '/about',
			origin + '/about-us',
			origin + '/locations',
			origin + '/company',
		];
	} catch {
		return [];
	}
}

let i = 0;
let withStreet = 0;
let noStreet = 0;
let errors = 0;

async function resolveHq(row) {
	const name = row.name;
	// 1) company site contact/about pages
	for (const u of contactUrls(row.url)) {
		const html = await fetchText(u);
		const hq = extractHqFromText(html, name);
		if (hq) return hq;
		await new Promise((r) => setTimeout(r, 80));
	}
	// 2) DuckDuckGo queries
	const queries = [
		`"${name}" headquarters address`,
		`${name} corporate office street address`,
		`${name} "Suite" OR "Avenue" OR "Street" headquarters`,
	];
	for (const q of queries) {
		const html = await ddgSearch(q);
		const hq = extractHqFromText(html, name);
		if (hq) return hq;
		await new Promise((r) => setTimeout(r, 400));
	}
	return null;
}

async function worker() {
	while (i < rows.length) {
		const idx = i++;
		const row = rows[idx];
		try {
			const hq = await resolveHq(row);
			if (!hq) {
				noStreet += 1;
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
		await new Promise((r) => setTimeout(r, 300));
		if ((idx + 1) % 20 === 0 || idx + 1 === rows.length) {
			console.log(
				JSON.stringify({
					processed: idx + 1,
					withStreet,
					noStreet,
					errors,
					remaining: rows.length - idx - 1,
				}),
			);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(JSON.stringify({ done: true, processed: rows.length, withStreet, noStreet, errors }, null, 2));
