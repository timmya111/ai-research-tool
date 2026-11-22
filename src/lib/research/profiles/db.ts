import { DatabaseSync } from 'node:sqlite';
import { getProfilesDbPath } from '@/lib/research/profiles/paths';
import { migrateProfilesDb } from '@/lib/research/profiles/schema';

const g = globalThis as typeof globalThis & {
	__researchProfilesDb?: DatabaseSync;
	__researchProfilesDbPath?: string;
};

export function getProfilesDb(): DatabaseSync {
	const dbPath = getProfilesDbPath();
	if (g.__researchProfilesDb && g.__researchProfilesDbPath === dbPath) {
		return g.__researchProfilesDb;
	}
	if (g.__researchProfilesDb) {
		try {
			g.__researchProfilesDb.close();
		} catch {
			/* ignore */
		}
	}
	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec('PRAGMA busy_timeout = 5000;');
	migrateProfilesDb(db);
	g.__researchProfilesDb = db;
	g.__researchProfilesDbPath = dbPath;
	return db;
}

export function withProfilesTransaction<T>(fn: (db: DatabaseSync) => T): T {
	const db = getProfilesDb();
	db.exec('BEGIN IMMEDIATE;');
	try {
		const out = fn(db);
		db.exec('COMMIT;');
		return out;
	} catch (error) {
		try {
			db.exec('ROLLBACK;');
		} catch {
			/* ignore */
		}
		throw error;
	}
}
