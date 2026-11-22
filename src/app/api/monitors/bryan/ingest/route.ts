import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { ingestNote } from '@/lib/research/knowledge/ingest';
import { createProject, ensureDefaultProject, listProjects } from '@/lib/research/knowledge/projects';
import {
	BRYAN_PROJECT_NAME,
	formatBryanFilingNote,
	type BryanFilingDetail,
} from '@/lib/monitors/bryanRealtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function resolveProjectId(opts: { projectId?: string | null; projectName?: string | null }): string {
	if (opts.projectId && String(opts.projectId).trim()) return String(opts.projectId).trim();
	ensureDefaultProject();
	const wanted = (opts.projectName && String(opts.projectName).trim()) || BRYAN_PROJECT_NAME;
	const existing = listProjects().find((p) => p.name.toLowerCase() === wanted.toLowerCase());
	if (existing) return existing.id;
	return createProject(wanted).id;
}

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	let body: Record<string, unknown> | null = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const filings = Array.isArray(body?.filings) ? (body.filings as BryanFilingDetail[]) : [];
	if (!filings.length) {
		return NextResponse.json({ error: 'filings array required' }, { status: 400 });
	}

	try {
		const projectId = resolveProjectId({
			projectId: body?.projectId != null ? String(body.projectId) : null,
			projectName: body?.projectName != null ? String(body.projectName) : null,
		});
		const saved: string[] = [];
		const skipped: string[] = [];
		const errors: Array<{ id?: string; error: string }> = [];

		for (const filing of filings) {
			if (!filing || typeof filing !== 'object' || !filing.href) {
				errors.push({ error: 'invalid filing' });
				continue;
			}
			try {
				const note = formatBryanFilingNote(filing);
				const result = await ingestNote({
					projectId,
					title: note.title,
					text: note.text,
					url: note.url,
					metadata: {
						kind: 'okcr-filing',
						site: filing.site || null,
						recordId: filing.id,
						docType: filing.docType,
						instrument: filing.instrument,
						county: filing.county || null,
					},
				});
				if (result.skipped) skipped.push(String(filing.id || note.url));
				else saved.push(result.id);
			} catch (error: unknown) {
				errors.push({
					id: filing.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return NextResponse.json(
			{
				ok: true,
				projectId,
				saved: saved.length,
				skipped: skipped.length,
				errors,
				ids: saved,
			},
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
