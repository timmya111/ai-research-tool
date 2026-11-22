import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { getProfile, upsertProfileLink } from '@/lib/research/profiles/store';
import type { LinkStatus, ProfileRelationType, TimelineAngle } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const fromProf = getProfile(String(body.fromProfileId || '').trim());
		const toProf = getProfile(String(body.toProfileId || '').trim());
		if (!fromProf || !toProf) {
			return NextResponse.json(
				{ ok: false, error: 'Both fromProfileId and toProfileId must resolve to existing profiles' },
				{ status: 400 },
			);
		}
		if (fromProf.id === toProf.id) {
			return NextResponse.json({ ok: false, error: 'Cannot link a profile to itself' }, { status: 400 });
		}

		const linkId = upsertProfileLink({
			fromProfileId: fromProf.id,
			toProfileId: toProf.id,
			relationType: (body.relationType ? String(body.relationType) : 'affiliated_with') as ProfileRelationType,
			roleLabel: body.roleLabel ? String(body.roleLabel) : null,
			startDate: body.startDate ? String(body.startDate) : null,
			endDate: body.endDate ? String(body.endDate) : null,
			status: (body.status ? String(body.status) : 'verified') as LinkStatus,
			confidence: typeof body.confidence === 'number' ? body.confidence : 0.9,
			angle: (body.angle ? String(body.angle) : 'general') as TimelineAngle,
			sourceCorpus: String(body.sourceCorpus || 'manual'),
			evidenceNote: body.evidenceNote ? String(body.evidenceNote) : '',
		});

		return NextResponse.json(
			{ ok: true, linkId },
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
