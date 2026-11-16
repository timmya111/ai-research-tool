import { getKnowledgeDb, withKnowledgeTransaction } from '@/lib/research/knowledge/db';
import { embedMany, packEmbedding } from '@/lib/research/knowledge/embed';
import { setSchemaMeta } from '@/lib/research/knowledge/schema';
import { DEFAULT_EMBED_MODEL, EXPECTED_EMBED_DIMS } from '@/lib/research/knowledge/types';

export type ReindexResult = {
	ok: true;
	chunkCount: number;
	updated: number;
	embedModel: string;
	embedDims: number;
	projectId: string | null;
	ms: number;
};

/**
 * Re-embed chunk texts with the configured Ollama model and refresh schema_meta.
 * Optionally scoped to one project. Embeds outside the write transaction.
 */
export async function reindexKnowledge(options: {
	projectId?: string | null;
} = {}): Promise<ReindexResult> {
	const started = Date.now();
	const projectId = options.projectId ? String(options.projectId).trim() : null;
	const embedModel = process.env.RESEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL;
	const db = getKnowledgeDb();

	let sql = `SELECT c.id, c.text FROM chunks c`;
	const params: unknown[] = [];
	if (projectId) {
		sql += ` JOIN documents d ON d.id = c.document_id WHERE d.project_id = ?`;
		params.push(projectId);
	}
	sql += ` ORDER BY c.document_id, c.chunk_index`;

	const rows = db.prepare(sql).all(...params) as Array<{ id: string; text: string }>;
	if (!rows.length) {
		setSchemaMeta(db, 'embed_model', embedModel);
		setSchemaMeta(db, 'embed_dims', String(EXPECTED_EMBED_DIMS));
		return {
			ok: true,
			chunkCount: 0,
			updated: 0,
			embedModel,
			embedDims: EXPECTED_EMBED_DIMS,
			projectId,
			ms: Date.now() - started,
		};
	}

	const embeddings = await embedMany(rows.map((r) => r.text));

	withKnowledgeTransaction((tx) => {
		const update = tx.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`);
		for (let i = 0; i < rows.length; i++) {
			const emb = embeddings[i];
			if (!emb) continue;
			update.run(packEmbedding(emb), rows[i]!.id);
		}
		setSchemaMeta(tx, 'embed_model', embedModel);
		setSchemaMeta(tx, 'embed_dims', String(EXPECTED_EMBED_DIMS));
	});

	try {
		db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
	} catch {
		/* rebuild optional if FTS already consistent */
	}

	return {
		ok: true,
		chunkCount: rows.length,
		updated: rows.length,
		embedModel,
		embedDims: EXPECTED_EMBED_DIMS,
		projectId,
		ms: Date.now() - started,
	};
}
