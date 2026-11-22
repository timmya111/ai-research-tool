import fs from 'node:fs';
import path from 'node:path';

export type CountryMeta = {
	code: string;
	name: string;
	capital?: string;
	continent?: string;
	iso?: boolean;
};

let cachedCountryMap: Map<string, CountryMeta> | null = null;

/**
 * Load the local lipis/flag-icons country metadata from public/flags/country.json.
 */
export function getCountryMap(): Map<string, CountryMeta> {
	if (cachedCountryMap) return cachedCountryMap;
	const map = new Map<string, CountryMeta>();
	const jsonPath = path.join(process.cwd(), 'public', 'flags', 'country.json');
	try {
		if (fs.existsSync(jsonPath)) {
			const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as CountryMeta[];
			for (const r of rows) {
				if (r?.code && r?.name) {
					map.set(String(r.code).toLowerCase(), {
						code: String(r.code).toLowerCase(),
						name: String(r.name),
						capital: r.capital,
						continent: r.continent,
						iso: r.iso,
					});
				}
			}
		}
	} catch {
		/* ignore */
	}
	// Ensure key common entries exist even if file unavailable
	if (!map.has('us')) map.set('us', { code: 'us', name: 'United States of America', iso: true });
	if (!map.has('gb')) map.set('gb', { code: 'gb', name: 'United Kingdom', iso: true });
	if (!map.has('eu')) map.set('eu', { code: 'eu', name: 'Europe', iso: false });
	if (!map.has('un')) map.set('un', { code: 'un', name: 'United Nations', iso: false });
	cachedCountryMap = map;
	return map;
}

export function getCountryName(code: string): string {
	const c = String(code || '').toLowerCase();
	return getCountryMap().get(c)?.name || c.toUpperCase();
}

const VALID_ISIN_COUNTRIES = new Set([
	'us', 'gb', 'de', 'fr', 'es', 'it', 'ch', 'nl', 'be', 'se', 'no', 'dk', 'fi', 'at', 'ie', 'pt',
	'pl', 'cz', 'gr', 'lu', 'ca', 'jp', 'cn', 'kr', 'au', 'nz', 'sg', 'hk', 'tw', 'in', 'br', 'mx',
	'za', 'il', 'ae', 'sa', 'ru', 'ua', 'tr', 'ar', 'cl', 'co', 'ky', 'bm', 'je', 'gg', 'im',
]);

const US_STATE_ABBR_SET = new Set([
	'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
	'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
	'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
	'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const US_STATE_FULL_RE =
	/\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington,?\s*D\.?C\.?|West Virginia|Wisconsin|Wyoming)\b/i;

/**
 * Unambiguous country / demonym / major-city patterns for clear country association.
 * Ambiguous names (Georgia, Jordan, Chad, Jersey, Guinea, Mali, Niger, Oman, Togo, Benin, Turkey)
 * are handled carefully via structured fields or explicit qualifiers only.
 */
const COUNTRY_PATTERNS: Array<{ code: string; re: RegExp }> = [
	{
		code: 'us',
		re: /\b(?:United States(?: of America)?|U\.S\.A?\.|American|Americans|Washington,?\s*D\.?C\.?|New York City|Wall Street|Boston|Dallas|Fort Worth|Houston|Austin|Chicago|Los Angeles|San Francisco|Palo Alto|Silicon Valley|Philadelphia|Seattle|Denver|Atlanta|Miami|Detroit|Oklahoma City|Tulsa|Durant|Bryan County|Pentagon|U\.?S\.?\s+(?:Army|Navy|Air Force|Marine Corps|Marines|Coast Guard|Space Force|Senate|Congress|Department|Government|Federal)|Federal Reserve|Securities and Exchange Commission|FINRA|DARPA|NORTHCOM|NASA|CIA|FBI|CDC|FDA|NIH|FEMA|USGS|NOAA|Stanford(?:\s+(?:University|Law School))?|Harvard(?:\s+(?:University|College|Law School|Business School))?|Yale(?:\s+(?:University|Law School))?|Princeton(?:\s+University)?|Haverford College|Columbia University|Cornell University|Dartmouth College|Brown University|University of Pennsylvania|Wharton School|Massachusetts Institute of Technology|Caltech|Johns Hopkins|Duke University|Georgetown University|University of Chicago|Northwestern University|Carnegie Mellon|UC Berkeley|UCLA|NYU|UT Dallas|Ohio State)\b/i,
	},
	{
		code: 'gb',
		re: /\b(?:United Kingdom|Great Britain|British(?!\s+Columbia)|England(?!\s*,)|Scottish|Scotland|Wales(?!\s*,)|Welsh|Northern Ireland|London|Oxford(?:\s+University)?|University of Oxford|Cambridge(?:\s+University)?|University of Cambridge|Imperial College|London School of Economics|Manchester|Edinburgh|Birmingham,?\s*UK|Royal Navy|Royal Air Force|British Army|Imperial War Museums?|Bank of England|Parliament of the United Kingdom)\b/i,
	},
	{
		code: 'de',
		re: /\b(?:Germany|German|West Germany|East Germany|Berlin|Frankfurt|Munich|Hamburg|Cologne|Stuttgart|Düsseldorf|Bundeswehr|Goethe University|Heidelberg University|Siemens|Deutsche Bank)\b/i,
	},
	{
		code: 'es',
		re: /\b(?:Spain|Spanish|Madrid|Barcelona|Bilbao|Llodio|Basque Country|Álava|Alava|Seville|Valencia|Tubacex)\b/i,
	},
	{
		code: 'fr',
		re: /\b(?:France|French|Paris|Lyon|Marseille|Toulouse|Sorbonne|École|French Army|French Navy)\b/i,
	},
	{
		code: 'ru',
		re: /\b(?:Russia|Russian|Soviet Union|USSR|Moscow|Novosibirsk|Saint Petersburg|St\.?\s*Petersburg,?\s*Russia|Siberia|Russian Academy|ITMO|Kremlin|Red Army)\b/i,
	},
	{
		code: 'cn',
		re: /\b(?:China|Chinese|People'?s Republic of China|Beijing|Shanghai|Wuhan|Shenzhen|Guangzhou|Tsinghua|Peking University)\b/i,
	},
	{
		code: 'ca',
		re: /\b(?:Canada|Canadian|Toronto|Montreal|Montréal|Vancouver|Ottawa|Calgary|Quebec|Québec|Ontario|British Columbia|Alberta|Queen'?s University|McGill University|University of Toronto|University of Waterloo)\b/i,
	},
	{
		code: 'za',
		re: /\b(?:South Africa|South African|Pretoria|Johannesburg|Cape Town)\b/i,
	},
	{
		code: 'nz',
		re: /\b(?:New Zealand|Auckland|Wellington,?\s*New Zealand|Christchurch)\b/i,
	},
	{
		code: 'au',
		re: /\b(?:Australia|Australian|Sydney|Melbourne|Canberra|Brisbane|Perth,?\s*Australia)\b/i,
	},
	{
		code: 'il',
		re: /\b(?:Israel|Israeli|Tel Aviv|Jerusalem|Haifa|Technion)\b/i,
	},
	{
		code: 'ua',
		re: /\b(?:Ukraine|Ukrainian|Kyiv|Kiev|Kharkiv|Odesa|Odessa|Crimea|Donbas)\b/i,
	},
	{
		code: 'ch',
		re: /\b(?:Switzerland|Swiss|Zurich|Zürich|Geneva|Basel|Bern|ETH Zurich|CERN)\b/i,
	},
	{
		code: 'it',
		re: /\b(?:Italy|Italian|Rome|Milan|Turin|Naples|Florence|Venice|Bologna|INFN)\b/i,
	},
	{
		code: 'jp',
		re: /\b(?:Japan|Japanese|Tokyo|Kyoto|Osaka|Yokohama|Nagoya)\b/i,
	},
	{
		code: 'kr',
		re: /\b(?:South Korea|South Korean|Republic of Korea|Seoul|Busan)\b/i,
	},
	{
		code: 'kp',
		re: /\b(?:North Korea|North Korean|Pyongyang|DPRK)\b/i,
	},
	{
		code: 'in',
		re: /\b(?:India|Indian(?!\s+(?:Territory|Nation|Reservation|Affairs|Ocean))|New Delhi|Mumbai|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata)\b/i,
	},
	{
		code: 'nl',
		re: /\b(?:Netherlands|Dutch|Amsterdam|Rotterdam|The Hague|Utrecht|Eindhoven)\b/i,
	},
	{
		code: 'be',
		re: /\b(?:Belgium|Belgian|Brussels|Antwerp|Ghent)\b/i,
	},
	{
		code: 'se',
		re: /\b(?:Sweden|Swedish|Stockholm|Gothenburg|Uppsala)\b/i,
	},
	{
		code: 'no',
		re: /\b(?:Norway|Norwegian|Oslo|Bergen)\b/i,
	},
	{
		code: 'dk',
		re: /\b(?:Denmark|Danish|Copenhagen)\b/i,
	},
	{
		code: 'fi',
		re: /\b(?:Finland|Finnish|Helsinki)\b/i,
	},
	{
		code: 'ie',
		re: /\b(?:Republic of Ireland|Ireland|Irish|Dublin|Cork)\b/i,
	},
	{
		code: 'at',
		re: /\b(?:Austria|Austrian|Vienna|Graz|Salzburg)\b/i,
	},
	{
		code: 'pl',
		re: /\b(?:Poland|Polish|Warsaw|Kraków|Krakow|Gdańsk)\b/i,
	},
	{
		code: 'cz',
		re: /\b(?:Czech Republic|Czechia|Czech|Prague)\b/i,
	},
	{
		code: 'hu',
		re: /\b(?:Hungary|Hungarian|Budapest)\b/i,
	},
	{
		code: 'gr',
		re: /\b(?:Greece|Greek|Athens,?\s*Greece|Thessaloniki)\b/i,
	},
	{
		code: 'pt',
		re: /\b(?:Portugal|Portuguese|Lisbon|Porto)\b/i,
	},
	{
		code: 'kz',
		re: /\b(?:Kazakhstan|Kazakh|Astana|Almaty|Nazarbayev)\b/i,
	},
	{
		code: 'iq',
		re: /\b(?:Iraq|Iraqi|Baghdad|Basra|Mosul|Fallujah)\b/i,
	},
	{
		code: 'af',
		re: /\b(?:Afghanistan|Afghan|Kabul|Kandahar|Helmand)\b/i,
	},
	{
		code: 'sy',
		re: /\b(?:Syria|Syrian|Damascus|Aleppo)\b/i,
	},
	{
		code: 'ye',
		re: /\b(?:Yemen|Yemeni|Sanaa|Aden)\b/i,
	},
	{
		code: 'ly',
		re: /\b(?:Libya|Libyan|Tripoli|Benghazi)\b/i,
	},
	{
		code: 'ir',
		re: /\b(?:Iran|Iranian|Tehran|Persia|Persian)\b/i,
	},
	{
		code: 'sa',
		re: /\b(?:Saudi Arabia|Saudi|Riyadh|Jeddah)\b/i,
	},
	{
		code: 'ae',
		re: /\b(?:United Arab Emirates|U\.?A\.?E\.?|Dubai|Abu Dhabi|Emirati)\b/i,
	},
	{
		code: 'eg',
		re: /\b(?:Egypt|Egyptian|Cairo|Alexandria,?\s*Egypt)\b/i,
	},
	{
		code: 'tr',
		re: /\b(?:Republic of Turkey|Türkiye|Turkish|Istanbul|Ankara|Ottoman)\b/i,
	},
	{
		code: 'ba',
		re: /\b(?:Bosnia(?:\s+and\s+Herzegovina)?|Bosnian|Sarajevo|Srebrenica)\b/i,
	},
	{
		code: 'xk',
		re: /\b(?:Kosovo|Kosovar|Pristina|Prishtina)\b/i,
	},
	{
		code: 'rs',
		re: /\b(?:Serbia|Serbian|Belgrade|Yugoslavia|Yugoslav)\b/i,
	},
	{
		code: 'hr',
		re: /\b(?:Croatia|Croatian|Zagreb)\b/i,
	},
	{
		code: 'sl',
		re: /\b(?:Sierra Leone|Sierra Leonean|Freetown)\b/i,
	},
	{
		code: 'kw',
		re: /\b(?:Kuwait|Kuwaiti)\b/i,
	},
	{
		code: 'vn',
		re: /\b(?:Vietnam|Vietnamese|Hanoi|Saigon|Ho Chi Minh City)\b/i,
	},
	{
		code: 'fk',
		re: /\b(?:Falkland Islands|Falklands|Malvinas)\b/i,
	},
	{
		code: 'ar',
		re: /\b(?:Argentina|Argentine|Argentinian|Buenos Aires)\b/i,
	},
	{
		code: 'br',
		re: /\b(?:Brazil|Brazilian|São Paulo|Rio de Janeiro|Brasília)\b/i,
	},
	{
		code: 'mx',
		re: /\b(?:(?<!New\s)Mexico|Mexican|Mexico City|Monterrey|Guadalajara)\b/i,
	},
	{
		code: 'sg',
		re: /\b(?:Singapore|Singaporean)\b/i,
	},
	{
		code: 'hk',
		re: /\b(?:Hong Kong)\b/i,
	},
	{
		code: 'tw',
		re: /\b(?:Taiwan|Taiwanese|Taipei)\b/i,
	},
	{
		code: 'pk',
		re: /\b(?:Pakistan|Pakistani|Islamabad|Karachi|Lahore)\b/i,
	},
	{
		code: 'my',
		re: /\b(?:Malaysia|Malaysian|Kuala Lumpur|Malaya|Malayan)\b/i,
	},
	{
		code: 'ke',
		re: /\b(?:Kenya|Kenyan|Nairobi|Mau Mau)\b/i,
	},
	{
		code: 'cy',
		re: /\b(?:Cyprus|Cypriot|Nicosia)\b/i,
	},
	{
		code: 'so',
		re: /\b(?:Somalia|Somali|Mogadishu)\b/i,
	},
	{
		code: 'rw',
		re: /\b(?:Rwanda|Rwandan|Kigali)\b/i,
	},
	{
		code: 'sd',
		re: /\b(?:Sudan|Sudanese|Khartoum|Darfur)\b/i,
	},
	{
		code: 'et',
		re: /\b(?:Ethiopia|Ethiopian|Addis Ababa)\b/i,
	},
	{
		code: 'ng',
		re: /\b(?:Nigeria|Nigerian|Lagos|Abuja)\b/i,
	},
	{
		code: 'lb',
		re: /\b(?:Lebanon(?!,\s*[A-Z]{2})|Lebanese|Beirut)\b/i,
	},
	{
		code: 'ps',
		re: /\b(?:State of Palestine|Palestine|Palestinian)\b/i,
	},
	{
		code: 'cu',
		re: /\b(?:Cuba|Cuban|Havana)\b/i,
	},
	{
		code: 've',
		re: /\b(?:Venezuela|Venezuelan|Caracas)\b/i,
	},
	{
		code: 'co',
		re: /\b(?:Colombia|Colombian|Bogotá|Bogota)\b/i,
	},
	{
		code: 'cl',
		re: /\b(?:Chile|Chilean|Santiago,?\s*Chile)\b/i,
	},
	{
		code: 'eu',
		re: /\b(?:European Union|European Commission|European Parliament)\b/i,
	},
	{
		code: 'un',
		re: /\b(?:United Nations|UNESCO|UNICEF|World Health Organization|IAEA)\b/i,
	},
];

// Direct exact country name -> ISO code lookup built from country.json
let exactNameToCode: Map<string, string> | null = null;
function getExactNameToCode(): Map<string, string> {
	if (exactNameToCode) return exactNameToCode;
	const m = new Map<string, string>();
	for (const [code, meta] of getCountryMap().entries()) {
		m.set(meta.name.toLowerCase(), code);
	}
	// Common aliases for structured country fields
	m.set('us', 'us');
	m.set('usa', 'us');
	m.set('u.s.', 'us');
	m.set('u.s.a.', 'us');
	m.set('united states', 'us');
	m.set('united states of america', 'us');
	m.set('uk', 'gb');
	m.set('u.k.', 'gb');
	m.set('britain', 'gb');
	m.set('great britain', 'gb');
	m.set('england', 'gb');
	m.set('russia', 'ru');
	m.set('south korea', 'kr');
	m.set('north korea', 'kp');
	m.set('vietnam', 'vn');
	m.set('iran', 'ir');
	m.set('syria', 'sy');
	m.set('taiwan', 'tw');
	m.set('uae', 'ae');
	m.set('czech republic', 'cz');
	m.set('bosnia', 'ba');
	m.set('kosovo', 'xk');
	exactNameToCode = m;
	return m;
}

function scanTextForCountries(text: string, add: (code: string, weight: number) => void, weight: number): void {
	const raw = String(text || '').trim();
	if (!raw) return;
	// Clean out "New England" / "New Mexico" / "New South Wales" / "British Columbia" and pronunciation tags like "Canadian French:"
	const sanitized = raw
		.replace(/\b(?:Canadian|Quebec|Swiss|Belgian|Louisiana|Cajun)\s+French\b/gi, 'Lang_Fr')
		.replace(/\b(?:French|German|Spanish|Italian|Russian|Chinese|Japanese|Arabic|Dutch|Polish|Portuguese|Greek|Turkish)\s*:/gi, 'Lang_Pron:')
		.replace(/\bNew England\b/gi, 'New_Eng_US')
		.replace(/\bNew Mexico\b/gi, 'New_Mex_US')
		.replace(/\bNew South Wales\b/gi, 'NSW_AU')
		.replace(/\bNew Jersey\b/gi, 'New_Jer_US')
		.replace(/\bBritish Columbia\b/gi, 'BC_Canada');

	if (/\b(?:New_Eng_US|New_Mex_US|New_Jer_US)\b/.test(sanitized)) add('us', weight);
	if (/\bNSW_AU\b/.test(sanitized)) add('au', weight);
	if (/\bBC_Canada\b/.test(sanitized)) add('ca', weight);
	if (US_STATE_FULL_RE.test(sanitized)) add('us', weight);

	for (const { code, re } of COUNTRY_PATTERNS) {
		if (re.test(sanitized)) {
			add(code, weight);
		}
	}
}

export type DetectCountryInput = {
	name: string;
	profileType?: string;
	summary?: string;
	locations?: Array<{
		raw?: string | null;
		city?: string | null;
		state?: string | null;
		country?: string | null;
		geoKey?: string | null;
	}>;
	identifiers?: Array<{ scheme: string; value: string }>;
	metadata?: Record<string, unknown>;
};

/**
 * Determine clear country associations (single or multiple for multinational entities)
 * returning lowercase ISO/flag-icons codes verified to exist in public/flags/4x3/.
 */
export function detectProfileCountryCodes(input: DetectCountryInput): string[] {
	const validMap = getCountryMap();
	const exactNames = getExactNameToCode();
	const weights = new Map<string, number>();

	const add = (codeRaw: string, w: number) => {
		const c = String(codeRaw || '').trim().toLowerCase();
		if (!c || !validMap.has(c)) return;
		weights.set(c, (weights.get(c) || 0) + w);
	};

	const meta = input.metadata || {};

	// 0. If explicit manual countryCodes override exists in metadata, honor it
	if (Array.isArray(meta.manualCountryCodes) && meta.manualCountryCodes.length > 0) {
		return [...new Set(meta.manualCountryCodes.map((c) => String(c).toLowerCase()).filter((c) => validMap.has(c)))].slice(0, 8);
	}

	// 1. Structured locations (highest signal!)
	for (const loc of input.locations || []) {
		const gk = String(loc.geoKey || '').toLowerCase();
		if (gk.startsWith('us:')) {
			add('us', 4);
		} else if (gk.startsWith('country:')) {
			const slug = gk.slice('country:'.length).replace(/-/g, ' ');
			const mapped = exactNames.get(slug);
			if (mapped) add(mapped, 4);
		}
		if (loc.state && US_STATE_ABBR_SET.has(String(loc.state).toUpperCase())) {
			add('us', 3);
		}
		if (loc.country) {
			const cNorm = String(loc.country).trim().toLowerCase();
			const mapped = exactNames.get(cNorm);
			if (mapped) add(mapped, 4);
			else scanTextForCountries(loc.country, add, 3);
		}
		if (loc.raw) {
			scanTextForCountries(loc.raw, add, 3);
		}
	}

	// 2. Structured identifiers (US regulatory IDs & ISIN prefix)
	for (const id of input.identifiers || []) {
		if (id.scheme === 'finra_crd' || id.scheme === 'irs_ein' || id.scheme === 'okcr_instrument' || id.scheme === 'spc_om') {
			add('us', 3);
		} else if (id.scheme === 'sec_cik') {
			add('us', 2);
		}
	}
	if (typeof meta.isin === 'string' && meta.isin.trim().length >= 2) {
		const isinPrefix = meta.isin.trim().slice(0, 2).toLowerCase();
		if (VALID_ISIN_COUNTRIES.has(isinPrefix)) add(isinPrefix, 5);
	}

	// 3. Explicit structured metadata (citizenship, jurisdiction, militaryBranch, eventLocation, belligerents, wikipediaCategories)
	for (const [k, w] of [
		['citizenship', 5],
		['jurisdiction', 4],
		['militaryBranch', 4],
		['parentAgency', 3],
		['eventLocation', 4],
		['belligerents', 2],
	] as const) {
		const v = meta[k];
		if (typeof v === 'string' && v.trim()) {
			// Also split comma/semicolon lists for exact country names (e.g. citizenship: "United States, Germany, New Zealand")
			for (const part of v.split(/[,;/·\n]+/)) {
				const mapped = exactNames.get(part.trim().toLowerCase());
				if (mapped) add(mapped, w);
			}
			scanTextForCountries(v, add, w);
		}
	}

	if (Array.isArray(meta.wikipediaCategories)) {
		const catText = meta.wikipediaCategories
			.map(String)
			.filter((c) => {
				if (/^(?:Articles|All articles|CS1|Use |Short description|Wikipedia|All Wikipedia)/i.test(c)) return false;
				// For people, attending a university abroad ("... alumni") does not establish nationality/country association
				if (input.profileType === 'person' && /\b(?:alumni|students|faculty|fellows)\b/i.test(c)) return false;
				return true;
			})
			.join(' ; ');
		scanTextForCountries(catText, add, 2);
	}

	// 4. Entity Name (strong signal for explicit national orgs & historic events)
	scanTextForCountries(input.name, add, 4);

	// 5. Lead sentence of Summary ONLY (first sentence for people so bio education/travel doesn't add false flags;
	// first ~340 chars for orgs/events where HQ and operations appear)
	const summaryRaw = String(input.summary || '').trim();
	if (summaryRaw) {
		let summaryLead = summaryRaw.slice(0, 340);
		if (input.profileType === 'person') {
			const firstSentMatch = summaryRaw.match(/^.{30,260}?[.!?](?:\s|$)/);
			summaryLead = firstSentMatch ? firstSentMatch[0] : summaryRaw.slice(0, 200);
		}
		scanTextForCountries(summaryLead, add, 2.5);
	}

	// 6. Corpus-level fallback ONLY when profile is unambiguously US-domestic (e.g. county filings, FINRA, CDC/DoD US timelines)
	if (weights.size === 0 && Array.isArray(meta.corpora)) {
		const corpora = meta.corpora.map(String);
		if (
			corpora.some((c) =>
				/^(?:finra-sidecar|finra-brokercheck|bryan-ucc|dallas-deeds|authority-timelines|twdb-trinity|tornado-spc|seismic-usgs)$/i.test(
					c,
				),
			)
		) {
			add('us', 2);
		}
	}

	// Sort by strength descending; filter out weak incidental mentions (weight < 2)
	const ranked = [...weights.entries()]
		.filter(([, w]) => w >= 2)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([code]) => code);

	// Cap at 6 flags for clean visual display
	return ranked.slice(0, 6);
}
