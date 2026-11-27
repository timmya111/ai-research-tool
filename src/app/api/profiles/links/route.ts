import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	deleteProfileLink,
	getProfile,
	touchProfilesForUserAction,
	updateProfileLink,
	upsertProfileLink,
} from '@/lib/research/profiles/store';
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

		touchProfilesForUserAction([fromProf.id, toProf.id]);
		return NextResponse.json(
			{ ok: true, linkId },
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

/** Body: { linkId, profileId?, relationType?, roleLabel?, startDate?, endDate?, evidenceNote?, status? } */
export async function PATCH(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const linkId = String(body.linkId || body.id || '').trim();
		if (!linkId) {
			return NextResponse.json({ ok: false, error: 'linkId is required' }, { status: 400 });
		}
		let profileId: string | null = body.profileId ? String(body.profileId).trim() : null;
		if (profileId) {
			const prof = getProfile(profileId);
			profileId = prof?.id || profileId;
		}
		const result = updateProfileLink({
			id: linkId,
			profileId,
			...(body.relationType != null ?
				{ relationType: String(body.relationType) as ProfileRelationType }
			:	{}),
			...(Object.prototype.hasOwnProperty.call(body, 'roleLabel') ?
				{ roleLabel: body.roleLabel == null ? null : String(body.roleLabel) }
			:	{}),
			...(Object.prototype.hasOwnProperty.call(body, 'startDate') ?
				{ startDate: body.startDate == null || body.startDate === '' ? null : String(body.startDate) }
			:	{}),
			...(Object.prototype.hasOwnProperty.call(body, 'endDate') ?
				{ endDate: body.endDate == null || body.endDate === '' ? null : String(body.endDate) }
			:	{}),
			...(Object.prototype.hasOwnProperty.call(body, 'evidenceNote') ?
				{ evidenceNote: body.evidenceNote == null ? '' : String(body.evidenceNote) }
			:	{}),
			...(body.status != null ? { status: String(body.status) as LinkStatus } : {}),
		});
		if (!result.ok) {
			const status = result.error.includes('not found') ? 404 : 409;
			return NextResponse.json({ ok: false, error: result.error }, { status });
		}
		if (profileId) touchProfilesForUserAction([profileId]);
		return NextResponse.json({ ok: true, linkId: result.id }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

/** Body: { linkId, profileId? } — profileId scopes delete to links touching that card. */
export async function DELETE(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const linkId = String(body.linkId || body.id || '').trim();
		if (!linkId) {
			return NextResponse.json({ ok: false, error: 'linkId is required' }, { status: 400 });
		}
		let profileId: string | null = body.profileId ? String(body.profileId).trim() : null;
		if (profileId) {
			const prof = getProfile(profileId);
			profileId = prof?.id || profileId;
		}
		const deleted = deleteProfileLink({ id: linkId, profileId });
		if (!deleted) {
			return NextResponse.json(
				{ ok: false, error: 'Link not found or does not belong to this profile' },
				{ status: 404 },
			);
		}
		if (profileId) touchProfilesForUserAction([profileId]);
		return NextResponse.json({ ok: true, deleted: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
