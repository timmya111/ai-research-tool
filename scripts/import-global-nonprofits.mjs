#!/usr/bin/env node
/**
 * Import curated global non-profits (INGOs, foundations, public-interest orgs).
 * Source: .data/global-nonprofits/organizations.json
 * Usage: pnpm profiles:import-global-nonprofits
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

const CORPUS = 'global-nonprofits-curated';
const SEED_PATH = path.join(ROOT, '.data/global-nonprofits/organizations.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const orgs = Array.isArray(seed.organizations) ? seed.organizations : [];

const CATEGORY_LABEL = {
	humanitarian_aid_development: 'Humanitarian Aid & International Development',
	global_health_medical: 'Global Health & Medical Relief',
	philanthropic_foundation: 'Major Global Philanthropic Foundations',
	human_rights_advocacy_peace: 'Human Rights, Advocacy & Peacebuilding',
	environment_science_culture_knowledge: 'Environment, Science, Culture & Open Knowledge',
};

let created = 0;
let updated = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:global-nonprofits',
			sourceUrl: null,
			title: 'Global non-profits (curated INGOs & foundations)',
			excerpt: `${orgs.length} global nonprofits / foundations imported.`,
			metadata: { count: orgs.length, retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByName = new Map();

	const findExistingByName = (name) => {
		const key = String(name || '').trim().toLowerCase();
		if (!key) return null;
		if (idByName.has(key)) return idByName.get(key);
		const row = tx
			.prepare(
				`SELECT id FROM profiles
         WHERE profile_type = 'nonprofit' AND name = ? COLLATE NOCASE
         LIMIT 1`,
			)
			.get(String(name).trim());
		return row?.id ? String(row.id) : null;
	};

	for (const o of orgs) {
		const name = String(o.name || '').trim();
		if (!name) continue;
		const profileType = 'nonprofit';
		const slug = makeProfileSlug(profileType, name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const category = String(o.category || 'nonprofit');
		const taxClass = o.taxClass ? String(o.taxClass) : null;
		const country = o.country ? String(o.country).trim() : null;
		const countries = Array.isArray(o.countries)
			? o.countries.map((c) => String(c).trim()).filter(Boolean)
			: country
				? [country]
				: [];

		const summary =
			String(o.summary || '').trim() ||
			`${name} is a global non-profit / public-interest organization.`;

		const prof = upsertProfile(
			{
				profileType,
				name,
				slug,
				status: 'pinned',
				summary,
				metadata: {
					categoryTags: [
						'nonprofit',
						'global-nonprofit',
						category,
						...(taxClass ? [taxClass.replace(/[()]/g, '')] : []),
					],
					nonprofitCategory: CATEGORY_LABEL[category] || category,
					taxClassification: taxClass || undefined,
					country: country || undefined,
					countries: countries.length ? countries : undefined,
					hqCity: o.hqCity || undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;
		idByName.set(name.toLowerCase(), prof.id);

		if (Array.isArray(o.aliases)) {
			for (const al of o.aliases) {
				const alias = String(al || '').trim();
				if (!alias || alias.toLowerCase() === name.toLowerCase()) continue;
				addAlias({ profileId: prof.id, alias, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `global-nonprofit:${prof.slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (country || o.hqCity) {
			const locRaw = [o.hqCity, country].filter(Boolean).join(', ');
			const parts = parseAddressParts(locRaw);
			addLocation(
				{
					profileId: prof.id,
					raw: locRaw,
					city: parts.city || o.hqCity || null,
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

	const linkRelated = (fromId, toId, roleLabel, evidenceNote) => {
		if (!fromId || !toId || fromId === toId) return;
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: 'affiliated_with',
				roleLabel: roleLabel || 'Related organization',
				status: 'verified',
				confidence: 0.9,
				angle: 'financial',
				sourceCorpus: CORPUS,
				evidenceNote,
			},
			tx,
		);
		links += 1;
	};

	for (const o of orgs) {
		const name = String(o.name || '').trim();
		const fromId = idByName.get(name.toLowerCase());
		if (!fromId || !o.relatedTo) continue;
		const peerId = findExistingByName(o.relatedTo);
		if (peerId) {
			linkRelated(
				fromId,
				peerId,
				o.relationRole || 'Related organization',
				`${name} related to ${o.relatedTo}.`,
			);
		}
	}

	// Movement ↔ ICRC if present
	const movementId = idByName.get('international red cross and red crescent movement');
	const icrc = tx
		.prepare(
			`SELECT id FROM profiles WHERE slug = 'nonprofit:international-committee-of-the-red-cross-icrc' LIMIT 1`,
		)
		.get();
	if (movementId && icrc?.id) {
		linkRelated(
			String(icrc.id),
			movementId,
			'Component of Red Cross and Red Crescent Movement',
			'ICRC is a core component of the International Red Cross and Red Crescent Movement.',
		);
	}

	// MSF international ↔ Doctors Without Borders USA if present
	const msfId = idByName.get('médecins sans frontières');
	const msfUsa = tx
		.prepare(`SELECT id FROM profiles WHERE slug = 'nonprofit:doctors-without-borders-usa' LIMIT 1`)
		.get();
	if (msfId && msfUsa?.id) {
		linkRelated(
			String(msfUsa.id),
			msfId,
			'U.S. section of Médecins Sans Frontières',
			'Doctors Without Borders USA is the U.S. section of MSF.',
		);
	}

	// Keep INGKA ownership edge if firm exists
	const ingkaFound = idByName.get('stichting ingka foundation');
	const ingkaHold = tx
		.prepare(`SELECT id FROM profiles WHERE slug = 'firm:ingka-holding-b-v' LIMIT 1`)
		.get();
	if (ingkaFound && ingkaHold?.id) {
		upsertProfileLink(
			{
				fromProfileId: String(ingkaHold.id),
				toProfileId: ingkaFound,
				relationType: 'owned_by',
				roleLabel: 'Owned by non-profit foundation',
				status: 'verified',
				confidence: 0.95,
				angle: 'financial',
				sourceCorpus: CORPUS,
				evidenceNote: 'INGKA Holding B.V. is owned by Stichting INGKA Foundation.',
			},
			tx,
		);
		links += 1;
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			seedCount: orgs.length,
			created,
			updated,
			links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
