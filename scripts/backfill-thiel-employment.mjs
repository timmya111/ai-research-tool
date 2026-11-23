#!/usr/bin/env node
/**
 * Curated backfill: Peter Thiel employer HQ street addresses + employment start/end dates.
 * Also merges bogus firm:partner-in-founders-fund into firm:founders-fund.
 *
 * Usage: node scripts/backfill-thiel-employment.mjs
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
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { withProfilesTransaction, getProfilesDb } = await import('../src/lib/research/profiles/db.ts');
const {
	getProfile,
	addLocation,
	addPersonEmployment,
	mergeProfiles,
	upsertProfile,
	updateProfileFields,
	getProfileDetail,
} = await import('../src/lib/research/profiles/store.ts');
const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

const CORPUS = 'thiel-employment-curated';
const PERSON = 'person:peter-thiel';

/** Full public HQ / principal office addresses for Thiel employers. */
const FIRM_HQ = [
	{
		slug: 'firm:palantir-technologies',
		name: 'Palantir Technologies',
		hq: '19505 Biscayne Boulevard, Suite 2350, Aventura, FL 33180',
		startDate: '2003',
		endDate: null,
		note: 'Principal executive office (SEC 8-K / Sunbiz, effective 2026-02-17)',
	},
	{
		slug: 'firm:founders-fund',
		name: 'Founders Fund',
		hq: 'One Letterman Drive, Building D, 5th Floor, San Francisco, CA 94129',
		startDate: '2005',
		endDate: null,
		note: 'SEC Form D / firm disclosures; Letterman Digital Arts Center',
	},
	{
		slug: 'firm:clarium-capital',
		name: 'Clarium Capital',
		hq: '1 Letterman Drive, Building C, Suite 400, San Francisco, CA 94129',
		startDate: '2002',
		endDate: '2013',
		note: 'Historic SF HQ (SEC Form D / SF business registration); firm defunct ~2013',
	},
	{
		slug: 'firm:paypal',
		name: 'PayPal',
		hq: '2211 North First Street, San Jose, CA 95131',
		startDate: '1998',
		endDate: null,
		note: 'Current corporate HQ (PayPal company facts); Thiel era was Palo Alto / Mountain View',
	},
];

/** Employment spans for Peter Thiel at each firm. */
const EMPLOYMENTS = [
	{
		orgSlug: 'firm:palantir-technologies',
		orgName: 'Palantir Technologies',
		role: 'co-founder, Chairman',
		startDate: '2003',
		endDate: null,
		isCurrent: true,
		location: '19505 Biscayne Boulevard, Suite 2350, Aventura, FL 33180',
	},
	{
		orgSlug: 'firm:founders-fund',
		orgName: 'Founders Fund',
		role: 'founder, Partner',
		startDate: '2005',
		endDate: null,
		isCurrent: true,
		location: 'One Letterman Drive, Building D, 5th Floor, San Francisco, CA 94129',
	},
	{
		orgSlug: 'firm:clarium-capital',
		orgName: 'Clarium Capital',
		role: 'President',
		startDate: '2002',
		endDate: '2011',
		isCurrent: false,
		location: '1 Letterman Drive, Building C, Suite 400, San Francisco, CA 94129',
	},
	{
		orgSlug: 'firm:paypal',
		orgName: 'PayPal',
		role: 'co-founder',
		startDate: '1998',
		endDate: '2002',
		isCurrent: false,
		location: '2211 North First Street, San Jose, CA 95131',
	},
];

function setHq(profileId, raw, note, tx) {
	const parts = parseAddressParts(raw);
	addLocation(
		{
			profileId,
			raw,
			city: parts.city,
			county: parts.county,
			state: parts.state,
			country: parts.country || 'US',
			role: 'hq',
			sourceCorpus: CORPUS,
		},
		tx,
	);
	return note;
}

withProfilesTransaction((tx) => {
	const person = getProfile(PERSON, tx);
	if (!person) throw new Error(`Missing ${PERSON}`);

	// 1. Merge bogus "Partner in Founders Fund" firm into Founders Fund
	const bogus = getProfile('firm:partner-in-founders-fund', tx);
	const founders = getProfile('firm:founders-fund', tx);
	if (bogus && founders) {
		const merged = mergeProfiles(founders.id, bogus.id, tx);
		console.log(
			'merged partner-in-founders-fund → founders-fund',
			merged ? merged.mergedName : 'skip',
		);
	} else if (bogus && !founders) {
		updateProfileFields(
			bogus.id,
			{ name: 'Founders Fund', summary: bogus.summary || 'Venture capital firm co-founded by Peter Thiel.' },
			tx,
		);
		console.log('renamed partner-in-founders-fund → Founders Fund (no prior founders-fund card)');
	} else {
		console.log('no bogus partner-in-founders-fund card (ok)');
	}

	// 2. Firm HQ addresses + firm founding/defunct dates
	for (const firm of FIRM_HQ) {
		let prof = getProfile(firm.slug, tx);
		if (!prof) {
			prof = upsertProfile(
				{
					profileType: 'firm',
					name: firm.name,
					slug: firm.slug.replace(/^firm:/, ''),
					status: 'pinned',
					startDate: firm.startDate,
					endDate: firm.endDate,
					sourceCorpus: CORPUS,
					metadata: { hqNote: firm.note },
				},
				tx,
			);
			console.log('created', prof.slug);
		} else {
			updateProfileFields(
				prof.id,
				{
					startDate: firm.startDate || prof.startDate,
					endDate: firm.endDate !== undefined ? firm.endDate : prof.endDate,
					metadata: { ...(prof.metadata || {}), hqNote: firm.note },
				},
				tx,
			);
		}
		setHq(prof.id, firm.hq, firm.note, tx);
		console.log('hq', firm.slug, '→', firm.hq);
	}

	// 3. Dated employment links (also writes branch= location onto evidence + org)
	for (const emp of EMPLOYMENTS) {
		const added = addPersonEmployment(
			{
				personIdOrSlug: person.id,
				orgName: emp.orgName,
				orgIdOrSlug: emp.orgSlug,
				orgCategory: 'firm',
				role: emp.role,
				startDate: emp.startDate,
				endDate: emp.endDate,
				isCurrent: emp.isCurrent,
				location: emp.location,
				notes: `Curated employment history (${CORPUS})`,
				sourceCorpus: CORPUS,
			},
			tx,
		);
		console.log(
			'employment',
			emp.orgName,
			emp.startDate,
			'→',
			emp.endDate || 'present',
			added ? added.linkId.slice(0, 8) : 'FAIL',
		);
	}

	// 4. Patch undated legacy employed_by rows for the same orgs so UI merge keeps dates
	const db = tx;
	const patches = [
		{ toSlug: 'firm:palantir-technologies', start: '2003', end: null },
		{ toSlug: 'firm:founders-fund', start: '2005', end: null },
		{ toSlug: 'firm:clarium-capital', start: '2002', end: '2011' },
		{ toSlug: 'firm:paypal', start: '1998', end: '2002' },
	];
	for (const p of patches) {
		const org = getProfile(p.toSlug, db);
		if (!org) continue;
		const info = db
			.prepare(
				`UPDATE profile_links
         SET start_date = COALESCE(start_date, ?),
             end_date = COALESCE(end_date, ?),
             updated_at = ?
         WHERE from_profile_id = ? AND to_profile_id = ?
           AND relation_type IN ('employed_by','affiliated_with','business_tie')
           AND (start_date IS NULL OR end_date IS NULL)`,
			)
			.run(p.start, p.end, new Date().toISOString(), person.id, org.id);
		if (Number(info.changes || 0) > 0) {
			console.log('patched legacy dates', p.toSlug, 'rows', info.changes);
		}
	}
});

const detail = getProfileDetail(PERSON);
const emp = detail?.employmentHistory || [];
console.log('\n=== employmentHistory after backfill ===');
for (const e of emp.filter((x) => x.orgCategory === 'firm')) {
	console.log(
		JSON.stringify(
			{
				org: e.orgName,
				role: e.role,
				start: e.startDate,
				end: e.endDate,
				current: e.isCurrent,
				location: e.location,
			},
			null,
			0,
		),
	);
}
console.log('firm employment count', emp.filter((x) => x.orgCategory === 'firm').length);
void getProfilesDb;
