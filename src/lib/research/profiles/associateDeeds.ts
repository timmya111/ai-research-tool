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
import { normalizeIsoDate, normalizeText } from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import { upsertProfileLink, upsertTimelineEntry } from '@/lib/research/profiles/store';

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

/**
 * Generic single-word / boilerplate party strings that appear in county deed indexes
 * (e.g., Grantee: "PUBLIC", Grantor: "USA", "INTEGRITY") and must never match corporate aliases.
 */
const DEED_GENERIC_NAME_SKIP = new Set([
	'public',
	'usa',
	'u s a',
	'united states',
	'united states of america',
	'unknown',
	'none',
	'integrity',
	'state',
	'county',
	'city',
	'trust',
	'bank',
	'grantor',
	'grantee',
	'et al',
	'et ux',
	'et vir',
	'the public',
	'various',
	'self',
	'owner',
	'estate',
	'heirs',
]);

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
	linkWrites: number;
	/** Always 0 — okcr_instrument URL identifiers are no longer written. */
	identifierWrites: number;
	unmatchedParties: number;
};

type MatchedDeedParty = {
	profileId: string;
	role: string;
	name: string;
};

type DeedLinkMeta = {
	county: string;
	docType: string;
	instrument: string;
	recordedIso: string | null;
	book?: string;
	pages?: string;
	legal?: string;
	grantors?: string;
	grantees?: string;
	docKey: string;
};

function isSafeDeedPartyKey(norm: string): boolean {
	if (!norm || norm.length < 4) return false;
	if (DEED_GENERIC_NAME_SKIP.has(norm)) return false;
	// Require single-word party names to be at least 6 chars so short acronyms/words never collide
	if (!norm.includes(' ') && norm.length < 6) return false;
	return true;
}

function parseDeedRecordedIso(raw: unknown): string | null {
	const s = String(raw || '').trim();
	if (!s || /^unknown$/i.test(s)) return null;
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (mdy) {
		return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
	}
	const parsed = normalizeIsoDate(s);
	return parsed.date || null;
}

function extractFieldFromDeedText(rawText: string, label: string): string {
	// Stop at newline OR next inline OKCR "- Label:" delimiter (handles single-line timeline summaries)
	const m = rawText.match(
		new RegExp(`(?:-\\s*|^|\\s)${label}\\s*:\\s*(.+?)(?=\\n|\\s+-\\s+[A-Z][A-Za-z ]{1,24}:|\\s+Source:\\s+http|$)`, 'im'),
	);
	const val = m ? String(m[1] || '').trim() : '';
	return !val || /^unknown$/i.test(val) ? '' : val;
}

function buildDeedEvidenceNote(meta: DeedLinkMeta): string {
	const parts: string[] = [];
	const head = [meta.county, meta.docType, meta.instrument].filter(Boolean).join(' ');
	parts.push(meta.recordedIso ? `${head} (${meta.recordedIso})` : head);
	if (meta.grantors || meta.grantees) {
		parts.push(`Grantor: ${meta.grantors || '—'} → Grantee: ${meta.grantees || '—'}`);
	}
	if (meta.book || meta.pages) {
		parts.push(`Book/Pages: ${[meta.book, meta.pages].filter(Boolean).join(' / ')}`);
	}
	if (meta.legal) {
		parts.push(`Legal: ${meta.legal.replace(/\s+/g, ' ').slice(0, 140)}`);
	}
	return parts.join(' — ').slice(0, 360);
}

function linkMatchedDeedParties(
	matched: MatchedDeedParty[],
	meta: DeedLinkMeta,
	pdb: DatabaseSync,
): number {
	// Deduplicate by profileId (keep first role per profile on this instrument)
	const distinct: MatchedDeedParty[] = [];
	const seen = new Set<string>();
	for (const m of matched) {
		if (seen.has(m.profileId)) continue;
		seen.add(m.profileId);
		distinct.push(m);
	}
	if (distinct.length < 2) return 0;

	let writes = 0;
	const evidenceNote = buildDeedEvidenceNote(meta);
	for (let i = 0; i < distinct.length; i++) {
		for (let j = i + 1; j < distinct.length; j++) {
			const a = distinct[i]!;
			const b = distinct[j]!;
			const [first, second] = a.profileId < b.profileId ? [a, b] : [b, a];
			const rolePair =
				first.role.toLowerCase() === second.role.toLowerCase()
					? `Co-${first.role}`
					: `${first.role} ↔ ${second.role}`;
			const shortDoc = [meta.docType, meta.county].filter(Boolean).join(' · ');
			upsertProfileLink(
				{
					fromProfileId: first.profileId,
					toProfileId: second.profileId,
					relationType: 'business_tie',
					roleLabel: `Land deed: ${rolePair}${shortDoc ? ` (${shortDoc})` : ''}`.slice(0, 120),
					startDate: meta.recordedIso,
					status: 'observed',
					confidence: 0.9,
					angle: 'land_records',
					sourceCorpus: 'land-deed-associate',
					evidenceNote,
					dedupeHint: `deed-pair:${first.profileId}:${second.profileId}`,
				},
				pdb,
			);
			writes += 1;
		}
	}
	return writes;
}

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
		if (!isSafeDeedPartyKey(norm)) return;
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
 * as timeline entries and co-party Connected Profiles links with deed descriptions.
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
		linkWrites: 0,
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
		const county = extractFieldFromDeedText(doc.raw_text, 'County') || doc.project_name;
		const docType = extractFieldFromDeedText(doc.raw_text, 'Type');
		const recordedRaw =
			extractFieldFromDeedText(doc.raw_text, 'Recorded') ||
			doc.updated_at?.slice(0, 10) ||
			null;
		const recordedIso = parseDeedRecordedIso(recordedRaw);
		const book = extractFieldFromDeedText(doc.raw_text, 'Book');
		const pages = extractFieldFromDeedText(doc.raw_text, 'Pages');
		const legal = extractFieldFromDeedText(doc.raw_text, 'Legal');
		const grantors =
			extractFieldFromDeedText(doc.raw_text, 'Grantor') ||
			extractFieldFromDeedText(doc.raw_text, 'Grantors') ||
			extractFieldFromDeedText(doc.raw_text, 'Seller');
		const grantees =
			extractFieldFromDeedText(doc.raw_text, 'Grantee') ||
			extractFieldFromDeedText(doc.raw_text, 'Grantees') ||
			extractFieldFromDeedText(doc.raw_text, 'Buyer');

		const matchedParties: MatchedDeedParty[] = [];

		for (const party of parties) {
			const norm = normalizeText(party.name);
			if (!isSafeDeedPartyKey(norm)) {
				report.unmatchedParties += 1;
				continue;
			}
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
			const profileId = hits[0]!;
			report.matches += 1;
			matchedParties.push({ profileId, role: party.role, name: party.name });
			if (opts.dryRun) continue;

			upsertTimelineEntry(
				{
					profileId,
					entryKind: 'observation',
					title: `${doc.project_name}: ${instrument} (${party.role})`,
					summary: `${party.role}: ${party.name}. Exact name match on county deed / land record.`,
					eventDate: recordedIso || (recordedRaw ? recordedRaw.slice(0, 10) : null),
					angle: 'land_records',
					sourceCorpus: 'knowledge-sqlite',
					dedupeHint: `deed:${doc.id}:${party.role}:${norm}`,
				},
				pdb,
			);
			report.timelineWrites += 1;
		}

		if (!opts.dryRun && matchedParties.length >= 2) {
			report.linkWrites += linkMatchedDeedParties(
				matchedParties,
				{
					county,
					docType,
					instrument,
					recordedIso,
					book,
					pages,
					legal,
					grantors,
					grantees,
					docKey: `deed:${doc.id}`,
				},
				pdb,
			);
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
		linkWrites: 0,
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
				const grantorNames = asNameList(rec.grantor);
				const granteeNames = asNameList(rec.grantee);
				const parties: Array<{ role: string; name: string }> = [];
				for (const name of grantorNames) parties.push({ role: 'Grantor', name });
				for (const name of granteeNames) parties.push({ role: 'Grantee', name });
				report.partiesParsed += parties.length;

				const matchedParties: MatchedDeedParty[] = [];

				for (const party of parties) {
					const norm = normalizeText(party.name);
					if (!isSafeDeedPartyKey(norm)) {
						report.unmatchedParties += 1;
						continue;
					}
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
					matchedParties.push({ profileId: hits[0]!, role: party.role, name: party.name });
					if (opts.dryRun) continue;
					upsertTimelineEntry(
						{
							profileId: hits[0]!,
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

				if (!opts.dryRun && matchedParties.length >= 2) {
					report.linkWrites += linkMatchedDeedParties(
						matchedParties,
						{
							county,
							docType,
							instrument,
							recordedIso: recorded,
							book: String(rec.bookVolumePage || '').trim() || undefined,
							legal: asNameList(rec.legal).join('; ') || String(rec.legalDescription || '').trim() || undefined,
							grantors: grantorNames.join('; '),
							grantees: granteeNames.join('; '),
							docKey: `tyler:${county}:${docId}`,
						},
						pdb,
					);
				}
			}
		}
	}
	return report;
}

/**
 * Materialize Connected Profiles (`profile_links`) for all existing multi-profile land deed
 * matches already recorded in `timeline_entries` (angle='land_records') AND `## Land Deeds`
 * sections in `profiles.summary`, attaching the full deed description and filtering out
 * boilerplate party strings (e.g., PUBLIC, USA, INTEGRITY).
 */
export function syncExistingLandDeedLinks(opts?: { dryRun?: boolean }): {
	timelineDeedsGrouped: number;
	summaryDeedBulletsScanned: number;
	pairsLinked: number;
	skippedGenericMatches: number;
} {
	const pdb = getProfilesDb();
	const nameIndex = buildNameIndex(pdb);
	let timelineDeedsGrouped = 0;
	let summaryDeedBulletsScanned = 0;
	let skippedGenericMatches = 0;

	type PairAgg = {
		firstId: string;
		secondId: string;
		roleLabel: string;
		latestDate: string | null;
		latestDesc: string;
		count: number;
	};
	const pairMap = new Map<string, PairAgg>();

	const recordPair = (
		aId: string,
		aRole: string,
		bId: string,
		bRole: string,
		docTypeCounty: string,
		dateIso: string | null,
		desc: string,
	) => {
		if (aId === bId) return;
		const [firstId, firstRole, secondId, secondRole] =
			aId < bId ? [aId, aRole, bId, bRole] : [bId, bRole, aId, aRole];
		const key = `${firstId}|${secondId}`;
		const rolePair =
			firstRole.toLowerCase() === secondRole.toLowerCase()
				? `Co-${firstRole}`
				: `${firstRole} ↔ ${secondRole}`;
		const roleLabel = `Land deed: ${rolePair}${docTypeCounty ? ` (${docTypeCounty})` : ''}`.slice(0, 120);
		const prev = pairMap.get(key);
		if (!prev) {
			pairMap.set(key, {
				firstId,
				secondId,
				roleLabel,
				latestDate: dateIso,
				latestDesc: desc,
				count: 1,
			});
		} else {
			prev.count += 1;
			if (dateIso && (!prev.latestDate || dateIso > prev.latestDate)) {
				prev.latestDate = dateIso;
				prev.latestDesc = desc;
				prev.roleLabel = roleLabel;
			}
		}
	};

	// 1. Group existing land_records timeline entries by deed document
	const tlRows = pdb
		.prepare(
			`SELECT t.profile_id, t.title, t.summary, t.event_date, t.source_corpus
       FROM timeline_entries t
       WHERE t.angle = 'land_records'`,
		)
		.all() as Array<{
		profile_id: string;
		title: string;
		summary: string;
		event_date: string | null;
		source_corpus: string;
	}>;

	const byDoc = new Map<
		string,
		Array<{
			profileId: string;
			role: string;
			partyName: string;
			baseTitle: string;
			summary: string;
			eventDate: string | null;
		}>
	>();

	for (const r of tlRows) {
		const rawTitle = String(r.title || '').trim();
		const roleM = rawTitle.match(/\((Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\)\s*$/i);
		const role = roleM ? roleM[1]! : 'Party';
		const baseTitle = rawTitle
			.replace(/\s*\((?:Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\)\s*$/i, '')
			.trim();
		const partyM = String(r.summary || '').match(
			/^(?:Grantor|Grantee|Grantors|Grantees|Buyer|Seller|Borrower|Lender)\s*:\s*([^.\n]+)/i,
		);
		const partyName = partyM ? partyM[1]!.trim() : '';
		if (partyName && !isSafeDeedPartyKey(normalizeText(partyName))) {
			skippedGenericMatches += 1;
			continue;
		}
		const docKey = `${r.source_corpus}|${baseTitle}|${r.event_date || ''}`;
		let arr = byDoc.get(docKey);
		if (!arr) {
			arr = [];
			byDoc.set(docKey, arr);
		}
		arr.push({
			profileId: r.profile_id,
			role,
			partyName,
			baseTitle,
			summary: String(r.summary || ''),
			eventDate: parseDeedRecordedIso(r.event_date),
		});
	}

	for (const [, arr] of byDoc) {
		const distinct = new Map<string, (typeof arr)[number]>();
		for (const item of arr) {
			if (!distinct.has(item.profileId)) distinct.set(item.profileId, item);
		}
		if (distinct.size < 2) continue;
		timelineDeedsGrouped += 1;
		const list = [...distinct.values()];
		const sample = list[0]!;
		// Extract cleaner description if full OKCR filing text is embedded in summary
		const county =
			extractFieldFromDeedText(sample.summary, 'County') ||
			sample.baseTitle.match(/^\[([^\]]+)\]/)?.[1] ||
			sample.baseTitle.split(':')[0]?.trim() ||
			'';
		const docType = extractFieldFromDeedText(sample.summary, 'Type');
		const legal = extractFieldFromDeedText(sample.summary, 'Legal');
		const isFullOkcrSummary = /-\s*Instrument:/i.test(sample.summary);
		const grantor = isFullOkcrSummary ? extractFieldFromDeedText(sample.summary, 'Grantor') : '';
		const grantee = isFullOkcrSummary ? extractFieldFromDeedText(sample.summary, 'Grantee') : '';
		const partySummary =
			grantor || grantee
				? `Grantor: ${grantor || '—'} → Grantee: ${grantee || '—'}`
				: list
						.map((x) => {
							const cleanParty = x.partyName.replace(/\.\s*Exact name match.*$/i, '').trim();
							return `${x.role}: ${cleanParty || x.profileId}`;
						})
						.join('; ');
		const desc = [
			sample.eventDate ? `${sample.baseTitle} (${sample.eventDate})` : sample.baseTitle,
			partySummary,
			legal ? `Legal: ${legal.slice(0, 120)}` : '',
		]
			.filter(Boolean)
			.join(' — ')
			.slice(0, 340);
		const docTypeCounty = [docType, county].filter(Boolean).join(' · ');

		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				recordPair(
					list[i]!.profileId,
					list[i]!.role,
					list[j]!.profileId,
					list[j]!.role,
					docTypeCounty,
					sample.eventDate,
					desc,
				);
			}
		}
	}

	// 1b. Also scan embedded Grantor/Grantee fields inside full OKCR timeline summaries
	// so counterparties in profiles.sqlite are linked even if only one side had a timeline entry.
	for (const r of tlRows) {
		const sum = String(r.summary || '');
		if (!/-\s*Instrument:/i.test(sum)) continue;
		const county = extractFieldFromDeedText(sum, 'County') || String(r.title || '').match(/^\[([^\]]+)\]/)?.[1] || '';
		const docType = extractFieldFromDeedText(sum, 'Type');
		const instrument = extractFieldFromDeedText(sum, 'Instrument');
		const legal = extractFieldFromDeedText(sum, 'Legal');
		const grantorRaw = extractFieldFromDeedText(sum, 'Grantor');
		const granteeRaw = extractFieldFromDeedText(sum, 'Grantee');
		const dateIso = parseDeedRecordedIso(r.event_date);
		const checkSide = (sideRaw: string, sideRole: string) => {
			if (!sideRaw) return;
			for (const part of sideRaw.split(/[;/|]/)) {
				const norm = normalizeText(part);
				if (!isSafeDeedPartyKey(norm)) continue;
				const hits = nameIndex.get(norm);
				if (!hits || hits.length !== 1) continue;
				const peerId = hits[0]!;
				if (peerId === r.profile_id) continue;
				const otherRole = sideRole === 'Grantor' ? 'Grantee' : 'Grantor';
				const head = [county, docType, instrument].filter(Boolean).join(' ') || String(r.title || '');
				const desc = [
					dateIso ? `${head} (${dateIso})` : head,
					`Grantor: ${grantorRaw || '—'} → Grantee: ${granteeRaw || '—'}`,
					legal ? `Legal: ${legal.slice(0, 120)}` : '',
				]
					.filter(Boolean)
					.join(' — ')
					.slice(0, 340);
				recordPair(
					r.profile_id,
					otherRole,
					peerId,
					sideRole,
					[docType, county].filter(Boolean).join(' · '),
					dateIso,
					desc,
				);
			}
		};
		checkSide(grantorRaw, 'Grantor');
		checkSide(granteeRaw, 'Grantee');
	}

	// 2. Also scan ## Land Deeds markdown sections inside profiles.summary for exact Grantor/Grantee matches
	const summaryRows = pdb
		.prepare(`SELECT id, name, summary FROM profiles WHERE summary LIKE '%## Land Deeds%'`)
		.all() as Array<{ id: string; name: string; summary: string }>;

	for (const prof of summaryRows) {
		const idx = prof.summary.indexOf('## Land Deeds');
		if (idx === -1) continue;
		const section = prof.summary.slice(idx);
		let currentCounty = '';
		for (const line of section.split('\n')) {
			const h3 = line.match(/^###\s+([^(]+?)(?:\s*\(\d+\))?\s*$/);
			if (h3) {
				currentCounty = h3[1]!.trim();
				continue;
			}
			// - **2024-03-05** — WD (`I-2024-001`) *(Cargill grantor)*: GRANTOR A → GRANTEE B · _Legal_
			const bm = line.match(/^-\s+\*\*([^*]+)\*\*\s+[—–-]\s+([^:]+):\s*(.+?)\s*(?:→|->)\s*(.+)$/);
			if (!bm) continue;
			summaryDeedBulletsScanned += 1;
			const dateIso = parseDeedRecordedIso(bm[1]);
			const docHead = bm[2]!.replace(/\*\([^)]*\)\*/g, '').replace(/`/g, '').trim();
			const grantorRaw = bm[3]!.trim();
			const granteePart = bm[4]!.split('·')[0]!.trim();
			const legalPart = bm[4]!.includes('·')
				? bm[4]!.split('·').slice(1).join('·').replace(/_/g, '').trim()
				: '';

			const checkSide = (sideRaw: string, role: string) => {
				for (const part of sideRaw.split(/[;/|]/)) {
					const norm = normalizeText(part);
					if (!isSafeDeedPartyKey(norm)) continue;
					const hits = nameIndex.get(norm);
					if (!hits || hits.length !== 1) continue;
					const peerId = hits[0]!;
					if (peerId === prof.id) continue;
					const otherRole = role === 'Grantor' ? 'Grantee' : 'Grantor';
					const desc = [
						`${currentCounty ? `${currentCounty} ` : ''}${docHead}${dateIso ? ` (${dateIso})` : ''}`,
						`Grantor: ${grantorRaw} → Grantee: ${granteePart}`,
						legalPart ? `Legal: ${legalPart.slice(0, 120)}` : '',
					]
						.filter(Boolean)
						.join(' — ')
						.slice(0, 340);
					recordPair(
						prof.id,
						otherRole,
						peerId,
						role,
						[docHead.split(' ')[0] || '', currentCounty].filter(Boolean).join(' · '),
						dateIso,
						desc,
					);
				}
			};
			checkSide(grantorRaw, 'Grantor');
			checkSide(granteePart, 'Grantee');
		}
	}

	let pairsLinked = 0;
	if (!opts?.dryRun) {
		for (const agg of pairMap.values()) {
			const suffix = agg.count > 1 ? ` (+${agg.count - 1} more recorded land deed${agg.count - 1 === 1 ? '' : 's'})` : '';
			upsertProfileLink(
				{
					fromProfileId: agg.firstId,
					toProfileId: agg.secondId,
					relationType: 'business_tie',
					roleLabel: agg.roleLabel,
					startDate: agg.latestDate,
					status: 'observed',
					confidence: 0.9,
					angle: 'land_records',
					sourceCorpus: 'land-deed-associate',
					evidenceNote: `${agg.latestDesc}${suffix}`.slice(0, 380),
					dedupeHint: `land-deed-pair:${agg.firstId}:${agg.secondId}`,
				},
				pdb,
			);
			pairsLinked += 1;
		}
	} else {
		pairsLinked = pairMap.size;
	}

	return {
		timelineDeedsGrouped,
		summaryDeedBulletsScanned,
		pairsLinked,
		skippedGenericMatches,
	};
}

function pathResolveDeedsRp(deedsDir: string): string | null {
	const base = String(deedsDir || '').trim();
	if (!base) return null;
	const rp = base.endsWith('/records/RP') || base.endsWith('/records/RP/')
		? base.replace(/\/$/, '')
		: `${base.replace(/\/$/, '')}/records/RP`;
	return rp;
}
