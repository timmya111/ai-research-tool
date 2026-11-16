import { NextResponse } from 'next/server';
import { isLocalResearchHost } from '@/lib/research/guard';

/**
 * Stricter than chat: loopback always OK; off-loopback only with BOTH
 * RESEARCH_KNOWLEDGE_REMOTE=1 and ALLOW_LOCAL_AI=1.
 */
export function rejectUnlessLocalKnowledge(request: Request): NextResponse | null {
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
	if (isLocalResearchHost(host)) return null;

	if (process.env.RESEARCH_KNOWLEDGE_REMOTE === '1' && process.env.ALLOW_LOCAL_AI === '1') {
		return null;
	}

	return NextResponse.json(
		{
			error:
				'Knowledge store is localhost-only. Set RESEARCH_KNOWLEDGE_REMOTE=1 and ALLOW_LOCAL_AI=1 to override (dangerous).',
		},
		{ status: 403, headers: { 'Cache-Control': 'no-store' } },
	);
}

/** True when status may include knowledge.path / counts. */
export function canExposeKnowledgeStatusDetail(request: Request): boolean {
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
	if (isLocalResearchHost(host)) return true;
	return process.env.RESEARCH_KNOWLEDGE_REMOTE === '1' && process.env.ALLOW_LOCAL_AI === '1';
}
