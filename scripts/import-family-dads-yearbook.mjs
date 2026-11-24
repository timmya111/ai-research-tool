#!/usr/bin/env node
/**
 * Import Murray College yearbook name/hometown directory + related Family/dads leads.
 *
 *   node scripts/import-family-dads-yearbook.mjs
 *   node scripts/import-family-dads-yearbook.mjs --dry-run
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const DATA_PATH = process.argv.find((a) => a.startsWith('--data='))?.slice(7) || '/tmp/dads_yearbook_people.json';

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
	addLocation,
	upsertProfileLink,
	upsertSourceRecord,
	getProfile,
	updateProfileFields,
	touchProfilesForUserAction,
} = await import('../src/lib/research/profiles/store.ts');

const CORPUS = 'family-dads-murray-yearbook';
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const NOW = new Date().toISOString();

function slugifyPart(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

function personSlug(name, city) {
	const base = slugifyPart(name);
	const loc = slugifyPart(city || '');
	return loc ? `${base}-${loc}` : base;
}

function yearbookSummary(entry) {
	const loc = entry.location?.raw || 'hometown not stated';
	return (
		`Listed in a Murray College (Tishomingo, Oklahoma) yearbook student directory as from ${loc}. ` +
		`Source: Research Drive \`${entry.sourcePath || entry.page}\` (Family/dads).`
	);
}

const stats = {
	orgs: 0,
	peopleCreated: 0,
	peopleUpdated: 0,
	specialUpdated: 0,
	links: 0,
	extras: 0,
	skipped: 0,
};

if (DRY) {
	console.log(
		JSON.stringify(
			{
				dryRun: true,
				people: data.people?.length,
				orgs: data.orgs?.length,
				extras: data.extra?.length,
			},
			null,
			2,
		),
	);
	process.exit(0);
}

withProfilesTransaction((tx) => {
	tx.exec('PRAGMA busy_timeout = 60000');

	upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'research-drive:Family/dads:murray-yearbook',
			sourceUrl: null,
			title: 'Family/dads Murray College yearbook directory + Goodland leads',
			excerpt: `${data.people?.length || 0} student name/hometown pairs from Murray College yearbook pages in Research Drive Family/dads.`,
			metadata: {
				folder: 'Family/dads',
				importedAt: NOW,
				people: data.people?.length || 0,
			},
		},
		tx,
	);

	const orgIds = {};
	for (const org of data.orgs || []) {
		const existing = tx
			.prepare(
				`SELECT id, slug FROM profiles WHERE profile_type = ? AND name = ? COLLATE NOCASE LIMIT 1`,
			)
			.get(org.type, org.name);
		const profile = upsertProfile(
			{
				profileType: org.type,
				name: org.name,
				slug: existing?.slug?.split(':')[1] || slugifyPart(org.name),
				status: 'pinned',
				summary: org.summary || '',
				metadata: {
					corpora: [CORPUS, 'manual'],
					researchDriveSources: ['Family/dads'],
					userTouchedAt: NOW,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		orgIds[org.name] = profile.id;
		for (const a of org.aliases || []) {
			addAlias({ profileId: profile.id, alias: a, aliasKind: 'other_name', sourceCorpus: CORPUS }, tx);
		}
		if (org.location?.raw) {
			addLocation(
				{
					profileId: profile.id,
					raw: org.location.raw,
					city: org.location.city || null,
					state: org.location.state || null,
					country: org.location.country || 'US',
					role: 'headquarters',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
		stats.orgs += 1;
	}

	const murrayId = orgIds['Murray State College'];
	const goodlandId = orgIds['Goodland Academy'];

	/** Special merges into existing family cards */
	const SPECIAL = [
		{
			matchName: 'Allen Farrell',
			keepSlug: 'person:allen-farrell',
			entry: data.people.find(
				(p) => p.name === 'Allen Farrell' && /bokchito/i.test(p.location?.raw || ''),
			),
		},
		{
			matchName: 'Bennie Adams',
			keepSlug: 'person:bennie-clinton-adams',
			entry: data.people.find(
				(p) => p.name === 'Bennie Adams' && /bokchito/i.test(p.location?.raw || ''),
			),
		},
	];

	const skipKeys = new Set();
	for (const sp of SPECIAL) {
		if (!sp.entry) continue;
		const keep = getProfile(sp.keepSlug, tx);
		if (!keep) continue;
		const loc = sp.entry.location;
		const yb = yearbookSummary(sp.entry);
		const summary = keep.summary?.includes('Murray College')
			? keep.summary
			: `${keep.summary || ''}\n\n${yb}`.trim();
		updateProfileFields(
			keep.id,
			{
				summary,
				metadata: {
					...keep.metadata,
					corpora: [
						...new Set([
							...(Array.isArray(keep.metadata?.corpora) ? keep.metadata.corpora.map(String) : []),
							CORPUS,
							'manual',
						]),
					],
					researchDriveSources: [
						...new Set([
							...(Array.isArray(keep.metadata?.researchDriveSources)
								? keep.metadata.researchDriveSources.map(String)
								: []),
							sp.entry.sourcePath,
						]),
					],
					murrayCollegeHometown: loc?.raw || null,
					userTouchedAt: NOW,
				},
			},
			tx,
		);
		if (loc?.raw) {
			addLocation(
				{
					profileId: keep.id,
					raw: loc.raw,
					city: loc.city || null,
					state: loc.state || null,
					country: loc.country || 'US',
					role: 'associated',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
		if (sp.entry.ocrName && sp.entry.ocrName !== keep.name) {
			addAlias(
				{ profileId: keep.id, alias: sp.entry.ocrName, aliasKind: 'other_name', sourceCorpus: CORPUS },
				tx,
			);
		}
		if (sp.matchName !== keep.name) {
			addAlias(
				{ profileId: keep.id, alias: sp.matchName, aliasKind: 'other_name', sourceCorpus: CORPUS },
				tx,
			);
		}
		if (murrayId) {
			upsertProfileLink(
				{
					fromProfileId: keep.id,
					toProfileId: murrayId,
					relationType: 'alumni_or_faculty',
					roleLabel: 'student (yearbook directory)',
					status: 'observed',
					confidence: 0.85,
					sourceCorpus: CORPUS,
					evidenceNote: `Murray College yearbook directory; ${sp.entry.sourcePath}`,
				},
				tx,
			);
			stats.links += 1;
		}
		touchProfilesForUserAction([keep.id], tx);
		skipKeys.add(`${sp.entry.name.toLowerCase()}|${(sp.entry.location?.raw || '').toLowerCase()}`);
		stats.specialUpdated += 1;
	}

	for (const entry of data.people || []) {
		const key = `${entry.name.toLowerCase()}|${(entry.location?.raw || '').toLowerCase()}`;
		if (skipKeys.has(key)) {
			stats.skipped += 1;
			continue;
		}
		const city = entry.location?.city || '';
		const slugTail = personSlug(entry.name, city);
		const existing = getProfile(`person:${slugTail}`, tx);
		const profile = upsertProfile(
			{
				profileType: 'person',
				name: entry.name,
				slug: slugTail,
				status: 'pinned',
				summary: yearbookSummary(entry),
				metadata: {
					corpora: [CORPUS, 'manual'],
					researchDriveSources: [entry.sourcePath],
					murrayCollegeHometown: entry.location?.raw || null,
					yearbookPage: entry.page || null,
					userTouchedAt: NOW,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		if (existing) stats.peopleUpdated += 1;
		else stats.peopleCreated += 1;

		if (entry.ocrName && entry.ocrName.toLowerCase() !== entry.name.toLowerCase()) {
			addAlias(
				{ profileId: profile.id, alias: entry.ocrName, aliasKind: 'other_name', sourceCorpus: CORPUS },
				tx,
			);
		}
		if (entry.location?.raw) {
			addLocation(
				{
					profileId: profile.id,
					raw: entry.location.raw,
					city: entry.location.city || null,
					state: entry.location.state || null,
					country: entry.location.country || 'US',
					role: 'associated',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
		if (murrayId) {
			upsertProfileLink(
				{
					fromProfileId: profile.id,
					toProfileId: murrayId,
					relationType: 'alumni_or_faculty',
					roleLabel: 'student (yearbook directory)',
					status: 'observed',
					confidence: 0.8,
					sourceCorpus: CORPUS,
					evidenceNote: `Murray College yearbook directory; ${entry.sourcePath}`,
				},
				tx,
			);
			stats.links += 1;
		}
	}

	for (const ex of data.extra || []) {
		const slugTail = personSlug(ex.name, ex.location?.city || ex.kind || 'family');
		const profile = upsertProfile(
			{
				profileType: 'person',
				name: ex.name,
				slug: slugTail,
				status: 'pinned',
				summary: `${ex.role} Source: Research Drive \`${ex.sourcePath}\`.`,
				metadata: {
					corpora: [CORPUS, 'manual'],
					researchDriveSources: [ex.sourcePath],
					userTouchedAt: NOW,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);
		if (ex.location?.raw) {
			addLocation(
				{
					profileId: profile.id,
					raw: ex.location.raw,
					city: ex.location.city || null,
					state: ex.location.state || null,
					country: ex.location.country || 'US',
					role: 'associated',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}
		if (ex.kind === 'goodland' && goodlandId) {
			upsertProfileLink(
				{
					fromProfileId: profile.id,
					toProfileId: goodlandId,
					relationType: 'alumni_or_faculty',
					roleLabel: 'Goodland association',
					status: 'observed',
					confidence: 0.75,
					sourceCorpus: CORPUS,
					evidenceNote: ex.role,
				},
				tx,
			);
			stats.links += 1;
		}
		stats.extras += 1;
	}
});

console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
