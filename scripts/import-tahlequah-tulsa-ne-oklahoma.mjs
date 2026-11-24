#!/usr/bin/env node
/**
 * Tahlequah, Tulsa, and northeastern Oklahoma notables in defense/aerospace,
 * space/defense-tech, energy, fiber/tech, and related (Cherokee Nation corridor).
 *
 * Usage: node scripts/import-tahlequah-tulsa-ne-oklahoma.mjs [--dry-run]
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
const CORPUS = 'tahlequah-tulsa-ne-oklahoma-2026-11-23';

const metaBase = {
	tahlequahTulsaNeOk: true,
	txOkStatewide: true,
	region: 'Tahlequah–Tulsa / northeastern Oklahoma corridor',
	state: 'OK',
};

function loc(raw, role, city, county) {
	return {
		raw,
		role,
		city: city || null,
		state: 'OK',
		country: 'US',
		...(county ? { county } : {}),
	};
}

function peerEvent(slug, name, label) {
	return {
		peerName: name,
		peerSlug: slug,
		peerType: 'historic_event',
		relationType: 'participated_in',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

function peerFirm(slug, name, label) {
	return {
		peerName: name,
		peerSlug: slug,
		relationType: 'business_tie',
		roleLabel: label,
		createPeerIfMissing: false,
	};
}

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	// --- Corridor framing events ---
	{
		profileType: 'historic_event',
		name: 'Tulsa Tech, Military, Aerospace, Quantum',
		slug: 'historic_event:tulsa-aerospace-defense-space-corridor',
		status: 'pinned',
		startDate: '1920',
		summary:
			'Northeastern Oklahoma’s primary concentration for aerospace MRO, aerostructures, defense electronics, national-security and commercial space, fiber/digital infrastructure, and energy-adjacent tech. Anchored at Tulsa International Airport / Tulsa metro (Tulsa Aerospace, Defense & Space Corridor). Most recent milestones at the top.\n\n2026: **Quantum Space** advances spacecraft manufacturing facility near Tulsa International Airport (Ranger satellites, propulsion tanks, and precision parts for national-security and commercial space missions). Led by former NASA Administrator Jim Bridenstine; interim space and initial operational capability targeted in this period, with longer-term higher-volume production plans. **Agile Space Industries** Space Test Center near TUL continues development for rocket-engine testing supporting NASA, commercial, and Department of Defense needs. Meta Project Anthem AI-optimized data-center campus advances in the Tulsa area (workforce training includes fiber optics and structured cabling). Ongoing operations and growth across the established MRO and aerostructures base (American Airlines Maintenance & Engineering, NORDAM, Spirit AeroSystems, Lufthansa Technik, L3Harris/Aeromet).\n\n2025: Quantum Space announces Tulsa manufacturing site (former Spartan Aircraft area near the airport) for Ranger spacecraft components and related production. Agile Space Industries breaks ground / advances the ~$20 million Space Test Center near Tulsa International Airport. Manna Air Delivery launches full-scale U.S. operational and manufacturing activity in Tulsa (autonomous aviation). Continued federal and regional support for the Tulsa Tech Hub focused on autonomous systems and dual-use technology.\n\n2020–2024: Tulsa receives federal Tech Hub designation and related funding (including major EDA award for the Tulsa Hub for Equitable and Trustworthy Autonomy / THETA), emphasizing autonomous systems, UAS, advanced manufacturing, and dual-use tech. Tulsa Innovation Labs and Rose Rock Bridge expand energy-tech startup and industry collaboration support. Meta announces large AI data-center campus (Project Anthem). University of Tulsa research activity in energy systems, materials, autonomy, AI, and cybersecurity continues to support the ecosystem.\n\n2010–2019: Consolidation and growth of Tulsa’s MRO and aerostructures footprint (American Airlines base, NORDAM, Spirit AeroSystems, Lufthansa Technik component services, L3Harris/Aeromet defense electronics). Regional aerospace & defense employment and company count expand; Tulsa recognized as a major commercial MRO and supplier node alongside broader Oklahoma activity centered on Tinker AFB (Oklahoma City).\n\nPre-2010s / foundational: American Airlines establishes and grows its major maintenance base at Tulsa International Airport (later recognized as one of the world’s largest commercial aircraft MRO facilities). NORDAM (founded 1969) develops as a Tulsa-headquartered independent aerospace company specializing in airframe components, nacelles, and thrust reversers for commercial and military aircraft. Energy infrastructure solidifies Tulsa’s “Oil Capital” heritage (midstream presence including ONEOK and Williams Companies; Cushing crude storage and pipeline hub west of Tulsa; University of Tulsa Fluid Flow Projects supporting oil & gas, pipelines, and later hydrogen/carbon-capture work). Helmerich & Payne (land drilling) maintains Tulsa headquarters.\n\nAerospace, military, and defense: American Airlines Maintenance & Engineering; NORDAM; Spirit AeroSystems Tulsa; Lufthansa Technik (component MRO); L3Harris (including Aeromet); Accurus Aerospace; Delaware Resource Group of Oklahoma; FlightSafety International; Cherokee Nation Aerospace & Defense; Oklahoma Air National Guard 138th Fighter Wing. Broader ecosystem ties to Boeing, Lockheed Martin, Northrop Grumman, RTX/Raytheon, General Dynamics, BAE Systems, and Kratos.\n\nSpace and quantum-adjacent: Quantum Space (lead “quantum”-named and space-tech presence) and Agile Space Industries. Pure quantum-computing headquarters are not prominent in Tulsa.\n\nTech, fiber, and supporting institutions: Meta data-center activity; Tulsa Innovation Labs; Rose Rock Bridge; PartnerTulsa; University of Tulsa and Oklahoma State University Tulsa ties.\n\nEnergy context: ONEOK, Williams Companies, Helmerich & Payne, Cushing hub, and University of Tulsa fluid-flow research.\n\nTahlequah / Cherokee Nation area (east of Tulsa): Limited specialized scale—mainly smaller manufacturing (e.g., Cross Industries / Precision Injection Molding with some defense-adjacent parts work), Watts Native Technologies, Provalus tech support, local fiber providers (including Lake Region Telecommunications), and Northeastern State University. Cherokee Nation Businesses provide tribal aerospace/defense linkages into the broader corridor.\n\nTulsa remains the clear concentration point in northeastern Oklahoma; Oklahoma’s wider aerospace & defense sector also centers on Tinker AFB near Oklahoma City as a major depot node.',
		aliases: [
			'Tulsa Tech, Military, Aerospace, Quantum',
			'Tulsa Tech Military Aerospace Quantum',
			'Tulsa International Airport aerospace cluster',
			'Tulsa Aerospace, Defense & Space Corridor',
		],
		locations: [
			loc('Tulsa International Airport / Tulsa metro, OK', 'associated', 'Tulsa', 'Tulsa'),
			loc('Northeastern Oklahoma (Tulsa–Tahlequah corridor)', 'associated', 'Tulsa', 'Tulsa'),
		],
		metadata: {
			...metaBase,
			industry: 'aerospace',
			sector: 'regional_corridor',
			themes: ['tech', 'military', 'aerospace', 'quantum', 'space', 'fiber', 'energy'],
			summaryTitle: 'Tulsa Tech, Military, Aerospace, Quantum',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'historic_event',
		name: 'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
		slug: 'historic_event:tahlequah-cherokee-nation-tech-light-industry',
		status: 'pinned',
		startDate: '1980',
		summary:
			'Tahlequah (Cherokee Nation capital area) smaller-scale tech services, light manufacturing (including defense/firearms-adjacent molding), Native-owned IT, and campus/research presence (NSU). Limited specialized oilfield, quantum, or large securities footprint compared with Tulsa.',
		locations: [loc('Tahlequah, OK', 'associated', 'Tahlequah', 'Cherokee')],
		metadata: { ...metaBase, industry: 'tech', sector: 'regional_corridor' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'historic_event',
		name: 'Cushing, Oklahoma Crude Oil Hub',
		slug: 'historic_event:cushing-oklahoma-crude-oil-hub',
		status: 'pinned',
		startDate: '1912',
		summary:
			'Major U.S. crude oil storage and pipeline hub west of Tulsa (Cushing, OK). Central to midstream pricing (WTI) and pipeline connectivity for Mid-Continent energy logistics tied to Tulsa’s Oil Capital heritage.',
		locations: [loc('Cushing, OK', 'associated', 'Cushing', 'Payne')],
		metadata: { ...metaBase, industry: 'oil_gas', sector: 'midstream_hub' },
		sourceCorpus: CORPUS,
	},

	// --- Tahlequah ---
	{
		profileType: 'firm',
		name: 'Cross Industries / Precision Injection Molding',
		slug: 'firm:cross-industries-precision-injection-molding',
		status: 'pinned',
		endDate: '',
		summary:
			'Tahlequah Business and Technology Park injection-molding job shop producing small technical parts for medical, food/beverage, and defense/firearms applications. Primary specialized manufacturing presence noted in Tahlequah for defense-adjacent work.',
		aliases: ['Precision Injection Molding', 'Cross Industries', 'Precision Injection Molding / Cross Industries'],
		locations: [loc('Tahlequah Business and Technology Park, Tahlequah, OK', 'hq', 'Tahlequah', 'Cherokee')],
		links: [
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Tahlequah Business Park defense/firearms-adjacent molding',
			),
		],
		metadata: { ...metaBase, industry: 'manufacturing', sector: 'injection_molding_defense_adjacent', city: 'Tahlequah' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Watts Native Technologies LLC',
		slug: 'firm:watts-native-technologies-llc',
		status: 'pinned',
		endDate: '',
		summary:
			'Tahlequah-registered Native American-owned firm providing computer-related services, construction, data processing, and related NAICS activities. Local IT/services presence in the Cherokee Nation capital area.',
		aliases: ['Watts Native Technologies'],
		locations: [loc('Tahlequah, OK', 'hq', 'Tahlequah', 'Cherokee')],
		links: [
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Tahlequah Native-owned IT / data services',
			),
		],
		metadata: { ...metaBase, industry: 'tech', sector: 'it_services', ownership: 'native_owned', city: 'Tahlequah' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Provalus',
		slug: 'firm:provalus',
		status: 'pinned',
		endDate: '',
		summary:
			'Technology innovation/support center opened in Tahlequah — tech services and managed support roles. Notable corporate tech-services presence in the Tahlequah Business and Technology Park area.',
		aliases: ['Provalus Tahlequah'],
		locations: [loc('Tahlequah, OK', 'associated', 'Tahlequah', 'Cherokee')],
		links: [
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Tahlequah tech innovation / managed support center',
			),
		],
		metadata: { ...metaBase, industry: 'tech', sector: 'managed_it_support', city: 'Tahlequah' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Lake Region Telecommunications',
		slug: 'firm:lake-region-telecommunications',
		status: 'pinned',
		endDate: '',
		summary:
			'Regional fiber/telecom provider serving northeastern Oklahoma including the Tahlequah area and Business and Technology Park connectivity needs.',
		aliases: ['Lake Region Telecom', 'LRT'],
		locations: [loc('Northeastern Oklahoma / Tahlequah area', 'associated', 'Tahlequah', 'Cherokee')],
		links: [
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Tahlequah-area fiber / telecom',
			),
		],
		metadata: { ...metaBase, industry: 'telecom', sector: 'fiber_optics', city: 'Tahlequah' },
		sourceCorpus: CORPUS,
	},

	// --- Tulsa aerospace / defense / space ---
	{
		profileType: 'firm',
		name: 'American Airlines Maintenance & Engineering (Tulsa)',
		slug: 'firm:american-airlines-maintenance-engineering-tulsa',
		status: 'pinned',
		endDate: '',
		startDate: '1946',
		summary:
			'World’s largest commercial aircraft MRO facility at Tulsa International Airport. Major local employer and cornerstone of Tulsa’s aerospace maintenance base.',
		aliases: ['American Airlines MRO Tulsa', 'AA Maintenance & Engineering Tulsa', 'American Airlines Tulsa'],
		locations: [loc('Tulsa International Airport, Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.aa.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa International Airport commercial MRO anchor',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'mro', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'NORDAM Group, Inc.',
		slug: 'firm:nordam-group-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1969',
		summary:
			'Tulsa-headquartered independent aerospace company. Manufactures and repairs airframe components, nacelles, thrust reversers, and related structures for commercial and military aircraft.',
		aliases: ['NORDAM', 'The NORDAM Group'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.nordam.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa HQ aerostructures / nacelles',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'aerostructures_mro', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Spirit AeroSystems Holdings, Inc. (Tulsa)',
		slug: 'firm:spirit-aerosystems-tulsa',
		status: 'pinned',
		endDate: '',
		startDate: '2005',
		summary:
			'Aerostructures manufacturing (fuselage, wings, and related components) with Tulsa operations. Major aerostructures presence in the Tulsa aerospace corridor (Spirit AeroSystems Holdings public parent).',
		aliases: ['Spirit AeroSystems Tulsa', 'Spirit AeroSystems'],
		locations: [loc('Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [
			{ scheme: 'ticker', value: 'SPR' },
			{ scheme: 'url', value: 'https://www.spiritaero.com/' },
		],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa aerostructures manufacturing',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'aerostructures', city: 'Tulsa', exchange: 'NYSE' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Lufthansa Technik Component Services (Tulsa)',
		slug: 'firm:lufthansa-technik-tulsa',
		status: 'pinned',
		endDate: '',
		summary:
			'MRO for aircraft components in Tulsa — avionics, hydraulics, and related systems. Part of Lufthansa Technik’s component services footprint supporting Tulsa’s MRO cluster.',
		aliases: ['Lufthansa Technik Tulsa', 'Lufthansa Technik Component Services'],
		locations: [loc('Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.lufthansa-technik.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa component MRO (avionics/hydraulics)',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'mro_components', city: 'Tulsa', countries: ['DE', 'US'] },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Quantum Space',
		slug: 'firm:quantum-space',
		status: 'pinned',
		endDate: '',
		startDate: '2021',
		summary:
			'Building a spacecraft manufacturing facility (Ranger satellites and related parts/propulsion tanks) near Tulsa International Airport. Focused on national security and commercial space operations. Led by former NASA Administrator Jim Bridenstine. Closest high-profile “quantum”-adjacent / space-tech activity in the Tulsa corridor.',
		aliases: ['Quantum Space LLC', 'Quantum Space Tulsa'],
		locations: [loc('Near Tulsa International Airport, Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://quantumspace.us/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa spacecraft manufacturing (Ranger / national security space)',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'space_manufacturing', city: 'Tulsa', ownership: 'private' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Agile Space Industries',
		slug: 'firm:agile-space-industries',
		status: 'pinned',
		endDate: '',
		startDate: '2019',
		summary:
			'Developing a Space Test Center near Tulsa International Airport for rocket engine testing supporting NASA, commercial, and DoD needs. Complements Quantum Space manufacturing in the Tulsa space cluster.',
		aliases: ['Agile Space', 'Agile Space Industries Tulsa'],
		locations: [loc('Near Tulsa International Airport, Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://agilespaceindustries.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa rocket engine / Space Test Center',
			),
			peerFirm('firm:quantum-space', 'Quantum Space', 'Tulsa airport-area space cluster peer'),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'propulsion_test', city: 'Tulsa', ownership: 'private' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Accurus Aerospace',
		slug: 'firm:accurus-aerospace',
		status: 'pinned',
		endDate: '',
		summary:
			'Tulsa-area aerospace manufacturing / supplier firm noted among local aerostructures and machining suppliers supporting commercial and defense programs.',
		aliases: ['Accurus Aerospace Corporation'],
		locations: [loc('Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa aerospace supplier',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'machining_supplier', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Delaware Resource Group of Oklahoma',
		slug: 'firm:delaware-resource-group-of-oklahoma',
		status: 'pinned',
		endDate: '',
		summary:
			'Oklahoma aerospace and defense training and support services firm with Tulsa-area relevance. Provides aircrew training devices, maintenance training, and related defense support.',
		aliases: ['Delaware Resource Group', 'DRG Oklahoma'],
		locations: [loc('Oklahoma / Tulsa area', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.drgok.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Aerospace/defense training & support',
			),
		],
		metadata: { ...metaBase, industry: 'defense', sector: 'training_support', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'FlightSafety International (Tulsa)',
		slug: 'firm:flightsafety-international-tulsa',
		status: 'pinned',
		endDate: '',
		startDate: '1951',
		summary:
			'Flight training and simulation company with historic Tulsa roots / operations. Part of the regional aerospace training ecosystem (Berkshire Hathaway–owned FlightSafety International).',
		aliases: ['FlightSafety', 'FlightSafety International', 'FlightSafety Tulsa'],
		locations: [loc('Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.flightsafety.com/' }],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa flight training / simulation',
			),
		],
		metadata: { ...metaBase, industry: 'aerospace', sector: 'training_simulation', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Cherokee Nation Businesses',
		slug: 'firm:cherokee-nation-businesses',
		status: 'pinned',
		endDate: '',
		summary:
			'Economic development and business arm of the Cherokee Nation. Aerospace/defense, hospitality, and diversified enterprises that can touch the Tahlequah–Tulsa corridor.',
		aliases: ['CNB', 'Cherokee Nation Businesses, L.L.C.'],
		locations: [
			loc('Catoosa / Cherokee Nation, OK', 'hq', 'Catoosa', 'Rogers'),
			loc('Tahlequah, OK', 'associated', 'Tahlequah', 'Cherokee'),
		],
		identifiers: [{ scheme: 'url', value: 'https://cherokeenationbusinesses.com/' }],
		metadata: { ...metaBase, industry: 'conglomerate', sector: 'tribal_enterprise', ownership: 'tribal' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Cherokee Nation Aerospace & Defense',
		slug: 'firm:cherokee-nation-aerospace-defense',
		status: 'pinned',
		endDate: '',
		summary:
			'Tribal aerospace and defense manufacturing / contracting entity under Cherokee Nation Businesses. Links the Tahlequah–Tulsa corridor tribal economic development to federal aerospace and defense work.',
		aliases: ['Cherokee Nation Aerospace and Defense', 'CNAD'],
		locations: [
			loc('Cherokee Nation / northeastern Oklahoma', 'associated', 'Tahlequah', 'Cherokee'),
			loc('Tulsa metro, OK', 'associated', 'Tulsa', 'Tulsa'),
		],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tribal aerospace & defense manufacturing',
			),
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Cherokee Nation aerospace and defense arm',
			),
			peerFirm('firm:cherokee-nation-businesses', 'Cherokee Nation Businesses', 'CNAD under Cherokee Nation Businesses'),
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'tribal_aerospace_defense',
			ownership: 'tribal',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'government',
		name: 'Oklahoma Air National Guard 138th Fighter Wing',
		slug: 'government:ok-ang-138th-fighter-wing',
		status: 'pinned',
		endDate: '',
		startDate: '1947',
		summary:
			'Tulsa Air National Guard Base — 138th Fighter Wing. Local military aviation presence supporting the Tulsa aerospace and defense ecosystem.',
		aliases: ['138th Fighter Wing', 'Tulsa Air National Guard', '138th FW'],
		locations: [loc('Tulsa Air National Guard Base, Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa ANG fighter wing',
			),
		],
		metadata: { ...metaBase, industry: 'defense', sector: 'military_aviation', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Kratos Defense & Security Solutions, Inc.',
		slug: 'firm:kratos-defense-security-solutions-inc',
		status: 'pinned',
		endDate: '',
		startDate: '1994',
		summary:
			'Public defense-tech company (KTOS) — unmanned systems, C5ISR, and related national-security technologies. Noted among broader Oklahoma/Tulsa-relevant defense ecosystem primes and suppliers.',
		aliases: ['Kratos', 'Kratos Defense'],
		locations: [
			loc('San Diego, CA', 'hq', 'San Diego', null),
			loc('Oklahoma / Tulsa-relevant defense ecosystem', 'associated', 'Tulsa', 'Tulsa'),
		],
		identifiers: [
			{ scheme: 'ticker', value: 'KTOS' },
			{ scheme: 'url', value: 'https://www.kratosdefense.com/' },
		],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Defense-tech ecosystem peer (unmanned / C5ISR)',
			),
		],
		metadata: {
			...metaBase,
			industry: 'defense',
			sector: 'defense_tech',
			exchange: 'NASDAQ',
			state: 'CA',
		},
		sourceCorpus: CORPUS,
	},

	// --- Energy / tech / econ development ---
	{
		profileType: 'firm',
		name: 'Tulsa Innovation Labs',
		slug: 'firm:tulsa-innovation-labs',
		status: 'pinned',
		endDate: '',
		startDate: '2019',
		summary:
			'Tulsa economic development / innovation organization supporting energy-tech startups, industry collaboration, and related tech workforce initiatives (including ties to Rose Rock Bridge and metro tech strategy).',
		aliases: ['TIL', 'Tulsa Innovation Labs LLC'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.tulsainnovationlabs.com/' }],
		metadata: { ...metaBase, industry: 'econ_dev', sector: 'innovation_labs', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rose Rock Bridge',
		slug: 'firm:rose-rock-bridge',
		status: 'pinned',
		endDate: '',
		summary:
			'Tulsa energy-tech / innovation collaboration vehicle supporting startups and industry partnership (often referenced alongside Tulsa Innovation Labs). Distinct from unrelated “Rose Rock” securities/finance name collisions.',
		aliases: ['Rose Rock Bridge Tulsa'],
		locations: [loc('Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		links: [
			peerFirm('firm:tulsa-innovation-labs', 'Tulsa Innovation Labs', 'Tulsa energy-tech / innovation peer'),
		],
		metadata: { ...metaBase, industry: 'econ_dev', sector: 'energy_tech_bridge', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'PartnerTulsa',
		slug: 'firm:partnertulsa',
		status: 'pinned',
		endDate: '',
		summary:
			'Tulsa’s economic development authority / partnership organization. Coordinates business attraction and growth across aerospace, energy, tech, and related sectors.',
		aliases: ['Partner Tulsa', 'Tulsa Authority for Economic Opportunity'],
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://www.partnertulsa.com/' }],
		metadata: { ...metaBase, industry: 'econ_dev', sector: 'eda', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Meta Platforms — Tulsa Project Anthem Data Center',
		slug: 'firm:meta-tulsa-project-anthem',
		status: 'pinned',
		endDate: '',
		startDate: '2024',
		summary:
			'Meta AI-optimized data center campus in the Tulsa area (Project Anthem). Large-scale digital infrastructure build including workforce training that references fiber optics and structured cabling — major tech/fiber-adjacent investment in northeastern Oklahoma.',
		aliases: ['Project Anthem', 'Meta Tulsa Data Center', 'Meta Project Anthem'],
		locations: [loc('Tulsa area, OK', 'associated', 'Tulsa', 'Tulsa')],
		identifiers: [{ scheme: 'url', value: 'https://about.meta.com/' }],
		links: [
			peerFirm('firm:meta-platforms-inc', 'Meta Platforms, Inc.', 'Meta Tulsa data center project under Meta Platforms'),
		],
		metadata: {
			...metaBase,
			industry: 'tech',
			sector: 'data_center_ai',
			city: 'Tulsa',
			project: 'Project Anthem',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Meta Platforms, Inc.',
		slug: 'firm:meta-platforms-inc',
		status: 'pinned',
		endDate: '',
		startDate: '2004',
		summary:
			'Public technology company (META; formerly Facebook). Building a large AI-optimized data center campus in the Tulsa area (Project Anthem).',
		aliases: ['Meta', 'Facebook', 'Meta Platforms'],
		locations: [
			loc('Menlo Park, CA', 'hq', 'Menlo Park', null),
			loc('Tulsa area, OK (Project Anthem)', 'associated', 'Tulsa', 'Tulsa'),
		],
		identifiers: [
			{ scheme: 'ticker', value: 'META' },
			{ scheme: 'url', value: 'https://about.meta.com/' },
		],
		metadata: { ...metaBase, industry: 'tech', sector: 'social_ai_infra', exchange: 'NASDAQ', cik: '0001326801' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'education',
		name: 'University of Tulsa Fluid Flow Projects',
		slug: 'education:university-of-tulsa-fluid-flow-projects',
		status: 'pinned',
		endDate: '',
		startDate: '1973',
		summary:
			'University of Tulsa research consortium supporting oil & gas multiphase flow, hydrogen, carbon capture, and pipeline-related work. Anchors Tulsa’s energy research capability alongside corporate midstream HQs.',
		aliases: ['TU Fluid Flow Projects', 'Tulsa University Fluid Flow Projects', 'TUFFP'],
		locations: [loc('University of Tulsa, Tulsa, OK', 'associated', 'Tulsa', 'Tulsa')],
		links: [
			peerFirm('firm:oneok-inc', 'ONEOK, Inc.', 'Tulsa energy research / midstream ecosystem'),
			peerFirm('firm:williams-companies-inc', 'The Williams Companies, Inc.', 'Tulsa energy research / midstream ecosystem'),
			peerEvent(
				'historic_event:cushing-oklahoma-crude-oil-hub',
				'Cushing, Oklahoma Crude Oil Hub',
				'Mid-Continent pipeline / flow research relevance',
			),
		],
		metadata: { ...metaBase, industry: 'research', sector: 'energy_fluid_flow', city: 'Tulsa' },
		sourceCorpus: CORPUS,
	},
];

const enrichExisting = [
	{
		slug: 'education:northeastern-state-university',
		name: 'Northeastern State University',
		profileType: 'education',
		status: 'pinned',
		endDate: '',
		summary:
			'Public university with main campus in Tahlequah (Cherokee Nation capital area). Local education/research presence; limited specialized defense contracting historically (mostly low-volume).',
		locations: [loc('Tahlequah, OK', 'hq', 'Tahlequah', 'Cherokee')],
		links: [
			peerEvent(
				'historic_event:tahlequah-cherokee-nation-tech-light-industry',
				'Tahlequah / Cherokee Nation Capital Area Tech & Light Industry',
				'Tahlequah campus education/research anchor',
			),
		],
		metadata: { ...metaBase, city: 'Tahlequah' },
	},
	{
		slug: 'firm:oneok-inc',
		name: 'ONEOK, Inc.',
		endDate: '',
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		links: [
			peerEvent(
				'historic_event:cushing-oklahoma-crude-oil-hub',
				'Cushing, Oklahoma Crude Oil Hub',
				'Tulsa midstream HQ; Mid-Continent pipeline ecosystem',
			),
		],
		metadata: { ...metaBase, city: 'Tulsa' },
	},
	{
		slug: 'firm:williams-companies-inc',
		name: 'The Williams Companies, Inc.',
		endDate: '',
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		links: [
			peerEvent(
				'historic_event:cushing-oklahoma-crude-oil-hub',
				'Cushing, Oklahoma Crude Oil Hub',
				'Tulsa midstream HQ; Mid-Continent gas infrastructure',
			),
		],
		metadata: { ...metaBase, city: 'Tulsa' },
	},
	{
		slug: 'firm:l3harris',
		name: 'L3Harris Technologies, Inc.',
		endDate: '',
		locations: [loc('Tulsa, OK (Aeromet / defense electronics)', 'associated', 'Tulsa', 'Tulsa')],
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Tulsa Aeromet / defense electronics presence',
			),
		],
		metadata: { ...metaBase, tulsaPresence: true },
	},
	{
		slug: 'firm:helmerich-payne-inc',
		name: 'Helmerich & Payne, Inc.',
		endDate: '',
		locations: [loc('Tulsa, OK', 'hq', 'Tulsa', 'Tulsa')],
		metadata: { ...metaBase, city: 'Tulsa' },
	},
	{
		slug: 'firm:boeing',
		name: 'The Boeing Company',
		endDate: '',
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Oklahoma/Tulsa-relevant defense ecosystem prime',
			),
		],
		metadata: { ...metaBase, oklahomaEcosystem: true },
	},
	{
		slug: 'firm:lockheed-martin-corporation',
		name: 'Lockheed Martin Corporation',
		endDate: '',
		links: [
			peerEvent(
				'historic_event:tulsa-aerospace-defense-space-corridor',
				'Tulsa Tech, Military, Aerospace, Quantum',
				'Oklahoma/Tulsa-relevant defense ecosystem prime',
			),
		],
		metadata: { ...metaBase, oklahomaEcosystem: true },
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

console.log(`Tahlequah–Tulsa NE Oklahoma import (${dryRun ? 'DRY RUN' : 'live'}) — corpus ${CORPUS}`);
let ok = 0;
let fail = 0;

for (const item of batch) {
	const res = await runOne(item, 'create/update');
	if (res?.ok !== false) ok += 1;
	else fail += 1;
}

for (const item of enrichExisting) {
	const { slug, name, profileType, ...rest } = item;
	const args = {
		profileType: profileType || 'firm',
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
