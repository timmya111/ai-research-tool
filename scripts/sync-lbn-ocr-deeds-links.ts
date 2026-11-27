import { syncOcrNameMatchesToProfileLinks } from '@/lib/research/legalDocsPipeline';
import { syncExistingLandDeedLinks } from '@/lib/research/profiles/associateDeeds';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	findExistingProfileDuplicate,
	getProfile,
	touchProfilesForUserAction,
	upsertProfile,
	upsertProfileLink,
} from '@/lib/research/profiles/store';
import type { ProfileRelationType, ProfileType, TimelineAngle } from '@/lib/research/profiles/types';

function ensureProfile(input: {
	name: string;
	profileType: ProfileType;
	summary: string;
	aliases?: string[];
}) {
	const dup = findExistingProfileDuplicate({
		name: input.name,
		profileType: input.profileType,
		aliases: input.aliases,
	});
	if (dup?.profile) return dup.profile;
	return upsertProfile({
		profileType: input.profileType,
		name: input.name,
		status: 'active',
		summary: input.summary,
		aliases: input.aliases,
		sourceCorpus: 'lbn-documented-relationships',
	});
}

function main() {
	const db = getProfilesDb();
	db.exec('PRAGMA busy_timeout = 10000;');

	const lbn = getProfile('firm:love-beal-nixon-p-c');
	if (!lbn) throw new Error('Profile firm:love-beal-nixon-p-c not found');

	// 1. Clean out stale/raw-newline/duplicate legal-api-ocr links on LBN before re-syncing cleanly
	const del = db
		.prepare(
			`DELETE FROM profile_links
       WHERE (from_profile_id = ? OR to_profile_id = ?)
         AND source_corpus = 'legal-api-ocr'`,
		)
		.run(lbn.id, lbn.id);
	console.log('Cleared old legal-api-ocr links on LBN:', del.changes);

	// 2. Enrich existing curated LBN links where court OCR docs add concrete docket details
	const enrichExistingByName: Array<{
		name: string;
		roleLabel: string;
		evidenceNote: string;
	}> = [
		{
			name: 'JPMorgan Chase & Co.',
			roleLabel: 'Creditor / garnishment counterparty & Amicus curiae',
			evidenceNote:
				'Court records reflect J.P. Morgan Chase Bank appearing alongside Love, Beal & Nixon, P.C. in post-judgment garnishment proceedings and bank-account garnishee workflows; JPMorgan Chase Bank, N.A. also joined as Amicus Curiae in DaimlerChrysler Financial Services v. Ballard & Quick (10th Cir. Nos. 07-5109 & 07-5112, May 19, 2008).',
		},
		{
			name: 'LVNV Funding LLC',
			roleLabel: 'Debt buyer client / FDCPA co-defendant',
			evidenceNote:
				'Public federal court dockets reflect Love, Beal & Nixon, P.C. representing or appearing alongside LVNV Funding LLC in consumer collection litigation, including as co-defendants in Webb v. Love Beal & Nixon PC, LVNV Funding, LLC & Resurgent Capital Services, LP (E.D. Ark. No. 3:24-cv-39-DPM, dismissed with prejudice following settlement).',
		},
		{
			name: 'Resurgent Capital Services LP',
			roleLabel: 'Collection agency / servicer client & FDCPA co-defendant',
			evidenceNote:
				'Public federal court records reflect representation or joint co-defendant status alongside Love, Beal & Nixon, P.C., including Webb v. Love Beal & Nixon PC, LVNV Funding, LLC & Resurgent Capital Services, LP (E.D. Ark. No. 3:24-cv-39-DPM, dismissed with prejudice following settlement).',
		},
	];

	for (const item of enrichExistingByName) {
		const hit = findExistingProfileDuplicate({ name: item.name, profileType: 'firm' });
		const peer = hit?.profile;
		if (!peer) continue;
		db.prepare(
			`UPDATE profile_links
       SET role_label = ?, evidence_note = ?
       WHERE ((from_profile_id = ? AND to_profile_id = ?) OR (from_profile_id = ? AND to_profile_id = ?))
         AND source_corpus = 'lbn-documented-relationships'`,
		).run(item.roleLabel, item.evidenceNote, lbn.id, peer.id, peer.id, lbn.id);
	}

	// 3. Upsert all companies/entities listed on LBN's Overview, History Timeline, and 9 Court Filings / OCR Docs
	const lbnConnections: Array<{
		name: string;
		profileType: ProfileType;
		summary: string;
		aliases?: string[];
		relationType: ProfileRelationType;
		roleLabel: string;
		startDate?: string | null;
		angle: TimelineAngle;
		sourceCorpus: string;
		evidenceNote: string;
	}> = [
		// From Overview / History Timeline
		{
			name: 'Asset Acceptance, LLC',
			profileType: 'firm',
			summary:
				'Asset Acceptance, LLC is a consumer debt buyer documented in Oklahoma appellate creditor-rights litigation.',
			aliases: ['Asset Acceptance L.L.C.'],
			relationType: 'business_tie',
			roleLabel: 'Debt buyer client (appellate litigation)',
			startDate: '2014',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'2014 — Love, Beal & Nixon, P.C. litigated appellate creditor-rights matters before the Oklahoma Court of Civil Appeals, including Asset Acceptance L.L.C. v. White (led by William L. Nixon, Jr. and Tracy Cotts Reed).',
		},
		{
			name: 'Oklahoma State and Education Employees Group Insurance Board',
			profileType: 'government',
			summary:
				'Oklahoma state employee and education group insurance board appearing in Oklahoma appellate proceedings.',
			aliases: ['OSEEGIB'],
			relationType: 'business_tie',
			roleLabel: 'State entity client (appellate proceedings)',
			startDate: '2011',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'2009–2012 — Oklahoma appellate proceedings on behalf of national banks and state entities, including Oklahoma State and Education Employees Group Insurance Board matters in 2011–2012.',
		},
		{
			name: 'University of Oklahoma',
			profileType: 'education',
			summary: 'Public research university in Norman, Oklahoma.',
			relationType: 'affiliated_with',
			roleLabel: 'Principal alma mater (1988 J.D.)',
			startDate: '1988',
			angle: 'academic_research',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				"Established October 1, 1988 in Oklahoma City as a professional corporation following principal William Lowell Nixon, Jr.'s 1988 J.D. graduation from the University of Oklahoma.",
		},
		{
			name: 'Oklahoma Bar Association',
			profileType: 'nonprofit',
			summary: 'Unified state bar association governing licensed attorneys in Oklahoma.',
			relationType: 'affiliated_with',
			roleLabel: 'Bar admission / licensing body',
			startDate: '1988',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				"Principal William Lowell Nixon, Jr. was admitted to the Oklahoma Bar Association in 1988 prior to establishing Love, Beal & Nixon, P.C. on October 1, 1988.",
		},
		{
			name: 'Cavalry SPV I, LLC',
			profileType: 'firm',
			summary: 'Institutional consumer debt buyer active in Oklahoma civil collection dockets.',
			relationType: 'business_tie',
			roleLabel: 'Debt buyer client & FDCPA co-defendant',
			startDate: '2017-09-18',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Represents institutional debt buyer Cavalry SPV I, LLC in Oklahoma county civil dockets (2020–2023, including Tulsa and Oklahoma Counties); also named co-defendants in Strickland v. Cavalry SPV I, LLC & Love, Beal, Nixon P.C. (W.D. Okla. Case No. CIV-17-1011-M).',
		},
		{
			name: 'SoloSuit',
			profileType: 'firm',
			summary: 'Consumer legal-tech platform publishing debt-settlement and collection defense guides.',
			relationType: 'mentioned_in',
			roleLabel: 'Published debt-settlement guide',
			startDate: '2026-07-16',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'July 16, 2026 — Article published on SoloSuit about how to settle debt with Love, Beal & Nixon, P.C.',
		},
		{
			name: 'Get Crowned Credit',
			profileType: 'firm',
			summary: 'Consumer credit guidance publisher.',
			relationType: 'mentioned_in',
			roleLabel: 'Published credit-report guide',
			startDate: '2026-11-08',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'November 8, 2026 — Article published on Get Crowned Credit about how to remove Love, Beal & Nixon, P.C. from a credit report.',
		},
		{
			name: 'Martindale-Hubbell',
			profileType: 'firm',
			summary: 'Legal directory and peer-review rating organization for attorneys and law firms.',
			relationType: 'mentioned_in',
			roleLabel: 'Legal directory / peer recognition',
			startDate: '2026',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Listed in Martindale-Hubbell directory (6621 N. Meridian Ave., Oklahoma City, OK 73116; leadership William L. Nixon and David O. Beal) and receives Martindale-Hubbell peer recognition in 2026.',
		},
		{
			name: 'FindLaw',
			profileType: 'firm',
			summary: 'Online legal directory and legal information publisher.',
			relationType: 'mentioned_in',
			roleLabel: 'Legal directory listing',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Public legal directory listing Love, Beal & Nixon, P.C. as a professional corporation at 6621 N. Meridian Ave., Oklahoma City, OK 73116 with leadership William L. Nixon and David O. Beal.',
		},
		{
			name: 'Better Business Bureau',
			profileType: 'nonprofit',
			summary: 'Nonprofit business accreditation and consumer complaint directory organization.',
			aliases: ['BBB'],
			relationType: 'mentioned_in',
			roleLabel: 'Business directory / complaint record',
			angle: 'corporate',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'BBB records list Love, Beal & Nixon, P.C. as a professional corporation at 6621 N. Meridian Ave., Oklahoma City, OK 73116 with leadership associated with William L. Nixon and David O. Beal.',
		},
		// From LBN's 9 Court Filings, CFPB & OCR Documents
		{
			name: 'DaimlerChrysler Financial Services',
			profileType: 'firm',
			summary:
				'Automotive captive finance lender (DaimlerChrysler Financial Services Americas LLC, successor by merger to DaimlerChrysler Services North America LLC).',
			aliases: ['DaimlerChrysler Financial Services Americas LLC'],
			relationType: 'business_tie',
			roleLabel: 'Appellate creditor client (10th Cir. & BAP)',
			startDate: '2007-07-05',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Layla Dougherty of Love, Beal & Nixon, P.C. (with co-counsel Crowe & Dunlevy) represented Appellant DaimlerChrysler Financial Services Americas LLC in DaimlerChrysler Financial Services v. Ballard & Quick (10th Cir. Nos. 07-5109 & 07-5112; 10th Cir. BAP Nos. NO-07-025 & NO-07-026, 2007–2008).',
		},
		{
			name: 'Crowe & Dunlevy',
			profileType: 'firm',
			summary: 'Oklahoma City law firm appearing as appellate co-counsel in Tenth Circuit litigation.',
			relationType: 'business_tie',
			roleLabel: 'Co-counsel for Appellant (10th Cir. Nos. 07-5109 & 07-5112)',
			startDate: '2008-05-19',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Stephen L. DeGiusti (Crowe & Dunlevy, Oklahoma City) appeared as co-counsel alongside Layla Dougherty (Love, Beal & Nixon, P.C.) for Appellant DaimlerChrysler Financial Services Americas LLC in 10th Cir. Nos. 07-5109 & 07-5112 (May 19, 2008).',
		},
		{
			name: 'Sooner State Bank',
			profileType: 'firm',
			summary: 'Oklahoma bank named as co-defendant in Oklahoma County District Court SC-2003-18355.',
			relationType: 'business_tie',
			roleLabel: 'Co-defendant (OSCN Oklahoma County SC-2003-18355)',
			startDate: '2003-09-26',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Named co-defendant alongside Love, Beal & Nixon, P.C. and Ford Motor Credit in Delores Smith v. Sooner State Bank, Ford Motor Credit, and Love Beal Nixon (Oklahoma County District Court No. SC-2003-18355, filed 09/26/2003; judgment for plaintiff vs. Sooner State Bank, dismissed-settled vs. Love Beal Nixon and Ford Motor Credit on 11/04/2003).',
		},
		{
			name: 'FORD MOTOR CREDIT COMPANY',
			profileType: 'firm',
			summary: 'Automotive finance company appearing as co-defendant in OSCN SC-2003-18355 and Amicus Curiae in 10th Cir. Nos. 07-5109 & 07-5112.',
			aliases: ['Ford Motor Credit', 'Ford Motor Credit Company, LLC'],
			relationType: 'business_tie',
			roleLabel: 'Co-defendant (OSCN SC-2003-18355) & Amicus curiae (10th Cir.)',
			startDate: '2003-09-26',
			angle: 'law_enforcement',
			sourceCorpus: 'lbn-documented-relationships',
			evidenceNote:
				'Named co-defendant alongside Love, Beal & Nixon, P.C. and Sooner State Bank in Delores Smith v. Sooner State Bank, Ford Motor Credit, and Love Beal Nixon (OSCN Oklahoma County SC-2003-18355, dismissed-settled 11/04/2003); also joined as Amicus Curiae in DaimlerChrysler Financial Services v. Ballard & Quick (10th Cir. Nos. 07-5109 & 07-5112, May 19, 2008).',
		},
	];

	for (const conn of lbnConnections) {
		const target = ensureProfile({
			name: conn.name,
			profileType: conn.profileType,
			summary: conn.summary,
			aliases: conn.aliases,
		});
		if (target.id === lbn.id) continue;
		upsertProfileLink(
			{
				fromProfileId: lbn.id,
				toProfileId: target.id,
				relationType: conn.relationType,
				roleLabel: conn.roleLabel,
				startDate: conn.startDate || null,
				status: 'observed',
				confidence: 0.95,
				angle: conn.angle,
				sourceCorpus: conn.sourceCorpus,
				evidenceNote: conn.evidenceNote,
				dedupeHint: `lbn-curated:${target.slug}`,
			},
			db,
		);
	}

	// 4. Run OCR name-match auto-linker across ALL cached court/docket OCR documents
	// (adds the 10th Cir. Amicus Curiae coalition — Bank of America, Wells Fargo, GMAC, Toyota Motor Credit,
	// Nuvell Credit, Nuvell National Auto Finance, American Suzuki Financial Services, Nissan Motor Acceptance,
	// American Honda Finance, AmeriCredit — plus Chickasaw Nation's OSCN counterparties!)
	const ocrSync = syncOcrNameMatchesToProfileLinks();
	console.log('OCR name-match link sync:', ocrSync);

	// 5. Run Land Deed name-match auto-linker across existing land_records timeline entries + ## Land Deeds summaries
	const deedSync = syncExistingLandDeedLinks();
	console.log('Land-deed name-match link sync:', deedSync);

	touchProfilesForUserAction([lbn.id]);

	// Print summary of LBN links
	const finalLbnLinks = db
		.prepare(
			`SELECT p.name, p.profile_type, l.relation_type, l.role_label, l.source_corpus, l.evidence_note
       FROM profile_links l
       JOIN profiles p ON p.id = CASE WHEN l.from_profile_id = ? THEN l.to_profile_id ELSE l.from_profile_id END
       WHERE l.from_profile_id = ? OR l.to_profile_id = ?
       ORDER BY p.name`,
		)
		.all(lbn.id, lbn.id, lbn.id) as Array<{
		name: string;
		profile_type: string;
		relation_type: string;
		role_label: string | null;
		source_corpus: string;
		evidence_note: string | null;
	}>;
	console.log(`\n=== FINAL LBN CONNECTED PROFILES (${finalLbnLinks.length}) ===`);
	for (const r of finalLbnLinks) {
		console.log(`- ${r.name} [${r.profile_type}] | ${r.relation_type} | ${r.role_label} | ${String(r.evidence_note || '').slice(0, 140)}`);
	}
}

main();
