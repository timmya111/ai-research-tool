import { getKnowledgeDb, withKnowledgeTransaction } from '@/lib/research/knowledge/db';
import type { KnowledgeDocument, KnowledgeSourceType } from '@/lib/research/knowledge/types';

function parseMeta(raw: unknown): Record<string, unknown> {
	try {
		const parsed = JSON.parse(String(raw || '{}'));
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function rowToDoc(row: Record<string, unknown>): KnowledgeDocument {
	return {
		id: String(row.id || ''),
		projectId: String(row.project_id || ''),
		sourceType: String(row.source_type || 'note') as KnowledgeSourceType,
		title: String(row.title || ''),
		url: row.url != null ? String(row.url) : null,
		contentHash: row.content_hash != null ? String(row.content_hash) : null,
		rawText: String(row.raw_text || ''),
		metadata: parseMeta(row.metadata_json),
		createdAt: String(row.created_at || ''),
		updatedAt: String(row.updated_at || ''),
	};
}

export function listDocuments(options: {
	projectId: string;
	sourceType?: KnowledgeSourceType | 'any';
	limit?: number;
	offset?: number;
}): { documents: Omit<KnowledgeDocument, 'rawText'>[]; total: number } {
	const projectId = String(options.projectId || '').trim();
	if (!projectId) throw new Error('projectId required');

	const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
	const offset = Math.max(0, Number(options.offset) || 0);
	const sourceType =
		options.sourceType && options.sourceType !== 'any' ? options.sourceType : null;

	const db = getKnowledgeDb();
	let countSql = `SELECT COUNT(*) AS c FROM documents WHERE project_id = ?`;
	const countParams: unknown[] = [projectId];
	if (sourceType) {
		countSql += ` AND source_type = ?`;
		countParams.push(sourceType);
	}
	const total = Number((db.prepare(countSql).get(...countParams) as { c?: number })?.c || 0);

	let sql = `
    SELECT id, project_id, source_type, title, url, content_hash, metadata_json, created_at, updated_at
    FROM documents
    WHERE project_id = ?`;
	const params: unknown[] = [projectId];
	if (sourceType) {
		sql += ` AND source_type = ?`;
		params.push(sourceType);
	}
	sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	const documents = rows.map((row) => {
		const doc = rowToDoc({ ...row, raw_text: '' });
		return {
			id: doc.id,
			projectId: doc.projectId,
			sourceType: doc.sourceType,
			title: doc.title,
			url: doc.url,
			contentHash: doc.contentHash,
			metadata: doc.metadata,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		};
	});

	return { documents, total };
}

export function getDocument(id: string): KnowledgeDocument | null {
	const row = getKnowledgeDb()
		.prepare(
			`SELECT id, project_id, source_type, title, url, content_hash, raw_text, metadata_json, created_at, updated_at
       FROM documents WHERE id = ?`,
		)
		.get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToDoc(row);
}

export function deleteDocument(id: string): boolean {
	return withKnowledgeTransaction((db) => {
		const info = db.prepare(`DELETE FROM documents WHERE id = ?`).run(id) as { changes?: number };
		return Number(info?.changes || 0) > 0;
	});
}

export function knowledgeCounts(): { documentCount: number; chunkCount: number; projectCount: number } {
	const db = getKnowledgeDb();
	const documentCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM documents`).get() as { c?: number })?.c || 0);
	const chunkCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c?: number })?.c || 0);
	const projectCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM projects`).get() as { c?: number })?.c || 0);
	return { documentCount, chunkCount, projectCount };
}
