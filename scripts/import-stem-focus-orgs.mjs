#!/usr/bin/env node
/**
 * Import STEM-focus education, nonprofit, medical_hospital, and government orgs
 * (DNA repair, CRISPR, DNA/genomics, blood, quantum).
 * Source: .data/stem-focus-orgs/organizations.json
 * Usage: pnpm profiles:import-stem-focus-orgs
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

const CORPUS = 'stem-focus-orgs-curated';
const SEED_PATH = path.join(ROOT, '.data/stem-focus-orgs/organizations.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const orgs = Array.isArray(seed.organizations) ? seed.organizations : [];

const ALLOWED_TYPES = new Set(['education', 'nonprofit', 'medical_hospital', 'government']);

let created = 0;
let updated = 0;
/** @type {Record<string, number>} */
const byType = { education: 0, nonprofit: 0, medical_hospital: 0, government: 0 };

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:stem-focus-orgs',
			sourceUrl: null,
			title: 'STEM focus organizations (DNA / CRISPR / blood / quantum)',
			excerpt: `${orgs.length} STEM-focus orgs across education, nonprofit, medical_hospital, government.`,
			metadata: {
				count: orgs.length,
				focusKeywords: seed.focusKeywords || [],
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	const findExisting = (profileType, name, aliases = []) => {
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		for (const candidate of candidates) {
			const byName = tx
				.prepare(
					`SELECT id, slug, name, profile_type FROM profiles
           WHERE profile_type = ? AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byName?.id) return byName;
			const byAlias = tx
				.prepare(
					`SELECT p.id, p.slug, p.name, p.profile_type
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byAlias?.id) return byAlias;
		}
		// Cross-type fallback for institutes that already exist under another org type
		for (const candidate of candidates) {
			const row = tx
				.prepare(
					`SELECT id, slug, name, profile_type FROM profiles
           WHERE profile_type IN ('education','nonprofit','medical_hospital','government')
             AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (row?.id) return row;
		}
		return null;
	};

	for (const o of orgs) {
		const name = String(o.name || '').trim();
		if (!name) continue;
		const requestedType = String(o.profileType || '').trim();
		if (!ALLOWED_TYPES.has(requestedType)) continue;
		const aliases = Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const existing = findExisting(requestedType, name, aliases);
		const profileType = existing?.profile_type && ALLOWED_TYPES.has(existing.profile_type)
			? existing.profile_type
			: requestedType;
		const slug = existing?.slug || makeProfileSlug(profileType, name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const focusAreas = Array.isArray(o.focusAreas)
			? o.focusAreas.map((f) => String(f).trim()).filter(Boolean)
			: [];
		const country = o.country ? String(o.country).trim() : null;
		const city = o.hqCity ? String(o.hqCity).trim() : null;
		const state = o.hqState ? String(o.hqState).trim() : null;
		const taxClass = o.taxClass ? String(o.taxClass) : null;
		const summary =
			String(o.summary || '').trim() ||
			`${name} is a STEM-focused ${profileType.replace(/_/g, ' ')} organization.`;

		const prof = upsertProfile(
			{
				profileType,
				name: existing?.name || name,
				slug,
				status: 'pinned',
				summary,
				metadata: {
					categoryTags: [
						profileType,
						'stem-focus',
						...focusAreas,
						...(taxClass ? [taxClass.replace(/[()]/g, '')] : []),
					],
					focusAreas,
					stemFocus: true,
					taxClassification: taxClass || undefined,
					country: country || undefined,
					hqCity: city || undefined,
					hqState: state || undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed || existing) updated += 1;
		else created += 1;
		byType[profileType] = (byType[profileType] || 0) + 1;

		for (const al of [name, ...aliases]) {
			if (al.toLowerCase() === String(existing?.name || name).toLowerCase()) continue;
			addAlias({ profileId: prof.id, alias: al, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `stem-focus-org:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (country || city || state) {
			const locRaw = [city, state, country].filter(Boolean).join(', ');
			const parts = parseAddressParts(locRaw);
			addLocation(
				{
					profileId: prof.id,
					raw: locRaw,
					city: parts.city || city || null,
					county: parts.county,
					state: parts.state || state || null,
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
			seedCount: orgs.length,
			created,
			updated,
			byType,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
