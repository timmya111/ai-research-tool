import { NextResponse } from 'next/server';
import {
	ingestPastedContent,
	ingestUploadedFile,
} from '@/lib/research/knowledge/attachments';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import { ingestNote } from '@/lib/research/knowledge/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const contentType = String(request.headers.get('content-type') || '');

	try {
		// JSON: note or paste
		if (contentType.includes('application/json')) {
			const body = (await request.json()) as Record<string, unknown>;
			const projectId = String(body.projectId || '').trim();
			const mode = String(body.mode || 'note').trim().toLowerCase();
			const text = String(body.text || '');
			const title = body.title != null ? String(body.title) : undefined;
			const url = body.url != null ? String(body.url) : null;

			if (mode === 'paste') {
				const result = await ingestPastedContent({ projectId, text, title, url });
				return NextResponse.json(
					{ ok: true, ...result },
					{ headers: { 'Cache-Control': 'no-store' } },
				);
			}

			const result = await ingestNote({
				projectId,
				text,
				title,
				url,
				sourceType: 'note',
				metadata: { kind: 'note', via: 'composer' },
			});
			return NextResponse.json(
				{
					ok: true,
					id: result.id,
					projectId: result.projectId,
					title: result.title,
					sourceType: 'note',
					skipped: result.skipped,
				},
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		// Multipart: files / screenshots
		if (contentType.includes('multipart/form-data')) {
			const form = await request.formData();
			const projectId = String(form.get('projectId') || '').trim();
			const titleRaw = form.get('title');
			const title = titleRaw != null ? String(titleRaw) : undefined;
			const files = form.getAll('files').filter((v): v is File => typeof File !== 'undefined' && v instanceof File);
			if (!files.length) {
				const single = form.get('file');
				if (typeof File !== 'undefined' && single instanceof File) files.push(single);
			}
			if (!projectId) {
				return NextResponse.json({ ok: false, error: 'projectId required' }, { status: 400 });
			}
			if (!files.length) {
				return NextResponse.json({ ok: false, error: 'file required' }, { status: 400 });
			}

			const results = [];
			for (const file of files.slice(0, 8)) {
				const buf = Buffer.from(await file.arrayBuffer());
				if (buf.length > MAX_UPLOAD_BYTES) {
					results.push({
						ok: false,
						fileName: file.name,
						error: `file exceeds ${MAX_UPLOAD_BYTES} bytes`,
					});
					continue;
				}
				try {
					const saved = await ingestUploadedFile({
						projectId,
						fileName: file.name || 'upload',
						mimeType: file.type || undefined,
						bytes: buf,
						title: files.length === 1 ? title : undefined,
					});
					results.push({ ok: true, fileName: file.name, ...saved });
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					results.push({ ok: false, fileName: file.name, error: message });
				}
			}

			const ok = results.some((r) => r.ok);
			return NextResponse.json(
				{ ok, results },
				{ status: ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } },
			);
		}

		return NextResponse.json(
			{ ok: false, error: 'expected application/json or multipart/form-data' },
			{ status: 415 },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			/projectId required|project not found|text required|exceeds|Unsupported file/i.test(message)
				? 400
				: /ollama|OCR|vision/i.test(message)
					? 503
					: 500;
		return NextResponse.json({ ok: false, error: message }, { status });
	}
}
