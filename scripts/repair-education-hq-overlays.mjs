#!/usr/bin/env node
/**
 * Repair education cards polluted by global-education-curated overlays:
 *  - restore display names that were overwritten with a different school
 *  - drop conflicting HQ location rows (wrong city/country)
 *  - realign metadata hqCity/country/region from summary "Located in …"
 *  - mint missing displaced university cards
 *  - set manualCountryCodes from kept HQ
 *
 *   node scripts/repair-education-hq-overlays.mjs --dry-run
 *   node scripts/repair-education-hq-overlays.mjs
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

const {
	updateProfileFields,
	deleteLocation,
	upsertProfile,
	addLocation,
	addAlias,
	touchProfilesForUserAction,
	getProfile,
} = await import('../src/lib/research/profiles/store.ts');

const dryRun = process.argv.includes('--dry-run');
const DB_PATH = path.join(ROOT, '.data/profiles/profiles.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 60000');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.data', 'profiles', 'org-validate', stamp);
fs.mkdirSync(outDir, { recursive: true });

/** slug → correct display name (when name was overwritten) */
const NAME_RESTORES = {
	'education:korea-university': 'Korea University',
	'education:michigan-state-university': 'Michigan State University',
	'education:university-at-buffalo': 'University at Buffalo',
	'education:university-of-california-merced': 'University of California, Merced',
	'education:university-of-south-florida': 'University of South Florida',
	'education:university-of-georgia': 'University of Georgia',
	'education:university-of-nevada-reno': 'University of Nevada, Reno',
	'education:king-saud-university': 'King Saud University',
};

/** Displaced schools that need their own cards after restore */
const DISPLACED = [
	{
		name: 'University of Copenhagen',
		slugHint: 'university-of-copenhagen',
		hq: { raw: 'Copenhagen, Denmark', city: 'Copenhagen', country: 'Denmark', geoKey: 'denmark:city:copenhagen' },
		summary: 'Public research university in Copenhagen, Denmark.',
		manualCountryCodes: ['dk'],
	},
	{
		name: 'Lomonosov Moscow State University',
		slugHint: 'lomonosov-moscow-state-university',
		hq: { raw: 'Moscow, Russia', city: 'Moscow', country: 'Russia', geoKey: 'russia:city:moscow' },
		summary: 'Public research university in Moscow, Russia (Lomonosov Moscow State University).',
		manualCountryCodes: ['ru'],
		aliases: ['Moscow State University', 'MSU'],
	},
	{
		name: 'University of Barcelona',
		slugHint: 'university-of-barcelona',
		hq: { raw: 'Barcelona, Spain', city: 'Barcelona', country: 'Spain', geoKey: 'spain:city:barcelona' },
		summary: 'Public research university in Barcelona, Spain.',
		manualCountryCodes: ['es'],
	},
	{
		name: 'Complutense University of Madrid',
		slugHint: 'complutense-university-of-madrid',
		hq: { raw: 'Madrid, Spain', city: 'Madrid', country: 'Spain', geoKey: 'spain:city:madrid' },
		summary: 'Public research university in Madrid, Spain (Universidad Complutense de Madrid).',
		manualCountryCodes: ['es'],
		aliases: ['Universidad Complutense de Madrid', 'UCM'],
	},
	{
		name: 'University of San Francisco',
		slugHint: 'university-of-san-francisco',
		hq: { raw: 'San Francisco', city: 'San Francisco', country: 'US', geoKey: 'us:ca:city:san-francisco' },
		summary: 'Private Jesuit university in San Francisco, California.',
		manualCountryCodes: ['us'],
	},
	{
		name: 'Université Grenoble Alpes',
		slugHint: 'universite-grenoble-alpes',
		hq: { raw: 'Grenoble, France', city: 'Grenoble', country: 'France', geoKey: 'france:city:grenoble' },
		summary: 'Public research university in Grenoble, France.',
		manualCountryCodes: ['fr'],
		aliases: ['Grenoble Alpes University', 'UGA'],
	},
	{
		name: 'National University of Rosario',
		slugHint: 'national-university-of-rosario',
		hq: { raw: 'Rosario, Argentina', city: 'Rosario', country: 'Argentina', geoKey: 'argentina:city:rosario' },
		summary: 'Public national university in Rosario, Argentina (Universidad Nacional de Rosario).',
		manualCountryCodes: ['ar'],
		aliases: ['Universidad Nacional de Rosario', 'UNR'],
	},
	{
		name: 'Kennesaw State University',
		slugHint: 'kennesaw-state-university',
		hq: { raw: 'Kennesaw', city: 'Kennesaw', country: 'US', geoKey: 'us:ga:city:kennesaw' },
		summary: 'Public university in Kennesaw, Georgia.',
		manualCountryCodes: ['us'],
	},
];

/** Explicit summary restores when overview was overwritten */
const SUMMARY_RESTORES = {
	'education:university-of-south-florida':
		'Public research university in Tampa, Florida (University of South Florida).',
	'education:king-saud-university':
		'Public research university in Riyadh, Saudi Arabia (King Saud University).',
};

const COUNTRY_TO_CODE = {
	'united states': 'us',
	usa: 'us',
	us: 'us',
	'united kingdom': 'gb',
	uk: 'gb',
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
	italia: 'it',
	netherlands: 'nl',
	nederland: 'nl',
	belgium: 'be',
	switzerland: 'ch',
	austria: 'at',
	sweden: 'se',
	norway: 'no',
	denmark: 'dk',
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
	korea: 'kr',
	'hong kong': 'hk',
	singapore: 'sg',
	india: 'in',
	australia: 'au',
	'new zealand': 'nz',
	brazil: 'br',
	brasil: 'br',
	argentina: 'ar',
	chile: 'cl',
	'saudi arabia': 'sa',
	uae: 'ae',
	'united arab emirates': 'ae',
	egypt: 'eg',
	'south africa': 'za',
	nigeria: 'ng',
	kenya: 'ke',
	uganda: 'ug',
	ghana: 'gh',
	morocco: 'ma',
	senegal: 'sn',
	thailand: 'th',
	vietnam: 'vn',
	indonesia: 'id',
	malaysia: 'my',
	philippines: 'ph',
	bangladesh: 'bd',
	pakistan: 'pk',
	turkey: 'tr',
	israel: 'il',
	taiwan: 'tw',
	danmark: 'dk',
	españa: 'es',
	nederland: 'nl',
	österreich: 'at',
	suisse: 'ch',
	schweiz: 'ch',
};

function countryCode(raw) {
	if (!raw) return null;
	const s = String(raw).trim().toLowerCase();
	if (COUNTRY_TO_CODE[s]) return COUNTRY_TO_CODE[s];
	if (/^[a-z]{2}$/.test(s) && s !== 'in' && s !== 'me' && s !== 'no') return s;
	// Longest multi-word / multi-char names first; never substring-match 2-letter codes.
	const entries = Object.entries(COUNTRY_TO_CODE).sort((a, b) => b[0].length - a[0].length);
	for (const [k, v] of entries) {
		if (k.length <= 2) continue;
		const re = new RegExp(`(?:^|[^a-z])${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:[^a-z]|$)`);
		if (re.test(s)) return v;
	}
	return null;
}

function parseSummaryLocation(summary) {
	const s = String(summary || '');
	const m = s.match(/Located in\s+([^(]+)\(([^)]+)\)/i);
	if (!m) return null;
	return { country: m[1].trim(), city: m[2].trim() };
}

function locCountryCode(loc) {
	// Prefer signals in raw address text — stored country is often wrong (US stamped on foreign HQ).
	const raw = String(loc.raw || '');
	const fromRaw = countryCode(raw);
	if (fromRaw && /(?:united states|united kingdom|canada|france|germany|spain|italy|netherlands|china|japan|korea|singapore|australia|india|brazil|russia|denmark|sweden|switzerland|ireland|hong kong|mexico|argentina|saudi arabia)/i.test(raw)) {
		return fromRaw;
	}
	const gk = String(loc.geo_key || '').toLowerCase();
	if (gk.startsWith('us:')) return 'us';
	if (gk.startsWith('country:')) {
		return countryCode(gk.slice('country:'.length).replace(/-/g, ' '));
	}
	const m = gk.match(/^([a-z]{2}(?:-[a-z]+)?):/);
	if (m) {
		const prefix = m[1];
		if (prefix === 'us') return 'us';
		if (COUNTRY_TO_CODE[prefix.replace(/-/g, ' ')]) return COUNTRY_TO_CODE[prefix.replace(/-/g, ' ')];
		if (/^[a-z]{2}$/.test(prefix) && prefix !== 'co') return prefix;
	}
	const fromCountry = countryCode(loc.country);
	if (fromCountry) return fromCountry;
	if (fromRaw) return fromRaw;
	return null;
}

function isProtectedSource(source) {
	return /stem-universities|org-hq-curated|org-hq-wikipedia|free-ipeds|free-wikidata|ufo-uap|bruce-king|tahlequah|family-|wikipedia-local|stem-focus/i.test(
		String(source || ''),
	);
}

function cityMatches(a, b) {
	if (!a || !b) return false;
	const na = String(a).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const nb = String(b).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	if (!na || !nb) return false;
	return na === nb || na.includes(nb) || nb.includes(na);
}

const report = {
	dryRun,
	nameRestored: [],
	summaryRestored: [],
	locationsDeleted: [],
	metadataFixed: [],
	displacedCreated: [],
	manualFlagsSet: [],
	errors: [],
};

const education = db
	.prepare(
		`SELECT id, slug, name, summary, metadata_json FROM profiles WHERE profile_type = 'education'`,
	)
	.all();

for (const row of education) {
	try {
		const meta = JSON.parse(row.metadata_json || '{}');
		const locs = db
			.prepare(
				`SELECT id, role, raw, city, state, country, geo_key, source_corpus
         FROM profile_locations WHERE profile_id = ?`,
			)
			.all(row.id)
			.filter((l) => {
				const role = String(l.role || 'hq').toLowerCase();
				return role === 'hq' || role === 'headquarters' || role === '';
			});

		const summaryLoc = parseSummaryLocation(row.summary);
		const restoreName = NAME_RESTORES[row.slug];
		let targetCity = summaryLoc?.city || null;
		let targetCountry = summaryLoc?.country || null;

		// Prefer stem / curated street over polluted meta when summary exists
		if (restoreName === 'Korea University') {
			targetCity = 'Seoul';
			targetCountry = 'South Korea';
		} else if (restoreName === 'King Saud University') {
			targetCity = 'Riyadh';
			targetCountry = 'Saudi Arabia';
		} else if (restoreName === 'University of South Florida') {
			targetCity = 'Tampa';
			targetCountry = 'United States';
		}

		const targetCode = countryCode(targetCountry);

		// Conservative deletes:
		// 1) global-education-curated city stubs that conflict with summary/target OR duplicate a better HQ
		// 2) clearly wrong-country contaminants (named below)
		// Never delete protected sources unless raw text proves wrong country vs target.
		const toDelete = [];
		const protectedKeep = locs.filter((l) => isProtectedSource(l.source_corpus));

		for (const loc of locs) {
			const source = String(loc.source_corpus || '');
			const code = locCountryCode(loc);
			const city = loc.city || loc.raw;
			const streetish = /\d/.test(String(loc.raw || ''));
			const protectedLoc = isProtectedSource(source);

			// Explicit known contaminants
			if (row.slug === 'education:de-la-salle-university' && code === 'us') {
				toDelete.push(loc);
				continue;
			}
			if (
				row.slug === 'education:college-of-saint-benedict-and-saint-johns-university' &&
				/brighton/i.test(String(loc.raw || ''))
			) {
				toDelete.push(loc);
				continue;
			}
			if (row.slug === 'education:alexandria-university' && /alexandria,\s*la/i.test(String(loc.raw || ''))) {
				toDelete.push(loc);
				continue;
			}
			if (row.slug === 'education:covenant-university' && /saint louis|st\.?\s*louis/i.test(String(loc.raw || ''))) {
				toDelete.push(loc);
				continue;
			}
			if (row.slug === 'education:city-university-of-new-york' && /jersey city/i.test(String(loc.raw || ''))) {
				toDelete.push(loc);
				continue;
			}
			if (row.slug === 'education:boston-college' && /silber way/i.test(String(loc.raw || ''))) {
				toDelete.push(loc);
				continue;
			}
			if (
				row.slug === 'education:concordia-university' &&
				/irvine|concordia west/i.test(String(loc.raw || ''))
			) {
				toDelete.push(loc);
				continue;
			}
			if (
				row.slug === 'education:charles-university' &&
				/worcester|united kingdom/i.test(String(loc.raw || ''))
			) {
				toDelete.push(loc);
				continue;
			}

			if (source === 'global-education-curated' && !streetish) {
				const conflictsCountry = Boolean(targetCode && code && code !== targetCode);
				const conflictsCity = Boolean(targetCity && city && !cityMatches(city, targetCity));
				const hasBetter =
					protectedKeep.some((o) => o.id !== loc.id) ||
					locs.some(
						(o) =>
							o.id !== loc.id &&
							(/\d/.test(String(o.raw || '')) || isProtectedSource(o.source_corpus)) &&
							(!targetCode || !locCountryCode(o) || locCountryCode(o) === targetCode),
					);
				if (conflictsCountry || conflictsCity || hasBetter) {
					toDelete.push(loc);
					continue;
				}
			}

		}

		const uniqueDelete = [...new Map(toDelete.map((l) => [l.id, l])).values()];

		if (uniqueDelete.length && !dryRun) {
			for (const loc of uniqueDelete) {
				deleteLocation({ id: loc.id, profileId: row.id });
			}
		}
		if (uniqueDelete.length) {
			report.locationsDeleted.push({
				slug: row.slug,
				name: row.name,
				deleted: uniqueDelete.map((l) => ({
					raw: l.raw,
					country: l.country,
					source: l.source_corpus,
				})),
			});
		}

		// Name / summary restores
		const patch = {};
		if (restoreName && restoreName !== row.name) {
			patch.name = restoreName;
			report.nameRestored.push({ slug: row.slug, from: row.name, to: restoreName });
		}
		if (SUMMARY_RESTORES[row.slug]) {
			patch.summary = SUMMARY_RESTORES[row.slug];
			report.summaryRestored.push({ slug: row.slug });
		}

		// Metadata realign from target city/country
		const metaPatch = { ...meta };
		let metaChanged = false;
		if (targetCity && meta.hqCity !== targetCity) {
			metaPatch.hqCity = targetCity;
			metaChanged = true;
		}
		if (targetCountry && meta.country !== targetCountry) {
			metaPatch.country = targetCountry;
			metaChanged = true;
		}
		if (targetCode) {
			const regionGuess =
				['us', 'ca', 'mx'].includes(targetCode)
					? 'North America'
					: ['gb', 'fr', 'de', 'es', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'dk', 'fi', 'ie', 'pt', 'pl', 'cz', 'ru'].includes(
								targetCode,
						  )
						? 'Europe'
						: ['cn', 'jp', 'kr', 'hk', 'sg', 'in', 'tw', 'th', 'vn', 'id', 'my', 'ph', 'bd', 'pk'].includes(targetCode)
							? 'Asia'
							: ['au', 'nz'].includes(targetCode)
								? 'Oceania'
								: ['br', 'ar', 'cl'].includes(targetCode)
									? 'South America'
									: meta.region;
			if (regionGuess && meta.region !== regionGuess) {
				metaPatch.region = regionGuess;
				metaChanged = true;
			}
			const codes = Array.isArray(meta.manualCountryCodes) ? meta.manualCountryCodes.map(String) : [];
			if (codes.length !== 1 || codes[0] !== targetCode) {
				// Only force manual flag when we had cross-country pollution or name restore
				const hadCrossCountry =
					locs.some((l) => {
						const c = locCountryCode(l);
						return c && targetCode && c !== targetCode;
					}) || Boolean(restoreName);
				if (hadCrossCountry) {
					metaPatch.manualCountryCodes = [targetCode];
					metaChanged = true;
					report.manualFlagsSet.push({ slug: row.slug, codes: [targetCode] });
				}
			}
		}
		if (metaChanged) {
			patch.metadata = metaPatch;
			report.metadataFixed.push({
				slug: row.slug,
				hqCity: metaPatch.hqCity,
				country: metaPatch.country,
			});
		}

		if (Object.keys(patch).length && !dryRun) {
			updateProfileFields(row.id, patch);
			touchProfilesForUserAction([row.id]);
		}
	} catch (err) {
		report.errors.push({ slug: row.slug, error: String(err?.message || err) });
	}
}

// Create displaced university cards
for (const d of DISPLACED) {
	try {
		const existingByName = db
			.prepare(
				`SELECT id, slug, name FROM profiles
         WHERE profile_type = 'education' AND (name = ? OR slug = ?)`,
			)
			.get(d.name, `education:${d.slugHint}`);
		if (existingByName && NAME_RESTORES[existingByName.slug]) {
			// still the corrupt card before rename applied in same process — skip name collision
		}
		const after = dryRun
			? existingByName
			: getProfile(`education:${d.slugHint}`) ||
				db.prepare(`SELECT id, slug, name FROM profiles WHERE profile_type='education' AND name = ?`).get(d.name);

		// If a card with this exact name still points at a restored US slug, we need a new slug card
		const blockedSlugs = new Set(Object.keys(NAME_RESTORES));
		if (after && !blockedSlugs.has(after.slug) && after.name === d.name) {
			report.displacedCreated.push({ name: d.name, status: 'already_exists', slug: after.slug });
			continue;
		}

		if (dryRun) {
			report.displacedCreated.push({ name: d.name, status: 'would_create', slug: `education:${d.slugHint}` });
			continue;
		}

		const created = upsertProfile({
			name: d.name,
			profileType: 'education',
			slug: d.slugHint,
			summary: d.summary,
			status: 'active',
			metadata: {
				hqCity: d.hq.city,
				country: d.hq.country,
				manualCountryCodes: d.manualCountryCodes,
				corpora: ['org-validate-displaced-restore'],
			},
			sourceCorpus: 'org-validate-displaced-restore',
		});
		addLocation({
			profileId: created.id,
			raw: d.hq.raw,
			city: d.hq.city,
			country: d.hq.country,
			role: 'hq',
			sourceCorpus: 'org-validate-displaced-restore',
			confirmed: true,
		});
		for (const a of d.aliases || []) {
			addAlias({
				profileId: created.id,
				alias: a,
				aliasKind: 'name',
				confidence: 0.9,
				sourceCorpus: 'org-validate-displaced-restore',
			});
		}
		touchProfilesForUserAction([created.id]);
		report.displacedCreated.push({ name: d.name, status: 'created', slug: created.slug, id: created.id });
	} catch (err) {
		report.errors.push({ displaced: d.name, error: String(err?.message || err) });
	}
}

fs.writeFileSync(path.join(outDir, 'education-hq-repair.json'), JSON.stringify(report, null, 2));
console.log(
	JSON.stringify(
		{
			outDir,
			dryRun,
			nameRestored: report.nameRestored.length,
			summaryRestored: report.summaryRestored.length,
			profilesWithLocDeletes: report.locationsDeleted.length,
			locRowsDeleted: report.locationsDeleted.reduce((n, r) => n + r.deleted.length, 0),
			metadataFixed: report.metadataFixed.length,
			manualFlagsSet: report.manualFlagsSet.length,
			displacedCreated: report.displacedCreated,
			errors: report.errors,
		},
		null,
		2,
	),
);
