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
	inferEdgeWeightSector,
	isCityLevelGeoKey,
	secondarySignalBoost,
	type GeoProximity,
} from '@/lib/research/profiles/edgeWeights';
import { normalizeText } from '@/lib/research/profiles/normalize';
import {
	buildProfileIdentityContext,
	buildSearchPhrasesForProfile,
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
	angleComparison: number;
	countyFilingMatch: number;
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
		angleComparison: 0,
		countyFilingMatch: 0,
		possibleMatchNameOnly: 0,
		totalUpserted: 0,
		durationMs: 0,
	};

	const actorTypeSql = EDGE_WEIGHT_PROFILE_TYPES.map((t) => `'${t}'`).join(', ');

	const db = getProfilesDb();

	// 1. Shared Identifiers (exact CRD / CIK / Ticker / EIN / URL across different profiles)
	// parent_sec_cik / url are relational or locators, not same-entity identity keys
	const sharedIdentRows = db
		.prepare(
			`SELECT a.profile_id AS p1, b.profile_id AS p2, a.scheme, a.value,
              p1.name AS n1, p2.name AS n2, a.source_corpus AS c1, b.source_corpus AS c2
       FROM profile_identifiers a
       JOIN profile_identifiers b
         ON a.scheme = b.scheme AND a.normalized_value = b.normalized_value AND a.profile_id < b.profile_id
       JOIN profiles p1 ON p1.id = a.profile_id
       JOIN profiles p2 ON p2.id = b.profile_id
       WHERE a.scheme NOT IN ('parent_sec_cik', 'url', 'source_id', 'dossier_slug')
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

	// 4. Shared Affiliations across DIFFERENT corpora
	const sharedAffilRows = db
		.prepare(
			`SELECT l1.from_profile_id AS p1, l2.from_profile_id AS p2, l1.to_profile_id AS hub_id,
              hub.name AS hub_name, hub.profile_type AS hub_type,
              l1.source_corpus AS c1, l2.source_corpus AS c2,
              l1.role_label AS r1, l2.role_label AS r2,
              a1.name AS n1, a2.name AS n2
       FROM profile_links l1
       JOIN profile_links l2
         ON l1.to_profile_id = l2.to_profile_id
        AND l1.from_profile_id < l2.from_profile_id
        AND l1.source_corpus != l2.source_corpus
       JOIN profiles hub ON hub.id = l1.to_profile_id
       JOIN profiles a1 ON a1.id = l1.from_profile_id
       JOIN profiles a2 ON a2.id = l2.from_profile_id
       WHERE hub.profile_type IN ('firm', 'education', 'nonprofit', 'medical_hospital', 'government')
         AND a1.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital')
         AND a2.profile_type IN ('person', 'firm', 'education', 'nonprofit', 'medical_hospital')
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
	const multiAngleRows = db
		.prepare(
			`SELECT p.id, p.name, p.profile_type,
              substr(te.event_date, 1, 7) AS ym,
              COUNT(DISTINCT te.angle) AS angle_count,
              COUNT(DISTINCT te.source_corpus) AS corpus_count,
              GROUP_CONCAT(DISTINCT te.angle) AS angles,
              GROUP_CONCAT(DISTINCT te.source_corpus) AS corpora,
              COUNT(*) AS entry_count
       FROM timeline_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.event_date IS NOT NULL AND length(te.event_date) >= 7
       GROUP BY p.id, ym
       HAVING angle_count >= 2 OR corpus_count >= 2
       ORDER BY angle_count DESC, entry_count DESC
       LIMIT 120`,
		)
		.all() as Array<Record<string, unknown>>;

	withProfilesTransaction((tx) => {
		// Commit (1) Shared Identifiers
		for (const r of sharedIdentRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			const scheme = String(r.scheme);
			const value = String(r.value);
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
						{ corpus: String(r.c1 || 'profiles'), label: `${String(r.n1)} (${scheme}: ${value})` },
						{ corpus: String(r.c2 || 'profiles'), label: `${String(r.n2)} (${scheme}: ${value})` },
					],
				},
				tx,
			);
			counts.sharedIdentifier += 1;
		}

		// Commit (2) Same Entity Alias across distinct profiles (with strict person corroboration check)
		let aliasCount = 0;
		for (const [normKey, group] of byNormKey.entries()) {
			if (group.length < 2 || group.length > 6) continue;
			for (let i = 0; i < group.length; i++) {
				for (let j = i + 1; j < group.length; j++) {
					if (aliasCount >= 250) break;
					const a = group[i];
					const b = group[j];
					const [left, right] = a.profileId < b.profileId ? [a, b] : [b, a];
					const sameType = left.profileType === right.profileType;
					const crossCorpus = left.corpus !== right.corpus;

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
								upsertAlignmentCandidate(
									{
										dedupeKey: sha256Key(['possible_match_name_only', left.profileId, right.profileId, normKey]),
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

							upsertAlignmentCandidate(
								{
									dedupeKey: sha256Key(['same_entity_alias', left.profileId, right.profileId, normKey]),
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

					const score = (sameType ? 0.78 : 0.62) + (crossCorpus ? 0.1 : 0);
					upsertAlignmentCandidate(
						{
							dedupeKey: sha256Key(['same_entity_alias', left.profileId, right.profileId, normKey]),
							alignmentKind: 'same_entity_alias',
							leftProfileId: left.profileId,
							rightProfileId: right.profileId,
							score,
							cautionTier: score >= 0.82 ? 'closer_look' : 'observation',
							rationale: `Shared normalized name/alias "${normKey}" across "${left.name}" (${left.profileType}, ${left.corpus}) and "${right.name}" (${right.profileType}, ${right.corpus}).`,
							evidence: [
								{ corpus: left.corpus, label: `${left.name} [${left.profileType}]` },
								{ corpus: right.corpus, label: `${right.name} [${right.profileType}]` },
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
			let corpora: string[] = [];
			try {
				const meta = JSON.parse(String(p.metadata_json || '{}')) as Record<string, unknown>;
				if (Array.isArray(meta.corpora)) corpora = [...new Set(meta.corpora.map(String))];
			} catch {
				/* ignore */
			}
			if (corpora.length < 2) continue;
			const pid = String(p.id);
			const score = Math.min(0.95, 0.65 + corpora.length * 0.1);
			const tier: CautionTier = corpora.length >= 3 ? 'stronger_indicator' : 'closer_look';
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['cross_source_mention', pid]),
					alignmentKind: 'cross_source_mention',
					leftProfileId: pid,
					rightProfileId: null,
					score,
					cautionTier: tier,
					rationale: `"${String(p.name)}" (${String(p.profile_type)}) appears across ${corpora.length} distinct data sources: ${corpora.join(', ')}.`,
					evidence: corpora.map((c) => ({ corpus: c, label: `Present in ${c}` })),
				},
				tx,
			);
			counts.crossSourceMention += 1;
		}

		// Commit (4) Shared Affiliations across different corpora
		for (const r of sharedAffilRows) {
			const p1 = String(r.p1);
			const p2 = String(r.p2);
			const hubName = String(r.hub_name);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['shared_affiliation', p1, p2, String(r.hub_id)]),
					alignmentKind: 'shared_affiliation',
					leftProfileId: p1,
					rightProfileId: p2,
					score: 0.72,
					cautionTier: 'observation',
					rationale: `"${String(r.n1)}" (${String(r.c1)}) and "${String(r.n2)}" (${String(r.c2)}) both connect to ${hubName} (${String(r.hub_type)}).`,
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
			const pk = pairKey(a.profileId, b.profileId);
			if (coveredPairs.has(pk)) return false;
			coveredPairs.add(pk);

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
			const ym = String(r.ym);
			const angles = String(r.angles || '').split(',').filter(Boolean);
			const corpora = String(r.corpora || '').split(',').filter(Boolean);
			const n = Number(r.entry_count || 0);
			upsertAlignmentCandidate(
				{
					dedupeKey: sha256Key(['angle_comparison', pid, ym]),
					alignmentKind: 'angle_comparison',
					leftProfileId: pid,
					rightProfileId: null,
					score: Math.min(0.92, 0.65 + angles.length * 0.08),
					cautionTier: 'closer_look',
					rationale: `Multi-angle coverage on "${String(r.name)}" in ${ym}: ${n} entries across ${angles.length} angles (${angles.join(', ')}) from ${corpora.join(', ')}.`,
					evidence: corpora.map((c) => ({
						corpus: c,
						label: `${ym} coverage (${angles.join(' / ')})`,
						date: ym,
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

				const seenDoc = new Set<string>();
				const validHits: EvaluatedHit[] = [];
				const noteHits: EvaluatedHit[] = [];

				for (const phrase of phrases.slice(0, 4)) {
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
					nameOnlyCommits.push({ profileId: String(cp.id), profileName: rawName, hits: noteHits });
				}
			}

			if (validatedCommits.length > 0 || nameOnlyCommits.length > 0) {
				withProfilesTransaction((tx) => {
					for (const m of validatedCommits) {
						const projects = [...new Set(m.hits.map((h) => h.projectName))];
						const evidence: AlignmentEvidenceItem[] = m.hits.slice(0, 6).map((h) => ({
							corpus: `knowledge:${h.projectName}`,
							label: h.title.slice(0, 120),
							date: h.date,
							url: h.url,
							sourceRef: `knowledge:doc:${h.docId}`,
							snippet: h.snippet.slice(0, 200),
						}));

						upsertAlignmentCandidate(
							{
								dedupeKey: sha256Key(['county_filing_match', m.profileId]),
								alignmentKind: 'county_filing_match',
								leftProfileId: m.profileId,
								rightProfileId: null,
								score: Math.max(...m.hits.map((h) => h.score)),
								cautionTier: m.hits.length >= 2 ? 'stronger_indicator' : 'closer_look',
								rationale: `Validated match for "${m.profileName}" across ${m.hits.length} record(s) in local knowledge store (${projects.join(', ')}). ${m.hits[0].rationale}`,
								evidence,
							},
							tx,
						);
						counts.countyFilingMatch += 1;

						// ONLY attach timeline observations for validated matches!
						for (const h of m.hits.slice(0, 3)) {
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
									angle: /county|deeds/i.test(h.projectName) ? 'land_records' : 'general',
									entryKind: 'filing',
									confidence: h.score,
									sourceCorpus: 'knowledge-sqlite',
									sourceRecordId: srId,
									dedupeHint: `kdoc:${h.docId}`,
								},
								tx,
							);
						}
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
						upsertAlignmentCandidate(
							{
								dedupeKey: sha256Key(['possible_match_name_only', m.profileId, 'knowledge-sqlite']),
								alignmentKind: 'possible_match_name_only',
								leftProfileId: m.profileId,
								rightProfileId: null,
								score: m.hits[0].score,
								cautionTier: 'observation',
								rationale: `Name-only match for "${m.profileName}" in ${projects.join(', ')} (${m.hits.length} doc(s)) with NO corroborating address, firm, military base, or institution. NOT merged onto profile/timeline — verify party/address first.`,
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
