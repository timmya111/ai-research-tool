import { NextResponse } from 'next/server';
import {
	ingestFirmDetailsFromVisualizer,
	ingestIndividualFromVisualizer,
	readFinraSyncState,
	readRecentFinraChanges,
	runDailyFinraChangeCheck,
} from '@/lib/research/finraVisualizerMirror';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function normalizeCrd(raw: unknown): string {
	return String(raw || '')
		.trim()
		.replace(/^CRD[#:\s]*/i, '')
		.replace(/[^\d]/g, '');
}

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

		const force = body.force === true;
		const firmCrd = normalizeCrd(body.firmCrd);
		const individualCrd = normalizeCrd(body.individualCrd);

		// Firm CRD sync (dashboard/firm/{crd}) — keep separate from individual person CRDs.
		if (firmCrd) {
			if (individualCrd && individualCrd === firmCrd) {
				return NextResponse.json(
					{
						ok: false,
						error:
							'Same value passed as both firmCrd and individualCrd. Firm CRDs and Individual CRDs are distinct — pick one (e.g. firmCrd=288811 for Florida Financial Advisors).',
					},
					{ status: 400 },
				);
			}
			const res = await ingestFirmDetailsFromVisualizer(firmCrd, { forceRefresh: force });
			return NextResponse.json(
				{ ok: true, crdKind: 'firm', firm: res },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		if (individualCrd) {
			const res = await ingestIndividualFromVisualizer(individualCrd, {
				forceRefresh: force,
			});
			// If the visualizer has no individual for this CRD, say so clearly (may be a Firm CRD).
			if (!res.found) {
				return NextResponse.json(
					{
						ok: true,
						crdKind: 'individual',
						individual: res,
						hint:
							'No individual hit for this CRD. If this is a Firm CRD (e.g. dashboard/firm/288811), POST with firmCrd instead of individualCrd.',
					},
					{ headers: { 'Cache-Control': 'no-store' } },
				);
			}
			return NextResponse.json(
				{ ok: true, crdKind: 'individual', individual: res },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		const report = await runDailyFinraChangeCheck({
			force,
			maxIndividuals: typeof body.maxIndividuals === 'number' ? body.maxIndividuals : 500,
			maxFirms: typeof body.maxFirms === 'number' ? body.maxFirms : 250,
		});
		return NextResponse.json({ ok: true, report }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
