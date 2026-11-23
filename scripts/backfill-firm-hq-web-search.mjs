#!/usr/bin/env node
/**
 * Web-researched full street HQ backfill for high-link firms lacking digit streets / finra_crd.
 * Also creates Crow Holdings + Hunt Oil Company if missing.
 *
 * Usage: node scripts/backfill-firm-hq-web-search.mjs
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

const { getProfile, addLocation, upsertProfile, addAlias } = await import(
	'../src/lib/research/profiles/store.ts'
);
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'firm-hq-web-search';

function hasStreetDigit(hq) {
	return /[0-9]/.test(String(hq || ''));
}

/** @type {Array<{slug:string, hq:string, note?:string, country?:string}>} */
const FIRM_HQ = [
	{
		slug: 'firm:bloomberg-l-p',
		hq: '731 Lexington Avenue, New York, NY 10022',
		note: 'Bloomberg Tower / LEI headquarters address',
	},
	{
		slug: 'firm:adecco-group',
		hq: 'Bellerivestrasse 30, 8008 Zurich, Switzerland',
		note: 'Adecco Group AG HQ (PitchBook / Craft)',
		country: 'CH',
	},
	{
		slug: 'firm:egon-zehnder-international-ltd',
		hq: 'Wiesenstrasse 17, 8008 Zurich, Switzerland',
		note: 'Egon Zehnder International AG (OpenCorporates / Swiss UID)',
		country: 'CH',
	},
	{
		slug: 'firm:kasikornbank-public-company-limited',
		hq: '1 Soi Rat Burana 27/1, Rat Burana Road, Rat Burana Sub-District, Rat Burana District, Bangkok 10140, Thailand',
		note: 'Kasikornbank head office (kasikornbank.com 2026 notice)',
		country: 'TH',
	},
	{
		slug: 'firm:xanadu-quantum',
		hq: '777 Bay Street, Suite 2400, Toronto, ON M5G 2C8, Canada',
		note: 'Xanadu principal office (SEC 6-K / LEI)',
		country: 'CA',
	},
	{
		slug: 'firm:tata-group',
		hq: 'Bombay House, 24 Homi Mody Street, Mumbai, Maharashtra 400001, India',
		note: 'Tata Group HQ Bombay House',
		country: 'IN',
	},
	{
		slug: 'firm:reliance-industries',
		hq: '3rd Floor, Maker Chambers IV, 222 Nariman Point, Mumbai, Maharashtra 400021, India',
		note: 'RIL registered/HQ (LEI / ril.com)',
		country: 'IN',
	},
	{
		slug: 'firm:sparx-asset-management-co-ltd',
		hq: 'Shinagawa Season Terrace 6F, 1-2-70 Konan, Minato-ku, Tokyo 108-0075, Japan',
		note: 'SPARX Asset Management official company outline',
		country: 'JP',
	},
	{
		slug: 'firm:abdul-latif-jameel-international-group',
		hq: 'Amir Majed Street, Al Safa District, Jeddah 21471, Saudi Arabia',
		note: 'ALJ domestic HQ (alj.com contact archive)',
		country: 'SA',
	},
	{
		slug: 'firm:thomson-reuters',
		hq: '19 Duncan Street, Toronto, ON M5H 3H1, Canada',
		note: 'Thomson Reuters corporate HQ (thomsonreuters.com / LEI)',
		country: 'CA',
	},
	{
		slug: 'firm:royal-philips',
		hq: 'Amstelplein 2, 1096 BC Amsterdam, Netherlands',
		note: 'Koninklijke Philips N.V. principal executive offices (SEC 6-K)',
		country: 'NL',
	},
	{
		slug: 'firm:the-boston-consulting-group',
		hq: '200 Pier 4 Boulevard, Boston, MA 02210',
		note: 'BCG Inc registered / HQ (OpenCorporates / LEI)',
	},
	{
		slug: 'firm:pwc',
		hq: '300 Madison Avenue, New York, NY 10017',
		note: 'PwC US / PricewaterhouseCoopers LLP HQ (LEI / pwc.com)',
	},
	{
		slug: 'firm:johnson-controls',
		hq: '1 Albert Quay, Cork, T12 X8N6, Ireland',
		note: 'Johnson Controls International plc HQ (LEI / filings)',
		country: 'IE',
	},
	{
		slug: 'firm:heidrick-struggles',
		hq: '233 South Wacker Drive, Suite 4900, Chicago, IL 60606',
		note: 'Heidrick & Struggles Chicago HQ (heidrick.com)',
	},
	{
		slug: 'firm:zurich-insurance-group',
		hq: 'Mythenquai 2, 8002 Zurich, Switzerland',
		note: 'Zurich Insurance Group AG HQ (LEI / zurich.ch)',
		country: 'CH',
	},
	{
		slug: 'firm:ey',
		hq: '1 More London Place, London, SE1 2AF, United Kingdom',
		note: 'EY / Ernst & Young Global coordinating office (ey.com)',
		country: 'GB',
	},
	{
		slug: 'firm:bain-company-inc',
		hq: '131 Dartmouth Street, Boston, MA 02116',
		note: 'Bain & Company Inc HQ (bain.com Boston / LEI)',
	},
	{
		slug: 'firm:bt-group-plc',
		hq: '1 Braham Street, London, E1 8EE, United Kingdom',
		note: 'BT Group plc registered office (bt.com)',
		country: 'GB',
	},
	{
		slug: 'firm:ups',
		hq: '55 Glenlake Parkway NE, Atlanta, GA 30328',
		note: 'UPS world headquarters (SEC / ups.com)',
	},
	{
		slug: 'firm:related-companies',
		hq: '30 Hudson Yards, New York, NY 10001',
		note: 'Related Companies HQ (related.com / LEI)',
	},
	{
		slug: 'firm:the-dow-chemical-company',
		hq: '2211 H.H. Dow Way, Midland, MI 48674',
		note: 'Dow corporate headquarters (corporate.dow.com / LEI)',
	},
	{
		slug: 'firm:kpmg',
		hq: 'Laan van Langerhuize 1, 1186 DS Amstelveen, Netherlands',
		note: 'KPMG International coordinating HQ (kpmg.com NL)',
		country: 'NL',
	},
	{
		slug: 'firm:infosys-ltd',
		hq: 'Plot No. 44/97A, 3rd Cross, Electronics City, Hosur Road, Bengaluru, Karnataka 560100, India',
		note: 'Infosys Limited campus HQ (SEC / company directories)',
		country: 'IN',
	},
	{
		slug: 'firm:jll',
		hq: '200 East Randolph Drive, Chicago, IL 60601',
		note: 'Jones Lang LaSalle Inc HQ (SEC 8-K)',
	},
	{
		slug: 'firm:baker-mckenzie',
		hq: '300 East Randolph Street, Suite 5000, Chicago, IL 60601',
		note: 'Baker McKenzie founding / HQ office (bakermckenzie.com)',
	},
	{
		slug: 'firm:swiss-reinsurance-company',
		hq: 'Mythenquai 50/60, 8002 Zurich, Switzerland',
		note: 'Swiss Re global HQ (swissre.com / LEI)',
		country: 'CH',
	},
	{
		slug: 'firm:a-t-kearney',
		hq: '227 West Monroe Street, Chicago, IL 60606',
		note: 'Kearney / A.T. Kearney Chicago HQ (kearney.com / FL SOS)',
	},
	{
		slug: 'firm:the-new-england-journal-of-medicine',
		hq: '860 Winter Street, Waltham, MA 02451',
		note: 'NEJM / NEJM Group publishing HQ (nejm.org contact)',
	},
	// Twin / alternate slug that still only had country
	{
		slug: 'firm:the-adecco-group',
		hq: 'Bellerivestrasse 30, 8008 Zurich, Switzerland',
		note: 'Adecco Group AG HQ (same campus as firm:adecco-group)',
		country: 'CH',
	},
	{
		slug: 'firm:allianz-se',
		hq: 'Königinstrasse 28, 80802 Munich, Germany',
		note: 'Allianz SE Head Office (allianz.com / LEI)',
		country: 'DE',
	},
	{
		slug: 'firm:novozymes-a-s',
		hq: 'Krogshøjvej 36, 2880 Bagsværd, Denmark',
		note: 'Novozymes A/S CVR registered address',
		country: 'DK',
	},
	{
		slug: 'firm:frost-sullivan',
		hq: '7550 IH 10 West, Suite 400, San Antonio, TX 78229',
		note: 'Frost & Sullivan Inc HQ (SAM / frost.com)',
	},
	{
		slug: 'firm:apco-worldwide',
		hq: '1299 Pennsylvania Avenue NW, Suite 300, Washington, DC 20004',
		note: 'APCO Worldwide global HQ (apcoworldwide.com / SAM)',
	},
	{
		slug: 'firm:pnc-bank-national-association',
		hq: 'The Tower at PNC Plaza, 300 Fifth Avenue, Pittsburgh, PA 15222',
		note: 'PNC principal executive offices (investor.pnc.com / LEI parent)',
	},
	{
		slug: 'firm:ptt-global-chemical-public-company-limited',
		hq: '555/1 Energy Complex, Building A, 18th Floor, Vibhavadi Rangsit Road, Chatuchak, Bangkok 10900, Thailand',
		note: 'PTTGC head office (pttgcgroup.com contact)',
		country: 'TH',
	},
	{
		slug: 'firm:itau-bba',
		hq: 'Avenida Brigadeiro Faria Lima 3500, São Paulo, SP 04538-132, Brazil',
		note: 'Itaú BBA Faria Lima HQ (LinkedIn / PitchBook)',
		country: 'BR',
	},
	{
		slug: 'firm:aurec-capital-group-ltd',
		hq: '3 Hayetzira Street, Ramat Gan 5252141, Israel',
		note: 'Aurec Capital Ltd registered HQ (Israeli companies registry / LEI)',
		country: 'IL',
	},
	{
		slug: 'firm:peach-aviation-limited',
		hq: '1 Senshu-kuko-kita, Izumisano, Osaka 549-0001, Japan',
		note: 'Peach Aviation registered HQ at Kansai Airport (gBiz / Wikidata)',
		country: 'JP',
	},
	{
		slug: 'firm:tubacex',
		hq: 'Tres Cruces 8, 01400 Llodio, Álava, Spain',
		note: 'Tubacex SA corporate HQ Llodio (company filings / LEI)',
		country: 'ES',
	},
	{
		slug: 'firm:swiss-reinsurance-company-ltd',
		hq: 'Mythenquai 50/60, 8002 Zurich, Switzerland',
		note: 'Swiss Re global HQ (swissre.com / LEI)',
		country: 'CH',
	},
	{
		slug: 'firm:zurich-insurance-company-ltd',
		hq: 'Mythenquai 2, 8002 Zurich, Switzerland',
		note: 'Zurich Insurance Group AG HQ (zurich.com / LEI)',
		country: 'CH',
	},
	{
		slug: 'firm:thomson-reuters-group',
		hq: '19 Duncan Street, Toronto, ON M5H 3H1, Canada',
		note: 'Thomson Reuters corporate HQ (thomsonreuters.com)',
		country: 'CA',
	},
];

/** Profiles to create if missing, then HQ-locate */
const CREATE = [
	{
		slug: 'firm:crow-holdings',
		name: 'Crow Holdings',
		hq: '3819 Maple Avenue, Dallas, TX 75219',
		summary:
			'Dallas-based private real estate investment firm associated with the Crow family; parent of Crow Holdings Securities.',
		aliases: ['Crow Holdings Capital', 'Crow Family Holdings'],
		note: 'Crow Holdings HQ (user-curated / Crow Holdings Securities shared campus)',
	},
	{
		slug: 'firm:hunt-oil-company',
		name: 'Hunt Oil Company',
		hq: '1900 North Akard Street, Dallas, TX 75201',
		summary:
			'Dallas independent oil and gas company founded by H.L. Hunt; part of the Hunt family energy enterprises.',
		aliases: ['Hunt Oil', 'Hunt Oil Co.', 'Hunt Consolidated'],
		note: 'Hunt Oil Company Dallas HQ (user-curated)',
	},
];

let ok = 0;
let missing = 0;
let skipped = 0;
let created = 0;
const applied = [];
const failures = [];

for (const row of CREATE) {
	if (!hasStreetDigit(row.hq)) {
		failures.push({ slug: row.slug, reason: 'hq_missing_digit' });
		continue;
	}
	let p = getProfile(row.slug);
	if (!p) {
		p = upsertProfile({
			profileType: 'firm',
			name: row.name,
			slug: row.slug,
			status: 'active',
			summary: row.summary,
			metadata: {
				corpora: [CORPUS],
				hqSource: CORPUS,
			},
			sourceCorpus: CORPUS,
		});
		for (const al of row.aliases || []) {
			addAlias({ profileId: p.id, alias: al, aliasKind: 'name', sourceCorpus: CORPUS });
		}
		created += 1;
		console.log('CREATED', row.slug);
	} else {
		console.log('EXISTS', row.slug);
	}
	const already = (p.locations || []).some((l) => /[0-9]/.test(String(l.raw || '')));
	// getProfile may not include locations; re-check via addLocation idempotency by raw
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
	console.log('OK', row.slug, '=>', row.hq, row.note ? `(${row.note})` : '');
	applied.push({ slug: row.slug, hq: row.hq });
	ok += 1;
}

for (const u of FIRM_HQ) {
	if (!hasStreetDigit(u.hq)) {
		failures.push({ slug: u.slug, reason: 'hq_missing_digit' });
		skipped += 1;
		continue;
	}
	const p = getProfile(u.slug);
	if (!p) {
		console.log('MISSING_PROFILE', u.slug);
		missing += 1;
		failures.push({ slug: u.slug, reason: 'missing_profile' });
		continue;
	}
	const parts = parseAddressParts(u.hq);
	addLocation({
		profileId: p.id,
		raw: u.hq,
		city: parts.city,
		county: parts.county,
		state: parts.state,
		country: u.country || parts.country || 'US',
		role: 'hq',
		sourceCorpus: CORPUS,
	});
	console.log('OK', u.slug, '=>', u.hq, u.note ? `(${u.note})` : '');
	applied.push({ slug: u.slug, hq: u.hq });
	ok += 1;
}

console.log(
	JSON.stringify(
		{
			ok,
			created,
			missing,
			skipped,
			totalTargets: FIRM_HQ.length + CREATE.length,
			applied,
			failures,
		},
		null,
		2,
	),
);
