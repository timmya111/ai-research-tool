import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { ingestFetchFromToolTrace } from '@/lib/research/knowledge/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** Save successful fetch_url bodies from a toolTrace (toast confirm path). */
export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const projectId = String(body?.projectId || '').trim();
	if (!projectId) {
		return NextResponse.json({ error: 'projectId required' }, { status: 400 });
	}

	try {
		const ids = await ingestFetchFromToolTrace(body?.toolTrace, { projectId });
		return NextResponse.json(
			{ ok: true, projectId, saved: ids.length, ids },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			/project not found|required/i.test(message) ? 400
			: /ollama embeddings/i.test(message) ? 503
			: 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
