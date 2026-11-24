#!/usr/bin/env node
/**
 * Curated firm founded / dissolved dates for well-known cards.
 * Only fills missing startDate / endDate — never overwrites.
 *
 * Usage: node scripts/backfill-firm-dates-curated.mjs [--dry-run]
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { updateProfileFields, getProfile } = await import('../src/lib/research/profiles/store.ts');

const CORPUS = 'firm-dates-curated';
const dryRun = process.argv.includes('--dry-run');

/** @type {Array<{slug:string, startDate?:string|null, endDate?:string|null, note?:string}>} */
const FIRM_DATES = [
	// Big tech / AI
	{ slug: 'firm:openai', startDate: '2015-12-08', note: 'Founded Dec 8, 2015' },
	{ slug: 'firm:anthropic', startDate: '2021', note: 'Founded 2021' },
	{ slug: 'firm:palantir', startDate: '2003', note: 'Founded 2003' },
	{ slug: 'firm:palantir-technologies', startDate: '2003' },
	{ slug: 'firm:founders-fund', startDate: '2005' },
	{ slug: 'firm:clarium-capital', startDate: '2002' },
	{ slug: 'firm:paypal', startDate: '1998', note: 'Confinity/PayPal lineage 1998' },
	{ slug: 'firm:meta', startDate: '2004-02-04', note: 'Facebook founded 2004' },
	{ slug: 'firm:facebook', startDate: '2004-02-04' },
	{ slug: 'firm:google', startDate: '1998-09-04' },
	{ slug: 'firm:alphabet', startDate: '2015-10-02' },
	{ slug: 'firm:apple', startDate: '1976-04-01' },
	{ slug: 'firm:microsoft', startDate: '1975-04-04' },
	{ slug: 'firm:amazon', startDate: '1994-07-05' },
	{ slug: 'firm:nvidia', startDate: '1993-04-05' },
	{ slug: 'firm:tesla', startDate: '2003-07-01' },
	{ slug: 'firm:spacex', startDate: '2002-03-14' },
	{ slug: 'firm:xai', startDate: '2023-03-09' },
	{ slug: 'firm:twitter', startDate: '2006-03-21', endDate: '2023-07-23', note: 'Rebranded X 2023' },
	{ slug: 'firm:x', startDate: '2023-07-23', note: 'Twitter rebrand' },

	// Asset managers / banks
	{ slug: 'firm:blackrock', startDate: '1988' },
	{ slug: 'firm:vanguard', startDate: '1975' },
	{ slug: 'firm:state-street-corporation', startDate: '1792', note: 'Union Bank lineage / modern State Street' },
	{ slug: 'firm:jpmorgan-chase', startDate: '2000', note: 'JPMorgan Chase merger 2000; roots earlier' },
	{ slug: 'firm:jp-morgan-chase', startDate: '2000' },
	{ slug: 'firm:goldman-sachs', startDate: '1869' },
	{ slug: 'firm:morgan-stanley', startDate: '1935', note: 'Founded 1935 (overwrite only if missing)' },
	{ slug: 'firm:citigroup', startDate: '1998', note: 'Citi/Travelers merger; Citibank roots 1812' },
	{ slug: 'firm:bank-of-america', startDate: '1998', note: 'NationsBank/BankAmerica; roots earlier' },
	{ slug: 'firm:wells-fargo', startDate: '1852' },
	{ slug: 'firm:fidelity-investments', startDate: '1946' },
	{ slug: 'firm:fidelity-personal-and-workplace-advisors', startDate: '1946', note: 'Fidelity group lineage' },
	{ slug: 'firm:charles-schwab', startDate: '1971' },
	{ slug: 'firm:schwab-wealth-advisory-inc', startDate: '1971', note: 'Schwab group' },
	{ slug: 'firm:t-rowe-price', startDate: '1937' },
	{ slug: 'firm:pimco', startDate: '1971' },
	{ slug: 'firm:bridgewater-associates', startDate: '1975' },
	{ slug: 'firm:renaissance-technologies', startDate: '1982' },
	{ slug: 'firm:citadel', startDate: '1990' },
	{ slug: 'firm:two-sigma', startDate: '2001' },
	{ slug: 'firm:jane-street', startDate: '2000' },
	{ slug: 'firm:brown-brothers-harriman-co', startDate: '1818', note: 'BBH; W.A. Harriman merged 1931' },
	{ slug: 'firm:rothschild-co', startDate: '1812', note: 'Rothschild banking lineage' },
	{ slug: 'firm:lazard', startDate: '1848' },
	{ slug: 'firm:evercore', startDate: '1995' },
	{ slug: 'firm:moelis-company', startDate: '2007' },

	// Defunct / historic
	{ slug: 'firm:enron', startDate: '1985-07-16', endDate: '2001', note: 'Bankruptcy 2001; Creditors Recovery later' },
	{ slug: 'firm:lehman-brothers', startDate: '1850', endDate: '2008-09-15' },
	{ slug: 'firm:lehman-brothers-inc', startDate: '1850', endDate: '2008-09-15' },
	{ slug: 'firm:bear-stearns', startDate: '1923', endDate: '2008' },
	{ slug: 'firm:merrill-lynch', startDate: '1914', note: 'Acquired by BofA 2008; brand continues' },
	{ slug: 'firm:kidder-peabody', startDate: '1865', endDate: '1994' },
	{ slug: 'firm:ef-hutton', startDate: '1904', endDate: '1988' },
	{ slug: 'firm:drexel-burnham-lambert', startDate: '1935', endDate: '1990' },
	{ slug: 'firm:salomon-brothers', startDate: '1910', endDate: '1998', note: 'Merged into Travelers/Smith Barney' },
	{ slug: 'firm:ag-edwards', startDate: '1887', endDate: '2007' },
	{ slug: 'firm:a-g-edwards', startDate: '1887', endDate: '2007' },
	{ slug: 'firm:wa-harriman-co', startDate: '1919', endDate: '1931', note: 'Merged into BBH' },
	{ slug: 'firm:w-a-harriman-co', startDate: '1919', endDate: '1931' },
	{ slug: 'firm:arbusto-energy', startDate: '1977', endDate: '1984' },
	{ slug: 'firm:spectrum-7', startDate: '1979', endDate: '1986' },

	// Energy / industrials / Dallas
	{ slug: 'firm:halliburton', startDate: '1919' },
	{ slug: 'firm:exxonmobil', startDate: '1999', note: 'Exxon–Mobil merger; Standard Oil roots' },
	{ slug: 'firm:exxon-mobil-corporation', startDate: '1999-11-30', note: 'Exxon–Mobil merger' },
	{ slug: 'firm:chevron', startDate: '1879', note: 'Pacific Coast Oil / Standard Oil of California lineage' },
	{ slug: 'firm:conocophillips', startDate: '2002' },
	{ slug: 'firm:phillips-66', startDate: '2012-04-30' },
	{ slug: 'firm:enterprise-products-partners-lp', startDate: '1968' },
	{ slug: 'firm:occidental-petroleum-corporation', startDate: '1920' },
	{ slug: 'firm:baker-hughes-company', startDate: '1907' },
	{ slug: 'firm:slb', startDate: '1926', note: 'Schlumberger founded 1926; rebranded SLB' },
	{ slug: 'firm:schlumberger', startDate: '1926' },
	{ slug: 'firm:weatherford-international-inc', startDate: '1941' },
	{ slug: 'firm:nov-inc', startDate: '1841', note: 'NOV / National Oilwell Varco lineage' },
	{ slug: 'firm:national-oilwell-varco', startDate: '1841' },
	{ slug: 'firm:patterson-uti-energy-inc', startDate: '1978' },
	{ slug: 'firm:nabors-industries-ltd', startDate: '1952' },
	{ slug: 'firm:liberty-energy-inc', startDate: '2011' },
	{ slug: 'firm:propetro-holding-corp', startDate: '2005' },
	{ slug: 'firm:profrac-holding-corp', startDate: '2016' },
	{ slug: 'firm:nine-energy-service-inc', startDate: '2011' },
	{ slug: 'firm:select-water-solutions-inc', startDate: '2008' },
	{ slug: 'firm:superior-energy-services-inc', startDate: '1989' },
	{ slug: 'firm:oil-states-international-inc', startDate: '1995' },
	{ slug: 'firm:forum-energy-technologies-inc', startDate: '2005' },
	{ slug: 'firm:technipfmc-plc', startDate: '2017', note: 'Technip–FMC merger' },
	{ slug: 'firm:championx-corporation', startDate: '2018' },
	{ slug: 'firm:oceaneering-international-inc', startDate: '1964' },
	{ slug: 'firm:dril-quip-inc', startDate: '1981' },
	{ slug: 'firm:kinder-morgan-inc', startDate: '1997' },
	{ slug: 'firm:cheniere-energy-inc', startDate: '1996' },
	{ slug: 'firm:eog-resources-inc', startDate: '1999' },
	{ slug: 'firm:energy-transfer', startDate: '1996' },
	{ slug: 'firm:hf-sinclair', startDate: '1947' },
	{ slug: 'firm:oneok-inc', startDate: '1906' },
	{ slug: 'firm:williams-companies-inc', startDate: '1908' },
	{ slug: 'firm:helmerich-payne-inc', startDate: '1920' },
	{ slug: 'firm:continental-resources-inc', startDate: '1967' },
	{ slug: 'firm:schlumberger', startDate: '1926' },
	{ slug: 'firm:baker-hughes', startDate: '1987', note: 'Baker+Hughes merger; roots earlier' },
	{ slug: 'firm:hunt-oil-company', startDate: '1934' },
	{ slug: 'firm:crow-holdings', startDate: '1948' },
	{ slug: 'firm:trammell-crow-company', startDate: '1948' },
	{ slug: 'firm:perot-systems', startDate: '1988', endDate: '2009', note: 'Acquired by Dell 2009' },
	{ slug: 'firm:eds', startDate: '1962', endDate: '2008', note: 'Acquired by HP' },
	{ slug: 'firm:neiman-marcus', startDate: '1907' },
	{ slug: 'firm:texas-instruments', startDate: '1951' },
	{ slug: 'firm:dell-technologies-inc', startDate: '1984-02-01' },
	{ slug: 'firm:securonix-inc', startDate: '2008' },
	{ slug: 'firm:zimperium-inc', startDate: '2010' },
	{ slug: 'firm:critical-start-inc', startDate: '2008' },
	{ slug: 'firm:trellix', startDate: '2022', note: 'McAfee Enterprise + FireEye rebrand' },
	{ slug: 'firm:allied-universal', startDate: '1957' },
	{ slug: 'firm:securitas-ab', startDate: '1934' },
	{ slug: 'firm:anduril-industries-inc', startDate: '2017' },
	{ slug: 'firm:axiom-space-inc', startDate: '2016' },
	{ slug: 'firm:intuitive-machines-inc', startDate: '2013' },
	{ slug: 'firm:bell-nunnally-martin-llp', startDate: '1980' },
	{ slug: 'firm:cain-skarnulis-pllc', startDate: '2005' },
	{ slug: 'firm:blenden-roth-law-firm', startDate: '1990' },
	{ slug: 'firm:pope-hardwicke-christie-schell-kelly-taplett', startDate: '1980' },
	{ slug: 'firm:northrop-grumman', startDate: '1994' },
	{ slug: 'firm:bae-systems', startDate: '1999' },
	{ slug: 'firm:pratt-whitney', startDate: '1925' },
	{ slug: 'firm:raytheon', startDate: '1922' },
	{ slug: 'firm:elbit-systems-of-america', startDate: '2000' },
	{ slug: 'firm:coinbase-global-inc', startDate: '2012-06-20' },
	{ slug: 'firm:robinhood-markets-inc', startDate: '2013' },
	{ slug: 'firm:wealthfront', startDate: '2008' },
	{ slug: 'firm:jefferies-financial-group-inc', startDate: '1979' },
	{ slug: 'firm:houlihan-lokey-inc', startDate: '1972' },
	{ slug: 'firm:crowdstrike-holdings-inc', startDate: '2011' },
	{ slug: 'firm:fortinet-inc', startDate: '2000' },
	{ slug: 'firm:zscaler-inc', startDate: '2007' },
	{ slug: 'firm:okta-inc', startDate: '2009' },
	{ slug: 'firm:palo-alto-networks', startDate: '2005' },
	{ slug: 'firm:boeing', startDate: '1916-07-15' },
	{ slug: 'firm:general-dynamics', startDate: '1952', note: 'GD name 1952; Electric Boat roots earlier' },
	{ slug: 'firm:airbus-se', startDate: '1970', note: 'Airbus consortium lineage' },
	{ slug: 'firm:leonardo-spa', startDate: '1948', note: 'Finmeccanica / Leonardo lineage' },
	{ slug: 'firm:thales-sa', startDate: '2000', note: 'Thales branding; Thomson-CSF roots earlier' },
	{ slug: 'firm:rheinmetall-ag', startDate: '1889' },
	{ slug: 'firm:dassault-aviation-sa', startDate: '1929' },
	{ slug: 'firm:elbit-systems-ltd', startDate: '1966' },
	{ slug: 'firm:mbda', startDate: '2001' },
	{ slug: 'firm:naval-group', startDate: '1631', note: 'French naval construction lineage' },
	{ slug: 'firm:avic', startDate: '2008' },
	{ slug: 'firm:norinco-group', startDate: '1980' },
	{ slug: 'firm:saipem-spa', startDate: '1957' },
	{ slug: 'firm:china-oilfield-services-limited', startDate: '2001' },
	{ slug: 'firm:check-point-software-technologies-ltd', startDate: '1993' },
	{ slug: 'firm:darktrace-plc', startDate: '2013' },
	{ slug: 'firm:helsing-gmbh', startDate: '2021' },
	{ slug: 'firm:iceye-oy', startDate: '2014' },
	{ slug: 'firm:quantum-systems-gmbh', startDate: '2015' },
	{ slug: 'firm:stark-defence', startDate: '2024' },
	{ slug: 'firm:saab-ab', startDate: '1937' },
	{ slug: 'firm:bae-systems', startDate: '1999' },
	{ slug: 'firm:nordam-group-inc', startDate: '1969' },
	{ slug: 'firm:american-airlines-maintenance-engineering-tulsa', startDate: '1946' },
	{ slug: 'firm:spirit-aerosystems-tulsa', startDate: '2005' },
	{ slug: 'firm:quantum-space', startDate: '2021' },
	{ slug: 'firm:agile-space-industries', startDate: '2019' },
	{ slug: 'firm:flightsafety-international-tulsa', startDate: '1951' },
	{ slug: 'firm:kratos-defense-security-solutions-inc', startDate: '1994' },
	{ slug: 'firm:tulsa-innovation-labs', startDate: '2019' },
	{ slug: 'firm:meta-platforms-inc', startDate: '2004' },
	{ slug: 'firm:meta-tulsa-project-anthem', startDate: '2024' },

	// Global / WEF-ish
	{ slug: 'firm:alibaba', startDate: '1999' },

	{ slug: 'firm:tencent', startDate: '1998' },
	{ slug: 'firm:samsung', startDate: '1938' },
	{ slug: 'firm:toyota', startDate: '1937' },
	{ slug: 'firm:sony', startDate: '1946' },
	{ slug: 'firm:siemens', startDate: '1847' },
	{ slug: 'firm:nestle', startDate: '1866' },
	{ slug: 'firm:unilever', startDate: '1929' },
	{ slug: 'firm:shell', startDate: '1907' },
	{ slug: 'firm:bp', startDate: '1909' },
	{ slug: 'firm:totalenergies', startDate: '1924' },
	{ slug: 'firm:softbank', startDate: '1981' },
	{ slug: 'firm:softbank-group', startDate: '1981' },
	{ slug: 'firm:reliance', startDate: '1966' },
	{ slug: 'firm:reliance-industries', startDate: '1966' },
	{ slug: 'firm:tata-group', startDate: '1868' },
	{ slug: 'firm:tata-sons', startDate: '1917' },
	{ slug: 'firm:adani-group', startDate: '1988' },
	{ slug: 'firm:bloomberg', startDate: '1981' },
	{ slug: 'firm:bloomberg-lp', startDate: '1981' },
	{ slug: 'firm:thomson-reuters', startDate: '2008', note: 'Thomson–Reuters merger' },
	{ slug: 'firm:kpmg', startDate: '1987', note: 'KPMG name 1987; predecessor firms earlier' },
	{ slug: 'firm:deloitte', startDate: '1845' },
	{ slug: 'firm:pwc', startDate: '1998', note: 'PwC merger; roots earlier' },
	{ slug: 'firm:ey', startDate: '1989', note: 'Ernst & Young merger branding' },
	{ slug: 'firm:mckinsey', startDate: '1926' },
	{ slug: 'firm:bain-company', startDate: '1973' },
	{ slug: 'firm:boston-consulting-group', startDate: '1963' },
	{ slug: 'firm:y-combinator', startDate: '2005' },
	{ slug: 'firm:sequoia-capital', startDate: '1972' },
	{ slug: 'firm:andreessen-horowitz', startDate: '2009' },
	{ slug: 'firm:a16z', startDate: '2009' },

	// Broker / advisory high-link (group lineage when BD-specific founding unknown)
	{ slug: 'firm:morgan-stanley-dw-inc', startDate: '1924', endDate: '2009', note: 'Dean Witter lineage; MS DW brand sunset' },
	{ slug: 'firm:ids-life-insurance-company', startDate: '1894', note: 'IDS / Ameriprise lineage' },
	{ slug: 'firm:prudential-equity-group-llc', startDate: '1875', endDate: '2003', note: 'Prudential Securities lineage' },
	{ slug: 'firm:first-jersey-securities-inc', startDate: '1970', endDate: '1987', note: 'Approx.; collapsed late 1980s' },
	{ slug: 'firm:empower-advisory-group-llc', startDate: '1989', note: 'Great-West/Empower lineage' },
	{ slug: 'firm:truist-advisory-services-inc', startDate: '2019', note: 'Truist formed BB&T+SunTrust 2019' },
	{ slug: 'firm:captrust', startDate: '1997' },
];

let ok = 0;
let missing = 0;
let skipped = 0;

for (const u of FIRM_DATES) {
	const p = getProfile(u.slug);
	if (!p) {
		console.log('MISSING_PROFILE', u.slug);
		missing += 1;
		continue;
	}
	const patch = {};
	if (u.startDate && !String(p.startDate || '').trim()) patch.startDate = u.startDate;
	if (u.endDate && !String(p.endDate || '').trim()) patch.endDate = u.endDate;
	if (Object.keys(patch).length === 0) {
		skipped += 1;
		continue;
	}
	if (dryRun) {
		console.log('DRY', u.slug, patch, u.note || '');
		ok += 1;
		continue;
	}
	updateProfileFields(p.id, {
		...patch,
		metadata: { firmDatesSource: CORPUS, firmDatesNote: u.note || null },
	});
	console.log('OK', u.slug, patch, u.note || '');
	ok += 1;
}

console.log(JSON.stringify({ ok, missing, skipped, total: FIRM_DATES.length, dryRun, corpus: CORPUS }, null, 2));
