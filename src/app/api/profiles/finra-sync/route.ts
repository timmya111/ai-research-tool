import { NextResponse } from 'next/server';
import {
	ingestIndividualFromVisualizer,
	readFinraSyncState,
	readRecentFinraChanges,
	runDailyFinraChangeCheck,
} from '@/lib/research/finraVisualizerMirror';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const state = readFinraSyncState();
	const recentChanges = readRecentFinraChanges(30);
	return NextResponse.json(
		{
			ok: true,
			mode: 'read-only-local-mirror',
			ttlHours: 24,
			lastDailyRunAt: state.lastDailyRunAt,
			trackedIndividuals: Object.keys(state.individuals).length,
			trackedFirms: Object.keys(state.firms).length,
			recentChanges,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		let body: Record<string, unknown> = {};
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			/* optional */
		}

		if (body.individualCrd) {
			const res = await ingestIndividualFromVisualizer(String(body.individualCrd), {
				forceRefresh: body.force === true,
			});
			return NextResponse.json({ ok: true, individual: res }, { headers: { 'Cache-Control': 'no-store' } });
		}

		const report = await runDailyFinraChangeCheck({
			force: body.force === true,
			maxIndividuals: typeof body.maxIndividuals === 'number' ? body.maxIndividuals : 500,
			maxFirms: typeof body.maxFirms === 'number' ? body.maxFirms : 250,
		});
		return NextResponse.json({ ok: true, report }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
