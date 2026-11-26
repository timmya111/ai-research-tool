/**
 * Associate county deed / OKCR knowledge documents to entity profiles when
 * Grantor/Grantee (or Dallas party) script names exactly match a profile name
 * or a strict name-like alias (normalized) — including under-title **other names**.
 *
 * Safe by design: exact normalized name / other_name / former_name / legal_name only —
 * no fuzzy absorb. Short ambiguous kinds (slug, acronym, ticker, crd) are excluded.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeText } from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import { upsertTimelineEntry } from '@/lib/research/profiles/store';

const PARTY_LINE_RE =
	/^-\s*(Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\s*:\s*(.+)$/gim;

/** Alias kinds allowed as strict deed party keys (exact normalized equality). */
const DEED_MATCH_ALIAS_KINDS = new Set([
	'name',
	'other_name',
	'former_name',
	'formerly',
	'aka',
	'legal_name',
]);

/** Alias kinds that must never drive deed association (too short / not a party name). */
const DEED_MATCH_ALIAS_EXCLUDE = new Set(['slug', 'acronym', 'ticker', 'crd']);

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
	// Strict name keys: canonical name aliases + under-title other names (+ former/legal).
	// Re-normalize raw `alias` so stale normalized_alias rows still match party lines.
	for (const row of db
		.prepare(
			`SELECT profile_id AS id, alias, normalized_alias AS n, alias_kind AS kind
       FROM profile_aliases`,
		)
		.all() as Array<{ id: string; alias: string; n: string; kind: string | null }>) {
		const kind = String(row.kind || 'name').trim().toLowerCase() || 'name';
		if (DEED_MATCH_ALIAS_EXCLUDE.has(kind)) continue;
		if (row.kind != null && row.kind !== '' && !DEED_MATCH_ALIAS_KINDS.has(kind)) continue;
		const profileId = String(row.id);
		push(String(row.n || ''), profileId);
		push(normalizeText(row.alias || ''), profileId);
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

export type AssociateTylerJsonlOptions = {
	/** Directory containing records/RP/YYYY/*.jsonl (e.g. .data/rockwall-deeds). */
	deedsDir: string;
	/** County label for timeline titles (e.g. "Rockwall County"). */
	countyLabel: string;
	/** Max JSONL rows to scan (default all). */
	limit?: number;
	dryRun?: boolean;
};

function parseTylerRecordedDate(raw: unknown): string | null {
	const s = String(raw || '').trim();
	if (!s) return null;
	// 05/08/2024 03:34 PM  or  2024-05-08
	const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
	if (iso) return iso[1];
	const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (mdy) {
		const mm = mdy[1].padStart(2, '0');
		const dd = mdy[2].padStart(2, '0');
		return `${mdy[3]}-${mm}-${dd}`;
	}
	return null;
}

function asNameList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
	if (typeof v === 'string' && v.trim()) return [v.trim()];
	return [];
}

/**
 * Associate Tyler self-service index JSONL (grantor/grantee arrays) to profiles
 * with the same strict exact-name rules as knowledge deed docs.
 */
export function associateTylerJsonlToProfiles(
	opts: AssociateTylerJsonlOptions,
): AssociateDeedsReport {
	const report: AssociateDeedsReport = {
		documentsScanned: 0,
		partiesParsed: 0,
		matches: 0,
		timelineWrites: 0,
		identifierWrites: 0,
		unmatchedParties: 0,
	};
	const root = pathResolveDeedsRp(opts.deedsDir);
	if (!root || !fs.existsSync(root)) return report;

	const pdb = getProfilesDb();
	const nameIndex = buildNameIndex(pdb);
	const county = String(opts.countyLabel || 'Tyler County').trim() || 'Tyler County';
	const limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;

	const years = fs
		.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();

	outer: for (const year of years) {
		const yearDir = `${root}/${year}`;
		const files = fs
			.readdirSync(yearDir)
			.filter((n) => n.endsWith('.jsonl'))
			.sort();
		for (const file of files) {
			const full = `${yearDir}/${file}`;
			const text = fs.readFileSync(full, 'utf8');
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				if (report.documentsScanned >= limit) break outer;
				let rec: Record<string, unknown>;
				try {
					rec = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				report.documentsScanned += 1;
				const docId = String(rec.id || rec.docNumber || `${file}:${report.documentsScanned}`);
				const instrument = String(rec.docNumber || docId);
				const docType = String(rec.docType || 'Instrument');
				const recorded = parseTylerRecordedDate(rec.recordedDate);
				const parties: Array<{ role: string; name: string }> = [];
				for (const name of asNameList(rec.grantor)) parties.push({ role: 'Grantor', name });
				for (const name of asNameList(rec.grantee)) parties.push({ role: 'Grantee', name });
				report.partiesParsed += parties.length;

				for (const party of parties) {
					const norm = normalizeText(party.name);
					const hits = nameIndex.get(norm);
					if (!hits?.length) {
						report.unmatchedParties += 1;
						continue;
					}
					if (hits.length > 1) {
						report.unmatchedParties += 1;
						continue;
					}
					report.matches += 1;
					if (opts.dryRun) continue;
					upsertTimelineEntry(
						{
							profileId: hits[0],
							entryKind: 'observation',
							title: `${county}: ${docType} ${instrument} (${party.role})`,
							summary: `${party.role}: ${party.name}. Exact name match on ${county} Tyler index.`,
							eventDate: recorded,
							angle: 'land_records',
							sourceCorpus: 'tyler-deeds-jsonl',
							dedupeHint: `tyler:${county}:${docId}:${party.role}:${norm}`,
						},
						pdb,
					);
					report.timelineWrites += 1;
				}
			}
		}
	}
	return report;
}

function pathResolveDeedsRp(deedsDir: string): string | null {
	const base = String(deedsDir || '').trim();
	if (!base) return null;
	const rp = base.endsWith('/records/RP') || base.endsWith('/records/RP/')
		? base.replace(/\/$/, '')
		: `${base.replace(/\/$/, '')}/records/RP`;
	return rp;
}
