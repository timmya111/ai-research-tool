import {
	assistantMessageText,
	DEFAULT_RESEARCH_MODEL,
	normalizeToolCallArguments,
	ollamaChat,
	type OllamaChatMessage,
} from '@/lib/research/ollama';
import type { CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { ensureDefaultProject } from '@/lib/research/knowledge/projects';
import { formatSnippetsForPrompt, retrieve } from '@/lib/research/knowledge/retrieve';
import { RESEARCH_TOOL_DEFINITIONS, runResearchTool } from '@/lib/research/tools';
import {
	RESEARCH_AUTO_MODEL,
	routeResearchModel,
	shouldHeuristicMulti,
	type ResearchRouteDecision,
	type ResearchWorkerPlan,
} from '@/lib/research/orchestrator';

/** Cap tool JSON fed back into the model so 4k–32k contexts survive large knowledge/fetch dumps. */
const TOOL_RESULT_MAX_CHARS = (() => {
	const n = Number(process.env.RESEARCH_TOOL_RESULT_MAX_CHARS || 8000);
	if (!Number.isFinite(n)) return 8000;
	return Math.max(1500, Math.min(48_000, Math.floor(n)));
})();

function stringifyToolResultForModel(result: unknown): string {
	const full = JSON.stringify(result);
	if (full.length <= TOOL_RESULT_MAX_CHARS) return full;
	const marker = `\n…[truncated ${full.length - TOOL_RESULT_MAX_CHARS} chars for model context; ask a narrower query or URL]`;
	const budget = Math.max(200, TOOL_RESULT_MAX_CHARS - marker.length);
	return `${full.slice(0, budget)}${marker}`;
}

function buildSystemPrompt(
	snapshot?: CanvasSnapshot | null,
	aboutNodeGraph = false,
	workerFocus?: string,
	knowledgeSnippets?: string,
) {
	const canvasLine =
		aboutNodeGraph && snapshot && snapshot.nodeCount > 0
			? `The user checked "Question about node graph". Canvas snapshot attached: source=${snapshot.source}, nodes=${snapshot.nodeCount}, links=${snapshot.linkCount}, people=${snapshot.personCount}, firms=${snapshot.firmCount}. Call inspect_canvas_graph first for this question.`
			: aboutNodeGraph
				? 'The user checked "Question about node graph", but no canvas snapshot is attached (or it is empty). Tell them to Connect the live FINRA graph window (or paste snapshot JSON), then ask again.'
				: 'The user did not check "Question about node graph". Do not use inspect_canvas_graph unless they clearly ask about the attached canvas.';

	const focusLine = workerFocus ? `\nWorker focus: ${workerFocus}\n` : '';
	const knowledgeBlock =
		knowledgeSnippets && knowledgeSnippets.trim()
			? `\n${knowledgeSnippets.trim()}\n`
			: '';

	return `You are a local AI research assistant running on the developer's machine via Ollama.
You help with research questions: summarizing sources, cross-checking URLs, comparing claims, drafting concise findings, searching a local knowledge store, charting Bryan County filing volume over time, and (when enabled) inspecting a FINRA canvas graph snapshot from the live visualizer.
${focusLine}
Rules:
- Use tools for facts when the user pastes a URL or asks you to look something up. Do not invent page contents, quotes, or citations.
- When the user pastes an API endpoint or page URL, call fetch_url with that URL. Only allowlisted (or open-fetch public) hosts work. The live app host finra-sec-data-visualizer-canvas.vercel.app, BrokerCheck, and AdviserInfo are allowlisted.
- Prefer search_knowledge before inventing prior facts from earlier sessions. Empty hits mean no local memory for that query.
- When the user asks for a chart, trend, volume over a period, monthly/weekly/daily counts, or document-type breakdown of Bryan County filings, call chart_filings (default PNG for easy online sharing; format=jpeg if they ask for JPG). Embed the returned imageUrl as markdown ![title](imageUrl) and summarize the top buckets in text.
- When the user asks for a logo or vector mark, call make_logo (default SVG). Use format=png or jpeg on make_logo only if they want a raster logo to share.
- Do not claim durable memory unless search_knowledge returned hits or knowledge snippets are attached below.
- Only use inspect_canvas_graph when a canvas snapshot is attached for a node-graph question.
- Prefer short, structured answers. Lead with the conclusion or list, then brief supporting notes.
- If a tool fails or a host is blocked, say so clearly and suggest adding the host to RESEARCH_FETCH_HOSTS or enabling RESEARCH_OPEN_FETCH=1.
- Do not claim you browsed the live web unless fetch_url succeeded.
- When listing people from the canvas, use: Name :: CRD# 1234567
- Keep answers concise.

${canvasLine}${knowledgeBlock}`;
}

export type ResearchAgentResult = {
	ok: boolean;
	model: string;
	answer: string;
	messages: OllamaChatMessage[];
	toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
	route?: ResearchRouteDecision | null;
	workerTraces?: Array<{
		id: string;
		role: string;
		model: string;
		answer: string;
		toolTrace: ResearchAgentResult['toolTrace'];
	}>;
	canvas?: { source?: string; nodeCount?: number; linkCount?: number } | null;
	knowledge?: { retrieved?: number; projectId?: string | null } | null;
	error?: string;
};
async function runToolAgentLoop(options: {
	model: string;
	question: string;
	history: OllamaChatMessage[];
	maxRounds: number;
	useTools: boolean;
	canvasSnapshot: CanvasSnapshot | null;
	aboutNodeGraph: boolean;
	projectId?: string | null;
	knowledgeSnippets?: string;
	workerFocus?: string;
	priorContext?: string;
}): Promise<{
	ok: boolean;
	answer: string;
	messages: OllamaChatMessage[];
	toolTrace: ResearchAgentResult['toolTrace'];
	error?: string;
}> {
	const userContent =
		options.priorContext
			? `${options.question}\n\n---\nPrior worker findings (use as evidence; do not invent beyond this + tools):\n${options.priorContext}`
			: options.question;

	const messages: OllamaChatMessage[] = [
		{
			role: 'system',
			content: buildSystemPrompt(
				options.canvasSnapshot,
				options.aboutNodeGraph,
				options.workerFocus,
				options.knowledgeSnippets,
			),
		},
		...options.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content),
		{ role: 'user', content: userContent },
	];
	const toolTrace: ResearchAgentResult['toolTrace'] = [];
	const toolContext = {
		canvasSnapshot: options.canvasSnapshot,
		projectId: options.projectId,
	};

	try {
		for (let round = 0; round < options.maxRounds; round++) {
			const { message } = await ollamaChat({
				model: options.model,
				messages,
				tools: options.useTools ? RESEARCH_TOOL_DEFINITIONS : undefined,
			});
			messages.push(message);

			const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			if (!toolCalls.length || !options.useTools) {
				return {
					ok: true,
					answer: assistantMessageText(message) || '(empty model response)',
					messages,
					toolTrace,
				};
			}

			for (const call of toolCalls) {
				const toolName = String(call?.function?.name || '').trim();
				const args = normalizeToolCallArguments(call?.function?.arguments);
				const ran = await runResearchTool(toolName, args, toolContext);
				toolTrace.push({ tool: toolName, args, result: ran.result });
				messages.push({
					role: 'tool',
					tool_name: toolName,
					content: stringifyToolResultForModel(ran.result),
				});
			}
		}
		return {
			ok: true,
			answer:
				'I hit the tool-round limit before a final answer. Check the tool trace and ask a more specific follow-up.',
			messages,
			toolTrace,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			answer: '',
			messages,
			toolTrace,
			error: message,
		};
	}
}

async function mergeWorkerAnswers(options: {
	question: string;
	mergeModel: string;
	workers: Array<{ id: string; role: string; model: string; answer: string }>;
}): Promise<{ ok: boolean; answer: string; error?: string }> {
	const blocks = options.workers
		.map((w, i) => `### Worker ${i + 1} (${w.id}, role=${w.role}, model=${w.model})\n${w.answer || '(empty)'}`)
		.join('\n\n');
	try {
		const { message } = await ollamaChat({
			model: options.mergeModel,
			messages: [
				{
					role: 'system',
					content: `You merge specialist worker answers into one final reply for a local research assistant.
Rules:
- Prefer concrete tool facts (URLs fetched, quotes, numbers, dates) over speculation.
- Resolve conflicts explicitly; if workers disagree, say so and prefer tool-backed claims.
- Do not invent citations absent from the worker findings.
- Keep the answer concise. Lead with the conclusion or list, then brief notes.`,
				},
				{
					role: 'user',
					content: `Original question:\n${options.question}\n\nWorker findings:\n${blocks}\n\nWrite the final merged answer.`,
				},
			],
		});
		return { ok: true, answer: assistantMessageText(message) || '(empty merge response)' };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, answer: '', error: message };
	}
}

/**
 * Lightweight claim check with bespoke-minicheck (or similar). Appends a short
 * "Fact-check" note when the specialist flags unsupported claims; never replaces
 * the primary answer on failure.
 */
async function maybeFactCheckAnswer(options: {
	question: string;
	answer: string;
	factCheckModel?: string | null;
	toolTrace?: ResearchAgentResult['toolTrace'];
}): Promise<string> {
	const model = String(options.factCheckModel || '').trim();
	const answer = String(options.answer || '').trim();
	if (!model || !answer || answer.startsWith('(empty')) return options.answer;

	const evidence = (options.toolTrace || [])
		.slice(0, 6)
		.map((t) => {
			const body = JSON.stringify(t.result);
			return `- ${t.tool}: ${body.slice(0, 500)}`;
		})
		.join('\n');

	try {
		const { message } = await ollamaChat({
			model,
			numCtx: 8192,
			messages: [
				{
					role: 'system',
					content: `You are a strict fact-check specialist. Given a question, a draft answer, and optional tool evidence, reply with ONLY:
SUPPORTED — if key claims are backed by the evidence or are clearly general knowledge appropriate to the question
UNSUPPORTED: <one short sentence> — if important claims lack evidence or contradict the tools
MIXED: <one short sentence> — if partly supported
Do not rewrite the answer. Do not invent new facts.`,
				},
				{
					role: 'user',
					content: `Question:\n${options.question}\n\nDraft answer:\n${answer.slice(0, 4000)}\n\nTool evidence:\n${evidence || '(none)'}\n\nVerdict:`,
				},
			],
		});
		const verdict = assistantMessageText(message).trim();
		if (!verdict) return options.answer;
		if (/^SUPPORTED\b/i.test(verdict)) return options.answer;
		return `${options.answer}\n\n_Fact-check (${model}):_ ${verdict}`;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[factcheck] skipped', message);
		return options.answer;
	}
}

export async function runResearchAgent(options: {
	question: string;
	model?: string;
	history?: OllamaChatMessage[];
	maxRounds?: number;
	availableModels?: string[];
	canvasSnapshot?: CanvasSnapshot | null;
	aboutNodeGraph?: boolean;
	projectId?: string | null;
	ragAuto?: boolean;
	knowledgeSnippets?: string;
}): Promise<ResearchAgentResult> {
	const requested = String(options.model || RESEARCH_AUTO_MODEL).trim() || RESEARCH_AUTO_MODEL;
	const route = await routeResearchModel({
		question: options.question,
		availableModels: options.availableModels,
		forceModel: requested === RESEARCH_AUTO_MODEL ? null : requested,
	});
	const maxRounds = Math.max(1, Math.min(8, options.maxRounds ?? 5));
	const history = Array.isArray(options.history) ? options.history : [];
	const aboutNodeGraph = Boolean(options.aboutNodeGraph);
	const canvasSnapshot =
		aboutNodeGraph && options.canvasSnapshot && typeof options.canvasSnapshot === 'object'
			? options.canvasSnapshot
			: null;
	const canvasMeta =
		canvasSnapshot && canvasSnapshot.nodeCount > 0
			? {
					source: canvasSnapshot.source,
					nodeCount: canvasSnapshot.nodeCount,
					linkCount: canvasSnapshot.linkCount,
				}
			: null;
	let projectId = options.projectId ? String(options.projectId).trim() : null;
	if (!projectId) {
		try {
			projectId = ensureDefaultProject().id;
		} catch {
			projectId = null;
		}
	}

	const ragAuto =
		options.ragAuto === true ||
		(options.ragAuto !== false && process.env.RESEARCH_RAG_AUTO === '1');

	let knowledgeSnippets = options.knowledgeSnippets?.trim() || undefined;
	let retrievedCount = 0;
	if (!knowledgeSnippets && ragAuto && projectId) {
		try {
			const topK = Math.max(1, Math.min(12, Number(process.env.RESEARCH_RAG_TOP_K) || 8));
			const hits = await retrieve(options.question, { projectId, limit: topK });
			retrievedCount = hits.length;
			// Larger budget so Bryan filing notes can include full field lists in answers.
			knowledgeSnippets = formatSnippetsForPrompt(hits, { maxChars: 8000 }) || undefined;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('[knowledge] auto-retrieve failed', message);
		}
	}

	const knowledgeMeta = {
		retrieved: retrievedCount,
		projectId,
	};

	if (!String(options.question || '').trim()) {
		return {
			ok: false,
			model: route.model || DEFAULT_RESEARCH_MODEL,
			answer: '',
			messages: [],
			toolTrace: [],
			route,
			canvas: canvasMeta,
			knowledge: knowledgeMeta,
			error: 'question required',
		};
	}

	const workers: ResearchWorkerPlan[] =
		route.pipeline === 'multi' && Array.isArray(route.workers) && route.workers.length >= 2
			? route.workers.slice(0, 2)
			: [];

	if (!workers.length) {
		const model = route.model || DEFAULT_RESEARCH_MODEL;
		const ran = await runToolAgentLoop({
			model,
			question: options.question,
			history,
			maxRounds,
			useTools: true,
			canvasSnapshot,
			aboutNodeGraph,
			projectId,
			knowledgeSnippets,
		});
		const shouldCheck =
			ran.ok &&
			Boolean(route.factCheckModel) &&
			(route.pipeline === 'multi' || shouldHeuristicMulti(options.question) || /compar|analy|explain why|versus|pros and cons/i.test(options.question));
		const answer = shouldCheck
			? await maybeFactCheckAnswer({
					question: options.question,
					answer: ran.answer,
					factCheckModel: route.factCheckModel,
					toolTrace: ran.toolTrace,
				})
			: ran.answer;
		return {
			ok: ran.ok,
			model,
			answer,
			messages: ran.messages,
			toolTrace: ran.toolTrace,
			route,
			canvas: canvasMeta,
			knowledge: knowledgeMeta,
			error: ran.error,
		};
	}

	const workerTraces: NonNullable<ResearchAgentResult['workerTraces']> = [];
	const allToolTrace: ResearchAgentResult['toolTrace'] = [];
	let prior = '';
	let lastMessages: OllamaChatMessage[] = [];

	for (const worker of workers) {
		const ran = await runToolAgentLoop({
			model: worker.model,
			question: options.question,
			history,
			maxRounds: worker.useTools ? maxRounds : Math.min(3, maxRounds),
			useTools: worker.useTools,
			canvasSnapshot,
			aboutNodeGraph,
			projectId,
			knowledgeSnippets,
			workerFocus: worker.focus,
			priorContext: prior || undefined,
		});
		workerTraces.push({
			id: worker.id,
			role: worker.role,
			model: worker.model,
			answer: ran.answer || ran.error || '',
			toolTrace: ran.toolTrace,
		});
		allToolTrace.push(...ran.toolTrace.map((t) => ({ ...t, args: { ...t.args, _worker: worker.id } })));
		lastMessages = ran.messages;
		prior = [prior, `## ${worker.id} (${worker.role} / ${worker.model})\n${ran.answer || ran.error || ''}`]
			.filter(Boolean)
			.join('\n\n');
	}

	const mergeModel = route.mergeModel || route.model || DEFAULT_RESEARCH_MODEL;
	const merged = await mergeWorkerAnswers({
		question: options.question,
		mergeModel,
		workers: workerTraces.map((w) => ({
			id: w.id,
			role: w.role,
			model: w.model,
			answer: w.answer,
		})),
	});

	if (!merged.ok) {
		const fallbackAnswer = workerTraces.map((w) => `### ${w.role} (${w.model})\n${w.answer}`).join('\n\n');
		return {
			ok: Boolean(fallbackAnswer.trim()),
			model: mergeModel,
			answer: fallbackAnswer || '',
			messages: lastMessages,
			toolTrace: allToolTrace,
			route,
			workerTraces,
			canvas: canvasMeta,
			knowledge: knowledgeMeta,
			error: merged.error,
		};
	}

	const checked = await maybeFactCheckAnswer({
		question: options.question,
		answer: merged.answer,
		factCheckModel: route.factCheckModel,
		toolTrace: allToolTrace,
	});

	return {
		ok: true,
		model: mergeModel,
		answer: checked,
		messages: lastMessages,
		toolTrace: allToolTrace,
		route,
		workerTraces,
		canvas: canvasMeta,
		knowledge: knowledgeMeta,
	};
}
