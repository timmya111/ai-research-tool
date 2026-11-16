import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { retrieve } from '@/lib/research/knowledge/retrieve';
import type { KnowledgeSourceType } from '@/lib/research/knowledge/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

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
	const query = String(body?.query || '').trim();
	if (!projectId) {
		return NextResponse.json({ error: 'projectId required' }, { status: 400 });
	}
	if (!query) {
		return NextResponse.json({ error: 'query required' }, { status: 400 });
	}

	const started = Date.now();
	try {
		const hits = await retrieve(query, {
			projectId,
			limit: body?.limit as number | undefined,
			sourceType: (body?.sourceType as KnowledgeSourceType | 'any' | undefined) || 'any',
		});
		const payload: Record<string, unknown> = {
			ok: true,
			query,
			projectId,
			returned: hits.length,
			hits,
		};
		if (process.env.NODE_ENV === 'development') {
			payload.retrieveMs = Date.now() - started;
		}
		return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			/projectId required|project not found|needs reindex/i.test(message) ? 400
			: /ollama embeddings/i.test(message) ? 503
			: 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
