import fs from 'fs';
import path from 'path';

const DEFAULT_RELATIVE = path.join('.data', 'charts');

export type ChartImageFormat = 'png' | 'jpeg' | 'svg';

const FORMAT_EXT: Record<ChartImageFormat, string> = {
	png: 'png',
	jpeg: 'jpg',
	svg: 'svg',
};

const MIME: Record<ChartImageFormat, string> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	svg: 'image/svg+xml; charset=utf-8',
};

/** Absolute chart output directory (sibling of knowledge under .data when using defaults). */
export function getChartsDir(): string {
	const raw = String(process.env.RESEARCH_CHARTS_DIR || '').trim();
	if (raw) return path.resolve(raw);
	const dataRoot = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (dataRoot) {
		// RESEARCH_DATA_DIR points at .../knowledge; charts live next to it under .data/
		const parent = path.dirname(path.resolve(dataRoot));
		return path.join(parent, 'charts');
	}
	return path.resolve(process.cwd(), DEFAULT_RELATIVE);
}

export function ensureChartsDir(): string {
	const dir = getChartsDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* ignore */
	}
	return dir;
}

export function normalizeChartFormat(raw: unknown, fallback: ChartImageFormat = 'png'): ChartImageFormat {
	const s = String(raw || '')
		.trim()
		.toLowerCase();
	if (s === 'svg' || s === 'vector' || s === 'logo') return 'svg';
	if (s === 'jpg' || s === 'jpeg') return 'jpeg';
	if (s === 'png') return 'png';
	return fallback;
}

export function chartExt(format: ChartImageFormat): string {
	return FORMAT_EXT[format];
}

export function chartMimeType(format: ChartImageFormat): string {
	return MIME[format];
}

export function sanitizeChartId(chartId: string): string {
	const safe = String(chartId || '')
		.replace(/\.(png|jpe?g|svg)$/i, '')
		.replace(/[^a-zA-Z0-9_-]/g, '');
	if (!safe || safe.length < 8) throw new Error('invalid chart id');
	return safe;
}

export function chartFilePath(chartId: string, format: ChartImageFormat = 'png'): string {
	const safe = sanitizeChartId(chartId);
	return path.join(getChartsDir(), `${safe}.${chartExt(format)}`);
}

/** Resolve an existing chart file by id (tries png, jpg, svg). */
export function resolveChartFile(chartId: string): { path: string; format: ChartImageFormat } | null {
	const safe = sanitizeChartId(chartId);
	const dir = getChartsDir();
	const candidates: ChartImageFormat[] = ['png', 'jpeg', 'svg'];
	for (const format of candidates) {
		const filePath = path.join(dir, `${safe}.${chartExt(format)}`);
		if (fs.existsSync(filePath)) return { path: filePath, format };
	}
	return null;
}
