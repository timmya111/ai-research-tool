/**
 * Extracts exact report dates, Groundwater Conservation Districts (GCDs),
 * Groundwater Management Areas (GMAs), Texas counties, cities, authors, and
 * concise request/purpose summaries from local TWDB Trinity Aquifer digests
 * (.data/twdb-trinity-aquifer/digests/*.md).
 */

export type TwdbParsedDigest = {
	eventDate: string | null;
	datePrecision: 'day' | 'month' | 'year' | 'unknown';
	title: string;
	geoLabel: string;
	geoKey: string;
	summary: string;
	district: string | null;
	gmas: string[];
	counties: string[];
	cities: string[];
	author: string | null;
};

type DistrictGeo = {
	pattern: RegExp;
	label: string;
	counties: string[];
	cities: string[];
};

const TEXAS_DISTRICTS: DistrictGeo[] = [
	{
		pattern: /\bClearwater\s+Underground\s+Water\s+Conservation\s+District\b/i,
		label: 'Clearwater UWCD',
		counties: ['Bell County'],
		cities: ['Belton', 'Killeen', 'Temple'],
	},
	{
		pattern: /\bMiddle\s+Trinity\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Middle Trinity GCD',
		counties: ['Erath County', 'Comanche County', 'Bosque County', 'Coryell County'],
		cities: ['Stephenville', 'Comanche', 'Meridian', 'Gatesville'],
	},
	{
		pattern: /\bCow\s+Creek\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Cow Creek GCD',
		counties: ['Kendall County'],
		cities: ['Boerne', 'Comfort'],
	},
	{
		pattern: /\b(?:Neches\s+and\s+)?Trinity\s+Valleys\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Neches & Trinity Valleys GCD',
		counties: ['Anderson County', 'Cherokee County', 'Henderson County'],
		cities: ['Palestine', 'Jacksonville', 'Athens'],
	},
	{
		pattern: /\bFox\s+Crossing\s+Water\s+District\b/i,
		label: 'Fox Crossing Water District',
		counties: ['Mills County'],
		cities: ['Goldthwaite'],
	},
	{
		pattern: /\bHays[\s-]+Trinity\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Hays Trinity GCD',
		counties: ['Hays County'],
		cities: ['Dripping Springs', 'Wimberley', 'San Marcos'],
	},
	{
		pattern: /\bCentral\s+Texas\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Central Texas GCD',
		counties: ['Burnet County'],
		cities: ['Burnet', 'Marble Falls'],
	},
	{
		pattern: /\bMedina\s+County\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Medina County GCD',
		counties: ['Medina County'],
		cities: ['Castroville', 'Hondo'],
	},
	{
		pattern: /\bBlanco[\s-]+Pedernales\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Blanco-Pedernales GCD',
		counties: ['Blanco County'],
		cities: ['Johnson City', 'Blanco'],
	},
	{
		pattern: /\bLost\s+Pines\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Lost Pines GCD',
		counties: ['Bastrop County', 'Lee County'],
		cities: ['Bastrop', 'Giddings'],
	},
	{
		pattern: /\bSaratoga\s+Underground\s+Water(?:\s+Conservation)?\s+District\b/i,
		label: 'Saratoga UWCD',
		counties: ['Lampasas County'],
		cities: ['Lampasas'],
	},
	{
		pattern: /\bHill\s+Country\s+Underground\s+Water\s+Conservation\s+District\b/i,
		label: 'Hill Country UWCD',
		counties: ['Gillespie County'],
		cities: ['Fredericksburg'],
	},
	{
		pattern: /\bPrairielands\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Prairielands GCD',
		counties: ['Ellis County', 'Hill County', 'Johnson County', 'Somervell County'],
		cities: ['Waxahachie', 'Cleburne', 'Hillsboro', 'Glen Rose'],
	},
	{
		pattern: /\bNorth\s+Texas\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'North Texas GCD',
		counties: ['Collin County', 'Cooke County', 'Denton County'],
		cities: ['McKinney', 'Denton', 'Gainesville'],
	},
	{
		pattern: /\bRed\s+River\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Red River GCD',
		counties: ['Fannin County', 'Grayson County'],
		cities: ['Sherman', 'Denison', 'Bonham'],
	},
	{
		pattern: /\bUpper\s+Trinity\s+Groundwater(?:\s+Conservation)?\s+District\b/i,
		label: 'Upper Trinity GCD',
		counties: ['Hood County', 'Montague County', 'Parker County', 'Wise County'],
		cities: ['Granbury', 'Weatherford', 'Decatur', 'Bowie'],
	},
	{
		pattern: /\bNorthern\s+Trinity\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Northern Trinity GCD',
		counties: ['Tarrant County'],
		cities: ['Fort Worth', 'Arlington'],
	},
	{
		pattern: /\bSouthern\s+Trinity\s+Groundwater\s+Conservation\s+District\b|\bMcLennan\s+County\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Southern Trinity GCD',
		counties: ['McLennan County'],
		cities: ['Waco'],
	},
	{
		pattern: /\bBandera\s+County\s+River\s+Authority(?:\s+and\s+Groundwater(?:\s+Conservation)?\s+District)?\b/i,
		label: 'Bandera County River Authority & Groundwater District',
		counties: ['Bandera County'],
		cities: ['Bandera'],
	},
	{
		pattern: /\bHeadwaters\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Headwaters GCD',
		counties: ['Kerr County'],
		cities: ['Kerrville'],
	},
	{
		pattern: /\bPost\s+Oak\s+Savannah\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Post Oak Savannah GCD',
		counties: ['Burleson County', 'Milam County'],
		cities: ['Caldwell', 'Cameron'],
	},
	{
		pattern: /\bTrinity[\s-]+Glen\s+Rose\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Trinity Glen Rose GCD',
		counties: ['Bexar County'],
		cities: ['San Antonio'],
	},
	{
		pattern: /\bComal\s+Trinity\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Comal Trinity GCD',
		counties: ['Comal County'],
		cities: ['New Braunfels', 'Bulverde'],
	},
	{
		pattern: /\bUvalde(?:\s+County)?\s+Underground\s+Water\s+Conservation\s+District\b/i,
		label: 'Uvalde County UWCD',
		counties: ['Uvalde County'],
		cities: ['Uvalde'],
	},
	{
		pattern: /\bSouthwestern\s+Travis(?:\s+County)?\s+Groundwater\s+Conservation\s+District\b/i,
		label: 'Southwestern Travis County GCD',
		counties: ['Travis County'],
		cities: ['Austin', 'Bee Cave', 'Lakeway'],
	},
	{
		pattern: /\bBarton\s+Springs\s*\/\s*Edwards\s+Aquifer\s+Conservation\s+District\b|\bEdwards\s+Aquifer\s+(?:Conservation\s+District|Authority)\b/i,
		label: 'Barton Springs / Edwards Aquifer Conservation District',
		counties: ['Travis County', 'Hays County', 'Caldwell County', 'Bastrop County'],
		cities: ['Austin', 'Buda', 'Kyle', 'San Marcos'],
	},
	{
		pattern: /\bGuadalupe[\s-]+Blanco\s+River\s+Authority\b/i,
		label: 'Guadalupe-Blanco River Authority',
		counties: ['Kendall County', 'Comal County', 'Guadalupe County', 'Hays County', 'Gonzales County'],
		cities: ['New Braunfels', 'Seguin', 'San Marcos'],
	},
];

const GMA_REGION_LABELS: Record<string, string> = {
	'GMA 6': 'North-Central Texas / Rolling Plains (GMA 6)',
	'GMA 7': 'Edwards Plateau / Hill Country West (GMA 7)',
	'GMA 8': 'North & Central Texas Trinity Corridor (GMA 8)',
	'GMA 9': 'Texas Hill Country (GMA 9)',
	'GMA 10': 'Edwards / Austin–San Antonio Corridor (GMA 10)',
	'GMA 11': 'East Texas (GMA 11)',
	'GMA 12': 'Central Texas / Brazos Valley (GMA 12)',
};

const KNOWN_TX_COUNTIES = new Set([
	'Anderson', 'Bandera', 'Bastrop', 'Bell', 'Bexar', 'Blanco', 'Bosque', 'Bowie', 'Brazos', 'Brown',
	'Burleson', 'Burnet', 'Caldwell', 'Callahan', 'Cherokee', 'Collin', 'Comal', 'Comanche', 'Cooke',
	'Coryell', 'Dallas', 'Delta', 'Denton', 'DeWitt', 'Eastland', 'Ellis', 'Erath', 'Falls', 'Fannin',
	'Fayette', 'Gillespie', 'Gonzales', 'Grayson', 'Guadalupe', 'Hamilton', 'Hays', 'Henderson', 'Hill',
	'Hood', 'Hopkins', 'Hunt', 'Jack', 'Johnson', 'Kaufman', 'Kendall', 'Kerr', 'Kimble', 'Kinney',
	'Lamar', 'Lampasas', 'Lavaca', 'Lee', 'Leon', 'Limestone', 'Llano', 'Madison', 'Mason', 'McCulloch',
	'McLennan', 'Medina', 'Menard', 'Milam', 'Mills', 'Montague', 'Navarro', 'Palo Pinto', 'Parker',
	'Real', 'Red River', 'Robertson', 'Rockwall', 'San Saba', 'Somervell', 'Stephens', 'Tarrant',
	'Taylor', 'Travis', 'Uvalde', 'Val Verde', 'Van Zandt', 'Victoria', 'Washington', 'Williamson',
	'Wise', 'Wood', 'Young',
]);

const KNOWN_TX_CITIES = [
	'Austin', 'San Antonio', 'Dallas', 'Fort Worth', 'Waco', 'Killeen', 'Temple', 'Belton',
	'New Braunfels', 'San Marcos', 'Georgetown', 'Round Rock', 'Denton', 'McKinney', 'Sherman',
	'Denison', 'Boerne', 'Kerrville', 'Fredericksburg', 'Stephenville', 'Weatherford', 'Granbury',
	'Cleburne', 'Waxahachie', 'Hillsboro', 'Burnet', 'Marble Falls', 'Lampasas', 'Bastrop',
	'Bandera', 'Uvalde', 'Hondo', 'Castroville', 'Dripping Springs', 'Wimberley', 'Seguin',
	'Johnson City', 'Palestine', 'Athens', 'Jacksonville', 'Gainesville', 'Bonham', 'Decatur',
	'Gatesville', 'Meridian', 'Goldthwaite', 'Glen Rose', 'Caldwell', 'Cameron', 'Arlington',
];

const MONTHS: Record<string, string> = {
	january: '01',
	february: '02',
	march: '03',
	april: '04',
	may: '05',
	june: '06',
	july: '07',
	august: '08',
	september: '09',
	october: '10',
	november: '11',
	december: '12',
};

function parseHeaderDate(head: string, title: string, facetYears: number[]): {
	date: string | null;
	precision: 'day' | 'month' | 'year' | 'unknown';
} {
	const fullM = head.match(
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(19\d{2}|20[0-2]\d)\b/i,
	);
	if (fullM) {
		const mm = MONTHS[fullM[1].toLowerCase()];
		const dd = String(Number(fullM[2])).padStart(2, '0');
		const yyyy = fullM[3];
		if (mm && Number(yyyy) <= 2026) {
			return { date: `${yyyy}-${mm}-${dd}`, precision: 'day' };
		}
	}

	const myM = head.match(
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(19\d{2}|20[0-2]\d)\b/i,
	);
	if (myM) {
		const mm = MONTHS[myM[1].toLowerCase()];
		const yyyy = myM[2];
		if (mm && Number(yyyy) <= 2026) {
			return { date: `${yyyy}-${mm}`, precision: 'month' };
		}
	}

	// Fallback: GAM Run YY-NN or GAM Task YY-NN encodes the fiscal/calendar year.
	const gamYr = title.match(/\bGAM\s+(?:Run|Runs|Task)\s+(\d{1,2})-\d+/i);
	if (gamYr) {
		const yy = Number(gamYr[1]);
		if (yy >= 0 && yy <= 26) {
			return { date: String(2000 + yy), precision: 'year' };
		}
	}

	const realisticYears = facetYears.filter((y) => y >= 1980 && y <= 2026);
	if (realisticYears.length > 0) {
		return { date: String(Math.max(...realisticYears)), precision: 'year' };
	}

	return { date: null, precision: 'unknown' };
}

function extractPurposeSnippet(body: string): string | null {
	const cleaned = body.replace(/\r/g, '');
	const patterns = [
		/DESCRIPTION\s+OF\s+(?:REQUEST|TASK)\s*:?\s*\n+([\s\S]{30,520}?)(?:\n\s*\n|\n[A-Z][A-Z\s]{4,}:)/i,
		/(The\s+purpose\s+of\s+this\s+(?:model\s+run|report|study|task)[\s\S]{20,380}?\.)/i,
		/(This\s+report\s+(?:presents|provides|summarizes|documents|evaluates)[\s\S]{20,360}?\.)/i,
	];
	for (const re of patterns) {
		const m = cleaned.match(re);
		if (m && m[1]) {
			const s = m[1].replace(/\s+/g, ' ').trim();
			if (s.length >= 25) {
				return s.length > 260 ? `${s.slice(0, 257).replace(/\s+\S*$/, '')}…` : s;
			}
		}
	}
	return null;
}

export function parseTwdbDigest(opts: {
	rawTitle: string;
	digestMarkdown: string | null;
	facets?: Record<string, unknown>;
}): TwdbParsedDigest {
	const facets = opts.facets || {};
	const docType = String(facets.docType || 'report');
	const topics = Array.isArray(facets.topics) ? facets.topics.map(String) : [];
	const facetYears = Array.isArray(facets.years)
		? facets.years.map((y) => Number(y)).filter((n) => Number.isFinite(n))
		: [];

	let body = '';
	if (opts.digestMarkdown) {
		const idx = opts.digestMarkdown.indexOf('## Extracted text');
		body = (idx >= 0 ? opts.digestMarkdown.slice(idx + 17) : opts.digestMarkdown).trim();
	}
	const head = body.slice(0, 1500);
	const bodyScan = body.slice(0, 22000);

	// 1. Exact report date
	const parsedDate = parseHeaderDate(head, opts.rawTitle, facetYears);

	// 2. Author
	let author: string | null = null;
	const authorM = head.match(/\bby\s+([A-Z][A-Za-z.,\s'-]{3,75}?)(?:\n|Texas\s+Water)/i);
	if (authorM) {
		const a = authorM[1].replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
		if (a && a.length <= 70 && !/Texas\s+Water/i.test(a)) author = a;
	}

	// 3. Clean title (avoid ugly PDF header artifacts like "This page is intentionally blank")
	let baseTitle = String(opts.rawTitle || '').replace(/\s+/g, ' ').trim();
	if (/^this page is intentionally blank$/i.test(baseTitle) || /^for the best experience/i.test(baseTitle)) {
		const betterM = head.match(/\b(GAM\s+(?:RUN|TASK|RUNS)\s+[0-9A-Za-z-]+(?:\s*\([^)]+\))?\s*:\s*[^\n]{5,110})/i);
		if (betterM) baseTitle = betterM[1].replace(/\s+/g, ' ').trim();
	}

	// 4. GMAs
	const gmaNums = new Set<string>();
	if (Array.isArray(facets.gma)) {
		for (const g of facets.gma) {
			const m = String(g).match(/(\d{1,2})/);
			if (m) gmaNums.add(`GMA ${m[1]}`);
		}
	}
	for (const m of body.slice(0, 8000).matchAll(/(?:Groundwater\s+Management\s+Area|GMA)\s*#?\s*(\d{1,2})\b/gi)) {
		gmaNums.add(`GMA ${m[1]}`);
	}
	const gmas = [...gmaNums].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

	// 5. District & mapped counties/cities
	let matchedDistrict: DistrictGeo | null = null;
	for (const d of TEXAS_DISTRICTS) {
		if (d.pattern.test(body.slice(0, 6000))) {
			matchedDistrict = d;
			break;
		}
	}

	// 6. Explicit counties & cities in text
	// For single-district management-plan GAM runs (not GMA-wide runs), the district's
	// official counties & cities are the exact scope — avoid pulling in bibliography or
	// geologic formation names ("Fredericksburg Group", "Glen Rose Formation", "Austin Chalk").
	const isGmaWideRun =
		gmas.length > 0 &&
		/(?:on\s+behalf\s+of\s+Groundwater\s+Management\s+Area|aquifers?\s+in\s+Groundwater\s+Management\s+Area|desired\s+future\s+conditions.*Groundwater\s+Management\s+Area)/i.test(
			body.slice(0, 3500),
		);
	const countySet = new Set<string>(matchedDistrict ? matchedDistrict.counties : []);
	if (!matchedDistrict || isGmaWideRun) {
		for (const m of bodyScan.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Count(?:y|ies)\b/g)) {
			const name = m[1].trim();
			if (KNOWN_TX_COUNTIES.has(name)) {
				countySet.add(`${name} County`);
			}
		}
		// Also capture comma-separated county lists like "Bastrop, Bell, Burnet, Lee, Milam, Travis, and Williamson counties"
		const listMatch = body
			.slice(0, 4000)
			.match(/(?:of|in|for)\s+(?:portions\s+of\s+)?([A-Z][a-z]+(?:,\s+[A-Z][a-z]+){1,10}(?:,?\s+and\s+[A-Z][a-z]+)?)\s+[Cc]ounties\b/);
		if (listMatch) {
			for (const part of listMatch[1].split(/,|\band\b/i)) {
				const name = part.trim();
				if (KNOWN_TX_COUNTIES.has(name)) countySet.add(`${name} County`);
			}
		}
	}
	const counties = [...countySet];

	const GEOLOGIC_CITY_FALSE_POSITIVES = new Set(['Glen Rose', 'Fredericksburg', 'Austin', 'Taylor', 'Meridian']);
	const citySet = new Set<string>(matchedDistrict ? matchedDistrict.cities : []);
	if (!matchedDistrict || isGmaWideRun) {
		const cityScan = body.slice(0, 12000);
		for (const city of KNOWN_TX_CITIES) {
			if (GEOLOGIC_CITY_FALSE_POSITIVES.has(city)) {
				// Only accept these as cities when explicitly styled as "City of X" or "X, Texas"
				const explicitCityRe = new RegExp(`(?:City\\s+of\\s+${city}|\\b${city},\\s*(?:TX|Texas)\\b)`, 'i');
				if (explicitCityRe.test(cityScan)) citySet.add(city);
			} else {
				const re = new RegExp(`\\b${city.replace(/\s+/g, '\\s+')}\\b`);
				if (re.test(cityScan)) citySet.add(city);
			}
		}
	}
	const cities = [...citySet];

	// 7. Build informative geoLabel (Counties / Cities / GMA / Hill Country / Texas)
	let geoLabel = 'Texas';
	if (counties.length === 1) {
		const cityPart = cities.length > 0 ? ` (${cities.slice(0, 3).join(', ')})` : '';
		geoLabel = `${counties[0]}${cityPart}, TX`;
	} else if (counties.length >= 2 && counties.length <= 4) {
		const shortCounties = counties.map((c) => c.replace(/\s+County$/, ''));
		const cityPart = cities.length > 0 ? ` (${cities.slice(0, 3).join(', ')})` : '';
		geoLabel = `${shortCounties.join(', ')} Counties${cityPart}, TX`;
	} else if (counties.length > 4) {
		const shortCounties = counties.slice(0, 4).map((c) => c.replace(/\s+County$/, ''));
		const prefix = gmas.length === 1 ? `${gmas[0]} — ` : '';
		geoLabel = `${prefix}${shortCounties.join(', ')} & ${counties.length - 4} more TX counties`;
	} else if (gmas.length === 1 && GMA_REGION_LABELS[gmas[0]]) {
		geoLabel = GMA_REGION_LABELS[gmas[0]];
	} else if (/\bHill\s+Country\b/i.test(head)) {
		geoLabel = 'Texas Hill Country (Trinity Aquifer)';
	} else if (cities.length > 0) {
		geoLabel = `${cities.slice(0, 3).join(', ')}, TX`;
	}

	// 8. Build scannable title (append District or GMA if not already in title)
	let finalTitle = baseTitle;
	if (matchedDistrict && !baseTitle.toLowerCase().includes(matchedDistrict.label.toLowerCase().split(' ')[0])) {
		finalTitle = `${baseTitle} — ${matchedDistrict.label}`;
	} else if (!matchedDistrict && gmas.length > 0 && !/\bGMA\b|Management Area/i.test(baseTitle)) {
		finalTitle = `${baseTitle} — ${gmas.slice(0, 2).join(', ')}`;
	}

	// 9. Build rich summary
	const summaryParts: string[] = [];
	if (matchedDistrict) {
		const gmaNote = gmas.length > 0 ? ` (${gmas.join(', ')})` : '';
		summaryParts.push(`District: ${matchedDistrict.label}${gmaNote}`);
	} else if (gmas.length > 0) {
		summaryParts.push(`Area: ${gmas.join(', ')}`);
	}
	if (counties.length > 0) {
		const shownCounties =
			counties.length <= 6
				? counties.join(', ')
				: `${counties.slice(0, 6).join(', ')} (+${counties.length - 6} more)`;
		summaryParts.push(`Counties: ${shownCounties}`);
	}
	if (cities.length > 0) {
		summaryParts.push(`Cities: ${cities.slice(0, 5).join(', ')}`);
	}
	const purpose = extractPurposeSnippet(body);
	if (purpose) {
		summaryParts.push(purpose);
	} else if (topics.length > 0) {
		summaryParts.push(`TWDB ${docType} — topics: ${topics.join(', ')}`);
	}
	if (author) {
		summaryParts.push(`Author: ${author}`);
	}

	const summary =
		summaryParts.length > 0
			? summaryParts.join(' · ')
			: `TWDB ${docType} — topics: ${topics.join(', ')}`;

	return {
		eventDate: parsedDate.date,
		datePrecision: parsedDate.precision,
		title: finalTitle,
		geoLabel,
		geoKey: 'us:tx',
		summary,
		district: matchedDistrict?.label || null,
		gmas,
		counties,
		cities,
		author,
	};
}
