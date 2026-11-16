import { createHash } from 'crypto';
import { MAX_CHUNKS_PER_DOCUMENT, MAX_DOCUMENT_CHARS } from '@/lib/research/knowledge/types';

const TARGET_MIN = 600;
const TARGET_MAX = 900;
const OVERLAP = 80;

export type ChunkPlan = {
	rawText: string;
	truncated: boolean;
	chunks: Array<{ index: number; text: string; tokenEstimate: number }>;
};

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function splitParagraphs(text: string): string[] {
	return text
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
}

function splitSentences(text: string): string[] {
	const parts = text.split(/(?<=[.!?])\s+/);
	return parts.map((p) => p.trim()).filter(Boolean);
}

function hardSlices(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		out.push(text.slice(i, i + size));
	}
	return out;
}

function pushChunk(
	chunks: Array<{ index: number; text: string; tokenEstimate: number }>,
	header: string,
	body: string,
): void {
	const text = `${header}\n${body}`.trim();
	if (!text) return;
	chunks.push({
		index: chunks.length,
		text,
		tokenEstimate: estimateTokens(text),
	});
}

/**
 * Split source text into overlapping chunks (~600–900 chars), max 64.
 * Applies 48k source bound first.
 */
export function planChunks(options: {
	sourceText: string;
	header?: string;
}): ChunkPlan {
	let raw = String(options.sourceText || '');
	let truncated = false;
	if (raw.length > MAX_DOCUMENT_CHARS) {
		raw = raw.slice(0, MAX_DOCUMENT_CHARS);
		truncated = true;
	}

	const header = String(options.header || '[note]').trim() || '[note]';
	const chunks: Array<{ index: number; text: string; tokenEstimate: number }> = [];

	if (!raw.trim()) {
		return { rawText: raw, truncated, chunks };
	}

	const paragraphs = splitParagraphs(raw);
	let buffer = '';

	const flush = (force = false) => {
		while (buffer.length >= TARGET_MIN || (force && buffer.trim())) {
			if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
				truncated = true;
				buffer = '';
				return;
			}
			let take = Math.min(TARGET_MAX, buffer.length);
			if (!force && buffer.length > TARGET_MAX) {
				// Prefer a break near the end of the window
				const window = buffer.slice(0, TARGET_MAX);
				const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
				if (breakAt >= TARGET_MIN) take = breakAt + 1;
			} else if (force && buffer.length > TARGET_MAX) {
				take = TARGET_MAX;
			}
			const piece = buffer.slice(0, take).trim();
			if (piece) pushChunk(chunks, header, piece);
			if (buffer.length <= take) {
				buffer = '';
				return;
			}
			const overlapStart = Math.max(0, take - OVERLAP);
			buffer = buffer.slice(overlapStart).trimStart();
			if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
				truncated = true;
				buffer = '';
				return;
			}
		}
	};

	for (const para of paragraphs.length ? paragraphs : [raw]) {
		if (para.length > TARGET_MAX * 2) {
			for (const sentence of splitSentences(para)) {
				if (sentence.length > TARGET_MAX) {
					for (const slice of hardSlices(sentence, TARGET_MAX)) {
						buffer = buffer ? `${buffer} ${slice}` : slice;
						flush();
					}
				} else {
					buffer = buffer ? `${buffer} ${sentence}` : sentence;
					flush();
				}
			}
		} else {
			buffer = buffer ? `${buffer}\n\n${para}` : para;
			flush();
		}
		if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
			truncated = true;
			break;
		}
	}
	flush(true);

	if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
		truncated = true;
		chunks.length = MAX_CHUNKS_PER_DOCUMENT;
		chunks.forEach((c, i) => {
			c.index = i;
		});
	}

	return { rawText: raw, truncated, chunks };
}

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
