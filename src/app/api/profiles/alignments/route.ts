import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { listAlignments } from '@/lib/research/profiles/align';
import { getProfile, updateAlignmentStatus } from '@/lib/research/profiles/store';
import type { AlignmentKind, AlignmentStatus, CautionTier } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const url = new URL(request.url);
	const profileKey = url.searchParams.get('profileId') || undefined;
	let profileId: string | undefined;
	if (profileKey) {
		const p = getProfile(profileKey);
		profileId = p ? p.id : profileKey;
	}
	const alignmentKind = (url.searchParams.get('kind') || undefined) as AlignmentKind | undefined;
	const status = (url.searchParams.get('status') || undefined) as AlignmentStatus | undefined;
	const cautionTier = (url.searchParams.get('cautionTier') || undefined) as CautionTier | undefined;
	const minScoreRaw = url.searchParams.get('minScore');
	const minScore = minScoreRaw != null ? Number(minScoreRaw) : undefined;
	const limit = Number(url.searchParams.get('limit') || 50);
	const offset = Number(url.searchParams.get('offset') || 0);

	try {
		const res = listAlignments({
			profileId,
			alignmentKind,
			status,
			cautionTier,
			minScore,
			limit,
			offset,
		});
		return NextResponse.json({ ok: true, ...res }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function PATCH(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const id = String(body.id || '').trim();
		const status = String(body.status || '').trim() as AlignmentStatus;
		if (!id || !['proposed', 'confirmed', 'dismissed'].includes(status)) {
			return NextResponse.json(
				{ ok: false, error: 'id and status (proposed|confirmed|dismissed) are required' },
				{ status: 400 },
			);
		}
		const updated = updateAlignmentStatus(id, status);
		if (!updated) {
			return NextResponse.json({ ok: false, error: 'Alignment candidate not found' }, { status: 404 });
		}
		return NextResponse.json(
			{ ok: true, alignment: updated },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
