#!/usr/bin/env node
/**
 * Associate article profiles (news_rss / historic_event) with existing actor profiles
 * (people, firms, government agencies, nonprofits, universities, hospitals) in
 * profiles.sqlite — tagging each link with whether the relationship is a current or
 * previous connection based on existing profile_links and article context.
 *
 * Strict precision guards:
 *  - Only links to EXISTING active/pinned profiles (never creates duplicates).
 *  - Never mutates profile_locations.
 *  - Strips ## Local Wikipedia cross-check / ## Source articles before scanning so only
 *    actual article prose is matched.
 *  - Requires Proper-Noun capitalization in article text for org/person phrase matches
 *    (eliminates lowercase common-word collisions like "trading partners", "the fund").
 *  - Disambiguates shared acronyms (e.g. GSA) by domain context overlap against article.
 *  - Checks 1-hop current/previous connections of matched orgs to catch linked people.
 *
 * Usage:
 *   node scripts/associate-articles-to-profiles.mjs --dry-run
 *   node scripts/associate-articles-to-profiles.mjs
 *   node scripts/associate-articles-to-profiles.mjs --all-events
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { upsertProfileLink } = await import('@/lib/research/profiles/store');
const { normalizeText } = await import('@/lib/research/profiles/normalize');

const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const CORPUS = 'article-connection-associate';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ALL_EVENTS = argv.includes('--all-events');
const DUMP_ALL = argv.includes('--dump-all');
const MAX_LINKS_PER_ARTICLE = Math.max(2, Number((argv.find((a) => a.startsWith('--max-per-article=')) || '').split('=')[1]) || 8);

const NEWS_OUTLET_RE =
	/^(?:bbc|bbc news|un news|federal news network|reuters|associated press|ap news|enr|engineering news-record|defense daily|breaking defense|defense one|construction dive|construction exec|construction executive|ground engineering|the guardian|new york times|the new york times|washington post|the washington post|wall street journal|the wall street journal|financial times|bloomberg|cnn|fox news|nbc news|cbs news|abc news|npr|al jazeera|kvue|kxan|khou|kfor|abc13|fox7|nbcdfw|wfaa|yahoo finance|wikipedia|youtube|twitter|facebook|instagram|linkedin|tiktok|politico|axios|the hill|cnbc|forbes|fortune|business insider|the economist|associated press)$/i;

const GENERIC_PHRASE_SKIP = new Set([
	'united states',
	'united kingdom',
	'european union',
	'north america',
	'south america',
	'middle east',
	'south africa',
	'north korea',
	'south korea',
	'saudi arabia',
	'new zealand',
	'new york',
	'new jersey',
	'new mexico',
	'new hampshire',
	'north carolina',
	'south carolina',
	'north dakota',
	'south dakota',
	'west virginia',
	'rhode island',
	'washington dc',
	'district of columbia',
	'hong kong',
	'sri lanka',
	'costa rica',
	'puerto rico',
	'el salvador',
	'solomon islands',
	'the pacific',
	'the atlantic',
	'the paper',
	'the fund',
	'the financial',
	'the street',
	'the bank',
	'the court',
	'the board',
	'the agency',
	'the company',
	'the group',
	'the union',
	'the state',
	'the city',
	'the county',
	'the nation',
	'the world',
	'the military',
	'the army',
	'the navy',
	'the air force',
	'the house',
	'the senate',
	'the congress',
	'trading partners',
	'program offices',
	'emergency services',
	'power plant operations',
	'national security',
	'homeland security',
	'public health',
	'mental health',
	'human rights',
	'civil rights',
	'climate change',
	'artificial intelligence',
	'machine learning',
	'data center',
	'data centers',
	'supply chain',
	'real estate',
	'private equity',
	'venture capital',
	'investment bank',
	'federal government',
	'local government',
	'state government',
	'city council',
	'school board',
	'supreme court',
	'appeals court',
	'district court',
	'federal court',
	'police department',
	'fire department',
	'water authority',
	'port authority',
	'transit authority',
	'housing authority',
	'union investment',
	'first national',
	'national bank',
	'american bank',
	'united bank',
	'citizens bank',
	'liberty mutual',
	'first republic',
	'prime minister',
	'vice president',
	'attorney general',
	'secretary general',
	'chief executive',
	'managing director',
	'executive director',
	'board of directors',
	'south pole',
	'north pole',
	'u s government',
	'us government',
	'science and technology',
	'strategic capital',
	'capital planning',
	'public sector',
	'private sector',
	'national defense',
	'foreign policy',
	'executive office',
]);

// Bare single-word org names that are common words, places, or surnames — never match alone.
const SINGLE_WORD_ORG_SKIP = new Set([
	'related',
	'williams',
	'bristol',
	'maryland',
	'michigan',
	'wisconsin',
	'alberta',
	'northwestern',
	'southern',
	'northern',
	'eastern',
	'western',
	'central',
	'pacific',
	'atlantic',
	'continental',
	'republic',
	'standard',
	'citizens',
	'national',
	'american',
	'federal',
	'general',
	'united',
	'global',
	'international',
	'dynamic',
	'direct',
	'target',
	'frontier',
	'pioneer',
	'liberty',
	'heritage',
	'horizon',
	'meridian',
	'pinnacle',
	'vanguard',
	'fidelity',
	'victory',
	'compass',
	'beacon',
	'catalyst',
	'mosaic',
	'spectrum',
	'matrix',
	'vertex',
	'vector',
	'strata',
	'summit',
	'bridge',
	'anchor',
	'energy',
	'capital',
	'partners',
	'holdings',
	'ventures',
	'services',
	'solutions',
	'systems',
	'security',
	'defense',
	'health',
	'medical',
	'research',
	'science',
	'technology',
	'industry',
	'industries',
	'construction',
	'engineering',
	'infrastructure',
	'transport',
	'transportation',
	'financial',
	'banking',
	'insurance',
	'markets',
	'trading',
	'housing',
	'property',
	'properties',
	'building',
	'buildings',
	'community',
	'foundation',
	'institute',
	'association',
	'society',
	'council',
	'commission',
	'committee',
	'authority',
	'administration',
	'department',
	'ministry',
	'bureau',
	'office',
	'agency',
	'service',
	'force',
	'guard',
	'corps',
	'command',
	'division',
	'group',
	'company',
	'corporation',
	'enterprise',
	'enterprises',
	'network',
	'networks',
	'digital',
	'online',
	'mobile',
	'wireless',
	'software',
	'hardware',
	'robotics',
	'aviation',
	'aerospace',
	'maritime',
	'railway',
	'railways',
	'airlines',
	'airways',
	'express',
	'logistics',
	'materials',
	'chemicals',
	'resources',
	'minerals',
	'mining',
	'metals',
	'steel',
	'concrete',
	'cement',
	'lumber',
	'timber',
	'nuclear',
	'solar',
	'electric',
	'electrical',
	'power',
	'water',
	'sewer',
	'waste',
	'climate',
	'carbon',
	'green',
	'clean',
	'smart',
	'modern',
	'future',
	'vision',
	'impact',
	'action',
	'change',
	'growth',
	'value',
	'trust',
	'union',
	'credit',
	'equity',
	'asset',
	'assets',
	'wealth',
	'advisors',
	'advisers',
	'management',
	'consulting',
	'analytics',
	'intelligence',
	'strategy',
	'strategic',
	'operations',
	'development',
	'investments',
	'investment',
	'commercial',
	'industrial',
	'residential',
	'municipal',
	'regional',
	'metropolitan',
	'public',
	'private',
	'civic',
	'urban',
	'rural',
	'coastal',
	'island',
	'valley',
	'mountain',
	'river',
	'harbor',
	'forest',
	'desert',
	'prairie',
	'plains',
	'spring',
	'springs',
	'falls',
	'creek',
	'ridge',
	'point',
	'field',
	'fields',
	'garden',
	'gardens',
	'meadow',
	'park',
	'plaza',
	'tower',
	'center',
	'centre',
	'square',
	'court',
	'house',
	'hall',
	'plant',
	'station',
	'terminal',
	'campus',
	'college',
	'school',
	'academy',
	'university',
	'hospital',
	'clinic',
	'oxford',
	'cambridge',
	'columbia',
	'virginia',
	'georgia',
	'florida',
	'texas',
	'indiana',
	'illinois',
	'oregon',
	'nevada',
	'arizona',
	'colorado',
	'kansas',
	'montana',
	'alabama',
	'alaska',
	'hawaii',
	'dakota',
	'carolina',
	'missouri',
	'tennessee',
	'kentucky',
	'oklahoma',
	'louisiana',
	'arkansas',
	'minnesota',
	'nebraska',
	'delaware',
	'vermont',
	'wyoming',
	'pennsylvania',
	'california',
	'massachusetts',
	'connecticut',
	'washington',
	'ohio',
	'iowa',
	'idaho',
	'utah',
	'maine',
	'england',
	'scotland',
	'ireland',
	'wales',
	'france',
	'germany',
	'spain',
	'italy',
	'sweden',
	'norway',
	'poland',
	'turkey',
	'canada',
	'mexico',
	'brazil',
	'india',
	'china',
	'japan',
	'russia',
	'ukraine',
	'israel',
	'palestine',
	'iran',
	'iraq',
	'syria',
	'egypt',
	'libya',
	'sudan',
	'nigeria',
	'kenya',
	'zimbabwe',
	'pakistan',
	'venezuela',
	'colombia',
	'australia',
	'switzerland',
	'singapore',
	'malaysia',
	'thailand',
	'vietnam',
	'indonesia',
	'philippines',
	'taiwan',
	'london',
	'paris',
	'berlin',
	'madrid',
	'rome',
	'vienna',
	'zurich',
	'geneva',
	'brussels',
	'amsterdam',
	'dublin',
	'toronto',
	'montreal',
	'vancouver',
	'sydney',
	'melbourne',
	'mumbai',
	'delhi',
	'shanghai',
	'beijing',
	'tokyo',
	'seoul',
	'boston',
	'chicago',
	'dallas',
	'houston',
	'austin',
	'seattle',
	'denver',
	'atlanta',
	'miami',
	'detroit',
	'phoenix',
	'portland',
	'baltimore',
	'pittsburgh',
	'philadelphia',
	'cleveland',
	'cincinnati',
	'minneapolis',
	'nashville',
	'memphis',
	'orlando',
	'tampa',
	'charlotte',
	'raleigh',
	'richmond',
	'hamburg',
	'munich',
	'frankfurt',
	'manchester',
	'birmingham',
	'liverpool',
	'glasgow',
	'edinburgh',
	'belfast',
	'cardiff',
	'leeds',
	'sheffield',
	'orange',
	'apple',
	'shell',
	'meta',
	'visa',
	'amazon',
	'oracle',
	'delta',
	'united',
	'spirit',
	'frontier',
	'jetblue',
	'southwest',
	'american',
	'british',
	'norwegian',
	'general',
	'morgan',
	'chase',
	'wells',
	'fargo',
	'goldman',
	'sachs',
	'barclays',
	'turner',
	'bechtel',
	'jacobs',
	'fluor',
	'kiewit',
	'skanska',
	'clark',
	'walsh',
	'granite',
	'parsons',
	'knight',
	'walker',
	'fisher',
	'hunter',
	'baker',
	'miller',
	'carter',
	'cooper',
	'parker',
	'taylor',
	'wilson',
	'johnson',
	'jackson',
	'thompson',
	'anderson',
	'harris',
	'martin',
	'thomas',
	'roberts',
	'edwards',
	'collins',
	'stewart',
	'morris',
	'rogers',
	'morgan',
	'bell',
	'murphy',
	'bailey',
	'rivera',
	'richardson',
	'howard',
	'brooks',
	'kelly',
	'sanders',
	'price',
	'bennett',
	'barnes',
	'henderson',
	'coleman',
	'jenkins',
	'perry',
	'powell',
	'patterson',
	'hughes',
	'butler',
	'simmons',
	'foster',
	'russell',
	'griffin',
	'hayes',
	'myers',
	'ford',
	'hamilton',
	'graham',
	'sullivan',
	'wallace',
	'woods',
	'west',
	'jordan',
	'owens',
	'reynolds',
	'ellis',
	'harrison',
	'gibson',
	'mcdonald',
	'marshall',
	'ortiz',
	'gomez',
	'murray',
	'freeman',
	'webb',
	'simpson',
	'stevens',
	'tucker',
	'porter',
	'hicks',
	'crawford',
	'henry',
	'boyd',
	'mason',
	'morales',
	'kennedy',
	'warren',
	'dixon',
	'ramos',
	'reyes',
	'burns',
	'gordon',
	'shaw',
	'holmes',
	'rice',
	'robertson',
	'hunt',
	'black',
	'daniels',
	'palmer',
	'mills',
	'nichols',
	'grant',
	'ferguson',
	'rose',
	'stone',
	'hawkins',
	'dunn',
	'perkins',
	'hudson',
	'spencer',
	'gardner',
	'stephens',
	'payne',
	'pierce',
	'berry',
	'matthews',
	'arnold',
	'wagner',
	'willis',
	'ray',
	'watkins',
	'olson',
	'carroll',
	'duncan',
	'snyder',
	'hart',
	'cunningham',
	'bradley',
	'lane',
	'andrews',
	'ruiz',
	'harper',
	'fox',
	'riley',
	'armstrong',
	'carpenter',
	'weaver',
	'greene',
	'lawrence',
	'elliott',
	'chavez',
	'sims',
	'austin',
	'peters',
	'kelley',
	'franklin',
	'lawson',
	'fields',
	'gutierrez',
	'ryan',
	'schmidt',
	'carr',
	'vasquez',
	'castillo',
	'wheeler',
	'chapman',
	'oliver',
	'montgomery',
	'richards',
	'williamson',
	'johnston',
	'banks',
	'meyer',
	'bishop',
	'mccoy',
	'howell',
	'alvarez',
	'morrison',
	'hansen',
	'fernandez',
	'garza',
	'harvey',
	'little',
	'burton',
	'stanley',
	'nguyen',
	'george',
	'reid',
	'kim',
	'fuller',
	'lynch',
	'dean',
	'gilbert',
	'garrett',
	'romero',
	'welch',
	'larson',
	'frazier',
	'burke',
	'hanson',
	'day',
	'mendoza',
	'moreno',
	'bowman',
	'medina',
	'fowler',
	'brewer',
	'hoffman',
	'carlson',
	'silva',
	'pearson',
	'holland',
	'douglas',
	'fleming',
	'jensen',
	'vargas',
	'byrd',
	'davidson',
	'hopkins',
	'may',
	'terry',
	'herrera',
	'wade',
	'soto',
	'walters',
	'curtis',
	'neal',
	'caldwell',
	'lowe',
	'jennings',
	'barnett',
	'graves',
	'jimenez',
	'horton',
	'shelton',
	'barrett',
	'obrien',
	'castro',
	'sutton',
	'gregory',
	'mckinney',
	'lucas',
	'miles',
	'craig',
	'rodriquez',
	'chambers',
	'holt',
	'lambert',
	'fletcher',
	'watts',
	'bates',
	'hale',
	'rhodes',
	'pena',
	'beck',
	'newman',
]);

// Unambiguous single-word proper brands allowed as standalone capitalized matches.
const DISTINCTIVE_BRAND_WORDS = new Set([
	'nvidia',
	'boeing',
	'airbus',
	'spacex',
	'palantir',
	'lockheed',
	'raytheon',
	'halliburton',
	'chevron',
	'exxonmobil',
	'anthropic',
	'openai',
	'microsoft',
	'google',
	'alphabet',
	'tesla',
	'intel',
	'qualcomm',
	'broadcom',
	'cisco',
	'honeywell',
	'caterpillar',
	'pfizer',
	'moderna',
	'novartis',
	'sanofi',
	'astrazeneca',
	'amtrak',
	'penndot',
	'txdot',
	'odot',
	'anduril',
	'northrop',
	'safran',
	'thales',
	'siemens',
	'cerberus',
	'oneweb',
	'enbridge',
	'aecom',
	'textron',
	'leidos',
	'l3harris',
	'starlink',
	'deepseek',
	'baidu',
	'alibaba',
	'tencent',
	'huawei',
	'samsung',
	'toyota',
	'volkswagen',
	'stellantis',
	'renault',
	'comcast',
	'verizon',
	'citigroup',
	'blackrock',
	'jpmorgan',
	'mastercard',
	'paypal',
	'stripe',
	'coinbase',
	'cloudflare',
	'crowdstrike',
	'databricks',
	'snowflake',
	'salesforce',
	'servicenow',
	'workday',
	'atlassian',
	'netflix',
	'spotify',
	'airbnb',
	'uber',
	'lyft',
	'doordash',
	'walmart',
	'costco',
	'kroger',
	'starbucks',
	'pepsico',
	'unilever',
	'nestle',
	'danaher',
	'medtronic',
	'abbvie',
	'amgen',
	'gilead',
	'biogen',
	'regeneron',
	'illumina',
	'stryker',
	'schlumberger',
	'conocophillips',
	'valero',
	'occidental',
	'nextera',
	'vistra',
	'entergy',
	'exelon',
	'sempra',
	'ameren',
	'nisource',
	'iberdrola',
	'orsted',
	'vestas',
	'engie',
	'totalenergies',
	'equinor',
	'aramco',
	'petrobras',
	'glencore',
	'newmont',
	'nucor',
	'arcelormittal',
	'holcim',
	'cemex',
	'pultegroup',
	'hntb',
	'stantec',
	'costain',
	'bouygues',
	'eiffage',
	'strabag',
	'hochtief',
	'ferrovial',
	'acciona',
	'obayashi',
	'kajima',
	'shimizu',
	'taisei',
	'hyundai',
	'doosan',
]);

// Canonical journalistic shorthands -> preferred existing profile name (exact match, case-insensitive)
const CANONICAL_AGENCY_SHORTHANDS = [
	{ phrases: ['pentagon', 'the pentagon', 'defense department', 'department of defense'], targetName: 'United States Department of Defense' },
	{ phrases: ['justice department', 'department of justice'], targetName: 'United States Department of Justice (DOJ)' },
	{ phrases: ['commerce department', 'department of commerce'], targetName: 'United States Department of Commerce' },
	{ phrases: ['state department', 'department of state'], targetName: 'United States Department of State (DOS)' },
	{ phrases: ['treasury department', 'department of the treasury'], targetName: 'United States Department of the Treasury' },
	{ phrases: ['transportation department', 'department of transportation'], targetName: 'United States Department of Transportation' },
	{ phrases: ['department of homeland security', 'homeland security department', 'u s department of homeland security', 'us department of homeland security'], targetName: 'United States Department of Homeland Security' },
	{ phrases: ['department of veterans affairs', 'veterans affairs'], targetName: 'United States Department of Veterans Affairs' },
	{ phrases: ['energy department', 'department of energy'], targetName: 'United States Department of Energy' },
	{ phrases: ['federal reserve'], targetName: 'Federal Reserve System' },
	{ phrases: ['white house', 'the white house'], targetName: 'The White House' },
	{ phrases: ['u s army', 'us army'], targetName: 'United States Army' },
	{ phrases: ['u s air force', 'us air force'], targetName: 'United States Air Force' },
	{ phrases: ['u s navy', 'us navy'], targetName: 'United States Navy' },
	{ phrases: ['u s marine corps', 'us marine corps', 'marine corps'], targetName: 'United States Marine Corps' },
	{ phrases: ['u s coast guard', 'us coast guard', 'coast guard'], targetName: 'United States Coast Guard' },
];

// Known uppercase acronyms with optional preferred canonical slug/keyword hints for disambiguation.
const KNOWN_UPPER_ACRONYMS = new Map([
	['FEMA', 'federal emergency management'],
	['EPA', 'environmental protection'],
	['OSHA', 'occupational safety'],
	['NASA', 'aeronautics'],
	['NATO', 'north atlantic treaty'],
	['DARPA', 'defense advanced research'],
	['NOAA', 'oceanic'],
	['CISA', 'cybersecurity'],
	['USACE', 'army corps of engineers'],
	['USGS', 'geological survey'],
	['NWS', 'weather service'],
	['NTSB', 'transportation safety'],
	['FAA', 'aviation administration'],
	['FCC', 'communications commission'],
	['FTC', 'trade commission'],
	['FDIC', 'deposit insurance'],
	['FINRA', 'financial industry regulatory'],
	['CFPB', 'consumer financial protection'],
	['FBI', 'federal bureau of investigation'],
	['CIA', 'central intelligence'],
	['NSA', 'national security agency'],
	['DHS', 'homeland security'],
	['DOD', 'department of defense'],
	['DOJ', 'department of justice'],
	['DOE', 'department of energy'],
	['HHS', 'health and human services'],
	['HUD', 'housing and urban'],
	['IRS', 'internal revenue'],
	['OPM', 'personnel management'],
	['GSA', 'general services administration'],
	['NNSA', 'national nuclear security'],
	['SBA', 'small business administration'],
	['SSA', 'social security administration'],
	['ATF', 'alcohol tobacco firearms'],
	['DEA', 'drug enforcement'],
	['ICE', 'immigration and customs'],
	['CBP', 'customs and border'],
	['BOP', 'bureau of prisons'],
	['USPS', 'postal service'],
	['USDA', 'department of agriculture'],
	['CDC', 'disease control'],
	['NIH', 'institutes of health'],
	['FDA', 'food and drug'],
	['CMS', 'medicare'],
	['WHO', 'world health organization'],
	['WTO', 'world trade organization'],
	['IMF', 'international monetary fund'],
	['UNHCR', 'refugees'],
	['UNICEF', 'children'],
	['UNESCO', 'educational scientific'],
	['IAEA', 'atomic energy'],
	['OPEC', 'petroleum exporting'],
	['ASCE', 'civil engineers'],
	['NVIDIA', 'nvidia'],
	['TSMC', 'taiwan semiconductor'],
	['ASML', 'asml'],
	['CERN', 'nuclear research'],
	['ESA', 'european space'],
	['JAXA', 'japan aerospace'],
	['ISRO', 'indian space'],
]);

const SMALL_CONNECTORS = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'on', 'to', 'by', 'de', 'la', 'du', 'van', 'von', 'der', 'al', 'el', 'bin']);

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verify that the phrase actually appears with Proper-Noun capitalization in the original text.
 * Every non-connector word (len >= 2) must start with an uppercase letter (or digit).
 */
function appearsCapitalizedInText(rawText, lowPhrase) {
	const words = lowPhrase.split(' ').filter(Boolean);
	if (!words.length) return false;
	const exactPattern = words
		.map((w) => {
			if (SMALL_CONNECTORS.has(w)) return `(?:${escapeRe(w)}|${escapeRe(w[0].toUpperCase() + w.slice(1))}|${escapeRe(w.toUpperCase())})`;
			if (/^\d/.test(w)) return escapeRe(w);
			const firstUpper = escapeRe(w[0].toUpperCase());
			const restExact = w
				.slice(1)
				.split('')
				.map((ch) => (/[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : escapeRe(ch)))
				.join('');
			return `${firstUpper}${restExact}`;
		})
		.join('(?:[\\s\\-\\u2013\\u2014&,.\'’]+)');
	try {
		const re = new RegExp(`(?<![A-Za-z0-9])${exactPattern}(?![A-Za-z0-9])`);
		return re.test(rawText);
	} catch {
		return false;
	}
}

function stripLegal(s) {
	return String(s || '')
		.replace(/\b(?:inc\.?|incorporated|corp\.?|corporation|llc|l\.l\.c\.|ltd\.?|limited|plc|l\.p\.|lp|llp|pbc|co\.?|company|holdings?|group)\b/gi, ' ')
		.replace(/[^a-z0-9\s'-]+/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractArticleProse(article) {
	const body = String(article.summary || '')
		.replace(/\n## Local Wikipedia cross-check[\s\S]*$/i, '')
		.replace(/\n## Source articles[\s\S]*$/i, '')
		.replace(/\n## Sources[\s\S]*$/i, '');
	return `${article.name || ''}\n${body}`;
}

function extractSentenceAround(text, needle) {
	const idx = text.toLowerCase().indexOf(needle.toLowerCase());
	if (idx < 0) return '';
	const start = Math.max(0, text.lastIndexOf('.', idx) + 1, text.lastIndexOf('\n', idx) + 1);
	let end = text.indexOf('.', idx + needle.length);
	const nl = text.indexOf('\n', idx + needle.length);
	if (nl >= 0 && (end < 0 || nl < end)) end = nl;
	if (end < 0) end = Math.min(text.length, idx + 220);
	else end += 1;
	return text.slice(start, end).replace(/^[-*•\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 260);
}

function classifyContextRecency(text, needle) {
	const low = text.toLowerCase();
	const idx = low.indexOf(needle.toLowerCase());
	if (idx < 0) return null;
	// Only match modifiers directly modifying this entity (no clause boundary like .,;: in between)
	const before = low.slice(Math.max(0, idx - 36), idx);
	const after = low.slice(idx + needle.length, Math.min(low.length, idx + needle.length + 32));
	if (/\b(?:former|ex-|retired|ousted|late|deceased|disgraced|impeached)\s+(?:[a-z.'-]+\s+){0,4}$/.test(before) || /^,\s*(?:former|ex-|retired|who previously served)\b/.test(after)) {
		return 'previous';
	}
	if (/\b(?:current|interim|acting|incumbent|ceo|chief executive|chairman|chair|president|secretary|director|administrator|speaker|governor|senator|minister|commander|general|admiral|secretary of)\s+(?:[a-z.'-]+\s+){0,4}$/.test(before) || /^,\s*(?:ceo|chief executive|president|chair|chairman|director|secretary|acting|interim)\b/.test(after)) {
		return 'current';
	}
	return null;
}

function main() {
	const db = new DatabaseSync(PROFILES_DB, { readOnly: DRY_RUN });
	if (!DRY_RUN) db.exec('PRAGMA busy_timeout = 10000;');

	const articles = db
		.prepare(
			ALL_EVENTS
				? `SELECT p.id, p.slug, p.name, p.start_date, p.summary, p.metadata_json
           FROM profiles p
           WHERE p.profile_type = 'historic_event'
             AND p.status IN ('active', 'pinned')
             AND length(trim(coalesce(p.summary, ''))) >= 60
           ORDER BY p.start_date DESC, p.updated_at DESC`
				: `SELECT p.id, p.slug, p.name, p.start_date, p.summary, p.metadata_json
           FROM profiles p
           WHERE p.profile_type = 'historic_event'
             AND p.status IN ('active', 'pinned')
             AND (p.slug LIKE 'historic_event:news-%' OR p.metadata_json LIKE '%news_rss%')
           ORDER BY p.start_date DESC, p.updated_at DESC`,
		)
		.all();

	const existingPairs = new Set();
	const actorConnections = new Map();
	const allLinks = db
		.prepare(
			`SELECT pl.from_profile_id, pl.to_profile_id, pl.relation_type, pl.role_label, pl.start_date, pl.end_date, pl.evidence_note,
              fp.name AS from_name, fp.profile_type AS from_type,
              tp.name AS to_name, tp.profile_type AS to_type
       FROM profile_links pl
       JOIN profiles fp ON fp.id = pl.from_profile_id
       JOIN profiles tp ON tp.id = pl.to_profile_id`,
		)
		.all();

	for (const l of allLinks) {
		existingPairs.add(`${l.from_profile_id}|${l.to_profile_id}`);
		existingPairs.add(`${l.to_profile_id}|${l.from_profile_id}`);
		if (l.from_type !== 'historic_event' && l.to_type !== 'historic_event') {
			const isPrevious =
				Boolean(l.end_date) ||
				/\b(?:former|previous|ex-|retired|past|status=previous)\b/i.test(`${l.role_label || ''} ${l.evidence_note || ''}`);
			const addConn = (id, peerId, peerName, peerType) => {
				let arr = actorConnections.get(id);
				if (!arr) {
					arr = [];
					actorConnections.set(id, arr);
				}
				arr.push({
					peerId,
					peerName,
					peerType,
					rel: l.relation_type,
					role: l.role_label || null,
					startDate: l.start_date || null,
					endDate: l.end_date || null,
					isPrevious,
				});
			};
			addConn(l.from_profile_id, l.to_profile_id, l.to_name, l.to_type);
			addConn(l.to_profile_id, l.from_profile_id, l.from_name, l.from_type);
		}
	}

	// Skip junk role-as-firm stubs (e.g. "Textron CEO", "Army Undersecretary", "UNCTAD Acting Secretary-General")
	const ROLE_TITLE_STUB_RE =
		/\b(?:ceo|chief executive|undersecretary|secretary-general|attorney general|executive for|director of|acting secretary)\b$/i;

	const rawActors = db
		.prepare(
			`SELECT p.id, p.slug, p.profile_type, p.name, p.normalized_name, p.status, p.summary, p.metadata_json
       FROM profiles p
       WHERE p.profile_type IN ('person','firm','government','nonprofit','education','medical_hospital')
         AND p.status IN ('active','pinned')`,
		)
		.all();

	const aliasMap = new Map();
	for (const r of db
		.prepare(`SELECT profile_id, alias, alias_kind FROM profile_aliases WHERE alias_kind IN ('name','acronym','other_name')`)
		.all()) {
		let arr = aliasMap.get(r.profile_id);
		if (!arr) {
			arr = [];
			aliasMap.set(r.profile_id, arr);
		}
		arr.push(r);
	}

	const actorById = new Map();
	const phraseIndex = new Map();
	const upperAcronymIndex = new Map();
	const addIndex = (map, key, id) => {
		let s = map.get(key);
		if (!s) {
			s = new Set();
			map.set(key, s);
		}
		s.add(id);
	};

	for (const a of rawActors) {
		const m = String(a.metadata_json || '');
		const isFinraOnly =
			a.status !== 'pinned' &&
			m.includes('finra-visualizer') &&
			!m.includes('wikipedia') &&
			!m.includes('manual') &&
			!m.includes('wikidata') &&
			String(a.summary || '').length < 180;
		if (isFinraOnly) continue;
		if (a.profile_type !== 'person' && ROLE_TITLE_STUB_RE.test(String(a.name || '').trim())) continue;

		actorById.set(a.id, a);
		const names = [{ alias: a.name, kind: 'name' }, ...(aliasMap.get(a.id) || []).map((x) => ({ alias: x.alias, kind: x.alias_kind }))];

		for (const { alias } of names) {
			const raw = String(alias || '').trim();
			if (!raw || NEWS_OUTLET_RE.test(raw)) continue;

			// Known uppercase acronyms (e.g. FEMA, EPA, NASA, FBI, GSA, NNSA)
			if (KNOWN_UPPER_ACRONYMS.has(raw)) {
				const hint = KNOWN_UPPER_ACRONYMS.get(raw);
				const hay = `${a.name} ${a.summary || ''}`.toLowerCase();
				if (!hint || hay.includes(hint)) {
					addIndex(upperAcronymIndex, raw, a.id);
				}
				continue;
			}

			const clean = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
			const low = clean
				.toLowerCase()
				.replace(/[^a-z0-9\s'-]+/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			if (!low || GENERIC_PHRASE_SKIP.has(low) || NEWS_OUTLET_RE.test(low)) continue;
			const words = low.split(' ').filter(Boolean);

			if (a.profile_type === 'person') {
				if (words.length < 2 || words.length > 4) continue;
				if (words[0].length < 2 || words[words.length - 1].length < 4) continue;
				addIndex(phraseIndex, low, a.id);
			} else if (a.profile_type === 'education') {
				// Education: require an academic cue word so bare city/state aliases never fire.
				if (!/\b(?:university|college|institute|school|academy|polytechnic|mit|caltech|stanford|harvard|yale|princeton|cornell|dartmouth|brown university|duke university|johns hopkins|carnegie mellon|northwestern university)\b/i.test(low)) {
					continue;
				}
				if (words.length >= 2 && low.length >= 8) {
					addIndex(phraseIndex, low, a.id);
				}
			} else if (a.profile_type === 'medical_hospital') {
				// Hospital: require a medical cue word so e.g. "Johns Hopkins University" never maps to "Johns Hopkins Hospital"
				if (!/\b(?:hospital|medical|clinic|health|infirmary|sanatorium|care center|medical center)\b/i.test(low)) {
					continue;
				}
				if (words.length >= 2 && low.length >= 8) {
					addIndex(phraseIndex, low, a.id);
				}
			} else {
				// Firm, Government, Nonprofit
				if (words.length >= 2 && low.length >= 7) {
					// Never index bare "the <skip-word>"
					const withoutLeadingThe = low.replace(/^the\s+/, '');
					if (!(low.startsWith('the ') && !withoutLeadingThe.includes(' ') && SINGLE_WORD_ORG_SKIP.has(withoutLeadingThe))) {
						addIndex(phraseIndex, low, a.id);
					}
					const stripped = stripLegal(clean).toLowerCase().replace(/^the\s+/, '').trim();
					if (
						stripped &&
						stripped !== low &&
						!GENERIC_PHRASE_SKIP.has(stripped) &&
						!SINGLE_WORD_ORG_SKIP.has(stripped) &&
						!NEWS_OUTLET_RE.test(stripped)
					) {
						const sw = stripped.split(' ').filter(Boolean);
						if (sw.length >= 2 && stripped.length >= 8) {
							addIndex(phraseIndex, stripped, a.id);
						} else if (sw.length === 1 && DISTINCTIVE_BRAND_WORDS.has(stripped)) {
							addIndex(phraseIndex, stripped, a.id);
						}
					}
				} else if (words.length === 1 && DISTINCTIVE_BRAND_WORDS.has(low) && !SINGLE_WORD_ORG_SKIP.has(low)) {
					addIndex(phraseIndex, low, a.id);
				}
			}
		}
	}

	// Prefer canonical / pinned profile when multiple profiles share an exact phrase or acronym
	const pickBestForKey = (ids) => {
		if (ids.size <= 1) return [...ids];
		const arr = [...ids].map((id) => actorById.get(id)).filter(Boolean);
		const pinned = arr.filter((a) => a.status === 'pinned');
		if (pinned.length === 1) return [pinned[0].id];
		if (arr.length === 2) {
			// Prefer longer summary / more connections
			arr.sort((x, y) => {
				const cx = (actorConnections.get(x.id)?.length || 0) + (x.status === 'pinned' ? 10 : 0);
				const cy = (actorConnections.get(y.id)?.length || 0) + (y.status === 'pinned' ? 10 : 0);
				return cy - cx || String(y.summary || '').length - String(x.summary || '').length;
			});
			return [arr[0].id];
		}
		return [];
	};

	const resolvedPhrase = new Map();
	for (const [k, set] of phraseIndex.entries()) {
		if (set.size > 3) continue;
		const best = pickBestForKey(set);
		if (best.length === 1) resolvedPhrase.set(k, best[0]);
	}
	const resolvedAcronym = new Map();
	for (const [k, set] of upperAcronymIndex.entries()) {
		const best = pickBestForKey(set);
		if (best.length === 1) resolvedAcronym.set(k, best[0]);
	}

	// Bind canonical agency shorthands and preferred pinned targets (also prevents duplicate
	// "White House" vs "The White House" or unpinned DHS duplicate).
	const actorByExactLowerName = new Map();
	for (const a of actorById.values()) {
		const key = String(a.name || '').trim().toLowerCase();
		const prev = actorByExactLowerName.get(key);
		if (!prev || (a.status === 'pinned' && prev.status !== 'pinned') || (actorConnections.get(a.id)?.length || 0) > (actorConnections.get(prev.id)?.length || 0)) {
			actorByExactLowerName.set(key, a);
		}
	}
	for (const { phrases, targetName } of CANONICAL_AGENCY_SHORTHANDS) {
		const target = actorByExactLowerName.get(targetName.toLowerCase());
		if (!target) continue;
		for (const p of phrases) {
			resolvedPhrase.set(p, target.id);
		}
	}
	// Ensure major acronyms prefer the pinned canonical agency even if a duplicate lacks the alias
	const ACRONYM_PREFERRED_TARGETS = {
		DHS: 'United States Department of Homeland Security',
		DOJ: 'United States Department of Justice (DOJ)',
		DOD: 'United States Department of Defense',
		DOE: 'United States Department of Energy',
		SEC: 'Securities and Exchange Commission (SEC)',
	};
	for (const [acr, targetName] of Object.entries(ACRONYM_PREFERRED_TARGETS)) {
		const target = actorByExactLowerName.get(targetName.toLowerCase());
		if (target) resolvedAcronym.set(acr, target.id);
	}

	let articlesTouched = 0;
	let linksCreated = 0;
	let currentTagged = 0;
	let previousTagged = 0;
	let directOnlyTagged = 0;
	const byType = {};
	const samples = [];

	for (const art of articles) {
		const rawText = extractArticleProse(art);
		const lowText = rawText
			.toLowerCase()
			.replace(/[^a-z0-9\s'-]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const toks = lowText.split(' ');
		const found = new Map();

		// 1. Uppercase acronyms
		for (const m of rawText.matchAll(/\b([A-Z][A-Z0-9]{2,6})\b/g)) {
			const acr = m[1];
			const id = resolvedAcronym.get(acr);
			if (id && !found.has(id)) {
				found.set(id, { matchedVia: acr, isAcronym: true });
			}
		}

		// 2. 1..6-gram phrase matches with strict Proper-Noun capitalization check
		for (let i = 0; i < toks.length; i++) {
			let phrase = '';
			for (let len = 1; len <= 6 && i + len <= toks.length; len++) {
				phrase = len === 1 ? toks[i] : `${phrase} ${toks[i + len - 1]}`;
				const id = resolvedPhrase.get(phrase);
				if (!id || found.has(id)) continue;
				if (!appearsCapitalizedInText(rawText, phrase)) continue;
				found.set(id, { matchedVia: phrase, isAcronym: false });
			}
		}

		// 3. 1-hop current/previous connection check: if an org in `found` has connected people
		// whose full name appears capitalized in rawText, include them as corroborated connections!
		for (const actorId of [...found.keys()]) {
			const conns = actorConnections.get(actorId) || [];
			for (const c of conns) {
				if (c.peerType !== 'person' || found.has(c.peerId)) continue;
				const pNorm = normalizeText(c.peerName);
				const pWords = pNorm.split(' ').filter(Boolean);
				if (pWords.length < 2 || pWords[pWords.length - 1].length < 4) continue;
				if (appearsCapitalizedInText(rawText, pNorm)) {
					if (!actorById.has(c.peerId)) {
						const row = db.prepare('SELECT id, slug, profile_type, name, normalized_name, status, summary, metadata_json FROM profiles WHERE id = ?').get(c.peerId);
						if (row) actorById.set(row.id, row);
					}
					found.set(c.peerId, { matchedVia: pNorm, isAcronym: false, viaOrgConn: c });
				}
			}
		}

		// Score and select top verified associations for this article
		const candidates = [];
		for (const [actorId, info] of found.entries()) {
			if (existingPairs.has(`${actorId}|${art.id}`)) continue;
			const actor = actorById.get(actorId);
			if (!actor) continue;

			const conns = actorConnections.get(actorId) || [];
			const peerHits = conns.filter((c) => found.has(c.peerId));
			const inTitle = (art.name || '').toLowerCase().includes(info.matchedVia.toLowerCase());

			if (actor.profile_type === 'person') {
				const hasPeer = peerHits.length > 0 || Boolean(info.viaOrgConn);
				const isPinned = actor.status === 'pinned';
				if (!hasPeer && !isPinned && !inTitle) continue;
			}

			// Determine current vs previous connection label
			let roleLabel = null;
			let connKind = 'direct';
			const bestPeer = info.viaOrgConn || peerHits[0] || null;
			if (bestPeer) {
				const statusWord = bestPeer.isPrevious ? 'Previous' : 'Current';
				connKind = bestPeer.isPrevious ? 'previous' : 'current';
				const relDesc = bestPeer.role || bestPeer.rel.replace(/_/g, ' ');
				roleLabel = `${statusWord} connection (${relDesc} — ${bestPeer.peerName})`.slice(0, 140);
			} else {
				const ctxRecency = classifyContextRecency(rawText, info.matchedVia);
				if (ctxRecency === 'previous') {
					connKind = 'previous';
					roleLabel = 'Previous connection referenced';
				} else if (ctxRecency === 'current') {
					connKind = 'current';
					roleLabel = 'Current connection referenced';
				} else if (conns.length > 0) {
					// Check if actor has an active primary org connection mentioned or general current role
					const curOrg = conns.find((c) => !c.isPrevious && c.peerType !== 'person');
					const prevOrg = conns.find((c) => c.isPrevious && c.peerType !== 'person');
					if (actor.profile_type === 'person' && (curOrg || prevOrg)) {
						const pick = curOrg || prevOrg;
						connKind = pick.isPrevious ? 'previous' : 'current';
						roleLabel = `${pick.isPrevious ? 'Previous' : 'Current'} connection (${pick.role || pick.peerName})`.slice(0, 140);
					}
				}
			}

			const snippet = extractSentenceAround(rawText, info.matchedVia);
			const priority = (peerHits.length > 0 || info.viaOrgConn ? 30 : 0) + (inTitle ? 20 : 0) + (actor.status === 'pinned' ? 10 : 0) + (info.isAcronym ? 5 : 0);
			candidates.push({
				actorId,
				actorName: actor.name,
				actorType: actor.profile_type,
				matchedVia: info.matchedVia,
				roleLabel,
				connKind,
				snippet,
				priority,
			});
		}

		candidates.sort((a, b) => b.priority - a.priority);
		const chosen = candidates.slice(0, MAX_LINKS_PER_ARTICLE);
		if (!chosen.length) continue;

		articlesTouched += 1;
		for (const c of chosen) {
			if (!DRY_RUN) {
				upsertProfileLink(
					{
						fromProfileId: c.actorId,
						toProfileId: art.id,
						relationType: c.connKind === 'direct' ? 'mentioned_in' : 'participated_in',
						roleLabel: c.roleLabel,
						startDate: art.start_date || null,
						status: 'observed',
						confidence: c.priority >= 30 ? 0.94 : c.priority >= 20 ? 0.9 : 0.85,
						angle: 'general',
						sourceCorpus: CORPUS,
						evidenceNote: c.snippet || `Matched "${c.matchedVia}" in article "${art.name}"`,
					},
					db,
				);
			}
			existingPairs.add(`${c.actorId}|${art.id}`);
			existingPairs.add(`${art.id}|${c.actorId}`);
			linksCreated += 1;
			byType[c.actorType] = (byType[c.actorType] || 0) + 1;
			if (c.connKind === 'current') currentTagged += 1;
			else if (c.connKind === 'previous') previousTagged += 1;
			else directOnlyTagged += 1;
		}

		if (DUMP_ALL || samples.length < 35) {
			samples.push({
				article: art.name,
				date: art.start_date,
				links: chosen.map((c) => `${c.actorType}:${c.actorName} [${c.matchedVia}]${c.roleLabel ? ` -> ${c.roleLabel}` : ''}`),
			});
		}
	}

	db.close?.();
	console.log(
		JSON.stringify(
			{
				dryRun: DRY_RUN,
				allEvents: ALL_EVENTS,
				articlesScanned: articles.length,
				articlesTouched,
				linksCreated,
				currentTagged,
				previousTagged,
				directOnlyTagged,
				byType,
				samples,
			},
			null,
			2,
		),
	);
}

main();
