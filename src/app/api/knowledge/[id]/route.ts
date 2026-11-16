import { NextResponse } from 'next/server';
import { deleteDocument, getDocument } from '@/lib/research/knowledge/documents';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const doc = getDocument(String(id || '').trim());
	if (!doc) {
		return NextResponse.json({ error: 'not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true, document: doc }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const ok = deleteDocument(String(id || '').trim());
	if (!ok) {
		return NextResponse.json({ error: 'not found' }, { status: 404 });
	}
	return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
