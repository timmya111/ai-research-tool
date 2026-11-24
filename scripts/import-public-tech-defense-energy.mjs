#!/usr/bin/env node
/**
 * Public tech, defense, energy, and cybersecurity companies (plus notable
 * private defense-tech) with TX/OK/NM-relevant summaries and tickers.
 *
 * Usage: node scripts/import-public-tech-defense-energy.mjs [--dry-run]
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
const CORPUS = 'public-tech-defense-energy-2026-11-23';

const metaBase = {
	publicTechDefenseEnergy: true,
	txOkStatewide: true,
	region: 'Public tech / defense / energy / cyber (TX–OK–NM relevant)',
};

function loc(raw, role, city, state, county) {
	return {
		raw,
		role,
		city: city || null,
		state,
		country: 'US',
		...(county ? { county } : {}),
	};
}

function ticker(sym) {
	return { scheme: 'ticker', value: sym };
}

function url(u) {
	return { scheme: 'url', value: u };
}

/** New cards (missing or thin). */
/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const createBatch = [
	{
		profileType: 'firm',
		name: 'CrowdStrike Holdings, Inc.',
		slug: 'firm:crowdstrike-holdings-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2011',
		summary:
			'Cloud-native endpoint security, threat intelligence, and XDR platform (Falcon). Austin headquarters. Widely used by enterprises and government; public cybersecurity peer (CRWD) with strong Texas presence.',
		aliases: ['CrowdStrike', 'CrowdStrike Holdings', 'CrowdStrike, Inc.'],
		locations: [loc('Austin, TX', 'hq', 'Austin', 'TX', 'Travis')],
		identifiers: [ticker('CRWD'), url('https://www.crowdstrike.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'endpoint_xdr',
			state: 'TX',
			exchange: 'NASDAQ',
			cik: '0001535527',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Fortinet, Inc.',
		slug: 'firm:fortinet-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2000',
		summary:
			'Public cybersecurity company (FTNT) providing network security, firewalls, and broader security fabric (hardware + software). Enterprise and government customers; peer to Palo Alto Networks and CrowdStrike.',
		aliases: ['Fortinet'],
		locations: [loc('Sunnyvale, CA', 'hq', 'Sunnyvale', 'CA', 'Santa Clara')],
		identifiers: [ticker('FTNT'), url('https://www.fortinet.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'network_security',
			state: 'CA',
			exchange: 'NASDAQ',
			cik: '0001262039',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Zscaler, Inc.',
		slug: 'firm:zscaler-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2007',
		summary:
			'Public zero-trust / cloud security company (ZS). Edge and internet access security platform used by enterprises and government; peer set with Cloudflare, Okta, and Palo Alto Networks.',
		aliases: ['Zscaler'],
		locations: [loc('San Jose, CA', 'hq', 'San Jose', 'CA', 'Santa Clara')],
		identifiers: [ticker('ZS'), url('https://www.zscaler.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'zero_trust_cloud',
			state: 'CA',
			exchange: 'NASDAQ',
			cik: '0001713683',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Okta, Inc.',
		slug: 'firm:okta-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2009',
		summary:
			'Public identity and access management company (OKTA). Workforce and customer identity platforms used across enterprise and government; identity peer to zero-trust cyber vendors.',
		aliases: ['Okta'],
		locations: [loc('San Francisco, CA', 'hq', 'San Francisco', 'CA', 'San Francisco')],
		identifiers: [ticker('OKTA'), url('https://www.okta.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'identity',
			state: 'CA',
			exchange: 'NASDAQ',
			cik: '0001660134',
		},
		sourceCorpus: CORPUS,
	},
];

/**
 * Enrich existing cards with the pasted public-company summaries, tickers, and TX/OK locations.
 * Pass summary only when we want to replace a thin/empty or upgrade to the curated public blurb.
 */
const enrichBatch = [
	// --- Defense primes ---
	{
		slug: 'firm:lockheed-martin-corporation',
		name: 'Lockheed Martin Corporation',
		status: 'pinned',
		endDate: '',
		startDate: '1995-03-15',
		summary:
			'One of the largest U.S. defense primes (LMT). Develops and produces the F-35 fighter, missiles (including PAC-3 and others), space systems, and related technologies. Major presence in Fort Worth (aeronautics) and Grand Prairie (missiles). Involved in large programs such as missile defense initiatives.',
		aliases: ['Lockheed Martin', 'Lockheed Martin Corp.'],
		locations: [
			loc('Fort Worth, TX', 'associated', 'Fort Worth', 'TX', 'Tarrant'),
			loc('Grand Prairie, TX', 'associated', 'Grand Prairie', 'TX', 'Dallas'),
			loc('Bethesda, MD', 'hq', 'Bethesda', 'MD', 'Montgomery'),
		],
		identifiers: [ticker('LMT'), url('https://www.lockheedmartin.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			exchange: 'NYSE',
			cik: '0000936468',
			states: ['TX', 'MD'],
		},
	},
	{
		slug: 'firm:rtx-corporation',
		name: 'RTX Corporation',
		status: 'pinned',
		endDate: '',
		summary:
			'Parent of Raytheon and Collins Aerospace (RTX; formerly Raytheon Technologies). Major producer of missiles (Patriot, Standard Missile, AMRAAM), engines (Pratt & Whitney), avionics, and defense electronics. Significant North Texas operations including McKinney.',
		aliases: ['RTX', 'Raytheon Technologies', 'Raytheon Technologies Corporation'],
		locations: [
			loc('McKinney, TX', 'associated', 'McKinney', 'TX', 'Collin'),
			loc('Arlington, VA', 'hq', 'Arlington', 'VA', 'Arlington'),
		],
		identifiers: [ticker('RTX'), url('https://www.rtx.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			exchange: 'NYSE',
			cik: '0000101829',
			states: ['TX', 'VA'],
		},
	},
	{
		slug: 'firm:raytheon',
		name: 'Raytheon',
		status: 'pinned',
		endDate: '',
		startDate: '1922',
		summary:
			'RTX missile and defense electronics business (legacy Raytheon). Missiles include Patriot, Standard Missile, and AMRAAM; significant North Texas (McKinney) operations.',
		aliases: ['Raytheon Company', 'Raytheon Technologies Missiles & Defense'],
		locations: [loc('McKinney, TX', 'associated', 'McKinney', 'TX', 'Collin')],
		identifiers: [url('https://www.rtx.com/raytheon')],
		links: [
			{
				peerName: 'RTX Corporation',
				peerSlug: 'firm:rtx-corporation',
				relationType: 'owned_by',
				roleLabel: 'Raytheon unit owned by RTX parent',
				createPeerIfMissing: false,
			},
		],
		metadata: { ...metaBase, industry: 'defense', sector: 'missiles_sensors', state: 'TX' },
	},
	{
		slug: 'firm:collins-aerospace',
		name: 'Collins Aerospace',
		status: 'pinned',
		endDate: '',
		summary:
			'RTX avionics and aerospace systems unit (Collins Aerospace). Formed 2018 from UTC/Rockwell Collins lineage; Texas and broader U.S. aerospace footprint under RTX.',
		links: [
			{
				peerName: 'RTX Corporation',
				peerSlug: 'firm:rtx-corporation',
				relationType: 'owned_by',
				roleLabel: 'Collins Aerospace unit owned by RTX parent',
				createPeerIfMissing: false,
			},
		],
		metadata: { ...metaBase, industry: 'defense', sector: 'avionics', parentTicker: 'RTX' },
	},
	{
		slug: 'firm:northrop-grumman',
		name: 'Northrop Grumman Corporation',
		status: 'pinned',
		endDate: '',
		startDate: '1994',
		summary:
			'U.S. defense prime (NOC) focused on strategic systems including the B-21 bomber, solid rocket motors, air and missile defense, and advanced electronics. Strong presence in defense programs and systems integration; Texas activity among broader national footprint.',
		aliases: ['Northrop Grumman', 'Northrop Grumman Corp.'],
		locations: [
			loc('Falls Church, VA', 'hq', 'Falls Church', 'VA'),
			loc('Texas, US', 'associated', null, 'TX'),
		],
		identifiers: [ticker('NOC'), url('https://www.northropgrumman.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			exchange: 'NYSE',
			cik: '0001133421',
		},
	},
	{
		slug: 'firm:general-dynamics',
		name: 'General Dynamics Corporation',
		status: 'pinned',
		endDate: '',
		startDate: '1952',
		summary:
			'Diversified defense prime (GD) across submarines, armored vehicles, combat systems, and IT/services. Active in land, sea, and information systems for defense customers.',
		aliases: ['General Dynamics', 'GD'],
		locations: [loc('Reston, VA', 'hq', 'Reston', 'VA')],
		identifiers: [ticker('GD'), url('https://www.gd.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_prime',
			exchange: 'NYSE',
			cik: '0000040533',
		},
	},
	{
		slug: 'firm:boeing',
		name: 'The Boeing Company',
		status: 'pinned',
		endDate: '',
		startDate: '1916-07-15',
		summary:
			'Major commercial aerospace plus defense segment (BA) — fighters, tankers, missiles, space, and sustainment. Defense work includes various platforms; presence in Texas among national manufacturing and support sites.',
		aliases: ['Boeing', 'Boeing Company'],
		locations: [
			loc('Arlington, VA', 'hq', 'Arlington', 'VA'),
			loc('Texas, US', 'associated', null, 'TX'),
		],
		identifiers: [ticker('BA'), url('https://www.boeing.com/')],
		metadata: {
			...metaBase,
			industry: 'aerospace',
			sector: 'commercial_and_defense',
			exchange: 'NYSE',
			cik: '0000012927',
		},
	},
	{
		slug: 'firm:l3harris',
		name: 'L3Harris Technologies, Inc.',
		status: 'pinned',
		endDate: '',
		summary:
			'Defense electronics, communications, sensors, and mission systems (LHX). Multiple facilities in the DFW area and elsewhere in Texas; public defense-electronics peer to the large primes.',
		aliases: ['L3Harris', 'L3Harris Technologies', 'L3 Harris'],
		locations: [
			loc('Melbourne, FL', 'hq', 'Melbourne', 'FL'),
			loc('Dallas–Fort Worth, TX', 'associated', 'Dallas', 'TX'),
		],
		identifiers: [ticker('LHX'), url('https://www.l3harris.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'aerospace_electronics',
			exchange: 'NYSE',
			cik: '0000202058',
			states: ['FL', 'TX'],
		},
	},
	{
		slug: 'firm:palantir-technologies',
		name: 'Palantir Technologies Inc.',
		status: 'pinned',
		endDate: '',
		startDate: '2003',
		summary:
			'Data analytics and AI software platforms (Gotham, Foundry, AIP) widely used for intelligence, targeting, and decision support across U.S. military and government customers (PLTR). Frequently partners with hardware-focused defense firms; public software peer in the defense-tech stack.',
		aliases: ['Palantir', 'Palantir Technologies'],
		locations: [loc('Denver, CO', 'hq', 'Denver', 'CO')],
		identifiers: [ticker('PLTR'), url('https://www.palantir.com/')],
		metadata: {
			...metaBase,
			industry: 'defense_tech',
			sector: 'software_ai_analytics',
			exchange: 'NYSE',
			cik: '0001321655',
		},
	},
	{
		slug: 'firm:anduril-industries-inc',
		name: 'Anduril Industries, Inc.',
		status: 'pinned',
		endDate: '',
		startDate: '2017',
		summary:
			'Private, highly valued defense-tech company. Builds autonomous systems, drones, software (Lattice AI platform), interceptors, and other defense hardware/software. Competes with and partners with traditional primes; rapidly growing revenue and contracts. Expanding Texas presence among next-gen defense firms.',
		aliases: ['Anduril', 'Anduril Industries'],
		locations: [
			loc('Costa Mesa, CA', 'hq', 'Costa Mesa', 'CA'),
			loc('Texas, US', 'associated', null, 'TX'),
		],
		identifiers: [url('https://www.anduril.com/')],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_tech',
			ownership: 'private',
			states: ['CA', 'TX'],
		},
	},

	// --- Energy / OFS (refresh summaries + tickers) ---
	{
		slug: 'firm:halliburton',
		name: 'Halliburton Company',
		status: 'pinned',
		endDate: '',
		summary:
			'Major global oilfield services provider (HAL): drilling, completion, production, cementing, well intervention. Strong North American (including Permian) presence; Houston-area headquarters. Expanding into digital and some energy-transition-related work.',
		identifiers: [ticker('HAL'), url('https://www.halliburton.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'oilfield_services',
			exchange: 'NYSE',
			cik: '0000045012',
			state: 'TX',
		},
	},
	{
		slug: 'firm:slb',
		name: 'SLB',
		status: 'pinned',
		endDate: '',
		summary:
			'Largest oilfield services company by revenue (SLB, formerly Schlumberger). Drilling, completions, production, measurement, and digital solutions worldwide. Houston operations; strong international focus. Public OFS peer to Halliburton.',
		identifiers: [ticker('SLB'), url('https://www.slb.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'oilfield_services',
			exchange: 'NYSE',
			cik: '0000087347',
			state: 'TX',
			formerName: 'Schlumberger',
		},
	},
	{
		slug: 'firm:baker-hughes-company',
		name: 'Baker Hughes Company',
		status: 'pinned',
		endDate: '',
		summary:
			'Oilfield services and equipment plus industrial/energy technology (BKR), including gas turbines, LNG tech, and growing data-center/power infrastructure work. Houston-based; straddles traditional OFS and broader energy tech.',
		identifiers: [ticker('BKR'), url('https://www.bakerhughes.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'oilfield_services',
			exchange: 'NASDAQ',
			cik: '0001701605',
			state: 'TX',
		},
	},
	{
		slug: 'firm:weatherford-international-inc',
		name: 'Weatherford International plc',
		status: 'pinned',
		endDate: '',
		summary:
			'Oilfield services focused on drilling, completion, production, and intervention tools/services (WFRD). Houston-area headquarters functions; public Halliburton peer.',
		identifiers: [ticker('WFRD'), url('https://www.weatherford.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'oilfield_services',
			exchange: 'NASDAQ',
			cik: '0001603923',
			state: 'TX',
		},
	},
	{
		slug: 'firm:helmerich-payne-inc',
		name: 'Helmerich & Payne, Inc.',
		status: 'pinned',
		endDate: '',
		summary:
			'Major land drilling contractor (HP) with Tulsa headquarters and extensive Permian and other basin activity. Public drilling peer adjacent to Halliburton’s oilfield services set.',
		identifiers: [ticker('HP'), url('https://www.helmerichpayne.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'land_drilling',
			exchange: 'NYSE',
			cik: '0000046765',
			states: ['OK', 'TX'],
		},
	},
	{
		slug: 'firm:energy-transfer',
		name: 'Energy Transfer LP',
		status: 'pinned',
		endDate: '',
		summary:
			'Dallas-based midstream MLP (ET) — pipelines and storage for natural gas, NGLs, crude, and refined products. Major Texas midstream public company often grouped with energy infrastructure peers.',
		identifiers: [ticker('ET'), url('https://www.energytransfer.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'midstream',
			exchange: 'NYSE',
			state: 'TX',
		},
	},
	{
		slug: 'firm:oneok-inc',
		name: 'ONEOK, Inc.',
		status: 'pinned',
		endDate: '',
		summary:
			'Tulsa midstream company (OKE) focused on natural gas gathering, processing, and NGL pipelines. Major Oklahoma energy headquarters and public midstream peer.',
		identifiers: [ticker('OKE'), url('https://www.oneok.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'midstream',
			exchange: 'NYSE',
			cik: '0000059478',
			state: 'OK',
		},
	},
	{
		slug: 'firm:williams-companies-inc',
		name: 'The Williams Companies, Inc.',
		status: 'pinned',
		endDate: '',
		summary:
			'Tulsa natural gas infrastructure company (WMB; Transco and related systems). Core Oklahoma midstream headquarters and public energy infrastructure peer.',
		identifiers: [ticker('WMB'), url('https://www.williams.com/')],
		metadata: {
			...metaBase,
			industry: 'oil_gas',
			sector: 'midstream',
			exchange: 'NYSE',
			cik: '0000107263',
			state: 'OK',
		},
	},

	// --- Cyber / tech ---
	{
		slug: 'firm:palo-alto-networks',
		name: 'Palo Alto Networks, Inc.',
		status: 'pinned',
		endDate: '',
		startDate: '2005',
		summary:
			'Large cybersecurity platform (PANW) spanning network security (firewalls), cloud, endpoint/XDR, and security operations. High market cap; active in enterprise and government. Public cyber peer to CrowdStrike, Fortinet, and Zscaler.',
		aliases: ['Palo Alto Networks', 'PANW'],
		locations: [loc('Santa Clara, CA', 'hq', 'Santa Clara', 'CA', 'Santa Clara')],
		identifiers: [ticker('PANW'), url('https://www.paloaltonetworks.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'platform_security',
			exchange: 'NASDAQ',
			cik: '0001327567',
			state: 'CA',
		},
	},
	{
		slug: 'firm:cloudflare',
		name: 'Cloudflare, Inc.',
		status: 'pinned',
		endDate: '',
		startDate: '2009-07-26',
		summary:
			'Public edge security and performance company (NET). CDN, zero-trust, and application security used by enterprises and developers; peer to Zscaler and other cloud security platforms.',
		aliases: ['Cloudflare'],
		locations: [loc('San Francisco, CA', 'hq', 'San Francisco', 'CA')],
		identifiers: [ticker('NET'), url('https://www.cloudflare.com/')],
		metadata: {
			...metaBase,
			industry: 'cybersecurity',
			sector: 'edge_security',
			exchange: 'NYSE',
			cik: '0001477333',
			state: 'CA',
		},
	},
	{
		slug: 'firm:pratt-whitney',
		name: 'Pratt & Whitney',
		status: 'pinned',
		endDate: '',
		summary:
			'RTX aircraft engines unit (Pratt & Whitney). Military and commercial engines; Oklahoma City military engines sustainment tied to the Tinker AFB aerospace hub.',
		identifiers: [url('https://www.prattwhitney.com/')],
		links: [
			{
				peerName: 'RTX Corporation',
				peerSlug: 'firm:rtx-corporation',
				relationType: 'owned_by',
				roleLabel: 'Pratt & Whitney unit owned by RTX parent',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			industry: 'aerospace',
			sector: 'engines_mro',
			parentTicker: 'RTX',
			states: ['OK', 'CT'],
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

console.log(`Public tech/defense/energy import (${dryRun ? 'DRY RUN' : 'live'}) — corpus ${CORPUS}`);
let ok = 0;
let fail = 0;

for (const item of createBatch) {
	const res = await runOne(item, 'create');
	if (res?.ok !== false) ok += 1;
	else fail += 1;
}

for (const item of enrichBatch) {
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
