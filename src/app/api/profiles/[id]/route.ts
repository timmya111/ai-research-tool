import { after, NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	runAutoProfileResearchPipeline,
	shouldScheduleAutoResearch,
} from '@/lib/research/profiles/autoResearchPipeline';
import { extractDatesFromProse } from '@/lib/research/profiles/dateResolver';
import {
	addAlias,
	addIdentifier,
	addLocation,
	deleteAlias,
	deleteIdentifier,
	deleteLocation,
	deleteProfile,
	findExistingProfileDuplicate,
	getProfile,
	getProfileDetail,
	recordDuplicateAlignmentCandidates,
	replaceOtherNames,
	touchProfilesForUserAction,
	updateAlias,
	updateLocation,
	updateProfileFields,
} from '@/lib/research/profiles/store';
import {
	formatHistoricEventSummaryToTimeline,
	summaryAlreadyHasTimelinedView,
} from '@/lib/research/profiles/historicEventTimeline';
import {
	ensureSummaryTimelineNewestFirst,
	syncSummaryTimelineToEntries,
} from '@/lib/research/profiles/syncSummaryTimeline';
import {
	LOCATION_ROLES,
	PROFILE_TYPES,
	type AliasKind,
	type IdentifierScheme,
	type LocationRole,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const detail = getProfileDetail(decodeURIComponent(String(id || '').trim()));
	if (!detail) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true, ...detail }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const metadataPatch: Record<string, unknown> = {};
		if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
			Object.assign(metadataPatch, body.metadata as Record<string, unknown>);
		}
		if (Array.isArray(body.categoryTags)) {
			metadataPatch.categoryTags = body.categoryTags
				.map((t) => String(t) as ProfileType)
				.filter((t) => PROFILE_TYPES.includes(t) && t !== 'person');
		}
		const hasMetadataPatch = Object.keys(metadataPatch).length > 0;

		const nextProfileType =
			body.profileType != null ? (String(body.profileType).trim() as ProfileType) : undefined;
		if (nextProfileType !== undefined && !PROFILE_TYPES.includes(nextProfileType)) {
			return NextResponse.json(
				{ ok: false, error: `Invalid profileType: ${String(body.profileType)}` },
				{ status: 400 },
			);
		}

		// Extra duplicate validation check when renaming or changing category on an existing profile.
		const allowDuplicate = body.allowDuplicate === true;
		const existingBeforeUpdate = getProfile(key);
		if (!existingBeforeUpdate) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}
		if (!allowDuplicate) {
			const candidateName =
				body.name != null && String(body.name).trim()
					? String(body.name).trim()
					: existingBeforeUpdate.name;
			const candidateType = nextProfileType ?? existingBeforeUpdate.profileType;
			const nameOrTypeChanging =
				candidateName !== existingBeforeUpdate.name ||
				candidateType !== existingBeforeUpdate.profileType;
			if (nameOrTypeChanging) {
				const dupHit = findExistingProfileDuplicate({
					name: candidateName,
					profileType: candidateType,
					startDate:
						body.startDate !== undefined
							? body.startDate
								? String(body.startDate)
								: null
							: existingBeforeUpdate.startDate,
					endDate:
						body.endDate !== undefined
							? body.endDate
								? String(body.endDate)
								: null
							: existingBeforeUpdate.endDate,
					excludeProfileId: existingBeforeUpdate.id,
				});
				if (dupHit) {
					const ep = dupHit.profile;
					// Surface this duplicate pair in /profiles/alignments immediately so the user can merge or dismiss it.
					recordDuplicateAlignmentCandidates(existingBeforeUpdate.id);
					return NextResponse.json(
						{
							ok: false,
							duplicate: true,
							matchReason: dupHit.matchReason,
							error: `Another matching profile already exists: "${ep.name}" (${ep.profileType.replace(/_/g, ' ')} — ${dupHit.matchReason}).`,
							existingProfile: {
								id: ep.id,
								slug: ep.slug,
								name: ep.name,
								profileType: ep.profileType,
								primaryLocation: dupHit.primaryLocation,
							},
						},
						{ status: 409, headers: { 'Cache-Control': 'no-store' } },
					);
				}
			}
		}

		let patchStartDate =
			body.startDate !== undefined ? (body.startDate ? String(body.startDate) : null) : undefined;
		let patchEndDate =
			body.endDate !== undefined ? (body.endDate ? String(body.endDate) : null) : undefined;
		if (body.summary != null) {
			const effectiveStart =
				patchStartDate !== undefined ? patchStartDate : existingBeforeUpdate.startDate;
			const effectiveEnd =
				patchEndDate !== undefined ? patchEndDate : existingBeforeUpdate.endDate;
			if (!effectiveStart || !effectiveEnd) {
				const extracted = extractDatesFromProse(
					String(body.summary),
					nextProfileType ?? existingBeforeUpdate.profileType,
					body.name != null ? String(body.name) : existingBeforeUpdate.name,
				);
				if (!effectiveStart && extracted.startDate) patchStartDate = extracted.startDate;
				if (!effectiveEnd && extracted.endDate) patchEndDate = extracted.endDate;
			}
		}

		let updated = updateProfileFields(key, {
			name: body.name != null ? String(body.name) : undefined,
			profileType: nextProfileType,
			status: body.status != null ? (String(body.status) as ProfileStatus) : undefined,
			summary: body.summary != null ? String(body.summary) : undefined,
			startDate: patchStartDate,
			endDate: patchEndDate,
			metadata: hasMetadataPatch ? metadataPatch : undefined,
		});
		if (!updated) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}

		// Auto-extract explicit EIN / FEIN (e.g., "EIN: 73-6101744") from updated summary prose
		if (typeof body.summary === 'string' && body.summary.trim()) {
			const einMatches = body.summary.matchAll(/\b(?:IRS\s+)?(?:F?EIN)\s*[:#-]?\s*(\d{2}-\d{7})\b/gi);
			const seenEins = new Set<string>();
			for (const em of einMatches) {
				const ein = em[1]?.trim();
				if (ein && !seenEins.has(ein)) {
					seenEins.add(ein);
					addIdentifier({
						profileId: updated.id,
						scheme: 'irs_ein',
						value: ein,
						sourceCorpus: 'manual',
					});
				}
			}
		}

		if (typeof body.addAlias === 'string' && body.addAlias.trim()) {
			addAlias({ profileId: updated.id, alias: body.addAlias.trim(), sourceCorpus: 'manual' });
		} else if (body.addAlias && typeof body.addAlias === 'object') {
			const a = body.addAlias as Record<string, unknown>;
			const alias = String(a.alias || '').trim();
			const kindRaw = a.aliasKind != null ? String(a.aliasKind) : 'name';
			const aliasKind = (
				['name', 'other_name', 'former_name', 'acronym', 'slug'].includes(kindRaw)
					? kindRaw
					: 'name'
			) as AliasKind;
			if (alias) {
				addAlias({
					profileId: updated.id,
					alias,
					aliasKind,
					sourceCorpus: 'manual',
				});
			}
		}
		if (body.updateAlias && typeof body.updateAlias === 'object') {
			const a = body.updateAlias as Record<string, unknown>;
			const aliasId = a.id != null ? String(a.id).trim() : '';
			if (!aliasId) {
				return NextResponse.json({ ok: false, error: 'updateAlias.id is required' }, { status: 400 });
			}
			const kindRaw = a.aliasKind != null ? String(a.aliasKind) : undefined;
			const aliasKind =
				kindRaw && ['name', 'other_name', 'former_name', 'acronym', 'slug'].includes(kindRaw)
					? (kindRaw as AliasKind)
					: undefined;
			const ok = updateAlias({
				id: aliasId,
				profileId: updated.id,
				alias: a.alias != null ? String(a.alias) : undefined,
				aliasKind,
			});
			if (!ok) {
				return NextResponse.json(
					{ ok: false, error: 'Alias not found or conflicts with an existing name' },
					{ status: 404 },
				);
			}
		}
		if (Array.isArray(body.replaceOtherNames)) {
			replaceOtherNames({
				profileId: updated.id,
				names: body.replaceOtherNames.map((n) => String(n ?? '')),
			});
		}
		if (body.addLocation && typeof body.addLocation === 'object') {
			const loc = body.addLocation as Record<string, unknown>;
			if (loc.raw) {
				const roleRaw = loc.role ? String(loc.role) : 'associated';
				const role = (LOCATION_ROLES.includes(roleRaw as LocationRole)
					? roleRaw
					: 'associated') as LocationRole;
				addLocation({
					profileId: updated.id,
					raw: String(loc.raw),
					city: loc.city ? String(loc.city) : null,
					county: loc.county ? String(loc.county) : null,
					state: loc.state ? String(loc.state) : null,
					country: loc.country ? String(loc.country) : null,
					role,
					sourceCorpus: 'manual',
					confirmed: Boolean(loc.confirmed),
				});
			}
		}
		if (body.updateLocation && typeof body.updateLocation === 'object') {
			const loc = body.updateLocation as Record<string, unknown>;
			const locId = loc.id != null ? String(loc.id).trim() : '';
			if (!locId) {
				return NextResponse.json({ ok: false, error: 'updateLocation.id is required' }, { status: 400 });
			}
			const roleRaw = loc.role != null ? String(loc.role) : undefined;
			const role =
				roleRaw && LOCATION_ROLES.includes(roleRaw as LocationRole)
					? (roleRaw as LocationRole)
					: undefined;
			const ok = updateLocation({
				id: locId,
				profileId: updated.id,
				raw: loc.raw != null ? String(loc.raw) : undefined,
				city: loc.city !== undefined ? (loc.city ? String(loc.city) : null) : undefined,
				county: loc.county !== undefined ? (loc.county ? String(loc.county) : null) : undefined,
				state: loc.state !== undefined ? (loc.state ? String(loc.state) : null) : undefined,
				country: loc.country !== undefined ? (loc.country ? String(loc.country) : null) : undefined,
				role,
				confirmed: loc.confirmed !== undefined ? Boolean(loc.confirmed) : undefined,
			});
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Location not found or invalid' }, { status: 404 });
			}
		}
		if (body.deleteLocation != null) {
			const locId =
				typeof body.deleteLocation === 'object' && body.deleteLocation !== null
					? String((body.deleteLocation as Record<string, unknown>).id || '').trim()
					: String(body.deleteLocation).trim();
			if (!locId) {
				return NextResponse.json({ ok: false, error: 'deleteLocation id is required' }, { status: 400 });
			}
			const ok = deleteLocation({ id: locId, profileId: updated.id });
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404 });
			}
		}
		if (body.deleteAlias != null) {
			const aliasId =
				typeof body.deleteAlias === 'object' && body.deleteAlias !== null
					? String((body.deleteAlias as Record<string, unknown>).id || '').trim()
					: String(body.deleteAlias).trim();
			if (!aliasId) {
				return NextResponse.json({ ok: false, error: 'deleteAlias id is required' }, { status: 400 });
			}
			const ok = deleteAlias({ id: aliasId, profileId: updated.id });
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Alias not found' }, { status: 404 });
			}
		}
		if (body.addIdentifier && typeof body.addIdentifier === 'object') {
			const ident = body.addIdentifier as Record<string, unknown>;
			const scheme = String(ident.scheme || '').trim() as IdentifierScheme;
			const value = String(ident.value || '').trim();
			const allowed: IdentifierScheme[] = [
				'finra_crd',
				'sec_cik',
				'parent_sec_cik',
				'ticker',
				'irs_ein',
				'tx_sos_file',
				'tx_taxpayer',
				'ok_sos_file',
				'cusip',
				'ror',
				'orcid',
				'wikidata',
				'usgs_event',
				'spc_om',
				'dossier_slug',
				'okcr_instrument',
				'source_id',
				'url',
				'us_passport',
				'driver_license',
			];
			if (!value || !allowed.includes(scheme)) {
				return NextResponse.json(
					{ ok: false, error: 'addIdentifier requires a valid scheme and value' },
					{ status: 400 },
				);
			}
			addIdentifier({
				profileId: updated.id,
				scheme,
				value,
				sourceCorpus: 'manual',
			});
		}
		if (body.deleteIdentifier != null) {
			const identId =
				typeof body.deleteIdentifier === 'object' && body.deleteIdentifier !== null
					? String((body.deleteIdentifier as Record<string, unknown>).id || '').trim()
					: String(body.deleteIdentifier).trim();
			if (!identId) {
				return NextResponse.json(
					{ ok: false, error: 'deleteIdentifier id is required' },
					{ status: 400 },
				);
			}
			const ok = deleteIdentifier({ id: identId, profileId: updated.id });
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Identifier not found' }, { status: 404 });
			}
		}

		const userTouch =
			body.userTouch === true ||
			body.userTouch === 1 ||
			body.userTouch === '1' ||
			body.userTouch === 'true';
		const manualEdit =
			userTouch ||
			body.name != null ||
			body.profileType != null ||
			body.summary != null ||
			body.startDate !== undefined ||
			body.endDate !== undefined ||
			body.addAlias != null ||
			body.updateAlias != null ||
			body.replaceOtherNames != null ||
			body.deleteAlias != null ||
			body.addLocation != null ||
			body.updateLocation != null ||
			body.deleteLocation != null ||
			body.addIdentifier != null ||
			body.deleteIdentifier != null;
		if (manualEdit) {
			touchProfilesForUserAction([updated.id]);
			updated = getProfile(updated.id) || updated;
		}
		// Immediately refresh duplicate candidates in /profiles/alignments after profile updates.
		recordDuplicateAlignmentCandidates(updated.id);

		/** Sync Overview ## Timeline dated bullets → Timeline tab (+ linked historic_event mirrors). */
		const syncFlag = body.syncTimelineFromSummary;
		const syncDisabled =
			syncFlag === false || syncFlag === 0 || syncFlag === '0' || syncFlag === 'false';
		const syncForced =
			syncFlag === true || syncFlag === 1 || syncFlag === '1' || syncFlag === 'true';
		const ollamaReorderFlag = body.ollamaReorderTimeline;
		const ollamaReorderDisabled =
			ollamaReorderFlag === false ||
			ollamaReorderFlag === 0 ||
			ollamaReorderFlag === '0' ||
			ollamaReorderFlag === 'false';
		let timelineSync: (ReturnType<typeof syncSummaryTimelineToEntries> & {
			reorder?: {
				changed: boolean;
				method: 'deterministic' | 'ollama' | 'none';
				datedCount: number;
				error?: string;
			};
		}) | null = null;
		const autoFormatDisabled =
			body.autoFormatTimeline === false ||
			body.autoFormatTimeline === 0 ||
			body.autoFormatTimeline === '0' ||
			body.autoFormatTimeline === 'false';
		if (!syncDisabled && (body.summary != null || syncForced)) {
			let summaryForSync = updated.summary || '';
			let autoFormattedHistoric = false;
			if (
				!autoFormatDisabled &&
				updated.profileType === 'historic_event' &&
				summaryForSync.trim() &&
				!summaryAlreadyHasTimelinedView(summaryForSync)
			) {
				const metaObj = (updated.metadata || {}) as Record<string, unknown>;
				const sourceTag =
					typeof metaObj.newsFeedId === 'string' && metaObj.newsFeedId.trim()
						? metaObj.newsFeedId.trim()
						: null;
				const sourceUrl =
					typeof metaObj.sourceUrl === 'string' && metaObj.sourceUrl.trim()
						? metaObj.sourceUrl.trim()
						: null;
				const formatted = formatHistoricEventSummaryToTimeline(summaryForSync, {
					title: updated.name,
					startDate: updated.startDate,
					sourceTag,
					sourceUrl,
				});
				if (formatted.changed) {
					const patchFields: { summary: string; startDate?: string | null } = {
						summary: formatted.summary,
					};
					if (!updated.startDate && formatted.inferredStartDate) {
						patchFields.startDate = formatted.inferredStartDate;
					}
					const rewritten = updateProfileFields(updated.id, patchFields);
					if (rewritten) {
						updated = rewritten;
						summaryForSync = rewritten.summary || formatted.summary;
					} else {
						summaryForSync = formatted.summary;
					}
					autoFormattedHistoric = true;
				}
			}
			const reorder = await ensureSummaryTimelineNewestFirst(summaryForSync, {
				useOllama: !ollamaReorderDisabled,
			});
			if (reorder.changed && reorder.summary !== summaryForSync) {
				const rewritten = updateProfileFields(updated.id, { summary: reorder.summary });
				if (rewritten) {
					updated = rewritten;
					summaryForSync = rewritten.summary || reorder.summary;
				} else {
					summaryForSync = reorder.summary;
				}
			}
			timelineSync = {
				...syncSummaryTimelineToEntries(updated.id, {
					summary: summaryForSync,
					mirrorToRelated: body.mirrorTimelineToRelated !== false,
				}),
				reorder: {
					changed: reorder.changed || autoFormattedHistoric,
					method: reorder.changed ? reorder.method : autoFormattedHistoric ? 'deterministic' : 'none',
					datedCount: reorder.datedCount,
					...(reorder.error ? { error: reorder.error } : {}),
				},
			};
			if (timelineSync.parsed > 0 || reorder.changed || autoFormattedHistoric) {
				const meta = {
					...(updated.metadata || {}),
					overviewStyle: 'lead_plus_timeline_rail',
					formatMode:
						typeof (updated.metadata || {}).formatMode === 'string' ?
							(updated.metadata as { formatMode?: string }).formatMode
						:	'dated_expressive',
					timelineSyncedAt: new Date().toISOString(),
					timelineSyncedCount: timelineSync.upsertedOwn,
					...(reorder.changed ?
						{
							timelineReorderedAt: new Date().toISOString(),
							timelineReorderMethod: reorder.method,
						}
					:	{}),
				};
				updateProfileFields(updated.id, { metadata: meta });
			}
		}

		// Do NOT auto-run background research/entity discovery on profile edits.
		// Auto-research runs only on profile creation (POST /api/profiles), explicit
		// "Research & Fill Details" (POST /api/profiles/[id]/enrich), or when a caller
		// explicitly passes autoResearch: true.
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
		const isAutomatedBatchPatch =
			metadataPatch.formattedBy === 'news-rss-format-card' ||
			metadataPatch.formattedBy === 'historic-events-basic-timeline' ||
			metadataPatch.sparseTimelineEnrichedAt != null ||
			metadataPatch.entityCrawledAt != null;
		const autoResearchScheduled =
			!skipAutoResearch &&
			!isAutomatedBatchPatch &&
			forceAutoResearch &&
			shouldScheduleAutoResearch(updated.id, { force: true });
		if (autoResearchScheduled) {
			const pid = updated.id;
			after(async () => {
				try {
					await runAutoProfileResearchPipeline(pid, {
						trigger: 'update',
						force: forceAutoResearch,
					});
				} catch (err) {
					console.error('[auto-research] update pipeline failed', err);
				}
			});
		}

		const detail = getProfileDetail(updated.id);
		return NextResponse.json(
			{
				ok: true,
				...detail,
				...(timelineSync ? { timelineSync } : {}),
				...(autoResearchScheduled
					? { autoResearch: { scheduled: true, trigger: 'update', profileId: updated.id } }
					: {}),
			},
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function DELETE(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const ok = deleteProfile(decodeURIComponent(String(id || '').trim()));
	if (!ok) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
