#!/usr/bin/env node
/**
 * Free org enrich: street HQ + founding date + active status.
 *
 * Sources: Wikidata SPARQL, ProPublica Nonprofit Explorer (nonprofits), Nominatim/OSM.
 * No paid Places APIs.
 *
 * Usage:
 *   node scripts/backfill-org-free-enrich.mjs --dry-run --limit 25
 *   node scripts/backfill-org-free-enrich.mjs --types education,nonprofit --limit 40
 *   node scripts/backfill-org-free-enrich.mjs --types nonprofit --limit 100
 *   node scripts/backfill-org-free-enrich.mjs --dates-only --limit 50
 *   node scripts/backfill-org-free-enrich.mjs --addresses-only --limit 50
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

const { addLocation, addIdentifier, updateProfileFields, getProfile } = await import(
	'../src/lib/research/profiles/store.ts'
);
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');
const {
	lookupOrgFreeEnrich,
	looksLikeSecuritiesJunk,
	isPlausibleStreetHq,
	isContaminantFreeOrgAddress,
	looksLikeForeignNonprofitName,
} = await import('../src/lib/research/profiles/freeOrgEnrich.ts');

const ALLOWED = new Set(['education', 'nonprofit', 'medical_hospital', 'government']);

try {
	process.stdout._handle?.setBlocking?.(true);
} catch {
	/* ignore */
}

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
const forceDates = has('--force-dates');
const addressesOnly = has('--addresses-only');
const datesOnly = has('--dates-only');
const limit = Math.max(1, Number(arg('--limit', '40')) || 40);
const types = String(arg('--types', 'education,nonprofit,medical_hospital,government'))
	.split(',')
	.map((s) => s.trim())
	.filter((t) => ALLOWED.has(t));
if (!types.length) {
	console.error('No valid --types');
	process.exit(1);
}

const DB_PATH = path.join(ROOT, '.data/profiles/profiles.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 60000');
db.exec('PRAGMA foreign_keys = ON');

const withStreet = new Set(
	db
		.prepare(
			`SELECT DISTINCT profile_id AS id FROM profile_locations
       WHERE raw GLOB '*[0-9]*'`,
		)
		.all()
		.map((r) => String(r.id)),
);

const einByProfile = new Map(
	db
		.prepare(
			`SELECT profile_id AS id, value FROM profile_identifiers WHERE scheme = 'irs_ein'`,
		)
		.all()
		.map((r) => [String(r.id), String(r.value)]),
);

const placeholders = types.map(() => '?').join(',');
const rows = db
	.prepare(
		`SELECT id, slug, name, profile_type, status, start_date, end_date
     FROM profiles
     WHERE profile_type IN (${placeholders})
     ORDER BY name ASC`,
	)
	.all(...types);

const candidates = [];
for (const r of rows) {
	if (looksLikeSecuritiesJunk(r.name, r.profile_type)) continue;
	if (/\bfamily\b/i.test(r.name) && r.profile_type === 'nonprofit') continue;

	const hasStreet = withStreet.has(r.id);
	const hasStart = Boolean(r.start_date && String(r.start_date).trim());
	const needAddr = !datesOnly && !hasStreet;
	const needDate = !addressesOnly && (!hasStart || forceDates);
	if (!needAddr && !needDate) continue;

	candidates.push({
		id: r.id,
		slug: r.slug,
		name: r.name,
		profileType: r.profile_type,
		status: r.status,
		startDate: r.start_date,
		endDate: r.end_date,
		ein: einByProfile.get(r.id) || null,
		needAddr,
		needDate,
	});
}

const queue = candidates.slice(0, limit);
console.log(
	JSON.stringify({
		dryRun,
		limit,
		types,
		addressesOnly,
		datesOnly,
		forceDates,
		candidates: candidates.length,
		queue: queue.length,
	}),
);

const summary = {
	processed: 0,
	addressesAdded: 0,
	datesSet: 0,
	statusSet: 0,
	identifiersAdded: 0,
	skipped: 0,
	errors: 0,
};

for (let i = 0; i < queue.length; i++) {
	const row = queue[i];
	summary.processed += 1;
	try {
		const hit = await lookupOrgFreeEnrich({
			name: row.name,
			profileType: row.profileType,
			ein: row.ein,
			skipNominatim: datesOnly || !row.needAddr,
			skipProPublica: row.profileType !== 'nonprofit',
		});

		if (!hit.address && !hit.startDate && !hit.endDate && !hit.wikidataQid && !hit.ein) {
			summary.skipped += 1;
			if ((i + 1) % 10 === 0) {
				console.log(JSON.stringify({ processed: i + 1, ...summary }));
			}
			continue;
		}

		const parts = [];
		if (
			row.needAddr &&
			hit.address &&
			isPlausibleStreetHq(hit.address.raw) &&
			!isContaminantFreeOrgAddress(hit.address.raw) &&
			!(row.profileType === 'nonprofit' && looksLikeForeignNonprofitName(row.name) && hit.address.source === 'irs-eo-bmf')
		) {
			const parsed = parseAddressParts(hit.address.raw);
			const corpus = `free-${hit.address.source}`;
			if (!dryRun) {
				addLocation(
					{
						profileId: row.id,
						raw: hit.address.raw,
						city: hit.address.city ?? parsed.city,
						state: hit.address.state ?? parsed.state,
						country: hit.address.country ?? parsed.country,
						lat: hit.address.lat ?? null,
						lon: hit.address.lon ?? null,
						role: 'hq',
						sourceCorpus: corpus,
					},
					db,
				);
			}
			summary.addressesAdded += 1;
			parts.push(`addr[${hit.address.source}]=${hit.address.raw}`);
		}

		const patch = {};
		if (row.needDate && hit.startDate && (forceDates || !row.startDate)) {
			patch.startDate = hit.startDate;
			summary.datesSet += 1;
			parts.push(`start=${hit.startDate}`);
		}
		if (hit.endDate && !row.endDate) {
			patch.endDate = hit.endDate;
			parts.push(`end=${hit.endDate}`);
		}
		if (
			hit.status &&
			row.status !== 'pinned' &&
			(hit.status === 'archived' || (hit.status === 'active' && row.status === 'candidate'))
		) {
			patch.status = hit.status;
			summary.statusSet += 1;
			parts.push(`status=${hit.status}`);
		}

		if (!dryRun && Object.keys(patch).length) {
			updateProfileFields(row.id, patch, db);
		}

		if (hit.wikidataQid) {
			if (!dryRun) {
				addIdentifier(
					{ profileId: row.id, scheme: 'wikidata', value: hit.wikidataQid, sourceCorpus: 'free-wikidata' },
					db,
				);
			}
			summary.identifiersAdded += 1;
			parts.push(`qid=${hit.wikidataQid}`);
		}
		if (hit.ein && row.profileType === 'nonprofit') {
			if (!dryRun) {
				addIdentifier(
					{ profileId: row.id, scheme: 'irs_ein', value: hit.ein, sourceCorpus: 'free-propublica' },
					db,
				);
			}
			summary.identifiersAdded += 1;
			parts.push(`ein=${hit.ein}`);
		}

		if (parts.length) {
			console.log(`${dryRun ? 'DRY ' : 'OK '}${row.slug} ${parts.join(' | ')}`);
		} else {
			summary.skipped += 1;
		}
	} catch (e) {
		summary.errors += 1;
		console.log(`ERR ${row.slug} ${e?.message || e}`);
	}
}

console.log(JSON.stringify({ done: true, dryRun, ...summary }));
db.close();
