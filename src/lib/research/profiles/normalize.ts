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
	/\b(universit[a-z]*|universidade|universidad|université|college|polytechnic|politecnico|mit\b|caltech|eth\s+zurich|itmo|sorbonne|stanford|harvard|oxford|cambridge|princeton|yale|columbia\s+univ|berkeley|nyu\b|ucla\b|ut\s+dallas|nazarbayev|novosibirsk\s+state|moscow\s+institute\s+of\s+physics|technion|imperial\s+college|tsinghua|peking\s+univ|kyoto\s+univ|tokyo\s+institute\s+of\s+technology|faculty\s+of|school\s+district|independent\s+school|public\s+schools|board\s+of\s+education|high\s+school|middle\s+school|elementary\s+school|prep(?:aratory)?\s+school|law\s+school|business\s+school|medical\s+school|divinity\s+school|graduate\s+school|school\s+of\b|conservatory|seminary|educational\s+(?:trust|foundation|institute|board|system|services|group)|education\s+(?:board|district|network|system|group)|academy\s+of\s+(?!sciences|medicine)|k-?12|charter\s+school|montessori|lyceum|gymnasium|edtech|teaching\s+institute|instituto\s+superior|karolinska|virginia\s+tech)\b/i;

const US_GOVERNMENT_RE =
	/\b(u\.?s\.?\s+(?:department|dept|army|navy|air\s+force|marines|coast\s+guard|customs|border|marshals|secret\s+service|treasury|justice|state|defense|health|geological|government|federal|senate|congress|house\s+of\s+representatives)|united\s+states\s+(?:department|government|army|navy|air\s+force|secret\s+service|senate|congress)|federal\s+(?:bureau|reserve|trade|communications|aviation|emergency|agency|commission|administration|government)|white\s+house|\bcdc\b|centers\s+for\s+disease\s+control|\bhhs\b|health\s+and\s+human\s+services|\bdod\b|department\s+of\s+defense|\bdhs\b|homeland\s+security|\bice\b|immigration\s+and\s+customs|\bdea\b|drug\s+enforcement|\bcbp\b|customs\s+and\s+border|\bfbi\b|\batf\b|\busss\b|\bdoj\b|\bfda\b|food\s+and\s+drug\s+administration|\bnih\b|national\s+institutes\s+of\s+health|\bniaid\b|\bfema\b|\bnoaa\b|national\s+oceanic|\busgs\b|\bsec\b|securities\s+and\s+exchange\s+commission|\bnasa\b|\bdarpa\b|\bbarda\b|\bnorthcom\b|national\s+guard|\bngb\b|pentagon|war\.gov|central\s+intelligence\s+agency|\bcia\b|\bnsa\b|veterans\s+affairs|internal\s+revenue\s+service|\birs\b|environmental\s+protection\s+agency|\bepa\b|operation\s+warp\s+speed|texas\s+water\s+development\s+board|\btwdb\b|city\s+of\s+(?:atlanta|dallas|austin|houston|oklahoma\s+city|tulsa|durant|new\s+york|chicago|los\s+angeles|san\s+francisco|seattle|boston|miami|denver|phoenix)|state\s+of\s+(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming)|(?:texas|oklahoma|california|new\s+york|florida|illinois|virginia|ohio|georgia|michigan|pennsylvania|north\s+carolina|arizona|colorado|washington|massachusetts|minnesota|missouri|tennessee|indiana|maryland|wisconsin|oregon|nevada|kansas|arkansas|louisiana|alabama|utah|iowa|kentucky|new\s+mexico)\s+(?:department|dept|commission|board|agency|legislature|senate|house|supreme\s+court|attorney\s+general|treasurer|comptroller|governor|state\s+police|highway\s+patrol|health\s+department|water\s+board)|state\s+(?:department\s+of|commission|board\s+of|legislature|senate|assembly|treasurer|comptroller|attorney\s+general|health\s+department|governor|agency|authority)|county\s+(?:clerk|commissioner|sheriff|assessor|treasurer|court|board|government))\b/i;

const FOREIGN_GOV_RE =
	/\b(ministry\s+of|government\s+of|department\s+of|bureau\s+of|agency|administration|commission|state\s+committee|municipal|city\s+of\s+|parliament|national\s+assembly|embassy|consulate|central\s+bank|bank\s+of\s+england|european\s+commission|european\s+parliament)\b/i;

const NONPROFIT_RE =
	/\b(foundation|non[- ]?profit|ngo|charity|charitable|trust|society|association|institute|institution|academy|consortium|alliance|coalition|council|forum|world\s+health\s+organization|\bwho\b|united\s+nations|\bun\b|unesco|unicef|iaea|red\s+cross|bill\s*&\s*melinda|rockefeller\s+foundation|gates\s+foundation|open\s+society|brookings|rand\s+corporation|cern|infn|joint\s+institute|ras\b|russian\s+academy|isde|world\s+economic\s+forum|wef|church|baptist|methodist|catholic|synagogue|mosque|mission|relief|civic|museum|observatory|laboratory|laboratori|center\s+for|centre\s+for)\b/i;

const FIRM_RE =
	/\b(llc|l\.l\.c\.|inc\.?|corp\.?|corporation|ltd\.?|limited|plc|gmbh|s\.a\.|co\.|company|capital|ventures|partners|holdings|bank|financial|securities|advisors|advisers|investments|management|pharma|pharmaceuticals|therapeutics|biotech|biosciences|labs|systems|solutions|technologies|consulting|energy|oil|gas|realty|properties|restaurants|games|enterprises|industries|manufacturing|logistics|airlines|telecom|media|studios|group)\b/i;

/**
 * True for broker/holding/investment-style names that only *mention* a university brand
 * (e.g. "Stanford Investment Group, Inc.", "Cambridge Securities", "MIT Holdings LLC").
 * Real schools and educational institutes return false.
 */
export function isCommercialFirmName(name: string): boolean {
	const n = String(name || '').trim();
	if (!n) return false;
	// Clear educational institutions — even with LLC (e.g. CNL Educational Institute, LLC).
	if (
		/\b(educational?\s+(?:institute|institution|group|services|system|board|trust|foundation)|education\s+group|school\s+district|board\s+of\s+education|university\s+corporation\s+for|historically\s+black\s+college|law\s+school|business\s+school|medical\s+school|divinity\s+school|graduate\s+school)\b/i.test(
			n,
		)
	) {
		return false;
	}
	const hasSchoolWord =
		/\b(universit(?:y|ies)|colleges?|schools?|academ(?:y|ies)|seminar(?:y|ies)|conservator(?:y|ies)|polytechnics?)\b/i.test(
			n,
		);
	const hasFinancial =
		/\b(securities|investments?|capital\s+markets|equities|financial|holdings?|advisors?|advisers?|broker(?:age)?|wealth|retirement|trading|asset\s+management|partners?|college\s+planning|university\s+sales|university\s+equities)\b/i.test(
			n,
		);
	const hasCorpSuffix =
		/\b(llc|l\.l\.c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|plc|lp|llp|pllc|gmbh|co\.)\b/i.test(
			n,
		);
	// "Harvard Securities, Inc." / "University Equities Corporation" → firm
	if (hasFinancial && (hasCorpSuffix || hasSchoolWord || /\b(group|company)\b/i.test(n))) {
		return true;
	}
	// "MIT Holdings, LLC" / "Tsinghua Holdings Co. Ltd" with no school-word as the entity type
	if (hasCorpSuffix && hasFinancial) return true;
	if (hasCorpSuffix && !hasSchoolWord) return true;
	// Brand-only university tokens + Group/Holdings (not an actual school entity).
	if (
		/\b(harvard|yale|stanford|princeton|oxford|cambridge|berkeley|mit|tsinghua|columbia|nyu|ucla)\b/i.test(
			n,
		) &&
		!/\b(universit(?:y|ies)|colleges?|schools?|academ(?:y|ies)|institutes?|seminar(?:y|ies)|educational?)\b/i.test(
			n,
		) &&
		/\b(group|holdings?|inc\.?|llc|corp\.?|ltd\.?|company|partners?|securities|capital|enterprise)\b/i.test(
			n,
		)
	) {
		return true;
	}
	return false;
}

/**
 * Heuristically classify an organization name into:
 * medical_hospital | education | government | nonprofit | firm.
 * Government covers domestic and foreign ministries, embassies, and intl bodies.
 */
export function classifyOrgType(
	name: string,
	hint?: string | null,
): Exclude<ActorProfileType, 'person'> {
	const rawHint = String(hint || '').toLowerCase().trim();
	// Commercial brokers / holdings that only borrow a university brand → firm first.
	if (isCommercialFirmName(name)) return 'firm';

	if (rawHint === 'medical_hospital' || rawHint === 'medical_mental_hospital' || rawHint === 'hospital' || rawHint === 'medical') {
		return 'medical_hospital';
	}
	if (rawHint === 'education' || rawHint === 'university' || rawHint === 'academic' || rawHint === 'school') {
		return 'education';
	}
	if (
		rawHint === 'government' ||
		rawHint === 'gov' ||
		rawHint === 'federal_gov' ||
		rawHint === 'state_gov' ||
		rawHint === 'federal' ||
		rawHint === 'state' ||
		rawHint === 'foreign' ||
		rawHint === 'foreign_gov' ||
		rawHint === 'agency'
	) {
		return 'government';
	}
	if (rawHint === 'nonprofit' || rawHint === 'non-profit' || rawHint === 'ngo' || rawHint === 'foundation') {
		return 'nonprofit';
	}
	if (rawHint === 'firm' || rawHint === 'company' || rawHint === 'business') return 'firm';

	const hay = `${name} ${rawHint}`;
	// 1. Medical hospitals & health centers (avoid "Hospitality")
	if (MEDICAL_HOSPITAL_RE.test(hay) && !/\bhospitality\b/i.test(hay)) return 'medical_hospital';
	// 2. Education (universities, colleges, schools, districts, boards) — not commercial brands
	if (EDUCATION_RE.test(hay) && !isCommercialFirmName(name)) return 'education';
	// 3. Government (domestic + foreign ministries / embassies / intl bodies)
	if (US_GOVERNMENT_RE.test(hay)) return 'government';
	if (FOREIGN_GOV_RE.test(hay) && !/\b(co\.?\s*ltd|llc|inc\.?|corp\.?|plc|gmbh)\b/i.test(hay)) {
		return 'government';
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
	'd.c.': 'DC',
	'd.c': 'DC',
	'dc.': 'DC',
	'washington dc': 'DC',
	'washington d.c.': 'DC',
	'washington d.c': 'DC',
};

export function normalizeUsState(input?: string | null): string | null {
	const raw = String(input || '').trim();
	if (!raw) return null;
	if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
	// Dotted / spaced postal style: "S.C.", "N. Y.", "D.C."
	const dotted = raw.replace(/\./g, '').replace(/\s+/g, '');
	if (/^[A-Za-z]{2}$/.test(dotted)) return dotted.toUpperCase();
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
	const keepUpper = new Set([
		'NW',
		'NE',
		'SW',
		'SE',
		'PO',
		'WTC',
		'AFB',
		'NAS',
		'JRB',
		'US',
		'UK',
		'DC',
		'NYC',
		// Australian states / territories
		'NSW',
		'VIC',
		'QLD',
		'SA',
		'WA',
		'ACT',
		'NT',
		'TAS',
	]);
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

		// Normalize "D.C." / "D.C. 20001" tokens to "DC" / "DC 20001" anywhere in the parts list.
		for (let i = 0; i < parts.length; i++) {
			const dcZip = parts[i].match(/^d\.?\s*c\.?(?:\s+(\d{5}(?:-\d{4})?))?$/i);
			if (dcZip) {
				parts[i] = dcZip[1] ? `DC ${dcZip[1]}` : 'DC';
			}
		}

		// Handle "Washington, D.C." (any adjacent pair — not only at the start).
		for (let i = 0; i < parts.length - 1; i++) {
			if (/^washington$/i.test(parts[i]) && /^(?:d\.?\s*c\.?|DC)(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[i + 1])) {
				city = city || 'Washington';
				state = 'DC';
				country = 'US';
				const zipM = parts[i + 1].match(/\b(\d{5}(?:-\d{4})?)\b/);
				parts.splice(i, 2, 'Washington', zipM ? `DC ${zipM[1]}` : 'DC');
				break;
			}
		}

		// "Suite 308 Washington" + "DC" → peel city out of a trailing Washington in the prior part (keep Washington as its own segment).
		for (let i = 0; i < parts.length - 1; i++) {
			if (/^(?:d\.?\s*c\.?|DC)(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[i + 1])) {
				const wash = parts[i].match(/^(.+\b)(washington)\s*$/i);
				if (wash) {
					const leading = String(wash[1] || '').trim().replace(/[,\s]+$/g, '');
					if (leading) {
						parts.splice(i, 1, leading, 'Washington');
						city = city || 'Washington';
						state = 'DC';
						country = 'US';
						break;
					}
				}
			}
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
		const stateZipM = lastPart.match(/^([A-Za-z.\s]+?)(?:\s+(\d{5}(?:-\d{4})?))?$/);
		if (stateZipM) {
			const maybeState = stateZipM[1].trim();
			const zip = stateZipM[2] || '';
			const mapped =
				normalizeUsState(maybeState) &&
				VALID_US_STATES.has(String(normalizeUsState(maybeState)))
					? String(normalizeUsState(maybeState))
					: maybeState.length === 2 && VALID_US_STATES.has(maybeState.toUpperCase())
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
			} else if (
				!city &&
				beforeState &&
				!/^\d/.test(beforeState) &&
				!/^(?:suite|ste\.?|floor|fl\.?|apt\.?|unit|room|rm\.?)\b/i.test(beforeState)
			) {
				city = beforeState;
			}
		}
		// DC shorthand: if we know DC but city still empty, prefer Washington.
		if (!city && state === 'DC') city = 'Washington';

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

const GENERIC_COUNTRY_ONLY_RE =
	/^(?:u\.?s\.?a?\.?|united states(?: of america)?|america|unknown|n\/a|none)$/i;

const BARE_COUNTRY_NAME_RE =
	/^(?:netherlands|australia|germany|france|canada|united kingdom|uk|england|japan|china|india|israel|switzerland|sweden|norway|denmark|finland|belgium|spain|italy|brazil|mexico|singapore|south korea|korea|ireland|austria|new zealand)$/i;

/**
 * Build the richest display address possible from structured location fields.
 * Prefers a street-bearing `raw` when present; otherwise composes city / county /
 * state / country (omitting redundant "US" when a US state is already shown).
 */
export function formatFullAddress(loc: {
	raw?: string | null;
	city?: string | null;
	county?: string | null;
	state?: string | null;
	country?: string | null;
}): string | null {
	const norm = normalizeLocationRecord({
		raw: loc.raw,
		city: loc.city,
		county: loc.county,
		state: loc.state,
		country: loc.country,
	});
	const raw = String(norm.raw || '').trim();
	const city = norm.city;
	const county = norm.county;
	const state = norm.state;
	let country = norm.country;
	if (country && /^(?:u\.?s\.?a?\.?|united states(?: of america)?)$/i.test(country)) {
		country = 'US';
	}

	const rawParts = raw
		? raw
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];
	const hasStreet = rawParts.some((p) => /^\d/.test(p) || /\d{5}(?:-\d{4})?/.test(p));
	const rawIsBareCountry =
		rawParts.length === 1 &&
		(BARE_COUNTRY_NAME_RE.test(rawParts[0]) || GENERIC_COUNTRY_ONLY_RE.test(rawParts[0]));
	const rawLooksComplete =
		Boolean(raw) &&
		!rawIsBareCountry &&
		(hasStreet || rawParts.length >= 2 || (Boolean(city) && Boolean(state)));

	if (rawLooksComplete && !rawIsBareCountry) {
		// Ensure country is present for non-US addresses when we know it
		if (
			country &&
			country !== 'US' &&
			!raw.toLowerCase().includes(country.toLowerCase()) &&
			!BARE_COUNTRY_NAME_RE.test(raw)
		) {
			return `${raw}, ${country}`;
		}
		return raw;
	}

	const parts: string[] = [];
	if (hasStreet && rawParts[0] && /^\d/.test(rawParts[0])) {
		parts.push(rawParts[0]);
	}
	if (city && !parts.some((p) => p.toLowerCase() === city.toLowerCase())) {
		parts.push(city);
	} else if (county) {
		const countyLabel = /county$/i.test(county) ? county : `${county} County`;
		if (!parts.some((p) => p.toLowerCase() === countyLabel.toLowerCase())) {
			parts.push(countyLabel);
		}
	}
	if (state && !parts.some((p) => p.toUpperCase() === state.toUpperCase())) {
		parts.push(state);
	}
	if (country && country !== 'US') {
		if (!parts.some((p) => p.toLowerCase() === country!.toLowerCase())) {
			parts.push(country);
		}
	} else if (country === 'US' && !state && parts.length > 0) {
		parts.push('US');
	}

	const built = parts.join(', ').trim();
	return built || (raw && !GENERIC_COUNTRY_ONLY_RE.test(raw) ? raw : null);
}

/** Score a location for "best display address" (confirmed residence/HQ + street preferred). */
export function scoreLocationCompleteness(loc: {
	raw?: string | null;
	city?: string | null;
	county?: string | null;
	state?: string | null;
	country?: string | null;
	role?: string | null;
	confirmed?: boolean | null;
}): number {
	const label = formatFullAddress(loc) || '';
	if (!label) return -1;
	const streety = /\d/.test(label) ? 1000 : 0;
	const commaParts = label.split(',').length;
	const confirmed = Boolean(loc.confirmed);
	// Unconfirmed residence must never win the primary/header address.
	const roleBoost =
		loc.role === 'hq'
			? confirmed
				? 900
				: 500
			: loc.role === 'residence'
				? confirmed
					? 950
					: -10_000
				: loc.role === 'birthplace'
					? 150
					: loc.role === 'branch'
						? 100
						: 0;
	const confirmedBoost = confirmed ? 2000 : 0;
	const structured =
		(loc.city ? 40 : 0) + (loc.state ? 40 : 0) + (loc.county ? 20 : 0) + (loc.country ? 10 : 0);
	return confirmedBoost + streety + roleBoost + commaParts * 25 + structured + label.length;
}

/**
 * Compact person-list location: "City, ST" for US; "City, ST, CC" / "City, CC" when abroad.
 * Omits street, ZIP, county, and USA. Returns null when there is no city (or city+state).
 */
export function formatCompactCityStateLocation(
	loc: {
		raw?: string | null;
		city?: string | null;
		state?: string | null;
		country?: string | null;
	},
	opts?: { countryAbbrev?: string | null },
): string | null {
	const norm = normalizeLocationRecord({
		raw: loc.raw,
		city: loc.city,
		state: loc.state,
		country: loc.country,
	});
	const city = String(norm.city || '').trim() || null;
	const state = normalizeUsState(norm.state);
	const countryRaw = String(norm.country || '').trim();
	const isUsCountry =
		!countryRaw || /^(?:u\.?s\.?a?\.?|united states(?: of america)?)$/i.test(countryRaw);
	const inferredUs = Boolean(state && Object.values(US_STATE_ABBR).includes(state) && isUsCountry);
	const isUs = isUsCountry || inferredUs;

	let countryAbbrev = opts?.countryAbbrev != null ? String(opts.countryAbbrev).trim() : '';
	if (!countryAbbrev && !isUs && countryRaw) {
		if (/^[a-z]{2}$/i.test(countryRaw)) countryAbbrev = countryRaw.toUpperCase();
	}
	if (isUs || /^(us)$/i.test(countryAbbrev)) countryAbbrev = '';

	const parts: string[] = [];
	if (city) parts.push(city);
	if (state) parts.push(state);
	if (countryAbbrev) parts.push(countryAbbrev.toUpperCase());
	// Prefer city+state; allow city-only abroad; skip bare US state with no city.
	if (!city) return null;
	return parts.length ? parts.join(', ') : null;
}

/** Pick the best location row and return a full display address string. */
export function pickBestFullAddress(
	locs: Array<{
		raw?: string | null;
		city?: string | null;
		county?: string | null;
		state?: string | null;
		country?: string | null;
		role?: string | null;
		confirmed?: boolean | null;
	}>,
): string | null {
	if (!locs.length) return null;
	const ranked = [...locs].sort(
		(a, b) => scoreLocationCompleteness(b) - scoreLocationCompleteness(a),
	);
	return formatFullAddress(ranked[0]);
}

/** Best location object for UI (includes role/confirmed for badges). */
export function pickBestLocation<
	T extends {
		raw?: string | null;
		city?: string | null;
		county?: string | null;
		state?: string | null;
		country?: string | null;
		role?: string | null;
		confirmed?: boolean | null;
	},
>(locs: T[]): T | null {
	if (!locs.length) return null;
	return [...locs].sort((a, b) => scoreLocationCompleteness(b) - scoreLocationCompleteness(a))[0] || null;
}

/**
 * Return true when a location string is too generic to be useful as a location row
 * (e.g. bare "USA", "United States", "U.S.", "US" with no city, county, state, or street).
 */
export function isTooGenericLocation(loc: {
	raw?: string | null;
	city?: string | null;
	county?: string | null;
	state?: string | null;
}): boolean {
	if (loc.city || loc.county || loc.state) return false;
	const raw = String(loc.raw || '').replace(/\s+/g, ' ').trim();
	if (!raw) return true;
	return GENERIC_COUNTRY_ONLY_RE.test(raw);
}

const LOCATION_ROLE_PRIORITY: Record<string, number> = {
	hq: 7,
	residence: 6,
	birthplace: 5,
	branch: 4,
	event_site: 3,
	jurisdiction: 2,
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
	// Step 1 & 2: Normalize and dedupe exact normalized address string (dropping bare generic country-only rows like "USA")
	const byExact = new Map<string, T>();
	for (const loc of locations) {
		const norm = normalizeLocationRecord(loc);
		if (isTooGenericLocation(norm)) continue;
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

	// Sort: digit street first, then hq/residence role, then longer raw, then alpha
	pruned.sort((a, b) => {
		const scoreDiff = scoreLocationCompleteness(b) - scoreLocationCompleteness(a);
		if (scoreDiff !== 0) return scoreDiff;
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

	const MONTH_NAME_TO_INDEX: Record<string, string> = {
		jan: '01',
		january: '01',
		feb: '02',
		february: '02',
		mar: '03',
		march: '03',
		apr: '04',
		april: '04',
		may: '05',
		jun: '06',
		june: '06',
		jul: '07',
		july: '07',
		aug: '08',
		august: '08',
		sep: '09',
		sept: '09',
		september: '09',
		oct: '10',
		october: '10',
		nov: '11',
		november: '11',
		dec: '12',
		december: '12',
	};

	// Prefer ISO YYYY-MM-DD first so "1906-06-05" is not misread as US order.
	const dayMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dayMatch) return { date: `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`, precision: 'day' };

	const isoEmbedded = s.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (isoEmbedded && !/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(s) && !/^[A-Za-z]/.test(s)) {
		return { date: `${isoEmbedded[1]}-${isoEmbedded[2]}-${isoEmbedded[3]}`, precision: 'day' };
	}

	// Long display form: November 26, 2026 / Nov 26, 2026
	const longDay = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})$/i,
	);
	if (longDay) {
		const mm = MONTH_NAME_TO_INDEX[longDay[1].toLowerCase().replace(/\.$/, '')];
		const dd = Number(longDay[2]);
		if (mm && dd >= 1 && dd <= 31) {
			return { date: `${longDay[3]}-${mm}-${String(dd).padStart(2, '0')}`, precision: 'day' };
		}
	}

	// Month + year: November 2026 / Nov 2026
	const longMonth = s.match(
		/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})$/i,
	);
	if (longMonth) {
		const mm = MONTH_NAME_TO_INDEX[longMonth[1].toLowerCase().replace(/\.$/, '')];
		if (mm) return { date: `${longMonth[2]}-${mm}`, precision: 'month' };
	}

	const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (slashMatch) {
		const mm = slashMatch[1].padStart(2, '0');
		const dd = slashMatch[2].padStart(2, '0');
		return { date: `${slashMatch[3]}-${mm}-${dd}`, precision: 'day' };
	}

	// Preferred typed form MM-DD-YYYY (e.g. 11-26-2026)
	const usDashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
	if (usDashMatch) {
		const mm = Number(usDashMatch[1]);
		const dd = Number(usDashMatch[2]);
		if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
			return {
				date: `${usDashMatch[3]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
				precision: 'day',
			};
		}
	}

	// Compact MMDDYYYY (e.g. 11262026 → 2026-11-26)
	const compact = s.match(/^(\d{2})(\d{2})(\d{4})$/);
	if (compact) {
		const mm = Number(compact[1]);
		const dd = Number(compact[2]);
		const yyyy = Number(compact[3]);
		if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy >= 1600 && yyyy <= 2100) {
			return {
				date: `${compact[3]}-${compact[1]}-${compact[2]}`,
				precision: 'day',
			};
		}
	}

	const monthMatch = s.match(/^(\d{4})-(\d{2})$/);
	if (monthMatch) return { date: `${monthMatch[1]}-${monthMatch[2]}`, precision: 'month' };

	const yearMatch = s.match(/^(1[6-9]\d{2}|20\d{2})$/);
	if (yearMatch) return { date: yearMatch[1], precision: 'year' };

	const yearEmbedded = s.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
	if (yearEmbedded) return { date: yearEmbedded[1], precision: 'year' };

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
/** Digits of an IRS EIN. Hyphens and spaces do not make two EINs different. */
export function irsEinDigits(value: string | null | undefined): string {
	const digits = String(value || '').replace(/\D/g, '');
	return digits.length >= 9 ? digits : '';
}

/**
 * True when both sides have at least one IRS EIN and none of those EINs match.
 * A shared Wikidata ID (or other soft identifier) is not a stronger indicator
 * in that case. An empty side is not a conflict.
 */
export function irsEinSetsConflict(
	left: Iterable<string> | null | undefined,
	right: Iterable<string> | null | undefined,
): boolean {
	const a = new Set<string>();
	for (const value of left || []) {
		const digits = irsEinDigits(value);
		if (digits) a.add(digits);
	}
	if (!a.size) return false;
	let sawRight = false;
	for (const value of right || []) {
		const digits = irsEinDigits(value);
		if (!digits) continue;
		sawRight = true;
		if (a.has(digits)) return false;
	}
	return sawRight;
}

export function formatIrsEin(value: string | null | undefined): string {
	const digits = irsEinDigits(value) || String(value || '').replace(/\D/g, '');
	if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
	return String(value || '').trim();
}

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
