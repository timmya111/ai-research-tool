import { NextResponse } from 'next/server';
import { createBryanFilingChart, createLogo } from '@/lib/research/charts';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
import { ensureDefaultProject, listProjects } from '@/lib/research/knowledge/projects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

function resolveProjectId(explicit?: string | null): string {
	const raw = String(explicit || '').trim();
	const projects = listProjects();
	if (raw) {
		const byId = projects.find((p) => p.id === raw);
		if (byId) return byId.id;
		const byName = projects.find((p) => p.name.toLowerCase() === raw.toLowerCase());
		if (byName) return byName.id;
		const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
		const byCompact = projects.find((p) => p.name.toLowerCase().replace(/[\s_-]+/g, '') === compact);
		if (byCompact) return byCompact.id;
	}
	const bryan = projects.find((p) => p.name.toLowerCase() === 'bryan county');
	if (bryan) return bryan.id;
	return ensureDefaultProject().id;
}

/** Create a Bryan filings chart (localhost). Body: { kind?, period?, from?, to?, docType?, format?, projectId? }. */
export async function POST(request: Request) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}

	try {
		const kind = String(body.type || body.mode || '').trim().toLowerCase();
		if (kind === 'logo') {
			const logo = await createLogo({
				text: String(body.text || ''),
				subtitle: body.subtitle != null ? String(body.subtitle) : null,
				format: body.format as string | undefined,
			});
			return NextResponse.json(logo, { headers: { 'Cache-Control': 'no-store' } });
		}

		const projectId = resolveProjectId(body.projectId != null ? String(body.projectId) : null);
		const chart = await createBryanFilingChart({
			projectId,
			period: body.period as string | undefined,
			kind: body.kind as string | undefined,
			from: body.from != null ? String(body.from) : null,
			to: body.to != null ? String(body.to) : null,
			docType: body.docType != null ? String(body.docType) : null,
			format: body.format as string | undefined,
		});
		return NextResponse.json(chart, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
