#!/usr/bin/env node
/**
 * Statewide TX/OK notables across creditors’ rights, oil & gas, tech/cyber,
 * physical security, and defense/aerospace (hubs + representative majors).
 *
 * Usage: node scripts/import-tx-ok-statewide-notables.mjs [--dry-run]
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
const CORPUS = 'tx-ok-statewide-notables-2026-11-23';
const LBN = 'firm:love-beal-nixon-p-c';

const regionMeta = {
	txOkStatewide: true,
	region: 'Texas and Oklahoma statewide overview (major hubs)',
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
	// --- Collections / creditors’ rights (TX beyond DFW corridor import) ---
	{
		profileType: 'firm',
		name: 'Bell Nunnally & Martin LLP',
		slug: 'firm:bell-nunnally-martin-llp',
		status: 'pinned',
		endDate: '',
		startDate: '1980',
		summary:
			'Dallas commercial litigation and business law firm; creditors’ rights and collections work among broader commercial practice. Statewide TX peer category to Love, Beal & Nixon.',
		aliases: ['Bell Nunnally', 'Bell Nunnally & Martin'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		links: [peerLbn('TX creditors rights / commercial collections peer (Dallas)')],
		metadata: { ...regionMeta, industry: 'law', sector: 'creditors_rights_collections', state: 'TX' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Cain & Skarnulis PLLC',
		slug: 'firm:cain-skarnulis-pllc',
		status: 'pinned',
		endDate: '',
		summary:
			'Austin creditors’ rights, foreclosure, bankruptcy, and judgment enforcement practice. Texas collections peer category to Love, Beal & Nixon.',
		aliases: ['Cain & Skarnulis', 'Cain and Skarnulis'],
		locations: [loc('Austin, TX', 'hq', 'Austin', 'TX', 'Travis')],
		links: [peerLbn('TX creditors rights peer (Austin)')],
		metadata: { ...regionMeta, industry: 'law', sector: 'creditors_rights_collections', state: 'TX' },
		sourceCorpus: CORPUS,
	},

	// --- Oil & Gas / Energy — Texas ---
	{
		profileType: 'firm',
		name: 'Exxon Mobil Corporation',
		slug: 'firm:exxon-mobil-corporation',
		status: 'pinned',
		endDate: '',
		startDate: '1999-11-30',
		summary:
			'Integrated oil and gas major. Houston-area headquarters (Spring / Houston metro). Dominant U.S. energy player with Texas upstream, refining, and chemicals footprint. Standard Oil lineage; Exxon–Mobil merger 1999.',
		aliases: ['ExxonMobil', 'Exxon Mobil', 'ExxonMobil Corporation'],
		locations: [
			loc('22777 Springwoods Village Parkway, Spring, TX', 'hq', 'Spring', 'TX', 'Harris'),
			loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris'),
		],
		identifiers: [{ scheme: 'url', value: 'https://corporate.exxonmobil.com/' }],
		metadata: {
			...regionMeta,
			industry: 'oil_gas',
			sector: 'integrated_major',
			state: 'TX',
			cik: '0000034088',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ConocoPhillips',
		slug: 'firm:conocophillips',
		status: 'pinned',
		endDate: '',
		startDate: '2002',
		summary:
			'Houston-headquartered independent E&P major. Significant Permian and other U.S. shale operations; Texas energy hub fixture.',
		aliases: ['ConocoPhillips Company'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.conocophillips.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'ep_major', state: 'TX', cik: '0001163165' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Phillips 66',
		slug: 'firm:phillips-66',
		status: 'pinned',
		endDate: '',
		startDate: '2012-04-30',
		summary:
			'Houston refining, midstream, and chemicals company spun from ConocoPhillips. Major Texas Gulf Coast refining presence.',
		aliases: ['Phillips 66 Company'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.phillips66.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'refining_midstream', state: 'TX', cik: '0001534701' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Enterprise Products Partners L.P.',
		slug: 'firm:enterprise-products-partners-lp',
		status: 'pinned',
		endDate: '',
		startDate: '1968',
		summary:
			'Houston midstream MLP — NGL, crude, natural gas, and petrochemical pipelines and storage across Texas and the Gulf Coast.',
		aliases: ['Enterprise Products Partners', 'Enterprise Products'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.enterpriseproducts.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'midstream', state: 'TX', cik: '0001061219' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Occidental Petroleum Corporation',
		slug: 'firm:occidental-petroleum-corporation',
		status: 'pinned',
		endDate: '',
		startDate: '1920',
		summary:
			'Houston-based E&P major with large Permian Basin position. Texas energy headquarters presence.',
		aliases: ['Occidental Petroleum', 'Oxy'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.oxy.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'ep_major', state: 'TX', cik: '0000797468' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Baker Hughes Company',
		slug: 'firm:baker-hughes-company',
		status: 'pinned',
		endDate: '',
		startDate: '1907',
		summary:
			'Houston oilfield services and energy technology company (Baker Hughes / SLB peer set). Major Texas OFS headquarters.',
		aliases: ['Baker Hughes', 'Baker Hughes a GE company'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.bakerhughes.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'oilfield_services', state: 'TX', cik: '0001701605' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Kinder Morgan, Inc.',
		slug: 'firm:kinder-morgan-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1997',
		summary:
			'Houston midstream infrastructure company — pipelines and terminals for natural gas, products, and CO2. Large Texas footprint.',
		aliases: ['Kinder Morgan'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.kindermorgan.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'midstream', state: 'TX', cik: '0001506307' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Cheniere Energy, Inc.',
		slug: 'firm:cheniere-energy-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1996',
		summary:
			'Houston LNG export company (Sabine Pass, Corpus Christi). Leading U.S. LNG developer with Texas Gulf Coast terminals.',
		aliases: ['Cheniere Energy', 'Cheniere'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.cheniere.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'lng', state: 'TX', cik: '0000003570' },
		sourceCorpus: CORPUS,
	},

	// --- Oil & Gas / Energy — Oklahoma ---
	{
		profileType: 'firm',
		name: 'ONEOK, Inc.',
		slug: 'firm:oneok-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1906',
		summary:
			'Tulsa midstream company focused on natural gas gathering, processing, and NGL pipelines. Major Oklahoma energy headquarters.',
		aliases: ['ONEOK', 'Oneok'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'OK', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.oneok.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'midstream', state: 'OK', cik: '0000059478' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'The Williams Companies, Inc.',
		slug: 'firm:williams-companies-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1908',
		summary:
			'Tulsa natural gas infrastructure company (Transco and related systems). Core Oklahoma midstream headquarters.',
		aliases: ['Williams Companies', 'Williams', 'The Williams Companies'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'OK', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.williams.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'midstream', state: 'OK', cik: '0000107263' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Helmerich & Payne, Inc.',
		slug: 'firm:helmerich-payne-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1920',
		summary:
			'Tulsa land drilling contractor. Major Oklahoma oilfield services headquarters with nationwide land rig fleet.',
		aliases: ['Helmerich & Payne', 'Helmerich and Payne', 'H&P'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'OK', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.helmerichpayne.com/' }],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'drilling', state: 'OK', cik: '0000046765' },
		sourceCorpus: CORPUS,
	},

	// --- Tech / Cybersecurity ---
	{
		profileType: 'firm',
		name: 'Dell Technologies Inc.',
		slug: 'firm:dell-technologies-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1984-02-01',
		summary:
			'Round Rock, Texas PC, server, and IT infrastructure company. Anchor of Austin–Round Rock tech cluster.',
		aliases: ['Dell', 'Dell Technologies', 'Dell Inc.'],
		locations: [loc('Round Rock, TX', 'hq', 'Round Rock', 'TX', 'Williamson')],
		identifiers: [{ scheme: 'url', value: 'https://www.dell.com/' }],
		metadata: { ...regionMeta, industry: 'tech', sector: 'hardware_it', state: 'TX', cik: '0001571996' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Critical Start, Inc.',
		slug: 'firm:critical-start-inc',
		status: 'pinned',
		endDate: '',
		summary:
			'Texas cybersecurity / MDR and managed detection firm with DFW-area presence. Part of North Texas cyber cluster alongside Trellix, Securonix, Zimperium.',
		aliases: ['Critical Start'],
		locations: [loc('Plano, TX', 'hq', 'Plano', 'TX', 'Collin')],
		metadata: { ...regionMeta, industry: 'cybersecurity', sector: 'mdr_mssp', state: 'TX' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Securonix, Inc.',
		slug: 'firm:securonix-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2008',
		summary:
			'SIEM / UEBA cybersecurity platform with significant Texas (DFW) presence. Enterprise security analytics.',
		aliases: ['Securonix'],
		locations: [loc('Plano, TX', 'associated', 'Plano', 'TX', 'Collin')],
		identifiers: [{ scheme: 'url', value: 'https://www.securonix.com/' }],
		metadata: { ...regionMeta, industry: 'cybersecurity', sector: 'siem_ueba', state: 'TX' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Zimperium, Inc.',
		slug: 'firm:zimperium-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2010',
		summary:
			'Dallas mobile threat defense / mobile security company. Part of DFW cybersecurity cluster.',
		aliases: ['Zimperium'],
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		identifiers: [{ scheme: 'url', value: 'https://www.zimperium.com/' }],
		metadata: { ...regionMeta, industry: 'cybersecurity', sector: 'mobile_security', state: 'TX' },
		sourceCorpus: CORPUS,
	},

	// --- Physical security ---
	{
		profileType: 'firm',
		name: 'Allied Universal',
		slug: 'firm:allied-universal',
		status: 'pinned',
		endDate: '',
		startDate: '1957',
		summary:
			'National private security and facility services company with extensive Texas and Oklahoma metro operations (guards, patrol, systems). Formed via AlliedBarton / Universal Services lineage.',
		aliases: ['Allied Universal Security Services', 'AlliedBarton'],
		locations: [
			loc('Houston, TX', 'associated', 'Houston', 'TX'),
			loc('Dallas, TX', 'associated', 'Dallas', 'TX'),
			loc('Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK'),
		],
		identifiers: [{ scheme: 'url', value: 'https://www.aus.com/' }],
		metadata: { ...regionMeta, industry: 'security', sector: 'private_security_guards', states: ['TX', 'OK'] },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Securitas AB',
		slug: 'firm:securitas-ab',
		status: 'pinned',
		endDate: '',
		startDate: '1934',
		summary:
			'Global private security company with large U.S. guarding and electronic security operations including Texas and Oklahoma metros.',
		aliases: ['Securitas', 'Securitas Security Services USA'],
		locations: [
			loc('Houston, TX', 'associated', 'Houston', 'TX'),
			loc('Dallas, TX', 'associated', 'Dallas', 'TX'),
			loc('Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK'),
		],
		identifiers: [{ scheme: 'url', value: 'https://www.securitas.com/' }],
		metadata: { ...regionMeta, industry: 'security', sector: 'private_security_guards', states: ['TX', 'OK'] },
		sourceCorpus: CORPUS,
	},

	// --- Defense / Aerospace — Texas ---
	{
		profileType: 'firm',
		name: 'Anduril Industries, Inc.',
		slug: 'firm:anduril-industries-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2017',
		summary:
			'Defense-tech company (autonomous systems, Lattice software). Expanding Texas presence among next-gen defense primes alongside traditional DFW aerospace.',
		aliases: ['Anduril', 'Anduril Industries'],
		locations: [loc('Texas, US', 'associated', null, 'TX')],
		identifiers: [{ scheme: 'url', value: 'https://www.anduril.com/' }],
		metadata: { ...regionMeta, industry: 'defense', sector: 'defense_tech', state: 'TX' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Axiom Space, Inc.',
		slug: 'firm:axiom-space-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2016',
		summary:
			'Houston commercial space station and human spaceflight company. Core of Houston space / aerospace cluster.',
		aliases: ['Axiom Space'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.axiomspace.com/' }],
		metadata: { ...regionMeta, industry: 'aerospace', sector: 'commercial_space', state: 'TX' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Intuitive Machines, Inc.',
		slug: 'firm:intuitive-machines-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2013',
		summary:
			'Houston lunar lander and space services company (Nasdaq: LUNR). Part of Houston commercial space cluster.',
		aliases: ['Intuitive Machines'],
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		identifiers: [{ scheme: 'url', value: 'https://www.intuitivemachines.com/' }],
		metadata: { ...regionMeta, industry: 'aerospace', sector: 'commercial_space', state: 'TX', cik: '0001844452' },
		sourceCorpus: CORPUS,
	},

	// --- Defense / Aerospace — Oklahoma ---
	{
		profileType: 'historic_event',
		name: 'Tinker Air Force Base Aerospace & Defense Sustainment Hub',
		slug: 'historic_event:tinker-afb-aerospace-defense-hub',
		status: 'pinned',
		startDate: '1941',
		summary:
			'Oklahoma City–area aerospace and defense sustainment hub centered on Tinker AFB (major depot/maintenance). Anchors Pratt & Whitney military engines work and a broad contractor/supplier base across Oklahoma.',
		locations: [loc('Tinker AFB / Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK', 'Oklahoma')],
		metadata: { ...regionMeta, industry: 'defense', sector: 'aerospace_mro_depot', state: 'OK' },
		sourceCorpus: CORPUS,
	},
];

/** Existing profiles: fill missing start dates / clear bad ends / add statewide meta without clobbering summaries. */
const enrichExisting = [
	{
		slug: 'firm:eog-resources-inc',
		name: 'EOG Resources, Inc.',
		startDate: '1999',
		endDate: '',
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'ep_independent', state: 'TX' },
	},
	{
		slug: 'firm:energy-transfer',
		name: 'Energy Transfer LP',
		startDate: '1996',
		endDate: '',
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'midstream', state: 'TX' },
	},
	{
		slug: 'firm:hf-sinclair',
		name: 'HF Sinclair Corporation',
		startDate: '1947',
		endDate: '',
		locations: [loc('Dallas, TX', 'hq', 'Dallas', 'TX', 'Dallas')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'refining', state: 'TX' },
	},
	{
		slug: 'firm:continental-resources-inc',
		name: 'Continental Resources, Inc.',
		startDate: '1967',
		endDate: '',
		locations: [loc('Oklahoma City, OK', 'hq', 'Oklahoma City', 'OK', 'Oklahoma')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'ep_independent', state: 'OK' },
	},
	{
		slug: 'firm:chevron-corporation',
		name: 'Chevron Corporation',
		endDate: '',
		locations: [loc('Houston, TX', 'associated', 'Houston', 'TX', 'Harris')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'integrated_major', state: 'TX' },
	},
	{
		slug: 'firm:halliburton',
		name: 'Halliburton Company',
		endDate: '',
		locations: [loc('Houston, TX', 'hq', 'Houston', 'TX', 'Harris')],
		metadata: { ...regionMeta, industry: 'oil_gas', sector: 'oilfield_services', state: 'TX' },
	},
	{
		slug: 'firm:lockheed-martin-corporation',
		name: 'Lockheed Martin Corporation',
		endDate: '',
		locations: [
			loc('Fort Worth, TX', 'associated', 'Fort Worth', 'TX', 'Tarrant'),
			loc('Grand Prairie, TX', 'associated', 'Grand Prairie', 'TX', 'Dallas'),
		],
		metadata: { ...regionMeta, industry: 'defense', sector: 'aerospace_prime', state: 'TX' },
	},
	{
		slug: 'firm:bell-textron',
		name: 'Bell Textron Inc.',
		endDate: '',
		metadata: { ...regionMeta, industry: 'defense', sector: 'rotorcraft', state: 'TX' },
	},
	{
		slug: 'firm:l3harris',
		name: 'L3Harris Technologies, Inc.',
		endDate: '',
		metadata: { ...regionMeta, industry: 'defense', sector: 'aerospace_electronics', state: 'TX' },
	},
	{
		slug: 'firm:elbit-systems-of-america',
		name: 'Elbit Systems of America',
		endDate: '',
		startDate: '2000',
		metadata: { ...regionMeta, industry: 'defense', sector: 'defense_electronics', state: 'TX' },
	},
	{
		slug: 'firm:northrop-grumman',
		name: 'Northrop Grumman Corporation',
		endDate: '',
		startDate: '1994',
		metadata: { ...regionMeta, industry: 'defense', sector: 'aerospace_prime', state: 'TX' },
	},
	{
		slug: 'firm:bae-systems',
		name: 'BAE Systems',
		endDate: '',
		startDate: '1999',
		metadata: { ...regionMeta, industry: 'defense', sector: 'aerospace_prime', state: 'TX' },
	},
	{
		slug: 'firm:pratt-whitney',
		name: 'Pratt & Whitney',
		endDate: '',
		startDate: '1925',
		locations: [loc('Oklahoma City, OK', 'associated', 'Oklahoma City', 'OK', 'Oklahoma')],
		metadata: { ...regionMeta, industry: 'aerospace', sector: 'engines_mro', state: 'OK' },
		links: [
			{
				peerName: 'Tinker Air Force Base Aerospace & Defense Sustainment Hub',
				peerSlug: 'historic_event:tinker-afb-aerospace-defense-hub',
				peerType: 'historic_event',
				relationType: 'participated_in',
				roleLabel: 'Military engines sustainment (OKC / Tinker hub)',
				createPeerIfMissing: false,
			},
		],
	},
	{
		slug: 'firm:trellix',
		name: 'Trellix',
		endDate: '',
		startDate: '2022',
		locations: [loc('Plano, TX', 'associated', 'Plano', 'TX', 'Collin')],
		metadata: { ...regionMeta, industry: 'cybersecurity', sector: 'endpoint_xdr', state: 'TX' },
	},
	{
		slug: 'firm:spacex',
		name: 'Space Exploration Technologies Corp.',
		endDate: '',
		locations: [loc('Starbase / Boca Chica, TX', 'associated', 'Brownsville', 'TX', 'Cameron')],
		metadata: { ...regionMeta, industry: 'aerospace', sector: 'launch', state: 'TX' },
	},
	{
		slug: 'firm:pope-hardwicke-christie-schell-kelly-taplett',
		name: 'Pope, Hardwicke, Christie, Schell, Kelly & Taplett, L.L.P.',
		endDate: '',
		links: [peerLbn('TX creditors rights peer (Fort Worth)')],
		metadata: { ...regionMeta, industry: 'law', sector: 'creditors_rights', state: 'TX' },
	},
	{
		slug: 'firm:blenden-roth-law-firm',
		name: 'Blenden Roth Law Firm',
		endDate: '',
		links: [peerLbn('TX creditors rights peer (Bedford)')],
		metadata: { ...regionMeta, industry: 'law', sector: 'creditors_rights_collections', state: 'TX' },
	},
	{
		slug: 'firm:raytheon',
		name: 'Raytheon (RTX)',
		endDate: '',
		startDate: '1922',
		locations: [loc('McKinney, TX', 'associated', 'McKinney', 'TX', 'Collin')],
		metadata: { ...regionMeta, industry: 'defense', sector: 'missiles_sensors', state: 'TX' },
	},
];

async function runOne(args, label) {
	if (dryRun) {
		console.log(`[dry-run] ${label}: ${args.slug || args.name}`);
		return { ok: true };
	}
	const res = await upsertProfileTool(args);
	const status = res?.ok ? 'ok' : 'fail';
	console.log(`[${status}] ${label}: ${args.slug || args.name}${res?.error ? ' — ' + res.error : ''}`);
	return res;
}

console.log(`TX/OK statewide notables import (${dryRun ? 'DRY RUN' : 'live'}) — corpus ${CORPUS}`);
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
