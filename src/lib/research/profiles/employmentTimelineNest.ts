/**
 * Client-safe helpers: nest point timeline events inside employment date ranges.
 *
 * Long overlapping careers (e.g. lifelong ranching spanning political terms) become
 * parent chapters; shorter stints nest inside them. Everything renders in dated order.
 */

export type NestableTimelineEntry = {
	id: string;
	eventDate: string | null;
	endDate?: string | null;
	title: string;
	summary?: string;
	entryKind?: string | null;
	angle?: string | null;
	metadata?: Record<string, unknown> | null;
	sourceCorpus?: string | null;
	geoLabel?: string | null;
	sourceUrl?: string | null;
	linkedProfileId?: string | null;
	linkedProfileSlug?: string | null;
	linkedProfileName?: string | null;
	originProfileId?: string | null;
	originProfileSlug?: string | null;
};

export type CareerChapter<T extends NestableTimelineEntry = NestableTimelineEntry> = {
	span: T;
	/** Point events in this span that are not inside a child stint. */
	nested: T[];
	/** Shorter employment stints fully contained in this span. */
	children: CareerChapter<T>[];
	start: string;
	end: string | null;
	isCurrent: boolean;
	/** Newest activity date — used for chronological placement. */
	sortDate: string;
};

/** Chronological stream item inside a chapter or at the top level. */
export type CareerStreamItem<T extends NestableTimelineEntry = NestableTimelineEntry> =
	| { kind: 'chapter'; date: string; chapter: CareerChapter<T> }
	| { kind: 'point'; date: string; entry: T };

function isSpan(entry: NestableTimelineEntry): boolean {
	if (String(entry.entryKind || '') === 'employment') return true;
	return String(entry.metadata?.kind || '') === 'employment_span';
}

/** Normalize to YYYY-MM-DD (or far-future) for range compares. */
export function timelineDateSortable(raw: string | null | undefined, asEnd = false): string | null {
	const s = String(raw || '').trim();
	if (!s) return null;
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
	if (/^\d{4}-\d{2}$/.test(s)) return asEnd ? `${s}-28` : `${s}-01`;
	if (/^\d{4}$/.test(s)) return asEnd ? `${s}-12-31` : `${s}-01-01`;
	const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	return null;
}

function spanBounds(span: NestableTimelineEntry): { start: string; end: string; isCurrent: boolean } | null {
	const start = timelineDateSortable(span.eventDate, false);
	if (!start) return null;
	const metaCurrent = span.metadata?.isCurrent === true;
	const isCurrent = metaCurrent || !span.endDate;
	const end =
		isCurrent ? '9999-12-31'
		: timelineDateSortable(span.endDate, true) || start;
	return { start, end, isCurrent };
}

function pointDate(entry: NestableTimelineEntry): string | null {
	return timelineDateSortable(entry.eventDate, false);
}

function contains(bounds: { start: string; end: string }, day: string): boolean {
	return day >= bounds.start && day <= bounds.end;
}

function spanDurationDays(start: string, end: string): number {
	const s = Date.parse(start);
	const e = Date.parse(end === '9999-12-31' ? new Date().toISOString().slice(0, 10) : end);
	if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
	return Math.round((e - s) / (24 * 3600 * 1000));
}

function strictlyContains(
	outer: { start: string; end: string },
	inner: { start: string; end: string },
): boolean {
	if (!(outer.start <= inner.start && outer.end >= inner.end)) return false;
	// Equal bounds are not parent/child — siblings / dupes.
	return outer.start < inner.start || outer.end > inner.end;
}

type ChapterDef<T extends NestableTimelineEntry> = {
	span: T;
	start: string;
	end: string;
	isCurrent: boolean;
	nested: T[];
	children: ChapterDef<T>[];
	parent: ChapterDef<T> | null;
	duration: number;
};

function maxDate(...dates: Array<string | null | undefined>): string {
	let best = '';
	for (const d of dates) {
		const s = String(d || '');
		if (s && s > best) best = s;
	}
	return best || '0000-01-01';
}

function chapterSortDate<T extends NestableTimelineEntry>(ch: ChapterDef<T>): string {
	const nestedNewest = ch.nested.reduce((acc, p) => maxDate(acc, pointDate(p)), '');
	const childNewest = ch.children.reduce((acc, c) => maxDate(acc, chapterSortDate(c)), '');
	const spanEnd = ch.isCurrent ? new Date().toISOString().slice(0, 10) : ch.end;
	return maxDate(spanEnd, nestedNewest, childNewest);
}

function toCareerChapter<T extends NestableTimelineEntry>(ch: ChapterDef<T>): CareerChapter<T> {
	const children = [...ch.children]
		.map(toCareerChapter)
		.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
	const nested = [...ch.nested].sort((a, b) => {
		const da = pointDate(a) || '';
		const db = pointDate(b) || '';
		return db.localeCompare(da);
	});
	const sortDate = maxDate(
		ch.isCurrent ? new Date().toISOString().slice(0, 10) : ch.end,
		...nested.map((p) => pointDate(p)),
		...children.map((c) => c.sortDate),
	);
	return {
		span: ch.span,
		nested,
		children,
		start: ch.start,
		end: ch.isCurrent ? null : ch.end === '9999-12-31' ? null : ch.end,
		isCurrent: ch.isCurrent,
		sortDate,
	};
}

/**
 * Merge chapters + points into one newest-first chronological stream.
 * Child chapters are placed by their own sortDate among sibling points.
 */
export function buildCareerChronologicalStream<T extends NestableTimelineEntry>(
	chapters: CareerChapter<T>[],
	points: T[],
): CareerStreamItem<T>[] {
	const items: CareerStreamItem<T>[] = [
		...chapters.map((chapter) => ({
			kind: 'chapter' as const,
			date: chapter.sortDate,
			chapter,
		})),
		...points
			.map((entry) => {
				const date = pointDate(entry);
				if (!date) return null;
				return { kind: 'point' as const, date, entry };
			})
			.filter(Boolean) as CareerStreamItem<T>[],
	];
	items.sort((a, b) => {
		if (a.date !== b.date) return b.date.localeCompare(a.date);
		// Chapters before points on the same day; stable by title otherwise.
		if (a.kind !== b.kind) return a.kind === 'chapter' ? -1 : 1;
		return 0;
	});
	return items;
}

/**
 * Split timeline entries into employment chapters with nested milestones/filings,
 * plus point events that fall outside every span.
 *
 * Shorter stints fully inside a longer career range become child chapters so a
 * lifelong ranching span can encapsulate political terms without stealing their
 * milestones — and the tree still sorts by dated activity.
 */
export function nestTimelineIntoCareerChapters<T extends NestableTimelineEntry>(
	entries: T[],
): {
	chapters: CareerChapter<T>[];
	unassigned: T[];
	hasSpans: boolean;
	/** Top-level chronological stream (chapters + unassigned points). */
	stream: CareerStreamItem<T>[];
} {
	const spans = entries.filter(isSpan);
	const points = entries.filter((e) => !isSpan(e));
	if (!spans.length) {
		return {
			chapters: [],
			unassigned: points,
			hasSpans: false,
			stream: buildCareerChronologicalStream([], points),
		};
	}

	const chapterDefs: ChapterDef<T>[] = spans
		.map((span) => {
			const bounds = spanBounds(span);
			if (!bounds) return null;
			return {
				span,
				...bounds,
				nested: [] as T[],
				children: [] as ChapterDef<T>[],
				parent: null as ChapterDef<T> | null,
				duration: spanDurationDays(bounds.start, bounds.end),
			};
		})
		.filter(Boolean) as ChapterDef<T>[];

	// Parent = smallest qualifying span that strictly contains this one.
	// Require a meaningful duration gap so peer political stints (House vs party
	// chair vs convention) stay siblings under a long background career (ranching),
	// instead of nesting three levels deep on tiny date overlaps.
	const MIN_PARENT_EXTRA_DAYS = 3650; // ~10 years
	for (const child of chapterDefs) {
		let best: ChapterDef<T> | null = null;
		for (const cand of chapterDefs) {
			if (cand === child) continue;
			if (!strictlyContains(cand, child)) continue;
			if (cand.duration - child.duration < MIN_PARENT_EXTRA_DAYS) continue;
			if (!best || cand.duration < best.duration) best = cand;
		}
		if (best) {
			child.parent = best;
			best.children.push(child);
		}
	}

	const roots = chapterDefs.filter((c) => !c.parent);

	// Assign each point to the tightest (shortest) containing span.
	const assignTargets = [...chapterDefs].sort((a, b) => {
		if (a.duration !== b.duration) return a.duration - b.duration;
		return b.start.localeCompare(a.start);
	});

	const unassigned: T[] = [];
	for (const pt of points) {
		const day = pointDate(pt);
		if (!day) {
			unassigned.push(pt);
			continue;
		}
		const hit = assignTargets.find((ch) => contains({ start: ch.start, end: ch.end }, day));
		if (hit) hit.nested.push(pt);
		else unassigned.push(pt);
	}

	const chapters = roots.map(toCareerChapter).sort((a, b) => b.sortDate.localeCompare(a.sortDate));

	return {
		hasSpans: true,
		chapters,
		unassigned,
		stream: buildCareerChronologicalStream(chapters, unassigned),
	};
}

export function formatCareerSpanLabel(start: string, end: string | null, isCurrent: boolean): string {
	const fmt = (d: string) => {
		if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
			const [y, m, day] = d.slice(0, 10).split('-');
			return `${Number(m)}/${Number(day)}/${y}`;
		}
		return d;
	};
	if (isCurrent || !end) return `${fmt(start)} → Present`;
	return `${fmt(start)} → ${fmt(end)}`;
}

export function approxSpanYears(start: string, end: string | null, isCurrent: boolean): number | null {
	const s = Date.parse(start.length === 4 ? `${start}-01-01` : start.slice(0, 10));
	const e = Date.parse(
		isCurrent || !end ? new Date().toISOString().slice(0, 10)
		: end.length === 4 ? `${end}-12-31`
		: end.slice(0, 10),
	);
	if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
	return Math.max(0, Math.round(((e - s) / (365.25 * 24 * 3600 * 1000)) * 10) / 10);
}
