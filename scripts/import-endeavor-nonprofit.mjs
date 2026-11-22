#!/usr/bin/env node
/**
 * Import Wikipedia "Endeavor (non-profit)" as a nonprofit profile + key people.
 * Source: .data/endeavor-nonprofit/endeavor.json
 * Usage: pnpm profiles:import-endeavor
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
	upsertTimelineEntry,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'endeavor-nonprofit-wikipedia';
const SOURCE_URL = 'https://en.wikipedia.org/wiki/Endeavor_(non-profit)';
const SEED_PATH = path.join(ROOT, '.data/endeavor-nonprofit/endeavor.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

let created = 0;
let updated = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'wikipedia:Endeavor_(non-profit)',
			sourceUrl: SOURCE_URL,
			title: seed.sourceTitle || 'Endeavor (non-profit)',
			excerpt: seed.summary || 'Endeavor non-profit import',
			metadata: { retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	// Distinct from existing firm:endeavor — use display name for slug clarity
	const orgName = String(seed.orgDisplayName || 'Endeavor (non-profit)').trim();
	const slug = makeProfileSlug('nonprofit', orgName);
	const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

	const org = upsertProfile(
		{
			profileType: 'nonprofit',
			name: orgName,
			slug,
			status: 'pinned',
			startDate: seed.founded || '1997',
			summary: seed.summary,
			metadata: {
				categoryTags: ['nonprofit', 'entrepreneurship', 'social-entrepreneurship'],
				shortName: seed.orgName || 'Endeavor',
				website: seed.website || 'https://endeavor.org/',
				founded: seed.founded || '1997',
				employees: seed.employees || undefined,
				areaServed: seed.areaServed || undefined,
				hqCity: seed.hqCity || undefined,
				hqCountry: seed.hqCountry || undefined,
				wikipediaUrl: SOURCE_URL,
				note: 'Distinct from firm:endeavor (separate entertainment/other entity card if present).',
				sourceRecordId: srId,
			},
			sourceCorpus: CORPUS,
		},
		tx,
	);
	if (existed) updated += 1;
	else created += 1;

	addAlias({ profileId: org.id, alias: 'Endeavor', aliasKind: 'name', sourceCorpus: CORPUS }, tx);
	addAlias({ profileId: org.id, alias: 'Endeavor Global', aliasKind: 'name', sourceCorpus: CORPUS }, tx);

	addIdentifier({ profileId: org.id, scheme: 'url', value: SOURCE_URL, sourceCorpus: CORPUS }, tx);
	addIdentifier({
		profileId: org.id,
		scheme: 'url',
		value: seed.website || 'https://endeavor.org/',
		sourceCorpus: CORPUS,
	}, tx);
	addIdentifier({
		profileId: org.id,
		scheme: 'source_id',
		value: 'endeavor-nonprofit',
		sourceCorpus: CORPUS,
	}, tx);

	const locRaw = [seed.hqCity, seed.hqState, seed.hqCountry].filter(Boolean).join(', ');
	const parts = parseAddressParts(locRaw || 'New York City, NY, United States');
	addLocation({
		profileId: org.id,
		raw: locRaw || 'New York City, New York, United States',
		city: parts.city || seed.hqCity || 'New York City',
		county: parts.county,
		state: parts.state || seed.hqState || 'NY',
		country: parts.country || seed.hqCountry || 'US',
		role: 'hq',
		sourceCorpus: CORPUS,
	}, tx);

	upsertTimelineEntry(
		{
			profileId: org.id,
			eventDate: seed.founded || '1997',
			datePrecision: 'year',
			title: 'Endeavor founded',
			summary: 'Linda Rottenberg and Peter Kellner founded Endeavor; first office opened in Buenos Aires, Argentina.',
			angle: 'financial',
			entryKind: 'milestone',
			sourceCorpus: CORPUS,
			sourceRecordId: srId,
			dedupeHint: `endeavor-founded:${seed.founded || '1997'}`,
		},
		tx,
	);

	for (const p of seed.people || []) {
		const name = String(p.name || '').trim();
		if (!name) continue;
		const personSlug = makeProfileSlug('person', name);
		const personExisted = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(personSlug));
		const role = p.role ? String(p.role).trim() : 'Endeavor affiliate';
		const person = upsertProfile(
			{
				profileType: 'person',
				name,
				slug: personSlug,
				status: 'pinned',
				summary: `${name} is ${role} of Endeavor (non-profit), the high-impact entrepreneurship organization founded in 1997.${p.notes ? ` ${p.notes}` : ''}`,
				metadata: {
					categoryTags: ['person', 'endeavor', 'entrepreneurship'],
					endeavorRole: role,
					wikipediaOrgUrl: SOURCE_URL,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		if (personExisted) updated += 1;
		else created += 1;

		if (Array.isArray(p.aliases)) {
			for (const al of p.aliases) {
				addAlias({ profileId: person.id, alias: String(al), sourceCorpus: CORPUS }, tx);
			}
		}
		addIdentifier({
			profileId: person.id,
			scheme: 'source_id',
			value: `endeavor-person:${person.slug.replace(/^person:/, '')}`,
			sourceCorpus: CORPUS,
		}, tx);

		upsertProfileLink(
			{
				fromProfileId: person.id,
				toProfileId: org.id,
				relationType: 'affiliated_with',
				roleLabel: role,
				status: 'verified',
				confidence: 0.95,
				angle: 'financial',
				sourceCorpus: CORPUS,
				evidenceNote: `Listed on Wikipedia Endeavor (non-profit) as ${role}.`,
			},
			tx,
		);
		links += 1;
	}
});

console.log(JSON.stringify({ ok: true, source: SOURCE_URL, created, updated, links, corpus: CORPUS }, null, 2));
