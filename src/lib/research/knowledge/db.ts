import { DatabaseSync } from 'node:sqlite';
import { ensureKnowledgeDir, getKnowledgeSqlitePath } from '@/lib/research/knowledge/paths';
import { migrate } from '@/lib/research/knowledge/schema';

type GlobalWithDb = typeof globalThis & {
	__researchKnowledgeDb?: DatabaseSync;
};

/**
 * Process-global DatabaseSync singleton (HMR-safe via globalThis).
 * Single-process writers only. Embeds must happen outside write transactions.
 */
export function getKnowledgeDb(): DatabaseSync {
	const g = globalThis as GlobalWithDb;
	if (g.__researchKnowledgeDb) return g.__researchKnowledgeDb;

	ensureKnowledgeDir();
	const file = getKnowledgeSqlitePath();
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec('PRAGMA busy_timeout = 5000;');
	migrate(db);
	g.__researchKnowledgeDb = db;
	return db;
}

/** Run work inside an explicit transaction. Do not await embeds inside `fn`. */
export function withKnowledgeTransaction<T>(fn: (db: DatabaseSync) => T): T {
	const db = getKnowledgeDb();
	db.exec('BEGIN');
	try {
		const result = fn(db);
		db.exec('COMMIT');
		return result;
	} catch (error) {
		try {
			db.exec('ROLLBACK');
		} catch {
			/* ignore */
		}
		throw error;
	}
}

/** Test helper: close and clear singleton (e.g. after smoke against temp dir). */
export function closeKnowledgeDbForTests(): void {
	const g = globalThis as GlobalWithDb;
	const db = g.__researchKnowledgeDb;
	if (!db) return;
	try {
		db.close();
	} catch {
		/* ignore */
	}
	delete g.__researchKnowledgeDb;
}
