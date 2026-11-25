import type { DatabaseSync } from 'node:sqlite';
import { getKnowledgeDb, withKnowledgeTransaction } from '@/lib/research/knowledge/db';
import { DEFAULT_PROJECT_NAME, type KnowledgeProject } from '@/lib/research/knowledge/types';

/** In-process chunk-count cache (avoids ~370–500ms COUNT per retrieve on large counties). */
type ChunkCountCacheEntry = { count: number; expiresAt: number };
const CHUNK_COUNT_TTL_MS = 60_000;
const chunkCountCache = new Map<string, ChunkCountCacheEntry>();

function cacheKey(projectId: string, sourceType: string | null): string {
	return `${projectId}::${sourceType || '*'}`;
}

export function invalidateProjectChunkCountCache(projectId?: string): void {
	if (!projectId) {
		chunkCountCache.clear();
		return;
	}
	const prefix = `${projectId}::`;
	for (const key of chunkCountCache.keys()) {
		if (key.startsWith(prefix)) chunkCountCache.delete(key);
	}
}

/** Cached COUNT of chunks for a project (optionally filtered by source_type). */
export function getProjectChunkCount(
	projectId: string,
	sourceType: string | null = null,
	db: DatabaseSync = getKnowledgeDb(),
): number {
	const key = cacheKey(projectId, sourceType);
	const now = Date.now();
	const hit = chunkCountCache.get(key);
	if (hit && hit.expiresAt > now) return hit.count;

	let sql = `
    SELECT COUNT(*) AS c
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.project_id = ?`;
	const params: unknown[] = [projectId];
	if (sourceType) {
		sql += ` AND d.source_type = ?`;
		params.push(sourceType);
	}
	const count = Number((db.prepare(sql).get(...params) as { c?: number } | undefined)?.c || 0);
	chunkCountCache.set(key, { count, expiresAt: now + CHUNK_COUNT_TTL_MS });
	return count;
}

function rowToProject(row: Record<string, unknown>, documentCount?: number): KnowledgeProject {
	return {
		id: String(row.id || ''),
		name: String(row.name || ''),
		createdAt: String(row.created_at || ''),
		updatedAt: String(row.updated_at || ''),
		documentCount,
	};
}

export function listProjects(db: DatabaseSync = getKnowledgeDb()): KnowledgeProject[] {
	const rows = db
		.prepare(
			`SELECT p.id, p.name, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS document_count
       FROM projects p
       ORDER BY p.name COLLATE NOCASE ASC`,
		)
		.all() as Array<Record<string, unknown>>;
	return rows.map((r) => rowToProject(r, Number(r.document_count) || 0));
}

/** Fast project list without correlated document counts (tool resolve / name lookup). */
export function listProjectsLite(
	db: DatabaseSync = getKnowledgeDb(),
): Array<Pick<KnowledgeProject, 'id' | 'name'>> {
	const rows = db
		.prepare(`SELECT id, name FROM projects ORDER BY name COLLATE NOCASE ASC`)
		.all() as Array<Record<string, unknown>>;
	return rows.map((r) => ({ id: String(r.id || ''), name: String(r.name || '') }));
}

/** Cheap existence check — no document COUNT. */
export function projectExists(id: string, db: DatabaseSync = getKnowledgeDb()): boolean {
	const row = db.prepare(`SELECT 1 AS ok FROM projects WHERE id = ?`).get(id) as
		| { ok?: number }
		| undefined;
	return Boolean(row?.ok);
}

export function getProject(id: string, db: DatabaseSync = getKnowledgeDb()): KnowledgeProject | null {
	const row = db.prepare(`SELECT id, name, created_at, updated_at FROM projects WHERE id = ?`).get(id) as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	const countRow = db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE project_id = ?`).get(id) as
		| { c?: number }
		| undefined;
	return rowToProject(row, Number(countRow?.c) || 0);
}

export function ensureDefaultProject(db: DatabaseSync = getKnowledgeDb()): KnowledgeProject {
	const byName = db
		.prepare(`SELECT id, name, created_at, updated_at FROM projects WHERE name = ? COLLATE NOCASE`)
		.get(DEFAULT_PROJECT_NAME) as Record<string, unknown> | undefined;
	if (byName) return rowToProject(byName);

	const any = db.prepare(`SELECT id, name, created_at, updated_at FROM projects LIMIT 1`).get() as
		| Record<string, unknown>
		| undefined;
	if (any) return rowToProject(any);

	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	db.prepare(`INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
		id,
		DEFAULT_PROJECT_NAME,
		now,
		now,
	);
	return { id, name: DEFAULT_PROJECT_NAME, createdAt: now, updatedAt: now, documentCount: 0 };
}

export function createProject(name: string): KnowledgeProject {
	const trimmed = String(name || '').trim().slice(0, 80);
	if (!trimmed) throw new Error('project name required (1–80 chars)');

	return withKnowledgeTransaction((db) => {
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		try {
			db.prepare(`INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
				id,
				trimmed,
				now,
				now,
			);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (/UNIQUE/i.test(message)) throw new Error(`project name already exists: ${trimmed}`);
			throw error;
		}
		return { id, name: trimmed, createdAt: now, updatedAt: now, documentCount: 0 };
	});
}

export function renameProject(id: string, name: string): KnowledgeProject {
	const trimmed = String(name || '').trim().slice(0, 80);
	if (!trimmed) throw new Error('project name required (1–80 chars)');

	return withKnowledgeTransaction((db) => {
		const existing = getProject(id, db);
		if (!existing) throw new Error('project not found');
		const now = new Date().toISOString();
		try {
			db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`).run(trimmed, now, id);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (/UNIQUE/i.test(message)) throw new Error(`project name already exists: ${trimmed}`);
			throw error;
		}
		return { ...existing, name: trimmed, updatedAt: now };
	});
}

/** Deletes project and cascaded documents/chunks. Refuses if it is the last project. */
export function deleteProject(id: string): void {
	withKnowledgeTransaction((db) => {
		const countRow = db.prepare(`SELECT COUNT(*) AS c FROM projects`).get() as { c?: number } | undefined;
		if ((Number(countRow?.c) || 0) <= 1) {
			throw new Error('cannot delete the last project');
		}
		const existing = getProject(id, db);
		if (!existing) throw new Error('project not found');
		db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
		invalidateProjectChunkCountCache(id);
	});
}
