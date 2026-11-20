export type KnowledgeSourceType = 'chat' | 'fetch' | 'note' | 'file' | 'image';

export type KnowledgeProject = {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	documentCount?: number;
};

export type KnowledgeDocument = {
	id: string;
	projectId: string;
	sourceType: KnowledgeSourceType;
	title: string;
	url: string | null;
	contentHash: string | null;
	rawText: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export type KnowledgeChunk = {
	id: string;
	documentId: string;
	chunkIndex: number;
	text: string;
	embedding: Float32Array | null;
	tokenEstimate: number | null;
};

export type KnowledgeSearchHit = {
	chunkId: string;
	documentId: string;
	projectId: string;
	sourceType: KnowledgeSourceType;
	title: string;
	url: string | null;
	snippet: string;
	score: number;
	chunkIndex: number;
};

export const SCHEMA_VERSION = '1';
export const DEFAULT_PROJECT_NAME = 'Default';
export const MAX_DOCUMENT_CHARS = 48_000;
export const MAX_CHUNKS_PER_DOCUMENT = 64;
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
export const EXPECTED_EMBED_DIMS = 768;
