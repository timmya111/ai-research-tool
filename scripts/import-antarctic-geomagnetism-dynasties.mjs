#!/usr/bin/env node
/**
 * Import curated Antarctic / geomagnetism dynasty patronage network.
 * Source: .data/antarctic-geomagnetism-dynasties/entities.json
 * Usage: pnpm profiles:import-antarctic-geomagnetism
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

const CORPUS = 'antarctic-geomagnetism-dynasties-curated';
const SEED_PATH = path.join(ROOT, '.data/antarctic-geomagnetism-dynasties/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const firms = Array.isArray(seed.firms) ? seed.firms : [];
const nonprofits = Array.isArray(seed.nonprofits) ? seed.nonprofits : [];
const government = Array.isArray(seed.government) ? seed.government : [];
const education = Array.isArray(seed.education) ? seed.education : [];
const events = Array.isArray(seed.events) ? seed.events : [];
const links = Array.isArray(seed.links) ? seed.links : [];
const DISCLAIMER =
	seed.disclaimer ||
	'Appearance in this curated Antarctic / geomagnetism dynasties network records public historical patronage and scientific associations only.';

const ALLOWED = new Set(['person', 'firm', 'education', 'nonprofit', 'government', 'historic_event']);

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
			sourceRef: 'curated:antarctic-geomagnetism-dynasties',
			sourceUrl: seed.sourceUrl || null,
			title: 'Antarctic / geomagnetism dynasty patronage (curated)',
			excerpt: `${people.length} people, ${events.length} polar/geomagnetic events; Rockefeller–Carnegie–Rothschild–Ford–Astor–Wallenberg patronage network.`,
			metadata: {
				peopleCount: people.length,
				firmCount: firms.length,
				nonprofitCount: nonprofits.length,
				governmentCount: government.length,
				educationCount: education.length,
				eventCount: events.length,
				linkCount: links.length,
				disclaimer: DISCLAIMER,
				retrievedAt: seed.retrievedAt || null,
				sourceNote: seed.sourceNote || null,
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
			// legacy double-prefix slugs (e.g. nonprofit:nonprofit:rockefeller-family)
			const double = `${profileType}:${preferred}`;
			const byDouble = tx.prepare(`SELECT id, slug, name, profile_type FROM profiles WHERE slug = ?`).get(double);
			if (byDouble?.id) return byDouble;
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

	const upsertEntity = (profileType, o, extraTags = []) => {
		const name = String(o.name || '').trim();
		if (!name || !ALLOWED.has(profileType)) return null;
		const aliases = Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = o.slugHint ? String(o.slugHint).trim() : null;
		const existing = findExisting(profileType, name, aliases, slugHint);
		const slug = existing?.slug || makeProfileSlug(profileType, slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const network = o.network ? String(o.network).trim() : null;
		const role = o.role ? String(o.role).trim() : null;
		const baseSummary = String(o.summary || '').trim();
		const summary = [
			baseSummary || `${name} appears in the curated Antarctic / geomagnetism dynasties network.`,
			role ? `Role: ${role}.` : null,
			DISCLAIMER,
		]
			.filter(Boolean)
			.join('\n\n');

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
					categoryTags: [
						profileType,
						'antarctic-geomagnetism',
						'polar-dynasties',
						'geomagnetism',
						...(network ? [network] : []),
						...(o.category ? [String(o.category)] : []),
						...extraTags,
					],
					polarNetwork: network || undefined,
					role: role || undefined,
					ticker: o.ticker || undefined,
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
				value: `antarctic-geomag:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		if (o.ticker) {
			addIdentifier(
				{
					profileId: prof.id,
					scheme: 'ticker',
					value: String(o.ticker),
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		attachLocation(prof.id, o);
		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);
		return prof;
	};

	for (const ev of events) upsertEntity('historic_event', ev, ['polar-expedition']);
	for (const g of government) upsertEntity('government', g, ['polar-agency']);
	for (const n of nonprofits) upsertEntity('nonprofit', n, ['dynasty-or-foundation']);
	for (const f of firms) upsertEntity('firm', f, ['polar-patron-firm']);
	for (const e of education) upsertEntity('education', e, []);
	for (const p of people) upsertEntity('person', p, ['polar-patron-or-explorer']);

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
		if (row?.id) return String(row.id);
		const byAlias = tx
			.prepare(
				`SELECT p.id FROM profile_aliases a
         JOIN profiles p ON p.id = a.profile_id
         WHERE a.alias = ? COLLATE NOCASE
           AND p.profile_type IN ('person','firm','education','historic_event','nonprofit','government')
         LIMIT 1`,
			)
			.get(String(name || '').trim());
		return byAlias?.id ? String(byAlias.id) : null;
	};

	for (const L of links) {
		const fromId = resolveId(L.from);
		const toId = resolveId(L.to);
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
				confidence: typeof L.confidence === 'number' ? L.confidence : 0.9,
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
			firms: firms.length,
			nonprofits: nonprofits.length,
			government: government.length,
			education: education.length,
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
