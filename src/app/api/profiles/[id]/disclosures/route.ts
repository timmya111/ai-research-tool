import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	ingestFinraDisclosureEventsToTimeline,
	loadDisclosureEventsForTimeline,
	loadProfileFinraDisclosures,
} from '@/lib/research/finraDisclosures';
import { getProfileDetail } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

function resolveCrd(
	profileType: string,
	metadata: Record<string, unknown> | null | undefined,
	identifiers: Array<{ scheme: string; value: string }> | null | undefined,
): string | null {
	const fromMeta = String(metadata?.finraCrd || '').trim();
	if (/^\d{1,10}$/.test(fromMeta)) return fromMeta;
	for (const id of identifiers || []) {
		if (String(id.scheme || '').toLowerCase() !== 'finra_crd') continue;
		const v = String(id.value || '').trim();
		if (/^\d{1,10}$/.test(v)) return v;
	}
	void profileType;
	return null;
}

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	if (!key) {
		return NextResponse.json({ ok: false, error: 'Profile id or slug is required' }, { status: 400 });
	}

	const url = new URL(request.url);
	const forceRefresh = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
	const skipTimeline =
		url.searchParams.get('timeline') === '0' || url.searchParams.get('skipTimeline') === '1';

	try {
		const detail = getProfileDetail(key);
		if (!detail?.profile) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}
		const profileType = detail.profile.profileType;
		if (profileType !== 'person' && profileType !== 'firm') {
			return NextResponse.json(
				{ ok: true, found: false, skip: true, reason: 'not_person_or_firm', events: [], typeCounts: [] },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}
		const crd = resolveCrd(profileType, detail.profile.metadata, detail.identifiers);
		if (!crd) {
			return NextResponse.json(
				{ ok: true, found: false, skip: true, reason: 'no_crd', events: [], typeCounts: [] },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		const crdKind = profileType === 'firm' ? 'firm' : 'individual';
		const disclosures = await loadProfileFinraDisclosures({
			crd,
			crdKind,
			forceRefresh,
		});

		let timeline: {
			added: number;
			updated: number;
			skippedUndated: number;
			clearedStubs: number;
			written: number;
		} | null = null;

		const shouldWriteTimeline =
			!skipTimeline &&
			disclosures.found &&
			(disclosures.events.length > 0 ||
				disclosures.finraDisclosureFlag === true ||
				disclosures.typeCounts.some((t) => t.count > 0));
		if (shouldWriteTimeline) {
			const timelineEvents = await loadDisclosureEventsForTimeline({
				crd,
				crdKind,
				overview: disclosures,
			});
			if (timelineEvents.length) {
				timeline = ingestFinraDisclosureEventsToTimeline({
					profileId: detail.profile.id,
					crd,
					crdKind,
					profileName: detail.profile.name,
					events: timelineEvents,
				});
			}
		}

		return NextResponse.json(
			{ ...disclosures, timeline },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
