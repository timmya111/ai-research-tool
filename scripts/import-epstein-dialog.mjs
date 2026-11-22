#!/usr/bin/env node
/**
 * Import curated Epstein Files (2024–2026) and Dialog Society (2026 leak) people
 * plus historic-event cards. Appearance ≠ wrongdoing / confirmed attendance.
 * Source: .data/epstein-dialog/entities.json
 * Usage: pnpm profiles:import-epstein-dialog
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
	upsertProfileLink,
	upsertSourceRecord,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'epstein-dialog-curated';
const SEED_PATH = path.join(ROOT, '.data/epstein-dialog/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const events = Array.isArray(seed.events) ? seed.events : [];

const LIST_LABEL = {
	epstein_files: 'Epstein Files (2024–2026)',
	dialog: 'Dialog Society (2026 leak)',
};

const CATEGORY_LABEL = {
	central_figure: 'Central figure',
	convicted_or_accused: 'Convicted or directly accused associate',
	royalty_politics_government: 'Royalty, politics & government',
	business_finance_tech: 'Business, finance & tech',
	entertainment_media_academia_staff: 'Entertainment, media, academia & staff',
	dialog_government_politics_law: 'Dialog — government, politics & law',
	dialog_technology_ai: 'Dialog — technology & AI',
	dialog_finance_vc_business: 'Dialog — finance, VC & business',
	dialog_media_entertainment_academia: 'Dialog — media, entertainment & academia',
	dialog_founder: 'Dialog co-founder',
};

let createdPeople = 0;
let updatedPeople = 0;
let createdEvents = 0;
let updatedEvents = 0;
let links = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:epstein-files-dialog-2026',
			sourceUrl: null,
			title: 'Epstein Files & Dialog Society (curated name lists)',
			excerpt: `${people.length} people across Epstein file releases and Dialog leak materials.`,
			metadata: {
				peopleCount: people.length,
				eventCount: events.length,
				disclaimer: seed.disclaimer || null,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const eventIdByList = new Map();

	for (const ev of events) {
		const name = String(ev.name || '').trim();
		if (!name) continue;
		const slug = makeProfileSlug('historic_event', ev.slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const listKey = String(ev.listKey || '').trim();
		const summary = String(ev.summary || '').trim();

		const prof = upsertProfile(
			{
				profileType: 'historic_event',
				name,
				slug,
				status: 'pinned',
				startDate: ev.startDate || null,
				endDate: ev.endDate || null,
				summary,
				metadata: {
					categoryTags: [
						'historic_event',
						'disclosure',
						listKey || 'curated-list',
						...(listKey === 'epstein_files' ? ['epstein-files', 'court-records', 'doj'] : []),
						...(listKey === 'dialog' ? ['dialog', 'elite-retreat', 'thiel'] : []),
					],
					listKey: listKey || undefined,
					disclaimer: seed.disclaimer || undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed) updatedEvents += 1;
		else createdEvents += 1;
		if (listKey) eventIdByList.set(listKey, prof.id);

		if (Array.isArray(ev.aliases)) {
			for (const al of ev.aliases) {
				const alias = String(al || '').trim();
				if (!alias || alias.toLowerCase() === name.toLowerCase()) continue;
				addAlias({ profileId: prof.id, alias, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
			}
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `epstein-dialog-event:${listKey || slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);
	}

	const findExistingPerson = (name, aliases = []) => {
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		for (const candidate of candidates) {
			const byName = tx
				.prepare(
					`SELECT id, slug, name FROM profiles
           WHERE profile_type = 'person' AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (byName?.id) return byName;
			const byAlias = tx
				.prepare(
					`SELECT p.id, p.slug, p.name
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = 'person' AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(candidate);
			if (byAlias?.id) return byAlias;
		}
		return null;
	};

	for (const p of people) {
		const name = String(p.name || '').trim();
		if (!name) continue;
		const aliases = Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const existing = findExistingPerson(name, aliases);
		const slug = existing?.slug || makeProfileSlug('person', name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const lists = Array.isArray(p.lists) ? p.lists.map(String) : [];
		const category = String(p.category || 'named_in_disclosure');
		const note = String(p.note || '').trim();
		const listLabels = lists.map((L) => LIST_LABEL[L] || L).filter(Boolean);
		const summaryParts = [
			note || null,
			listLabels.length
				? `Named in curated research list(s): ${listLabels.join('; ')}.`
				: null,
			seed.disclaimer ||
				'Appearance in these disclosures does not imply criminal wrongdoing or confirmed attendance.',
		].filter(Boolean);

		const prof = upsertProfile(
			{
				profileType: 'person',
				name: existing?.name || name,
				slug,
				status: 'pinned',
				endDate: p.deceased ? p.endDate || undefined : undefined,
				summary: summaryParts.join(' '),
				metadata: {
					categoryTags: [
						'person',
						'disclosure-list',
						...lists,
						category,
						...(lists.includes('epstein_files') ? ['epstein-files'] : []),
						...(lists.includes('dialog') ? ['dialog'] : []),
					],
					disclosureLists: lists,
					disclosureCategory: CATEGORY_LABEL[category] || category,
					disclosureNote: note || undefined,
					disclaimer: seed.disclaimer || undefined,
					deceased: p.deceased ? true : undefined,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed || existing) updatedPeople += 1;
		else createdPeople += 1;

		for (const al of aliases) {
			if (al.toLowerCase() === String(existing?.name || name).toLowerCase()) continue;
			addAlias({ profileId: prof.id, alias: al, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}
		if (existing && existing.name.toLowerCase() !== name.toLowerCase()) {
			addAlias({ profileId: prof.id, alias: name, aliasKind: 'name', sourceCorpus: CORPUS }, tx);
		}

		addIdentifier(
			{
				profileId: prof.id,
				scheme: 'source_id',
				value: `epstein-dialog-person:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		for (const listKey of lists) {
			const eventId = eventIdByList.get(listKey);
			if (!eventId) continue;
			const roleLabel =
				listKey === 'epstein_files'
					? 'Named in Epstein Files releases (appearance ≠ wrongdoing)'
					: 'Named in Dialog directory / retreat materials (membership/attendance not assumed)';
			upsertProfileLink(
				{
					fromProfileId: prof.id,
					toProfileId: eventId,
					relationType: 'mentioned_in',
					roleLabel,
					status: 'observed',
					confidence: 0.85,
					angle: 'policy',
					sourceCorpus: CORPUS,
					evidenceNote: note || `${name} appears on curated ${LIST_LABEL[listKey] || listKey} list.`,
				},
				tx,
			);
			links += 1;
		}
	}

	// Co-founders → Dialog event as affiliated_with in addition to mentioned_in
	const dialogId = eventIdByList.get('dialog');
	for (const founderName of ['Peter Thiel', 'Auren Hoffman']) {
		const row = findExistingPerson(founderName, []);
		const id =
			row?.id ||
			tx.prepare(`SELECT id FROM profiles WHERE slug = ?`).get(makeProfileSlug('person', founderName))
				?.id;
		if (dialogId && id) {
			upsertProfileLink(
				{
					fromProfileId: String(id),
					toProfileId: dialogId,
					relationType: 'affiliated_with',
					roleLabel: 'Co-founder of Dialog',
					status: 'verified',
					confidence: 0.95,
					angle: 'corporate',
					sourceCorpus: CORPUS,
					evidenceNote: `${founderName} co-founded Dialog in 2006.`,
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
			people: people.length,
			events: events.length,
			createdPeople,
			updatedPeople,
			createdEvents,
			updatedEvents,
			links,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
