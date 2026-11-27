/**
 * Deterministic article/prose → timelined milestone formatter for `historic_event` profiles.
 *
 * Breaks raw news articles and multi-paragraph prose summaries into:
 *   <concise lead paragraph>
 *
 *   ## Timeline
 *   - **<Date>** — <milestone beat>
 *   ...
 *
 * Design rules:
 * - Preserves already-structured summaries (existing ## Timeline with bullets, or ≥2 dated bullets).
 * - Extracts distinct calendar milestones embedded in prose (full dates, Month DD, Month YYYY,
 *   Season YYYY, explicit historical years like "in 2021" / "charged in 2019", relative
 *   "two months later" follow-ups, and multi-date clauses like "in December 2022 and later ... in December 2024").
 * - Ignores future-horizon clauses ("until at least December 2028", "expiration in 2029") so
 *   future deadlines stay anchored to the announcement/action date rather than creating future dates.
 * - Preserves precision without fabricating days (Month YYYY stays "December 2024", YYYY stays "2021").
 * - Groups current-date article beats into readable paragraph/quote milestones under the content date.
 * - Orders milestones newest → oldest (preserving narrative reading order within the same date).
 */

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
] as const;

const MONTH_MAP: Record<string, number> = {
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

const WORD_NUM: Record<string, number> = {
	a: 1,
	an: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
};

const MONTH_TOKEN_SRC =
	'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const TIMELINE_HEADING_RE = /^#{1,3}\s+(?:timeline|chronolog\w*|milestones?|key dates|history)\b/i;
const ANY_HEADING_RE = /^#{1,3}\s+(.+)$/;
const BULLET_LINE_RE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;

const DATED_BULLET_LINE_RE =
	/^(?:\*\*)?(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:1[6-9]|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:1[6-9]|20)\d{2}|(?:Spring|Summer|Fall|Autumn|Winter)\s+(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}-\d{2}|\d{2}-\d{2}-(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}|\d{2}-(?:1[6-9]|20)\d{2}|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?(?:\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}s?|present|Present))?|(?:1[6-9]|20)\d{2}\+)(?:\*\*)?\s*[—–:\-]\s*\S/i;

const FUTURE_HORIZON_PREFIX_RE =
	/\b(?:until(?:\s+at\s+least)?|through(?:\s+at\s+least)?|by(?:\s+the\s+end\s+of)?|before|expir(?:e|es|ing|ation)\s+(?:in|on|by)|scheduled\s+(?:for|to\s+\w+\s+in)|set\s+(?:for|to\s+\w+\s+in)|planned\s+for|expected\s+(?:in|by|to\s+\w+\s+in)|runs?\s+(?:until|through)|lasting\s+(?:until|through)|projected\s+(?:for|by|in)|target(?:ed|ing)?\s+(?:for|in)|slated\s+for|no\s+later\s+than)\s*$/i;

const JUNK_LINE_RE =
	/^(?:advertisement|sponsored(?:\s+content)?|subscribe(?:\s+to)?|sign\s*up|newsletter|share\s+this|related\s+(?:articles?|stories|posts)|you\s+may\s+also\s+like|recommended|cookie\s+policy|accept\s+cookies|follow\s+us|leave\s+a\s+comment|comments?\s*$|tags?\s*:|tagged\s+with\s*:|categories?\s*:|posted\s+in\s*:|click\s+here|read\s+more\s*$|continue\s+reading|trending|popular\s+stories|from\s+our\s+partners|promo(?:ted)?\s+content|this\s+audio\s+is\s+auto-generated\.|see\s+also:|editor['’]s\s+note:|permission\s+granted\s+by\b|courtesy\s+of\b|image\s+courtesy\b|photo(?:\s+credit)?\s*:|credit\s*:|published\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|updated\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|dive\s+insight:?|senior\s+reporter\b|staff\s+reporter\b|if\s+you\s+would\s+like\s+to\s+contact\s+this\s+reporter\b|this\s+website\s+is\s+not\s+intended\s+for\s+users\b|all\s+rights\s+reserved\b|copyright\b|©\s*\d{4}\b)/i;

const ABBREV_PROTECT_RE =
	/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Col|Maj|Capt|Lt|Sgt|Rev|Hon|St|Jr|Sr|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|U\.S|U\.K|Inc|Ltd|Corp|Co|vs|No|Fig|Dept|Est|Approx)\./gi;

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export type ParsedMilestoneDate = {
	iso: string | null;
	label: string;
	sortKey: number;
	precision: DatePrecision;
};

export type HistoricEventMilestone = {
	iso: string | null;
	dateLabel: string;
	sortKey: number;
	precision: DatePrecision;
	text: string;
	isAnchorDate: boolean;
	order: number;
};

export type FormatHistoricEventSummaryOptions = {
	title?: string | null;
	startDate?: string | null;
	sourceTag?: string | null;
	sourceUrl?: string | null;
	maxMilestones?: number;
	/** Force re-formatting even if a ## Timeline heading already exists. */
	force?: boolean;
};

export type FormatHistoricEventSummaryResult = {
	summary: string;
	changed: boolean;
	lead: string;
	milestones: HistoricEventMilestone[];
	inferredStartDate: string | null;
};

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

type RefDate = {
	iso: string | null;
	year: number | null;
	month: number | null;
	day: number | null;
	sortKey: number;
	label: string;
	precision: DatePrecision;
};

function parseRefDate(raw?: string | null): RefDate {
	const s = String(raw || '').trim();
	if (!s) {
		return { iso: null, year: null, month: null, day: null, sortKey: -1, label: 'Undated', precision: 'unknown' };
	}

	const isoDay = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})$/);
	if (isoDay) {
		const y = Number(isoDay[1]);
		const m = Number(isoDay[2]);
		const d = Number(isoDay[3]);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			return {
				iso: `${y}-${pad2(m)}-${pad2(d)}`,
				year: y,
				month: m,
				day: d,
				sortKey: y * 10_000 + m * 100 + d,
				label: `${MONTHS[m - 1]} ${d}, ${y}`,
				precision: 'day',
			};
		}
	}

	const usDay = s.match(/^(\d{1,2})[-/](\d{1,2})[-/]((?:1[6-9]|20)\d{2})$/);
	if (usDay) {
		const m = Number(usDay[1]);
		const d = Number(usDay[2]);
		const y = Number(usDay[3]);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			return {
				iso: `${y}-${pad2(m)}-${pad2(d)}`,
				year: y,
				month: m,
				day: d,
				sortKey: y * 10_000 + m * 100 + d,
				label: `${MONTHS[m - 1]} ${d}, ${y}`,
				precision: 'day',
			};
		}
	}

	const isoMonth = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})$/);
	if (isoMonth) {
		const y = Number(isoMonth[1]);
		const m = Number(isoMonth[2]);
		if (m >= 1 && m <= 12) {
			return {
				iso: `${y}-${pad2(m)}`,
				year: y,
				month: m,
				day: null,
				sortKey: y * 10_000 + m * 100,
				label: `${MONTHS[m - 1]} ${y}`,
				precision: 'month',
			};
		}
	}

	const monDayYear = s.match(new RegExp(`^(${MONTH_TOKEN_SRC})\\.?\\s+(\\d{1,2}),?\\s+((?:1[6-9]|20)\\d{2})$`, 'i'));
	if (monDayYear) {
		const m = MONTH_MAP[monDayYear[1]!.toLowerCase().replace(/\.$/, '')];
		const d = Number(monDayYear[2]);
		const y = Number(monDayYear[3]);
		if (m && d >= 1 && d <= 31) {
			return {
				iso: `${y}-${pad2(m)}-${pad2(d)}`,
				year: y,
				month: m,
				day: d,
				sortKey: y * 10_000 + m * 100 + d,
				label: `${MONTHS[m - 1]} ${d}, ${y}`,
				precision: 'day',
			};
		}
	}

	const monYear = s.match(new RegExp(`^(${MONTH_TOKEN_SRC})\\.?\\s+((?:1[6-9]|20)\\d{2})$`, 'i'));
	if (monYear) {
		const m = MONTH_MAP[monYear[1]!.toLowerCase().replace(/\.$/, '')];
		const y = Number(monYear[2]);
		if (m) {
			return {
				iso: `${y}-${pad2(m)}`,
				year: y,
				month: m,
				day: null,
				sortKey: y * 10_000 + m * 100,
				label: `${MONTHS[m - 1]} ${y}`,
				precision: 'month',
			};
		}
	}

	const yearOnly = s.match(/^((?:1[6-9]|20)\d{2})$/);
	if (yearOnly) {
		const y = Number(yearOnly[1]);
		return {
			iso: String(y),
			year: y,
			month: null,
			day: null,
			sortKey: y * 10_000,
			label: String(y),
			precision: 'year',
		};
	}

	return { iso: null, year: null, month: null, day: null, sortKey: -1, label: 'Undated', precision: 'unknown' };
}

/** True when summary already has a populated ## Timeline section or ≥2 dated bullets. */
export function summaryAlreadyHasTimelinedView(summary: string): boolean {
	const src = String(summary || '').trim();
	if (!src) return false;
	const lines = src.split(/\r?\n/);

	let inTimeline = false;
	let timelineBullets = 0;
	let anyDatedBullets = 0;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (ANY_HEADING_RE.test(line)) {
			inTimeline = TIMELINE_HEADING_RE.test(line);
			continue;
		}
		const b = line.match(BULLET_LINE_RE);
		if (!b) continue;
		const body = b[1]!.trim();
		if (inTimeline) timelineBullets += 1;
		if (DATED_BULLET_LINE_RE.test(body)) anyDatedBullets += 1;
	}

	if (timelineBullets >= 1) return true;
	if (anyDatedBullets >= 2) return true;
	return false;
}

/** Peel trailing structured sections (## Local Wikipedia cross-check, ## Source articles) and bare Source/URL footers. */
function peelTrailingSections(summary: string): {
	body: string;
	preservedSections: string[];
	extractedSources: string[];
} {
	const lines = String(summary || '')
		.replace(/\r/g, '')
		.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
		.split('\n');

	const preservedSections: string[] = [];
	const extractedSources: string[] = [];
	const bodyLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i]!.trim();

		// Drop empty ## Timeline heading stub if we are reformatting an empty section.
		if (TIMELINE_HEADING_RE.test(trimmed)) {
			let j = i + 1;
			while (j < lines.length && !lines[j]!.trim()) j += 1;
			const nextLine = j < lines.length ? lines[j]!.trim() : '';
			if (!nextLine || ANY_HEADING_RE.test(nextLine)) {
				i = j;
				continue;
			}
		}

		// Preserve ## Local Wikipedia cross-check / ## Source articles / ## Sources / ## References verbatim.
		if (
			/^#{1,3}\s+(?:local\s+wikipedia|source\s+articles?|sources?|references?|further\s+reading)\b/i.test(
				trimmed,
			)
		) {
			const sec = [lines[i]!];
			i += 1;
			while (i < lines.length) {
				const t = lines[i]!.trim();
				if (ANY_HEADING_RE.test(t)) break;
				if (
					/^(?:Single-card rewrite (?:via|from)|Pieced from \d+ news_rss|Consolidated from \d+ news_rss)/i.test(t) ||
					/overview mixes a short paragraph with Timeline-style dated entries\.?$/i.test(t)
				) {
					i += 1;
					continue;
				}
				sec.push(lines[i]!);
				i += 1;
			}
			while (sec.length && !sec[sec.length - 1]!.trim()) sec.pop();
			if (sec.length > 1) preservedSections.push(sec.join('\n'));
			continue;
		}

		if (
			/^(?:Single-card rewrite (?:via|from)|Pieced from \d+ news_rss|Consolidated from \d+ news_rss)/i.test(trimmed) ||
			/overview mixes a short paragraph with Timeline-style dated entries\.?$/i.test(trimmed)
		) {
			i += 1;
			continue;
		}

		if (/^Source:\s+.+$/i.test(trimmed)) {
			extractedSources.push(trimmed);
			i += 1;
			continue;
		}

		if (/^https?:\/\/\S+$/i.test(trimmed)) {
			extractedSources.push(trimmed);
			i += 1;
			continue;
		}

		if (JUNK_LINE_RE.test(trimmed)) {
			// Copyright footer typically marks the end of wire copy.
			if (/^copyright\b|^©\s*\d{4}\b/i.test(trimmed)) {
				i += 1;
				while (i < lines.length) {
					const rem = lines[i]!.trim();
					if (/^Source:\s+/i.test(rem) || /^https?:\/\/\S+$/i.test(rem)) {
						extractedSources.push(rem);
					}
					i += 1;
				}
				break;
			}
			i += 1;
			continue;
		}

		bodyLines.push(lines[i]!);
		i += 1;
	}

	return {
		body: bodyLines.join('\n').trim(),
		preservedSections,
		extractedSources,
	};
}

/** Repair common Readability/wire glue like "Abilene.The Texas" or 'them."However' without breaking abbreviations. */
function cleanProseBody(raw: string): string {
	return String(raw || '')
		.replace(/\r/g, '')
		.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
		.replace(/\.(?=[A-Z][a-z])/g, '. ')
		.replace(/([.!?])"(?=[A-Z])/g, '$1" ')
		.replace(/([.!?])\u201d(?=[A-Z])/g, '$1\u201d ')
		.replace(/(\d)([A-Z][a-z])/g, '$1. $2')
		.replace(/\bU\.\s+S\./g, 'U.S.')
		.replace(/\bU\.\s+K\./g, 'U.K.')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function splitSentences(text: string): string[] {
	const cleaned = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return [];
	const protected_ = cleaned
		.replace(ABBREV_PROTECT_RE, '$1˘')
		// Protect single-letter initials ("William K. Marshall", "J. R. Smith")
		.replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1˘');
	const raw = protected_
		.split(/(?<=[.!?]["”’']?)\s+(?=[A-Z“"‘(\d])/)
		.map((s) => s.replace(/˘/g, '.').trim())
		.filter(Boolean);
	return raw;
}

function isFutureHorizon(text: string, matchIndex: number, candSortKey: number, refSortKey: number): boolean {
	if (refSortKey <= 0 || candSortKey <= refSortKey) return false;
	const before = text.slice(Math.max(0, matchIndex - 42), matchIndex);
	if (FUTURE_HORIZON_PREFIX_RE.test(before)) return true;
	// Also guard bare future year targets like "by 2029", "in 2028" when ref is earlier year and sentence uses future modal
	if (/\b(?:will|would|expected|projected|planned|scheduled|slated|aims?\s+to|target)\b/i.test(before)) {
		return true;
	}
	return false;
}

function makeDate(
	year: number,
	month: number | null,
	day: number | null,
	customLabel?: string,
): ParsedMilestoneDate {
	if (month != null && day != null) {
		return {
			iso: `${year}-${pad2(month)}-${pad2(day)}`,
			label: customLabel || `${MONTHS[month - 1]} ${day}, ${year}`,
			sortKey: year * 10_000 + month * 100 + day,
			precision: 'day',
		};
	}
	if (month != null) {
		return {
			iso: `${year}-${pad2(month)}`,
			label: customLabel || `${MONTHS[month - 1]} ${year}`,
			sortKey: year * 10_000 + month * 100,
			precision: 'month',
		};
	}
	return {
		iso: String(year),
		label: customLabel || String(year),
		sortKey: year * 10_000,
		precision: 'year',
	};
}

type DateHit = ParsedMilestoneDate & { index: number; endIndex: number; specificity: number };

function findDateHitsInSentence(
	sentence: string,
	ref: ReturnType<typeof parseRefDate>,
	prevHistoricalDate?: ParsedMilestoneDate | null,
): DateHit[] {
	const hits: DateHit[] = [];
	const occupied: Array<[number, number]> = [];
	const overlaps = (start: number, end: number) =>
		occupied.some(([a, b]) => start < b && end > a);
	const pushHit = (start: number, end: number, parsed: ParsedMilestoneDate, specificity: number) => {
		if (overlaps(start, end)) return;
		if (isFutureHorizon(sentence, start, parsed.sortKey, ref.sortKey)) return;
		occupied.push([start, end]);
		hits.push({ ...parsed, index: start, endIndex: end, specificity });
	};

	// 1. ISO YYYY-MM-DD
	for (const m of sentence.matchAll(/\b((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})\b/g)) {
		const y = Number(m[1]);
		const mo = Number(m[2]);
		const d = Number(m[3]);
		if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	// 2. US Month DD, YYYY (e.g. "November 19, 2026", "Nov. 13, 2026")
	const monDayYearRe = new RegExp(
		`\\b(${MONTH_TOKEN_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:1[6-9]|20)\\d{2})\\b`,
		'gi',
	);
	for (const m of sentence.matchAll(monDayYearRe)) {
		const mo = MONTH_MAP[m[1]!.toLowerCase().replace(/\.$/, '')];
		const d = Number(m[2]);
		const y = Number(m[3]);
		if (mo && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	// 3. UK DD Month YYYY (e.g. "5 August 2024")
	const dayMonYearRe = new RegExp(
		`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_TOKEN_SRC})\\.?,?\\s+((?:1[6-9]|20)\\d{2})\\b`,
		'gi',
	);
	for (const m of sentence.matchAll(dayMonYearRe)) {
		const d = Number(m[1]);
		const mo = MONTH_MAP[m[2]!.toLowerCase().replace(/\.$/, '')];
		const y = Number(m[3]);
		if (mo && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	// 4. Month + Year (e.g. "December 2022", "December 2024", "September 2025")
	const monYearRe = new RegExp(
		`\\b(${MONTH_TOKEN_SRC})\\.?,?\\s+((?:1[6-9]|20)\\d{2})\\b`,
		'gi',
	);
	for (const m of sentence.matchAll(monYearRe)) {
		const mo = MONTH_MAP[m[1]!.toLowerCase().replace(/\.$/, '')];
		const y = Number(m[2]);
		if (mo && m.index != null) {
			// Skip "May" lowercase modal verb (impossible before a year, but check capitalization anyway).
			if (m[1] === 'may') continue;
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, null), 3);
		}
	}

	// 5. Season + Year (e.g. "Spring 2025", "Summer of 2024")
	for (const m of sentence.matchAll(/\b(Spring|Summer|Fall|Autumn|Winter)(?:\s+of)?\s+((?:1[6-9]|20)\d{2})\b/gi)) {
		if (m.index == null) continue;
		const seasonRaw = m[1]!;
		const seasonCap = seasonRaw.charAt(0).toUpperCase() + seasonRaw.slice(1).toLowerCase();
		const mo = /spring/i.test(seasonRaw) ? 3 : /summer/i.test(seasonRaw) ? 6 : /winter/i.test(seasonRaw) ? 12 : 9;
		const y = Number(m[2]);
		pushHit(m.index, m.index + m[0].length, makeDate(y, mo, null, `${seasonCap} ${y}`), 3);
	}

	// 6. Month + Day without year (e.g. "Nov. 19", "Nov. 13", "16 December") when reference year is known
	if (ref.year != null) {
		const monDayRe = new RegExp(`\\b(${MONTH_TOKEN_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
		for (const m of sentence.matchAll(monDayRe)) {
			if (m.index == null) continue;
			if (m[1] === 'may') continue;
			const mo = MONTH_MAP[m[1]!.toLowerCase().replace(/\.$/, '')];
			const d = Number(m[2]);
			if (!mo || d < 1 || d > 31) continue;
			// Guard against "May 500" or "March 4th [amendment]" — require day <= 31 and not followed by %/$
			const afterChar = sentence[m.index + m[0].length] || '';
			if (/[%$]/.test(afterChar)) continue;
			let y = ref.year;
			if (ref.month != null && mo > ref.month + 1) {
				// Past reference wrapped from prior year unless preceded by future wording
				const before = sentence.slice(Math.max(0, m.index - 32), m.index);
				if (!FUTURE_HORIZON_PREFIX_RE.test(before) && !/\b(?:next|upcoming|scheduled|planned)\b/i.test(before)) {
					y = ref.year - 1;
				}
			}
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 3);
		}

		const dayMonRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_TOKEN_SRC})\\.?\\b`, 'gi');
		for (const m of sentence.matchAll(dayMonRe)) {
			if (m.index == null) continue;
			if (m[2] === 'may') continue;
			const d = Number(m[1]);
			const mo = MONTH_MAP[m[2]!.toLowerCase().replace(/\.$/, '')];
			if (!mo || d < 1 || d > 31) continue;
			let y = ref.year;
			if (ref.month != null && mo > ref.month + 1) {
				const before = sentence.slice(Math.max(0, m.index - 32), m.index);
				if (!FUTURE_HORIZON_PREFIX_RE.test(before)) y = ref.year - 1;
			}
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 3);
		}
	}

	// 7. Explicit contextual Month-only anchor when reference year is known:
	//    e.g. "In September, a federal judge issued..." (sentence-initial or explicit action cue, earlier than ref month)
	if (ref.year != null && ref.month != null && hits.length === 0) {
		const ctxMonthRe = new RegExp(
			`(?:^|(?:In|During|Earlier\\s+in|Back\\s+in)\\s+)(January|February|March|April|May|June|July|August|September|October|November|December)\\b(?![\\s,]+(?:\\d{1,2}|(?:1[6-9]|20)\\d{2}))`,
			'g',
		);
		for (const m of sentence.matchAll(ctxMonthRe)) {
			if (m.index == null) continue;
			const monName = m[1]!;
			const mo = MONTH_MAP[monName.toLowerCase()];
			if (!mo) continue;
			// Only anchor when preceded by In/During/Back in at or near sentence start, and strictly earlier than ref month
			if (m.index > 24 || !/^(?:In|During|Earlier|Back)\b/.test(m[0])) continue;
			const yr: number = mo < ref.month ? ref.year : mo > ref.month ? ref.year - 1 : ref.year;
			if (yr === ref.year && mo === ref.month) continue;
			pushHit(m.index, m.index + m[0].length, makeDate(yr, mo, null), 2);
		}
	}

	// 8. Explicit historical year cues: "in 2019", "founded in 2021", "first charged in 2019", "since 2018"
	const histYearRe =
		/\b(?:in|from|founded\s+in|established\s+in|set\s+up\s+in|formed\s+in|launched\s+in|enacted\s+in|signed\s+in|passed\s+in|opened\s+in|built\s+in|completed\s+in|charged\s+in|indicted\s+in|began\s+in|started\s+in|first\s+\w+\s+in)\s+((?:1[7-9]|20)\d{2})\b/gi;
	for (const m of sentence.matchAll(histYearRe)) {
		if (m.index == null) continue;
		const y = Number(m[1]);
		if (ref.year != null && y === ref.year) continue;
		// Skip incidental law/order citations inside current-date sentences when sentence has no past verb before it
		const before = sentence.slice(Math.max(0, m.index - 40), m.index);
		if (/\b(?:rely\s+on\s+a|under\s+a|citing\s+a|pursuant\s+to)\s*$/i.test(before)) continue;
		pushHit(m.index, m.index + m[0].length, makeDate(y, null, null), 2);
	}

	// 9. Relative offset from an immediately preceding historical milestone ("two months later", "a year later")
	if (hits.length === 0 && prevHistoricalDate?.iso) {
		const relMonths = sentence.match(
			/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?\s+later\b/i,
		);
		if (relMonths) {
			const n = /^\d+$/.test(relMonths[1]!) ? Number(relMonths[1]) : WORD_NUM[relMonths[1]!.toLowerCase()] || 0;
			const ym = prevHistoricalDate.iso.match(/^(\d{4})-(\d{2})/);
			if (n > 0 && ym) {
				const totalMonths = Number(ym[1]) * 12 + (Number(ym[2]) - 1) + n;
				const ny = Math.floor(totalMonths / 12);
				const nm = (totalMonths % 12) + 1;
				const cand = makeDate(ny, nm, null);
				if (ref.sortKey <= 0 || cand.sortKey <= ref.sortKey) {
					hits.push({ ...cand, index: relMonths.index || 0, endIndex: (relMonths.index || 0) + relMonths[0].length, specificity: 2 });
				}
			}
		}
	}

	// 10. "six years since ..." when ref year is known
	if (hits.length === 0 && ref.year != null) {
		const yearsSince = sentence.match(
			/\b(?:has\s+been|been|was)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+years?\s+since\b/i,
		);
		if (yearsSince) {
			const n = /^\d+$/.test(yearsSince[1]!) ? Number(yearsSince[1]) : WORD_NUM[yearsSince[1]!.toLowerCase()] || 0;
			if (n >= 1 && n <= 50) {
				const y = ref.year - n;
				hits.push({
					...makeDate(y, null, null),
					index: yearsSince.index || 0,
					endIndex: (yearsSince.index || 0) + yearsSince[0].length,
					specificity: 1,
				});
			}
		}
	}

	return hits.sort((a, b) => a.index - b.index);
}

/**
 * Split a single sentence containing 2+ distinct historical dates joined by a temporal
 * conjunction (e.g. "OPM first suspended ... in December 2022 and later extended ... in December 2024.")
 * into separate dated clauses so each milestone gets its own timeline entry.
 */
function splitMultiDateSentence(
	sentence: string,
	hits: DateHit[],
): Array<{ text: string; date: ParsedMilestoneDate }> {
	if (hits.length < 2) {
		return hits.length === 1 ? [{ text: sentence, date: hits[0]! }] : [];
	}
	// Check if dates are genuinely distinct
	const distinct = new Map<string, DateHit>();
	for (const h of hits) {
		if (!distinct.has(h.label)) distinct.set(h.label, h);
	}
	if (distinct.size < 2) {
		return [{ text: sentence, date: hits[0]! }];
	}

	// Try splitting between the first two distinct date hits on " and later " / " and then " / " and in " / "; " / ", before "
	const ordered = [...distinct.values()].sort((a, b) => a.index - b.index);
	const first = ordered[0]!;
	const second = ordered[1]!;
	const between = sentence.slice(first.endIndex, second.index);
	const conj = between.match(/\s+(?:and\s+later|and\s+then|and\s+subsequently|and\s+(?:again\s+)?in|before\s+\w+ing|;\s*|\,\s+and\s+)/i);
	if (conj && conj.index != null) {
		const splitPos = first.endIndex + conj.index;
		const left = sentence.slice(0, splitPos).replace(/[,;:\s]+$/, '').trim();
		let right = sentence
			.slice(splitPos)
			.trim()
			.replace(/^(?:,\s*)?(?:and\s+later|and\s+then|and\s+subsequently|and|;)\s+/i, '')
			.trim();
		if (left.length >= 24 && right.length >= 20) {
			// Capitalize right clause cleanly
			right = right.charAt(0).toUpperCase() + right.slice(1);
			return [
				{ text: /[.!?]$/.test(left) ? left : `${left}.`, date: first },
				{ text: /[.!?]$/.test(right) ? right : `${right}.`, date: second },
			];
		}
	}

	// Otherwise anchor to the most specific / earliest-mentioned event date
	const best = [...ordered].sort((a, b) => b.specificity - a.specificity || a.index - b.index)[0]!;
	return [{ text: sentence, date: best }];
}

function normKey(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
		.slice(0, 80);
}

function pickConciseLead(paragraphs: string[], title?: string | null): string {
	const firstPara = paragraphs.find((p) => p.length >= 30 && !JUNK_LINE_RE.test(p)) || '';
	const sents = splitSentences(firstPara);
	let lead = '';
	for (const s of sents) {
		if (!lead) {
			lead = s;
			if (lead.length >= 130) break;
		} else if (lead.length + 1 + s.length <= 320) {
			lead = `${lead} ${s}`;
			if (lead.length >= 180) break;
		} else {
			break;
		}
	}
	if (!lead) lead = String(title || '').trim();
	return lead.slice(0, 360).trim();
}

/**
 * Format a raw prose / article summary for a `historic_event` profile into a
 * lead + `## Timeline` milestone breakdown (newest → oldest).
 */
export function formatHistoricEventSummaryToTimeline(
	summary: string,
	options: FormatHistoricEventSummaryOptions = {},
): FormatHistoricEventSummaryResult {
	const raw = String(summary || '').trim();
	if (!raw) {
		return { summary: raw, changed: false, lead: '', milestones: [], inferredStartDate: null };
	}

	if (!options.force && summaryAlreadyHasTimelinedView(raw)) {
		return { summary: raw, changed: false, lead: '', milestones: [], inferredStartDate: null };
	}

	const { body, preservedSections, extractedSources } = peelTrailingSections(raw);
	const cleanedBody = cleanProseBody(body);
	if (!cleanedBody) {
		return { summary: raw, changed: false, lead: '', milestones: [], inferredStartDate: null };
	}

	const rawParagraphs = cleanedBody
		.split(/\n\n+/)
		.map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((p) => p.length >= 15 && !JUNK_LINE_RE.test(p));

	if (!rawParagraphs.length) {
		return { summary: raw, changed: false, lead: '', milestones: [], inferredStartDate: null };
	}

	// Drop leading photo-caption paragraph if followed by real prose
	const paragraphs =
		rawParagraphs.length > 1 &&
		/^(?:A |An |The |Photo|Pictured|Exterior)/i.test(rawParagraphs[0]!) &&
		/\(Photo by|\bPhoto:\b|\(Courtesy|\(AP Photo|\(Getty/i.test(rawParagraphs[0]!) &&
		rawParagraphs[1]!.length > 60
			? rawParagraphs.slice(1)
			: rawParagraphs;

	const allSentences: Array<{ paraIdx: number; text: string }> = [];
	for (let pi = 0; pi < paragraphs.length; pi++) {
		const sents = splitSentences(paragraphs[pi]!);
		for (const s of sents) {
			if (s.length < 18 || JUNK_LINE_RE.test(s)) continue;
			allSentences.push({ paraIdx: pi, text: s });
		}
	}

	if (!allSentences.length) {
		return { summary: raw, changed: false, lead: '', milestones: [], inferredStartDate: null };
	}

	let ref = parseRefDate(options.startDate);
	let inferredStartDate: string | null = ref.iso;

	// If no startDate was supplied on the profile, infer reference date from the newest explicit full date in the text
	if (!ref.iso) {
		let bestFull: DateHit | null = null;
		for (const s of allSentences) {
			const hits = findDateHitsInSentence(s.text, ref, null);
			for (const h of hits) {
				if (h.precision === 'day' && (!bestFull || h.sortKey > bestFull.sortKey)) {
					bestFull = h;
				}
			}
		}
		if (bestFull?.iso) {
			ref = parseRefDate(bestFull.iso);
			inferredStartDate = bestFull.iso;
		}
	}

	const feedSuffix = options.sourceTag ? ` [${String(options.sourceTag).replace(/^\[|\]$/g, '').trim()}]` : '';
	const maxMilestones = Math.max(4, Math.min(20, options.maxMilestones ?? 10));

	// Single-sentence short stub → emit clean 1-entry ## Timeline without repeating identical lead
	if (allSentences.length === 1 && cleanedBody.length < 220) {
		const singleText = allSentences[0]!.text;
		const hits = findDateHitsInSentence(singleText, ref, null);
		const chosen = hits[0] || {
			iso: ref.iso,
			label: ref.label,
			sortKey: ref.sortKey,
			precision: ref.precision,
		};
		const milestone: HistoricEventMilestone = {
			iso: chosen.iso,
			dateLabel: chosen.label,
			sortKey: chosen.sortKey,
			precision: chosen.precision,
			text: singleText,
			isAnchorDate: hits.length > 0,
			order: 0,
		};
		const outLines = ['## Timeline', `- **${milestone.dateLabel}** — ${milestone.text}${feedSuffix}`];
		if (preservedSections.length) outLines.push('', ...preservedSections);
		else if (extractedSources.length || options.sourceUrl) {
			const urls = [
				...new Set([
					...extractedSources.filter((s) => /^https?:\/\//i.test(s)),
					...(options.sourceUrl ? [options.sourceUrl] : []),
				]),
			];
			if (urls.length) {
				outLines.push('', '## Source articles', ...urls.map((u) => `- ${u}`));
			}
		}
		return {
			summary: `${outLines.join('\n').trim()}\n`,
			changed: true,
			lead: '',
			milestones: [milestone],
			inferredStartDate,
		};
	}

	const lead = pickConciseLead(paragraphs, options.title);

	// Walk sentences in order, separating distinct historical/calendar anchors from current-date narrative beats
	type RawEntry = {
		date: ParsedMilestoneDate;
		isAnchorDate: boolean;
		sentences: string[];
		paraIdx: number;
		order: number;
	};

	const rawEntries: RawEntry[] = [];
	const defaultDate: ParsedMilestoneDate = {
		iso: ref.iso,
		label: ref.label,
		sortKey: ref.sortKey,
		precision: ref.precision,
	};

	let prevHistoricalDate: ParsedMilestoneDate | null = null;
	let orderSeq = 0;

	const isDistinctFromDefault = (d: ParsedMilestoneDate): boolean => {
		if (!d.iso) return false;
		if (!defaultDate.iso) return true;
		return d.iso !== defaultDate.iso;
	};

	for (const item of allSentences) {
		const hits = findDateHitsInSentence(item.text, ref, prevHistoricalDate);
		const distinctHits = hits.filter((h) => isDistinctFromDefault(h));

		if (distinctHits.length > 0) {
			const clauses = splitMultiDateSentence(item.text, distinctHits);
			for (const c of clauses) {
				const prev = rawEntries[rawEntries.length - 1];
				const canMergeSameAnchor =
					prev &&
					prev.isAnchorDate &&
					prev.date.label === c.date.label &&
					prev.paraIdx === item.paraIdx &&
					prev.sentences.join(' ').length + c.text.length <= 480;
				if (canMergeSameAnchor) {
					prev.sentences.push(c.text);
				} else {
					rawEntries.push({
						date: c.date,
						isAnchorDate: true,
						sentences: [c.text],
						paraIdx: item.paraIdx,
						order: orderSeq++,
					});
				}
				prevHistoricalDate = c.date;
			}
			continue;
		}

		// No distinct historical date in this sentence:
		// If it immediately continues a historical milestone in the SAME paragraph (and doesn't shift back to present tense quote), attach it.
		const prev = rawEntries[rawEntries.length - 1];
		const startsQuoteOrPresentReaction =
			/^[“"‘]/.test(item.text) ||
			/\b(?:told\s+\w+|said\s+(?:Wednesday|Thursday|Friday|Monday|Tuesday|today|in\s+a\s+statement)|declined\s+to\s+comment)\b/i.test(
				item.text,
			);
		if (
			prev &&
			prev.isAnchorDate &&
			prev.paraIdx === item.paraIdx &&
			!startsQuoteOrPresentReaction &&
			prev.sentences.join(' ').length + item.text.length <= 440
		) {
			prev.sentences.push(item.text);
			continue;
		}

		// Otherwise it is a current-date narrative beat.
		// Group adjacent current-date sentences within the same paragraph (or short consecutive paragraphs) up to ~440 chars.
		const prevTextLen = prev ? prev.sentences.join(' ').length : 0;
		const samePara = prev && !prev.isAnchorDate && prev.paraIdx === item.paraIdx;
		const tinyAdjacentPara =
			prev &&
			!prev.isAnchorDate &&
			item.paraIdx === prev.paraIdx + 1 &&
			prevTextLen < 160 &&
			!startsQuoteOrPresentReaction;
		const canMergeCurrent =
			prev &&
			!prev.isAnchorDate &&
			(samePara || tinyAdjacentPara) &&
			prev.sentences.length < 3 &&
			prevTextLen + 1 + item.text.length <= 460;

		if (canMergeCurrent) {
			prev.sentences.push(item.text);
		} else {
			rawEntries.push({
				date: defaultDate,
				isAnchorDate: false,
				sentences: [item.text],
				paraIdx: item.paraIdx,
				order: orderSeq++,
			});
		}
	}

	// Build candidate milestones, deduplicating near-identical text
	const seenText = new Set<string>();
	const allMilestones: HistoricEventMilestone[] = [];
	for (const entry of rawEntries) {
		const text = entry.sentences.join(' ').replace(/\s+/g, ' ').trim();
		if (text.length < 24) continue;
		const key = normKey(text);
		if (!key || seenText.has(key)) continue;
		seenText.add(key);
		allMilestones.push({
			iso: entry.date.iso,
			dateLabel: entry.date.label,
			sortKey: entry.date.sortKey,
			precision: entry.date.precision,
			text,
			isAnchorDate: entry.isAnchorDate,
			order: entry.order,
		});
	}

	if (!allMilestones.length) {
		return { summary: raw, changed: false, lead, milestones: [], inferredStartDate };
	}

	// Select milestones: ALWAYS keep distinct dated anchors (up to maxMilestones - 2),
	// and fill remaining budget with the leading current-date narrative beats in reading order.
	const anchorMilestones = allMilestones.filter((m) => m.isAnchorDate);
	const currentMilestones = allMilestones.filter((m) => !m.isAnchorDate);

	// If the very first current-date bullet only repeats the lead (no extra sentences beyond lead)
	// AND there are ≥2 other bullets, drop the exact duplicate. Keep it when it carries additional context.
	const leadKey = normKey(lead);
	let filteredCurrent = currentMilestones;
	if (
		filteredCurrent.length >= 2 &&
		leadKey &&
		normKey(filteredCurrent[0]!.text) === leadKey &&
		filteredCurrent[0]!.text.length <= lead.length + 25
	) {
		filteredCurrent = filteredCurrent.slice(1);
	}

	const anchorBudget = Math.min(anchorMilestones.length, Math.max(4, maxMilestones - 3));
	const keptAnchors = anchorMilestones.slice(0, anchorBudget);
	const currentBudget = Math.max(2, maxMilestones - keptAnchors.length);
	const keptCurrent = filteredCurrent.slice(0, currentBudget);

	const selected = [...keptCurrent, ...keptAnchors].sort((a, b) => {
		// Undated sinks last
		const aUndated = a.sortKey < 0 ? 1 : 0;
		const bUndated = b.sortKey < 0 ? 1 : 0;
		if (aUndated !== bUndated) return aUndated - bUndated;
		// Newest date first
		if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
		// Preserve natural narrative order among same-date bullets
		return a.order - b.order;
	});

	const timelineLines = selected.map((m) => `- **${m.dateLabel}** — ${m.text}${feedSuffix}`);

	const outLines: string[] = [];
	if (lead && (selected.length > 1 || normKey(lead) !== normKey(selected[0]!.text))) {
		outLines.push(lead, '');
	}
	outLines.push('## Timeline', ...timelineLines);

	if (preservedSections.length) {
		outLines.push('', ...preservedSections);
	} else {
		const urls = [
			...new Set([
				...extractedSources.filter((s) => /^https?:\/\//i.test(s)),
				...(options.sourceUrl ? [options.sourceUrl] : []),
			]),
		];
		const nonUrlSources = extractedSources.filter((s) => !/^https?:\/\//i.test(s));
		if (urls.length) {
			outLines.push('', '## Source articles', ...urls.map((u) => `- ${u}`));
		} else if (nonUrlSources.length) {
			outLines.push('', ...nonUrlSources);
		}
	}

	const finalSummary = `${outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
	return {
		summary: finalSummary,
		changed: finalSummary.trim() !== raw.trim(),
		lead,
		milestones: selected,
		inferredStartDate,
	};
}
