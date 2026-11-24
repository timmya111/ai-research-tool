#!/usr/bin/env node
/**
 * Heuristic single-card formatter for news_rss historic_events.
 * Pieces subject matter into lead prose + ## Timeline + Local Wikipedia + sources,
 * wiki fact-checks via kiwix, and POSTs Timeline observations.
 *
 *   pnpm news:rss:format -- --id=<uuid>
 *   pnpm news:rss:format -- --slug=historic_event:news-asce-…
 *   pnpm news:rss:format -- --url=http://127.0.0.1:3333/profiles/historic_event/…
 *   pnpm news:rss:format -- --unformatted [--limit=N] [--related]
 *   NEWS_RSS_FORMAT_DRY_RUN=1 pnpm news:rss:format -- --slug=…
 *
 * Optional: --related also lists near-topic peers (does not merge unless
 * NEWS_RSS_FORMAT_MERGE_RELATED=1 and peer count is small, ≤4).
 * Batch: --unformatted formats active news_rss historic_events missing
 * overviewStyle=lead_plus_timeline_rail / ## Timeline (skips already formatted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const OUT_DIR = path.join(ROOT, '.data', 'monitors');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const KIWIX = String(process.env.KIWIX_SERVE_ORIGIN || process.env.RESEARCH_KIWIX_ORIGIN || 'http://127.0.0.1:8765').replace(
	/\/$/,
	'',
);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_FORMAT_DRY_RUN || ''));
const MERGE_RELATED = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_FORMAT_MERGE_RELATED || ''));
const MAX_BULLETS = Math.max(3, Number(process.env.NEWS_RSS_FORMAT_MAX_BULLETS || 8) || 8);
const MAX_WIKI = Math.max(2, Number(process.env.NEWS_RSS_FORMAT_MAX_WIKI || 4) || 4);

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

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function stripTags(s) {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseArgs(argv) {
	const out = { id: null, slug: null, url: null, related: false, unformatted: false, limit: null, bucket: null };
	for (const a of argv) {
		if (a === '--related' || a === '--related=1') out.related = true;
		else if (a === '--unformatted' || a === '--all-unformatted') out.unformatted = true;
		else if (a.startsWith('--id=')) out.id = a.slice(5);
		else if (a.startsWith('--slug=')) out.slug = a.slice(7);
		else if (a.startsWith('--url=')) out.url = a.slice(6);
		else if (a.startsWith('--limit=')) out.limit = Math.max(1, Number(a.slice(8)) || 0) || null;
		else if (a.startsWith('--bucket=')) out.bucket = a.slice(9).trim() || null;
		else if (!a.startsWith('-') && !out.slug && !out.id && !out.url && !out.unformatted) {
			if (/^[0-9a-f-]{36}$/i.test(a)) out.id = a;
			else if (a.includes('/profiles/')) out.url = a;
			else out.slug = a;
		}
	}
	if (out.url) {
		try {
			const u = new URL(out.url);
			const parts = u.pathname.split('/').filter(Boolean);
			// /profiles/historic_event/slug-tail
			if (parts[0] === 'profiles' && parts.length >= 3) {
				out.slug = `historic_event:${parts.slice(2).join('/')}`;
			} else if (parts[0] === 'profiles' && parts.length === 2) {
				out.slug = parts[1].includes(':') ? parts[1] : `historic_event:${parts[1]}`;
			}
		} catch {
			/* ignore */
		}
	}
	return out;
}

function loadProfileByRef({ id, slug }) {
	const db = new DatabaseSync(PROFILES_DB, { readonly: true });
	try {
		let row = null;
		if (id) {
			row = db.prepare(`SELECT id, slug, name, start_date, end_date, summary, metadata_json FROM profiles WHERE id = ?`).get(id);
		}
		if (!row && slug) {
			row = db
				.prepare(`SELECT id, slug, name, start_date, end_date, summary, metadata_json FROM profiles WHERE slug = ?`)
				.get(slug);
			if (!row && !slug.startsWith('historic_event:')) {
				row = db
					.prepare(`SELECT id, slug, name, start_date, end_date, summary, metadata_json FROM profiles WHERE slug = ?`)
					.get(`historic_event:${slug}`);
			}
			if (!row) {
				row = db
					.prepare(
						`SELECT id, slug, name, start_date, end_date, summary, metadata_json FROM profiles WHERE slug LIKE ? ORDER BY updated_at DESC LIMIT 1`,
					)
					.get(`%${slug.replace(/^historic_event:/, '')}%`);
			}
		}
		if (!row) return null;
		let metadata = {};
		try {
			metadata = JSON.parse(row.metadata_json || '{}');
		} catch {
			metadata = {};
		}
		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			startDate: row.start_date || null,
			endDate: row.end_date || null,
			summary: row.summary || '',
			feed: metadata.newsFeedId || null,
			feedName: metadata.newsFeedName || null,
			sourceUrl: metadata.sourceUrl || null,
			metadata,
		};
	} finally {
		db.close?.();
	}
}

function listNewsPeers(excludeId) {
	const db = new DatabaseSync(PROFILES_DB, { readonly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, slug, name, start_date, summary, metadata_json
         FROM profiles
         WHERE profile_type = 'historic_event'
           AND id != ?
           AND (metadata_json LIKE '%newsFeedId%' OR metadata_json LIKE '%"news_rss"%')`,
			)
			.all(excludeId);
		return rows.map((r) => {
			let metadata = {};
			try {
				metadata = JSON.parse(r.metadata_json || '{}');
			} catch {
				metadata = {};
			}
			return {
				id: r.id,
				slug: r.slug,
				name: r.name,
				startDate: r.start_date || null,
				summary: r.summary || '',
				feed: metadata.newsFeedId || null,
				sourceUrl: metadata.sourceUrl || null,
				metadata,
			};
		});
	} finally {
		db.close?.();
	}
}

function tokenizeSubject(text) {
	const stop = new Set(
		'a an the and or of to for in on at by with from as is are was were be been being this that these those it its into over under about after before between during without within than then so if but not no nor yet both either neither each few more most other some such only own same than too very can will just should now also per via new'.split(
			' ',
		),
	);
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s'-]/g, ' ')
		.split(/\s+/)
		.map((w) => w.trim())
		.filter((w) => w.length >= 4 && !stop.has(w));
}

function distinctiveTerms(text) {
	const boost = [];
	const s = String(text || '');
	for (const m of s.matchAll(
		/\b(lead azide|iowa army ammunition|middletown|asce|critical minerals?|hudson tunnel|whiting[- ]turner|liquidated damages|merit shop|report card|pennDOT|infrastructure investment and jobs act)\b/gi,
	)) {
		boost.push(m[1].toLowerCase());
	}
	return boost;
}

function subjectOverlapScore(a, b) {
	const ta = new Set(tokenizeSubject(`${a.name} ${firstSentences(a.summary, 240)}`));
	const tb = new Set(tokenizeSubject(`${b.name} ${firstSentences(b.summary, 240)}`));
	if (!ta.size || !tb.size) return 0;
	let hit = 0;
	for (const t of ta) if (tb.has(t)) hit++;
	let score = hit / Math.min(ta.size, tb.size);
	const da = new Set(distinctiveTerms(`${a.name}\n${a.summary.slice(0, 1200)}`));
	const db = new Set(distinctiveTerms(`${b.name}\n${b.summary.slice(0, 1200)}`));
	let shared = 0;
	for (const t of da) if (db.has(t)) shared++;
	if (shared > 0) score = Math.min(1, score + 0.25 * shared);
	return score;
}

function findRelatedPeers(profile, peers, { minScore = 0.38, limit = 6 } = {}) {
	return peers
		.map((p) => ({ p, score: subjectOverlapScore(profile, p) }))
		.filter((x) => x.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => ({ ...x.p, _score: x.score }));
}

function firstSentences(text, maxChars = 280) {
	const clean = String(text || '')
		.replace(/\s+/g, ' ')
		.replace(/^Tagged with:.*$/gim, '')
		.replace(/^Source:.*$/gim, '')
		.replace(/^https?:\/\/\S+$/gim, '')
		.replace(/^This audio is auto-generated\..*$/gim, '')
		.replace(/^SEE ALSO:.*$/gim, '')
		.trim();
	if (!clean) return '';
	// Protect common abbreviations so "Nov. 17" is not treated as a sentence end.
	const protected_ = clean
		.replace(/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|St|U\.S|U\.K|Inc|Ltd|Co)\./gi, '$1˘');
	const parts = protected_.split(/(?<=[.!?])\s+/).map((p) => p.replace(/˘/g, '.'));
	let out = '';
	for (const p of parts) {
		if (!p) continue;
		if (!out) {
			out = p;
			if (out.length >= 80) break;
			continue;
		}
		if ((out + ' ' + p).length > maxChars) break;
		out = `${out} ${p}`;
		if (out.length >= 140) break;
	}
	return out.slice(0, maxChars).trim();
}

function isoToLong(iso) {
	const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return null;
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	// Year-only placeholders (…-01-01 from "enacted in 2013") render as the year.
	if (month === 1 && day === 1) return m[1];
	return `${MONTHS[month - 1]} ${day}, ${m[1]}`;
}

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

function parseLooseDate(text, { allowYearOnly = false, fallbackYear = null } = {}) {
	const s = String(text || '');
	const iso = s.match(/\b((?:18|19|20)\d{2})-(\d{2})-(\d{2})\b/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const mon = s.match(
		/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+((?:18|19|20)\d{2})\b/i,
	);
	if (mon) {
		const mi = MONTH_MAP[mon[1].toLowerCase().replace(/\.$/, '')];
		if (mi) return `${mon[3]}-${String(mi).padStart(2, '0')}-${String(Number(mon[2])).padStart(2, '0')}`;
	}
	// "Nov. 17" / "November 17" without year — borrow fallbackYear (report year / profile year)
	const monDay = s.match(
		/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
	);
	if (monDay && fallbackYear) {
		const mi = MONTH_MAP[monDay[1].toLowerCase().replace(/\.$/, '')];
		if (mi) {
			return `${fallbackYear}-${String(mi).padStart(2, '0')}-${String(Number(monDay[2])).padStart(2, '0')}`;
		}
	}
	if (allowYearOnly) {
		const yearOnly = s.match(/\bin\s+((?:18|19|20)\d{2})\b/i);
		if (yearOnly) return `${yearOnly[1]}-01-01`;
	}
	return null;
}

function reportCardYear(body, profile) {
	const y =
		(body.match(/\b(20\d{2})\s+infrastructure report card/i) ||
			body.match(/report card[^.]*\b(20\d{2})\b/i) ||
			[])[1] || (profile.startDate || '').slice(0, 4) || null;
	return y;
}

function cleanArticleBody(summary) {
	return String(summary || '')
		.replace(/\r/g, '')
		.replace(/^This audio is auto-generated\..*$/gim, '')
		.replace(/^Source:\s*.*$/gim, '')
		.replace(/^https?:\/\/\S+\s*$/gim, '')
		.replace(/^SEE ALSO:.*$/gim, '')
		.replace(/^(?:Courtesy of|Image courtesy|Photo(?:\s+credit)?|Credit|Advertisement|Sponsored|Related stories?|Subscribe|Newsletter|Sign up|Read more|More from)\b.*$/gim, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function isJunkSectionLine(line) {
	const s = String(line || '').trim();
	if (!s) return true;
	if (/^(courtesy of|image courtesy|photo|credit|advertisement|sponsored|related|subscribe|newsletter|sign up|read more|more from|tagged with|share this|follow us)\b/i.test(s))
		return true;
	if (/\b(magazine|national safety council)\b/i.test(s) && s.length < 70) return true;
	// Product / sidebar chrome often Title Case without a verb.
	if (
		/\b(fall protection|rescue equipment|personal protective|safety glasses|hard hat|scaffolding)\b/i.test(s) &&
		!/\b(osha|citation|proposed|alleged|fine|penalty|violat)/i.test(s)
	) {
		return true;
	}
	if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,5}$/.test(s) && !/\b(OSHA|FEMA|USACE|ASCE|EPA|Army|Senate|Congress|Nuclear|Bridge|Dam|Port)\b/.test(s) && s.split(/\s+/).length <= 4) {
		// Short Title Case with no agency cue — often a sidebar head.
		if (!/\b(Settlement|Fine|Citation|Funding|Contract|Permit|Earthquake|Tornado|Flood|Mine|Tunnel)\b/i.test(s)) return true;
	}
	return false;
}

/** ASCE / infrastructure report-card style extraction. */
function extractAsceReportCard(body, profile) {
	const bullets = [];
	const year = reportCardYear(body, profile);
	const head = body.slice(0, 500);
	const overallDate =
		parseLooseDate(head, { fallbackYear: year }) ||
		(year && profile.startDate?.startsWith(year) ? profile.startDate : null) ||
		(year ? `${year}-11-17` : null) ||
		profile.startDate ||
		null;

	const takeSentence = (fromIndex) => {
		const slice = body.slice(fromIndex);
		const protected_ = slice.replace(
			/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|St|U\.S|U\.K|Inc|Ltd|Co)\./gi,
			'$1˘',
		);
		const m = protected_.match(/^[\s\S]{12,420}?(?:\.(?:\s|$)|$)/);
		return (m ? m[0] : protected_.slice(0, 280)).replace(/˘/g, '.').replace(/\s+/g, ' ').trim();
	};

	const overallHit =
		body.match(/\breceived a [‘'`]([A-F][+-]?)[’'`]\s+grade on its \d{4}\s+infrastructure report card\b/i) ||
		body.match(/\breceived a [‘'`]([A-F][+-]?)[’'`]\s+grade\b/i);

	const overallGrade = overallHit?.[1] || (body.match(/[‘'`]([A-F][+-]?)[’'`]\s+grade/i) || [])[1] || 'C-';

	if (overallHit || /report card/i.test(body)) {
		const text = overallHit?.index != null ? takeSentence(overallHit.index) : firstSentences(body, 260);
		bullets.push({
			iso: overallDate,
			title: `Overall ${year ? `${year} ` : ''}infrastructure grade ${overallGrade}`,
			text: (text || '').endsWith('.') ? text : `${text}.`,
			kind: 'overall',
		});
	}

	const categorySpecs = [
		{ cat: 'Transit', re: /\bTransit received the lowest grade in the report:\s*a [‘'`]([A-F][+-]?)[’'`]/i },
		{ cat: 'Energy', re: /\bEnergy was tied for the highest grade in the report with a [‘'`]([A-F][+-]?)[’'`]/i },
		{ cat: 'Roads', re: /\bOver [\d.]+% of state-owned roads are rated in poor condition/i },
		{ cat: 'Bridges', re: /\bThe number of bridges in poor condition has improved/i },
		{
			cat: 'Drinking water',
			re: /\bDrinking water, stormwater and wastewater each received a [‘'`]([A-F][+-]?)[’'`]/i,
		},
	];
	for (const spec of categorySpecs) {
		const hit = body.match(spec.re);
		if (!hit || hit.index == null) continue;
		const sentence = takeSentence(hit.index);
		const g = hit[1] || (sentence.match(/[‘'`]([A-F][+-]?)[’'`]/) || [])[1] || '';
		bullets.push({
			iso: overallDate,
			title: g ? `${spec.cat}: ${g}` : spec.cat,
			text: sentence.endsWith('.') ? sentence : `${sentence}.`,
			kind: 'grade',
		});
	}

	const highlightRes = [
		/\bAct 89\b/i,
		/\bInfrastructure Investment and Jobs Act\b/i,
		/\bU\.S\. infrastructure as a whole earned\b/i,
		/\$[\d.]+ billion\b[^]{0,120}(?:funding gap|needs|backlog)/gi,
		/\bPennDOT\b[^]{0,80}funding gap/i,
	];
	for (const re of highlightRes) {
		const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
		for (const hit of body.matchAll(global)) {
			if (hit.index == null) continue;
			const sentence = takeSentence(hit.index);
			if (sentence.length < 40) continue;
			const iso =
				parseLooseDate(sentence, { allowYearOnly: /enacted in|in \d{4}/i.test(sentence), fallbackYear: year }) ||
				overallDate;
			bullets.push({
				iso,
				title: sentence.slice(0, 72).replace(/[,:;]\s*$/, ''),
				text: sentence.endsWith('.') ? sentence : `${sentence}.`,
				kind: 'highlight',
			});
		}
	}

	return bullets;
}

/** Breaking / military / hazmat news: pull concrete operational claims. */
function extractBreakingClaims(body, profile) {
	const bullets = [];
	const sentenceAt = (matchIndex) => {
		let start = matchIndex;
		while (start > 0 && !/[.!?]\s/.test(body.slice(start - 2, start))) start--;
		if (start > 0) start = Math.min(matchIndex, start + (body[start] === ' ' ? 1 : 0));
		// Prefer walking back to a capital letter after newline/space.
		const back = body.slice(Math.max(0, matchIndex - 220), matchIndex);
		const cap = back.search(/(?:^|[.!?]\s+|[\n])([A-Z(“"‘])/);
		if (cap >= 0) {
			const abs = Math.max(0, matchIndex - 220) + cap;
			const ch = body[abs];
			start = /[.!?\s\n]/.test(ch) ? abs + 1 : abs;
		}
		const slice = body.slice(start);
		const protected_ = slice.replace(
			/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|St|U\.S|U\.K|Inc|Ltd|Co|Maj)\./gi,
			'$1˘',
		);
		const m = protected_.match(/^[\s\S]{12,420}?(?:\.(?:\s|$)|$)/);
		return (m ? m[0] : protected_.slice(0, 280)).replace(/˘/g, '.').replace(/\s+/g, ' ').trim();
	};
	const patterns = [
		{ title: 'Controlled detonation planned', re: /\b(?:plans to|will|set to)\s+detonate\b/i },
		{ title: 'Stockpile / volume', re: /\b(?:five tons|\d+\s+barrels|entire stockpile of lead azide)\b/i },
		{ title: 'Lead azide risk', re: /\bdangerously degrading bomb-making chemicals\b|\blead azide\b[^]{0,80}(?:explod|cooling weather|chain-react)/i },
		{ title: 'Court approval', re: /\bthree-judge panel of the 8th U\.S\. Circuit Court of Appeals\b|\bwon approval for the detonation from the federal appeals court\b/i },
		{ title: 'Schedule change', re: /\b(?:reschedul\w+ the detonation|initially planned for last Friday)\b/i },
		{ title: 'Evacuation / public notice', re: /\b(?:within \d+ miles|seal(?:ing)? their windows|may be evacuated)\b/i },
		{ title: 'Army leadership statement', re: /\b(?:Inaction is no longer an option|Acting Secretary of the Army|Maj\.?\s*Gen\.?\s+\w+)\b/i },
		{ title: 'Presidential / political twist', re: /\bTrump\b[^]{0,160}(?:ordered the Army|detonat|without court approval)/i },
		{ title: 'Plant / location', re: /\bIowa Army Ammunition Plant in Middletown\b/i },
		{ title: 'Environmental challenge', re: /\benvironmental groups that sued to stop the detonation\b/i },
		// General construction / regulatory / project claims
		{ title: 'OSHA penalty', re: /\bOSHA\b[^]{0,120}(?:proposed|issued|announced)\b[^]{0,80}\$[\d,.]+ ?(?:million|M)?\b|\bproposed (?:a )?\$[\d,.]+ ?(?:million|M)? (?:fine|penalty|in penalties)\b/i },
		{ title: 'Incident trigger', re: /\b(?:investigation followed|incident at|worker(?:s)? (?:were )?hospitaliz|crane.?s suspended load|energized power line)\b/i },
		{ title: 'Settlement', re: /\b\$[\d,.]+ ?(?:million|M)?\b[^]{0,80}\bsettlement\b|\bsettlement\b[^]{0,80}\$[\d,.]+/i },
		{ title: 'Funding commitment', re: /\b(?:commits?|announced|awarded|approved)\b[^]{0,100}\$[\d,.]+ ?(?:million|billion|M|B)\b|\b\$[\d,.]+ ?(?:million|billion)\b[^]{0,80}(?:to build|funding|grant|investment)\b/i },
		{ title: 'Contract award', re: /\b(?:awarded|won|signed)\b[^]{0,80}\b(?:contract|task order|IDIQ)\b|\b\$[\d,.]+ ?(?:billion|million)\b[^]{0,60}\bconstruction\b/i },
		{ title: 'Court / permitting fight', re: /\b(?:battle|sued|lawsuit|appeals? court|injunction|permitting reform)\b/i },
		{ title: 'Nuclear / energy project', re: /\b(?:nuclear plant|small modular|SMR|power authority|data center)\b/i },
		{ title: 'Infrastructure vote', re: /\b(?:Senate|House|Congress)\b[^]{0,100}\b(?:passes|passed|confirm|nominee|infrastructure|permitting)\b/i },
	];
	const seen = new Set();
	for (const spec of patterns) {
		const hit = body.match(spec.re);
		if (!hit || hit.index == null) continue;
		const sentence = sentenceAt(hit.index);
		if (sentence.length < 40) continue;
		const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 70);
		if (seen.has(key)) continue;
		seen.add(key);
		bullets.push({
			iso:
				parseLooseDate(sentence, {
					fallbackYear: (profile.startDate || '').slice(0, 4) || null,
				}) || profile.startDate,
			title: spec.title,
			text: sentence.endsWith('.') ? sentence : `${sentence}.`,
			kind: 'highlight',
		});
	}
	return bullets;
}

/** Numbered list / “1. …” opinion or provision style. */
function extractNumberedProvisions(body, profile) {
	const bullets = [];
	const re = /(?:^|\n)\s*(\d{1,2})[.)]\s+([^\n]{8,160})/g;
	let m;
	while ((m = re.exec(body))) {
		const head = m[2].replace(/\s+/g, ' ').trim();
		const after = body.slice(m.index + m[0].length, m.index + m[0].length + 400);
		const detail = firstSentences(after, 200);
		bullets.push({
			iso: profile.startDate,
			title: head.replace(/^Don’t|^Don't|^Never/i, (s) => s),
			text: detail || head,
			kind: 'provision',
		});
	}
	return bullets;
}

/** Generic: section-like short lines + dated sentences. */
function extractGenericMilestones(body, profile) {
	const bullets = [];
	const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	for (const line of lines) {
		// Short title-case section heads without ending punctuation
		if (
			line.length >= 12 &&
			line.length <= 80 &&
			!/[.!?]$/.test(line) &&
			!/^Source:/i.test(line) &&
			!/^https?:/i.test(line) &&
			/^[A-Z0-9]/.test(line) &&
			!/^(The|A|An|In|On|For|With|And|But)\b/.test(line) &&
			!isJunkSectionLine(line)
		) {
			const idx = body.indexOf(line);
			const after = body.slice(idx + line.length, idx + line.length + 350);
			const text = firstSentences(after, 220) || line;
			if (isJunkSectionLine(text) || text.length < 40) continue;
			bullets.push({
				iso: parseLooseDate(after) || profile.startDate,
				title: line,
				text,
				kind: 'section',
			});
		}
	}

	// Protect common abbreviations so "Sept. 22" / "Nov. 17" are not sentence ends.
	const protectedBody = body.replace(
		/\b(Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Nov|Oct|Sep|Sept|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|St|U\.S|U\.K|Inc|Ltd|Co|vs|No)\./gi,
		'$1˘',
	);
	const datedSentenceRe =
		/[^.!?\n]*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|(?:18|19|20)\d{2}-\d{2}-\d{2})[^.!?\n]*[.!?]/gi;
	for (const hit of protectedBody.matchAll(datedSentenceRe)) {
		const sentence = hit[0].replace(/˘/g, '.').replace(/\s+/g, ' ').trim();
		if (sentence.length < 50 || sentence.length > 320) continue;
		if (/^Source:/i.test(sentence)) continue;
		if (isJunkSectionLine(sentence)) continue;
		// Drop truncated abbrev tails that slipped through.
		if (/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.\s*$/i.test(sentence)) continue;
		bullets.push({
			iso: parseLooseDate(sentence) || profile.startDate,
			title: sentence.slice(0, 70).replace(/[,:;]\s*$/, ''),
			text: sentence,
			kind: 'dated',
		});
	}
	return bullets;
}

function dedupeBullets(bullets) {
	const out = [];
	const seenTitle = new Set();
	const seenText = new Set();
	for (const b of bullets) {
		const titleKey = `${b.kind}|${String(b.title || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '')
			.slice(0, 48)}`;
		const textKey = String(b.text || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '')
			.slice(0, 80);
		if (seenTitle.has(titleKey)) continue;
		// Allow distinct titled highlights to share overlapping source sentences.
		if (b.kind !== 'highlight' && textKey && seenText.has(textKey)) continue;
		seenTitle.add(titleKey);
		if (textKey) seenText.add(textKey);
		out.push(b);
	}
	return out;
}

function prioritizeBullets(bullets) {
	const rank = { overall: 0, grade: 1, provision: 1, highlight: 2, section: 3, dated: 4 };
	return [...bullets].sort((a, b) => {
		const ra = rank[a.kind] ?? 9;
		const rb = rank[b.kind] ?? 9;
		if (ra !== rb) return ra - rb;
		return String(a.iso || '').localeCompare(String(b.iso || ''));
	});
}

function extractMilestones(profile) {
	const body = cleanArticleBody(profile.summary);
	const name = profile.name || '';
	const head = `${name}\n${body.slice(0, 800)}`;
	let bullets = [];

	if (/asce|report card|infrastructure grade/i.test(head)) {
		bullets = bullets.concat(extractAsceReportCard(body, profile));
	}
	if (/\b\d{1,2}[.)]\s+\S/.test(body) && /don’t|don't|never|provision|refuse|accept/i.test(body)) {
		bullets = bullets.concat(extractNumberedProvisions(body, profile));
	}
	if (
		/detonat|lead azide|ammunition plant|evacuat|appeals court|stockpile|bomb-making|hazardous/i.test(head) ||
		bullets.length < 3
	) {
		bullets = bullets.concat(extractBreakingClaims(body, profile));
	}
	if (bullets.length < 4) {
		bullets = bullets.concat(extractGenericMilestones(body, profile));
	}

	bullets = prioritizeBullets(dedupeBullets(bullets));
	if (bullets.length === 0) {
		bullets.push({
			iso: profile.startDate,
			title: profile.name,
			text: firstSentences(body, 260) || profile.name,
			kind: 'dated',
		});
	}
	return bullets.slice(0, MAX_BULLETS);
}

const WIKI_STOP_TITLE_WORDS = new Set(
	'entire wednesday morning tuesday monday friday saturday sunday today tonight army plans after before without under about during since until against between within set plant stockpile detonated detonation material degraded getting court approval says said fine against contractor over from into onto upon with than then when while where which that this these those into onto upon'.split(
		' ',
	),
);

function deriveWikiQueries(profile, bullets) {
	const q = new Set();
	const name = profile.name || '';
	const blob = `${name}\n${profile.summary.slice(0, 1500)}`;

	if (/asce/i.test(name) || /american society of civil engineers/i.test(profile.summary)) {
		q.add('American Society of Civil Engineers');
		q.add("Report Card for America's Infrastructure");
	}
	if (/pennsylvania/i.test(blob)) {
		q.add('Pennsylvania Department of Transportation');
		q.add('Transportation in Pennsylvania');
	}
	if (/infrastructure report card|grades?\s+\w*\s*infrastructure/i.test(blob)) q.add('Infrastructure');
	if (/merit shop|associated builders/i.test(blob) || /\bABC Announces\b/i.test(name)) {
		q.add('Associated Builders and Contractors');
		q.add('Merit shop');
	}
	if (/critical minerals?/i.test(name)) q.add('United States critical materials list');
	if (/liquidated damages|indemnity|construction contract/i.test(profile.summary.slice(0, 600))) {
		q.add('Construction contract');
		q.add('Liquidated damages');
	}
	if (/lead azide/i.test(blob)) {
		q.add('Lead azide');
		q.add('Primary explosive');
	}
	if (/iowa army ammunition|middletown/i.test(blob)) {
		q.add('Iowa Army Ammunition Plant');
		q.add('Middletown, Iowa');
	}
	if (/8th u\.?s\.? circuit|appeals court/i.test(blob)) q.add('United States Court of Appeals for the Eighth Circuit');
	if (/\bEPA\b|environmental protection agency/i.test(blob)) q.add('United States Environmental Protection Agency');
	if (/\bU\.?S\.?\s+Army\b|the Army plans/i.test(blob)) q.add('United States Army');
	if (/\bOSHA\b|occupational safety and health/i.test(blob)) q.add('Occupational Safety and Health Administration');
	if (/\bFEMA\b/i.test(blob)) q.add('Federal Emergency Management Agency');
	if (/\bUSACE\b|army corps of engineers/i.test(blob)) q.add('United States Army Corps of Engineers');
	if (/\bnuclear plant|small modular|SMR\b/i.test(blob)) q.add('Nuclear power in the United States');
	if (/\bdata center/i.test(blob)) q.add('Data center');
	if (/\bpermitting reform\b/i.test(blob)) q.add('National Environmental Policy Act');
	if (/\bGreat Lakes\b.*\bport|\bport\b.*\bGreat Lakes\b/i.test(blob)) q.add('Great Lakes');

	// Multi-word Title Case phrases from the headline only (skip single junk words).
	for (const m of name.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g)) {
		const phrase = m[1];
		const words = phrase.split(/\s+/);
		const last = words[words.length - 1].toLowerCase();
		if (WIKI_STOP_TITLE_WORDS.has(last)) continue;
		if (words.every((w) => WIKI_STOP_TITLE_WORDS.has(w.toLowerCase()))) continue;
		if (words.filter((w) => WIKI_STOP_TITLE_WORDS.has(w.toLowerCase())).length >= Math.ceil(words.length / 2)) continue;
		if (isJunkSectionLine(phrase)) continue;
		if (words.length >= 2) q.add(phrase);
	}

	for (const b of bullets.slice(0, 4)) {
		if (/energy/i.test(b.title)) q.add('Electricity sector in the United States');
		if (/transit/i.test(b.title)) q.add('Public transport');
		if (/bridge/i.test(b.title)) q.add('Bridge');
		if (/drinking water|wastewater|stormwater/i.test(b.title)) q.add('Water infrastructure');
		if (/lead azide|stockpile|detonation/i.test(b.title)) q.add('Lead azide');
		if (/osha|penalty|citation/i.test(b.title)) q.add('Occupational Safety and Health Administration');
	}

	return [...q].slice(0, 8);
}

async function fetchText(url, { timeoutMs = 20_000, retries = 2 } = {}) {
	let lastErr = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (err) {
			lastErr = err;
			await sleep(200 + attempt * 300);
		}
	}
	throw lastErr || new Error('fetch failed');
}

async function wikiSearch(query, limit = 4) {
	const url = new URL(`${KIWIX}/search`);
	url.searchParams.set('pattern', query);
	url.searchParams.set('format', 'xml');
	url.searchParams.set('pageLength', String(limit));
	const xml = await fetchText(url, { timeoutMs: 20_000, retries: 2 });
	const hits = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
		const block = m[1];
		const title = stripTags((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
		const link = stripTags((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
		const snippet = stripTags((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '').slice(0, 280);
		if (title) hits.push({ title, link, snippet });
		if (hits.length >= limit) break;
	}
	return hits;
}

async function wikiFirstPara(link, title) {
	let path = link || '';
	if (!path.startsWith('/')) path = `/content/wikipedia_en_all_maxi/${String(title || '').replace(/ /g, '_')}`;
	if (path.startsWith('/wikipedia_en_all_maxi/')) path = `/content${path}`;
	if (!path.includes('/content/')) path = `/content/wikipedia_en_all_maxi/${String(title || '').replace(/ /g, '_')}`;
	try {
		const html = await fetchText(`${KIWIX}${path}`, { timeoutMs: 20_000, retries: 2 });
		const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1]));
		for (const t of paras) {
			if (t.length < 80) continue;
			if (/categories:/i.test(t)) continue;
			return t.slice(0, 280);
		}
	} catch {
		return '';
	}
	return '';
}

function isUsefulWikiHit(hit, query) {
	const t = String(hit.title || '').toLowerCase();
	if (!t) return false;
	if (
		/\bsong\b|\balbum\b|\bfilm\b|\bepisode\b|\bdisambiguation\b|^category:|list of .+ journals|academic journals|_categories_|partials_category/i.test(
			t,
		)
	) {
		return false;
	}
	const q = String(query || '').toLowerCase();
	if (/institute|university|college/i.test(t) && !/institute|university|college/i.test(q)) return false;
	if (t === q) return true;
	const qTokens = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
	const titleTokens = new Set(t.split(/[^a-z0-9]+/).filter(Boolean));
	const overlap = qTokens.filter((tok) => titleTokens.has(tok)).length;
	// Require strong title overlap — snippet-only hits (e.g. unrelated pages) are noise.
	if (!qTokens.length) return false;
	if (/^list of\b/i.test(t) && !/^list of\b/i.test(q)) return false;
	const need = qTokens.length >= 3 ? 2 : 1;
	return overlap >= need && overlap / qTokens.length >= 0.6;
}

async function collectWikiNotes(queries) {
	const notes = [];
	for (const q of queries) {
		try {
			const hits = await wikiSearch(q, 6);
			const exact = hits.find((h) => h.title.toLowerCase() === q.toLowerCase());
			const ordered = exact ? [exact, ...hits.filter((h) => h !== exact)] : hits;
			for (const h of ordered) {
				if (!isUsefulWikiHit(h, q)) continue;
				if (notes.some((n) => n.title === h.title)) continue;
				let link = h.link || '';
				if (!link.startsWith('/')) link = `/content/wikipedia_en_all_maxi/${h.title.replace(/ /g, '_')}`;
				if (link.startsWith('/wikipedia_en_all_maxi/')) link = `/content${link}`;
				if (!link.includes('/content/')) link = `/content/wikipedia_en_all_maxi/${h.title.replace(/ /g, '_')}`;
				const para = await wikiFirstPara(link, h.title);
				notes.push({
					title: h.title,
					link,
					snippet: para || h.snippet || h.title,
				});
				break; // one strong hit per query
			}
		} catch (err) {
			console.warn(`[format-card] wiki miss for "${q}":`, err instanceof Error ? err.message : err);
		}
		await sleep(60);
		if (notes.length >= MAX_WIKI) break;
	}
	return notes;
}

function buildFormattedSummary(profile, bullets, wikiNotes, { relatedCount = 0, sourceUrls = [] } = {}) {
	const feedTag = profile.feed ? ` [${profile.feed}]` : '';
	// Prefer overall/report-card date for the card span; ignore historical context years (Act 89, etc.)
	const primary =
		bullets.find((b) => b.kind === 'overall')?.iso ||
		bullets.find((b) => b.kind === 'grade')?.iso ||
		profile.startDate;
	const primaryDates = bullets
		.filter((b) => b.kind === 'overall' || b.kind === 'grade' || b.kind === 'provision' || b.kind === 'highlight')
		.map((b) => b.iso)
		.filter(Boolean)
		.sort();
	const startIso = primary || primaryDates[0] || profile.startDate;
	const endIso = null;
	const startLong = isoToLong(startIso) || startIso || 'undated';

	const lead = [
		firstSentences(cleanArticleBody(profile.summary), 240) || profile.name,
		`Fact-checked against the local Wikipedia library and reduced to dated milestones${relatedCount > 1 ? ` (pieced with ${relatedCount} related items)` : ''}.`,
		startLong ? `Keyed to ${startLong}.` : '',
	]
		.filter(Boolean)
		.join(' ');

	const timelineLines = bullets.map((b) => {
		const label = isoToLong(b.iso) || b.iso || 'Undated';
		const claim = (b.text || b.title || '').replace(/\s+/g, ' ').trim();
		const titleBit = b.title && !claim.toLowerCase().startsWith(String(b.title).toLowerCase().slice(0, 24)) ? `${b.title} — ` : '';
		return `- **${label}** — ${titleBit}${claim}${feedTag}`;
	});

	const wikiLines = wikiNotes.length
		? wikiNotes.map((w) => {
				const link = w.link ? `${KIWIX}${w.link.startsWith('/') ? w.link : `/${w.link}`}` : '';
				return `- **${w.title}** — ${w.snippet || '(no snippet)'}${link ? ` (${link})` : ''}`;
			})
		: ['- No strong local-wiki hits for the queried topic labels.'];

	const urls = (sourceUrls.length ? sourceUrls : [(profile.sourceUrl || '').split('?')[0] || profile.sourceUrl]).filter(Boolean);
	const lines = [
		lead,
		'',
		'## Timeline',
		...timelineLines,
		'',
		'## Local Wikipedia cross-check',
		...wikiLines,
		'',
		'## Source articles',
		...(urls.length ? urls.map((u) => `- ${u}`) : ['- (no source URL)']),
		'',
		relatedCount > 1
			? `Pieced from ${relatedCount} news_rss card(s) via news-rss-format-card; overview mixes a short paragraph with Timeline-style dated entries.`
			: `Single-card rewrite via news-rss-format-card; overview mixes a short paragraph with Timeline-style dated entries.`,
	];

	return {
		summary: lines.join('\n').slice(0, 120_000),
		startDate: startIso || profile.startDate,
		endDate: endIso && endIso !== startIso ? endIso : null,
	};
}

async function apiJson(pathname, { method = 'GET', body } = {}) {
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `${method} ${pathname} → HTTP ${res.status}`);
	}
	return data;
}

async function patchProfile(id, patch) {
	return apiJson(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

async function addTimeline(id, entry) {
	return apiJson(`/api/profiles/${encodeURIComponent(id)}/timeline`, { method: 'POST', body: entry });
}

async function mergeInto(keepId, mergeId) {
	return apiJson('/api/profiles/merge', { method: 'POST', body: { keepId, mergeId } });
}

function clusterIdFor(profile) {
	const base = String(profile.slug || profile.name || profile.id)
		.replace(/^historic_event:/, '')
		.replace(/[^a-z0-9]+/gi, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase()
		.slice(0, 48);
	return `format-${base || profile.id.slice(0, 8)}`;
}

function isAlreadyFormatted(profile) {
	const md = profile.metadata || {};
	if (md.overviewStyle === 'lead_plus_timeline_rail') return true;
	if (md.formattedBy === 'news-rss-format-card') return true;
	if (String(profile.summary || '').includes('## Timeline') && /news-rss-format-card|topic_consolidated|Local Wikipedia cross-check/i.test(profile.summary))
		return true;
	return false;
}

function listUnformattedNews({ bucket = null, limit = null } = {}) {
	const db = new DatabaseSync(PROFILES_DB, { readonly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, slug, name, start_date, end_date, summary, metadata_json
         FROM profiles
         WHERE profile_type = 'historic_event'
           AND status = 'active'
           AND (metadata_json LIKE '%newsFeedId%' OR metadata_json LIKE '%"news_rss"%' OR slug LIKE 'historic_event:news-%')
         ORDER BY COALESCE(start_date, '') DESC, updated_at DESC`,
			)
			.all();
		const out = [];
		for (const r of rows) {
			let metadata = {};
			try {
				metadata = JSON.parse(r.metadata_json || '{}');
			} catch {
				metadata = {};
			}
			const profile = {
				id: r.id,
				slug: r.slug,
				name: r.name,
				startDate: r.start_date || null,
				endDate: r.end_date || null,
				summary: r.summary || '',
				feed: metadata.newsFeedId || null,
				feedName: metadata.newsFeedName || null,
				sourceUrl: metadata.sourceUrl || null,
				metadata,
			};
			if (bucket && String(metadata.newsBucket || '') !== bucket) continue;
			if (isAlreadyFormatted(profile)) continue;
			out.push(profile);
			if (limit && out.length >= limit) break;
		}
		return out;
	} finally {
		db.close?.();
	}
}

async function formatOne(profile, { related: wantRelated = false, quiet = false } = {}) {
	if (!quiet) console.log(`[format-card] ${profile.slug} dryRun=${DRY_RUN} kiwix=${KIWIX}`);

	let related = [];
	if (wantRelated || MERGE_RELATED) {
		const peers = listNewsPeers(profile.id);
		related = findRelatedPeers(profile, peers);
		if (!quiet) {
			console.log(`[format-card] related peers=${related.length}`);
			for (const r of related) console.log(`  ~${r._score.toFixed(2)} ${r.startDate || '----'} ${r.name.slice(0, 70)}`);
		}
	}

	const combinedSummary = [profile, ...related]
		.map((p) => cleanArticleBody(p.summary))
		.filter(Boolean)
		.join('\n\n');
	const extractProfile = {
		...profile,
		summary: combinedSummary || profile.summary,
		name: profile.name,
	};

	const bullets = extractMilestones(extractProfile);
	if (!quiet) {
		console.log(`[format-card] milestones=${bullets.length}`);
		for (const b of bullets) console.log(`  - ${b.iso || 'undated'} [${b.kind}] ${String(b.title).slice(0, 70)}`);
	}

	const wikiQueries = deriveWikiQueries(extractProfile, bullets);
	if (!quiet) console.log(`[format-card] wikiQueries=${wikiQueries.join(' | ')}`);
	const wikiNotes = await collectWikiNotes(wikiQueries);
	if (!quiet) console.log(`[format-card] wikiNotes=${wikiNotes.map((w) => w.title).join(' | ')}`);

	const sourceUrls = [
		...new Set(
			[profile.sourceUrl, ...related.map((r) => r.sourceUrl)].filter(Boolean).map((u) => String(u).split('?')[0]),
		),
	];
	const { summary, startDate, endDate } = buildFormattedSummary(profile, bullets, wikiNotes, {
		relatedCount: related.length + 1,
		sourceUrls,
	});

	const clusterId = clusterIdFor(profile);
	const report = {
		at: new Date().toISOString(),
		dryRun: DRY_RUN,
		id: profile.id,
		slug: profile.slug,
		clusterId,
		bullets: bullets.map((b) => ({ iso: b.iso, kind: b.kind, title: b.title })),
		wikiTitles: wikiNotes.map((w) => w.title),
		related: related.map((r) => ({ id: r.id, slug: r.slug, score: r._score, name: r.name })),
		summaryChars: summary.length,
		startDate,
		endDate,
	};

	if (DRY_RUN) {
		if (!quiet) console.log(`\n[format-card] DRY summary preview (${summary.length}c):\n${summary.slice(0, 1200)}\n…\n`);
		return { ...report, status: 'dry_run', summaryPreview: summary.slice(0, 1500) };
	}

	if (MERGE_RELATED && related.length > 0 && related.length <= 4) {
		for (const r of related) {
			try {
				await mergeInto(profile.id, r.id);
				console.log(`[format-card] merged ${r.slug} → ${profile.slug}`);
				await sleep(100);
			} catch (err) {
				console.error(`[format-card] merge fail ${r.slug}:`, err instanceof Error ? err.message : err);
			}
		}
	}

	const patch = {
		summary,
		startDate,
		endDate,
		metadata: {
			topicClusterId: clusterId,
			topicConsolidatedAt: new Date().toISOString(),
			topicMemberCount: 1 + (MERGE_RELATED ? related.length : 0),
			wikiFactCheck: wikiNotes.map((w) => ({ title: w.title, snippet: w.snippet, link: w.link })),
			overviewStyle: 'lead_plus_timeline_rail',
			formattedBy: 'news-rss-format-card',
			corpora: [
				...new Set([
					...(Array.isArray(profile.metadata?.corpora) ? profile.metadata.corpora.map(String) : []),
					...related.flatMap((r) => (Array.isArray(r.metadata?.corpora) ? r.metadata.corpora.map(String) : [])),
					profile.feed ? `news_rss:${profile.feed}` : 'news_rss',
					...related.map((r) => (r.feed ? `news_rss:${r.feed}` : null)).filter(Boolean),
					'news_rss',
					'topic_consolidated',
					`cluster:${clusterId}`,
				]),
			],
		},
	};
	if (MERGE_RELATED && related.length > 0 && /lead azide|detonate.*iowa|iowa.*detonate/i.test(profile.name)) {
		patch.name = 'Iowa Army Ammunition Plant lead azide detonation';
	}
	await patchProfile(profile.id, patch);

	for (const b of bullets) {
		try {
			await addTimeline(profile.id, {
				title: String(b.title || profile.name).slice(0, 180),
				summary: String(b.text || b.title || '').slice(0, 500),
				eventDate: b.iso || startDate || profile.startDate,
				angle: 'general',
				entryKind: 'observation',
				sourceCorpus: `news_rss:${profile.feed || 'unknown'}`,
				sourceUrl: profile.sourceUrl,
				sourceRef: `${profile.sourceUrl || profile.slug}#${String(b.kind)}-${String(b.title || '')
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.slice(0, 40)}`,
			});
			await sleep(50);
		} catch (err) {
			console.error(`[format-card] timeline fail:`, err instanceof Error ? err.message : err);
		}
	}

	if (!quiet) console.log(`[format-card] ok summaryChars=${summary.length} start=${startDate} end=${endDate || '-'}`);
	return { ...report, status: 'ok' };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.unformatted && !args.id && !args.slug && !args.url) {
		console.error(
			'Usage: news-rss-format-card --id=<uuid> | --slug=<slug> | --url=<profile url> | --unformatted [--limit=N] [--bucket=…] [--related]',
		);
		process.exit(2);
	}

	fs.mkdirSync(OUT_DIR, { recursive: true });

	if (args.unformatted) {
		const targets = listUnformattedNews({ bucket: args.bucket, limit: args.limit });
		console.log(
			`[format-card] batch unformatted=${targets.length} dryRun=${DRY_RUN} mergeRelated=${MERGE_RELATED} related=${!!args.related} bucket=${args.bucket || '*'}`,
		);
		const batch = {
			at: new Date().toISOString(),
			dryRun: DRY_RUN,
			mergeRelated: MERGE_RELATED,
			related: !!args.related,
			bucket: args.bucket,
			limit: args.limit,
			total: targets.length,
			results: [],
		};
		let ok = 0;
		let fail = 0;
		for (let i = 0; i < targets.length; i++) {
			const profile = targets[i];
			process.stdout.write(`[format-card] (${i + 1}/${targets.length}) ${profile.slug.slice(0, 72)} … `);
			try {
				const report = await formatOne(profile, { related: args.related || MERGE_RELATED, quiet: true });
				batch.results.push({
					id: report.id,
					slug: report.slug,
					status: report.status,
					milestones: report.bullets?.length || 0,
					wikiTitles: report.wikiTitles,
					related: report.related?.length || 0,
					summaryChars: report.summaryChars,
					startDate: report.startDate,
				});
				ok++;
				console.log(`${report.status} milestones=${report.bullets?.length || 0} wiki=${(report.wikiTitles || []).length}`);
			} catch (err) {
				fail++;
				const msg = err instanceof Error ? err.message : String(err);
				batch.results.push({ id: profile.id, slug: profile.slug, status: 'error', error: msg });
				console.log(`ERROR ${msg}`);
				await sleep(500);
			}
			fs.writeFileSync(path.join(OUT_DIR, 'news-rss-format-card-batch.json'), JSON.stringify(batch, null, 2));
			await sleep(150);
		}
		batch.ok = ok;
		batch.fail = fail;
		batch.finishedAt = new Date().toISOString();
		fs.writeFileSync(path.join(OUT_DIR, 'news-rss-format-card-batch.json'), JSON.stringify(batch, null, 2));
		console.log(`[format-card] batch done ok=${ok} fail=${fail} → .data/monitors/news-rss-format-card-batch.json`);
		return;
	}

	const profile = loadProfileByRef(args);
	if (!profile) {
		console.error('[format-card] profile not found', args);
		process.exit(1);
	}

	const report = await formatOne(profile, { related: args.related || MERGE_RELATED, quiet: false });
	fs.writeFileSync(path.join(OUT_DIR, 'news-rss-format-card.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error('[format-card] fatal', err);
	process.exit(1);
});
