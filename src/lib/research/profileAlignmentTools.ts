/**
 * Agent tool handlers for the unified Entity Profile & Cross-Source Alignment store
 * (.data/profiles/profiles.sqlite).
 */
import { listAlignments } from '@/lib/research/profiles/align';
import { enrichProfile } from '@/lib/research/profiles/enrich';
import { makeProfileSlug, normalizeLocationRecord } from '@/lib/research/profiles/normalize';
import {
	addAlias,
	addIdentifier,
	addLocation,
	getProfile,
	getProfileDetail,
	getProfileStats,
	listProfiles,
	updateProfileFields,
	upsertProfile,
	upsertProfileLink,
	upsertSourceRecord,
} from '@/lib/research/profiles/store';
import { formatHistoricEventSummaryToTimeline } from '@/lib/research/profiles/historicEventTimeline';
import {
	ensureSummaryTimelineNewestFirst,
	syncSummaryTimelineToEntries,
} from '@/lib/research/profiles/syncSummaryTimeline';
import { getProfileTimeline } from '@/lib/research/profiles/timeline';
import {
	LOCATION_ROLES,
	PROFILE_TYPES,
	type AliasKind,
	type AlignmentKind,
	type AlignmentStatus,
	type CautionTier,
	type IdentifierScheme,
	type LocationRole,
	type ProfileRelationType,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';

const ALLOWED_IDENTIFIER_SCHEMES = new Set<IdentifierScheme>([
	'finra_crd',
	'sec_cik',
	'parent_sec_cik',
	'ticker',
	'irs_ein',
	'cusip',
	'ror',
	'orcid',
	'wikidata',
	'dossier_slug',
	'source_id',
	'url',
	'us_passport',
	'driver_license',
]);

const ALLOWED_RELATIONS = new Set<ProfileRelationType>([
	'owned_by',
	'business_tie',
	'affiliated_with',
	'employed_by',
	'funded_by',
	'family_or_associate',
	'alumni_or_faculty',
	'mentioned_in',
	'participated_in',
	'part_of_subject',
	'regulator_of',
	'location_overlap',
]);

const DEFAULT_UPSERT_CORPUS = 'chat-upsert-profile';

function resolveProfileType(raw: unknown, fallback: ProfileType = 'firm'): ProfileType {
	const t = String(raw || fallback).trim().toLowerCase();
	return PROFILE_TYPES.includes(t as ProfileType) ? (t as ProfileType) : fallback;
}

function resolveExistingProfile(nameOrSlug: string, profileType?: ProfileType) {
	const key = String(nameOrSlug || '').trim();
	if (!key) return null;
	const direct = getProfile(key);
	if (direct) return direct;
	if (profileType) {
		const typedSlug = makeProfileSlug(profileType, key);
		const byTyped = getProfile(typedSlug);
		if (byTyped) return byTyped;
	}
	// Exact name / alias only — never fall back to the first fuzzy search hit
	// (that previously overwrote unrelated firms like CapRock Exploration).
	const found = listProfiles({
		query: key,
		profileType: profileType || 'all',
		limit: 20,
	});
	const keyLow = key.toLowerCase();
	const exact = found.profiles.find(
		(p) =>
			p.slug === key ||
			p.name.trim().toLowerCase() === keyLow ||
			(p.alternateNames || []).some((a) => a.trim().toLowerCase() === keyLow),
	);
	return exact || null;
}

export type SearchProfilesToolArgs = {
	query?: string;
	slug?: string;
	profileType?: string;
	tag?: string;
	corpus?: string;
	geo?: string;
	status?: string;
	limit?: number;
};

export type GetProfileTimelineToolArgs = {
	profile?: string;
	from?: string;
	to?: string;
	angle?: string;
	corpus?: string;
	minGapDays?: number;
	detectGaps?: boolean;
	fillFromKnowledge?: boolean;
	limit?: number;
};

export type FindProfileAlignmentsToolArgs = {
	profile?: string;
	kind?: string;
	status?: string;
	cautionTier?: string;
	minScore?: number;
	limit?: number;
};

export async function searchProfilesTool(args: SearchProfilesToolArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	try {
		const slug = String(args.slug || '').trim();
		if (slug) {
			const detail = getProfileDetail(slug);
			if (!detail) {
				return {
					ok: false,
					result: { ok: false, error: `No profile found for "${slug}". Try search_profiles with query instead.` },
				};
			}
			return {
				ok: true,
				result: {
					ok: true,
					mode: 'detail',
					profile: detail.profile,
					categoryTags: detail.categoryTags,
					employmentHistory: detail.employmentHistory.slice(0, 30),
					aliases: detail.aliases.slice(0, 20).map((a) => ({ alias: a.alias, kind: a.aliasKind })),
					identifiers: detail.identifiers.slice(0, 15).map((i) => ({ scheme: i.scheme, value: i.value })),
					locations: detail.locations.slice(0, 15).map((l) => ({ raw: l.raw, geoKey: l.geoKey, role: l.role })),
					links: detail.links.slice(0, 30).map((l) => ({
						direction: l.fromProfileId === detail.profile.id ? 'out' : 'in',
						relationType: l.relationType,
						roleLabel: l.roleLabel,
						peerName: l.fromProfileId === detail.profile.id ? l.toName : l.fromName,
						peerSlug: l.fromProfileId === detail.profile.id ? l.toSlug : l.fromSlug,
						peerType: l.fromProfileId === detail.profile.id ? l.toType : l.fromType,
						corpus: l.sourceCorpus,
						note: l.evidenceNote,
					})),
					alignments: detail.alignments.slice(0, 15).map((a) => ({
						id: a.id,
						kind: a.alignmentKind,
						score: a.score,
						cautionTier: a.cautionTier,
						status: a.status,
						peerName: a.leftProfileId === detail.profile.id ? a.rightName : a.leftName,
						peerSlug: a.leftProfileId === detail.profile.id ? a.rightSlug : a.leftSlug,
						rationale: a.rationale,
					})),
					counts: detail.counts,
				},
			};
		}

		const typeRaw = String(args.profileType || 'all').trim().toLowerCase();
		const profileType =
			typeRaw === 'all' || typeRaw === 'actors' || typeRaw === 'narratives'
				? typeRaw
				: PROFILE_TYPES.includes(typeRaw as ProfileType)
					? (typeRaw as ProfileType)
					: 'all';

		const tagRaw = String(args.tag || '').trim().toLowerCase();
		const tag = PROFILE_TYPES.includes(tagRaw as ProfileType) ? (tagRaw as ProfileType) : undefined;

		const limit = Math.max(1, Math.min(40, Math.floor(Number(args.limit ?? 15))));
		const { profiles, total } = listProfiles({
			query: args.query ? String(args.query) : undefined,
			profileType,
			tag,
			status: args.status ? (String(args.status) as ProfileStatus) : undefined,
			corpus: args.corpus ? String(args.corpus) : undefined,
			geo: args.geo ? String(args.geo) : undefined,
			limit,
		});

		const stats = getProfileStats();
		return {
			ok: true,
			result: {
				ok: true,
				mode: 'search',
				total,
				returned: profiles.length,
				profiles: profiles.map((p) => ({
					id: p.id,
					slug: p.slug,
					profileType: p.profileType,
					name: p.name,
					status: p.status,
					summary: p.summary.slice(0, 260),
					primaryLocation: p.primaryLocation,
					countryCodes: p.countryCodes,
					categoryTags: p.categoryTags,
					startDate: p.startDate,
					endDate: p.endDate,
					corpora: p.corpora,
					counts: {
						aliases: p.aliasCount,
						links: p.linkCount,
						timeline: p.timelineCount,
						alignments: p.alignmentCount,
					},
				})),
				storeStats: {
					totalProfiles: stats.totalProfiles,
					byType: stats.byType,
					totalAlignments: stats.totalAlignments,
				},
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export async function getProfileTimelineTool(args: GetProfileTimelineToolArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	try {
		const target = String(args.profile || '').trim();
		if (!target) {
			return {
				ok: false,
				result: { ok: false, error: 'profile (id or slug, e.g. historic_event:covid-19-pandemic-response) is required' },
			};
		}

		// Allow fuzzy name fallback if user didn't pass an exact slug/id
		let resolved = getProfileTimeline(target, {
			from: args.from,
			to: args.to,
			angle: args.angle,
			corpus: args.corpus,
			minGapDays: args.minGapDays,
			detectGaps: args.detectGaps !== false,
			fillFromKnowledge: args.fillFromKnowledge !== false,
			limit: Math.max(1, Math.min(80, Math.floor(Number(args.limit ?? 35)))),
		});

		if (!resolved) {
			const search = listProfiles({ query: target, limit: 1 });
			if (search.profiles[0]) {
				resolved = getProfileTimeline(search.profiles[0].id, {
					from: args.from,
					to: args.to,
					angle: args.angle,
					corpus: args.corpus,
					minGapDays: args.minGapDays,
					detectGaps: args.detectGaps !== false,
					fillFromKnowledge: args.fillFromKnowledge !== false,
					limit: Math.max(1, Math.min(80, Math.floor(Number(args.limit ?? 35)))),
				});
			}
		}

		if (!resolved) {
			return { ok: false, result: { ok: false, error: `No profile found matching "${target}"` } };
		}

		return {
			ok: true,
			result: {
				ok: true,
				profile: {
					id: resolved.profile.id,
					slug: resolved.profile.slug,
					name: resolved.profile.name,
					profileType: resolved.profile.profileType,
				},
				totalEntries: resolved.totalEntries,
				returnedEntries: resolved.entries.length,
				dateRange: resolved.dateRange,
				angleBreakdown: resolved.angleBreakdown,
				corpusBreakdown: resolved.corpusBreakdown,
				overlappingWindows: resolved.overlappingWindows.slice(0, 20),
				gaps: resolved.gaps.map((g) => ({
					fromDate: g.fromDate,
					toDate: g.toDate,
					gapDays: g.gapDays,
					before: `${g.beforeCorpus}: ${g.beforeEntryTitle.slice(0, 100)}`,
					after: `${g.afterCorpus}: ${g.afterEntryTitle.slice(0, 100)}`,
					fillLeadCount: g.fillLeads.length,
					fillLeads: g.fillLeads.slice(0, 5),
				})),
				entries: resolved.entries.map((e) => ({
					date: e.eventDate,
					angle: e.angle,
					corpus: e.sourceCorpus,
					kind: e.entryKind,
					title: e.title.slice(0, 180),
					summary: e.summary.slice(0, 260),
					geo: e.geoLabel,
					url: e.sourceUrl,
				})),
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export async function findProfileAlignmentsTool(args: FindProfileAlignmentsToolArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	try {
		let profileId: string | undefined;
		if (args.profile) {
			const p = String(args.profile).trim();
			const detail = getProfileDetail(p);
			if (detail) {
				profileId = detail.profile.id;
			} else {
				const found = listProfiles({ query: p, limit: 1 });
				profileId = found.profiles[0]?.id;
			}
		}

		const limit = Math.max(1, Math.min(40, Math.floor(Number(args.limit ?? 20))));
		const res = listAlignments({
			profileId,
			alignmentKind: args.kind ? (String(args.kind) as AlignmentKind) : undefined,
			status: args.status ? (String(args.status) as AlignmentStatus) : undefined,
			cautionTier: args.cautionTier ? (String(args.cautionTier) as CautionTier) : undefined,
			minScore: typeof args.minScore === 'number' ? args.minScore : undefined,
			limit,
		});

		return {
			ok: true,
			result: {
				ok: true,
				total: res.total,
				returned: res.alignments.length,
				alignments: res.alignments.map((a) => ({
					id: a.id,
					kind: a.alignmentKind,
					score: a.score,
					cautionTier: a.cautionTier,
					status: a.status,
					left: { name: a.leftName, slug: a.leftSlug, type: a.leftType },
					right: a.rightProfileId
						? { name: a.rightName, slug: a.rightSlug, type: a.rightType }
						: null,
					rationale: a.rationale,
					evidence: a.evidence.slice(0, 5),
				})),
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export type EnrichProfileToolArgs = {
	profile?: string;
	includeWikipedia?: boolean;
	includeBrokercheck?: boolean;
	includeKnowledge?: boolean;
	includeBryanUcc?: boolean;
};

export async function enrichProfileTool(args: EnrichProfileToolArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	try {
		const target = String(args.profile || '').trim();
		if (!target) {
			return {
				ok: false,
				result: { ok: false, error: 'profile (id, slug, or name) is required' },
			};
		}

		let resolvedId = target;
		if (!getProfileDetail(target)) {
			const found = listProfiles({ query: target, limit: 1 });
			if (found.profiles[0]) {
				resolvedId = found.profiles[0].id;
			}
		}

		const report = await enrichProfile(resolvedId, {
			includeWikipedia: args.includeWikipedia !== false,
			includeBrokercheck: args.includeBrokercheck !== false,
			includeKnowledge: args.includeKnowledge !== false,
			includeBryanUcc: args.includeBryanUcc !== false,
		});

		if (!report) {
			return { ok: false, result: { ok: false, error: `No profile found matching "${target}"` } };
		}

		return {
			ok: true,
			result: {
				ok: true,
				report,
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export type UpsertProfileToolAlias = string | { alias: string; kind?: string };
export type UpsertProfileToolLocation = {
	raw: string;
	role?: string;
	city?: string;
	county?: string;
	state?: string;
	country?: string;
};
export type UpsertProfileToolIdentifier = { scheme: string; value: string };
export type UpsertProfileToolLink = {
	peerName?: string;
	peerSlug?: string;
	peerType?: string;
	relationType?: string;
	roleLabel?: string;
	startDate?: string | null;
	endDate?: string | null;
	note?: string;
	createPeerIfMissing?: boolean;
};

export type UpsertProfileToolArgs = {
	profileType?: string;
	name?: string;
	slug?: string;
	summary?: string;
	startDate?: string | null;
	endDate?: string | null;
	status?: string;
	aliases?: UpsertProfileToolAlias[];
	locations?: UpsertProfileToolLocation[];
	identifiers?: UpsertProfileToolIdentifier[];
	links?: UpsertProfileToolLink[];
	/** Object preferred; JSON strings from models are coerced. */
	metadata?: Record<string, unknown> | string | null;
	sourceCorpus?: string;
	createPeerIfMissing?: boolean;
	dryRun?: boolean;
};

const TIMELINE_SECTION_HEADING_RE =
	/^#{1,6}\s*(?:timeline|chronology|milestones?|key dates)\b/i;

function summaryHasTimelineSection(summary: string): boolean {
	return summary.split(/\r?\n/).some((line) => TIMELINE_SECTION_HEADING_RE.test(line.trim()));
}

/** Extract `## Timeline` / `### Timeline` (etc.) blocks from a summary. */
function extractTimelineSections(summary: string): string {
	const lines = String(summary || '').split(/\r?\n/);
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] || '';
		const heading = line.trim().match(/^(#{1,6})\s+(.*)$/);
		if (heading && TIMELINE_SECTION_HEADING_RE.test(line.trim())) {
			const level = heading[1]!.length;
			const block = [line];
			i += 1;
			while (i < lines.length) {
				const next = lines[i] || '';
				const nextHeading = next.trim().match(/^(#{1,6})\s+/);
				if (nextHeading && nextHeading[1]!.length <= level) break;
				block.push(next);
				i += 1;
			}
			while (block.length && !block[block.length - 1]!.trim()) block.pop();
			if (block.length) out.push(block.join('\n'));
			continue;
		}
		i += 1;
	}
	return out.join('\n\n').trim();
}

/**
 * Chat upserts often send a short lead-only summary and wipe Overview timeline rails.
 * When the incoming summary has no Timeline section, keep the existing one(s).
 */
function preserveTimelineSectionsInSummary(
	existingSummary: string | null | undefined,
	incomingSummary: string,
): string {
	const next = String(incomingSummary || '').trim();
	const prev = String(existingSummary || '');
	if (!next || !prev.trim()) return next;
	if (summaryHasTimelineSection(next) || !summaryHasTimelineSection(prev)) return next;
	const kept = extractTimelineSections(prev);
	if (!kept) return next;
	return `${next.replace(/\s+$/, '')}\n\n${kept}\n`;
}

function coerceUpsertMetadata(raw: unknown): Record<string, unknown> {
	if (!raw) return {};
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		return { ...(raw as Record<string, unknown>) };
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim().replace(/\]+\s*$/, '');
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { ...(parsed as Record<string, unknown>) };
			}
		} catch {
			/* ignore malformed metadata strings from models */
		}
	}
	return {};
}

/**
 * Create or update a canonical profile from chat (founding dates, status, aliases,
 * locations, identifiers, and predecessor/ownership links). Prefer searching first
 * with search_profiles so existing cards are updated instead of duplicated.
 */
export async function upsertProfileTool(args: UpsertProfileToolArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	try {
		const profileType = resolveProfileType(args.profileType, 'firm');
		const corpus = String(args.sourceCorpus || DEFAULT_UPSERT_CORPUS).trim() || DEFAULT_UPSERT_CORPUS;
		const dryRun = Boolean(args.dryRun);
		const createPeersDefault = args.createPeerIfMissing !== false;

		const slugArg = args.slug ? String(args.slug).trim() : '';
		const nameArg = String(args.name || '').trim();
		// Slug-only updates are allowed so models can avoid XML-breaking chars like & in names.
		const existingBySlug = slugArg
			? getProfile(makeProfileSlug(profileType, slugArg)) || resolveExistingProfile(slugArg, profileType)
			: null;
		let name = nameArg || existingBySlug?.name || '';
		if (!name) {
			return {
				ok: false,
				result: {
					ok: false,
					error: 'name is required (or pass slug of an existing profile to update locations/identifiers)',
				},
			};
		}

		const requestedSlug = slugArg
			? makeProfileSlug(profileType, slugArg)
			: makeProfileSlug(profileType, name);
		let existing =
			existingBySlug ||
			getProfile(requestedSlug) ||
			resolveExistingProfile(name, profileType) ||
			(slugArg ? resolveExistingProfile(slugArg, profileType) : null);
		// Never rename/hijack a different firm that only fuzzy-matched earlier.
		if (
			existing &&
			existing.slug !== requestedSlug &&
			existing.name.trim().toLowerCase() !== name.trim().toLowerCase()
		) {
			existing = null;
		}
		if (!nameArg && existing) {
			name = existing.name;
		}

		const statusRaw = String(args.status || (existing ? existing.status : 'pinned')).trim().toLowerCase();
		const status = (['pinned', 'active', 'candidate', 'archived'].includes(statusRaw)
			? statusRaw
			: 'pinned') as ProfileStatus;

		const startDate =
			args.startDate === undefined
				? undefined
				: args.startDate === null || String(args.startDate).trim() === ''
					? null
					: String(args.startDate).trim();
		const endDate =
			args.endDate === undefined
				? undefined
				: args.endDate === null || String(args.endDate).trim() === ''
					? null
					: String(args.endDate).trim();

		const summaryRaw = args.summary != null ? String(args.summary).trim() : undefined;
		let summary =
			summaryRaw != null
				? preserveTimelineSectionsInSummary(existing?.summary, summaryRaw)
				: undefined;
		const metaIn = coerceUpsertMetadata(args.metadata);
		let effectiveStartDate = startDate;
		if (profileType === 'historic_event' && summary) {
			const sourceTag =
				typeof metaIn.newsFeedId === 'string' && metaIn.newsFeedId.trim()
					? metaIn.newsFeedId.trim()
					: null;
			const sourceUrl =
				typeof metaIn.sourceUrl === 'string' && metaIn.sourceUrl.trim()
					? metaIn.sourceUrl.trim()
					: null;
			const formatted = formatHistoricEventSummaryToTimeline(summary, {
				title: name,
				startDate: effectiveStartDate ?? existing?.startDate ?? null,
				sourceTag,
				sourceUrl,
			});
			if (formatted.changed) {
				summary = formatted.summary;
				if (effectiveStartDate === undefined && !existing?.startDate && formatted.inferredStartDate) {
					effectiveStartDate = formatted.inferredStartDate;
				}
				metaIn.overviewStyle = metaIn.overviewStyle || 'lead_plus_timeline_rail';
				metaIn.formatMode = metaIn.formatMode || 'dated_expressive';
			}
		}

		if (dryRun) {
			return {
				ok: true,
				result: {
					ok: true,
					dryRun: true,
					action: existing ? 'update' : 'create',
					slug: existing?.slug || requestedSlug,
					name: existing?.name || name,
					profileType,
					startDate: startDate === undefined ? existing?.startDate ?? null : startDate,
					endDate: endDate === undefined ? existing?.endDate ?? null : endDate,
					aliases: (args.aliases || []).length,
					locations: (args.locations || []).length,
					identifiers: (args.identifiers || []).length,
					links: (args.links || []).length,
				},
			};
		}

		const createdPeers: Array<{ slug: string; name: string }> = [];
		const linksWritten: Array<Record<string, unknown>> = [];
		let aliasesAdded = 0;
		let locationsAdded = 0;
		let identifiersAdded = 0;

		const srId = upsertSourceRecord({
			corpus,
			sourceRef: `chat-upsert:${requestedSlug}`,
			sourceUrl: null,
			title: `Chat upsert: ${name}`,
			excerpt: summary ? summary.slice(0, 400) : `Profile upserted via research chat (${profileType}).`,
			metadata: { profileType, name, requestedSlug },
		});

		let profile = existing
			? updateProfileFields(existing.id, {
					name,
					profileType,
					status,
					summary,
					startDate: effectiveStartDate,
					endDate,
					metadata: {
						...metaIn,
						sourceRecordId: srId,
						chatUpsertedAt: new Date().toISOString(),
					},
				})
			: upsertProfile({
					profileType,
					name,
					slug: requestedSlug,
					status,
					summary,
					startDate: effectiveStartDate,
					endDate,
					metadata: {
						...metaIn,
						sourceRecordId: srId,
						chatUpsertedAt: new Date().toISOString(),
					},
					sourceCorpus: corpus,
				});

		if (!profile) {
			throw new Error(`Failed to upsert profile for ${name}`);
		}

		if (summary && profile.summary.trim()) {
			const reorder = await ensureSummaryTimelineNewestFirst(profile.summary, { useOllama: false });
			if (reorder.changed && reorder.summary !== profile.summary) {
				profile = updateProfileFields(profile.id, { summary: reorder.summary }) || profile;
			}
			const synced = syncSummaryTimelineToEntries(profile.id, { summary: profile.summary });
			if (synced.parsed > 0) {
				profile =
					updateProfileFields(profile.id, {
						metadata: {
							overviewStyle: 'lead_plus_timeline_rail',
							timelineSyncedAt: new Date().toISOString(),
							timelineSyncedCount: synced.upsertedOwn,
						},
					}) || profile;
			}
		}

		// Ensure corpus tagging on updates (updateProfileFields does not auto-append corpora)
		if (existing) {
			const corpora = Array.isArray(profile.metadata?.corpora)
				? (profile.metadata.corpora as unknown[]).map(String)
				: [];
			if (!corpora.includes(corpus)) {
				profile =
					updateProfileFields(profile.id, { metadata: { corpora: [...corpora, corpus] } }) ||
					profile;
			}
		}

		for (const rawAlias of args.aliases || []) {
			const alias =
				typeof rawAlias === 'string' ? rawAlias.trim() : String(rawAlias?.alias || '').trim();
			if (!alias) continue;
			const kindRaw =
				typeof rawAlias === 'string'
					? 'name'
					: String(rawAlias?.kind || 'name').trim().toLowerCase();
			const aliasKind = (
				[
					'name',
					'acronym',
					'former_name',
					'crd',
					'cik',
					'ticker',
					'ein',
					'domain',
					'handle',
					'slug',
				].includes(kindRaw)
					? kindRaw
					: kindRaw === 'formerly' || kindRaw === 'former'
						? 'former_name'
						: 'name'
			) as AliasKind;
			addAlias({
				profileId: profile.id,
				alias,
				aliasKind,
				confidence: 0.95,
				sourceCorpus: corpus,
			});
			aliasesAdded += 1;
		}

		for (const loc of args.locations || []) {
			const raw = String(loc?.raw || '').trim();
			if (!raw) continue;
			const roleRaw = String(loc.role || 'associated').trim().toLowerCase();
			const role = (LOCATION_ROLES.includes(roleRaw as LocationRole)
				? roleRaw
				: 'associated') as LocationRole;
			const parts = normalizeLocationRecord({
				raw,
				city: loc.city,
				county: loc.county,
				state: loc.state,
				country: loc.country,
			});
			addLocation({
				profileId: profile.id,
				raw: parts.raw || raw,
				city: parts.city,
				county: parts.county,
				state: parts.state,
				country: parts.country || 'US',
				role,
				sourceCorpus: corpus,
			});
			locationsAdded += 1;
		}

		for (const id of args.identifiers || []) {
			const scheme = String(id?.scheme || '').trim().toLowerCase() as IdentifierScheme;
			const value = String(id?.value || '').trim();
			if (!value || !ALLOWED_IDENTIFIER_SCHEMES.has(scheme)) continue;
			addIdentifier({
				profileId: profile.id,
				scheme,
				value,
				sourceCorpus: corpus,
			});
			identifiersAdded += 1;
		}

		for (const link of args.links || []) {
			const peerName = String(link.peerName || '').trim();
			const peerSlug = String(link.peerSlug || '').trim();
			if (!peerName && !peerSlug) continue;
			const peerType = resolveProfileType(link.peerType, profileType);
			const relationRaw = String(link.relationType || 'business_tie').trim().toLowerCase();
			const relationType = (ALLOWED_RELATIONS.has(relationRaw as ProfileRelationType)
				? relationRaw
				: 'business_tie') as ProfileRelationType;
			const createPeer = link.createPeerIfMissing ?? createPeersDefault;

			let peer =
				(peerSlug ? getProfile(peerSlug) : null) ||
				(peerName ? resolveExistingProfile(peerName, peerType) : null) ||
				(peerSlug ? resolveExistingProfile(peerSlug, peerType) : null);

			if (!peer && createPeer) {
				const peerCreateName = peerName || peerSlug.replace(/^[^:]+:/, '').replace(/-/g, ' ');
				peer = upsertProfile({
					profileType: peerType,
					name: peerCreateName,
					slug: peerSlug || undefined,
					status: 'pinned',
					summary: `Related entity linked from ${name} via research chat upsert.`,
					sourceCorpus: corpus,
					metadata: { createdAsLinkPeerFrom: profile.slug },
				});
				createdPeers.push({ slug: peer.slug, name: peer.name });
			}
			if (!peer) continue;

			const linkId = upsertProfileLink({
				fromProfileId: profile.id,
				toProfileId: peer.id,
				relationType,
				roleLabel: link.roleLabel ? String(link.roleLabel).trim() : null,
				startDate:
					link.startDate === undefined
						? null
						: link.startDate === null || String(link.startDate).trim() === ''
							? null
							: String(link.startDate).trim(),
				endDate:
					link.endDate === undefined
						? null
						: link.endDate === null || String(link.endDate).trim() === ''
							? null
							: String(link.endDate).trim(),
				status: 'observed',
				confidence: 0.9,
				sourceCorpus: corpus,
				sourceRecordId: srId,
				evidenceNote: link.note ? String(link.note).trim() : undefined,
			});
			linksWritten.push({
				linkId,
				relationType,
				roleLabel: link.roleLabel || null,
				peerSlug: peer.slug,
				peerName: peer.name,
			});
		}

		const detail = getProfileDetail(profile.id);
		return {
			ok: true,
			result: {
				ok: true,
				action: existing ? 'updated' : 'created',
				slug: profile.slug,
				id: profile.id,
				name: profile.name,
				profileType: profile.profileType,
				status: profile.status,
				startDate: profile.startDate,
				endDate: profile.endDate,
				summary: (profile.summary || '').slice(0, 280),
				aliasesAdded,
				locationsAdded,
				identifiersAdded,
				linksWritten,
				createdPeers,
				hasLiveSourceUrl: detail?.profile.hasLiveSourceUrl ?? null,
				uiPath: `/profiles/${profile.slug.replace(':', '/')}`,
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}
