import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	lookupBrokercheckIndividual,
	type BrokercheckEmployment,
	type BrokercheckExam,
} from '@/lib/research/brokercheckLookup';
import { finraApiUrl } from '@/lib/research/finraApp';
import { hydrateFirmConnectionDates } from '@/lib/research/finraEmploymentDates';
import {
	ingestFirmDetailsFromVisualizer,
	ingestIndividualFromVisualizer,
} from '@/lib/research/finraVisualizerMirror';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import {
	buildProfileIdentityContext,
	buildSearchPhrasesForProfile,
	evaluateIdentityMatch,
	extractIdentifyingKeywords,
	extractMilitarySignals,
	type CandidateIdentityInput,
	type ProfileIdentityContext,
} from '@/lib/research/profiles/identity';
import {
	classifyOrgType,
	normalizeIsoDate,
	normalizeText,
	parseAddressParts,
	sha256Key,
} from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import {
	addAlias,
	addIdentifier,
	addLocation,
	addPersonEmployment,
	getProfileDetail,
	updateProfileFields,
	upsertAlignmentCandidate,
	upsertProfile,
	upsertProfileLink,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import type {
	EnrichProfileReport,
	EnrichSourceOutcome,
	ProfileType,
} from '@/lib/research/profiles/types';

export type EnrichProfileOptions = {
	includeWikipedia?: boolean;
	includeBrokercheck?: boolean;
	includeKnowledge?: boolean;
	includeBryanUcc?: boolean;
	kiwixBaseUrl?: string;
};

export type EnrichBatchOptions = EnrichProfileOptions & {
	limit?: number;
	profileType?: ProfileType | 'all';
	pinnedOnly?: boolean;
	onlyMissingSummaryOrDetails?: boolean;
};

export type EnrichBatchReport = {
	processed: number;
	validatedEnrichments: number;
	nameOnlyNotesRecorded: number;
	totalFieldsUpdated: number;
	totalEmploymentsAdded: number;
	totalLocationsAdded: number;
	totalTimelineAdded: number;
	results: Array<{
		slug: string;
		name: string;
		profileType: ProfileType;
		validatedSources: number;
		heldNameOnlyNotes: number;
		fieldsUpdated: string[];
	}>;
	durationMs: number;
};

const DEFAULT_KIWIX_BASE = process.env.KIWIX_URL || 'http://127.0.0.1:8765';

function emptyCounts() {
	return {
		aliases: 0,
		identifiers: 0,
		locations: 0,
		employments: 0,
		links: 0,
		timelineEntries: 0,
		notes: 0,
	};
}

function decodeHtmlEntities(input: string): string {
	return String(input || '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;|&#x27;/gi, "'")
		.replace(/&ndash;|&#8211;/gi, '–')
		.replace(/&mdash;|&#8212;/gi, '—')
		.replace(/&#(\d+);/g, (_, num) => {
			const code = Number(num);
			return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const code = parseInt(hex, 16);
			return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
		});
}

function stripHtmlTags(html: string): string {
	return decodeHtmlEntities(
		String(html || '')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '')
			.replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(?:li|p|div|tr)>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	)
		.replace(/\[\d+\]|\[citation needed\]|\[a\]|\[b\]|\[c\]/gi, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();
}

function splitCleanItems(rawHtml: string): string[] {
	const cleaned = stripHtmlTags(rawHtml);
	const rawLines = cleaned
		.split(/\n|;|•|·/)
		.map((s) => s.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim())
		.filter((s) => s.length >= 2 && s.length <= 160);
	return [...new Set(rawLines)];
}

function extractWikiLinksFromFragment(html: string): string[] {
	const out: string[] = [];
	const re = /<a\b[^>]*rel="mw:WikiLink"[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	for (const m of String(html || '').matchAll(re)) {
		const text = stripHtmlTags(m[2]).replace(/\s+/g, ' ').trim();
		const title = decodeHtmlEntities(m[1]).trim();
		const pick = text.length >= 2 ? text : title;
		if (pick && !/^(BA|BS|MA|MS|MBA|JD|MD|PhD|LLB|DPhil|US|U\.S\.|USA|UK|CEO|CFO|CTO|COO)$/i.test(pick)) {
			out.push(pick);
		}
	}
	return [...new Set(out)];
}

type ParsedWikiArticle = {
	title: string;
	pageName: string;
	articleId: number | null;
	canonicalUrl: string;
	kiwixUrl: string;
	categories: string[];
	infobox: Record<string, { text: string; items: string[]; links: string[]; rawHtml: string }>;
	infoboxHeaders: string[];
	birthName: string | null;
	birthDate: string | null;
	deathDate: string | null;
	birthPlace: string | null;
	leadSummary: string;
	bodyText: string;
	datedMilestones: Array<{ date: string; title: string; summary: string }>;
	isDisambiguation: boolean;
};

type KiwixSearchHit = {
	title: string;
	link: string;
};

function fetchLocalHttpText(urlStr: string, timeoutMs = 10_000, maxBytes = 600_000): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (val: string | null) => {
			if (settled) return;
			settled = true;
			resolve(val);
		};
		try {
			const parsed = new URL(urlStr);
			const mod = parsed.protocol === 'https:' ? https : http;
			const req = mod.get(
				{
					hostname: parsed.hostname,
					port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
					path: parsed.pathname + parsed.search,
					agent: false,
					headers: { Connection: 'close', Accept: 'text/html,application/xml,*/*' },
				},
				(res) => {
					if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
						res.resume();
						const nextUrl = new URL(res.headers.location, urlStr).toString();
						void fetchLocalHttpText(nextUrl, timeoutMs, maxBytes).then(finish);
						return;
					}
					if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
						res.resume();
						finish(null);
						return;
					}
					const chunks: Buffer[] = [];
					let total = 0;
					res.on('data', (chunk: Buffer) => {
						total += chunk.length;
						chunks.push(chunk);
						if (total >= maxBytes) {
							res.destroy();
							finish(Buffer.concat(chunks).toString('utf8'));
						}
					});
					res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
					res.on('error', () => {
						if (chunks.length) finish(Buffer.concat(chunks).toString('utf8'));
						else finish(null);
					});
				},
			);
			req.setTimeout(timeoutMs, () => {
				req.destroy();
				finish(null);
			});
			req.on('error', () => finish(null));
		} catch {
			finish(null);
		}
	});
}

async function searchKiwixWikipedia(
	query: string,
	kiwixBaseUrl: string,
	pageLength = 8,
): Promise<KiwixSearchHit[]> {
	const q = String(query || '').trim();
	if (!q) return [];
	const url = `${kiwixBaseUrl.replace(/\/+$/, '')}/search?pattern=${encodeURIComponent(q)}&format=xml&pageLength=${pageLength}`;
	const xml = await fetchLocalHttpText(url, 8_000, 120_000);
	if (!xml) return [];
	const hits: KiwixSearchHit[] = [];
	const itemRe = /<item>([\s\S]*?)<\/item>/gi;
	for (const m of xml.matchAll(itemRe)) {
		const block = m[1];
		const titleM = block.match(/<title>([\s\S]*?)<\/title>/i);
		const linkM = block.match(/<link>([\s\S]*?)<\/link>/i);
		if (!titleM || !linkM) continue;
		const title = decodeHtmlEntities(titleM[1]).trim();
		const link = decodeHtmlEntities(linkM[1]).trim();
		if (!title || !link) continue;
		// Skip category partials, disambiguation pages, surname pages, and list pages
		if (
			title.startsWith('_categories_') ||
			link.includes('_categories_') ||
			/\((?:disambiguation|surname|given name)\)/i.test(title) ||
			/^(?:Category|List of|Index of|Template|Portal):/i.test(title) ||
			/^List of /i.test(title)
		) {
			continue;
		}
		hits.push({ title, link });
	}
	return hits;
}

async function fetchAndParseKiwixArticle(
	kiwixLink: string,
	kiwixBaseUrl: string,
): Promise<ParsedWikiArticle | null> {
	const base = kiwixBaseUrl.replace(/\/+$/, '');
	const fullUrl = kiwixLink.startsWith('http')
		? kiwixLink
		: `${base}${kiwixLink.startsWith('/') ? '' : '/'}${kiwixLink}`;

	const html = await fetchLocalHttpText(fullUrl, 12_000, 260_000);
	if (!html || html.length < 300) return null;

	// Extract RLCONF metadata from header script
	let title = '';
	let pageName = '';
	let articleId: number | null = null;
	let categories: string[] = [];
	const rlMatch = html.match(/RLCONF\s*=\s*(\{[\s\S]*?\});?\s*\n/);
	if (rlMatch) {
		try {
			const conf = JSON.parse(rlMatch[1]) as Record<string, unknown>;
			title = String(conf.wgTitle || '').trim();
			pageName = String(conf.wgPageName || '').trim();
			articleId = typeof conf.wgArticleId === 'number' ? conf.wgArticleId : null;
			if (Array.isArray(conf.wgCategories)) {
				categories = conf.wgCategories.map(String).filter((c) => !/^(?:Articles|All articles|CS1|Use |Short description|Wikipedia|Commons|Webarchive|Pages)/i.test(c));
			}
		} catch {
			/* ignore JSON parse issues */
		}
	}
	if (!title) {
		const tMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
		title = tMatch ? decodeHtmlEntities(tMatch[1]).replace(/\s*-\s*Wikipedia$/i, '').trim() : '';
	}
	if (!pageName) {
		pageName = title.replace(/\s+/g, '_');
	}
	const isDisambiguation =
		categories.some((c) => /disambiguation|human name disambiguation/i.test(c)) ||
		/\bmay refer to:\s*$/i.test(stripHtmlTags(html.slice(0, 8000)));

	// Parse first infobox table
	const infobox: ParsedWikiArticle['infobox'] = {};
	const infoboxHeaders: string[] = [];
	let birthName: string | null = null;
	let birthDate: string | null = null;
	let deathDate: string | null = null;
	let birthPlace: string | null = null;

	const ibMatch = html.match(/<table\b[^>]*class="[^"]*\binfobox\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
	if (ibMatch) {
		const ibHtml = ibMatch[1];
		const nickM = ibHtml.match(/class="[^"]*\bnickname\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
		if (nickM) birthName = stripHtmlTags(nickM[1]).replace(/[\[\]]+/g, '').replace(/\s+/g, ' ').trim() || null;

		const bdayM = ibHtml.match(/class="[^"]*\bbday\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
		if (bdayM) birthDate = normalizeIsoDate(stripHtmlTags(bdayM[1])).date;

		const ddayM = ibHtml.match(/class="[^"]*\bdday\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
		if (ddayM) deathDate = normalizeIsoDate(stripHtmlTags(ddayM[1])).date;

		const bpM = ibHtml.match(/class="[^"]*\bbirthplace\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
		if (bpM) birthPlace = stripHtmlTags(bpM[1]).replace(/\s+/g, ' ').trim() || null;

		const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
		for (const rm of ibHtml.matchAll(rowRe)) {
			const row = rm[1];
			const hdrM = row.match(/<th\b[^>]*class="[^"]*infobox-header[^"]*"[^>]*>([\s\S]*?)<\/th>/i);
			if (hdrM) {
				const hdrText = stripHtmlTags(hdrM[1]).replace(/\s+/g, ' ').trim();
				if (
					hdrText.length >= 6 &&
					hdrText.length <= 120 &&
					!/^(?:Personal details|Signature|Military service|Military career|Background information|Awards|Honours|Honors|Career|Website)$/i.test(
						hdrText,
					)
				) {
					infoboxHeaders.push(hdrText);
				}
			}
			const thM = row.match(/<th\b[^>]*class="[^"]*infobox-label[^"]*"[^>]*>([\s\S]*?)<\/th>/i);
			const tdM = row.match(/<td\b[^>]*class="[^"]*infobox-data[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
			if (!thM || !tdM) continue;
			const label = normalizeText(stripHtmlTags(thM[1]));
			if (!label) continue;
			const rawValHtml = tdM[1];
			const text = stripHtmlTags(rawValHtml).replace(/\s+/g, ' ').trim();
			const items = splitCleanItems(rawValHtml);
			const links = extractWikiLinksFromFragment(rawValHtml);
			if (text) {
				infobox[label] = { text, items, links, rawHtml: rawValHtml };
			}
		}
	}

	// Fallback birth/death date parsing from infobox text
	if (!birthDate && infobox.born?.text) {
		birthDate = normalizeIsoDate(infobox.born.text).date;
	}
	if (!deathDate && infobox.died?.text) {
		deathDate = normalizeIsoDate(infobox.died.text).date;
	}

	// Extract lead + body paragraphs (limit slice for speed on massive articles)
	const bodySlice = html.slice(0, 220_000);
	const paragraphs: string[] = [];
	const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
	for (const pm of bodySlice.matchAll(pRe)) {
		const txt = stripHtmlTags(pm[1]).replace(/\s+/g, ' ').trim();
		if (txt.length >= 40) {
			paragraphs.push(txt);
			if (paragraphs.length >= 45) break;
		}
	}

	const leadSummary = paragraphs.slice(0, 3).join(' ').slice(0, 950).trim();
	const bodyText = paragraphs.join('\n').slice(0, 32_000);

	// Extract up to 6 dated career/historical milestones from body paragraphs
	const datedMilestones: Array<{ date: string; title: string; summary: string }> = [];
	const seenYears = new Set<string>();
	const milestoneVerbRe =
		/\b(founded|co-founded|established|incorporated|joined|appointed|named|became|elected|graduated|earned|received|acquired|merged|spun off|relocated|moved|headquartered|opened|built|served|enlisted|commissioned|deployed|retired|resigned|stepped down|indicted|convicted|died|passed away|launched|introduced|developed|signed|awarded)\b/i;

	for (const para of paragraphs.slice(0, 20)) {
		const sentences = para.split(/(?<=[.!?])\s+/);
		for (const sent of sentences) {
			if (sent.length < 35 || sent.length > 360) continue;
			if (!milestoneVerbRe.test(sent)) continue;
			const ym = sent.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
			if (!ym) continue;
			const year = ym[1];
			if (seenYears.has(year)) continue;
			seenYears.add(year);
			datedMilestones.push({
				date: year,
				title: `${title} (${year}): ${sent.slice(0, 110)}${sent.length > 110 ? '…' : ''}`,
				summary: sent,
			});
			if (datedMilestones.length >= 6) break;
		}
		if (datedMilestones.length >= 6) break;
	}

	return {
		title,
		pageName,
		articleId,
		canonicalUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageName)}`,
		kiwixUrl: fullUrl,
		categories,
		infobox,
		infoboxHeaders: [...new Set(infoboxHeaders)].slice(0, 8),
		birthName,
		birthDate,
		deathDate,
		birthPlace,
		leadSummary,
		bodyText,
		datedMilestones,
		isDisambiguation,
	};
}

function buildWikiCandidateInput(article: ParsedWikiArticle): CandidateIdentityInput {
	const aliases: string[] = [];
	if (article.birthName) aliases.push(article.birthName);
	for (const key of ['other names', 'formerly', 'former name', 'trading name', 'native name', 'also known as']) {
		if (article.infobox[key]?.items) aliases.push(...article.infobox[key].items);
	}

	const locations: string[] = [];
	if (article.birthPlace) locations.push(article.birthPlace);
	for (const key of ['headquarters', 'location', 'residence', 'resting place', 'campus', 'area served', 'founded', 'died']) {
		if (article.infobox[key]?.text) locations.push(article.infobox[key].text);
	}

	const firms: string[] = [];
	for (const key of [
		'employer',
		'employers',
		'title',
		'organization',
		'organizations',
		'board member of',
		'parent',
		'owner',
		'subsidiaries',
		'divisions',
		'founder',
		'founders',
		'key people',
		'known for',
	]) {
		if (article.infobox[key]?.items) firms.push(...article.infobox[key].items);
		if (article.infobox[key]?.links) firms.push(...article.infobox[key].links);
	}

	const institutions: string[] = [];
	for (const key of ['education', 'alma mater', 'academic advisors', 'affiliations', 'affiliation']) {
		if (article.infobox[key]?.items) institutions.push(...article.infobox[key].items);
		if (article.infobox[key]?.links) institutions.push(...article.infobox[key].links);
	}

	const militarySignals: string[] = [];
	for (const key of ['branch', 'service branch', 'allegiance', 'unit', 'commands', 'battles wars', 'military career']) {
		if (article.infobox[key]?.text) militarySignals.push(article.infobox[key].text);
	}

	const identifiers: Array<{ scheme: string; value: string }> = [];
	const traded = article.infobox['traded as']?.text || '';
	const tickerM = traded.match(/\b(?:NYSE|NASDAQ|AMEX|LSE|TSX|BME)\s*:\s*([A-Z]{1,6})\b/i);
	if (tickerM) {
		identifiers.push({ scheme: 'ticker', value: tickerM[1].toUpperCase() });
	}

	const foundedDate = article.infobox.founded?.text
		? normalizeIsoDate(article.infobox.founded.text).date
		: null;
	const defunctDate = article.infobox.defunct?.text
		? normalizeIsoDate(article.infobox.defunct.text).date
		: article.infobox.dissolved?.text
			? normalizeIsoDate(article.infobox.dissolved.text).date
			: null;

	const combinedText = [
		article.leadSummary,
		article.categories.join(' ; '),
		Object.entries(article.infobox)
			.map(([k, v]) => `${k}: ${v.text}`)
			.join('\n'),
		article.bodyText.slice(0, 28_000),
	].join('\n');

	return {
		candidateName: article.title,
		candidateAliases: [...new Set(aliases)],
		candidateIdentifiers: identifiers,
		candidateLocations: [...new Set(locations)],
		candidateFirms: [...new Set(firms)],
		candidateInstitutions: [...new Set(institutions)],
		candidateMilitarySignals: [
			...new Set([...militarySignals, ...extractMilitarySignals(combinedText)]),
		],
		candidateStartDate: article.birthDate || foundedDate,
		candidateEndDate: article.deathDate || defunctDate,
		candidateText: combinedText,
	};
}

const MONTH_NAME_TO_MM: Record<string, string> = {
	january: '01', jan: '01',
	february: '02', feb: '02',
	march: '03', mar: '03',
	april: '04', apr: '04',
	may: '05',
	june: '06', jun: '06',
	july: '07', jul: '07',
	august: '08', aug: '08',
	september: '09', sep: '09', sept: '09',
	october: '10', oct: '10',
	november: '11', nov: '11',
	december: '12', dec: '12',
};

const DATE_TOKEN_SOURCE =
	'(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+)?(?:1[89]\\d{2}|20[0-2]\\d)';

function parseMonthYearToken(raw: string): string | null {
	const s = String(raw || '').trim();
	const m = s.match(
		/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(1[89]\d{2}|20[0-2]\d)\b/i,
	);
	if (m) {
		const mm = MONTH_NAME_TO_MM[m[1].toLowerCase()];
		if (mm) return `${m[2]}-${mm}`;
	}
	const y = s.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
	return y ? y[1] : null;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract Month/Year (YYYY-MM) or Year (YYYY) of attending a school or working at an organization
 * from Wikipedia infobox text + article body prose.
 */
function extractOrgDatesFromWiki(
	orgName: string,
	kind: 'education' | 'employment',
	infoboxText: string,
	bodyText: string,
	leadSummary: string,
): { startDate: string | null; endDate: string | null; isCurrent?: boolean } {
	const cleanOrg = String(orgName || '').trim();
	if (!cleanOrg) return { startDate: null, endDate: null };

	// Build candidate matching stems (full name + stripped core stem like "Stanford", "Goethe University", "Palantir")
	const stems = new Set<string>([cleanOrg]);
	const stripped = cleanOrg
		.replace(/\b(?:University|College|Institute|School|Technologies|Inc\.?|Corp\.?|Corporation|LLC|Ltd\.?|Company|Group)\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (stripped.length >= 5) stems.add(stripped);

	const stemAlternation = [...stems]
		.sort((a, b) => b.length - a.length)
		.map(escapeRe)
		.join('|');
	const orgRe = new RegExp(`\\b(?:${stemAlternation})\\b`, 'i');

	let startDate: string | null = null;
	let endDate: string | null = null;
	let isCurrent: boolean | undefined;

	// 1. Check infobox text first for explicit ranges next to org name: e.g. "Palantir (2003–present)" or "Stanford (1989–1992)"
	const ibRangeRe = new RegExp(
		`\\b(?:${stemAlternation})[^;\\n]{0,45}?\\(?\\s*(${DATE_TOKEN_SOURCE})\\s*(?:–|-|to)\\s*(${DATE_TOKEN_SOURCE}|present|current)`,
		'i',
	);
	const ibRangeM = infoboxText.match(ibRangeRe);
	if (ibRangeM) {
		startDate = parseMonthYearToken(ibRangeM[1]);
		if (/present|current/i.test(ibRangeM[2])) {
			isCurrent = true;
		} else {
			endDate = parseMonthYearToken(ibRangeM[2]);
			isCurrent = false;
		}
		if (startDate || endDate) return { startDate, endDate, isCurrent };
	}

	// Single year inside parentheses next to org in infobox: e.g. "Haverford College (BA, 1989)"
	const ibSingleRe = new RegExp(`\\b(?:${stemAlternation})[^;\\n]{0,40}?\\([^)]{0,30}?(${DATE_TOKEN_SOURCE})[^)]*\\)`, 'i');
	const ibSingleM = infoboxText.match(ibSingleRe);
	if (ibSingleM) {
		const dt = parseMonthYearToken(ibSingleM[1]);
		if (dt) {
			if (kind === 'education') return { startDate: null, endDate: dt, isCurrent: false };
			return { startDate: dt, endDate: null };
		}
	}

	// 2. Scan matching clauses in article body text (avoid splitting sentences on degree/title abbreviations like Ph.D., J.D., B.A., U.S.)
	const safeBody = bodyText.replace(
		/\b(Ph\.D|J\.D|M\.D|B\.A|B\.S|M\.A|M\.S|M\.B\.A|LL\.B|LL\.M|D\.Phil|U\.S|U\.K|Dr|Mr|Mrs|Ms|Prof|St)\./gi,
		'$1\u0000',
	);
	const sentences = safeBody.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\u0000/g, '.'));
	const rangeRe = new RegExp(
		`(?:from\\s+)?(${DATE_TOKEN_SOURCE})\\s*(?:–|-|to|until)\\s*(${DATE_TOKEN_SOURCE}|present|current)`,
		'i',
	);

	for (const sent of sentences) {
		if (!orgRe.test(sent)) continue;

		// Focus on the clause immediately surrounding this org (avoid pulling another school's date in the same sentence)
		const matchIdx = sent.search(orgRe);
		const afterOrg = sent.slice(matchIdx, matchIdx + 170);
		const beforeOrg = sent.slice(Math.max(0, matchIdx - 90), matchIdx + 40);
		// Trim afterOrg at the start of a new clause introducing a different school/job (e.g. ", then enrolled at ...")
		const clauseAfter = afterOrg.split(/\b(?:then\s+(?:enrolled|attended|moved|joined|went)|before\s+(?:joining|attending|moving))\b/i)[0] || afterOrg;

		const rMatch = clauseAfter.match(rangeRe) || beforeOrg.match(rangeRe);
		if (rMatch) {
			startDate = startDate || parseMonthYearToken(rMatch[1]);
			if (/present|current/i.test(rMatch[2])) {
				isCurrent = true;
			} else {
				endDate = endDate || parseMonthYearToken(rMatch[2]);
				isCurrent = false;
			}
			continue;
		}

		if (kind === 'education') {
			const isEduSent =
				/\b(?:graduat|earned|receiv|complet|degree|bachelor|master|doctorate|ph\.?d|j\.?d|m\.?d|m\.?b\.?a|b\.?a\.?|b\.?s\.?|enrolled|attended|studied)\b/i.test(
					sent,
				);
			if (!isEduSent) continue;

			const afterIn = clauseAfter.match(new RegExp(`\\bin\\s+(${DATE_TOKEN_SOURCE})\\b`, 'i'));
			const afterBare = clauseAfter.match(new RegExp(`\\b(${DATE_TOKEN_SOURCE})\\b`, 'i'));
			const beforeIn = beforeOrg.match(new RegExp(`\\bin\\s+(${DATE_TOKEN_SOURCE})\\b`, 'i'));

			const picked = afterIn?.[1] || afterBare?.[1] || beforeIn?.[1];
			if (picked) {
				const dt = parseMonthYearToken(picked);
				if (dt) {
					if (/\b(?:enrolled|entered|began|started)\b/i.test(clauseAfter) && !/\b(?:graduat|earned|receiv)\b/i.test(clauseAfter)) {
						startDate = startDate || dt;
					} else {
						endDate = endDate || dt;
						isCurrent = false;
					}
				}
			}
		} else {
			// Employment / founding / executive role
			const startCtx =
				/\b(?:founded|co-founded|established|joined|hired|appointed|named|became|started|since|ceo|president|chairman|director|partner)\b/i.test(
					sent,
				);
			const endCtx = /\b(?:left|resigned|stepped down|retired|departed|fired|ousted|ended)\b/i.test(sent);

			const inDate =
				clauseAfter.match(new RegExp(`\\b(?:in|since)\\s+(${DATE_TOKEN_SOURCE})\\b`, 'i')) ||
				beforeOrg.match(new RegExp(`\\b(?:in|since)\\s+(${DATE_TOKEN_SOURCE})\\b`, 'i'));
			if (inDate) {
				const dt = parseMonthYearToken(inDate[1]);
				if (dt) {
					if (endCtx && !startCtx) {
						endDate = endDate || dt;
						isCurrent = false;
					} else if (startCtx) {
						startDate = startDate || dt;
						if (/\bsince\b/i.test(inDate[0])) isCurrent = true;
					}
				}
			}
		}
	}

	// Check lead summary for present-tense current role (e.g. "He is the co-founder and CEO of ... Palantir")
	if (kind === 'employment' && isCurrent === undefined && !endDate) {
		const currentLeadRe = new RegExp(
			`\\bis\\s+(?:the\\s+|a\\s+)?(?:co-?founder|founder|ceo|chief executive|chairman|chair|president|executive|director|managing|partner)[^.]{0,90}?\\b(?:${stemAlternation})\\b`,
			'i',
		);
		if (currentLeadRe.test(leadSummary)) {
			isCurrent = true;
		}
	}

	return { startDate, endDate, isCurrent };
}

function cleanRoleEntityPair(rawItem: string): { role: string | null; org: string | null } {
	const cleaned = rawItem.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
	// Pattern: "Co-founder and CEO, Palantir Technologies" or "CEO of Palantir"
	const commaM = cleaned.match(/^(.{2,60}?),\s+([A-Z][A-Za-z0-9&.'\-\s]{2,70})$/);
	if (commaM) return { role: commaM[1].trim(), org: commaM[2].trim() };
	const ofM = cleaned.match(/^(.{2,55}?)\s+(?:of|at)\s+([A-Z][A-Za-z0-9&.'\-\s]{2,70})$/);
	if (ofM) return { role: ofM[1].trim(), org: ofM[2].trim() };
	return { role: null, org: cleaned.length >= 3 ? cleaned : null };
}

function extractLocationFromInfoboxText(raw: string): string | null {
	const clean = String(raw || '')
		.replace(/\(\d{4}[^)]*\)/g, '')
		.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi, '')
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[,;\s-]+|[,;\s-]+$/g, '')
		.trim();
	if (clean.length < 3 || clean.length > 110) return null;
	return clean;
}

function applyValidatedWikipediaEnrichment(
	profileId: string,
	profileType: ProfileType,
	profileName: string,
	article: ParsedWikiArticle,
): { fieldsUpdated: string[]; countsAdded: ReturnType<typeof emptyCounts> } {
	const counts = emptyCounts();
	const fieldsUpdated: string[] = [];
	const detail = getProfileDetail(profileId);
	if (!detail) return { fieldsUpdated, countsAdded: counts };

	const existingMeta = detail.profile.metadata || {};
	const prevCorpora = Array.isArray(existingMeta.corpora) ? existingMeta.corpora.map(String) : [];
	const nextCorpora = prevCorpora.includes('wikipedia-local')
		? prevCorpora
		: [...prevCorpora, 'wikipedia-local'];

	const foundedDate = article.infobox.founded?.text
		? normalizeIsoDate(article.infobox.founded.text).date
		: null;
	const defunctDate = article.infobox.defunct?.text
		? normalizeIsoDate(article.infobox.defunct.text).date
		: article.infobox.dissolved?.text
			? normalizeIsoDate(article.infobox.dissolved.text).date
			: null;

	const nextStartDate = detail.profile.startDate || article.birthDate || foundedDate || null;
	const nextEndDate = detail.profile.endDate || article.deathDate || defunctDate || null;
	const nextSummary =
		article.leadSummary.length > detail.profile.summary.trim().length + 25
			? article.leadSummary
			: detail.profile.summary;

	if (nextSummary !== detail.profile.summary) fieldsUpdated.push('summary');
	if (nextStartDate && !detail.profile.startDate) fieldsUpdated.push('startDate');
	if (nextEndDate && !detail.profile.endDate) fieldsUpdated.push('endDate');

	const extractedKw = extractIdentifyingKeywords(
		`${article.leadSummary}\n${Object.values(article.infobox).map((v) => v.text).join('\n')}`,
		profileName,
	);
	const identifyingKeywords = [
		...extractedKw.properPhrases.slice(0, 8),
		...extractedKw.domainAnchors.slice(0, 8),
		...extractedKw.distinctiveTerms.slice(0, 8),
	].slice(0, 18);

	const metaPatch: Record<string, unknown> = {
		corpora: nextCorpora,
		wikipediaTitle: article.title,
		wikipediaUrl: article.canonicalUrl,
		wikipediaArticleId: article.articleId,
		wikipediaCategories: article.categories.slice(0, 14),
		identifyingKeywords,
		lastEnrichedAt: new Date().toISOString(),
	};

	const setDetailField = (
		metaKey: string,
		val: string | string[] | null | undefined,
		fieldLabel?: string,
		maxLen = 280,
	) => {
		if (!val) return;
		if (Array.isArray(val)) {
			const clean = val.map((x) => x.trim()).filter(Boolean).slice(0, 10);
			if (!clean.length) return;
			metaPatch[metaKey] = clean;
			fieldsUpdated.push(fieldLabel || metaKey);
			return;
		}
		const clean = val.replace(/\s+/g, ' ').trim().slice(0, maxLen);
		if (!clean) return;
		metaPatch[metaKey] = clean;
		fieldsUpdated.push(fieldLabel || metaKey);
	};

	// Rich Person, Artist/Musician, Firm/Org, Military, and Historic Event infobox details
	setDetailField('occupation', article.infobox.occupation?.text || article.infobox.occupations?.text);
	setDetailField('title', article.infobox.title?.text);
	setDetailField('yearsActive', article.infobox['years active']?.text, 'yearsActive', 120);
	setDetailField('genres', article.infobox.genres?.text || article.infobox.genre?.text, 'genres', 220);
	setDetailField('instruments', article.infobox.instruments?.text, 'instruments', 220);
	setDetailField('labels', article.infobox.labels?.text || article.infobox.label?.text, 'labels', 220);
	setDetailField('formerlyOf', article.infobox['formerly of']?.text, 'formerlyOf', 180);
	setDetailField('knownFor', article.infobox['known for']?.text);
	setDetailField('notableWorks', article.infobox['notable work']?.text || article.infobox['notable works']?.text);
	setDetailField('citizenship', article.infobox.citizenship?.text || article.infobox.nationality?.text);
	setDetailField('politicalParty', article.infobox['political party']?.text || article.infobox.party?.text);
	if (article.infoboxHeaders.length > 0 && profileType === 'person') {
		setDetailField('officesHeld', article.infoboxHeaders);
	}
	setDetailField('awards', article.infobox.awards?.text || article.infobox.honors?.text || article.infobox.honours?.text);
	setDetailField('educationSummary', article.infobox.education?.text || article.infobox['alma mater']?.text);
	setDetailField('netWorth', article.infobox['net worth']?.text, 'netWorth', 120);
	const familyParts = [
		article.infobox.spouse?.text || article.infobox.spouses?.text ? `Spouse: ${article.infobox.spouse?.text || article.infobox.spouses?.text}` : '',
		article.infobox.partner?.text || article.infobox.partners?.text ? `Partner: ${article.infobox.partner?.text || article.infobox.partners?.text}` : '',
		article.infobox.children?.text ? `Children: ${article.infobox.children.text}` : '',
		article.infobox.parents?.text ? `Parents: ${article.infobox.parents.text}` : '',
		article.infobox.relatives?.text ? `Relatives: ${article.infobox.relatives.text}` : '',
	].filter(Boolean);
	if (familyParts.length) {
		setDetailField('familyAndRelatives', familyParts.join(' · '), 'familyAndRelatives', 320);
	}

	// Military details
	setDetailField('militaryBranch', article.infobox.branch?.text || article.infobox['service branch']?.text, 'militaryBranch', 160);
	setDetailField('militaryRank', article.infobox.rank?.text, 'militaryRank', 120);
	setDetailField('yearsOfService', article.infobox['years of service']?.text, 'yearsOfService', 120);
	setDetailField('militaryUnit', article.infobox.unit?.text, 'militaryUnit', 200);
	setDetailField('militaryCommands', article.infobox.commands?.text, 'militaryCommands', 240);
	setDetailField('battlesWars', article.infobox['battles wars']?.text, 'battlesWars', 260);

	// Firm / Org / Gov / Education details
	setDetailField('companyType', article.infobox['company type']?.text || article.infobox.type?.text, 'companyType', 140);
	setDetailField('industry', article.infobox.industry?.text);
	setDetailField('products', article.infobox.products?.text);
	setDetailField('services', article.infobox.services?.text);
	setDetailField('revenue', article.infobox.revenue?.text, 'revenue', 140);
	setDetailField('netIncome', article.infobox['net income']?.text, 'netIncome', 140);
	setDetailField('assets', article.infobox['total assets']?.text || article.infobox.assets?.text, 'assets', 140);
	setDetailField('employees', article.infobox['number of employees']?.text || article.infobox.employees?.text, 'employees', 120);
	setDetailField('areaServed', article.infobox['area served']?.text, 'areaServed', 180);
	setDetailField('divisions', article.infobox.divisions?.text, 'divisions', 240);
	setDetailField('predecessor', article.infobox.predecessor?.text || article.infobox.predecessors?.text, 'predecessor', 200);
	setDetailField('successor', article.infobox.successor?.text || article.infobox.successors?.text, 'successor', 200);
	setDetailField('isin', article.infobox.isin?.text, 'isin', 80);
	setDetailField('jurisdiction', article.infobox.jurisdiction?.text, 'jurisdiction', 160);
	setDetailField('parentAgency', article.infobox['parent agency']?.text || article.infobox['parent department']?.text, 'parentAgency', 180);
	setDetailField('website', article.infobox.website?.text, 'website', 160);

	// Historic event details
	if (profileType === 'historic_event') {
		setDetailField('eventDateText', article.infobox.date?.text, 'eventDateText', 160);
		setDetailField('eventLocation', article.infobox.location?.text, 'eventLocation', 200);
		setDetailField('eventResult', article.infobox.result?.text || article.infobox.outcome?.text, 'eventResult', 320);
		setDetailField('belligerents', article.infobox.belligerents?.text || article.infobox.participants?.text, 'belligerents', 320);
		setDetailField('commanders', article.infobox['commanders and leaders']?.text, 'commanders', 320);
		setDetailField('casualties', article.infobox['casualties and losses']?.text || article.infobox.casualties?.text, 'casualties', 260);
		setDetailField('causes', article.infobox.cause?.text || article.infobox.causes?.text, 'causes', 260);
	}

	withProfilesTransaction((tx) => {
		updateProfileFields(profileId, {
			summary: nextSummary,
			startDate: nextStartDate,
			endDate: nextEndDate,
			metadata: metaPatch,
		});

		const srId = upsertSourceRecord(
			{
				corpus: 'wikipedia-local',
				sourceRef: `wikipedia:${article.pageName}`,
				sourceUrl: article.canonicalUrl,
				title: article.title,
				publishedDate: nextStartDate,
				excerpt: article.leadSummary.slice(0, 600),
				metadata: {
					articleId: article.articleId,
					kiwixUrl: article.kiwixUrl,
				},
			},
			tx,
		);

		// Identifiers
		addIdentifier(
			{
				profileId,
				scheme: 'url',
				value: article.canonicalUrl,
				sourceCorpus: 'wikipedia-local',
			},
			tx,
		);
		counts.identifiers += 1;

		const traded = article.infobox['traded as']?.text || '';
		const tickerM = traded.match(/\b(?:NYSE|NASDAQ|AMEX|LSE|TSX|BME)\s*:\s*([A-Z]{1,6})\b/i);
		if (tickerM) {
			addIdentifier(
				{
					profileId,
					scheme: 'ticker',
					value: tickerM[1].toUpperCase(),
					sourceCorpus: 'wikipedia-local',
				},
				tx,
			);
			counts.identifiers += 1;
			fieldsUpdated.push('ticker');
		}

		// Aliases
		const aliasCandidates = new Set<string>();
		if (article.title && normalizeText(article.title) !== normalizeText(profileName)) {
			aliasCandidates.add(article.title);
		}
		if (article.birthName && normalizeText(article.birthName) !== normalizeText(profileName)) {
			aliasCandidates.add(article.birthName);
		}
		for (const k of ['formerly', 'former name', 'other names', 'trading name', 'also known as']) {
			for (const item of article.infobox[k]?.items || []) {
				if (item.length >= 3 && item.length <= 90) aliasCandidates.add(item);
			}
		}
		for (const al of aliasCandidates) {
			addAlias(
				{
					profileId,
					alias: al,
					aliasKind: 'name',
					confidence: 0.95,
					sourceCorpus: 'wikipedia-local',
				},
				tx,
			);
			counts.aliases += 1;
		}
		if (counts.aliases > 0) fieldsUpdated.push('aliases');

		// Locations (birthplace, residence, headquarters, location, military bases)
		const locEntries: Array<{ raw: string; role: 'hq' | 'residence' | 'branch' | 'event_site' | 'associated' }> = [];
		if (article.birthPlace) {
			locEntries.push({ raw: article.birthPlace, role: 'residence' });
		}
		if (article.infobox.origin?.text) {
			const clean = extractLocationFromInfoboxText(article.infobox.origin.text);
			if (clean) locEntries.push({ raw: clean, role: 'residence' });
		}
		if (article.infobox.residence?.text) {
			const clean = extractLocationFromInfoboxText(article.infobox.residence.text);
			if (clean) locEntries.push({ raw: clean, role: 'residence' });
		}
		if (article.infobox.headquarters?.text) {
			const clean = extractLocationFromInfoboxText(article.infobox.headquarters.text);
			if (clean) locEntries.push({ raw: clean, role: 'hq' });
		}
		if (article.infobox.location?.text) {
			const clean = extractLocationFromInfoboxText(article.infobox.location.text);
			if (clean) locEntries.push({ raw: clean, role: profileType === 'historic_event' ? 'event_site' : 'hq' });
		}
		if (article.infobox.campus?.text) {
			const clean = extractLocationFromInfoboxText(article.infobox.campus.text);
			if (clean) locEntries.push({ raw: clean, role: 'hq' });
		}

		for (const le of locEntries) {
			const parts = parseAddressParts(le.raw);
			addLocation(
				{
					profileId,
					raw: le.raw,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country,
					role: le.role,
					sourceCorpus: 'wikipedia-local',
				},
				tx,
			);
			counts.locations += 1;
		}
		if (counts.locations > 0) fieldsUpdated.push('locations');

		// Person-specific enrichments: Education, Employment / Title orgs, Military service
		if (profileType === 'person') {
			// Education / Alma mater
			const eduNames = new Set<string>();
			for (const k of ['education', 'alma mater']) {
				const row = article.infobox[k];
				if (!row) continue;
				const preferred = row.links.length ? row.links : row.items;
				for (const item of preferred.slice(0, 6)) {
					const clean = item.replace(/\([^)]*\)/g, '').trim();
					if (clean.length >= 4 && clean.length <= 90 && !/^(bachelor|master|doctor|juris|phd|ba|bs|jd|md|mba)/i.test(clean)) {
						eduNames.add(clean);
					}
				}
			}
			for (const edu of eduNames) {
				const eduRowText = [article.infobox.education?.text, article.infobox['alma mater']?.text]
					.filter(Boolean)
					.join(' ; ');
				const dates = extractOrgDatesFromWiki(edu, 'education', eduRowText, article.bodyText, article.leadSummary);
				addPersonEmployment(
					{
						personIdOrSlug: profileId,
						orgName: edu,
						orgCategory: 'education',
						role: 'Alumni',
						startDate: dates.startDate,
						endDate: dates.endDate,
						isCurrent: dates.isCurrent,
						sourceCorpus: 'wikipedia-local',
						notes: `Wikipedia infobox education (${article.title})`,
					},
					tx,
				);
				counts.employments += 1;
			}

			// Employer / Organizations / Title
			const empSeen = new Set<string>();
			for (const k of ['employer', 'employers', 'organizations', 'organization', 'board member of']) {
				const row = article.infobox[k];
				if (!row) continue;
				const preferred = row.links.length ? row.links : row.items;
				for (const item of preferred.slice(0, 5)) {
					const clean = item.replace(/\([^)]*\)/g, '').trim();
					if (clean.length < 3 || clean.length > 80) continue;
					const norm = normalizeText(clean);
					if (empSeen.has(norm) || norm === normalizeText(profileName)) continue;
					empSeen.add(norm);
					const dates = extractOrgDatesFromWiki(clean, 'employment', row.text, article.bodyText, article.leadSummary);
					addPersonEmployment(
						{
							personIdOrSlug: profileId,
							orgName: clean,
							orgCategory: classifyOrgType(clean),
							role: k === 'board member of' ? 'Board member' : null,
							startDate: dates.startDate,
							endDate: dates.endDate,
							isCurrent: dates.isCurrent,
							sourceCorpus: 'wikipedia-local',
							notes: `Wikipedia infobox ${k} (${article.title})`,
						},
						tx,
					);
					counts.employments += 1;
				}
			}

			if (article.infobox.title?.items) {
				for (const item of article.infobox.title.items.slice(0, 3)) {
					const { role, org } = cleanRoleEntityPair(item);
					if (org && org.length >= 3 && org.length <= 75) {
						const norm = normalizeText(org);
						if (!empSeen.has(norm) && norm !== normalizeText(profileName)) {
							empSeen.add(norm);
							const dates = extractOrgDatesFromWiki(
								org,
								'employment',
								article.infobox.title.text,
								article.bodyText,
								article.leadSummary,
							);
							addPersonEmployment(
								{
									personIdOrSlug: profileId,
									orgName: org,
									orgCategory: classifyOrgType(org),
									role: role || 'Executive / Title',
									startDate: dates.startDate,
									endDate: dates.endDate,
									isCurrent: dates.isCurrent,
									sourceCorpus: 'wikipedia-local',
									notes: `Wikipedia infobox title (${article.title})`,
								},
								tx,
							);
							counts.employments += 1;
						}
					}
				}
			}

			// Military service branch / commands
			const milBranch = article.infobox.branch?.text || article.infobox['service branch']?.text;
			if (milBranch && milBranch.length >= 3 && milBranch.length <= 90) {
				const years = article.infobox['years of service']?.text || '';
				const ym = years.match(/(\d{4})\s*[–-]\s*(\d{4}|present)/i);
				addPersonEmployment(
					{
						personIdOrSlug: profileId,
						orgName: milBranch.split(/[,;\n]/)[0].trim(),
						orgCategory: 'government',
						role: article.infobox.rank?.text ? `Military (${article.infobox.rank.text})` : 'Military service',
						startDate: ym ? ym[1] : null,
						endDate: ym && ym[2] !== 'present' ? ym[2] : null,
						sourceCorpus: 'wikipedia-local',
						notes: `Wikipedia military service (${years || article.title})`,
					},
					tx,
				);
				counts.employments += 1;
			}
			if (counts.employments > 0) fieldsUpdated.push('employmentHistory');
		} else if (
			profileType === 'firm' ||
			profileType === 'education' ||
			profileType === 'nonprofit' ||
			profileType === 'medical_hospital' ||
			profileType === 'government'
		) {
			// Link founders & key people (as person profiles)
			for (const k of ['founder', 'founders', 'key people']) {
				const row = article.infobox[k];
				if (!row) continue;
				const people = (row.links.length ? row.links : row.items).slice(0, 4);
				for (const pRaw of people) {
					const clean = pRaw.replace(/\([^)]*\)/g, '').trim();
					if (clean.length < 4 || clean.length > 60 || !clean.includes(' ')) continue;
					if (/^(chairman|ceo|president|director|executive|founder)/i.test(clean)) continue;
					const personProf = upsertProfile(
						{
							profileType: 'person',
							name: clean,
							sourceCorpus: 'wikipedia-local',
						},
						tx,
					);
					upsertProfileLink(
						{
							fromProfileId: personProf.id,
							toProfileId: profileId,
							relationType: 'affiliated_with',
							roleLabel: k.startsWith('founder') ? 'Founder' : 'Key executive',
							status: 'verified',
							confidence: 0.9,
							angle: 'corporate',
							sourceCorpus: 'wikipedia-local',
							sourceRecordId: srId,
							evidenceNote: `Wikipedia infobox ${k} on ${article.title}`,
						},
						tx,
					);
					counts.links += 1;
				}
			}

			// Link parent, subsidiaries, predecessor & successor
			for (const k of ['parent', 'owner', 'subsidiaries', 'predecessor', 'successor']) {
				const row = article.infobox[k];
				if (!row) continue;
				const orgs = (row.links.length ? row.links : row.items).slice(0, 4);
				for (const oRaw of orgs) {
					const clean = oRaw.replace(/\([^)]*\)/g, '').trim();
					if (clean.length < 3 || clean.length > 75 || normalizeText(clean) === normalizeText(profileName)) continue;
					const orgProf = upsertProfile(
						{
							profileType: classifyOrgType(clean),
							name: clean,
							sourceCorpus: 'wikipedia-local',
						},
						tx,
					);
					const roleMap: Record<string, string> = {
						subsidiaries: 'Subsidiary',
						parent: 'Parent / Owner',
						owner: 'Parent / Owner',
						predecessor: 'Predecessor',
						successor: 'Successor',
					};
					upsertProfileLink(
						{
							fromProfileId: k === 'subsidiaries' || k === 'successor' ? profileId : orgProf.id,
							toProfileId: k === 'subsidiaries' || k === 'successor' ? orgProf.id : profileId,
							relationType: 'business_tie',
							roleLabel: roleMap[k] || k,
							status: 'verified',
							confidence: 0.9,
							angle: 'corporate',
							sourceCorpus: 'wikipedia-local',
							sourceRecordId: srId,
							evidenceNote: `Wikipedia infobox ${k} on ${article.title}`,
						},
						tx,
					);
					counts.links += 1;
				}
			}
			if (counts.links > 0) fieldsUpdated.push('links');
		}

		// Timeline entries (birth/founding, death/defunct, career milestones)
		if (article.birthDate) {
			upsertTimelineEntry(
				{
					profileId,
					eventDate: article.birthDate,
					title: `Born: ${article.birthName || article.title}${article.birthPlace ? ` (${article.birthPlace})` : ''}`,
					summary: article.infobox.born?.text || article.leadSummary.slice(0, 240),
					angle: 'general',
					entryKind: 'milestone',
					geoLabel: article.birthPlace,
					sourceCorpus: 'wikipedia-local',
					sourceRecordId: srId,
					dedupeHint: 'wiki:born',
				},
				tx,
			);
			counts.timelineEntries += 1;
		} else if (foundedDate) {
			upsertTimelineEntry(
				{
					profileId,
					eventDate: foundedDate,
					title: `Founded: ${article.title}`,
					summary: article.infobox.founded?.text || article.leadSummary.slice(0, 240),
					angle: 'corporate',
					entryKind: 'milestone',
					sourceCorpus: 'wikipedia-local',
					sourceRecordId: srId,
					dedupeHint: 'wiki:founded',
				},
				tx,
			);
			counts.timelineEntries += 1;
		}

		if (article.deathDate) {
			upsertTimelineEntry(
				{
					profileId,
					eventDate: article.deathDate,
					title: `Died: ${article.title}`,
					summary: article.infobox.died?.text || '',
					angle: 'general',
					entryKind: 'milestone',
					sourceCorpus: 'wikipedia-local',
					sourceRecordId: srId,
					dedupeHint: 'wiki:died',
				},
				tx,
			);
			counts.timelineEntries += 1;
		}

		for (const ms of article.datedMilestones) {
			upsertTimelineEntry(
				{
					profileId,
					eventDate: ms.date,
					title: ms.title,
					summary: ms.summary,
					angle: profileType === 'firm' ? 'corporate' : 'general',
					entryKind: 'milestone',
					sourceCorpus: 'wikipedia-local',
					sourceRecordId: srId,
					dedupeHint: `wiki:ms:${ms.date}`,
				},
				tx,
			);
			counts.timelineEntries += 1;
		}
		if (counts.timelineEntries > 0) fieldsUpdated.push('timeline');
	});

	return { fieldsUpdated: [...new Set(fieldsUpdated)], countsAdded: counts };
}

async function enrichFromLocalWikipedia(
	ctx: ProfileIdentityContext,
	kiwixBaseUrl: string,
): Promise<EnrichSourceOutcome> {
	const counts = emptyCounts();
	const searchQueries: string[] = [ctx.name];
	if (ctx.profileType === 'person' && ctx.firmsAndAssociates[0]) {
		searchQueries.push(`${ctx.name} ${ctx.firmsAndAssociates[0]}`);
	} else if (ctx.profileType === 'person' && ctx.locations[0]?.city) {
		searchQueries.push(`${ctx.name} ${ctx.locations[0].city}`);
	}

	const candidateLinks = new Map<string, KiwixSearchHit>();
	// Try direct exact Wikipedia article path first so e.g. "Bell Textron" hits /Bell_Textron before search results like "Textron"
	const directSlug = ctx.name.trim().replace(/\s+/g, '_');
	if (directSlug.length >= 3 && !/[/?#]/.test(directSlug)) {
		const directLink = `/content/wikipedia_en_all_maxi/${encodeURIComponent(directSlug)}`;
		candidateLinks.set(directLink, { title: ctx.name, link: directLink });
	}
	for (const q of searchQueries) {
		const hits = await searchKiwixWikipedia(q, kiwixBaseUrl, 6);
		for (const h of hits) {
			if (!candidateLinks.has(h.link)) candidateLinks.set(h.link, h);
		}
		if (candidateLinks.size >= 8) break;
	}

	if (candidateLinks.size === 0) {
		return {
			source: 'wikipedia_local',
			status: 'not_found',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'No matching local Wikipedia article found.',
		};
	}

	let bestValidated: { article: ParsedWikiArticle; evalRes: ReturnType<typeof evaluateIdentityMatch> } | null = null;
	let bestNameOnly: { article: ParsedWikiArticle; evalRes: ReturnType<typeof evaluateIdentityMatch> } | null = null;

	// Inspect top 5 candidate articles to find a validated match
	let inspected = 0;
	for (const hit of candidateLinks.values()) {
		if (inspected >= 5) break;
		inspected += 1;

		const article = await fetchAndParseKiwixArticle(hit.link, kiwixBaseUrl);
		if (!article || article.isDisambiguation) continue;

		const candInput = buildWikiCandidateInput(article);
		const evalRes = evaluateIdentityMatch(ctx, candInput);

		if (evalRes.decision === 'validated_merge') {
			if (!bestValidated || evalRes.score > bestValidated.evalRes.score) {
				bestValidated = { article, evalRes };
			}
			// High-confidence exact match validated -> stop early
			if (evalRes.score >= 0.9) break;
		} else if (evalRes.decision === 'name_only_note') {
			if (!bestNameOnly || evalRes.score > bestNameOnly.evalRes.score) {
				bestNameOnly = { article, evalRes };
			}
		}
	}

	if (bestValidated) {
		const applied = applyValidatedWikipediaEnrichment(
			ctx.profileId,
			ctx.profileType,
			ctx.name,
			bestValidated.article,
		);
		return {
			source: 'wikipedia_local',
			status: 'merged',
			candidateTitle: bestValidated.article.title,
			candidateUrl: bestValidated.article.canonicalUrl,
			evaluation: bestValidated.evalRes,
			fieldsUpdated: applied.fieldsUpdated,
			countsAdded: applied.countsAdded,
			note: bestValidated.evalRes.rationale,
		};
	}

	if (bestNameOnly) {
		// STRICT RULE: Name-only match -> DO NOT MERGE ANY DATA! Record a reviewable note only.
		const art = bestNameOnly.article;
		const ev = bestNameOnly.evalRes;
		upsertAlignmentCandidate({
			dedupeKey: sha256Key(['possible_match_name_only', ctx.profileId, 'wikipedia-local', art.pageName]),
			alignmentKind: 'possible_match_name_only',
			leftProfileId: ctx.profileId,
			rightProfileId: null,
			score: ev.score,
			cautionTier: 'observation',
			rationale: `${ev.rationale} ${ev.missingValidationHint || ''}`.trim(),
			evidence: [
				{
					corpus: 'wikipedia-local',
					label: `Wikipedia: ${art.title}`,
					url: art.canonicalUrl,
					sourceRef: `wikipedia:${art.pageName}`,
					snippet: art.leadSummary.slice(0, 260),
				},
			],
		});
		counts.notes += 1;
		return {
			source: 'wikipedia_local',
			status: 'name_only_note',
			candidateTitle: art.title,
			candidateUrl: art.canonicalUrl,
			evaluation: ev,
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'Name-only match found on Wikipedia; held as possible_match_name_only note (nothing merged).',
		};
	}

	return {
		source: 'wikipedia_local',
		status: 'not_found',
		fieldsUpdated: [],
		countsAdded: counts,
		note: 'Local Wikipedia candidates did not pass identity or date validation.',
	};
}

async function enrichFromBrokercheck(ctx: ProfileIdentityContext): Promise<EnrichSourceOutcome> {
	const counts = emptyCounts();
	if (ctx.profileType !== 'person') {
		return {
			source: 'brokercheck',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'BrokerCheck applies to person profiles with FINRA CRD.',
		};
	}

	const crdIdent = ctx.identifiers.find((i) => i.scheme === 'finra_crd');
	if (!crdIdent) {
		return {
			source: 'brokercheck',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'No FINRA CRD identifier on profile.',
		};
	}

	const res = await lookupBrokercheckIndividual({ crd: crdIdent.value, includeAdviserInfo: true });
	if (!res.ok || !res.result.profile) {
		return {
			source: 'brokercheck',
			status: 'error',
			fieldsUpdated: [],
			countsAdded: counts,
			note: String(res.result.error || 'BrokerCheck lookup failed'),
		};
	}

	const bc = res.result.profile as Record<string, unknown>;
	const ia = (res.result.adviserInfo as Record<string, unknown> | undefined) || null;
	const bcName = String(bc.name || ctx.name);
	const brokercheckUrl = String(bc.brokercheckUrl || `https://brokercheck.finra.org/individual/summary/${crdIdent.value}`);

	// Validate via evaluateIdentityMatch (auto-validates via shared_identifier finra_crd!)
	const evalRes = evaluateIdentityMatch(ctx, {
		candidateName: bcName,
		candidateAliases: Array.isArray(bc.otherNames) ? bc.otherNames.map(String) : [],
		candidateIdentifiers: [{ scheme: 'finra_crd', value: crdIdent.value }],
		candidateText: `FINRA CRD ${crdIdent.value} ${bcName}`,
	});

	if (evalRes.decision !== 'validated_merge') {
		return {
			source: 'brokercheck',
			status: 'skipped',
			candidateTitle: bcName,
			candidateUrl: brokercheckUrl,
			evaluation: evalRes,
			fieldsUpdated: [],
			countsAdded: counts,
		};
	}

	const fieldsUpdated: string[] = [];
	const allEmployments: BrokercheckEmployment[] = [
		...(Array.isArray(bc.employments) ? (bc.employments as BrokercheckEmployment[]) : []),
		...(ia && Array.isArray(ia.employments) ? (ia.employments as BrokercheckEmployment[]) : []),
	];
	const allExams: BrokercheckExam[] = [
		...(Array.isArray(bc.exams) ? (bc.exams as BrokercheckExam[]) : []),
	];
	const otherNames = [
		...(Array.isArray(bc.otherNames) ? bc.otherNames.map(String) : []),
		...(ia && Array.isArray(ia.otherNames) ? ia.otherNames.map(String) : []),
	];

	withProfilesTransaction((tx) => {
		const detail = getProfileDetail(ctx.profileId);
		const prevMeta = detail?.profile.metadata || {};
		const prevCorpora = Array.isArray(prevMeta.corpora) ? prevMeta.corpora.map(String) : [];
		const nextCorpora = prevCorpora.includes('finra-brokercheck')
			? prevCorpora
			: [...prevCorpora, 'finra-brokercheck'];

		const summaryParts: string[] = [];
		if (bc.bcScope) summaryParts.push(`BrokerCheck scope: ${String(bc.bcScope)}`);
		if (bc.iaScope) summaryParts.push(`IA scope: ${String(bc.iaScope)}`);
		if (bc.daysInIndustry) summaryParts.push(`Days in industry: ${String(bc.daysInIndustry)}`);
		if (bc.disclosureCount != null) summaryParts.push(`Disclosures: ${String(bc.disclosureCount)}`);
		if (allEmployments.length) summaryParts.push(`Recorded firm registrations: ${allEmployments.length}`);

		const nextSummary =
			detail && detail.profile.summary.trim().length < 40 && summaryParts.length
				? `${bcName} (FINRA CRD# ${crdIdent.value}). ${summaryParts.join(' · ')}.`
				: detail?.profile.summary;

		if (detail && nextSummary && nextSummary !== detail.profile.summary) {
			fieldsUpdated.push('summary');
		}

		const examLabels = allExams
			.slice(0, 14)
			.map((ex) => {
				const d = normalizeIsoDate(ex.takenDate).date;
				return [ex.category, ex.name, d ? `(${d})` : ''].filter(Boolean).join(' ');
			})
			.filter(Boolean);
		const regStates = Array.isArray(bc.registeredStates)
			? (bc.registeredStates as Array<Record<string, unknown>>)
					.map((s) => String(s.state || s.name || s || '').trim())
					.filter(Boolean)
					.slice(0, 30)
			: [];
		const regSros = Array.isArray(bc.registeredSROs)
			? (bc.registeredSROs as Array<Record<string, unknown>>)
					.map((s) => String(s.sro || s.name || s || '').trim())
					.filter(Boolean)
					.slice(0, 15)
			: [];

		updateProfileFields(ctx.profileId, {
			summary: nextSummary,
			metadata: {
				corpora: nextCorpora,
				brokercheckUrl,
				finraBcScope: bc.bcScope || null,
				finraIaScope: bc.iaScope || null,
				finraDaysInIndustry: bc.daysInIndustry ?? null,
				finraDisclosureCount: bc.disclosureCount ?? 0,
				finraExams: examLabels.length ? examLabels : undefined,
				finraRegisteredStates: regStates.length ? regStates : undefined,
				finraRegisteredSROs: regSros.length ? regSros : undefined,
				lastBrokercheckEnrichedAt: new Date().toISOString(),
			},
		});

		const srId = upsertSourceRecord(
			{
				corpus: 'finra-brokercheck',
				sourceRef: `finra:crd:${crdIdent.value}`,
				sourceUrl: brokercheckUrl,
				title: `FINRA BrokerCheck: ${bcName} (CRD# ${crdIdent.value})`,
				excerpt: summaryParts.join(' · '),
			},
			tx,
		);

		addIdentifier(
			{
				profileId: ctx.profileId,
				scheme: 'url',
				value: brokercheckUrl,
				sourceCorpus: 'finra-brokercheck',
			},
			tx,
		);
		counts.identifiers += 1;

		for (const on of [...new Set(otherNames)]) {
			if (on.trim().length >= 3) {
				addAlias(
					{
						profileId: ctx.profileId,
						alias: on.trim(),
						aliasKind: 'former_name',
						confidence: 0.98,
						sourceCorpus: 'finra-brokercheck',
					},
					tx,
				);
				counts.aliases += 1;
			}
		}
		if (counts.aliases > 0) fieldsUpdated.push('aliases');

		const seenEmp = new Set<string>();
		for (const emp of allEmployments) {
			const firmName = String(emp.firmName || '').trim();
			if (!firmName) continue;
			const startDate = normalizeIsoDate(emp.begin).date;
			const endDate = normalizeIsoDate(emp.end).date;
			const dedupe = `${normalizeText(firmName)}|${startDate || ''}|${endDate || ''}`;
			if (seenEmp.has(dedupe)) continue;
			seenEmp.add(dedupe);

			const loc = [emp.city, emp.state].filter(Boolean).join(', ');
			const isCurrent = emp.source === 'current' || emp.source === 'currentIA';
			const added = addPersonEmployment(
				{
					personIdOrSlug: ctx.profileId,
					orgName: firmName,
					orgCategory: 'firm',
					role: emp.source.includes('IA') ? 'Investment Adviser Representative' : 'Registered Representative',
					startDate,
					endDate,
					isCurrent,
					location: loc || null,
					sourceCorpus: 'finra-brokercheck',
					notes: `BrokerCheck CRD# ${crdIdent.value}${emp.firmId ? ` · Firm CRD# ${emp.firmId}` : ''}`,
				},
				tx,
			);
			counts.employments += 1;
			if (loc) counts.locations += 1;
			if (added && emp.firmId) {
				addIdentifier(
					{
						profileId: added.orgProfile.id,
						scheme: 'finra_crd',
						value: emp.firmId,
						sourceCorpus: 'finra-brokercheck',
					},
					tx,
				);
			}
		}
		if (counts.employments > 0) fieldsUpdated.push('employmentHistory');
		if (counts.locations > 0) fieldsUpdated.push('locations');

		for (const ex of allExams.slice(0, 12)) {
			const exDate = normalizeIsoDate(ex.takenDate).date;
			const label = [ex.category, ex.name].filter(Boolean).join(' — ');
			if (!label) continue;
			upsertTimelineEntry(
				{
					profileId: ctx.profileId,
					eventDate: exDate,
					title: `FINRA Exam Passed: ${label}`,
					summary: `Scope: ${ex.scope || ex.kind} (CRD# ${crdIdent.value})`,
					angle: 'regulatory_finra',
					entryKind: 'milestone',
					sourceCorpus: 'finra-brokercheck',
					sourceRecordId: srId,
					dedupeHint: `exam:${ex.category || ex.name}:${exDate || ''}`,
				},
				tx,
			);
			counts.timelineEntries += 1;
		}
		if (counts.timelineEntries > 0) fieldsUpdated.push('timeline');
	});

	return {
		source: 'brokercheck',
		status: 'merged',
		candidateTitle: bcName,
		candidateUrl: brokercheckUrl,
		evaluation: evalRes,
		fieldsUpdated: [...new Set(fieldsUpdated)],
		countsAdded: counts,
		note: evalRes.rationale,
	};
}

/**
 * Enrich a FINRA-registered firm profile with all current and previous connected individuals
 * via `GET /api/finra/firm/{crd}/connections` on the FINRA/SEC visualizer API.
 */
async function enrichFirmFromFinraConnections(ctx: ProfileIdentityContext): Promise<EnrichSourceOutcome> {
	const counts = emptyCounts();
	if (ctx.profileType !== 'firm') {
		return {
			source: 'brokercheck',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'Firm connections lookup applies to firm profiles.',
		};
	}
	const crdIdent = ctx.identifiers.find((i) => i.scheme === 'finra_crd');
	if (!crdIdent) {
		return {
			source: 'brokercheck',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'No FINRA CRD identifier on firm profile.',
		};
	}

	const firmCrd = String(crdIdent.value).replace(/\D/g, '');
	if (!firmCrd) {
		return {
			source: 'brokercheck',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'Invalid FINRA CRD identifier on firm profile.',
		};
	}

	// Step A: Ingest full merged firm dossier (HQ/mailing addresses, direct owners/officers, approval date, disclosures)
	let firmDetailNote = '';
	try {
		const fd = await ingestFirmDetailsFromVisualizer(firmCrd, { profileIdOverride: ctx.profileId });
		if (fd.found) {
			counts.locations += fd.locationsAdded;
			counts.links += fd.ownersLinked;
			counts.aliases += fd.aliasesAdded;
			counts.timelineEntries += fd.timelineAdded;
			firmDetailNote = ` Firm dossier synced (${fd.locationsAdded} locations, ${fd.ownersLinked} direct owners/officers, ${fd.timelineAdded} milestones).`;
		}
	} catch {
		/* non-fatal; proceed with connections */
	}

	const url = finraApiUrl(`/api/finra/firm/${firmCrd}/connections`);
	let payload: Record<string, unknown> | null = null;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 45_000);
		try {
			const res = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: controller.signal,
				headers: { Accept: 'application/json' },
			});
			if (!res.ok) {
				return {
					source: 'brokercheck',
					status: 'error',
					candidateUrl: url,
					fieldsUpdated: [],
					countsAdded: counts,
					note: `FINRA connections HTTP ${res.status}`,
				};
			}
			payload = (await res.json()) as Record<string, unknown>;
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		return {
			source: 'brokercheck',
			status: 'error',
			candidateUrl: url,
			fieldsUpdated: [],
			countsAdded: counts,
			note: `FINRA connections error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const curRaw = Array.isArray(payload?.currentConnections)
		? (payload.currentConnections as Array<Record<string, unknown>>)
		: [];
	const prevRaw = Array.isArray(payload?.previousConnections)
		? (payload.previousConnections as Array<Record<string, unknown>>)
		: [];

	if (payload?.found === false || (curRaw.length === 0 && prevRaw.length === 0)) {
		return {
			source: 'brokercheck',
			status: 'not_found',
			candidateUrl: url,
			fieldsUpdated: [],
			countsAdded: counts,
			note: `No FINRA firm connections found for CRD# ${firmCrd}.`,
		};
	}

	const evalRes = evaluateIdentityMatch(ctx, {
		candidateName: ctx.name,
		candidateIdentifiers: [{ scheme: 'finra_crd', value: firmCrd }],
		candidateText: `FINRA Firm Connections CRD# ${firmCrd} ${ctx.name}`,
	});

	const fieldsUpdated: string[] = [];
	const CORPUS = 'finra-visualizer';

	withProfilesTransaction((tx) => {
		const srId = upsertSourceRecord(
			{
				corpus: CORPUS,
				sourceRef: `finra:firm:${firmCrd}:connections`,
				sourceUrl: url,
				title: `FINRA Connections: ${ctx.name} (CRD# ${firmCrd})`,
				excerpt: `${curRaw.length} current · ${prevRaw.length} previous connected registrations.`,
			},
			tx,
		);

		const ingestGroup = (rows: Array<Record<string, unknown>>, isCurrent: boolean) => {
			const seen = new Set<string>();
			for (const r of rows) {
				const indCrd = String(r.individualId || r.crd || '').replace(/\D/g, '');
				const name = String(r.name || '').replace(/\s+/g, ' ').trim();
				if (!indCrd || !name || seen.has(indCrd)) continue;
				seen.add(indCrd);
				const bcScope = typeof r.bcScope === 'string' && r.bcScope.trim() ? r.bcScope.trim() : null;
				const iaScope = typeof r.iaScope === 'string' && r.iaScope.trim() ? r.iaScope.trim() : null;
				const address = typeof r.address === 'string' && r.address.trim() ? r.address.trim() : null;

				const personProf = upsertProfile(
					{
						profileType: 'person',
						name,
						sourceCorpus: CORPUS,
						metadata: {
							finraCrd: indCrd,
							finraBcScope: bcScope,
							finraIaScope: iaScope,
						},
					},
					tx,
				);
				addIdentifier(
					{
						profileId: personProf.id,
						scheme: 'finra_crd',
						value: indCrd,
						sourceCorpus: CORPUS,
					},
					tx,
				);
				if (address) {
					const parts = parseAddressParts(address);
					addLocation(
						{
							profileId: personProf.id,
							raw: address,
							city: parts.city,
							county: parts.county,
							state: parts.state,
							country: parts.country,
							role: 'branch',
							sourceCorpus: CORPUS,
						},
						tx,
					);
				}
				const noteParts = [
					`status=${isCurrent ? 'current' : 'previous'}`,
					`CRD# ${indCrd}`,
					bcScope ? `bcScope=${bcScope}` : '',
					iaScope ? `iaScope=${iaScope}` : '',
					address ? `branch=${address}` : '',
				].filter(Boolean);
				upsertProfileLink(
					{
						fromProfileId: personProf.id,
						toProfileId: ctx.profileId,
						relationType: 'registered_at',
						roleLabel: isCurrent ? 'Current registration' : 'Previous registration',
						status: 'verified',
						confidence: 0.96,
						angle: 'regulatory_finra',
						sourceCorpus: CORPUS,
						sourceRecordId: srId,
						evidenceNote: noteParts.join('; '),
					},
					tx,
				);
				counts.links += 1;
			}
		};

		ingestGroup(curRaw, true);
		ingestGroup(prevRaw, false);
		if (counts.links > 0) fieldsUpdated.push('links');
	});

	let dateNote = '';
	try {
		const dateRes = await hydrateFirmConnectionDates(ctx.profileId, {
			maxPeople: 150,
			concurrency: 4,
		});
		if (dateRes && dateRes.linksUpdated > 0) {
			fieldsUpdated.push('employment_dates');
			dateNote = ` Hydrated employment dates on ${dateRes.linksUpdated} links (${dateRes.peopleWithDates}/${dateRes.peopleChecked} people).`;
		}
	} catch {
		/* non-fatal */
	}

	return {
		source: 'brokercheck',
		status: 'merged',
		candidateTitle: `${ctx.name} (CRD# ${firmCrd})`,
		candidateUrl: url,
		evaluation: evalRes,
		fieldsUpdated: [...new Set(fieldsUpdated)],
		countsAdded: counts,
		note: `Synced ${curRaw.length} current and ${prevRaw.length} previous FINRA connections via ${url}.${firmDetailNote}${dateNote}`,
	};
}

function extractDateFromText(title: string, text: string): string | null {
	const hay = `${title}\n${text}`;
	const recMatch = hay.match(/(?:recorded|filed|date)[:\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
	if (recMatch) return normalizeIsoDate(recMatch[1]).date;
	const anyIso = hay.match(/\b(19\d{2}|20[0-2]\d)-\d{2}-\d{2}\b/);
	if (anyIso) return anyIso[0];
	const anySlash = hay.match(/\b(\d{1,2}\/\d{1,2}\/(?:19\d{2}|20[0-2]\d))\b/);
	if (anySlash) return normalizeIsoDate(anySlash[1]).date;
	return null;
}

function enrichFromKnowledgeSqlite(ctx: ProfileIdentityContext): EnrichSourceOutcome {
	const counts = emptyCounts();
	const kPath = getKnowledgeSqlitePath();
	if (!fs.existsSync(kPath)) {
		return {
			source: 'knowledge_sqlite',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'Local knowledge.sqlite not present.',
		};
	}

	const phrases = buildSearchPhrasesForProfile(ctx.name, ctx.profileType, ctx.aliases);
	if (!phrases.length) {
		return {
			source: 'knowledge_sqlite',
			status: 'skipped',
			fieldsUpdated: [],
			countsAdded: counts,
			note: 'Profile name too short for FTS search.',
		};
	}

	let kdb: DatabaseSync | null = null;
	const rawHits = new Map<
		string,
		{
			docId: string;
			title: string;
			url: string | null;
			projectName: string;
			snippet: string;
			matchedPhrase: string;
			date: string | null;
		}
	>();

	try {
		kdb = new DatabaseSync(kPath, { readOnly: true });
		const stmt = kdb.prepare(
			`SELECT d.id AS doc_id, d.title, d.url, p.name AS project_name, substr(c.text, 1, 800) AS snippet
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       JOIN documents d ON d.id = c.document_id
       JOIN projects p ON p.id = d.project_id
       WHERE chunks_fts MATCH ?
         AND p.name IN ('Bryan County', 'Cherokee County', 'Adair County', 'Sequoyah County', 'Dallas County Deeds', 'Research Drive')
       LIMIT 6`,
		);

		for (const phrase of phrases.slice(0, 5)) {
			try {
				const rows = stmt.all(`"${phrase}"`) as Array<Record<string, unknown>>;
				for (const r of rows) {
					const docId = String(r.doc_id);
					if (rawHits.has(docId)) continue;
					const title = String(r.title || '');
					const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim();
					rawHits.set(docId, {
						docId,
						title,
						url: r.url != null ? String(r.url) : null,
						projectName: String(r.project_name || 'knowledge'),
						snippet,
						matchedPhrase: phrase,
						date: extractDateFromText(title, snippet),
					});
					if (rawHits.size >= 10) break;
				}
			} catch {
				/* skip invalid FTS phrase */
			}
			if (rawHits.size >= 10) break;
		}
	} catch (error: unknown) {
		return {
			source: 'knowledge_sqlite',
			status: 'error',
			fieldsUpdated: [],
			countsAdded: counts,
			note: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (kdb) {
			try {
				kdb.close();
			} catch {
				/* ignore */
			}
		}
	}

	if (rawHits.size === 0) {
		return {
			source: 'knowledge_sqlite',
			status: 'not_found',
			fieldsUpdated: [],
			countsAdded: counts,
		};
	}

	const validatedHits: Array<{ hit: NonNullable<ReturnType<typeof rawHits.get>>; evalRes: ReturnType<typeof evaluateIdentityMatch> }> = [];
	const nameOnlyHits: Array<{ hit: NonNullable<ReturnType<typeof rawHits.get>>; evalRes: ReturnType<typeof evaluateIdentityMatch> }> = [];

	for (const hit of rawHits.values()) {
		const countyHint = /county|deeds/i.test(hit.projectName)
			? hit.projectName.replace(/\s+Deeds$/i, '')
			: '';
		const stateHint = /Bryan|Cherokee|Adair|Sequoyah/i.test(hit.projectName)
			? 'Oklahoma'
			: /Dallas/i.test(hit.projectName)
				? 'Texas'
				: '';

		const evalRes = evaluateIdentityMatch(ctx, {
			candidateName: hit.matchedPhrase,
			candidateLocations: [countyHint, stateHint].filter(Boolean),
			candidateEventDates: hit.date ? [hit.date] : [],
			candidateText: `${hit.projectName} ${stateHint} ${hit.title} ${hit.snippet}`,
		});

		if (evalRes.decision === 'validated_merge') {
			validatedHits.push({ hit, evalRes });
		} else if (evalRes.decision === 'name_only_note') {
			nameOnlyHits.push({ hit, evalRes });
		}
	}

	const fieldsUpdated: string[] = [];

	withProfilesTransaction((tx) => {
		if (validatedHits.length > 0) {
			const projects = [...new Set(validatedHits.map((v) => v.hit.projectName))];
			const topEval = validatedHits[0].evalRes;
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['county_filing_match', ctx.profileId]),
					alignmentKind: 'county_filing_match',
					leftProfileId: ctx.profileId,
					rightProfileId: null,
					score: Math.max(...validatedHits.map((v) => v.evalRes.score)),
					cautionTier: validatedHits.length >= 2 ? 'stronger_indicator' : 'closer_look',
					rationale: `Validated match across ${validatedHits.length} local knowledge record(s) (${projects.join(', ')}). ${topEval.rationale}`,
					evidence: validatedHits.slice(0, 6).map((v) => ({
						corpus: `knowledge:${v.hit.projectName}`,
						label: v.hit.title.slice(0, 120),
						date: v.hit.date,
						url: v.hit.url,
						sourceRef: `knowledge:doc:${v.hit.docId}`,
						snippet: v.hit.snippet.slice(0, 220),
					})),
				},
				tx,
			);

			for (const v of validatedHits.slice(0, 4)) {
				const srId = upsertSourceRecord(
					{
						corpus: 'knowledge-sqlite',
						sourceRef: `knowledge:doc:${v.hit.docId}`,
						sourceUrl: v.hit.url,
						title: `[${v.hit.projectName}] ${v.hit.title}`,
						publishedDate: v.hit.date,
						excerpt: v.hit.snippet.slice(0, 600),
						metadata: { projectName: v.hit.projectName, docId: v.hit.docId },
					},
					tx,
				);
				upsertTimelineEntry(
					{
						profileId: ctx.profileId,
						eventDate: v.hit.date,
						title: `[${v.hit.projectName}] ${v.hit.title}`,
						summary: v.hit.snippet.slice(0, 400),
						angle: /county|deeds/i.test(v.hit.projectName) ? 'land_records' : 'general',
						entryKind: 'filing',
						confidence: v.evalRes.score,
						sourceCorpus: 'knowledge-sqlite',
						sourceRecordId: srId,
						dedupeHint: `kdoc:${v.hit.docId}`,
					},
					tx,
				);
				counts.timelineEntries += 1;
			}
			fieldsUpdated.push('timeline');
		}

		if (nameOnlyHits.length > 0) {
			// STRICT RULE: Name-only hits in county deeds / Research Drive are NEVER added to timeline — note only!
			const projects = [...new Set(nameOnlyHits.map((n) => n.hit.projectName))];
			const sample = nameOnlyHits[0].evalRes;
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['possible_match_name_only', ctx.profileId, 'knowledge-sqlite']),
					alignmentKind: 'possible_match_name_only',
					leftProfileId: ctx.profileId,
					rightProfileId: null,
					score: sample.score,
					cautionTier: 'observation',
					rationale: `Name-only hit in local records (${projects.join(', ')}): ${nameOnlyHits.length} doc(s) matched name/initials without corroborating address, firm, military base, or institution. NOT merged onto profile/timeline — verify party/address first.`,
					evidence: nameOnlyHits.slice(0, 6).map((n) => ({
						corpus: `knowledge:${n.hit.projectName}`,
						label: n.hit.title.slice(0, 120),
						date: n.hit.date,
						url: n.hit.url,
						sourceRef: `knowledge:doc:${n.hit.docId}`,
						snippet: n.hit.snippet.slice(0, 220),
					})),
				},
				tx,
			);
			counts.notes += 1;
		}
	});

	if (validatedHits.length > 0) {
		return {
			source: 'knowledge_sqlite',
			status: 'merged',
			candidateTitle: validatedHits[0].hit.title,
			candidateUrl: validatedHits[0].hit.url,
			evaluation: validatedHits[0].evalRes,
			fieldsUpdated,
			countsAdded: counts,
			note: `${validatedHits.length} validated hit(s) added; ${nameOnlyHits.length} name-only hit(s) held as notes.`,
		};
	}

	if (nameOnlyHits.length > 0) {
		return {
			source: 'knowledge_sqlite',
			status: 'name_only_note',
			candidateTitle: nameOnlyHits[0].hit.title,
			candidateUrl: nameOnlyHits[0].hit.url,
			evaluation: nameOnlyHits[0].evalRes,
			fieldsUpdated: [],
			countsAdded: counts,
			note: `${nameOnlyHits.length} name-only hit(s) in local county/knowledge records held as note (nothing merged).`,
		};
	}

	return {
		source: 'knowledge_sqlite',
		status: 'not_found',
		fieldsUpdated: [],
		countsAdded: counts,
	};
}

type BryanUccRow = {
	instrument?: string;
	type?: string;
	recorded?: string;
	grantor?: string;
	grantee?: string;
	title?: string;
	document_id?: string;
};

let cachedBryanUcc: BryanUccRow[] | null = null;
function loadBryanUccFilings(): BryanUccRow[] {
	if (cachedBryanUcc) return cachedBryanUcc;
	const p = path.join(process.cwd(), '.data', 'bryan-business', 'bryan_ucc_filings_2026.json');
	if (!fs.existsSync(p)) {
		cachedBryanUcc = [];
		return cachedBryanUcc;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { filings?: BryanUccRow[] };
		cachedBryanUcc = Array.isArray(raw.filings) ? raw.filings : [];
	} catch {
		cachedBryanUcc = [];
	}
	return cachedBryanUcc;
}

function enrichFromBryanUcc(ctx: ProfileIdentityContext): EnrichSourceOutcome {
	const counts = emptyCounts();
	const filings = loadBryanUccFilings();
	if (!filings.length) {
		return { source: 'bryan_ucc', status: 'skipped', fieldsUpdated: [], countsAdded: counts };
	}

	const validated: Array<{ row: BryanUccRow; evalRes: ReturnType<typeof evaluateIdentityMatch> }> = [];
	const nameOnly: Array<{ row: BryanUccRow; evalRes: ReturnType<typeof evaluateIdentityMatch> }> = [];

	for (const row of filings) {
		const parties = [
			...String(row.grantor || '').split(';'),
			...String(row.grantee || '').split(';'),
		]
			.map((s) => s.trim())
			.filter((s) => s.length >= 3);

		for (const party of parties) {
			const recDate = normalizeIsoDate(row.recorded).date;
			const evalRes = evaluateIdentityMatch(ctx, {
				candidateName: party,
				candidateLocations: ['Bryan County, OK', 'Durant, OK', 'Oklahoma'],
				candidateFirms: String(row.grantor || '')
					.split(';')
					.map((s) => s.trim())
					.filter(Boolean),
				candidateEventDates: recDate ? [recDate] : [],
				candidateText: `Bryan County Oklahoma UCC filing ${row.instrument || ''} ${row.type || ''} Grantor: ${row.grantor || ''} Grantee: ${row.grantee || ''} Recorded: ${row.recorded || ''}`,
			});
			if (evalRes.decision === 'validated_merge') {
				validated.push({ row, evalRes });
				break;
			} else if (evalRes.decision === 'name_only_note') {
				nameOnly.push({ row, evalRes });
				break;
			}
		}
	}

	const fieldsUpdated: string[] = [];
	withProfilesTransaction((tx) => {
		for (const v of validated.slice(0, 4)) {
			const recDate = normalizeIsoDate(v.row.recorded).date;
			const srId = upsertSourceRecord(
				{
					corpus: 'bryan-ucc',
					sourceRef: `bryan:ucc:${v.row.instrument || v.row.document_id || 'unknown'}`,
					title: `${v.row.title || v.row.instrument || 'Bryan UCC Filing'}`,
					publishedDate: recDate,
					excerpt: `Grantor: ${v.row.grantor || ''} | Grantee: ${v.row.grantee || ''}`,
				},
				tx,
			);
			upsertTimelineEntry(
				{
					profileId: ctx.profileId,
					eventDate: recDate,
					title: `[Bryan County UCC] ${v.row.title || v.row.instrument || 'UCC Filing'}`,
					summary: `Grantor: ${v.row.grantor || '—'} · Grantee: ${v.row.grantee || '—'}`,
					angle: 'land_records',
					entryKind: 'filing',
					geoKey: 'us:ok:county:bryan',
					geoLabel: 'Bryan County, OK',
					confidence: v.evalRes.score,
					sourceCorpus: 'bryan-ucc',
					sourceRecordId: srId,
					dedupeHint: `bryan-ucc:${v.row.instrument || v.row.document_id}`,
				},
				tx,
			);
			counts.timelineEntries += 1;
		}
		if (counts.timelineEntries > 0) fieldsUpdated.push('timeline');

		if (nameOnly.length > 0) {
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['possible_match_name_only', ctx.profileId, 'bryan-ucc']),
					alignmentKind: 'possible_match_name_only',
					leftProfileId: ctx.profileId,
					rightProfileId: null,
					score: nameOnly[0].evalRes.score,
					cautionTier: 'observation',
					rationale: `Name-only match in Bryan County OK UCC filings (${nameOnly.length} filing(s)) with no corroborating Bryan County/Oklahoma address or shared firm. NOT merged — verify before linking.`,
					evidence: nameOnly.slice(0, 5).map((n) => ({
						corpus: 'bryan-ucc',
						label: String(n.row.title || n.row.instrument || 'Bryan UCC'),
						date: normalizeIsoDate(n.row.recorded).date,
						snippet: `Grantor: ${n.row.grantor || ''} | Grantee: ${n.row.grantee || ''}`,
					})),
				},
				tx,
			);
			counts.notes += 1;
		}
	});

	if (validated.length > 0) {
		return {
			source: 'bryan_ucc',
			status: 'merged',
			candidateTitle: String(validated[0].row.title || validated[0].row.instrument || ''),
			evaluation: validated[0].evalRes,
			fieldsUpdated,
			countsAdded: counts,
		};
	}
	if (nameOnly.length > 0) {
		return {
			source: 'bryan_ucc',
			status: 'name_only_note',
			candidateTitle: String(nameOnly[0].row.title || nameOnly[0].row.instrument || ''),
			evaluation: nameOnly[0].evalRes,
			fieldsUpdated: [],
			countsAdded: counts,
		};
	}
	return { source: 'bryan_ucc', status: 'not_found', fieldsUpdated: [], countsAdded: counts };
}

/**
 * Research and enrich a single captured entity profile across local offline Wikipedia,
 * FINRA BrokerCheck (if CRD present), local knowledge.sqlite (county deeds / Research Drive),
 * and Bryan County UCC filings — strictly enforcing identity validation before merging any field.
 */
export async function enrichProfile(
	idOrSlug: string,
	opts: EnrichProfileOptions = {},
): Promise<EnrichProfileReport | null> {
	const t0 = Date.now();
	const detail = getProfileDetail(idOrSlug);
	if (!detail) return null;

	const kiwixBaseUrl = opts.kiwixBaseUrl || DEFAULT_KIWIX_BASE;
	const outcomes: EnrichSourceOutcome[] = [];

	// Step 1: FINRA Visualizer (read-only local-first 24h cache) + BrokerCheck FIRST if profile has a FINRA CRD
	if (opts.includeBrokercheck !== false) {
		const ctx1 = buildProfileIdentityContext(detail);
		const crdIdent = ctx1.identifiers.find((i) => i.scheme === 'finra_crd');
		if (ctx1.profileType === 'person' && crdIdent) {
			const vis = await ingestIndividualFromVisualizer(crdIdent.value, {
				profileIdOverride: ctx1.profileId,
			});
			if (vis.found) {
				outcomes.push({
					source: 'brokercheck',
					status: 'merged',
					candidateTitle: vis.name || ctx1.name,
					candidateUrl: vis.sourceUrl,
					fieldsUpdated: vis.linksUpdated > 0 ? ['employment_history', 'locations', 'metadata'] : ['metadata'],
					countsAdded: {
						aliases: 0,
						identifiers: 0,
						locations: vis.locationsAdded,
						employments: vis.employmentsCount,
						links: vis.linksUpdated,
						timelineEntries: 0,
						notes: 0,
					},
					note: `Synced ${vis.currentCount} current & ${vis.previousCount} previous employments from read-only FINRA visualizer (${vis.fromCache ? 'local 24h cache' : 'live refresh'}).`,
				});
			} else {
				outcomes.push(await enrichFromBrokercheck(ctx1));
			}
		} else if (ctx1.profileType === 'firm' && crdIdent) {
			outcomes.push(await enrichFirmFromFinraConnections(ctx1));
		}
	}

	// Reload context after BrokerCheck in case new employment/locations were validated & added
	const detailAfterBc = getProfileDetail(detail.profile.id) || detail;
	const ctxAfterBc = buildProfileIdentityContext(detailAfterBc);

	// Step 2: Local Offline English Wikipedia (kiwix-serve)
	if (opts.includeWikipedia !== false) {
		outcomes.push(await enrichFromLocalWikipedia(ctxAfterBc, kiwixBaseUrl));
	}

	// Reload context after Wikipedia in case new validated locations/employers/military bases were added
	const detailAfterWiki = getProfileDetail(detail.profile.id) || detailAfterBc;
	const ctxAfterWiki = buildProfileIdentityContext(detailAfterWiki);

	// Step 3: Local knowledge.sqlite (County Deeds + Research Drive)
	if (opts.includeKnowledge !== false) {
		outcomes.push(enrichFromKnowledgeSqlite(ctxAfterWiki));
	}

	// Step 4: Bryan County UCC filings
	if (opts.includeBryanUcc !== false) {
		outcomes.push(enrichFromBryanUcc(ctxAfterWiki));
	}

	const totalsAdded = emptyCounts();
	const fieldsSet = new Set<string>();
	let validatedSources = 0;
	let heldNameOnlyNotes = 0;

	for (const o of outcomes) {
		if (o.status === 'merged') validatedSources += 1;
		if (o.status === 'name_only_note') heldNameOnlyNotes += 1;
		for (const f of o.fieldsUpdated) fieldsSet.add(f);
		totalsAdded.aliases += o.countsAdded.aliases;
		totalsAdded.identifiers += o.countsAdded.identifiers;
		totalsAdded.locations += o.countsAdded.locations;
		totalsAdded.employments += o.countsAdded.employments;
		totalsAdded.links += o.countsAdded.links;
		totalsAdded.timelineEntries += o.countsAdded.timelineEntries;
		totalsAdded.notes += o.countsAdded.notes;
	}

	return {
		profileId: detail.profile.id,
		profileSlug: detail.profile.slug,
		profileName: detail.profile.name,
		profileType: detail.profile.profileType,
		validatedSources,
		heldNameOnlyNotes,
		fieldsUpdated: [...fieldsSet],
		totalsAdded,
		outcomes,
		durationMs: Date.now() - t0,
	};
}

/**
 * Batch-enrich captured profiles prioritized by pinned status, link count, and missing details.
 */
export async function enrichBatchProfiles(
	opts: EnrichBatchOptions = {},
): Promise<EnrichBatchReport> {
	const t0 = Date.now();
	const db = getProfilesDb();
	const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit ?? 30))));

	const where: string[] = ['length(p.normalized_name) >= 4'];
	const params: Array<string | number> = [];

	if (opts.profileType && opts.profileType !== 'all') {
		where.push('p.profile_type = ?');
		params.push(opts.profileType);
	}
	if (opts.pinnedOnly) {
		where.push(`p.status = 'pinned'`);
	}
	if (opts.onlyMissingSummaryOrDetails) {
		where.push(`(length(trim(COALESCE(p.summary, ''))) < 120 OR p.start_date IS NULL)`);
	}

	const rows = db
		.prepare(
			`SELECT p.id, p.slug, p.name, p.profile_type
       FROM profiles p
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE p.status WHEN 'pinned' THEN 0 ELSE 1 END,
         (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) DESC,
         (SELECT COUNT(*) FROM timeline_entries te WHERE te.profile_id = p.id) DESC,
         p.updated_at DESC
       LIMIT ?`,
		)
		.all(...params, limit) as Array<{ id: string; slug: string; name: string; profile_type: ProfileType }>;

	const report: EnrichBatchReport = {
		processed: 0,
		validatedEnrichments: 0,
		nameOnlyNotesRecorded: 0,
		totalFieldsUpdated: 0,
		totalEmploymentsAdded: 0,
		totalLocationsAdded: 0,
		totalTimelineAdded: 0,
		results: [],
		durationMs: 0,
	};

	for (const r of rows) {
		const res = await enrichProfile(r.id, opts);
		if (!res) continue;
		report.processed += 1;
		if (res.validatedSources > 0) report.validatedEnrichments += 1;
		report.nameOnlyNotesRecorded += res.heldNameOnlyNotes;
		report.totalFieldsUpdated += res.fieldsUpdated.length;
		report.totalEmploymentsAdded += res.totalsAdded.employments;
		report.totalLocationsAdded += res.totalsAdded.locations;
		report.totalTimelineAdded += res.totalsAdded.timelineEntries;
		report.results.push({
			slug: res.profileSlug,
			name: res.profileName,
			profileType: res.profileType,
			validatedSources: res.validatedSources,
			heldNameOnlyNotes: res.heldNameOnlyNotes,
			fieldsUpdated: res.fieldsUpdated,
		});
	}

	report.durationMs = Date.now() - t0;
	return report;
}
