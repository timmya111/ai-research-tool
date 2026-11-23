#!/usr/bin/env node
/**
 * Backfill firm startDate (founded/established) and endDate (dissolved/defunct)
 * from local Kiwix Wikipedia company infoboxes.
 *
 * Only fills missing fields — never overwrites an existing start/end.
 *
 * Usage:
 *   node scripts/backfill-firm-dates-wikipedia.mjs --limit 300 --concurrency 1
 *   node scripts/backfill-firm-dates-wikipedia.mjs --min-links 5 --limit 1000
 *   node scripts/backfill-firm-dates-wikipedia.mjs --slug firm:openai
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { updateProfileFields, getProfile } = await import('../src/lib/research/profiles/store.ts');
const { normalizeIsoDate } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'firm-dates-wikipedia';
const KIWIX = process.env.KIWIX_BASE || process.env.KIWIX_URL || 'http://127.0.0.1:8765';
const UA = 'AI-Research-Tool-FirmDates/1.0 (local research; +http://localhost:3333)';

try {
	process.stdout._handle?.setBlocking?.(true);
} catch {
	/* ignore */
}

const argv = process.argv.slice(2);
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}
const limit = Number(arg('--limit', '300'));
const concurrency = Math.max(1, Math.min(2, Number(arg('--concurrency', '1'))));
const minLinks = Number(arg('--min-links', '0'));
const onlySlug = arg('--slug', null);
const dryRun = argv.includes('--dry-run');
/** Skip ALL-CAPS FINRA-style names (weak Wikipedia hit rate / high false positives). */
const mixedCaseOnly = argv.includes('--mixed-case-only') || !argv.includes('--include-all-caps');
/** By default only process firms missing startDate (founded). Pass --also-missing-end to include end-only gaps. */
const alsoMissingEnd = argv.includes('--also-missing-end');

const MONTHS = {
	january: '01',
	february: '02',
	march: '03',
	april: '04',
	may: '05',
	june: '06',
	july: '07',
	august: '08',
	september: '09',
	october: '10',
	november: '11',
	december: '12',
};

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function curlText(url) {
	const { stdout } = await execFileAsync(
		'curl',
		['-fsS', '--max-time', '25', '-A', UA, url],
		{ maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
	);
	return stdout;
}

async function searchKiwix(q) {
	const url = `${KIWIX.replace(/\/+$/, '')}/search?pattern=${encodeURIComponent(q)}&format=xml&pageLength=8`;
	const xml = await curlText(url);
	const hits = [];
	const re = /<item>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<link>([^<]+)<\/link>/gi;
	let m;
	while ((m = re.exec(xml))) {
		const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
		const link = m[2].trim();
		if (!link || link.startsWith('/search')) continue;
		hits.push({ title, link });
	}
	return hits;
}

async function fetchArticleHtml(link) {
	const base = KIWIX.replace(/\/+$/, '');
	const full = link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
	return curlText(full);
}

function stripTags(raw) {
	return String(raw || '')
		.replace(/<br\s*\/?>/gi, ', ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#\d+;/g, ' ')
		.replace(/\[\s*\d+\s*\]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Parse the best ISO-ish date from an infobox cell. Prefer parenthetical ISO. */
function parseDateFromCell(raw) {
	const s = stripTags(raw);
	if (!s || s.length > 240) return null;

	// Prefer explicit ISO in parentheses: ( 2015-12-08 ) or (2015-12-08)
	const isoParen = s.match(/\(\s*(\d{4}-\d{2}-\d{2})\s*\)/);
	if (isoParen) return normalizeIsoDate(isoParen[1]).date;

	// Month Day, Year
	const mdy = s.match(
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (mdy) {
		const mm = MONTHS[mdy[1].toLowerCase()];
		const dd = String(mdy[2]).padStart(2, '0');
		return normalizeIsoDate(`${mdy[3]}-${mm}-${dd}`).date;
	}

	// Year in parentheses: ( 1850 )
	const yearParen = s.match(/\(\s*((?:1[89]|20)\d{2})\s*\)/);
	if (yearParen) return yearParen[1];

	// Bare year — take earliest plausible company year in the cell
	const years = [...s.matchAll(/\b((?:1[789]|20)\d{2})\b/g)].map((m) => m[1]);
	const plausible = years.filter((y) => {
		const n = Number(y);
		return n >= 1600 && n <= 2026;
	});
	if (plausible.length) {
		plausible.sort();
		return plausible[0];
	}

	return normalizeIsoDate(s).date;
}

function isStartLabel(label) {
	return /^(founded|established|formation|formed|incorporation|incorporated|opened|launched|started|origin|commenced)$/i.test(
		label,
	);
}

function isEndLabel(label) {
	return /^(dissolved|defunct|ceased|closed|liquidation|bankruptcy date|wound up)$/i.test(label);
}

/**
 * Extract founded/established and dissolved/defunct from company infobox.
 * Fate alone is only used when it clearly encodes an end year and no Defunct row exists.
 */
function extractFirmDatesFromHtml(html) {
	const text = String(html || '');
	const ibMatch = text.match(/<table\b[^>]*class="[^"]*\binfobox\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
	if (!ibMatch) return { startDate: null, endDate: null, sourceTitle: null };

	const ibHtml = ibMatch[1];
	let startDate = null;
	let endDate = null;
	let fateText = null;

	const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	for (const rm of ibHtml.matchAll(rowRe)) {
		const row = rm[1];
		const thM = row.match(/<th\b[^>]*class="[^"]*infobox-label[^"]*"[^>]*>([\s\S]*?)<\/th>/i);
		const tdM = row.match(/<td\b[^>]*class="[^"]*infobox-data[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
		if (!thM || !tdM) continue;
		const label = stripTags(thM[1])
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
		if (!label) continue;

		if (isStartLabel(label) && !startDate) {
			startDate = parseDateFromCell(tdM[1]);
		} else if (isEndLabel(label) && !endDate) {
			endDate = parseDateFromCell(tdM[1]);
		} else if (/^fate$/.test(label) && !fateText) {
			fateText = stripTags(tdM[1]);
		}
	}

	// Fallback: Fate with a clear terminal verb + year (no Defunct row)
	if (!endDate && fateText) {
		const fateEnd = fateText.match(
			/\b(?:bankrupt(?:cy|ed)?|liquidat(?:ed|ion)|dissolv(?:ed|ing)|acquired|merged|ceased|closed|wound\s+up)\b[^.]{0,80}?\b((?:1[89]|20)\d{2})\b/i,
		);
		if (fateEnd) endDate = fateEnd[1];
	}

	// Sanity: end after start when both year-comparable
	if (startDate && endDate) {
		const sy = Number(String(startDate).slice(0, 4));
		const ey = Number(String(endDate).slice(0, 4));
		if (Number.isFinite(sy) && Number.isFinite(ey) && ey < sy) endDate = null;
	}

	return { startDate, endDate };
}

/** Strip only leading "the" and trailing legal-entity suffixes — keep brand words like Company/Group/Bank. */
const TRAILING_LEGAL = new Set([
	'inc',
	'llc',
	'ltd',
	'limited',
	'corp',
	'corporation',
	'co',
	'plc',
	'ag',
	'sa',
	'nv',
	'se',
	'lp',
	'llp',
	'pty',
	'gmbh',
	'a/s',
	'ab',
	'oy',
	'bv',
	'kk',
]);

const FINANCE_HINT =
	/\b(securities|advisors?|advisory|investments?|capital|equity|equities|asset|fund|funds|broker|brokerage|wealth|trust|insurance|bank|bancorp|holdings?|partners?|management|financial|markets?|trading|underwriters?)\b/i;

function rawTokens(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/&amp;/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1 || /^\d+$/.test(t));
}

function coreTokens(name) {
	const toks = rawTokens(name);
	while (toks.length && toks[0] === 'the') toks.shift();
	while (toks.length && TRAILING_LEGAL.has(toks[toks.length - 1])) toks.pop();
	// Drop dangling "and"
	while (toks.length && toks[toks.length - 1] === 'and') toks.pop();
	return toks.filter((t) => t.length >= 2 || /^\d+$/.test(t));
}

/** Too-generic single tokens — never match on these alone. */
const GENERIC_SOLO = new Set([
	'firm',
	'group',
	'company',
	'capital',
	'holdings',
	'partners',
	'international',
	'global',
	'national',
	'united',
	'first',
	'american',
	'general',
	'standard',
	'united',
	'services',
	'systems',
	'technologies',
	'tech',
	'bank',
	'trust',
	'energy',
	'resources',
	'industries',
]);

function nameLooksLikeHit(firmName, title) {
	// Keep parenthetical country/region tokens (China, US); drop only pure disambiguation cues
	const titleBase = String(title || '')
		.replace(/\s*\((?:company|firm|business|brand|manufacturer|band|disambiguation)\)\s*/gi, ' ')
		.replace(/[()]/g, ' ')
		.trim();
	const firmBase = String(firmName || '')
		.replace(/[()]/g, ' ')
		.trim();
	const aAll = coreTokens(firmBase);
	const bAll = coreTokens(titleBase);
	if (!aAll.length || !bAll.length) return false;

	const a = aAll.join(' ');
	const b = bAll.join(' ');
	if (a === b) return true;

	const at = new Set(aAll);
	const bt = new Set(bAll);
	const overlap = aAll.filter((t) => bt.has(t));
	const overlapCount = overlap.length;
	const extraTitle = bAll.filter((t) => !at.has(t));
	const extraFirm = aAll.filter((t) => !bt.has(t));

	// Numeric / region tokens in the firm name must appear in the title (Firm 9, ABB China)
	const mustKeep = aAll.filter((t) => /^\d+$/.test(t) || /^(china|india|japan|korea|brazil|mexico|europe|asia|usa|uk|us)$/.test(t));
	if (mustKeep.some((t) => !bt.has(t))) return false;

	// Overlap that is only generic glue words is not an identity match
	const meaningfulOverlap = overlap.filter((t) => !GENERIC_SOLO.has(t) && !/^\d+$/.test(t));
	if (aAll.length >= 2 && meaningfulOverlap.length === 0) return false;

	// Single-token brand: title must be that brand; reject generic solos (Firm → The Firm, Inc.)
	if (aAll.length === 1) {
		if (GENERIC_SOLO.has(aAll[0])) return false;
		return bAll.length === 1 && bAll[0] === aAll[0];
	}

	// All firm tokens appear in title, and title does not add a conflicting distinctive token
	// (blocks Deutsche Bank → Deutsche WertpapierService Bank, Nestlé China → Nestlé India)
	// Same multiset with different order (CF Capital ↔ Capital CF) is rejected — a === b already handled.
	if (extraFirm.length === 0) {
		if (extraTitle.length === 0) return false;
		// Allow one mild corporate synonym in title (group/company/holdings)
		if (
			extraTitle.length === 1 &&
			/^(group|company|holdings|corporation|limited|plc)$/.test(extraTitle[0])
		) {
			return true;
		}
		return false;
	}

	// Title is shorter brand of a longer firm name (Visa Inc → Visa; Allianz SE → Allianz)
	if (extraTitle.length === 0 && overlapCount === bAll.length && overlapCount >= Math.min(2, aAll.length)) {
		// Require remaining firm extras to be mild corporate words or country markers we tolerate
		if (extraFirm.every((t) => /^(group|company|holdings|corporation|international|worldwide)$/.test(t))) {
			return true;
		}
	}

	const mildCorp = /^(group|company|holdings|corporation|limited|plc)$/;

	// Synonym swap: Zurich Insurance Company ↔ Zurich Insurance Group
	if (
		overlapCount >= 2 &&
		extraFirm.length === 1 &&
		extraTitle.length === 1 &&
		mildCorp.test(extraFirm[0]) &&
		mildCorp.test(extraTitle[0])
	) {
		return true;
	}

	// Strong overlap without extras on either side beyond 1 mild token
	if (overlapCount >= 2 && overlapCount / aAll.length >= 0.8 && extraTitle.length <= 1) {
		if (extraTitle.length === 1 && !mildCorp.test(extraTitle[0])) {
			return false;
		}
		if (FINANCE_HINT.test(firmName) && extraTitle.some((t) => FINANCE_HINT.test(t) && !at.has(t))) {
			// Bain Company vs Bain Capital — conflicting finance token
			return false;
		}
		return extraFirm.length <= 1;
	}

	return false;
}

function skipTitle(title) {
	return /\b(family|surname|season|album|film|song|election|disambiguation|list of|football|basketball|cricket|racing|mall|shopping|airport|stadium|university|college|school|hospital|church|park|lake|river|mountain|novel|television|tv series|municipality|village|township|county|bridge|highway|road|tourism|meat solutions|bpm)\b/i.test(
		title,
	);
}

const db = new DatabaseSync(path.join(ROOT, '.data/profiles/profiles.sqlite'), { readOnly: true });

const linkCountById = new Map(
	db
		.prepare(
			`SELECT profile_id AS id, COUNT(*) AS c FROM (
			   SELECT from_profile_id AS profile_id FROM profile_links
			   UNION ALL
			   SELECT to_profile_id AS profile_id FROM profile_links
			 ) GROUP BY profile_id`,
		)
		.all()
		.map((r) => [r.id, Number(r.c) || 0]),
);

let queue = [];
if (onlySlug) {
	const row = db
		.prepare(
			`SELECT id, slug, name, start_date AS startDate, end_date AS endDate
       FROM profiles WHERE slug = ? AND profile_type = 'firm'`,
		)
		.get(onlySlug);
	if (!row) {
		console.error(`No firm profile for slug ${onlySlug}`);
		process.exit(1);
	}
	queue = [{ ...row, links: linkCountById.get(row.id) || 0 }];
} else {
	const firmScan = db
		.prepare(
			`SELECT id, slug, name, start_date AS startDate, end_date AS endDate
       FROM profiles WHERE profile_type = 'firm'`,
		)
		.all();
	const candidates = [];
	for (const f of firmScan) {
		const missingStart = !String(f.startDate || '').trim();
		const missingEnd = !String(f.endDate || '').trim();
		if (!missingStart && !missingEnd) continue;
		if (!missingStart && !alsoMissingEnd) continue;
		const links = linkCountById.get(f.id) || 0;
		if (links < minLinks) continue;
		const isAllCaps = f.name === String(f.name).toUpperCase() && /[A-Z]/.test(f.name);
		if (mixedCaseOnly && isAllCaps) continue;
		const latin = /[A-Za-z]/.test(f.name) ? 1 : 0;
		candidates.push({ ...f, links, latin, missingStart, missingEnd });
	}
	candidates.sort((a, b) => b.latin - a.latin || b.links - a.links || a.name.localeCompare(b.name));
	queue = candidates.slice(0, limit);
}

console.log(
	JSON.stringify({
		queue: queue.length,
		limit,
		concurrency,
		minLinks,
		onlySlug,
		dryRun,
		mixedCaseOnly,
		alsoMissingEnd,
		kiwix: KIWIX,
		corpus: CORPUS,
	}),
);

let okCount = 0;
let missCount = 0;
let skipCount = 0;
let errors = 0;
let idx = 0;

async function worker() {
	while (idx < queue.length) {
		const i = idx++;
		const row = queue[i];
		try {
			const live = getProfile(row.id);
			if (!live) {
				missCount += 1;
				continue;
			}
			const needStart = !String(live.startDate || '').trim();
			const needEnd = !String(live.endDate || '').trim();
			if (!needStart && !needEnd) {
				skipCount += 1;
				continue;
			}

			// Keep parenthetical region tokens (e.g. ABB (China)) for matching; only flatten for search queries.
			const matchName = String(row.name || '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
			const baseName = matchName;
			const queries = [
				matchName,
				`${matchName} company`,
				String(row.name || '')
					.replace(/\s*\([^)]*\)\s*/g, ' ')
					.replace(/\s+/g, ' ')
					.trim(),
			].filter(Boolean);
			let found = null;
			let hitTitle = null;

			for (const q of queries) {
				const hits = await searchKiwix(q);
				const ranked = [...hits].sort((a, b) => {
					const ae = nameLooksLikeHit(matchName, a.title) ? 0 : 1;
					const be = nameLooksLikeHit(matchName, b.title) ? 0 : 1;
					if (ae !== be) return ae - be;
					return a.title.length - b.title.length;
				});
				for (const hit of ranked.slice(0, 5)) {
					if (!nameLooksLikeHit(matchName, hit.title)) continue;
					if (skipTitle(hit.title)) continue;
					const html = await fetchArticleHtml(hit.link);
					const dates = extractFirmDatesFromHtml(html);
					if (dates.startDate || dates.endDate) {
						found = dates;
						hitTitle = hit.title;
						break;
					}
				}
				if (found) break;
			}

			if (!found || (!found.startDate && !found.endDate)) {
				missCount += 1;
				if ((i + 1) % 25 === 0) {
					console.log(
						JSON.stringify({
							processed: i + 1,
							okCount,
							missCount,
							skipCount,
							errors,
							remaining: queue.length - i - 1,
						}),
					);
				}
			} else {
				const patch = {};
				if (needStart && found.startDate) {
					const existingEnd = String(live.endDate || found.endDate || '').trim();
					const sy = Number(String(found.startDate).slice(0, 4));
					const ey = existingEnd ? Number(existingEnd.slice(0, 4)) : NaN;
					// Never write a start that would make end-before-start vs existing/wiki end
					if (!Number.isFinite(ey) || !Number.isFinite(sy) || sy <= ey) {
						patch.startDate = found.startDate;
					}
				}
				if (needEnd && found.endDate) {
					const startForCmp = String(patch.startDate || live.startDate || found.startDate || '').trim();
					const sy = startForCmp ? Number(startForCmp.slice(0, 4)) : NaN;
					const ey = Number(String(found.endDate).slice(0, 4));
					if (!Number.isFinite(sy) || !Number.isFinite(ey) || ey >= sy) {
						patch.endDate = found.endDate;
					}
				}
				if (Object.keys(patch).length === 0) {
					skipCount += 1;
				} else if (dryRun) {
					okCount += 1;
					console.log(`DRY ${row.slug} =>`, patch, `(wiki:${hitTitle})`);
				} else {
					updateProfileFields(row.id, {
						...patch,
						metadata: {
							firmDatesSource: CORPUS,
							firmDatesWikiTitle: hitTitle,
						},
					});
					okCount += 1;
					console.log(
						`OK ${row.slug} => start=${patch.startDate || live.startDate || '-'} end=${patch.endDate || live.endDate || '-'} (wiki:${hitTitle})`,
					);
				}
			}
		} catch (e) {
			errors += 1;
			console.log(`ERR ${row.slug} ${e?.message || e}`);
		}
		await sleep(150);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(
	JSON.stringify({
		done: true,
		processed: queue.length,
		okCount,
		missCount,
		skipCount,
		errors,
	}),
);
db.close();
