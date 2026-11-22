#!/usr/bin/env node
/**
 * Import Bruce King / King family / Zorro Ranch curated network.
 * Source: .data/bruce-king-zorro-ranch/entities.json
 * Usage: pnpm profiles:import-bruce-king-zorro
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
	upsertTimelineEntry,
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'bruce-king-zorro-ranch-curated';
const SEED_PATH = path.join(ROOT, '.data/bruce-king-zorro-ranch/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const firms = Array.isArray(seed.firms) ? seed.firms : [];
const education = Array.isArray(seed.education) ? seed.education : [];
const events = Array.isArray(seed.events) ? seed.events : [];
const links = Array.isArray(seed.links) ? seed.links : [];
const DISCLAIMER =
	seed.disclaimer ||
	'Appearance in this curated network does not imply criminal wrongdoing.';

let createdPeople = 0;
let updatedPeople = 0;
let createdFirms = 0;
let updatedFirms = 0;
let createdEducation = 0;
let updatedEducation = 0;
let createdEvents = 0;
let updatedEvents = 0;
let linkCount = 0;
let timelineCount = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:bruce-king-zorro-ranch',
			sourceUrl: seed.sourceUrl || null,
			title: 'Bruce King / King family / Zorro Ranch network',
			excerpt: `${people.length} people, ${firms.length} firms, ${education.length} education, ${events.length} events.`,
			metadata: {
				peopleCount: people.length,
				firmCount: firms.length,
				educationCount: education.length,
				eventCount: events.length,
				linkCount: links.length,
				disclaimer: DISCLAIMER,
				retrievedAt: seed.retrievedAt || null,
			},
		},
		tx,
	);

	/** @type {Map<string, string>} name(lowercase) -> profile id */
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

	const findExisting = (profileType, name, aliases = [], slugHint = null) => {
		if (slugHint) {
			const preferred = makeProfileSlug(profileType, slugHint);
			const bySlug = tx.prepare(`SELECT id, slug, name, profile_type FROM profiles WHERE slug = ?`).get(preferred);
			if (bySlug?.id) return bySlug;
		}
		const candidates = [name, ...aliases].map((s) => String(s || '').trim()).filter(Boolean);
		for (const candidate of candidates) {
			const byName = tx
				.prepare(
					`SELECT id, slug, name, profile_type FROM profiles
           WHERE profile_type = ? AND name = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byName?.id) return byName;
			const byAlias = tx
				.prepare(
					`SELECT p.id, p.slug, p.name, p.profile_type
           FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byAlias?.id) return byAlias;
		}
		return null;
	};

	const attachLocation = (profileId, o) => {
		const country = o.country ? String(o.country).trim() : null;
		const city = o.hqCity ? String(o.hqCity).trim() : null;
		const state = o.hqState ? String(o.hqState).trim() : null;
		if (!country && !city && !state) return;
		const locRaw = [city, state, country].filter(Boolean).join(', ');
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

	const upsertOrg = (profileType, o, counters) => {
		const name = String(o.name || '').trim();
		if (!name) return null;
		const aliases = Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = o.slugHint ? String(o.slugHint).trim() : null;
		const existing = findExisting(profileType, name, aliases, slugHint);
		const slug = existing?.slug || makeProfileSlug(profileType, slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const summary =
			String(o.summary || '').trim() ||
			`${name} appears in the curated Bruce King / Zorro Ranch network. ${DISCLAIMER}`;

		const prof = upsertProfile(
			{
				profileType,
				name: existing?.name || name,
				slug,
				status: 'pinned',
				startDate: o.startDate || null,
				endDate: o.endDate || null,
				summary,
				metadata: {
					categoryTags: [
						profileType,
						'bruce-king-network',
						'zorro-ranch',
						'new-mexico',
						...(o.listKey ? [String(o.listKey)] : []),
					],
					network: 'bruce-king-zorro-ranch',
					listKey: o.listKey || undefined,
					disclaimer: DISCLAIMER,
					sourceRecordId: srId,
				},
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (existed || existing) counters.updated += 1;
		else counters.created += 1;

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
				value: `bruce-king-zorro:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);
		attachLocation(prof.id, o);
		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);
		return prof;
	};

	for (const ev of events) {
		const c = { created: 0, updated: 0 };
		upsertOrg('historic_event', ev, c);
		createdEvents += c.created;
		updatedEvents += c.updated;
	}

	for (const f of firms) {
		const c = { created: 0, updated: 0 };
		upsertOrg('firm', f, c);
		createdFirms += c.created;
		updatedFirms += c.updated;
	}

	for (const e of education) {
		const c = { created: 0, updated: 0 };
		upsertOrg('education', e, c);
		createdEducation += c.created;
		updatedEducation += c.updated;
	}

	for (const p of people) {
		const name = String(p.name || '').trim();
		if (!name) continue;
		const aliases = Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = p.slugHint ? String(p.slugHint).trim() : null;
		const existing = findExisting('person', name, aliases, slugHint);
		const slug = existing?.slug || makeProfileSlug('person', slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const network = String(p.network || 'network').trim();
		const role = String(p.role || '').trim();
		const baseSummary = String(p.summary || '').trim();
		const summary = [baseSummary || null, role ? `Role: ${role}.` : null, DISCLAIMER]
			.filter(Boolean)
			.join(' ');

		const prof = upsertProfile(
			{
				profileType: 'person',
				name: existing?.name || name,
				slug,
				status: 'pinned',
				endDate: p.deceased ? p.endDate || undefined : p.endDate || undefined,
				summary,
				metadata: {
					categoryTags: [
						'person',
						'bruce-king-network',
						'zorro-ranch',
						'new-mexico',
						network,
						...(p.deceased ? ['deceased'] : []),
					],
					network,
					role: role || undefined,
					birthYear: p.birthYear || undefined,
					deceased: p.deceased ? true : undefined,
					disclaimer: DISCLAIMER,
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
				value: `bruce-king-zorro:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (name === 'Bruce King' && seed.sourceUrl) {
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

		attachLocation(prof.id, p);
		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);

		if (Array.isArray(p.timeline)) {
			for (const te of p.timeline) {
				const title = String(te.label || te.title || '').trim();
				if (!title) continue;
				upsertTimelineEntry(
					{
						profileId: prof.id,
						eventDate: te.date || null,
						title,
						summary: te.summary || title,
						angle: 'policy',
						entryKind: 'milestone',
						confidence: 0.9,
						sourceCorpus: CORPUS,
						sourceRecordId: srId,
						geoKey: p.hqState ? `US-${p.hqState}` : null,
						geoLabel: [p.hqCity, p.hqState].filter(Boolean).join(', ') || 'New Mexico',
						dedupeHint: `bruce-king-tl:${te.date || ''}:${title}`,
					},
					tx,
				);
				timelineCount += 1;
			}
		}
	}

	const resolveId = (name) => {
		const key = String(name || '')
			.toLowerCase()
			.trim();
		if (idByName.has(key)) return idByName.get(key);
		const row = tx
			.prepare(
				`SELECT id FROM profiles
         WHERE name = ? COLLATE NOCASE
           AND profile_type IN ('person','firm','education','historic_event','nonprofit','government')
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
			continue;
		}
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: L.relationType || 'affiliated_with',
				roleLabel: L.roleLabel || null,
				status: L.status || 'observed',
				confidence: typeof L.confidence === 'number' ? L.confidence : 0.85,
				angle: 'policy',
				sourceCorpus: CORPUS,
				evidenceNote: L.evidenceNote || L.note || `${L.from} → ${L.to} (${L.roleLabel || L.relationType})`,
			},
			tx,
		);
		linkCount += 1;
	}
});

console.log(
	JSON.stringify(
		{
			ok: true,
			people: people.length,
			firms: firms.length,
			education: education.length,
			events: events.length,
			createdPeople,
			updatedPeople,
			createdFirms,
			updatedFirms,
			createdEducation,
			updatedEducation,
			createdEvents,
			updatedEvents,
			links: linkCount,
			timelineEntries: timelineCount,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
