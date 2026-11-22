import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	addAlias,
	addIdentifier,
	addLocation,
	addPersonEmployment,
	getProfileStats,
	listProfiles,
	upsertProfile,
} from '@/lib/research/profiles/store';
import {
	PROFILE_TYPES,
	type AliasKind,
	type IdentifierScheme,
	type LocationRole,
	type ProfileStatus,
	type ProfileType,
} from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const url = new URL(request.url);
	const q = url.searchParams.get('q') || undefined;
	const typeRaw = url.searchParams.get('type') || 'all';
	const tagRaw = url.searchParams.get('tag') || undefined;
	const statusRaw = url.searchParams.get('status') || undefined;
	const corpus = url.searchParams.get('corpus') || undefined;
	const geo = url.searchParams.get('geo') || undefined;
	const countryCodeRaw = url.searchParams.get('country') || url.searchParams.get('countryCode') || undefined;
	const countryCode = countryCodeRaw ? String(countryCodeRaw).trim().toLowerCase() : undefined;
	const limit = Number(url.searchParams.get('limit') || 50);
	const offset = Number(url.searchParams.get('offset') || 0);
	const includeStats = url.searchParams.get('stats') !== '0';

	const profileType =
		typeRaw === 'all' || typeRaw === 'actors' || typeRaw === 'narratives'
			? typeRaw
			: PROFILE_TYPES.includes(typeRaw as ProfileType)
				? (typeRaw as ProfileType)
				: 'all';
	const tag =
		tagRaw && PROFILE_TYPES.includes(tagRaw as ProfileType)
			? (tagRaw as ProfileType)
			: undefined;

	try {
		const { profiles, total } = listProfiles({
			query: q,
			profileType,
			tag,
			status: statusRaw as ProfileStatus | undefined,
			corpus,
			geo,
			countryCode,
			limit,
			offset,
		});
		const stats = includeStats ? getProfileStats() : undefined;
		return NextResponse.json(
			{ ok: true, profiles, total, stats },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const profileType = String(body.profileType || '').trim() as ProfileType;
		const name = String(body.name || '').trim();
		if (!name) {
			return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
		}
		if (!PROFILE_TYPES.includes(profileType)) {
			return NextResponse.json(
				{ ok: false, error: `profileType must be one of: ${PROFILE_TYPES.join(', ')}` },
				{ status: 400 },
			);
		}

		const metaInput: Record<string, unknown> =
			body.metadata && typeof body.metadata === 'object'
				? { ...(body.metadata as Record<string, unknown>) }
				: {};
		if (Array.isArray(body.categoryTags)) {
			metaInput.categoryTags = body.categoryTags
				.map((t) => String(t) as ProfileType)
				.filter((t) => PROFILE_TYPES.includes(t) && t !== 'person');
		}

		const profile = upsertProfile({
			profileType,
			name,
			slug: body.slug ? String(body.slug) : undefined,
			status: (body.status ? String(body.status) : 'pinned') as ProfileStatus,
			summary: body.summary ? String(body.summary) : '',
			startDate: body.startDate ? String(body.startDate) : null,
			endDate: body.endDate ? String(body.endDate) : null,
			metadata: Object.keys(metaInput).length ? metaInput : undefined,
			sourceCorpus: body.sourceCorpus ? String(body.sourceCorpus) : 'manual',
		});

		if (profileType === 'person' && Array.isArray(body.employmentHistory)) {
			for (const emp of body.employmentHistory as Array<Record<string, unknown>>) {
				if (!emp?.orgName) continue;
				addPersonEmployment({
					personIdOrSlug: profile.id,
					orgName: String(emp.orgName),
					orgCategory: emp.orgCategory ? (String(emp.orgCategory) as ProfileType) : undefined,
					role: emp.role ? String(emp.role) : null,
					startDate: emp.startDate ? String(emp.startDate) : null,
					endDate: emp.endDate ? String(emp.endDate) : null,
					isCurrent: typeof emp.isCurrent === 'boolean' ? emp.isCurrent : undefined,
					location: emp.location ? String(emp.location) : null,
					notes: emp.notes ? String(emp.notes) : null,
					sourceCorpus: 'manual',
				});
			}
		}

		if (Array.isArray(body.aliases)) {
			for (const a of body.aliases) {
				if (typeof a === 'string') {
					addAlias({ profileId: profile.id, alias: a, sourceCorpus: 'manual' });
				} else if (a && typeof a === 'object') {
					const obj = a as Record<string, unknown>;
					addAlias({
						profileId: profile.id,
						alias: String(obj.alias || ''),
						aliasKind: (obj.aliasKind ? String(obj.aliasKind) : 'name') as AliasKind,
						sourceCorpus: 'manual',
					});
				}
			}
		}

		if (Array.isArray(body.identifiers)) {
			for (const idItem of body.identifiers as Array<Record<string, unknown>>) {
				if (!idItem?.scheme || !idItem?.value) continue;
				addIdentifier({
					profileId: profile.id,
					scheme: String(idItem.scheme) as IdentifierScheme,
					value: String(idItem.value),
					sourceCorpus: 'manual',
				});
			}
		}

		if (Array.isArray(body.locations)) {
			for (const loc of body.locations as Array<Record<string, unknown>>) {
				const raw = String(loc?.raw || '').trim();
				if (!raw) continue;
				addLocation({
					profileId: profile.id,
					raw,
					city: loc.city ? String(loc.city) : null,
					county: loc.county ? String(loc.county) : null,
					state: loc.state ? String(loc.state) : null,
					country: loc.country ? String(loc.country) : null,
					role: (loc.role ? String(loc.role) : 'associated') as LocationRole,
					sourceCorpus: 'manual',
				});
			}
		}

		return NextResponse.json(
			{ ok: true, profile },
			{ status: 201, headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
