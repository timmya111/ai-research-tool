import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	findNearbyProfilesForProfile,
	type NearbyMode,
} from '@/lib/research/profiles/nearby';
import { getProfile } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	const profile = getProfile(key);
	if (!profile) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}

	const url = new URL(request.url);
	const modeRaw = (url.searchParams.get('mode') || 'nearby').trim();
	const mode: NearbyMode = modeRaw === 'same_building' ? 'same_building' : 'nearby';
	const limit = Number(url.searchParams.get('limit') || 40);

	try {
		const result = findNearbyProfilesForProfile(profile.id, { mode, limit });
		return NextResponse.json(
			{ ok: true, ...result },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
