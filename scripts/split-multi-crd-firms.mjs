#!/usr/bin/env node
/**
 * Split firm profiles that carry multiple distinct finra_crd values into
 * one profile per CRD (user rule: separate profile for each major ID).
 *
 * Keeps the original profile with the preferred CRD (metadata.finraCrd, else
 * the numerically smallest CRD). Extra CRDs become new firm: cards linked
 * affiliated_with the original, named "{name} (CRD {n})" until FINRA enrich.
 *
 * Usage:
 *   node scripts/split-multi-crd-firms.mjs --dry-run
 *   node scripts/split-multi-crd-firms.mjs
 *   node scripts/split-multi-crd-firms.mjs --limit 20
 */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function linkDedupe(fromId, toId, relation, role) {
	return createHash('sha256')
		.update([fromId, toId, relation, role || ''].join('|'))
		.digest('hex');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, '.data/profiles/profiles.sqlite');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1]) || 0) : 0;

function slugify(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function allocateSlug(db, base) {
	let slug = `firm:${base}`;
	let n = 2;
	while (db.prepare('SELECT 1 FROM profiles WHERE slug = ? LIMIT 1').get(slug)) {
		slug = `firm:${base}-${n}`;
		n += 1;
	}
	return slug;
}

function normalizeName(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const multi = db
	.prepare(
		`SELECT p.id, p.slug, p.name, p.metadata_json,
            group_concat(DISTINCT pi.value) AS crds,
            COUNT(DISTINCT pi.value) AS c
     FROM profiles p
     JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
     WHERE p.profile_type = 'firm'
     GROUP BY p.id
     HAVING c > 1
     ORDER BY c DESC, p.name ASC`,
	)
	.all();

console.log(`multi-CRD firms: ${multi.length}${DRY ? ' (dry-run)' : ''}`);
let splitCount = 0;
let newProfiles = 0;

for (const row of multi) {
	if (LIMIT && splitCount >= LIMIT) break;
	const crds = String(row.crds || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (crds.length < 2) continue;

	let meta = {};
	try {
		meta = JSON.parse(String(row.metadata_json || '{}'));
	} catch {
		meta = {};
	}
	const preferred =
		meta.finraCrd != null && crds.includes(String(meta.finraCrd))
			? String(meta.finraCrd)
			: [...crds].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))[0];
	const extras = crds.filter((c) => c !== preferred);
	console.log(
		`- ${row.name} (${row.slug}) keep CRD ${preferred}; split ${extras.join(', ')}`,
	);
	if (DRY) {
		splitCount += 1;
		continue;
	}

	const now = new Date().toISOString();
	const delIdent = db.prepare(
		`DELETE FROM profile_identifiers WHERE profile_id = ? AND scheme = 'finra_crd' AND value = ?`,
	);
	const insertProfile = db.prepare(
		`INSERT INTO profiles (
       id, slug, profile_type, name, normalized_name, status, summary,
       start_date, end_date, metadata_json, created_at, updated_at
     ) VALUES (?, ?, 'firm', ?, ?, 'active', ?, NULL, NULL, ?, ?, ?)`,
	);
	const insertIdent = db.prepare(
		`INSERT OR IGNORE INTO profile_identifiers (
       id, profile_id, scheme, value, normalized_value, source_corpus
     ) VALUES (?, ?, 'finra_crd', ?, ?, 'split-multi-crd')`,
	);
	const insertLink = db.prepare(
		`INSERT OR IGNORE INTO profile_links (
       id, dedupe_key, from_profile_id, to_profile_id, relation_type, role_label,
       confidence, source_corpus, evidence_note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'affiliated_with', ?, 0.9, 'split-multi-crd', ?, ?, ?)`,
	);
	const updateMeta = db.prepare(
		`UPDATE profiles SET metadata_json = ?, updated_at = ? WHERE id = ?`,
	);

	db.exec('BEGIN');
	try {
		meta.finraCrd = preferred;
		meta.splitMultiCrdAt = now;
		meta.splitKeptCrd = preferred;
		meta.splitOffCrds = extras;
		updateMeta.run(JSON.stringify(meta), now, row.id);

		for (const crd of extras) {
			delIdent.run(row.id, crd);
			const display = `${row.name} (CRD ${crd})`;
			const id = randomUUID();
			const slug = allocateSlug(db, `${slugify(row.name)}-crd-${crd}`);
			const childMeta = {
				finraCrd: crd,
				corpora: ['split-multi-crd'],
				splitFromProfileId: row.id,
				splitFromSlug: row.slug,
				splitAt: now,
			};
			insertProfile.run(
				id,
				slug,
				display,
				normalizeName(display),
				`FINRA firm CRD# ${crd}. Split from "${row.name}" so each CRD has its own profile.`,
				JSON.stringify(childMeta),
				now,
				now,
			);
			insertIdent.run(randomUUID(), id, crd, crd);
			const roleA = `same/similar name; distinct CRD ${crd} vs ${preferred}`;
			const roleB = `affiliated / name-similar; CRD ${preferred} vs ${crd}`;
			insertLink.run(
				randomUUID(),
				linkDedupe(id, row.id, 'affiliated_with', roleA),
				id,
				row.id,
				roleA,
				`Split from ${row.slug}; enrich via FINRA visualizer for canonical legal name.`,
				now,
				now,
			);
			insertLink.run(
				randomUUID(),
				linkDedupe(row.id, id, 'affiliated_with', roleB),
				row.id,
				id,
				roleB,
				`Counterpart split card for CRD ${crd}.`,
				now,
				now,
			);
			newProfiles += 1;
			console.log(`  → created ${slug}`);
		}
		db.exec('COMMIT');
		splitCount += 1;
	} catch (e) {
		db.exec('ROLLBACK');
		console.error(`  FAIL ${row.slug}:`, e.message || e);
	}
}

console.log(
	JSON.stringify(
		{ dryRun: DRY, firmsProcessed: splitCount, newProfiles, remainingMulti: DRY ? multi.length : null },
		null,
		2,
	),
);
