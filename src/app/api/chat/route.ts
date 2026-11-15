import { NextResponse } from 'next/server';
import { runResearchAgent } from '@/lib/research/agent';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
import { RESEARCH_AUTO_MODEL } from '@/lib/research/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const question = String(body?.question || body?.message || '').trim();
	if (!question) {
		return NextResponse.json({ error: 'question required' }, { status: 400 });
	}

	const model = String(body?.model || RESEARCH_AUTO_MODEL).trim() || RESEARCH_AUTO_MODEL;
	const history = Array.isArray(body?.history) ? body.history : [];
	const availableModels = Array.isArray(body?.availableModels)
		? body.availableModels.map((m: unknown) => String(m || '').trim()).filter(Boolean)
		: undefined;

	const result = await runResearchAgent({
		question,
		model,
		history,
		availableModels,
	});
	return NextResponse.json(result, {
		status: result.ok ? 200 : 500,
		headers: { 'Cache-Control': 'no-store' },
	});
}
