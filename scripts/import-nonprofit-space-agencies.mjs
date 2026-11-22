#!/usr/bin/env node
/**
 * Import Wikipedia "List of non-profit space agencies" as nonprofit profiles.
 * Source seed: .data/nonprofit-space-agencies/agencies.json
 * Usage: pnpm profiles:import-nonprofit-space-agencies
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

const CORPUS = 'nonprofit-space-agencies-wikipedia';
const SOURCE_URL = 'https://en.wikipedia.org/wiki/List_of_non-profit_space_agencies';
const SEED_PATH = path.join(ROOT, '.data/nonprofit-space-agencies/agencies.json');

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const agencies = Array.isArray(seed.agencies) ? seed.agencies : [];
if (!agencies.length) {
	console.error('No agencies in seed', SEED_PATH);
	process.exit(1);
}

let created = 0;
let updated = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'wikipedia:List_of_non-profit_space_agencies',
			sourceUrl: SOURCE_URL,
			title: seed.sourceTitle || 'List of non-profit space agencies',
			excerpt: `${agencies.length} non-profit space agencies imported as nonprofit profiles.`,
			metadata: { count: agencies.length, retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByName = new Map();

	for (const a of agencies) {
		const name = String(a.name || '').trim();
		if (!name) continue;
		const country = a.country ? String(a.country).trim() : null;
		const website = a.website ? String(a.website).trim() : null;
		const relatedUniversity = a.relatedUniversity ? String(a.relatedUniversity).trim() : null;

		const slug = makeProfileSlug('nonprofit', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

		const summary = [
			`${name} is a non-profit space agency/organization`,
			country ? `based in ${country}` : null,
			'(listed on Wikipedia List of non-profit space agencies)',
		]
			.filter(Boolean)
			.join(' ');

		const prof = upsertProfile(
			{
				profileType: 'nonprofit',
				name,
				slug,
				status: 'pinned',
				summary: `${summary}.`,
				metadata: {
					categoryTags: ['nonprofit', 'space', 'space-agency'],
					country: country || undefined,
					website: website || undefined,
					relatedUniversity: relatedUniversity || undefined,
					wikipediaListUrl: SOURCE_URL,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;
		idByName.set(name.toLowerCase(), prof.id);

		if (Array.isArray(a.aliases)) {
			for (const al of a.aliases) {
				addAlias({ profileId: prof.id, alias: String(al), sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier({
			profileId: prof.id,
			scheme: 'url',
			value: SOURCE_URL,
			sourceCorpus: CORPUS,
		}, tx);
		addIdentifier({
			profileId: prof.id,
			scheme: 'source_id',
			value: `nonprofit-space:${prof.slug.replace(/^nonprofit:/, '')}`,
			sourceCorpus: CORPUS,
		}, tx);
		if (website) {
			addIdentifier({
				profileId: prof.id,
				scheme: 'url',
				value: website,
				sourceCorpus: CORPUS,
			}, tx);
		}

		if (country) {
			const parts = parseAddressParts(country);
			addLocation({
				profileId: prof.id,
				raw: country,
				city: parts.city,
				county: parts.county,
				state: parts.state,
				country: parts.country || country,
				role: 'hq',
				sourceCorpus: CORPUS,
			}, tx);
		}

		if (relatedUniversity) {
			const uniSlug = makeProfileSlug('education', relatedUniversity);
			const uniExisted = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(uniSlug));
			const uni = upsertProfile(
				{
					profileType: 'education',
					name: relatedUniversity,
					slug: uniSlug,
					status: 'pinned',
					summary: `${relatedUniversity} is associated with non-profit space organization ${name} (Wikipedia List of non-profit space agencies).`,
					metadata: {
						categoryTags: ['education', 'space'],
						wikipediaListUrl: SOURCE_URL,
						sourceRecordId: srId,
					},
					sourceCorpus: CORPUS,
				},
				tx,
			);
			if (uniExisted) updated += 1;
			else created += 1;
			upsertProfileLink(
				{
					fromProfileId: prof.id,
					toProfileId: uni.id,
					relationType: 'affiliated_with',
					roleLabel: 'University affiliation',
					status: 'observed',
					confidence: 0.9,
					angle: 'academic_research',
					sourceCorpus: CORPUS,
					evidenceNote: `Listed with ${relatedUniversity} on Wikipedia List of non-profit space agencies.`,
				},
				tx,
			);
			links += 1;
		}
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			source: SOURCE_URL,
			seedCount: agencies.length,
			created,
			updated,
			links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
