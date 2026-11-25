/**
 * Preferred historic-news focus: global affairs, big-money deals, geology/money,
 * military, gov geophysical/quantum data, international forums (WEF + summits),
 * NATO, and material law/regulation changes — not personal-injury anecdotes,
 * pet stories, or routine quarterly earnings releases.
 */

export const DEFAULT_FOCUS_TOPICS = [
	// Forums / summits / multilateral
	'World Economic Forum',
	'WEF',
	'Davos',
	'AMNC',
	'Annual Meeting',
	'summit',
	'G7',
	'G20',
	'COP30',
	'COP31',
	'UN General Assembly',
	'Security Council',
	'multilateral',
	'Bretton Woods',
	'ASEAN',
	'NATO',
	'North Atlantic Council',
	// Money / deals
	'billion',
	'million contract',
	'contract award',
	'acquisition',
	'merger',
	'joint venture',
	'IPO',
	'enterprise value',
	'funding',
	'investment',
	'critical minerals',
	// Geology / earth / space weather / quantum
	'seismic',
	'earthquake',
	'geology',
	'geotech',
	'geomagnetic',
	'magnetic field',
	'magnetosphere',
	'space weather',
	'solar storm',
	'quantum',
	'USGS',
	'aquifer',
	'subsurface',
	// Military / defense construction & programs
	'MILCON',
	'Sentinel',
	'ICBM',
	'shipyard',
	'defense',
	'defence',
	'USACE',
	'Army Corps',
	'Vandenberg',
	'Global Strike',
	// Law / regulation changes
	'legislation',
	'statute',
	'permitting reform',
	'regulation',
	'Congress passes',
	'Senate passes',
	'House passes',
	'executive order',
	'sanctions',
	'treaty',
];

const PERSONAL_INJURY_TITLE_RE =
	/\b(?:electrical injury|cumulative injur(?:y|ies)|worker(?:s)? (?:injured|hurt|killed|shocked)|shock injury|personal injury|deserve(?:d)? a .{0,20}(?:safety )?fine|lock\s*out\s*tag\s*out|OSHA .{0,40}injury|injury deserve|safety fine for .{0,40}injury|hurt on the job|workplace injury|prevent .{0,40}injur(?:y|ies) among .{0,40}workers?)\b/i;

const PERSONAL_INJURY_BODY_RE =
	/\b(?:administrative law judge|lock\s*out\/?\s*tag\s*out|worker was (?:shocked|injured|electrocuted)|personal injury|injury case)\b/i;

/** Pet / animal-breeder human-interest (skip for historic timelines). */
const PET_STORY_TITLE_RE =
	/\b(?:puppies?|kitten(?:s)?|dog breeder|puppy mill|cat breeder|pet shop|sick (?:puppies?|dogs?|kittens?|cats?)|selling (?:sick )?(?:puppies?|dogs?|kittens?)|rescue (?:dog|cat|puppy|kitten)|animal rescue|pet adoption|stray (?:dogs?|cats?)|exotic pet)\b/i;

const PET_STORY_BODY_RE =
	/\b(?:dog breeder|puppy mill|breeding (?:dogs?|puppies?|cats?)|selling .{0,40}(?:puppies?|kittens?) for .{0,20}(?:£|\$|€)|secret filming .{0,40}(?:breeder|puppies?|dogs?))\b/i;

/** Routine quarterly earnings / revenue-release stories (skip for historic timelines). */
const QUARTERLY_EARNINGS_TITLE_RE =
	/\b(?:quarterly (?:earnings|results|revenue|profit)|(?:Q[1-4]|first|second|third|fourth)[- ]quarter (?:earnings|results|revenue|profit|guidance)|(?:earnings|results) (?:call|report|release)|(?:beats|misses|meets) (?:earnings|estimates|EPS)|revenue growth in Q[1-4]|delivers .{0,40}revenue growth in Q[1-4]|Q[1-4] \d{4} (?:earnings|results|revenue|profit)|reports? (?:Q[1-4]|quarterly) (?:revenue|earnings|results|profit)|(?:net (?:income|profit)|EBITDA|EPS) .{0,30}(?:Q[1-4]|quarter))\b/i;

const QUARTERLY_EARNINGS_BODY_RE =
	/\b(?:reported (?:Q[1-4]|quarterly) (?:revenue|earnings|results)|(?:Q[1-4]|quarterly) (?:earnings|results) (?:call|release)|year[- ]over[- ]year revenue growth of|adjusted EBITDA for the (?:quarter|period))\b/i;

/**
 * @param {string[]} topics
 * @param {{ title?: string, summary?: string, description?: string, rssBody?: string }} item
 */
export function itemMatchesFocusTopics(item, topics = DEFAULT_FOCUS_TOPICS) {
	const list = (topics || []).map(String).filter(Boolean);
	if (!list.length) return true;
	const hay = `${item.title || ''} ${item.description || ''} ${item.summary || ''} ${item.rssBody || ''}`.toLowerCase();
	return list.some((k) => {
		const needle = String(k || '')
			.trim()
			.toLowerCase();
		if (!needle) return false;
		if (/\s/.test(needle) || needle.length >= 12) return hay.includes(needle);
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(hay);
	});
}

/**
 * Worker-anecdote / personal-injury safety stories (skip for historic timelines).
 * @param {{ title?: string, summary?: string, description?: string }} input
 */
export function classifyPersonalInjuryStory(input = {}) {
	const title = String(input.title || '');
	const body = String(input.summary || input.description || '');
	const reasons = [];
	if (PERSONAL_INJURY_TITLE_RE.test(title)) reasons.push('personal_injury_title');
	if (PERSONAL_INJURY_BODY_RE.test(title) || PERSONAL_INJURY_BODY_RE.test(body.slice(0, 1_500))) {
		if (!reasons.includes('personal_injury_body')) reasons.push('personal_injury_body');
	}
	// Title asks whether an injury "deserved" a fine / penalty → anecdote framing.
	if (/\bdeserve|\binjury\b.*\b(?:fine|penalty|osha)\b|\b(?:fine|penalty|osha)\b.*\binjury\b/i.test(title)) {
		if (!reasons.length) reasons.push('injury_fine_framing');
	}
	return { soft: reasons.length > 0, reasons, score: reasons.length ? 4 : 0 };
}

/**
 * Pet / animal-breeder human-interest stories (skip for historic timelines).
 * @param {{ title?: string, summary?: string, description?: string }} input
 */
export function classifyPetStory(input = {}) {
	const title = String(input.title || '');
	const body = String(input.summary || input.description || '');
	const reasons = [];
	if (PET_STORY_TITLE_RE.test(title)) reasons.push('pet_story_title');
	if (PET_STORY_BODY_RE.test(title) || PET_STORY_BODY_RE.test(body.slice(0, 1_500))) {
		if (!reasons.includes('pet_story_body')) reasons.push('pet_story_body');
	}
	return { soft: reasons.length > 0, reasons, score: reasons.length ? 4 : 0 };
}

/**
 * Routine quarterly earnings / revenue-release stories (skip for historic timelines).
 * Keeps industry-trend Q mentions (e.g. "cancellations in Q3 doubled") unless they are
 * company earnings/revenue releases.
 * @param {{ title?: string, summary?: string, description?: string }} input
 */
export function classifyQuarterlyEarnings(input = {}) {
	const title = String(input.title || '');
	const body = String(input.summary || input.description || '');
	const reasons = [];
	if (QUARTERLY_EARNINGS_TITLE_RE.test(title)) reasons.push('quarterly_earnings_title');
	if (QUARTERLY_EARNINGS_BODY_RE.test(title) || QUARTERLY_EARNINGS_BODY_RE.test(body.slice(0, 1_500))) {
		if (!reasons.includes('quarterly_earnings_body')) reasons.push('quarterly_earnings_body');
	}
	return { soft: reasons.length > 0, reasons, score: reasons.length ? 4 : 0 };
}
