#!/usr/bin/env node
/**
 * Curated street HQ backfill for high-visibility education / nonprofit /
 * medical_hospital / government profiles.
 *
 * Usage: node scripts/backfill-org-hq-curated.mjs
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

const { getProfile, addLocation } = await import('../src/lib/research/profiles/store.ts');
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'org-hq-curated';

/** @type {Array<{slug:string, hq:string, note?:string}>} */
const ORG_HQ = [
	// Education
	{ slug: 'education:harvard-university', hq: 'Massachusetts Hall, Cambridge, MA 02138', note: 'Harvard University main campus' },
	{ slug: 'education:stanford-university', hq: '450 Serra Mall, Stanford, CA 94305', note: 'Stanford University' },
	{ slug: 'education:yale-university', hq: '105 Wall Street, New Haven, CT 06511', note: 'Yale University central campus' },
	{ slug: 'education:princeton-university', hq: '1 Nassau Hall, Princeton, NJ 08544', note: 'Princeton University' },
	{ slug: 'education:massachusetts-institute-of-technology', hq: '77 Massachusetts Avenue, Cambridge, MA 02139', note: 'MIT' },
	{ slug: 'education:columbia-university', hq: '116th Street and Broadway, New York, NY 10027', note: 'Columbia Morningside' },
	{ slug: 'education:university-of-chicago', hq: '5801 South Ellis Avenue, Chicago, IL 60637', note: 'UChicago' },
	{ slug: 'education:university-of-pennsylvania', hq: '3451 Walnut Street, Philadelphia, PA 19104', note: 'Penn' },
	{ slug: 'education:cornell-university', hq: '300 Day Hall, Ithaca, NY 14853', note: 'Cornell Ithaca' },
	{ slug: 'education:brown-university', hq: '1 Prospect Street, Providence, RI 02912', note: 'Brown University' },
	{ slug: 'education:dartmouth-college', hq: '6016 McNutt Hall, Hanover, NH 03755', note: 'Dartmouth' },
	{ slug: 'education:carnegie-mellon-university', hq: '5000 Forbes Avenue, Pittsburgh, PA 15213', note: 'CMU' },
	{ slug: 'education:california-institute-of-technology', hq: '1200 East California Boulevard, Pasadena, CA 91125', note: 'Caltech' },
	{ slug: 'education:university-of-california-berkeley', hq: '110 Sproul Hall, Berkeley, CA 94720', note: 'UC Berkeley' },
	{ slug: 'education:university-of-california-los-angeles', hq: '405 Hilgard Avenue, Los Angeles, CA 90095', note: 'UCLA' },
	{ slug: 'education:university-of-michigan-ann-arbor', hq: '500 South State Street, Ann Arbor, MI 48109', note: 'UMich' },
	{ slug: 'education:new-york-university', hq: '70 Washington Square South, New York, NY 10012', note: 'NYU' },
	{ slug: 'education:georgetown-university', hq: '37th and O Streets NW, Washington, DC 20057', note: 'Georgetown' },
	{ slug: 'education:duke-university', hq: '2080 Duke University Road, Durham, NC 27708', note: 'Duke' },
	{ slug: 'education:northwestern-university', hq: '633 Clark Street, Evanston, IL 60208', note: 'Northwestern' },
	{ slug: 'education:johns-hopkins-university', hq: '3400 North Charles Street, Baltimore, MD 21218', note: 'JHU Homewood' },
	{ slug: 'education:imperial-college-london', hq: 'South Kensington Campus, Exhibition Road, London SW7 2AZ, United Kingdom', note: 'Imperial College' },
	{ slug: 'education:eth-zurich', hq: 'Rämistrasse 101, 8092 Zurich, Switzerland', note: 'ETH Zurich' },
	{ slug: 'education:university-of-oxford', hq: 'University Offices, Wellington Square, Oxford OX1 2JD, United Kingdom', note: 'Oxford' },
	{ slug: 'education:university-of-cambridge', hq: 'The Old Schools, Trinity Lane, Cambridge CB2 1TN, United Kingdom', note: 'Cambridge' },
	{ slug: 'education:national-university-of-singapore', hq: '21 Lower Kent Ridge Road, Singapore 119077', note: 'NUS' },
	{ slug: 'education:tsinghua-university', hq: '30 Shuangqing Road, Haidian District, Beijing 100084, China', note: 'Tsinghua' },
	{ slug: 'education:peking-university', hq: '5 Yiheyuan Road, Haidian District, Beijing 100871, China', note: 'Peking University' },

	{ slug: 'education:university-of-tokyo', hq: '7-3-1 Hongo, Bunkyo-ku, Tokyo 113-8654, Japan', note: 'UTokyo Hongo' },
	{ slug: 'education:london-school-of-economics', hq: 'Houghton Street, London WC2A 2AE, United Kingdom', note: 'LSE' },
	{ slug: 'education:university-college-london', hq: 'Gower Street, London WC1E 6BT, United Kingdom', note: 'UCL' },

	// Nonprofit / foundations
	{ slug: 'nonprofit:bill-melinda-gates-foundation', hq: '500 5th Avenue North, Seattle, WA 98109', note: 'Gates Foundation HQ' },
	{ slug: 'nonprofit:ford-foundation', hq: '320 East 43rd Street, New York, NY 10017', note: 'Ford Foundation' },
	{ slug: 'nonprofit:rockefeller-foundation', hq: '420 Fifth Avenue, New York, NY 10018', note: 'Rockefeller Foundation' },
	{ slug: 'nonprofit:wellcome-trust', hq: '215 Euston Road, London NW1 2BE, United Kingdom', note: 'Wellcome Trust' },
	{ slug: 'nonprofit:open-society-foundations', hq: '224 West 57th Street, New York, NY 10019', note: 'OSF' },
	{ slug: 'nonprofit:macarthur-foundation', hq: '140 South Dearborn Street, Chicago, IL 60603', note: 'MacArthur Foundation' },
	{ slug: 'nonprofit:hewlett-foundation', hq: '2121 Sand Hill Road, Menlo Park, CA 94025', note: 'Hewlett Foundation' },
	{ slug: 'nonprofit:andrew-w-mellon-foundation', hq: '140 East 62nd Street, New York, NY 10065', note: 'Mellon Foundation' },
	{ slug: 'nonprofit:carnegie-corporation-of-new-york', hq: '437 Madison Avenue, New York, NY 10022', note: 'Carnegie Corporation' },
	{ slug: 'nonprofit:red-cross', hq: '431 18th Street NW, Washington, DC 20006', note: 'American Red Cross NHQ' },
	{ slug: 'nonprofit:american-red-cross', hq: '431 18th Street NW, Washington, DC 20006', note: 'American Red Cross NHQ' },
	{ slug: 'nonprofit:world-wildlife-fund', hq: '1250 24th Street NW, Washington, DC 20037', note: 'WWF-US' },
	{ slug: 'nonprofit:brookings-institution', hq: '1775 Massachusetts Avenue NW, Washington, DC 20036', note: 'Brookings' },
	{ slug: 'nonprofit:council-on-foreign-relations', hq: '58 East 68th Street, New York, NY 10065', note: 'CFR' },
	{ slug: 'nonprofit:department-of-terrestrial-magnetism', hq: '5241 Broad Branch Road NW, Washington, DC 20015', note: 'DTM / Carnegie Science (historical campus)' },

	// Hospitals
	{ slug: 'medical_hospital:johns-hopkins-hospital', hq: '1800 Orleans Street, Baltimore, MD 21287', note: 'Johns Hopkins Hospital' },
	{ slug: 'medical_hospital:memorial-sloan-kettering-cancer-center', hq: '1275 York Avenue, New York, NY 10065', note: 'MSKCC' },
	{ slug: 'nonprofit:mayo-clinic', hq: '200 First Street SW, Rochester, MN 55905', note: 'Mayo Clinic Rochester' },
	{ slug: 'medical_hospital:mayo-clinic', hq: '200 First Street SW, Rochester, MN 55905', note: 'Mayo Clinic Rochester' },
	{ slug: 'medical_hospital:cleveland-clinic', hq: '9500 Euclid Avenue, Cleveland, OH 44195', note: 'Cleveland Clinic' },
	{ slug: 'medical_hospital:massachusetts-general-hospital', hq: '55 Fruit Street, Boston, MA 02114', note: 'MGH' },
	{ slug: 'medical_hospital:brigham-and-womens-hospital', hq: '75 Francis Street, Boston, MA 02115', note: 'BWH' },
	{ slug: 'medical_hospital:childrens-hospital-boston', hq: '300 Longwood Avenue, Boston, MA 02115', note: 'Boston Children\'s' },
	{ slug: 'medical_hospital:dana-farber-brigham-cancer-center', hq: '450 Brookline Avenue, Boston, MA 02215', note: 'Dana-Farber' },
	{ slug: 'medical_hospital:the-university-of-texas-m-d-anderson-cancer-center', hq: '1515 Holcombe Boulevard, Houston, TX 77030', note: 'MD Anderson' },
	{ slug: 'medical_hospital:hospital-of-the-university-of-pennsylvania', hq: '3400 Spruce Street, Philadelphia, PA 19104', note: 'HUP' },
	{ slug: 'medical_hospital:newyork-presbyterian', hq: '525 East 68th Street, New York, NY 10065', note: 'NY-Presbyterian Weill Cornell' },
	{ slug: 'medical_hospital:texas-medical-center', hq: '2450 Holcombe Boulevard, Houston, TX 77021', note: 'TMC campus' },
	{ slug: 'medical_hospital:sheba-medical-center', hq: '2 Sheba Road, Tel Hashomer, Ramat Gan 52621, Israel', note: 'Sheba Medical Center' },
	{ slug: 'medical_hospital:cedars-sinai-medical-center', hq: '8700 Beverly Boulevard, Los Angeles, CA 90048', note: 'Cedars-Sinai' },
	{ slug: 'medical_hospital:ucla-medical-center', hq: '757 Westwood Plaza, Los Angeles, CA 90095', note: 'UCLA Medical Center' },
	{ slug: 'medical_hospital:stanford-hospital', hq: '300 Pasteur Drive, Stanford, CA 94305', note: 'Stanford Hospital' },

	// Government
	{ slug: 'government:the-white-house', hq: '1600 Pennsylvania Avenue NW, Washington, DC 20500', note: 'White House' },
	{ slug: 'government:united-states-department-of-state-dos', hq: '2201 C Street NW, Washington, DC 20520', note: 'Harry S Truman Building' },
	{ slug: 'government:united-states-department-of-justice-doj', hq: '950 Pennsylvania Avenue NW, Washington, DC 20530', note: 'RFK DOJ Building' },
	{ slug: 'government:united-states-department-of-the-treasury', hq: '1500 Pennsylvania Avenue NW, Washington, DC 20220', note: 'Treasury Building' },
	{ slug: 'government:united-states-department-of-defense', hq: '1400 Defense Pentagon, Washington, DC 20301', note: 'Pentagon' },
	{ slug: 'government:united-states-department-of-homeland-security', hq: '2707 Martin Luther King Jr Avenue SE, Washington, DC 20528', note: 'DHS St. Elizabeths campus' },
	{ slug: 'government:united-states-department-of-health-and-human-services', hq: '200 Independence Avenue SW, Washington, DC 20201', note: 'HHS Hubert H. Humphrey Building' },
	{ slug: 'government:united-states-department-of-commerce', hq: '1401 Constitution Avenue NW, Washington, DC 20230', note: 'Herbert C. Hoover Building' },
	{ slug: 'government:united-states-department-of-energy', hq: '1000 Independence Avenue SW, Washington, DC 20585', note: 'James Forrestal Building' },
	{ slug: 'government:united-states-department-of-agriculture-usda', hq: '1400 Independence Avenue SW, Washington, DC 20250', note: 'USDA Whitten Building' },
	{ slug: 'government:united-states-department-of-the-interior-doi', hq: '1849 C Street NW, Washington, DC 20240', note: 'Interior Building' },
	{ slug: 'government:united-states-department-of-labor', hq: '200 Constitution Avenue NW, Washington, DC 20210', note: 'Frances Perkins Building' },
	{ slug: 'government:united-states-department-of-education', hq: '400 Maryland Avenue SW, Washington, DC 20202', note: 'Lyndon Baines Johnson Building' },
	{ slug: 'government:united-states-department-of-transportation', hq: '1200 New Jersey Avenue SE, Washington, DC 20590', note: 'DOT HQ' },
	{ slug: 'government:united-states-department-of-veterans-affairs', hq: '810 Vermont Avenue NW, Washington, DC 20420', note: 'VA' },
	{ slug: 'government:u-s-immigration-and-customs-enforcement-ice', hq: '500 12th Street SW, Washington, DC 20536', note: 'ICE HQ' },
	{ slug: 'government:u-s-customs-and-border-protection-cbp', hq: '1300 Pennsylvania Avenue NW, Washington, DC 20229', note: 'CBP / Ronald Reagan Building' },
	{ slug: 'government:federal-bureau-of-investigation-fbi', hq: '935 Pennsylvania Avenue NW, Washington, DC 20535', note: 'J. Edgar Hoover Building' },
	{ slug: 'government:central-intelligence-agency-cia', hq: '1000 Colonial Farm Road, McLean, VA 22101', note: 'CIA HQ George Bush Center' },
	{ slug: 'government:national-security-agency', hq: '9800 Savage Road, Fort Meade, MD 20755', note: 'NSA' },
	{ slug: 'government:securities-and-exchange-commission-sec', hq: '100 F Street NE, Washington, DC 20549', note: 'SEC' },
	{ slug: 'government:federal-reserve-system', hq: '20th Street and Constitution Avenue NW, Washington, DC 20551', note: 'Federal Reserve Board Eccles Building' },
	{ slug: 'government:united-states-department-of-state', hq: '2201 C Street NW, Washington, DC 20520', note: 'Harry S Truman Building' },
	{ slug: 'government:united-states-department-of-justice', hq: '950 Pennsylvania Avenue NW, Washington, DC 20530', note: 'RFK DOJ Building' },
	{ slug: 'government:united-states-capitol', hq: 'First Street SE, Washington, DC 20004', note: 'U.S. Capitol' },
	{ slug: 'government:supreme-court-of-the-united-states', hq: '1 First Street NE, Washington, DC 20543', note: 'Supreme Court' },
];

function hasDigit(hq) {
	return /[0-9]/.test(String(hq || ''));
}

let ok = 0;
let missing = 0;
let skipped = 0;
const applied = [];
const failures = [];

for (const row of ORG_HQ) {
	if (!hasDigit(row.hq)) {
		failures.push({ slug: row.slug, reason: 'hq_missing_digit' });
		continue;
	}
	const p = getProfile(row.slug);
	if (!p) {
		missing += 1;
		failures.push({ slug: row.slug, reason: 'missing_profile' });
		continue;
	}
	const already = (p.locations || []).some((l) => /[0-9]/.test(String(l.raw || '')));
	if (already) {
		// Still ensure curated street is present via addLocation
	}
	const parts = parseAddressParts(row.hq);
	addLocation({
		profileId: p.id,
		raw: row.hq,
		city: parts.city,
		county: parts.county,
		state: parts.state,
		country: parts.country || 'US',
		role: 'hq',
		sourceCorpus: CORPUS,
	});
	ok += 1;
	applied.push({ slug: row.slug, hq: row.hq });
	console.log(`OK ${row.slug} => ${row.hq}${row.note ? ` (${row.note})` : ''}`);
}

console.log(JSON.stringify({ ok, missing, skipped, applied: applied.length, failures }, null, 2));
