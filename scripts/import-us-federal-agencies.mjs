#!/usr/bin/env node
/**
 * Import agencies from Wikipedia "List of federal agencies in the United States"
 * as government profiles.
 *
 * Source seed: .data/us-federal-agencies/agencies.json
 * Usage: pnpm profiles:import-us-federal-agencies
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
	upsertProfileLink,
	upsertSourceRecord,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'us-federal-agencies-wikipedia';
const SOURCE_URL = 'https://en.wikipedia.org/wiki/List_of_federal_agencies_in_the_United_States';
const SEED_PATH = path.join(ROOT, '.data/us-federal-agencies/agencies.json');

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const agencies = Array.isArray(seed.agencies) ? seed.agencies : [];
if (!agencies.length) {
	console.error('No agencies in seed file', SEED_PATH);
	process.exit(1);
}

let created = 0;
let updated = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'wikipedia:List_of_federal_agencies_in_the_United_States',
			sourceUrl: SOURCE_URL,
			title: seed.sourceTitle || 'List of federal agencies in the United States',
			excerpt: `${agencies.length} U.S. federal agencies/offices imported as government profiles.`,
			metadata: {
				count: agencies.length,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByCanonical = new Map();

	for (const a of agencies) {
		const name = String(a.name || '').trim();
		if (!name) continue;
		const canonical = String(a.canonicalName || name).trim();
		const department = a.department ? String(a.department).trim() : null;
		const parentSection = a.parentSection ? String(a.parentSection).trim() : null;
		const branchPath = Array.isArray(a.branchPath) ? a.branchPath.map(String) : [];

		const slug = makeProfileSlug('government', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));

		const summaryParts = [
			`${canonical} is a United States federal government organization`,
			department && department !== canonical ? `listed under ${department}` : null,
			'on Wikipedia List of federal agencies in the United States',
		].filter(Boolean);

		const prof = upsertProfile(
			{
				profileType: 'government',
				name,
				slug,
				status: 'pinned',
				summary: `${summaryParts.join(' ')}.`,
				metadata: {
					categoryTags: ['government'],
					country: 'US',
					countryCodes: ['us'],
					jurisdiction: 'United States federal',
					department: department || undefined,
					parentSection: parentSection || undefined,
					branchPath: branchPath.length ? branchPath : undefined,
					canonicalName: canonical !== name ? canonical : undefined,
					wikipediaListUrl: SOURCE_URL,
					sourceRecordId: srId,
					listKind: a.kind || undefined,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updated += 1;
		else created += 1;

		idByCanonical.set(canonical.toLowerCase(), prof.id);
		idByCanonical.set(name.toLowerCase(), prof.id);

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
				value: `us-fed-agency:${prof.slug.replace(/^government:/, '')}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		const loc = parseAddressParts('United States');
		addLocation(
			{
				profileId: prof.id,
				raw: 'United States',
				city: null,
				county: null,
				state: null,
				country: loc.country || 'US',
				role: 'jurisdiction',
				sourceCorpus: CORPUS,
			},
			tx,
		);
	}

	// Link component agencies to their department profile when both exist
	for (const a of agencies) {
		const name = String(a.name || '').trim();
		const canonical = String(a.canonicalName || name).trim();
		const department = a.department ? String(a.department).trim() : null;
		if (!department || !name) continue;
		if (department.toLowerCase() === canonical.toLowerCase() || department.toLowerCase() === name.toLowerCase()) {
			continue;
		}
		const childId = idByCanonical.get(name.toLowerCase()) || idByCanonical.get(canonical.toLowerCase());
		const parentId = idByCanonical.get(department.toLowerCase());
		if (!childId || !parentId || childId === parentId) continue;
		upsertProfileLink(
			{
				fromProfileId: childId,
				toProfileId: parentId,
				relationType: 'affiliated_with',
				roleLabel: 'Component of',
				status: 'observed',
				confidence: 0.85,
				angle: 'policy',
				sourceCorpus: CORPUS,
				evidenceNote: `Listed under ${department} on Wikipedia List of federal agencies in the United States.`,
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
			source: SOURCE_URL,
			seedCount: agencies.length,
			created,
			updated,
			componentLinks: links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
