import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeIsoDate, sha256Key } from '@/lib/research/profiles/normalize';
import { getProfile, upsertTimelineEntry } from '@/lib/research/profiles/store';
import type { TimelineAngle } from '@/lib/research/profiles/types';

const OWN_SOURCE = 'summary-timeline';
const MIRROR_SOURCE = 'summary-timeline-mirror';

const HEADING_RE = /^#{1,3}\s+(.+)$/;
const BULLET_RE = /^[-*•]\s+(.+)$/;
/** Same family of date labels as ProfilesClient SUMMARY_DATED_BULLET_RE (server-side). */
const DATED_BULLET_RE =
	/^(?:\*\*)?((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:1[6-9]|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:1[6-9]|20)\d{2}|(?:Spring|Summer|Fall|Autumn|Winter)\s+(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}-\d{2}|\d{2}-\d{2}-(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}(?:-\d{2})?\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}-\d{2}(?:-\d{2})?|present|Present)|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?\s*[–—-]\s*(?:(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|present|Present)|(?:1[6-9]|20)\d{2}\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}|present|Present)|(?:1[6-9]|20)\d{2}-\d{2}|\d{2}-(?:1[6-9]|20)\d{2}|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|(?:1[6-9]|20)\d{2}\+|(?:1[6-9]|20)\d{2})(?:\*\*)?\s*[—–:\-]\s*(.+)$/i;

const MONTH_INDEX: Record<string, string> = {
	jan: '01',
	january: '01',
	feb: '02',
	february: '02',
	mar: '03',
	march: '03',
	apr: '04',
	april: '04',
	may: '05',
	jun: '06',
	june: '06',
	jul: '07',
	july: '07',
	aug: '08',
	august: '08',
	sep: '09',
	sept: '09',
	september: '09',
	oct: '10',
	october: '10',
	nov: '11',
	november: '11',
	dec: '12',
	december: '12',
};

export type ParsedSummaryTimelineItem = {
	eventDate: string | null;
	endDate: string | null;
	title: string;
	summary: string;
	rawDateLabel: string;
};

export type SyncSummaryTimelineResult = {
	parsed: number;
	upsertedOwn: number;
	removedOwn: number;
	mirroredRelated: number;
	relatedProfileIds: string[];
};

function stripMd(s: string): string {
	return String(s || '')
		.replace(/\*\*/g, '')
		.replace(/__/g, '')
		.replace(/`+/g, '')
		.trim();
}

function titleFromBody(body: string): string {
	const clean = stripMd(body).replace(/\s+/g, ' ').trim();
	if (!clean) return 'Untitled milestone';
	// Prefer a leading short label before an em/en dash when present.
	const dashed = clean.match(/^(.{3,80}?)\s*[—–:]\s+\S/);
	if (dashed) {
		return dashed[1]!.replace(/[.\s]+$/g, '').trim().slice(0, 160);
	}
	// First sentence; keep common abbreviations intact.
	const protected_ = clean
		.replace(/\be\.g\./gi, 'eg')
		.replace(/\bi\.e\./gi, 'ie')
		.replace(/\bU\.S\./g, 'US')
		.replace(/\betc\./gi, 'etc');
	const cut = protected_.search(/\.\s+/);
	const first = cut >= 0 ? clean.slice(0, cut) : clean;
	return first.replace(/[.\s]+$/g, '').trim().slice(0, 160) || 'Untitled milestone';
}

/** Parse a display/ISO date label into eventDate + optional endDate. */
export function parseTimelineDateLabel(raw: string): {
	eventDate: string | null;
	endDate: string | null;
} {
	const s = stripMd(raw);
	if (!s || /^undated$/i.test(s) || /^present$/i.test(s)) {
		return { eventDate: null, endDate: null };
	}

	// Exact single dates (ISO YYYY-MM-DD, US MM-DD-YYYY / MM/DD/YYYY, YYYY-MM, MM-YYYY)
	// MUST be checked BEFORE range matching so "11-25-2026" is not misread as "11-25" – "2026".
	const exactIsoDay = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})$/);
	if (exactIsoDay) {
		return { eventDate: `${exactIsoDay[1]}-${exactIsoDay[2]}-${exactIsoDay[3]}`, endDate: null };
	}

	const exactUsDay = s.match(/^(\d{1,2})[-/](\d{1,2})[-/]((?:1[6-9]|20)\d{2})$/);
	if (exactUsDay) {
		const mm = Number(exactUsDay[1]);
		const dd = Number(exactUsDay[2]);
		if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
			return {
				eventDate: `${exactUsDay[3]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
				endDate: null,
			};
		}
	}

	const exactIsoMonth = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})$/);
	if (exactIsoMonth) {
		const mm = Number(exactIsoMonth[2]);
		if (mm >= 1 && mm <= 12) {
			return { eventDate: `${exactIsoMonth[1]}-${exactIsoMonth[2]}`, endDate: null };
		}
	}

	const exactUsMonth = s.match(/^(\d{2})-((?:1[6-9]|20)\d{2})$/);
	if (exactUsMonth) {
		const mm = Number(exactUsMonth[1]);
		if (mm >= 1 && mm <= 12) {
			return { eventDate: `${exactUsMonth[2]}-${exactUsMonth[1]}`, endDate: null };
		}
	}

	const decadeRange = s.match(
		/^(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d)0s\s*[–—-]\s*(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d)0s$/i,
	);
	if (decadeRange) {
		const start = `${decadeRange[1]}0`;
		const end = `${decadeRange[2]}9`;
		return { eventDate: start, endDate: end };
	}

	const decade = s.match(/^(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d)0s$/i);
	if (decade) {
		const y = `${decade[1]}0`;
		return { eventDate: y, endDate: String(Number(y) + 9) };
	}

	const range = s.match(
		/^(.+?)\s*[–—-]\s*(present|Present|(?:1[6-9]|20)\d{2}(?:-\d{2}(?:-\d{2})?)?|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?)$/i,
	);
	if (range) {
		const start = parseTimelineDateLabel(range[1]!).eventDate;
		const endRaw = range[2]!;
		const end = /^present$/i.test(endRaw) ? null : parseTimelineDateLabel(endRaw).eventDate;
		return { eventDate: start, endDate: end };
	}

	const monthDay = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:1[6-9]|20)\d{2})$/i,
	);
	if (monthDay) {
		const mm = MONTH_INDEX[monthDay[1]!.toLowerCase().replace(/\.$/, '')];
		if (mm) {
			return {
				eventDate: `${monthDay[3]}-${mm}-${String(Number(monthDay[2])).padStart(2, '0')}`,
				endDate: null,
			};
		}
	}

	const monthYear = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+((?:1[6-9]|20)\d{2})$/i,
	);
	if (monthYear) {
		const mm = MONTH_INDEX[monthYear[1]!.toLowerCase().replace(/\.$/, '')];
		if (mm) return { eventDate: `${monthYear[2]}-${mm}`, endDate: null };
	}

	const season = s.match(/^(Spring|Summer|Fall|Autumn|Winter)\s+((?:1[6-9]|20)\d{2})$/i);
	if (season) {
		const mm =
			/spring/i.test(season[1]!) ? '03'
			: /summer/i.test(season[1]!) ? '06'
			: /winter/i.test(season[1]!) ? '12'
			:	'09';
		return { eventDate: `${season[2]}-${mm}`, endDate: null };
	}

	const iso = normalizeIsoDate(s);
	return { eventDate: iso.date, endDate: null };
}

/**
 * Extract dated bullets under Timeline / Chronology / Milestones / Key dates headings,
 * or from an implicit chronology (dated bullets without a ## Timeline heading, including
 * multi-line follow-up prose attached to `* YYYY: Title`).
 */
export function parseSummaryTimelineItems(summary: string): ParsedSummaryTimelineItem[] {
	const lines = String(summary || '').split(/\n/);
	const items: ParsedSummaryTimelineItem[] = [];
	const spans = findTimelineSectionSpans(lines);
	const effectiveSpans =
		spans.length > 0 ? spans : (() => {
			const implicit = findImplicitChronologySpan(lines);
			return implicit ? [implicit] : [];
		})();

	for (const span of effectiveSpans) {
		const body = lines.slice(span.bodyStart, span.bodyEnd);
		const blocks = splitTimelineBlocks(body);
		for (const block of blocks) {
			const firstLine = block.lines[0]?.trim() || '';
			const bullet = firstLine.match(BULLET_RE);
			if (!bullet) continue;
			const firstBody = bullet[1]!.trim();
			const dated = firstBody.match(DATED_BULLET_RE);
			if (!dated) continue;

			const rawDateLabel = stripMd(dated[1] || '');
			const firstText = stripMd(dated[2] || '');
			const extraProse = block.lines
				.slice(1)
				.map((l) => stripMd(l))
				.filter(Boolean)
				.join(' ')
				.trim();
			const combinedText = extraProse ? `${firstText} — ${extraProse}` : firstText;
			if (!combinedText) continue;
			const { eventDate, endDate } = parseTimelineDateLabel(rawDateLabel);
			items.push({
				eventDate,
				endDate,
				title: titleFromBody(firstText || combinedText),
				summary: combinedText.slice(0, 2000),
				rawDateLabel,
			});
		}
	}

	return items;
}

function guessAngle(text: string): TimelineAngle {
	const t = text.toLowerCase();
	if (/\b(vietnam|war|military|troops|defense|dod)\b/.test(t)) return 'defense_dod';
	if (/\b(medicare|medicaid|health|hospital)\b/.test(t)) return 'civilian_health';
	if (/\b(irs|tax|bankrupt|license|deport|indict|prison|giuliani|police)\b/.test(t)) return 'corporate';
	if (/\b(civil rights|voting|fair housing|senate|president|congress|policy|act of)\b/.test(t)) return 'policy';
	if (/\b(club|limelight|tunnel|palladium|hacienda|factory|records|techno|dj)\b/.test(t)) return 'corporate';
	return 'general';
}

function listRelatedHistoricEventIds(profileId: string): string[] {
	const db = getProfilesDb();
	const profile = getProfile(profileId);
	if (!profile) return [];

	const ids = new Set<string>();
	const linked = profile.metadata?.linkedEvents;
	if (Array.isArray(linked)) {
		for (const slug of linked) {
			const p = getProfile(String(slug || '').trim());
			if (p?.profileType === 'historic_event') ids.add(p.id);
		}
	}

	const rows = db
		.prepare(
			`SELECT CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END AS peer_id
       FROM profile_links pl
       WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
         AND pl.relation_type IN (
           'participated_in','affiliated_with','part_of_subject','mentioned_in','business_tie','temporal_overlap'
         )`,
		)
		.all(profileId, profileId, profileId) as Array<{ peer_id?: string }>;

	for (const row of rows) {
		const peer = getProfile(String(row.peer_id || ''));
		if (peer?.profileType === 'historic_event') ids.add(peer.id);
	}

	ids.delete(profileId);
	return [...ids];
}

function ownDedupeKey(profileId: string, eventDate: string | null, title: string): string {
	const hint = `${eventDate || 'nodate'}|${title}`;
	return sha256Key([profileId, OWN_SOURCE, eventDate || 'nodate', hint]);
}

function removeStaleOwnEntries(profileId: string, keepDedupeKeys: Set<string>): number {
	const db = getProfilesDb();
	const rows = db
		.prepare(
			`SELECT id, dedupe_key FROM timeline_entries
       WHERE profile_id = ? AND source_corpus = ?`,
		)
		.all(profileId, OWN_SOURCE) as Array<{ id?: string; dedupe_key?: string }>;
	let removed = 0;
	for (const row of rows) {
		const key = String(row.dedupe_key || '');
		if (keepDedupeKeys.has(key)) continue;
		db.prepare(`DELETE FROM timeline_entries WHERE id = ?`).run(String(row.id));
		removed += 1;
	}
	return removed;
}

function removeStaleMirrors(relatedProfileId: string, sourceProfileId: string, keepHints: Set<string>): number {
	const db = getProfilesDb();
	const rows = db
		.prepare(
			`SELECT id, metadata_json FROM timeline_entries
       WHERE profile_id = ? AND source_corpus = ?`,
		)
		.all(relatedProfileId, MIRROR_SOURCE) as Array<{ id?: string; metadata_json?: string }>;
	let removed = 0;
	for (const row of rows) {
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
		} catch {
			meta = {};
		}
		if (String(meta.sourceProfileId || '') !== sourceProfileId) continue;
		const hint = String(meta.dedupeHint || '');
		if (keepHints.has(hint)) continue;
		db.prepare(`DELETE FROM timeline_entries WHERE id = ?`).run(String(row.id));
		removed += 1;
	}
	return removed;
}

/**
 * Parse ## Timeline (etc.) dated bullets from a profile summary and upsert
 * matching timeline_entries. Optionally mirror onto linked historic_event cards.
 */
export function syncSummaryTimelineToEntries(
	profileId: string,
	options: {
		summary?: string | null;
		mirrorToRelated?: boolean;
		angle?: TimelineAngle;
	} = {},
): SyncSummaryTimelineResult {
	const profile = getProfile(profileId);
	if (!profile) {
		return { parsed: 0, upsertedOwn: 0, removedOwn: 0, mirroredRelated: 0, relatedProfileIds: [] };
	}

	const summary = options.summary != null ? String(options.summary) : profile.summary || '';
	const items = parseSummaryTimelineItems(summary);
	const keepDedupeKeys = new Set<string>();

	for (const item of items) {
		const dedupeHint = `${item.eventDate || 'nodate'}|${item.title}`;
		upsertTimelineEntry({
			profileId: profile.id,
			eventDate: item.eventDate,
			endDate: item.endDate,
			title: item.title,
			summary: item.summary,
			angle: options.angle || guessAngle(item.summary),
			entryKind: 'observation',
			sourceCorpus: OWN_SOURCE,
			dedupeHint,
			confidence: 0.95,
			metadata: {
				fromSummaryTimeline: true,
				rawDateLabel: item.rawDateLabel,
			},
		});
		keepDedupeKeys.add(ownDedupeKey(profile.id, item.eventDate, item.title));
	}

	const removedOwn = removeStaleOwnEntries(profile.id, keepDedupeKeys);

	let mirroredRelated = 0;
	const relatedProfileIds =
		options.mirrorToRelated === false || profile.profileType === 'historic_event' ?
			[]
		:	listRelatedHistoricEventIds(profile.id);

	for (const relatedId of relatedProfileIds) {
		const keepHints = new Set<string>();
		for (const item of items) {
			const dedupeHint = `${profile.id}|${item.eventDate || 'nodate'}|${item.title}`;
			keepHints.add(dedupeHint);
			upsertTimelineEntry({
				profileId: relatedId,
				eventDate: item.eventDate,
				endDate: item.endDate,
				title: `${profile.name}: ${item.title}`.slice(0, 400),
				summary: item.summary,
				angle: options.angle || guessAngle(item.summary),
				entryKind: 'observation',
				sourceCorpus: MIRROR_SOURCE,
				dedupeHint,
				confidence: 0.85,
				metadata: {
					fromSummaryTimeline: true,
					sourceProfileId: profile.id,
					sourceProfileSlug: profile.slug,
					dedupeHint,
					rawDateLabel: item.rawDateLabel,
				},
			});
			mirroredRelated += 1;
		}
		removeStaleMirrors(relatedId, profile.id, keepHints);
	}

	return {
		parsed: items.length,
		upsertedOwn: items.length,
		removedOwn,
		mirroredRelated,
		relatedProfileIds,
	};
}

/** Sort key for newest-first: YYYYMMDD-ish number; undated → -1 (sinks last). */
export function timelineDateSortKey(
	eventDate: string | null,
	_endDate: string | null,
	rawDateLabel?: string,
): number {
	const label = String(rawDateLabel || '').trim();
	// Open “–present” uses the start year so recent dated events stay above long-running roles
	// (matches Overview SummaryTimelineRail / summaryYearSortKey).
	if (/\bpresent\b/i.test(label)) {
		const startOnly = label.replace(/\s*[–—-]\s*present\b/i, '').trim();
		if (startOnly && startOnly !== label) {
			const parsed = parseTimelineDateLabel(startOnly);
			return timelineDateSortKey(parsed.eventDate, parsed.endDate, startOnly);
		}
		return 9999_12_31;
	}
	// Prefer start (eventDate) so decade/range bullets interleave by when they began.
	const prefer = eventDate;
	if (!prefer) return -1;
	const parts = prefer.split('-').map((p) => Number(p));
	const y = parts[0] || 0;
	const m = parts[1] || 0;
	const d = parts[2] || 0;
	if (!y) return -1;
	return y * 10_000 + (m || 0) * 100 + (d || 0);
}

const TIMELINE_HEADING_TITLE_RE = /timeline|chronolog|milestones?|key dates|history/i;

type TimelineSectionSpan = {
	headingLineIndex: number;
	/** Inclusive start of body (line after heading). */
	bodyStart: number;
	/** Exclusive end of body (next heading or EOF). */
	bodyEnd: number;
};

function findTimelineSectionSpans(lines: string[]): TimelineSectionSpan[] {
	const spans: TimelineSectionSpan[] = [];
	let current: TimelineSectionSpan | null = null;

	for (let i = 0; i < lines.length; i++) {
		const heading = lines[i]!.trim().match(HEADING_RE);
		if (heading) {
			if (current) {
				current.bodyEnd = i;
				spans.push(current);
				current = null;
			}
			const title = stripMd(heading[1] || '');
			if (TIMELINE_HEADING_TITLE_RE.test(title)) {
				current = { headingLineIndex: i, bodyStart: i + 1, bodyEnd: lines.length };
			}
		}
	}
	if (current) spans.push(current);
	return spans;
}

export type ReorderSummaryTimelineResult = {
	summary: string;
	changed: boolean;
	method: 'deterministic' | 'ollama' | 'none';
	datedCount: number;
	alreadySorted: boolean;
	error?: string;
};

type TimelineBlock = {
	lines: string[];
	sortKey: number;
	dated: boolean;
	origIndex: number;
};

function isDatedBulletContent(content: string): {
	dated: boolean;
	sortKey: number;
	rawDateLabel: string;
} {
	const dated = content.match(DATED_BULLET_RE);
	if (!dated) return { dated: false, sortKey: -1, rawDateLabel: '' };
	const rawDateLabel = stripMd(dated[1] || '');
	const { eventDate, endDate } = parseTimelineDateLabel(rawDateLabel);
	return {
		dated: true,
		sortKey: timelineDateSortKey(eventDate, endDate, rawDateLabel),
		rawDateLabel,
	};
}

/**
 * Split a section body into chronology blocks: each dated/undated bullet plus the
 * following prose until the next bullet or heading. Preserves `* YYYY: title` +
 * paragraph layouts used outside a formal ## Timeline heading.
 */
function splitTimelineBlocks(body: string[]): TimelineBlock[] {
	const blocks: TimelineBlock[] = [];
	let i = 0;
	while (i < body.length) {
		const trimmed = body[i]!.trim();
		if (!BULLET_RE.test(trimmed)) {
			i += 1;
			continue;
		}
		const start = i;
		i += 1;
		while (i < body.length) {
			const t = body[i]!.trim();
			if (BULLET_RE.test(t) || HEADING_RE.test(t)) break;
			i += 1;
		}
		const blockLines = body.slice(start, i);
		const content = blockLines[0]!.trim().match(BULLET_RE)![1]!.trim();
		const parsed = isDatedBulletContent(content);
		blocks.push({
			lines: blockLines,
			sortKey: parsed.sortKey,
			dated: parsed.dated,
			origIndex: start,
		});
	}
	return blocks;
}

function findImplicitChronologySpan(lines: string[]): TimelineSectionSpan | null {
	const bulletIndexes: number[] = [];
	let dated = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		const m = trimmed.match(BULLET_RE);
		if (!m) continue;
		bulletIndexes.push(i);
		if (isDatedBulletContent(m[1]!.trim()).dated) dated += 1;
	}
	if (bulletIndexes.length < 2 || dated < 2) return null;
	// Require a chronology-like doc: most bullets carry parseable dates.
	if (dated / bulletIndexes.length < 0.6) return null;
	const first = bulletIndexes[0]!;
	const last = bulletIndexes[bulletIndexes.length - 1]!;
	// Include prose after the last bullet until EOF / next heading.
	let bodyEnd = lines.length;
	for (let i = last + 1; i < lines.length; i++) {
		if (HEADING_RE.test(lines[i]!.trim())) {
			bodyEnd = i;
			break;
		}
	}
	return { headingLineIndex: -1, bodyStart: first, bodyEnd };
}

/**
 * Deterministically rewrite chronology sections newest-first.
 * Handles ## Timeline headings and implicit `* YYYY: …` chronologies (with
 * following prose kept attached to each dated bullet).
 * Undated bullets stay after dated ones (stable among themselves).
 */
export function reorderSummaryTimelineNewestFirst(summary: string): ReorderSummaryTimelineResult {
	const src = String(summary || '');
	if (!src.trim()) {
		return {
			summary: src,
			changed: false,
			method: 'none',
			datedCount: 0,
			alreadySorted: true,
		};
	}

	const lines = src.split(/\n/);
	let spans = findTimelineSectionSpans(lines);
	if (!spans.length) {
		const implicit = findImplicitChronologySpan(lines);
		if (implicit) spans = [implicit];
	}
	if (!spans.length) {
		return {
			summary: src,
			changed: false,
			method: 'none',
			datedCount: 0,
			alreadySorted: true,
		};
	}

	let totalDated = 0;
	let anyChanged = false;
	const out = [...lines];

	// Process from bottom so index shifts do not invalidate earlier spans.
	for (let si = spans.length - 1; si >= 0; si--) {
		const span = spans[si]!;
		const body = lines.slice(span.bodyStart, span.bodyEnd);
		const blocks = splitTimelineBlocks(body);
		if (blocks.length < 2) continue;

		const datedBlocks = blocks.filter((b) => b.dated);
		if (datedBlocks.length < 2) continue;
		totalDated += datedBlocks.length;

		const firstBullet = blocks[0]!.origIndex;
		const lastBlock = blocks[blocks.length - 1]!;
		const lastBulletEnd = lastBlock.origIndex + lastBlock.lines.length;
		const leading = body.slice(0, firstBullet);
		const trailing = body.slice(lastBulletEnd);

		const sorted = [...blocks].sort((a, b) => {
			if (a.dated !== b.dated) return a.dated ? -1 : 1;
			if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
			return a.origIndex - b.origIndex;
		});

		const sameOrder = sorted.every((b, i) => b.origIndex === blocks[i]!.origIndex);
		if (sameOrder) continue;

		anyChanged = true;
		const rebuilt = [...leading, ...sorted.flatMap((b) => b.lines), ...trailing];
		out.splice(span.bodyStart, span.bodyEnd - span.bodyStart, ...rebuilt);
	}

	const next = out.join('\n');
	const alreadySorted = !anyChanged;
	return {
		summary: next,
		changed: anyChanged,
		method: anyChanged ? 'deterministic' : 'none',
		datedCount: totalDated,
		alreadySorted,
	};
}

/**
 * True when a Timeline section exists but has little/no parseable dated bullets
 * (prose-only or ambiguous date wording) — candidate for Ollama rewrite.
 */
export function timelineNeedsOllamaReorder(summary: string): boolean {
	const src = String(summary || '');
	const lines = src.split(/\n/);
	const spans = findTimelineSectionSpans(lines);
	if (!spans.length) return false;

	for (const span of spans) {
		const body = lines.slice(span.bodyStart, span.bodyEnd);
		let dated = 0;
		let undatedBullets = 0;
		let proseChars = 0;
		let yearMentions = 0;
		for (const rawLine of body) {
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			const bullet = trimmed.match(BULLET_RE);
			if (bullet) {
				const content = bullet[1]!.trim();
				if (content.match(DATED_BULLET_RE)) dated += 1;
				else {
					undatedBullets += 1;
					if (/\b(?:1[6-9]|20)\d{2}\b/.test(content)) yearMentions += 1;
				}
				continue;
			}
			if (!HEADING_RE.test(trimmed)) {
				proseChars += trimmed.length;
				if (/\b(?:1[6-9]|20)\d{2}\b/.test(trimmed)) yearMentions += 1;
			}
		}
		// Prose-heavy or undated bullets that still mention years → Ollama.
		if (dated < 2 && (proseChars >= 40 || undatedBullets >= 2 || yearMentions >= 2)) {
			return true;
		}
		// Mix: some dated, but also undated year-ish bullets that the deterministic path
		// cannot order — ask Ollama to normalize the whole section.
		if (dated >= 1 && undatedBullets >= 2 && yearMentions >= 2) {
			return true;
		}
	}
	return false;
}

function stripCodeFences(text: string): string {
	let s = String(text || '').trim();
	if (/^```/.test(s)) {
		s = s.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}
	return s;
}

/**
 * Ask Ollama to rewrite Timeline section(s) as dated bullets, newest date on top.
 * Returns the full summary with only the timeline portion rearranged/normalized.
 */
export async function ollamaReorderTimelineSection(
	summary: string,
	options: { model?: string } = {},
): Promise<ReorderSummaryTimelineResult> {
	const src = String(summary || '');
	if (!src.trim() || !timelineNeedsOllamaReorder(src)) {
		return {
			summary: src,
			changed: false,
			method: 'none',
			datedCount: parseSummaryTimelineItems(src).length,
			alreadySorted: true,
		};
	}

	try {
		const { assistantMessageText, ollamaChat, ollamaTags, PREFERRED_CHAT_MODELS, resolveInstalledModel } =
			await import('@/lib/research/ollama');
		const tags = await ollamaTags();
		const model =
			options.model ||
			resolveInstalledModel(PREFERRED_CHAT_MODELS[0], tags.models) ||
			PREFERRED_CHAT_MODELS.map((p) => resolveInstalledModel(p, tags.models)).find(Boolean) ||
			tags.models[0];
		if (!model) {
			return {
				summary: src,
				changed: false,
				method: 'none',
				datedCount: parseSummaryTimelineItems(src).length,
				alreadySorted: false,
				error: 'No Ollama model available for timeline reorder',
			};
		}

		const { message } = await ollamaChat({
			model,
			numCtx: 8192,
			messages: [
				{
					role: 'system',
					content:
						'You rewrite profile overview markdown. Keep every fact. Output ONLY the full markdown document — no preamble.',
				},
				{
					role: 'user',
					content: `Rewrite the ## Timeline (or Chronology / Milestones / Key dates / History) section of this profile summary so every milestone is a markdown bullet with the date first, newest date on top.

Rules:
- Bullet form: - **DATE** — claim text
- Prefer ISO-ish or year labels already present (YYYY, YYYY-MM-DD, Month YYYY, Late 1980s, 1980s–1990s, etc.)
- Sort newest → oldest. Put undated items last.
- Do not invent events. Do not drop events. Do not rewrite sections outside Timeline.
- Keep the same heading level/title for the timeline section.
- Return the COMPLETE summary markdown (lead + timeline + any other sections).

Summary:
${src.slice(0, 12000)}`,
				},
			],
		});

		const rewritten = stripCodeFences(assistantMessageText(message));
		if (!rewritten || rewritten.length < 40) {
			return {
				summary: src,
				changed: false,
				method: 'none',
				datedCount: parseSummaryTimelineItems(src).length,
				alreadySorted: false,
				error: 'Ollama returned empty timeline rewrite',
			};
		}

		// Prefer deterministic polish on the model output so ordering is guaranteed.
		const polished = reorderSummaryTimelineNewestFirst(rewritten);
		const finalSummary = polished.summary;
		const datedCount = parseSummaryTimelineItems(finalSummary).length;
		const changed = finalSummary.trim() !== src.trim();
		return {
			summary: changed ? finalSummary : src,
			changed,
			method: changed ? 'ollama' : 'none',
			datedCount,
			alreadySorted: !changed,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			summary: src,
			changed: false,
			method: 'none',
			datedCount: parseSummaryTimelineItems(src).length,
			alreadySorted: false,
			error: message,
		};
	}
}

const INLINE_CLAIM_DATE_RE =
	/(January|February|March|April|May|June|July|August|September|October|November|December|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:1[6-9]|20)\d{2}/gi;

/**
 * Turn pasted prose chronologies like
 * `March 12, 2026 — Title (details)   August 7, 2024 — …`
 * into a `## Timeline` section with `* DATE: Title` bullets (details as following prose).
 * Skips matches already on dated bullet lines.
 */
export function promoteInlineDatedClaimsToTimeline(summary: string): ReorderSummaryTimelineResult {
	const src = String(summary || '');
	if (!src.trim()) {
		return { summary: src, changed: false, method: 'none', datedCount: 0, alreadySorted: true };
	}

	type Claim = { date: string; title: string; detail: string; start: number; end: number };
	const starts: Array<{ index: number; date: string; bodyStart: number }> = [];
	const starter = new RegExp(
		`(${INLINE_CLAIM_DATE_RE.source})\\s*[—–-]\\s*`,
		'gi',
	);
	let m: RegExpExecArray | null;
	while ((m = starter.exec(src))) {
		const absIndex = m.index;
		const lineStart = src.lastIndexOf('\n', absIndex) + 1;
		const prefix = src.slice(lineStart, absIndex);
		// Already a markdown bullet / numbered chronology line — leave alone.
		if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(prefix) || /\*\*.*[—–:]/.test(prefix)) continue;
		starts.push({
			index: absIndex,
			date: stripMd(m[1] || '').replace(/\s+/g, ' ').trim(),
			bodyStart: absIndex + m[0].length,
		});
	}
	if (starts.length < 2) {
		return { summary: src, changed: false, method: 'none', datedCount: 0, alreadySorted: true };
	}

	const claims: Claim[] = [];
	for (let i = 0; i < starts.length; i++) {
		const cur = starts[i]!;
		const nextStart = i + 1 < starts.length ? starts[i + 1]!.index : src.length;
		let endLimit = nextStart;
		const slice = src.slice(cur.bodyStart, nextStart);
		const stop = slice.search(/\n\s*\n|\n(?=\s*Sources\b|\s*#{1,3}\s+)/i);
		if (stop >= 0) endLimit = cur.bodyStart + stop;
		let body = src.slice(cur.bodyStart, endLimit).trim();
		// Trim trailing separators / whitespace left from the run.
		body = body.replace(/\s+/g, ' ').trim();
		if (!body) continue;
		let title = body;
		let detail = '';
		const paren = body.match(/^(.+?)\s*\((.+)\)\s*$/);
		if (paren && paren[1]!.length >= 8) {
			title = paren[1]!.trim();
			detail = paren[2]!.trim();
		} else {
			title = titleFromBody(body);
			if (title.length < body.length) {
				detail = body.slice(title.length).replace(/^[\s.:—–-]+/, '').trim();
			}
		}
		claims.push({
			date: cur.date,
			title: title.slice(0, 160),
			detail,
			start: cur.index,
			end: endLimit,
		});
	}
	if (claims.length < 2) {
		return { summary: src, changed: false, method: 'none', datedCount: 0, alreadySorted: true };
	}

	// Prefer one contiguous run (≥2 claims with only whitespace between).
	type Run = { claims: Claim[]; start: number; end: number };
	const runs: Run[] = [];
	let run: Claim[] = [claims[0]!];
	for (let i = 1; i < claims.length; i++) {
		const prev = claims[i - 1]!;
		const cur = claims[i]!;
		const gap = src.slice(prev.end, cur.start);
		if (/^[\s]*$/.test(gap)) {
			run.push(cur);
		} else {
			if (run.length >= 2) {
				runs.push({ claims: run, start: run[0]!.start, end: run[run.length - 1]!.end });
			}
			run = [cur];
		}
	}
	if (run.length >= 2) {
		runs.push({ claims: run, start: run[0]!.start, end: run[run.length - 1]!.end });
	}
	if (!runs.length) {
		return { summary: src, changed: false, method: 'none', datedCount: 0, alreadySorted: true };
	}
	runs.sort((a, b) => b.claims.length - a.claims.length || a.start - b.start);
	const best = runs[0]!;

	const bulletLines: string[] = [];
	for (const c of best.claims) {
		bulletLines.push(`* ${c.date}: ${c.title}`);
		if (c.detail) bulletLines.push(c.detail);
		bulletLines.push('');
	}
	while (bulletLines.length && bulletLines[bulletLines.length - 1] === '') bulletLines.pop();

	const before = src.slice(0, best.start).replace(/\s+$/, '');
	const after = src.slice(best.end).replace(/^\s+/, '');

	const hasTimelineHeading = /^#{1,3}\s+.*\b(timeline|chronolog|milestones?|key dates)\b/im.test(
		`${before}\n${after}`,
	);

	let next: string;
	if (hasTimelineHeading) {
		// Insert bullets immediately after the first timeline-like heading in `before`, else prepend section.
		const beforeLines = before.split(/\n/);
		let insertAt = -1;
		for (let i = 0; i < beforeLines.length; i++) {
			const h = beforeLines[i]!.trim().match(HEADING_RE);
			if (h && TIMELINE_HEADING_TITLE_RE.test(stripMd(h[1] || ''))) {
				insertAt = i + 1;
				break;
			}
		}
		if (insertAt >= 0) {
			beforeLines.splice(insertAt, 0, '', ...bulletLines, '');
			next = `${beforeLines.join('\n').replace(/\s+$/, '')}${after ? `\n\n${after}` : ''}`.trim() + '\n';
		} else {
			next = `${before}\n\n## Timeline\n\n${bulletLines.join('\n')}${after ? `\n\n${after}` : ''}\n`;
		}
	} else {
		// Place Timeline before Sources / next ## heading / end.
		const afterMatch = after.match(/^(Sources\b.*)$/im);
		const nextHeading = after.match(/^(#{1,3}\s+.+)$/m);
		if (afterMatch && afterMatch.index != null) {
			const head = after.slice(0, afterMatch.index).replace(/\s+$/, '');
			const tail = after.slice(afterMatch.index);
			next =
				`${before}${head ? `\n\n${head}` : ''}\n\n## Timeline\n\n${bulletLines.join('\n')}\n\n${tail}`.trim() +
				'\n';
		} else if (nextHeading && nextHeading.index === 0) {
			next = `${before}\n\n## Timeline\n\n${bulletLines.join('\n')}\n\n${after}`.trim() + '\n';
		} else if (nextHeading && nextHeading.index != null) {
			const head = after.slice(0, nextHeading.index).replace(/\s+$/, '');
			const tail = after.slice(nextHeading.index);
			next =
				`${before}${head ? `\n\n${head}` : ''}\n\n## Timeline\n\n${bulletLines.join('\n')}\n\n${tail}`.trim() +
				'\n';
		} else {
			next = `${before}\n\n## Timeline\n\n${bulletLines.join('\n')}${after ? `\n\n${after}` : ''}\n`;
		}
	}

	if (next === src) {
		return { summary: src, changed: false, method: 'none', datedCount: best.claims.length, alreadySorted: true };
	}
	return {
		summary: next,
		changed: true,
		method: 'deterministic',
		datedCount: best.claims.length,
		alreadySorted: false,
	};
}

/**
 * Ensure Overview Timeline content is newest-first:
 * 0) Promote pasted “Month Day, Year — claim” prose runs into ## Timeline bullets.
 * 1) Deterministic bullet sort when ≥2 dated bullets parse.
 * 2) Ollama rewrite when the section is prose-only / ambiguous (optional).
 */
export async function ensureSummaryTimelineNewestFirst(
	summary: string,
	options: { useOllama?: boolean; model?: string } = {},
): Promise<ReorderSummaryTimelineResult> {
	const promoted = promoteInlineDatedClaimsToTimeline(summary);
	const deterministic = reorderSummaryTimelineNewestFirst(promoted.summary);
	if (promoted.changed || deterministic.changed) {
		return {
			summary: deterministic.summary,
			changed: true,
			method: 'deterministic',
			datedCount: Math.max(deterministic.datedCount, promoted.datedCount),
			alreadySorted: deterministic.alreadySorted && !promoted.changed,
		};
	}

	const useOllama = options.useOllama !== false;
	if (useOllama && timelineNeedsOllamaReorder(deterministic.summary)) {
		return ollamaReorderTimelineSection(deterministic.summary, { model: options.model });
	}

	return {
		...deterministic,
		method: 'none',
	};
}
