import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	addAlias,
	addLocation,
	deleteLocation,
	deleteProfile,
	getProfileDetail,
	updateLocation,
	updateProfileFields,
} from '@/lib/research/profiles/store';
import {
	LOCATION_ROLES,
	PROFILE_TYPES,
	type LocationRole,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';

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
		const metadataPatch =
			Array.isArray(body.categoryTags)
				? {
						categoryTags: body.categoryTags
							.map((t) => String(t) as ProfileType)
							.filter((t) => PROFILE_TYPES.includes(t) && t !== 'person'),
					}
				: undefined;

		const updated = updateProfileFields(key, {
			name: body.name != null ? String(body.name) : undefined,
			profileType: body.profileType != null ? (String(body.profileType) as ProfileType) : undefined,
			status: body.status != null ? (String(body.status) as ProfileStatus) : undefined,
			summary: body.summary != null ? String(body.summary) : undefined,
			startDate: body.startDate !== undefined ? (body.startDate ? String(body.startDate) : null) : undefined,
			endDate: body.endDate !== undefined ? (body.endDate ? String(body.endDate) : null) : undefined,
			metadata: metadataPatch,
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
				const roleRaw = loc.role ? String(loc.role) : 'associated';
				const role = (LOCATION_ROLES.includes(roleRaw as LocationRole)
					? roleRaw
					: 'associated') as LocationRole;
				addLocation({
					profileId: updated.id,
					raw: String(loc.raw),
					city: loc.city ? String(loc.city) : null,
					county: loc.county ? String(loc.county) : null,
					state: loc.state ? String(loc.state) : null,
					country: loc.country ? String(loc.country) : null,
					role,
					sourceCorpus: 'manual',
					confirmed: Boolean(loc.confirmed),
				});
			}
		}
		if (body.updateLocation && typeof body.updateLocation === 'object') {
			const loc = body.updateLocation as Record<string, unknown>;
			const locId = loc.id != null ? String(loc.id).trim() : '';
			if (!locId) {
				return NextResponse.json({ ok: false, error: 'updateLocation.id is required' }, { status: 400 });
			}
			const roleRaw = loc.role != null ? String(loc.role) : undefined;
			const role =
				roleRaw && LOCATION_ROLES.includes(roleRaw as LocationRole)
					? (roleRaw as LocationRole)
					: undefined;
			const ok = updateLocation({
				id: locId,
				profileId: updated.id,
				raw: loc.raw != null ? String(loc.raw) : undefined,
				city: loc.city !== undefined ? (loc.city ? String(loc.city) : null) : undefined,
				county: loc.county !== undefined ? (loc.county ? String(loc.county) : null) : undefined,
				state: loc.state !== undefined ? (loc.state ? String(loc.state) : null) : undefined,
				country: loc.country !== undefined ? (loc.country ? String(loc.country) : null) : undefined,
				role,
				confirmed: loc.confirmed !== undefined ? Boolean(loc.confirmed) : undefined,
			});
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Location not found or invalid' }, { status: 404 });
			}
		}
		if (body.deleteLocation != null) {
			const locId =
				typeof body.deleteLocation === 'object' && body.deleteLocation !== null
					? String((body.deleteLocation as Record<string, unknown>).id || '').trim()
					: String(body.deleteLocation).trim();
			if (!locId) {
				return NextResponse.json({ ok: false, error: 'deleteLocation id is required' }, { status: 400 });
			}
			const ok = deleteLocation({ id: locId, profileId: updated.id });
			if (!ok) {
				return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404 });
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
