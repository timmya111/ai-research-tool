import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { reindexKnowledge } from '@/lib/research/knowledge/reindex';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}

	const projectId = body?.projectId != null ? String(body.projectId).trim() : null;

	try {
		const result = await reindexKnowledge({ projectId: projectId || null });
		return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /ollama embeddings/i.test(message) ? 503 : 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
