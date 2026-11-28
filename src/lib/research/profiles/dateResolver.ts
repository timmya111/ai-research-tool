import http from 'node:http';
import { normalizeIsoDate, normalizeText, stripLegalSuffixes } from '@/lib/research/profiles/normalize';
import type { ProfileType } from '@/lib/research/profiles/types';

function fetchLocalHttpText(urlStr: string, timeoutMs = 4000, redirectsLeft = 4): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (val: string | null) => {
			if (settled) return;
			settled = true;
			resolve(val);
		};
		try {
			const u = new URL(urlStr);
			const req = http.get(
				{
					hostname: u.hostname,
					port: u.port ? Number(u.port) : 80,
					path: u.pathname + u.search,
					agent: false,
					headers: { Connection: 'close', Accept: 'text/html' },
					timeout: timeoutMs,
				},
				(res) => {
					const status = res.statusCode || 0;
					if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
						res.resume();
						const nextUrl = new URL(res.headers.location, urlStr).toString();
						void fetchLocalHttpText(nextUrl, timeoutMs, redirectsLeft - 1).then(finish);
						return;
					}
					if (status !== 200) {
						res.resume();
						finish(null);
						return;
					}
					const chunks: Buffer[] = [];
					let totalBytes = 0;
					res.on('data', (c: Buffer) => {
						// Cap read at 220 KB — RLCONF, infobox, and lead paragraphs are always in the top portion
						if (totalBytes < 220_000) {
							chunks.push(c);
							totalBytes += c.length;
						}
					});
					res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
					res.on('error', () => finish(null));
				},
			);
			req.on('timeout', () => {
				req.destroy();
				finish(null);
			});
			req.on('error', () => finish(null));
		} catch {
			finish(null);
		}
	});
}

const UA = 'AIResearchTool/1.0 (local-research-workbench; contact=local)';

function getLocalKiwixBase(): string {
	const raw = String(process.env.KIWIX_SERVE_ORIGIN || process.env.RESEARCH_KIWIX_ORIGIN || '')
		.trim()
		.replace(/\/$/, '');
	return `${raw || 'http://127.0.0.1:8765'}/content/wikipedia_en_all_maxi`;
}

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&ndash;/gi, '–')
		.replace(/&mdash;/gi, '—')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/<[^>]+>/g, ' ')
		.replace(/\[\d+\]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Parse startDate, endDate, categories, and lead text directly from a Wikipedia article's HTML
 * (served locally by kiwix-serve with zero rate limits).
 */
export function parseWikipediaArticleHtml(
	html: string,
	profileType: ProfileType,
): {
	title: string | null;
	leadText: string;
	categories: string[];
	startDate: string | null;
	endDate: string | null;
	matchesType: boolean;
} {
	if (!html || html.length < 400) {
		return { title: null, leadText: '', categories: [], startDate: null, endDate: null, matchesType: false };
	}

	// 1. Parse RLCONF wgTitle & wgCategories
	let title: string | null = null;
	let categories: string[] = [];
	const titleM = html.match(/"wgTitle"\s*:\s*("(?:\\.|[^"\\])*")/);
	if (titleM) {
		try {
			title = String(JSON.parse(titleM[1]!));
		} catch {
			title = titleM[1]!
				.slice(1, -1)
				.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
				.replace(/\\"/g, '"');
		}
	}
	const catsM = html.match(/"wgCategories"\s*:\s*(\[[^\]]*\])/);
	if (catsM) {
		try {
			const parsed = JSON.parse(catsM[1]!) as unknown;
			if (Array.isArray(parsed)) categories = parsed.map(String);
		} catch {
			/* ignore */
		}
	}
	const catsLow = categories.map((c) => c.toLowerCase());
	if (catsLow.some((c) => c.includes('disambiguation'))) {
		return { title, leadText: '', categories, startDate: null, endDate: null, matchesType: false };
	}

	// 2. Extract lead paragraphs (first ~1200 chars of visible <p> text)
	const bodyStart = html.indexOf('<body');
	const bodySlice = html.slice(bodyStart >= 0 ? bodyStart : 0, (bodyStart >= 0 ? bodyStart : 0) + 45_000);
	const pChunks: string[] = [];
	for (const pm of bodySlice.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
		const txt = decodeHtmlEntities(pm[1] || '');
		if (txt.length >= 40) {
			pChunks.push(txt);
			if (pChunks.join(' ').length >= 1000) break;
		}
	}
	const leadText = pChunks.join(' ').slice(0, 1200);

	// 3. Strict profileType verification via categories + lead text
	const hasPersonCat = catsLow.some((c) => /\b(?:\d{4} births|\d{4} deaths|living people|alumni|politicians|businesspeople|executives|lawyers|scientists|officers|generals)\b/.test(c));
	const hasFirmCat = catsLow.some((c) => /\b(?:companies|banks|firms|corporations|businesses|financial services|manufacturers|retailers|airlines|railroads|brands|subsidiaries|law firms|insurers|publishers|utilities|producers|contractors)\b/.test(c));
	const hasEduCat = catsLow.some((c) => /\b(?:universities|colleges|schools|seminaries|academies|educational institutions)\b/.test(c));
	const hasHospCat = catsLow.some((c) => /\b(?:hospitals|medical centers|clinics|health systems|healthcare)\b/.test(c));
	const hasGovCat = catsLow.some((c) => /\b(?:agencies|departments|ministries|governments|courts|commissions|boards|military|legislatures|parliaments|countries|states|municipalities|counties|cities)\b/.test(c));
	const hasNonprofitCat = catsLow.some((c) => /\b(?:non-profit|nonprofit|foundations|charities|associations|organizations|organisations|societies|institutes|churches|families|dynasties|clubs|unions|alliances|councils)\b/.test(c));

	let matchesType = false;
	if (profileType === 'person') {
		matchesType = hasPersonCat || wikiMatchesProfileType('person', leadText);
	} else if (profileType === 'firm') {
		matchesType = !hasPersonCat && (hasFirmCat || wikiMatchesProfileType('firm', leadText));
	} else if (profileType === 'education') {
		matchesType = !hasPersonCat && (hasEduCat || wikiMatchesProfileType('education', leadText));
	} else if (profileType === 'medical_hospital') {
		matchesType = !hasPersonCat && (hasHospCat || wikiMatchesProfileType('medical_hospital', leadText));
	} else if (profileType === 'government') {
		matchesType = !hasPersonCat && (hasGovCat || wikiMatchesProfileType('government', leadText));
	} else if (profileType === 'nonprofit') {
		matchesType = !hasPersonCat && (hasNonprofitCat || wikiMatchesProfileType('nonprofit', leadText));
	} else {
		matchesType = true;
	}

	if (!matchesType) {
		return { title, leadText, categories, startDate: null, endDate: null, matchesType: false };
	}

	let startDate: string | null = null;
	let endDate: string | null = null;

	// 4. Parse Infobox structured rows (<table class="infobox ...">)
	const ibMatch = html.match(/<table\b[^>]*class="[^"]*infobox[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
	const ibHtml = ibMatch ? ibMatch[1]! : '';

	if (profileType === 'person') {
		const bdayM = ibHtml.match(/class="[^"]*\bbday\b[^"]*"[^>]*>([^<]+)</i);
		if (bdayM) startDate = parseDateToken(decodeHtmlEntities(bdayM[1]!));
		const ddayM = ibHtml.match(/class="[^"]*\bdday\b[^"]*"[^>]*>([^<]+)</i);
		if (ddayM) endDate = parseDateToken(decodeHtmlEntities(ddayM[1]!));

		for (const tr of ibHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
			const thM = tr[1]!.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
			const tdM = tr[1]!.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
			if (!thM || !tdM) continue;
			const label = decodeHtmlEntities(thM[1]!).toLowerCase();
			const val = decodeHtmlEntities(tdM[1]!);
			if (!startDate && /^born\b/.test(label)) {
				const dm = val.match(new RegExp(`(${DATE_TOKEN_RE})`, 'i'));
				if (dm) startDate = parseDateToken(dm[1]);
			}
			if (!endDate && /^died\b/.test(label)) {
				const dm = val.match(new RegExp(`(${DATE_TOKEN_RE})`, 'i'));
				if (dm) endDate = parseDateToken(dm[1]);
			}
		}
		// Fallback to Wikipedia categories ("1912 births", "1973 deaths")
		if (!startDate) {
			for (const c of categories) {
				const m = c.match(/^((?:1[4-9]|20)\d{2})\s+births$/i);
				if (m) {
					startDate = m[1]!;
					break;
				}
			}
		}
		if (!endDate) {
			for (const c of categories) {
				const m = c.match(/^((?:1[4-9]|20)\d{2})\s+deaths$/i);
				if (m) {
					endDate = m[1]!;
					break;
				}
			}
		}
	} else {
		for (const tr of ibHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
			const thM = tr[1]!.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
			const tdM = tr[1]!.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
			if (!thM || !tdM) continue;
			const label = decodeHtmlEntities(thM[1]!).toLowerCase();
			const val = decodeHtmlEntities(tdM[1]!);
			if (
				!startDate &&
				/^(?:founded|established|formed|incorporated|opened|chartered|created|constituted|date|start\s+date|in\s+operation)/.test(label)
			) {
				const spanM = val.match(new RegExp(`(${DATE_TOKEN_RE})\\s*[–—-]\\s*(${DATE_TOKEN_RE})`, 'i'));
				if (spanM) {
					startDate = parseDateToken(spanM[1]);
					if (!endDate) endDate = parseDateToken(spanM[2]);
				} else {
					const dm = val.match(new RegExp(`(${DATE_TOKEN_RE})`, 'i'));
					if (dm) startDate = parseDateToken(dm[1]);
				}
			}
			if (
				!endDate &&
				/^(?:defunct|dissolved|closed|disbanded|abolished|ended|end\s+date|terminated|ceased)/.test(label)
			) {
				const dm = val.match(new RegExp(`(${DATE_TOKEN_RE})`, 'i'));
				if (dm) {
					const d = parseDateToken(dm[1]);
					if (d && (!startDate || d >= startDate)) endDate = d;
				}
			}
		}
		// Fallback to Wikipedia establishment / disestablishment categories
		if (!startDate) {
			for (const c of categories) {
				const m =
					c.match(/\bestablished\s+in\s+((?:1[4-9]|20)\d{2})\b/i) ||
					c.match(/^((?:1[4-9]|20)\d{2})\s+establishments\b/i);
				if (m) {
					startDate = m[1]!;
					break;
				}
			}
		}
		if (!endDate) {
			for (const c of categories) {
				const m =
					c.match(/\bdisestablished\s+in\s+((?:1[4-9]|20)\d{2})\b/i) ||
					c.match(/^((?:1[4-9]|20)\d{2})\s+disestablishments\b/i);
				if (m && (!startDate || m[1]! >= startDate.slice(0, 4))) {
					endDate = m[1]!;
					break;
				}
			}
		}
	}

	// 5. Fallback to lead prose extraction
	if (!startDate || !endDate) {
		const prose = extractDatesFromProse(leadText, profileType, title || undefined);
		if (!startDate && prose.startDate) startDate = prose.startDate;
		if (!endDate && prose.endDate) endDate = prose.endDate;
	}

	return { title, leadText, categories, startDate, endDate, matchesType: true };
}

/**
 * Look up an entity directly against the local offline Kiwix Wikipedia ZIM server (zero rate limits, ~2ms/article).
 */
export async function lookupLocalKiwixEntityDates(input: {
	name: string;
	profileType: ProfileType;
	existingWikiUrl?: string | null;
}): Promise<ResolvedEntityDates | null> {
	const base = getLocalKiwixBase();
	const candidates = buildWikiTitleCandidates(input.name, input.profileType);
	if (input.existingWikiUrl) {
		const m = input.existingWikiUrl.match(/wikipedia\.org\/wiki\/([^#?]+)/i);
		if (m) {
			const dec = decodeURIComponent(m[1]!).replace(/_/g, ' ').trim();
			if (dec && !candidates.some((c) => c.toLowerCase() === dec.toLowerCase())) {
				candidates.unshift(dec);
			}
		}
	}

	for (const cand of candidates) {
		const slug = encodeURIComponent(cand.replace(/\s+/g, '_')).replace(/%2F/g, '/');
		try {
			const html = await fetchLocalHttpText(`${base}/${slug}`, 4_000);
			if (!html) continue;
			const parsed = parseWikipediaArticleHtml(html, input.profileType);
			if (!parsed.matchesType) continue;
			if (!parsed.startDate && !parsed.endDate && !parsed.leadText) continue;
			const resolvedTitle = parsed.title || cand;
			return {
				startDate: parsed.startDate,
				endDate: parsed.endDate,
				qid: null,
				wikiUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, '_'))}`,
				wikiTitle: resolvedTitle,
				wikiExtract: parsed.leadText || null,
				source: 'local_kiwix_wikipedia',
			};
		} catch {
			return null;
		}
	}
	return null;
}

export type ResolvedEntityDates = {
	startDate: string | null;
	endDate: string | null;
	qid: string | null;
	wikiUrl: string | null;
	wikiTitle: string | null;
	wikiExtract: string | null;
	source: string | null;
};

const MONTH_RE =
	'(?:Jan(?:uary|\\.)?|Feb(?:ruary|\\.)?|Mar(?:ch|\\.)?|Apr(?:il|\\.)?|May|Jun(?:e|\\.)?|Jul(?:y|\\.)?|Aug(?:ust|\\.)?|Sep(?:t(?:ember)?|\\.)?|Oct(?:ober|\\.)?|Nov(?:ember|\\.)?|Dec(?:ember|\\.)?)';
const DATE_TOKEN_RE = `(?:\\d{4}-\\d{2}-\\d{2}|${MONTH_RE}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MONTH_RE}\\s+\\d{4}|${MONTH_RE}\\s+\\d{4}|(?:1[5-9]|20)\\d{2})`;

function parseDateToken(raw: string | null | undefined): string | null {
	const s = String(raw || '').trim();
	if (!s) return null;
	const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (us) {
		const y = Number(us[3]);
		if (y >= 1400 && y <= 2030) {
			return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
		}
	}
	const norm = normalizeIsoDate(s).date;
	if (!norm) return null;
	const yr = Number(norm.slice(0, 4));
	if (!Number.isFinite(yr) || yr < 1000 || yr > 2030) return null;
	return norm;
}

/**
 * Extract verified startDate (birth / founding / incorporation / event start) and
 * endDate (death / dissolution / defunct / event end) from prose or summary text.
 */
export function extractDatesFromProse(
	rawText: string,
	profileType: ProfileType,
	entityName?: string,
): { startDate: string | null; endDate: string | null } {
	const text = String(rawText || '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/[\r\n]+/g, '\n')
		.trim();
	if (!text) return { startDate: null, endDate: null };

	// Only inspect the lead portion (before ## Land Deeds or ## Timeline) for entity lifespan dates
	const cutIdx = (() => {
		const idxLd = text.indexOf('## Land Deeds');
		const idxTl = text.indexOf('## Timeline');
		const idxSrc = text.indexOf('## Sources');
		const cands = [idxLd, idxTl, idxSrc].filter((n) => n >= 0);
		return cands.length ? Math.min(...cands) : text.length;
	})();
	const lead = text.slice(0, Math.min(cutIdx, 2200)).trim();
	const leadSingle = lead.replace(/\s+/g, ' ');

	let startDate: string | null = null;
	let endDate: string | null = null;

	if (profileType === 'person') {
		// 1. Standard bio lifespan in opening sentence: "Name (May 1, 1912 – February 22, 1973)" or "(1839–1937)"
		const parenLife = leadSingle.slice(0, 320).match(
			new RegExp(`\\((?:(?:born|b\\.)\\s+)?(${DATE_TOKEN_RE})\\s*[–—-]\\s*(?:(?:died|d\\.)\\s+)?(${DATE_TOKEN_RE})\\)`, 'i'),
		);
		if (parenLife) {
			const s = parseDateToken(parenLife[1]);
			const e = parseDateToken(parenLife[2]);
			if (s && e && Number(e.slice(0, 4)) >= Number(s.slice(0, 4)) + 15) {
				startDate = s;
				endDate = e;
			}
		}
		// 2. "(born June 18, 1937)" or "(b. 1945)"
		if (!startDate) {
			const bornParen = leadSingle.slice(0, 400).match(
				new RegExp(`\\((?:born|b\\.)\\s+(?:on\\s+)?(${DATE_TOKEN_RE})(?:[,;\\s)]|$)`, 'i'),
			);
			if (bornParen) startDate = parseDateToken(bornParen[1]);
		}
		if (!startDate) {
			const bornProse = leadSingle.slice(0, 600).match(
				new RegExp(`\\bwas\\s+born\\s+(?:on\\s+|in\\s+)?(${DATE_TOKEN_RE})\\b`, 'i'),
			);
			if (bornProse) startDate = parseDateToken(bornProse[1]);
		}
		if (!endDate) {
			const diedProse = leadSingle.slice(0, 700).match(
				new RegExp(`\\b(?:died|passed\\s+away)\\s+(?:on\\s+|in\\s+)?(${DATE_TOKEN_RE})\\b`, 'i'),
			);
			if (diedProse) {
				const d = parseDateToken(diedProse[1]);
				if (d && (!startDate || d >= startDate)) endDate = d;
			}
		}
		return { startDate, endDate };
	}

	if (profileType === 'historic_event') {
		// Check explicit date range or single date in lead or entity name
		const hay = `${entityName || ''} ${leadSingle.slice(0, 500)}`;
		const spanM = hay.match(new RegExp(`(${DATE_TOKEN_RE})\\s*[–—-]\\s*(${DATE_TOKEN_RE})`, 'i'));
		if (spanM) {
			const s = parseDateToken(spanM[1]);
			const e = parseDateToken(spanM[2]);
			if (s && e && e >= s) {
				return { startDate: s, endDate: e };
			}
		}
		const singleM = hay.match(new RegExp(`\\b(${DATE_TOKEN_RE})\\b`, 'i'));
		if (singleM) {
			startDate = parseDateToken(singleM[1]);
		}
		return { startDate, endDate };
	}

	// Firms, nonprofits, government, education, medical_hospital, region:
	// 1. FINRA / BrokerCheck approval line: "Approved 2018-10-10"
	const approvedM = leadSingle.match(/\bApproved\s+(\d{4}-\d{2}-\d{2})\b/i);
	if (approvedM) startDate = parseDateToken(approvedM[1]);

	// 2. Leading parenthetical lifespan right near entity name: "Humble Oil (1911–1973)"
	if (!startDate) {
		const orgSpan = leadSingle.slice(0, 260).match(
			new RegExp(`\\((${DATE_TOKEN_RE})\\s*[–—-]\\s*(${DATE_TOKEN_RE})\\)`, 'i'),
		);
		if (orgSpan) {
			const s = parseDateToken(orgSpan[1]);
			const e = parseDateToken(orgSpan[2]);
			if (s && e && e >= s) {
				startDate = s;
				endDate = e;
			}
		}
	}

	// 3. Explicit founding / formation / incorporation / establishment verbs
	if (!startDate) {
		const foundRe = new RegExp(
			`\\b(?:founded|established|incorporated|formed|chartered|created|organized|opened|launched|started|begun|originated|constituted)\\s+(?:in\\s+|on\\s+)?(${DATE_TOKEN_RE})\\b`,
			'i',
		);
		const m = leadSingle.match(foundRe);
		if (m) startDate = parseDateToken(m[1]);
	}
	if (!startDate) {
		const sinceRe = new RegExp(
			`\\b(?:operating|active|serving|in\\s+business)\\s+since\\s+(${DATE_TOKEN_RE})\\b`,
			'i',
		);
		const m = leadSingle.match(sinceRe);
		if (m) startDate = parseDateToken(m[1]);
	}

	// 4. Explicit dissolution / defunct / closure / merger-termination verbs
	if (!endDate) {
		const defunctRe = new RegExp(
			`\\b(?:dissolved|defunct|ceased\\s+operations|liquidated|shut\\s+down|closed\\s+(?:its\\s+doors|permanently|operations)|disbanded|abolished|terminated)\\s+(?:in\\s+|on\\s+)?(${DATE_TOKEN_RE})\\b`,
			'i',
		);
		const m = leadSingle.match(defunctRe);
		if (m) {
			const d = parseDateToken(m[1]);
			if (d && (!startDate || d >= startDate)) endDate = d;
		}
	}
	if (!endDate && /\b(?:former|defunct|dissolved|predecessor|historic(?:al)?)\b/i.test(leadSingle.slice(0, 350))) {
		const mergedRe = new RegExp(
			`\\b(?:merged\\s+into|folded\\s+into|absorbed\\s+into|renamed\\s+[A-Z][^.,;]{1,40})\\s+(?:in\\s+|on\\s+)?(${DATE_TOKEN_RE})\\b`,
			'i',
		);
		const m = leadSingle.match(mergedRe);
		if (m) {
			const d = parseDateToken(m[1]);
			if (d && (!startDate || d >= startDate)) endDate = d;
		}
	}

	return { startDate, endDate };
}

export function extractWikidataTime(
	claims: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>> | undefined,
	prop: string,
): string | null {
	const arr = claims?.[prop];
	if (!Array.isArray(arr) || arr.length === 0) return null;
	for (const item of arr) {
		const raw = item?.mainsnak?.datavalue?.value?.time;
		if (!raw) continue;
		const m = String(raw).match(/^\+?(\d{4})-(\d{2})-(\d{2})/);
		if (!m) continue;
		const yr = Number(m[1]);
		if (yr < 1000 || yr > 2030) continue;
		if (m[2] === '00') return m[1]!;
		if (m[3] === '00') return `${m[1]}-${m[2]}`;
		return `${m[1]}-${m[2]}-${m[3]}`;
	}
	return null;
}

export function extractDatesFromWikidataClaims(
	claims: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>> | undefined,
	profileType: ProfileType,
): { startDate: string | null; endDate: string | null } {
	if (!claims) return { startDate: null, endDate: null };
	if (profileType === 'person') {
		return {
			startDate: extractWikidataTime(claims, 'P569'),
			endDate: extractWikidataTime(claims, 'P570'),
		};
	}
	if (profileType === 'historic_event') {
		const start =
			extractWikidataTime(claims, 'P580') ||
			extractWikidataTime(claims, 'P585') ||
			extractWikidataTime(claims, 'P571');
		const end = extractWikidataTime(claims, 'P582') || extractWikidataTime(claims, 'P576');
		return { startDate: start, endDate: end };
	}
	return {
		startDate:
			extractWikidataTime(claims, 'P571') ||
			extractWikidataTime(claims, 'P1619') ||
			extractWikidataTime(claims, 'P580'),
		endDate:
			extractWikidataTime(claims, 'P576') ||
			extractWikidataTime(claims, 'P582'),
	};
}

/** Verify that a Wikipedia extract & Wikidata description plausibly match the expected profileType. */
export function wikiMatchesProfileType(
	profileType: ProfileType,
	extract: string,
	wdDescription?: string | null,
): boolean {
	const hay = `${wdDescription || ''} ${extract.slice(0, 450)}`.toLowerCase();
	if (!hay.trim()) return false;
	if (/may refer to:|is a disambiguation/i.test(hay.slice(0, 260))) return false;
	if (profileType === 'person') {
		// Reject obvious non-person articles (places, films, albums, companies)
		if (/\b(?:is a (?:city|town|village|county|municipality|film|album|song|band|company|corporation|river|lake|mountain|school|university|hospital))\b/.test(hay)) {
			return false;
		}
		return (
			/\b(?:born|died|is an?|was an?)\b/.test(hay) &&
			(/\(\s*(?:born|b\.|c\.|1[5-9]\d{2}|20[0-2]\d|[a-z]+\s+\d{1,2},?\s+\d{4})/.test(hay) ||
				/\b(?:politician|businessman|businesswoman|executive|entrepreneur|attorney|lawyer|judge|scientist|professor|banker|financier|philanthropist|author|journalist|general|admiral|senator|governor|representative|officer|director|founder|ceo|investor|physician|doctor|engineer|architect|actor|musician|activist|diplomat)\b/.test(hay))
		);
	}
	if (profileType === 'firm') {
		if (/\b(?:is a (?:city|town|village|county|river|lake|mountain|film|album|song|novel|person|politician|actor|footballer|player))\b/.test(hay)) {
			return false;
		}
		return /\b(?:company|corporation|firm|bank|bancorp|financial|oil|energy|petroleum|refining|manufacturer|enterprise|conglomerate|subsidiary|holdings|inc\.|llc|ltd|plc|law firm|brokerage|insurer|insurance|railroad|airline|retailer|chain|brand|publisher|agency|provider|developer|operator|producer|group|services|investments|capital|partners|trust|ventures|industries|pharmaceutical|biotech|aerospace|defense|defense contractor|telecom|software|technology|automotive|mining|chemical|utility)\b/.test(
			hay,
		);
	}
	if (profileType === 'education') {
		return /\b(?:university|college|school|institute|academy|seminary|polytechnic|campus|educational)\b/.test(hay);
	}
	if (profileType === 'medical_hospital') {
		return /\b(?:hospital|medical center|clinic|health system|healthcare|infirmary|sanatorium|rehabilitation)\b/.test(hay);
	}
	if (profileType === 'government') {
		return /\b(?:agency|department|ministry|bureau|commission|board|authority|court|office|administration|service|command|corps|force|parliament|congress|senate|legislature|government|federal|state|municipal|county|city|republic|kingdom|country|nation|territory)\b/.test(
			hay,
		);
	}
	if (profileType === 'nonprofit') {
		return /\b(?:nonprofit|non-profit|foundation|charity|charitable|association|society|institute|organization|organisation|alliance|council|federation|union|fellowship|guild|league|trust|church|ministry|family|dynasty|philanthrop|club|committee|coalition)\b/.test(
			hay,
		);
	}
	return true;
}

/** Generate clean candidate Wikipedia titles for a profile name (e.g., "Humble Oil & Refining Co" -> "Humble Oil"). */
export function buildWikiTitleCandidates(name: string, profileType: ProfileType): string[] {
	const raw = String(name || '').trim();
	if (!raw) return [];
	// Skip bare 2-4 letter ALL-CAPS callsigns/acronyms (e.g., KNOC -> radio station) unless an explicit wiki URL exists
	if (raw.length <= 4 && /^[A-Z0-9]+$/.test(raw)) return [];
	const out: string[] = [];
	const push = (s: string) => {
		const clean = s.replace(/\s+/g, ' ').trim();
		if (clean.length >= 3 && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) {
			out.push(clean);
		}
	};

	push(raw);
	// Strip parenthesized qualifiers like "(NYSE: XOM)" or "(NARCA)"
	const noParen = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
	if (noParen !== raw) push(noParen);

	if (profileType !== 'person') {
		// Expand abbreviated endings ("Co" -> "Company", "Corp" -> "Corporation")
		const expanded = noParen
			.replace(/,?\s+\bCo\.?$/i, ' Company')
			.replace(/,?\s+\bCorp\.?$/i, ' Corporation');
		push(expanded);

		// Strip legal suffixes
		const stripped = noParen
			.replace(
				/,?\s+\b(?:incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|l\.?l\.?p\.?|l\.?p\.?|p\.?l\.?l\.?c\.?|p\.?c\.?|p\.?l\.?c\.?|n\.?a\.?|co\.?|company)\s*$/i,
				'',
			)
			.trim();
		push(stripped);

		// Strip secondary "& Refining" / "& Gas" / "& Trust" suffix for famous shortened Wiki titles (e.g. "Humble Oil & Refining" -> "Humble Oil")
		const beforeAmp = stripped.replace(/\s+(?:&|and)\s+(?:Refining|Production|Exploration|Gas|Trust|Sons|Associates)\b.*$/i, '').trim();
		if (beforeAmp.split(/\s+/).length >= 2) push(beforeAmp);
	}

	return out.slice(0, 4);
}

async function fetchJsonSafe(url: string, timeoutMs = 10_000): Promise<unknown | null> {
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * Batch-fetch Wikidata dates for up to 50 QIDs in a single API request.
 */
export async function batchFetchWikidataDates(
	qids: string[],
): Promise<
	Map<
		string,
		{
			description: string | null;
			claims: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>>;
		}
	>
> {
	const out = new Map<
		string,
		{
			description: string | null;
			claims: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>>;
		}
	>();
	const clean = [...new Set(qids.map((q) => String(q || '').trim().toUpperCase()).filter((q) => /^Q\d+$/.test(q)))];
	if (clean.length === 0) return out;

	const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(clean.slice(0, 50).join('|'))}&props=descriptions|claims&languages=en&format=json`;
	const data = (await fetchJsonSafe(url, 15_000)) as {
		entities?: Record<
			string,
			{
				descriptions?: { en?: { value?: string } };
				claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>>;
			}
		>;
	} | null;

	for (const [qid, ent] of Object.entries(data?.entities || {})) {
		if (!ent?.claims) continue;
		out.set(qid.toUpperCase(), {
			description: ent.descriptions?.en?.value || null,
			claims: ent.claims,
		});
	}
	return out;
}

/**
 * Resolve startDate and endDate for a single entity using:
 *  1. Explicit prose extraction from summary/context
 *  2. Wikidata QID (if provided)
 *  3. Wikipedia title/search lookup + Wikidata claims (when allowWebLookup is true)
 */
export async function resolveEntityStartEndDates(input: {
	name: string;
	profileType: ProfileType;
	summary?: string | null;
	contextText?: string | null;
	existingQid?: string | null;
	existingWikiUrl?: string | null;
	allowWebLookup?: boolean;
}): Promise<ResolvedEntityDates> {
	const prose = extractDatesFromProse(
		`${input.summary || ''}\n${input.contextText || ''}`,
		input.profileType,
		input.name,
	);
	let startDate = prose.startDate;
	let endDate = prose.endDate;
	let qid = input.existingQid ? String(input.existingQid).trim().toUpperCase() : null;
	let wikiUrl = input.existingWikiUrl || null;
	let wikiTitle: string | null = null;
	let wikiExtract: string | null = null;
	let source: string | null = startDate || endDate ? 'prose' : null;

	if (!input.allowWebLookup) {
		return { startDate, endDate, qid, wikiUrl, wikiTitle, wikiExtract, source };
	}

	// 0. Local offline Kiwix Wikipedia ZIM lookup FIRST (~2ms, zero Wikimedia rate limits!)
	try {
		const kiwix = await lookupLocalKiwixEntityDates({
			name: input.name,
			profileType: input.profileType,
			existingWikiUrl: wikiUrl,
		});
		if (kiwix) {
			if (!startDate && kiwix.startDate) {
				startDate = kiwix.startDate;
				source = kiwix.source;
			}
			if (!endDate && kiwix.endDate) {
				endDate = kiwix.endDate;
				source = source || kiwix.source;
			}
			if (kiwix.wikiTitle) wikiTitle = kiwix.wikiTitle;
			if (kiwix.wikiUrl) wikiUrl = kiwix.wikiUrl;
			if (kiwix.wikiExtract) wikiExtract = kiwix.wikiExtract;
			if (startDate) {
				return { startDate, endDate, qid, wikiUrl, wikiTitle, wikiExtract, source };
			}
		}
	} catch {
		/* fall through to remote Wikipedia/Wikidata */
	}

	// 1. If we already have a Wikidata QID, fetch structured dates directly
	if (qid && /^Q\d+$/.test(qid)) {
		const map = await batchFetchWikidataDates([qid]);
		const ent = map.get(qid);
		if (ent) {
			const wdDates = extractDatesFromWikidataClaims(ent.claims, input.profileType);
			if (!startDate && wdDates.startDate) {
				startDate = wdDates.startDate;
				source = 'wikidata';
			}
			if (!endDate && wdDates.endDate) {
				endDate = wdDates.endDate;
				source = source || 'wikidata';
			}
		}
		if (startDate && (endDate || input.profileType === 'region')) {
			return { startDate, endDate, qid, wikiUrl, wikiTitle, wikiExtract, source };
		}
	}

	// 2. Try Wikipedia direct title lookup (exact + stripped variants in 1 batch request!)
	const candidates = buildWikiTitleCandidates(input.name, input.profileType);
	if (wikiUrl) {
		const m = wikiUrl.match(/wikipedia\.org\/wiki\/([^#?]+)/i);
		if (m) {
			const decoded = decodeURIComponent(m[1]!).replace(/_/g, ' ');
			if (!candidates.includes(decoded)) candidates.unshift(decoded);
		}
	}

	if (candidates.length > 0) {
		const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=wikibase_item&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(candidates.join('|'))}&format=json`;
		const data = (await fetchJsonSafe(url, 10_000)) as {
			query?: {
				pages?: Record<
					string,
					{
						missing?: unknown;
						title?: string;
						extract?: string;
						pageprops?: { wikibase_item?: string };
					}
				>;
			};
		} | null;

		const pages = Object.values(data?.query?.pages || {}).filter((p) => p && p.missing == null && p.extract);
		const qidsToFetch = pages
			.map((p) => p.pageprops?.wikibase_item)
			.filter((x): x is string => Boolean(x && /^Q\d+$/i.test(x)));
		const wdMap = qidsToFetch.length ? await batchFetchWikidataDates(qidsToFetch) : new Map();

		for (const p of pages) {
			const ext = String(p.extract || '').trim();
			const pQid = p.pageprops?.wikibase_item?.toUpperCase() || null;
			const wdEnt = pQid ? wdMap.get(pQid) : undefined;
			if (!wikiMatchesProfileType(input.profileType, ext, wdEnt?.description)) continue;

			wikiTitle = String(p.title || '');
			wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, '_'))}`;
			wikiExtract = ext;
			if (pQid) qid = pQid;

			if (wdEnt) {
				const wdDates = extractDatesFromWikidataClaims(wdEnt.claims, input.profileType);
				if (!startDate && wdDates.startDate) {
					startDate = wdDates.startDate;
					source = 'wikidata';
				}
				if (!endDate && wdDates.endDate) {
					endDate = wdDates.endDate;
					source = source || 'wikidata';
				}
			}
			// Fallback to prose dates in the verified Wikipedia intro extract
			if (!startDate || !endDate) {
				const extDates = extractDatesFromProse(ext, input.profileType, wikiTitle);
				if (!startDate && extDates.startDate) {
					startDate = extDates.startDate;
					source = source || 'wikipedia_intro';
				}
				if (!endDate && extDates.endDate) {
					endDate = extDates.endDate;
					source = source || 'wikipedia_intro';
				}
			}
			break;
		}
	}

	// 3. If direct title lookup missed, try 1 Wikipedia search query for near-exact title match
	if (!startDate && !wikiTitle) {
		const sUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(input.name)}&srlimit=3&format=json`;
		const sData = (await fetchJsonSafe(sUrl, 8_000)) as {
			query?: { search?: Array<{ title?: string }> };
		} | null;
		const normName = normalizeText(input.name);
		const strippedName = stripLegalSuffixes(input.name);
		const matchTitles: string[] = [];
		for (const h of sData?.query?.search || []) {
			const t = String(h.title || '').trim();
			if (!t || /^List of /i.test(t)) continue;
			const tn = normalizeText(t.replace(/\s*\([^)]*\)\s*$/, ''));
			const ts = stripLegalSuffixes(t.replace(/\s*\([^)]*\)\s*$/, ''));
			if (
				tn === normName ||
				ts === strippedName ||
				tn.replace(/^the /, '') === normName.replace(/^the /, '') ||
				(strippedName.length >= 6 && (tn.includes(strippedName) || strippedName.includes(tn)))
			) {
				matchTitles.push(t);
			}
		}
		if (matchTitles.length > 0) {
			const pUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=wikibase_item&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(matchTitles.slice(0, 2).join('|'))}&format=json`;
			const pData = (await fetchJsonSafe(pUrl, 10_000)) as {
				query?: {
					pages?: Record<
						string,
						{ missing?: unknown; title?: string; extract?: string; pageprops?: { wikibase_item?: string } }
					>;
				};
			} | null;
			const pages = Object.values(pData?.query?.pages || {}).filter((p) => p && p.missing == null && p.extract);
			const qids = pages
				.map((p) => p.pageprops?.wikibase_item)
				.filter((x): x is string => Boolean(x && /^Q\d+$/i.test(x)));
			const wdMap = qids.length ? await batchFetchWikidataDates(qids) : new Map();
			for (const p of pages) {
				const ext = String(p.extract || '').trim();
				const pQid = p.pageprops?.wikibase_item?.toUpperCase() || null;
				const wdEnt = pQid ? wdMap.get(pQid) : undefined;
				if (!wikiMatchesProfileType(input.profileType, ext, wdEnt?.description)) continue;
				wikiTitle = String(p.title || '');
				wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, '_'))}`;
				wikiExtract = ext;
				if (pQid) qid = pQid;
				if (wdEnt) {
					const wdDates = extractDatesFromWikidataClaims(wdEnt.claims, input.profileType);
					if (!startDate && wdDates.startDate) {
						startDate = wdDates.startDate;
						source = 'wikidata';
					}
					if (!endDate && wdDates.endDate) {
						endDate = wdDates.endDate;
						source = source || 'wikidata';
					}
				}
				if (!startDate || !endDate) {
					const extDates = extractDatesFromProse(ext, input.profileType, wikiTitle);
					if (!startDate && extDates.startDate) {
						startDate = extDates.startDate;
						source = source || 'wikipedia_intro';
					}
					if (!endDate && extDates.endDate) {
						endDate = extDates.endDate;
						source = source || 'wikipedia_intro';
					}
				}
				break;
			}
		}
	}

	return { startDate, endDate, qid, wikiUrl, wikiTitle, wikiExtract, source };
}
