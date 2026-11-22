/**
 * Agent tool handlers for the unified Entity Profile & Cross-Source Alignment store
 * (.data/profiles/profiles.sqlite).
 */
import { listAlignments } from '@/lib/research/profiles/align';
import { enrichProfile } from '@/lib/research/profiles/enrich';
import { getProfileDetail, getProfileStats, listProfiles } from '@/lib/research/profiles/store';
import { getProfileTimeline } from '@/lib/research/profiles/timeline';
import {
	PROFILE_TYPES,
	type AlignmentKind,
	type AlignmentStatus,
	type CautionTier,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';

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
