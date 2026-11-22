#!/usr/bin/env node
/**
 * Import curated hematology specialists (person) and blood-disorder centers (medical_hospital).
 * Source: .data/hematology/hematology.json
 * Usage: pnpm profiles:import-hematology
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
	upsertProfileLink,
	upsertSourceRecord,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'hematology-curated';
const SEED_PATH = path.join(ROOT, '.data/hematology/hematology.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const specialists = Array.isArray(seed.specialists) ? seed.specialists : [];
const centers = Array.isArray(seed.centers) ? seed.centers : [];

let createdPeople = 0;
let updatedPeople = 0;
let createdCenters = 0;
let updatedCenters = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:hematology-specialists-centers',
			sourceUrl: null,
			title: 'Hematology specialists & blood-disorder centers (curated)',
			excerpt: `${specialists.length} specialists and ${centers.length} centers imported.`,
			metadata: {
				specialistCount: specialists.length,
				centerCount: centers.length,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const centerIdByName = new Map();

	const findExistingHospital = (name, aliases = []) => {
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		for (const candidate of candidates) {
			const row = tx
				.prepare(
					`SELECT id, slug, name, profile_type FROM profiles
           WHERE profile_type IN ('medical_hospital', 'nonprofit')
             AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (row?.id) return row;
			const aliasRow = tx
				.prepare(
					`SELECT p.id, p.slug, p.name, p.profile_type
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type IN ('medical_hospital', 'nonprofit')
             AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (aliasRow?.id) return aliasRow;
		}
		return null;
	};

	for (const c of centers) {
		const name = String(c.name || '').trim();
		if (!name) continue;
		const aliases = Array.isArray(c.aliases) ? c.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const existing = findExistingHospital(name, aliases);
		const profileType = existing?.profile_type === 'nonprofit' ? 'nonprofit' : 'medical_hospital';
		const slug = existing?.slug || makeProfileSlug(profileType, name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const country = c.country ? String(c.country).trim() : null;
		const city = c.hqCity ? String(c.hqCity).trim() : null;
		const state = c.hqState ? String(c.hqState).trim() : null;
		const category = String(c.category || 'hematology_center');
		const focus = c.focus ? String(c.focus).trim() : null;
		const summary =
			String(c.summary || '').trim() ||
			`${name} is a hematology / blood-disorder center${focus ? ` focused on ${focus}` : ''}.`;

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
						'hematology',
						'blood-disorder-center',
						category,
						'stem-cell-transplant',
					],
					hematologyFocus: focus || undefined,
					centerCategory: category,
					country: country || undefined,
					hqCity: city || undefined,
					hqState: state || undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed || existing) updatedCenters += 1;
		else createdCenters += 1;

		centerIdByName.set(name.toLowerCase(), prof.id);
		for (const al of [name, ...aliases]) {
			centerIdByName.set(al.toLowerCase(), prof.id);
			if (al.toLowerCase() === String(existing?.name || name).toLowerCase()) continue;
			addAlias({ profileId: prof.id, alias: al, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `hematology-center:${slug}`,
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

	for (const s of specialists) {
		const name = String(s.name || '').trim();
		if (!name) continue;
		const slug = makeProfileSlug('person', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const focus = s.focus ? String(s.focus).trim() : null;
		const institution = s.institution ? String(s.institution).trim() : null;
		const country = s.country ? String(s.country).trim() : null;
		const city = s.hqCity ? String(s.hqCity).trim() : null;
		const state = s.hqState ? String(s.hqState).trim() : null;
		const credentials = s.credentials ? String(s.credentials).trim() : null;
		const summary =
			String(s.summary || '').trim() ||
			`${name} is a hematologist / hematologist-oncologist${focus ? ` specializing in ${focus}` : ''}.`;

		const prof = upsertProfile(
			{
				profileType: 'person',
				name,
				slug,
				status: 'pinned',
				summary,
				metadata: {
					categoryTags: [
						'person',
						'hematology',
						'hematologist',
						'hematologist-oncologist',
						...(focus ? [focus.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')] : []),
					],
					specialty: 'hematology',
					hematologyFocus: focus || undefined,
					credentials: credentials || undefined,
					institution: institution || undefined,
					country: country || undefined,
					hqCity: city || undefined,
					hqState: state || undefined,
					occupation: credentials ? `Hematologist (${credentials})` : 'Hematologist',
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updatedPeople += 1;
		else createdPeople += 1;

		const aliases = Array.isArray(s.aliases) ? s.aliases : [];
		for (const al of aliases) {
			const alias = String(al || '').trim();
			if (!alias || alias.toLowerCase() === name.toLowerCase()) continue;
			addAlias({ profileId: prof.id, alias, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `hematology-specialist:${slug}`,
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
					role: 'associated',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		if (institution) {
			let orgId = centerIdByName.get(institution.toLowerCase());
			if (!orgId) {
				const found = findExistingHospital(institution, []);
				if (found?.id) orgId = String(found.id);
			}
			if (orgId) {
				upsertProfileLink(
					{
						fromProfileId: prof.id,
						toProfileId: orgId,
						relationType: 'affiliated_with',
						roleLabel: focus ? `Hematologist — ${focus}` : 'Hematologist',
						status: 'verified',
						confidence: 0.92,
						angle: 'academic_research',
						sourceCorpus: CORPUS,
						evidenceNote: `${name} affiliated with ${institution}.`,
					},
					tx,
				);
				links += 1;
			}
		}
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			specialists: specialists.length,
			centers: centers.length,
			createdPeople,
			updatedPeople,
			createdCenters,
			updatedCenters,
			links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
