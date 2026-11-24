#!/usr/bin/env node
/**
 * Backfill firm startDate from public APIs / registries when missing.
 *
 * Priority:
 *   1. SEC EDGAR submissions (entityType / formerNames — incorporation often in filings;
 *      we use registered date hints when present in CIK JSON + companyFacts fallbacks)
 *   2. OpenCorporates company search (incorporation_date) when OPENCORPORATES_API_TOKEN set
 *   3. Wikidata P571 (inception) via SPARQL (free)
 *
 * Never overwrites an existing startDate. Writes source URL + date type into metadata.
 *
 * Usage:
 *   node scripts/backfill-firm-start-dates-apis.mjs --limit 50
 *   node scripts/backfill-firm-start-dates-apis.mjs --slug firm:conocophillips
 *   node scripts/backfill-firm-start-dates-apis.mjs --slugs-file /tmp/slugs.txt
 *   OPENCORPORATES_API_TOKEN=… node scripts/backfill-firm-start-dates-apis.mjs --prefer opencorporates
 *
 * Env:
 *   OPENCORPORATES_API_TOKEN  optional commercial/free key
 *   SEC_USER_AGENT            override User-Agent for data.sec.gov (required format)
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

const { updateProfileFields, getProfile } = await import('../src/lib/research/profiles/store.ts');
const { normalizeIsoDate } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'firm-start-dates-apis';
const OC_TOKEN = process.env.OPENCORPORATES_API_TOKEN || '';
const SEC_UA =
	process.env.SEC_USER_AGENT ||
	'AI-Research-Tool/1.0 (local research; contact: localhost:3333; +https://www.sec.gov/os/webmaster-faq)';

const argv = process.argv.slice(2);
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}
const limit = Number(arg('--limit', '40'));
const onlySlug = arg('--slug', null);
const slugsFile = arg('--slugs-file', null);
const dryRun = argv.includes('--dry-run');
const prefer = String(arg('--prefer', 'wikidata') || 'wikidata').toLowerCase();
const sleepMs = Number(arg('--sleep-ms', '350'));

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, headers = {}) {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			'User-Agent': SEC_UA,
			...headers,
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, status: res.status, error: text.slice(0, 200) };
	}
	const data = await res.json();
	return { ok: true, data };
}

function padCik(cik) {
	const digits = String(cik || '').replace(/\D/g, '');
	if (!digits) return null;
	return digits.padStart(10, '0');
}

function titleCaseFirm(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/\b([a-z])/g, (m) => m.toUpperCase())
		.replace(/\b(Llc|Llp|Inc|Ltd|Lp|Corp|Co|Pllc|Plc)\b/g, (m) => m.toUpperCase())
		.replace(/\b(Of|And|The|For)\b/g, (m) => m.toLowerCase());
}

function nameVariants(name) {
	const clean = String(name || '').trim();
	const out = [];
	const push = (s) => {
		const t = String(s || '').trim();
		if (t && !out.includes(t)) out.push(t);
	};
	push(clean);
	push(titleCaseFirm(clean));
	push(clean.replace(/,?\s+(LLC|L\.L\.C\.|INC\.?|LTD\.?|LP|L\.P\.|CORP\.?|CO\.|PLLC|LLP)\.?$/i, '').trim());
	push(titleCaseFirm(out[out.length - 1] || clean));
	return out;
}

async function wikidataSparqlByLabel(label) {
	const sparql = `
SELECT ?item ?itemLabel ?inception WHERE {
  ?item rdfs:label "${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"@en.
  OPTIONAL { ?item wdt:P571 ?inception. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 5`.trim();
	const url =
		'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
	return fetchJson(url, { Accept: 'application/sparql-results+json' });
}

async function wikidataSearchEntities(query) {
	const url =
		'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=' +
		encodeURIComponent(query);
	const res = await fetchJson(url);
	if (!res.ok) return [];
	return res.data?.search || [];
}

async function wikidataInceptionByQid(qid) {
	const sparql = `
SELECT ?inception WHERE {
  wd:${qid} wdt:P571 ?inception.
}
LIMIT 1`.trim();
	const url =
		'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
	const res = await fetchJson(url, { Accept: 'application/sparql-results+json' });
	if (!res.ok) return null;
	const inception = res.data?.results?.bindings?.[0]?.inception?.value;
	if (!inception) return null;
	return normalizeIsoDate(inception.slice(0, 10)).date || inception.slice(0, 4);
}

/** Wikidata inception (P571): exact label, title-case variants, then wbsearchentities. */
async function lookupWikidataInception(name) {
	const clean = String(name || '').trim();
	if (!clean || clean.length < 2) return null;

	for (const label of nameVariants(clean)) {
		const res = await wikidataSparqlByLabel(label);
		if (!res.ok) continue;
		const bindings = res.data?.results?.bindings || [];
		for (const b of bindings) {
			const inception = b.inception?.value;
			if (!inception) continue;
			const iso = normalizeIsoDate(inception.slice(0, 10)).date || inception.slice(0, 4);
			if (!iso) continue;
			const item = b.item?.value || '';
			return {
				startDate: iso,
				dateType: 'founding_or_inception',
				sourceUrl: item || 'https://www.wikidata.org/',
				confidence: 'wikidata_p571_label',
				provider: 'wikidata',
			};
		}
		await sleep(120);
	}

	for (const q of nameVariants(clean).slice(0, 2)) {
		const hits = await wikidataSearchEntities(q);
		for (const h of hits) {
			const qid = h.id;
			if (!qid || !/^Q\d+$/.test(qid)) continue;
			const iso = await wikidataInceptionByQid(qid);
			if (!iso) continue;
			return {
				startDate: iso,
				dateType: 'founding_or_inception',
				sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
				confidence: 'wikidata_p571_search',
				provider: 'wikidata',
			};
		}
		await sleep(120);
	}
	return null;
}

/** OpenCorporates search — first hit with incorporation_date. */
async function lookupOpenCorporates(name) {
	const q = encodeURIComponent(String(name || '').trim());
	if (!q) return null;
	const base = `https://api.opencorporates.com/v0.4/companies/search?q=${q}&per_page=5`;
	const url = OC_TOKEN ? `${base}&api_token=${encodeURIComponent(OC_TOKEN)}` : base;
	const res = await fetchJson(url);
	if (!res.ok) return null;
	const companies = res.data?.results?.companies || [];
	for (const wrap of companies) {
		const c = wrap.company || wrap;
		const inc = c.incorporation_date || c.created_at;
		if (!inc) continue;
		const iso = normalizeIsoDate(String(inc).slice(0, 10)).date || String(inc).slice(0, 4);
		if (!iso) continue;
		const jurisdiction = c.jurisdiction_code || '';
		const companyNum = c.company_number || '';
		const sourceUrl =
			c.opencorporates_url ||
			`https://opencorporates.com/companies/${jurisdiction}/${companyNum}`;
		return {
			startDate: iso,
			dateType: 'incorporation_or_registration',
			sourceUrl,
			confidence: 'opencorporates_incorporation_date',
			provider: 'opencorporates',
			jurisdiction,
		};
	}
	return null;
}

/**
 * SEC EDGAR submissions — uses tickers/name; incorporation is rarely a top-level field,
 * but `name` + CIK confirms public company. Prefer Wikidata/OC for dates; SEC used for CIK attach.
 */
async function lookupSecCik(cik) {
	const padded = padCik(cik);
	if (!padded) return null;
	const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
	const res = await fetchJson(url);
	if (!res.ok) return null;
	const d = res.data || {};
	// Some older entities expose addresses / formerNames only — no reliable incorporation date here.
	// Return null for date; caller may still store CIK.
	return {
		cik: padded,
		name: d.name || null,
		sourceUrl: url,
		provider: 'sec_edgar',
	};
}

function loadTargets() {
	const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
	if (onlySlug) {
		const row = db
			.prepare(
				`SELECT slug, name, start_date, metadata_json FROM profiles WHERE slug = ? AND profile_type = 'firm'`,
			)
			.get(onlySlug);
		return row ? [row] : [];
	}
	if (slugsFile) {
		const slugs = fs
			.readFileSync(slugsFile, 'utf8')
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		const out = [];
		const stmt = db.prepare(
			`SELECT slug, name, start_date, metadata_json FROM profiles WHERE slug = ? AND profile_type = 'firm'`,
		);
		for (const s of slugs) {
			const row = stmt.get(s);
			if (row) out.push(row);
		}
		return out;
	}
	// Prefer statewide / pinned notables missing start dates, then any firm with CIK in metadata.
	return db
		.prepare(
			`
      SELECT slug, name, start_date, metadata_json
      FROM profiles
      WHERE profile_type = 'firm'
        AND (start_date IS NULL OR TRIM(start_date) = '')
        AND (
          json_extract(metadata_json, '$.txOkStatewide') = 1
          OR json_extract(metadata_json, '$.dfwMetro') = 1
          OR status = 'pinned'
          OR json_extract(metadata_json, '$.cik') IS NOT NULL
        )
      ORDER BY
        CASE WHEN json_extract(metadata_json, '$.txOkStatewide') = 1 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT ?
    `,
		)
		.all(limit);
}

const providers =
	prefer === 'opencorporates'
		? ['opencorporates', 'wikidata']
		: prefer === 'sec'
			? ['wikidata', 'opencorporates']
			: ['wikidata', 'opencorporates'];

const targets = loadTargets();
console.log(
	`Firm start-date API backfill (${dryRun ? 'DRY RUN' : 'live'}) — ${targets.length} targets; providers=${providers.join(',')}`,
);

let filled = 0;
let skipped = 0;
let failed = 0;

for (const row of targets) {
	const slug = String(row.slug);
	const name = String(row.name);
	if (row.start_date && String(row.start_date).trim()) {
		skipped += 1;
		continue;
	}
	let meta = {};
	try {
		meta = JSON.parse(String(row.metadata_json || '{}'));
	} catch {
		meta = {};
	}

	let hit = null;
	for (const p of providers) {
		try {
			if (p === 'wikidata') hit = await lookupWikidataInception(name);
			else if (p === 'opencorporates') hit = await lookupOpenCorporates(name);
		} catch (e) {
			console.warn(`  warn ${slug} ${p}:`, e?.message || e);
		}
		if (hit?.startDate) break;
		await sleep(sleepMs);
	}

	if (!hit?.startDate) {
		failed += 1;
		console.log(`[miss] ${slug} (${name})`);
		continue;
	}

	const patchMeta = {
		...meta,
		startDateSource: hit.sourceUrl,
		startDateType: hit.dateType,
		startDateConfidence: hit.confidence,
		startDateProvider: hit.provider,
	};
	if (hit.jurisdiction) patchMeta.startDateJurisdiction = hit.jurisdiction;

	console.log(
		`[${dryRun ? 'dry' : 'set'}] ${slug} → ${hit.startDate} (${hit.provider}) ${hit.sourceUrl}`,
	);
	if (!dryRun) {
		updateProfileFields(slug, {
			startDate: hit.startDate,
			metadata: { ...patchMeta, startDateCorpus: CORPUS },
		});
		getProfile(slug);
	}
	filled += 1;
	await sleep(sleepMs);
}

console.log(`Done. filled=${filled} skipped=${skipped} missed=${failed}`);
