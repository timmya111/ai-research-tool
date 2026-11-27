/**
 * Client-safe helpers: nest dated milestones inside multi-date ranges (e.g. "1907 – 1945")
 * so Overview and Timeline rails can display date ranges as enclosing span/era cards.
 */

export type DateRangeBounds = {
	/** Sortable YYYYMMDD integer for range start (or negative for BCE). */
	startKey: number;
	/** Sortable YYYYMMDD integer for range end (9999_12_31 for open "–Present"). */
	endKey: number;
	/** Calendar start year (negative for BCE). */
	startYear: number;
	/** Calendar end year, or null when open-ended ("–Present"). */
	endYear: number | null;
	isOpen: boolean;
	/** True when this entry represents an actual span (not a single point). */
	isRange: boolean;
};

export type RangeSpanChapter<T> = {
	span: T;
	bounds: DateRangeBounds;
	/** Point items that fall inside this range (and not inside a tighter child span). */
	nested: Array<{ item: T; sortKey: number }>;
	/** Shorter date ranges strictly contained within this range. */
	children: RangeSpanChapter<T>[];
	/** Sort key for chronological placement (newest first). */
	sortKey: number;
	/** Total count of nested points + descendant spans/points. */
	totalNestedCount: number;
};

export type RangeStreamItem<T> =
	| { kind: 'span'; sortKey: number; chapter: RangeSpanChapter<T> }
	| { kind: 'point'; sortKey: number; item: T };

const MONTH_INDEX: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

function parseSingleDateEndpoint(
	raw: string | null | undefined,
	side: 'start' | 'end',
): { key: number; year: number } | null {
	const s = String(raw || '')
		.replace(/\*\*/g, '')
		.trim();
	if (!s || /^undated$/i.test(s)) return null;

	const defaultMonth = side === 'end' ? 12 : 1;
	const defaultDay = side === 'end' ? 31 : 1;

	const bce = s.match(/^(\d{1,4})\s*(?:BCE|BC)\b/i);
	if (bce) {
		const y = -Number(bce[1]);
		return { key: y * 10_000 + defaultMonth * 100 + defaultDay, year: y };
	}

	const isoDay = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})/);
	if (isoDay) {
		const y = Number(isoDay[1]);
		const m = Number(isoDay[2]);
		const d = Number(isoDay[3]);
		return { key: y * 10_000 + m * 100 + d, year: y };
	}

	const usDay = s.match(/^(\d{1,2})[-/](\d{1,2})[-/]((?:1[6-9]|20)\d{2})$/);
	if (usDay) {
		const m = Number(usDay[1]);
		const d = Number(usDay[2]);
		const y = Number(usDay[3]);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			return { key: y * 10_000 + m * 100 + d, year: y };
		}
	}

	const isoMonth = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})$/);
	if (isoMonth) {
		const y = Number(isoMonth[1]);
		const m = Number(isoMonth[2]);
		if (m >= 1 && m <= 12) {
			return { key: y * 10_000 + m * 100 + defaultDay, year: y };
		}
	}

	const usMonth = s.match(/^(\d{2})[-/]((?:1[6-9]|20)\d{2})$/);
	if (usMonth) {
		const m = Number(usMonth[1]);
		const y = Number(usMonth[2]);
		if (m >= 1 && m <= 12) {
			return { key: y * 10_000 + m * 100 + defaultDay, year: y };
		}
	}

	const monDayYear = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:1[6-9]|20)\d{2})$/i,
	);
	if (monDayYear) {
		const m = MONTH_INDEX[monDayYear[1]!.toLowerCase().replace(/\.$/, '')] || defaultMonth;
		const d = Number(monDayYear[2]);
		const y = Number(monDayYear[3]);
		return { key: y * 10_000 + m * 100 + d, year: y };
	}

	const monYear = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+((?:1[6-9]|20)\d{2})$/i,
	);
	if (monYear) {
		const m = MONTH_INDEX[monYear[1]!.toLowerCase().replace(/\.$/, '')] || defaultMonth;
		const y = Number(monYear[2]);
		return { key: y * 10_000 + m * 100 + defaultDay, year: y };
	}

	const seasonYear = s.match(/^(Spring|Summer|Fall|Autumn|Winter)\s+((?:1[6-9]|20)\d{2})$/i);
	if (seasonYear) {
		const m =
			/spring/i.test(seasonYear[1]!) ? 3
			: /summer/i.test(seasonYear[1]!) ? 6
			: /winter/i.test(seasonYear[1]!) ? 12
			: 9;
		const y = Number(seasonYear[2]);
		return { key: y * 10_000 + m * 100 + defaultDay, year: y };
	}

	const decade = s.match(/^(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d)0s$/i);
	if (decade) {
		const base = Number(`${decade[1]}0`);
		const y = side === 'end' ? base + 9 : base;
		return { key: y * 10_000 + defaultMonth * 100 + defaultDay, year: y };
	}

	const yearPlus = s.match(/^((?:1[6-9]|20)\d{2})\+$/);
	if (yearPlus) {
		const y = Number(yearPlus[1]);
		return { key: y * 10_000 + defaultMonth * 100 + defaultDay, year: y };
	}

	const plainYear = s.match(/^(\d{3,4})$/);
	if (plainYear) {
		const y = Number(plainYear[1]);
		return { key: y * 10_000 + defaultMonth * 100 + defaultDay, year: y };
	}

	return null;
}

/**
 * Parse a summary date label (e.g. "1907–1945", "2020–Present", "1945", "November 13, 2009")
 * into range bounds. Only multi-date / open-ended spans return `isRange: true`.
 */
export function parseSummaryDateBounds(raw: string | null | undefined): DateRangeBounds | null {
	const s = String(raw || '')
		.replace(/\*\*/g, '')
		.trim();
	if (!s || /^undated$/i.test(s)) return null;

	// Avoid splitting single ISO/US dates like "2026-11-27" or "11-27-2026" on their internal hyphens.
	const singleFirst = parseSingleDateEndpoint(s, 'start');
	if (singleFirst) {
		// Decade labels like "1980s" span 1980–1989.
		if (/^(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d0s$/i.test(s)) {
			const end = parseSingleDateEndpoint(s, 'end')!;
			return {
				startKey: singleFirst.key,
				endKey: end.key,
				startYear: singleFirst.year,
				endYear: end.year,
				isOpen: false,
				isRange: end.year > singleFirst.year,
			};
		}
		if (/^(?:1[6-9]|20)\d{2}\+$/.test(s)) {
			return {
				startKey: singleFirst.key,
				endKey: 9999_12_31,
				startYear: singleFirst.year,
				endYear: null,
				isOpen: true,
				isRange: true,
			};
		}
		const endSingle = parseSingleDateEndpoint(s, 'end') || singleFirst;
		return {
			startKey: singleFirst.key,
			endKey: endSingle.key,
			startYear: singleFirst.year,
			endYear: endSingle.year,
			isOpen: false,
			isRange: false,
		};
	}

	// Explicit range separated by en-dash, em-dash, or hyphen (e.g. "1907 – 1945", "2020–Present").
	const rangeMatch = s.match(
		/^(.+?)\s*[–—-]\s*(present|current|now|(?:\d{1,4}\s*(?:BCE|BC))|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|(?:1[6-9]|20)\d{2}(?:-\d{2}(?:-\d{2})?)?|\d{2}-\d{2}-(?:1[6-9]|20)\d{2}|\d{2}-(?:1[6-9]|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:\d{1,2},?\s+)?(?:1[6-9]|20)\d{2}|\d{3,4})$/i,
	);
	if (rangeMatch) {
		const start = parseSingleDateEndpoint(rangeMatch[1], 'start');
		if (!start) return null;
		const endRaw = String(rangeMatch[2] || '').trim();
		if (/^(?:present|current|now)$/i.test(endRaw)) {
			return {
				startKey: start.key,
				endKey: 9999_12_31,
				startYear: start.year,
				endYear: null,
				isOpen: true,
				isRange: true,
			};
		}
		const end = parseSingleDateEndpoint(endRaw, 'end');
		if (!end || end.key <= start.key) return null;
		return {
			startKey: start.key,
			endKey: end.key,
			startYear: start.year,
			endYear: end.year,
			isOpen: false,
			isRange: end.year > start.year || Math.floor(end.key / 100) > Math.floor(start.key / 100),
		};
	}

	return null;
}

/**
 * Parse bounds for a structured Timeline tab entry using eventDate, endDate, and optional rawDateLabel.
 */
export function parseTimelineEntryBounds(entry: {
	eventDate?: string | null;
	endDate?: string | null;
	metadata?: Record<string, unknown> | null;
}): DateRangeBounds | null {
	const rawLabel = entry.metadata?.rawDateLabel ? String(entry.metadata.rawDateLabel).trim() : '';
	if (rawLabel) {
		const fromLabel = parseSummaryDateBounds(rawLabel);
		if (fromLabel?.isRange) return fromLabel;
	}

	const startRaw = String(entry.eventDate || '').trim();
	if (!startRaw) return null;

	const start = parseSingleDateEndpoint(startRaw, 'start');
	if (!start) return parseSummaryDateBounds(startRaw);

	const endRaw = String(entry.endDate || '').trim();
	if (endRaw) {
		if (/^(?:present|current|now)$/i.test(endRaw)) {
			return {
				startKey: start.key,
				endKey: 9999_12_31,
				startYear: start.year,
				endYear: null,
				isOpen: true,
				isRange: true,
			};
		}
		const end = parseSingleDateEndpoint(endRaw, 'end');
		if (end && end.key > start.key) {
			const isRange = end.year > start.year || Math.floor(end.key / 100) > Math.floor(start.key / 100);
			return {
				startKey: start.key,
				endKey: end.key,
				startYear: start.year,
				endYear: end.year,
				isOpen: false,
				isRange,
			};
		}
	}

	const endSingle = parseSingleDateEndpoint(startRaw, 'end') || start;
	return {
		startKey: start.key,
		endKey: endSingle.key,
		startYear: start.year,
		endYear: endSingle.year,
		isOpen: false,
		isRange: false,
	};
}

function approxDurationScore(bounds: DateRangeBounds): number {
	const nowYear = new Date().getFullYear();
	const effectiveEnd = bounds.isOpen ? nowYear * 10_000 + 1231 : bounds.endKey;
	return Math.max(0, effectiveEnd - bounds.startKey);
}

function strictlyContainsBounds(outer: DateRangeBounds, inner: DateRangeBounds): boolean {
	if (!(outer.startKey <= inner.startKey && outer.endKey >= inner.endKey)) return false;
	return outer.startKey < inner.startKey || outer.endKey > inner.endKey;
}

function boundsContainPoint(bounds: DateRangeBounds, pointKey: number): boolean {
	return pointKey >= bounds.startKey && pointKey <= bounds.endKey;
}

type InternalSpan<T> = {
	item: T;
	bounds: DateRangeBounds;
	duration: number;
	nested: Array<{ item: T; sortKey: number }>;
	children: InternalSpan<T>[];
	parent: InternalSpan<T> | null;
};

/**
 * Group timeline items into enclosing date-range chapters + uncontained point items.
 *
 * Only ranges that actually enclose at least one inner milestone (or child range) are
 * promoted to framed span cards; ranges with zero inner milestones stay in the regular
 * point stream so range-only timelines keep their clean compact rail layout.
 */
export function nestTimelineItemsIntoRangeSpans<T>(
	items: T[],
	getBounds: (item: T) => DateRangeBounds | null,
	getFallbackSortKey: (item: T) => number,
): {
	stream: RangeStreamItem<T>[];
	hasActiveSpans: boolean;
} {
	const spanCandidates: InternalSpan<T>[] = [];
	const points: Array<{ item: T; bounds: DateRangeBounds | null; sortKey: number }> = [];

	for (const item of items) {
		const bounds = getBounds(item);
		if (bounds?.isRange) {
			spanCandidates.push({
				item,
				bounds,
				duration: approxDurationScore(bounds),
				nested: [],
				children: [],
				parent: null,
			});
		} else {
			const sortKey = bounds ? bounds.startKey : getFallbackSortKey(item);
			points.push({ item, bounds, sortKey });
		}
	}

	if (spanCandidates.length === 0) {
		const stream: RangeStreamItem<T>[] = points
			.map((p) => ({ kind: 'point' as const, sortKey: p.sortKey, item: p.item }))
			.sort((a, b) => b.sortKey - a.sortKey);
		return { stream, hasActiveSpans: false };
	}

	// Nest strictly shorter ranges inside strictly wider containing ranges.
	for (const child of spanCandidates) {
		let best: InternalSpan<T> | null = null;
		for (const cand of spanCandidates) {
			if (cand === child) continue;
			if (!strictlyContainsBounds(cand.bounds, child.bounds)) continue;
			if (!best || cand.duration < best.duration) best = cand;
		}
		if (best) {
			child.parent = best;
			best.children.push(child);
		}
	}

	// Assign each point to the tightest (shortest) range that contains it.
	const assignTargets = [...spanCandidates].sort((a, b) => {
		if (a.duration !== b.duration) return a.duration - b.duration;
		return b.bounds.startKey - a.bounds.startKey;
	});

	const unassignedPoints: Array<{ item: T; sortKey: number }> = [];
	for (const pt of points) {
		if (!pt.bounds) {
			unassignedPoints.push({ item: pt.item, sortKey: pt.sortKey });
			continue;
		}
		// Match using the point's start key (or end key for year-precision points).
		const hit = assignTargets.find((sp) => boundsContainPoint(sp.bounds, pt.bounds!.startKey));
		if (hit) {
			hit.nested.push({ item: pt.item, sortKey: pt.sortKey });
		} else {
			unassignedPoints.push({ item: pt.item, sortKey: pt.sortKey });
		}
	}

	const countDescendants = (sp: InternalSpan<T>): number =>
		sp.nested.length + sp.children.reduce((n, c) => n + 1 + countDescendants(c), 0);

	const toChapter = (sp: InternalSpan<T>): RangeSpanChapter<T> => {
		const children = sp.children.map(toChapter).sort((a, b) => b.sortKey - a.sortKey);
		const nested = [...sp.nested].sort((a, b) => b.sortKey - a.sortKey);
		const newestNested = nested.reduce((acc, p) => Math.max(acc, p.sortKey), -Infinity);
		const newestChild = children.reduce((acc, c) => Math.max(acc, c.sortKey), -Infinity);
		const baseSort = sp.bounds.isOpen ? sp.bounds.startKey : sp.bounds.endKey;
		const sortKey = Math.max(baseSort, newestNested, newestChild);
		const totalNestedCount =
			nested.length + children.reduce((n, c) => n + 1 + c.totalNestedCount, 0);
		return {
			span: sp.item,
			bounds: sp.bounds,
			nested,
			children,
			sortKey,
			totalNestedCount,
		};
	};

	const stream: RangeStreamItem<T>[] = [];
	let hasActiveSpans = false;

	const roots = spanCandidates.filter((c) => !c.parent);
	for (const root of roots) {
		if (countDescendants(root) > 0) {
			hasActiveSpans = true;
			const chapter = toChapter(root);
			stream.push({ kind: 'span', sortKey: chapter.sortKey, chapter });
		} else {
			// Empty range (no inner milestones) stays a regular rail entry.
			const sortKey = root.bounds.isOpen ? root.bounds.startKey : root.bounds.endKey;
			stream.push({ kind: 'point', sortKey, item: root.item });
		}
	}

	for (const pt of unassignedPoints) {
		stream.push({ kind: 'point', sortKey: pt.sortKey, item: pt.item });
	}

	stream.sort((a, b) => {
		if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
		if (a.kind !== b.kind) return a.kind === 'span' ? -1 : 1;
		return 0;
	});

	return { stream, hasActiveSpans };
}

/** Human-friendly span duration label (e.g. "38 yrs", "7 yrs", or null if open/tiny). */
export function formatRangeSpanDuration(bounds: DateRangeBounds): string | null {
	if (bounds.isOpen || bounds.endYear == null) return null;
	const years = bounds.endYear - bounds.startYear;
	if (years >= 1) return `${years} ${years === 1 ? 'yr' : 'yrs'}`;
	const startMonth = Math.floor((Math.abs(bounds.startKey) % 10_000) / 100);
	const endMonth = Math.floor((Math.abs(bounds.endKey) % 10_000) / 100);
	const months = endMonth - startMonth;
	if (months >= 1) return `${months} mo`;
	return null;
}

/** Clean display label for a Timeline tab entry span (e.g. "1907 – 1945", "2020 – Present"). */
export function formatTimelineSpanHeaderLabel(entry: {
	eventDate?: string | null;
	endDate?: string | null;
	metadata?: Record<string, unknown> | null;
}): string {
	const rawLabel = entry.metadata?.rawDateLabel ? String(entry.metadata.rawDateLabel).trim() : '';
	if (rawLabel && /[–—-]/.test(rawLabel)) {
		return rawLabel.replace(/\s*[–—-]\s*/g, ' – ').replace(/\bpresent\b/i, 'Present');
	}
	const start = String(entry.eventDate || '').trim();
	const end = String(entry.endDate || '').trim();
	if (start && end) return `${start} – ${end}`;
	if (start) return `${start} – Present`;
	return rawLabel || 'Range';
}
