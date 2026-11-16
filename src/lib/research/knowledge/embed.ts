import { getOllamaBaseUrl } from '@/lib/research/ollama';
import { DEFAULT_EMBED_MODEL, EXPECTED_EMBED_DIMS } from '@/lib/research/knowledge/types';

export { DEFAULT_EMBED_MODEL, EXPECTED_EMBED_DIMS };

/** Correct for sliced Float32Array views — not Buffer.from(arr.buffer) alone. */
export function packEmbedding(arr: Float32Array): Buffer {
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function unpackEmbedding(buf: Buffer, dims = EXPECTED_EMBED_DIMS): Float32Array {
	if (buf.byteLength !== dims * 4) {
		throw new Error(`embedding blob size ${buf.byteLength} != ${dims * 4}`);
	}
	return new Float32Array(buf.buffer, buf.byteOffset, dims);
}

export function l2Normalize(v: Float32Array): Float32Array {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i] * v[i];
	const n = Math.sqrt(s) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
	return out;
}

/** Cosine similarity for already L2-normalized vectors equals dot product. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < n; i++) dot += a[i] * b[i];
	return dot;
}

export async function ollamaEmbed(
	prompt: string,
	model = process.env.RESEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL,
): Promise<Float32Array> {
	const baseUrl = getOllamaBaseUrl();
	const res = await fetch(`${baseUrl}/api/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, prompt }),
		cache: 'no-store',
	});
	if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
	const data = (await res.json()) as { embedding?: unknown };
	const arr = data?.embedding;
	if (!Array.isArray(arr) || arr.length !== EXPECTED_EMBED_DIMS) {
		throw new Error(
			`expected ${EXPECTED_EMBED_DIMS}-d embedding, got ${Array.isArray(arr) ? arr.length : typeof arr}`,
		);
	}
	return l2Normalize(Float32Array.from(arr as number[]));
}

export async function embedMany(
	texts: string[],
	options: { concurrency?: number; model?: string } = {},
): Promise<Float32Array[]> {
	const fromEnv = Number(process.env.RESEARCH_EMBED_CONCURRENCY);
	const concurrency = Math.max(
		1,
		Math.min(8, options.concurrency ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4)),
	);
	const out: Float32Array[] = new Array(texts.length);
	let next = 0;

	async function worker() {
		while (next < texts.length) {
			const i = next++;
			out[i] = await ollamaEmbed(texts[i], options.model);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, texts.length || 1) }, () => worker());
	await Promise.all(workers);
	return out;
}
