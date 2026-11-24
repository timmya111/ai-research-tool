#!/usr/bin/env node
/**
 * United Cerebral Palsy national (EIN 20-3568840) + historical Dallas/North Texas
 * affiliate notes, Easterseals North Texas peer, Elsie S. Bellows Fund.
 *
 * Usage: node scripts/import-ucp-national-dallas.mjs [--dry-run]
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
const CORPUS = 'ucp-national-dallas-2026-11-23';

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	{
		profileType: 'nonprofit',
		name: 'United Cerebral Palsy, Inc.',
		slug: 'nonprofit:united-cerebral-palsy-inc',
		status: 'pinned',
		startDate: '2005',
		endDate: '',
		summary:
			'United Cerebral Palsy, Inc. (UCP / UCP National) is the national 501(c)(3) coordinating and advocacy organization for a network of independent local UCP affiliates. Focuses on advocacy, resources, information/referral, research support, and public policy; direct services are delivered primarily by affiliates. Broader UCP movement founded in 1949; current national EIN entity formalized mid-2000s (tax-exempt ruling effective May 2006; year formed often listed as 2005). Formerly associated with United Cerebral Palsy Associations, Inc.\n\nCurrent address: 8401 Old Courthouse Rd, Vienna, VA 22182. Previous addresses include 1825 K Street NW, Suite 600, Washington, DC 20006 and 1660 L Street, Suite 700, Washington, DC 20036, plus other DC locations. Phone (800) 872-5827; website ucp.org.\n\nNetwork scale (recent): roughly 55–58 affiliates in the U.S. and Canada serving on the order of 150,000–200,000 people annually. National Form 990 revenue typically in the low-to-mid millions (affiliates file separately). Post-2000 emphasis includes affiliate support, assistive technology initiatives (e.g., Elsie S. Bellows Fund), advocacy, and “Life Without Limits” messaging. Form 990s available via ProPublica Nonprofit Explorer (EIN 20-3568840), GuideStar/Candid, and the IRS.\n\nDallas / North Texas: There is no single currently prominent “United Cerebral Palsy of Dallas” or “UCP of North Texas” that appears as an active, large independent affiliate in recent national UCP affiliate listings or major 990 databases in the same way as some other regional chapters. Historical references exist to United Cerebral Palsy of North Texas (sometimes styled UCP Association of Dallas County or similar) at 8802 Harry Hines Blvd., Dallas, TX 75235, with phone numbers in the 214-351-xxxx range and former websites ucpdallas.org and ucpnorthtexas.org. Services described in those records included early childhood development, community living supports (CLASS and HCS), group homes, adult programs, OT, PT, and speech therapy, and assistive technology/equipment loan programs. Some older event and resource materials reference a North Texas Service Center at the Harry Hines address. Related or successor-style disability service organizations in the Dallas area continue to serve people with cerebral palsy and other disabilities, but they are not always branded as active UCP affiliates in current national directories. Other North Texas disability nonprofits (such as Easterseals North Texas) operate in the region and serve overlapping populations, but they are separate organizations.\n\nHistory notes (post-2000): Local UCP-affiliated or named activity in Dallas/North Texas is documented in directories and event materials through at least the 2000s–2010s. The organization appears to have evolved, reduced visibility under the UCP name, or shifted affiliations over time; current national UCP affiliate maps and recent Form 990 searches do not prominently feature a large, independently filing Dallas UCP entity comparable to affiliates in other cities. Exact transition details (merger, rebranding, or wind-down) are best confirmed via Texas Secretary of State nonprofit filings, older Form 990s, or local archival sources. See profile United Cerebral Palsy of North Texas for the dedicated historical chapter card.',
		aliases: [
			'United Cerebral Palsy',
			'UCP',
			'UCP National',
			'United Cerebral Palsy Associations, Inc.',
		],
		locations: [
			{ raw: '8401 Old Courthouse Rd, Vienna, VA 22182', role: 'hq', city: 'Vienna', state: 'VA', country: 'US' },
			{ raw: '1825 K Street NW, Suite 600, Washington, DC 20006 (former)', role: 'associated', city: 'Washington', state: 'DC', country: 'US' },
			{ raw: '1660 L Street, Suite 700, Washington, DC 20036 (former)', role: 'associated', city: 'Washington', state: 'DC', country: 'US' },
		],
		identifiers: [
			{ scheme: 'irs_ein', value: '20-3568840' },
			{ scheme: 'url', value: 'https://ucp.org/' },
		],
		metadata: {
			ucpNetwork: true,
			industry: 'nonprofit',
			sector: 'disability_advocacy',
			taxExempt: '501c3',
			irsRuling: '2006-05',
			yearFormedRecords: '2005',
			movementFounded: '1949',
			phone: '800-872-5827',
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'nonprofit',
		name: 'United Cerebral Palsy of North Texas',
		slug: 'nonprofit:united-cerebral-palsy-of-north-texas',
		status: 'pinned',
		startDate: '2000',
		endDate: '',
		summary:
			'Dallas / North Texas historical UCP chapter notes. There is no single currently prominent “United Cerebral Palsy of Dallas” or “UCP of North Texas” that appears as an active, large independent affiliate in recent national UCP affiliate listings or major 990 databases in the same way as some other regional chapters.\n\nHistorical references: Older resource directories list United Cerebral Palsy of North Texas (sometimes styled UCP Association of Dallas County or similar) with an address of 8802 Harry Hines Blvd., Dallas, TX 75235 and phone numbers in the 214-351-xxxx range, plus a former website (ucpdallas.org or ucpnorthtexas.org). Services described in those records included early childhood development, community living supports (CLASS and HCS), group homes, adult programs, OT, PT, and speech therapy, and assistive technology/equipment loan programs. Some older event and resource materials reference a North Texas Service Center at the Harry Hines address.\n\nRelated organizations: Related or successor-style disability service organizations in the Dallas area (e.g., entities that have rebranded or partnered over time) continue to serve people with cerebral palsy and other disabilities, but they are not always branded as active UCP affiliates in current national directories. Other North Texas disability nonprofits (such as Easterseals North Texas) operate in the region and serve overlapping populations, but they are separate organizations.\n\nHistory notes (post-2000): Local UCP-affiliated or named activity in Dallas/North Texas is documented in directories and event materials through at least the 2000s–2010s. The organization appears to have evolved, reduced visibility under the UCP name, or shifted affiliations over time; current national UCP affiliate maps and recent Form 990 searches do not prominently feature a large, independently filing Dallas UCP entity comparable to affiliates in other cities. Exact transition details (merger, rebranding, or wind-down) are best confirmed via Texas Secretary of State nonprofit filings, older Form 990s, or local archival sources.\n\nNational parent: United Cerebral Palsy, Inc. (UCP National; EIN 20-3568840; Vienna, VA / ucp.org) coordinates the affiliate network; this Dallas/North Texas card documents historical local naming and directory evidence under the UCP brand.',
		aliases: [
			'UCP of North Texas',
			'United Cerebral Palsy Association of Dallas County',
			'UCP Dallas',
			'UCP North Texas',
			'United Cerebral Palsy of Dallas',
		],
		locations: [
			{
				raw: '8802 Harry Hines Blvd., Dallas, TX 75235 (historical directory address)',
				role: 'hq',
				city: 'Dallas',
				county: 'Dallas',
				state: 'TX',
				country: 'US',
			},
		],
		links: [
			{
				peerName: 'United Cerebral Palsy, Inc.',
				peerSlug: 'nonprofit:united-cerebral-palsy-inc',
				relationType: 'affiliated_with',
				roleLabel:
					'Historical Dallas/North Texas UCP-named affiliate or related chapter (status under UCP brand unclear in recent national directories)',
				createPeerIfMissing: false,
			},
			{
				peerName: 'Easterseals North Texas',
				peerSlug: 'nonprofit:easterseals-north-texas',
				relationType: 'business_tie',
				roleLabel: 'Dallas-area disability services peer (separate org; overlapping populations)',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			ucpNetwork: true,
			region: 'Dallas / North Texas',
			historicalAffiliate: true,
			currentNationalListingProminent: false,
			formerWebsites: ['ucpdallas.org', 'ucpnorthtexas.org'],
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'nonprofit',
		name: 'Easterseals North Texas',
		slug: 'nonprofit:easterseals-north-texas',
		status: 'pinned',
		endDate: '',
		summary:
			'North Texas disability services nonprofit serving people with cerebral palsy and other disabilities. Separate from United Cerebral Palsy; Dallas-area peer when historical UCP North Texas visibility under the UCP brand declined.',
		aliases: ['Easter Seals North Texas', 'Easterseals of North Texas'],
		locations: [
			{ raw: 'Dallas–Fort Worth / North Texas', role: 'associated', city: 'Dallas', county: 'Dallas', state: 'TX', country: 'US' },
		],
		identifiers: [{ scheme: 'url', value: 'https://www.easterseals.com/northtexas/' }],
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'nonprofit',
		name: 'Elsie S. Bellows Fund (UCP)',
		slug: 'nonprofit:elsie-s-bellows-fund-ucp',
		status: 'pinned',
		endDate: '',
		summary:
			'United Cerebral Palsy assistive technology initiative / fund (Elsie S. Bellows Fund) within the UCP National network.',
		aliases: ['Elsie S. Bellows Fund', 'UCP Elsie S. Bellows Fund'],
		links: [
			{
				peerName: 'United Cerebral Palsy, Inc.',
				peerSlug: 'nonprofit:united-cerebral-palsy-inc',
				relationType: 'owned_by',
				roleLabel: 'UCP assistive technology fund / initiative under UCP National',
				createPeerIfMissing: false,
			},
		],
		metadata: { ucpNetwork: true, sector: 'assistive_technology_fund' },
		sourceCorpus: CORPUS,
	},
];

console.log(`UCP national + Dallas import (${dryRun ? 'DRY RUN' : 'live'})`);
let ok = 0;
let fail = 0;
for (const item of batch) {
	if (dryRun) {
		console.log(`[dry-run] ${item.slug}`);
		ok += 1;
		continue;
	}
	const res = await upsertProfileTool(item);
	if (res?.ok !== false) ok += 1;
	else {
		fail += 1;
		console.log(`[fail] ${item.slug} — ${res?.error}`);
	}
	if (res?.ok !== false) console.log(`[ok] ${item.slug}`);
}
console.log(`Done. ok=${ok} fail=${fail}`);
