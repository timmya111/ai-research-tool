import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { isCityLevelGeoKey } from '@/lib/research/profiles/edgeWeights';
import {
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

/**
 * Tokens that must never drive gap-fill FTS alone — they match unrelated
 * "World Cup games", "poker games", ICE "take down", etc.
 * Do not run aliases through stripLegalSuffixes (it turns "Take-Two" into
 * "take two" and then "take" matches every take-down headline).
 */
const GAP_FILL_STOP_TOKENS = new Set([
	'company',
	'corporation',
	'corp',
	'inc',
	'llc',
	'ltd',
	'group',
	'holdings',
	'partners',
	'capital',
	'services',
	'solutions',
	'systems',
	'technologies',
	'international',
	'global',
	'american',
	'national',
	'united',
	'the',
	'and',
	'of',
	'software',
	'games',
	'game',
	'gaming',
	'interactive',
	'entertainment',
	'studio',
	'studios',
	'music',
	'media',
	'digital',
	'online',
	'network',
	'networks',
	'label',
	'publishing',
	'division',
	'formerly',
	'former',
	'take',
	'make',
	'made',
	'based',
	'north',
	'south',
	'east',
	'west',
	'city',
	'street',
	'auto', // alone — "Grand Theft Auto" stays as a phrase
	'theft',
	'grand',
]);

type GapFillSearchTerms = { phrases: string[]; tokens: string[] };

/** Light cleanup that keeps hyphenated brands like Take-Two intact. */
function cleanGapFillAlias(raw: string): string {
	return String(raw || '')
		.replace(/\b(incorporated|inc|llc|ltd|corp|corporation|company|co|plc|lp|llp)\b\.?/gi, ' ')
		.replace(/[^\w\s-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectGapFillSearchTerms(name: string, aliases: string[]): GapFillSearchTerms {
	const phrases: string[] = [];
	const tokens: string[] = [];
	const seen = new Set<string>();

	for (const raw of [name, ...aliases]) {
		const cleaned = cleanGapFillAlias(raw);
		if (cleaned.length < 3) continue;
		const parts = cleaned.split(/\s+/).filter(Boolean);
		const distinctive = parts.filter((p) => {
			const compact = p.toLowerCase().replace(/[^a-z0-9]/g, '');
			return compact.length >= 3 && !GAP_FILL_STOP_TOKENS.has(compact) && !GAP_FILL_STOP_TOKENS.has(p.toLowerCase());
		});
		if (!distinctive.length) continue;

		const phraseKey = cleaned.toLowerCase();
		if (parts.length >= 2 && !seen.has(`p:${phraseKey}`)) {
			seen.add(`p:${phraseKey}`);
			phrases.push(cleaned);
		}
		for (const d of distinctive) {
			// Keep hyphens (take-two); FTS gets a quoted token, post-filter matches the brand.
			const t = d.toLowerCase().replace(/[^a-z0-9-]/g, '');
			const compact = t.replace(/[^a-z0-9]/g, '');
			const isShortTicker = parts.length === 1 && /^[a-z0-9]{2,5}$/.test(compact);
			// Require 5+ chars unless it is a short ticker/alias like TTWO / BMG.
			if ((!isShortTicker && compact.length < 5) || seen.has(`t:${t}`)) continue;
			if (GAP_FILL_STOP_TOKENS.has(compact) || GAP_FILL_STOP_TOKENS.has(t)) continue;
			seen.add(`t:${t}`);
			tokens.push(t);
		}
	}
	return { phrases: phrases.slice(0, 6), tokens: tokens.slice(0, 8) };
}

/** FTS5 OR of distinctive phrases/tokens — never bare stopwords like "games". */
function buildGapFillFtsQuery(terms: GapFillSearchTerms): string {
	const parts: string[] = [];
	for (const p of terms.phrases) {
		const safe = p.replace(/"/g, '').trim();
		if (safe.length >= 3) parts.push(`"${safe}"`);
	}
	for (const t of terms.tokens) {
		if (t.length >= 4) parts.push(`"${t}"`);
	}
	// Prefer phrases (company + employee full names) over bare tokens.
	return [...new Set(parts)].slice(0, 24).join(' OR ');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Require title/snippet/profileName to mention a distinctive subject token/phrase. */
function leadMentionsSubject(lead: GapFillLead, terms: GapFillSearchTerms): boolean {
	if (!terms.phrases.length && !terms.tokens.length) return false;
	const hay = `${lead.title || ''} ${lead.snippet || ''} ${lead.profileName || ''}`.toLowerCase();
	for (const p of terms.phrases) {
		const pl = p.toLowerCase();
		if (hay.includes(pl) || hay.includes(pl.replace(/-/g, ' '))) return true;
	}
	for (const t of terms.tokens) {
		// Hyphenated brands: match "take-two" / "take two" / "taketwo", never bare "take".
		const variants = t.includes('-')
			? [t, t.replace(/-/g, ' '), t.replace(/-/g, '')]
			: [t];
		for (const v of variants) {
			if (v.length < 3) continue;
			const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(v)}(?:[^a-z0-9]|$)`, 'i');
			if (re.test(hay)) return true;
		}
	}
	return false;
}

/**
 * People employed at a firm (or employers of a person) via employment links.
 * Used so gap-fill may accept leads that name those people / companies.
 */
function employmentConnectionNames(
	db: DatabaseSync,
	profileId: string,
	profileType: string,
): string[] {
	const wantPerson = profileType === 'firm' || profileType === 'nonprofit' || profileType === 'medical_hospital';
	const wantOrg = profileType === 'person';
	if (!wantPerson && !wantOrg) return [];

	const rows = db
		.prepare(
			`SELECT p.name AS name, p.profile_type AS ptype
       FROM profile_links pl
       JOIN profiles p ON p.id = CASE
         WHEN pl.from_profile_id = ? THEN pl.to_profile_id
         ELSE pl.from_profile_id
       END
       WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
         AND pl.relation_type IN ('employed_by', 'affiliated_with')
       LIMIT 120`,
		)
		.all(profileId, profileId, profileId) as Array<{ name: string; ptype: string }>;

	const out: string[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		const name = String(r.name || '').trim();
		const ptype = String(r.ptype || '');
		if (name.length < 5) continue;
		if (wantPerson && ptype !== 'person') continue;
		if (wantOrg && ptype === 'person') continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

/** Add full person/org names as phrases only (avoid tokenizing common surnames). */
function addEmploymentConnectionPhrases(terms: GapFillSearchTerms, names: string[]): void {
	const seen = new Set(terms.phrases.map((p) => p.toLowerCase()));
	for (const name of names.slice(0, 40)) {
		const cleaned = cleanGapFillAlias(name);
		if (cleaned.length < 5) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		terms.phrases.push(cleaned);
	}
	terms.phrases = terms.phrases.slice(0, 30);
}

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

export type LinkedHistoricEventHit = { id: string; slug: string; name: string };

export function normTimelineTitle(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/^\[[^\]]+\]\s*/, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function normalizeSourceUrl(raw?: string | null): string | null {
	const s = String(raw || '')
		.trim()
		.replace(/\/+$/, '');
	if (!s) return null;
	try {
		const u = new URL(s);
		u.hash = '';
		return u.toString().replace(/\/+$/, '');
	} catch {
		return s;
	}
}

/** Exact, prefix, long shared prefix, or shared EO / Operation label. */
export function historicEventTitlesMatch(a: string, b: string): boolean {
	const na = normTimelineTitle(a);
	const nb = normTimelineTitle(b);
	if (!na || !nb || na.length < 8 || nb.length < 8) return false;
	if (na === nb) return true;
	if (na.startsWith(nb) || nb.startsWith(na)) return true;
	let i = 0;
	const lim = Math.min(na.length, nb.length);
	while (i < lim && na[i] === nb[i]) i += 1;
	if (i >= 36) return true;
	const eoA = na.match(/\beo\s*(\d{4,5})\b/);
	const eoB = nb.match(/\beo\s*(\d{4,5})\b/);
	if (eoA && eoB && eoA[1] === eoB[1]) return true;
	const opA = na.match(/\boperation\s+([a-z0-9][a-z0-9 -]{2,40})/);
	const opB = nb.match(/\boperation\s+([a-z0-9][a-z0-9 -]{2,40})/);
	if (opA && opB && opA[1].trim() === opB[1].trim()) return true;
	return false;
}

function lookupHistoricEventByTitle(
	db: DatabaseSync,
	title: string,
	excludeProfileId?: string | null,
): LinkedHistoricEventHit | null {
	const stripped = String(title || '')
		.replace(/^\[[^\]]+\]\s*/, '')
		.trim();
	if (stripped.length < 8) return null;
	const like = `${stripped.slice(0, 72)}%`;
	const eo = stripped.match(/\bEO\s*(\d{4,5})\b/i);
	const op = stripped.match(/\bOperation\s+([A-Za-z0-9][A-Za-z0-9 -]{2,40})/i);
	const rows = db
		.prepare(
			`SELECT id, slug, name FROM profiles
       WHERE profile_type = 'historic_event'
         AND status IN ('active', 'pinned')
         AND (? IS NULL OR id != ?)
         AND (
           name = ? OR normalized_name = ? OR name LIKE ? OR name LIKE ?
           OR (? IS NOT NULL AND name LIKE ?)
           OR (? IS NOT NULL AND name LIKE ?)
         )
       LIMIT 12`,
		)
		.all(
			excludeProfileId || null,
			excludeProfileId || null,
			stripped.slice(0, 160),
			normTimelineTitle(stripped).slice(0, 160),
			like,
			`%${stripped.slice(0, 48)}%`,
			eo ? 1 : null,
			eo ? `%EO ${eo[1]}%` : null,
			op ? 1 : null,
			op ? `%Operation ${op[1].trim().slice(0, 40)}%` : null,
		) as Array<Record<string, unknown>>;
	for (const r of rows) {
		const hit: LinkedHistoricEventHit = {
			id: String(r.id),
			slug: String(r.slug),
			name: String(r.name),
		};
		if (excludeProfileId && hit.id === excludeProfileId) continue;
		if (historicEventTitlesMatch(stripped, hit.name) || historicEventTitlesMatch(title, hit.name)) {
			return hit;
		}
	}
	return null;
}

function lookupHistoricEventByUrl(
	db: DatabaseSync,
	rawUrl: string,
	excludeProfileId?: string | null,
): LinkedHistoricEventHit | null {
	const url = normalizeSourceUrl(rawUrl);
	if (!url) return null;
	const viaId = db
		.prepare(
			`SELECT p.id, p.slug, p.name
       FROM profile_identifiers i
       JOIN profiles p ON p.id = i.profile_id
       WHERE p.profile_type = 'historic_event'
         AND p.status IN ('active', 'pinned')
         AND (? IS NULL OR p.id != ?)
         AND i.scheme = 'url'
         AND (i.value = ? OR rtrim(i.value, '/') = ?)
       LIMIT 1`,
		)
		.get(excludeProfileId || null, excludeProfileId || null, url, url) as
		| Record<string, unknown>
		| undefined;
	if (viaId?.id) {
		return { id: String(viaId.id), slug: String(viaId.slug), name: String(viaId.name) };
	}
	const needle = url.replace(/^https?:\/\//, '');
	const viaMeta = db
		.prepare(
			`SELECT id, slug, name FROM profiles
       WHERE profile_type = 'historic_event'
         AND status IN ('active', 'pinned')
         AND (? IS NULL OR id != ?)
         AND metadata_json LIKE ?
       LIMIT 1`,
		)
		.get(excludeProfileId || null, excludeProfileId || null, `%${needle}%`) as
		| Record<string, unknown>
		| undefined;
	if (viaMeta?.id) {
		return { id: String(viaMeta.id), slug: String(viaMeta.slug), name: String(viaMeta.name) };
	}
	return null;
}

/**
 * Resolve historic_event profiles for free-text titles / source URLs (Overview rail + tools).
 * Never returns the excluded profile.
 */
export function resolveHistoricEventLinks(
	titles: string[],
	opts: { excludeProfileId?: string | null; urls?: string[] } = {},
): Array<{ query: string; hit: LinkedHistoricEventHit | null }> {
	const db = getProfilesDb();
	const exclude = opts.excludeProfileId || null;
	const out: Array<{ query: string; hit: LinkedHistoricEventHit | null }> = [];
	const seen = new Set<string>();
	for (const raw of titles) {
		const q = String(raw || '').trim();
		if (!q || seen.has(q)) continue;
		seen.add(q);
		out.push({ query: q, hit: lookupHistoricEventByTitle(db, q, exclude) });
	}
	for (const raw of opts.urls || []) {
		const q = String(raw || '').trim();
		if (!q || seen.has(`url:${q}`)) continue;
		seen.add(`url:${q}`);
		out.push({ query: q, hit: lookupHistoricEventByUrl(db, q, exclude) });
	}
	return out;
}

/**
 * Attach linkedProfile* for in-app title navigation when an entry maps to another
 * historic_event (origin owner, exact/near title, or source URL). Never links to self.
 */
function attachLinkedEventProfiles(
	db: DatabaseSync,
	entries: TimelineEntry[],
	currentProfileId: string,
): void {
	if (!entries.length) return;

	for (const entry of entries) {
		let hit: LinkedHistoricEventHit | null = null;
		if (
			entry.originProfileId &&
			entry.originProfileId !== currentProfileId &&
			entry.originProfileSlug
		) {
			hit = {
				id: entry.originProfileId,
				slug: entry.originProfileSlug,
				name: entry.originProfileName || entry.title,
			};
		}
		if (!hit) {
			const metaId =
				entry.metadata && typeof entry.metadata.linkedProfileId === 'string'
					? entry.metadata.linkedProfileId
					: null;
			if (metaId && metaId !== currentProfileId) {
				const row = db
					.prepare(
						`SELECT id, slug, name FROM profiles WHERE id = ? AND profile_type = 'historic_event' LIMIT 1`,
					)
					.get(metaId) as Record<string, unknown> | undefined;
				if (row?.id) {
					hit = { id: String(row.id), slug: String(row.slug), name: String(row.name) };
				}
			}
		}
		if (!hit && entry.sourceUrl) {
			hit = lookupHistoricEventByUrl(db, entry.sourceUrl, currentProfileId);
		}
		if (!hit) {
			hit = lookupHistoricEventByTitle(db, entry.title, currentProfileId);
		}
		if (!hit || hit.id === currentProfileId) continue;
		entry.linkedProfileId = hit.id;
		entry.linkedProfileSlug = hit.slug;
		entry.linkedProfileName = hit.name;
	}
}

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
	terms: GapFillSearchTerms,
	fromDate: string,
	toDate: string,
	maxHits = 4,
): GapFillLead[] {
	const fts = buildGapFillFtsQuery(terms);
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

			const lead: GapFillLead = {
				source: 'knowledge_sqlite',
				corpus: `knowledge:${String(r.project_name || 'Default')}`,
				date: matchedDate,
				title: String(r.title || 'Knowledge document'),
				angle: /county|deeds/i.test(String(r.project_name || '')) ? 'land_records' : 'general',
				snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 260),
				reason: `Knowledge store FTS hit dated ${matchedDate} inside ${fromDate}→${toDate} gap`,
				sourceRef: `knowledge:doc:${docId}`,
				url: r.url != null ? String(r.url) : null,
			};
			if (!leadMentionsSubject(lead, terms)) continue;

			seenDoc.add(docId);
			leads.push(lead);
			if (leads.length >= maxHits) break;
		}
		return leads;
	} catch {
		return [];
	}
}

/**
 * Retrieve a merged multi-source timeline for any profile (especially historic_event),
 * compute angle/corpus breakdowns, detect chronological gaps,
 * and surface cross-source gap-fill leads.
 */
export function getProfileTimeline(
	idOrSlug: string,
	opts: GetProfileTimelineOptions = {},
): ProfileTimelineResult | null {
	const db = getProfilesDb();
	const profile = getProfile(idOrSlug, db);
	if (!profile) return null;

	// Historic event cards stay on their own timeline_entries. Linked merge (parent hubs /
	// child events) is for actor profiles (person/firm/…) so a firm can show related events.
	const includeLinked =
		opts.includeLinkedEvents !== undefined
			? Boolean(opts.includeLinkedEvents)
			: profile.profileType !== 'historic_event';
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
			const weAreFrom = String(lr.from_profile_id) === profile.id;
			const otherId = weAreFrom ? String(lr.to_profile_id) : String(lr.from_profile_id);
			const otherType = weAreFrom ? String(lr.to_type) : String(lr.from_type);
			const rel = String(lr.relation_type);

			relatedActorIds.add(otherId);

			// Merge timelines from child historic events, parent subjects, or direct participations.
			// part_of_subject is directional: only the child (from) pulls the parent subject (to).
			// Parent hubs (e.g. Global Electrotelluric Framework) must not ingest every child's rail.
			if (
				otherType === 'historic_event' ||
				rel === 'participated_in' ||
				(profile.profileType !== 'historic_event' && rel === 'mentioned_in') ||
				(rel === 'part_of_subject' && weAreFrom)
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
              op.id AS origin_profile_id, op.name AS origin_profile_name, op.profile_type AS origin_profile_type,
              op.slug AS origin_profile_slug
       FROM timeline_entries te
       LEFT JOIN source_records sr ON sr.id = te.source_record_id
       JOIN profiles op ON op.id = te.profile_id
       WHERE ${where.join(' AND ')}
       ORDER BY te.event_date IS NULL ASC, te.event_date DESC, te.created_at DESC`,
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

	attachLinkedEventProfiles(db, deduped, profile.id);

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
		.sort((a, b) => b.month.localeCompare(a.month));

	// Timeline Gap Detection + Cross-Source Gap-Fill Leads
	const gaps: TimelineGap[] = [];
	if (detectGaps) {
		// Ascending for adjacent-gap math; display order is newest-first below.
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
			.prepare('SELECT alias FROM profile_aliases WHERE profile_id = ? LIMIT 12')
			.all(profile.id) as Array<{ alias: string }>;
		const gapFillTerms = collectGapFillSearchTerms(
			profile.name,
			aliasRows.map((a) => String(a.alias)),
		);
		// Employment graph: firm ← employees, or person → employers. Gap-fill
		// leads must mention the company (aliases) or these connected names.
		addEmploymentConnectionPhrases(
			gapFillTerms,
			employmentConnectionNames(db, profile.id, profile.profileType),
		);
		const gapFillFts = buildGapFillFtsQuery(gapFillTerms);
		const hasSubjectTerms =
			gapFillTerms.phrases.length > 0 || gapFillTerms.tokens.length > 0;

		const existingCorpora = new Set(deduped.map((e) => e.sourceCorpus));
		const isFirmProfile = profile.profileType === 'firm';

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

		// Prioritize the largest gaps (up to 8) then show most recent first
		const topGaps = rawGaps
			.sort((a, b) => b.gapDays - a.gapDays)
			.slice(0, 8)
			.sort((a, b) => b.toDate.localeCompare(a.toDate) || b.fromDate.localeCompare(a.fromDate));

		const kdb = fillFromKnowledge && topGaps.length > 0 ? openKnowledgeReadOnly() : null;
		// City-only geo (e.g. us:ny:city:new-york) is far too broad for firm HQ —
		// it pulls unrelated NY events into gap fill. Keep street/building keys only.
		const geoKeyList = [...geoKeys]
			.filter((gk) => !(isFirmProfile && isCityLevelGeoKey(gk)))
			.slice(0, 20);
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
						const lead: GapFillLead = {
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
						};
						// Always require company / employment-connected person mention.
						if (!hasSubjectTerms || !leadMentionsSubject(lead, gapFillTerms)) continue;
						seenLead.add(k);
						fillLeads.push(lead);
					}
				}

				// 2. Timeline entries from employment-linked people (or other related
				// actors) — still require the lead text/name to mention the company
				// or an employment-connected person (business_tie-only peers alone
				// are not enough).
				if (relatedIdList.length > 0 && fillLeads.length < 6 && hasSubjectTerms) {
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
               LIMIT 12`,
						)
						.all(g.fromDate, g.toDate, ...relatedIdList) as Array<Record<string, unknown>>;

					for (const h of relHits) {
						const k = `p:${String(h.id)}`;
						if (seenLead.has(k)) continue;
						const lead: GapFillLead = {
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
						};
						if (!leadMentionsSubject(lead, gapFillTerms)) continue;
						seenLead.add(k);
						fillLeads.push(lead);
						if (fillLeads.length >= 6) break;
					}
				}

				// 3. FTS match in other timeline entries during this gap (distinctive
				// company / employment-connected phrases only).
				if (gapFillFts && fillLeads.length < 8 && hasSubjectTerms) {
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
                 LIMIT 12`,
							)
							.all(gapFillFts, g.fromDate, g.toDate, ...idList) as Array<Record<string, unknown>>;

						for (const h of ftsHits) {
							const k = `p:${String(h.id)}`;
							if (seenLead.has(k)) continue;
							const otherCorpus = !existingCorpora.has(String(h.source_corpus));
							const lead: GapFillLead = {
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
							};
							if (!leadMentionsSubject(lead, gapFillTerms)) continue;
							seenLead.add(k);
							fillLeads.push(lead);
							if (fillLeads.length >= 8) break;
						}
					} catch {
						/* ignore FTS syntax edge cases */
					}
				}

				// 4. Read-only FTS5 match in knowledge.sqlite during this gap
				if (kdb && fillLeads.length < 10 && (gapFillTerms.tokens.length || gapFillTerms.phrases.length)) {
					const kLeads = searchKnowledgeForGap(
						kdb,
						gapFillTerms,
						g.fromDate,
						g.toDate,
						3,
					);
					for (const kl of kLeads) {
						fillLeads.push(kl);
					}
				}

				fillLeads.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
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
