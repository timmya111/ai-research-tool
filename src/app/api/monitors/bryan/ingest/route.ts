import { NextResponse } from 'next/server';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';
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

function ensureBryanProjectId(explicit?: string | null): string {
	if (explicit && String(explicit).trim()) return String(explicit).trim();
	ensureDefaultProject();
	const existing = listProjects().find((p) => p.name.toLowerCase() === BRYAN_PROJECT_NAME.toLowerCase());
	if (existing) return existing.id;
	return createProject(BRYAN_PROJECT_NAME).id;
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

	const filings = Array.isArray(body?.filings) ? (body.filings as BryanFilingDetail[]) : [];
	if (!filings.length) {
		return NextResponse.json({ error: 'filings array required' }, { status: 400 });
	}

	try {
		const projectId = ensureBryanProjectId(body?.projectId != null ? String(body.projectId) : null);
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
						kind: 'bryan-filing',
						recordId: filing.id,
						docType: filing.docType,
						instrument: filing.instrument,
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
