import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	applyLandDeedsToProfile,
	loadLandDeedsForProfile,
	summaryHasLandDeeds,
} from '@/lib/research/profiles/landDeeds';
import { getProfile } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

/** GET — preview Land Deeds content for a profile (from okcr_instrument → knowledge). */
export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const profile = getProfile(decodeURIComponent(String(id || '').trim()));
	if (!profile) {
		return NextResponse.json({ ok: false, error: 'profile not found' }, { status: 404 });
	}
	const bundle = loadLandDeedsForProfile(profile.id);
	return NextResponse.json({
		ok: true,
		profileId: profile.id,
		profileName: profile.name,
		slug: profile.slug,
		summaryHasLandDeeds: summaryHasLandDeeds(profile.summary),
		filings: bundle?.filings || [],
		countyCounts: bundle?.countyCounts || [],
		markdown: bundle?.markdown || '',
		count: bundle?.filings.length || 0,
	});
}

/**
 * POST — write ## Land Deeds into overview summary (Cargill style) and delete
 * okcr_instrument URL identifier rows. Body: { dryRun?: boolean }.
 */
export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const profile = getProfile(decodeURIComponent(String(id || '').trim()));
	if (!profile) {
		return NextResponse.json({ ok: false, error: 'profile not found' }, { status: 404 });
	}
	let dryRun = false;
	try {
		const body = (await request.json()) as { dryRun?: boolean };
		dryRun = Boolean(body?.dryRun);
	} catch {
		/* empty body ok */
	}
	const result = applyLandDeedsToProfile(profile.id, { dryRun });
	if (!result.ok) {
		return NextResponse.json(
			{ ok: false, error: 'no okcr_instrument filings found for this profile', ...result },
			{ status: 404 },
		);
	}
	return NextResponse.json({ ok: true, ...result, profileId: profile.id, slug: profile.slug });
}
