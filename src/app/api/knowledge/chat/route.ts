import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { ingestChatPair } from '@/lib/research/knowledge/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** Explicit per-turn save of a Q+A (+ toolTrace summary) into the knowledge store. */
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
	const question = String(body?.question || '').trim();
	const answer = String(body?.answer || '').trim();
	if (!projectId) {
		return NextResponse.json({ error: 'projectId required' }, { status: 400 });
	}
	if (!question) {
		return NextResponse.json({ error: 'question required' }, { status: 400 });
	}
	if (!answer) {
		return NextResponse.json({ error: 'answer required' }, { status: 400 });
	}

	try {
		const id = await ingestChatPair({
			projectId,
			question,
			answer,
			toolTrace: body?.toolTrace,
		});
		return NextResponse.json(
			{ ok: true, id, projectId },
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
