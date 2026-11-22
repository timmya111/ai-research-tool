import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { addPersonEmployment, getProfileDetail } from '@/lib/research/profiles/store';
import type { ProfileType } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const orgName = String(body.orgName || '').trim();
		if (!orgName) {
			return NextResponse.json({ ok: false, error: 'orgName is required' }, { status: 400 });
		}

		const created = addPersonEmployment({
			personIdOrSlug: key,
			orgName,
			orgCategory: body.orgCategory ? (String(body.orgCategory) as ProfileType) : 'firm',
			role: body.role ? String(body.role) : null,
			startDate: body.startDate ? String(body.startDate) : null,
			endDate: body.endDate ? String(body.endDate) : null,
			isCurrent: typeof body.isCurrent === 'boolean' ? body.isCurrent : undefined,
			location: body.location ? String(body.location) : null,
			notes: body.notes ? String(body.notes) : null,
			sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
		});

		if (!created) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}

		const detail = getProfileDetail(key);
		return NextResponse.json(
			{ ok: true, linkId: created.linkId, orgProfile: created.orgProfile, detail },
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
