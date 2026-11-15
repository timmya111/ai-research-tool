import { NextResponse } from 'next/server';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
import { DEFAULT_RESEARCH_MODEL, getOllamaBaseUrl, ollamaTags } from '@/lib/research/ollama';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	const baseUrl = getOllamaBaseUrl();
	const tags = await ollamaTags(baseUrl);
	return NextResponse.json(
		{
			ok: tags.ok,
			baseUrl,
			defaultModel: DEFAULT_RESEARCH_MODEL,
			models: tags.models,
			error: tags.error || null,
			localOnly: true,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}
