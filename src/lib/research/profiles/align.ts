import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import {
	dateToEpochDays,
	normalizeIsoDate,
	sha256Key,
	stripLegalSuffixes,
} from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import {
	rowToAlignment,
	upsertAlignmentCandidate,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import type {
	AlignmentCandidate,
	AlignmentEvidenceItem,
	AlignmentKind,
	AlignmentStatus,
	CautionTier,
} from '@/lib/research/profiles/types';

export type RunAlignmentPassOptions = {
	includeKnowledgeCrossMatch?: boolean;
	geoWindowDays?: number;
	maxCountyProfiles?: number;
};

export type AlignmentPassReport = {
	sharedIdentifier: number;
	sameEntityAlias: number;
	crossSourceMention: number;
	sharedAffiliation: number;
	geoTemporalCoOccurrence: number;
	angleComparison: number;
	countyFilingMatch: number;
	totalUpserted: number;
	durationMs: number;
};

const STOP_ALIAS_WORDS = new Set([
	'united states',
	'american',
	'national',
	'international',
	'global',
	'world',
	'federal',
	'state',
	'department',
	'institute',
	'university',
	'center',
	'foundation',
	'group',
	'capital',
	'partners',
	'holdings',
	'research',
	'science',
	'health',
	'covid',
	'coronavirus',
	'vaccine',
	'texas',
	'oklahoma',
	'dallas',
]);

function extractDateFromFiling(title: string, text: string): string | null {
	const hay = `${title}\n${text}`;
	const recMatch = hay.match(/(?:recorded|filed|date)[:\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
	if (recMatch) return normalizeIsoDate(recMatch[1]).date;
	const anyIso = hay.match(/\b(20[12]\d-\d{2}-\d{2})\b/);
	if (anyIso) return anyIso[1];
	const anySlash = hay.match(/\b(\d{1,2}\/\d{1,2}\/20[12]\d)\b/);
	if (anySlash) return normalizeIsoDate(anySlash[1]).date;
	return null;
}

/**
 * Scan the unified profiles store (and optionally read-only knowledge.sqlite) to
 * discover cross-source alignments, alias collisions, shared affiliations,
 * geo-temporal co-occurrences, multi-angle overlaps, and county-filing matches.
 */
export function runAlignmentPass(opts: RunAlignmentPassOptions = {}): AlignmentPassReport {
	const t0 = Date.now();
	const includeKnowledge = opts.includeKnowledgeCrossMatch !== false;
	const geoWindowDays = Math.max(1, Math.min(90, Number(opts.geoWindowDays ?? 14)));
	const maxCountyProfiles = Math.max(10, Math.min(250, Number(opts.maxCountyProfiles ?? 120)));

	const counts: AlignmentPassReport = {
		sharedIdentifier: 0,
		sameEntityAlias: 0,
		crossSourceMention: 0,
		sharedAffiliation: 0,
		geoTemporalCoOccurrence: 0,
		angleComparison: 0,
		countyFilingMatch: 0,
		totalUpserted: 0,
		durationMs: 0,
	};

	const db = getProfilesDb();

	// 1. Shared Identifiers (exact CRD / CIK / Ticker / EIN / URL across different profiles)
	const sharedIdentRows = db
		.prepare(
			`SELECT a.profile_id AS p1, b.profile_id AS p2, a.scheme, a.value,
              p1.name AS n1, p2.name AS n2, a.source_corpus AS c1, b.source_corpus AS c2
       FROM profile_identifiers a
       JOIN profile_identifiers b
         ON a.scheme = b.scheme AND a.normalized_value = b.normalized_value AND a.profile_id < b.profile_id
       JOIN profiles p1 ON p1.id = a.profile_id
       JOIN profiles p2 ON p2.id = b.profile_id
       LIMIT 300`,
		)
		.all() as Array<Record<string, unknown>>;

	// 2. Same Entity Alias / Stripped Legal Name across distinct profiles
	const aliasGroups = db
		.prepare(
			`SELECT pa.normalized_alias, pa.profile_id, p.name, p.profile_type, pa.source_corpus
       FROM profile_aliases pa
       JOIN profiles p ON p.id = pa.profile_id
       WHERE length(pa.normalized_alias) >= 5`,
		)
		.all() as Array<Record<string, unknown>>;

	const byNormKey = new Map<
		string,
		Array<{ profileId: string; name: string; profileType: string; corpus: string }>
	>();
	for (const r of aliasGroups) {
		const rawNorm = String(r.normalized_alias);
		const keys = new Set<string>([rawNorm]);
		const stripped = stripLegalSuffixes(rawNorm);
		if (stripped.length >= 6 && stripped !== rawNorm) keys.add(stripped);

		for (const k of keys) {
			if (STOP_ALIAS_WORDS.has(k) || k.length < 5) continue;
			const list = byNormKey.get(k) || [];
			if (!list.some((x) => x.profileId === String(r.profile_id))) {
				list.push({
					profileId: String(r.profile_id),
					name: String(r.name),
					profileType: String(r.profile_type),
					corpus: String(r.source_corpus || 'unknown'),
				});
			}
			byNormKey.set(k, list);
		}
	}

	// 3. Cross-Source Mentions (single canonical profile present in >= 2 distinct corpora)
	const allProfiles = db
		.prepare('SELECT id, name, slug, profile_type, status, metadata_json FROM profiles')
		.all() as Array<Record<string, unknown>>;

	// 4. Shared Affiliations across DIFFERENT corpora
	const sharedAffilRows = db
		.prepare(
			`SELECT l1.from_profile_id AS p1, l2.from_profile_id AS p2, l1.to_profile_id AS hub_id,
              hub.name AS hub_name, hub.profile_type AS hub_type,
              l1.source_corpus AS c1, l2.source_corpus AS c2,
              l1.role_label AS r1, l2.role_label AS r2,
              a1.name AS n1, a2.name AS n2
       FROM profile_links l1
       JOIN profile_links l2
         ON l1.to_profile_id = l2.to_profile_id
        AND l1.from_profile_id < l2.from_profile_id
        AND l1.source_corpus != l2.source_corpus
       JOIN profiles hub ON hub.id = l1.to_profile_id
       JOIN profiles a1 ON a1.id = l1.from_profile_id
       JOIN profiles a2 ON a2.id = l2.from_profile_id
       WHERE hub.profile_type IN ('firm', 'education', 'nonprofit', 'medical_hospital', 'government', 'foreign')
         AND a1.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital')
         AND a2.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital')
       LIMIT 250`,
		)
		.all() as Array<Record<string, unknown>>;

	// 5. Geo-Temporal Co-Occurrence (timeline entries sharing geo_key within geoWindowDays across different corpora)
	const geoTimelineRows = db
		.prepare(
			`SELECT te.id, te.profile_id, te.event_date, te.title, te.angle, te.geo_key, te.geo_label,
              te.source_corpus, p.name AS profile_name, p.profile_type
       FROM timeline_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.geo_key IS NOT NULL
         AND te.event_date IS NOT NULL
         AND length(te.event_date) >= 10
       ORDER BY te.geo_key, te.event_date ASC`,
		)
		.all() as Array<Record<string, unknown>>;

	// 6. Multi-Angle Overlaps on historic_event / actor profiles
	const multiAngleRows = db
		.prepare(
			`SELECT p.id, p.name, p.profile_type,
              substr(te.event_date, 1, 7) AS ym,
              COUNT(DISTINCT te.angle) AS angle_count,
              COUNT(DISTINCT te.source_corpus) AS corpus_count,
              GROUP_CONCAT(DISTINCT te.angle) AS angles,
              GROUP_CONCAT(DISTINCT te.source_corpus) AS corpora,
              COUNT(*) AS entry_count
       FROM timeline_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.event_date IS NOT NULL AND length(te.event_date) >= 7
       GROUP BY p.id, ym
       HAVING angle_count >= 2 OR corpus_count >= 2
       ORDER BY angle_count DESC, entry_count DESC
       LIMIT 120`,
		)
		.all() as Array<Record<string, unknown>>;

	withProfilesTransaction((tx) => {
		// Commit (1) Shared Identifiers
		for (const r of sharedIdentRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			const scheme = String(r.scheme);
			const value = String(r.value);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['shared_identifier', p1, p2, scheme, value]),
					alignmentKind: 'shared_identifier',
					leftProfileId: p1,
					rightProfileId: p2,
					score: 0.96,
					cautionTier: 'stronger_indicator',
					rationale: `Exact shared identifier ${scheme}=${value} between "${String(r.n1)}" and "${String(r.n2)}".`,
					evidence: [
						{ corpus: String(r.c1 || 'profiles'), label: `${String(r.n1)} (${scheme}: ${value})` },
						{ corpus: String(r.c2 || 'profiles'), label: `${String(r.n2)} (${scheme}: ${value})` },
					],
				},
				tx,
			);
			counts.sharedIdentifier += 1;
		}

		// Commit (2) Same Entity Alias across distinct profiles
		let aliasCount = 0;
		for (const [normKey, group] of byNormKey.entries()) {
			if (group.length < 2 || group.length > 6) continue;
			for (let i = 0; i < group.length; i++) {
				for (let j = i + 1; j < group.length; j++) {
					if (aliasCount >= 250) break;
					const a = group[i];
					const b = group[j];
					const [left, right] = a.profileId < b.profileId ? [a, b] : [b, a];
					const sameType = left.profileType === right.profileType;
					const crossCorpus = left.corpus !== right.corpus;
					const score = (sameType ? 0.78 : 0.62) + (crossCorpus ? 0.1 : 0);
					upsertAlignmentCandidate(
						{
							dedupeKey: sha256Key(['same_entity_alias', left.profileId, right.profileId, normKey]),
							alignmentKind: 'same_entity_alias',
							leftProfileId: left.profileId,
							rightProfileId: right.profileId,
							score,
							cautionTier: score >= 0.82 ? 'closer_look' : 'observation',
							rationale: `Shared normalized name/alias "${normKey}" across "${left.name}" (${left.profileType}, ${left.corpus}) and "${right.name}" (${right.profileType}, ${right.corpus}).`,
							evidence: [
								{ corpus: left.corpus, label: `${left.name} [${left.profileType}]` },
								{ corpus: right.corpus, label: `${right.name} [${right.profileType}]` },
							],
						},
						tx,
					);
					counts.sameEntityAlias += 1;
					aliasCount += 1;
				}
			}
		}

		// Commit (3) Cross-Source Mentions (same canonical profile enriched by >=2 corpora)
		for (const p of allProfiles) {
			let corpora: string[] = [];
			try {
				const meta = JSON.parse(String(p.metadata_json || '{}')) as Record<string, unknown>;
				if (Array.isArray(meta.corpora)) corpora = [...new Set(meta.corpora.map(String))];
			} catch {
				/* ignore */
			}
			if (corpora.length < 2) continue;
			const pid = String(p.id);
			const score = Math.min(0.95, 0.65 + corpora.length * 0.1);
			const tier: CautionTier = corpora.length >= 3 ? 'stronger_indicator' : 'closer_look';
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['cross_source_mention', pid]),
					alignmentKind: 'cross_source_mention',
					leftProfileId: pid,
					rightProfileId: null,
					score,
					cautionTier: tier,
					rationale: `"${String(p.name)}" (${String(p.profile_type)}) appears across ${corpora.length} distinct data sources: ${corpora.join(', ')}.`,
					evidence: corpora.map((c) => ({ corpus: c, label: `Present in ${c}` })),
				},
				tx,
			);
			counts.crossSourceMention += 1;
		}

		// Commit (4) Shared Affiliations across different corpora
		for (const r of sharedAffilRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			const hubName = String(r.hub_name);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['shared_affiliation', p1, p2, String(r.hub_id)]),
					alignmentKind: 'shared_affiliation',
					leftProfileId: p1,
					rightProfileId: p2,
					score: 0.72,
					cautionTier: 'observation',
					rationale: `"${String(r.n1)}" (${String(r.c1)}) and "${String(r.n2)}" (${String(r.c2)}) both connect to ${hubName} (${String(r.hub_type)}).`,
					evidence: [
						{ corpus: String(r.c1), label: `${String(r.n1)} → ${hubName}${r.r1 ? ` (${String(r.r1)})` : ''}` },
						{ corpus: String(r.c2), label: `${String(r.n2)} → ${hubName}${r.r2 ? ` (${String(r.r2)})` : ''}` },
					],
				},
				tx,
			);
			counts.sharedAffiliation += 1;
		}

		// Commit (5) Geo-Temporal Co-Occurrence
		const byGeo = new Map<string, Array<Record<string, unknown>>>();
		for (const r of geoTimelineRows) {
			const gk = String(r.geo_key);
			// Skip country-only buckets to avoid noisy coincidences; focus on city/county/state level
			if (gk.startsWith('country:') || gk.startsWith('raw:')) continue;
			const list = byGeo.get(gk) || [];
			list.push(r);
			byGeo.set(gk, list);
		}

		let geoAdded = 0;
		for (const [geoKey, list] of byGeo.entries()) {
			if (list.length < 2 || geoAdded >= 180) continue;
			for (let i = 0; i < list.length && geoAdded < 180; i++) {
				const a = list[i];
				const dayA = dateToEpochDays(String(a.event_date));
				if (dayA == null) continue;
				for (let j = i + 1; j < list.length && geoAdded < 180; j++) {
					const b = list[j];
					const dayB = dateToEpochDays(String(b.event_date));
					if (dayB == null) continue;
					const diff = Math.abs(dayB - dayA);
					if (diff > geoWindowDays) break;
					if (String(a.source_corpus) === String(b.source_corpus)) continue;
					if (String(a.profile_id) === String(b.profile_id)) continue;

					const [left, right] =
						String(a.profile_id) < String(b.profile_id) ? [a, b] : [b, a];
					const score = Number((0.68 - (diff / (geoWindowDays + 1)) * 0.18).toFixed(3));
					upsertAlignmentCandidate(
						{
							dedupeKey: sha256Key([
								'co_occurrence_time_geo',
								String(left.profile_id),
								String(right.profile_id),
								geoKey,
								String(left.event_date).slice(0, 7),
							]),
							alignmentKind: 'co_occurrence_time_geo',
							leftProfileId: String(left.profile_id),
							rightProfileId: String(right.profile_id),
							score,
							cautionTier: 'observation',
							rationale: `Geo-temporal overlap (${diff}d apart) in ${String(left.geo_label || geoKey)} between ${String(left.source_corpus)} ("${String(left.title).slice(0, 70)}") and ${String(right.source_corpus)} ("${String(right.title).slice(0, 70)}").`,
							evidence: [
								{
									corpus: String(left.source_corpus),
									label: String(left.title).slice(0, 120),
									date: String(left.event_date),
									geoKey,
								},
								{
									corpus: String(right.source_corpus),
									label: String(right.title).slice(0, 120),
									date: String(right.event_date),
									geoKey,
								},
							],
						},
						tx,
					);
					counts.geoTemporalCoOccurrence += 1;
					geoAdded += 1;
				}
			}
		}

		// Commit (6) Multi-Angle Comparisons
		for (const r of multiAngleRows) {
			const pid = String(r.id);
			const ym = String(r.ym);
			const angles = String(r.angles || '').split(',').filter(Boolean);
			const corpora = String(r.corpora || '').split(',').filter(Boolean);
			const n = Number(r.entry_count || 0);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['angle_comparison', pid, ym]),
					alignmentKind: 'angle_comparison',
					leftProfileId: pid,
					rightProfileId: null,
					score: Math.min(0.92, 0.65 + angles.length * 0.08),
					cautionTier: 'closer_look',
					rationale: `Multi-angle coverage on "${String(r.name)}" in ${ym}: ${n} entries across ${angles.length} angles (${angles.join(', ')}) from ${corpora.join(', ')}.`,
					evidence: corpora.map((c) => ({
						corpus: c,
						label: `${ym} coverage (${angles.join(' / ')})`,
						date: ym,
					})),
				},
				tx,
			);
			counts.angleComparison += 1;
		}
	});

	// 7. Read-only FTS5 cross-match against knowledge.sqlite (Bryan/Cherokee/Adair/Sequoyah/Dallas filings + Research Drive)
	const kPath = getKnowledgeSqlitePath();
	if (includeKnowledge && fs.existsSync(kPath)) {
		let kdb: DatabaseSync | null = null;
		try {
			kdb = new DatabaseSync(kPath, { readOnly: true });
			// Focus on pinned + high-signal firms, nonprofits, universities, and people (avoid matching 5,000 generic rows)
			const candidateProfiles = db
				.prepare(
					`SELECT p.id, p.name, p.slug, p.profile_type, p.status
           FROM profiles p
           WHERE p.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital', 'government')
             AND length(p.normalized_name) >= 5
           ORDER BY
             CASE p.status WHEN 'pinned' THEN 0 ELSE 1 END,
             CASE p.profile_type
               WHEN 'firm' THEN 0
               WHEN 'medical_hospital' THEN 1
               WHEN 'nonprofit' THEN 2
               WHEN 'education' THEN 3
               WHEN 'government' THEN 4
               ELSE 5
             END,
             (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) DESC
           LIMIT ?`,
				)
				.all(maxCountyProfiles) as Array<Record<string, unknown>>;

			const stmt = kdb.prepare(
				`SELECT d.id AS doc_id, d.title, d.url, p.name AS project_name, substr(c.text, 1, 300) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         JOIN projects p ON p.id = d.project_id
         WHERE chunks_fts MATCH ?
           AND p.name IN ('Bryan County', 'Cherokee County', 'Adair County', 'Sequoyah County', 'Dallas County Deeds', 'Research Drive')
         LIMIT 8`,
			);

			const matchesToCommit: Array<{
				profileId: string;
				profileName: string;
				profileType: string;
				hits: Array<{
					docId: string;
					title: string;
					url: string | null;
					projectName: string;
					snippet: string;
					date: string | null;
				}>;
			}> = [];

			for (const cp of candidateProfiles) {
				const rawName = String(cp.name || '').trim();
				// Require >= 2 tokens or >= 8 chars to avoid false-positive single common words
				const tokens = rawName
					.replace(/["'*^(){}[\]:]/g, ' ')
					.split(/[^a-zA-Z0-9]+/)
					.filter((t) => t.length >= 2);
				if (tokens.length === 0) continue;
				if (tokens.length === 1 && tokens[0].length < 8) continue;
				if (STOP_ALIAS_WORDS.has(tokens.join(' ').toLowerCase())) continue;

				// Exact phrase query in FTS5 for high precision!
				const phraseQuery = `"${tokens.join(' ')}"`;
				try {
					const rows = stmt.all(phraseQuery) as Array<Record<string, unknown>>;
					if (!rows.length) continue;
					const seenDoc = new Set<string>();
					const hits: Array<{
						docId: string;
						title: string;
						url: string | null;
						projectName: string;
						snippet: string;
						date: string | null;
					}> = [];
					for (const r of rows) {
						const docId = String(r.doc_id);
						if (seenDoc.has(docId)) continue;
						seenDoc.add(docId);
						const title = String(r.title || '');
						const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim();
						hits.push({
							docId,
							title,
							url: r.url != null ? String(r.url) : null,
							projectName: String(r.project_name || 'knowledge'),
							snippet,
							date: extractDateFromFiling(title, snippet),
						});
					}
					if (hits.length > 0) {
						matchesToCommit.push({
							profileId: String(cp.id),
							profileName: rawName,
							profileType: String(cp.profile_type),
							hits,
						});
					}
				} catch {
					/* skip invalid FTS phrase */
				}
			}

			if (matchesToCommit.length > 0) {
				withProfilesTransaction((tx) => {
					for (const m of matchesToCommit) {
						const projects = [...new Set(m.hits.map((h) => h.projectName))];
						const evidence: AlignmentEvidenceItem[] = m.hits.slice(0, 6).map((h) => ({
							corpus: `knowledge:${h.projectName}`,
							label: h.title.slice(0, 120),
							date: h.date,
							url: h.url,
							sourceRef: `knowledge:doc:${h.docId}`,
							snippet: h.snippet.slice(0, 200),
						}));

						upsertAlignmentCandidate(
							{
								dedupeKey: sha256Key(['county_filing_match', m.profileId]),
								alignmentKind: 'county_filing_match',
								leftProfileId: m.profileId,
								rightProfileId: null,
								score: Math.min(0.9, 0.62 + m.hits.length * 0.05),
								cautionTier: m.hits.length >= 3 ? 'closer_look' : 'observation',
								rationale: `Exact phrase "${m.profileName}" matched ${m.hits.length} record(s) in local knowledge store (${projects.join(', ')}). Treat as name-match lead until verified by party/address.`,
								evidence,
							},
							tx,
						);
						counts.countyFilingMatch += 1;

						// Also attach dated land-record observations to the actor's timeline!
						for (const h of m.hits.slice(0, 3)) {
							const srId = upsertSourceRecord(
								{
									corpus: 'knowledge-sqlite',
									sourceRef: `knowledge:doc:${h.docId}`,
									sourceUrl: h.url,
									title: `[${h.projectName}] ${h.title}`,
									publishedDate: h.date,
									excerpt: h.snippet,
									metadata: { projectName: h.projectName, docId: h.docId },
								},
								tx,
							);
							upsertTimelineEntry(
								{
									profileId: m.profileId,
									eventDate: h.date,
									title: `[${h.projectName}] ${h.title}`,
									summary: h.snippet,
									angle: /county|deeds/i.test(h.projectName) ? 'land_records' : 'general',
									entryKind: 'filing',
									confidence: 0.65,
									sourceCorpus: 'knowledge-sqlite',
									sourceRecordId: srId,
									dedupeHint: `kdoc:${h.docId}`,
								},
								tx,
							);
						}
					}
				});
			}
		} catch {
			/* knowledge.sqlite unavailable or locked; skip cleanly */
		} finally {
			if (kdb) {
				try {
					kdb.close();
				} catch {
					/* ignore */
				}
			}
		}
	}

	counts.totalUpserted =
		counts.sharedIdentifier +
		counts.sameEntityAlias +
		counts.crossSourceMention +
		counts.sharedAffiliation +
		counts.geoTemporalCoOccurrence +
		counts.angleComparison +
		counts.countyFilingMatch;
	counts.durationMs = Date.now() - t0;

	return counts;
}

export type ListAlignmentsFilter = {
	profileId?: string;
	alignmentKind?: AlignmentKind;
	status?: AlignmentStatus;
	cautionTier?: CautionTier;
	minScore?: number;
	limit?: number;
	offset?: number;
};

export function listAlignments(filter: ListAlignmentsFilter = {}): {
	alignments: AlignmentCandidate[];
	total: number;
} {
	const db = getProfilesDb();
	const limit = Math.max(1, Math.min(200, Math.floor(Number(filter.limit ?? 50))));
	const offset = Math.max(0, Math.floor(Number(filter.offset ?? 0)));

	const where: string[] = [];
	const params: Array<string | number> = [];

	if (filter.profileId) {
		where.push('(ac.left_profile_id = ? OR ac.right_profile_id = ?)');
		params.push(filter.profileId, filter.profileId);
	}
	if (filter.alignmentKind) {
		where.push('ac.alignment_kind = ?');
		params.push(filter.alignmentKind);
	}
	if (filter.status) {
		where.push('ac.status = ?');
		params.push(filter.status);
	}
	if (filter.cautionTier) {
		where.push('ac.caution_tier = ?');
		params.push(filter.cautionTier);
	}
	if (typeof filter.minScore === 'number' && Number.isFinite(filter.minScore)) {
		where.push('ac.score >= ?');
		params.push(filter.minScore);
	}

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const total = Number(
		(
			db
				.prepare(`SELECT COUNT(*) AS c FROM alignment_candidates ac ${whereSql}`)
				.get(...params) as { c?: number }
		)?.c || 0,
	);

	const rows = db
		.prepare(
			`SELECT ac.*,
              lp.name AS left_name, lp.slug AS left_slug, lp.profile_type AS left_type,
              rp.name AS right_name, rp.slug AS right_slug, rp.profile_type AS right_type
       FROM alignment_candidates ac
       JOIN profiles lp ON lp.id = ac.left_profile_id
       LEFT JOIN profiles rp ON rp.id = ac.right_profile_id
       ${whereSql}
       ORDER BY
         CASE ac.status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
         ac.score DESC,
         ac.updated_at DESC
       LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Array<Record<string, unknown>>;

	return {
		alignments: rows.map(rowToAlignment),
		total,
	};
}
