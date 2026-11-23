#!/usr/bin/env node
/**
 * Import La Salle County, TX oil & gas producers from MineralAnswers as firm profiles.
 * Seed: .data/la-salle-oil/la_salle_county_oil_companies.json
 *
 * Usage: pnpm profiles:import-la-salle-oil
 *        node scripts/import-la-salle-oil-companies.mjs [--dry-run]
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

const CORPUS = 'mineralanswers-la-salle-oil';
const SOURCE_URL = 'https://www.mineralanswers.com/texas/la-salle-county';
const PRODUCERS_URL = 'https://www.mineralanswers.com/texas/la-salle-county/producers';
const SEED_PATH = path.join(ROOT, '.data/la-salle-oil/la_salle_county_oil_companies.json');
const dryRun = process.argv.includes('--dry-run');

/** Prefer an existing profile slug when the same firm was already imported (e.g. Bryan XTO). */
const SLUG_OVERRIDES = {
	// Bryan import used the same canonical slug for XTO Energy Inc.
	'XTO ENERGY INC.': 'firm:xto-energy-inc',
};

function cleanAddress(raw) {
	if (!raw) return null;
	return String(raw)
		.replace(/\bOk\./gi, 'OK')
		.replace(/\bTx\./gi, 'TX')
		.replace(/\bTx\b/gi, 'TX')
		.replace(/\bCo\./gi, 'CO')
		.replace(/\bAl\./gi, 'AL')
		.replace(/\bGa\./gi, 'GA')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleCaseName(name) {
	return String(name || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function formatBoe(n) {
	if (n == null || !Number.isFinite(Number(n))) return null;
	const v = Number(n);
	if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M BOE`;
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
		console.log(`${existed ? 'UPDATE' : 'CREATE'} ${slug}  ${name}${c.activeJun2026 ? ' [jun2026]' : ''}`);
	}
	console.log(`dry-run: ${companies.length} companies`);
	process.exit(0);
}

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'mineralanswers:texas/la-salle-county/producers',
			sourceUrl: PRODUCERS_URL,
			title: 'La Salle County, TX Oil & Gas Producers (MineralAnswers)',
			excerpt: `${companies.length} La Salle County oil & gas producers imported as firm profiles.`,
			metadata: {
				count: companies.length,
				countyPage: SOURCE_URL,
				fetchedAt: seed.fetchedAt || null,
				counts: seed.counts || null,
			},
		},
		tx,
	);

	for (const c of companies) {
		const name = titleCaseName(c.name);
		if (!name) continue;

		const slug = SLUG_OVERRIDES[name] || makeProfileSlug('firm', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

		const jun = c.jun2026 || null;
		const boeLabel = jun ? formatBoe(jun.boe) : null;
		const laSalleSummary = [
			`${name} is an oil & gas producer with activity in La Salle County, Texas (MineralAnswers).`,
			jun
				? `Jun 2026 La Salle County production: ${jun.oilRaw || '—'} oil, ${jun.gasRaw || '—'} gas (${jun.boeRaw || boeLabel || '—'}).`
				: c.latestProductionDate
					? `Latest production date listed: ${c.latestProductionDate}.`
					: null,
			c.activeJun2026 ? 'Listed among county Top Producers by BOE for Jun 2026.' : null,
		]
			.filter(Boolean)
			.join(' ');

		const existing = existed ? getProfile(slug) : null;
		let summary = laSalleSummary;
		if (existing?.summary && !/La Salle County/i.test(existing.summary)) {
			summary = `${existing.summary} ${laSalleSummary}`;
		} else if (existing?.summary && /La Salle County/i.test(existing.summary)) {
			summary = existing.summary;
		}

		const priorMeta =
			existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
		const mergedMeta = {
			...priorMeta,
			industry: 'oil_and_gas',
			sector: 'energy',
			laSalleCountyTx: true,
			mineralAnswersTxProducerId: c.producerId || undefined,
			mineralAnswersTxUrl: c.url || undefined,
			mineralAnswersLatestProductionDate: c.latestProductionDate || undefined,
			laSalleActiveJun2026: Boolean(c.activeJun2026),
			laSalleJun2026: jun
				? {
						productionDate: jun.productionDate,
						oilBbl: jun.oilBbl,
						gasMcf: jun.gasMcf,
						boe: jun.boe,
					}
				: undefined,
			hqAddressRaw: c.address || priorMeta.hqAddressRaw || undefined,
			sourceRecordId: srId,
		};

		const prof = upsertProfile(
			{
				profileType: 'firm',
				name: existing?.name || name,
				slug,
				status: 'pinned',
				summary,
				metadata: mergedMeta,
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
					value: `mineralanswers-tx-producer:${c.producerId}`,
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		const pretty = name.replace(/\b([A-Z]+)\b/g, (w) => {
			if (['LLC', 'LP', 'INC', 'CORP', 'CO', 'L', 'E', 'LL', 'C', 'USA', 'USG', 'EF', 'O', 'G', 'STX', 'MGMT'].includes(w))
				return w;
			if (w.length <= 2) return w;
			return w.charAt(0) + w.slice(1).toLowerCase();
		});
		if (pretty !== name) {
			addAlias(
				{
					profileId: prof.id,
					alias: pretty,
					aliasKind: 'name',
					sourceCorpus: CORPUS,
				},
				tx,
			);
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

		addLocation(
			{
				profileId: prof.id,
				raw: 'La Salle County, TX',
				city: null,
				county: 'La Salle',
				state: 'TX',
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
