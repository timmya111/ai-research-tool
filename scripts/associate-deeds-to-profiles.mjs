#!/usr/bin/env node
/**
 * Associate OKCR / county deed knowledge docs to profiles by exact Grantor/Grantee name match.
 *
 *   node scripts/associate-deeds-to-profiles.mjs
 *   node scripts/associate-deeds-to-profiles.mjs --dry-run --limit 500
 *   node scripts/associate-deeds-to-profiles.mjs --project "Pawnee County" --limit 8000
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DB = path.join(ROOT, '.data/profiles/profiles.sqlite');
const KNOWLEDGE_DB = path.join(ROOT, '.data/knowledge/knowledge.sqlite');

const PARTY_LINE_RE =
	/^-\s*(Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\s*:\s*(.+)$/gim;

function normalizeText(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function sha256Key(parts) {
	return createHash('sha256').update(parts.map(String).join('|')).digest('hex');
}

function parseParties(rawText) {
	const out = [];
	const text = String(rawText || '');
	PARTY_LINE_RE.lastIndex = 0;
	let m;
	while ((m = PARTY_LINE_RE.exec(text))) {
		const role = String(m[1] || '').trim();
		const raw = String(m[2] || '').trim();
		if (!raw || raw === '—' || raw === '-') continue;
		for (const part of raw.split(/[;/|]/)) {
			const name = part.replace(/\s+/g, ' ').trim();
			if (name.length < 3) continue;
			out.push({ role, name });
		}
	}
	return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceIdx = args.indexOf('--since');
const limitIdx = args.indexOf('--limit');
const projectIdx = args.indexOf('--project');
const sinceIso = sinceIdx >= 0 ? String(args[sinceIdx + 1] || '').trim() : '';
const limit = Math.max(1, Math.min(limitIdx >= 0 ? Number(args[limitIdx + 1]) || 5000 : 5000, 50_000));
const projectNameIncludes =
	projectIdx >= 0 ? String(args[projectIdx + 1] || '').trim() : '';

if (!fs.existsSync(KNOWLEDGE_DB)) {
	console.error('missing knowledge db', KNOWLEDGE_DB);
	process.exit(1);
}
if (!fs.existsSync(PROFILES_DB)) {
	console.error('missing profiles db', PROFILES_DB);
	process.exit(1);
}

const kdb = new DatabaseSync(KNOWLEDGE_DB, { readOnly: true });
const pdb = new DatabaseSync(PROFILES_DB);
pdb.exec('PRAGMA foreign_keys = ON');
pdb.exec('PRAGMA busy_timeout = 120000');

const nameIndex = new Map();
const push = (norm, profileId) => {
	if (!norm || norm.length < 3) return;
	const list = nameIndex.get(norm) || [];
	if (!list.includes(profileId)) list.push(profileId);
	nameIndex.set(norm, list);
};
for (const row of pdb.prepare('SELECT id, normalized_name FROM profiles').all()) {
	push(String(row.normalized_name || ''), String(row.id));
}
for (const row of pdb
	.prepare(
		`SELECT profile_id AS id, normalized_alias AS n FROM profile_aliases
     WHERE alias_kind IS NULL OR alias_kind NOT IN ('slug')`,
	)
	.all()) {
	push(String(row.n || ''), String(row.id));
}

const params = [];
let sql = `
  SELECT d.id, d.title, d.url, d.raw_text, d.updated_at, p.name AS project_name
  FROM documents d
  JOIN projects p ON p.id = d.project_id
  WHERE d.raw_text LIKE '%Grantor:%' OR d.raw_text LIKE '%Grantee:%'
     OR d.raw_text LIKE '%Buyer:%' OR d.raw_text LIKE '%Seller:%'
`;
if (sinceIso) {
	sql += ` AND datetime(d.updated_at) >= datetime(?)`;
	params.push(sinceIso);
}
if (projectNameIncludes) {
	sql += ` AND lower(p.name) LIKE ?`;
	params.push(`%${projectNameIncludes.toLowerCase()}%`);
}
sql += ` ORDER BY datetime(d.updated_at) DESC LIMIT ?`;
params.push(limit);

const docs = kdb.prepare(sql).all(...params);
const report = {
	dryRun,
	documentsScanned: 0,
	partiesParsed: 0,
	matches: 0,
	timelineWrites: 0,
	identifierWrites: 0,
	unmatchedParties: 0,
};

const insertTimeline = pdb.prepare(
	`INSERT INTO timeline_entries(
     id, profile_id, event_date, date_precision, end_date, title, summary, angle, entry_kind,
     geo_key, geo_label, confidence, source_corpus, source_record_id, metadata_json, dedupe_key, created_at
   ) VALUES (?, ?, ?, 'day', NULL, ?, ?, 'land_records', 'observation', NULL, NULL, 0.85, 'knowledge-sqlite', NULL, ?, ?, ?)`,
);
const selectTimeline = pdb.prepare('SELECT id FROM timeline_entries WHERE dedupe_key = ?');
const now = new Date().toISOString();

for (const doc of docs) {
	report.documentsScanned += 1;
	const parties = parseParties(doc.raw_text);
	report.partiesParsed += parties.length;
	const instrument =
		doc.title?.match(/\b([A-Z]{1,5}\s+I-\d{4}-\d+)\b/)?.[1] ||
		doc.title?.match(/\b(I-\d{4}-\d+)\b/)?.[1] ||
		doc.title ||
		doc.id;

	for (const party of parties) {
		const norm = normalizeText(party.name);
		const hits = nameIndex.get(norm);
		if (!hits?.length || hits.length > 1) {
			report.unmatchedParties += 1;
			continue;
		}
		const profileId = hits[0];
		report.matches += 1;
		if (dryRun) continue;

		const recorded =
			doc.raw_text.match(/Recorded:\s*(.+)/i)?.[1]?.trim()?.slice(0, 10) ||
			String(doc.updated_at || '').slice(0, 10) ||
			null;
		const title = `${doc.project_name}: ${instrument} (${party.role})`;
		const summary = `${party.role}: ${party.name}. Exact name match on county deed / land record.`;
		const dedupeKey = sha256Key([
			profileId,
			'knowledge-sqlite',
			recorded || 'nodate',
			`deed:${doc.id}:${party.role}:${norm}`,
		]);
		if (!selectTimeline.get(dedupeKey)) {
			insertTimeline.run(
				randomUUID(),
				profileId,
				recorded,
				title.slice(0, 400),
				summary.slice(0, 2000),
				JSON.stringify({ knowledgeDocumentId: doc.id, partyRole: party.role }),
				dedupeKey,
				now,
			);
			report.timelineWrites += 1;
		}

		// Property content stays on Timeline (land_records) + overview ## Land Deeds.
		// Do not write okcr_instrument URL identifiers into Sources & Identifiers.
	}
}

try {
	kdb.close();
} catch {
	/* ignore */
}
try {
	pdb.close();
} catch {
	/* ignore */
}

console.log(JSON.stringify(report, null, 2));
