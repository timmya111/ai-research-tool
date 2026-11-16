import { after, NextResponse } from 'next/server';
import { runResearchAgent } from '@/lib/research/agent';
import { isCanvasSnapshot, type CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
import { ingestChatPair, ingestFetchFromToolTrace } from '@/lib/research/knowledge/ingest';
import { ensureDefaultProject } from '@/lib/research/knowledge/projects';
import { RESEARCH_AUTO_MODEL } from '@/lib/research/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function truthyFlag(value: unknown): boolean {
	if (value === true || value === 1) return true;
	const s = String(value ?? '')
		.trim()
		.toLowerCase();
	return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

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
	const aboutNodeGraph = Boolean(body?.aboutNodeGraph);
	const canvasSnapshot: CanvasSnapshot | null =
		aboutNodeGraph && isCanvasSnapshot(body?.canvasSnapshot) ? body.canvasSnapshot : null;

	let projectId = body?.projectId != null ? String(body.projectId).trim() : '';
	if (!projectId) {
		try {
			projectId = ensureDefaultProject().id;
		} catch {
			projectId = '';
		}
	}

	const persistChat = truthyFlag(body?.persistChat);
	const persistFetches = truthyFlag(body?.persistFetches);
	const ragAuto =
		body?.ragAuto === undefined ? undefined : truthyFlag(body.ragAuto);

	const result = await runResearchAgent({
		question,
		model,
		history,
		availableModels,
		aboutNodeGraph,
		canvasSnapshot,
		projectId: projectId || null,
		ragAuto,
	});

	const persistScheduled = Boolean(result.ok && projectId && (persistChat || persistFetches));
	if (persistScheduled) {
		const trace = result.toolTrace;
		const answer = result.answer;
		const pid = projectId;
		after(async () => {
			try {
				if (persistChat) {
					await ingestChatPair({
						projectId: pid,
						question,
						answer,
						toolTrace: trace,
					});
				}
				if (persistFetches) {
					await ingestFetchFromToolTrace(trace, { projectId: pid });
				}
			} catch (error: unknown) {
				console.error('[knowledge] deferred ingest failed', error);
			}
		});
	}

	return NextResponse.json(
		{
			...result,
			knowledge: {
				...(result.knowledge && typeof result.knowledge === 'object' ? result.knowledge : {}),
				retrieved: result.knowledge?.retrieved ?? 0,
				projectId: projectId || result.knowledge?.projectId || null,
				persistScheduled,
				persistChat: persistScheduled ? persistChat : false,
				persistFetches: persistScheduled ? persistFetches : false,
			},
		},
		{
			status: result.ok ? 200 : 500,
			headers: { 'Cache-Control': 'no-store' },
		},
	);
}
