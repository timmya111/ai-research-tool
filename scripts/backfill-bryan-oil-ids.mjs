#!/usr/bin/env node
/**
 * Curated identifier enrichment for MineralAnswers Bryan County oil firm profiles.
 * Sources: local SEC CIK index (.data/sec/ciks-since-2016.json), EDGAR submissions
 * (EIN/SIC), Oklahoma OCC + Texas RRC operator numbers (Valor / Berlin / RRC pages).
 *
 * Only high-confidence matches. Parent filers use parent_sec_cik (no same-entity merge).
 * OCC/RRC stored as source_id: occ-operator:N / rrc-p5:N.
 *
 * Usage:
 *   node scripts/backfill-bryan-oil-ids.mjs
 *   node scripts/backfill-bryan-oil-ids.mjs --dry-run
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const { withProfilesTransaction } = await import('../src/lib/research/profiles/db.ts');
const { getProfile, addIdentifier, updateProfileFields } = await import(
	'../src/lib/research/profiles/store.ts'
);

const CORPUS = 'bryan-oil-regulatory-ids';
const dryRun = process.argv.includes('--dry-run');

function padCik(cik) {
	return String(cik || '')
		.replace(/\D/g, '')
		.padStart(10, '0');
}

function formatEin(raw) {
	const digits = String(raw || '').replace(/\D/g, '');
	if (digits.length !== 9 || digits === '000000000') return null;
	return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

/**
 * Curated map: profile slug → identifiers + optional metadata patches.
 * Do not invent weak name matches (Seaport SPACs, Zenergy Brands, etc.).
 */
const CURATED = {
	'firm:continental-resources-oil-gas': {
		note: 'Exact SEC name CONTINENTAL RESOURCES, INC; OCC/RRC oil operator (not FINRA BD)',
		identifiers: [
			{ scheme: 'sec_cik', value: '0000732834' },
			{ scheme: 'irs_ein', value: '73-0767549' },
			{ scheme: 'source_id', value: 'occ-operator:3186' },
			{ scheme: 'source_id', value: 'rrc-p5:173777' },
		],
		meta: { sic: '1311', sicDescription: 'Crude Petroleum & Natural Gas' },
	},
	'firm:xto-energy-inc': {
		note: 'Exact SEC name XTO ENERGY INC; Exxon Mobil subsidiary',
		identifiers: [
			{ scheme: 'sec_cik', value: '0000868809' },
			{ scheme: 'irs_ein', value: '75-2347769' },
			{ scheme: 'parent_sec_cik', value: '0000034088' },
			{ scheme: 'source_id', value: 'occ-operator:21003' },
			{ scheme: 'source_id', value: 'rrc-p5:945936' },
		],
		meta: { sic: '1311', sicDescription: 'Crude Petroleum & Natural Gas', parentName: 'Exxon Mobil Corp' },
	},
	'firm:cimarex-energy-co-of-colorado': {
		note: 'Operating entity; parent filer CIMAREX ENERGY CO (now in Coterra family)',
		identifiers: [
			{ scheme: 'parent_sec_cik', value: '0001168054' },
			{ scheme: 'source_id', value: 'rrc-p5:153429' },
		],
		meta: { parentName: 'Cimarex Energy Co', parentEin: '45-0466694' },
	},
	'firm:expand-operating-llc': {
		note: 'Former Chesapeake Operating; manager Expand Energy Corp (EXE) per WV SOS',
		identifiers: [
			{ scheme: 'parent_sec_cik', value: '0000895126' },
			{ scheme: 'source_id', value: 'rrc-p5:103013' },
		],
		meta: {
			parentName: 'Expand Energy Corp',
			parentTicker: 'EXE',
			parentEin: '73-1395733',
			parentFormerName: 'Chesapeake Energy Corp',
		},
	},
	'firm:noble-energy-production-inc': {
		note: 'Operating subsidiary of Noble Energy Inc (acquired by Chevron); not the parent CIK',
		identifiers: [{ scheme: 'parent_sec_cik', value: '0000072207' }],
		meta: { parentName: 'Noble Energy Inc' },
	},
	'firm:kaiser-francis-oil-company': {
		note: 'Private Tulsa independent; OCC/RRC/KCC operator numbers',
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:6390' },
			{ scheme: 'source_id', value: 'rrc-p5:450175' },
			{ scheme: 'source_id', value: 'kcc-operator:6568' },
		],
	},
	'firm:citation-oil-gas-corp': {
		note: 'Private Houston independent; no SEC CIK',
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:14156' },
			{ scheme: 'source_id', value: 'rrc-p5:154235' },
		],
	},
	'firm:crawley-petroleum-corporation': {
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:7980' },
			{ scheme: 'source_id', value: 'rrc-p5:186937' },
		],
	},
	'firm:finley-resources-inc': {
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:20799' },
			{ scheme: 'source_id', value: 'rrc-p5:268602' },
		],
	},
	'firm:mustang-fuel-corporation': {
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:4999' },
			{ scheme: 'source_id', value: 'rrc-p5:596921' },
		],
	},
	'firm:ranken-energy-corporation': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:17205' }],
	},
	'firm:longfellow-energy-lp': {
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:22113' },
			{ scheme: 'source_id', value: 'rrc-p5:508409' },
		],
	},
	'firm:glb-exploration-inc': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:18634' }],
	},
	'firm:spring-operating-company': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:20386' }],
	},
	'firm:dunne-equities-operating-inc': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:20254' }],
	},
	'firm:zenergy-inc': {
		note: 'OK oil operator OCC 11129 — not ZENERGY BRANDS SEC CIK 0001386026',
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:11129' }],
	},
	'firm:aspect-energy-llc': {
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:20672' },
			{ scheme: 'source_id', value: 'rrc-p5:35453' },
		],
	},
	'firm:seaport-inc': {
		note: 'OK oil operator — not Seaport Entertainment/Therapeutics SPACs',
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:18403' }],
	},
	'firm:verdad-oil-gas-corporation': {
		note: 'OK/TX operator — not Verdad advisers/funds',
		identifiers: [
			{ scheme: 'source_id', value: 'occ-operator:16210' },
			{ scheme: 'source_id', value: 'rrc-p5:884572' },
		],
	},
	'firm:godfrey-oil-properties': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:7043' }],
	},
	'firm:rafter-h-operating-llc': {
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:21697' }],
	},
	'firm:l-e-jones-operating-inc': {
		note: 'L.E. Jones Operating, Inc. OCC 19169 (Berlin / OCC)',
		identifiers: [{ scheme: 'source_id', value: 'occ-operator:19169' }],
	},
	'firm:marjo-operating-company-inc': {
		note: 'Marjo Operating Co., Inc. Texas P5; Mid-Continent LLC OCC 23610 is related entity name — attach P5 only',
		identifiers: [{ scheme: 'source_id', value: 'rrc-p5:526277' }],
	},
};

function hasId(db, profileId, scheme, value) {
	const norm = String(value).toLowerCase().replace(/\s+/g, '');
	const row = db
		.prepare(
			`SELECT 1 AS ok FROM profile_identifiers
       WHERE profile_id = ? AND scheme = ? AND normalized_value = ? LIMIT 1`,
		)
		.get(profileId, scheme, norm);
	return Boolean(row);
}

const stats = { profiles: 0, added: 0, skipped: 0, missing: 0, meta: 0 };

await withProfilesTransaction((db) => {
	for (const [slug, entry] of Object.entries(CURATED)) {
		const profile = getProfile(slug, db);
		if (!profile) {
			console.log(`MISSING ${slug}`);
			stats.missing++;
			continue;
		}
		stats.profiles++;
		console.log(`\n${slug} — ${profile.name}${entry.note ? ` (${entry.note})` : ''}`);

		for (const id of entry.identifiers) {
			let value = id.value;
			if (id.scheme === 'sec_cik' || id.scheme === 'parent_sec_cik') value = padCik(value);
			if (id.scheme === 'irs_ein') value = formatEin(value) || value;
			if (hasId(db, profile.id, id.scheme, value)) {
				console.log(`  skip ${id.scheme}:${value}`);
				stats.skipped++;
				continue;
			}
			console.log(`  + ${id.scheme}:${value}`);
			if (!dryRun) {
				addIdentifier(
					{ profileId: profile.id, scheme: id.scheme, value, sourceCorpus: CORPUS },
					db,
				);
			}
			stats.added++;
		}

		if (entry.meta && Object.keys(entry.meta).length) {
			const nextMeta = { ...(profile.metadata || {}), ...entry.meta, bryanOilIdsAt: new Date().toISOString() };
			console.log(`  meta ${JSON.stringify(entry.meta)}`);
			if (!dryRun) {
				updateProfileFields(profile.id, { metadata: nextMeta }, db);
			}
			stats.meta++;
		}
	}
});

console.log(
	`\n${dryRun ? 'DRY-RUN ' : ''}done: profiles=${stats.profiles} added=${stats.added} skipped=${stats.skipped} missing=${stats.missing} meta=${stats.meta}`,
);
