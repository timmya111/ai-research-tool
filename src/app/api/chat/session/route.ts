import { NextResponse } from 'next/server';
import {
	readCurrentChatSession,
	startNewChatSession,
	writeCurrentChatSession,
	type PersistedChatTurn,
} from '@/lib/research/chatSession';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	try {
		const session = readCurrentChatSession();
		return NextResponse.json(
			{ ok: true, session },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

export async function PUT(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	try {
		const turns = Array.isArray(body?.turns) ? (body.turns as PersistedChatTurn[]) : [];
		const session = writeCurrentChatSession({
			turns,
			id: body?.id != null ? String(body.id) : undefined,
			createdAt: body?.createdAt != null ? String(body.createdAt) : undefined,
		});
		return NextResponse.json(
			{ ok: true, session },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}

/** Start a new session: archive the current one (if non-empty) and return a fresh empty session. */
export async function DELETE(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	try {
		const { previous, session } = startNewChatSession();
		return NextResponse.json(
			{
				ok: true,
				session,
				archived: previous
					? { id: previous.id, turnCount: previous.turns.length, createdAt: previous.createdAt }
					: null,
			},
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
