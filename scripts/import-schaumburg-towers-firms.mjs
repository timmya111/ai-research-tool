#!/usr/bin/env node
/**
 * Import / enrich firms tied to Schaumburg Towers (1400–1450 American Lane).
 * Usage: node scripts/import-schaumburg-towers-firms.mjs [--dry-run]
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
const CORPUS = 'schaumburg-towers-tenants-2026-11-23';

const TOWER_1450 = '1450 American Lane, Schaumburg, IL 60173';
const TOWER_1400 = '1400 American Lane, Schaumburg, IL 60173';
const COMPLEX =
	'Schaumburg Towers complex, 1400–1450 American Lane, Schaumburg, IL 60173';

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	{
		profileType: 'firm',
		name: 'Cetera Investment Advisers LLC',
		slug: 'firm:cetera-investment-advisers-llc',
		startDate: '1984-01-13',
		endDate: '',
		status: 'pinned',
		summary:
			'Large RIA supporting independent financial advisors at Schaumburg Towers (Suite 650). Specializations: financial planning, portfolio management (individuals/institutions), pension consulting, adviser selection, educational seminars. ~$250–257B AUM. SEC-approved January 13, 1984; still active. SEC File #801-20406.',
		aliases: [
			'CETERA INVESTMENT ADVISERS LLC',
			'Cetera Investment Advisers',
			{ alias: 'Cetera', kind: 'name' },
		],
		locations: [
			{
				raw: '1450 American Lane, 6th Floor, Suite 650, Schaumburg, IL 60173-2096',
				role: 'hq',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		identifiers: [
			{ scheme: 'finra_crd', value: '105644' },
			{ scheme: 'sec_cik', value: '0001666741' },
			{ scheme: 'source_id', value: 'sec-ia-801-20406' },
		],
		metadata: {
			industry: 'ria',
			sector: 'financial_services',
			activeStatus: 'active',
			secFileNumber: '801-20406',
			aumApproxBillions: '250-257',
			schaumburgTowers: true,
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Meltzer, Purtill & Stelle LLC',
		slug: 'firm:meltzer-purtill-stelle-llc',
		startDate: '1996',
		endDate: '',
		status: 'pinned',
		summary:
			'Business law firm focused on commercial real estate, banking and finance, corporate and M&A, litigation, land use and zoning, employment, and tax and estate planning. Relocated to 1450 American Lane Suite 1900 (about July 2025); previously nearby. Active private law firm (no CRD/CIK).',
		aliases: [
			'Meltzer Purtill & Stelle',
			'Meltzer, Purtill and Stelle LLC',
			{ alias: 'MPS LLC', kind: 'acronym' },
		],
		locations: [
			{
				raw: '1450 American Lane, Suite 1900, Schaumburg, IL 60173',
				role: 'hq',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		metadata: {
			industry: 'law',
			sector: 'legal_services',
			activeStatus: 'active',
			entityType: 'LLC',
			schaumburgTowers: true,
			relocatedToSuite1900: '2025-07',
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'USI Insurance Services LLC',
		slug: 'firm:usi-insurance-services-llc',
		startDate: '1994',
		endDate: '',
		status: 'pinned',
		summary:
			'Insurance brokerage and consulting (property & casualty, employee benefits, personal risk, retirement solutions). Founded 1994; active. Local office at 1450 American Lane Suite 1100. Recently acquired by Aon. Private; no CRD/CIK for the local office.',
		aliases: ['USI Insurance Services', 'USI'],
		locations: [
			{
				raw: '1450 American Lane, Suite 1100, Schaumburg, IL 60173',
				role: 'branch',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Aon Group, Inc.',
				peerSlug: 'firm:aon-group-inc',
				relationType: 'owned_by',
				roleLabel: 'Acquired by Aon (parent)',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'insurance_brokerage',
			sector: 'insurance',
			activeStatus: 'active',
			schaumburgTowers: true,
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Network Services Company',
		slug: 'firm:network-services-company',
		startDate: '1968',
		endDate: '',
		status: 'pinned',
		summary:
			'Member-owned distribution/cooperative for janitorial, food-service, packaging, and related industrial supplies; serves healthcare, commercial, grocery, and food-service industries. Founded 1968; active. Associated with 1400 American Lane (Schaumburg Towers complex); earlier listings also referenced nearby Woodfield Road. CAGE 09RP0; DUNS 082941204 (no CIK/CRD).',
		aliases: ['Network Services Co', 'Network Services'],
		locations: [
			{
				raw: '1400 American Lane, Schaumburg, IL 60173',
				role: 'hq',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
			{
				raw: TOWER_1450,
				role: 'associated',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		metadata: {
			industry: 'distribution_cooperative',
			sector: 'industrial_supplies',
			activeStatus: 'active',
			cage: '09RP0',
			duns: '082941204',
			schaumburgTowers: true,
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Ally Financial Inc.',
		slug: 'firm:ally-financial-inc',
		startDate: '1919',
		endDate: '',
		status: 'pinned',
		summary:
			'Digital financial services — auto finance/insurance, online banking (Ally Bank), consumer credit, corporate finance, securities brokerage/advisory. Founded 1919 as GMAC; public company (NYSE: ALLY), active. Occupies space in Schaumburg Towers (~55,000 SF on floors 15–17, occupied ~2022). Not primarily an RIA (no primary CRD).',
		aliases: [
			'ALLY FINANCIAL INC.',
			'Ally Financial',
			{ alias: 'GMAC', kind: 'former_name' },
			{ alias: 'ALLY', kind: 'ticker' },
		],
		locations: [
			{
				raw: 'Ally Detroit Center, 500 Woodward Ave. Floor 10, Detroit, MI 48226',
				role: 'hq',
				city: 'Detroit',
				state: 'MI',
				country: 'US',
			},
			{
				raw: '1400–1450 American Lane, floors 15–17, Schaumburg, IL 60173',
				role: 'branch',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		identifiers: [
			{ scheme: 'sec_cik', value: '0000040729' },
			{ scheme: 'ticker', value: 'ALLY' },
		],
		metadata: {
			industry: 'financial_services',
			sector: 'banking_auto_finance',
			activeStatus: 'active',
			schaumburgTowers: true,
			schaumburgOccupancyApprox: '2022',
			schaumburgSfApprox: 55000,
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'The Hartford Financial Services Group, Inc.',
		slug: 'firm:the-hartford-financial-services-group-inc',
		startDate: null,
		endDate: '',
		status: 'pinned',
		summary:
			'Major P&C and group-benefits insurer (HQ Hartford, CT). Reported in older lease comps at Schaumburg Towers (1400–1450 American Lane); exact current suite status not confirmed in recent free sources.',
		aliases: [
			'Hartford Financial Services Group',
			'The Hartford',
			{ alias: 'HIG', kind: 'ticker' },
		],
		locations: [
			{
				raw: 'Hartford, CT',
				role: 'hq',
				city: 'Hartford',
				state: 'CT',
				country: 'US',
			},
			{
				raw: COMPLEX,
				role: 'associated',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		identifiers: [{ scheme: 'sec_cik', value: '0000874766' }],
		metadata: {
			industry: 'insurance',
			sector: 'pc_group_benefits',
			activeStatus: 'active',
			schaumburgTowers: true,
			schaumburgOccupancy: 'older_lease_comps_unconfirmed',
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Swiss Re',
		slug: 'firm:swiss-re',
		startDate: null,
		endDate: '',
		status: 'pinned',
		summary:
			'Global reinsurer. Reported in older lease comps at Schaumburg Towers (1400–1450 American Lane); exact current suite status not confirmed in recent free sources.',
		aliases: [
			'Swiss Reinsurance Company',
			'Swiss Reinsurance Company Ltd',
			{ alias: 'Swiss Re Corporate Solutions', kind: 'name' },
		],
		locations: [
			{
				raw: 'Mythenquai 50/60, 8002 Zurich, Switzerland',
				role: 'hq',
				city: 'Zurich',
				country: 'CH',
			},
			{
				raw: COMPLEX,
				role: 'associated',
				city: 'Schaumburg',
				state: 'IL',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'Swiss Reinsurance Company Ltd',
				peerSlug: 'firm:swiss-reinsurance-company-ltd',
				relationType: 'business_tie',
				roleLabel: 'Related Swiss Re operating / legal entity',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			industry: 'reinsurance',
			sector: 'insurance',
			activeStatus: 'active',
			schaumburgTowers: true,
			schaumburgOccupancy: 'older_lease_comps_unconfirmed',
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	// --- stub tenants (thin public detail) ---
	{
		profileType: 'firm',
		name: 'J Power USA Development',
		slug: 'firm:j-power-usa-development',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private operating company; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'HYPERQUEST',
		slug: 'firm:hyperquest',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ADO Professional Solutions',
		slug: 'firm:ado-professional-solutions',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'American College of Occupational & Environmental Medicine',
		slug: 'firm:american-college-of-occupational-environmental-medicine',
		status: 'candidate',
		summary:
			'Professional/medical association (ACOEM). Appeared in commercial lease databases at Schaumburg Towers (1400–1450 American Lane). Current occupancy and suite not consistently detailed in free public sources.',
		aliases: [
			'American College of Occupational and Environmental Medicine',
			{ alias: 'ACOEM', kind: 'acronym' },
		],
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: {
			industry: 'professional_association',
			sector: 'occupational_medicine',
			schaumburgTowers: true,
			occupancySource: 'commercial_lease_databases',
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'AKKR',
		slug: 'firm:akkr',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Mario Tricoci',
		slug: 'firm:mario-tricoci',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant/brand presence. Private; specialization and current occupancy not consistently detailed in public filings.',
		aliases: ['Mario Tricoci Hair Salons and Day Spas'],
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: {
			industry: 'salon_spa',
			schaumburgTowers: true,
			occupancySource: 'commercial_lease_databases',
			building: COMPLEX,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ATC Operations',
		slug: 'firm:atc-operations',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'American Digital',
		slug: 'firm:american-digital',
		status: 'candidate',
		summary:
			'Appeared in commercial lease databases as a Schaumburg Towers (1400–1450 American Lane) tenant. Private; specialization and current occupancy not consistently detailed in public filings.',
		locations: [{ raw: COMPLEX, role: 'associated', city: 'Schaumburg', state: 'IL', country: 'US' }],
		metadata: { schaumburgTowers: true, occupancySource: 'commercial_lease_databases', building: COMPLEX },
		sourceCorpus: CORPUS,
	},
];

const results = [];
for (const item of batch) {
	const res = await upsertProfileTool({ ...item, dryRun });
	results.push(res.result);
	const label = res.result?.slug || item.name;
	console.log(
		`${res.ok ? 'OK' : 'ERR'} ${res.result?.action || ''} ${label} start=${res.result?.startDate ?? '—'} locs=${res.result?.locationsAdded ?? res.result?.locations ?? '—'} ids=${res.result?.identifiersAdded ?? res.result?.identifiers ?? '—'}`,
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
