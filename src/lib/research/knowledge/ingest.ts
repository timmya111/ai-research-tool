import { planChunks, sha256Hex } from '@/lib/research/knowledge/chunk';
import { getKnowledgeDb, withKnowledgeTransaction } from '@/lib/research/knowledge/db';
import { embedMany, packEmbedding } from '@/lib/research/knowledge/embed';
import { getProject } from '@/lib/research/knowledge/projects';
import { formatToolTraceSummary } from '@/lib/research/knowledge/toolTraceSummary';
import {
	MAX_DOCUMENT_CHARS,
	type KnowledgeSourceType,
} from '@/lib/research/knowledge/types';

function requireProject(projectId: string): void {
	const id = String(projectId || '').trim();
	if (!id) throw new Error('projectId required');
	if (!getProject(id)) throw new Error('project not found');
}

function titleFromQuestion(question: string): string {
	return String(question || '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80) || 'chat';
}

function titleFromUrl(url: string | null | undefined): string {
	try {
		const u = new URL(String(url || ''));
		return `${u.hostname}${u.pathname}`.slice(0, 160) || 'fetch';
	} catch {
		return 'fetch';
	}
}

async function commitDocument(options: {
	projectId: string;
	sourceType: KnowledgeSourceType;
	title: string;
	url?: string | null;
	rawText: string;
	header: string;
	metadata?: Record<string, unknown>;
	replaceExistingId?: string | null;
}): Promise<string> {
	requireProject(options.projectId);

	const plan = planChunks({
		sourceText: options.rawText,
		header: options.header,
	});
	const contentHash = sha256Hex(plan.rawText);
	const metadata = {
		...(options.metadata || {}),
		...(plan.truncated ? { truncated: true } : {}),
	};

	const embeddings =
		plan.chunks.length > 0 ? await embedMany(plan.chunks.map((c) => c.text)) : [];

	const now = new Date().toISOString();
	const docId = options.replaceExistingId || crypto.randomUUID();

	withKnowledgeTransaction((db) => {
		if (options.replaceExistingId) {
			db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(options.replaceExistingId);
			db.prepare(
				`UPDATE documents SET title = ?, url = ?, content_hash = ?, raw_text = ?, metadata_json = ?, updated_at = ?, source_type = ?
         WHERE id = ?`,
			).run(
				options.title,
				options.url ?? null,
				contentHash,
				plan.rawText,
				JSON.stringify(metadata),
				now,
				options.sourceType,
				options.replaceExistingId,
			);
		} else {
			db.prepare(
				`INSERT INTO documents(id, project_id, source_type, title, url, content_hash, raw_text, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				docId,
				options.projectId,
				options.sourceType,
				options.title,
				options.url ?? null,
				contentHash,
				plan.rawText,
				JSON.stringify(metadata),
				now,
				now,
			);
		}

		const insertChunk = db.prepare(
			`INSERT INTO chunks(id, document_id, chunk_index, text, embedding, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (let i = 0; i < plan.chunks.length; i++) {
			const chunk = plan.chunks[i]!;
			const emb = embeddings[i];
			insertChunk.run(
				crypto.randomUUID(),
				docId,
				chunk.index,
				chunk.text,
				emb ? packEmbedding(emb) : null,
				chunk.tokenEstimate,
			);
		}
	});

	return docId;
}

export async function ingestNote(options: {
	projectId: string;
	title?: string;
	text: string;
	url?: string | null;
	metadata?: Record<string, unknown>;
	replaceIfSameUrlHash?: boolean;
}): Promise<{ id: string; projectId: string; skipped?: boolean }> {
	const text = String(options.text || '');
	if (!text.trim()) throw new Error('text required');
	if (text.length > MAX_DOCUMENT_CHARS) {
		throw new Error(`text exceeds ${MAX_DOCUMENT_CHARS} characters; split or shorten the note`);
	}

	const title =
		String(options.title || '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120) || text.trim().slice(0, 80) || 'note';

	const url = options.url != null ? String(options.url).trim() || null : null;
	const planPreview = planChunks({ sourceText: text, header: `[note] ${title}` });
	const contentHash = sha256Hex(planPreview.rawText);

	if (url && options.replaceIfSameUrlHash !== false) {
		const existing = getKnowledgeDb()
			.prepare(
				`SELECT id FROM documents WHERE project_id = ? AND url = ? AND content_hash = ? LIMIT 1`,
			)
			.get(options.projectId, url, contentHash) as { id?: string } | undefined;
		if (existing?.id) {
			return { id: existing.id, projectId: options.projectId, skipped: true };
		}
	}

	const id = await commitDocument({
		projectId: options.projectId,
		sourceType: 'note',
		title,
		url,
		rawText: text,
		header: `[note] ${title}`,
		metadata: { kind: 'note', ...(options.metadata || {}) },
	});
	return { id, projectId: options.projectId };
}

export async function ingestChatPair(options: {
	projectId: string;
	question: string;
	answer: string;
	toolTrace?: unknown;
}): Promise<string> {
	const question = String(options.question || '').trim();
	const answer = String(options.answer || '').trim();
	const tools = formatToolTraceSummary(options.toolTrace);
	const rawText = `## Question\n${question}\n\n## Answer\n${answer}\n\n${tools}`;
	const title = titleFromQuestion(question);

	return commitDocument({
		projectId: options.projectId,
		sourceType: 'chat',
		title,
		rawText,
		header: `[chat] Q: ${title}`,
		metadata: { kind: 'chat' },
	});
}

export async function ingestFetchFromToolTrace(
	toolTrace: unknown,
	options: { projectId: string },
): Promise<string[]> {
	requireProject(options.projectId);
	const entries = Array.isArray(toolTrace) ? toolTrace : [];
	const seen = new Set<string>();
	const ids: string[] = [];

	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue;
		const tool = String((entry as { tool?: string }).tool || '');
		if (tool !== 'fetch_url') continue;
		const result = (entry as { result?: Record<string, unknown> }).result;
		if (!result || typeof result !== 'object') continue;
		if (result.ok !== true) continue;
		const status = result.status;
		if (typeof status === 'number' && (status < 200 || status >= 400)) continue;

		let bodyText = '';
		if (typeof result.body === 'string') bodyText = result.body;
		else if (result.body && typeof result.body === 'object') {
			bodyText = JSON.stringify(result.body, null, 2);
		} else continue;

		const url = String(result.finalUrl || result.requestedUrl || '').trim() || null;
		const planPreview = planChunks({ sourceText: bodyText, header: '[fetch]' });
		const contentHash = sha256Hex(planPreview.rawText);
		const dedupeKey = `${url || ''}::${contentHash}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);

		let replaceExistingId: string | null = null;
		if (url) {
			const existing = getKnowledgeDb()
				.prepare(
					`SELECT id FROM documents WHERE project_id = ? AND url = ? AND content_hash = ? LIMIT 1`,
				)
				.get(options.projectId, url, contentHash) as { id?: string } | undefined;
			replaceExistingId = existing?.id || null;
		}

		const id = await commitDocument({
			projectId: options.projectId,
			sourceType: 'fetch',
			title: titleFromUrl(url),
			url,
			rawText: bodyText,
			header: `[fetch] ${url || 'fetch'} | ${new Date().toISOString().slice(0, 10)}`,
			metadata: {
				contentType: result.contentType ?? null,
				kind: result.kind ?? null,
				truncated: Boolean(result.truncated),
				status: status ?? null,
			},
			replaceExistingId,
		});
		ids.push(id);
	}

	return ids;
}
