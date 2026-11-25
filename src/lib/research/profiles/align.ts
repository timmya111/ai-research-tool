import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import {
	alignmentKindForProximity,
	cautionForCityWeight,
	cityColocationWeight,
	EDGE_WEIGHT_PROFILE_TYPES,
	EDGE_WEIGHT_TIERS,
	extractAddressProximityKeys,
	extractSuiteFloorToken,
	inferEdgeWeightSector,
	isCityLevelGeoKey,
	secondarySignalBoost,
	sharedSignificantFirmTokens,
	type GeoProximity,
} from '@/lib/research/profiles/edgeWeights';
import { normalizeText } from '@/lib/research/profiles/normalize';
import {
	buildProfileIdentityContext,
	buildSearchPhrasesForProfile,
	demoteBareCountyNameOnlyScore,
	evaluateIdentityMatch,
} from '@/lib/research/profiles/identity';
import {
	dateToEpochDays,
	normalizeIsoDate,
	sha256Key,
	stripLegalSuffixes,
} from '@/lib/research/profiles/normalize';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import {
	getProfileDetail,
	mergeProfiles,
	profilesHaveConflictingMajorIds,
	profilesShareMajorIdentity,
	getMajorIdentityMap,
	rowToAlignment,
	upsertAlignmentCandidate,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import type {
	AlignmentCandidate,
	AlignmentEvidenceItem,
	AlignmentKind,
	AlignmentStatus,
	CautionTier,
	ProfileType,
} from '@/lib/research/profiles/types';

export type RunAlignmentPassOptions = {
	includeKnowledgeCrossMatch?: boolean;
	geoWindowDays?: number;
	maxCountyProfiles?: number;
};

export type AlignmentPassReport = {
	sharedIdentifier: number;
	sameEntityAlias: number;
	crossSourceMention: number;
	sharedAffiliation: number;
	geoTemporalCoOccurrence: number;
	cityColocation: number;
	blockColocation: number;
	buildingColocation: number;
	/** Proposed geo colo auto-dismissed: both sides have FINRA CRDs with no overlap. */
	disjointCrdColocationDismissed: number;
	angleComparison: number;
	countyFilingMatch: number;
	knowledgeStoreMatch: number;
	possibleMatchNameOnly: number;
	totalUpserted: number;
	durationMs: number;
};

const STOP_ALIAS_WORDS = new Set([
	'united states',
	'american',
	'national',
	'international',
	'global',
	'world',
	'federal',
	'state',
	'department',
	'institute',
	'university',
	'center',
	'foundation',
	'group',
	'capital',
	'partners',
	'holdings',
	'research',
	'science',
	'health',
	'covid',
	'coronavirus',
	'vaccine',
	'texas',
	'oklahoma',
	'dallas',
]);

/** Generic 2+ token alias keys that collide unrelated FINRA/WEF firms / places / dynasties. */
const GENERIC_FIRM_ALIAS_KEYS = new Set([
	'wall street',
	'the times',
	'j p morgan',
	'jp morgan',
	'jpmorgan chase',
	'morgan stanley',
	'advanced',
	'vision',
	'united',
	'advantage',
	'strategy',
	'hugh martin',
	'guggenheim',
	'rockefeller',
	'rothschild',
	'endeavor',
	'national geographic',
	'lee seung hee',
]);

/** Skip same_entity_alias across these type pairs (person≠firm, district≠BD, etc.). */
function isCrossTypeAliasNoise(t1: string, t2: string): boolean {
	const a = String(t1 || '');
	const b = String(t2 || '');
	const pair = new Set([a, b]);
	if (pair.has('person') && (pair.has('firm') || pair.has('government') || pair.has('historic_event'))) {
		return true;
	}
	if (pair.has('historic_event') && pair.has('firm')) return true;
	return false;
}

/** Inbound link count above which a hub is treated as a high-degree employer/BD. */
const SHARED_AFFIL_HIGH_DEGREE_HUB = 40;

/** Natural-hazard timeline corpora — do not geo-temporal-match against federal press releases. */
const HAZARD_TIMELINE_CORPORA = new Set(['tornadoes', 'seismic']);
const AUTHORITY_TIMELINE_CORPORA = new Set(['authority-timelines']);

function isHazardAuthorityCoOccurrence(corpusA: string, corpusB: string): boolean {
	const a = String(corpusA || '').toLowerCase();
	const b = String(corpusB || '').toLowerCase();
	return (
		(HAZARD_TIMELINE_CORPORA.has(a) && AUTHORITY_TIMELINE_CORPORA.has(b)) ||
		(HAZARD_TIMELINE_CORPORA.has(b) && AUTHORITY_TIMELINE_CORPORA.has(a))
	);
}

/** Alumni / student roles vs professor / visiting scholar — no real shared-affiliation signal. */
function isAlumniFacultyRoleNoise(role1: string | null | undefined, role2: string | null | undefined): boolean {
	const alumniRe =
		/\b(alumni|alumnus|alumna|alumnae|graduate|graduated|student|mba|j\.?d\.?|ph\.?d\.?|class of)\b/i;
	const facultyRe =
		/\b(professor|scholar|faculty|lecturer|instructor|visiting|fellow|teacher|adjunct)\b/i;
	const governanceRe = /\b(trustee|board|regent|overseer|director|governor|fellow of the corporation)\b/i;
	const r1 = String(role1 || '');
	const r2 = String(role2 || '');
	const alum = (r: string) => alumniRe.test(r) && !governanceRe.test(r);
	const fac = (r: string) => facultyRe.test(r) && !governanceRe.test(r);
	return (alum(r1) && fac(r2)) || (alum(r2) && fac(r1));
}

/** Extract tornado/SPC-style event id from a historic_event title (#2411030157-01). */
function tornadoEventId(name: string): string | null {
	const m = String(name || '').match(/#([0-9]{6,}(?:-[0-9]+)?)/);
	return m ? m[1] : null;
}

/** Tokens of length ≥2 in a normalized alias (no stopword filter). */
function aliasRawTokens(normKey: string): string[] {
	return String(normKey || '')
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

/**
 * Local ingest tags for FINRA BrokerCheck / visualizer API data.
 * Display as "FINRA API"; identity is CRD from
 * https://finra-sec-data-visualizer-canvas.vercel.app/dashboard?disable_analytics=1
 * (merged/firm|individual) — never treat the canvas itself as a merge source.
 */
const FINRA_PERSON_CORPORA = new Set([
	'finra-visualizer',
	'finra-api',
	'finra-brokercheck',
	'finra-rosters',
]);

function isFinraPersonCorpus(corpus: string): boolean {
	return FINRA_PERSON_CORPORA.has(String(corpus || '').toLowerCase());
}

/**
 * Middle name / initial signal: ≥3 name tokens, or a single-letter middle initial
 * (e.g. "Peter Clark Rockefeller", "R. James Nicholson", "John F Kennedy").
 */
function personNameHasMiddleSignal(name: string, aliases: string[]): boolean {
	for (const raw of [name, ...aliases]) {
		const tokens = String(raw || '')
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (tokens.length >= 3) return true;
		if (tokens.some((t) => /^[A-Za-z]\.?$/.test(t))) return true;
	}
	return false;
}

function significantOrgTokens(orgName: string): Set<string> {
	const stripped = stripLegalSuffixes(normalizeText(orgName));
	return new Set(
		stripped
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length >= 3 && !STOP_ALIAS_WORDS.has(t)),
	);
}

/** True when a FINRA registration firm shares a significant token (or substring) with a non-FINRA org. */
function finraEmployerCorroborated(finraOrgs: string[], otherOrgs: string[]): boolean {
	for (const f of finraOrgs) {
		const ft = significantOrgTokens(f);
		const fn = stripLegalSuffixes(normalizeText(f));
		for (const o of otherOrgs) {
			const ot = significantOrgTokens(o);
			const on = stripLegalSuffixes(normalizeText(o));
			for (const t of ft) {
				if (ot.has(t)) return true;
			}
			if (fn.length >= 6 && on.length >= 6 && (fn.includes(on) || on.includes(fn))) return true;
		}
	}
	return false;
}

/**
 * True when a knowledge hit is an OKCountyRecords / county land-records filing
 * (instrument number I-YYYY-…, okcountyrecords URL, or a *County* project that is not Research Drive).
 */
function isCountyFilingHit(projectName: string, title: string, url: string | null): boolean {
	const project = String(projectName || '');
	const ttl = String(title || '');
	const href = String(url || '');
	// Research Drive / WEF lists / screenshots are knowledge hits, never county filings.
	if (/research\s*drive/i.test(project)) return false;
	if (/okcountyrecords\.com/i.test(href)) return true;
	// OKCR instrument numbers (I-YYYY-…) in title or URL.
	if (/\bI-\d{4}-\d+\b/i.test(ttl) || /\bI-\d{4}-\d+\b/i.test(href)) return true;
	// Dallas (and similar) county-deeds projects without OKCR URLs.
	if (/\bcounty\s+deeds\b/i.test(project)) return true;
	// *County project folders also hold saved prompts/notes — require filing signal.
	return false;
}

function extractDateFromFiling(title: string, text: string): string | null {
	const hay = `${title}\n${text}`;
	const recMatch = hay.match(/(?:recorded|filed|date)[:\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
	if (recMatch) return normalizeIsoDate(recMatch[1]).date;
	const anyIso = hay.match(/\b(20[12]\d-\d{2}-\d{2})\b/);
	if (anyIso) return anyIso[1];
	const anySlash = hay.match(/\b(\d{1,2}\/\d{1,2}\/20[12]\d)\b/);
	if (anySlash) return normalizeIsoDate(anySlash[1]).date;
	return null;
}

/**
 * Scan the unified profiles store (and optionally read-only knowledge.sqlite) to
 * discover cross-source alignments, alias collisions, shared affiliations,
 * geo-temporal co-occurrences, multi-angle overlaps, and county-filing matches.
 */
export function runAlignmentPass(opts: RunAlignmentPassOptions = {}): AlignmentPassReport {
	const t0 = Date.now();
	const includeKnowledge = opts.includeKnowledgeCrossMatch !== false;
	const geoWindowDays = Math.max(1, Math.min(90, Number(opts.geoWindowDays ?? 14)));
	const maxCountyProfiles = Math.max(10, Math.min(250, Number(opts.maxCountyProfiles ?? 120)));

	const counts: AlignmentPassReport = {
		sharedIdentifier: 0,
		sameEntityAlias: 0,
		crossSourceMention: 0,
		sharedAffiliation: 0,
		geoTemporalCoOccurrence: 0,
		cityColocation: 0,
		blockColocation: 0,
		buildingColocation: 0,
		disjointCrdColocationDismissed: 0,
		angleComparison: 0,
		countyFilingMatch: 0,
		knowledgeStoreMatch: 0,
		possibleMatchNameOnly: 0,
		totalUpserted: 0,
		durationMs: 0,
	};

	const actorTypeSql = EDGE_WEIGHT_PROFILE_TYPES.map((t) => `'${t}'`).join(', ');

	const db = getProfilesDb();

	// 1. Shared Identifiers (exact CRD / CIK / Ticker / EIN / URL across different profiles)
	// parent_sec_cik / url are relational or locators, not same-entity identity keys
	// finra_crd is a shared numeric namespace for Firm CRDs and Individual CRDs — never treat
	// person↔org finra_crd collisions as same-entity (e.g. firm 288811 ≠ individual 288811).
	// Same-kind matches are mergeable: firm↔firm (incl. mistyped education/gov org cards)
	// or person↔person. Org↔org same Firm CRD → Merge into firm:; person↔person same
	// Individual CRD → Merge. Verify kind via visualizer merged/firm vs merged/individual.
	const sharedIdentRows = db
		.prepare(
			`SELECT a.profile_id AS p1, b.profile_id AS p2, a.scheme, a.value,
              p1.name AS n1, p2.name AS n2, p1.profile_type AS t1, p2.profile_type AS t2,
              a.source_corpus AS c1, b.source_corpus AS c2
       FROM profile_identifiers a
       JOIN profile_identifiers b
         ON a.scheme = b.scheme AND a.normalized_value = b.normalized_value AND a.profile_id < b.profile_id
       JOIN profiles p1 ON p1.id = a.profile_id
       JOIN profiles p2 ON p2.id = b.profile_id
       WHERE a.scheme NOT IN ('parent_sec_cik', 'url', 'source_id', 'dossier_slug')
         AND NOT (
           a.scheme = 'finra_crd'
           AND (
             (p1.profile_type = 'person' AND p2.profile_type != 'person')
             OR (p2.profile_type = 'person' AND p1.profile_type != 'person')
           )
         )
       LIMIT 300`,
		)
		.all() as Array<Record<string, unknown>>;

	// 2. Same Entity Alias / Stripped Legal Name across distinct profiles
	const aliasGroups = db
		.prepare(
			`SELECT pa.normalized_alias, pa.profile_id, p.name, p.profile_type, pa.source_corpus
       FROM profile_aliases pa
       JOIN profiles p ON p.id = pa.profile_id
       WHERE length(pa.normalized_alias) >= 5`,
		)
		.all() as Array<Record<string, unknown>>;

	const byNormKey = new Map<
		string,
		Array<{ profileId: string; name: string; profileType: string; corpus: string }>
	>();
	for (const r of aliasGroups) {
		const rawNorm = String(r.normalized_alias);
		const keys = new Set<string>([rawNorm]);
		const stripped = stripLegalSuffixes(rawNorm);
		if (stripped.length >= 6 && stripped !== rawNorm) keys.add(stripped);

		for (const k of keys) {
			if (STOP_ALIAS_WORDS.has(k) || k.length < 5) continue;
			const list = byNormKey.get(k) || [];
			if (!list.some((x) => x.profileId === String(r.profile_id))) {
				list.push({
					profileId: String(r.profile_id),
					name: String(r.name),
					profileType: String(r.profile_type),
					corpus: String(r.source_corpus || 'unknown'),
				});
			}
			byNormKey.set(k, list);
		}
	}

	// 3. Cross-Source Mentions (single canonical profile present in >= 2 distinct corpora)
	const allProfiles = db
		.prepare('SELECT id, name, slug, profile_type, status, metadata_json FROM profiles')
		.all() as Array<Record<string, unknown>>;

	// Person alias + org-link maps for FINRA common-name CSM gate
	const personAliasesById = new Map<string, string[]>();
	for (const row of db
		.prepare(
			`SELECT pa.profile_id AS pid, pa.alias AS alias
       FROM profile_aliases pa
       JOIN profiles p ON p.id = pa.profile_id
       WHERE p.profile_type = 'person'`,
		)
		.all() as Array<Record<string, unknown>>) {
		const pid = String(row.pid);
		const list = personAliasesById.get(pid) || [];
		list.push(String(row.alias || ''));
		personAliasesById.set(pid, list);
	}
	const personFinraOrgsById = new Map<string, string[]>();
	const personOtherOrgsById = new Map<string, string[]>();
	for (const row of db
		.prepare(
			`SELECT l.from_profile_id AS pid, o.name AS org_name, l.source_corpus AS corpus, l.relation_type AS rel
       FROM profile_links l
       JOIN profiles o ON o.id = l.to_profile_id
       JOIN profiles p ON p.id = l.from_profile_id
       WHERE p.profile_type = 'person'
         AND l.relation_type IN ('registered_at', 'employed_by', 'affiliated_with', 'alumni_or_faculty')`,
		)
		.all() as Array<Record<string, unknown>>) {
		const pid = String(row.pid);
		const org = String(row.org_name || '');
		if (!org) continue;
		if (isFinraPersonCorpus(String(row.corpus || ''))) {
			const list = personFinraOrgsById.get(pid) || [];
			list.push(org);
			personFinraOrgsById.set(pid, list);
		} else {
			const list = personOtherOrgsById.get(pid) || [];
			list.push(org);
			personOtherOrgsById.set(pid, list);
		}
	}
	/** Distinct FINRA CRD count per person — used to auto-confirm FINRA↔FINRA CSM. */
	const personCrdCountById = new Map<string, number>();
	/**
	 * FINRA CRD sets per profile (API-backed ingest).
	 * Alias merges must not join profiles with disjoint CRD sets — those are distinct
	 * BrokerCheck registrants even when a shared short alias overlaps
	 * (e.g. "hudson securities" vs "hudson partners securities").
	 * Applies to firm and mis-typed education/government cards that still carry finra_crd.
	 */
	const crdsById = new Map<string, Set<string>>();
	for (const row of db
		.prepare(
			`SELECT profile_id AS pid, COUNT(DISTINCT value) AS n
       FROM profile_identifiers
       WHERE scheme = 'finra_crd'
       GROUP BY profile_id`,
		)
		.all() as Array<Record<string, unknown>>) {
		personCrdCountById.set(String(row.pid), Number(row.n || 0));
	}
	for (const row of db
		.prepare(
			`SELECT pi.profile_id AS pid, pi.value AS crd
       FROM profile_identifiers pi
       WHERE pi.scheme = 'finra_crd'`,
		)
		.all() as Array<Record<string, unknown>>) {
		const pid = String(row.pid);
		const crd = String(row.crd || '').trim();
		if (!crd) continue;
		const set = crdsById.get(pid) || new Set<string>();
		set.add(crd);
		crdsById.set(pid, set);
	}

	// 4. Shared Affiliations across DIFFERENT corpora
	// Keep person↔person (shared board seats) and org↔org only.
	// Skip firm↔person (MEMBER/PARENT holding ↔ rep fan-out).
	// Skip high-degree hubs (inbound links ≥ SHARED_AFFIL_HIGH_DEGREE_HUB) so
	// large BDs like ROCKEFELLER FINANCIAL do not emit O(n) colleague pairs.
	const sharedAffilRows = db
		.prepare(
			`SELECT l1.from_profile_id AS p1, l2.from_profile_id AS p2, l1.to_profile_id AS hub_id,
              hub.name AS hub_name, hub.profile_type AS hub_type,
              l1.source_corpus AS c1, l2.source_corpus AS c2,
              l1.role_label AS r1, l2.role_label AS r2,
              a1.name AS n1, a2.name AS n2,
              a1.profile_type AS t1, a2.profile_type AS t2
       FROM profile_links l1
       JOIN profile_links l2
         ON l1.to_profile_id = l2.to_profile_id
        AND l1.from_profile_id < l2.from_profile_id
        AND l1.source_corpus != l2.source_corpus
       JOIN profiles hub ON hub.id = l1.to_profile_id
       JOIN profiles a1 ON a1.id = l1.from_profile_id
       JOIN profiles a2 ON a2.id = l2.from_profile_id
       WHERE hub.profile_type IN ('firm', 'education', 'nonprofit', 'medical_hospital', 'government')
         AND (
           (a1.profile_type = 'person' AND a2.profile_type = 'person')
           OR (
             a1.profile_type IN ('firm', 'education', 'nonprofit', 'medical_hospital')
             AND a2.profile_type IN ('firm', 'education', 'nonprofit', 'medical_hospital')
           )
         )
         AND (
           SELECT COUNT(*) FROM profile_links pl WHERE pl.to_profile_id = hub.id
         ) < ${SHARED_AFFIL_HIGH_DEGREE_HUB}
       LIMIT 250`,
		)
		.all() as Array<Record<string, unknown>>;

	// 5. Geo-Temporal Co-Occurrence (timeline entries sharing geo_key within geoWindowDays across different corpora)
	const geoTimelineRows = db
		.prepare(
			`SELECT te.id, te.profile_id, te.event_date, te.title, te.angle, te.geo_key, te.geo_label,
              te.source_corpus, p.name AS profile_name, p.profile_type
       FROM timeline_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.geo_key IS NOT NULL
         AND te.event_date IS NOT NULL
         AND length(te.event_date) >= 10
       ORDER BY te.geo_key, te.event_date ASC`,
		)
		.all() as Array<Record<string, unknown>>;

	// 6. Multi-Angle Overlaps on historic_event / actor profiles
	// Require ≥2 distinct source corpora (no single-source self-matches like authority-timelines
	// tagging law_enforcement+policy). Roll up by calendar year so umbrella events
	// (COVID, Authority Initiatives) produce one proposal per year, not 12 monthly ones.
	const multiAngleRows = db
		.prepare(
			`SELECT p.id, p.name, p.profile_type,
              substr(te.event_date, 1, 4) AS yr,
              COUNT(DISTINCT te.angle) AS angle_count,
              COUNT(DISTINCT te.source_corpus) AS corpus_count,
              GROUP_CONCAT(DISTINCT te.angle) AS angles,
              GROUP_CONCAT(DISTINCT te.source_corpus) AS corpora,
              COUNT(*) AS entry_count
       FROM timeline_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.event_date IS NOT NULL AND length(te.event_date) >= 4
       GROUP BY p.id, yr
       HAVING corpus_count >= 2 AND angle_count >= 2
       ORDER BY angle_count DESC, entry_count DESC
       LIMIT 120`,
		)
		.all() as Array<Record<string, unknown>>;

	withProfilesTransaction((tx) => {
		// Profiles deleted by auto-merge inside this txn; later steps still hold
		// pre-txn snapshots (allProfiles, geo rows, etc.) and must not FK-insert them.
		const mergedAwayIds = new Set<string>();
		const recordMerge = (leftId: string, rightId: string) => {
			const result = mergeProfiles(leftId, rightId, tx);
			if (result) mergedAwayIds.add(result.mergedId);
			return result;
		};
		const profileAlive = (id: string) => !mergedAwayIds.has(id);

		// Commit (1) Shared Identifiers
		for (const r of sharedIdentRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			const scheme = String(r.scheme);
			const value = String(r.value);
			const evCorpus = (c: string) =>
				scheme === 'finra_crd' || isFinraPersonCorpus(String(c || ''))
					? 'finra-api'
					: String(c || 'profiles');
			const finraUrl =
				scheme === 'finra_crd'
					? `https://finra-sec-data-visualizer-canvas.vercel.app/dashboard/firm/${encodeURIComponent(value)}?disable_analytics=1`
					: null;
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['shared_identifier', p1, p2, scheme, value]),
					alignmentKind: 'shared_identifier',
					leftProfileId: p1,
					rightProfileId: p2,
					score: 0.96,
					cautionTier: 'stronger_indicator',
					rationale: `Exact shared identifier ${scheme}=${value} between "${String(r.n1)}" and "${String(r.n2)}".`,
					evidence: [
						{
							corpus: evCorpus(String(r.c1 || '')),
							label: `${String(r.n1)} (${scheme}: ${value})`,
							url: finraUrl,
						},
						{
							corpus: evCorpus(String(r.c2 || '')),
							label: `${String(r.n2)} (${scheme}: ${value})`,
							url: finraUrl,
						},
					],
				},
				tx,
			);
			counts.sharedIdentifier += 1;
		}

		// Commit (2) Same Entity Alias across distinct profiles (with strict person corroboration check)
		let aliasCount = 0;
		const aliasPairSeen = new Set<string>();
		for (const [normKey, group] of byNormKey.entries()) {
			if (group.length < 2 || group.length > 6) continue;
			// Block single-token surname/brand collisions (Rockwell, Emerson, Grosvenor).
			// Shared CRD/CIK still surfaces via shared_identifier.
			if (aliasRawTokens(normKey).length < 2) continue;
			if (GENERIC_FIRM_ALIAS_KEYS.has(normKey)) continue;
			for (let i = 0; i < group.length; i++) {
				for (let j = i + 1; j < group.length; j++) {
					if (aliasCount >= 250) break;
					const a = group[i];
					const b = group[j];
					const [left, right] = a.profileId < b.profileId ? [a, b] : [b, a];
					const pairKey = `${left.profileId}|${right.profileId}`;
					if (aliasPairSeen.has(pairKey)) continue;
					if (!profileAlive(left.profileId) || !profileAlive(right.profileId)) continue;
					const sameType = left.profileType === right.profileType;
					const crossCorpus = left.corpus !== right.corpus;

					// Distinct tornado / SPC events sharing only rating+date (different #ids)
					if (
						left.profileType === 'historic_event' &&
						right.profileType === 'historic_event'
					) {
						const idL = tornadoEventId(left.name);
						const idR = tornadoEventId(right.name);
						if (idL && idR && idL !== idR) continue;
					}

					// Person≠firm / person≠gov / historic_event≠firm alias collisions
					if (isCrossTypeAliasNoise(left.profileType, right.profileType)) continue;

					// FINRA identity is CRD from the visualizer merged API / dashboard,
					// not the local `finra-visualizer` corpus label or short alias overlap.
					// Also block when any major IDs (CRD/CIK/ticker/EIN/CUSIP) conflict.
					{
						if (profilesHaveConflictingMajorIds(left.profileId, right.profileId, tx)) {
							continue;
						}
						const crdsL = crdsById.get(left.profileId);
						const crdsR = crdsById.get(right.profileId);
						if (crdsL?.size && crdsR?.size) {
							let sharedCrd = false;
							for (const c of crdsL) {
								if (crdsR.has(c)) {
									sharedCrd = true;
									break;
								}
							}
							// Disjoint CRD sets → distinct registrants (never alias-merge).
							if (!sharedCrd) continue;
						} else if (
							// Both FINRA-ingested without a usable shared CRD: do not emit
							// name-only alias noise from the ingest corpus alone.
							isFinraPersonCorpus(left.corpus) &&
							isFinraPersonCorpus(right.corpus)
						) {
							continue;
						}
					}

					// For two person profiles sharing a name, verify whether any corroborating signal exists
					if (left.profileType === 'person' && right.profileType === 'person') {
						const dLeft = getProfileDetail(left.profileId);
						const dRight = getProfileDetail(right.profileId);
						if (dLeft && dRight) {
							const ctxLeft = buildProfileIdentityContext(dLeft);
							const ctxRight = buildProfileIdentityContext(dRight);
							const evalRes = evaluateIdentityMatch(ctxLeft, {
								candidateName: ctxRight.name,
								candidateAliases: ctxRight.aliases,
								candidateIdentifiers: ctxRight.identifiers,
								candidateLocations: ctxRight.locations.map((l) => l.raw),
								candidateFirms: ctxRight.firmsAndAssociates,
								candidateInstitutions: ctxRight.institutions,
								candidateMilitarySignals: ctxRight.militarySignals,
								candidateStartDate: ctxRight.startDate,
								candidateEndDate: ctxRight.endDate,
								candidateText: [
									ctxRight.summary,
									...ctxRight.locations.map((l) => l.raw),
									...ctxRight.firmsAndAssociates,
									...ctxRight.institutions,
									...ctxRight.militarySignals,
								].join(' '),
							});

							if (evalRes.decision === 'reject') continue;
							if (evalRes.decision === 'name_only_note') {
								aliasPairSeen.add(pairKey);
								upsertAlignmentCandidate(
									{
										dedupeKey: sha256Key(['possible_match_name_only', left.profileId, right.profileId]),
										alignmentKind: 'possible_match_name_only',
										leftProfileId: left.profileId,
										rightProfileId: right.profileId,
										score: evalRes.score,
										cautionTier: 'observation',
										rationale: `${evalRes.rationale} ${evalRes.missingValidationHint || ''}`.trim(),
										evidence: [
											{ corpus: left.corpus, label: `${left.name} [${left.profileType}]` },
											{ corpus: right.corpus, label: `${right.name} [${right.profileType}]` },
										],
									},
									tx,
								);
								counts.possibleMatchNameOnly += 1;
								aliasCount += 1;
								continue;
							}

							aliasPairSeen.add(pairKey);
							upsertAlignmentCandidate(
								{
									dedupeKey: sha256Key(['same_entity_alias', left.profileId, right.profileId]),
									alignmentKind: 'same_entity_alias',
									leftProfileId: left.profileId,
									rightProfileId: right.profileId,
									score: evalRes.score,
									cautionTier: evalRes.score >= 0.85 ? 'stronger_indicator' : 'closer_look',
									rationale: evalRes.rationale,
									evidence: [
										{ corpus: left.corpus, label: `${left.name} [${left.profileType}]` },
										{ corpus: right.corpus, label: `${right.name} [${right.profileType}]` },
									],
								},
								tx,
							);
							counts.sameEntityAlias += 1;
							aliasCount += 1;
							continue;
						}
					}

					aliasPairSeen.add(pairKey);

					// Exact duplicate cards (same type + identical display name) — e.g. repeated
					// authority-timelines lines. Auto-merge only when safe:
					// - historic_event / people without conflicting IDs, or
					// - orgs that share a major ID (CRD/CIK/ticker/EIN/CUSIP).
					// Never auto-merge two orgs that each have a different major ID.
					const leftNameNorm = normalizeText(left.name);
					const rightNameNorm = normalizeText(right.name);
					if (
						sameType &&
						leftNameNorm &&
						leftNameNorm === rightNameNorm
					) {
						const orgTypes = new Set([
							'firm',
							'nonprofit',
							'education',
							'medical_hospital',
							'government',
						]);
						const bothOrgs =
							orgTypes.has(left.profileType) && orgTypes.has(right.profileType);
						if (bothOrgs) {
							const leftIds = getMajorIdentityMap(left.profileId, tx);
							const rightIds = getMajorIdentityMap(right.profileId, tx);
							const leftHas = [...leftIds.values()].some((s) => s.size > 0);
							const rightHas = [...rightIds.values()].some((s) => s.size > 0);
							// Require a shared major ID when either side is ID-keyed.
							if (
								(leftHas || rightHas) &&
								!profilesShareMajorIdentity(left.profileId, right.profileId, tx)
							) {
								// Surface as proposed alias instead of silent merge.
							} else if (
								!leftHas &&
								!rightHas
							) {
								recordMerge(left.profileId, right.profileId);
								counts.sameEntityAlias += 1;
								aliasCount += 1;
								continue;
							} else if (
								profilesShareMajorIdentity(left.profileId, right.profileId, tx)
							) {
								recordMerge(left.profileId, right.profileId);
								counts.sameEntityAlias += 1;
								aliasCount += 1;
								continue;
							}
						} else if (
							!profilesHaveConflictingMajorIds(left.profileId, right.profileId, tx)
						) {
							recordMerge(left.profileId, right.profileId);
							counts.sameEntityAlias += 1;
							aliasCount += 1;
							continue;
						}
					}

					const score = (sameType ? 0.78 : 0.62) + (crossCorpus ? 0.1 : 0);
					const evidenceCorpus = (c: string) =>
						isFinraPersonCorpus(c) ? 'finra-api' : c;
					upsertAlignmentCandidate(
						{
							dedupeKey: sha256Key(['same_entity_alias', left.profileId, right.profileId]),
							alignmentKind: 'same_entity_alias',
							leftProfileId: left.profileId,
							rightProfileId: right.profileId,
							score,
							cautionTier: score >= 0.82 ? 'closer_look' : 'observation',
							rationale: `Shared normalized name/alias "${normKey}" across "${left.name}" (${left.profileType}, ${evidenceCorpus(left.corpus)}) and "${right.name}" (${right.profileType}, ${evidenceCorpus(right.corpus)}).`,
							evidence: [
								{
									corpus: evidenceCorpus(left.corpus),
									label: `${left.name} [${left.profileType}]`,
								},
								{
									corpus: evidenceCorpus(right.corpus),
									label: `${right.name} [${right.profileType}]`,
								},
							],
						},
						tx,
					);
					counts.sameEntityAlias += 1;
					aliasCount += 1;
				}
			}
		}

		// Commit (3) Cross-Source Mentions (same canonical profile enriched by >=2 corpora)
		for (const p of allProfiles) {
			const pid = String(p.id);
			if (!profileAlive(pid)) continue;
			let corpora: string[] = [];
			try {
				const meta = JSON.parse(String(p.metadata_json || '{}')) as Record<string, unknown>;
				if (Array.isArray(meta.corpora)) corpora = [...new Set(meta.corpora.map(String))];
			} catch {
				/* ignore */
			}
			if (corpora.length < 2) continue;
			const profileType = String(p.profile_type || '');

			// Person + FINRA corpus + non-FINRA corpus: require middle name/initial OR
			// corroborated employer/firm so common-name BrokerCheck reps do not flood CSM.
			// When the non-FINRA side is WEF / cabinets / dialog (public-figure corpora),
			// middle name alone is not enough — require employer corroboration
			// (blocks Eun Soo Kim / Sang Yup Lee / Imran Khan style collisions).
			const PUBLIC_FIGURE_CORPORA = new Set([
				'wef-amnc',
				'us-presidential-cabinets-curated',
				'epstein-dialog-curated',
				'dialog-curated',
				'dynasties-power-network-curated',
			]);
			const hasFinraCorpus = corpora.some((c) => isFinraPersonCorpus(c));
			const hasNonFinraCorpus = corpora.some((c) => !isFinraPersonCorpus(c));
			if (profileType === 'person' && hasFinraCorpus && hasNonFinraCorpus) {
				const aliases = personAliasesById.get(pid) || [];
				const middleOk = personNameHasMiddleSignal(String(p.name || ''), aliases);
				const employerOk = finraEmployerCorroborated(
					personFinraOrgsById.get(pid) || [],
					personOtherOrgsById.get(pid) || [],
				);
				const hasPublicFigureCorpus = corpora.some((c) =>
					PUBLIC_FIGURE_CORPORA.has(String(c || '').toLowerCase()),
				);
				if (hasPublicFigureCorpus) {
					if (!employerOk) continue;
				} else if (!middleOk && !employerOk) {
					continue;
				}
			}

			const score = Math.min(0.95, 0.65 + corpora.length * 0.1);
			const tier: CautionTier = corpora.length >= 3 ? 'stronger_indicator' : 'closer_look';
			// Auto-confirm FINRA-corpora-only person CSM with exactly one CRD
			// (rosters↔API same registrant — no manual queue).
			const finraOnly =
				profileType === 'person' &&
				corpora.length >= 2 &&
				corpora.every((c) => isFinraPersonCorpus(c));
			const singleCrd = (personCrdCountById.get(pid) || 0) === 1;
			// Org / event cards: multi-corpus on one profile is enrichment of the same
			// entity (MineralAnswers + chat dates, DFW + HQ search, etc.) — auto-confirm
			// so triage is not flooded. Person CSM stays manual except FINRA-only+single CRD.
			const orgOrEventAutoConfirm = [
				'firm',
				'education',
				'nonprofit',
				'government',
				'medical_hospital',
				'historic_event',
			].includes(profileType);
			const autoConfirm =
				orgOrEventAutoConfirm || (finraOnly && singleCrd);
			const displayCorpus = (c: string) =>
				isFinraPersonCorpus(c) ? 'finra-api' : String(c || '');
			const displayLabel = (c: string) =>
				isFinraPersonCorpus(c) ? 'Present in FINRA API' : `Present in ${c}`;
			const corporaForRationale = [
				...new Set(corpora.map((c) => displayCorpus(c))),
			];
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['cross_source_mention', pid]),
					alignmentKind: 'cross_source_mention',
					leftProfileId: pid,
					rightProfileId: null,
					score,
					cautionTier: tier,
					rationale: `"${String(p.name)}" (${profileType}) appears across ${corporaForRationale.length} distinct data sources: ${corporaForRationale.join(', ')}.`,
					evidence: corpora.map((c) => ({
						corpus: displayCorpus(c),
						label: displayLabel(c),
					})),
					status: autoConfirm ? 'confirmed' : undefined,
				},
				tx,
			);
			counts.crossSourceMention += 1;
		}

		// Commit (4) Shared Affiliations across different corpora
		for (const r of sharedAffilRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			if (!profileAlive(p1) || !profileAlive(p2)) continue;
			const hubName = String(r.hub_name);
			const hubType = String(r.hub_type || '');
			// Education hubs: skip Alumni/student ↔ Professor/Scholar (keep Trustee/Board pairs).
			if (
				hubType === 'education' &&
				isAlumniFacultyRoleNoise(
					r.r1 != null ? String(r.r1) : null,
					r.r2 != null ? String(r.r2) : null,
				)
			) {
				continue;
			}
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['shared_affiliation', p1, p2, String(r.hub_id)]),
					alignmentKind: 'shared_affiliation',
					leftProfileId: p1,
					rightProfileId: p2,
					score: 0.72,
					cautionTier: 'observation',
					rationale: `"${String(r.n1)}" (${String(r.c1)}) and "${String(r.n2)}" (${String(r.c2)}) both connect to ${hubName} (${hubType}).`,
					evidence: [
						{ corpus: String(r.c1), label: `${String(r.n1)} → ${hubName}${r.r1 ? ` (${String(r.r1)})` : ''}` },
						{ corpus: String(r.c2), label: `${String(r.n2)} → ${hubName}${r.r2 ? ` (${String(r.r2)})` : ''}` },
					],
				},
				tx,
			);
			counts.sharedAffiliation += 1;
		}

		// Commit (5) Geo-Temporal Co-Occurrence
		const byGeo = new Map<string, Array<Record<string, unknown>>>();
		for (const r of geoTimelineRows) {
			const gk = String(r.geo_key);
			// Skip country-only buckets to avoid noisy coincidences; focus on city/county/state level
			if (gk.startsWith('country:') || gk.startsWith('raw:')) continue;
			const list = byGeo.get(gk) || [];
			list.push(r);
			byGeo.set(gk, list);
		}

		let geoAdded = 0;
		for (const [geoKey, list] of byGeo.entries()) {
			if (list.length < 2 || geoAdded >= 180) continue;
			const nCity = list.length;
			for (let i = 0; i < list.length && geoAdded < 180; i++) {
				const a = list[i];
				const dayA = dateToEpochDays(String(a.event_date));
				if (dayA == null) continue;
				for (let j = i + 1; j < list.length && geoAdded < 180; j++) {
					const b = list[j];
					const dayB = dateToEpochDays(String(b.event_date));
					if (dayB == null) continue;
					const diff = Math.abs(dayB - dayA);
					if (diff > geoWindowDays) break;
					if (String(a.source_corpus) === String(b.source_corpus)) continue;
					if (String(a.profile_id) === String(b.profile_id)) continue;
					if (!profileAlive(String(a.profile_id)) || !profileAlive(String(b.profile_id))) {
						continue;
					}
					// Tornadoes/seismic must not pair with authority-timelines (ICE/HSI) on OK/TX dates.
					if (isHazardAuthorityCoOccurrence(String(a.source_corpus), String(b.source_corpus))) {
						continue;
					}

					const [left, right] =
						String(a.profile_id) < String(b.profile_id) ? [a, b] : [b, a];
					const sectorA = inferEdgeWeightSector({
						profileType: String(left.profile_type) as ProfileType,
						name: String(left.profile_name || ''),
						summary: String(left.title || ''),
					});
					const sectorB = inferEdgeWeightSector({
						profileType: String(right.profile_type) as ProfileType,
						name: String(right.profile_name || ''),
						summary: String(right.title || ''),
					});
					const wCity = isCityLevelGeoKey(geoKey)
						? cityColocationWeight({ sectorA, sectorB, nCity })
						: EDGE_WEIGHT_TIERS.sameCityDifferentSector.min;
					const temporal = Number((0.55 - (diff / (geoWindowDays + 1)) * 0.18).toFixed(4));
					const score = Number(
						Math.min(
							EDGE_WEIGHT_TIERS.sharedConferenceOrEvent.max + 0.15,
							Math.max(0.12, temporal + wCity),
						).toFixed(3),
					);
					upsertAlignmentCandidate(
						{
							dedupeKey: sha256Key([
								'co_occurrence_time_geo',
								String(left.profile_id),
								String(right.profile_id),
								geoKey,
								String(left.event_date).slice(0, 7),
							]),
							alignmentKind: 'co_occurrence_time_geo',
							leftProfileId: String(left.profile_id),
							rightProfileId: String(right.profile_id),
							score,
							cautionTier: cautionForCityWeight(wCity),
							rationale: `Geo-temporal overlap (${diff}d apart) in ${String(left.geo_label || geoKey)} between ${String(left.source_corpus)} ("${String(left.title).slice(0, 70)}") and ${String(right.source_corpus)} ("${String(right.title).slice(0, 70)}"); city weight ${wCity} (N_city=${nCity}, sectors ${sectorA}/${sectorB}).`,
							evidence: [
								{
									corpus: String(left.source_corpus),
									label: String(left.title).slice(0, 120),
									date: String(left.event_date),
									geoKey,
								},
								{
									corpus: String(right.source_corpus),
									label: String(right.title).slice(0, 120),
									date: String(right.event_date),
									geoKey,
								},
							],
						},
						tx,
					);
					counts.geoTemporalCoOccurrence += 1;
					geoAdded += 1;
				}
			}
		}

		// Commit (5b) Geo co-location: building > block > city across all main categories.
		// Building/block matches also query shared firms, roles, and name tokens.
		const cityLocRows = db
			.prepare(
				`SELECT pl.profile_id, pl.geo_key, pl.raw, pl.city, pl.role,
                p.name, p.profile_type, p.summary, p.metadata_json
         FROM profile_locations pl
         JOIN profiles p ON p.id = pl.profile_id
         WHERE p.profile_type IN (${actorTypeSql})
           AND pl.geo_key IS NOT NULL
           AND length(pl.geo_key) > 4`,
			)
			.all() as Array<Record<string, unknown>>;

		type CityMember = {
			profileId: string;
			name: string;
			profileType: ProfileType;
			summary: string;
			metadata: Record<string, unknown>;
			raw: string;
			role: string;
			geoKey: string;
			buildingKey: string | null;
			blockKey: string | null;
		};
		const byCity = new Map<string, CityMember[]>();
		const byBuilding = new Map<string, CityMember[]>();
		const byBlock = new Map<string, CityMember[]>();

		const NAME_STOP = new Set([
			...STOP_ALIAS_WORDS,
			'inc',
			'llc',
			'ltd',
			'corp',
			'the',
			'and',
			'of',
			'company',
			'group',
		]);

		function parseMetadata(raw: unknown): Record<string, unknown> {
			try {
				return raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
			} catch {
				return {};
			}
		}

		function sectorFor(m: CityMember) {
			return inferEdgeWeightSector({
				profileType: m.profileType,
				name: m.name,
				summary: m.summary,
				metadata: m.metadata,
				industry: typeof m.metadata.industry === 'string' ? m.metadata.industry : null,
				categoryTags: Array.isArray(m.metadata.categoryTags)
					? (m.metadata.categoryTags as string[])
					: null,
			});
		}

		/** FINRA CRDs from identifiers + metadata.finraCrd (firm or individual). */
		function crdsForMember(m: CityMember): Set<string> {
			const set = new Set<string>(crdsById.get(m.profileId) || []);
			const meta = m.metadata.finraCrd ?? m.metadata.crd;
			if (meta != null && String(meta).trim()) set.add(String(meta).trim());
			return set;
		}

		function nameTokens(name: string): Set<string> {
			return new Set(
				normalizeText(name)
					.split(/\s+/)
					.filter((t) => t.length >= 3 && !NAME_STOP.has(t)),
			);
		}

		const firmPeerStmt = db.prepare(
			`SELECT CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END AS peer_id,
              p.name AS peer_name,
              pl.role_label
       FROM profile_links pl
       JOIN profiles p ON p.id = CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END
       WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
         AND p.profile_type IN ('firm', 'nonprofit', 'education', 'medical_hospital', 'government')
         AND pl.relation_type IN (
           'employed_by', 'affiliated_with', 'owned_by', 'business_tie',
           'registered_at', 'alumni_or_faculty', 'funded_by'
         )
       LIMIT 40`,
		);

		const aliasStmt = db.prepare(
			`SELECT alias FROM profile_aliases WHERE profile_id = ? LIMIT 24`,
		);

		function querySecondaryGeoSignals(leftId: string, rightId: string, leftName: string, rightName: string) {
			const leftPeers = firmPeerStmt.all(leftId, leftId, leftId, leftId) as Array<Record<string, unknown>>;
			const rightPeers = firmPeerStmt.all(rightId, rightId, rightId, rightId) as Array<
				Record<string, unknown>
			>;
			const rightPeerById = new Map(rightPeers.map((p) => [String(p.peer_id), p]));
			const sharedFirmNames: string[] = [];
			const sharedRoles: string[] = [];
			for (const lp of leftPeers) {
				const id = String(lp.peer_id);
				const rp = rightPeerById.get(id);
				if (!rp) continue;
				const peerName = String(lp.peer_name || rp.peer_name || id);
				if (!sharedFirmNames.includes(peerName)) sharedFirmNames.push(peerName);
				const roleL = String(lp.role_label || '').trim().toLowerCase();
				const roleR = String(rp.role_label || '').trim().toLowerCase();
				if (roleL && roleR && roleL === roleR && !sharedRoles.includes(roleL)) {
					sharedRoles.push(roleL);
				}
			}

			const leftAliases = (aliasStmt.all(leftId) as Array<{ alias?: string }>).map((a) =>
				String(a.alias || ''),
			);
			const rightAliases = (aliasStmt.all(rightId) as Array<{ alias?: string }>).map((a) =>
				String(a.alias || ''),
			);
			const leftTok = new Set<string>();
			for (const n of [leftName, ...leftAliases]) {
				for (const t of nameTokens(n)) leftTok.add(t);
			}
			const overlap: string[] = [];
			for (const n of [rightName, ...rightAliases]) {
				for (const t of nameTokens(n)) {
					if (leftTok.has(t) && !overlap.includes(t)) overlap.push(t);
				}
			}

			const boost = secondarySignalBoost({
				sharedFirmCount: sharedFirmNames.length,
				sharedRoleCount: sharedRoles.length,
				nameTokenOverlapCount: overlap.length,
			});
			return { sharedFirmNames, sharedRoles, nameTokenOverlap: overlap, boost };
		}

		for (const r of cityLocRows) {
			const geoKey = String(r.geo_key || '');
			const role = String(r.role || '');
			if (role && !/hq|registered|associated|branch|campus/i.test(role)) continue;
			const raw = String(r.raw || '');
			const keys = extractAddressProximityKeys(raw, geoKey);
			const cityEligible = isCityLevelGeoKey(geoKey);
			// Street-level raw addresses still participate in building/block even without city geo_key
			if (!cityEligible && !keys.buildingKey && !keys.blockKey) continue;

			const pid = String(r.profile_id);
			const member: CityMember = {
				profileId: pid,
				name: String(r.name || ''),
				profileType: String(r.profile_type) as ProfileType,
				summary: String(r.summary || ''),
				metadata: parseMetadata(r.metadata_json),
				raw,
				role,
				geoKey,
				buildingKey: keys.buildingKey,
				blockKey: keys.blockKey,
			};

			if (cityEligible) {
				const list = byCity.get(geoKey) || [];
				if (!list.some((x) => x.profileId === pid)) {
					list.push(member);
					byCity.set(geoKey, list);
				}
			}
			if (keys.buildingKey) {
				const list = byBuilding.get(keys.buildingKey) || [];
				if (!list.some((x) => x.profileId === pid)) {
					list.push(member);
					byBuilding.set(keys.buildingKey, list);
				}
			}
			if (keys.blockKey) {
				const list = byBlock.get(keys.blockKey) || [];
				if (!list.some((x) => x.profileId === pid)) {
					list.push(member);
					byBlock.set(keys.blockKey, list);
				}
			}
		}

		const coveredPairs = new Set<string>();
		function pairKey(a: string, b: string): string {
			return a < b ? `${a}|${b}` : `${b}|${a}`;
		}

		function emitGeoPair(
			a: CityMember,
			b: CityMember,
			proximity: GeoProximity,
			clusterKey: string,
			nCluster: number,
			budget: { added: number; max: number },
		): boolean {
			if (budget.added >= budget.max) return false;
			if (!profileAlive(a.profileId) || !profileAlive(b.profileId)) return false;
			const pk = pairKey(a.profileId, b.profileId);
			if (coveredPairs.has(pk)) return false;

			// Building grain: firm↔firm only (drop HQ coworker person↔person fan-out).
			// When firms=0, require matching suite/floor so multi-tenant towers do not collide
			// on generic finance name tokens (Sovran Suite 800 ≠ Pure Suite 1550).
			if (proximity === 'building') {
				if (a.profileType !== 'firm' || b.profileType !== 'firm') {
					coveredPairs.add(pk);
					return false;
				}
			}

			// Distinct FINRA CRDs (firm or person) ⇒ distinct registrants. Shared
			// suite/building is multi-tenant noise, not same-entity evidence — skip
			// (existing proposed rows are swept to dismissed after the geo pass).
			{
				const crdsA = crdsForMember(a);
				const crdsB = crdsForMember(b);
				if (crdsA.size > 0 && crdsB.size > 0) {
					let sharedCrd = false;
					for (const c of crdsA) {
						if (crdsB.has(c)) {
							sharedCrd = true;
							break;
						}
					}
					if (!sharedCrd) {
						coveredPairs.add(pk);
						return false;
					}
				}
			}

			const sectorA = sectorFor(a);
			const sectorB = sectorFor(b);
			let wGeo = cityColocationWeight({
				sectorA,
				sectorB,
				nCity: nCluster,
				proximity,
			});

			const [left, right] = a.profileId < b.profileId ? [a, b] : [b, a];
			const evidence: AlignmentEvidenceItem[] = [
				{
					corpus: 'profiles',
					label: `${left.name} @ ${left.raw || left.geoKey}`,
					geoKey: left.geoKey,
				},
				{
					corpus: 'profiles',
					label: `${right.name} @ ${right.raw || right.geoKey}`,
					geoKey: right.geoKey,
				},
			];

			let secondaryNote = '';
			if (proximity === 'building' || proximity === 'block') {
				const secondary = querySecondaryGeoSignals(
					left.profileId,
					right.profileId,
					left.name,
					right.name,
				);
				if (proximity === 'building' && secondary.sharedFirmNames.length === 0) {
					const suiteL = extractSuiteFloorToken(left.raw);
					const suiteR = extractSuiteFloorToken(right.raw);
					const suiteOk = Boolean(suiteL && suiteR && suiteL === suiteR);
					const brandTokens = sharedSignificantFirmTokens(left.name, right.name);
					// Require same suite/floor OR a non-generic shared brand token
					// (blocks Sovran↔Pure / Bell Potter↔Samsung; keeps Oppenheimer / Ascendiant).
					if (!suiteOk && brandTokens.length === 0) {
						coveredPairs.add(pk);
						return false;
					}
					if (suiteOk) {
						evidence.push({
							corpus: 'profiles',
							label: `Matching suite/floor: ${suiteL}`,
							snippet: String(suiteL),
							geoKey: clusterKey,
						});
					}
					if (brandTokens.length) {
						evidence.push({
							corpus: 'profiles',
							label: `Shared brand tokens: ${brandTokens.slice(0, 4).join(', ')}`,
							snippet: brandTokens.join(', '),
							geoKey: clusterKey,
						});
					}
				}
				wGeo = Number(
					Math.min(
						proximity === 'building'
							? EDGE_WEIGHT_TIERS.sameBuildingSameSector.max + 0.08
							: EDGE_WEIGHT_TIERS.sameBlockSameSector.max + 0.06,
						wGeo + secondary.boost,
					).toFixed(4),
				);
				if (secondary.sharedFirmNames.length) {
					evidence.push({
						corpus: 'profiles',
						label: `Shared org peers: ${secondary.sharedFirmNames.slice(0, 4).join('; ')}`,
						snippet: secondary.sharedFirmNames.slice(0, 6).join(', '),
						geoKey: clusterKey,
					});
				}
				if (secondary.sharedRoles.length) {
					evidence.push({
						corpus: 'profiles',
						label: `Shared roles: ${secondary.sharedRoles.slice(0, 4).join('; ')}`,
						snippet: secondary.sharedRoles.join(', '),
						geoKey: clusterKey,
					});
				}
				if (secondary.nameTokenOverlap.length) {
					evidence.push({
						corpus: 'profiles',
						label: `Name/alias token overlap: ${secondary.nameTokenOverlap.slice(0, 6).join(', ')}`,
						snippet: secondary.nameTokenOverlap.join(', '),
						geoKey: clusterKey,
					});
				}
				if (secondary.boost > 0) {
					secondaryNote = ` Secondary signals boost +${secondary.boost} (firms=${secondary.sharedFirmNames.length}, roles=${secondary.sharedRoles.length}, nameTokens=${secondary.nameTokenOverlap.length}).`;
				} else {
					secondaryNote = ' Secondary name/role/firm query ran with no shared peers.';
				}
			}

			coveredPairs.add(pk);
			const kind = alignmentKindForProximity(proximity);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key([kind, left.profileId, right.profileId, clusterKey]),
					alignmentKind: kind,
					leftProfileId: left.profileId,
					rightProfileId: right.profileId,
					score: wGeo,
					cautionTier: cautionForCityWeight(wGeo, proximity),
					rationale: `Same-${proximity} co-location (${clusterKey}) for "${left.name}" (${left.profileType}/${sectorA}) and "${right.name}" (${right.profileType}/${sectorB}); w_geo=${wGeo} (N=${nCluster}).${secondaryNote}`,
					evidence,
				},
				tx,
			);
			if (proximity === 'building') counts.buildingColocation += 1;
			else if (proximity === 'block') counts.blockColocation += 1;
			else counts.cityColocation += 1;
			budget.added += 1;
			return true;
		}

		const buildingBudget = { added: 0, max: 260 };
		const buildingClusters = [...byBuilding.entries()].sort((a, b) => a[1].length - b[1].length);
		for (const [bKey, members] of buildingClusters) {
			if (members.length < 2 || buildingBudget.added >= buildingBudget.max) continue;
			const maxPairs = members.length > 30 ? 40 : 120;
			let pairs = 0;
			for (let i = 0; i < members.length && pairs < maxPairs && buildingBudget.added < buildingBudget.max; i++) {
				for (let j = i + 1; j < members.length && pairs < maxPairs && buildingBudget.added < buildingBudget.max; j++) {
					if (emitGeoPair(members[i], members[j], 'building', bKey, members.length, buildingBudget)) {
						pairs += 1;
					}
				}
			}
		}

		const blockBudget = { added: 0, max: 160 };
		const blockClusters = [...byBlock.entries()].sort((a, b) => a[1].length - b[1].length);
		for (const [blkKey, members] of blockClusters) {
			if (members.length < 2 || blockBudget.added >= blockBudget.max) continue;
			// Dense office corridors (many house numbers on one street+ZIP) need tight caps
			if (members.length > 80) continue;
			const maxPairs = members.length > 25 ? 20 : 60;
			let pairs = 0;
			for (let i = 0; i < members.length && pairs < maxPairs && blockBudget.added < blockBudget.max; i++) {
				for (let j = i + 1; j < members.length && pairs < maxPairs && blockBudget.added < blockBudget.max; j++) {
					const left = members[i];
					const right = members[j];
					// If building budget skipped a true same-building pair, upgrade here
					if (left.buildingKey && left.buildingKey === right.buildingKey) {
						if (
							emitGeoPair(
								left,
								right,
								'building',
								left.buildingKey,
								byBuilding.get(left.buildingKey)?.length || 2,
								buildingBudget.added < buildingBudget.max ? buildingBudget : blockBudget,
							)
						) {
							pairs += 1;
						}
						continue;
					}
					if (emitGeoPair(left, right, 'block', blkKey, members.length, blockBudget)) {
						pairs += 1;
					}
				}
			}
		}

		const cityBudget = { added: 0, max: 220 };
		for (const [geoKey, members] of byCity.entries()) {
			if (members.length < 2 || cityBudget.added >= cityBudget.max) continue;
			const nCity = members.length;
			const maxPairs = nCity > 40 ? 12 : nCity > 20 ? 30 : 80;
			let pairs = 0;
			for (let i = 0; i < members.length && pairs < maxPairs && cityBudget.added < cityBudget.max; i++) {
				for (let j = i + 1; j < members.length && pairs < maxPairs && cityBudget.added < cityBudget.max; j++) {
					if (emitGeoPair(members[i], members[j], 'city', geoKey, nCity, cityBudget)) {
						pairs += 1;
					}
				}
			}
		}

		// Commit (6) Multi-Angle Comparisons
		for (const r of multiAngleRows) {
			const pid = String(r.id);
			if (!profileAlive(pid)) continue;
			const yr = String(r.yr);
			const angles = String(r.angles || '').split(',').filter(Boolean);
			const corpora = [...new Set(String(r.corpora || '').split(',').filter(Boolean))];
			if (corpora.length < 2 || angles.length < 2) continue;
			const n = Number(r.entry_count || 0);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['angle_comparison', pid, yr]),
					alignmentKind: 'angle_comparison',
					leftProfileId: pid,
					rightProfileId: null,
					score: Math.min(0.92, 0.65 + angles.length * 0.08 + Math.min(0.1, corpora.length * 0.03)),
					cautionTier: 'closer_look',
					rationale: `Multi-angle coverage on "${String(r.name)}" in ${yr}: ${n} entries across ${angles.length} angles (${angles.join(', ')}) from ${corpora.join(', ')}.`,
					evidence: corpora.map((c) => ({
						corpus: c,
						label: `${yr} coverage (${angles.join(' / ')})`,
						date: yr,
					})),
				},
				tx,
			);
			counts.angleComparison += 1;
		}
	});

	// 7. Read-only FTS5 cross-match against knowledge.sqlite (Bryan/Cherokee/Adair/Sequoyah/Dallas filings + Research Drive)
	const kPath = getKnowledgeSqlitePath();
	if (includeKnowledge && fs.existsSync(kPath)) {
		let kdb: DatabaseSync | null = null;
		try {
			kdb = new DatabaseSync(kPath, { readOnly: true });
			// Focus on pinned + high-signal firms, nonprofits, universities, and people (avoid matching 5,000 generic rows)
			const candidateProfiles = db
				.prepare(
					`SELECT p.id, p.name, p.slug, p.profile_type, p.status
           FROM profiles p
           WHERE p.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital', 'government')
             AND length(p.normalized_name) >= 5
           ORDER BY
             CASE p.status WHEN 'pinned' THEN 0 ELSE 1 END,
             CASE p.profile_type
               WHEN 'firm' THEN 0
               WHEN 'medical_hospital' THEN 1
               WHEN 'nonprofit' THEN 2
               WHEN 'education' THEN 3
               WHEN 'government' THEN 4
               ELSE 5
             END,
             (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) DESC
           LIMIT ?`,
				)
				.all(maxCountyProfiles) as Array<Record<string, unknown>>;

			const stmt = kdb.prepare(
				`SELECT d.id AS doc_id, d.title, d.url, p.name AS project_name, substr(c.text, 1, 600) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         JOIN projects p ON p.id = d.project_id
         WHERE chunks_fts MATCH ?
           AND p.name IN ('Bryan County', 'Cherokee County', 'Adair County', 'Sequoyah County', 'Dallas County Deeds', 'Research Drive')
         LIMIT 6`,
			);

			type EvaluatedHit = {
				docId: string;
				title: string;
				url: string | null;
				projectName: string;
				snippet: string;
				date: string | null;
				score: number;
				rationale: string;
			};

			const validatedCommits: Array<{
				profileId: string;
				profileName: string;
				hits: EvaluatedHit[];
			}> = [];
			const nameOnlyCommits: Array<{
				profileId: string;
				profileName: string;
				profileType: ProfileType;
				hits: EvaluatedHit[];
			}> = [];

			for (const cp of candidateProfiles) {
				const rawName = String(cp.name || '').trim();
				const pType = String(cp.profile_type) as ProfileType;
				const detail = getProfileDetail(String(cp.id));
				if (!detail) continue;
				const profileCtx = buildProfileIdentityContext(detail);

				const phrases = buildSearchPhrasesForProfile(rawName, pType, profileCtx.aliases);
				if (!phrases.length) continue;
				if (STOP_ALIAS_WORDS.has(phrases[0].toLowerCase())) continue;

				const profileRawTokenCount = aliasRawTokens(
					stripLegalSuffixes(normalizeText(rawName)) || normalizeText(rawName),
				).length;

				const seenDoc = new Set<string>();
				const validHits: EvaluatedHit[] = [];
				const noteHits: EvaluatedHit[] = [];

				for (const phrase of phrases.slice(0, 4)) {
					// Skip single-token FTS phrases for multi-token profiles (Grosvenor Group → "Grosvenor").
					const phraseRawTokenCount = aliasRawTokens(
						stripLegalSuffixes(normalizeText(phrase)) || normalizeText(phrase),
					).length;
					if (phraseRawTokenCount < 2 && profileRawTokenCount >= 2) continue;

					try {
						const rows = stmt.all(`"${phrase}"`) as Array<Record<string, unknown>>;
						for (const r of rows) {
							const docId = String(r.doc_id);
							if (seenDoc.has(docId)) continue;
							seenDoc.add(docId);
							const title = String(r.title || '');
							const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim();
							const projectName = String(r.project_name || 'knowledge');
							const date = extractDateFromFiling(title, snippet);

							const countyHint = /county|deeds/i.test(projectName)
								? projectName.replace(/\s+Deeds$/i, '')
								: '';
							const stateHint = /Bryan|Cherokee|Adair|Sequoyah/i.test(projectName)
								? 'Oklahoma'
								: /Dallas/i.test(projectName)
									? 'Texas'
									: '';

							const evalRes = evaluateIdentityMatch(profileCtx, {
								candidateName: phrase,
								candidateLocations: [countyHint, stateHint].filter(Boolean),
								candidateEventDates: date ? [date] : [],
								candidateText: `${projectName} ${stateHint} ${title} ${snippet}`,
							});

							const item: EvaluatedHit = {
								docId,
								title,
								url: r.url != null ? String(r.url) : null,
								projectName,
								snippet,
								date,
								score: evalRes.score,
								rationale: evalRes.rationale,
							};

							if (evalRes.decision === 'validated_merge') {
								validHits.push(item);
							} else if (evalRes.decision === 'name_only_note') {
								noteHits.push(item);
							}
						}
					} catch {
						/* skip invalid FTS phrase */
					}
				}

				if (validHits.length > 0) {
					validatedCommits.push({ profileId: String(cp.id), profileName: rawName, hits: validHits });
				}
				if (noteHits.length > 0) {
					nameOnlyCommits.push({
						profileId: String(cp.id),
						profileName: rawName,
						profileType: pType,
						hits: noteHits,
					});
				}
			}

			if (validatedCommits.length > 0 || nameOnlyCommits.length > 0) {
				withProfilesTransaction((tx) => {
					for (const m of validatedCommits) {
						const countyHits = m.hits.filter((h) => isCountyFilingHit(h.projectName, h.title, h.url));
						const knowledgeHits = m.hits.filter((h) => !isCountyFilingHit(h.projectName, h.title, h.url));

						const commitBucket = (
							hits: EvaluatedHit[],
							kind: 'county_filing_match' | 'knowledge_store_match',
						) => {
							if (!hits.length) return;
							const projects = [...new Set(hits.map((h) => h.projectName))];
							const evidence: AlignmentEvidenceItem[] = hits.slice(0, 6).map((h) => ({
								corpus: `knowledge:${h.projectName}`,
								label: h.title.slice(0, 120),
								date: h.date,
								url: h.url,
								sourceRef: `knowledge:doc:${h.docId}`,
								snippet: h.snippet.slice(0, 200),
							}));
							const label =
								kind === 'county_filing_match'
									? 'county filing record(s)'
									: 'local knowledge store document(s)';
							upsertAlignmentCandidate(
								{
									dedupeKey: sha256Key([kind, m.profileId]),
									alignmentKind: kind,
									leftProfileId: m.profileId,
									rightProfileId: null,
									score: Math.max(...hits.map((h) => h.score)),
									cautionTier: hits.length >= 2 ? 'stronger_indicator' : 'closer_look',
									rationale: `Validated match for "${m.profileName}" across ${hits.length} ${label} (${projects.join(', ')}). ${hits[0].rationale}`,
									evidence,
								},
								tx,
							);
							if (kind === 'county_filing_match') counts.countyFilingMatch += 1;
							else counts.knowledgeStoreMatch += 1;

							// ONLY attach timeline observations for validated matches!
							for (const h of hits.slice(0, 3)) {
								const srId = upsertSourceRecord(
									{
										corpus: 'knowledge-sqlite',
										sourceRef: `knowledge:doc:${h.docId}`,
										sourceUrl: h.url,
										title: `[${h.projectName}] ${h.title}`,
										publishedDate: h.date,
										excerpt: h.snippet,
										metadata: { projectName: h.projectName, docId: h.docId },
									},
									tx,
								);
								upsertTimelineEntry(
									{
										profileId: m.profileId,
										eventDate: h.date,
										title: `[${h.projectName}] ${h.title}`,
										summary: h.snippet,
										angle: kind === 'county_filing_match' ? 'land_records' : 'general',
										entryKind: kind === 'county_filing_match' ? 'filing' : 'observation',
										confidence: h.score,
										sourceCorpus: 'knowledge-sqlite',
										sourceRecordId: srId,
										dedupeHint: `kdoc:${h.docId}`,
									},
									tx,
								);
							}
						};

						commitBucket(countyHits, 'county_filing_match');
						commitBucket(knowledgeHits, 'knowledge_store_match');
					}

					// Name-only county hits: NEVER attach to timeline or mutate profile; record note only!
					for (const m of nameOnlyCommits) {
						const projects = [...new Set(m.hits.map((h) => h.projectName))];
						const evidence: AlignmentEvidenceItem[] = m.hits.slice(0, 6).map((h) => ({
							corpus: `knowledge:${h.projectName}`,
							label: h.title.slice(0, 120),
							date: h.date,
							url: h.url,
							sourceRef: `knowledge:doc:${h.docId}`,
							snippet: h.snippet.slice(0, 200),
						}));
						const rawScore = m.hits[0].score;
						const demotedScore = demoteBareCountyNameOnlyScore(
							m.profileType,
							m.hits.map((h) => ({
								projectName: h.projectName,
								title: h.title,
								snippet: h.snippet,
								profileName: m.profileName,
							})),
							rawScore,
							m.profileName,
						);
						upsertAlignmentCandidate(
							{
								dedupeKey: sha256Key(['possible_match_name_only', m.profileId, 'knowledge-sqlite']),
								alignmentKind: 'possible_match_name_only',
								leftProfileId: m.profileId,
								rightProfileId: null,
								score: demotedScore,
								cautionTier: 'observation',
								rationale: `Name-only match for "${m.profileName}" in ${projects.join(', ')} (${m.hits.length} doc(s)) with NO corroborating address, firm, military base, or institution. NOT merged onto profile/timeline — verify party/address first.${
									demotedScore < rawScore
										? ' Score demoted (bare county person-name collision; no LLC/INC/Trust party).'
										: ''
								}`,
								evidence,
							},
							tx,
						);
						counts.possibleMatchNameOnly += 1;
					}
				});
			}
		} catch {
			/* knowledge.sqlite unavailable or locked; skip cleanly */
		} finally {
			if (kdb) {
				try {
					kdb.close();
				} catch {
					/* ignore */
				}
			}
		}
	}

	// Sweep: any remaining proposed geo colo where both sides already have
	// FINRA CRDs with no overlap (multi-tenant offices ≠ same registrant).
	{
		const now = new Date().toISOString();
		const sweep = db
			.prepare(
				`UPDATE alignment_candidates
         SET status = 'dismissed',
             rationale = CASE
               WHEN rationale LIKE '%Auto-dismissed: distinct FINRA CRDs%' THEN rationale
               ELSE substr(rationale || ' Auto-dismissed: distinct FINRA CRDs (different registrants).', 1, 1000)
             END,
             updated_at = ?
         WHERE status = 'proposed'
           AND alignment_kind IN ('building_colocation', 'block_colocation', 'city_colocation')
           AND right_profile_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM profile_identifiers l
             WHERE l.profile_id = alignment_candidates.left_profile_id AND l.scheme = 'finra_crd'
           )
           AND EXISTS (
             SELECT 1 FROM profile_identifiers r
             WHERE r.profile_id = alignment_candidates.right_profile_id AND r.scheme = 'finra_crd'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM profile_identifiers l
             JOIN profile_identifiers r
               ON r.scheme = 'finra_crd'
              AND r.profile_id = alignment_candidates.right_profile_id
              AND r.value = l.value
             WHERE l.profile_id = alignment_candidates.left_profile_id
               AND l.scheme = 'finra_crd'
           )`,
			)
			.run(now);
		counts.disjointCrdColocationDismissed += Number(sweep.changes || 0);
	}

	counts.totalUpserted =
		counts.sharedIdentifier +
		counts.sameEntityAlias +
		counts.crossSourceMention +
		counts.sharedAffiliation +
		counts.geoTemporalCoOccurrence +
		counts.cityColocation +
		counts.blockColocation +
		counts.buildingColocation +
		counts.angleComparison +
		counts.countyFilingMatch +
		counts.knowledgeStoreMatch +
		counts.possibleMatchNameOnly;
	counts.durationMs = Date.now() - t0;

	return counts;
}

export type ListAlignmentsFilter = {
	profileId?: string;
	alignmentKind?: AlignmentKind;
	status?: AlignmentStatus;
	cautionTier?: CautionTier;
	minScore?: number;
	limit?: number;
	offset?: number;
};

export function listAlignments(filter: ListAlignmentsFilter = {}): {
	alignments: AlignmentCandidate[];
	total: number;
} {
	const db = getProfilesDb();
	const limit = Math.max(1, Math.min(200, Math.floor(Number(filter.limit ?? 50))));
	const offset = Math.max(0, Math.floor(Number(filter.offset ?? 0)));

	const where: string[] = [];
	const params: Array<string | number> = [];

	if (filter.profileId) {
		where.push('(ac.left_profile_id = ? OR ac.right_profile_id = ?)');
		params.push(filter.profileId, filter.profileId);
	}
	if (filter.alignmentKind) {
		where.push('ac.alignment_kind = ?');
		params.push(filter.alignmentKind);
	}
	if (filter.status) {
		where.push('ac.status = ?');
		params.push(filter.status);
	}
	if (filter.cautionTier) {
		where.push('ac.caution_tier = ?');
		params.push(filter.cautionTier);
	}
	if (typeof filter.minScore === 'number' && Number.isFinite(filter.minScore)) {
		where.push('ac.score >= ?');
		params.push(filter.minScore);
	}

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const total = Number(
		(
			db
				.prepare(`SELECT COUNT(*) AS c FROM alignment_candidates ac ${whereSql}`)
				.get(...params) as { c?: number }
		)?.c || 0,
	);

	const rows = db
		.prepare(
			`SELECT ac.*,
              lp.name AS left_name, lp.slug AS left_slug, lp.profile_type AS left_type,
              rp.name AS right_name, rp.slug AS right_slug, rp.profile_type AS right_type
       FROM alignment_candidates ac
       JOIN profiles lp ON lp.id = ac.left_profile_id
       LEFT JOIN profiles rp ON rp.id = ac.right_profile_id
       ${whereSql}
       ORDER BY
         CASE ac.status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
         ac.score DESC,
         ac.updated_at DESC
       LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Array<Record<string, unknown>>;

	return {
		alignments: rows.map(rowToAlignment),
		total,
	};
}
