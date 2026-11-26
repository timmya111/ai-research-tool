/**
 * Client-safe helpers: nest point timeline events inside employment date ranges.
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
	nested: T[];
	start: string;
	end: string | null;
	isCurrent: boolean;
};

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

/**
 * Split timeline entries into employment chapters with nested milestones/filings,
 * plus point events that fall outside every span.
 */
export function nestTimelineIntoCareerChapters<T extends NestableTimelineEntry>(
	entries: T[],
): {
	chapters: CareerChapter<T>[];
	unassigned: T[];
	hasSpans: boolean;
} {
	const spans = entries.filter(isSpan);
	const points = entries.filter((e) => !isSpan(e));
	if (!spans.length) {
		return { chapters: [], unassigned: points, hasSpans: false };
	}

	const chapterDefs = spans
		.map((span) => {
			const bounds = spanBounds(span);
			if (!bounds) return null;
			return { span, ...bounds, nested: [] as T[] };
		})
		.filter(Boolean) as Array<{
		span: T;
		start: string;
		end: string;
		isCurrent: boolean;
		nested: T[];
	}>;

	// Prefer later-starting (and shorter) spans on overlap so transition weeks land on the new firm.
	chapterDefs.sort((a, b) => {
		if (a.start !== b.start) return b.start.localeCompare(a.start);
		return a.end.localeCompare(b.end);
	});

	const unassigned: T[] = [];
	for (const pt of points) {
		const day = pointDate(pt);
		if (!day) {
			unassigned.push(pt);
			continue;
		}
		const hit = chapterDefs.find((ch) => contains({ start: ch.start, end: ch.end }, day));
		if (hit) hit.nested.push(pt);
		else unassigned.push(pt);
	}

	for (const ch of chapterDefs) {
		ch.nested.sort((a, b) => {
			const da = pointDate(a) || '';
			const db = pointDate(b) || '';
			return db.localeCompare(da);
		});
	}

	// Display newest employer first
	chapterDefs.sort((a, b) => b.start.localeCompare(a.start));

	return {
		hasSpans: true,
		chapters: chapterDefs.map((ch) => ({
			span: ch.span,
			nested: ch.nested,
			start: ch.start,
			end: ch.isCurrent ? null : ch.end === '9999-12-31' ? null : ch.end,
			isCurrent: ch.isCurrent,
		})),
		unassigned,
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
