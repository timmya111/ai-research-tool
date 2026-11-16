import { NextResponse } from 'next/server';
import { listDocuments } from '@/lib/research/knowledge/documents';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { ingestNote } from '@/lib/research/knowledge/ingest';
import type { KnowledgeSourceType } from '@/lib/research/knowledge/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	try {
		const url = new URL(request.url);
		const projectId = String(url.searchParams.get('projectId') || '').trim();
		if (!projectId) {
			return NextResponse.json({ error: 'projectId required' }, { status: 400 });
		}
		const sourceType = (url.searchParams.get('sourceType') || 'any') as KnowledgeSourceType | 'any';
		const limit = Number(url.searchParams.get('limit') || 50);
		const offset = Number(url.searchParams.get('offset') || 0);
		const result = listDocuments({ projectId, sourceType, limit, offset });
		return NextResponse.json(
			{ ok: true, ...result },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /projectId required|project not found/i.test(message) ? 400 : 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	try {
		const projectId = String(body?.projectId || '').trim();
		const text = String(body?.text || '');
		const title = body?.title != null ? String(body.title) : undefined;
		const result = await ingestNote({ projectId, text, title });
		return NextResponse.json(
			{ ok: true, id: result.id, projectId: result.projectId },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			/projectId required|project not found|text required|exceeds/i.test(message) ? 400
			: /ollama embeddings/i.test(message) ? 503
			: 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
