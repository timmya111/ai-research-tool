#!/usr/bin/env node
/**
 * Import firms near Love, Beal & Nixon (6621 N. Meridian / NW Expressway corridor, OKC).
 * Usage: node scripts/import-okc-meridian-corridor-firms.mjs [--dry-run]
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
const CORPUS = 'okc-meridian-corridor-2026-11-23';
const LBN = 'firm:love-beal-nixon-p-c';
const CORRIDOR =
	'Meridian Avenue / Northwest Expressway corridor, Oklahoma City, OK (near 6621 N. Meridian)';

function nearLbn(roleLabel = 'Same Meridian–NW Expressway corridor (OKC), near Love, Beal & Nixon') {
	return {
		peerName: 'Love, Beal & Nixon, P.C.',
		peerSlug: LBN,
		relationType: 'business_tie',
		roleLabel,
		createPeerIfMissing: false,
	};
}

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	// --- Collections / creditors' rights ---
	{
		profileType: 'firm',
		name: 'Morgan & Associates, PC',
		slug: 'firm:morgan-associates-pc',
		endDate: '',
		status: 'pinned',
		summary:
			'Collections and creditors rights law practice serving the Oklahoma City market. Active. Closest peer practice to Love, Beal & Nixon in the Meridian / NW Expressway corridor.',
		aliases: ['Morgan and Associates, PC', 'Morgan & Associates'],
		locations: [
			{
				raw: '2601 NW Expressway, Suite 205E, Oklahoma City, OK 73112',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn('Creditors rights / collections peer near Love, Beal & Nixon (NW Expressway)')],
		metadata: {
			industry: 'law',
			sector: 'creditors_rights_collections',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Stephen Bruce & Associates',
		slug: 'firm:stephen-bruce-associates',
		startDate: '1984',
		endDate: '',
		status: 'pinned',
		summary:
			'Specializes in consumer and commercial collections. Founded 1984; multi-state practice. Primarily Edmond with Oklahoma City presence and service area. Collections-oriented peer to Love, Beal & Nixon in the northwest OKC metro.',
		aliases: ['Stephen Bruce and Associates', 'Stephen Bruce & Associates'],
		locations: [
			{
				raw: 'Edmond, OK (primary); serves Oklahoma City metro',
				role: 'hq',
				city: 'Edmond',
				state: 'OK',
				country: 'US',
			},
			{
				raw: CORRIDOR,
				role: 'associated',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn('Collections peer (Edmond/OKC) near Love, Beal & Nixon corridor')],
		metadata: {
			industry: 'law',
			sector: 'creditors_rights_collections',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	// --- Oil & gas / energy ---
	{
		profileType: 'firm',
		name: 'Peak Energy, LLC',
		slug: 'firm:peak-energy-llc',
		endDate: '',
		status: 'pinned',
		summary:
			'Independent oil and gas exploration; mineral, royalty, and leasehold acquisitions focused on SCOOP, STACK, MERGE (Anadarko Basin) and other basins. Office at 1601 NW Expressway Suite 1600, Oklahoma City.',
		aliases: ['Peak Energy LLC', 'Peak Energy'],
		locations: [
			{
				raw: '1601 NW Expressway, Suite 1600, Oklahoma City, OK 73118',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			nearLbn(),
			{
				peerName: 'Peak Energy Fund I, LP',
				peerSlug: 'firm:peak-energy-fund-i-lp',
				relationType: 'business_tie',
				roleLabel: 'Related Peak Energy Fund I, LP',
				createPeerIfMissing: true,
			},
		],
		metadata: {
			industry: 'oil_gas',
			sector: 'exploration_minerals',
			basins: ['SCOOP', 'STACK', 'MERGE', 'Anadarko'],
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Peak Energy Fund I, LP',
		slug: 'firm:peak-energy-fund-i-lp',
		endDate: '',
		status: 'pinned',
		summary:
			'Peak Energy Fund I, LP — related Peak Energy vehicle for oil and gas / mineral and leasehold activity (SCOOP/STACK/MERGE). Associated with 1601 NW Expressway Suite 1600, Oklahoma City.',
		locations: [
			{
				raw: '1601 NW Expressway, Suite 1600, Oklahoma City, OK 73118',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			nearLbn(),
			{
				peerName: 'Peak Energy, LLC',
				peerSlug: 'firm:peak-energy-llc',
				relationType: 'business_tie',
				roleLabel: 'Related Peak Energy, LLC',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'oil_gas',
			sector: 'energy_fund',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Royal Energy Group LLC',
		slug: 'firm:royal-energy-group-llc',
		endDate: '',
		status: 'pinned',
		summary:
			'Energy investment firm acquiring oil and gas interests, primarily Mid-Continent (including STACK, SCOOP, MERGE). Office at 6300 NW Expressway #200, Oklahoma City.',
		aliases: ['Royal Energy Group'],
		locations: [
			{
				raw: '6300 NW Expressway, #200, Oklahoma City, OK 73132',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas',
			sector: 'energy_investment',
			basins: ['STACK', 'SCOOP', 'MERGE', 'Mid-Continent'],
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'SEF Energy',
		slug: 'firm:sef-energy',
		endDate: '',
		status: 'pinned',
		summary:
			'Private holding company focused on oilfield manufacturing assets. Office at 2601 NW Expressway #900E, Oklahoma City.',
		locations: [
			{
				raw: '2601 NW Expressway, #900E, Oklahoma City, OK 73112',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas',
			sector: 'oilfield_manufacturing_holding',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Fishermens Petroleum Company Limited',
		slug: 'firm:fishermens-petroleum-company-limited',
		endDate: '',
		status: 'pinned',
		summary:
			'Oil and gas exploration and production. Office at 2601 NW Expressway #708W, Oklahoma City.',
		aliases: ["Fishermen's Petroleum Company Limited", 'Fishermens Petroleum'],
		locations: [
			{
				raw: '2601 NW Expressway, #708W, Oklahoma City, OK 73112',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas',
			sector: 'exploration_production',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'PHX Minerals LLC',
		slug: 'firm:phx-minerals-llc',
		endDate: '',
		status: 'pinned',
		summary:
			'Mineral and oil and gas interest ownership and management. Related to Panhandle Oil and Gas interests. Listings in the 1601 NW Expressway area, Oklahoma City.',
		aliases: ['PHX Minerals', 'Panhandle Oil and Gas (related interests)'],
		locations: [
			{
				raw: '1601 NW Expressway area, Oklahoma City, OK 73118',
				role: 'associated',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas',
			sector: 'minerals',
			relatedTo: 'Panhandle Oil and Gas interests',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'NRG Asset Management',
		slug: 'firm:nrg-asset-management',
		endDate: '',
		status: 'pinned',
		summary:
			'Specialized oil and gas accounting services. Office at 4334 NW Expressway #201, Oklahoma City.',
		locations: [
			{
				raw: '4334 NW Expressway, #201, Oklahoma City, OK 73116',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas_services',
			sector: 'accounting',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Fortune Oil Partners',
		slug: 'firm:fortune-oil-partners',
		endDate: '',
		status: 'pinned',
		summary:
			'Energy and investment-related operations. Office at 2601 NW Expressway Ste 107E, Oklahoma City.',
		locations: [
			{
				raw: '2601 NW Expressway, Ste 107E, Oklahoma City, OK 73112',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'oil_gas',
			sector: 'energy_investment',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	// --- Security ---
	{
		profileType: 'firm',
		name: 'Prosegur Security USA',
		slug: 'firm:prosegur-security-usa',
		endDate: '',
		status: 'pinned',
		summary:
			'Oklahoma City office: security guard services, remote monitoring, access control, emergency response, and cybersecurity. Serves commercial, energy, healthcare, and government clients across Oklahoma. Closest major security presence to the Meridian / NW Expressway corridor near Love, Beal & Nixon.',
		aliases: ['Prosegur Security USA – Oklahoma City Office', 'Prosegur'],
		locations: [
			{
				raw: '1900 NW Expressway, Suite 510, Oklahoma City, OK 73118',
				role: 'branch',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn('Security services presence near Love, Beal & Nixon corridor')],
		metadata: {
			industry: 'security',
			sector: 'guard_monitoring_cyber',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Consolidated Security Consultants',
		slug: 'firm:consolidated-security-consultants',
		endDate: '',
		status: 'pinned',
		summary:
			'Employment screening, criminal history checks, E-Verify, drug testing, and background verification services. Office at 2809 NW Expressway #390, Oklahoma City.',
		locations: [
			{
				raw: '2809 NW Expressway, #390, Oklahoma City, OK 73112',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn()],
		metadata: {
			industry: 'security',
			sector: 'background_screening',
			activeStatus: 'active',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	// --- Stubs / notes ---
	{
		profileType: 'firm',
		name: 'Alias Cybersecurity',
		slug: 'firm:alias-cybersecurity',
		status: 'candidate',
		summary:
			'Broader Oklahoma City cybersecurity firm operating from other parts of the metro; serves clients in the northwest Meridian / NW Expressway area. Exact corridor suite not confirmed in free public sources.',
		locations: [
			{
				raw: 'Oklahoma City metro (serves NW Meridian corridor clients)',
				role: 'associated',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [nearLbn('Cybersecurity firm serving NW OKC corridor clients')],
		metadata: {
			industry: 'cybersecurity',
			sector: 'it_security',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
			occupancySource: 'metro_service_area_note',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'government',
		name: 'GSA at Lake Park Tower (Oklahoma City)',
		slug: 'government:gsa-lake-park-tower-oklahoma-city',
		status: 'candidate',
		summary:
			'General Services Administration has occupied space at Lake Park Tower (6525 N. Meridian, Oklahoma City), which can include federal administrative or support functions. Closest federal presence noted in the Meridian corridor near Love, Beal & Nixon.',
		aliases: ['GSA Lake Park Tower OKC', 'General Services Administration – Lake Park Tower'],
		locations: [
			{
				raw: 'Lake Park Tower, 6525 N. Meridian, Oklahoma City, OK',
				role: 'associated',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Love, Beal & Nixon, P.C.',
				peerSlug: LBN,
				peerType: 'firm',
				relationType: 'business_tie',
				roleLabel: 'Federal GSA presence at Lake Park Tower near Love, Beal & Nixon',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			agency: 'GSA',
			building: 'Lake Park Tower',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Lake Park Tower',
		slug: 'firm:lake-park-tower-oklahoma-city',
		status: 'candidate',
		summary:
			'Office tower at 6525 N. Meridian, Oklahoma City. Commercial records note GSA occupancy and past Weatherford-related or compression services listings. Landmark building in the Meridian corridor near Love, Beal & Nixon (6621 N. Meridian).',
		locations: [
			{
				raw: '6525 N. Meridian, Oklahoma City, OK',
				role: 'hq',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			nearLbn('Lake Park Tower (6525 N. Meridian) near Love, Beal & Nixon'),
			{
				peerName: 'GSA at Lake Park Tower (Oklahoma City)',
				peerSlug: 'government:gsa-lake-park-tower-oklahoma-city',
				peerType: 'government',
				relationType: 'business_tie',
				roleLabel: 'GSA has occupied space in this building',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'real_estate',
			sector: 'office_tower',
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Weatherford International Inc.',
		slug: 'firm:weatherford-international-inc',
		status: 'pinned',
		summary:
			'Oilfield services company (HQ Houston). Historical/nearby commercial data: Weatherford-related or compression services have appeared at or near Lake Park Tower (6525 N. Meridian, Oklahoma City) in past listings. Not confirmed as a current primary OKC Meridian corridor office.',
		locations: [
			{
				raw: 'Lake Park Tower / 6525 N. Meridian area, Oklahoma City, OK (historical commercial listing)',
				role: 'associated',
				city: 'Oklahoma City',
				state: 'OK',
				country: 'US',
			},
		],
		links: [
			nearLbn('Historical Weatherford-related listing near Lake Park Tower / Love, Beal & Nixon'),
			{
				peerName: 'Lake Park Tower',
				peerSlug: 'firm:lake-park-tower-oklahoma-city',
				relationType: 'business_tie',
				roleLabel: 'Past commercial data associated Weatherford-related or compression services with this building',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			okcMeridianCorridor: true,
			corridor: CORRIDOR,
			schaumburgOccupancy: undefined,
			okcOccupancy: 'historical_commercial_listing_unconfirmed',
		},
		sourceCorpus: CORPUS,
	},
];

const results = [];
for (const item of batch) {
	const res = await upsertProfileTool({ ...item, dryRun });
	results.push(res.result);
	console.log(
		`${res.ok ? 'OK' : 'ERR'} ${res.result?.action || ''} ${res.result?.slug || item.name} start=${res.result?.startDate ?? '—'} locs=${res.result?.locationsAdded ?? res.result?.locations ?? '—'}`,
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
