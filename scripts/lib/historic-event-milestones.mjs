/**
 * Shared ESM article → dated milestone extractor for Node CLI scripts
 * (news-rss-ingest.mjs, news-rss-format-card.mjs).
 *
 * Mirrors src/lib/research/profiles/historicEventTimeline.ts so RSS ingest,
 * batch formatting, and UI/API profile creation produce consistent milestones.
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
];

const MONTH_MAP = {
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

const WORD_NUM = {
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

const FUTURE_HORIZON_PREFIX_RE =
	/\b(?:until(?:\s+at\s+least)?|through(?:\s+at\s+least)?|by(?:\s+the\s+end\s+of)?|before|expir(?:e|es|ing|ation)\s+(?:in|on|by)|scheduled\s+(?:for|to\s+\w+\s+in)|set\s+(?:for|to\s+\w+\s+in)|planned\s+for|expected\s+(?:in|by|to\s+\w+\s+in)|runs?\s+(?:until|through)|lasting\s+(?:until|through)|projected\s+(?:for|by|in)|target(?:ed|ing)?\s+(?:for|in)|slated\s+for|no\s+later\s+than)\s*$/i;

const JUNK_LINE_RE =
	/^(?:source\s*:|https?:\/\/\S+$|advertisement|sponsored(?:\s+content)?|subscribe(?:\s+to)?|sign\s*up|newsletter|share\s+this|related\s+(?:articles?|stories|posts)|you\s+may\s+also\s+like|recommended|cookie\s+policy|accept\s+cookies|follow\s+us|leave\s+a\s+comment|comments?\s*$|tags?\s*:|tagged\s+with\s*:|categories?\s*:|posted\s+in\s*:|click\s+here|read\s+more\s*$|continue\s+reading|trending|popular\s+stories|from\s+our\s+partners|promo(?:ted)?\s+content|this\s+audio\s+is\s+auto-generated\.|see\s+also:|editor['’]s\s+note:|permission\s+granted\s+by\b|courtesy\s+of\b|image\s+courtesy\b|photo(?:\s+credit)?\s*:|credit\s*:|published\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|updated\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|dive\s+insight:?|senior\s+reporter\b|staff\s+reporter\b|if\s+you\s+would\s+like\s+to\s+contact\s+this\s+reporter\b|this\s+website\s+is\s+not\s+intended\s+for\s+users\b|all\s+rights\s+reserved\b|copyright\b|©\s*\d{4}\b)/i;

const ABBREV_PROTECT_RE =
	/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Col|Maj|Capt|Lt|Sgt|Rev|Hon|St|Jr|Sr|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|U\.S|U\.K|Inc|Ltd|Corp|Co|vs|No|Fig|Dept|Est|Approx)\./gi;

function pad2(n) {
	return String(n).padStart(2, '0');
}

export function formatFlexibleDateLabel(iso) {
	const s = String(iso || '').trim();
	if (!s) return null;
	const day = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})$/);
	if (day) {
		const m = Number(day[2]);
		const d = Number(day[3]);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			return `${MONTHS[m - 1]} ${d}, ${day[1]}`;
		}
	}
	const ym = s.match(/^((?:1[6-9]|20)\d{2})-(\d{2})$/);
	if (ym) {
		const m = Number(ym[2]);
		if (m >= 1 && m <= 12) return `${MONTHS[m - 1]} ${ym[1]}`;
	}
	if (/^(?:1[6-9]|20)\d{2}$/.test(s)) return s;
	return s;
}

function parseRefDate(raw) {
	const s = String(raw || '').trim();
	if (!s) return { iso: null, year: null, month: null, day: null, sortKey: -1, label: 'Undated', precision: 'unknown' };

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

function splitSentences(text) {
	const cleaned = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return [];
	const protected_ = cleaned
		.replace(ABBREV_PROTECT_RE, '$1˘')
		.replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1˘');
	return protected_
		.split(/(?<=[.!?]["”’']?)\s+(?=[A-Z“"‘(\d])/)
		.map((s) => s.replace(/˘/g, '.').trim())
		.filter(Boolean);
}

function makeDate(year, month, day, customLabel) {
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

function isFutureHorizon(text, matchIndex, candSortKey, refSortKey) {
	if (refSortKey <= 0 || candSortKey <= refSortKey) return false;
	const before = text.slice(Math.max(0, matchIndex - 42), matchIndex);
	if (FUTURE_HORIZON_PREFIX_RE.test(before)) return true;
	if (/\b(?:will|would|expected|projected|planned|scheduled|slated|aims?\s+to|target)\b/i.test(before)) {
		return true;
	}
	return false;
}

function findDateHitsInSentence(sentence, ref, prevHistoricalDate = null) {
	const hits = [];
	const occupied = [];
	const overlaps = (start, end) => occupied.some(([a, b]) => start < b && end > a);
	const pushHit = (start, end, parsed, specificity) => {
		if (overlaps(start, end)) return;
		if (isFutureHorizon(sentence, start, parsed.sortKey, ref.sortKey)) return;
		occupied.push([start, end]);
		hits.push({ ...parsed, index: start, endIndex: end, specificity });
	};

	for (const m of sentence.matchAll(/\b((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})\b/g)) {
		const y = Number(m[1]);
		const mo = Number(m[2]);
		const d = Number(m[3]);
		if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	const monDayYearRe = new RegExp(
		`\\b(${MONTH_TOKEN_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:1[6-9]|20)\\d{2})\\b`,
		'gi',
	);
	for (const m of sentence.matchAll(monDayYearRe)) {
		const mo = MONTH_MAP[m[1].toLowerCase().replace(/\.$/, '')];
		const d = Number(m[2]);
		const y = Number(m[3]);
		if (mo && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	const dayMonYearRe = new RegExp(
		`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_TOKEN_SRC})\\.?,?\\s+((?:1[6-9]|20)\\d{2})\\b`,
		'gi',
	);
	for (const m of sentence.matchAll(dayMonYearRe)) {
		const d = Number(m[1]);
		const mo = MONTH_MAP[m[2].toLowerCase().replace(/\.$/, '')];
		const y = Number(m[3]);
		if (mo && d >= 1 && d <= 31 && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 4);
		}
	}

	const monYearRe = new RegExp(`\\b(${MONTH_TOKEN_SRC})\\.?,?\\s+((?:1[6-9]|20)\\d{2})\\b`, 'gi');
	for (const m of sentence.matchAll(monYearRe)) {
		if (m[1] === 'may') continue;
		const mo = MONTH_MAP[m[1].toLowerCase().replace(/\.$/, '')];
		const y = Number(m[2]);
		if (mo && m.index != null) {
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, null), 3);
		}
	}

	for (const m of sentence.matchAll(/\b(Spring|Summer|Fall|Autumn|Winter)(?:\s+of)?\s+((?:1[6-9]|20)\d{2})\b/gi)) {
		if (m.index == null) continue;
		const seasonCap = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
		const mo = /spring/i.test(m[1]) ? 3 : /summer/i.test(m[1]) ? 6 : /winter/i.test(m[1]) ? 12 : 9;
		const y = Number(m[2]);
		pushHit(m.index, m.index + m[0].length, makeDate(y, mo, null, `${seasonCap} ${y}`), 3);
	}

	if (ref.year != null) {
		const monDayRe = new RegExp(`\\b(${MONTH_TOKEN_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
		for (const m of sentence.matchAll(monDayRe)) {
			if (m.index == null || m[1] === 'may') continue;
			const mo = MONTH_MAP[m[1].toLowerCase().replace(/\.$/, '')];
			const d = Number(m[2]);
			if (!mo || d < 1 || d > 31) continue;
			const afterChar = sentence[m.index + m[0].length] || '';
			if (/[%$]/.test(afterChar)) continue;
			let y = ref.year;
			if (ref.month != null && mo > ref.month + 1) {
				const before = sentence.slice(Math.max(0, m.index - 32), m.index);
				if (!FUTURE_HORIZON_PREFIX_RE.test(before) && !/\b(?:next|upcoming|scheduled|planned)\b/i.test(before)) {
					y = ref.year - 1;
				}
			}
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 3);
		}

		const dayMonRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_TOKEN_SRC})\\.?\\b`, 'gi');
		for (const m of sentence.matchAll(dayMonRe)) {
			if (m.index == null || m[2] === 'may') continue;
			const d = Number(m[1]);
			const mo = MONTH_MAP[m[2].toLowerCase().replace(/\.$/, '')];
			if (!mo || d < 1 || d > 31) continue;
			let y = ref.year;
			if (ref.month != null && mo > ref.month + 1) {
				const before = sentence.slice(Math.max(0, m.index - 32), m.index);
				if (!FUTURE_HORIZON_PREFIX_RE.test(before)) y = ref.year - 1;
			}
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, d), 3);
		}
	}

	if (ref.year != null && ref.month != null && hits.length === 0) {
		const ctxMonthRe =
			/(?:^|(?:In|During|Earlier\s+in|Back\s+in)\s+)(January|February|March|April|May|June|July|August|September|October|November|December)\b(?![\s,]+(?:\d{1,2}|(?:1[6-9]|20)\d{2}))/g;
		for (const m of sentence.matchAll(ctxMonthRe)) {
			if (m.index == null) continue;
			const mo = MONTH_MAP[m[1].toLowerCase()];
			if (!mo) continue;
			if (m.index > 24 || !/^(?:In|During|Earlier|Back)\b/.test(m[0])) continue;
			const y = mo < ref.month ? ref.year : mo > ref.month ? ref.year - 1 : ref.year;
			if (y === ref.year && mo === ref.month) continue;
			pushHit(m.index, m.index + m[0].length, makeDate(y, mo, null), 2);
		}
	}

	const histYearRe =
		/\b(?:in|from|founded\s+in|established\s+in|set\s+up\s+in|formed\s+in|launched\s+in|enacted\s+in|signed\s+in|passed\s+in|opened\s+in|built\s+in|completed\s+in|charged\s+in|indicted\s+in|began\s+in|started\s+in|first\s+\w+\s+in)\s+((?:1[7-9]|20)\d{2})\b/gi;
	for (const m of sentence.matchAll(histYearRe)) {
		if (m.index == null) continue;
		const y = Number(m[1]);
		if (ref.year != null && y === ref.year) continue;
		const before = sentence.slice(Math.max(0, m.index - 40), m.index);
		if (/\b(?:rely\s+on\s+a|under\s+a|citing\s+a|pursuant\s+to)\s*$/i.test(before)) continue;
		pushHit(m.index, m.index + m[0].length, makeDate(y, null, null), 2);
	}

	if (hits.length === 0 && prevHistoricalDate?.iso) {
		const relMonths = sentence.match(
			/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?\s+later\b/i,
		);
		if (relMonths) {
			const n = /^\d+$/.test(relMonths[1]) ? Number(relMonths[1]) : WORD_NUM[relMonths[1].toLowerCase()] || 0;
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

	if (hits.length === 0 && ref.year != null) {
		const yearsSince = sentence.match(
			/\b(?:has\s+been|been|was)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+years?\s+since\b/i,
		);
		if (yearsSince) {
			const n = /^\d+$/.test(yearsSince[1]) ? Number(yearsSince[1]) : WORD_NUM[yearsSince[1].toLowerCase()] || 0;
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

function splitMultiDateSentence(sentence, hits) {
	if (hits.length < 2) {
		return hits.length === 1 ? [{ text: sentence, date: hits[0] }] : [];
	}
	const distinct = new Map();
	for (const h of hits) {
		if (!distinct.has(h.label)) distinct.set(h.label, h);
	}
	if (distinct.size < 2) return [{ text: sentence, date: hits[0] }];

	const ordered = [...distinct.values()].sort((a, b) => a.index - b.index);
	const first = ordered[0];
	const second = ordered[1];
	const between = sentence.slice(first.endIndex, second.index);
	const conj = between.match(/\s+(?:and\s+later|and\s+then|and\s+subsequently|and\s+(?:again\s+)?in|before\s+\w+ing|;\s*|,\s+and\s+)/i);
	if (conj && conj.index != null) {
		const splitPos = first.endIndex + conj.index;
		const left = sentence.slice(0, splitPos).replace(/[,;:\s]+$/, '').trim();
		let right = sentence
			.slice(splitPos)
			.trim()
			.replace(/^(?:,\s*)?(?:and\s+later|and\s+then|and\s+subsequently|and|;)\s+/i, '')
			.trim();
		if (left.length >= 24 && right.length >= 20) {
			right = right.charAt(0).toUpperCase() + right.slice(1);
			return [
				{ text: /[.!?]$/.test(left) ? left : `${left}.`, date: first },
				{ text: /[.!?]$/.test(right) ? right : `${right}.`, date: second },
			];
		}
	}

	const best = [...ordered].sort((a, b) => b.specificity - a.specificity || a.index - b.index)[0];
	return [{ text: sentence, date: best }];
}

function normKey(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
		.slice(0, 80);
}

/**
 * Extract structured, newest-first milestones from cleaned article prose.
 * Returns objects compatible with news-rss-format-card bullets:
 *   { iso, dateLabel, sortKey, title, text, kind }
 */
export function extractArticleMilestones(body, profile = {}, { maxBullets = 10 } = {}) {
	const cleaned = String(body || '')
		.replace(/\r/g, '')
		.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
		.replace(/\.(?=[A-Z][a-z])/g, '. ')
		.replace(/([.!?])"(?=[A-Z])/g, '$1" ')
		.replace(/([.!?])\u201d(?=[A-Z])/g, '$1\u201d ')
		.replace(/(\d)([A-Z][a-z])/g, '$1. $2')
		.replace(/\bU\.\s+S\./g, 'U.S.')
		.replace(/\bU\.\s+K\./g, 'U.K.')
		.trim();
	if (!cleaned) return [];

	const rawParas = cleaned
		.split(/\n\n+/)
		.map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((p) => p.length >= 15 && !JUNK_LINE_RE.test(p));
	if (!rawParas.length) return [];

	const paragraphs =
		rawParas.length > 1 &&
		/^(?:A |An |The |Photo|Pictured|Exterior)/i.test(rawParas[0]) &&
		/\(Photo by|\bPhoto:\b|\(Courtesy|\(AP Photo|\(Getty/i.test(rawParas[0]) &&
		rawParas[1].length > 60
			? rawParas.slice(1)
			: rawParas;

	const allSentences = [];
	for (let pi = 0; pi < paragraphs.length; pi++) {
		for (const s of splitSentences(paragraphs[pi])) {
			if (s.length < 18 || JUNK_LINE_RE.test(s)) continue;
			allSentences.push({ paraIdx: pi, text: s });
		}
	}
	if (!allSentences.length) return [];

	let ref = parseRefDate(profile.startDate);
	if (!ref.iso) {
		let bestFull = null;
		for (const s of allSentences) {
			for (const h of findDateHitsInSentence(s.text, ref, null)) {
				if (h.precision === 'day' && (!bestFull || h.sortKey > bestFull.sortKey)) {
					bestFull = h;
				}
			}
		}
		if (bestFull?.iso) ref = parseRefDate(bestFull.iso);
	}

	const defaultDate = {
		iso: ref.iso,
		label: ref.label,
		sortKey: ref.sortKey,
		precision: ref.precision,
	};

	const isDistinctFromDefault = (d) => {
		if (!d.iso) return false;
		if (!defaultDate.iso) return true;
		return d.iso !== defaultDate.iso;
	};

	const rawEntries = [];
	let prevHistoricalDate = null;
	let orderSeq = 0;

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

	const seenText = new Set();
	const allMilestones = [];
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
			title: '',
			text,
			kind: entry.isAnchorDate ? 'dated' : 'paragraph',
			isAnchorDate: entry.isAnchorDate,
			order: entry.order,
		});
	}

	const anchors = allMilestones.filter((m) => m.isAnchorDate);
	const current = allMilestones.filter((m) => !m.isAnchorDate);
	const anchorBudget = Math.min(anchors.length, Math.max(4, maxBullets - 3));
	const keptAnchors = anchors.slice(0, anchorBudget);
	const currentBudget = Math.max(2, maxBullets - keptAnchors.length);
	const keptCurrent = current.slice(0, currentBudget);

	return [...keptCurrent, ...keptAnchors].sort((a, b) => {
		const aUndated = a.sortKey < 0 ? 1 : 0;
		const bUndated = b.sortKey < 0 ? 1 : 0;
		if (aUndated !== bUndated) return aUndated - bUndated;
		if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
		return a.order - b.order;
	});
}
