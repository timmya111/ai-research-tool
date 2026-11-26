#!/usr/bin/env node
/**
 * Flag validation for org profiles: when structured HQ implies one country but
 * summary/name detection would add extras, persist metadata.manualCountryCodes
 * to the HQ country (or curated multi-HQ set).
 *
 *   node scripts/org-validate-flags.mjs --dry-run --types medical_hospital,nonprofit
 *   node scripts/org-validate-flags.mjs --types education,government --limit 500
 *   node scripts/org-validate-flags.mjs --types firm --limit 2000
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

const { detectProfileCountryCodes } = await import('../src/lib/research/profiles/countries.ts');
const { updateProfileFields, touchProfilesForUserAction } = await import(
	'../src/lib/research/profiles/store.ts'
);

const argv = process.argv.slice(2);
function has(flag) {
	return argv.includes(flag);
}
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}

const dryRun = has('--dry-run');
const limit = Math.max(0, Number(arg('--limit', '0')) || 0);
const types = String(arg('--types', 'medical_hospital,nonprofit,education,government'))
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const DB_PATH = path.join(ROOT, '.data/profiles/profiles.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 60000');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.data', 'profiles', 'org-validate', stamp);
fs.mkdirSync(outDir, { recursive: true });

const COUNTRY_ALIAS = {
	'united states': 'us',
	usa: 'us',
	'u.s.': 'us',
	'u.s.a.': 'us',
	'united kingdom': 'gb',
	uk: 'gb',
	'great britain': 'gb',
	england: 'gb',
	scotland: 'gb',
	wales: 'gb',
	canada: 'ca',
	mexico: 'mx',
	france: 'fr',
	germany: 'de',
	spain: 'es',
	españa: 'es',
	italy: 'it',
	netherlands: 'nl',
	nederland: 'nl',
	belgium: 'be',
	switzerland: 'ch',
	austria: 'at',
	sweden: 'se',
	norway: 'no',
	denmark: 'dk',
	danmark: 'dk',
	finland: 'fi',
	ireland: 'ie',
	portugal: 'pt',
	poland: 'pl',
	'czech republic': 'cz',
	czechia: 'cz',
	russia: 'ru',
	china: 'cn',
	"people's republic of china": 'cn',
	japan: 'jp',
	'south korea': 'kr',
	'korea, republic of': 'kr',
	'hong kong': 'hk',
	'hong kong sar': 'hk',
	singapore: 'sg',
	india: 'in',
	australia: 'au',
	'new zealand': 'nz',
	brazil: 'br',
	brasil: 'br',
	argentina: 'ar',
	chile: 'cl',
	'saudi arabia': 'sa',
	'united arab emirates': 'ae',
	egypt: 'eg',
	nigeria: 'ng',
	'south africa': 'za',
	israel: 'il',
	turkey: 'tr',
	taiwan: 'tw',
	thailand: 'th',
	indonesia: 'id',
	malaysia: 'my',
	philippines: 'ph',
	vietnam: 'vn',
	bangladesh: 'bd',
	pakistan: 'pk',
	uganda: 'ug',
	kenya: 'ke',
	ghana: 'gh',
	morocco: 'ma',
	senegal: 'sn',
};

function mapCountry(raw) {
	if (!raw) return null;
	const s = String(raw).trim().toLowerCase();
	if (COUNTRY_ALIAS[s]) return COUNTRY_ALIAS[s];
	if (/^[a-z]{2}$/.test(s)) return s;
	const entries = Object.entries(COUNTRY_ALIAS).sort((a, b) => b[0].length - a[0].length);
	for (const [k, v] of entries) {
		if (k.length <= 2) continue;
		const re = new RegExp(`(?:^|[^a-z])${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:[^a-z]|$)`);
		if (re.test(s)) return v;
	}
	return null;
}

function locCode(loc) {
	const gk = String(loc.geo_key || '').toLowerCase();
	if (gk.startsWith('us:')) return 'us';
	if (gk.startsWith('country:')) {
		return mapCountry(gk.slice('country:'.length).replace(/-/g, ' '));
	}
	const fromRaw = mapCountry(loc.raw);
	if (fromRaw && /(?:united states|united kingdom|canada|france|germany|spain|italy|netherlands|china|japan|korea|singapore|australia|india|brazil|russia|denmark|sweden|switzerland|ireland|hong kong|mexico|argentina|saudi arabia|nigeria|egypt|poland|austria)/i.test(String(loc.raw || ''))) {
		return fromRaw;
	}
	const fromCountry = mapCountry(loc.country);
	if (fromCountry) return fromCountry;
	if (fromRaw) return fromRaw;
	const m = gk.match(/^([a-z]{2}):/);
	if (m && m[1] !== 'co') return m[1];
	return null;
}

function hqCodesFromLocations(locs) {
	const hq = locs.filter((loc) => {
		const role = String(loc.role || 'hq').toLowerCase();
		return role === 'hq' || role === 'headquarters' || role === '';
	});
	const associatedCountry = locs
		.filter((loc) => String(loc.role || '').toLowerCase() === 'associated')
		.map(locCode)
		.filter(Boolean);

	const codes = new Set();
	for (const loc of hq) {
		// Ignore free-ipeds / scorecard US streets when an associated non-US country exists
		const source = String(loc.source_corpus || '');
		const code = locCode(loc);
		if (
			/free-ipeds|free-college-scorecard/i.test(source) &&
			code === 'us' &&
			associatedCountry.some((c) => c && c !== 'us')
		) {
			continue;
		}
		if (code) codes.add(code);
	}
	if (!codes.size && associatedCountry.length) {
		for (const c of associatedCountry) codes.add(c);
	}
	return [...codes];
}

/** Embassy of X in host city → host country from HQ address, not sending state name. */
function embassyHostCode(name, locs) {
	if (!/^embassy of /i.test(name)) return null;
	const hq = locs.find((l) => String(l.role || '').toLowerCase() === 'hq') || locs[0];
	if (!hq) return null;
	const raw = String(hq.raw || '');
	// DC / US street patterns without country field
	if (/\b(?:n\.?\s*w\.?|washington|d\.?\s*c\.?|united states)\b/i.test(raw) || mapCountry(hq.country) === 'us') {
		return 'us';
	}
	if (/tsukiji|tokyo|japan/i.test(raw) || mapCountry(hq.country) === 'jp') return 'jp';
	if (/beijing|china/i.test(raw)) return 'cn';
	return mapCountry(hq.country) || mapCountry(raw);
}

const placeholders = types.map(() => '?').join(',');
let rows = db
	.prepare(
		`SELECT id, slug, name, profile_type, summary, metadata_json
     FROM profiles WHERE profile_type IN (${placeholders})
     ORDER BY name ASC`,
	)
	.all(...types);

if (limit > 0) rows = rows.slice(0, limit);

const report = {
	dryRun,
	types,
	scanned: rows.length,
	alreadyManual: 0,
	unchanged: 0,
	setManual: [],
	clearedExtras: [],
	errors: [],
};

for (const row of rows) {
	try {
		const meta = JSON.parse(row.metadata_json || '{}');
		if (Array.isArray(meta.manualCountryCodes) && meta.manualCountryCodes.length) {
			report.alreadyManual += 1;
			continue;
		}

		const locs = db
			.prepare(
				`SELECT raw, city, state, country, geo_key, role FROM profile_locations WHERE profile_id = ?`,
			)
			.all(row.id);
		const idents = db
			.prepare(`SELECT scheme, value FROM profile_identifiers WHERE profile_id = ?`)
			.all(row.id);

		const detected = detectProfileCountryCodes({
			name: row.name,
			profileType: row.profile_type,
			summary: row.summary || '',
			locations: locs,
			identifiers: idents,
			metadata: meta,
		});

		const hqOnly = detectProfileCountryCodes({
			name: row.name,
			profileType: row.profile_type,
			summary: '',
			locations: locs.filter((l) => {
				const role = String(l.role || 'hq').toLowerCase();
				return role === 'hq' || role === 'headquarters' || role === '';
			}),
			identifiers: [],
			metadata: {},
		});

		const structuredHq = hqCodesFromLocations(locs);
		let desired = structuredHq.length ? structuredHq : hqOnly;

		const embassyHost = embassyHostCode(row.name, locs);
		if (embassyHost) desired = [embassyHost];

		desired = [...new Set(desired.map((c) => String(c).toLowerCase()))].slice(0, 4);
		if (!desired.length) {
			report.unchanged += 1;
			continue;
		}

		// Name-country veto: do not pin US (or other) when the org name clearly belongs elsewhere
		const nameCodes = detectProfileCountryCodes({
			name: row.name,
			profileType: row.profile_type,
			summary: '',
			locations: [],
			identifiers: [],
			metadata: {},
		}).filter((c) => c !== 'un' && c !== 'eu');
		if (
			nameCodes.length === 1 &&
			desired.length === 1 &&
			desired[0] !== nameCodes[0] &&
			desired[0] === 'us'
		) {
			desired = nameCodes;
		}

		const detectedSet = new Set(detected);
		const desiredSet = new Set(desired);
		const extras = detected.filter((c) => !desiredSet.has(c));
		const missing = desired.filter((c) => !detectedSet.has(c));

		// Persist manual only when detection disagrees with HQ (extras from overview prose, or embassy)
		const needsManual =
			extras.length > 0 || Boolean(embassyHost) || (desired.length === 1 && detected.length > 1);
		if (!needsManual) {
			report.unchanged += 1;
			continue;
		}
		// Skip noisy multi-HQ without a single clear home country
		if (desired.length > 2 && !embassyHost) {
			report.unchanged += 1;
			continue;
		}

		const entry = {
			slug: row.slug,
			name: row.name,
			from: detected,
			to: desired,
			extras,
			missing,
			embassyHost: embassyHost || undefined,
		};
		report.setManual.push(entry);
		if (extras.length) report.clearedExtras.push(entry);

		if (!dryRun) {
			updateProfileFields(row.id, {
				metadata: { ...meta, manualCountryCodes: desired },
			});
			touchProfilesForUserAction([row.id]);
		}
	} catch (err) {
		report.errors.push({ slug: row.slug, error: String(err?.message || err) });
	}
}

fs.writeFileSync(path.join(outDir, 'flag-fixes.json'), JSON.stringify(report, null, 2));
console.log(
	JSON.stringify(
		{
			outDir,
			dryRun,
			scanned: report.scanned,
			alreadyManual: report.alreadyManual,
			unchanged: report.unchanged,
			setManual: report.setManual.length,
			sample: report.setManual.slice(0, 20),
			errors: report.errors.slice(0, 10),
		},
		null,
		2,
	),
);
db.close();
