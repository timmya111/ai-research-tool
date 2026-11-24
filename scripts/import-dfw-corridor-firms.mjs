#!/usr/bin/env node
/**
 * DFW / North Texas (Plano–Denison + metroplex) firms in Love Beal & Nixon peer categories.
 * Usage: node scripts/import-dfw-corridor-firms.mjs [--dry-run]
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
const CORPUS = 'dfw-north-texas-corridor-2026-11-23';
const LBN = 'firm:love-beal-nixon-p-c';
const DFW_EVENT = 'historic_event:dfw-military-defense-tech-corridor';

const dfwMeta = {
	dfwMetro: true,
	region: 'Dallas–Fort Worth metroplex and North Texas (Plano north to Denison)',
};

function peerLbn(label) {
	return {
		peerName: 'Love, Beal & Nixon, P.C.',
		peerSlug: LBN,
		relationType: 'business_tie',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

function peerDfwDefense(label) {
	return {
		peerName: 'Dallas–Fort Worth Military & Defense Tech Corridor',
		peerSlug: DFW_EVENT,
		peerType: 'historic_event',
		relationType: 'participated_in',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

function loc(raw, role, city, state = 'TX', county) {
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
	// --- Collections ---
	{
		profileType: 'firm',
		name: 'Hicks Law Group',
		slug: 'firm:hicks-law-group',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas creditors rights and collections firm. Aggressive commercial and consumer debt enforcement, post-judgment work, and workouts. Peer category to Love, Beal & Nixon in the DFW metro.',
		locations: [loc('325 N. St. Paul Street, Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		links: [peerLbn('DFW creditors rights / collections peer (Dallas)')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'creditors_rights_collections' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Jones, Allen & Fuquay, L.L.P.',
		slug: 'firm:jones-allen-fuquay-llp',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas firm focused on creditors rights and bankruptcy representation.',
		aliases: ['Jones, Allen and Fuquay, L.L.P.', 'Jones Allen & Fuquay'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		links: [peerLbn('DFW creditors rights / bankruptcy peer (Dallas)')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'creditors_rights_bankruptcy' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Palmer Lehman, PLLC',
		slug: 'firm:palmer-lehman-pllc',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas longstanding financial-institution and creditors rights practice.',
		aliases: ['Palmer Lehman'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		links: [peerLbn('DFW creditors rights peer (Dallas)')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'creditors_rights' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Cowles & Thompson',
		slug: 'firm:cowles-thompson',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas/Fort Worth area firm: bankruptcy, restructuring, and creditors rights.',
		aliases: ['Cowles and Thompson'],
		locations: [
			loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas'),
			loc('Fort Worth, TX', 'branch', 'Fort Worth', 'TX', 'Tarrant'),
		],
		links: [peerLbn('DFW bankruptcy / creditors rights peer')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'bankruptcy_creditors_rights' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Pope, Hardwicke, Christie, Schell, Kelly & Taplett',
		slug: 'firm:pope-hardwicke-christie-schell-kelly-taplett',
		status: 'pinned',
		endDate: '',
		summary:
			'Fort Worth firm: banking and creditors rights for financial institutions.',
		aliases: ['Pope Hardwicke Christie Schell Kelly & Taplett', 'Pope Hardwicke'],
		locations: [loc('Fort Worth, TX', 'hq', 'Fort Worth', 'TX', 'Tarrant')],
		links: [peerLbn('DFW banking / creditors rights peer (Fort Worth)')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'banking_creditors_rights' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Blenden Roth Law Firm',
		slug: 'firm:blenden-roth-law-firm',
		status: 'pinned',
		endDate: '',
		summary:
			'Bedford (Fort Worth area) firm: commercial collections and judgment work.',
		locations: [loc('Bedford, TX (Fort Worth area)', 'hq', 'Bedford', 'TX', 'Tarrant')],
		links: [peerLbn('DFW commercial collections peer (Bedford / Fort Worth area)')],
		metadata: { ...dfwMeta, industry: 'law', sector: 'commercial_collections' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Northern DFW Creditors Rights Practices (Plano–McKinney–Frisco)',
		slug: 'firm:northern-dfw-creditors-rights-practices',
		status: 'candidate',
		summary:
			'Stub for local creditors rights and collections practices in McKinney, Plano, and Frisco serving the northern DFW suburbs. Specific firm names vary in directories; occupancy and specialization change over time.',
		locations: [
			loc('Plano, TX', 'associated', 'Plano', 'TX', 'Collin'),
			loc('McKinney, TX', 'associated', 'McKinney', 'TX', 'Collin'),
			loc('Frisco, TX', 'associated', 'Frisco', 'TX', 'Collin'),
		],
		links: [peerLbn('Northern DFW suburb collections / creditors rights category stub')],
		metadata: { ...dfwMeta, stub: true, sector: 'creditors_rights_collections' },
		sourceCorpus: CORPUS,
	},

	// --- Energy ---
	{
		profileType: 'firm',
		name: 'Energy Transfer',
		slug: 'firm:energy-transfer',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas-based major midstream company (pipelines for natural gas, NGLs, crude, refined products).',
		aliases: ['Energy Transfer LP', 'Energy Transfer Partners'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'midstream' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'HF Sinclair',
		slug: 'firm:hf-sinclair',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas refining company (HollyFrontier/Sinclair lineage): refining, renewable diesel, specialty products.',
		aliases: ['HF Sinclair Corporation', 'HollyFrontier', 'HollyFrontier Corporation'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'refining' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Hunt Consolidated',
		slug: 'firm:hunt-consolidated',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas Hunt family holding company related to Hunt Oil exploration, development, and energy interests.',
		aliases: ['Hunt Consolidated, Inc.'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		links: [
			{
				peerName: 'Hunt Oil Company',
				peerSlug: 'firm:hunt-oil-company',
				relationType: 'business_tie',
				roleLabel: 'Related Hunt Oil / Hunt family energy interests',
				createPeerIfMissing: false,
			},
		],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'holding_e_and_p' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Hunt Oil Company',
		slug: 'firm:hunt-oil-company',
		locations: [loc('1900 North Akard Street, Dallas, TX 75201', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: {
			...dfwMeta,
			industry: 'oil_gas',
			sector: 'exploration_development',
			dfwNote: 'Dallas HQ; exploration, development, and related energy interests',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Atmos Energy',
		slug: 'firm:atmos-energy',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas-based large natural-gas distribution utility.',
		aliases: ['Atmos Energy Corporation'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'utilities', sector: 'natural_gas_distribution' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'EnLink Midstream',
		slug: 'firm:enlink-midstream',
		status: 'pinned',
		endDate: '',
		summary: 'Dallas-area midstream energy company.',
		aliases: ['EnLink Midstream, LLC'],
		locations: [loc('Dallas area, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'midstream' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Range Resources',
		slug: 'firm:range-resources',
		status: 'pinned',
		endDate: '',
		summary:
			'Independent oil and gas producer with Fort Worth area presence (historical Barnett Shale ties).',
		aliases: ['Range Resources Corporation'],
		locations: [loc('Fort Worth area, TX', 'associated', 'Fort Worth', 'TX', 'Tarrant')],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'exploration_production' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'HighPeak Energy',
		slug: 'firm:highpeak-energy',
		status: 'pinned',
		endDate: '',
		summary:
			'Fort Worth independent E&P company (Midland Basin focus).',
		aliases: ['HighPeak Energy, Inc.'],
		locations: [loc('Fort Worth, TX', 'hq', 'Fort Worth', 'TX', 'Tarrant')],
		metadata: { ...dfwMeta, industry: 'oil_gas', sector: 'exploration_production' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'DFW Smaller Oil Gas Operators and Mineral Companies',
		slug: 'firm:dfw-smaller-oil-gas-operators-mineral-companies',
		status: 'candidate',
		summary:
			'Stub for numerous smaller operators, mineral companies, and service firms throughout Dallas, Fort Worth, and surrounding North Texas counties. Not an exhaustive roster.',
		locations: [
			loc('Dallas–Fort Worth metroplex, TX', 'associated', 'Dallas', 'TX'),
		],
		metadata: { ...dfwMeta, stub: true, industry: 'oil_gas' },
		sourceCorpus: CORPUS,
	},

	// --- Tech / cyber ---
	{
		profileType: 'firm',
		name: 'Trellix',
		slug: 'firm:trellix',
		status: 'pinned',
		endDate: '',
		summary:
			'Cybersecurity product/service firm with Plano area presence. Part of the denser Collin County / North Dallas tech and cyber ecosystem supporting commercial and defense supply-chain security (CMMC / NIST 800-171).',
		locations: [loc('Plano area, TX', 'associated', 'Plano', 'TX', 'Collin')],
		metadata: { ...dfwMeta, industry: 'cybersecurity', sector: 'product_services' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'DFW MSSP and CMMC Cybersecurity Providers',
		slug: 'firm:dfw-mssp-cmmc-cybersecurity-providers',
		status: 'candidate',
		summary:
			'Stub for managed security service providers (MSSPs), vCISO firms, and CMMC specialists serving DFW businesses and defense contractors (Fort Worth, Keller, Plano, Frisco, North Dallas, and related suburbs). Specific firm names change frequently.',
		locations: [
			loc('Plano / Frisco / North Dallas, TX', 'associated', 'Plano', 'TX', 'Collin'),
			loc('Fort Worth / Keller, TX', 'associated', 'Fort Worth', 'TX', 'Tarrant'),
		],
		links: [peerDfwDefense('Supporting cybersecurity / CMMC ecosystem for DFW defense supply chain')],
		metadata: { ...dfwMeta, stub: true, industry: 'cybersecurity', sector: 'mssp_cmmc' },
		sourceCorpus: CORPUS,
	},

	// --- Physical security ---
	{
		profileType: 'firm',
		name: 'Overton Security',
		slug: 'firm:overton-security',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas office; covers DFW including Plano and Fort Worth (officers, patrol, executive protection).',
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'security', sector: 'physical_patrol_ep' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Texas Industrial Security',
		slug: 'firm:texas-industrial-security',
		status: 'pinned',
		endDate: '',
		summary:
			'Longstanding North Texas physical security presence (Dallas and Fort Worth operations).',
		locations: [
			loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas'),
			loc('Fort Worth, TX', 'branch', 'Fort Worth', 'TX', 'Tarrant'),
		],
		metadata: { ...dfwMeta, industry: 'security', sector: 'physical_industrial' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'FRPS Security Solutions',
		slug: 'firm:frps-security-solutions',
		status: 'pinned',
		endDate: '',
		summary:
			'Plano/Collin County focus; armed and specialized protection.',
		locations: [loc('Plano / Collin County, TX', 'hq', 'Plano', 'TX', 'Collin')],
		metadata: { ...dfwMeta, industry: 'security', sector: 'armed_specialized' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Verified Response',
		slug: 'firm:verified-response',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas-based armed security, patrol, and investigations.',
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...dfwMeta, industry: 'security', sector: 'armed_patrol_investigations' },
		sourceCorpus: CORPUS,
	},

	// --- Defense (create missing; update existing locations) ---
	{
		profileType: 'firm',
		name: 'Lockheed Martin Corporation',
		slug: 'firm:lockheed-martin-corporation',
		locations: [
			loc('1 Lockheed Boulevard, Fort Worth, TX 76108 (Aeronautics / F-35)', 'branch', 'Fort Worth', 'TX', 'Tarrant'),
			loc('Grand Prairie, TX (Missiles and Fire Control)', 'branch', 'Grand Prairie', 'TX', 'Dallas'),
		],
		links: [peerDfwDefense('Major DFW defense prime — Fort Worth Aeronautics and Grand Prairie MFC')],
		metadata: {
			...dfwMeta,
			dfwSites: ['Fort Worth Aeronautics / F-35', 'Grand Prairie Missiles and Fire Control'],
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Lockheed Martin Aeronautics',
		slug: 'firm:lockheed-martin-aeronautics',
		locations: [loc('1 Lockheed Boulevard, Fort Worth, TX 76108', 'hq', 'Fort Worth', 'TX', 'Tarrant')],
		links: [peerDfwDefense('Fort Worth Aeronautics / F-35 production')],
		metadata: { ...dfwMeta },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Bell Textron',
		slug: 'firm:bell-textron',
		locations: [loc('3255 Bell Flight Boulevard, Fort Worth, TX 76118', 'hq', 'Fort Worth', 'TX', 'Tarrant')],
		links: [peerDfwDefense('Fort Worth rotorcraft HQ and military programs')],
		metadata: { ...dfwMeta, sector: 'rotorcraft_aerospace' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'RTX Corporation',
		slug: 'firm:rtx-corporation',
		locations: [
			loc('McKinney, TX (Raytheon defense electronics)', 'branch', 'McKinney', 'TX', 'Collin'),
		],
		links: [peerDfwDefense('Raytheon / Collins aerospace-defense presence in North Texas')],
		metadata: { ...dfwMeta, dfwNote: 'Raytheon defense electronics in McKinney; Collins facilities in region' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Collins Aerospace',
		slug: 'firm:collins-aerospace',
		locations: [loc('Dallas–Fort Worth / North Texas facilities', 'associated', 'Dallas', 'TX')],
		links: [peerDfwDefense('Collins Aerospace facilities in the DFW region')],
		metadata: { ...dfwMeta },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'L3Harris',
		slug: 'firm:l3harris',
		locations: [
			loc('Arlington, TX', 'branch', 'Arlington', 'TX', 'Tarrant'),
			loc('Plano, TX', 'branch', 'Plano', 'TX', 'Collin'),
			loc('Greenville, TX', 'branch', 'Greenville', 'TX', 'Hunt'),
		],
		links: [peerDfwDefense('Multiple North Texas locations (Arlington, Plano, Greenville)')],
		metadata: { ...dfwMeta },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Elbit Systems of America',
		slug: 'firm:elbit-systems-of-america',
		status: 'pinned',
		endDate: '',
		summary:
			'Defense electronics and systems firm with Fort Worth area presence.',
		locations: [loc('Fort Worth area, TX', 'associated', 'Fort Worth', 'TX', 'Tarrant')],
		links: [peerDfwDefense('Fort Worth area defense systems presence')],
		metadata: { ...dfwMeta, industry: 'defense' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Leonardo DRS',
		slug: 'firm:leonardo-drs',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas-area manufacturing and defense systems work (Leonardo DRS).',
		aliases: ['DRS', 'Leonardo DRS, Inc.'],
		locations: [loc('Dallas area, TX', 'associated', 'Dallas', 'TX', 'Dallas')],
		links: [peerDfwDefense('Dallas-area manufacturing and systems')],
		metadata: { ...dfwMeta, industry: 'defense' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'BAE Systems',
		slug: 'firm:bae-systems',
		status: 'pinned',
		endDate: '',
		summary:
			'Global defense contractor with facilities or significant presence across the DFW metro (Dallas, Fort Worth, Plano, Richardson, Grand Prairie, and related sites).',
		locations: [loc('Dallas–Fort Worth metroplex, TX', 'associated', 'Dallas', 'TX')],
		links: [peerDfwDefense('DFW metro defense presence')],
		metadata: { ...dfwMeta, industry: 'defense' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Northrop Grumman',
		slug: 'firm:northrop-grumman',
		status: 'pinned',
		endDate: '',
		summary:
			'Major U.S. defense contractor with facilities or significant presence across the DFW metro.',
		aliases: ['Northrop Grumman Corporation'],
		locations: [loc('Dallas–Fort Worth metroplex, TX', 'associated', 'Dallas', 'TX')],
		links: [peerDfwDefense('DFW metro defense presence')],
		metadata: { ...dfwMeta, industry: 'defense' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Boeing',
		slug: 'firm:boeing',
		status: 'pinned',
		endDate: '',
		summary:
			'Aerospace and defense company with facilities or significant presence across the DFW metro (including ties to regional rotorcraft/defense programs).',
		aliases: ['The Boeing Company'],
		locations: [loc('Dallas–Fort Worth metroplex, TX', 'associated', 'Dallas', 'TX')],
		links: [peerDfwDefense('DFW metro aerospace/defense presence')],
		metadata: { ...dfwMeta, industry: 'aerospace_defense' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'DFW Defense Supply Chain Smaller Contractors',
		slug: 'firm:dfw-defense-supply-chain-smaller-contractors',
		status: 'candidate',
		summary:
			'Stub for the large supporting ecosystem of smaller contractors, manufacturers, and cybersecurity/IT firms serving the North Texas defense supply chain (~$35B annual gross product impact cited for private-sector defense activity in North Texas).',
		locations: [loc('Dallas–Fort Worth / North Texas', 'associated', 'Dallas', 'TX')],
		links: [peerDfwDefense('Smaller contractor / supplier ecosystem stub')],
		metadata: { ...dfwMeta, stub: true, industry: 'defense_supply_chain' },
		sourceCorpus: CORPUS,
	},
];

const results = [];
for (const item of batch) {
	const res = await upsertProfileTool({ ...item, dryRun });
	results.push(res.result);
	console.log(
		`${res.ok ? 'OK' : 'ERR'} ${res.result?.action || ''} ${res.result?.slug || item.name} locs=${res.result?.locationsAdded ?? res.result?.locations ?? '—'}`,
	);
	if (!res.ok) console.log(' ', res.result);
}

console.log(
	JSON.stringify(
		{
			ok: results.every((r) => r?.ok),
			dryRun,
			count: results.length,
			slugs: results.map((r) => r.slug).filter(Boolean),
		},
		null,
		2,
	),
);
