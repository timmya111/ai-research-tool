#!/usr/bin/env node
/**
 * Import curated Dallas elite networks:
 * Altman family (St. Louis contrast), Starck Club, Bush DFW network, Campisi family, core dynasties.
 * Source: .data/dallas-elite/entities.json
 * Usage: pnpm profiles:import-dallas-elite
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
	upsertProfileLink,
	getProfile,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'dallas-elite-curated';
const SEED_PATH = path.join(ROOT, '.data/dallas-elite/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const firms = Array.isArray(seed.firms) ? seed.firms : [];
const nonprofits = Array.isArray(seed.nonprofits) ? seed.nonprofits : [];
const education = Array.isArray(seed.education) ? seed.education : [];
const medicalHospitals = Array.isArray(seed.medical_hospitals) ? seed.medical_hospitals : [];
const events = Array.isArray(seed.events) ? seed.events : [];
const links = Array.isArray(seed.links) ? seed.links : [];
const DISCLAIMER =
	seed.disclaimer ||
	'Appearance in this curated Dallas elite network records public historical, business, social, and political associations only.';

const ALLOWED = new Set([
	'person',
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	'historic_event',
]);

/** @type {Record<string, number>} */
const created = {};
/** @type {Record<string, number>} */
const updated = {};
for (const t of ALLOWED) {
	created[t] = 0;
	updated[t] = 0;
}
let linkCount = 0;
let skippedLinks = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:dallas-elite',
			sourceUrl: seed.sourceUrl || null,
			title: seed.title || 'Dallas elite networks (curated)',
			excerpt: `${people.length} people · ${firms.length} firms · Starck Club / Bush / Campisi / dynasties. Label: dallas-elite.`,
			metadata: {
				label: 'dallas-elite',
				peopleCount: people.length,
				firmCount: firms.length,
				nonprofitCount: nonprofits.length,
				educationCount: education.length,
				medicalHospitalCount: medicalHospitals.length,
				eventCount: events.length,
				linkCount: links.length,
				disclaimer: DISCLAIMER,
				note: seed.note || null,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	/** @type {Map<string, string>} */
	const idByName = new Map();

	const remember = (name, id, aliases = []) => {
		idByName.set(String(name).toLowerCase().trim(), id);
		for (const a of aliases) {
			const k = String(a || '')
				.toLowerCase()
				.trim();
			if (k) idByName.set(k, id);
		}
	};

	const findExisting = (profileType, name, aliases = [], slugHint = null, opts = {}) => {
		if (slugHint) {
			const preferred = makeProfileSlug(profileType, slugHint);
			const bySlug = tx.prepare(`SELECT id, slug, name, profile_type FROM profiles WHERE slug = ?`).get(preferred);
			if (bySlug?.id) return bySlug;
		}
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		const rejectFinraCollision = Boolean(opts.rejectFinraCollision);
		const hasFinraCrd = (profileId) =>
			Boolean(
				tx
					.prepare(`SELECT 1 AS ok FROM profile_identifiers WHERE profile_id = ? AND scheme = 'finra_crd' LIMIT 1`)
					.get(profileId),
			);
		for (const candidate of candidates) {
			const byName = tx
				.prepare(
					`SELECT id, slug, name, profile_type FROM profiles
           WHERE profile_type = ? AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byName?.id) {
				if (rejectFinraCollision && hasFinraCrd(String(byName.id))) continue;
				return byName;
			}
			const byAlias = tx
				.prepare(
					`SELECT p.id, p.slug, p.name, p.profile_type
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byAlias?.id) {
				if (rejectFinraCollision && hasFinraCrd(String(byAlias.id))) continue;
				return byAlias;
			}
		}
		return null;
	};

	const attachLocation = (profileId, o) => {
		const hqAddress = o.hqAddress ? String(o.hqAddress).trim() : '';
		const country = o.country ? String(o.country).trim() : null;
		const city = o.hqCity ? String(o.hqCity).trim() : null;
		const state = o.hqState ? String(o.hqState).trim() : null;
		const locRaw = hqAddress || [city, state, country].filter(Boolean).join(', ');
		if (!locRaw) return;
		const parts = parseAddressParts(locRaw);
		addLocation(
			{
				profileId,
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
	};

	const upsertEntity = (profileType, o, extraTags = []) => {
		const name = String(o.name || '').trim();
		if (!name || !ALLOWED.has(profileType)) return null;
		const aliases = Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = o.slugHint ? String(o.slugHint).trim() : null;
		// Prefer slugHint cards over FINRA name/alias collisions (e.g. OpenAI Sam Altman vs CRD Samuel Altman)
		const existing = findExisting(profileType, name, aliases, slugHint, {
			rejectFinraCollision: profileType === 'person' && Boolean(slugHint),
		});
		const slug = existing?.slug || makeProfileSlug(profileType, slugHint || name);
		const existedRow = tx.prepare('SELECT id, metadata_json, summary, start_date, end_date FROM profiles WHERE slug = ?').get(slug);
		const existed = Boolean(existedRow?.id);

		let prevMeta = {};
		try {
			prevMeta = existedRow?.metadata_json ? JSON.parse(String(existedRow.metadata_json)) : {};
		} catch {
			prevMeta = {};
		}
		const prevTags = Array.isArray(prevMeta.categoryTags) ? prevMeta.categoryTags.map(String) : [];
		const listKey = o.listKey ? String(o.listKey).trim() : null;
		const role = o.role ? String(o.role).trim() : null;
		const baseSummary = String(o.summary || '').trim();
		// Keep disclaimer on metadata / source_record only (do not append into summary prose)
		const summary = baseSummary || `${name} appears in the curated Dallas elite network.`;

		const startDate =
			o.startDate || o.birthDate || (o.birthYear != null ? String(o.birthYear) : null) || null;
		const endDate = o.endDate || null;

		const nextTags = [
			...new Set([
				...prevTags,
				profileType,
				'dallas-elite',
				'dallas',
				'texas',
				...(listKey ? [listKey] : []),
				...extraTags,
			]),
		];

		const prof = upsertProfile(
			{
				profileType,
				name: existing?.name || name,
				slug,
				status: 'pinned',
				startDate: startDate || (existedRow?.start_date != null ? String(existedRow.start_date) : null),
				endDate: endDate || (existedRow?.end_date != null ? String(existedRow.end_date) : null),
				summary,
				metadata: {
					...prevMeta,
					categoryTags: nextTags,
					network: 'dallas-elite',
					label: 'dallas-elite',
					role: role || prevMeta.role || undefined,
					listKey: listKey || prevMeta.listKey || undefined,
					disclaimer: DISCLAIMER,
					sourceRecordId: srId,
					corpora: [
						...new Set([
							...(Array.isArray(prevMeta.corpora) ? prevMeta.corpora.map(String) : []),
							CORPUS,
						]),
					],
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed || existing) updated[profileType] += 1;
		else created[profileType] += 1;

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
				value: `dallas-elite:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (name === 'Clint Murchison Jr.' && seed.sourceUrl) {
			addIdentifier(
				{
					profileId: prof.id,
					scheme: 'url',
					value: String(seed.sourceUrl),
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		attachLocation(prof.id, o);
		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);
		if (slugHint) remember(slugHint.replace(/-/g, ' '), prof.id, []);
		return prof;
	};

	for (const ev of events) upsertEntity('historic_event', ev, ['dallas-nightlife', 'dallas-history']);
	for (const n of nonprofits) upsertEntity('nonprofit', n, ['family', 'dynasty']);
	for (const f of firms) upsertEntity('firm', f, []);
	for (const e of education) upsertEntity('education', e, []);
	for (const m of medicalHospitals) upsertEntity('medical_hospital', m, []);
	for (const p of people) upsertEntity('person', p, []);

	const resolveId = (name) => {
		const key = String(name || '')
			.toLowerCase()
			.trim();
		if (idByName.has(key)) return idByName.get(key);
		const row = tx
			.prepare(
				`SELECT id FROM profiles
         WHERE name = ? COLLATE NOCASE
           AND profile_type IN ('person','firm','education','historic_event','nonprofit','government','medical_hospital')
         LIMIT 1`,
			)
			.get(String(name || '').trim());
		return row?.id ? String(row.id) : null;
	};

	for (const L of links) {
		const fromId = resolveId(L.from);
		const toId = resolveId(L.to);
		if (!fromId || !toId) {
			console.warn('skip link unresolved', L.from, '->', L.to);
			skippedLinks += 1;
			continue;
		}
		const angle =
			L.listKey === 'campisi'
				? 'policy'
				: L.listKey === 'bush'
					? 'corporate'
					: L.relationType === 'family_or_associate'
						? 'general'
						: 'corporate';
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: L.relationType || 'affiliated_with',
				roleLabel: L.roleLabel || null,
				status: L.status || 'observed',
				confidence: typeof L.confidence === 'number' ? L.confidence : 0.88,
				angle,
				sourceCorpus: CORPUS,
				evidenceNote:
					L.evidenceNote ||
					L.note ||
					`${L.from} → ${L.to} (${L.roleLabel || L.relationType}); dallas-elite`,
			},
			tx,
		);
		linkCount += 1;
	}
});

// Quick sanity on hub cards
const hubs = [
	'person:sam-altman',
	'firm:starck-club',
	'historic_event:starck-club-dallas-1984-1989',
	'nonprofit:bush-family',
	'nonprofit:campisi-family',
	'person:joseph-papa-joe-campisi',
	'firm:neiman-marcus',
	'person:clint-murchison-jr',
];
const hubStatus = {};
for (const slug of hubs) {
	const p = getProfile(slug);
	hubStatus[slug] = p ? { name: p.name, id: p.id.slice(0, 8) } : null;
}

console.log(
	JSON.stringify(
		{
			ok: true,
			label: 'dallas-elite',
			people: people.length,
			firms: firms.length,
			nonprofits: nonprofits.length,
			education: education.length,
			medicalHospitals: medicalHospitals.length,
			events: events.length,
			created,
			updated,
			links: linkCount,
			skippedLinks,
			corpus: CORPUS,
			hubs: hubStatus,
		},
		null,
		2,
	),
);
