import fs from 'fs';
import path from 'path';

const DEFAULT_RELATIVE = path.join('.data', 'charts');

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

export function chartFilePath(chartId: string): string {
	const safe = String(chartId || '').replace(/[^a-zA-Z0-9_-]/g, '');
	if (!safe) throw new Error('invalid chart id');
	return path.join(getChartsDir(), `${safe}.svg`);
}
