#!/usr/bin/env node
/**
 * Bryan County (Durant area) firms similar to Love Beal & Nixon categories:
 * collections/law, oil & gas operators (Bryan County location), security, IT, Choctaw defense.
 *
 * Usage: node scripts/import-bryan-county-similar-firms.mjs [--dry-run]
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
const CORPUS = 'bryan-county-similar-firms-2026-11-23';
const LBN = 'firm:love-beal-nixon-p-c';
const BRYAN_LOC = {
	raw: 'Bryan County, Oklahoma (Durant area production / leases)',
	role: 'associated',
	city: 'Durant',
	county: 'Bryan',
	state: 'OK',
	country: 'US',
};

function similarToLbn(label) {
	return {
		peerName: 'Love, Beal & Nixon, P.C.',
		peerSlug: LBN,
		relationType: 'business_tie',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

/** Existing operators: add Bryan County location only (do not overwrite summaries). */
const operatorSlugs = [
	{ name: 'FINLEY RESOURCES INC', slug: 'firm:finley-resources-inc' },
	{ name: 'XTO ENERGY INC.', slug: 'firm:xto-energy-inc' },
	{ name: 'CIMAREX ENERGY CO. OF COLORADO', slug: 'firm:cimarex-energy-co-of-colorado' },
	{ name: 'CITATION OIL & GAS CORP', slug: 'firm:citation-oil-gas-corp' },
	{ name: 'VERDAD OIL & GAS CORPORATION', slug: 'firm:verdad-oil-gas-corporation' },
	{ name: 'GLB EXPLORATION INC', slug: 'firm:glb-exploration-inc' },
	{ name: 'GODFREY OIL PROPERTIES', slug: 'firm:godfrey-oil-properties' },
];

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	// --- Collections / law (Durant) ---
	{
		profileType: 'firm',
		name: 'Criswell and Criswell',
		slug: 'firm:criswell-and-criswell',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant, Oklahoma local law practice (Tom Criswell, III). Long experience that includes debt collection matters. Closest local collections-oriented peer in Bryan County to Love, Beal & Nixon style creditors rights work (most Bryan County collection suits are filed by out-of-county firms).',
		aliases: ['Criswell & Criswell', 'Tom Criswell, III'],
		locations: [
			{
				raw: '122 North 3rd Avenue, Durant, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			similarToLbn(
				'Bryan County / Durant collections-related local counsel (peer category to Love, Beal & Nixon)',
			),
		],
		metadata: {
			industry: 'law',
			sector: 'general_practice_collections',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Burrage Law Firm, PLLC',
		slug: 'firm:burrage-law-firm-pllc',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant general practice firm. Handles business, commercial, and litigation work that can include collections or creditors rights issues in Bryan County.',
		aliases: ['Burrage Law Firm'],
		locations: [
			{
				raw: '1201 Westside Drive, Durant, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			similarToLbn(
				'Bryan County / Durant general practice; commercial and litigation including collections matters',
			),
		],
		metadata: {
			industry: 'law',
			sector: 'general_practice',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'McGehee & Associates',
		slug: 'firm:mcgehee-associates',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant-area general practice firm. Business, commercial, and litigation work that can include collections or creditors rights issues in Bryan County.',
		aliases: ['McGehee and Associates'],
		locations: [
			{
				raw: 'Durant, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			similarToLbn(
				'Bryan County / Durant general practice; commercial and litigation including collections matters',
			),
		],
		metadata: {
			industry: 'law',
			sector: 'general_practice',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	// --- New operator + local energy ---
	{
		profileType: 'firm',
		name: 'BCE-Mach III LLC',
		slug: 'firm:bce-mach-iii-llc',
		endDate: '',
		status: 'pinned',
		summary:
			'Oil and gas operator with active or recent production in Bryan County, Oklahoma. HQ typically elsewhere; Bryan County noted for local leases and wells (modest volumes vs core Oklahoma basins).',
		aliases: ['BCE-Mach III', 'BCE Mach III LLC'],
		locations: [BRYAN_LOC],
		metadata: {
			industry: 'oil_gas',
			sector: 'exploration_production',
			bryanCounty: true,
			bryanCountyRole: 'operator_production',
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'McCraw Oil & Propane',
		slug: 'firm:mccraw-oil-propane',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant local energy-related business: fuels, propane, lubricants, and farm/ranch supplies.',
		aliases: ['McCraw Oil and Propane', 'McCraw Oil'],
		locations: [
			{
				raw: '2715 N 1st Ave, Durant, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			industry: 'energy_retail',
			sector: 'fuels_propane',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	// --- Security ---
	{
		profileType: 'firm',
		name: 'Oklahoma Safety Agency',
		slug: 'firm:oklahoma-safety-agency',
		endDate: '',
		status: 'pinned',
		summary:
			'Based in Durant. Provides armed security patrol, 24/7 response, and related services. Serves Bryan County and neighboring counties. Veteran-owned (USMC leadership). CLEET licensed.',
		locations: [
			{
				raw: 'Durant, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			industry: 'security',
			sector: 'armed_patrol_response',
			bryanCounty: true,
			cleetLicensed: true,
			veteranOwned: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	// --- Tech / IT ---
	{
		profileType: 'firm',
		name: 'Button 108',
		slug: 'firm:button-108',
		endDate: '',
		status: 'pinned',
		summary:
			'Managed Services of Durant — Durant-based MSP. Offers managed IT, networking, VoIP, cabling, security cameras, antivirus, and related support. Serves southern Oklahoma and north Texas.',
		aliases: ['Managed Services of Durant', 'Button108'],
		locations: [
			{
				raw: 'Durant, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			industry: 'it_msp',
			sector: 'managed_services',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Computer Services of Durant, Inc.',
		slug: 'firm:computer-services-of-durant-inc',
		endDate: '',
		status: 'pinned',
		summary:
			'Computer repair, networking, website design/hosting, servers, and related tech services in the Texoma area (Durant / Bryan County).',
		aliases: ['Computer Services of Durant'],
		locations: [
			{
				raw: 'Durant, Bryan County, OK (Texoma area)',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			industry: 'it_services',
			sector: 'repair_networking_web',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Shade Tech Solutions',
		slug: 'firm:shade-tech-solutions',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant firm offering home automation, home theater, and security systems.',
		locations: [
			{
				raw: 'Durant, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			industry: 'it_av',
			sector: 'home_automation_security',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	// --- Choctaw defense / tribal ---
	{
		profileType: 'government',
		name: 'Choctaw Nation of Oklahoma',
		slug: 'government:choctaw-nation-of-oklahoma',
		endDate: '',
		status: 'pinned',
		summary:
			'Federally recognized tribe headquartered in the Durant area (Bryan County). Major driver of local economy via tribal government, gaming, healthcare, and related enterprises including Choctaw Global and defense manufacturing entities.',
		aliases: ['Choctaw Nation', 'Choctaw Nation of Oklahoma'],
		locations: [
			{
				raw: 'Durant area, Bryan County, OK (tribal headquarters area)',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		metadata: {
			bryanCounty: true,
			entityKind: 'tribal_nation',
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Choctaw Defense Munitions, LLC',
		slug: 'firm:choctaw-defense-munitions-llc',
		endDate: '',
		status: 'pinned',
		summary:
			'Durant-area tribal 8(a) firm (also operating as Choctaw Workforce Solutions). Involved in workforce solutions, services supporting military readiness, and federal contracts (including Army and other DoD). Related to Choctaw Global / Choctaw Nation of Oklahoma.',
		aliases: [
			'Choctaw Defense Munitions',
			'Choctaw Workforce Solutions',
			{ alias: 'CDM', kind: 'acronym' },
		],
		locations: [
			{
				raw: 'Durant area, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Choctaw Nation of Oklahoma',
				peerSlug: 'government:choctaw-nation-of-oklahoma',
				peerType: 'government',
				relationType: 'owned_by',
				roleLabel: 'Tribal 8(a) / related to Choctaw Nation of Oklahoma',
				createPeerIfMissing: false,
			},
			{
				peerName: 'Choctaw Global',
				peerSlug: 'firm:choctaw-global',
				relationType: 'affiliated_with',
				roleLabel: 'Related to Choctaw Global',
				createPeerIfMissing: true,
			},
		],
		metadata: {
			industry: 'defense',
			sector: 'workforce_munitions_federal_contracts',
			tribal8a: true,
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Choctaw Defense Manufacturing',
		slug: 'firm:choctaw-defense-manufacturing',
		endDate: '',
		status: 'pinned',
		summary:
			'Choctaw Nation-related manufacturing entity. Precision manufacturing for commercial and military applications (plants in the broader Choctaw Nation area; ITAR/AS9100 capabilities noted).',
		aliases: ['Choctaw Defense Manufacturing LLC'],
		locations: [
			{
				raw: 'Broader Choctaw Nation area (Bryan County / SE Oklahoma)',
				role: 'associated',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Choctaw Nation of Oklahoma',
				peerSlug: 'government:choctaw-nation-of-oklahoma',
				peerType: 'government',
				relationType: 'owned_by',
				roleLabel: 'Related Choctaw Nation manufacturing entity',
				createPeerIfMissing: false,
			},
			{
				peerName: 'Choctaw Defense Munitions, LLC',
				peerSlug: 'firm:choctaw-defense-munitions-llc',
				relationType: 'affiliated_with',
				roleLabel: 'Related Choctaw defense enterprise',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'defense_manufacturing',
			sector: 'precision_manufacturing',
			itar: true,
			as9100: true,
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Choctaw Global',
		slug: 'firm:choctaw-global',
		endDate: '',
		status: 'pinned',
		summary:
			'Choctaw Nation of Oklahoma enterprise group associated with defense, manufacturing, workforce, and federal contracting affiliates (including Choctaw Defense Munitions / Choctaw Workforce Solutions).',
		locations: [
			{
				raw: 'Durant area, Bryan County, OK',
				role: 'hq',
				city: 'Durant',
				county: 'Bryan',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Choctaw Nation of Oklahoma',
				peerSlug: 'government:choctaw-nation-of-oklahoma',
				peerType: 'government',
				relationType: 'owned_by',
				roleLabel: 'Enterprise of Choctaw Nation of Oklahoma',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'tribal_enterprise',
			bryanCounty: true,
			activeStatus: 'active',
		},
		sourceCorpus: CORPUS,
	},
];

for (const op of operatorSlugs) {
	batch.push({
		profileType: 'firm',
		name: op.name,
		slug: op.slug,
		locations: [BRYAN_LOC],
		metadata: {
			bryanCounty: true,
			bryanCountyRole: 'operator_production',
			bryanCountyNote:
				'Active or recent oil and gas production / leases in Bryan County, OK (modest volumes vs core Oklahoma basins; HQ typically elsewhere).',
		},
		sourceCorpus: CORPUS,
	});
}

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
