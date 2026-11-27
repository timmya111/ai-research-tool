import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { syncOcrNameMatchesToProfileLinks } from '@/lib/research/legalDocsPipeline';
import { syncExistingLandDeedLinks } from '@/lib/research/profiles/associateDeeds';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeText } from '@/lib/research/profiles/normalize';
import { upsertProfileLink } from '@/lib/research/profiles/store';
import type { ProfileRelationType, ProfileType, TimelineAngle } from '@/lib/research/profiles/types';

type IndexedOrg = {
	id: string;
	name: string;
	slug: string;
	profileType: ProfileType;
};

type TrieNode = {
	children: Map<string, TrieNode>;
	matches?: IndexedOrg[];
};

const ORG_TYPES = new Set<ProfileType>([
	'firm',
	'nonprofit',
	'government',
	'education',
	'medical_hospital',
]);

/** Common English, geographic, and corporate-generic words that must never match as a 1-word org name. */
const SINGLE_WORD_STOP = new Set([
	'american', 'national', 'federal', 'united', 'states', 'state', 'general', 'capital', 'central',
	'western', 'eastern', 'northern', 'southern', 'public', 'private', 'company', 'corporation',
	'financial', 'holdings', 'services', 'partners', 'advisors', 'management', 'solutions', 'systems',
	'global', 'group', 'trust', 'vision', 'summit', 'liberty', 'heritage', 'pioneer', 'frontier',
	'premier', 'standard', 'citizens', 'republic', 'integrity', 'progress', 'enterprise', 'foundation',
	'institute', 'academy', 'college', 'university', 'hospital', 'medical', 'center', 'health',
	'energy', 'resources', 'properties', 'industries', 'technologies', 'investments', 'securities',
	'insurance', 'banking', 'credit', 'mortgage', 'realty', 'ventures', 'pacific', 'atlantic',
	'midwest', 'southwest', 'international', 'president', 'director', 'chairman', 'executive',
	'officer', 'secretary', 'treasurer', 'counsel', 'attorney', 'partner', 'founder', 'member',
	'committee', 'council', 'commission', 'department', 'bureau', 'agency', 'office', 'division',
	'service', 'authority', 'district', 'county', 'school', 'church', 'society', 'association',
	'alliance', 'network', 'project', 'program', 'report', 'journal', 'review', 'media', 'world',
	'first', 'second', 'third', 'fourth', 'fifth', 'north', 'south', 'east', 'west', 'great',
	'grand', 'royal', 'crown', 'prime', 'alpha', 'delta', 'omega', 'bridge', 'beacon', 'anchor',
	'shield', 'guard', 'point', 'stone', 'brook', 'creek', 'ridge', 'valley', 'plains', 'prairie',
	'river', 'spring', 'forest', 'field', 'silver', 'white', 'black', 'green', 'brown', 'queen',
	'prince', 'saint', 'cross', 'mount', 'coast', 'island', 'beach', 'harbor', 'landing', 'station',
	'tower', 'plaza', 'square', 'court', 'place', 'street', 'avenue', 'drive', 'trail', 'circle',
	'highway', 'suite', 'floor', 'building', 'complex', 'campus', 'market', 'trade', 'exchange',
	'commerce', 'industry', 'business', 'finance', 'wealth', 'asset', 'equity', 'power', 'water',
	'modern', 'future', 'people', 'person', 'human', 'local', 'regional', 'civic', 'civil', 'legal',
	'texas', 'oklahoma', 'arkansas', 'dallas', 'austin', 'houston', 'tulsa', 'norman', 'durant',
	'chicago', 'boston', 'london', 'washington', 'virginia', 'california', 'florida', 'georgia',
	'illinois', 'indiana', 'kansas', 'missouri', 'colorado', 'arizona', 'alabama', 'alaska', 'hawaii',
	'oregon', 'nevada', 'montana', 'wyoming', 'vermont', 'delaware', 'maryland', 'michigan',
	'minnesota', 'nebraska', 'kentucky', 'louisiana', 'tennessee', 'wisconsin', 'carolina', 'dakota',
	'america', 'europe', 'canada', 'britain', 'england', 'france', 'germany', 'russia', 'china',
	'japan', 'india', 'israel', 'brazil', 'australia', 'mexico', 'january', 'february', 'march',
	'april', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday',
	'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'vanguard', 'fidelity', 'horizon',
	'compass', 'pinnacle', 'meridian', 'sterling', 'keystone', 'landmark', 'capstone', 'catalyst',
	'spectrum', 'momentum', 'synergy', 'quantum', 'matrix', 'nexus', 'vertex', 'zenith', 'phoenix',
	'monarch', 'sovereign', 'legacy', 'destiny', 'victory', 'triumph', 'harmony', 'clarity',
	'prosperity', 'security', 'guardian', 'sentinel', 'patriot', 'freedom', 'justice', 'balance',
	'mission', 'purpose', 'venture', 'capital', 'funding', 'lending', 'leasing', 'trading', 'broker',
	'brokerage', 'digital', 'mobile', 'online', 'direct', 'select', 'choice', 'focus', 'impact',
	'insight', 'bright', 'clear', 'smart', 'prime', 'first', 'metro', 'urban', 'rural', 'global',
	'nation', 'empire', 'kingdom', 'colony', 'union', 'league', 'guild', 'order', 'party', 'front',
	'force', 'corps', 'fleet', 'guard', 'watch', 'patrol', 'signal', 'radio', 'press', 'times',
	'herald', 'tribune', 'gazette', 'chronicle', 'observer', 'dispatch', 'bulletin', 'register',
	'record', 'ledger', 'beacon', 'mirror', 'standard', 'express', 'mercury', 'phoenix', 'eagle',
	'falcon', 'hawk', 'lion', 'tiger', 'bear', 'wolf', 'buffalo', 'mustang', 'mustangs', 'longhorn',
	'sooner', 'sooners', 'cowboys', 'rangers', 'trojans', 'spartans', 'knights', 'pirates', 'giants',
	'titans', 'eagles', 'hawks', 'lions', 'tigers', 'bears', 'wolves', 'panthers', 'wildcats',
	'bulldogs', 'cougars', 'cardinals', 'falcons', 'ravens', 'sharks', 'dolphins', 'marlins',
	'genesis', 'exodus', 'oracle', 'atlas', 'apollo', 'athena', 'hermes', 'zeus', 'titan', 'orion',
	'polaris', 'sirius', 'aurora', 'solaris', 'eclipse', 'nebula', 'cosmos', 'galaxy', 'universe',
	'genesis', 'trinity', 'calvary', 'bethel', 'shiloh', 'zion', 'canaan', 'eden', 'jordan', 'salem',
	'hebron', 'carmel', 'tabor', 'sinai', 'olive', 'cedar', 'cypress', 'willow', 'maple', 'oakland',
	'aspen', 'sequoia', 'redwood', 'pine', 'spruce', 'birch', 'poplar', 'laurel', 'magnolia',
	'dogwood', 'hawthorn', 'sycamore', 'chestnut', 'walnut', 'hickory', 'pecan', 'mesquite',
	'diamond', 'emerald', 'sapphire', 'crystal', 'granite', 'marble', 'limestone', 'sandstone',
	'copper', 'bronze', 'cobalt', 'nickel', 'chrome', 'titanium', 'platinum', 'uranium', 'radium',
	'silicon', 'carbon', 'oxygen', 'hydrogen', 'nitrogen', 'helium', 'argon', 'neon', 'xenon',
	'energy', 'nuclear', 'atomic', 'solar', 'thermal', 'hydro', 'kinetic', 'static', 'dynamic',
	'research', 'science', 'physics', 'biology', 'chemistry', 'history', 'culture', 'policy',
	'defense', 'military', 'marine', 'naval', 'aviation', 'aerospace', 'telecom', 'software',
	'hardware', 'network', 'internet', 'wireless', 'broadband', 'satellite', 'optical', 'photonic',
	'quantum', 'neural', 'robotic', 'robotics', 'bionic', 'genetic', 'genomic', 'biotech', 'pharma',
	'clinical', 'surgical', 'dental', 'optical', 'hearing', 'therapy', 'rehab', 'hospice', 'clinic',
	'family', 'children', 'youth', 'senior', 'elder', 'veteran', 'women', 'alumni', 'student',
	'teacher', 'faculty', 'scholar', 'fellow', 'leader', 'mentor', 'coach', 'trainer', 'player',
	'artist', 'author', 'writer', 'editor', 'creator', 'maker', 'builder', 'designer', 'planner',
	'engineer', 'analyst', 'advisor', 'broker', 'dealer', 'trader', 'banker', 'lender', 'insurer',
	'auditor', 'lawyer', 'judge', 'justice', 'sheriff', 'marshal', 'warden', 'ranger', 'trooper',
	'soldier', 'sailor', 'airman', 'marine', 'pilot', 'captain', 'major', 'colonel', 'general',
	'admiral', 'senator', 'governor', 'mayor', 'minister', 'premier', 'chancellor', 'ambassador',
	'consulate', 'embassy', 'cabinet', 'congress', 'senate', 'assembly', 'parliament', 'tribunal',
	'chancery', 'circuit', 'appeals', 'supreme', 'federal', 'municipal', 'regional', 'provincial',
	'territory', 'commonwealth', 'dominion', 'federation', 'confederation', 'coalition', 'syndicate',
	'consortium', 'cartel', 'monopoly', 'holding', 'subsidiary', 'affiliate', 'branch', 'chapter',
	'lodge', 'order', 'fraternity', 'sorority', 'brotherhood', 'sisterhood', 'fellowship', 'ministry',
	'parish', 'diocese', 'synod', 'presbytery', 'conference', 'convention', 'assembly', 'summit',
	'forum', 'symposium', 'colloquium', 'seminar', 'workshop', 'retreat', 'festival', 'carnival',
	'pageant', 'parade', 'exhibition', 'exposition', 'showcase', 'gallery', 'museum', 'library',
	'archive', 'conservatory', 'observatory', 'planetarium', 'aquarium', 'arboretum', 'sanctuary',
	'reserve', 'refuge', 'preserve', 'parkway', 'turnpike', 'freeway', 'expressway', 'causeway',
	'viaduct', 'tunnel', 'harbor', 'seaport', 'airport', 'heliport', 'spaceport', 'terminal',
	'depot', 'warehouse', 'factory', 'foundry', 'refinery', 'smelter', 'millwork', 'sawmill',
	'brewery', 'winery', 'distillery', 'bakery', 'creamery', 'cannery', 'tannery', 'quarry',
	'colliery', 'oilfield', 'pipeline', 'gridiron', 'stadium', 'coliseum', 'amphitheater', 'theater',
	'theatre', 'cinema', 'playhouse', 'operahouse', 'ballroom', 'auditorium', 'pavilion', 'rotunda',
	'cathedral', 'basilica', 'chapel', 'temple', 'mosque', 'synagogue', 'monastery', 'convent',
	'abbey', 'priory', 'hermitage', 'shrine', 'memorial', 'monument', 'cenotaph', 'obelisk',
	'citadel', 'fortress', 'bastion', 'garrison', 'barracks', 'armory', 'arsenal', 'magazine',
	'bunker', 'shelter', 'asylum', 'infirmary', 'sanatorium', 'lazaretto', 'dispensary', 'pharmacy',
	'apothecary', 'laboratory', 'studio', 'atelier', 'workshop', 'garage', 'hangar', 'shipyard',
	'dockyard', 'drydock', 'marina', 'wharf', 'pier', 'jetty', 'quay', 'berth', 'slip', 'anchorage',
	'beacon', 'lighthouse', 'windmill', 'watermill', 'powerhouse', 'substation', 'switchyard',
	'reservoir', 'aqueduct', 'canal', 'lock', 'weir', 'levee', 'dike', 'seawall', 'breakwater',
]);

/** Multi-word phrases that are too generic / boilerplate to link automatically. */
const MULTI_WORD_STOP = new Set([
	'united states',
	'united states of america',
	'state of oklahoma',
	'state of texas',
	'state of arkansas',
	'state of new york',
	'state of california',
	'district court',
	'supreme court',
	'court of appeals',
	'bankruptcy court',
	'federal government',
	'state government',
	'local government',
	'public company',
	'private company',
	'law firm',
	'credit union',
	'national bank',
	'first national bank',
	'community bank',
	'state bank',
	'savings bank',
	'trust company',
	'real estate',
	'oil and gas',
	'wall street',
	'new york',
	'new york city',
	'oklahoma city',
	'los angeles',
	'san francisco',
	'washington dc',
	'washington d c',
	'north america',
	'south america',
	'united kingdom',
	'european union',
	'world war',
	'civil war',
	'cold war',
	'white house',
	'capitol hill',
	'board of directors',
	'board of trustees',
	'board of regents',
	'board of education',
	'chamber of commerce',
	'better business',
	'american bar',
	'public schools',
	'high school',
	'middle school',
	'elementary school',
	'medical center',
	'health system',
	'regional medical center',
	'memorial hospital',
	'general hospital',
	'community hospital',
	'baptist church',
	'methodist church',
	'catholic church',
	'presbyterian church',
	'lutheran church',
	'episcopal church',
	'christian church',
	'first baptist church',
	'financial services',
	'asset management',
	'wealth management',
	'investment management',
	'capital management',
	'capital partners',
	'capital group',
	'equity partners',
	'private equity',
	'venture capital',
	'investment bank',
	'commercial bank',
	'retail bank',
	'mortgage company',
	'insurance company',
	'holding company',
	'oil company',
	'gas company',
	'power company',
	'electric company',
	'water company',
	'telephone company',
	'railroad company',
	'shipping company',
	'mining company',
	'lumber company',
	'construction company',
	'engineering company',
	'manufacturing company',
	'publishing company',
	'broadcasting company',
	'security company',
	'service company',
	'supply company',
	'trading company',
	'development company',
	'management company',
	'consulting group',
	'advisory group',
	'research institute',
	'policy institute',
	'national laboratory',
	'state university',
	'community college',
	'junior college',
	'technical college',
	'law school',
	'medical school',
	'business school',
	'graduate school',
	'public library',
	'city council',
	'county commission',
	'county commissioners',
	'school district',
	'fire department',
	'police department',
	'sheriff office',
	'attorney general',
	'secretary of state',
	'department of justice',
	'department of state',
	'department of defense',
	'department of education',
	'department of energy',
	'department of treasury',
	'department of commerce',
	'department of labor',
	'department of interior',
	'department of agriculture',
	'department of transportation',
	'department of health',
	'department of homeland security',
	'securities and exchange',
	'internal revenue',
	'federal reserve',
	'social security',
	'postal service',
	'national guard',
	'air force',
	'marine corps',
	'coast guard',
	'army corps',
	'red cross',
	'united way',
	'salvation army',
	'boy scouts',
	'girl scouts',
	'rotary club',
	'lions club',
	'kiwanis club',
	'country club',
	'golf club',
	'athletic club',
	'yacht club',
	'press club',
	'economic forum',
	'world bank',
	'united nations',
	'chairman and ceo',
	'president and ceo',
	'chief executive officer',
	'chief financial officer',
	'chief operating officer',
]);

type TokenSpan = {
	raw: string;
	norm: string;
	start: number;
	end: number;
	hasUpper: boolean;
};

function tokenizeWithOffsets(text: string): TokenSpan[] {
	const out: TokenSpan[] = [];
	const re = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const raw = m[0];
		const norm = raw.toLowerCase().replace(/['’]/g, '');
		if (!norm) continue;
		out.push({
			raw,
			norm,
			start: m.index,
			end: m.index + raw.length,
			hasUpper: /[A-Z]/.test(raw),
		});
	}
	return out;
}

function isPhraseAllowed(phrase: string, isSingleCanonical: boolean): boolean {
	if (!phrase || phrase.length < 5) return false;
	if (MULTI_WORD_STOP.has(phrase)) return false;
	const words = phrase.split(' ').filter(Boolean);
	if (words.length === 0 || words.length > 10) return false;
	if (words.length === 1) {
		if (!isSingleCanonical) return false;
		const w = words[0]!;
		if (w.length < 6) return false;
		if (SINGLE_WORD_STOP.has(w)) return false;
		if (/^\d+$/.test(w)) return false;
		return true;
	}
	// Reject 2-word phrases where either token is a single character (e.g., "The U" matching "The U.S. Border Patrol")
	if (words.length === 2 && (words[0]!.length < 2 || words[1]!.length < 2)) {
		return false;
	}
	// Reject 2-word phrases where both words are generic single-word stopwords
	if (words.length === 2 && SINGLE_WORD_STOP.has(words[0]!) && SINGLE_WORD_STOP.has(words[1]!)) {
		return false;
	}
	return true;
}

/**
 * Strip ONLY strict legal entity endings (Inc, LLC, Corp, Ltd, LP, LLP, PLLC, PC, PLC, NA) —
 * never stripping words like "Financial", "Group", "Holdings", "Partners", "International", or "Associates".
 */
function stripStrictLegalEnding(raw: string): string {
	let s = normalizeText(raw);
	let prev = '';
	while (s && s !== prev) {
		prev = s;
		s = s
			.replace(
				/\s+(?:incorporated|inc|l\s*l\s*c|llc|corporation|corp|limited|ltd|l\s*l\s*p|llp|l\s*p|lp|p\s*l\s*l\s*c|pllc|p\s*c|pc|plc|p\s*a|n\s*a|na|national association|f\s*s\s*b|fsb|s\s*a|gmbh|ag|nv|bv)$/,
				'',
			)
			.trim();
	}
	return s;
}

function buildOrgTrie(db: DatabaseSync): { root: TrieNode; phraseCount: number } {
	const byPhrase = new Map<string, Map<string, IndexedOrg>>();
	const addPhrase = (phrase: string, org: IndexedOrg, allowSingleWord: boolean) => {
		if (!isPhraseAllowed(phrase, allowSingleWord)) return;
		let m = byPhrase.get(phrase);
		if (!m) {
			m = new Map();
			byPhrase.set(phrase, m);
		}
		m.set(org.id, org);
	};

	const orgRows = db
		.prepare(
			`SELECT id, name, slug, profile_type, normalized_name
       FROM profiles
       WHERE profile_type IN ('firm', 'nonprofit', 'government', 'education', 'medical_hospital')`,
		)
		.all() as Array<{
		id: string;
		name: string;
		slug: string;
		profile_type: ProfileType;
		normalized_name: string;
	}>;

	const orgById = new Map<string, IndexedOrg>();
	for (const r of orgRows) {
		const org: IndexedOrg = {
			id: r.id,
			name: r.name,
			slug: r.slug,
			profileType: r.profile_type,
		};
		orgById.set(r.id, org);
		const norm = normalizeText(r.name);
		const words = norm.split(' ').filter(Boolean);
		// Only allow 1-word matches if the canonical profile name itself is a single distinctive word
		// (e.g. PayPal, ExxonMobil, Walmart, SpaceX, SoloSuit, FindLaw — never stripped multi-word names!)
		addPhrase(norm, org, words.length === 1 && norm.length >= 6);

		// Strict legal-ending stripped variant — ALWAYS requires >= 2 words so "Columbia Financial Group, Inc."
		// or "Midtown Partners" or "Huntington Holdings, Inc." can NEVER collapse to a 1-word geographic/common word!
		const stripped = stripStrictLegalEnding(r.name);
		if (stripped && stripped !== norm) {
			const sWords = stripped.split(' ').filter(Boolean);
			if (sWords.length >= 2) {
				addPhrase(stripped, org, false);
			}
		}
	}

	// Add strict non-acronym aliases (other_name / former_name / legal_name / name) — >= 2 words only
	const aliasRows = db
		.prepare(
			`SELECT profile_id, alias, alias_kind
       FROM profile_aliases
       WHERE lower(coalesce(alias_kind, 'name')) IN ('name', 'other_name', 'former_name', 'formerly', 'legal_name')`,
		)
		.all() as Array<{ profile_id: string; alias: string; alias_kind: string | null }>;

	for (const a of aliasRows) {
		const org = orgById.get(a.profile_id);
		if (!org) continue;
		const norm = normalizeText(a.alias);
		const words = norm.split(' ').filter(Boolean);
		if (words.length >= 2) {
			addPhrase(norm, org, false);
		}
	}

	const root: TrieNode = { children: new Map() };
	let phraseCount = 0;
	for (const [phrase, orgMap] of byPhrase) {
		// Strictly unambiguous: only index phrases that map to exactly ONE profile
		if (orgMap.size !== 1) continue;
		const org = [...orgMap.values()][0]!;
		const words = phrase.split(' ').filter(Boolean);
		let node = root;
		for (const w of words) {
			let next = node.children.get(w);
			if (!next) {
				next = { children: new Map() };
				node.children.set(w, next);
			}
			node = next;
		}
		node.matches = [org];
		phraseCount += 1;
	}

	return { root, phraseCount };
}

function stripMarkdownFormatting(s: string): string {
	return s
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/^#{1,6}\s+/, '')
		.replace(/^[-*•]\s+/, '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractContextSentence(text: string, start: number, end: number): {
	description: string;
	sectionHeading: string;
	isBold: boolean;
	isBullet: boolean;
} {
	const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
	const lineEndRaw = text.indexOf('\n', end);
	const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
	const rawLine = text.slice(lineStart, lineEnd).trim();
	const isBullet = /^[-*•]\s+/.test(rawLine);
	const around = text.slice(Math.max(0, start - 3), Math.min(text.length, end + 3));
	const isBold = around.includes('**');

	// Find nearest preceding markdown heading
	let sectionHeading = '';
	const beforeText = text.slice(0, lineStart);
	const headingMatches = [...beforeText.matchAll(/^#{1,4}\s+(.+)$/gm)];
	if (headingMatches.length > 0) {
		sectionHeading = stripMarkdownFormatting(headingMatches[headingMatches.length - 1]![1] || '').slice(0, 80);
	}

	let description = stripMarkdownFormatting(rawLine);
	if (!isBullet && description.length > 320) {
		// Narrow to the exact sentence containing the match (avoid splitting on initials like "John D." or "U.S.")
		const relPos = Math.max(0, start - lineStart);
		const before = rawLine.slice(0, relPos);
		const after = rawLine.slice(relPos);
		let sentStart = 0;
		for (const m of before.matchAll(/(?<![A-Z])[.!?]\s+/g)) {
			if (m.index != null) sentStart = m.index + m[0].length;
		}
		const sentEndM = after.match(/(?<![A-Z])[.!?](?:\s|$)/);
		const sentEnd = sentEndM && sentEndM.index != null ? relPos + sentEndM.index + 1 : rawLine.length;
		description = stripMarkdownFormatting(rawLine.slice(sentStart, sentEnd));
	}
	if (description.length > 360) {
		description = `${description.slice(0, 355).replace(/\s+\S*$/, '')}…`;
	}
	return { description, sectionHeading, isBold, isBullet };
}

function inferRelationFromOverviewContext(
	subjectType: ProfileType,
	targetType: ProfileType,
	desc: string,
	sectionHeading: string,
): { relationType: ProfileRelationType; roleLabel: string } {
	const low = `${sectionHeading} ${desc}`.toLowerCase();

	if (
		targetType === 'education' &&
		/\b(?:graduated|degree|j\.?d\.?|b\.?a\.?|b\.?s\.?|m\.?b\.?a\.?|ph\.?d\.?|attended|alumn|faculty|professor|fellow|student|dean|chancellor|regent)\b/.test(low)
	) {
		return { relationType: 'alumni_or_faculty', roleLabel: 'Education / academic tie (profile overview)' };
	}

	if (
		subjectType === 'person' &&
		/\b(?:ceo|chief executive|president|chairman|director|partner|founder|co-founder|executive|vice president|managing director|officer|joined|worked at|employed|attorney at|counsel at|board member|trustee)\b/.test(low)
	) {
		return { relationType: 'employed_by', roleLabel: 'Leadership / employment mention (profile overview)' };
	}

	if (/\b(?:subsidiary of|owned by|wholly owned|acquired by|parent company|division of|spin-?off)\b/.test(low)) {
		return { relationType: 'owned_by', roleLabel: 'Ownership / corporate structure (profile overview)' };
	}

	if (/\b(?:funded by|grant from|backed by|invested|investor|donor|endowment|financed by)\b/.test(low)) {
		return { relationType: 'funded_by', roleLabel: 'Funding / investment mention (profile overview)' };
	}

	if (
		targetType === 'government' &&
		/\b(?:regulated by|regulator|oversight|enforcement|fined|sanction|investigation|license|licensed by|chartered by|registered with)\b/.test(low)
	) {
		return { relationType: 'regulator_of', roleLabel: 'Regulatory / government mention (profile overview)' };
	}

	if (
		/\b(?:client|represented|counsel|co-defendant|creditor|debt buyer|garnish|lender|borrower|supplier|customer|vendor|contract|joint venture|merger|acquisition|litigation|lawsuit|appellant|appellee|plaintiff|defendant)\b/.test(low) ||
		/\bv\.\s+/.test(desc)
	) {
		return {
			relationType: 'business_tie',
			roleLabel: sectionHeading ? `Business / legal tie (${sectionHeading.slice(0, 48)})` : 'Business / legal tie (profile overview)',
		};
	}

	if (
		targetType === 'nonprofit' ||
		/\b(?:member of|membership|trade association|alliance|coalition|affiliated|partnered|partnership|board of|fellowship)\b/.test(low)
	) {
		return {
			relationType: 'affiliated_with',
			roleLabel: sectionHeading ? `Affiliation (${sectionHeading.slice(0, 52)})` : 'Affiliation (profile overview)',
		};
	}

	return {
		relationType: 'mentioned_in',
		roleLabel: sectionHeading ? `Listed in ${sectionHeading.slice(0, 56)}` : 'Listed in profile overview',
	};
}

function extractYearFromLine(line: string): string | null {
	const iso = line.match(/\b((?:18|19|20)\d{2}-\d{2}-\d{2})\b/);
	if (iso) return iso[1]!;
	const yr = line.match(/\b((?:18|19|20)\d{2})\b/);
	return yr ? yr[1]! : null;
}

function isBoilerplateOnlySummary(summary: string): boolean {
	const t = summary.trim();
	if (t.length < 90) return true;
	if (/^FINRA\/SEC registered firm \(CRD#\s*\d+\)/i.test(t) && t.length < 240 && !t.includes('\n')) {
		return true;
	}
	if (/^FINRA BrokerCheck (?:individual|record)/i.test(t) && t.length < 240 && !t.includes('\n')) {
		return true;
	}
	return false;
}

function scanTextForOrgs(
	text: string,
	root: TrieNode,
	selfId: string,
	selfNorm: string,
): Array<{ org: IndexedOrg; start: number; end: number; spanLen: number }> {
	const tokens = tokenizeWithOffsets(text);
	const foundByOrg = new Map<string, { org: IndexedOrg; start: number; end: number; spanLen: number }>();

	for (let i = 0; i < tokens.length; i++) {
		const t0 = tokens[i]!;
		// Require the matched organization name in prose to start with an uppercase letter
		if (!t0.hasUpper) continue;

		let node: TrieNode | undefined = root.children.get(t0.norm);
		if (!node) continue;

		let bestMatch: { org: IndexedOrg; endIdx: number; len: number } | null = null;
		let j = i;
		while (node) {
			if (node.matches && node.matches.length === 1) {
				const org = node.matches[0]!;
				if (org.id !== selfId) {
					// Verify capitalization on at least half of significant tokens in multi-word matches
					let upperCount = 0;
					let sigCount = 0;
					for (let k = i; k <= j; k++) {
						const tk = tokens[k]!;
						if (tk.norm.length >= 4 || k === i || k === j) {
							sigCount += 1;
							if (tk.hasUpper) upperCount += 1;
						}
					}
					if (sigCount > 0 && upperCount / sigCount >= 0.6) {
						bestMatch = { org, endIdx: j, len: j - i + 1 };
					}
				}
			}
			j += 1;
			if (j >= tokens.length) break;
			// Do not cross paragraph / bullet boundaries
			const gap = text.slice(tokens[j - 1]!.end, tokens[j]!.start);
			if (/[\n;()[\]]/.test(gap) || gap.length > 6) break;
			node = node.children.get(tokens[j]!.norm);
		}

		if (bestMatch) {
			const { org, endIdx, len } = bestMatch;
			// Avoid self-substring matches (e.g., "Bank of America, N.A." matching "Bank of America")
			const orgNorm = normalizeText(org.name);
			if (
				orgNorm &&
				selfNorm &&
				(selfNorm === orgNorm ||
					(orgNorm.length >= 6 && selfNorm.includes(orgNorm)) ||
					(selfNorm.length >= 6 && orgNorm.includes(selfNorm)))
			) {
				i = endIdx;
				continue;
			}
			const prev = foundByOrg.get(org.id);
			if (!prev || len > prev.spanLen) {
				foundByOrg.set(org.id, {
					org,
					start: t0.start,
					end: tokens[endIdx]!.end,
					spanLen: len,
				});
			}
			i = endIdx;
		}
	}

	return [...foundByOrg.values()];
}

export type SyncAllProfilesReport = {
	orgPhrasesIndexed: number;
	profilesScanned: number;
	overviewMatchesFound: number;
	overviewLinksWritten: number;
	overviewSkippedExisting: number;
	ocrExtraMatchesWritten: number;
	ocrPipelineReport: ReturnType<typeof syncOcrNameMatchesToProfileLinks>;
	landDeedReport: ReturnType<typeof syncExistingLandDeedLinks>;
	sampleLinks: Array<{
		from: string;
		to: string;
		relationType: string;
		roleLabel: string;
		evidenceNote: string;
	}>;
};

/**
 * Scan ALL profiles in profiles.sqlite and materialize Connected Profiles (`profile_links`) with
 * descriptions for:
 *  1. Companies / organizations listed in each profile's Overview / History Timeline prose
 *  2. Name matches inside cached Court Filings & OCR Documents
 *  3. Name matches inside Land Deeds (timeline_entries + ## Land Deeds overview sections)
 */
export function syncAllProfileConnections(opts?: {
	dryRun?: boolean;
	maxLinksPerProfile?: number;
}): SyncAllProfilesReport {
	const db = getProfilesDb();
	db.exec('PRAGMA busy_timeout = 15000;');
	const dryRun = Boolean(opts?.dryRun);
	const maxPerProfile = Math.max(5, Math.min(50, opts?.maxLinksPerProfile ?? 25));

	// 1. Build unambiguous organization phrase Trie
	const { root, phraseCount } = buildOrgTrie(db);

	// 2. Load existing undirected link pairs so we never duplicate an already-connected pair
	const existingPairs = new Set<string>();
	for (const row of db
		.prepare(`SELECT from_profile_id, to_profile_id FROM profile_links`)
		.all() as Array<{ from_profile_id: string; to_profile_id: string }>) {
		const a = row.from_profile_id;
		const b = row.to_profile_id;
		existingPairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
	}

	const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

	// 3. Scan all profiles with non-trivial summaries
	const allProfiles = db
		.prepare(
			`SELECT id, slug, name, profile_type, summary
       FROM profiles
       WHERE length(coalesce(summary, '')) >= 90`,
		)
		.all() as Array<{
		id: string;
		slug: string;
		name: string;
		profile_type: ProfileType;
		summary: string;
	}>;

	let profilesScanned = 0;
	let overviewMatchesFound = 0;
	let overviewLinksWritten = 0;
	let overviewSkippedExisting = 0;
	const sampleLinks: SyncAllProfilesReport['sampleLinks'] = [];

	const pendingWrites: Array<{
		fromProfileId: string;
		toProfileId: string;
		relationType: ProfileRelationType;
		roleLabel: string;
		startDate: string | null;
		angle: TimelineAngle;
		evidenceNote: string;
		dedupeHint: string;
	}> = [];

	for (const prof of allProfiles) {
		// Strip ## Land Deeds block (handled separately) and "Seeded from ..." corpus provenance footers
		// so boilerplate seed notes never create cross-links between unrelated entities in the same corridor.
		const ldIdx = prof.summary.indexOf('## Land Deeds');
		const prose = (ldIdx !== -1 ? prof.summary.slice(0, ldIdx) : prof.summary)
			.replace(/^Seeded from\b[^\n]*$/gim, '')
			.trim();
		if (isBoilerplateOnlySummary(prose)) continue;

		profilesScanned += 1;
		const selfNorm = normalizeText(prof.name);
		const hits = scanTextForOrgs(prose, root, prof.id, selfNorm);
		if (hits.length === 0) continue;

		// Score hits so bolded / bulleted / business-tie mentions rank first if capping at maxPerProfile
		const enriched = hits
			.map((h) => {
				const ctx = extractContextSentence(prose, h.start, h.end);
				const rel = inferRelationFromOverviewContext(
					prof.profile_type,
					h.org.profileType,
					ctx.description,
					ctx.sectionHeading,
				);
				const priority =
					(ctx.isBold ? 3 : 0) +
					(ctx.isBullet ? 2 : 0) +
					(rel.relationType !== 'mentioned_in' ? 3 : 0) +
					Math.min(3, h.spanLen);
				return { h, ctx, rel, priority };
			})
			.filter((x) => x.ctx.description.length >= 20)
			.sort((a, b) => b.priority - a.priority)
			.slice(0, maxPerProfile);

		for (const item of enriched) {
			overviewMatchesFound += 1;
			const pk = pairKey(prof.id, item.h.org.id);
			if (existingPairs.has(pk)) {
				overviewSkippedExisting += 1;
				continue;
			}
			existingPairs.add(pk);

			const startDate = extractYearFromLine(item.ctx.description);
			const angle: TimelineAngle =
				item.h.org.profileType === 'education'
					? 'academic_research'
					: item.h.org.profileType === 'government'
						? 'policy'
						: /\b(?:court|litigation|lawsuit|docket|fdcpa|garnish|arrest|indict|seize|v\.)\b/i.test(item.ctx.description)
							? 'law_enforcement'
							: 'corporate';

			pendingWrites.push({
				fromProfileId: prof.id,
				toProfileId: item.h.org.id,
				relationType: item.rel.relationType,
				roleLabel: item.rel.roleLabel,
				startDate,
				angle,
				evidenceNote: item.ctx.description,
				dedupeHint: `overview-mention:${prof.id}:${item.h.org.id}`,
			});

			if (sampleLinks.length < 30) {
				sampleLinks.push({
					from: `${prof.name} [${prof.profile_type}]`,
					to: `${item.h.org.name} [${item.h.org.profileType}]`,
					relationType: item.rel.relationType,
					roleLabel: item.rel.roleLabel,
					evidenceNote: item.ctx.description,
				});
			}
		}
	}

	// 4. Also scan ALL cached non-CFPB court/docket OCR files with our full org Trie
	// so any existing profile in profiles.sqlite named in a court filing gets linked with its OCR sentence!
	let ocrExtraMatchesWritten = 0;
	const ocrDir = path.resolve(process.cwd(), '.data', 'legal-docs', 'ocr');
	if (fs.existsSync(ocrDir)) {
		for (const fname of fs.readdirSync(ocrDir)) {
			if (!fname.endsWith('.json')) continue;
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(ocrDir, fname), 'utf8')) as {
					source?: string;
					profileId?: string;
					profileSlug?: string;
					title?: string;
					caseOrRecordId?: string;
					courtOrSource?: string;
					dateIssued?: string | null;
					fullText?: string;
					textExcerpt?: string;
				};
				if (!raw || raw.source === 'cfpb') continue;
				const ownerRow = db
					.prepare(`SELECT id, name FROM profiles WHERE id = ? OR slug = ? LIMIT 1`)
					.get(raw.profileId || '', raw.profileSlug || '') as { id: string; name: string } | undefined;
				if (!ownerRow) continue;

				const cleanText = String(raw.fullText || raw.textExcerpt || '')
					.replace(/[\r\n\t]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim();
				if (cleanText.length < 40) continue;

				const hits = scanTextForOrgs(cleanText, root, ownerRow.id, normalizeText(ownerRow.name));
				const cleanTitle = String(raw.title || raw.caseOrRecordId || '')
					.replace(/[\r\n\t]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim();

				for (const h of hits) {
					// Skip pure precedent citations ("see also X v. Y, 515 F.3d")
					const nearBefore = cleanText.slice(Math.max(0, h.start - 60), h.start);
					const nearAfter = cleanText.slice(h.end, Math.min(cleanText.length, h.end + 100));
					if (
						/\b(?:see\s+also|see,?\s+e\.g\.|accord|cf\.|citing)\b/i.test(nearBefore) ||
						/\b\d+\s+(?:F\.3d|F\.2d|F\.\s*Supp|B\.R\.|U\.S\.|WL\s+\d+)\b/i.test(nearAfter)
					) {
						continue;
					}
					const pk = pairKey(ownerRow.id, h.org.id);
					if (existingPairs.has(pk)) continue;
					existingPairs.add(pk);

					const excerpt = cleanText
						.slice(Math.max(0, h.start - 80), Math.min(cleanText.length, h.end + 160))
						.trim();
					pendingWrites.push({
						fromProfileId: ownerRow.id,
						toProfileId: h.org.id,
						relationType: 'business_tie',
						roleLabel: `Named in court filing (${raw.caseOrRecordId || raw.source})`,
						startDate: raw.dateIssued || null,
						angle: 'law_enforcement',
						evidenceNote: `${cleanTitle} (${raw.caseOrRecordId || ''}, ${raw.courtOrSource || ''}) — "…${excerpt}…"`.slice(0, 360),
						dedupeHint: `ocr-trie:${ownerRow.id}:${h.org.id}`,
					});
					ocrExtraMatchesWritten += 1;
				}
			} catch {
				/* skip malformed OCR file */
			}
		}
	}

	if (!dryRun && pendingWrites.length > 0) {
		db.exec('BEGIN IMMEDIATE;');
		try {
			for (const w of pendingWrites) {
				const isOcr = w.dedupeHint.startsWith('ocr-trie:');
				upsertProfileLink(
					{
						fromProfileId: w.fromProfileId,
						toProfileId: w.toProfileId,
						relationType: w.relationType,
						roleLabel: w.roleLabel,
						startDate: w.startDate,
						status: 'observed',
						confidence: isOcr ? 0.91 : 0.86,
						angle: w.angle,
						sourceCorpus: isOcr ? 'legal-api-ocr' : 'overview-mention-associate',
						evidenceNote: w.evidenceNote,
						dedupeHint: w.dedupeHint,
					},
					db,
				);
				if (!isOcr) overviewLinksWritten += 1;
			}
			db.exec('COMMIT;');
		} catch (e) {
			try {
				db.exec('ROLLBACK;');
			} catch {
				/* ignore */
			}
			throw e;
		}
	} else {
		overviewLinksWritten = pendingWrites.filter((w) => !w.dedupeHint.startsWith('ocr-trie:')).length;
	}

	// 5. Run OCR counterparty linker + Land Deed linker (both respect dryRun / idempotency)
	const ocrPipelineReport = dryRun
		? { docsScanned: 0, linksUpserted: 0, profilesCreated: 0 }
		: syncOcrNameMatchesToProfileLinks();
	const landDeedReport = syncExistingLandDeedLinks({ dryRun });

	return {
		orgPhrasesIndexed: phraseCount,
		profilesScanned,
		overviewMatchesFound,
		overviewLinksWritten,
		overviewSkippedExisting,
		ocrExtraMatchesWritten,
		ocrPipelineReport,
		landDeedReport,
		sampleLinks,
	};
}
