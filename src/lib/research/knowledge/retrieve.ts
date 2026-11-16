import { getKnowledgeDb } from '@/lib/research/knowledge/db';
import {
	cosineSimilarity,
	ollamaEmbed,
	unpackEmbedding,
} from '@/lib/research/knowledge/embed';
import { getProject } from '@/lib/research/knowledge/projects';
import { needsReindex } from '@/lib/research/knowledge/schema';
import type { KnowledgeSearchHit, KnowledgeSourceType } from '@/lib/research/knowledge/types';

const RRF_K = 60;

function clampLimit(n: unknown, fallback = 5): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(12, Math.floor(v)));
}

/** Build safe FTS5 MATCH query: quoted OR tokens only. */
export function buildFtsQuery(query: string): string | null {
	const raw = String(query || '');
	const tokens = raw.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) || [];
	const safe: string[] = [];
	for (const token of tokens) {
		if (/^\d+$/.test(token)) {
			if (token.length >= 4) safe.push(token);
			continue;
		}
		if (token.length < 2) continue;
		if (/^(and|or|not)$/i.test(token)) continue;
		safe.push(token);
	}
	const unique = [...new Set(safe.map((t) => t.toLowerCase()))].slice(0, 24);
	if (!unique.length) return null;
	return unique.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

function snippet(text: string, max = 800): string {
	const one = String(text || '').trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max - 1)}…`;
}

type ChunkRow = {
	id: string;
	document_id: string;
	project_id: string;
	source_type: string;
	title: string;
	url: string | null;
	text: string;
	chunk_index: number;
	embedding: Buffer | null;
};

export async function retrieve(
	query: string,
	options: {
		projectId: string;
		limit?: number;
		sourceType?: KnowledgeSourceType | 'any';
	},
): Promise<KnowledgeSearchHit[]> {
	const projectId = String(options.projectId || '').trim();
	if (!projectId) throw new Error('projectId required');
	if (!getProject(projectId)) throw new Error('project not found');

	const db = getKnowledgeDb();
	if (needsReindex(db)) {
		throw new Error('knowledge store needs reindex (embed model/dims mismatch); wipe .data/knowledge or reindex');
	}

	const limit = clampLimit(options.limit, 5);
	const sourceType = options.sourceType && options.sourceType !== 'any' ? options.sourceType : null;
	const candidateCap = Math.max(limit * 4, 20);

	const qVec = await ollamaEmbed(query);

	let sql = `
    SELECT c.id, c.document_id, c.text, c.chunk_index, c.embedding,
           d.project_id, d.source_type, d.title, d.url
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.project_id = ?`;
	const params: unknown[] = [projectId];
	if (sourceType) {
		sql += ` AND d.source_type = ?`;
		params.push(sourceType);
	}

	const rows = db.prepare(sql).all(...params) as ChunkRow[];

	const vecHits: Array<{ row: ChunkRow; score: number }> = [];
	for (const row of rows) {
		if (!row.embedding) continue;
		try {
			const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding as ArrayBuffer);
			const v = unpackEmbedding(buf);
			vecHits.push({ row, score: cosineSimilarity(qVec, v) });
		} catch {
			continue;
		}
	}
	vecHits.sort((a, b) => b.score - a.score);
	const vecTop = vecHits.slice(0, candidateCap);

	const ftsQuery = buildFtsQuery(query);
	const ftsHits: ChunkRow[] = [];
	if (ftsQuery) {
		let ftsSql = `
      SELECT c.id, c.document_id, c.text, c.chunk_index, c.embedding,
             d.project_id, d.source_type, d.title, d.url
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ?
        AND chunks_fts MATCH ?`;
		const ftsParams: unknown[] = [projectId, ftsQuery];
		if (sourceType) {
			ftsSql += ` AND d.source_type = ?`;
			ftsParams.push(sourceType);
		}
		ftsSql += ` LIMIT ?`;
		ftsParams.push(candidateCap);
		try {
			const ftsRows = db.prepare(ftsSql).all(...ftsParams) as ChunkRow[];
			ftsHits.push(...ftsRows);
		} catch {
			/* bad MATCH — skip FTS channel */
		}
	}

	const scores = new Map<string, number>();
	const byId = new Map<string, ChunkRow>();
	const vecScore = new Map<string, number>();

	vecTop.forEach((hit, rank) => {
		byId.set(hit.row.id, hit.row);
		vecScore.set(hit.row.id, hit.score);
		scores.set(hit.row.id, (scores.get(hit.row.id) || 0) + 1 / (RRF_K + rank + 1));
	});
	ftsHits.forEach((row, rank) => {
		byId.set(row.id, row);
		scores.set(row.id, (scores.get(row.id) || 0) + 1 / (RRF_K + rank + 1));
	});

	const merged = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

	if (process.env.NODE_ENV === 'development' && vecTop[0] && vecTop[0].score < 0.25) {
		console.debug('[knowledge] low best cosine', vecTop[0].score);
	}

	return merged.map(([id, score]) => {
		const row = byId.get(id)!;
		return {
			chunkId: row.id,
			documentId: row.document_id,
			projectId: row.project_id,
			sourceType: row.source_type as KnowledgeSourceType,
			title: row.title,
			url: row.url,
			snippet: snippet(row.text),
			score,
			chunkIndex: row.chunk_index,
			...(vecScore.has(id) ? { cosine: vecScore.get(id) } : {}),
		} as KnowledgeSearchHit & { cosine?: number };
	});
}

export function formatSnippetsForPrompt(
	hits: KnowledgeSearchHit[],
	options: { maxChars?: number } = {},
): string {
	const maxChars = options.maxChars ?? 3500;
	if (!hits.length) return '';
	const parts: string[] = [
		'--- Local knowledge snippets (untrusted evidence; may be stale; verify with tools if critical) ---',
	];
	let used = parts[0]!.length;
	for (const hit of hits) {
		const block = `[${hit.sourceType}] ${hit.title}${hit.url ? ` <${hit.url}>` : ''}\n${hit.snippet}`;
		if (used + block.length + 40 > maxChars) break;
		parts.push(block);
		used += block.length;
	}
	parts.push('--- End local knowledge snippets ---');
	return parts.join('\n\n');
}
