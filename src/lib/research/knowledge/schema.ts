import {
	DEFAULT_EMBED_MODEL,
	DEFAULT_PROJECT_NAME,
	EXPECTED_EMBED_DIMS,
	SCHEMA_VERSION,
} from '@/lib/research/knowledge/types';
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  content_hash TEXT,
  raw_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  token_estimate INTEGER,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS documents_project_id ON documents(project_id);
CREATE INDEX IF NOT EXISTS documents_source_type ON documents(source_type);
CREATE INDEX IF NOT EXISTS documents_created_at ON documents(created_at);
CREATE INDEX IF NOT EXISTS documents_project_created ON documents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_project_source ON documents(project_id, source_type);
`;

const FTS_AND_TRIGGERS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

function metaGet(db: DatabaseSync, key: string): string | null {
	const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
		| { value?: string }
		| undefined;
	return row?.value != null ? String(row.value) : null;
}

export function setSchemaMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare(
		`INSERT INTO schema_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, value);
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
	setSchemaMeta(db, key, value);
}

function ensureUniqueUrlHashIndex(db: DatabaseSync): void {
	db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS documents_project_url_hash
      ON documents(project_id, url, content_hash)
      WHERE url IS NOT NULL AND content_hash IS NOT NULL;
  `);
}

function seedDefaultProject(db: DatabaseSync): void {
	const existing = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id?: string } | undefined;
	if (existing?.id) return;
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
	).run(id, DEFAULT_PROJECT_NAME, now, now);
}

/** Apply DDL, FTS triggers, meta, and Default project seed. Idempotent. */
export function migrate(db: DatabaseSync): void {
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(SCHEMA_SQL);
	ensureUniqueUrlHashIndex(db);
	// Composite indexes for large-project retrieve (recent fallback + sourceType filter).
	db.exec(`CREATE INDEX IF NOT EXISTS documents_project_created ON documents(project_id, created_at DESC);`);
	db.exec(`CREATE INDEX IF NOT EXISTS documents_project_source ON documents(project_id, source_type);`);

	// FTS virtual table + triggers (IF NOT EXISTS for table; triggers may already exist)
	try {
		db.exec(FTS_AND_TRIGGERS_SQL);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		// Ignore "already exists" on triggers if IF NOT EXISTS unsupported on older builds
		if (!/already exists/i.test(message)) throw error;
	}

	const version = metaGet(db, 'version');
	if (!version) {
		metaSet(db, 'version', SCHEMA_VERSION);
		metaSet(db, 'embed_model', process.env.RESEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL);
		metaSet(db, 'embed_dims', String(EXPECTED_EMBED_DIMS));
	}

	seedDefaultProject(db);
}

export function getSchemaMeta(db: DatabaseSync): {
	version: string | null;
	embedModel: string | null;
	embedDims: number | null;
} {
	const dimsRaw = metaGet(db, 'embed_dims');
	return {
		version: metaGet(db, 'version'),
		embedModel: metaGet(db, 'embed_model'),
		embedDims: dimsRaw != null && /^\d+$/.test(dimsRaw) ? Number(dimsRaw) : null,
	};
}

export function needsReindex(db: DatabaseSync): boolean {
	const meta = getSchemaMeta(db);
	const configured = process.env.RESEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL;
	if (meta.embedModel && meta.embedModel !== configured) return true;
	if (meta.embedDims != null && meta.embedDims !== EXPECTED_EMBED_DIMS) return true;
	return false;
}
