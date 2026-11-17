import fs from 'fs';
import { NextResponse } from 'next/server';
import { chartFilePath } from '@/lib/research/charts/paths';
import { rejectUnlessLocalResearch } from '@/lib/research/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalResearch(request);
	if (blocked) return blocked;

	const { id: rawId } = await context.params;
	const id = String(rawId || '')
		.trim()
		.replace(/\.svg$/i, '');
	if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
		return NextResponse.json({ error: 'invalid chart id' }, { status: 400 });
	}

	let filePath: string;
	try {
		filePath = chartFilePath(id);
	} catch {
		return NextResponse.json({ error: 'invalid chart id' }, { status: 400 });
	}

	if (!fs.existsSync(filePath)) {
		return NextResponse.json({ error: 'chart not found' }, { status: 404 });
	}

	const svg = fs.readFileSync(filePath, 'utf8');
	return new NextResponse(svg, {
		status: 200,
		headers: {
			'Content-Type': 'image/svg+xml; charset=utf-8',
			'Cache-Control': 'private, max-age=3600',
		},
	});
}
