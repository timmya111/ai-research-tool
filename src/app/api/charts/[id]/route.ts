import fs from 'fs';
import { NextResponse } from 'next/server';
import { chartMimeType, resolveChartFile, sanitizeChartId } from '@/lib/research/charts/paths';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	const { id: rawId } = await context.params;
	let id: string;
	try {
		id = sanitizeChartId(String(rawId || '').trim());
	} catch {
		return NextResponse.json({ error: 'invalid chart id' }, { status: 400 });
	}

	const resolved = resolveChartFile(id);
	if (!resolved) {
		return NextResponse.json({ error: 'chart not found' }, { status: 404 });
	}

	const body = fs.readFileSync(resolved.path);
	const contentType = chartMimeType(resolved.format);
	return new NextResponse(body, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'private, max-age=3600',
			'Content-Disposition': `inline; filename="${id}.${resolved.format === 'jpeg' ? 'jpg' : resolved.format}"`,
		},
	});
}
