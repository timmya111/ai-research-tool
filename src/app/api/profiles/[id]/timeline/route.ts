import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { syncEmploymentSpansToTimeline } from '@/lib/research/profiles/employmentTimeline';
import { normalizeGeoKey } from '@/lib/research/profiles/normalize';
import {
	getProfile,
	touchProfilesForUserAction,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import { getProfileTimeline } from '@/lib/research/profiles/timeline';
import type { TimelineAngle, TimelineEntryKind } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const url = new URL(request.url);
	const from = url.searchParams.get('from') || undefined;
	const to = url.searchParams.get('to') || undefined;
	const angle = url.searchParams.get('angle') || undefined;
	const corpus = url.searchParams.get('corpus') || undefined;
	const minGapDays = url.searchParams.get('minGapDays')
		? Number(url.searchParams.get('minGapDays'))
		: undefined;
	const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
	const detectGaps = url.searchParams.get('detectGaps') !== '0';
	const fillFromKnowledge = url.searchParams.get('fillFromKnowledge') !== '0';
	const includeLinkedParam = url.searchParams.get('includeLinkedEvents');
	const includeLinkedEvents =
		includeLinkedParam == null ? undefined : includeLinkedParam !== '0' && includeLinkedParam !== 'false';

	const key = decodeURIComponent(String(id || '').trim());
	const profile = getProfile(key);
	if (profile?.profileType === 'person') {
		try {
			syncEmploymentSpansToTimeline(profile.id);
		} catch {
			/* employment span sync is best-effort */
		}
	}

	const result = getProfileTimeline(key, {
		from,
		to,
		angle,
		corpus,
		minGapDays,
		limit,
		detectGaps,
		fillFromKnowledge,
		includeLinkedEvents,
	});
	if (!result) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const profile = getProfile(decodeURIComponent(String(id || '').trim()));
	if (!profile) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const title = String(body.title || '').trim();
		if (!title) {
			return NextResponse.json({ ok: false, error: 'title is required' }, { status: 400 });
		}

		const sourceCorpus = String(body.sourceCorpus || 'manual').trim();
		const sourceUrl = body.sourceUrl ? String(body.sourceUrl).trim() : null;
		let sourceRecordId: string | null = null;
		if (sourceUrl || body.sourceRef) {
			sourceRecordId = upsertSourceRecord({
				corpus: sourceCorpus,
				sourceRef: String(body.sourceRef || sourceUrl || `manual:${Date.now()}`),
				sourceUrl,
				title,
				publishedDate: body.eventDate ? String(body.eventDate) : null,
				excerpt: body.summary ? String(body.summary) : '',
			});
		}

		const geoLabel = body.geoLabel ? String(body.geoLabel).trim() : null;
		const geoKey = geoLabel ? normalizeGeoKey({ raw: geoLabel }) : null;

		const entryId = upsertTimelineEntry({
			profileId: profile.id,
			eventDate: body.eventDate ? String(body.eventDate) : null,
			endDate: body.endDate ? String(body.endDate) : null,
			title,
			summary: body.summary ? String(body.summary) : '',
			angle: (body.angle ? String(body.angle) : 'general') as TimelineAngle,
			entryKind: (body.entryKind ? String(body.entryKind) : 'observation') as TimelineEntryKind,
			geoKey,
			geoLabel,
			sourceCorpus,
			sourceRecordId,
		});

		touchProfilesForUserAction([profile.id]);
		return NextResponse.json(
			{ ok: true, entryId },
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
