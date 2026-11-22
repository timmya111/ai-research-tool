import crypto from 'node:crypto';
import type { ActorProfileType, ProfileType } from '@/lib/research/profiles/types';

export function normalizeText(input: string): string {
	return String(input || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export function slugifyPart(input: string, maxLen = 84): string {
	const s = normalizeText(input).replace(/\s+/g, '-');
	if (!s) return 'unknown';
	if (s.length <= maxLen) return s;
	const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
	return `${s.slice(0, maxLen - 9)}-${hash}`;
}

export function makeProfileSlug(profileType: ProfileType, nameOrSlug: string): string {
	const raw = String(nameOrSlug || '').trim();
	if (raw.startsWith(`${profileType}:`)) {
		return `${profileType}:${slugifyPart(raw.slice(profileType.length + 1))}`;
	}
	return `${profileType}:${slugifyPart(raw)}`;
}

export function sha256Key(parts: Array<string | number | null | undefined>): string {
	const joined = parts.map((p) => String(p ?? '').trim()).join('|');
	return crypto.createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Strip common corporate / institutional suffixes for secondary alias matching.
 */
export function stripLegalSuffixes(name: string): string {
	const norm = normalizeText(name);
	return norm
		.replace(
			/\b(inc|incorporated|llc|l l c|lp|l p|llp|corp|corporation|co|company|ltd|limited|plc|holdings|group|technologies|tech|financial|partners|international|global)\b/g,
			' ',
		)
		.replace(/\s+/g, ' ')
		.trim();
}

const MEDICAL_HOSPITAL_RE =
	/\b(hospital|medical\s+center|medical\s+centre|health\s+system|healthcare\s+system|health\s+center|health\s+centre|infirmary|clinic\b|mayo\s+clinic|cleveland\s+clinic|va\s+medical|children'?s\s+hospital|general\s+hospital|memorial\s+hospital|regional\s+medical|surgical\s+center|trauma\s+center|cancer\s+center|maternity\s+hospital|psychiatric\s+(?:hospital|center|centre|institute|clinic|facility)|behavioral\s+health\s+(?:hospital|center|centre|system)|asylum|sanitarium|sanatorium|neuropsychiatric|mental\s+health\s+(?:hospital|center|centre|institute|facility|authority))\b/i;

const EDUCATION_RE =
	/\b(universit[a-z]*|college|polytechnic|mit\b|caltech|eth\s+zurich|itmo|sorbonne|stanford|harvard|oxford|cambridge|princeton|yale|columbia\s+univ|berkeley|nyu\b|ucla\b|ut\s+dallas|nazarbayev|novosibirsk\s+state|moscow\s+institute\s+of\s+physics|technion|imperial\s+college|tsinghua|peking\s+univ|kyoto\s+univ|tokyo\s+institute\s+of\s+technology|faculty\s+of|school\s+district|independent\s+school|public\s+schools|board\s+of\s+education|high\s+school|middle\s+school|elementary\s+school|prep(?:aratory)?\s+school|school\s+of\b|conservatory|seminary|educational\s+(?:trust|foundation|institute|board|system|services)|education\s+(?:board|district|network|system)|academy\s+of\s+(?!sciences|medicine)|k-?12|charter\s+school|montessori|lyceum|gymnasium|edtech|teaching\s+institute)\b/i;

const US_GOVERNMENT_RE =
	/\b(u\.?s\.?\s+(?:department|dept|army|navy|air\s+force|marines|coast\s+guard|customs|border|marshals|secret\s+service|treasury|justice|state|defense|health|geological|government|federal|senate|congress|house\s+of\s+representatives)|united\s+states\s+(?:department|government|army|navy|air\s+force|secret\s+service|senate|congress)|federal\s+(?:bureau|reserve|trade|communications|aviation|emergency|agency|commission|administration|government)|white\s+house|\bcdc\b|centers\s+for\s+disease\s+control|\bhhs\b|health\s+and\s+human\s+services|\bdod\b|department\s+of\s+defense|\bdhs\b|homeland\s+security|\bice\b|immigration\s+and\s+customs|\bdea\b|drug\s+enforcement|\bcbp\b|customs\s+and\s+border|\bfbi\b|\batf\b|\busss\b|\bdoj\b|\bfda\b|food\s+and\s+drug\s+administration|\bnih\b|national\s+institutes\s+of\s+health|\bniaid\b|\bfema\b|\bnoaa\b|national\s+oceanic|\busgs\b|\bsec\b|securities\s+and\s+exchange\s+commission|\bnasa\b|\bdarpa\b|\bbarda\b|\bnorthcom\b|national\s+guard|\bngb\b|pentagon|war\.gov|central\s+intelligence\s+agency|\bcia\b|\bnsa\b|veterans\s+affairs|internal\s+revenue\s+service|\birs\b|environmental\s+protection\s+agency|\bepa\b|operation\s+warp\s+speed|texas\s+water\s+development\s+board|\btwdb\b|city\s+of\s+(?:atlanta|dallas|austin|houston|oklahoma\s+city|tulsa|durant|new\s+york|chicago|los\s+angeles|san\s+francisco|seattle|boston|miami|denver|phoenix)|state\s+of\s+(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming)|(?:texas|oklahoma|california|new\s+york|florida|illinois|virginia|ohio|georgia|michigan|pennsylvania|north\s+carolina|arizona|colorado|washington|massachusetts|minnesota|missouri|tennessee|indiana|maryland|wisconsin|oregon|nevada|kansas|arkansas|louisiana|alabama|utah|iowa|kentucky|new\s+mexico)\s+(?:department|dept|commission|board|agency|legislature|senate|house|supreme\s+court|attorney\s+general|treasurer|comptroller|governor|state\s+police|highway\s+patrol|health\s+department|water\s+board)|state\s+(?:department\s+of|commission|board\s+of|legislature|senate|assembly|treasurer|comptroller|attorney\s+general|health\s+department|governor|agency|authority)|county\s+(?:clerk|commissioner|sheriff|assessor|treasurer|court|board|government))\b/i;

const FOREIGN_GOV_RE =
	/\b(ministry\s+of|government\s+of|department\s+of|bureau\s+of|agency|administration|commission|state\s+committee|municipal|city\s+of\s+|parliament|national\s+assembly|embassy|consulate|central\s+bank|bank\s+of\s+england|european\s+commission|european\s+parliament)\b/i;

const NONPROFIT_RE =
	/\b(foundation|non[- ]?profit|ngo|charity|charitable|trust|society|association|institute|institution|academy|consortium|alliance|coalition|council|forum|world\s+health\s+organization|\bwho\b|united\s+nations|\bun\b|unesco|unicef|iaea|red\s+cross|bill\s*&\s*melinda|rockefeller\s+foundation|gates\s+foundation|open\s+society|brookings|rand\s+corporation|cern|infn|joint\s+institute|ras\b|russian\s+academy|isde|world\s+economic\s+forum|wef|church|baptist|methodist|catholic|synagogue|mosque|mission|relief|civic|museum|observatory|laboratory|laboratori|center\s+for|centre\s+for)\b/i;

const FIRM_RE =
	/\b(llc|l\.l\.c\.|inc\.?|corp\.?|corporation|ltd\.?|limited|plc|gmbh|s\.a\.|co\.|company|capital|ventures|partners|holdings|bank|financial|securities|advisors|advisers|investments|management|pharma|pharmaceuticals|therapeutics|biotech|biosciences|labs|systems|solutions|technologies|consulting|energy|oil|gas|realty|properties|restaurants|games|enterprises|industries|manufacturing|logistics|airlines|telecom|media|studios|group)\b/i;

/**
 * Heuristically classify an organization name into:
 * medical_hospital | education | government | foreign | nonprofit | firm.
 */
export function classifyOrgType(
	name: string,
	hint?: string | null,
): Exclude<ActorProfileType, 'person'> {
	const rawHint = String(hint || '').toLowerCase().trim();
	if (rawHint === 'medical_hospital' || rawHint === 'medical_mental_hospital' || rawHint === 'hospital' || rawHint === 'medical') {
		return 'medical_hospital';
	}
	if (rawHint === 'education' || rawHint === 'university' || rawHint === 'academic' || rawHint === 'school') {
		return 'education';
	}
	if (rawHint === 'government' || rawHint === 'gov' || rawHint === 'federal_gov' || rawHint === 'state_gov' || rawHint === 'federal' || rawHint === 'state') {
		return 'government';
	}
	if (rawHint === 'nonprofit' || rawHint === 'non-profit' || rawHint === 'ngo' || rawHint === 'foundation') {
		return 'nonprofit';
	}
	if (rawHint === 'foreign' || rawHint === 'foreign_gov' || rawHint === 'agency') {
		if (US_GOVERNMENT_RE.test(name)) return 'government';
		return 'foreign';
	}
	if (rawHint === 'firm' || rawHint === 'company' || rawHint === 'business') return 'firm';

	const hay = `${name} ${rawHint}`;
	// 1. Medical hospitals & health centers (avoid "Hospitality")
	if (MEDICAL_HOSPITAL_RE.test(hay) && !/\bhospitality\b/i.test(hay)) return 'medical_hospital';
	// 2. Education (universities, colleges, schools, districts, boards)
	if (EDUCATION_RE.test(hay)) return 'education';
	// 3. Domestic government (federal + state + local) vs Foreign gov/agency
	if (US_GOVERNMENT_RE.test(hay)) return 'government';
	if (FOREIGN_GOV_RE.test(hay) && !/\b(co\.?\s*ltd|llc|inc\.?|corp\.?|plc|gmbh)\b/i.test(hay)) {
		return 'foreign';
	}
	// 4. Commercial firms vs nonprofits
	if (FIRM_RE.test(hay) && !/\b(foundation|society|association|non[- ]?profit|church|charity|museum)\b/i.test(hay)) {
		return 'firm';
	}
	if (NONPROFIT_RE.test(hay)) return 'nonprofit';
	return 'firm';
}

const US_STATE_ABBR: Record<string, string> = {
	alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
	colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
	hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
	kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
	massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
	montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
	'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
	oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
	'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
	virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
	'district of columbia': 'DC',
};

export function normalizeUsState(input?: string | null): string | null {
	const raw = String(input || '').trim();
	if (!raw) return null;
	if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
	const mapped = US_STATE_ABBR[raw.toLowerCase()];
	return mapped || raw.toUpperCase().slice(0, 24);
}

/**
 * Build a deterministic normalized geo key for fast geographic overlap joins.
 * Examples: `us:ok:county:bryan`, `us:tx:city:dallas`, `country:russia`, `raw:wuhan-china`
 */
export function normalizeGeoKey(input: {
	raw?: string | null;
	city?: string | null;
	county?: string | null;
	state?: string | null;
	country?: string | null;
}): string {
	const state = normalizeUsState(input.state);
	const countryRaw = String(input.country || '').trim();
	const country =
		countryRaw && /^(us|usa|united states|united states of america)$/i.test(countryRaw)
			? 'us'
			: countryRaw
				? slugifyPart(countryRaw, 32)
				: state && Object.values(US_STATE_ABBR).includes(state)
					? 'us'
					: '';

	const county = input.county ? slugifyPart(String(input.county).replace(/\s+county$/i, ''), 32) : '';
	const city = input.city ? slugifyPart(String(input.city), 32) : '';

	if (country === 'us' && state) {
		if (county) return `us:${state.toLowerCase()}:county:${county}`;
		if (city) return `us:${state.toLowerCase()}:city:${city}`;
		return `us:${state.toLowerCase()}`;
	}
	if (country) {
		if (city) return `${country}:city:${city}`;
		return `country:${country}`;
	}
	if (city) return `city:${city}`;
	if (county) return `county:${county}`;
	return `raw:${slugifyPart(input.raw || 'unknown', 48)}`;
}

const VALID_US_STATES = new Set(Object.values(US_STATE_ABBR));

function toTitleCaseSegment(seg: string): string {
	const s = seg.trim();
	if (!s) return '';
	// Only re-case ALL CAPS or all lowercase segments; preserve mixed case like "McLean" or "LaSalle"
	const isAllUpper = s === s.toUpperCase() && /[A-Z]/.test(s) && s.length > 2;
	const isAllLower = s === s.toLowerCase() && /[a-z]/.test(s);
	if (!isAllUpper && !isAllLower) return s;
	const keepUpper = new Set(['NW', 'NE', 'SW', 'SE', 'PO', 'WTC', 'AFB', 'NAS', 'JRB', 'US', 'UK', 'DC', 'NYC']);
	const keepLower = new Set(['of', 'the', 'and', 'de', 'la', 'del', 'in', 'on', 'at']);
	return s
		.toLowerCase()
		.split(/(\s+|-)/)
		.map((part, idx) => {
			if (!part || /^[\s-]+$/.test(part)) return part;
			const up = part.toUpperCase();
			if (keepUpper.has(up)) return up;
			if (idx > 0 && keepLower.has(part)) return part;
			return part[0].toUpperCase() + part.slice(1);
		})
		.join('');
}

/**
 * Clean and standardize an address / location string into a consistent naming convention:
 * - US street/neighborhood: "<Detail>, <City>, <ST>" (e.g. "30 Park Place, New York, NY")
 * - US city: "<City>, <ST>" (e.g. "New York, NY", "Washington, DC", "Dallas, TX")
 * - US county: "<Name> County, <ST>" (e.g. "Bryan County, OK")
 * - International: clean comma spacing ("Montreal, Quebec, Canada", "Frankfurt, Germany")
 */
export function normalizeLocationRecord(input: {
	raw?: string | null;
	city?: string | null;
	county?: string | null;
	state?: string | null;
	country?: string | null;
}): {
	raw: string;
	city: string | null;
	county: string | null;
	state: string | null;
	country: string | null;
	geoKey: string;
} {
	const rawClean = String(input.raw || '')
		.replace(/\s+,/g, ',')
		.replace(/,\s*,+/g, ',')
		.replace(/\s+/g, ' ')
		.replace(/^[,;\s-]+|[,;\s-]+$/g, '')
		.trim();

	let city = input.city ? toTitleCaseSegment(String(input.city)) : null;
	let county = input.county ? toTitleCaseSegment(String(input.county)) : null;
	let state = input.state ? normalizeUsState(input.state) : null;
	let country = input.country ? String(input.country).trim() : null;

	if (rawClean) {
		// Split by commas and normalize parts
		const parts = rawClean
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);

		// Strip trailing ", U.S." / ", USA" / ", United States" when we have US state/city context
		let trailingIsUs = false;
		if (parts.length >= 2 && /^(?:u\.?s\.?a?\.?|united states(?: of america)?)$/i.test(parts[parts.length - 1])) {
			trailingIsUs = true;
			parts.pop();
			country = 'US';
		}

		// Handle "Washington, D.C."
		if (parts.length >= 2 && /^washington$/i.test(parts[0]) && /^d\.?c\.?$/i.test(parts[1])) {
			city = 'Washington';
			state = 'DC';
			country = 'US';
			parts.splice(0, 2, 'Washington', 'DC');
		}

		// Handle standalone "New York City" (with or without trailing US / NY)
		for (let i = 0; i < parts.length; i++) {
			if (/^new york city$/i.test(parts[i])) {
				parts[i] = 'New York';
				if (!state && (trailingIsUs || i === parts.length - 1)) {
					state = 'NY';
					country = 'US';
				}
			}
		}

		// If "New York" ended up without state after stripping ", U.S.", add ", NY" BEFORE state abbreviation check
		if (parts.length === 1 && parts[0].toLowerCase() === 'new york' && (state === 'NY' || trailingIsUs)) {
			parts.push('NY');
			state = 'NY';
			country = 'US';
		}

		// Check if last part is a US state (only when parts.length >= 2, so standalone city/state isn't collapsed to bare 2-letter code)
		const lastPart = parts.length >= 2 ? parts[parts.length - 1] : '';
		const stateZipM = lastPart.match(/^([A-Za-z ]+?)(?:\s+(\d{5}(?:-\d{4})?))?$/);
		if (stateZipM) {
			const maybeState = stateZipM[1].trim();
			const zip = stateZipM[2] || '';
			const mapped =
				maybeState.length === 2 && VALID_US_STATES.has(maybeState.toUpperCase())
					? maybeState.toUpperCase()
					: US_STATE_ABBR[maybeState.toLowerCase()] || null;
			if (mapped) {
				state = mapped;
				country = 'US';
				parts[parts.length - 1] = zip ? `${mapped} ${zip}` : mapped;
			}
		}
		// Prevent duplicate "New York, New York, NY" -> "New York, NY"
		if (parts.length >= 2 && parts[parts.length - 1] === 'NY' && parts[parts.length - 2].toLowerCase() === 'new york') {
			if (parts.length >= 3 && parts[parts.length - 3].toLowerCase() === 'new york') {
				parts.splice(parts.length - 3, 1);
			}
		}

		// Title-case non-state segments cleanly
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			if (/^[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(p)) continue;
			parts[i] = toTitleCaseSegment(p);
		}

		// Infer city / county from normalized parts when missing
		if (state && VALID_US_STATES.has(state)) {
			country = 'US';
			const beforeState = parts.length >= 2 ? parts[parts.length - 2] : '';
			const countyM = beforeState.match(/^(.+?)\s+County$/i);
			if (countyM) {
				county = county || countyM[1].trim();
			} else if (beforeState && !/^\d/.test(beforeState)) {
				city = beforeState;
			}
		}

		if (city && /^new york city$/i.test(city)) city = 'New York';

		const formattedRaw = parts.join(', ');
		const geoKey = normalizeGeoKey({ raw: formattedRaw, city, county, state, country });
		return {
			raw: formattedRaw || rawClean,
			city,
			county,
			state,
			country,
			geoKey,
		};
	}

	// Fallback if only structured fields were provided
	if (city && /^new york city$/i.test(city)) city = 'New York';
	const fallbackParts: string[] = [];
	if (county) fallbackParts.push(`${county} County`);
	else if (city) fallbackParts.push(city);
	if (state) fallbackParts.push(state);
	else if (country) fallbackParts.push(country);
	const formatted = fallbackParts.join(', ') || 'Unknown';
	return {
		raw: formatted,
		city,
		county,
		state,
		country: country || (state && VALID_US_STATES.has(state) ? 'US' : null),
		geoKey: normalizeGeoKey({ raw: formatted, city, county, state, country }),
	};
}

const LOCATION_ROLE_PRIORITY: Record<string, number> = {
	hq: 7,
	residence: 6,
	branch: 5,
	event_site: 4,
	jurisdiction: 3,
	corridor: 2,
	associated: 1,
};

/**
 * Deduplicate locations consistently:
 * 1. Normalize every address via `normalizeLocationRecord`.
 * 2. Merge exact duplicates (keeping highest-priority role).
 * 3. Drop generic city-only rows (e.g. "New York, NY" or "Brooklyn, NY") when a more specific
 *    street/neighborhood address in the exact same city/state (e.g. "30 Park Place, New York, NY"
 *    or "Bedford-Stuyvesant, Brooklyn, NY") is already present.
 */
export function deduplicateLocations<
	T extends {
		raw: string;
		city: string | null;
		county: string | null;
		state: string | null;
		country: string | null;
		geoKey: string;
		role: string;
	},
>(locations: T[]): T[] {
	// Step 1 & 2: Normalize and dedupe exact normalized address string
	const byExact = new Map<string, T>();
	for (const loc of locations) {
		const norm = normalizeLocationRecord(loc);
		const normalizedLoc: T = {
			...loc,
			raw: norm.raw,
			city: norm.city,
			county: norm.county,
			state: norm.state,
			country: norm.country,
			geoKey: norm.geoKey,
		};
		const key = normalizeText(norm.raw);
		if (!key) continue;
		const existing = byExact.get(key);
		if (!existing) {
			byExact.set(key, normalizedLoc);
		} else {
			const exPri = LOCATION_ROLE_PRIORITY[existing.role] || 0;
			const newPri = LOCATION_ROLE_PRIORITY[normalizedLoc.role] || 0;
			if (newPri > exPri) {
				byExact.set(key, normalizedLoc);
			}
		}
	}

	const unique = [...byExact.values()];

	// Step 3: Identify city/state buckets that already have a specific street/neighborhood address (3+ comma parts)
	const specificGeoKeys = new Set<string>();
	for (const loc of unique) {
		const commaParts = loc.raw.split(',').map((p) => p.trim()).filter(Boolean);
		if (commaParts.length >= 3 && loc.geoKey && !loc.geoKey.startsWith('raw:')) {
			specificGeoKeys.add(loc.geoKey);
		}
	}

	const pruned = unique.filter((loc) => {
		const commaParts = loc.raw.split(',').map((p) => p.trim()).filter(Boolean);
		// Drop generic "City, ST" (2 parts) when we already have "<Street/Neighborhood>, City, ST" in the same geoKey
		if (commaParts.length <= 2 && specificGeoKeys.has(loc.geoKey)) {
			return false;
		}
		return true;
	});

	// Sort cleanly: hq/residence first, then branch, then alphabetical
	pruned.sort((a, b) => {
		const pa = LOCATION_ROLE_PRIORITY[a.role] || 0;
		const pb = LOCATION_ROLE_PRIORITY[b.role] || 0;
		if (pa !== pb) return pb - pa;
		return a.raw.localeCompare(b.raw);
	});

	return pruned;
}

/**
 * Parse a loose US "City, ST 12345" address string into structured parts.
 */
export function parseAddressParts(raw: string): {
	city: string | null;
	county: string | null;
	state: string | null;
	country: string | null;
} {
	const norm = normalizeLocationRecord({ raw });
	return {
		city: norm.city,
		county: norm.county,
		state: norm.state,
		country: norm.country,
	};
}

/**
 * Normalize ISO-ish dates into YYYY-MM-DD, YYYY-MM, or YYYY + precision.
 */
export function normalizeIsoDate(raw?: string | null): {
	date: string | null;
	precision: 'day' | 'month' | 'year' | 'unknown';
} {
	const s = String(raw || '').trim();
	if (!s) return { date: null, precision: 'unknown' };

	const dayMatch = s.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (dayMatch) return { date: `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`, precision: 'day' };

	const slashMatch = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (slashMatch) {
		const mm = slashMatch[1].padStart(2, '0');
		const dd = slashMatch[2].padStart(2, '0');
		return { date: `${slashMatch[3]}-${mm}-${dd}`, precision: 'day' };
	}

	const monthMatch = s.match(/^(\d{4})-(\d{2})$/);
	if (monthMatch) return { date: `${monthMatch[1]}-${monthMatch[2]}`, precision: 'month' };

	const yearMatch = s.match(/\b(1[89]\d{2}|20\d{2})\b/);
	if (yearMatch) return { date: yearMatch[1], precision: 'year' };

	return { date: null, precision: 'unknown' };
}

/**
 * Convert an ISO-ish date (YYYY-MM-DD / YYYY-MM / YYYY) to epoch days for gap math.
 */
export function dateToEpochDays(dateStr: string | null | undefined): number | null {
	if (!dateStr) return null;
	const s = String(dateStr).trim();
	let iso = s;
	if (/^\d{4}$/.test(s)) iso = `${s}-06-15`;
	else if (/^\d{4}-\d{2}$/.test(s)) iso = `${s}-15`;
	else if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
	const ms = Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
	if (!Number.isFinite(ms)) return null;
	return Math.floor(ms / 86_400_000);
}

/**
 * Build safe FTS5 OR query tokens from arbitrary text.
 */
export function buildSafeFtsQuery(query: string): string {
	const rawTokens = String(query || '')
		.replace(/["'*^(){}[\]:]/g, ' ')
		.split(/[^a-zA-Z0-9-]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
	const unique = [...new Set(rawTokens)].slice(0, 10);
	if (!unique.length) return '';
	return unique.map((t) => `"${t}"`).join(' OR ');
}
