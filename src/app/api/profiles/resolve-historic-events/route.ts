import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	resolveAnyProfileLinks,
	resolveHistoricEventLinks,
} from '@/lib/research/profiles/timeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Resolve free-text titles / URLs to profiles for in-app Overview & Timeline links.
 * POST { titles?: string[], urls?: string[], excludeProfileId?: string, allTypes?: boolean }
 */
export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const body = (await request.json()) as Record<string, unknown>;
		const titles = Array.isArray(body.titles)
			? body.titles.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 100)
			: [];
		const urls = Array.isArray(body.urls)
			? body.urls.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 40)
			: [];
		const excludeProfileId = body.excludeProfileId ? String(body.excludeProfileId) : null;
		const allTypes = body.allTypes === true;
		const resolved = allTypes
			? resolveAnyProfileLinks(titles, { excludeProfileId })
			: resolveHistoricEventLinks(titles, { excludeProfileId, urls });
		const links: Record<string, { id: string; slug: string; name: string }> = {};
		for (const row of resolved) {
			if (!row.hit) continue;
			links[row.query] = row.hit;
		}
		return NextResponse.json(
			{ ok: true, links, resolved },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
