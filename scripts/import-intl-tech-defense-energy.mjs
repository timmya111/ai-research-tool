#!/usr/bin/env node
/**
 * Non-US tech, defense, energy/OFS, cyber, and defense-tech startups /
 * public firms (Europe, Israel, China, etc.) with high-level summaries.
 *
 * Usage: node scripts/import-intl-tech-defense-energy.mjs [--dry-run]
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
const CORPUS = 'intl-tech-defense-energy-2026-11-23';

const metaBase = {
	intlTechDefenseEnergy: true,
	region: 'Non-US tech / defense / energy / cyber / defense-tech',
};

function loc(raw, role, city, country, state) {
	return {
		raw,
		role,
		city: city || null,
		country,
		...(state ? { state } : {}),
	};
}

function ticker(sym) {
	return { scheme: 'ticker', value: sym };
}

function url(u) {
	return { scheme: 'url', value: u };
}

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	// --- Defense / Aerospace primes ---
	{
		profileType: 'firm',
		name: 'Airbus SE',
		slug: 'firm:airbus-se',
		status: 'pinned',
		endDate: '',
		startDate: '1970',
		summary:
			'Trans-European commercial aerospace major (primarily France/Germany/Spain/Netherlands) with a significant defense and space division — military aircraft, helicopters, satellites, and related systems. Involved in European collaborative programs. Public peer to Boeing on the commercial side and to European defense primes on the military side.',
		aliases: ['Airbus', 'Airbus Group', 'EADS'],
		locations: [
			loc('Leiden, Netherlands', 'hq', 'Leiden', 'NL'),
			loc('Toulouse, France', 'associated', 'Toulouse', 'FR'),
			loc('Ottobrunn / Munich area, Germany', 'associated', 'Munich', 'DE'),
		],
		identifiers: [ticker('AIR'), url('https://www.airbus.com/')],
		metadata: {
			...metaBase,
			industry: 'aerospace',
			sector: 'commercial_and_defense',
			countries: ['NL', 'FR', 'DE', 'ES'],
			exchange: 'EURONEXT',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Leonardo S.p.A.',
		slug: 'firm:leonardo-spa',
		status: 'pinned',
		endDate: '',
		startDate: '1948',
		summary:
			'Italian diversified aerospace, defense, and security company (formerly Finmeccanica). Helicopters, electronics, and participation in Eurofighter and other joint programs. Growing defense revenue. Parent of Leonardo DRS in the U.S.',
		aliases: ['Leonardo', 'Leonardo SpA', 'Finmeccanica'],
		locations: [loc('Rome, Italy', 'hq', 'Rome', 'IT')],
		identifiers: [ticker('LDO'), url('https://www.leonardo.com/')],
		links: [
			{
				peerName: 'Leonardo DRS',
				peerSlug: 'firm:leonardo-drs',
				relationType: 'business_tie',
				roleLabel: 'Leonardo S.p.A. parent / Leonardo DRS U.S. unit',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			countries: ['IT'],
			exchange: 'BIT',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Thales S.A.',
		slug: 'firm:thales-sa',
		status: 'pinned',
		endDate: '',
		startDate: '2000',
		summary:
			'French aerospace, defense electronics, air defense, avionics, cyber, and secure communications company. Active in sensors, systems integration, and dual-use technologies. Public European defense-electronics peer.',
		aliases: ['Thales', 'Thales Group', 'Thomson-CSF'],
		locations: [loc('Paris / Meudon, France', 'hq', 'Paris', 'FR')],
		identifiers: [ticker('HO'), url('https://www.thalesgroup.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_electronics',
			countries: ['FR'],
			exchange: 'EURONEXT',
			note: 'Thales Group branding; Thomson-CSF lineage',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rheinmetall AG',
		slug: 'firm:rheinmetall-ag',
		status: 'pinned',
		endDate: '',
		startDate: '1889',
		summary:
			'German combat vehicles, ammunition, air defense, and land systems company. Expanded significantly amid increased European defense spending. Public European land-systems peer.',
		aliases: ['Rheinmetall'],
		locations: [loc('Düsseldorf, Germany', 'hq', 'Düsseldorf', 'DE')],
		identifiers: [ticker('RHM'), url('https://www.rheinmetall.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'land_systems',
			countries: ['DE'],
			exchange: 'XETRA',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Dassault Aviation S.A.',
		slug: 'firm:dassault-aviation-sa',
		status: 'pinned',
		endDate: '',
		startDate: '1929',
		summary:
			'French combat aircraft specialist; primary producer of the Rafale multirole fighter and related systems. Highly specialized European fighter OEM.',
		aliases: ['Dassault Aviation', 'Dassault'],
		locations: [loc('Paris / Saint-Cloud, France', 'hq', 'Saint-Cloud', 'FR')],
		identifiers: [ticker('AM'), url('https://www.dassault-aviation.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'combat_aircraft',
			countries: ['FR'],
			exchange: 'EURONEXT',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Elbit Systems Ltd.',
		slug: 'firm:elbit-systems-ltd',
		status: 'pinned',
		endDate: '',
		startDate: '1966',
		summary:
			'Israeli defense electronics and platforms company: C4I, drones, electronic warfare, and related systems. High percentage of revenue from defense. Parent of Elbit Systems of America (U.S.).',
		aliases: ['Elbit Systems', 'Elbit'],
		locations: [loc('Haifa, Israel', 'hq', 'Haifa', 'IL')],
		identifiers: [ticker('ESLT'), url('https://elbitsystems.com/')],
		links: [
			{
				peerName: 'Elbit Systems of America',
				peerSlug: 'firm:elbit-systems-of-america',
				relationType: 'business_tie',
				roleLabel: 'Elbit Systems Ltd. parent / Elbit Systems of America U.S. unit',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_electronics',
			countries: ['IL'],
			exchange: 'NASDAQ',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'MBDA',
		slug: 'firm:mbda',
		status: 'pinned',
		endDate: '',
		startDate: '2001',
		summary:
			'Trans-European missile systems company (joint venture of Airbus, BAE Systems, and Leonardo lineages). Designs and produces guided missiles and missile systems for European and export customers.',
		aliases: ['MBDA Missile Systems'],
		locations: [
			loc('Le Plessis-Robinson, France', 'hq', 'Le Plessis-Robinson', 'FR'),
			loc('Stevenage, United Kingdom', 'associated', 'Stevenage', 'GB'),
			loc('Rome, Italy', 'associated', 'Rome', 'IT'),
		],
		identifiers: [url('https://www.mbda-systems.com/')],
		links: [
			{
				peerName: 'Airbus SE',
				peerSlug: 'firm:airbus-se',
				relationType: 'business_tie',
				roleLabel: 'MBDA shareholder / European missile JV partner lineage',
				createPeerIfMissing: false,
			},
			{
				peerName: 'BAE Systems',
				peerSlug: 'firm:bae-systems',
				relationType: 'business_tie',
				roleLabel: 'MBDA shareholder / European missile JV partner lineage',
				createPeerIfMissing: false,
			},
			{
				peerName: 'Leonardo S.p.A.',
				peerSlug: 'firm:leonardo-spa',
				relationType: 'business_tie',
				roleLabel: 'MBDA shareholder / European missile JV partner lineage',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'missiles',
			countries: ['FR', 'GB', 'IT', 'DE'],
			ownership: 'joint_venture',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Naval Group',
		slug: 'firm:naval-group',
		status: 'pinned',
		endDate: '',
		startDate: '1631',
		summary:
			'French naval defense company (formerly DCNS). Designs and builds submarines, surface combatants, and related naval systems for France and export customers.',
		aliases: ['DCNS', 'Direction des Constructions Navales'],
		locations: [loc('Paris / Cherbourg / Lorient, France', 'hq', 'Paris', 'FR')],
		identifiers: [url('https://www.naval-group.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'naval_systems',
			countries: ['FR'],
			ownership: 'state_linked',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Aviation Industry Corporation of China',
		slug: 'firm:avic',
		status: 'pinned',
		endDate: '',
		startDate: '2008',
		summary:
			'Chinese state-owned aerospace and defense conglomerate (AVIC). Military and civil aviation manufacturing and related systems. Major PRC military-aviation industrial group.',
		aliases: ['AVIC', '中国航空工业集团'],
		locations: [loc('Beijing, China', 'hq', 'Beijing', 'CN')],
		identifiers: [url('https://www.avic.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'military_aviation',
			countries: ['CN'],
			ownership: 'state_owned',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'China North Industries Group Corporation Limited',
		slug: 'firm:norinco-group',
		status: 'pinned',
		endDate: '',
		startDate: '1980',
		summary:
			'Chinese state-owned defense conglomerate (NORINCO Group). Land systems, munitions, and related military equipment. Major PRC land-systems industrial group.',
		aliases: ['NORINCO', 'Norinco', '中国兵器工业集团'],
		locations: [loc('Beijing, China', 'hq', 'Beijing', 'CN')],
		identifiers: [url('http://www.norinco.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'land_systems',
			countries: ['CN'],
			ownership: 'state_owned',
		},
		sourceCorpus: CORPUS,
	},

	// --- Energy / OFS ---
	{
		profileType: 'firm',
		name: 'Saipem S.p.A.',
		slug: 'firm:saipem-spa',
		status: 'pinned',
		endDate: '',
		startDate: '1957',
		summary:
			'Italian engineering, procurement, construction, and installation contractor focused on offshore platforms, pipelines, subsea systems, and drilling. Large backlog in energy infrastructure; also active in some energy-transition work. Public offshore/subsea peer to TechnipFMC.',
		aliases: ['Saipem', 'Saipem SpA'],
		locations: [loc('Milan / San Donato Milanese, Italy', 'hq', 'San Donato Milanese', 'IT')],
		identifiers: [ticker('SPM'), url('https://www.saipem.com/')],
		links: [
			{
				peerName: 'TechnipFMC plc',
				peerSlug: 'firm:technipfmc-plc',
				relationType: 'business_tie',
				roleLabel: 'Offshore / subsea EPCI peer',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'offshore_epci',
			countries: ['IT'],
			exchange: 'BIT',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'China Oilfield Services Limited',
		slug: 'firm:china-oilfield-services-limited',
		status: 'pinned',
		endDate: '',
		startDate: '2001',
		summary:
			'Chinese integrated oilfield services provider (COSL): geophysical services, drilling, well services, and marine support, with significant offshore activity. Public OFS peer with China focus; CNOOC-linked lineage.',
		aliases: ['COSL', 'China Oilfield Services', '中海油田服务'],
		locations: [loc('Beijing / Tianjin, China', 'hq', 'Beijing', 'CN')],
		identifiers: [ticker('2883'), url('https://www.cosl.com.cn/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'oilfield_services',
			countries: ['CN'],
			exchange: 'HKEX',
		},
		sourceCorpus: CORPUS,
	},

	// --- Cyber ---
	{
		profileType: 'firm',
		name: 'Check Point Software Technologies Ltd.',
		slug: 'firm:check-point-software-technologies-ltd',
		status: 'pinned',
		endDate: '',
		startDate: '1993',
		summary:
			'Israeli cybersecurity company providing firewalls, network security, and broader enterprise/government protection platforms. Long-standing public pure-play cyber vendor (CHKP).',
		aliases: ['Check Point', 'Check Point Software', 'Check Point Software Technologies'],
		locations: [loc('Tel Aviv, Israel', 'hq', 'Tel Aviv', 'IL')],
		identifiers: [ticker('CHKP'), url('https://www.checkpoint.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'network_security',
			countries: ['IL'],
			exchange: 'NASDAQ',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Darktrace plc',
		slug: 'firm:darktrace-plc',
		status: 'pinned',
		endDate: '',
		startDate: '2013',
		summary:
			'UK AI-powered threat detection and autonomous response platform (network, email, cloud). Founded in Cambridge; known for machine-learning approaches to anomalous activity. Taken private by Thoma Bravo (no longer a public pure-play).',
		aliases: ['Darktrace'],
		locations: [loc('Cambridge, United Kingdom', 'hq', 'Cambridge', 'GB')],
		identifiers: [url('https://www.darktrace.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'ai_threat_detection',
			countries: ['GB'],
			ownership: 'private',
			formerPublic: true,
			acquirer: 'Thoma Bravo',
		},
		sourceCorpus: CORPUS,
	},

	// --- Defense-tech startups (Europe) ---
	{
		profileType: 'firm',
		name: 'Helsing GmbH',
		slug: 'firm:helsing-gmbh',
		status: 'pinned',
		endDate: '',
		startDate: '2021',
		summary:
			'German AI software and autonomous systems company (including strike drones) for multi-domain defense applications. One of Europe’s highest-valued defense-tech startups.',
		aliases: ['Helsing', 'Helsing AI'],
		locations: [
			loc('Munich, Germany', 'hq', 'Munich', 'DE'),
			loc('Berlin, Germany', 'associated', 'Berlin', 'DE'),
		],
		identifiers: [url('https://helsing.ai/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_tech',
			countries: ['DE'],
			ownership: 'private',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'ICEYE Oy',
		slug: 'firm:iceye-oy',
		status: 'pinned',
		endDate: '',
		startDate: '2014',
		summary:
			'Finnish synthetic-aperture radar (SAR) satellite constellation company for all-weather imaging and monitoring, with defense and dual-use applications. Leading European New Space ISR player.',
		aliases: ['ICEYE', 'Iceye'],
		locations: [loc('Espoo, Finland', 'hq', 'Espoo', 'FI')],
		identifiers: [url('https://www.iceye.com/')],
		metadata: {
			...metaBase,
			industry: 'aerospace',
			sector: 'sar_satellites_isr',
			countries: ['FI'],
			ownership: 'private',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Quantum Systems GmbH',
		slug: 'firm:quantum-systems-gmbh',
		status: 'pinned',
		endDate: '',
		startDate: '2015',
		summary:
			'German software-defined autonomous aerial and ground systems for reconnaissance and dual-use missions. European defense-tech UAV/UGV startup.',
		aliases: ['Quantum Systems', 'Quantum-Systems'],
		locations: [loc('Gilching / Munich area, Germany', 'hq', 'Gilching', 'DE')],
		identifiers: [url('https://quantum-systems.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_tech_uav',
			countries: ['DE'],
			ownership: 'private',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'STARK Defence',
		slug: 'firm:stark-defence',
		status: 'pinned',
		endDate: '',
		startDate: '2024',
		summary:
			'German defense-tech firm focused on loitering munitions, attack drones, and unmanned systems (STARK / related European drone startups). Part of the rising European unmanned-strike cohort.',
		aliases: ['STARK', 'Stark Defence', 'STARK Defense'],
		locations: [loc('Germany', 'hq', null, 'DE')],
		identifiers: [url('https://www.stark-defence.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'loitering_munitions_uav',
			countries: ['DE'],
			ownership: 'private',
		},
		sourceCorpus: CORPUS,
	},

	// --- Research / collaborative framing event ---
	{
		profileType: 'historic_event',
		name: 'European Collaborative Aerospace & Defense Programs',
		slug: 'historic_event:european-collaborative-aerospace-defense-programs',
		status: 'pinned',
		startDate: '1969',
		summary:
			'Umbrella for collaborative European aerospace and defense programs (Eurofighter Typhoon, missile JVs such as MBDA lineage, Airbus defense/space projects, and related applied research). Involves primes including Airbus, BAE Systems, Leonardo, and others; typically government-affiliated research labs and university centers feed dual-use tech into these programs.',
		locations: [
			loc('Europe (multi-country)', 'associated', null, 'EU'),
			loc('United Kingdom', 'associated', null, 'GB'),
			loc('France', 'associated', null, 'FR'),
			loc('Germany', 'associated', null, 'DE'),
			loc('Italy', 'associated', null, 'IT'),
			loc('Spain', 'associated', null, 'ES'),
		],
		metadata: { ...metaBase, industry: 'defense', sector: 'collaborative_programs' },
		sourceCorpus: CORPUS,
	},
];

/** Enrich existing cards with international framing / tickers / summaries. */
const enrichExisting = [
	{
		slug: 'firm:bae-systems',
		name: 'BAE Systems plc',
		status: 'pinned',
		endDate: '',
		startDate: '1999',
		summary:
			'Europe’s largest defense contractor (UK). Combat vehicles, naval platforms, electronic systems, and programs such as the Eurofighter Typhoon. Strong UK and international markets; high share of revenue from defense. Also maintains significant U.S. / Texas presence among other locations.',
		aliases: ['BAE Systems', 'BAE'],
		locations: [
			loc('London / Farnborough, United Kingdom', 'hq', 'London', 'GB'),
			loc('United States (incl. Texas operations)', 'associated', null, 'US'),
		],
		identifiers: [ticker('BA'), url('https://www.baesystems.com/')],
		links: [
			{
				peerName: 'European Collaborative Aerospace & Defense Programs',
				peerSlug: 'historic_event:european-collaborative-aerospace-defense-programs',
				peerType: 'historic_event',
				relationType: 'participated_in',
				roleLabel: 'Eurofighter / European collaborative programs participant',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			countries: ['GB'],
			exchange: 'LSE',
		},
	},
	{
		slug: 'firm:saab-ab',
		name: 'Saab AB',
		status: 'pinned',
		endDate: '',
		startDate: '1937',
		summary:
			'Swedish defense and security company. Combat aircraft (Gripen), sensors, missiles, and related systems. Strong focus on advanced electronics and platforms. Public European fighter/electronics peer.',
		aliases: ['Saab', 'SAAB'],
		locations: [loc('Stockholm, Sweden', 'hq', 'Stockholm', 'SE')],
		identifiers: [ticker('SAAB-B'), url('https://www.saab.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			countries: ['SE'],
			exchange: 'OMX',
		},
	},
	{
		slug: 'firm:technipfmc-plc',
		name: 'TechnipFMC plc',
		status: 'pinned',
		endDate: '',
		summary:
			'UK/France-linked public subsea and surface energy technology company. Subsea trees, manifolds, and integrated offshore project delivery for deepwater developments worldwide. Major non-U.S. OFS/subsea peer alongside Saipem.',
		locations: [
			loc('Newcastle upon Tyne / London, United Kingdom', 'associated', 'Newcastle upon Tyne', 'GB'),
			loc('Paris, France', 'associated', 'Paris', 'FR'),
			loc('Houston, TX, United States', 'associated', 'Houston', 'US', 'TX'),
		],
		identifiers: [ticker('FTI'), url('https://www.technipfmc.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'subsea_surface_equipment',
			countries: ['GB', 'FR', 'US'],
			exchange: 'NYSE',
		},
	},
	{
		slug: 'firm:elbit-systems-of-america',
		name: 'Elbit Systems of America',
		status: 'pinned',
		endDate: '',
		summary:
			'U.S. subsidiary of Israel’s Elbit Systems Ltd. Defense electronics and platforms for U.S. customers; Texas and other U.S. facilities. Link to Israeli parent for international defense-electronics context.',
		links: [
			{
				peerName: 'Elbit Systems Ltd.',
				peerSlug: 'firm:elbit-systems-ltd',
				relationType: 'owned_by',
				roleLabel: 'Elbit Systems of America owned by Elbit Systems Ltd. (Israel)',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_electronics',
			countries: ['US', 'IL'],
		},
	},
	{
		slug: 'firm:leonardo-drs',
		name: 'Leonardo DRS',
		status: 'pinned',
		endDate: '',
		summary:
			'U.S. defense electronics and systems company; Leonardo S.p.A. (Italy) affiliate/unit serving U.S. defense customers.',
		links: [
			{
				peerName: 'Leonardo S.p.A.',
				peerSlug: 'firm:leonardo-spa',
				relationType: 'owned_by',
				roleLabel: 'Leonardo DRS owned by / affiliated with Leonardo S.p.A. (Italy)',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_electronics',
			countries: ['US', 'IT'],
		},
	},
	{
		slug: 'firm:airbus-defence-and-space-gmbh',
		name: 'Airbus Defence and Space GmbH',
		status: 'pinned',
		endDate: '',
		summary:
			'German Airbus defence and space unit. Military aircraft, space systems, and related programs within the Airbus SE group.',
		links: [
			{
				peerName: 'Airbus SE',
				peerSlug: 'firm:airbus-se',
				relationType: 'owned_by',
				roleLabel: 'Airbus Defence and Space unit owned by Airbus SE',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_defense_space',
			countries: ['DE'],
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

console.log(`Intl tech/defense/energy import (${dryRun ? 'DRY RUN' : 'live'}) — corpus ${CORPUS}`);
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
