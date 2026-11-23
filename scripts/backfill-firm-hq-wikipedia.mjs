#!/usr/bin/env node
/**
 * Backfill firm street HQs from local Kiwix Wikipedia infobox (headquarters/location).
 * Targets firm profiles that still lack a digit-bearing location.
 *
 * Usage:
 *   node scripts/backfill-firm-hq-wikipedia.mjs --limit 200 --concurrency 2
 *   node scripts/backfill-firm-hq-wikipedia.mjs --no-crd-only --limit 500
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { addLocation } = await import('../src/lib/research/profiles/store.ts');
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'firm-hq-wikipedia';
const KIWIX = process.env.KIWIX_BASE || process.env.KIWIX_URL || 'http://127.0.0.1:8765';
const UA = 'AI-Research-Tool-FirmHQ/1.0 (local research; +http://localhost:3333)';

// Line-buffer console when stdout is piped (background nohup / redirects).
try {
	process.stdout._handle?.setBlocking?.(true);
} catch {
	/* ignore */
}

const argv = process.argv.slice(2);
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}
const limit = Number(arg('--limit', '200'));
const concurrency = Math.max(1, Math.min(2, Number(arg('--concurrency', '1'))));
const noCrdOnly = argv.includes('--no-crd-only');

function hasDigit(s) {
	return /[0-9]/.test(String(s || ''));
}

/** Reject citation markers, money, tickers, and city-only rows with only [n] digits */
function isPlausibleStreetHq(raw) {
	const s = String(raw || '').replace(/\s+/g, ' ').trim();
	if (s.length < 10 || s.length > 200) return false;
	// strip wiki citation markers for digit check
	const noCite = s.replace(/\[\s*\d+\s*\]/g, '').replace(/\[\s*[a-z]\s*\]/gi, '');
	if (!/[0-9]/.test(noCite)) return false;
	if (/\$|€|£|¥|billion|million|kUSD|Euronext|NASDAQ|NYSE|CAC\s*\d|component|revenue|employees/i.test(s)) {
		return false;
	}
	if (/^(US\$|USD|EUR|CHF)/i.test(s)) return false;
	// Founded / date-only cells
	if (
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(s) &&
		/\b(19|20)\d{2}\b/.test(s) &&
		!/\b(street|st\.?|road|avenue|tower|building|plaza|strasse|district)\b/i.test(s)
	) {
		return false;
	}
	if (/^\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(s)) {
		return false;
	}
	// Org-structure / retail-count blurbs, not an address
	if (/\b(branches?|offices?|subsidiaries|representative offices)\b/i.test(s) && /\d+\s+(Branches|Offices|General)/i.test(s)) {
		return false;
	}
	if (/\b\d+\s+(stores?|countries|nations|continents)\b/i.test(s)) return false;
	// Prefer tokens that look like an address line
	const streetHint =
		/\b(street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|way|plaza|tower|building|suite|floor|strasse|straße|str\.|rue|via|calle|avenida|boulevard|gasse|weg|plein|quai|kai|chome|machi|ku\b|district|no\.?\s*\d)/i.test(
			noCite,
		) || /^\d{1,6}\s+[A-Za-z]/.test(noCite);
	return streetHint;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Use curl to avoid undici keep-alive crashes against kiwix-serve */
async function curlText(url) {
	const { stdout } = await execFileAsync(
		'curl',
		['-fsS', '--max-time', '25', '-A', UA, url],
		{ maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
	);
	return stdout;
}

async function searchKiwix(q) {
	const url = `${KIWIX.replace(/\/+$/, '')}/search?pattern=${encodeURIComponent(q)}&format=xml&pageLength=8`;
	const xml = await curlText(url);
	const hits = [];
	// RSS items: <title> then <link>
	const re = /<item>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<link>([^<]+)<\/link>/gi;
	let m;
	while ((m = re.exec(xml))) {
		hits.push({
			title: m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
			link: m[2].trim(),
		});
	}
	return hits;
}

async function fetchArticleHtml(link) {
	const base = KIWIX.replace(/\/+$/, '');
	const full = link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
	return curlText(full);
}

function cleanInfoboxCell(raw) {
	return String(raw || '')
		.replace(/<br\s*\/?>/gi, ', ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#\d+;/g, ' ')
		.replace(/\(\d{4}[^)]*\)/g, '')
		.replace(/\d{1,3}°[^,]{0,60}/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[,;\s-]+|[,;\s-]+$/g, '')
		.trim();
}

/** Pull headquarters / location / registered office from infobox-ish HTML */
function extractHqFromHtml(html) {
	const text = String(html || '');
	const patterns = [
		/infobox-label[^>]*>[\s\S]*?Headquarters[\s\S]*?<\/th>\s*<td[^>]*class="infobox-data"[^>]*>([\s\S]*?)<\/td>/i,
		/infobox-label[^>]*>[\s\S]*?Head office[\s\S]*?<\/th>\s*<td[^>]*class="infobox-data"[^>]*>([\s\S]*?)<\/td>/i,
		/infobox-label[^>]*>[\s\S]*?Registered office[\s\S]*?<\/th>\s*<td[^>]*class="infobox-data"[^>]*>([\s\S]*?)<\/td>/i,
		/>Headquarters<\/[^>]+>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
		/>Head office<\/[^>]+>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
		/>Registered office<\/[^>]+>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
	];
	for (const re of patterns) {
		const m = text.match(re);
		if (!m) continue;
		const cell = cleanInfoboxCell(m[1]).replace(/\[\s*\d+\s*\]/g, '').replace(/\s+/g, ' ').trim();
		if (isPlausibleStreetHq(cell)) return cell;
	}
	return null;
}

function nameLooksLikeHit(firmName, title) {
	const norm = (s) =>
		String(s || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|group|plc|ag|sa|nv|se|the)\b/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	const a = norm(firmName);
	const b = norm(title);
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.includes(b) || b.includes(a)) return true;
	const at = a.split(' ').filter((t) => t.length > 2);
	const bt = new Set(b.split(' ').filter((t) => t.length > 2));
	if (at.length === 0) return false;
	const overlap = at.filter((t) => bt.has(t)).length;
	return overlap >= Math.min(2, at.length) && overlap / at.length >= 0.5;
}

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });

// Fast set filters — correlated NOT EXISTS + GLOB over 25k firms is too slow.
const withStreet = new Set(
	db
		.prepare(`SELECT DISTINCT profile_id AS id FROM profile_locations WHERE raw GLOB '*[0-9]*'`)
		.all()
		.map((r) => r.id),
);
const withCrd = new Set(
	db
		.prepare(`SELECT profile_id AS id FROM profile_identifiers WHERE scheme = 'finra_crd'`)
		.all()
		.map((r) => r.id),
);
const linkCountById = new Map(
	db
		.prepare(
			`SELECT profile_id AS id, COUNT(*) AS c FROM (
			   SELECT from_profile_id AS profile_id FROM profile_links
			   UNION ALL
			   SELECT to_profile_id AS profile_id FROM profile_links
			 ) GROUP BY profile_id`,
		)
		.all()
		.map((r) => [r.id, Number(r.c) || 0]),
);

const firmScan = db
	.prepare(`SELECT id, slug, name FROM profiles WHERE profile_type = 'firm'`)
	.all();

const candidates = [];
for (const f of firmScan) {
	if (withStreet.has(f.id)) continue;
	if (noCrdOnly && withCrd.has(f.id)) continue;
	const latin = /[A-Za-z]/.test(f.name) ? 1 : 0;
	const links = linkCountById.get(f.id) || 0;
	candidates.push({ ...f, links, latin });
}
candidates.sort((a, b) => b.latin - a.latin || b.links - a.links || a.name.localeCompare(b.name));
const queue = candidates.slice(0, limit);

console.log(JSON.stringify({ queue: queue.length, limit, concurrency, noCrdOnly, kiwix: KIWIX }));
process.stdout.write(''); // nudge flush when piped

let okCount = 0;
let missCount = 0;
let errors = 0;
let idx = 0;

async function worker() {
	while (idx < queue.length) {
		const i = idx++;
		const row = queue[i];
		try {
			const baseName = row.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
			const queries = [baseName, `${baseName} company`];
			let hq = null;
			for (const q of queries) {
				const hits = await searchKiwix(q);
				// Prefer exact / shorter titles (company page over "Foo family")
				const ranked = [...hits].sort((a, b) => {
					const ae = nameLooksLikeHit(baseName, a.title) ? 0 : 1;
					const be = nameLooksLikeHit(baseName, b.title) ? 0 : 1;
					if (ae !== be) return ae - be;
					return a.title.length - b.title.length;
				});
				for (const hit of ranked.slice(0, 5)) {
					if (!nameLooksLikeHit(baseName, hit.title)) continue;
					// Skip obvious non-company pages
					if (/\b(family|surname|season|album|film|song|election)\b/i.test(hit.title)) continue;
					const html = await fetchArticleHtml(hit.link);
					hq = extractHqFromHtml(html);
					if (hq) break;
				}
				if (hq) break;
			}
			if (hq && isPlausibleStreetHq(hq)) {
				const parts = parseAddressParts(hq);
				addLocation({
					profileId: row.id,
					raw: hq,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country,
					role: 'hq',
					sourceCorpus: CORPUS,
				});
				okCount += 1;
				console.log(`OK ${row.slug} => ${hq}`);
			} else {
				missCount += 1;
				if ((i + 1) % 25 === 0) {
					console.log(JSON.stringify({ processed: i + 1, okCount, missCount, errors, remaining: queue.length - i - 1 }));
				}
			}
		} catch (e) {
			errors += 1;
			console.log(`ERR ${row.slug} ${e?.message || e}`);
		}
		await sleep(150);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(JSON.stringify({ done: true, processed: queue.length, okCount, missCount, errors }));
db.close();
