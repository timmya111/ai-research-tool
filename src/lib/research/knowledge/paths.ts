import fs from 'fs';
import path from 'path';

const DEFAULT_RELATIVE = path.join('.data', 'knowledge');

/** Absolute knowledge data directory. Env absolute path is the trust root. */
export function getKnowledgeDir(): string {
	const raw = String(process.env.RESEARCH_DATA_DIR || '').trim();
	const resolved = path.resolve(raw || path.join(process.cwd(), DEFAULT_RELATIVE));
	return resolved;
}

export function getKnowledgeSqlitePath(): string {
	return path.join(getKnowledgeDir(), 'knowledge.sqlite');
}

/** Ensure the data directory exists (mode 0o700 when possible). */
export function ensureKnowledgeDir(): string {
	const dir = getKnowledgeDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* ignore on platforms that ignore mode */
	}
	return dir;
}
