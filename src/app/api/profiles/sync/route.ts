import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { runAlignmentPass } from '@/lib/research/profiles/align';
import { runProfilesBackfill } from '@/lib/research/profiles/backfill';
import { getProfileStats } from '@/lib/research/profiles/store';

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
			/* allow empty POST body */
		}
		const mode = String(body.mode || 'full'); // 'full' | 'align_only'
		const includeKnowledgeCrossMatch = body.includeKnowledgeCrossMatch !== false;

		if (mode === 'align_only') {
			const alignment = runAlignmentPass({ includeKnowledgeCrossMatch });
			const stats = getProfileStats();
			return NextResponse.json(
				{ ok: true, mode, alignment, stats },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		const report = runProfilesBackfill({
			runAlignment: true,
			includeKnowledgeCrossMatch,
		});
		const stats = getProfileStats();
		return NextResponse.json(
			{ ok: true, mode: 'full', report, stats },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
