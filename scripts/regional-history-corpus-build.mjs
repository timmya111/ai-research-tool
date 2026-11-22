#!/usr/bin/env node
/**
 * Download and structure historical archives for:
 *   1. New York & Boston Financial History (ny_boston_finance)
 *   2. New York & Boston Labor & Union History (ny_boston_labor_unions)
 *   3. Regional Conflicts in New York & Boston (ny_boston_conflicts)
 *   4. Military, Defense, Aerospace & Industrial Tech Companies in Dallas–Fort Worth
 *      including Bell, Halliburton, Rockwell Collins, Emerson, Tubacex, and DFW peers (dfw_military_tech)
 *
 * Sources:
 *   - English Wikipedia MediaWiki API (full plaintext extracts + Wikidata IDs)
 *   - SEC EDGAR official company submissions JSON (CIK, SIC, former names, HQ, tickers)
 *   - Tubacex official web summary (fallback/enrichment)
 *
 * Output: .data/regional-history-corpus/
 *   - raw/wiki/<slug>.json
 *   - raw/sec/<cik>.json
 *   - articles/<slug>.md
 *   - events/events.jsonl
 *   - profiles/seed-profiles.json
 *   - digests/OVERVIEW.md
 *   - README.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'regional-history-corpus');

const WIKI_UA = 'ai-research-tool/1.0 (https://localhost; local-research-archive)';
const SEC_UA = 'AIResearchTool/1.0 (local-research-archive@localhost.invalid)';

/**
 * Curated manifest of topics across all 4 requested tracks.
 * profileType matches the 8 canonical categories:
 *   person | firm | education | nonprofit | medical_hospital | government | historic_event
 */
const MANIFEST = [
	// --- Track 1: New York & Boston Financial History ---
	{ wiki: 'History_of_Wall_Street', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial' },
	{ wiki: 'Buttonwood_Agreement', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '1792-05-17' },
	{ wiki: 'New_York_Stock_Exchange', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', startDate: '1792-05-17' },
	{ wiki: 'Bank_of_New_York', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', startDate: '1784-06-09' },
	{ wiki: 'BNY_Mellon', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', cik: '0001390777', ticker: 'BK' },
	{ wiki: 'Federal_Reserve_Bank_of_New_York', track: 'ny_boston_finance', profileType: 'government', geo: 'New York, NY', angle: 'financial', startDate: '1914-11-16' },
	{ wiki: 'Federal_Reserve_Bank_of_Boston', track: 'ny_boston_finance', profileType: 'government', geo: 'Boston, MA', angle: 'financial', startDate: '1914-11-16' },
	{ wiki: 'Massachusetts_Bank', track: 'ny_boston_finance', profileType: 'firm', geo: 'Boston, MA', angle: 'financial', startDate: '1784' },
	{ wiki: 'Boston_Associates', track: 'ny_boston_finance', profileType: 'firm', geo: 'Boston, MA', angle: 'financial', startDate: '1813' },
	{ wiki: 'Boston_Stock_Exchange', track: 'ny_boston_finance', profileType: 'firm', geo: 'Boston, MA', angle: 'financial', startDate: '1834' },
	{ wiki: 'State_Street_Corporation', track: 'ny_boston_finance', profileType: 'firm', geo: 'Boston, MA', angle: 'financial', cik: '0000093751', ticker: 'STT', startDate: '1792' },
	{ wiki: 'Fidelity_Investments', track: 'ny_boston_finance', profileType: 'firm', geo: 'Boston, MA', angle: 'financial', startDate: '1946' },
	{ wiki: 'J.P._Morgan_&_Co.', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', cik: '0000019617', ticker: 'JPM', startDate: '1871' },
	{ wiki: 'Goldman_Sachs', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', cik: '0000886982', ticker: 'GS', startDate: '1869' },
	{ wiki: 'Brown_Brothers_Harriman_&_Co.', track: 'ny_boston_finance', profileType: 'firm', geo: 'New York, NY', angle: 'financial', startDate: '1818' },
	{ wiki: 'Panic_of_1837', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '1837', endDate: '1843' },
	{ wiki: 'Panic_of_1873', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '1873', endDate: '1879' },
	{ wiki: 'Panic_of_1907', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '1907-10' },
	{ wiki: 'Wall_Street_crash_of_1929', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '1929-10-24', endDate: '1929-11-13' },
	{ wiki: 'Glass–Steagall_legislation', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'policy', startDate: '1933-06-16' },
	{ wiki: '2008_financial_crisis', track: 'ny_boston_finance', profileType: 'historic_event', geo: 'New York, NY', angle: 'financial', startDate: '2007', endDate: '2009' },

	// --- Track 2: New York & Boston Labor / Union History ---
	{ wiki: 'Lowell_mill_girls', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'Lowell, MA', angle: 'policy', startDate: '1823', endDate: '1850' },
	{ wiki: 'Great_Railroad_Strike_of_1877', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'New York, NY', angle: 'policy', startDate: '1877-07-14', endDate: '1877-09-04' },
	{ wiki: 'New_York_shirtwaist_strike_of_1909', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'New York, NY', angle: 'policy', startDate: '1909-11-23', endDate: '1910-02-15' },
	{ wiki: 'Triangle_Shirtwaist_Factory_fire', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'New York, NY', angle: 'policy', startDate: '1911-03-25' },
	{ wiki: '1912_Lawrence_textile_strike', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'Lawrence, MA', angle: 'policy', startDate: '1912-01-11', endDate: '1912-03-14' },
	{ wiki: 'Boston_Police_Strike', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'Boston, MA', angle: 'law_enforcement', startDate: '1919-09-09' },
	{ wiki: '1966_New_York_City_transit_strike', track: 'ny_boston_labor_unions', profileType: 'historic_event', geo: 'New York, NY', angle: 'policy', startDate: '1966-01-01', endDate: '1966-01-13' },
	{ wiki: "International_Ladies'_Garment_Workers'_Union", track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'New York, NY', angle: 'policy', startDate: '1900', endDate: '1995' },
	{ wiki: "International_Longshoremen's_Association", track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'New York, NY', angle: 'policy', startDate: '1892' },
	{ wiki: 'Industrial_Workers_of_the_World', track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'Boston, MA', angle: 'policy', startDate: '1905' },
	{ wiki: 'American_Federation_of_Labor', track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'New York, NY', angle: 'policy', startDate: '1886', endDate: '1955' },
	{ wiki: 'Knights_of_Labor', track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'Boston, MA', angle: 'policy', startDate: '1869' },
	{ wiki: 'Tammany_Hall', track: 'ny_boston_labor_unions', profileType: 'nonprofit', geo: 'New York, NY', angle: 'policy', startDate: '1789' },

	// --- Track 3: Regional Conflicts in New York & Boston ---
	{ wiki: "King_Philip's_War", track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'defense_dod', startDate: '1675', endDate: '1678' },
	{ wiki: 'Boston_Massacre', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'defense_dod', startDate: '1770-03-05' },
	{ wiki: 'Boston_Tea_Party', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'policy', startDate: '1773-12-16' },
	{ wiki: 'Battles_of_Lexington_and_Concord', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'defense_dod', startDate: '1775-04-19' },
	{ wiki: 'Siege_of_Boston', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'defense_dod', startDate: '1775-04-19', endDate: '1776-03-17' },
	{ wiki: 'Battle_of_Bunker_Hill', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'defense_dod', startDate: '1775-06-17' },
	{ wiki: 'New_York_and_New_Jersey_campaign', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'defense_dod', startDate: '1776-07', endDate: '1777-03' },
	{ wiki: 'Battle_of_Long_Island', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'defense_dod', startDate: '1776-08-27' },
	{ wiki: "Shays'_Rebellion", track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Springfield, MA', angle: 'defense_dod', startDate: '1786-08-29', endDate: '1787-06' },
	{ wiki: 'Astor_Place_Riot', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'law_enforcement', startDate: '1849-05-10' },
	{ wiki: 'New_York_City_draft_riots', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'law_enforcement', startDate: '1863-07-13', endDate: '1863-07-16' },
	{ wiki: 'Wall_Street_bombing', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'law_enforcement', startDate: '1920-09-16' },
	{ wiki: 'Sacco_and_Vanzetti', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'Boston, MA', angle: 'law_enforcement', startDate: '1920', endDate: '1927-08-23' },
	{ wiki: 'September_11_attacks', track: 'ny_boston_conflicts', profileType: 'historic_event', geo: 'New York, NY', angle: 'defense_dod', startDate: '2001-09-11' },

	// --- Track 4: Military / Defense / Industrial Tech Companies in Dallas–Fort Worth ---
	{ wiki: 'Bell_Textron', track: 'dfw_military_tech', profileType: 'firm', geo: 'Fort Worth, TX', angle: 'defense_dod', cik: '0000217346', ticker: 'TXT', aliases: ['Bell Helicopter', 'Bell Helicopter Textron'], startDate: '1935' },
	{ wiki: 'Bell_Aircraft', track: 'dfw_military_tech', profileType: 'firm', geo: 'Fort Worth, TX', angle: 'defense_dod', startDate: '1935', endDate: '1960' },
	{ wiki: 'Lawrence_Dale_Bell', track: 'dfw_military_tech', profileType: 'person', geo: 'Fort Worth, TX', angle: 'defense_dod', employer: 'Bell Textron', role: 'Founder', startDate: '1894-04-05', endDate: '1956-10-20' },
	{ wiki: 'Bell_UH-1_Iroquois', track: 'dfw_military_tech', profileType: 'historic_event', geo: 'Fort Worth, TX', angle: 'defense_dod', startDate: '1956' },
	{ wiki: 'Bell_Boeing_V-22_Osprey', track: 'dfw_military_tech', profileType: 'historic_event', geo: 'Fort Worth, TX', angle: 'defense_dod', startDate: '1989' },
	{ wiki: 'Halliburton', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'defense_dod', cik: '0000045012', ticker: 'HAL', aliases: ['Halliburton Company', 'Halliburton Energy Services'], startDate: '1919' },
	{ wiki: 'Erle_P._Halliburton', track: 'dfw_military_tech', profileType: 'person', geo: 'Duncan, OK', angle: 'corporate', employer: 'Halliburton', role: 'Founder', startDate: '1892-09-22', endDate: '1957-10-13' },
	{ wiki: 'KBR_(company)', track: 'dfw_military_tech', profileType: 'firm', geo: 'Houston, TX', angle: 'defense_dod', cik: '0001357615', ticker: 'KBR', aliases: ['Kellogg Brown & Root'], startDate: '1919' },
	{ wiki: 'Brown_&_Root', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'defense_dod', startDate: '1919' },
	{ wiki: 'Rockwell_Collins', track: 'dfw_military_tech', profileType: 'firm', geo: 'Richardson, TX', angle: 'defense_dod', aliases: ['Collins Radio', 'Collins Aerospace'], startDate: '1933', endDate: '2018' },
	{ wiki: 'Collins_Radio', track: 'dfw_military_tech', profileType: 'firm', geo: 'Richardson, TX', angle: 'defense_dod', startDate: '1933', endDate: '1973' },
	{ wiki: 'Arthur_A._Collins', track: 'dfw_military_tech', profileType: 'person', geo: 'Dallas, TX', angle: 'defense_dod', employer: 'Rockwell Collins', role: 'Founder (Collins Radio)', startDate: '1909-09-09', endDate: '1987-02-25' },
	{ wiki: 'Collins_Aerospace', track: 'dfw_military_tech', profileType: 'firm', geo: 'Richardson, TX', angle: 'defense_dod', cik: '0000101829', ticker: 'RTX', startDate: '2018' },
	{ wiki: 'Rockwell_International', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'defense_dod', startDate: '1919', endDate: '2001' },
	{ wiki: 'Emerson_Electric', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'corporate', cik: '0000032604', ticker: 'EMR', aliases: ['Emerson', 'Emerson Electric Co.'], startDate: '1890' },
	{
		wiki: 'Tubacex',
		wikiLang: 'es',
		webUrls: [
			'https://www.tubacex.com/en/tubacex-group/history/',
			'https://www.tubacex.com/en/tubacex-group/group-companies/',
			'https://www.tubacex.com/en/products-services/range-of-applications/',
		],
		track: 'dfw_military_tech',
		profileType: 'firm',
		geo: 'Durant, OK',
		angle: 'corporate',
		aliases: ['TUBACEX S.A.', 'Tubacex America', 'Salem Tube', 'Tubacex Durant'],
		startDate: '1963',
	},
	{ wiki: 'Air_Force_Plant_4', track: 'dfw_military_tech', profileType: 'government', geo: 'Fort Worth, TX', angle: 'defense_dod', startDate: '1942' },
	{ wiki: 'Lockheed_Martin_Aeronautics', track: 'dfw_military_tech', profileType: 'firm', geo: 'Fort Worth, TX', angle: 'defense_dod', cik: '0000936468', ticker: 'LMT', startDate: '1995' },
	{ wiki: 'Convair', track: 'dfw_military_tech', profileType: 'firm', geo: 'Fort Worth, TX', angle: 'defense_dod', startDate: '1943', endDate: '1994' },
	{ wiki: 'General_Dynamics', track: 'dfw_military_tech', profileType: 'firm', geo: 'Fort Worth, TX', angle: 'defense_dod', cik: '0000040533', ticker: 'GD', startDate: '1899' },
	{ wiki: 'Texas_Instruments', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'defense_dod', cik: '0000097476', ticker: 'TXN', aliases: ['TI', 'Geophysical Service Incorporated'], startDate: '1930' },
	{ wiki: 'Vought', track: 'dfw_military_tech', profileType: 'firm', geo: 'Grand Prairie, TX', angle: 'defense_dod', aliases: ['Chance Vought', 'Vought Aircraft Industries'], startDate: '1917' },
	{ wiki: 'Ling-Temco-Vought', track: 'dfw_military_tech', profileType: 'firm', geo: 'Dallas, TX', angle: 'defense_dod', aliases: ['LTV'], startDate: '1961', endDate: '2001' },
	{ wiki: 'E-Systems', track: 'dfw_military_tech', profileType: 'firm', geo: 'Garland, TX', angle: 'defense_dod', startDate: '1972', endDate: '1995' },
	{ wiki: 'L3Harris_Technologies', track: 'dfw_military_tech', profileType: 'firm', geo: 'Greenville, TX', angle: 'defense_dod', cik: '0000202058', ticker: 'LHX', aliases: ['L3Harris', 'L-3 Communications'], startDate: '1895' },
	{ wiki: 'RTX_Corporation', track: 'dfw_military_tech', profileType: 'firm', geo: 'Richardson, TX', angle: 'defense_dod', cik: '0000101829', ticker: 'RTX', aliases: ['Raytheon Technologies', 'Raytheon'], startDate: '1922' },
];

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function slugify(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function curlJson(url, ua) {
	const raw = execFileSync(
		'curl',
		['-sS', '-L', '-f', '--max-time', '25', '-A', ua, '-H', 'Accept: application/json', url],
		{ encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 },
	);
	return JSON.parse(raw);
}

function curlText(url, ua) {
	return execFileSync(
		'curl',
		['-sS', '-L', '-f', '--max-time', '25', '-A', ua, url],
		{ encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
	);
}

function htmlToPlaintext(html) {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const main = doc.querySelector('main') || doc.querySelector('article') || doc.body;
	for (const el of main.querySelectorAll('script, style, nav, footer, header, form, svg, iframe')) {
		el.remove();
	}
	const parts = [];
	const seen = new Set();
	for (const el of main.querySelectorAll('h1, h2, h3, h4, p, li')) {
		const t = el.textContent.replace(/\s+/g, ' ').trim();
		if (t.length < 18 || seen.has(t)) continue;
		seen.add(t);
		parts.push(t);
	}
	return parts.join('\n\n');
}

async function fetchWikiArticle(item, cacheFile) {
	if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 200) {
		return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
	}
	const lang = item.wikiLang || 'en';
	const wikiTitle = item.wiki;
	const apiUrl =
		`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1` +
		'&prop=extracts|info|pageprops&explaintext=1&inprop=url' +
		`&titles=${encodeURIComponent(wikiTitle)}`;
	const data = curlJson(apiUrl, WIKI_UA);
	const page = data?.query?.pages?.[0];
	let extract = page && !page.missing ? String(page.extract || '') : '';
	let fullurl =
		(page && !page.missing && page.fullurl) ||
		(item.webUrls?.[0] || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}`);
	const wikibaseItem = page?.pageprops?.wikibase_item || null;

	// Supplement with official web pages when configured (e.g. Tubacex official history + group companies)
	if (Array.isArray(item.webUrls) && item.webUrls.length > 0) {
		const chunks = [];
		for (const u of item.webUrls) {
			try {
				const html = curlText(u, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36');
				const txt = htmlToPlaintext(html);
				if (txt.length > 80) {
					chunks.push(`== Official Source: ${u} ==\n\n${txt}`);
				}
			} catch (err) {
				console.warn(`[regional] WARN webUrl ${u}: ${err.message}`);
			}
		}
		if (chunks.length > 0) {
			extract = [chunks.join('\n\n'), extract ? `== Wikipedia (${lang}) ==\n\n${extract}` : '']
				.filter(Boolean)
				.join('\n\n');
			fullurl = item.webUrls[0];
		}
	}

	if (!extract.trim()) {
		throw new Error(`No content fetched for ${wikiTitle}`);
	}

	const record = {
		requestedTitle: wikiTitle,
		title: (page && !page.missing && page.title) || wikiTitle.replace(/_/g, ' '),
		pageid: page?.pageid || null,
		fullurl,
		wikibaseItem,
		extract,
		fetchedAt: new Date().toISOString(),
	};
	fs.writeFileSync(cacheFile, JSON.stringify(record, null, 2), 'utf8');
	return record;
}

async function fetchSecSubmission(cik, cacheFile) {
	const padded = String(cik).replace(/\D/g, '').padStart(10, '0');
	if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 200) {
		return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
	}
	const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
	const data = curlJson(url, SEC_UA);
	const slim = {
		cik: padded,
		name: data.name || null,
		sic: data.sic || null,
		sicDescription: data.sicDescription || null,
		tickers: data.tickers || [],
		exchanges: data.exchanges || [],
		stateOfIncorporation: data.stateOfIncorporation || null,
		website: data.website || null,
		formerNames: (data.formerNames || []).slice(0, 12),
		businessAddress: data.addresses?.business || null,
		mailingAddress: data.addresses?.mailing || null,
		sourceUrl: url,
		fetchedAt: new Date().toISOString(),
	};
	fs.writeFileSync(cacheFile, JSON.stringify(slim, null, 2), 'utf8');
	return slim;
}

/**
 * Extract high-signal dated sentences from a Wikipedia plaintext extract so we get
 * rich chronological milestones for timeline alignment & gap filling.
 */
function extractTimelineMilestones(title, extract, maxItems = 8) {
	const milestones = [];
	const seenYears = new Set();
	// Split into sentences
	const sentences = String(extract || '')
		.replace(/==+[^=]+==+/g, '\n')
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.replace(/\s+/g, ' ').trim())
		.filter((s) => s.length >= 45 && s.length <= 360);

	const fullDateRe =
		/\b(?:on\s+)?(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:16|17|18|19|20)\d{2})|(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:16|17|18|19|20)\d{2}))\b/i;
	const yearActionRe =
		/\b(?:in|by|since|during|after|on)\s+((?:16|17|18|19|20)\d{2})\b/i;

	const MONTHS = {
		january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
		july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
	};

	for (const sent of sentences) {
		if (milestones.length >= maxItems) break;
		let isoDate = null;
		let precision = 'year';

		const fm = sent.match(fullDateRe);
		if (fm) {
			if (fm[1] && fm[2] && fm[3]) {
				isoDate = `${fm[3]}-${MONTHS[fm[1].toLowerCase()]}-${String(fm[2]).padStart(2, '0')}`;
				precision = 'day';
			} else if (fm[4] && fm[5] && fm[6]) {
				isoDate = `${fm[6]}-${MONTHS[fm[5].toLowerCase()]}-${String(fm[4]).padStart(2, '0')}`;
				precision = 'day';
			}
		} else {
			const ym = sent.match(yearActionRe);
			if (ym) {
				isoDate = ym[1];
				precision = 'year';
			}
		}
		if (!isoDate) continue;
		const yearKey = isoDate.slice(0, 4);
		if (seenYears.has(yearKey) && precision === 'year') continue;
		seenYears.add(yearKey);
		milestones.push({
			date: isoDate,
			precision,
			text: sent,
		});
	}

	milestones.sort((a, b) => a.date.localeCompare(b.date));
	return milestones;
}

function extractHeadings(extract) {
	const out = [];
	for (const m of String(extract || '').matchAll(/^==+\s*([^=\n]+?)\s*==+$/gm)) {
		const h = m[1].trim();
		if (!/^(see also|references|external links|further reading|notes|bibliography|sources)$/i.test(h)) {
			out.push(h);
		}
	}
	return out.slice(0, 25);
}

async function main() {
	ensureDir(path.join(OUT, 'raw', 'wiki'));
	ensureDir(path.join(OUT, 'raw', 'sec'));
	ensureDir(path.join(OUT, 'articles'));
	ensureDir(path.join(OUT, 'events'));
	ensureDir(path.join(OUT, 'profiles'));
	ensureDir(path.join(OUT, 'digests'));

	const secCache = new Map();
	const uniqueCiks = [...new Set(MANIFEST.map((m) => m.cik).filter(Boolean))];
	console.log(`[regional] fetching ${uniqueCiks.length} SEC EDGAR company profiles...`);
	for (const cik of uniqueCiks) {
		const f = path.join(OUT, 'raw', 'sec', `${cik}.json`);
		const wasCached = fs.existsSync(f);
		try {
			const sec = await fetchSecSubmission(cik, f);
			secCache.set(cik, sec);
			if (!wasCached) await sleep(200);
		} catch (err) {
			console.warn(`[regional] WARN SEC CIK ${cik}: ${err.message}`);
		}
	}

	const events = [];
	const seedProfiles = [];
	const byTrack = {
		ny_boston_finance: [],
		ny_boston_labor_unions: [],
		ny_boston_conflicts: [],
		dfw_military_tech: [],
	};

	console.log(`[regional] fetching ${MANIFEST.length} Wikipedia historical articles...`);
	for (let i = 0; i < MANIFEST.length; i++) {
		const item = MANIFEST[i];
		const slug = slugify(item.wiki);
		const cacheFile = path.join(OUT, 'raw', 'wiki', `${slug}.json`);
		const wasCached = fs.existsSync(cacheFile);

		let wiki;
		try {
			wiki = await fetchWikiArticle(item, cacheFile);
			if (!wasCached) await sleep(150);
		} catch (err) {
			console.warn(`[regional] WARN wiki ${item.wiki}: ${err.message}`);
			continue;
		}

		const sec = item.cik ? secCache.get(item.cik) || null : null;
		const headings = extractHeadings(wiki.extract);
		const leadParagraphs = wiki.extract
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter((p) => p.length > 40 && !p.startsWith('=='));
		const summary = leadParagraphs.slice(0, 2).join(' ').slice(0, 900);
		const milestones = extractTimelineMilestones(wiki.title, wiki.extract, 8);

		// Write clean markdown article digest
		const secBlock = sec
			? [
					'## SEC EDGAR Corporate Metadata',
					`- **Legal Name:** ${sec.name || wiki.title}`,
					`- **CIK:** ${sec.cik}`,
					sec.tickers?.length ? `- **Ticker(s):** ${sec.tickers.join(', ')}` : '',
					sec.sicDescription ? `- **SIC:** ${sec.sic} — ${sec.sicDescription}` : '',
					sec.stateOfIncorporation ? `- **State of Incorporation:** ${sec.stateOfIncorporation}` : '',
					sec.businessAddress?.city
						? `- **SEC HQ Address:** ${[sec.businessAddress.street1, sec.businessAddress.city, sec.businessAddress.stateOrCountry, sec.businessAddress.zipCode].filter(Boolean).join(', ')}`
						: '',
					sec.formerNames?.length
						? `- **Former Names:** ${sec.formerNames.map((fn) => `${fn.name} (${String(fn.from || '').slice(0, 4)}–${String(fn.to || '').slice(0, 4)})`).join('; ')}`
						: '',
					'',
				].filter(Boolean)
			: [];

		const md = [
			`# ${wiki.title}`,
			'',
			`- **Track:** ${item.track}`,
			`- **Category:** ${item.profileType}`,
			`- **Region / Geo:** ${item.geo}`,
			`- **Source:** ${wiki.fullurl}`,
			wiki.wikibaseItem ? `- **Wikidata:** ${wiki.wikibaseItem}` : '',
			headings.length ? `- **Sections:** ${headings.slice(0, 15).join(' | ')}` : '',
			'',
			...secBlock,
			milestones.length ? '## Key Dated Milestones' : '',
			...milestones.map((m) => `- **${m.date}**: ${m.text}`),
			'',
			'## Article Text',
			'',
			wiki.extract.slice(0, 24000),
			'',
		]
			.filter((l) => l !== undefined)
			.join('\n');
		fs.writeFileSync(path.join(OUT, 'articles', `${slug}.md`), md, 'utf8');

		const aliases = [...(item.aliases || [])];
		if (sec?.name && sec.name.toLowerCase() !== wiki.title.toLowerCase()) aliases.push(sec.name);
		if (sec?.formerNames) {
			for (const fn of sec.formerNames.slice(0, 6)) {
				if (fn?.name) aliases.push(fn.name);
			}
		}

		const hqAddr = sec?.businessAddress?.city
			? [sec.businessAddress.city, sec.businessAddress.stateOrCountry].filter(Boolean).join(', ')
			: null;

		const profileRecord = {
			slug,
			wikiTitle: wiki.title,
			track: item.track,
			profileType: item.profileType,
			name: wiki.title,
			geo: item.geo,
			secHq: hqAddr,
			angle: item.angle,
			startDate: item.startDate || milestones[0]?.date || null,
			endDate: item.endDate || null,
			aliases: [...new Set(aliases)],
			cik: sec?.cik || item.cik || null,
			ticker: sec?.tickers?.[0] || item.ticker || null,
			wikibaseItem: wiki.wikibaseItem,
			sicDescription: sec?.sicDescription || null,
			employer: item.employer || null,
			role: item.role || null,
			url: wiki.fullurl,
			secUrl: sec?.sourceUrl || null,
			summary,
			charCount: wiki.extract.length,
			milestones,
		};
		seedProfiles.push(profileRecord);
		byTrack[item.track].push(profileRecord);

		for (let mIdx = 0; mIdx < milestones.length; mIdx++) {
			const m = milestones[mIdx];
			events.push({
				id: `reg-${slug}-${String(mIdx + 1).padStart(2, '0')}`,
				track: item.track,
				entity_slug: slug,
				entity_name: wiki.title,
				profile_type: item.profileType,
				date: m.date,
				precision: m.precision,
				angle: item.angle,
				geo: item.geo,
				text: m.text,
				url: wiki.fullurl,
			});
		}

		if ((i + 1) % 15 === 0 || i === MANIFEST.length - 1) {
			console.log(`[regional] progress ${i + 1}/${MANIFEST.length} last=${wiki.title} (${wiki.extract.length} chars)`);
		}
	}

	fs.writeFileSync(
		path.join(OUT, 'events', 'events.jsonl'),
		events.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf8',
	);
	fs.writeFileSync(
		path.join(OUT, 'profiles', 'seed-profiles.json'),
		JSON.stringify(seedProfiles, null, 2) + '\n',
		'utf8',
	);

	const totalChars = seedProfiles.reduce((a, p) => a + p.charCount, 0);
	const overview = [
		'# Regional History Corpus: NY/Boston Finance, Labor & Conflicts + DFW Military-Tech Companies',
		'',
		`- **Updated:** ${new Date().toISOString()}`,
		`- **Articles downloaded:** ${seedProfiles.length} (${(totalChars / 1_000_000).toFixed(2)} MB extracted text)`,
		`- **SEC EDGAR company profiles:** ${secCache.size}`,
		`- **Extracted dated timeline milestones:** ${events.length}`,
		'',
		'## Track Breakdown',
		'',
		`| Track | Articles | Key Entries |`,
		`| --- | ---: | --- |`,
		`| **NY & Boston Financial History** (\`ny_boston_finance\`) | ${byTrack.ny_boston_finance.length} | ${byTrack.ny_boston_finance.slice(0, 8).map((x) => x.name).join(', ')} |`,
		`| **NY & Boston Labor & Unions** (\`ny_boston_labor_unions\`) | ${byTrack.ny_boston_labor_unions.length} | ${byTrack.ny_boston_labor_unions.slice(0, 8).map((x) => x.name).join(', ')} |`,
		`| **NY & Boston Regional Conflicts** (\`ny_boston_conflicts\`) | ${byTrack.ny_boston_conflicts.length} | ${byTrack.ny_boston_conflicts.slice(0, 8).map((x) => x.name).join(', ')} |`,
		`| **DFW Military & Industrial Tech** (\`dfw_military_tech\`) | ${byTrack.dfw_military_tech.length} | ${byTrack.dfw_military_tech.slice(0, 10).map((x) => x.name).join(', ')} |`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'digests', 'OVERVIEW.md'), overview, 'utf8');

	const readme = `# Regional History Corpus (local)

Covers:
1. **New York & Boston Financial History** (\`ny_boston_finance\`)
2. **New York & Boston Labor & Union History** (\`ny_boston_labor_unions\`)
3. **New York & Boston Regional Conflicts** (\`ny_boston_conflicts\`)
4. **Dallas–Fort Worth Military, Defense & Industrial Tech Companies** (\`dfw_military_tech\`): Bell Textron, Halliburton, Rockwell Collins / Collins Aerospace, Emerson Electric, Tubacex, Lockheed Martin Aeronautics, Air Force Plant 4, Texas Instruments, Vought / LTV, L3Harris / E-Systems, RTX, General Dynamics.

## Layout
- \`raw/wiki/*.json\` — cached full English Wikipedia extracts
- \`raw/sec/*.json\` — cached SEC EDGAR corporate submissions metadata
- \`articles/*.md\` — structured per-topic markdown digests
- \`events/events.jsonl\` — ${events.length} extracted dated timeline milestones
- \`profiles/seed-profiles.json\` — structured entities for \`pnpm profiles:backfill\`
- \`digests/OVERVIEW.md\` — corpus rollup

## Search & Alignment
- Agent tool: \`search_regional_history\`
- Entity Profiles & Alignment: ingested via \`pnpm profiles:backfill\` into \`.data/profiles/profiles.sqlite\`.
`;
	fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

	console.log(
		`[regional] DONE articles=${seedProfiles.length} sec=${secCache.size} events=${events.length} text_mb=${(totalChars / 1_000_000).toFixed(2)}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
