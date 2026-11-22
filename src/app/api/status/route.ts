import { NextResponse } from 'next/server';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
import { knowledgeCounts } from '@/lib/research/knowledge/documents';
import { canExposeKnowledgeStatusDetail } from '@/lib/research/knowledge/guard';
import { DEFAULT_EMBED_MODEL, EXPECTED_EMBED_DIMS } from '@/lib/research/knowledge/types';
import { getKnowledgeDir } from '@/lib/research/knowledge/paths';
import { ensureDefaultProject } from '@/lib/research/knowledge/projects';
import { getSchemaMeta, needsReindex } from '@/lib/research/knowledge/schema';
import { getKnowledgeDb } from '@/lib/research/knowledge/db';
import { getProfileStats } from '@/lib/research/profiles/store';
import { DEFAULT_RESEARCH_MODEL, getOllamaBaseUrl, ollamaTags } from '@/lib/research/ollama';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function buildKnowledgeStatus(request: Request) {
	const embedModel = process.env.RESEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL;
	const tags = await ollamaTags();
	const embedModelInstalled = tags.models.some(
		(m) => m === embedModel || m.startsWith(`${embedModel}:`),
	);

	const detailOk = canExposeKnowledgeStatusDetail(request);
	if (!detailOk) {
		return {
			ok: true,
			restricted: true as const,
			embedModel,
			embedModelInstalled,
		};
	}

	try {
		const db = getKnowledgeDb();
		ensureDefaultProject(db);
		const counts = knowledgeCounts();
		const meta = getSchemaMeta(db);
		return {
			ok: true,
			restricted: false as const,
			path: getKnowledgeDir(),
			documentCount: counts.documentCount,
			chunkCount: counts.chunkCount,
			projectCount: counts.projectCount,
			embedModel,
			embedModelInstalled,
			embedDims: meta.embedDims || EXPECTED_EMBED_DIMS,
			needsReindex: needsReindex(db),
			error: null as string | null,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			restricted: false as const,
			path: getKnowledgeDir(),
			documentCount: 0,
			chunkCount: 0,
			projectCount: 0,
			embedModel,
			embedModelInstalled,
			embedDims: EXPECTED_EMBED_DIMS,
			needsReindex: false,
			error: message,
		};
	}
}

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	const baseUrl = getOllamaBaseUrl();
	const tags = await ollamaTags(baseUrl);
	const knowledge = await buildKnowledgeStatus(request);
	const detailOk = canExposeKnowledgeStatusDetail(request);
	let profiles: Record<string, unknown> = { ok: true, restricted: true };
	if (detailOk) {
		try {
			const s = getProfileStats();
			profiles = {
				ok: true,
				restricted: false,
				path: s.path,
				totalProfiles: s.totalProfiles,
				byType: s.byType,
				totalTimelineEntries: s.totalTimelineEntries,
				totalLinks: s.totalLinks,
				totalAlignments: s.totalAlignments,
			};
		} catch (error: unknown) {
			profiles = {
				ok: false,
				restricted: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	return NextResponse.json(
		{
			ok: tags.ok,
			baseUrl,
			defaultModel: DEFAULT_RESEARCH_MODEL,
			models: tags.models,
			error: tags.error || null,
			localOnly: true,
			knowledge,
			profiles,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}
