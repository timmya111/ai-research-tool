export const DEFAULT_RESEARCH_MODEL = 'qwen2.5:7b';
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Ordered picker / auto-route preferences for RTX 5060 ~8GB (+ system RAM offload).
 * Keep DEFAULT_RESEARCH_MODEL as the safe tools daily driver until a new model passes tool smokes.
 */
export const PREFERRED_CHAT_MODELS: readonly string[] = [
	'qwen2.5:7b',
	'qwen3.5:9b',
	'ornith:latest',
	'granite4.2:8b',
	'nemotron-3.5-lightning:latest',
	'lfm2.5:8b',
	'mimo-v2.6:9b',
	'qwen2.5:14b',
	'llama3.1:8b',
	'bonsai-2:latest',
	'qwen3.6:latest',
	'llama3.2:latest',
	'gemma4:26b',
];

/** Fast/reliable tool-calling workers (GPU-resident when possible). */
export const PREFERRED_TOOLS_MODELS: readonly string[] = [
	'qwen2.5:7b',
	'qwen3.5:9b',
	'ornith:latest',
	'granite4.2:8b',
	'lfm2.5:8b',
	'mimo-v2.6:9b',
	'nemotron-3.5-lightning:latest',
	'bonsai-2:latest',
	'llama3.1:8b',
	'qwen3.6:latest',
	'llama3.2:latest',
];

/** Heavier reason / merge / critique workers. */
export const PREFERRED_REASON_MODELS: readonly string[] = [
	'nemotron-3.5-lightning:latest',
	'qwen2.5:14b',
	'qwen3.5:9b',
	'flint:latest',
	'gemma4:26b',
	'qwen3.6:latest',
	'qwen2.5:7b',
];

/** Cheap planner / router. */
export const PREFERRED_ROUTER_MODELS: readonly string[] = [
	'qwen2.5:7b',
	'lfm3:latest',
	'llama3.2:latest',
	'qwen3.5:9b',
	'qwen3.6:latest',
];

export type OllamaChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** Present on thinking models when the final `content` channel is empty. */
	thinking?: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
};

/** Default context window for chat+tools (granite-class models often ship at 4k). */
export const DEFAULT_OLLAMA_NUM_CTX = 32768;

export function getOllamaNumCtx(): number {
	const n = Number(process.env.RESEARCH_OLLAMA_NUM_CTX || DEFAULT_OLLAMA_NUM_CTX);
	if (!Number.isFinite(n)) return DEFAULT_OLLAMA_NUM_CTX;
	return Math.max(2048, Math.min(131_072, Math.floor(n)));
}

/** Prefer visible content; fall back to thinking text when content is blank. */
export function assistantMessageText(message: Pick<OllamaChatMessage, 'content' | 'thinking'>): string {
	const content = String(message?.content || '').trim();
	if (content) return content;
	return String(message?.thinking || '').trim();
}

export type OllamaToolCall = {
	id?: string;
	function: {
		name: string;
		arguments: Record<string, unknown> | string;
		index?: number;
	};
};

export function getOllamaBaseUrl(): string {
	return String(process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
}

/** Ollama Cloud tags (`*:cloud`) are paid; hide them from the model picker. */
export function isFreeLocalOllamaModel(name: string): boolean {
	const n = String(name || '').trim().toLowerCase();
	if (!n) return false;
	if (n.endsWith(':cloud') || n.includes(':cloud-') || n.includes('/cloud:')) return false;
	return true;
}

export function filterFreeLocalOllamaModels(models: string[]): string[] {
	return (Array.isArray(models) ? models : []).filter(isFreeLocalOllamaModel);
}

export async function ollamaTags(baseUrl = getOllamaBaseUrl()): Promise<{
	ok: boolean;
	models: string[];
	error?: string;
}> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { cache: 'no-store' });
		if (!res.ok) return { ok: false, models: [], error: `ollama tags HTTP ${res.status}` };
		const data = await res.json();
		const models = Array.isArray(data?.models)
			? filterFreeLocalOllamaModels(data.models.map((m: { name?: string }) => String(m?.name || '')).filter(Boolean))
			: [];
		return { ok: true, models };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, models: [], error: message };
	}
}

export async function ollamaChat(options: {
	model?: string;
	messages: OllamaChatMessage[];
	tools?: unknown[];
	baseUrl?: string;
	/** Override RESEARCH_OLLAMA_NUM_CTX / default 32768 for this call. */
	numCtx?: number;
}): Promise<{
	message: OllamaChatMessage;
	raw: unknown;
}> {
	const baseUrl = options.baseUrl || getOllamaBaseUrl();
	const model = options.model || DEFAULT_RESEARCH_MODEL;
	const numCtx =
		options.numCtx != null && Number.isFinite(Number(options.numCtx))
			? Math.max(2048, Math.min(131_072, Math.floor(Number(options.numCtx))))
			: getOllamaNumCtx();
	const res = await fetch(`${baseUrl}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: options.messages,
			tools: options.tools,
			stream: false,
			options: { num_ctx: numCtx },
		}),
		cache: 'no-store',
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`ollama chat HTTP ${res.status}: ${text.slice(0, 400)}`);
	}
	const raw = await res.json();
	const rawMessage = (raw?.message || {}) as Record<string, unknown>;
	const message: OllamaChatMessage = {
		role: (rawMessage.role as OllamaChatMessage['role']) || 'assistant',
		content: String(rawMessage.content || ''),
		...(rawMessage.thinking != null && String(rawMessage.thinking).trim()
			? { thinking: String(rawMessage.thinking) }
			: {}),
		...(Array.isArray(rawMessage.tool_calls) ? { tool_calls: rawMessage.tool_calls as OllamaToolCall[] } : {}),
		...(rawMessage.tool_name != null ? { tool_name: String(rawMessage.tool_name) } : {}),
	};
	return { message, raw };
}

export function normalizeToolCallArguments(
	args: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
	if (!args) return {};
	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	return args;
}
