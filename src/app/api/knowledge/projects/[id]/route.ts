import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { deleteProject, renameProject } from '@/lib/research/knowledge/projects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	try {
		const project = renameProject(String(id || '').trim(), String(body?.name || ''));
		return NextResponse.json(
			{ ok: true, project },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /not found/i.test(message) ? 404 : /required|already exists/i.test(message) ? 400 : 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}

export async function DELETE(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	try {
		deleteProject(String(id || '').trim());
		return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			/last project/i.test(message) ? 400
			: /not found/i.test(message) ? 404
			: 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
