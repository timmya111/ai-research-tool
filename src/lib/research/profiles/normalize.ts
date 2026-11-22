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

const UNIVERSITY_RE =
	/\b(universit[a-z]*|college|school of|polytechnic|mit|caltech|eth zurich|itmo|sorbonne|stanford|harvard|oxford|cambridge|princeton|yale|columbia|berkeley|nyu|ucla|ut dallas|nazarbayev|novosibirsk|moscow institute of physics|technion|imperial college|tsinghua|peking|kyoto|tokyo institute|academia|faculty of)\b/i;

const AGENCY_RE =
	/\b(department of|u\.?s\.?\s+(?:army|navy|air force|marines|coast guard|customs|border|marshals|secret service|treasury|justice|state|defense|health)|federal|bureau of|agency|administration|commission|ministry of|government of|white house|cdc|centers for disease control|dod|dhs|ice|dea|cbp|fbi|fda|nih|niaid|fema|noaa|usgs|twdb|sec|finra|nasa|darpa|barda|northcom|national guard|state committee|municipal|county clerk|parliament|senate|congress|pentagon|war\.gov)\b/i;

const NONPROFIT_RE =
	/\b(foundation|non[- ]?profit|ngo|charity|charitable|trust|society|association|institute|institution|academy|consortium|alliance|coalition|council|forum|world health organization|\bwho\b|united nations|\bun\b|unesco|unicef|iaea|red cross|bill & melinda|rockefeller foundation|gates foundation|open society|brookings|rand corporation|cern|infn|joint institute|ras\b|russian academy|isde|world economic forum|wef|church|baptist|methodist|catholic|synagogue|mosque|mission|relief|civic|museum|observatory|laboratory|laboratori|center for|centre for)\b/i;

const FIRM_RE =
	/\b(llc|l\.l\.c\.|inc\.?|corp\.?|corporation|ltd\.?|limited|plc|gmbh|s\.a\.|co\.|company|capital|ventures|partners|holdings|bank|financial|securities|advisors|advisers|investments|management|pharma|pharmaceuticals|therapeutics|biotech|biosciences|labs|systems|solutions|technologies|consulting|energy|oil|gas|realty|properties|restaurants|games|enterprises|industries|manufacturing|logistics|airlines|telecom|media|studios|group)\b/i;

/**
 * Heuristically classify an organization name into firm | university | nonprofit | agency.
 * Precedence: university → agency → nonprofit → firm (default for commercial orgs).
 */
export function classifyOrgType(
	name: string,
	hint?: string | null,
): Exclude<ActorProfileType, 'person'> {
	const rawHint = String(hint || '').toLowerCase().trim();
	if (rawHint === 'university' || rawHint === 'academic') return 'university';
	if (rawHint === 'nonprofit' || rawHint === 'non-profit' || rawHint === 'ngo' || rawHint === 'foundation') {
		return 'nonprofit';
	}
	if (rawHint === 'agency' || rawHint === 'government' || rawHint === 'gov') return 'agency';
	if (rawHint === 'firm' || rawHint === 'company' || rawHint === 'business') return 'firm';

	const hay = `${name} ${rawHint}`;
	if (UNIVERSITY_RE.test(hay)) return 'university';
	if (AGENCY_RE.test(hay)) return 'agency';
	// If it explicitly has commercial suffixes like LLC/Inc/Corp/Bank, prefer firm unless it's clearly a Foundation/Society
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

/**
 * Parse a loose US "City, ST 12345" address string into structured parts.
 */
export function parseAddressParts(raw: string): {
	city: string | null;
	county: string | null;
	state: string | null;
	country: string | null;
} {
	const text = String(raw || '').trim();
	if (!text) return { city: null, county: null, state: null, country: null };

	// Match "City, ST 12345" or "City, ST"
	const m = text.match(/([A-Za-z .'-]+?),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
	if (m) {
		return {
			city: m[1].trim(),
			county: null,
			state: m[2].toUpperCase(),
			country: 'US',
		};
	}
	// Match "... County, OK" or "... County, Texas"
	const cm = text.match(/([A-Za-z .'-]+?)\s+County(?:,\s*([A-Za-z ]+))?/i);
	if (cm) {
		const st = normalizeUsState(cm[2]);
		return {
			city: null,
			county: cm[1].trim(),
			state: st,
			country: st ? 'US' : null,
		};
	}
	return { city: null, county: null, state: null, country: null };
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
