#!/usr/bin/env node
/**
 * Import Association for Cultural Economics International (ACEI) people and
 * universities/host institutions from Wikipedia into profiles.
 *
 * Source seed: .data/acei/acei.json
 * Usage: pnpm profiles:import-acei
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

const CORPUS = 'acei-wikipedia';
const SOURCE_URL = 'https://en.wikipedia.org/wiki/Association_for_Cultural_Economics_International';
const SEED_PATH = path.join(ROOT, '.data/acei/acei.json');

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const institutions = Array.isArray(seed.institutions) ? seed.institutions : [];

let created = 0;
let updated = 0;
let links = 0;

function bump(existed) {
	if (existed) updated += 1;
	else created += 1;
}

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'wikipedia:Association_for_Cultural_Economics_International',
			sourceUrl: SOURCE_URL,
			title: seed.sourceTitle || 'Association for Cultural Economics International',
			excerpt: `ACEI import: ${people.length} people, ${institutions.length} institutions.`,
			metadata: { people: people.length, institutions: institutions.length, retrievedAt: seed.retrievedAt || null },
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByName = new Map();

	// 1) ACEI organization
	const aceiSlug = makeProfileSlug('nonprofit', seed.orgName || 'Association for Cultural Economics International');
	const aceiExisted = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(aceiSlug));
	const acei = upsertProfile(
		{
			profileType: 'nonprofit',
			name: seed.orgName || 'Association for Cultural Economics International',
			slug: aceiSlug,
			status: 'pinned',
			summary:
				seed.orgSummary ||
				'International association promoting scholarly research into the economics of the arts and cultural activities.',
			metadata: {
				categoryTags: ['nonprofit', 'economics', 'cultural-economics'],
				acronym: seed.orgAcronym || 'ACEI',
				wikipediaUrl: SOURCE_URL,
				website: 'https://culturaleconomics.org/',
				sourceRecordId: srId,
			},
			sourceCorpus: CORPUS,
		},
		tx,
	);
	bump(aceiExisted);
	idByName.set(acei.name.toLowerCase(), acei.id);
	idByName.set('acei', acei.id);
	addAlias({ profileId: acei.id, alias: 'ACEI', aliasKind: 'acronym', sourceCorpus: CORPUS }, tx);
	addAlias(
		{ profileId: acei.id, alias: 'Association for Cultural Economics', aliasKind: 'former_name', sourceCorpus: CORPUS },
		tx,
	);
	addIdentifier({ profileId: acei.id, scheme: 'url', value: SOURCE_URL, sourceCorpus: CORPUS }, tx);
	addIdentifier({
		profileId: acei.id,
		scheme: 'url',
		value: 'https://culturaleconomics.org/',
		sourceCorpus: CORPUS,
	}, tx);

	// 2) Institutions (universities / host orgs)
	for (const inst of institutions) {
		const name = String(inst.name || '').trim();
		if (!name) continue;
		const profileType = inst.profileType === 'nonprofit' ? 'nonprofit' : 'education';
		const slug = makeProfileSlug(profileType, name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const prof = upsertProfile(
			{
				profileType,
				name,
				slug,
				status: 'pinned',
				summary:
					profileType === 'education'
						? `${name} is a university/host institution associated with ACEI workshops, conferences, or presidential affiliations (Wikipedia ACEI page).`
						: `${name} is an organization associated with ACEI workshops or related cultural-economics activity (Wikipedia ACEI page).`,
				metadata: {
					categoryTags: [profileType, 'acei'],
					wikipediaListUrl: SOURCE_URL,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		bump(existed);
		idByName.set(name.toLowerCase(), prof.id);
		addIdentifier({
			profileId: prof.id,
			scheme: 'source_id',
			value: `acei-institution:${prof.slug}`,
			sourceCorpus: CORPUS,
		}, tx);
	}

	// 3) People
	for (const p of people) {
		const name = String(p.name || '').trim();
		if (!name) continue;
		const slug = makeProfileSlug('person', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const affiliation = p.affiliation ? String(p.affiliation).trim() : null;
		const country = p.country ? String(p.country).trim() : null;
		const role = p.role ? String(p.role).trim() : null;
		const presidency = p.aceiPresidency || null;

		const summaryBits = [
			`${name} is associated with the Association for Cultural Economics International (ACEI)`,
			role ? `as ${role}` : null,
			affiliation ? `affiliated with ${affiliation}` : null,
			country ? `(${country})` : null,
			p.notes ? `— ${p.notes}` : null,
		].filter(Boolean);

		const prof = upsertProfile(
			{
				profileType: 'person',
				name,
				slug,
				status: 'pinned',
				summary: `${summaryBits.join(' ')}.`,
				metadata: {
					categoryTags: ['person', 'acei', 'cultural-economics'],
					country: country || undefined,
					affiliation: affiliation || undefined,
					aceiRole: role || undefined,
					aceiPresidency: presidency || undefined,
					wikipediaListUrl: SOURCE_URL,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		bump(existed);
		idByName.set(name.toLowerCase(), prof.id);

		if (Array.isArray(p.aliases)) {
			for (const al of p.aliases) {
				addAlias({ profileId: prof.id, alias: String(al), sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier({
			profileId: prof.id,
			scheme: 'source_id',
			value: `acei-person:${prof.slug.replace(/^person:/, '')}`,
			sourceCorpus: CORPUS,
		}, tx);

		if (country) {
			const parts = parseAddressParts(country);
			addLocation({
				profileId: prof.id,
				raw: country,
				city: parts.city,
				county: parts.county,
				state: parts.state,
				country: parts.country || country,
				role: 'associated',
				sourceCorpus: CORPUS,
			}, tx);
		}

		// Link person → ACEI
		upsertProfileLink(
			{
				fromProfileId: prof.id,
				toProfileId: acei.id,
				relationType: 'affiliated_with',
				roleLabel: role || 'ACEI affiliate',
				startDate: presidency?.start || p.startDate || null,
				endDate: presidency?.end || p.endDate || null,
				status: 'verified',
				confidence: 0.92,
				angle: 'academic_research',
				sourceCorpus: CORPUS,
				evidenceNote: `Listed on Wikipedia ACEI page (${role || 'member/affiliate'}).`,
			},
			tx,
		);
		links += 1;

		// Link person → university
		if (affiliation) {
			const uniId = idByName.get(affiliation.toLowerCase());
			if (uniId) {
				upsertProfileLink(
					{
						fromProfileId: prof.id,
						toProfileId: uniId,
						relationType: 'alumni_or_faculty',
						roleLabel: 'Faculty / affiliation',
						status: 'observed',
						confidence: 0.88,
						angle: 'academic_research',
						sourceCorpus: CORPUS,
						evidenceNote: `Affiliation listed on Wikipedia ACEI presidents/founders table: ${affiliation}.`,
					},
					tx,
				);
				links += 1;
			}
		}

		// Presidency timeline
		if (presidency?.start) {
			upsertTimelineEntry(
				{
					profileId: prof.id,
					eventDate: presidency.start,
					datePrecision: 'year',
					endDate: presidency.end || null,
					title: `ACEI President (${presidency.period || presidency.start})`,
					summary: `${name} served as President of the Association for Cultural Economics International.`,
					angle: 'academic_research',
					entryKind: 'milestone',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `acei-president:${prof.id}:${presidency.start}`,
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
			source: SOURCE_URL,
			people: people.length,
			institutions: institutions.length,
			created,
			updated,
			links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
