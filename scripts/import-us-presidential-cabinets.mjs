#!/usr/bin/env node
/**
 * Import curated U.S. presidential cabinets (Carter → Trump II).
 * Source: .data/us-presidential-cabinets/entities.json
 * Usage: pnpm profiles:import-us-cabinets
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
} = await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug, parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'us-presidential-cabinets-curated';
const SEED_PATH = path.join(ROOT, '.data/us-presidential-cabinets/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const events = Array.isArray(seed.events) ? seed.events : [];
const links = Array.isArray(seed.links) ? seed.links : [];
const DISCLAIMER =
	seed.disclaimer ||
	'Appearance in this curated U.S. presidential cabinets corpus records publicly documented executive appointments only.';

const ALLOWED = new Set(['person', 'historic_event']);

/** @type {Record<string, number>} */
const created = { person: 0, historic_event: 0 };
/** @type {Record<string, number>} */
const updated = { person: 0, historic_event: 0 };
let linkCount = 0;
let skippedLinks = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:us-presidential-cabinets',
			sourceUrl: seed.sourceUrl || null,
			title: 'U.S. presidential cabinets (Carter–Trump II)',
			excerpt: `${people.length} people across ${events.length} administrations; VP + principal department secretaries.`,
			metadata: {
				peopleCount: people.length,
				eventCount: events.length,
				linkCount: links.length,
				administrations: seed.administrations || [],
				scope: seed.scope || null,
				disclaimer: DISCLAIMER,
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
		const country = o.country ? String(o.country).trim() : 'United States';
		const city = o.hqCity ? String(o.hqCity).trim() : null;
		const state = o.hqState ? String(o.hqState).trim() : null;
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

	const upsertEntity = (profileType, o, extraTags = []) => {
		const name = String(o.name || '').trim();
		if (!name || !ALLOWED.has(profileType)) return null;
		const aliases = Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = o.slugHint ? String(o.slugHint).trim() : null;
		const existing = findExisting(profileType, name, aliases, slugHint);
		const slug = existing?.slug || makeProfileSlug(profileType, slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const baseSummary = String(o.summary || '').trim();
		const summary = [baseSummary || `${name} appears in the curated U.S. presidential cabinets corpus.`, DISCLAIMER]
			.filter(Boolean)
			.join(' ');

		const categoryTags = [
			profileType,
			'us-presidential-cabinets',
			'us-cabinet',
			...(o.party ? [String(o.party).toLowerCase()] : []),
			...extraTags,
		];

		const prof = upsertProfile(
			{
				profileType,
				name: existing?.name || name,
				slug,
				status: 'pinned',
				startDate: o.startDate || null,
				endDate: o.deceased ? o.endDate || undefined : o.endDate || null,
				summary,
				metadata: {
					categoryTags,
					cabinetRoles: o.cabinetRoles || undefined,
					president: o.president || undefined,
					party: o.party || undefined,
					administrationNumber: o.number || undefined,
					disclaimer: DISCLAIMER,
					sourceRecordId: srId,
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
				value: `us-cabinet:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		attachLocation(prof.id, { country: o.country || 'United States', hqCity: o.hqCity, hqState: o.hqState });
		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);
		return prof;
	};

	for (const ev of events) {
		upsertEntity('historic_event', ev, ['us-administration', `president-${String(ev.number || '').padStart(2, '0')}`]);
	}
	for (const p of people) {
		const tags = ['us-cabinet-member'];
		const roles = Array.isArray(p.cabinetRoles) ? p.cabinetRoles : [];
		if (roles.some((r) => r.office === 'President of the United States')) tags.push('us-president');
		if (roles.some((r) => r.office === 'Vice President')) tags.push('us-vice-president');
		upsertEntity('person', p, tags);
	}

	const resolveId = (name, preferredType = null) => {
		const key = String(name || '')
			.toLowerCase()
			.trim();
		if (idByName.has(key)) return idByName.get(key);
		if (preferredType) {
			const byType = tx
				.prepare(
					`SELECT id FROM profiles WHERE profile_type = ? AND name = ? COLLATE NOCASE LIMIT 1`,
				)
				.get(preferredType, String(name || '').trim());
			if (byType?.id) return String(byType.id);
			const byAlias = tx
				.prepare(
					`SELECT p.id FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE LIMIT 1`,
				)
				.get(preferredType, String(name || '').trim());
			if (byAlias?.id) return String(byAlias.id);
		}
		const row = tx
			.prepare(
				`SELECT id FROM profiles
         WHERE name = ? COLLATE NOCASE
           AND profile_type IN ('person','historic_event')
         LIMIT 1`,
			)
			.get(String(name || '').trim());
		return row?.id ? String(row.id) : null;
	};

	for (const L of links) {
		const fromId = resolveId(L.from, L.fromType || 'person');
		const toId = resolveId(L.to, L.toType || 'historic_event');
		if (!fromId || !toId) {
			console.warn('skip link unresolved', L.from, '->', L.to);
			skippedLinks += 1;
			continue;
		}
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: L.relationType || 'affiliated_with',
				roleLabel: L.roleLabel || null,
				status: L.status || 'observed',
				confidence: typeof L.confidence === 'number' ? L.confidence : 0.95,
				angle: 'corporate',
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
			events: events.length,
			created,
			updated,
			links: linkCount,
			skippedLinks,
			corpus: CORPUS,
		},
		null,
		2,
	),
);
