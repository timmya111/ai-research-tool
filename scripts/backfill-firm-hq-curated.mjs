#!/usr/bin/env node
/**
 * Curated full street HQ backfill for high-signal firms (dallas-elite + well-known HQs).
 *
 * Usage: node scripts/backfill-firm-hq-curated.mjs
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
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { getProfile, addLocation, updateProfileFields } = await import(
	'../src/lib/research/profiles/store.ts'
);
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'firm-hq-curated';

/** @type {Array<{slug:string, hq:string, endDate?:string|null, note?:string}>} */
const FIRM_HQ = [
	// --- prior curated ---
	{
		slug: 'firm:arbusto-energy',
		hq: '214 W Texas Ave, Midland, TX 79701',
		endDate: '1984',
		note: 'Petroleum Building (Washington Post: Bush oil office)',
	},
	{
		slug: 'firm:beal-bank',
		hq: '6000 Legacy Drive, Plano, TX 75024',
		note: 'Beal Bank corporate HQ (bealbank.com)',
	},
	{
		slug: 'firm:campisis-egyptian-restaurant',
		hq: '5610 E Mockingbird Lane, Dallas, TX 75206',
		note: 'Campisi Egyptian / Mockingbird original',
	},
	{
		slug: 'firm:dallas-cowboys',
		hq: '1 Cowboys Way, Frisco, TX 75034',
		note: 'The Star — Dallas Cowboys World Headquarters',
	},
	{
		slug: 'firm:openai',
		hq: '1455 Third Street, San Francisco, CA 94158',
		note: 'OpenAI registered / Mission Bay HQ',
	},
	{
		slug: 'firm:enron',
		hq: '1400 Smith Street, Houston, TX 77002',
		endDate: '2001',
		note: 'Former Enron Complex HQ',
	},
	{
		slug: 'firm:neiman-marcus',
		hq: '1618 Main Street, Dallas, TX 75201',
		note: 'Neiman Marcus Building / One Marcus Square (historic HQ & flagship)',
	},
	{
		slug: 'firm:meta-platforms',
		hq: '1 Meta Way, Menlo Park, CA 94025',
		note: 'Meta Platforms HQ',
	},
	{
		slug: 'firm:microsoft-corporation',
		hq: 'One Microsoft Way, Redmond, WA 98052',
		note: 'Microsoft corporate HQ',
	},
	// --- dallas-elite / TX research pass ---
	{
		slug: 'firm:trammell-crow-company',
		hq: '2121 N Pearl Street, Suite 300, Dallas, TX 75201',
		note: 'Current Dallas HQ (CBRE affiliate; Sunbiz / ZoomInfo)',
	},
	{
		slug: 'firm:vinson-elkins',
		hq: '845 Texas Avenue, Suite 4700, Houston, TX 77002',
		note: 'Texas Tower Houston HQ (velaw.com)',
	},
	{
		slug: 'firm:dallas-market-center',
		hq: '2100 N Stemmons Freeway, Dallas, TX 75207',
		note: 'Dallas Market Center campus (dallasmarketcenter.com)',
	},
	{
		slug: 'firm:dresser-industries',
		hq: '2001 Ross Avenue, Dallas, TX 75201',
		endDate: '1998',
		note: 'Late-period SEC principal offices (LTV / Trammell Crow Center)',
	},
	{
		slug: 'firm:ebby-halliday-realtors',
		hq: '5560 Tennyson Parkway, Suite 100, Plano, TX 75024',
		note: 'Ebby Halliday Companies HQ (ebby.com)',
	},
	{
		slug: 'firm:electronic-data-systems',
		hq: '5400 Legacy Drive, Plano, TX 75024',
		endDate: '2008',
		note: 'Historic EDS Plano campus before HP acquisition',
	},
	{
		slug: 'firm:harken-energy',
		hq: '2505 N Highway 360, Suite 800, Grand Prairie, TX 75050',
		note: 'Historic TX filing address (Harken / Spectrum 7 era)',
	},
	{
		slug: 'firm:henry-s-miller-company',
		hq: '5151 Belt Line Road, Suite 900, Dallas, TX 75254',
		note: 'Henry S. Miller corporate HQ (henrysmiller.com)',
	},
	{
		slug: 'firm:texas-rangers-baseball',
		hq: '734 Stadium Drive, Arlington, TX 76011',
		note: 'Globe Life Field',
	},
	{
		slug: 'firm:zapata-offshore',
		hq: '711 Louisiana Street, Houston, TX 77002',
		note: 'Historic Zapata Tower / Pennzoil Place HQ',
	},
	{
		slug: 'firm:sterling-group',
		hq: 'Nine Greenway Plaza, Suite 2400, Houston, TX 77046',
		note: 'Sterling Group Houston HQ (sterling-group.com)',
	},
	{
		slug: 'firm:wa-harriman-co',
		hq: '39 Broadway, New York, NY 10006',
		endDate: '1931',
		note: 'Historic Harriman Building until BBH merger',
	},
	{
		slug: 'firm:murchison-brothers',
		hq: '1401 Elm Street, Dallas, TX 75202',
		note: 'First National Bank Tower offices (THC NRHP)',
	},
	{
		slug: 'firm:starck-club',
		hq: '703 McKinney Avenue, Dallas, TX 75202',
		endDate: '1989',
		note: 'Historic Dallas nightclub venue (West End)',
	},
	{
		slug: 'firm:apollo-projects',
		hq: '8595 Pelham Road, Suite 400 #309, Greenville, SC 29615',
		note: 'Registered / fund mailing (CA SOS / PitchBook)',
	},
	{
		slug: 'firm:hydrazine-capital',
		hq: '8595 Pelham Road, STE 400 #309, Greenville, SC 29615',
		note: 'Form ADV CRD 332160 reported office',
	},
	{
		slug: 'firm:lattice-hr',
		hq: '360 Spear Street, Floor 4, San Francisco, CA 94105',
		note: 'Degree Inc d/b/a Lattice (privacy policy)',
	},
	{
		slug: 'firm:saga-ventures',
		hq: '108 W Gibson Street, Austin, TX 78704',
		note: 'Austin HQ (firm / VC directory)',
	},
	{
		slug: 'firm:mid-county-dermatology',
		hq: '3009 N Ballas Road, Building B, Suite 100, St. Louis, MO 63131',
		note: 'Clinic / practice address',
	},
	// --- household / major TX & tech ---
	{
		slug: 'firm:halliburton',
		hq: '3000 North Sam Houston Parkway East, Houston, TX 77032',
		note: 'Halliburton principal executive offices (SEC 10-K)',
	},
	{
		slug: 'firm:texas-instruments',
		hq: '12500 TI Boulevard, Dallas, TX 75243',
		note: 'TI executive offices (ti.com)',
	},
	{
		slug: 'firm:palantir-technologies',
		hq: '19505 Biscayne Boulevard, Suite 2350, Aventura, FL 33180',
		note: 'Palantir HQ (curated / Thiel employment)',
	},
	{
		slug: 'firm:fluor-corporation',
		hq: '6700 Las Colinas Boulevard, Irving, TX 75039',
		note: 'Fluor corporate HQ Irving',
	},
	{
		slug: 'firm:at-t',
		hq: '208 S Akard Street, Dallas, TX 75202',
		note: 'AT&T Whitacre Tower HQ',
	},
	{
		slug: 'firm:at-t-inc',
		hq: '208 S Akard Street, Dallas, TX 75202',
		note: 'AT&T Whitacre Tower HQ',
	},
	{
		slug: 'firm:spacex',
		hq: '1 Rocket Road, Hawthorne, CA 90250',
		note: 'SpaceX Hawthorne HQ',
	},
	{
		slug: 'firm:tesla',
		hq: '1 Tesla Road, Austin, TX 78725',
		note: 'Tesla Gigafactory Texas / corporate HQ',
	},
	{
		slug: 'firm:xai',
		hq: '1450 Page Mill Road, Palo Alto, CA 94304',
		note: 'xAI registered office (approx; verify as filings change)',
	},
	{
		slug: 'firm:nvidia-corporation',
		hq: '2788 San Tomas Expressway, Santa Clara, CA 95051',
		note: 'NVIDIA corporate HQ',
	},
	{
		slug: 'firm:google',
		hq: '1600 Amphitheatre Parkway, Mountain View, CA 94043',
		note: 'Googleplex',
	},
	{
		slug: 'firm:amazon',
		hq: '410 Terry Avenue North, Seattle, WA 98109',
		note: 'Amazon corporate HQ',
	},
	{
		slug: 'firm:walmart',
		hq: '702 SW 8th Street, Bentonville, AR 72716',
		note: 'Walmart Home Office',
	},
	{
		slug: 'firm:pepsico',
		hq: '700 Anderson Hill Road, Purchase, NY 10577',
		note: 'PepsiCo world HQ',
	},
	{
		slug: 'firm:chevron-corporation',
		hq: '5001 Executive Parkway, Suite 200, San Ramon, CA 94583',
		note: 'Chevron corporate HQ',
	},
	{
		slug: 'firm:goldman-sachs',
		hq: '200 West Street, New York, NY 10282',
		note: 'Goldman Sachs HQ',
	},
	{
		slug: 'firm:jpmorgan-chase',
		hq: '383 Madison Avenue, New York, NY 10017',
		note: 'JPMorgan Chase HQ',
	},
	{
		slug: 'firm:morgan-stanley',
		hq: '1585 Broadway, New York, NY 10036',
		note: 'Morgan Stanley HQ',
	},
	{
		slug: 'firm:blackrock',
		hq: '50 Hudson Yards, New York, NY 10001',
		note: 'BlackRock HQ',
	},
	{
		slug: 'firm:the-blackstone-group',
		hq: '345 Park Avenue, New York, NY 10154',
		note: 'Blackstone HQ',
	},
	{
		slug: 'firm:mckinsey-company',
		hq: '3 World Trade Center, 175 Greenwich Street, New York, NY 10007',
		note: 'McKinsey global HQ',
	},
	{
		slug: 'firm:deloitte',
		hq: '30 Rockefeller Plaza, New York, NY 10112',
		note: 'Deloitte US HQ',
	},
	{
		slug: 'firm:ibm-corporation',
		hq: '1 New Orchard Road, Armonk, NY 10504',
		note: 'IBM corporate HQ',
	},
	{
		slug: 'firm:lockheed-martin-corporation',
		hq: '6801 Rockledge Drive, Bethesda, MD 20817',
		note: 'Lockheed Martin HQ',
	},
	{
		slug: 'firm:boeing-capital-corporation',
		hq: '929 Long Bridge Drive, Arlington, VA 22202',
		note: 'Boeing corporate HQ (Arlington)',
	},
	{
		slug: 'firm:state-street-corporation',
		hq: '1 Congress Street, Boston, MA 02114',
		note: 'State Street HQ',
	},
	{
		slug: 'firm:frost-bank',
		hq: '111 W Houston Street, San Antonio, TX 78205',
		note: 'Frost Bank HQ',
	},
	{
		slug: 'firm:charles-schwab-co-inc',
		hq: '3000 Schwab Way, Westlake, TX 76262',
		note: 'Charles Schwab HQ (Westlake TX)',
	},
	// --- wiki-titled + defense / markets ---
	{
		slug: 'firm:fidelity-investments',
		hq: '245 Summer Street, Boston, MA 02210',
		note: 'Fidelity corporate HQ',
	},
	{
		slug: 'firm:emerson-electric',
		hq: '8027 Forsyth Boulevard, St. Louis, MO 63105',
		note: 'Emerson Tower Clayton HQ (emerson.com)',
	},
	{
		slug: 'firm:rtx-corporation',
		hq: '1000 Wilson Boulevard, Arlington, VA 22209',
		note: 'RTX corporate HQ (rtx.com)',
	},
	{
		slug: 'firm:raytheon',
		hq: '1100 Wilson Boulevard, Arlington, VA 22209',
		note: 'Raytheon business unit HQ (rtx.com)',
	},
	{
		slug: 'firm:collins-aerospace',
		hq: '2730 West Tyvola Road, Charlotte, NC 28217',
		note: 'Collins Aerospace HQ Four Coliseum Centre',
	},
	{
		slug: 'firm:general-dynamics',
		hq: '11011 Sunset Hills Road, Reston, VA 20190',
		note: 'GD corporate HQ (SEC)',
	},
	{
		slug: 'firm:kbr-inc',
		hq: '601 Jefferson Street, Suite 3400, Houston, TX 77002',
		note: 'KBR corporate HQ',
	},
	{
		slug: 'firm:l3harris',
		hq: '1025 West NASA Boulevard, Melbourne, FL 32919',
		note: 'L3Harris principal executive offices',
	},
	{
		slug: 'firm:new-york-stock-exchange',
		hq: '11 Wall Street, New York, NY 10005',
		note: 'NYSE historic HQ / trading floor',
	},
	{
		slug: 'firm:lockheed-martin-aeronautics',
		hq: '1 Lockheed Boulevard, Fort Worth, TX 76108',
		note: 'LM Aeronautics Fort Worth',
	},
	{
		slug: 'firm:ling-temco-vought',
		hq: '2001 Ross Avenue, Dallas, TX 75201',
		note: 'Historic LTV / Trammell Crow Center era Dallas HQ',
	},
	{
		slug: 'firm:convair',
		hq: '3302 Pacific Highway, San Diego, CA 92101',
		note: 'Historic Convair San Diego plant / HQ area',
	},
	{
		slug: 'firm:j-p-morgan-co',
		hq: '23 Wall Street, New York, NY 10005',
		endDate: '2000',
		note: 'Historic House of Morgan / 23 Wall',
	},
	{
		slug: 'firm:google-inc',
		hq: '1600 Amphitheatre Parkway, Mountain View, CA 94043',
		note: 'Googleplex',
	},
	// --- banks / intl ---
	{
		slug: 'firm:bank-of-america-n-a',
		hq: '100 North Tryon Street, Charlotte, NC 28255',
		note: 'Bank of America Corporate Center',
	},
	{
		slug: 'firm:hsbc-holdings-plc',
		hq: '8 Canada Square, London, E14 5HQ, United Kingdom',
		note: 'HSBC Group Head Office',
	},
	{
		slug: 'firm:hsbc',
		hq: '8 Canada Square, London, E14 5HQ, United Kingdom',
		note: 'HSBC Group Head Office',
	},
	{
		slug: 'firm:deutsche-bank-ag',
		hq: 'Taunusanlage 12, 60325 Frankfurt am Main, Germany',
		note: 'Deutsche Bank principal office',
	},
	{
		slug: 'firm:deutsche-bank',
		hq: 'Taunusanlage 12, 60325 Frankfurt am Main, Germany',
		note: 'Deutsche Bank principal office',
	},
	{
		slug: 'firm:ubs-group-ag',
		hq: 'Bahnhofstrasse 45, 8001 Zurich, Switzerland',
		note: 'UBS Group AG registered office',
	},
	{
		slug: 'firm:ubs-ag',
		hq: 'Bahnhofstrasse 45, 8001 Zurich, Switzerland',
		note: 'UBS AG registered office',
	},
	{
		slug: 'firm:barclays-bank-plc',
		hq: '1 Churchill Place, London, E14 5HP, United Kingdom',
		note: 'Barclays Canary Wharf HQ',
	},
	{
		slug: 'firm:standard-chartered',
		hq: '1 Basinghall Avenue, London, EC2V 5DD, United Kingdom',
		note: 'Standard Chartered global HQ',
	},
	{
		slug: 'firm:credit-suisse-ag',
		hq: 'Paradeplatz 8, 8001 Zurich, Switzerland',
		note: 'Historic Credit Suisse Paradeplatz (now UBS)',
	},
	{
		slug: 'firm:wachovia-corporation',
		hq: '301 South College Street, Charlotte, NC 28202',
		note: 'Historic One Wachovia Center',
	},
	{
		slug: 'firm:wells-fargo-company',
		hq: '333 Market Street, San Francisco, CA 94105',
		note: 'Wells Fargo corporate offices',
	},
	{
		slug: 'firm:wells-fargo-bank-n-a',
		hq: '333 Market Street, San Francisco, CA 94105',
		note: 'Wells Fargo Bank N.A. corporate offices',
	},
	{
		slug: 'firm:x-corp',
		hq: '865 FM 1209, Building 2, Bastrop, TX 78602',
		note: 'X Corp principal office (TX filings)',
	},
	{
		slug: 'firm:bell-textron',
		hq: '3255 Bell Flight Boulevard, Fort Worth, TX 76118',
		note: 'Bell Flight Fort Worth HQ (bellflight.com)',
	},
	{
		slug: 'firm:harken-energy',
		hq: '180 State Street, Suite 200, Southlake, TX 76092',
		note: 'Harken / HKN SEC business address',
	},
	{
		slug: 'firm:rockwell-collins',
		hq: '3200 East Renner Road, Richardson, TX 75082',
		note: 'Collins Mission Systems / Rockwell Collins Richardson',
	},
	{
		slug: 'firm:raytheon-intelligence-information-and-services',
		hq: '1717 East CityLine Drive, Richardson, TX 75082',
		note: 'Raytheon IIS CityLine Richardson campus',
	},
	{
		slug: 'firm:take-two-interactive',
		hq: '110 West 44th Street, New York, NY 10036',
		note: 'Take-Two Interactive SEC business address',
	},
	{
		slug: 'firm:bny',
		hq: '240 Greenwich Street, New York, NY 10286',
		note: 'BNY Mellon HQ',
	},
	// --- historic / high-link BDs (BrokerCheck Main Office or well-documented HQ) ---
	{
		slug: 'firm:a-g-edwards-sons-inc',
		hq: '1 North Jefferson Avenue, St. Louis, MO 63103',
		endDate: '2008',
		note: 'A.G. Edwards HQ / BrokerCheck Main Office (acquired by Wachovia)',
	},
	{
		slug: 'firm:lehman-brothers-inc',
		hq: '745 Seventh Avenue, New York, NY 10019',
		endDate: '2008',
		note: 'Lehman Brothers Building HQ at collapse; BrokerCheck also lists One Battery Park Plaza',
	},
	{
		slug: 'firm:e-f-hutton-company-inc',
		hq: '1 Battery Park Plaza, New York, NY 10004',
		endDate: '1988',
		note: 'Historic E.F. Hutton & Company principal office (pre-Shearson merger)',
	},
	{
		slug: 'firm:kidder-peabody-co-incorporated',
		hq: '10 Hanover Square, New York, NY 10005',
		endDate: '1994',
		note: 'Kidder Peabody historic HQ (Mergr / firm histories)',
	},
	{
		slug: 'firm:morgan-stanley-dw-inc',
		hq: '2000 Westchester Avenue, Purchase, NY 10577',
		endDate: '2007',
		note: 'Morgan Stanley DW Inc principal office (state filings / BrokerCheck era)',
	},
	{
		slug: 'firm:prudential-equity-group-llc',
		hq: '1 New York Plaza, New York, NY 10292',
		note: 'Prudential Equity Group BrokerCheck Main Office',
	},
	{
		slug: 'firm:banc-of-america-securities-llc',
		hq: 'One Bryant Park, New York, NY 10036',
		note: 'Banc of America Securities BrokerCheck Main Office',
	},
	{
		slug: 'firm:wells-fargo-investments-llc',
		hq: '420 Montgomery Street, 12th Floor, San Francisco, CA 94104',
		note: 'Wells Fargo Investments BrokerCheck Main Office',
	},
	{
		slug: 'firm:securities-america-inc',
		hq: '12325 Port Grace Blvd, Papillion, NE 68046',
		note: 'Securities America BrokerCheck Main Office',
	},
	{
		slug: 'firm:optionsxpress-inc',
		hq: '150 South Wacker Drive, 12th Floor, Chicago, IL 60606',
		note: 'optionsXpress BrokerCheck Main Office',
	},
	{
		slug: 'firm:first-jersey-securities-inc',
		hq: '264 Route 537 East, Colts Neck, NJ 07722',
		note: 'First Jersey Securities BrokerCheck Main Office',
	},
	{
		slug: 'firm:scott-stringfellow-llc',
		hq: '901 E Byrd Street, Richmond, VA 23219',
		note: 'Scott & Stringfellow BrokerCheck Main Office',
	},
	{
		slug: 'firm:chase-investment-services-corp',
		hq: '1111 Polaris Parkway, Columbus, OH 43240',
		note: 'Chase Investment Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:avantax-investment-services-inc',
		hq: '3200 Olympus Blvd, Dallas, TX 75019',
		note: 'Avantax Investment Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:new-england-securities',
		hq: '1095 Avenue of the Americas, New York, NY 10036',
		note: 'New England Securities BrokerCheck Main Office',
	},
	{
		slug: 'firm:labranche-financial-services-llc',
		hq: '33 Whitehall Street, New York, NY 10004',
		note: 'LaBranche Financial Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:crowell-weedon-co',
		hq: '624 South Grand Avenue, Suite 2510, Los Angeles, CA 90017',
		note: 'Crowell, Weedon & Co BrokerCheck Main Office',
	},
	{
		slug: 'firm:emmett-a-larkin-company-inc',
		hq: '22 Battery Street, Suite 808, San Francisco, CA 94111',
		note: 'Emmett A. Larkin Company BrokerCheck Main Office',
	},
	{
		slug: 'firm:citicorp-investment-services',
		hq: 'One Court Square, 24th Floor, Long Island City, NY 11120',
		note: 'Citicorp Investment Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:banc-of-america-investment-services',
		hq: '101 S Tryon Street, 19th Floor, Charlotte, NC 28255',
		note: 'Banc of America Investment Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:the-lincoln-national-life-insurance',
		hq: '1300 South Clinton Street, Fort Wayne, IN 46801',
		note: 'Lincoln National Life BrokerCheck Main Office',
	},
	{
		slug: 'firm:titan-value-equities-group-inc',
		hq: '8001 Irvine Center Drive, Irvine, CA 92618',
		note: 'Titan Value Equities BrokerCheck Main Office',
	},
	{
		slug: 'firm:wrp-investments-inc',
		hq: '4407 Belmont Avenue, Youngstown, OH 44505',
		note: 'WRP Investments BrokerCheck Main Office',
	},
	{
		slug: 'firm:dominick-dickerman-llc',
		hq: '1700 East Putnam Avenue, Old Greenwich, CT 06870',
		note: 'Dominick & Dickerman BrokerCheck Main Office',
	},
	{
		slug: 'firm:ameriprise-advisor-services-inc',
		hq: '719 Griswold Street, Detroit, MI 48226',
		note: 'Ameriprise Advisor Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:foresters-financial-services-inc',
		hq: '110 Fieldcrest Avenue, Edison, NJ 08837',
		note: 'Foresters Financial Services BrokerCheck Main Office',
	},
	{
		slug: 'firm:metropolitan-life-insurance-company',
		hq: '27-01 Queens Plaza North, Long Island City, NY 11101',
		note: 'MetLife BrokerCheck Main Office',
	},
	// --- pasted incomplete-list street HQ pass (2026-11-23) ---
	{
		slug: 'firm:j-p-morgan-chase-co',
		hq: '270 Park Avenue, New York, NY 10017',
		note: 'JPMorganChase Tower global HQ (opened 2025; SEC business address)',
	},
	{
		slug: 'firm:jpmorgan-chase',
		hq: '270 Park Avenue, New York, NY 10017',
		note: 'JPMorganChase Tower global HQ (opened 2025; SEC business address)',
	},
	{
		slug: 'firm:helion-energy',
		hq: '1415 75th Street SW, Everett, WA 98203',
		note: 'Helion Everett HQ (PitchBook / company listings)',
	},
	{
		slug: 'firm:y-combinator',
		hq: '560 20th Street, San Francisco, CA 94107',
		note: 'YC Pier 70 / Dogpatch campus (Google Maps / Fortune 2024 move)',
	},
	{
		slug: 'firm:rothschild-and-co',
		hq: '23 Avenue de Messine, 75008 Paris, France',
		note: 'Rothschild & Co Paris siège (Companies register / Lexology)',
	},
	{
		slug: 'firm:related-midwest',
		hq: '350 W Hubbard Street, Suite 300, Chicago, IL 60654',
		note: 'Related Midwest Chicago HQ (LinkedIn / ZoomInfo)',
	},
	{
		slug: 'firm:oxford-ionics',
		hq: 'Unit 6a, Oxford Technology Park, Technology Drive, Oxford OX5 1GN, United Kingdom',
		note: 'Oxford Ionics global HQ (Companies House / oxionics.com)',
	},
	{
		slug: 'firm:praelium',
		hq: '18565 Jamboree Road, Suite 200, Irvine, CA 92612',
		note: 'Praelium Commercial Real Estate Irvine HQ',
	},
	{
		slug: 'firm:qpiai',
		hq: 'Hub 1 SEZ Tower, Karle Town Centre, Karle Infra SEZ, Nagavara, Bengaluru 560045, India',
		note: 'QpiAI Bengaluru HQ (PitchBook / company filings)',
	},
	{
		slug: 'firm:silicon-catalyst',
		hq: '2710 Walsh Avenue, Santa Clara, CA 95051',
		note: 'Silicon Catalyst Santa Clara HQ (ZoomInfo / Craft)',
	},
	{
		slug: 'firm:epb-chattanooga',
		hq: '10 West M.L. King Boulevard, Chattanooga, TN 37402',
		note: 'EPB main office / HQ (epb.com / LEED)',
	},
	{
		slug: 'firm:google-quantum-ai',
		hq: '301 Mentor Drive, Goleta, CA 93117',
		note: 'Google Quantum AI Goleta lab campus (Noozhawk / Independent)',
	},
	{
		slug: 'firm:life-science-reit',
		hq: '20 Triton Street, London NW1 3BF, United Kingdom',
		note: 'Life Science REIT / British Land group registered HQ',
	},
	{
		slug: 'firm:ironstone-asset-management',
		hq: '33 Cavendish Square, London W1G 0PW, United Kingdom',
		note: 'Ironstone Asset Management trading HQ (LinkedIn; adviser to Life Science REIT)',
	},
	{
		slug: 'firm:memq',
		hq: '5207 South Harper Avenue, Suite 500, Chicago, IL 60615',
		note: 'memQ Chicago HQ (PitchBook / ZoomInfo)',
	},
	{
		slug: 'firm:advocate-health',
		hq: '3075 Highland Parkway, Suite 600, Downers Grove, IL 60515',
		note: 'Advocate Health Care regional HQ (advocatehealth.com); system also lists Charlotte',
	},
	{
		slug: 'firm:bluefors',
		hq: 'Arinatie 10, 00370 Helsinki, Finland',
		note: 'Bluefors Oy global HQ (bluefors.com / Finnish register)',
	},
	{
		slug: 'firm:1qbit',
		hq: '1285 West Pender Street, Suite 200, Vancouver, BC V6E 4B1, Canada',
		note: '1QBit Vancouver HQ (LinkedIn / PitchBook)',
	},
	{
		slug: 'firm:1qb-information-technologies-1qbit',
		hq: '1285 West Pender Street, Suite 200, Vancouver, BC V6E 4B1, Canada',
		note: '1QBit Vancouver HQ (LinkedIn / PitchBook)',
	},
	{
		slug: 'firm:bluequbit',
		hq: '415 Mission Street, Floor 37, San Francisco, CA 94105',
		note: 'BlueQubit SF principal address (CA SOS / company site)',
	},
	{
		slug: 'firm:crypto-quantique',
		hq: 'The Print Rooms, Unit 304-5, 164-180 Union Street, London SE1 0LH, United Kingdom',
		note: 'Crypto Quantique London HQ (Companies House / PitchBook)',
	},
	{
		slug: 'firm:spectrum-7',
		hq: '2505 N Highway 360, Suite 800, Grand Prairie, TX 75050',
		endDate: '1986',
		note: 'Late Spectrum 7 / Harken-era Grand Prairie office (OH SOS cross-ref; merged into Harken)',
	},
];

let ok = 0;
let missing = 0;
for (const u of FIRM_HQ) {
	const p = getProfile(u.slug);
	if (!p) {
		console.log('MISSING_PROFILE', u.slug);
		missing += 1;
		continue;
	}
	const parts = parseAddressParts(u.hq);
	addLocation({
		profileId: p.id,
		raw: u.hq,
		city: parts.city,
		county: parts.county,
		state: parts.state,
		country: parts.country || 'US',
		role: 'hq',
		sourceCorpus: CORPUS,
	});
	const patch = {};
	if (u.endDate && !p.endDate) patch.endDate = u.endDate;
	if (Object.keys(patch).length) updateProfileFields(p.id, patch);
	console.log('OK', u.slug, '=>', u.hq, u.note ? `(${u.note})` : '');
	ok += 1;
}

console.log(JSON.stringify({ ok, missing, total: FIRM_HQ.length }, null, 2));
