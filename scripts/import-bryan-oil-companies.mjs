#!/usr/bin/env node
/**
 * Import Bryan County, OK oil & gas producers from MineralAnswers as firm profiles.
 * Seed: .data/bryan-oil/bryan_county_oil_companies.json
 *
 * Usage: pnpm profiles:import-bryan-oil
 *        node scripts/import-bryan-oil-companies.mjs [--dry-run]
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
const {
	upsertProfile,
	addAlias,
	addIdentifier,
	addLocation,
	upsertSourceRecord,
	getProfile,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, normalizeLocationRecord } = await import(
	'../src/lib/research/profiles/normalize.ts'
);

const CORPUS = 'mineralanswers-bryan-oil';
const SOURCE_URL = 'https://www.mineralanswers.com/oklahoma/bryan-county';
const PRODUCERS_URL = 'https://www.mineralanswers.com/oklahoma/bryan-county/producers';
const SEED_PATH = path.join(ROOT, '.data/bryan-oil/bryan_county_oil_companies.json');
const dryRun = process.argv.includes('--dry-run');

/** Slugs that would collide with a different entity already in profiles. */
const SLUG_OVERRIDES = {
	// Existing firm:continental-resources-inc is a terminated FINRA BD (PA), not the OK oil producer.
	'CONTINENTAL RESOURCES, INC.': 'firm:continental-resources-oil-gas',
};

function cleanAddress(raw) {
	if (!raw) return null;
	return String(raw)
		.replace(/\bOk\./gi, 'OK')
		.replace(/\bTx\./gi, 'TX')
		.replace(/\bTx\b/gi, 'TX')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleCaseName(name) {
	// Keep ALL-CAPS legal names mostly as-is but normalize spacing; MineralAnswers uses caps.
	return String(name || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function formatBoe(n) {
	if (n == null || !Number.isFinite(Number(n))) return null;
	const v = Number(n);
	if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K BOE`;
	return `${Math.round(v)} BOE`;
}

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const companies = Array.isArray(seed.companies) ? seed.companies : [];
if (!companies.length) {
	console.error('No companies in seed', SEED_PATH);
	process.exit(1);
}

let created = 0;
let updated = 0;
let locations = 0;
let aliases = 0;
const slugs = [];

if (dryRun) {
	for (const c of companies) {
		const name = titleCaseName(c.name);
		const slug = SLUG_OVERRIDES[name] || makeProfileSlug('firm', name);
		const existed = Boolean(getProfile(slug));
		console.log(`${existed ? 'UPDATE' : 'CREATE'} ${slug}  ${name}`);
	}
	console.log(`dry-run: ${companies.length} companies`);
	process.exit(0);
}

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'mineralanswers:oklahoma/bryan-county/producers',
			sourceUrl: PRODUCERS_URL,
			title: 'Bryan County, OK Oil & Gas Producers (MineralAnswers)',
			excerpt: `${companies.length} Bryan County oil & gas producers imported as firm profiles.`,
			metadata: {
				count: companies.length,
				countyPage: SOURCE_URL,
				fetchedAt: seed.fetchedAt || null,
			},
		},
		tx,
	);

	for (const c of companies) {
		const name = titleCaseName(c.name);
		if (!name) continue;

		const slug = SLUG_OVERRIDES[name] || makeProfileSlug('firm', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

		const apr = c.apr2026 || null;
		const boeLabel = apr ? formatBoe(apr.boe) : null;
		const summaryParts = [
			`${name} is an oil & gas producer with activity in Bryan County, Oklahoma (MineralAnswers).`,
			apr
				? `Apr 2026 Bryan County production: ${apr.oilRaw || '—'} oil, ${apr.gasRaw || '—'} gas (${apr.boeRaw || boeLabel || '—'}).`
				: c.latestProductionDate
					? `Latest production date listed: ${c.latestProductionDate}.`
					: null,
			c.activeApr2026 ? 'Listed among county Top Producers by BOE for Apr 2026.' : null,
		].filter(Boolean);

		const prof = upsertProfile(
			{
				profileType: 'firm',
				name,
				slug,
				status: 'pinned',
				summary: summaryParts.join(' '),
				metadata: {
					industry: 'oil_and_gas',
					sector: 'energy',
					bryanCountyOk: true,
					mineralAnswersProducerId: c.producerId || undefined,
					mineralAnswersUrl: c.url || undefined,
					mineralAnswersLatestProductionDate: c.latestProductionDate || undefined,
					bryanActiveApr2026: Boolean(c.activeApr2026),
					bryanApr2026: apr
						? {
								productionDate: apr.productionDate,
								oilBbl: apr.oilBbl,
								gasMcf: apr.gasMcf,
								boe: apr.boe,
							}
						: undefined,
					hqAddressRaw: c.address || undefined,
					sourceRecordId: srId,
					disambiguation:
						slug === 'firm:continental-resources-oil-gas'
							? 'Distinct from firm:continental-resources-inc (terminated FINRA broker-dealer, Pennsylvania).'
							: undefined,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;
		slugs.push(prof.slug);

		if (c.url) {
			addIdentifier(
				{
					profileId: prof.id,
					scheme: 'url',
					value: c.url,
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
		if (c.producerId) {
			addIdentifier(
				{
					profileId: prof.id,
					scheme: 'source_id',
					value: `mineralanswers-ok-producer:${c.producerId}`,
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		// Title-ish display alias when name is ALL CAPS
		const pretty = name.replace(/\b([A-Z]+)\b/g, (w) => {
			if (['LLC', 'LP', 'INC', 'CORP', 'CO', 'L', 'E', 'LL', 'C'].includes(w)) return w;
			if (w.length <= 2) return w;
			return w.charAt(0) + w.slice(1).toLowerCase();
		});
		if (pretty !== name) {
			addAlias({
				profileId: prof.id,
				alias: pretty,
				aliasKind: 'name',
				sourceCorpus: CORPUS,
			}, tx);
			aliases += 1;
		}
		if (slug === 'firm:continental-resources-oil-gas') {
			addAlias({
				profileId: prof.id,
				alias: 'Continental Resources',
				aliasKind: 'name',
				sourceCorpus: CORPUS,
			}, tx);
			aliases += 1;
		}

		const hqRaw = cleanAddress(c.address);
		if (hqRaw) {
			const parts = normalizeLocationRecord({ raw: hqRaw });
			addLocation(
				{
					profileId: prof.id,
					raw: parts.raw || hqRaw,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country || 'US',
					role: 'hq',
					sourceCorpus: CORPUS,
				},
				tx,
			);
			locations += 1;
		}

		// Bryan County operating footprint
		addLocation(
			{
				profileId: prof.id,
				raw: 'Bryan County, OK',
				city: null,
				county: 'Bryan',
				state: 'OK',
				country: 'US',
				role: 'associated',
				sourceCorpus: CORPUS,
			},
			tx,
		);
		locations += 1;
	}

	void srId;
});

console.log(
	JSON.stringify(
		{
			ok: true,
			created,
			updated,
			locations,
			aliases,
			total: companies.length,
			corpus: CORPUS,
			sampleSlugs: slugs.slice(0, 8),
		},
		null,
		2,
	),
);
