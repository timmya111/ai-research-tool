import { after, NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	runAutoProfileResearchPipeline,
	shouldScheduleAutoResearch,
} from '@/lib/research/profiles/autoResearchPipeline';
import { resolveFirmIdentityOnCreate } from '@/lib/research/profiles/firmIdentityFilter';
import {
	addAlias,
	addIdentifier,
	addLocation,
	addPersonEmployment,
	getProfileDetail,
	getProfileStats,
	listProfiles,
	updateProfileFields,
	upsertProfile,
} from '@/lib/research/profiles/store';
import { formatHistoricEventSummaryToTimeline } from '@/lib/research/profiles/historicEventTimeline';
import {
	ensureSummaryTimelineNewestFirst,
	syncSummaryTimelineToEntries,
} from '@/lib/research/profiles/syncSummaryTimeline';
import {
	PROFILE_TYPES,
	type AliasKind,
	type IdentifierScheme,
	type LocationRole,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';
import { scheduleYahooFirmEnrich } from '@/lib/research/profiles/yahooFinance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const url = new URL(request.url);
	const q = url.searchParams.get('q') || undefined;
	const typeRaw = url.searchParams.get('type') || 'all';
	const tagRaw = url.searchParams.get('tag') || undefined;
	const statusRaw = url.searchParams.get('status') || undefined;
	const corpus = url.searchParams.get('corpus') || undefined;
	const geo = url.searchParams.get('geo') || undefined;
	const countryCodeRaw = url.searchParams.get('country') || url.searchParams.get('countryCode') || undefined;
	const countryCode = countryCodeRaw ? String(countryCodeRaw).trim().toLowerCase() : undefined;
	const limit = Number(url.searchParams.get('limit') || 50);
	const offset = Number(url.searchParams.get('offset') || 0);
	const includeStats = url.searchParams.get('stats') !== '0';

	const profileType =
		typeRaw === 'all' || typeRaw === 'actors' || typeRaw === 'narratives'
			? typeRaw
			: PROFILE_TYPES.includes(typeRaw as ProfileType)
				? (typeRaw as ProfileType)
				: 'all';
	const tag =
		tagRaw && PROFILE_TYPES.includes(tagRaw as ProfileType)
			? (tagRaw as ProfileType)
			: undefined;

	try {
		const { profiles, total } = listProfiles({
			query: q,
			profileType,
			tag,
			status: statusRaw as ProfileStatus | undefined,
			corpus,
			geo,
			countryCode,
			limit,
			offset,
		});
		const stats = includeStats ? getProfileStats() : undefined;
		return NextResponse.json(
			{ ok: true, profiles, total, stats },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const profileType = String(body.profileType || '').trim() as ProfileType;
		const name = String(body.name || '').trim();
		if (!name) {
			return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
		}
		if (!PROFILE_TYPES.includes(profileType)) {
			return NextResponse.json(
				{ ok: false, error: `profileType must be one of: ${PROFILE_TYPES.join(', ')}` },
				{ status: 400 },
			);
		}

		const metaInput: Record<string, unknown> =
			body.metadata && typeof body.metadata === 'object'
				? { ...(body.metadata as Record<string, unknown>) }
				: {};
		if (Array.isArray(body.categoryTags)) {
			metaInput.categoryTags = body.categoryTags
				.map((t) => String(t) as ProfileType)
				.filter((t) => PROFILE_TYPES.includes(t) && t !== 'person');
		}

		// Public listed firms: correct wrong types (e.g. government:Walmart) and
		// reuse the canonical firm card when ticker already exists. Yahoo enrich
		// runs in the background via FlareSolverr (does not block this request).
		const skipFirmFilter = body.skipFirmIdentityFilter === true;
		const identity = skipFirmFilter
			? null
			: resolveFirmIdentityOnCreate(name, profileType);
		let effectiveType = profileType;
		if (identity?.correctedType) {
			effectiveType = identity.resolvedType;
			metaInput.identityFilter = {
				correctedFrom: identity.requestedType,
				warnings: identity.warnings,
				ticker: identity.known?.ticker || null,
				exchange: identity.known?.exchange || null,
			};
		}
		if (identity?.known) {
			metaInput.ticker = metaInput.ticker || identity.known.ticker;
			metaInput.exchange = metaInput.exchange || identity.known.exchange;
			metaInput.legalName = metaInput.legalName || identity.known.legalName;
		}

		if (identity?.existingFirm && identity.known) {
			const existingId = identity.existingFirm.id;
			addIdentifier({
				profileId: existingId,
				scheme: 'ticker',
				value: identity.known.ticker,
				sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
			});
			if (identity.known.legalName) {
				addAlias({
					profileId: existingId,
					alias: identity.known.legalName,
					aliasKind: 'other_name',
					sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
				});
			}
			scheduleYahooFirmEnrich(existingId, identity.known.ticker, {
				exchange: identity.known.exchange,
			});
			const detail = getProfileDetail(existingId);
			return NextResponse.json(
				{
					ok: true,
					profile: detail?.profile || identity.existingFirm,
					identityFilter: {
						reusedExistingFirm: true,
						correctedType: identity.correctedType,
						warnings: identity.warnings,
						ticker: identity.known.ticker,
						yahooEnrichScheduled: true,
					},
				},
				{ status: 200, headers: { 'Cache-Control': 'no-store' } },
			);
		}

		const autoFormatDisabled =
			body.autoFormatTimeline === false ||
			body.autoFormatTimeline === 0 ||
			body.autoFormatTimeline === '0' ||
			body.autoFormatTimeline === 'false';
		let initialSummary = body.summary ? String(body.summary) : '';
		let initialStartDate = body.startDate ? String(body.startDate) : null;
		let autoFormattedHistoric = false;
		if (effectiveType === 'historic_event' && initialSummary.trim() && !autoFormatDisabled) {
			const sourceTag =
				typeof metaInput.newsFeedId === 'string' && metaInput.newsFeedId.trim()
					? metaInput.newsFeedId.trim()
					: null;
			const sourceUrl =
				typeof metaInput.sourceUrl === 'string' && metaInput.sourceUrl.trim()
					? metaInput.sourceUrl.trim()
					: null;
			const formatted = formatHistoricEventSummaryToTimeline(initialSummary, {
				title: name,
				startDate: initialStartDate,
				sourceTag,
				sourceUrl,
			});
			if (formatted.changed) {
				initialSummary = formatted.summary;
				autoFormattedHistoric = true;
				if (!initialStartDate && formatted.inferredStartDate) {
					initialStartDate = formatted.inferredStartDate;
				}
				metaInput.overviewStyle = metaInput.overviewStyle || 'lead_plus_timeline_rail';
				metaInput.formatMode = metaInput.formatMode || 'dated_expressive';
				metaInput.formattedBy = metaInput.formattedBy || 'auto-historic-timeline';
			}
		}

		let profile = upsertProfile({
			profileType: effectiveType,
			name,
			slug: body.slug ? String(body.slug) : undefined,
			status: (body.status ? String(body.status) : 'pinned') as ProfileStatus,
			summary: initialSummary,
			startDate: initialStartDate,
			endDate: body.endDate ? String(body.endDate) : null,
			metadata: Object.keys(metaInput).length ? metaInput : undefined,
			sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
		});

		let timelineSync: ReturnType<typeof syncSummaryTimelineToEntries> | null = null;
		const syncDisabled =
			body.syncTimelineFromSummary === false ||
			body.syncTimelineFromSummary === 0 ||
			body.syncTimelineFromSummary === '0' ||
			body.syncTimelineFromSummary === 'false';
		if (!syncDisabled && profile.summary.trim()) {
			let summaryForSync = profile.summary;
			const reorder = await ensureSummaryTimelineNewestFirst(summaryForSync, { useOllama: false });
			if (reorder.changed && reorder.summary !== summaryForSync) {
				const rewritten = updateProfileFields(profile.id, { summary: reorder.summary });
				if (rewritten) {
					profile = rewritten;
					summaryForSync = rewritten.summary || reorder.summary;
				} else {
					summaryForSync = reorder.summary;
				}
			}
			timelineSync = syncSummaryTimelineToEntries(profile.id, {
				summary: summaryForSync,
				mirrorToRelated: body.mirrorTimelineToRelated !== false,
			});
			if (timelineSync.parsed > 0 || autoFormattedHistoric || reorder.changed) {
				const nextMeta = {
					...(profile.metadata || {}),
					overviewStyle: 'lead_plus_timeline_rail',
					formatMode:
						typeof (profile.metadata || {}).formatMode === 'string'
							? (profile.metadata as { formatMode?: string }).formatMode
							: 'dated_expressive',
					timelineSyncedAt: new Date().toISOString(),
					timelineSyncedCount: timelineSync.upsertedOwn,
				};
				profile = updateProfileFields(profile.id, { metadata: nextMeta }) || profile;
			}
		}

		if (identity?.known) {
			addIdentifier({
				profileId: profile.id,
				scheme: 'ticker',
				value: identity.known.ticker,
				sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
			});
			if (identity.known.legalName) {
				addAlias({
					profileId: profile.id,
					alias: identity.known.legalName,
					aliasKind: 'other_name',
					sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
				});
			}
			if (effectiveType === 'firm') {
				scheduleYahooFirmEnrich(profile.id, identity.known.ticker, {
					exchange: identity.known.exchange,
				});
			}
		}

		if (profileType === 'person' && Array.isArray(body.employmentHistory)) {
			for (const emp of body.employmentHistory as Array<Record<string, unknown>>) {
				if (!emp?.orgName) continue;
				addPersonEmployment({
					personIdOrSlug: profile.id,
					orgName: String(emp.orgName),
					orgCategory: emp.orgCategory ? (String(emp.orgCategory) as ProfileType) : undefined,
					role: emp.role ? String(emp.role) : null,
					startDate: emp.startDate ? String(emp.startDate) : null,
					endDate: emp.endDate ? String(emp.endDate) : null,
					isCurrent: typeof emp.isCurrent === 'boolean' ? emp.isCurrent : undefined,
					location: emp.location ? String(emp.location) : null,
					notes: emp.notes ? String(emp.notes) : null,
					sourceCorpus: 'manual',
				});
			}
		}

		if (Array.isArray(body.aliases)) {
			for (const a of body.aliases) {
				if (typeof a === 'string') {
					addAlias({ profileId: profile.id, alias: a, sourceCorpus: 'manual' });
				} else if (a && typeof a === 'object') {
					const obj = a as Record<string, unknown>;
					addAlias({
						profileId: profile.id,
						alias: String(obj.alias || ''),
						aliasKind: (obj.aliasKind ? String(obj.aliasKind) : 'name') as AliasKind,
						sourceCorpus: 'manual',
					});
				}
			}
		}

		if (Array.isArray(body.identifiers)) {
			for (const idItem of body.identifiers as Array<Record<string, unknown>>) {
				if (!idItem?.scheme || !idItem?.value) continue;
				addIdentifier({
					profileId: profile.id,
					scheme: String(idItem.scheme) as IdentifierScheme,
					value: String(idItem.value),
					sourceCorpus: 'manual',
				});
			}
		}

		if (Array.isArray(body.locations)) {
			for (const loc of body.locations as Array<Record<string, unknown>>) {
				const raw = String(loc?.raw || '').trim();
				if (!raw) continue;
				addLocation({
					profileId: profile.id,
					raw,
					city: loc.city ? String(loc.city) : null,
					county: loc.county ? String(loc.county) : null,
					state: loc.state ? String(loc.state) : null,
					country: loc.country ? String(loc.country) : null,
					role: (loc.role ? String(loc.role) : 'associated') as LocationRole,
					sourceCorpus: 'manual',
				});
			}
		}

		const sourceCorpusStr = body.sourceCorpus ? String(body.sourceCorpus) : 'manual';
		const skipAutoResearch =
			body.skipAutoResearch === true ||
			body.skipAutoResearch === 1 ||
			body.skipAutoResearch === '1' ||
			body.skipAutoResearch === 'true';
		const forceAutoResearch =
			body.autoResearch === true ||
			body.autoResearch === 1 ||
			body.autoResearch === '1' ||
			body.autoResearch === 'true';
		const autoResearchScheduled =
			!skipAutoResearch &&
			(sourceCorpusStr === 'manual' || forceAutoResearch) &&
			shouldScheduleAutoResearch(profile.id, { force: forceAutoResearch });
		if (autoResearchScheduled) {
			const pid = profile.id;
			after(async () => {
				try {
					await runAutoProfileResearchPipeline(pid, {
						trigger: 'create',
						force: forceAutoResearch,
					});
				} catch (err) {
					console.error('[auto-research] create pipeline failed', err);
				}
			});
		}

		return NextResponse.json(
			{
				ok: true,
				profile,
				...(timelineSync ? { timelineSync, autoFormattedHistoric } : {}),
				...(autoResearchScheduled
					? { autoResearch: { scheduled: true, trigger: 'create', profileId: profile.id } }
					: {}),
				...(identity
					? {
							identityFilter: {
								reusedExistingFirm: false,
								correctedType: identity.correctedType,
								warnings: identity.warnings,
								ticker: identity.known?.ticker || null,
								yahooEnrichScheduled: Boolean(identity.known && effectiveType === 'firm'),
							},
						}
					: {}),
			},
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
