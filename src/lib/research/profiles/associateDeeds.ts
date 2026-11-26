/**
 * Associate county deed / OKCR knowledge documents to entity profiles when
 * Grantor/Grantee (or Dallas party) script names exactly match a profile name
 * or alias (normalized).
 *
 * Safe by design: exact normalized name/alias only — no fuzzy absorb.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeText } from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import { upsertTimelineEntry } from '@/lib/research/profiles/store';

const PARTY_LINE_RE =
	/^-\s*(Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\s*:\s*(.+)$/gim;

export type AssociateDeedsOptions = {
	/** Only documents updated at/after this ISO timestamp. */
	sinceIso?: string;
	/** Max documents to scan this run. */
	limit?: number;
	/** Restrict to knowledge project name substring (e.g. "Pawnee", "Dallas"). */
	projectNameIncludes?: string;
	dryRun?: boolean;
};

export type AssociateDeedsReport = {
	documentsScanned: number;
	partiesParsed: number;
	matches: number;
	timelineWrites: number;
	/** Always 0 — okcr_instrument URL identifiers are no longer written. */
	identifierWrites: number;
	unmatchedParties: number;
};

function parseParties(rawText: string): Array<{ role: string; name: string }> {
	const out: Array<{ role: string; name: string }> = [];
	const text = String(rawText || '');
	PARTY_LINE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PARTY_LINE_RE.exec(text))) {
		const role = String(m[1] || '').trim();
		const raw = String(m[2] || '').trim();
		if (!raw || raw === '—' || raw === '-') continue;
		// Split multi-party fields on ; or /
		for (const part of raw.split(/[;/|]/)) {
			const name = part.replace(/\s+/g, ' ').trim();
			if (name.length < 3) continue;
			out.push({ role, name });
		}
	}
	return out;
}

function buildNameIndex(db: DatabaseSync): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const push = (norm: string, profileId: string) => {
		if (!norm || norm.length < 3) return;
		const list = map.get(norm) || [];
		if (!list.includes(profileId)) list.push(profileId);
		map.set(norm, list);
	};
	for (const row of db
		.prepare(`SELECT id, normalized_name FROM profiles`)
		.all() as Array<{ id: string; normalized_name: string }>) {
		push(String(row.normalized_name || ''), String(row.id));
	}
	for (const row of db
		.prepare(
			`SELECT profile_id AS id, normalized_alias AS n
       FROM profile_aliases
       WHERE alias_kind IS NULL OR alias_kind NOT IN ('slug')`,
		)
		.all() as Array<{ id: string; n: string }>) {
		push(String(row.n || ''), String(row.id));
	}
	return map;
}

/**
 * Scan knowledge.sqlite deed docs and attach exact name matches to profiles
 * as timeline entries (+ optional okcr_instrument identifier when present).
 */
export function associateDeedsToProfiles(
	opts: AssociateDeedsOptions = {},
): AssociateDeedsReport {
	const knowledgePath = getKnowledgeSqlitePath();
	const report: AssociateDeedsReport = {
		documentsScanned: 0,
		partiesParsed: 0,
		matches: 0,
		timelineWrites: 0,
		identifierWrites: 0,
		unmatchedParties: 0,
	};
	if (!knowledgePath || !fs.existsSync(knowledgePath)) {
		return report;
	}

	const kdb = new DatabaseSync(knowledgePath, { readOnly: true });
	const pdb = getProfilesDb();
	const nameIndex = buildNameIndex(pdb);

	const limit = Math.max(1, Math.min(opts.limit || 5000, 50_000));
	const params: Array<string | number> = [];
	let sql = `
    SELECT d.id, d.title, d.url, d.raw_text, d.updated_at, p.name AS project_name
    FROM documents d
    JOIN projects p ON p.id = d.project_id
    WHERE d.raw_text LIKE '%Grantor:%' OR d.raw_text LIKE '%Grantee:%'
       OR d.raw_text LIKE '%Buyer:%' OR d.raw_text LIKE '%Seller:%'
  `;
	if (opts.sinceIso) {
		sql += ` AND datetime(d.updated_at) >= datetime(?)`;
		params.push(opts.sinceIso);
	}
	if (opts.projectNameIncludes) {
		sql += ` AND lower(p.name) LIKE ?`;
		params.push(`%${opts.projectNameIncludes.toLowerCase()}%`);
	}
	sql += ` ORDER BY datetime(d.updated_at) DESC LIMIT ?`;
	params.push(limit);

	const docs = kdb.prepare(sql).all(...params) as Array<{
		id: string;
		title: string;
		url: string | null;
		raw_text: string;
		updated_at: string;
		project_name: string;
	}>;

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
			if (!hits?.length) {
				report.unmatchedParties += 1;
				continue;
			}
			// Ambiguous exact name (multiple profiles) — skip rather than guess.
			if (hits.length > 1) {
				report.unmatchedParties += 1;
				continue;
			}
			const profileId = hits[0];
			report.matches += 1;
			if (opts.dryRun) continue;

			const recorded =
				doc.raw_text.match(/Recorded:\s*(.+)/i)?.[1]?.trim() ||
				doc.updated_at?.slice(0, 10) ||
				null;
			upsertTimelineEntry(
				{
					profileId,
					entryKind: 'observation',
					title: `${doc.project_name}: ${instrument} (${party.role})`,
					summary: `${party.role}: ${party.name}. Exact name match on county deed / land record.`,
					eventDate: recorded ? recorded.slice(0, 10) : null,
					angle: 'land_records',
					sourceCorpus: 'knowledge-sqlite',
					dedupeHint: `deed:${doc.id}:${party.role}:${norm}`,
				},
				pdb,
			);
			report.timelineWrites += 1;

			// Property content lives on Timeline (land_records) and overview ## Land Deeds.
			// Do not attach okcr_instrument URL identifiers — they clutter Sources & Identifiers.

		}
	}

	try {
		kdb.close();
	} catch {
		/* ignore */
	}
	return report;
}
