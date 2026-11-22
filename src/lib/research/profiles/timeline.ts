import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	buildSafeFtsQuery,
	dateToEpochDays,
	normalizeIsoDate,
} from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import { getProfile, rowToTimeline } from '@/lib/research/profiles/store';
import type {
	GapFillLead,
	ProfileTimelineResult,
	TimelineEntry,
	TimelineGap,
} from '@/lib/research/profiles/types';

export type GetProfileTimelineOptions = {
	from?: string;
	to?: string;
	angle?: string;
	corpus?: string;
	includeLinkedEvents?: boolean;
	detectGaps?: boolean;
	minGapDays?: number;
	fillFromKnowledge?: boolean;
	limit?: number;
};

function openKnowledgeReadOnly(): DatabaseSync | null {
	const p = getKnowledgeSqlitePath();
	if (!fs.existsSync(p)) return null;
	try {
		return new DatabaseSync(p, { readOnly: true });
	} catch {
		return null;
	}
}

function searchKnowledgeForGap(
	kdb: DatabaseSync,
	keywords: string[],
	fromDate: string,
	toDate: string,
	maxHits = 4,
): GapFillLead[] {
	const fts = buildSafeFtsQuery(keywords.join(' '));
	if (!fts) return [];

	const fromYear = fromDate.slice(0, 4);
	const toYear = toDate.slice(0, 4);

	try {
		const rows = kdb
			.prepare(
				`SELECT d.id, d.title, d.url, p.name AS project_name, substr(c.text, 1, 320) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         JOIN projects p ON p.id = d.project_id
         WHERE chunks_fts MATCH ?
         LIMIT 24`,
			)
			.all(fts) as Array<Record<string, unknown>>;

		const leads: GapFillLead[] = [];
		const seenDoc = new Set<string>();
		const minDay = dateToEpochDays(fromDate);
		const maxDay = dateToEpochDays(toDate);

		for (const r of rows) {
			const docId = String(r.id || '');
			if (!docId || seenDoc.has(docId)) continue;
			const text = `${String(r.title || '')} ${String(r.snippet || '')}`;
			// Look for an explicit date in the title/snippet that falls inside the gap window
			const dateMatches = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/g) || [];
			let matchedDate: string | null = null;
			for (const dm of dateMatches) {
				const norm = normalizeIsoDate(dm).date;
				const ed = dateToEpochDays(norm);
				if (norm && ed != null && minDay != null && maxDay != null && ed >= minDay && ed <= maxDay) {
					matchedDate = norm;
					break;
				}
			}
			// Fallback: if no day-level date, accept matching year in title/snippet if gap spans months
			if (!matchedDate && (text.includes(fromYear) || text.includes(toYear))) {
				const ym = text.match(/\b(20\d{2}-\d{2})\b/);
				if (ym) {
					const ed = dateToEpochDays(ym[1]);
					if (ed != null && minDay != null && maxDay != null && ed >= minDay && ed <= maxDay) {
						matchedDate = ym[1];
					}
				}
			}
			if (!matchedDate) continue;

			seenDoc.add(docId);
			leads.push({
				source: 'knowledge_sqlite',
				corpus: `knowledge:${String(r.project_name || 'Default')}`,
				date: matchedDate,
				title: String(r.title || 'Knowledge document'),
				angle: /county|deeds/i.test(String(r.project_name || '')) ? 'land_records' : 'general',
				snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 260),
				reason: `Knowledge store FTS hit dated ${matchedDate} inside ${fromDate}→${toDate} gap`,
				sourceRef: `knowledge:doc:${docId}`,
				url: r.url != null ? String(r.url) : null,
			});
			if (leads.length >= maxHits) break;
		}
		return leads;
	} catch {
		return [];
	}
}

/**
 * Retrieve a merged multi-source timeline for any profile (especially subject_matter
 * or historic_event), compute angle/corpus breakdowns, detect chronological gaps,
 * and surface cross-source gap-fill leads.
 */
export function getProfileTimeline(
	idOrSlug: string,
	opts: GetProfileTimelineOptions = {},
): ProfileTimelineResult | null {
	const db = getProfilesDb();
	const profile = getProfile(idOrSlug, db);
	if (!profile) return null;

	const includeLinked = opts.includeLinkedEvents !== false;
	const detectGaps = opts.detectGaps !== false;
	const fillFromKnowledge = opts.fillFromKnowledge !== false;
	const minGapDays = Math.max(7, Math.min(3650, Math.floor(Number(opts.minGapDays ?? 30))));
	const limit = Math.max(10, Math.min(500, Math.floor(Number(opts.limit ?? 200))));

	// Collect direct profileId + linked historic_event / related child profile IDs
	const targetIds = new Set<string>([profile.id]);
	const relatedActorIds = new Set<string>([profile.id]);
	if (includeLinked) {
		const linkRows = db
			.prepare(
				`SELECT pl.from_profile_id, pl.to_profile_id, pl.relation_type,
                fp.profile_type AS from_type, tp.profile_type AS to_type
         FROM profile_links pl
         JOIN profiles fp ON fp.id = pl.from_profile_id
         JOIN profiles tp ON tp.id = pl.to_profile_id
         WHERE pl.from_profile_id = ? OR pl.to_profile_id = ?
         LIMIT 600`,
			)
			.all(profile.id, profile.id) as Array<Record<string, unknown>>;

		for (const lr of linkRows) {
			const otherId =
				String(lr.from_profile_id) === profile.id
					? String(lr.to_profile_id)
					: String(lr.from_profile_id);
			const otherType =
				String(lr.from_profile_id) === profile.id ? String(lr.to_type) : String(lr.from_type);
			const rel = String(lr.relation_type);

			relatedActorIds.add(otherId);

			// Merge timelines from child historic events, parent subjects, or direct participations
			if (
				otherType === 'historic_event' ||
				rel === 'part_of_subject' ||
				rel === 'participated_in' ||
				(profile.profileType !== 'subject_matter' && rel === 'mentioned_in')
			) {
				targetIds.add(otherId);
			}
		}
	}

	const idList = [...targetIds].slice(0, 400);
	const placeholders = idList.map(() => '?').join(',');
	const where: string[] = [`te.profile_id IN (${placeholders})`];
	const params: Array<string | number> = [...idList];

	if (opts.from) {
		where.push('te.event_date >= ?');
		params.push(opts.from);
	}
	if (opts.to) {
		where.push('te.event_date <= ?');
		params.push(opts.to);
	}
	if (opts.angle) {
		where.push('te.angle = ?');
		params.push(opts.angle);
	}
	if (opts.corpus) {
		where.push('te.source_corpus = ?');
		params.push(opts.corpus);
	}

	const rows = db
		.prepare(
			`SELECT te.*, sr.source_url, sr.source_ref,
              op.id AS origin_profile_id, op.name AS origin_profile_name, op.profile_type AS origin_profile_type
       FROM timeline_entries te
       LEFT JOIN source_records sr ON sr.id = te.source_record_id
       JOIN profiles op ON op.id = te.profile_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(te.event_date, '9999-99-99') ASC, te.created_at ASC`,
		)
		.all(...params) as Array<Record<string, unknown>>;

	// Deduplicate identical entries (same date + corpus + normalized title) when merged from child events
	const deduped: TimelineEntry[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		const entry = rowToTimeline(r);
		const key = `${entry.sourceCorpus}|${entry.eventDate || ''}|${entry.title.toLowerCase().slice(0, 90)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}

	const totalEntries = deduped.length;
	const entries = deduped.slice(0, limit);

	// Breakdowns by angle, corpus, and overlapping multi-angle months
	const angleMap = new Map<string, { count: number; corpora: Set<string> }>();
	const corpusMap = new Map<string, { count: number; angles: Set<string> }>();
	const monthMap = new Map<string, { angles: Set<string>; corpora: Set<string>; count: number }>();

	let minDate: string | null = null;
	let maxDate: string | null = null;

	for (const e of deduped) {
		const a = angleMap.get(e.angle) || { count: 0, corpora: new Set<string>() };
		a.count += 1;
		a.corpora.add(e.sourceCorpus);
		angleMap.set(e.angle, a);

		const c = corpusMap.get(e.sourceCorpus) || { count: 0, angles: new Set<string>() };
		c.count += 1;
		c.angles.add(e.angle);
		corpusMap.set(e.sourceCorpus, c);

		if (e.eventDate) {
			if (!minDate || e.eventDate < minDate) minDate = e.eventDate;
			if (!maxDate || e.eventDate > maxDate) maxDate = e.eventDate;
			if (e.eventDate.length >= 7) {
				const ym = e.eventDate.slice(0, 7);
				const mm = monthMap.get(ym) || { angles: new Set<string>(), corpora: new Set<string>(), count: 0 };
				mm.angles.add(e.angle);
				mm.corpora.add(e.sourceCorpus);
				mm.count += 1;
				monthMap.set(ym, mm);
			}
		}
	}

	const angleBreakdown = [...angleMap.entries()]
		.map(([angle, v]) => ({ angle, count: v.count, corpora: [...v.corpora].sort() }))
		.sort((a, b) => b.count - a.count);

	const corpusBreakdown = [...corpusMap.entries()]
		.map(([corpus, v]) => ({ corpus, count: v.count, angles: [...v.angles].sort() }))
		.sort((a, b) => b.count - a.count);

	const overlappingWindows = [...monthMap.entries()]
		.filter(([, v]) => v.angles.size >= 2 || v.corpora.size >= 2)
		.map(([month, v]) => ({
			month,
			angles: [...v.angles].sort(),
			corpora: [...v.corpora].sort(),
			count: v.count,
		}))
		.sort((a, b) => a.month.localeCompare(b.month));

	// Timeline Gap Detection + Cross-Source Gap-Fill Leads
	const gaps: TimelineGap[] = [];
	if (detectGaps) {
		const dated = deduped
			.map((e) => ({ entry: e, day: dateToEpochDays(e.eventDate) }))
			.filter((x): x is { entry: TimelineEntry; day: number } => x.day != null && Boolean(x.entry.eventDate))
			.sort((a, b) => a.day - b.day);

		// Collect profile geo keys + aliases for gap-fill matching
		const geoRows = db
			.prepare('SELECT DISTINCT geo_key FROM profile_locations WHERE profile_id = ?')
			.all(profile.id) as Array<{ geo_key: string }>;
		const geoKeys = new Set<string>(geoRows.map((g) => String(g.geo_key)));
		for (const e of deduped) {
			if (e.geoKey) geoKeys.add(e.geoKey);
		}

		const aliasRows = db
			.prepare('SELECT alias FROM profile_aliases WHERE profile_id = ? LIMIT 8')
			.all(profile.id) as Array<{ alias: string }>;
		const searchKeywords = [
			profile.name,
			...aliasRows.map((a) => String(a.alias)),
		].filter((s) => s.length >= 3);

		const existingCorpora = new Set(deduped.map((e) => e.sourceCorpus));

		// Identify top gaps (cap at 10 largest/chronological gaps for speed & clarity)
		const rawGaps: Array<{
			fromDate: string;
			toDate: string;
			gapDays: number;
			before: TimelineEntry;
			after: TimelineEntry;
		}> = [];

		for (let i = 0; i < dated.length - 1; i++) {
			const diff = dated[i + 1].day - dated[i].day;
			if (diff >= minGapDays) {
				rawGaps.push({
					fromDate: dated[i].entry.eventDate!,
					toDate: dated[i + 1].entry.eventDate!,
					gapDays: diff,
					before: dated[i].entry,
					after: dated[i + 1].entry,
				});
			}
		}

		// Prioritize the largest gaps (up to 8) then sort chronologically
		const topGaps = rawGaps
			.sort((a, b) => b.gapDays - a.gapDays)
			.slice(0, 8)
			.sort((a, b) => a.fromDate.localeCompare(b.fromDate));

		const kdb = fillFromKnowledge && topGaps.length > 0 ? openKnowledgeReadOnly() : null;
		const geoKeyList = [...geoKeys].slice(0, 20);
		const relatedIdList = [...relatedActorIds].filter((id) => !targetIds.has(id)).slice(0, 80);

		try {
			for (const g of topGaps) {
				const fillLeads: GapFillLead[] = [];
				const seenLead = new Set<string>();

				// 1. Other timeline entries in profiles.sqlite during this exact gap matching geo_key OR related actors
				if (geoKeyList.length > 0) {
					const gp = geoKeyList.map(() => '?').join(',');
					const geoHits = db
						.prepare(
							`SELECT te.*, p.slug AS p_slug, p.name AS p_name, sr.source_url, sr.source_ref
               FROM timeline_entries te
               JOIN profiles p ON p.id = te.profile_id
               LEFT JOIN source_records sr ON sr.id = te.source_record_id
               WHERE te.event_date > ? AND te.event_date < ?
                 AND te.geo_key IN (${gp})
                 AND te.profile_id NOT IN (${placeholders})
               ORDER BY te.event_date ASC
               LIMIT 6`,
						)
						.all(g.fromDate, g.toDate, ...geoKeyList, ...idList) as Array<Record<string, unknown>>;

					for (const h of geoHits) {
						const k = `p:${String(h.id)}`;
						if (seenLead.has(k)) continue;
						seenLead.add(k);
						fillLeads.push({
							source: 'profiles',
							corpus: String(h.source_corpus),
							date: h.event_date != null ? String(h.event_date) : null,
							title: String(h.title),
							angle: String(h.angle || 'general'),
							snippet: String(h.summary || '').slice(0, 240),
							reason: `Shared geography (${String(h.geo_label || h.geo_key)}) in ${String(h.source_corpus)} during gap`,
							profileId: String(h.profile_id),
							profileSlug: String(h.p_slug),
							profileName: String(h.p_name),
							sourceRef: h.source_ref != null ? String(h.source_ref) : null,
							url: h.source_url != null ? String(h.source_url) : null,
							geoLabel: h.geo_label != null ? String(h.geo_label) : null,
						});
					}
				}

				// 2. Timeline entries from related actors (people/firms/agencies linked to this subject/event)
				if (relatedIdList.length > 0 && fillLeads.length < 6) {
					const rp = relatedIdList.map(() => '?').join(',');
					const relHits = db
						.prepare(
							`SELECT te.*, p.slug AS p_slug, p.name AS p_name, sr.source_url, sr.source_ref
               FROM timeline_entries te
               JOIN profiles p ON p.id = te.profile_id
               LEFT JOIN source_records sr ON sr.id = te.source_record_id
               WHERE te.event_date > ? AND te.event_date < ?
                 AND te.profile_id IN (${rp})
               ORDER BY te.event_date ASC
               LIMIT 6`,
						)
						.all(g.fromDate, g.toDate, ...relatedIdList) as Array<Record<string, unknown>>;

					for (const h of relHits) {
						const k = `p:${String(h.id)}`;
						if (seenLead.has(k)) continue;
						seenLead.add(k);
						fillLeads.push({
							source: 'profiles',
							corpus: String(h.source_corpus),
							date: h.event_date != null ? String(h.event_date) : null,
							title: String(h.title),
							angle: String(h.angle || 'general'),
							snippet: String(h.summary || '').slice(0, 240),
							reason: `Linked actor (${String(h.p_name)}) active in ${String(h.source_corpus)} during gap`,
							profileId: String(h.profile_id),
							profileSlug: String(h.p_slug),
							profileName: String(h.p_name),
							sourceRef: h.source_ref != null ? String(h.source_ref) : null,
							url: h.source_url != null ? String(h.source_url) : null,
							geoLabel: h.geo_label != null ? String(h.geo_label) : null,
						});
					}
				}

				// 3. FTS match in other timeline entries from OTHER corpora during this gap
				const ftsQ = buildSafeFtsQuery(searchKeywords.slice(0, 4).join(' '));
				if (ftsQ && fillLeads.length < 8) {
					try {
						const ftsHits = db
							.prepare(
								`SELECT te.*, p.slug AS p_slug, p.name AS p_name, sr.source_url, sr.source_ref
                 FROM timeline_entries_fts f
                 JOIN timeline_entries te ON te.rowid = f.rowid
                 JOIN profiles p ON p.id = te.profile_id
                 LEFT JOIN source_records sr ON sr.id = te.source_record_id
                 WHERE timeline_entries_fts MATCH ?
                   AND te.event_date > ? AND te.event_date < ?
                   AND te.profile_id NOT IN (${placeholders})
                 ORDER BY te.event_date ASC
                 LIMIT 6`,
							)
							.all(ftsQ, g.fromDate, g.toDate, ...idList) as Array<Record<string, unknown>>;

						for (const h of ftsHits) {
							const k = `p:${String(h.id)}`;
							if (seenLead.has(k)) continue;
							seenLead.add(k);
							const otherCorpus = !existingCorpora.has(String(h.source_corpus));
							fillLeads.push({
								source: 'profiles',
								corpus: String(h.source_corpus),
								date: h.event_date != null ? String(h.event_date) : null,
								title: String(h.title),
								angle: String(h.angle || 'general'),
								snippet: String(h.summary || '').slice(0, 240),
								reason: otherCorpus
									? `Cross-corpus keyword hit in ${String(h.source_corpus)} (${String(h.angle)}) during gap`
									: `Related keyword hit in ${String(h.p_name)} during gap`,
								profileId: String(h.profile_id),
								profileSlug: String(h.p_slug),
								profileName: String(h.p_name),
								sourceRef: h.source_ref != null ? String(h.source_ref) : null,
								url: h.source_url != null ? String(h.source_url) : null,
								geoLabel: h.geo_label != null ? String(h.geo_label) : null,
							});
						}
					} catch {
						/* ignore FTS syntax edge cases */
					}
				}

				// 4. Read-only FTS5 match in knowledge.sqlite during this gap
				if (kdb && fillLeads.length < 10) {
					const kLeads = searchKnowledgeForGap(
						kdb,
						searchKeywords.slice(0, 3),
						g.fromDate,
						g.toDate,
						3,
					);
					for (const kl of kLeads) {
						fillLeads.push(kl);
					}
				}

				gaps.push({
					fromDate: g.fromDate,
					toDate: g.toDate,
					gapDays: g.gapDays,
					beforeEntryTitle: g.before.title,
					afterEntryTitle: g.after.title,
					beforeCorpus: g.before.sourceCorpus,
					afterCorpus: g.after.sourceCorpus,
					fillLeads: fillLeads.slice(0, 10),
				});
			}
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

	return {
		profile,
		entries,
		totalEntries,
		dateRange: { min: minDate, max: maxDate },
		angleBreakdown,
		corpusBreakdown,
		gaps,
		overlappingWindows,
	};
}
