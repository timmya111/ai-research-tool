import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { enrichProfile } from '@/lib/research/profiles/enrich';
import { getProfileDetail } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	if (!key) {
		return NextResponse.json({ ok: false, error: 'Profile id or slug is required' }, { status: 400 });
	}

	try {
		let body: Record<string, unknown> = {};
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			/* optional body */
		}

		const report = await enrichProfile(key, {
			includeWikipedia: body.includeWikipedia !== false,
			includeBrokercheck: body.includeBrokercheck !== false,
			includeKnowledge: body.includeKnowledge !== false,
			includeBryanUcc: body.includeBryanUcc !== false,
		});
		if (!report) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}

		const detail = getProfileDetail(report.profileId);
		return NextResponse.json(
			{ ok: true, report, detail },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
