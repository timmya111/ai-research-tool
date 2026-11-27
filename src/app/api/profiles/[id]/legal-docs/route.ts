import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	ingestLegalDocsForProfile,
	loadLegalDocsForProfileWithCrossMatches,
	readCachedLegalDocFullText,
	type LegalDocSource,
} from '@/lib/research/legalDocsPipeline';
import { getProfile } from '@/lib/research/profiles/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const ALLOWED_SOURCES: LegalDocSource[] = ['cfpb', 'govinfo', 'oscn', 'courtlistener'];

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
	const docId = url.searchParams.get('docId')?.trim();
	if (docId) {
		const doc = readCachedLegalDocFullText(docId);
		if (!doc) {
			return NextResponse.json({ ok: false, error: 'Document not found' }, { status: 404 });
		}
		return NextResponse.json({ ok: true, doc }, { headers: { 'Cache-Control': 'no-store' } });
	}

	const manifest = loadLegalDocsForProfileWithCrossMatches(profile.slug || profile.id);
	return NextResponse.json(
		{
			ok: true,
			profileId: profile.id,
			profileSlug: profile.slug,
			cached: Boolean(manifest),
			report: manifest,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}

export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	const profile = getProfile(key);
	if (!profile) {
		return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
	}

	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const sources = Array.isArray(body.sources)
			? body.sources
					.map((s) => String(s).trim().toLowerCase() as LegalDocSource)
					.filter((s) => ALLOWED_SOURCES.includes(s))
			: undefined;
		const states = Array.isArray(body.states)
			? body.states.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
			: undefined;
		const oscnCounties = Array.isArray(body.oscnCounties)
			? body.oscnCounties.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
			: undefined;

		const report = await ingestLegalDocsForProfile(profile.id, {
			query: typeof body.query === 'string' && body.query.trim() ? body.query.trim() : undefined,
			sources,
			states,
			oscnCounties,
			maxDocsPerSource: body.maxDocsPerSource != null ? Number(body.maxDocsPerSource) : undefined,
			downloadPdfs: body.downloadPdfs !== false,
			syncToProfile: body.syncToProfile !== false,
		});

		return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
