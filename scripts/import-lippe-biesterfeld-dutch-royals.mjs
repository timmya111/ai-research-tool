#!/usr/bin/env node
/**
 * Import Prince Bernhard of Lippe-Biesterfeld / Dutch royal descendant network.
 * Source: .data/lippe-biesterfeld-dutch-royals/entities.json
 * Usage: pnpm profiles:import-lippe-biesterfeld
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
const { upsertProfile, addAlias, addIdentifier, addLocation, upsertSourceRecord, upsertProfileLink } =
	await import('../src/lib/research/profiles/store.ts');
const { makeProfileSlug } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'lippe-biesterfeld-dutch-royals-curated';
const SEED_PATH = path.join(ROOT, '.data/lippe-biesterfeld-dutch-royals/entities.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const people = Array.isArray(seed.people) ? seed.people : [];
const links = Array.isArray(seed.links) ? seed.links : [];
const DISCLAIMER =
	seed.disclaimer ||
	'Appearance in this curated Dutch royal / Lippe-Biesterfeld descendant network records public genealogical relationships only.';

let createdPeople = 0;
let updatedPeople = 0;
let linkCount = 0;

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'curated:lippe-biesterfeld-dutch-royals',
			sourceUrl: seed.sourceUrl || null,
			title: 'Prince Bernhard of Lippe-Biesterfeld / Dutch royal descendants',
			excerpt: `${people.length} people, ${links.length} family links.`,
			metadata: {
				peopleCount: people.length,
				linkCount: links.length,
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
					`SELECT p.id, p.slug, p.name, p.profile_type FROM profile_aliases a
           JOIN profiles p ON p.id = a.profile_id
           WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE
           LIMIT 1`,
				)
				.get(profileType, candidate);
			if (byAlias?.id) return byAlias;
		}
		return null;
	};

	for (const p of people) {
		const name = String(p.name || '').trim();
		if (!name) continue;
		const aliases = Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
		const slugHint = p.slugHint ? String(p.slugHint).trim() : null;
		const existing = findExisting('person', name, aliases, slugHint);
		const slug = existing?.slug || makeProfileSlug('person', slugHint || name);
		const existed = Boolean(tx.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug));
		const network = String(p.network || 'family').trim();
		const role = String(p.role || '').trim();
		const baseSummary = String(p.summary || '').trim();
		const hasStructured = /^(Labels|Role):/m.test(baseSummary) || /\*\*\d{4}/.test(baseSummary);
		// Disclaimer stays on source_record / profile metadata only — not appended to overview summary text.
		const summary = hasStructured
			? baseSummary
			: [baseSummary || null, role ? `Role: ${role}` : null].filter(Boolean).join('\n\n');

		const birthYear = p.birthYear != null ? Number(p.birthYear) : null;
		const startDate =
			(p.startDate ? String(p.startDate).trim() : '') ||
			(p.birthDate ? String(p.birthDate).trim() : '') ||
			(Number.isFinite(birthYear) && birthYear >= 1000 ? String(birthYear) : '') ||
			undefined;

		const prof = upsertProfile(
			{
				profileType: 'person',
				name: existing?.name || name,
				slug,
				status: 'pinned',
				startDate: startDate || undefined,
				endDate: p.deceased ? p.endDate || undefined : p.endDate || undefined,
				summary,
				metadata: {
					categoryTags: [
						'person',
						'lippe-biesterfeld',
						'dutch-royals',
						'netherlands',
						network,
						...(p.deceased ? ['deceased'] : []),
					],
					network,
					role: role || undefined,
					birthYear: birthYear || undefined,
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
				value: `lippe-biesterfeld:${slug}`,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		const country = String(p.country || 'Netherlands').trim();
		if (country) {
			addLocation(
				{
					profileId: prof.id,
					raw: country,
					country: country === 'Netherlands' ? 'NL' : country,
					role: 'associated',
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		remember(name, prof.id, aliases);
		if (existing?.name) remember(existing.name, prof.id, []);
	}

	const resolveId = (name) => {
		const key = String(name || '')
			.toLowerCase()
			.trim();
		if (idByName.has(key)) return idByName.get(key);
		const row = tx
			.prepare(
				`SELECT id FROM profiles
         WHERE name = ? COLLATE NOCASE AND profile_type = 'person'
         LIMIT 1`,
			)
			.get(String(name || '').trim());
		return row?.id || null;
	};

	for (const l of links) {
		const fromId = resolveId(l.from);
		const toId = resolveId(l.to);
		if (!fromId || !toId) {
			console.warn('skip link (unresolved):', l.from, '->', l.to);
			continue;
		}
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: l.relationType || 'family_or_associate',
				roleLabel: l.roleLabel || null,
				status: 'verified',
				confidence: 0.95,
				angle: 'general',
				sourceCorpus: CORPUS,
				sourceRecordId: srId,
				evidenceNote: String(l.evidenceNote || l.roleLabel || 'Dutch royal / Lippe-Biesterfeld family link'),
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
			corpus: CORPUS,
			createdPeople,
			updatedPeople,
			linkCount,
			seedPeople: people.length,
			seedLinks: links.length,
		},
		null,
		2,
	),
);
