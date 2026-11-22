#!/usr/bin/env node
/**
 * Import curated major non-profit organizations as nonprofit (and related firm) profiles.
 * Source: .data/major-nonprofits/organizations.json
 * Usage: pnpm profiles:import-major-nonprofits
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

const CORPUS = 'major-nonprofits-curated';
const SEED_PATH = path.join(ROOT, '.data/major-nonprofits/organizations.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const orgs = Array.isArray(seed.organizations) ? seed.organizations : [];

const CATEGORY_LABEL = {
	charity_humanitarian: 'Major Charities & Humanitarian',
	healthcare_system: 'Healthcare Systems',
	research_tech_cultural_advocacy: 'Research, Technology, Cultural & Advocacy',
	foundation_owner: 'Non-profit Foundation Owner',
	commercial_brand_owned_by_nonprofit: 'Commercial Brand Owned by Non-profit',
};

let created = 0;
let updated = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:major-nonprofits',
			sourceUrl: null,
			title: 'Major non-profit organizations (curated)',
			excerpt: `${orgs.length} major nonprofits / foundation-owned brands imported.`,
			metadata: { count: orgs.length, retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByName = new Map();

	for (const o of orgs) {
		const name = String(o.name || '').trim();
		if (!name) continue;
		const profileType = o.profileType === 'firm' ? 'firm' : 'nonprofit';
		const slug = makeProfileSlug(profileType, name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const category = String(o.category || 'nonprofit');
		const taxClass = o.taxClass ? String(o.taxClass) : null;
		const country = o.country ? String(o.country).trim() : null;

		const summary =
			String(o.summary || '').trim() ||
			`${name} is a ${profileType === 'nonprofit' ? 'non-profit organization' : 'commercial entity related to a non-profit foundation'}.`;

		const prof = upsertProfile(
			{
				profileType,
				name,
				slug,
				status: 'pinned',
				summary,
				metadata: {
					categoryTags: [
						profileType,
						'major-nonprofit',
						category,
						...(taxClass ? [taxClass.replace(/[()]/g, '')] : []),
					],
					nonprofitCategory: CATEGORY_LABEL[category] || category,
					taxClassification: taxClass || undefined,
					country: country || undefined,
					hqCity: o.hqCity || undefined,
					hqState: o.hqState || undefined,
					ownsCommercialBrand: o.ownsCommercialBrand || undefined,
					ownedByNonprofit: o.ownedByNonprofit || undefined,
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
				addAlias({ profileId: prof.id, alias: String(al), sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier({
			profileId: prof.id,
			scheme: 'source_id',
			value: `major-nonprofit:${prof.slug}`,
			sourceCorpus: CORPUS,
		}, tx);

		if (country || o.hqCity) {
			const locRaw = [o.hqCity, o.hqState, country].filter(Boolean).join(', ');
			const parts = parseAddressParts(locRaw);
			addLocation({
				profileId: prof.id,
				raw: locRaw,
				city: parts.city || o.hqCity || null,
				county: parts.county,
				state: parts.state || o.hqState || null,
				country: parts.country || country || null,
				role: 'hq',
				sourceCorpus: CORPUS,
			}, tx);
		}
	}

	// Ownership / related links
	for (const o of orgs) {
		const name = String(o.name || '').trim();
		const fromId = idByName.get(name.toLowerCase());
		if (!fromId) continue;

		if (o.ownedByNonprofit) {
			const ownerId = idByName.get(String(o.ownedByNonprofit).toLowerCase());
			if (ownerId) {
				upsertProfileLink(
					{
						fromProfileId: fromId,
						toProfileId: ownerId,
						relationType: 'owned_by',
						roleLabel: 'Owned by non-profit foundation',
						status: 'verified',
						confidence: 0.95,
						angle: 'financial',
						sourceCorpus: CORPUS,
						evidenceNote: `${name} is owned by ${o.ownedByNonprofit}.`,
					},
					tx,
				);
				links += 1;
			}
		}

		if (o.ownsCommercialBrand) {
			const brandId = idByName.get(String(o.ownsCommercialBrand).toLowerCase());
			if (brandId) {
				upsertProfileLink(
					{
						fromProfileId: brandId,
						toProfileId: fromId,
						relationType: 'owned_by',
						roleLabel: 'Owned by non-profit foundation',
						status: 'verified',
						confidence: 0.95,
						angle: 'financial',
						sourceCorpus: CORPUS,
						evidenceNote: `${o.ownsCommercialBrand} is owned by ${name}.`,
					},
					tx,
				);
				links += 1;
			}
		}

		if (o.relatedTo) {
			const peerId = idByName.get(String(o.relatedTo).toLowerCase());
			if (peerId) {
				upsertProfileLink(
					{
						fromProfileId: fromId,
						toProfileId: peerId,
						relationType: 'affiliated_with',
						roleLabel: o.relationRole || 'Related organization',
						status: 'verified',
						confidence: 0.92,
						angle: 'financial',
						sourceCorpus: CORPUS,
						evidenceNote: `${name} related to ${o.relatedTo}.`,
					},
					tx,
				);
				links += 1;
			}
		}
	}

	// Link Mozilla Foundation → Mozilla Corporation if firm already exists
	const mozFound = idByName.get('mozilla foundation');
	const mozCorp = tx
		.prepare(`SELECT id FROM profiles WHERE slug = 'firm:mozilla-corporation' LIMIT 1`)
		.get();
	if (mozFound && mozCorp?.id) {
		upsertProfileLink(
			{
				fromProfileId: String(mozCorp.id),
				toProfileId: mozFound,
				relationType: 'owned_by',
				roleLabel: 'For-profit subsidiary of Mozilla Foundation',
				status: 'verified',
				confidence: 0.95,
				angle: 'financial',
				sourceCorpus: CORPUS,
				evidenceNote: 'Mozilla Corporation is the for-profit subsidiary overseen by Mozilla Foundation.',
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
