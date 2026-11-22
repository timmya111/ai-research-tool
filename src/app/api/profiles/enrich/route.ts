import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { enrichBatchProfiles } from '@/lib/research/profiles/enrich';
import { PROFILE_TYPES, type ProfileType } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		let body: Record<string, unknown> = {};
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			/* optional body */
		}

		const rawType = String(body.profileType || 'all').trim().toLowerCase();
		const profileType: ProfileType | 'all' =
			rawType === 'all'
				? 'all'
				: PROFILE_TYPES.includes(rawType as ProfileType)
					? (rawType as ProfileType)
					: 'all';

		const report = await enrichBatchProfiles({
			limit: body.limit != null ? Number(body.limit) : 25,
			profileType,
			pinnedOnly: body.pinnedOnly === true,
			onlyMissingSummaryOrDetails: body.onlyMissingSummaryOrDetails === true,
			includeWikipedia: body.includeWikipedia !== false,
			includeBrokercheck: body.includeBrokercheck === true,
			includeKnowledge: body.includeKnowledge !== false,
			includeBryanUcc: body.includeBryanUcc !== false,
		});

		return NextResponse.json(
			{ ok: true, report },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
