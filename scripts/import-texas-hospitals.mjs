#!/usr/bin/env node
/**
 * Import hospitals from Wikipedia "List of hospitals in Texas" as medical_hospital profiles.
 * Source seed: .data/texas-hospitals/hospitals.json
 *
 * Usage: pnpm profiles:import-tx-hospitals
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
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
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
	addIdentifier,
	addLocation,
	upsertSourceRecord,
} = await import('../src/lib/research/profiles/store.ts');
const { parseAddressParts, makeProfileSlug } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'texas-hospitals-wikipedia';
const SOURCE_URL = 'https://en.wikipedia.org/wiki/List_of_hospitals_in_Texas';
const SEED_PATH = path.join(ROOT, '.data/texas-hospitals/hospitals.json');

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const hospitals = Array.isArray(seed.hospitals) ? seed.hospitals : [];
if (!hospitals.length) {
	console.error('No hospitals in seed file', SEED_PATH);
	process.exit(1);
}

let created = 0;
let updated = 0;
let locations = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'wikipedia:List_of_hospitals_in_Texas',
			sourceUrl: SOURCE_URL,
			title: seed.sourceTitle || 'List of hospitals in Texas',
			excerpt: `${hospitals.length} Texas hospitals imported as medical_hospital profiles.`,
			metadata: {
				count: hospitals.length,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	for (const h of hospitals) {
		const name = String(h.name || '').trim();
		if (!name) continue;
		const city = String(h.city || '').trim() || null;
		const county = String(h.county || '').trim() || null;
		const state = String(h.state || 'TX').trim() || 'TX';
		const country = String(h.country || 'US').trim() || 'US';
		const locParts = [city, county ? `${county} County` : null, state].filter(Boolean);
		const locLabel = locParts.join(', ');

		const slug = makeProfileSlug('medical_hospital', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

		const summaryBits = [
			city ? `${name} is a hospital in ${city}, Texas` : `${name} is a hospital in Texas`,
			county ? `(${county} County)` : null,
			h.affiliation ? `affiliated with ${h.affiliation}` : null,
			h.acuteCareBeds ? `${h.acuteCareBeds} acute care beds` : null,
			h.traumaLevel ? `trauma level ${h.traumaLevel}` : null,
		].filter(Boolean);
		const summary = `${summaryBits.join(' · ')}. Listed on Wikipedia List of hospitals in Texas.`;

		const prof = upsertProfile(
			{
				profileType: 'medical_hospital',
				name,
				slug,
				status: 'pinned',
				summary,
				metadata: {
					categoryTags: ['medical_hospital'],
					state: 'Texas',
					stateCode: 'TX',
					city: city || undefined,
					county: county || undefined,
					affiliation: h.affiliation || undefined,
					acuteCareBeds: h.acuteCareBeds ?? undefined,
					traumaLevel: h.traumaLevel || undefined,
					notes: h.notes || undefined,
					wikipediaListUrl: SOURCE_URL,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'url',
				value: SOURCE_URL,
				sourceCorpus: CORPUS,
			},
			tx,
		);
		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `tx-hospital:${prof.slug.replace(/^medical_hospital:/, '')}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		const parts = parseAddressParts(locLabel);
		addLocation(
			{
				profileId: prof.id,
				raw: locLabel,
				city: parts.city || city,
				county: parts.county || county,
				state: parts.state || state,
				country: parts.country || country,
				role: 'hq',
				sourceCorpus: CORPUS,
			},
			tx,
		);
		locations += 1;
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			source: SOURCE_URL,
			seedCount: hospitals.length,
			created,
			updated,
			locations,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
