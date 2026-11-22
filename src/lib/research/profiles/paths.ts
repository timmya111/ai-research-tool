import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the local profiles SQLite directory.
 * Defaults to `<cwd>/.data/profiles` (gitignored under `.data/`).
 */
export function getProfilesDir(): string {
	const env = String(process.env.RESEARCH_PROFILES_DIR || '').trim();
	const dir = env ? path.resolve(env) : path.resolve(process.cwd(), '.data', 'profiles');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function getProfilesDbPath(): string {
	return path.join(getProfilesDir(), 'profiles.sqlite');
}

export function getDataRootDir(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..');
	return path.resolve(process.cwd(), '.data');
}

export function getKnowledgeSqlitePath(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.join(path.resolve(env), 'knowledge.sqlite');
	return path.resolve(process.cwd(), '.data', 'knowledge', 'knowledge.sqlite');
}
