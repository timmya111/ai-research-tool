#!/usr/bin/env node
/**
 * Dallas College, Collin College, and North Central Texas College (Denton area)
 * education profiles with public staff-directory / historical-roster availability notes.
 *
 * Usage: node scripts/import-dallas-collin-denton-community-colleges.mjs [--dry-run]
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
const CORPUS = 'dallas-collin-denton-cc-staff-notes-2026-11-23';

const metaBase = {
	region: 'North Texas',
	sector: 'community_college',
	staffRecordsNote: true,
	corpora: [CORPUS],
};

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	{
		profileType: 'education',
		name: 'Dallas College',
		slug: 'education:dallas-college',
		status: 'pinned',
		startDate: '1965',
		endDate: '',
		summary: `Dallas College (formerly Dallas County Community College District, DCCCD) is the multi-campus public community college system serving Dallas County, Texas. Rebranded as Dallas College in 2020 while continuing the district’s campus network.

Public staff records availability: No complete public record exists of all past staff who ever worked at Dallas College. Current staff only — public employee directory on the Dallas College website (searchable; lists thousands of current faculty and staff with titles and campus). Historical catalogs — older course catalogs in online archives sometimes list full-time faculty and key administrators for specific years, but not complete staff rosters and not going back comprehensively. Retiree Association — Dallas College Retirees Association has some historical officer lists, covering only retirees who joined the group, not all former employees. Public records — as a public institution, certain employment information can be requested under the Texas Public Information Act, but full personnel files are generally restricted. Salary data for some years appears in public databases (e.g. OpenTheBooks for county-related payroll) but is incomplete and not a full historical staff list. No centralized public archive of every person who ever worked there.

Bottom line: Current faculty and staff directories are public. All historical staff (everyone who ever worked there) are not published in any single public record or database. Partial historical faculty lists appear in old catalogs; limited payroll or retiree information exists in scattered public sources. Full historical employee records are internal and subject to Texas Public Information Act rules (with privacy exceptions).`,
		aliases: [
			'Dallas County Community College District',
			'DCCCD',
			'Dallas County Community College',
			'Dallas College (DCCCD)',
		],
		locations: [
			{
				raw: 'Dallas County multi-campus system, Dallas, TX',
				role: 'hq',
				city: 'Dallas',
				county: 'Dallas',
				state: 'TX',
				country: 'US',
			},
		],
		identifiers: [{ scheme: 'url', value: 'https://www.dallascollege.edu/' }],
		metadata: {
			...metaBase,
			formerNames: ['Dallas County Community College District', 'DCCCD'],
			rebrandedYear: 2020,
			staffSources: [
				'current public employee directory',
				'historical course catalogs (partial faculty)',
				'Retirees Association officer lists',
				'Texas Public Information Act',
				'OpenTheBooks and similar payroll extracts (incomplete)',
			],
			completeHistoricalStaffPublic: false,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'education',
		name: 'Collin College',
		slug: 'education:collin-college',
		status: 'pinned',
		startDate: '1985',
		endDate: '',
		summary: `Collin College is the public community college district serving Collin County, Texas (founded as Collin County Community College; commonly Collin College).

Public staff records availability: No complete public record exists of all past staff who ever worked at Collin College. Current faculty and staff directories are available on the Collin College website (departmental and general listings). Historical course catalogs and some archived pages list faculty for given years, but there is no public master list of all past employees. Same Texas public-records rules apply; full historical staff records are not published.

Bottom line: Current faculty and staff directories are public. Comprehensive past-staff lists are not. Partial historical faculty lists appear in old catalogs. Full historical employee records are internal and subject to Texas Public Information Act rules (with privacy exceptions).`,
		aliases: [
			'Collin County Community College',
			'Collin County Community College District',
			'CCCC',
		],
		locations: [
			{
				raw: 'Collin County multi-campus system, McKinney / Plano area, TX',
				role: 'hq',
				city: 'McKinney',
				county: 'Collin',
				state: 'TX',
				country: 'US',
			},
		],
		identifiers: [{ scheme: 'url', value: 'https://www.collin.edu/' }],
		metadata: {
			...metaBase,
			formerNames: ['Collin County Community College'],
			staffSources: [
				'current faculty and staff directories',
				'historical course catalogs (partial faculty)',
				'Texas Public Information Act',
			],
			completeHistoricalStaffPublic: false,
		},
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'education',
		name: 'North Central Texas College',
		slug: 'education:north-central-texas-college',
		status: 'pinned',
		startDate: '1920',
		endDate: '',
		summary: `North Central Texas College (NCTC) is a public community college serving Denton County and surrounding counties in North Texas. There is no single “Denton Community College” with a complete historical staff archive; NCTC is the main community-college option for the Denton area. Nearby Dallas College and Collin College campuses or service areas may also reach parts of the broader metro.

Public staff records availability: NCTC has a current personnel listing in its catalog and related public directory materials. Current directories exist; comprehensive past-staff lists do not. Partial historical faculty lists may appear in older catalogs. Full historical employee records are internal and subject to Texas Public Information Act rules (with privacy exceptions), following the same pattern as Dallas College and Collin College.

Bottom line: Current faculty and staff directories are public for NCTC. All historical staff are not published in any single public record or database.`,
		aliases: [
			'NCTC',
			'North Central Texas College (NCTC)',
			'Gainesville Junior College',
		],
		locations: [
			{
				raw: 'North Central Texas College — Denton County and multi-campus service area, TX',
				role: 'hq',
				city: 'Gainesville',
				county: 'Cooke',
				state: 'TX',
				country: 'US',
			},
			{
				raw: 'Denton County service area, TX',
				role: 'associated',
				city: 'Denton',
				county: 'Denton',
				state: 'TX',
				country: 'US',
			},
		],
		identifiers: [{ scheme: 'url', value: 'https://www.nctc.edu/' }],
		links: [
			{
				peerName: 'Dallas College',
				peerSlug: 'education:dallas-college',
				relationType: 'business_tie',
				roleLabel: 'North Texas community-college peer (Dallas County)',
				createPeerIfMissing: false,
			},
			{
				peerName: 'Collin College',
				peerSlug: 'education:collin-college',
				relationType: 'business_tie',
				roleLabel: 'North Texas community-college peer (Collin County)',
				createPeerIfMissing: false,
			},
		],
		metadata: {
			...metaBase,
			servesCounties: ['Denton', 'Cooke', 'Montague', 'Wise'],
			staffSources: [
				'current catalog personnel listing',
				'current directories',
				'historical catalogs (partial)',
				'Texas Public Information Act',
			],
			completeHistoricalStaffPublic: false,
			noteNoDentonCommunityCollege: true,
		},
		sourceCorpus: CORPUS,
	},
];

// Cross-link Dallas ↔ Collin after NCTC links both
batch[0].links = [
	{
		peerName: 'Collin College',
		peerSlug: 'education:collin-college',
		relationType: 'business_tie',
		roleLabel: 'North Texas community-college peer (Collin County)',
		createPeerIfMissing: false,
	},
	{
		peerName: 'North Central Texas College',
		peerSlug: 'education:north-central-texas-college',
		relationType: 'business_tie',
		roleLabel: 'North Texas community-college peer (Denton area / NCTC)',
		createPeerIfMissing: false,
	},
];
batch[1].links = [
	{
		peerName: 'Dallas College',
		peerSlug: 'education:dallas-college',
		relationType: 'business_tie',
		roleLabel: 'North Texas community-college peer (Dallas County)',
		createPeerIfMissing: false,
	},
	{
		peerName: 'North Central Texas College',
		peerSlug: 'education:north-central-texas-college',
		relationType: 'business_tie',
		roleLabel: 'North Texas community-college peer (Denton area / NCTC)',
		createPeerIfMissing: false,
	},
];

console.log(`Dallas / Collin / Denton CC import (${dryRun ? 'DRY RUN' : 'live'})`);
let ok = 0;
let fail = 0;
async function runPass(label) {
	console.log(`— ${label}`);
	for (const item of batch) {
		if (dryRun) {
			console.log(`[dry-run] ${item.slug}`);
			ok += 1;
			continue;
		}
		const res = await upsertProfileTool(item);
		if (res?.ok !== false) {
			ok += 1;
			console.log(`[ok] ${item.slug}`);
		} else {
			fail += 1;
			console.log(`[fail] ${item.slug} — ${res?.error}`);
		}
	}
}
// Two passes so peer links resolve after all three cards exist.
await runPass('pass 1 (create/update)');
if (!dryRun) await runPass('pass 2 (cross-links)');
console.log(`Done. ok=${ok} fail=${fail}`);
