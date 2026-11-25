/**
 * Tiered edge weights for Profiles graphs across all main categories.
 *
 * W_total(A,B) = w_direct + w_board + w_event + w_city(A,B)
 * w_city(A,B)  = α · SectorMatch(A,B) / log(1 + N_city)  [city-level]
 *
 * Same-city is a weak-tie prior with an inverse city-density penalty.
 * Same building / same city-block are stronger geo priors (still below board/equity)
 * and should trigger secondary querying of names, roles, and shared firms.
 */

import type { ProfileRelationType, ProfileType } from '@/lib/research/profiles/types';

/** Main actor + narrative categories the weighting model applies to. */
export const EDGE_WEIGHT_PROFILE_TYPES: readonly ProfileType[] = [
	'person',
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	'region',
	'historic_event',
] as const;

export type EdgeWeightSector =
	| 'biomedical'
	| 'finance'
	| 'technology'
	| 'energy'
	| 'defense'
	| 'education'
	| 'government'
	| 'media'
	| 'general';

/** Geographic proximity grain for co-location weights. */
export type GeoProximity = 'building' | 'block' | 'city';

/** Baseline tiers on a 0–1 scale (midpoints used as defaults). */
export const EDGE_WEIGHT_TIERS = {
	directEquity: { min: 0.8, max: 1.0, mid: 0.9 },
	sharedBoardOrSteering: { min: 0.5, max: 0.75, mid: 0.625 },
	sharedConferenceOrEvent: { min: 0.25, max: 0.4, mid: 0.325 },
	/** Same street address / named building (suite/floor differences ignored). */
	sameBuildingSameSector: { min: 0.28, max: 0.45, mid: 0.36 },
	sameBuildingDifferentSector: { min: 0.18, max: 0.32, mid: 0.25 },
	/** Same street + ZIP/city, different house numbers (city block corridor). */
	sameBlockSameSector: { min: 0.15, max: 0.3, mid: 0.22 },
	sameBlockDifferentSector: { min: 0.08, max: 0.18, mid: 0.12 },
	sameCitySameSector: { min: 0.05, max: 0.2, mid: 0.125 },
	sameCityDifferentSector: { min: 0.02, max: 0.08, mid: 0.05 },
} as const;

/** α scales the city component before the density penalty. */
export const CITY_COLOCATION_ALPHA = 0.35;

/** Extra score from secondary name/role/firm corroboration on tight geo matches. */
export const SECONDARY_SIGNAL_BOOST = {
	sharedFirm: 0.08,
	sharedRole: 0.05,
	nameTokenOverlap: 0.04,
	maxTotal: 0.18,
} as const;

const BIOMEDICAL_RE =
	/\b(?:pharma|biotech|biomed|bioscience|life[\s-]?science|health(?:care|tech)?|hospital|clinic|vaccine|therapeut|medtech|medical|oncolog|diagnost|drug|gsk|pfizer|roche|novartis|merck|astrazeneca|sanofi|biontech|deepmind|isomorphic|philips|siemens health|fresenius|elekta|getinge|sobi|lonza|idorsia|basilea|straumann|haleon|wellcome|ema|fda|dhsc|karolinska)\b/i;

const FINANCE_RE =
	/\b(?:bank|banking|capital|invest(?:ment|or)?|private[\s-]?equity|asset[\s-]?manag|securities|fintech|seb\b|wallenberg)\b/i;

const TECH_RE =
	/\b(?:software|semiconductor|artificial intelligence|\bai\b|machine learning|cloud|cyber|platform|deepmind|google|microsoft|meta)\b/i;

const ENERGY_RE = /\b(?:oil|gas|energy|petroleum|refin|pipeline|utilities|nuclear|renewable)\b/i;

const DEFENSE_RE = /\b(?:defense|defence|aerospace|missile|weapons|military|nato|dod|pentagon)\b/i;

const MEDIA_RE = /\b(?:media|news|publisher|broadcast|journalis|press)\b/i;

export type SectorHints = {
	profileType?: ProfileType | null;
	name?: string | null;
	summary?: string | null;
	industry?: string | null;
	metadata?: Record<string, unknown> | null;
	categoryTags?: string[] | null;
};

function textBlob(hints: SectorHints): string {
	const tags = Array.isArray(hints.categoryTags)
		? hints.categoryTags.join(' ')
		: Array.isArray(hints.metadata?.categoryTags)
			? (hints.metadata!.categoryTags as unknown[]).map(String).join(' ')
			: '';
	const industry =
		hints.industry ||
		(typeof hints.metadata?.industry === 'string' ? hints.metadata.industry : '') ||
		(typeof hints.metadata?.companyType === 'string' ? hints.metadata.companyType : '');
	return [hints.name, hints.summary, industry, tags, hints.profileType].filter(Boolean).join(' ');
}

/** Map a profile to a coarse sector used by SectorMatch. Applies to all main categories. */
export function inferEdgeWeightSector(hints: SectorHints): EdgeWeightSector {
	const type = hints.profileType || null;
	if (type === 'medical_hospital') return 'biomedical';
	if (type === 'education') return 'education';
	if (type === 'government') {
		const t = textBlob(hints);
		if (BIOMEDICAL_RE.test(t) || /\bhealth\b/i.test(t)) return 'biomedical';
		return 'government';
	}
	const t = textBlob(hints);
	if (BIOMEDICAL_RE.test(t)) return 'biomedical';
	if (FINANCE_RE.test(t)) return 'finance';
	if (DEFENSE_RE.test(t)) return 'defense';
	if (ENERGY_RE.test(t)) return 'energy';
	if (TECH_RE.test(t)) return 'technology';
	if (MEDIA_RE.test(t)) return 'media';
	if (type === 'nonprofit' && /\b(?:health|hospital|medical|patient|disease)\b/i.test(t)) return 'biomedical';
	return 'general';
}

/**
 * SectorMatch ∈ [0,1]. Same sector → 1; compatible biomedical↔hospital/gov health → 0.85;
 * different sector → 0.35 (still allows weak same-city prior); unrelated historic_event noise → 0.2.
 */
export function sectorMatch(a: EdgeWeightSector, b: EdgeWeightSector): number {
	if (a === b) return 1;
	const pair = new Set([a, b]);
	if (pair.has('biomedical') && (pair.has('education') || pair.has('government'))) return 0.85;
	if (pair.has('finance') && (pair.has('biomedical') || pair.has('technology') || pair.has('energy'))) {
		return 0.45;
	}
	if (a === 'general' || b === 'general') return 0.4;
	return 0.35;
}

/** Inverse city-density penalty: small N_city → higher weight. */
export function cityDensityFactor(nCity: number): number {
	const n = Math.max(0, Number(nCity) || 0);
	return 1 / Math.log(1 + Math.max(1, n));
}

function tierForProximity(proximity: GeoProximity, sameSector: boolean) {
	if (proximity === 'building') {
		return sameSector ? EDGE_WEIGHT_TIERS.sameBuildingSameSector : EDGE_WEIGHT_TIERS.sameBuildingDifferentSector;
	}
	if (proximity === 'block') {
		return sameSector ? EDGE_WEIGHT_TIERS.sameBlockSameSector : EDGE_WEIGHT_TIERS.sameBlockDifferentSector;
	}
	return sameSector ? EDGE_WEIGHT_TIERS.sameCitySameSector : EDGE_WEIGHT_TIERS.sameCityDifferentSector;
}

/**
 * Geo co-location weight. City uses density penalty; building/block use higher
 * fixed tiers (still below board/equity) so shared HQ floors outrank megacity noise.
 */
export function cityColocationWeight(opts: {
	sectorA: EdgeWeightSector;
	sectorB: EdgeWeightSector;
	nCity: number;
	proximity?: GeoProximity;
	alpha?: number;
}): number {
	const proximity = opts.proximity ?? 'city';
	const match = sectorMatch(opts.sectorA, opts.sectorB);
	const sameSector = match >= 0.85;
	const tier = tierForProximity(proximity, sameSector);

	if (proximity === 'city') {
		const alpha = opts.alpha ?? CITY_COLOCATION_ALPHA;
		const raw = alpha * match * cityDensityFactor(opts.nCity);
		return Number(Math.min(tier.max, Math.max(tier.min, raw)).toFixed(4));
	}

	// Building/block: density still soft-scales within the higher band
	const density = cityDensityFactor(Math.max(2, opts.nCity));
	const mid = tier.mid;
	const span = tier.max - tier.min;
	const raw = mid + (density - 0.4) * span;
	return Number(Math.min(tier.max, Math.max(tier.min, raw)).toFixed(4));
}

const SUITE_FLOOR_RE =
	/\b(?:suite|ste\.?|floor|fl\.?|unit|apt\.?|apartment|room|rm\.?|#)\s*[\w-]+/gi;

/** Capture suite/floor/unit token for same-suite gates (e.g. suite:800, floor:12). */
export function extractSuiteFloorToken(raw: string): string | null {
	const s = String(raw || '');
	// "4th Floor", "22nd, 24th Floor", "45th Floor" (ordinal before Floor)
	const ordinalFloor = s.match(/\b(\d+(?:st|nd|rd|th))(?:\s*,\s*\d+(?:st|nd|rd|th))*\s+floors?\b/i);
	if (ordinalFloor) {
		return `floor:${ordinalFloor[1].toLowerCase()}`;
	}
	const m = s.match(/\b(suite|ste\.?|floor|fl\.?|unit|apt\.?|apartment|room|rm\.?|#)\s*([\w-]+)/i);
	if (!m) return null;
	const kindRaw = m[1].toLowerCase().replace(/\./g, '');
	const kind =
		kindRaw === 'ste' || kindRaw === 'suite'
			? 'suite'
			: kindRaw === 'fl' || kindRaw === 'floor'
				? 'floor'
				: kindRaw === 'apt' || kindRaw === 'apartment'
					? 'unit'
					: kindRaw === 'rm' || kindRaw === 'room'
						? 'room'
						: kindRaw === '#'
							? 'unit'
							: kindRaw;
	return `${kind}:${m[2].toLowerCase()}`;
}

/** Significant brand token shared by two firm names (not generic finance words). */
const GENERIC_FIRM_NAME_TOKENS = new Set([
	'securities',
	'financial',
	'finance',
	'advisors',
	'advisers',
	'advisory',
	'wealth',
	'management',
	'capital',
	'investment',
	'investments',
	'asset',
	'partners',
	'group',
	'corp',
	'corporation',
	'company',
	'llc',
	'inc',
	'ltd',
	'services',
	'markets',
	'brokerage',
	'holdings',
	'global',
	'america',
	'american',
	'us',
	'usa',
	'the',
	'and',
	'of',
]);

export function sharedSignificantFirmTokens(nameA: string, nameB: string): string[] {
	const tok = (n: string) =>
		String(n || '')
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter((t) => t.length >= 3 && !GENERIC_FIRM_NAME_TOKENS.has(t));
	const a = new Set(tok(nameA));
	const out: string[] = [];
	for (const t of tok(nameB)) {
		if (a.has(t) && !out.includes(t)) out.push(t);
	}
	return out;
}
const C_O_RE = /\bc\/o\b[^,]*/gi;
const ATTN_RE = /\b(?:attn|attention|care of)\b[:\s][^,]*/gi;
const STREET_TYPE_MAP: Record<string, string> = {
	st: 'street',
	street: 'street',
	ave: 'avenue',
	avenue: 'avenue',
	blvd: 'boulevard',
	boulevard: 'boulevard',
	rd: 'road',
	road: 'road',
	dr: 'drive',
	drive: 'drive',
	ln: 'lane',
	lane: 'lane',
	pl: 'place',
	place: 'place',
	plz: 'plaza',
	plaza: 'plaza',
	ct: 'court',
	court: 'court',
	cir: 'circle',
	circle: 'circle',
	pkwy: 'parkway',
	parkway: 'parkway',
	ter: 'terrace',
	terrace: 'terrace',
	sq: 'square',
	square: 'square',
	hwy: 'highway',
	highway: 'highway',
	way: 'way',
};
const STREET_TYPE_ALT = Object.keys(STREET_TYPE_MAP).join('|');
const HOUSE_STREET_TYPED_RE = new RegExp(
	`\\b(\\d{1,6}[a-z]?)\\s+([a-z0-9.'\\-]+(?:\\s+[a-z0-9.'\\-]+){0,5})\\s+(${STREET_TYPE_ALT})\\b`,
	'i',
);
/** House number + street remainder after locale strip (covers Broadway without a type suffix). */
const HOUSE_STREET_LOOSE_RE = /\b(\d{1,6}[a-z]?)\s+([a-z0-9.'\-]+(?:\s+[a-z0-9.'\-]+){0,5})\s*$/i;
const NAMED_BUILDING_RE =
	/\b([a-z0-9][\w'&.-]*(?:\s+[a-z0-9][\w'&.-]*){0,5})\s+(building|tower|center|centre|plaza|hall|house|complex)\b/i;
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;
const QUAKE_DIST_RE = /^\d+\s*km\b/i;
const CITY_STATE_ONLY_RE =
	/^(?:[a-z][a-z\s.'-]{1,40}\s+)?[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i;
/** Trailing ", City ST ZIP" / "City ST ZIP" / bare ZIP so street parse does not swallow locale. */
const TRAILING_LOCALE_RE =
	/(?:,?\s+)(?:new york|los angeles|san francisco|chicago|boston|dallas|houston|seattle|atlanta|washington|london|paris|toronto|miami|denver|phoenix|minneapolis|charlotte|jacksonville|baltimore|portland|cambridge|brooklyn|manhattan|queens|bronx|arlington|malvern|smithfield|schaumburg|cedar rapids|camas|red bank|palo alto|southfield|summit|wheaton|greensburg|coral gables|chadds ford|lakewood|gandhinagar|mumbai|tokyo|dubai|hong kong|guatemala city|jakarta|toronto|ontario)?(?:\s+[a-z]{2})?(?:\s+\d{5}(?:-\d{4})?)?\s*$/i;
const TRAILING_STATE_ZIP_RE = /(?:\s+[a-z]{2})?\s+\d{5}(?:-\d{4})?\s*$/i;

export type AddressProximityKeys = {
	buildingKey: string | null;
	blockKey: string | null;
	houseNumber: string | null;
	street: string | null;
	buildingName: string | null;
	zip: string | null;
	cleaned: string;
};

/** Strip suite/floor/c-o noise and lowercase for address fingerprinting. */
export function cleanAddressForProximity(raw: string): string {
	return String(raw || '')
		.toLowerCase()
		.replace(C_O_RE, ' ')
		.replace(ATTN_RE, ' ')
		.replace(SUITE_FLOOR_RE, ' ')
		.replace(/[.,#]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeStreetToken(streetCore: string, streetType?: string | null): string {
	const core = streetCore.replace(/\s+/g, ' ').trim();
	if (!streetType) return core;
	const mapped = STREET_TYPE_MAP[streetType.toLowerCase()] || streetType.toLowerCase();
	// Avoid "street street" when core already ended with a type word
	if (new RegExp(`\\b${mapped}$`, 'i').test(core)) return core;
	return `${core} ${mapped}`.replace(/\s+/g, ' ').trim();
}

/**
 * Derive building- and block-level keys from a free-text location.
 * Returns null keys when the string is city/ZIP-only or non-address noise.
 */
export function extractAddressProximityKeys(
	raw: string,
	geoKey?: string | null,
): AddressProximityKeys {
	const cleaned = cleanAddressForProximity(raw);
	const empty: AddressProximityKeys = {
		buildingKey: null,
		blockKey: null,
		houseNumber: null,
		street: null,
		buildingName: null,
		zip: null,
		cleaned,
	};
	if (!cleaned || cleaned.length < 8 || QUAKE_DIST_RE.test(cleaned)) return empty;
	if (CITY_STATE_ONLY_RE.test(cleaned) && !/^\d/.test(cleaned)) {
		const zipOnly = cleaned.match(ZIP_RE);
		return { ...empty, zip: zipOnly ? zipOnly[1] : null };
	}

	const zipM = cleaned.match(ZIP_RE);
	const zip = zipM ? zipM[1] : null;
	const cityFromGeo = (() => {
		const gk = String(geoKey || '');
		const m = gk.match(/:city:([^:]+)$/) || gk.match(/^city:([^:]+)$/);
		return m ? m[1] : null;
	})();
	const locale = zip || cityFromGeo || '';

	// Peel city/state/ZIP so street fingerprints stay stable across suite variants
	let streetLine = cleaned;
	streetLine = streetLine.replace(TRAILING_STATE_ZIP_RE, '').trim();
	streetLine = streetLine.replace(TRAILING_LOCALE_RE, '').trim();
	// Second zip/state pass if city name left a trailing state
	streetLine = streetLine.replace(/\s+[a-z]{2}\s*$/i, '').trim();

	let houseNumber: string | null = null;
	let street: string | null = null;
	const typed = streetLine.match(HOUSE_STREET_TYPED_RE) || cleaned.match(HOUSE_STREET_TYPED_RE);
	if (typed) {
		houseNumber = typed[1];
		street = normalizeStreetToken(typed[2], typed[3]);
	} else {
		const loose = streetLine.match(HOUSE_STREET_LOOSE_RE);
		if (loose) {
			houseNumber = loose[1];
			street = normalizeStreetToken(loose[2], null);
		}
	}

	const named = streetLine.match(NAMED_BUILDING_RE) || cleaned.match(NAMED_BUILDING_RE);
	const buildingName = named
		? `${named[1].replace(/\s+/g, ' ').trim()} ${named[2].toLowerCase()}`
		: null;

	if (!street && !buildingName) {
		return { ...empty, zip };
	}

	const blockKey = street && locale ? `block:${street}|${locale}` : street ? `block:${street}` : null;
	const buildingKey = (() => {
		if (houseNumber && street) {
			return locale
				? `bldg:${houseNumber}|${street}|${locale}`
				: `bldg:${houseNumber}|${street}`;
		}
		if (buildingName && locale) return `bldgname:${buildingName}|${locale}`;
		if (buildingName) return `bldgname:${buildingName}`;
		return null;
	})();

	return { buildingKey, blockKey, houseNumber, street, buildingName, zip, cleaned };
}

/** Compare two address strings; prefer building over block over null. */
export function resolveGeoProximity(
	rawA: string,
	rawB: string,
	geoKey?: string | null,
): { proximity: GeoProximity | null; buildingKey: string | null; blockKey: string | null } {
	const a = extractAddressProximityKeys(rawA, geoKey);
	const b = extractAddressProximityKeys(rawB, geoKey);
	if (a.buildingKey && b.buildingKey && a.buildingKey === b.buildingKey) {
		return { proximity: 'building', buildingKey: a.buildingKey, blockKey: a.blockKey };
	}
	if (a.blockKey && b.blockKey && a.blockKey === b.blockKey) {
		return { proximity: 'block', buildingKey: null, blockKey: a.blockKey };
	}
	return { proximity: null, buildingKey: null, blockKey: null };
}

export type SecondaryGeoSignals = {
	sharedFirmNames: string[];
	sharedRoles: string[];
	nameTokenOverlap: string[];
	boost: number;
};

/** Cap secondary corroboration boost for building/block geo edges. */
export function secondarySignalBoost(parts: {
	sharedFirmCount?: number;
	sharedRoleCount?: number;
	nameTokenOverlapCount?: number;
}): number {
	let boost = 0;
	if ((parts.sharedFirmCount || 0) > 0) {
		boost += SECONDARY_SIGNAL_BOOST.sharedFirm * Math.min(2, parts.sharedFirmCount || 0);
	}
	if ((parts.sharedRoleCount || 0) > 0) {
		boost += SECONDARY_SIGNAL_BOOST.sharedRole * Math.min(2, parts.sharedRoleCount || 0);
	}
	if ((parts.nameTokenOverlapCount || 0) > 0) {
		boost += SECONDARY_SIGNAL_BOOST.nameTokenOverlap * Math.min(3, parts.nameTokenOverlapCount || 0);
	}
	return Number(Math.min(SECONDARY_SIGNAL_BOOST.maxTotal, boost).toFixed(4));
}

/** Default link confidence from relation type (all main categories). */
export function defaultConfidenceForRelation(relationType: ProfileRelationType): number {
	switch (relationType) {
		case 'owned_by':
			return EDGE_WEIGHT_TIERS.directEquity.mid;
		case 'employed_by':
		case 'registered_at':
		case 'alumni_or_faculty':
			return 0.85;
		case 'affiliated_with':
		case 'funded_by':
		case 'regulator_of':
		case 'family_or_associate':
			return EDGE_WEIGHT_TIERS.sharedBoardOrSteering.mid;
		case 'participated_in':
		case 'authored_or_spoke':
		case 'part_of_subject':
			return EDGE_WEIGHT_TIERS.sharedConferenceOrEvent.mid;
		case 'business_tie':
			return 0.45;
		case 'location_overlap':
			return EDGE_WEIGHT_TIERS.sameBlockSameSector.mid;
		case 'temporal_overlap':
			return 0.2;
		case 'mentioned_in':
			return 0.22;
		case 'possible_alignment':
			return 0.12;
		default:
			return 0.5;
	}
}

/** Relation priority for collapsing duplicate peer links (higher wins). */
export function relationPriority(relationType: ProfileRelationType): number {
	switch (relationType) {
		case 'owned_by':
			return 11;
		case 'employed_by':
			return 10;
		case 'registered_at':
		case 'alumni_or_faculty':
			return 9;
		case 'affiliated_with':
		case 'funded_by':
		case 'regulator_of':
			return 7;
		case 'family_or_associate':
		case 'participated_in':
		case 'authored_or_spoke':
			return 6;
		case 'part_of_subject':
			return 5;
		case 'business_tie':
			return 4;
		case 'location_overlap':
		case 'temporal_overlap':
			return 3;
		case 'mentioned_in':
			return 2;
		case 'possible_alignment':
			return 1;
		default:
			return 0;
	}
}

export type EdgeWeightBreakdown = {
	wDirect: number;
	wBoard: number;
	wEvent: number;
	wCity: number;
	wTotal: number;
};

/** Compose W_total from optional components (missing → 0). */
export function composeEdgeWeight(parts: {
	wDirect?: number;
	wBoard?: number;
	wEvent?: number;
	wCity?: number;
}): EdgeWeightBreakdown {
	const wDirect = Math.max(0, Number(parts.wDirect || 0));
	const wBoard = Math.max(0, Number(parts.wBoard || 0));
	const wEvent = Math.max(0, Number(parts.wEvent || 0));
	const wCity = Math.max(0, Number(parts.wCity || 0));
	const wTotal = Number(Math.min(1, wDirect + wBoard + wEvent + wCity).toFixed(4));
	return { wDirect, wBoard, wEvent, wCity, wTotal };
}

/** Caution tier for geo co-location; building matches can reach stronger_indicator. */
export function cautionForCityWeight(
	wCity: number,
	proximity: GeoProximity = 'city',
): 'observation' | 'closer_look' | 'stronger_indicator' {
	if (proximity === 'building' && wCity >= 0.32) return 'stronger_indicator';
	if (proximity === 'building' || proximity === 'block' || wCity >= 0.12) return 'closer_look';
	return 'observation';
}

/** True when geo_key is city-level enough for co-location (not country-only / raw). */
export function isCityLevelGeoKey(geoKey: string): boolean {
	const gk = String(geoKey || '');
	if (!gk || gk.startsWith('country:') || gk.startsWith('raw:')) return false;
	return gk.includes(':city:') || gk.startsWith('city:');
}

/** Alignment kind for a geo proximity grain. */
export function alignmentKindForProximity(
	proximity: GeoProximity,
): 'building_colocation' | 'block_colocation' | 'city_colocation' {
	if (proximity === 'building') return 'building_colocation';
	if (proximity === 'block') return 'block_colocation';
	return 'city_colocation';
}
