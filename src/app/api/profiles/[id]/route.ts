import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	addAlias,
	addLocation,
	deleteProfile,
	getProfileDetail,
	updateProfileFields,
} from '@/lib/research/profiles/store';
import type { LocationRole, ProfileStatus, ProfileType } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const detail = getProfileDetail(decodeURIComponent(String(id || '').trim()));
	if (!detail) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true, ...detail }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const updated = updateProfileFields(key, {
			name: body.name != null ? String(body.name) : undefined,
			profileType: body.profileType != null ? (String(body.profileType) as ProfileType) : undefined,
			status: body.status != null ? (String(body.status) as ProfileStatus) : undefined,
			summary: body.summary != null ? String(body.summary) : undefined,
			startDate: body.startDate !== undefined ? (body.startDate ? String(body.startDate) : null) : undefined,
			endDate: body.endDate !== undefined ? (body.endDate ? String(body.endDate) : null) : undefined,
		});
		if (!updated) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}

		if (typeof body.addAlias === 'string' && body.addAlias.trim()) {
			addAlias({ profileId: updated.id, alias: body.addAlias.trim(), sourceCorpus: 'manual' });
		}
		if (body.addLocation && typeof body.addLocation === 'object') {
			const loc = body.addLocation as Record<string, unknown>;
			if (loc.raw) {
				addLocation({
					profileId: updated.id,
					raw: String(loc.raw),
					city: loc.city ? String(loc.city) : null,
					county: loc.county ? String(loc.county) : null,
					state: loc.state ? String(loc.state) : null,
					country: loc.country ? String(loc.country) : null,
					role: (loc.role ? String(loc.role) : 'associated') as LocationRole,
					sourceCorpus: 'manual',
				});
			}
		}

		const detail = getProfileDetail(updated.id);
		return NextResponse.json({ ok: true, ...detail }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function DELETE(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const ok = deleteProfile(decodeURIComponent(String(id || '').trim()));
	if (!ok) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
