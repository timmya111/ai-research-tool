#!/usr/bin/env node
/**
 * Import curated global STEM universities as education profiles.
 * Source: .data/stem-universities/universities.json
 * Usage: pnpm profiles:import-stem-universities
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
	addAlias,
	addIdentifier,
	addLocation,
	upsertSourceRecord,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'stem-universities-curated';
const SEED_PATH = path.join(ROOT, '.data/stem-universities/universities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const unis = Array.isArray(seed.universities) ? seed.universities : [];

let created = 0;
let updated = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:stem-universities-qs-the-2026',
			sourceUrl: null,
			title: 'Global STEM universities (QS 2026 / THE Engineering & Science)',
			excerpt: `${unis.length} global STEM universities imported from curated QS/THE list.`,
			metadata: { count: unis.length, retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	for (const u of unis) {
		const name = String(u.name || '').trim();
		if (!name) continue;

		const slug = makeProfileSlug('education', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const rank = Number(u.rank) || null;
		const country = u.country ? String(u.country).trim() : null;
		const region = u.region ? String(u.region).trim() : null;
		const city = u.hqCity ? String(u.hqCity).trim() : null;

		const summaryParts = [
			rank ? `Ranked #${rank} on a curated 2026 QS/THE global STEM university list.` : null,
			region ? `${region}.` : null,
			country ? `Located in ${country}${city ? ` (${city})` : ''}.` : null,
			u.note ? String(u.note).trim() : null,
		].filter(Boolean);

		const prof = upsertProfile(
			{
				profileType: 'education',
				name,
				slug,
				status: 'pinned',
				summary: summaryParts.join(' '),
				metadata: {
					categoryTags: [
						'education',
						'university',
						'stem',
						'stem-university',
						...(region ? [region.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')] : []),
					],
					stemRank: rank || undefined,
					stemList: 'qs-the-2026-curated-120',
					region: region || undefined,
					country: country || undefined,
					hqCity: city || undefined,
					note: u.note || undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;

		if (Array.isArray(u.aliases)) {
			for (const al of u.aliases) {
				const alias = String(al || '').trim();
				if (!alias || alias.toLowerCase() === name.toLowerCase()) continue;
				addAlias({ profileId: prof.id, alias, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `stem-university:${rank ?? slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (country || city) {
			const locRaw = [city, country].filter(Boolean).join(', ');
			const parts = parseAddressParts(locRaw);
			addLocation(
				{
					profileId: prof.id,
					raw: locRaw,
					city: parts.city || city || null,
					county: parts.county,
					state: parts.state || null,
					country: parts.country || country || null,
					role: 'hq',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			seedCount: unis.length,
			created,
			updated,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
