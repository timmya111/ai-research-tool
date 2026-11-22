#!/usr/bin/env node
/**
 * Import curated global education institutions (public + private) as education profiles.
 * Source: .data/global-education/institutions.json
 * Usage: pnpm profiles:import-global-education
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

const CORPUS = 'global-education-curated';
const SEED_PATH = path.join(ROOT, '.data/global-education/institutions.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const institutions = Array.isArray(seed.institutions) ? seed.institutions : [];

let created = 0;
let updated = 0;
let publicCount = 0;
let privateCount = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:global-education',
			sourceUrl: null,
			title: 'Global education institutions (public & private)',
			excerpt: `${institutions.length} curated universities, colleges, and institutes across world regions.`,
			metadata: {
				count: institutions.length,
				stats: seed.stats || null,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	const findExisting = (name, aliases = []) => {
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		for (const candidate of candidates) {
			const byName = tx
				.prepare(
					`SELECT id, slug, name FROM profiles
           WHERE profile_type = 'education' AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (byName?.id) return byName;
			const byAlias = tx
				.prepare(
					`SELECT p.id, p.slug, p.name
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = 'education' AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (byAlias?.id) return byAlias;
		}
		return null;
	};

	for (const u of institutions) {
		const name = String(u.name || '').trim();
		if (!name) continue;

		const aliases = Array.isArray(u.aliases)
			? u.aliases.map((a) => String(a).trim()).filter(Boolean)
			: [];
		const existing = findExisting(name, aliases);
		const slug = existing?.slug || makeProfileSlug('education', name);
		const funding = String(u.funding || 'public').toLowerCase() === 'private' ? 'private' : 'public';
		const country = u.country ? String(u.country).trim() : null;
		const region = u.region ? String(u.region).trim() : null;
		const city = u.hqCity ? String(u.hqCity).trim() : null;
		const category = u.category ? String(u.category).trim() : 'university';

		const summaryParts = [
			`${funding === 'private' ? 'Privately funded' : 'Publicly funded'} ${category}.`,
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
						category,
						funding === 'private' ? 'private-education' : 'public-education',
						...(region
							? [region.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')]
							: []),
					],
					funding,
					institutionCategory: category,
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

		if (existing) updated += 1;
		else created += 1;
		if (funding === 'private') privateCount += 1;
		else publicCount += 1;

		for (const alias of aliases) {
			if (alias.toLowerCase() === name.toLowerCase()) continue;
			addAlias({ profileId: prof.id, alias, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `global-education:${slug}`,
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
			seedCount: institutions.length,
			created,
			updated,
			publicCount,
			privateCount,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
