#!/usr/bin/env node
/**
 * Look up earliest reliable start dates for a firm list and print a sourced table.
 *
 * Priority: OpenCorporates (if token) → Companies House (if CH key) → GLEIF →
 * SEC EDGAR (CIK) → Wikidata P571 → keep existing curated date.
 *
 * Usage:
 *   node scripts/lookup-firm-start-dates-report.mjs [--apply-missing] [--annotate] [--limit 80]
 *   node scripts/lookup-firm-start-dates-report.mjs --slugs-file /tmp/slugs.txt
 *
 * Env:
 *   OPENCORPORATES_API_TOKEN
 *   COMPANIES_HOUSE_API_KEY | CH_API_KEY  (HTTP Basic username, blank password)
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

const { updateProfileFields } = await import('../src/lib/research/profiles/store.ts');
const { normalizeIsoDate } = await import('../src/lib/research/profiles/normalize.ts');

const OC_TOKEN = process.env.OPENCORPORATES_API_TOKEN || '';
const CH_KEY =
	process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY || process.env.COMPANIES_HOUSE_KEY || '';
const SEC_UA =
	process.env.SEC_USER_AGENT ||
	'AI-Research-Tool/1.0 (local research; contact: localhost:3333; +https://www.sec.gov/os/webmaster-faq)';

const argv = process.argv.slice(2);
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}
const limit = Number(arg('--limit', '90'));
const slugsFile = arg('--slugs-file', null);
const applyMissing = argv.includes('--apply-missing');
const annotate = argv.includes('--annotate');
const sleepMs = Number(arg('--sleep-ms', '280'));

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function toIso(raw) {
	if (!raw) return null;
	const s = String(raw).trim();
	const n = normalizeIsoDate(s.slice(0, 10));
	if (n.date) return n.date;
	const y = s.match(/^(\d{4})/);
	return y ? y[1] : null;
}

async function fetchJson(url, opts = {}) {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			'User-Agent': SEC_UA,
			...(opts.headers || {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, status: res.status, error: text.slice(0, 180) };
	}
	return { ok: true, data: await res.json() };
}

function titleCaseFirm(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/\b([a-z])/g, (m) => m.toUpperCase())
		.replace(/\b(Llc|Llp|Inc|Ltd|Lp|Corp|Co|Pllc|Plc|Gmbh|Spa|Se|Ag|Ab|Oy|S\.A\.)\b/gi, (m) =>
			m.toUpperCase(),
		);
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
	push(clean.replace(/,?\s+(LLC|L\.L\.C\.|INC\.?|LTD\.?|LP|L\.P\.|CORP\.?|CO\.|PLLC|LLP|PLC|GMBH|S\.P\.A\.|S\.A\.|AG|AB|OY|SE)\.?$/i, '').trim());
	return out;
}

async function lookupOpenCorporates(name) {
	if (!OC_TOKEN) return null;
	const q = encodeURIComponent(String(name || '').trim());
	const url = `https://api.opencorporates.com/v0.4/companies/search?q=${q}&per_page=5&api_token=${encodeURIComponent(OC_TOKEN)}`;
	const res = await fetchJson(url);
	if (!res.ok) return null;
	for (const wrap of res.data?.results?.companies || []) {
		const c = wrap.company || wrap;
		const iso = toIso(c.incorporation_date);
		if (!iso) continue;
		return {
			date: iso,
			dateType: 'registration',
			jurisdiction: c.jurisdiction_code || '',
			sourceUrl:
				c.opencorporates_url ||
				`https://opencorporates.com/companies/${c.jurisdiction_code}/${c.company_number}`,
			confidence: 'high',
			provider: 'opencorporates',
		};
	}
	return null;
}

async function lookupCompaniesHouse(name) {
	if (!CH_KEY) return null;
	const auth = 'Basic ' + Buffer.from(`${CH_KEY}:`).toString('base64');
	const searchUrl =
		'https://api.company-information.service.gov.uk/search/companies?q=' +
		encodeURIComponent(name) +
		'&items_per_page=5';
	const search = await fetchJson(searchUrl, { headers: { Authorization: auth } });
	if (!search.ok) return null;
	const item = (search.data?.items || [])[0];
	if (!item?.company_number) return null;
	const profile = await fetchJson(
		`https://api.company-information.service.gov.uk/company/${item.company_number}`,
		{ headers: { Authorization: auth } },
	);
	if (!profile.ok) return null;
	const iso = toIso(profile.data?.date_of_creation);
	if (!iso) return null;
	return {
		date: iso,
		dateType: 'registration',
		jurisdiction: 'gb',
		sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
		confidence: 'high',
		provider: 'companies_house',
		companyNumber: item.company_number,
	};
}

async function lookupGleif(name) {
	const url =
		'https://api.gleif.org/api/v1/lei-records?page[size]=5&filter[entity.legalName]=' +
		encodeURIComponent(name);
	const res = await fetchJson(url);
	if (!res.ok) return null;
	for (const row of res.data?.data || []) {
		const attrs = row.attributes || {};
		const entity = attrs.entity || {};
		const reg = entity.registrationAuthority || {};
		// GLEIF often has entity.creationDate or legalAddress registration — check common fields
		const created =
			entity.creationDate ||
			attrs.registration?.initialRegistrationDate ||
			attrs.registration?.lastUpdateDate;
		const iso = toIso(created);
		const legalName = entity.legalName?.name || name;
		const lei = attrs.lei || row.id;
		if (!iso && !lei) continue;
		if (!iso) {
			return {
				date: null,
				dateType: 'lei_record',
				jurisdiction: entity.legalAddress?.country || entity.jurisdiction || '',
				sourceUrl: `https://search.gleif.org/#/record/${lei}`,
				confidence: 'low',
				provider: 'gleif',
				lei,
				legalName,
				note: 'LEI found; no creation date on record',
			};
		}
		return {
			date: iso,
			dateType: 'lei_registration_or_creation',
			jurisdiction: entity.legalAddress?.country || entity.jurisdiction || '',
			sourceUrl: `https://search.gleif.org/#/record/${lei}`,
			confidence: 'medium',
			provider: 'gleif',
			lei,
			legalName,
		};
	}
	return null;
}

async function lookupSecCik(cik) {
	const digits = String(cik || '').replace(/\D/g, '');
	if (!digits) return null;
	const padded = digits.padStart(10, '0');
	const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
	const res = await fetchJson(url);
	if (!res.ok) return null;
	// Submissions JSON rarely has incorporation date at top level; tickers/exchanges confirm identity.
	return {
		date: null,
		dateType: 'sec_identity',
		jurisdiction: 'us',
		sourceUrl: url,
		confidence: 'low',
		provider: 'sec_edgar',
		cik: padded,
		name: res.data?.name || null,
		note: 'CIK resolved; incorporation date usually in S-1/10-K text, not submissions JSON',
	};
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
	const sparql = `SELECT ?inception ?countryLabel WHERE {
  wd:${qid} wdt:P571 ?inception.
  OPTIONAL { wd:${qid} wdt:P17 ?country. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 1`;
	const url =
		'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
	const res = await fetchJson(url, { headers: { Accept: 'application/sparql-results+json' } });
	if (!res.ok) return null;
	const b = res.data?.results?.bindings?.[0];
	if (!b?.inception?.value) return null;
	return {
		date: toIso(b.inception.value.slice(0, 10)) || b.inception.value.slice(0, 4),
		country: b.countryLabel?.value || '',
	};
}

async function lookupWikidata(name) {
	for (const q of nameVariants(name).slice(0, 3)) {
		const hits = await wikidataSearchEntities(q);
		for (const h of hits) {
			const qid = h.id;
			if (!qid || !/^Q\d+$/.test(qid)) continue;
			const hit = await wikidataInceptionByQid(qid);
			if (!hit?.date) continue;
			return {
				date: hit.date,
				dateType: 'founding_or_inception',
				jurisdiction: hit.country || '',
				sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
				confidence: 'medium',
				provider: 'wikidata',
			};
		}
		await sleep(100);
	}
	return null;
}

function loadTargets() {
	const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });
	if (slugsFile) {
		const slugs = fs
			.readFileSync(slugsFile, 'utf8')
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		const stmt = db.prepare(
			`SELECT slug, name, start_date, metadata_json FROM profiles WHERE slug = ? AND profile_type = 'firm'`,
		);
		return slugs.map((s) => stmt.get(s)).filter(Boolean);
	}
	return db
		.prepare(
			`
      SELECT slug, name, start_date, metadata_json
      FROM profiles
      WHERE profile_type = 'firm'
        AND (
          json_extract(metadata_json, '$.intlTechDefenseEnergy') = 1
          OR json_extract(metadata_json, '$.publicTechDefenseEnergy') = 1
          OR json_extract(metadata_json, '$.txOkOilfieldServices') = 1
          OR json_extract(metadata_json, '$.txOkStatewide') = 1
        )
      ORDER BY name
      LIMIT ?
    `,
		)
		.all(limit);
}

const targets = loadTargets();
console.error(
	`Start-date lookup report — ${targets.length} firms; OC=${OC_TOKEN ? 'yes' : 'no'} CH=${CH_KEY ? 'yes' : 'no'} applyMissing=${applyMissing} annotate=${annotate}`,
);

const rows = [];
for (const t of targets) {
	const slug = String(t.slug);
	const name = String(t.name);
	let meta = {};
	try {
		meta = JSON.parse(String(t.metadata_json || '{}'));
	} catch {
		meta = {};
	}
	const existing = t.start_date ? String(t.start_date) : null;
	const cik = meta.cik || null;

	let hit = null;
	const providers = [];
	if (OC_TOKEN) providers.push('opencorporates');
	if (CH_KEY) providers.push('companies_house');
	providers.push('gleif', 'wikidata');

	for (const p of providers) {
		try {
			if (p === 'opencorporates') hit = await lookupOpenCorporates(name);
			else if (p === 'companies_house') hit = await lookupCompaniesHouse(name);
			else if (p === 'gleif') {
				const g = await lookupGleif(name);
				if (g?.date) hit = g;
				else if (g && !hit) hit = g; // keep LEI-only note if nothing better yet
			} else if (p === 'wikidata') {
				const w = await lookupWikidata(name);
				if (w?.date) hit = w;
			}
		} catch (e) {
			console.error(`  warn ${slug} ${p}:`, e?.message || e);
		}
		if (hit?.date && hit.confidence !== 'low') break;
		await sleep(sleepMs);
	}

	if (cik && (!hit || !hit.date)) {
		const sec = await lookupSecCik(cik);
		if (sec && !hit) hit = sec;
		await sleep(120);
	}

	const finalDate = existing || hit?.date || null;
	const dateType = existing
		? meta.startDateType || (hit?.date && hit.date === existing ? hit.dateType : 'curated_or_existing')
		: hit?.dateType || '';
	const sourceUrl = existing && meta.startDateSource ? meta.startDateSource : hit?.sourceUrl || '';
	const confidence = existing
		? meta.startDateConfidence || (hit?.date ? 'existing+lookup' : 'curated')
		: hit?.confidence || 'none';
	const jurisdiction =
		hit?.jurisdiction ||
		(Array.isArray(meta.countries) ? meta.countries.join(',') : meta.countries || meta.state || '');

	rows.push({
		company: name,
		slug,
		date: finalDate || '',
		dateType: dateType || '',
		jurisdiction: jurisdiction || '',
		sourceUrl: sourceUrl || '',
		confidence,
		provider: hit?.provider || meta.startDateProvider || (existing ? 'existing' : ''),
		lookupDate: hit?.date || '',
		note: hit?.note || '',
	});

	if (applyMissing && !existing && hit?.date) {
		updateProfileFields(slug, {
			startDate: hit.date,
			metadata: {
				...meta,
				startDateSource: hit.sourceUrl,
				startDateType: hit.dateType,
				startDateConfidence: hit.confidence,
				startDateProvider: hit.provider,
				startDateJurisdiction: hit.jurisdiction || undefined,
			},
		});
		console.error(`[applied] ${slug} → ${hit.date} (${hit.provider})`);
	} else if (annotate && hit) {
		updateProfileFields(slug, {
			metadata: {
				...meta,
				startDateLookupSource: hit.sourceUrl || undefined,
				startDateLookupProvider: hit.provider,
				startDateLookupDate: hit.date || undefined,
				startDateLookupType: hit.dateType || undefined,
				startDateLookupConfidence: hit.confidence,
				...(hit.lei ? { lei: hit.lei } : {}),
			},
		});
	}
}

console.log('| Company | Date | Date type | Jurisdiction | Source URL | Confidence |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
	const src = r.sourceUrl ? `[link](${r.sourceUrl})` : (r.provider === 'existing' ? 'curated/import' : '—');
	console.log(
		`| ${r.company.replace(/\|/g, '/')} | ${r.date || '—'} | ${r.dateType || '—'} | ${r.jurisdiction || '—'} | ${src} | ${r.confidence}${r.note ? ` (${r.note})` : ''} |`,
	);
}

const missing = rows.filter((r) => !r.date);
const verified = rows.filter((r) => r.lookupDate);
console.error(
	`\nSummary: ${rows.length} rows; with_date=${rows.length - missing.length}; lookup_hit=${verified.length}; still_missing=${missing.length}`,
);
if (missing.length) {
	console.error('Missing:');
	for (const m of missing) console.error(' -', m.slug, m.company);
}

const outPath = path.join(ROOT, '.data/monitors/firm-start-dates-lookup-report.md');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const md = [
	'# Firm start-date lookup report',
	'',
	`Generated: ${new Date().toISOString()}`,
	`OC token: ${OC_TOKEN ? 'yes' : 'no'}; Companies House key: ${CH_KEY ? 'yes' : 'no'}`,
	'',
	'| Company | Date | Date type | Jurisdiction | Source URL | Confidence |',
	'|---|---|---|---|---|---|',
	...rows.map((r) => {
		const src = r.sourceUrl || (r.provider === 'existing' ? 'curated/import' : '—');
		return `| ${r.company.replace(/\|/g, '/')} | ${r.date || '—'} | ${r.dateType || '—'} | ${r.jurisdiction || '—'} | ${src} | ${r.confidence}${r.note ? ` (${r.note})` : ''} |`;
	}),
	'',
];
fs.writeFileSync(outPath, md.join('\n'));
console.error(`Wrote ${outPath}`);
