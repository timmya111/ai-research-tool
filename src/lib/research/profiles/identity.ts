import {
	irsEinSetsConflict,
	normalizeText,
	stripLegalSuffixes,
} from '@/lib/research/profiles/normalize';
import { tickerListingKey, resolveTickerListing } from '@/lib/research/profiles/tickerListing';
import type {
	CorroborationHit,
	IdentityDecision,
	IdentityEvaluation,
	NameMatchKind,
	ProfileDetail,
	ProfileType,
} from '@/lib/research/profiles/types';

export type ProfileIdentityContext = {
	profileId: string;
	profileType: ProfileType;
	name: string;
	aliases: string[];
	identifiers: Array<{ scheme: string; value: string; normalizedValue: string }>;
	locations: Array<{
		raw: string;
		city: string | null;
		county: string | null;
		state: string | null;
		country: string | null;
		geoKey: string;
	}>;
	/** Linked firms, employers, or (for firm profiles) linked key people/subsidiaries */
	firmsAndAssociates: string[];
	/** Linked universities, schools, hospitals, government agencies, nonprofits */
	institutions: string[];
	/**
	 * 1-hop graph peers used for Wikipedia/candidate corroboration that are not already
	 * covered by firmsAndAssociates/institutions — especially `historic_event` titles and
	 * distinctive multi-word org/event phrases (e.g. "Starck Club Young Republicans fundraiser").
	 */
	graphNeighbors: string[];
	/** Military bases, installations, plants, commands, or branches associated with this profile */
	militarySignals: string[];
	summary: string;
	/** Rich combined description corpus (summary + timeline titles/summaries + link roles/notes + metadata) */
	descriptionText: string;
	startDate: string | null;
	endDate: string | null;
	timelineYears: number[];
	/** Listing venue for ticker identifiers (metadata.exchange). Bare symbols do not match. */
	listingExchange?: string | null;
};

export type CandidateIdentityInput = {
	candidateName: string;
	candidateAliases?: string[];
	candidateIdentifiers?: Array<{ scheme: string; value: string }>;
	candidateLocations?: string[];
	candidateFirms?: string[];
	candidateMilitarySignals?: string[];
	candidateInstitutions?: string[];
	candidateStartDate?: string | null;
	candidateEndDate?: string | null;
	candidateEventDates?: string[];
	candidateText: string;
	/** Listing venue when the candidate ticker value does not already include one. */
	candidateExchange?: string | null;
};

const NICKNAME_GROUPS: string[][] = [
	['alex', 'alexander', 'alexandra', 'alec', 'lex', 'sandy'],
	['larry', 'lawrence', 'laurence'],
	['bob', 'bobby', 'rob', 'robbie', 'robert', 'bert'],
	['bill', 'billy', 'will', 'willie', 'william', 'liam'],
	['jim', 'jimmy', 'jamie', 'james'],
	['tom', 'tommy', 'thomas'],
	['mike', 'mikey', 'mick', 'michael'],
	['dick', 'rick', 'ricky', 'rich', 'richie', 'richard'],
	['dave', 'davy', 'david'],
	['dan', 'danny', 'daniel'],
	['joe', 'joey', 'joseph'],
	['steve', 'stevie', 'steven', 'stephen'],
	['chris', 'christopher', 'christian', 'christine', 'christina'],
	['matt', 'matthew'],
	['nick', 'nicky', 'nicholas', 'nicolas'],
	['tony', 'anthony'],
	['ed', 'eddie', 'edward', 'edwin', 'edgar', 'ted', 'teddy'],
	['ted', 'teddy', 'theodore', 'theo'],
	['charlie', 'chuck', 'charles'],
	['jack', 'john', 'johnny', 'jon', 'jonathan'],
	['ben', 'benny', 'benjamin'],
	['sam', 'sammy', 'samuel', 'samantha'],
	['greg', 'gregory'],
	['jeff', 'jeffrey', 'geoffrey'],
	['ken', 'kenny', 'kenneth'],
	['ron', 'ronnie', 'ronald'],
	['don', 'donnie', 'donald'],
	['pat', 'patty', 'patrick', 'patricia'],
	['liz', 'beth', 'betty', 'eliza', 'elizabeth'],
	['kate', 'katie', 'kathy', 'cathy', 'katherine', 'catherine', 'kathryn'],
	['sue', 'suzie', 'susan', 'suzanne'],
	['meg', 'peggy', 'maggie', 'margaret'],
	['andy', 'drew', 'andrew'],
	['phil', 'philip', 'phillip'],
	['pete', 'peter'],
	['ray', 'raymond'],
	['jerry', 'gerry', 'gerald', 'jerome'],
	['harry', 'hal', 'hank', 'henry', 'harold'],
	['al', 'albert', 'alan', 'allen', 'alfred'],
	['art', 'artie', 'arthur'],
	['frank', 'frankie', 'francis', 'franklin'],
	['walt', 'walter'],
	['herb', 'herbert'],
	['stan', 'stanley'],
	['marty', 'martin'],
	['bernie', 'bernard'],
	['norm', 'norman'],
	['ernie', 'ernest'],
	['fred', 'freddy', 'frederick'],
	['tim', 'timmy', 'timothy'],
	['brad', 'bradley'],
	['doug', 'douglas'],
	['russ', 'russell'],
	['vince', 'vincent'],
	['stu', 'stuart', 'stewart'],
	['gene', 'eugene'],
	['len', 'lenny', 'leo', 'leonard'],
	['nate', 'nathan', 'nathaniel'],
	['josh', 'joshua'],
	['zach', 'zack', 'zachary'],
	['abe', 'abraham'],
	['wes', 'wesley'],
	['mel', 'melvin'],
	['erle', 'earl'],
];

const NICKNAME_MAP = new Map<string, Set<string>>();
for (const group of NICKNAME_GROUPS) {
	const set = new Set(group);
	for (const name of group) {
		const existing = NICKNAME_MAP.get(name) || new Set<string>();
		for (const item of set) existing.add(item);
		NICKNAME_MAP.set(name, existing);
	}
}

const GENERIC_ORG_STOPWORDS = new Set([
	'company',
	'corporation',
	'corp',
	'group',
	'holdings',
	'partners',
	'capital',
	'ventures',
	'financial',
	'securities',
	'advisors',
	'advisers',
	'investments',
	'management',
	'services',
	'solutions',
	'systems',
	'technologies',
	'international',
	'global',
	'american',
	'national',
	'united',
	'united states',
	'federal',
	'state',
	'department',
	'institute',
	'foundation',
	'association',
	'society',
	'trust',
	'bank',
	'university',
	'college',
	'school',
	'hospital',
	'medical',
	'center',
	'clinic',
	'research',
	'energy',
	'resources',
	'properties',
	'realty',
	'development',
	'industries',
	'manufacturing',
	'enterprises',
	'consulting',
	'agency',
	'commission',
	'board',
	'office',
	'council',
	'committee',
	'authority',
	'fund',
	'funds',
	'asset',
	'assets',
	'equity',
	'private',
	'public',
	'general',
	'first',
	'second',
	'north',
	'south',
	'east',
	'west',
	'central',
	'western',
	'eastern',
	'northern',
	'southern',
]);

const GENERIC_GEO_STOPWORDS = new Set([
	'us',
	'usa',
	'u s',
	'u s a',
	'united states',
	'united states of america',
	'america',
	'north america',
	'europe',
	'asia',
	'world',
	'global',
	'unknown',
	'county',
	'city',
	'state',
]);

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'jd', 'esq', 'cfa', 'cpa']);
const NAME_PREFIXES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'gen', 'col', 'lt', 'maj', 'capt', 'adm', 'sgt', 'rev', 'hon', 'sen', 'rep', 'gov', 'sir']);

const SPECIFIC_MILITARY_BASES = [
	'air force plant 4',
	'carswell air force base',
	'carswell afb',
	'nas jrb fort worth',
	'naval air station joint reserve base fort worth',
	'naval air station fort worth',
	'fort worth army airfield',
	'fort hood',
	'fort cavazos',
	'fort sill',
	'tinker air force base',
	'tinker afb',
	'dyess air force base',
	'dyess afb',
	'lackland air force base',
	'lackland afb',
	'randolph air force base',
	'randolph afb',
	'kelly air force base',
	'kelly afb',
	'sheppard air force base',
	'sheppard afb',
	'brooks air force base',
	'fort sam houston',
	'fort bliss',
	'red river army depot',
	'pentagon',
	'fort bragg',
	'fort liberty',
	'fort meade',
	'fort detrick',
	'fort belvoir',
	'fort benning',
	'fort moore',
	'fort campbell',
	'fort knox',
	'fort leavenworth',
	'fort riley',
	'fort drum',
	'fort stewart',
	'fort polk',
	'fort johnson',
	'fort carson',
	'fort lewis',
	'joint base lewis mcchord',
	'camp pendleton',
	'camp lejeune',
	'quantico',
	'wright patterson',
	'edwards air force base',
	'edwards afb',
	'eglin air force base',
	'eglin afb',
	'nellis air force base',
	'langley air force base',
	'andrews air force base',
	'offutt air force base',
	'barksdale air force base',
	'macdill air force base',
	'peterson space force base',
	'vandenberg',
	'redstone arsenal',
	'picatinny arsenal',
	'aberdeen proving ground',
	'white sands missile range',
	'naval station norfolk',
	'pearl harbor',
	'camp david',
	'ramstein',
	'northcom',
	'centcom',
	'socom',
	'darpa',
	'department of defense',
	'u s army',
	'united states army',
	'u s navy',
	'united states navy',
	'u s air force',
	'united states air force',
	'u s marine corps',
	'united states marine corps',
	'u s coast guard',
	'united states coast guard',
	'u s space force',
	'army air forces',
	'army air corps',
	'national guard',
	'texas national guard',
	'oklahoma national guard',
	'royal air force',
	'british army',
	'royal navy',
];

const GENERIC_BASE_REGEX =
	/\b(?:Fort|Camp|Naval Air Station|Air Force Base|Air Force Plant|Army Depot|Arsenal|Proving Ground|Joint Base|Marine Corps Base)\s+[A-Z0-9][A-Za-z0-9-]{1,22}(?:\s+[A-Z0-9][A-Za-z0-9-]{1,18})?/g;

const US_STATE_NAMES: Record<string, string> = {
	al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
	co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
	hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
	ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
	ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
	mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
	nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
	ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
	sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
	va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
	dc: 'district of columbia',
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(haystackNorm: string, phraseNorm: string): boolean {
	if (!phraseNorm || phraseNorm.length < 3) return false;
	const re = new RegExp(`(?:^| )${escapeRegExp(phraseNorm)}(?:$| )`);
	return re.test(haystackNorm);
}

/**
 * Standard Levenshtein edit distance (bounded for speed).
 */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	if (Math.abs(a.length - b.length) > 4) return Math.abs(a.length - b.length);
	const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
			prev = tmp;
		}
	}
	return dp[b.length];
}

/**
 * Jaro-Winkler string similarity in [0, 1].
 */
export function jaroWinkler(s1: string, s2: string): number {
	if (s1 === s2) return 1;
	if (!s1.length || !s2.length) return 0;
	const matchDist = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
	const m1 = new Array<boolean>(s1.length).fill(false);
	const m2 = new Array<boolean>(s2.length).fill(false);
	let matches = 0;
	for (let i = 0; i < s1.length; i++) {
		const start = Math.max(0, i - matchDist);
		const end = Math.min(i + matchDist + 1, s2.length);
		for (let j = start; j < end; j++) {
			if (!m2[j] && s1[i] === s2[j]) {
				m1[i] = true;
				m2[j] = true;
				matches++;
				break;
			}
		}
	}
	if (!matches) return 0;
	let t = 0;
	let k = 0;
	for (let i = 0; i < s1.length; i++) {
		if (!m1[i]) continue;
		while (!m2[k]) k++;
		if (s1[i] !== s2[k]) t++;
		k++;
	}
	t /= 2;
	const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
	let prefix = 0;
	for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
		if (s1[i] === s2[i]) prefix++;
		else break;
	}
	return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Normalize a person name, supporting both "First Middle Last" and "LAST, FIRST M." forms.
 */
const GEN_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function parsePersonNameParts(raw: string): {
	normalized: string;
	first: string;
	middles: string[];
	last: string;
	genSuffix: string | null;
	tokens: string[];
} {
	const cleaned = String(raw || '').trim();
	let reordered = cleaned;
	// Handle "LAST, FIRST [MIDDLE]" (exclude corporate/suffix commas like ", Jr." or ", PhD")
	const commaIdx = cleaned.indexOf(',');
	if (commaIdx > 0 && commaIdx < cleaned.length - 1) {
		const left = cleaned.slice(0, commaIdx).trim();
		const right = cleaned.slice(commaIdx + 1).trim();
		const rightNorm = normalizeText(right);
		const rightTokens = rightNorm.split(' ').filter(Boolean);
		const isSuffixOnly = rightTokens.length > 0 && rightTokens.every((t) => NAME_SUFFIXES.has(t));
		const leftTokens = normalizeText(left).split(' ').filter(Boolean);
		if (!isSuffixOnly && leftTokens.length >= 1 && leftTokens.length <= 2 && rightTokens.length >= 1 && rightTokens.length <= 3) {
			reordered = `${right} ${left}`;
		}
	}

	const normAll = normalizeText(reordered).split(' ').filter(Boolean);
	let genSuffix: string | null = null;
	const rawTokens = normAll.filter((t, idx, arr) => {
		if (idx === 0 && NAME_PREFIXES.has(t) && arr.length > 1) return false;
		if (idx === arr.length - 1 && NAME_SUFFIXES.has(t) && arr.length > 1) {
			if (GEN_SUFFIXES.has(t)) genSuffix = t;
			return false;
		}
		return true;
	});

	const first = rawTokens[0] || '';
	const last = rawTokens.length >= 2 ? rawTokens[rawTokens.length - 1] : '';
	const middles = rawTokens.length >= 3 ? rawTokens.slice(1, -1) : [];

	return {
		normalized: rawTokens.join(' '),
		first,
		middles,
		last,
		genSuffix,
		tokens: rawTokens,
	};
}

function areNicknameEquivalents(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const setA = NICKNAME_MAP.get(a);
	if (setA && setA.has(b)) return true;
	return false;
}

/**
 * Compare two names (for a person or an organization/event) and classify the match as:
 * - `exact_name`
 * - `fuzzy_name` (nicknames, minor spelling/typo differences, legal-suffix stripped org match)
 * - `initials_or_partial` (e.g., `J. Smith` <-> `John Smith`, `E. P. Halliburton` <-> `Erle P. Halliburton`, `Alex` <-> `Alexander`)
 * - `none`
 */
export function compareSingleNamePair(
	aRaw: string,
	bRaw: string,
	profileType: ProfileType,
): { kind: NameMatchKind; similarity: number } {
	const aNorm = normalizeText(aRaw);
	const bNorm = normalizeText(bRaw);
	if (!aNorm || !bNorm) return { kind: 'none', similarity: 0 };

	if (aNorm === bNorm) {
		return { kind: 'exact_name', similarity: 1.0 };
	}

	if (profileType === 'person') {
		const pa = parsePersonNameParts(aRaw);
		const pb = parsePersonNameParts(bRaw);
		if (!pa.tokens.length || !pb.tokens.length) return { kind: 'none', similarity: 0 };

		// Reject explicit generational suffix mismatches (e.g. Jr. vs Sr., III vs IV, V vs I/none)
		if (pa.genSuffix !== pb.genSuffix) {
			const hasDistinctNumeral =
				(pa.genSuffix && ['ii', 'iii', 'iv', 'v', 'jr'].includes(pa.genSuffix)) ||
				(pb.genSuffix && ['ii', 'iii', 'iv', 'v', 'jr'].includes(pb.genSuffix));
			if (hasDistinctNumeral) {
				return { kind: 'none', similarity: 0 };
			}
		}

		if (pa.normalized === pb.normalized) {
			return { kind: 'exact_name', similarity: 0.99 };
		}

		// Require both sides to have at least first + last (2 tokens) for person matching
		if (!pa.last || !pb.last) {
			return { kind: 'none', similarity: 0 };
		}

		const lastExact = pa.last === pb.last;
		const lastDist = levenshtein(pa.last, pb.last);
		const lastFuzzy =
			!lastExact &&
			pa.last.length >= 5 &&
			pb.last.length >= 5 &&
			(lastDist <= 1 || jaroWinkler(pa.last, pb.last) >= 0.92);

		if (!lastExact && !lastFuzzy) {
			return { kind: 'none', similarity: 0 };
		}

		// Check if middle initial conflicts explicitly (e.g. "John A. Smith" vs "John B. Smith")
		if (pa.middles.length > 0 && pb.middles.length > 0) {
			const ma = pa.middles[0][0];
			const mb = pb.middles[0][0];
			if (ma && mb && ma !== mb) {
				// Still allow if one is a fuller form of a nickname/first name match? Usually different middle initial = weak/no match
				return { kind: 'none', similarity: 0.35 };
			}
		}

		// Exact first + exact last (ignoring middle name/initial presence on one side)
		if (lastExact && pa.first === pb.first) {
			return { kind: 'exact_name', similarity: 0.97 };
		}

		// Nickname equivalent (e.g., Alex Karp <-> Alexander Caedmon Karp, Larry Bell <-> Lawrence Dale Bell)
		if (areNicknameEquivalents(pa.first, pb.first)) {
			return { kind: 'fuzzy_name', similarity: lastExact ? 0.93 : 0.87 };
		}

		// First-name typo/fuzzy match (edit distance <= 1 for len >= 4, or Jaro-Winkler >= 0.90)
		const firstDist = levenshtein(pa.first, pb.first);
		const firstJw = jaroWinkler(pa.first, pb.first);
		if (
			pa.first.length >= 3 &&
			pb.first.length >= 3 &&
			((firstDist <= 1 && Math.min(pa.first.length, pb.first.length) >= 4) || firstJw >= 0.9)
		) {
			return { kind: 'fuzzy_name', similarity: lastExact ? 0.9 : 0.84 };
		}

		// Partial prefix of given name (e.g. "Alex" <-> "Alexander", "Lawr" <-> "Lawrence", len >= 3)
		if (
			pa.first.length >= 3 &&
			pb.first.length >= 3 &&
			(pa.first.startsWith(pb.first) || pb.first.startsWith(pa.first))
		) {
			return { kind: 'initials_or_partial', similarity: lastExact ? 0.86 : 0.8 };
		}

		// Initials + surname (e.g. "A. Karp" <-> "Alex Karp", "E. P. Halliburton" <-> "Erle P. Halliburton")
		const aIsInitial = pa.first.length === 1;
		const bIsInitial = pb.first.length === 1;
		if (aIsInitial || bIsInitial) {
			const init = aIsInitial ? pa.first : pb.first;
			const full = aIsInitial ? pb.first : pa.first;
			if (full[0] === init) {
				return { kind: 'initials_or_partial', similarity: lastExact ? 0.82 : 0.76 };
			}
			// Check nickname initial (e.g. "B. Smith" <-> "William Smith" -> Bill)
			const nicks = NICKNAME_MAP.get(full);
			if (nicks && [...nicks].some((n) => n[0] === init)) {
				return { kind: 'initials_or_partial', similarity: lastExact ? 0.78 : 0.72 };
			}
		}

		// Double initials concatenated without space: "EP Halliburton" <-> "Erle P Halliburton"
		if (
			(pa.first.length === 2 && pa.middles.length === 0 && pb.middles.length >= 1 && pa.first[0] === pb.first[0] && pa.first[1] === pb.middles[0][0]) ||
			(pb.first.length === 2 && pb.middles.length === 0 && pa.middles.length >= 1 && pb.first[0] === pa.first[0] && pb.first[1] === pa.middles[0][0])
		) {
			return { kind: 'initials_or_partial', similarity: lastExact ? 0.84 : 0.78 };
		}

		return { kind: 'none', similarity: 0 };
	}

	// Non-person (firm, education, nonprofit, medical_hospital, government, historic_event)
	const aStripped = stripLegalSuffixes(aRaw);
	const bStripped = stripLegalSuffixes(bRaw);
	if (aStripped.length >= 4 && bStripped.length >= 4 && aStripped === bStripped) {
		return { kind: 'exact_name', similarity: 0.96 };
	}

	// Check acronym match if one is short uppercase-style acronym of the other (e.g. "UTD" vs "University of Texas at Dallas")
	const aTokens = aNorm.split(' ').filter((t) => t.length >= 2 && !['of', 'the', 'and', 'for', 'at', 'in'].includes(t));
	const bTokens = bNorm.split(' ').filter((t) => t.length >= 2 && !['of', 'the', 'and', 'for', 'at', 'in'].includes(t));
	const aAcronym = aTokens.map((t) => t[0]).join('');
	const bAcronym = bTokens.map((t) => t[0]).join('');
	if ((aNorm.length >= 3 && aNorm.length <= 6 && aNorm === bAcronym) || (bNorm.length >= 3 && bNorm.length <= 6 && bNorm === aAcronym)) {
		return { kind: 'initials_or_partial', similarity: 0.8 };
	}

	// Fuzzy Jaro-Winkler on legal-suffix-stripped names
	if (aStripped.length >= 5 && bStripped.length >= 5) {
		const jw = jaroWinkler(aStripped, bStripped);
		if (jw >= 0.92) {
			return { kind: 'fuzzy_name', similarity: Number(jw.toFixed(3)) };
		}
		// Partial containment (e.g. "Bell Helicopter" <-> "Bell Helicopter Textron" or "Halliburton" <-> "Halliburton Energy Services")
		// Require meaningful length coverage (>= 0.55) so a single city/word like "Dallas" never matches a long composite title.
		const minLen = Math.min(aStripped.length, bStripped.length);
		const maxLen = Math.max(aStripped.length, bStripped.length);
		const lenRatio = maxLen > 0 ? minLen / maxLen : 0;
		const shorterTokens = Math.min(aTokens.length, bTokens.length);
		const longerTokens = Math.max(aTokens.length, bTokens.length);
		if (
			lenRatio >= 0.55 &&
			!(longerTokens >= 4 && shorterTokens < 2) &&
			((aStripped.length >= 6 && hasPhrase(bStripped, aStripped)) ||
				(bStripped.length >= 6 && hasPhrase(aStripped, bStripped)))
		) {
			if (!GENERIC_ORG_STOPWORDS.has(aStripped) && !GENERIC_ORG_STOPWORDS.has(bStripped)) {
				return { kind: 'initials_or_partial', similarity: Number((0.75 + lenRatio * 0.15).toFixed(3)) };
			}
		}
	}

	return { kind: 'none', similarity: 0 };
}

/**
 * Evaluate the best name match across all known names/aliases of the profile and candidate.
 */
export function evaluateNameMatch(
	profileNames: string[],
	candidateNames: string[],
	profileType: ProfileType,
): {
	kind: NameMatchKind;
	similarity: number;
	matchedQueryName: string | null;
	matchedCandidateName: string | null;
} {
	const rank: Record<NameMatchKind, number> = {
		exact_name: 3,
		fuzzy_name: 2,
		initials_or_partial: 1,
		none: 0,
	};
	let best = {
		kind: 'none' as NameMatchKind,
		similarity: 0,
		matchedQueryName: null as string | null,
		matchedCandidateName: null as string | null,
	};

	const pClean = [...new Set(profileNames.map((s) => String(s || '').trim()).filter((s) => s.length >= 2))];
	const cClean = [...new Set(candidateNames.map((s) => String(s || '').trim()).filter((s) => s.length >= 2))];

	for (const pn of pClean) {
		for (const cn of cClean) {
			const res = compareSingleNamePair(pn, cn, profileType);
			if (
				rank[res.kind] > rank[best.kind] ||
				(rank[res.kind] === rank[best.kind] && res.similarity > best.similarity)
			) {
				best = {
					kind: res.kind,
					similarity: res.similarity,
					matchedQueryName: pn,
					matchedCandidateName: cn,
				};
			}
		}
	}

	return best;
}

/**
 * Extract normalized military bases, plants, installations, commands, and branches from text.
 */
const NON_MILITARY_FORT_CITIES = new Set([
	'fort worth',
	'fort lauderdale',
	'fort wayne',
	'fort collins',
	'fort myers',
	'fort smith',
	'fort pierce',
	'fort walton',
	'fort dodge',
	'fort morgan',
	'fort scott',
	'fort madison',
	'fort lee',
	'fort washington',
]);

export function extractMilitarySignals(text: string): string[] {
	const found = new Set<string>();
	const norm = normalizeText(text);
	if (!norm) return [];

	for (const base of SPECIFIC_MILITARY_BASES) {
		if (hasPhrase(norm, base)) {
			found.add(base);
		}
	}

	const rawText = String(text || '');
	const matches = rawText.matchAll(GENERIC_BASE_REGEX);
	for (const m of matches) {
		const clean = normalizeText(m[0]);
		if (clean.length >= 7 && !NON_MILITARY_FORT_CITIES.has(clean)) found.add(clean);
	}

	return [...found];
}

function extractYearsFromDateStr(d?: string | null): number | null {
	if (!d) return null;
	const m = String(d).match(/\b(1[5-9]\d{2}|20\d{2})\b/);
	return m ? Number(m[1]) : null;
}

function extractZipCodes(text: string): string[] {
	const zips = new Set<string>();
	const matches = String(text || '').matchAll(/\b(\d{5})(?:-\d{4})?\b/g);
	for (const m of matches) {
		const z = m[1];
		// Skip obvious years/CRDs/unlikely prefixes
		if (z.startsWith('00')) continue;
		zips.add(z);
	}
	return [...zips];
}

function extractStreetKeys(text: string): string[] {
	const keys = new Set<string>();
	const re = /\b(\d{2,6})\s+([A-Za-z0-9.\s]{2,28}?)\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pkwy|Parkway|Hwy|Highway|Pl|Place|Cir|Circle)\b/gi;
	for (const m of String(text || '').matchAll(re)) {
		const key = normalizeText(`${m[1]} ${m[2]}`);
		if (key.length >= 6) keys.add(key);
	}
	return [...keys];
}

function isDistinctOrgToken(raw: string): boolean {
	const norm = normalizeText(raw);
	if (norm.length < 4) return false;
	if (GENERIC_ORG_STOPWORDS.has(norm)) return false;
	const stripped = stripLegalSuffixes(norm);
	if (stripped.length < 4 || GENERIC_ORG_STOPWORDS.has(stripped)) return false;
	return true;
}

/**
 * Build a ProfileIdentityContext from a loaded ProfileDetail object.
 */
export function buildProfileIdentityContext(detail: ProfileDetail): ProfileIdentityContext {
	const aliases = detail.aliases.map((a) => a.alias).filter(Boolean);
	const identifiers = detail.identifiers.map((i) => ({
		scheme: i.scheme,
		value: i.value,
		normalizedValue: i.normalizedValue,
	}));
	const listingExchange =
		typeof detail.profile.metadata?.exchange === 'string'
			? detail.profile.metadata.exchange
			: null;
	const locations = detail.locations.map((l) => ({
		raw: l.raw,
		city: l.city,
		county: l.county,
		state: l.state,
		country: l.country,
		geoKey: l.geoKey,
	}));

	const firmsSet = new Set<string>();
	const instSet = new Set<string>();
	const neighborSet = new Set<string>();
	const milTextParts: string[] = [detail.profile.summary];

	for (const emp of detail.employmentHistory) {
		if (emp.orgName) {
			if (emp.orgCategory === 'firm') firmsSet.add(emp.orgName);
			else instSet.add(emp.orgName);
		}
		if (emp.location) milTextParts.push(emp.location);
		if (emp.evidenceNote) milTextParts.push(emp.evidenceNote);
	}

	for (const link of detail.links) {
		const isOut = link.fromProfileId === detail.profile.id;
		const peerName = isOut ? link.toName : link.fromName;
		const peerType = isOut ? link.toType : link.fromType;
		if (peerName) {
			if (peerType === 'firm' || peerType === 'person') {
				firmsSet.add(peerName);
			} else if (
				peerType === 'education' ||
				peerType === 'medical_hospital' ||
				peerType === 'government' ||
				peerType === 'nonprofit'
			) {
				instSet.add(peerName);
			} else if (peerType === 'historic_event') {
				neighborSet.add(peerName);
				// Also keep a shortened distinctive head when the event title is long
				const head = peerName.split(/[,:(–—-]/)[0]?.trim();
				if (head && head.length >= 6 && head !== peerName) neighborSet.add(head);
			}
		}
		if (link.evidenceNote) milTextParts.push(link.evidenceNote);
		if (link.roleLabel) milTextParts.push(link.roleLabel);
	}

	for (const loc of detail.locations) {
		milTextParts.push(loc.raw);
	}

	const timelineYears: number[] = [];
	const descParts: string[] = [];
	if (detail.profile.summary) descParts.push(detail.profile.summary);

	// Pull any existing descriptive metadata fields
	const meta = detail.profile.metadata || {};
	for (const k of [
		'occupation',
		'title',
		'industry',
		'knownFor',
		'notableWorks',
		'products',
		'services',
		'officesHeld',
		'militaryBranch',
		'militaryUnit',
		'battlesWars',
		'description',
		'notes',
		'category',
		'sector',
	]) {
		const v = meta[k];
		if (typeof v === 'string' && v.trim()) descParts.push(v.trim());
		else if (Array.isArray(v)) descParts.push(v.map(String).join(' '));
	}
	if (Array.isArray(meta.identifyingKeywords)) {
		descParts.push(meta.identifyingKeywords.map(String).join(' '));
	}

	for (const link of detail.links) {
		if (link.roleLabel) descParts.push(link.roleLabel);
		if (link.evidenceNote) descParts.push(link.evidenceNote);
	}

	const profileBirthYear = extractYearsFromDateStr(detail.profile.startDate);
	for (const te of detail.recentTimeline) {
		const y = extractYearsFromDateStr(te.eventDate);
		const isLifeBoundary =
			/^(?:born|died|birth|death)\b/i.test(te.title.trim()) ||
			(detail.profile.profileType === 'person' && profileBirthYear != null && y != null && y <= profileBirthYear + 14);
		if (y && !isLifeBoundary) timelineYears.push(y);
		milTextParts.push(te.title, te.summary);
		descParts.push(te.title, te.summary);
	}

	return {
		profileId: detail.profile.id,
		profileType: detail.profile.profileType,
		name: detail.profile.name,
		aliases,
		identifiers,
		locations,
		firmsAndAssociates: [...firmsSet],
		institutions: [...instSet],
		graphNeighbors: [...neighborSet],
		militarySignals: extractMilitarySignals(milTextParts.join(' \n ')),
		summary: detail.profile.summary || '',
		descriptionText: descParts.join(' \n ').slice(0, 12_000),
		startDate: detail.profile.startDate,
		endDate: detail.profile.endDate,
		timelineYears,
		listingExchange,
	};
}

const DOMAIN_ANCHOR_KEYWORDS = new Set([
	'senator', 'governor', 'vice president', 'president', 'congressman', 'representative', 'mayor',
	'diplomat', 'ambassador', 'secretary', 'minister', 'chancellor', 'attorney', 'lawyer', 'judge',
	'prosecutor', 'justice', 'politician', 'legislator', 'billionaire', 'entrepreneur', 'venture',
	'philanthropist', 'financier', 'banker', 'economist', 'investor', 'broker', 'securities',
	'trader', 'hedge', 'banking', 'brokerage', 'adviser', 'advisor', 'fiduciary', 'general',
	'admiral', 'colonel', 'commander', 'captain', 'major', 'lieutenant', 'pilot', 'astronaut',
	'soldier', 'veteran', 'marine', 'airman', 'sailor', 'physicist', 'chemist', 'biologist',
	'virologist', 'epidemiologist', 'immunologist', 'physician', 'surgeon', 'doctor', 'geologist',
	'geophysicist', 'astronomer', 'mathematician', 'scientist', 'inventor', 'engineer', 'architect',
	'professor', 'academic', 'scholar', 'historian', 'aerospace', 'helicopter', 'rotorcraft',
	'aviation', 'aircraft', 'avionics', 'radar', 'missile', 'defense', 'defence', 'munitions',
	'oilfield', 'petroleum', 'cementing', 'drilling', 'pipeline', 'refinery', 'fracking',
	'stainless', 'seamless', 'tubular', 'steel', 'metallurgy', 'semiconductor', 'transistor',
	'software', 'analytics', 'intelligence', 'surveillance', 'biotech', 'pharmaceutical', 'vaccine',
	'pandemic', 'coronavirus', 'earthquake', 'seismic', 'tornado', 'aquifer', 'hydrology',
	'musician', 'singer', 'songwriter', 'producer', 'filmmaker', 'director', 'actor', 'actress',
	'author', 'novelist', 'journalist', 'reporter', 'publisher', 'editor', 'artist', 'painter',
	'sculptor', 'composer', 'electronic', 'union', 'labor', 'labour', 'strike', 'riot', 'massacre',
	'bombing', 'insurgency', 'revolution', 'peacekeeping', 'genocide', 'treaty', 'armistice',
	'rebellion', 'conflict', 'intervention', 'invasion', 'siege', 'guerrilla', 'militia', 'nato',
	'balkans', 'yugoslavia', 'kosovo', 'bosnia', 'serbia', 'albania', 'freetown', 'liberia',
	'iraq', 'afghanistan', 'syria', 'yemen', 'libya', 'ukraine', 'crimea', 'donbas', 'wall street',
	'clearinghouse', 'railroad', 'textile', 'shipbuilding', 'whaling', 'maritime', 'finra', 'edgar',
]);

const DESCRIPTION_STOPWORDS = new Set([
	...GENERIC_ORG_STOPWORDS,
	...GENERIC_GEO_STOPWORDS,
	'about', 'after', 'again', 'against', 'their', 'there', 'these', 'those', 'which', 'where',
	'while', 'years', 'since', 'known', 'based', 'major', 'large', 'small', 'other', 'under',
	'between', 'through', 'during', 'before', 'within', 'without', 'including', 'founded',
	'headquartered', 'located', 'operates', 'provides', 'offers', 'products', 'business',
	'record', 'records', 'profile', 'entity', 'source', 'corpus', 'timeline', 'history',
	'article', 'summary', 'details', 'overview', 'people', 'person', 'individual', 'member',
	'former', 'current', 'active', 'inactive', 'status', 'registered', 'filing', 'filings',
	'document', 'documents', 'report', 'reports', 'series', 'number', 'total', 'count', 'event',
	'events', 'period', 'early', 'later', 'first', 'second', 'third', 'became', 'began', 'started',
	'ended', 'continued', 'several', 'many', 'multiple', 'various', 'different', 'important',
	'significant', 'notable', 'leading', 'primary', 'modern', 'recent', 'following', 'according',
	'however', 'although', 'because', 'despite', 'until', 'around', 'approximately', 'nearly',
	'already', 'still', 'often', 'usually', 'mostly', 'largely', 'mainly', 'partly', 'worked',
	'served', 'joined', 'helped', 'created', 'built', 'developed', 'established', 'formed',
	'named', 'called', 'titled', 'described', 'mentioned', 'appears', 'appeared', 'included',
	'linked', 'associated', 'affiliated', 'connected', 'related', 'involved', 'participated',
	'wikipedia', 'local', 'knowledge', 'dossier', 'dossiers', 'manual', 'import', 'imported',
	'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
	'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

const GENERIC_PROPER_PHRASE_RE =
	/^(?:United States|New York|North America|South America|World War|Great Britain|United Kingdom|European Union|White House|Supreme Court|Department Of|University Of|City Of|State Of|County Of|Timeline Of|History Of|Conflict Since)$/i;

/**
 * Extract high-specificity identifying keywords and proper-noun phrases from an entity's
 * existing description, timeline entries, notes, and metadata.
 */
export function extractIdentifyingKeywords(
	descriptionText: string,
	entityName: string,
): {
	properPhrases: string[];
	domainAnchors: string[];
	distinctiveTerms: string[];
	years: string[];
} {
	const raw = String(descriptionText || '').trim();
	if (!raw) {
		return { properPhrases: [], domainAnchors: [], distinctiveTerms: [], years: [] };
	}

	const nameNorm = normalizeText(entityName);
	const nameTokens = new Set(nameNorm.split(' ').filter((t) => t.length >= 2));

	// 1. Multi-word proper phrases (e.g. "Hillbilly Elegy", "Standard Oil", "Bell X-1", "Sierra Leone", "Red Army")
	const properSet = new Set<string>();
	const properRe = /\b([A-Z][a-zA-Z0-9'-]{2,}(?:\s+(?:of|the|and|for|in)?\s*[A-Z][a-zA-Z0-9'-]{1,}){1,3})\b/g;
	for (const m of raw.matchAll(properRe)) {
		const phraseRaw = m[1].replace(/\s+/g, ' ').trim();
		const phraseNorm = normalizeText(phraseRaw);
		if (phraseNorm.length < 6 || phraseNorm.length > 48) continue;
		if (phraseNorm === nameNorm || hasPhrase(nameNorm, phraseNorm)) continue;
		if (GENERIC_PROPER_PHRASE_RE.test(phraseRaw)) continue;
		const toks = phraseNorm.split(' ').filter(Boolean);
		if (toks.length < 2) continue;
		if (toks.every((t) => DESCRIPTION_STOPWORDS.has(t) || nameTokens.has(t))) continue;
		properSet.add(phraseNorm);
		if (properSet.size >= 24) break;
	}

	const norm = normalizeText(raw);

	// 2. Domain/role anchor terms
	const anchorSet = new Set<string>();
	for (const anchor of DOMAIN_ANCHOR_KEYWORDS) {
		if (nameTokens.has(anchor) || anchor === nameNorm) continue;
		if (hasPhrase(norm, anchor)) {
			anchorSet.add(anchor);
		}
	}

	// 3. Other distinctive content tokens (len >= 6, non-stopword, non-name)
	const termCounts = new Map<string, number>();
	for (const tok of norm.split(' ')) {
		if (tok.length < 6) continue;
		if (/^\d+$/.test(tok)) continue;
		if (DESCRIPTION_STOPWORDS.has(tok) || nameTokens.has(tok) || anchorSet.has(tok)) continue;
		termCounts.set(tok, (termCounts.get(tok) || 0) + 1);
	}
	const distinctiveTerms = [...termCounts.entries()]
		.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
		.slice(0, 30)
		.map(([t]) => t);

	// 4. Meaningful historical/biographical years (1750-2026)
	const yearSet = new Set<string>();
	for (const ym of raw.matchAll(/\b(1[789]\d{2}|20[0-2]\d)\b/g)) {
		yearSet.add(ym[1]);
		if (yearSet.size >= 12) break;
	}

	return {
		properPhrases: [...properSet],
		domainAnchors: [...anchorSet],
		distinctiveTerms,
		years: [...yearSet],
	};
}

/**
 * Evaluate whether a candidate external/local record represents the SAME entity as `profile`,
 * strictly enforcing the no-name-only-merge policy:
 *
 * - `validated_merge`: exact shared identifier OR (exact/fuzzy/initials name match AND >= 1 independent
 *   corroborating signal: address/geo, employer/firm, military base/unit, or education/institution;
 *   plus non-conflicting life/activity dates).
 * - `name_only_note`: name matched (exact, fuzzy, or initials/partial) with NO corroborating second factor
 *   and no disqualifying date conflict -> DO NOT MERGE; save as a reviewable possible-match note only.
 * - `reject`: no name match OR hard date-span conflict.
 */
export function evaluateIdentityMatch(
	profile: ProfileIdentityContext,
	candidate: CandidateIdentityInput,
): IdentityEvaluation {
	const corroborations: CorroborationHit[] = [];
	const seenCorrob = new Set<string>();
	const addCorrob = (hit: CorroborationHit) => {
		const key = `${hit.kind}:${normalizeText(hit.value)}`;
		if (seenCorrob.has(key)) return;
		seenCorrob.add(key);
		corroborations.push(hit);
	};

	// 1. Exact shared identifier check (CRD, CIK, EIN, Wikidata, ORCID, ROR, instrument).
	// Tickers count only when symbol, listing country, and market all match.
	const candidateIdents = candidate.candidateIdentifiers || [];
	for (const pi of profile.identifiers) {
		for (const ci of candidateIdents) {
			if (pi.scheme !== ci.scheme) continue;
			if (pi.scheme === 'ticker') {
				const left = tickerListingKey(
					resolveTickerListing(pi.value, profile.listingExchange),
				);
				const right = tickerListingKey(
					resolveTickerListing(ci.value, candidate.candidateExchange),
				);
				if (left && left === right) {
					addCorrob({
						kind: 'shared_identifier',
						value: `ticker:${left}`,
						detail: `Same ticker listing ${left} (symbol, country, and market)`,
					});
				}
				continue;
			}
			const cNorm = String(ci.value || '').trim().toLowerCase().replace(/\s+/g, '');
			if (pi.normalizedValue && pi.normalizedValue === cNorm) {
				addCorrob({
					kind: 'shared_identifier',
					value: `${pi.scheme}:${pi.value}`,
					detail: `Exact shared ${pi.scheme} identifier (${pi.value})`,
				});
			}
		}
	}

	// 2. Name matching (exact, fuzzy, or initials/partial)
	const profileNames = [profile.name, ...profile.aliases];
	const candidateNames = [candidate.candidateName, ...(candidate.candidateAliases || [])];
	const nameRes = evaluateNameMatch(profileNames, candidateNames, profile.profileType);

	// 2b. Distinct stage-name / birth-name / alternate-name corroboration:
	// If the profile's primary name AND a completely distinct multi-word alias (zero shared words,
	// e.g. "Grimes" + "Claire Elise Boucher") BOTH match the candidate, that strongly identifies the same entity!
	if (nameRes.kind !== 'none' && profile.aliases.length > 0) {
		const primaryTokens = new Set(normalizeText(profile.name).split(' ').filter((t) => t.length >= 2));
		const candNameListNorm = candidateNames.map((n) => normalizeText(n)).filter(Boolean);
		const candLeadNorm = normalizeText(candidate.candidateText || '').slice(0, 1500);
		for (const al of profile.aliases) {
			const alNorm = normalizeText(al);
			const alTokens = alNorm.split(' ').filter((t) => t.length >= 2);
			if (alTokens.length < 2) continue;
			const overlapsPrimary = alTokens.some((t) => primaryTokens.has(t));
			if (overlapsPrimary) continue;
			if (
				candNameListNorm.some((cn) => cn === alNorm || hasPhrase(cn, alNorm)) ||
				hasPhrase(candLeadNorm, alNorm)
			) {
				addCorrob({
					kind: 'description_keyword_match',
					value: al,
					detail: `Matched distinct known full/alternate name "${al}" alongside "${profile.name}"`,
				});
			}
		}
	}

	const candTextAll = [
		candidate.candidateName,
		...(candidate.candidateAliases || []),
		...(candidate.candidateLocations || []),
		...(candidate.candidateFirms || []),
		...(candidate.candidateMilitarySignals || []),
		...(candidate.candidateInstitutions || []),
		candidate.candidateText || '',
	].join(' \n ');
	const candNorm = normalizeText(candTextAll);

	// 3. Date-span sanity check
	let dateConflict = false;
	let dateConflictReason: string | null = null;
	const pStartY = extractYearsFromDateStr(profile.startDate);
	const pEndY = extractYearsFromDateStr(profile.endDate);
	const cStartY = extractYearsFromDateStr(candidate.candidateStartDate);
	const cEndY = extractYearsFromDateStr(candidate.candidateEndDate);

	if (profile.profileType === 'person') {
		// Conflicting birth years (> 2 yrs apart)
		if (pStartY && cStartY && Math.abs(pStartY - cStartY) > 2) {
			dateConflict = true;
			dateConflictReason = `Birth year mismatch (profile ${pStartY} vs candidate ${cStartY})`;
		}
		// Conflicting death years (> 2 yrs apart)
		if (!dateConflict && pEndY && cEndY && Math.abs(pEndY - cEndY) > 2) {
			dateConflict = true;
			dateConflictReason = `Death year mismatch (profile ${pEndY} vs candidate ${cEndY})`;
		}
		// Candidate died well before profile's recorded active employment/filings
		if (!dateConflict && cEndY && profile.timelineYears.length > 0) {
			const maxActiveYear = Math.max(...profile.timelineYears);
			if (maxActiveYear > cEndY + 5) {
				dateConflict = true;
				dateConflictReason = `Candidate died in ${cEndY}, before profile activity in ${maxActiveYear}`;
			}
		}
		// Candidate born too late for profile's recorded active employment/filings
		if (!dateConflict && cStartY && profile.timelineYears.length > 0) {
			const minActiveYear = Math.min(...profile.timelineYears);
			if (cStartY > minActiveYear - 14) {
				dateConflict = true;
				dateConflictReason = `Candidate born in ${cStartY}, incompatible with profile activity in ${minActiveYear}`;
			}
		}
		// Profile died before candidate's event dates
		if (!dateConflict && pEndY && candidate.candidateEventDates?.length) {
			const candYears = candidate.candidateEventDates
				.map((d) => extractYearsFromDateStr(d))
				.filter((y): y is number => y != null);
			if (candYears.length && Math.min(...candYears) > pEndY + 10) {
				dateConflict = true;
				dateConflictReason = `Profile ended in ${pEndY}, well before candidate event in ${Math.min(...candYears)}`;
			}
		}
	} else if (profile.profileType === 'firm' || profile.profileType === 'education' || profile.profileType === 'nonprofit') {
		if (pStartY && cStartY && Math.abs(pStartY - cStartY) > 15) {
			dateConflict = true;
			dateConflictReason = `Founding year mismatch (profile ${pStartY} vs candidate ${cStartY})`;
		}
	}

	// 4. Address / Geographic corroboration (street, ZIP, city+state, county+state, distinct city)
	const profileLocRawAll = profile.locations.map((l) => l.raw).join(' \n ');
	const profileStreets = extractStreetKeys(profileLocRawAll);
	const candStreets = extractStreetKeys(candTextAll);
	for (const ps of profileStreets) {
		if (candStreets.includes(ps) || hasPhrase(candNorm, ps)) {
			addCorrob({
				kind: 'address_or_geo',
				value: ps,
				detail: `Matched street address "${ps}"`,
			});
		}
	}

	const profileZips = extractZipCodes(profileLocRawAll);
	const candZips = extractZipCodes(candTextAll);
	for (const pz of profileZips) {
		if (candZips.includes(pz)) {
			addCorrob({
				kind: 'address_or_geo',
				value: pz,
				detail: `Matched ZIP code ${pz}`,
			});
		}
	}

	for (const loc of profile.locations) {
		const cityNorm = loc.city ? normalizeText(loc.city) : '';
		const countyNorm = loc.county ? normalizeText(loc.county.replace(/\s+county$/i, '')) : '';
		const stateCode = loc.state ? loc.state.toLowerCase() : '';
		const stateFull = stateCode && US_STATE_NAMES[stateCode] ? US_STATE_NAMES[stateCode] : stateCode;

		if (countyNorm && countyNorm.length >= 3 && !GENERIC_GEO_STOPWORDS.has(countyNorm)) {
			const hasCounty = hasPhrase(candNorm, `${countyNorm} county`) || hasPhrase(candNorm, countyNorm);
			const hasState = !stateFull || hasPhrase(candNorm, stateFull) || hasPhrase(candNorm, stateCode);
			if (hasCounty && hasState) {
				addCorrob({
					kind: 'address_or_geo',
					value: `${loc.county} County${loc.state ? `, ${loc.state}` : ''}`,
					detail: `Matched county/state (${loc.county} County${loc.state ? `, ${loc.state}` : ''})`,
				});
			}
		}

		if (cityNorm && cityNorm.length >= 4 && !GENERIC_GEO_STOPWORDS.has(cityNorm)) {
			if (hasPhrase(candNorm, cityNorm)) {
				const hasState = !stateFull || hasPhrase(candNorm, stateFull) || hasPhrase(candNorm, stateCode);
				// Require state co-occurrence for common US cities when state is known, or accept major distinct cities
				if (hasState || cityNorm.length >= 7) {
					addCorrob({
						kind: 'address_or_geo',
						value: `${loc.city}${loc.state ? `, ${loc.state}` : ''}`,
						detail: `Matched city/location (${loc.city}${loc.state ? `, ${loc.state}` : ''})`,
					});
				}
			}
		}
	}

	// 5. Employer / Firm / Organization corroboration
	const candFirmsNorm = (candidate.candidateFirms || []).map((f) => normalizeText(f)).filter(Boolean);
	for (const org of profile.firmsAndAssociates) {
		if (!isDistinctOrgToken(org)) continue;
		const orgNorm = normalizeText(org);
		const orgStripped = stripLegalSuffixes(org);
		// Skip matching the profile's own name as an employer
		if (orgNorm === normalizeText(profile.name)) continue;

		const hitFull = hasPhrase(candNorm, orgNorm);
		const hitStripped = orgStripped.length >= 5 && !GENERIC_ORG_STOPWORDS.has(orgStripped) && hasPhrase(candNorm, orgStripped);
		const hitFirmList = candFirmsNorm.some(
			(cf) =>
				cf === orgNorm ||
				(orgStripped.length >= 5 && stripLegalSuffixes(cf) === orgStripped),
		);

		if (hitFull || hitStripped || hitFirmList) {
			addCorrob({
				kind: 'employer_or_firm',
				value: org,
				detail: `Matched affiliated firm/associate "${org}"`,
			});
		}
	}

	// 6. Military base / installation / branch corroboration
	const candMil = new Set([
		...extractMilitarySignals(candTextAll),
		...(candidate.candidateMilitarySignals || []).map((m) => normalizeText(m)).filter(Boolean),
	]);
	for (const pm of profile.militarySignals) {
		if (candMil.has(pm) || hasPhrase(candNorm, pm)) {
			addCorrob({
				kind: 'military_base_or_unit',
				value: pm,
				detail: `Matched military base/unit "${pm}"`,
			});
		}
	}

	// 7. Education / Hospital / Government / Non-Profit institution corroboration
	for (const inst of profile.institutions) {
		if (!isDistinctOrgToken(inst)) continue;
		const instNorm = normalizeText(inst);
		const instStripped = stripLegalSuffixes(inst);
		if (instNorm === normalizeText(profile.name)) continue;

		if (
			hasPhrase(candNorm, instNorm) ||
			(instStripped.length >= 6 && !GENERIC_ORG_STOPWORDS.has(instStripped) && hasPhrase(candNorm, instStripped))
		) {
			addCorrob({
				kind: 'education_or_institution',
				value: inst,
				detail: `Matched institution "${inst}"`,
			});
		}
	}

	// 7b. 1-hop graph neighbors (historic_event titles and distinctive peer phrases) vs candidate text.
	// Catches Wikipedia exact-name hits where the curated node lacks flat address/CRD but shares an event/org
	// already linked in the graph (e.g. "Starck Club … fundraiser" ↔ article mentioning Starck Club).
	for (const neighbor of profile.graphNeighbors || []) {
		if (!isDistinctOrgToken(neighbor) && normalizeText(neighbor).split(/\s+/).length < 2) continue;
		const nNorm = normalizeText(neighbor);
		if (nNorm.length < 6) continue;
		if (nNorm === normalizeText(profile.name)) continue;
		if (hasPhrase(candNorm, nNorm)) {
			addCorrob({
				kind: 'graph_neighbor',
				value: neighbor,
				detail: `Matched 1-hop graph neighbor "${neighbor}" in candidate text`,
			});
			continue;
		}
		// Multi-word neighbors: also try a distinctive 2+ token head (drop trailing generic words)
		const tokens = nNorm.split(/\s+/).filter((t) => t.length >= 3 && !GENERIC_ORG_STOPWORDS.has(t));
		if (tokens.length >= 2) {
			const head = tokens.slice(0, Math.min(4, tokens.length)).join(' ');
			if (head.length >= 8 && hasPhrase(candNorm, head)) {
				addCorrob({
					kind: 'graph_neighbor',
					value: neighbor,
					detail: `Matched 1-hop graph neighbor head "${head}" from "${neighbor}"`,
				});
			}
		}
	}

	// 8. Strong description-keyword identity match (works for ALL entity types when description/timeline/notes
	// contain strongly identifying keywords, proper phrases, or domain/role anchors that match the candidate).
	// Strictly requires exact_name or strong fuzzy_name (>= 0.90) and non-conflicting dates, plus a high weighted
	// specificity score so bare/generic name matches STILL stay as name_only_note!
	const descCorpus = (profile.descriptionText || profile.summary || '').trim();
	if (
		!dateConflict &&
		(nameRes.kind === 'exact_name' || (nameRes.kind === 'fuzzy_name' && nameRes.similarity >= 0.9)) &&
		descCorpus.length >= 25
	) {
		const kw = extractIdentifyingKeywords(descCorpus, profile.name);
		const matchedProper = kw.properPhrases.filter((p) => hasPhrase(candNorm, p));
		const matchedAnchors = kw.domainAnchors.filter((a) => hasPhrase(candNorm, a));
		const matchedTerms = kw.distinctiveTerms.filter((t) => hasPhrase(candNorm, t));
		const matchedYears = kw.years.filter((y) => hasPhrase(candNorm, y));

		const strength =
			matchedProper.length * 2.0 +
			matchedAnchors.length * 1.2 +
			matchedTerms.length * 0.75 +
			Math.min(2, matchedYears.length) * 0.6;

		const totalKeywordHits = matchedProper.length + matchedAnchors.length + matchedTerms.length;
		const isStrongPersonMatch =
			profile.profileType === 'person' &&
			strength >= 2.8 &&
			totalKeywordHits >= 2 &&
			(matchedProper.length >= 1 || matchedAnchors.length >= 1 || matchedTerms.length >= 4);
		const isStrongNonPersonMatch =
			profile.profileType !== 'person' &&
			((strength >= 1.8 && totalKeywordHits + matchedYears.length >= 2) ||
				(matchedProper.length >= 1 && (totalKeywordHits >= 2 || matchedYears.length >= 1)));

		if (isStrongPersonMatch || isStrongNonPersonMatch) {
			const topLabels = [
				...matchedProper.slice(0, 3),
				...matchedAnchors.slice(0, 3),
				...matchedTerms.slice(0, 3),
				...matchedYears.slice(0, 2),
			].slice(0, 6);
			addCorrob({
				kind: 'description_keyword_match',
				value: topLabels.join(', '),
				detail: `Strong identifying description keywords matched (strength ${strength.toFixed(1)}): ${topLabels.join(', ')}`,
			});
		}
	}

	// 9. Decision logic (STRICT: never merge on name-only match!)
	const strongIdentCorrobs = corroborations.filter((c) => c.kind === 'shared_identifier');
	const profileEins = profile.identifiers
		.filter((i) => i.scheme === 'irs_ein')
		.map((i) => i.value);
	const candidateEins = candidateIdents
		.filter((i) => i.scheme === 'irs_ein')
		.map((i) => i.value);
	const einConflict = irsEinSetsConflict(profileEins, candidateEins);
	// A copied Wikidata/CIK/ticker must not outrank two different IRS EINs.
	const hasStrongIdent =
		!einConflict && strongIdentCorrobs.length > 0;
	let decision: IdentityDecision = 'reject';
	let score = 0;
	let rationale = '';
	let missingValidationHint: string | null = null;

	if (einConflict) {
		decision = 'reject';
		score = 0.1;
		rationale = `IRS EINs do not match (${profileEins.join(', ') || '—'} vs ${candidateEins.join(', ') || '—'}). A shared identifier is not a stronger indicator.`;
	} else if (dateConflict && !hasStrongIdent) {
		decision = 'reject';
		score = 0.1;
		rationale = `Rejected "${candidate.candidateName}" due to date conflict: ${dateConflictReason}.`;
	} else if (hasStrongIdent) {
		decision = 'validated_merge';
		score = 0.98;
		rationale = `Validated by exact shared identifier (${strongIdentCorrobs
			.map((c) => c.value)
			.join(', ')}).`;
	} else if (nameRes.kind !== 'none' && corroborations.length >= 1) {
		decision = 'validated_merge';
		const base =
			nameRes.kind === 'exact_name'
				? 0.78
				: nameRes.kind === 'fuzzy_name'
					? 0.74
					: 0.7;
		score = Math.min(0.96, Number((base + corroborations.length * 0.08).toFixed(3)));
		rationale = `Validated (${nameRes.kind}: "${nameRes.matchedQueryName}" ↔ "${nameRes.matchedCandidateName}") corroborated by ${corroborations
			.map((c) => `${c.kind}=${c.value}`)
			.join('; ')}.`;
	} else if (nameRes.kind !== 'none' && corroborations.length === 0) {
		// HARD RULE: Name match ONLY -> NEVER merge! Record possible-match note until validated.
		decision = 'name_only_note';
		score = nameRes.kind === 'exact_name' ? 0.48 : nameRes.kind === 'fuzzy_name' ? 0.42 : 0.36;
		missingValidationHint =
			profile.profileType === 'person'
				? 'Needs corroborating address/location, firm/employer, military base/unit, education/institution, or CRD/identifier before merging.'
				: 'Needs corroborating address/HQ, linked person/firm, identifier (CIK/ticker/EIN), or matching domain context before merging.';
		rationale = `Name-only match (${nameRes.kind}: "${nameRes.matchedQueryName}" ↔ "${nameRes.matchedCandidateName}") with NO corroborating address, firm, military base, institution, or identifier. Data NOT merged — held as possible-match note pending validation.`;
	} else {
		decision = 'reject';
		score = 0;
		rationale = `No sufficient name or identifier match between "${profile.name}" and "${candidate.candidateName}".`;
	}

	return {
		decision,
		nameMatch: nameRes.kind,
		nameSimilarity: nameRes.similarity,
		matchedQueryName: nameRes.matchedQueryName,
		matchedCandidateName: nameRes.matchedCandidateName,
		corroborations,
		dateConflict,
		dateConflictReason,
		score,
		rationale,
		missingValidationHint,
	};
}

/**
 * Generate safe FTS5 search phrases for a profile (including exact name,
 * "LAST, FIRST", and initials + surname variants for people so fuzzy/initials
 * matches in county deeds/UCC filings can be discovered and then validated).
 */
export function buildSearchPhrasesForProfile(
	name: string,
	profileType: ProfileType,
	aliases: string[] = [],
): string[] {
	const phrases = new Set<string>();
	const addPhrase = (raw: string) => {
		const tokens = String(raw || '')
			.replace(/["'*^(){}[\]:]/g, ' ')
			.split(/[^a-zA-Z0-9]+/)
			.filter((t) => t.length >= 1);
		if (tokens.length === 0) return;
		if (tokens.length === 1 && tokens[0].length < 7) return;
		phrases.add(tokens.join(' '));
	};

	addPhrase(name);
	for (const a of aliases.slice(0, 4)) {
		if (a.length >= 5) addPhrase(a);
	}

	if (profileType === 'person') {
		const parts = parsePersonNameParts(name);
		if (parts.first && parts.last && parts.last.length >= 4) {
			// "First Last" (without middle name)
			if (parts.middles.length > 0) {
				addPhrase(`${parts.first} ${parts.last}`);
			}
			// "Last First" (matches "LAST, FIRST" in FTS5 since comma is tokenized out)
			addPhrase(`${parts.last} ${parts.first}`);
			// Initial + Last (e.g., "A Karp", "E P Halliburton")
			addPhrase(`${parts.first[0]} ${parts.last}`);
			if (parts.middles.length > 0) {
				addPhrase(`${parts.first[0]} ${parts.middles[0][0]} ${parts.last}`);
			}
			// Nickname + Last (up to 2 common variants)
			const nicks = NICKNAME_MAP.get(parts.first);
			if (nicks) {
				let added = 0;
				for (const n of nicks) {
					if (n === parts.first) continue;
					addPhrase(`${n} ${parts.last}`);
					added++;
					if (added >= 2) break;
				}
			}
		}
	} else {
		const stripped = stripLegalSuffixes(name);
		if (stripped.length >= 6 && stripped !== normalizeText(name)) {
			addPhrase(stripped);
		}
	}

	return [...phrases].slice(0, 8);
}

/** Suffix glued to the matched person name that marks an entity party (not a counterparty bank). */
const PERSON_NAME_ENTITY_SUFFIX_RE =
	/\s+(?:llc|l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|l\.?p\.?|lp|llp|plc|company|co\.?|holdings?|partners?|associates?|trust)\b/i;

/** Oklahoma (and similar) county deed / land-records project names. */
const COUNTY_DEEDS_PROJECT_RE =
	/\b(?:Adair|Bryan|Cherokee|Sequoyah|Washington|Dallas|Oklahoma|Tulsa|Creek|Muskogee|McIntosh|Haskell|Le\s*Flore|Latimer|Pittsburg|Atoka|Coal|Johnston|Marshall|Love|Carter|Murray|Pontotoc|Seminole|Hughes|Okfuskee|Okmulgee|Wagoner|Mayes|Delaware|Ottawa)\b[\s\w-]*County|\bCounty\b[\s\w-]*(?:Deeds|Records|Clerk)/i;

/**
 * True when a knowledge hit is a bare person-name collision against a county deed index.
 * Counterparty banks/trusts on the same instrument do NOT block demotion — only when the
 * matched person name itself carries an LLC/INC/Trust-style suffix.
 */
export function isBareCountyPersonNameOnlyHit(input: {
	profileType: ProfileType;
	profileName?: string;
	projectName: string;
	title?: string;
	snippet?: string;
	matchedPhrase?: string;
}): boolean {
	if (input.profileType !== 'person') return false;
	if (!COUNTY_DEEDS_PROJECT_RE.test(input.projectName || '')) return false;
	const blob = `${input.title || ''} ${input.snippet || ''} ${input.matchedPhrase || ''}`;
	const name = String(input.profileName || input.matchedPhrase || '').trim();
	if (name.length >= 4) {
		const namePattern = name
			.split(/\s+/)
			.filter(Boolean)
			.map(escapeRegExp)
			.join('\\s+');
		const nameEntityRe = new RegExp(
			`\\b${namePattern}${PERSON_NAME_ENTITY_SUFFIX_RE.source}`,
			'i',
		);
		if (nameEntityRe.test(blob)) return false;
	}
	return true;
}

/** Cap for demoted bare county person name-only notes (sorts below building_colocation ~0.32–0.45). */
export const BARE_COUNTY_NAME_ONLY_SCORE_CAP = 0.28;

/**
 * Demote a name-only score when hits are predominantly bare county person collisions.
 * Mixed Research Drive + county keeps the higher score; pure county person blocks demote.
 */
export function demoteBareCountyNameOnlyScore(
	profileType: ProfileType,
	hits: Array<{
		projectName: string;
		title?: string;
		snippet?: string;
		matchedPhrase?: string;
		profileName?: string;
	}>,
	score: number,
	profileName?: string,
): number {
	if (!hits.length || profileType !== 'person') return score;
	const countyHits = hits.filter((h) => COUNTY_DEEDS_PROJECT_RE.test(h.projectName || ''));
	if (!countyHits.length) return score;
	// Only demote when every hit is a county deed (no Research Drive / Wikipedia mixed in)
	if (countyHits.length !== hits.length) return score;
	const allBare = countyHits.every((h) =>
		isBareCountyPersonNameOnlyHit({
			profileType,
			profileName: profileName || h.profileName,
			projectName: h.projectName,
			title: h.title,
			snippet: h.snippet,
			matchedPhrase: h.matchedPhrase,
		}),
	);
	if (!allBare) return score;
	return Math.min(BARE_COUNTY_NAME_ONLY_SCORE_CAP, Number(score) || 0);
}
