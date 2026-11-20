export {
	cosineSimilarity,
	embedMany,
	l2Normalize,
	ollamaEmbed,
	packEmbedding,
	unpackEmbedding,
} from '@/lib/research/knowledge/embed';
export { planChunks, sha256Hex } from '@/lib/research/knowledge/chunk';
export { closeKnowledgeDbForTests, getKnowledgeDb, withKnowledgeTransaction } from '@/lib/research/knowledge/db';
export { deleteDocument, getDocument, knowledgeCounts, listDocuments } from '@/lib/research/knowledge/documents';
export { canExposeKnowledgeStatusDetail, rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
export { ingestPastedContent, ingestUploadedFile } from '@/lib/research/knowledge/attachments';
export { ingestChatPair, ingestFetchFromToolTrace, ingestNote } from '@/lib/research/knowledge/ingest';
export { ensureKnowledgeDir, getKnowledgeDir, getKnowledgeSqlitePath } from '@/lib/research/knowledge/paths';
export {
	createProject,
	deleteProject,
	ensureDefaultProject,
	getProject,
	listProjects,
	renameProject,
} from '@/lib/research/knowledge/projects';
export { reindexKnowledge } from '@/lib/research/knowledge/reindex';
export { buildFtsQuery, formatSnippetsForPrompt, retrieve } from '@/lib/research/knowledge/retrieve';
export { getSchemaMeta, migrate, needsReindex, setSchemaMeta } from '@/lib/research/knowledge/schema';
export { formatToolTraceSummary } from '@/lib/research/knowledge/toolTraceSummary';
export {
	DEFAULT_EMBED_MODEL,
	DEFAULT_PROJECT_NAME,
	EXPECTED_EMBED_DIMS,
	MAX_CHUNKS_PER_DOCUMENT,
	MAX_DOCUMENT_CHARS,
	SCHEMA_VERSION,
	type KnowledgeChunk,
	type KnowledgeDocument,
	type KnowledgeProject,
	type KnowledgeSearchHit,
	type KnowledgeSourceType,
} from '@/lib/research/knowledge/types';
