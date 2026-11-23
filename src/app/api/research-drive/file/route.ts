import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROOT = path.resolve(process.cwd(), '.data/research-drive');

const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
};

/**
 * Serve a file from `.data/research-drive` only (path-traversal safe).
 * GET /api/research-drive/file?path=Personal/IMG_1530.jpg
 */
export async function GET(request: Request) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const url = new URL(request.url);
	const rel = String(url.searchParams.get('path') || '').trim();
	if (!rel) {
		return NextResponse.json({ ok: false, error: 'path required' }, { status: 400 });
	}
	if (rel.includes('\0') || path.isAbsolute(rel)) {
		return NextResponse.json({ ok: false, error: 'invalid path' }, { status: 400 });
	}

	const resolved = path.resolve(ROOT, rel);
	if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
		return NextResponse.json({ ok: false, error: 'path outside research-drive' }, { status: 400 });
	}
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
	}

	const ext = path.extname(resolved).toLowerCase();
	const type = MIME[ext] || 'application/octet-stream';
	const buf = fs.readFileSync(resolved);
	return new NextResponse(buf, {
		status: 200,
		headers: {
			'Content-Type': type,
			'Content-Length': String(buf.length),
			'Cache-Control': 'private, no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
