import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { getProfileDetail, mergeProfiles } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const keepId = String(body.keepId || '').trim();
		const mergeId = String(body.mergeId || '').trim();
		if (!keepId || !mergeId) {
			return NextResponse.json(
				{ ok: false, error: 'keepId and mergeId are required' },
				{ status: 400 },
			);
		}
		if (keepId === mergeId) {
			return NextResponse.json(
				{ ok: false, error: 'keepId and mergeId must be different profiles' },
				{ status: 400 },
			);
		}

		const merged = mergeProfiles(keepId, mergeId);
		if (!merged) {
			return NextResponse.json(
				{ ok: false, error: 'One or both profiles were not found' },
				{ status: 404 },
			);
		}
		const detail = getProfileDetail(merged.kept.id);
		return NextResponse.json(
			{ ok: true, ...merged, detail },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
