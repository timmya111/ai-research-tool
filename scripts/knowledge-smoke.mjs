/**
 * PR1 smoke: embed pack/unpack (incl. subarray), SQLite+FTS triggers, Default project.
 * Usage: RESEARCH_DATA_DIR=/tmp/research-knowledge-smoke node scripts/knowledge-smoke.mjs
 */
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

function packEmbedding(arr) {
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function unpackEmbedding(buf, dims = 768) {
	assert(buf.byteLength === dims * 4, `blob size ${buf.byteLength}`);
	return new Float32Array(buf.buffer, buf.byteOffset, dims);
}

// --- pack / unpack ---
{
	const full = new Float32Array(768);
	for (let i = 0; i < 768; i++) full[i] = i * 0.001;
	const packed = packEmbedding(full);
	const back = unpackEmbedding(packed);
	assert(back.length === 768, 'dims');
	assert(Math.abs(back[10] - full[10]) < 1e-7, 'round-trip');

	const view = full.subarray(0, 768);
	const packedView = packEmbedding(view);
	assert(packedView.byteLength === 768 * 4, `subarray pack length ${packedView.byteLength}`);
	console.log('ok pack/unpack (+ subarray)');
}

const dataDir = process.env.RESEARCH_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'research-knowledge-'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'knowledge.sqlite');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
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
`);

const now = new Date().toISOString();
const projectId = randomUUID();
db.prepare(`INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
	projectId,
	'Default',
	now,
	now,
);

const docId = randomUUID();
const chunkId = randomUUID();
const raw = 'Person CRD 5417517 linked to firm for smoke test.';
db.prepare(
	`INSERT INTO documents(id, project_id, source_type, title, url, content_hash, raw_text, metadata_json, created_at, updated_at)
   VALUES (?, ?, 'note', 'smoke', NULL, ?, ?, '{}', ?, ?)`,
).run(docId, projectId, createHash('sha256').update(raw).digest('hex'), raw, now, now);

db.prepare(
	`INSERT INTO chunks(id, document_id, chunk_index, text, embedding, token_estimate) VALUES (?, ?, 0, ?, NULL, 20)`,
).run(chunkId, docId, `[note]\n${raw}`);

const hit = db
	.prepare(`SELECT rowid, text FROM chunks_fts WHERE chunks_fts MATCH ?`)
	.get('"5417517"');
assert(hit && String(hit.text).includes('5417517'), 'FTS MATCH missed CRD token');

db.prepare(`DELETE FROM documents WHERE id = ?`).run(docId);
const orphan = db.prepare(`SELECT count(*) AS c FROM chunks_fts`).get();
assert(Number(orphan.c) === 0, `FTS orphan after cascade delete: ${orphan.c}`);

const projects = db.prepare(`SELECT name FROM projects`).all();
assert(projects.some((p) => p.name === 'Default'), 'Default project missing');

db.close();
console.log('ok FTS triggers + Default project');
console.log('dataDir', dataDir);
console.log('knowledge-smoke passed');

// silence unused import in some runners
void pathToFileURL;
