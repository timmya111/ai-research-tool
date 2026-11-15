import { NextResponse } from 'next/server';

/** True for loopback hosts used by local Next + Ollama workflows. */
export function isLocalResearchHost(host: string | null | undefined): boolean {
	const raw = String(host || '')
		.trim()
		.toLowerCase()
		.replace(/:\d+$/, '');
	return raw === 'localhost' || raw === '127.0.0.1' || raw === '[::1]' || raw === '::1';
}

/**
 * Block research API routes outside loopback unless ALLOW_LOCAL_AI=1.
 * Keeps the Ollama agent off public deployments by default.
 */
export function rejectUnlessLocalResearch(request: Request): NextResponse | null {
	if (process.env.ALLOW_LOCAL_AI === '1') return null;
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
	if (isLocalResearchHost(host)) return null;
	return NextResponse.json(
		{ error: 'AI research tool is available on localhost only' },
		{ status: 403, headers: { 'Cache-Control': 'no-store' } },
	);
}
