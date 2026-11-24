#!/usr/bin/env node
/**
 * Texas / Oklahoma oilfield services peers similar to Halliburton
 * (drilling, completions, production, cementing, equipment, land drilling contractors).
 *
 * Usage: node scripts/import-tx-ok-oilfield-services.mjs [--dry-run]
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

const { upsertProfileTool } = await import('../src/lib/research/profileAlignmentTools.ts');
const dryRun = process.argv.includes('--dry-run');
const CORPUS = 'tx-ok-oilfield-services-2026-11-23';
const HALLIBURTON = 'firm:halliburton';

const ofsMeta = {
	txOkStatewide: true,
	txOkOilfieldServices: true,
	industry: 'oil_gas',
	sector: 'oilfield_services',
	region: 'Texas and Oklahoma oilfield services / energy services (Halliburton peer set)',
};

function peerHal(label) {
	return {
		peerName: 'Halliburton Company',
		peerSlug: HALLIBURTON,
		relationType: 'business_tie',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

function loc(raw, role, city, state, county) {
	return {
		raw,
		role,
		city,
		state,
		country: 'US',
		...(county ? { county } : {}),
	};
}

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	// --- Global OFS majors (Houston hub) ---
	{
		profileType: 'firm',
		name: 'SLB',
		slug: 'firm:slb',
		status: 'pinned',
		endDate: '',
		startDate: '1926',
		summary:
			'Global oilfield services major (formerly Schlumberger). Drilling, wireline, completions, production, and digital solutions. Significant Houston presence and Texas/Oklahoma field operations; Halliburton peer in full-spectrum OFS.',
		aliases: ['Schlumberger', 'Schlumberger Limited', 'SLB Limited', 'Schlumberger N.V.'],
		locations: [
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
			loc('Sugar Land, TX', 'associated', 'Sugar Land', 'TX', 'Fort Bend'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.slb.com/' },
			{ scheme: 'ticker', value: 'SLB' },
		],
		links: [peerHal('Oilfield services peer (global OFS; Houston / TX-OK field ops)')],
		metadata: { ...ofsMeta, state: 'TX', cik: '0000087347', formerName: 'Schlumberger' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'NOV Inc.',
		slug: 'firm:nov-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1841',
		summary:
			'Houston-area drilling equipment, rig systems, and oilfield products/services company (National Oilwell Varco lineage). Major Texas OFS equipment peer to Halliburton’s services footprint.',
		aliases: ['NOV', 'National Oilwell Varco', 'National Oilwell Varco, Inc.', 'NOV Inc'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.nov.com/' },
			{ scheme: 'ticker', value: 'NOV' },
		],
		links: [peerHal('Oilfield equipment / services peer (Houston; NOV)')],
		metadata: { ...ofsMeta, sector: 'oilfield_equipment', state: 'TX', cik: '0001021860' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'TechnipFMC plc',
		slug: 'firm:technipfmc-plc',
		status: 'pinned',
		endDate: '',
		startDate: '2017',
		summary:
			'Subsea and surface energy technology / services company with major Houston operations. Completions and production systems peer set adjacent to Halliburton OFS.',
		aliases: ['TechnipFMC', 'TechnipFMC Limited'],
		locations: [loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.technipfmc.com/' },
			{ scheme: 'ticker', value: 'FTI' },
		],
		links: [peerHal('Energy technology / subsea-surface services peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'subsea_surface_equipment', state: 'TX', cik: '0001681168' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ChampionX Corporation',
		slug: 'firm:championx-corporation',
		status: 'pinned',
		endDate: '',
		startDate: '2018',
		summary:
			'Production chemicals, artificial lift, and drilling technologies company with Texas operations (Apergy / Ecolab lineage spin). Production-services peer adjacent to Halliburton.',
		aliases: ['ChampionX', 'Apergy'],
		locations: [
			loc('The Woodlands, TX', 'hq', 'The Woodlands', 'TX', 'Montgomery'),
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.championx.com/' },
			{ scheme: 'ticker', value: 'CHX' },
		],
		links: [peerHal('Production chemicals / artificial lift peer (TX)')],
		metadata: { ...ofsMeta, sector: 'production_chemicals_lift', state: 'TX', cik: '0001723089' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Oceaneering International, Inc.',
		slug: 'firm:oceaneering-international-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1964',
		summary:
			'Houston engineered services and products company (ROVs, subsea, inspection). Energy services peer with Texas HQ adjacent to oilfield services majors.',
		aliases: ['Oceaneering', 'Oceaneering International'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.oceaneering.com/' },
			{ scheme: 'ticker', value: 'OII' },
		],
		links: [peerHal('Subsea / engineered energy services peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'subsea_rov_inspection', state: 'TX', cik: '0000073756' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Dril-Quip, Inc.',
		slug: 'firm:dril-quip-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1981',
		summary:
			'Houston manufacturer of offshore drilling and production equipment (wellhead, subsea). Texas oilfield equipment peer.',
		aliases: ['Dril-Quip', 'Dril Quip'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.dril-quip.com/' },
			{ scheme: 'ticker', value: 'DRQ' },
		],
		links: [peerHal('Offshore drilling/production equipment peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'oilfield_equipment', state: 'TX', cik: '0001042893' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Oil States International, Inc.',
		slug: 'firm:oil-states-international-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1995',
		summary:
			'Houston oilfield products and services company (wellsite services, offshore/downhole products). Texas OFS peer.',
		aliases: ['Oil States International', 'Oil States'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.oilstatesintl.com/' },
			{ scheme: 'ticker', value: 'OIS' },
		],
		links: [peerHal('Oilfield products and services peer (Houston)')],
		metadata: { ...ofsMeta, state: 'TX', cik: '0001121484' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Forum Energy Technologies, Inc.',
		slug: 'firm:forum-energy-technologies-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2005',
		summary:
			'Houston oilfield products and equipment manufacturer (drilling & completions, production). Texas OFS equipment peer.',
		aliases: ['Forum Energy Technologies', 'Forum Energy', 'FET'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.f-e-t.com/' },
			{ scheme: 'ticker', value: 'FET' },
		],
		links: [peerHal('Oilfield products / equipment peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'oilfield_equipment', state: 'TX', cik: '0001405495' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Superior Energy Services, Inc.',
		slug: 'firm:superior-energy-services-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1989',
		summary:
			'Houston-area well intervention, coiled tubing, and production services company. Completions/intervention peer to Halliburton service lines.',
		aliases: ['Superior Energy Services', 'Superior Energy'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.superiorenergy.com/' }],
		links: [peerHal('Well intervention / production services peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'well_intervention', state: 'TX' },
		sourceCorpus: CORPUS,
	},

	// --- Pressure pumping / completions (Permian / TX) ---
	{
		profileType: 'firm',
		name: 'Liberty Energy Inc.',
		slug: 'firm:liberty-energy-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2011',
		summary:
			'Denver-founded / Texas-active hydraulic fracturing and completions company with large Permian Basin footprint. Pressure-pumping peer category to Halliburton.',
		aliases: ['Liberty Energy', 'Liberty Oilfield Services'],
		locations: [
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
			loc('Midland, TX', 'associated', 'Midland', 'TX', 'Midland'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.libertyenergy.com/' },
			{ scheme: 'ticker', value: 'LBRT' },
		],
		links: [peerHal('Pressure pumping / completions peer (Permian / TX)')],
		metadata: { ...ofsMeta, sector: 'pressure_pumping', state: 'TX', cik: '0001692427' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ProPetro Holding Corp.',
		slug: 'firm:propetro-holding-corp',
		status: 'pinned',
		endDate: '',
		startDate: '2005',
		summary:
			'Midland, Texas hydraulic fracturing and complementary services company focused on the Permian Basin. Regional completions peer to Halliburton.',
		aliases: ['ProPetro', 'ProPetro Holding', 'ProPetro Services'],
		locations: [loc('Midland, TX', 'hq', 'Midland', 'TX', 'Midland')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.propetroservices.com/' },
			{ scheme: 'ticker', value: 'PUMP' },
		],
		links: [peerHal('Permian pressure pumping peer (Midland)')],
		metadata: { ...ofsMeta, sector: 'pressure_pumping', state: 'TX', cik: '0001680247' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ProFrac Holding Corp.',
		slug: 'firm:profrac-holding-corp',
		status: 'pinned',
		endDate: '',
		startDate: '2016',
		summary:
			'Texas hydraulic fracturing and related services company (Willow Park / Willow Park–area HQ). Completions peer active in Texas basins.',
		aliases: ['ProFrac', 'ProFrac Holding', 'ProFrac Services'],
		locations: [
			loc('Willow Park, TX', 'hq', 'Willow Park', 'TX', 'Parker'),
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.profrac.com/' },
			{ scheme: 'ticker', value: 'ACDC' },
		],
		links: [peerHal('Pressure pumping / completions peer (TX)')],
		metadata: { ...ofsMeta, sector: 'pressure_pumping', state: 'TX', cik: '0001881487' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Nine Energy Service, Inc.',
		slug: 'firm:nine-energy-service-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2011',
		summary:
			'Houston completions equipment and services company (cementing, wireline, completion tools). Texas OFS peer to Halliburton completion lines.',
		aliases: ['Nine Energy Service', 'Nine Energy'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://nineenergyservice.com/' },
			{ scheme: 'ticker', value: 'NINE' },
		],
		links: [peerHal('Completions equipment / services peer (Houston)')],
		metadata: { ...ofsMeta, sector: 'completions', state: 'TX', cik: '0001532286' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Select Water Solutions, Inc.',
		slug: 'firm:select-water-solutions-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2008',
		summary:
			'Houston water management and related oilfield services company (formerly Select Energy Services). Completions/production support peer active in Texas and Mid-Continent.',
		aliases: ['Select Water Solutions', 'Select Energy Services', 'Select'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.selectwater.com/' },
			{ scheme: 'ticker', value: 'WTTR' },
		],
		links: [peerHal('Oilfield water / completions support peer (Houston; TX-OK basins)')],
		metadata: { ...ofsMeta, sector: 'water_management', state: 'TX', cik: '0001486957' },
		sourceCorpus: CORPUS,
	},

	// --- Land drilling contractors ---
	{
		profileType: 'firm',
		name: 'Patterson-UTI Energy, Inc.',
		slug: 'firm:patterson-uti-energy-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1978',
		summary:
			'Houston-area land drilling contractor and pressure pumping company. Major U.S. land rig fleet with Texas and Mid-Continent activity; drilling peer to Helmerich & Payne and services adjacency to Halliburton.',
		aliases: ['Patterson-UTI', 'Patterson UTI', 'Patterson-UTI Energy'],
		locations: [
			loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris'),
			loc('Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK', 'Oklahoma'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.patenergy.com/' },
			{ scheme: 'ticker', value: 'PTEN' },
		],
		links: [peerHal('Land drilling / pressure pumping peer (Houston; TX-OK)')],
		metadata: {
			...ofsMeta,
			sector: 'land_drilling',
			states: ['TX', 'OK'],
			cik: '0000889900',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Nabors Industries Ltd.',
		slug: 'firm:nabors-industries-ltd',
		status: 'pinned',
		endDate: '',
		startDate: '1952',
		summary:
			'Global land and offshore drilling contractor with significant U.S. onshore operations including Texas basins. Drilling contractor peer set with Helmerich & Payne.',
		aliases: ['Nabors', 'Nabors Industries', 'Nabors Drilling'],
		locations: [
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
			loc('Midland, TX', 'associated', 'Midland', 'TX', 'Midland'),
		],
		identifiers: [
			{ scheme: 'url', value: 'https://www.nabors.com/' },
			{ scheme: 'ticker', value: 'NBR' },
		],
		links: [peerHal('Land drilling contractor peer (TX basins)')],
		metadata: { ...ofsMeta, sector: 'land_drilling', state: 'TX', cik: '0001163739' },
		sourceCorpus: CORPUS,
	},

	// --- Oklahoma-focused / Mid-Continent services note event ---
	{
		profileType: 'historic_event',
		name: 'Mid-Continent / SCOOP-STACK Oilfield Services Corridor',
		slug: 'historic_event:midcontinent-scoop-stack-ofs-corridor',
		status: 'pinned',
		startDate: '2010',
		summary:
			'Oklahoma Mid-Continent oilfield services activity supporting SCOOP/STACK and related plays — drilling support, completions, production optimization, well intervention, and equipment rental. Anchored by Tulsa (Helmerich & Payne) and Oklahoma City field bases plus national OFS yards (Halliburton, Baker Hughes, SLB, Weatherford).',
		locations: [
			loc('Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK', 'Oklahoma'),
			loc('Tulsa, OK', 'associated', 'Tulsa', 'OK', 'Tulsa'),
		],
		metadata: { ...ofsMeta, sector: 'regional_corridor', state: 'OK' },
		sourceCorpus: CORPUS,
	},
];

/** Enrich existing Halliburton peer cards without clobbering good summaries. */
const enrichExisting = [
	{
		slug: 'firm:halliburton',
		name: 'Halliburton Company',
		endDate: '',
		startDate: '1919',
		locations: [loc('3000 North Sam Houston Parkway East, Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.halliburton.com/' },
			{ scheme: 'ticker', value: 'HAL' },
		],
		metadata: {
			...ofsMeta,
			sector: 'oilfield_services',
			state: 'TX',
			cik: '0000045012',
			halliburtonPeerAnchor: true,
		},
	},
	{
		slug: 'firm:baker-hughes-company',
		name: 'Baker Hughes Company',
		endDate: '',
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		links: [peerHal('Oilfield services peer (Houston; Baker Hughes)')],
		metadata: { ...ofsMeta, state: 'TX', cik: '0001701605' },
	},
	{
		slug: 'firm:weatherford-international-inc',
		name: 'Weatherford International plc',
		endDate: '',
		startDate: '1941',
		summary:
			'Houston-area drilling, completion, production, and well intervention services and equipment company. Global OFS peer to Halliburton with Texas headquarters functions and Oklahoma field activity.',
		aliases: ['Weatherford', 'Weatherford International', 'Weatherford International Inc.'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [
			{ scheme: 'url', value: 'https://www.weatherford.com/' },
			{ scheme: 'ticker', value: 'WFRD' },
		],
		links: [peerHal('Oilfield services peer (Houston; Weatherford)')],
		metadata: { ...ofsMeta, state: 'TX', cik: '0001603923' },
	},
	{
		slug: 'firm:helmerich-payne-inc',
		name: 'Helmerich & Payne, Inc.',
		endDate: '',
		locations: [
			loc('Tulsa, OK', 'hq', 'Tulsa', 'OK', 'Tulsa'),
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
			loc('Midland, TX', 'associated', 'Midland', 'TX', 'Midland'),
		],
		links: [
			peerHal('Land drilling contractor peer (Tulsa HQ; Permian / TX ops)'),
			{
				peerName: 'Mid-Continent / SCOOP-STACK Oilfield Services Corridor',
				peerSlug: 'historic_event:midcontinent-scoop-stack-ofs-corridor',
				peerType: 'historic_event',
				relationType: 'participated_in',
				roleLabel: 'Tulsa land drilling anchor',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...ofsMeta,
			sector: 'land_drilling',
			states: ['OK', 'TX'],
			cik: '0000046765',
		},
	},
];

async function runOne(args, label) {
	if (dryRun) {
		console.log(`[dry-run] ${label}: ${args.slug || args.name}`);
		return { ok: true };
	}
	const res = await upsertProfileTool(args);
	const status = res?.ok !== false ? 'ok' : 'fail';
	console.log(`[${status}] ${label}: ${args.slug || args.name}${res?.error ? ' — ' + res.error : ''}`);
	return res;
}

console.log(`TX/OK oilfield services import (${dryRun ? 'DRY RUN' : 'live'}) — corpus ${CORPUS}`);
let ok = 0;
let fail = 0;

for (const item of batch) {
	const res = await runOne(item, 'create/update');
	if (res?.ok !== false) ok += 1;
	else fail += 1;
}

for (const item of enrichExisting) {
	const { slug, name, ...rest } = item;
	const args = {
		profileType: 'firm',
		slug,
		name,
		sourceCorpus: CORPUS,
		...rest,
	};
	const res = await runOne(args, 'enrich');
	if (res?.ok !== false) ok += 1;
	else fail += 1;
}

console.log(`Done. ok=${ok} fail=${fail} total=${ok + fail}`);
