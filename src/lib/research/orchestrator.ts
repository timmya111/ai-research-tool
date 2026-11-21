import {
	DEFAULT_RESEARCH_MODEL,
	filterFreeLocalOllamaModels,
	getOllamaBaseUrl,
	ollamaChat,
	ollamaTags,
	PREFERRED_CHAT_MODELS,
	PREFERRED_FACTCHECK_MODELS,
	PREFERRED_REASON_MODELS,
	PREFERRED_ROUTER_MODELS,
	PREFERRED_TOOLS_MODELS,
	resolveInstalledModel,
} from '@/lib/research/ollama';

export const RESEARCH_AUTO_MODEL = 'auto';

/** Models that are free/local but not useful as the chat+tools worker. */
const NON_CHAT_MODEL_RE = /(embed|nomic-embed|whisper|tts|clip|minicheck)/i;

export type ResearchWorkerRole = 'tools' | 'reason' | 'fetch' | 'critique';

export type ResearchWorkerPlan = {
	id: string;
	role: ResearchWorkerRole;
	model: string;
	focus: string;
	useTools: boolean;
};

export type ResearchRouteDecision = {
	mode: 'auto' | 'manual';
	/** Primary model (single path, or merge/first worker for display). */
	model: string;
	reason: string;
	routerModel?: string;
	candidates: string[];
	pipeline?: 'single' | 'multi';
	workers?: ResearchWorkerPlan[];
	mergeModel?: string;
	/** Optional post-answer fact-check model (e.g. bespoke-minicheck). */
	factCheckModel?: string | null;
};

const TOOLISH_RE =
	/\b(fetch|url|http|https|lookup|look up|search|scrape|read (the )?page|open (the )?link|source|cite|citation|document|pdf|api|crd|brokercheck|adviserinfo|finra|sidecar|employment history|registration history|firm connections|roster|connections for)\b/i;
const HARD_RE =
	/\b(compar|analy[sz]e|explain why|synthesize|multi[- ]step|strategy|cross[- ]ref|reconcile|debate|summarize (all|everything)|complex|versus|vs\.?|pros and cons|trade-?offs?)\b/i;
const URL_RE = /https?:\/\/[^\s]+/i;
/** Local Bryan / knowledge / chart questions need tools even when phrased analytically. */
const LOCAL_DATA_RE =
	/\b(bryan|filing|filings|mortgage|\bmtg\b|warranty deed|\bwd\b|grantor|grantee|chart|okcounty|recorded|instrument|book\/pages|knowledge store|search_knowledge|chart_filings|seismic|earthquake|earthquakes|comcat|usgs|oklahoma quake|texas quake|magnitude|\bm[2-9](\.\d)?\b|tornado|tornadoes|tornadic|\bef[0-5]\b|\befu\b|spc|ncei|storm events)\b/i;

export function isResearchChatModel(name: string): boolean {
	const n = String(name || '').trim();
	if (!n) return false;
	if (NON_CHAT_MODEL_RE.test(n)) return false;
	return true;
}

export function listAutoChatCandidates(installed: string[]): string[] {
	const free = filterFreeLocalOllamaModels(installed).filter(isResearchChatModel);
	const prefer = [...PREFERRED_CHAT_MODELS];
	const ordered = [...prefer.filter((m) => free.includes(m)), ...free.filter((m) => !prefer.includes(m))];
	return ordered;
}

function pickAvailable(candidates: string[], preferred: readonly string[], fallback: string): string {
	for (const p of preferred) {
		const resolved = resolveInstalledModel(p, candidates);
		if (resolved) return resolved;
	}
	return candidates[0] || fallback;
}

function toolsModelOf(candidates: string[]): string {
	return pickAvailable(candidates, PREFERRED_TOOLS_MODELS, DEFAULT_RESEARCH_MODEL);
}

function reasonModelOf(candidates: string[]): string {
	return pickAvailable(candidates, PREFERRED_REASON_MODELS, toolsModelOf(candidates));
}

function factCheckModelOf(installed: string[]): string | null {
	const flag = String(process.env.RESEARCH_FACTCHECK || '1').trim().toLowerCase();
	if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return null;
	const free = filterFreeLocalOllamaModels(installed);
	for (const p of PREFERRED_FACTCHECK_MODELS) {
		const resolved = resolveInstalledModel(p, free);
		if (resolved) return resolved;
	}
	return null;
}

export function shouldHeuristicMulti(question: string): boolean {
	const q = String(question || '');
	if (URL_RE.test(q) && TOOLISH_RE.test(q)) return true;
	if (HARD_RE.test(q) && TOOLISH_RE.test(q)) return true;
	if (HARD_RE.test(q) && URL_RE.test(q)) return true;
	// Analytical Bryan/filing/chart questions need tools+reason, not reason-only.
	if (HARD_RE.test(q) && LOCAL_DATA_RE.test(q)) return true;
	return false;
}

function needsTools(question: string): boolean {
	const q = String(question || '');
	return TOOLISH_RE.test(q) || URL_RE.test(q) || LOCAL_DATA_RE.test(q);
}

function buildMultiPlan(
	question: string,
	candidates: string[],
	reason: string,
	routerModel?: string,
	factCheckModel?: string | null,
): ResearchRouteDecision {
	const toolsModel = toolsModelOf(candidates);
	const reasonModel = reasonModelOf(candidates);
	const hasUrl = URL_RE.test(question);
	const workers: ResearchWorkerPlan[] = [
		{
			id: 'w1',
			role: hasUrl ? 'fetch' : 'tools',
			model: toolsModel,
			focus: hasUrl
				? 'Use tools (including fetch_url) to gather facts from allowlisted URLs and local helpers.'
				: LOCAL_DATA_RE.test(question)
					? 'Use search_knowledge and/or chart_filings for Bryan County / local store facts. Do not invent filings or dates.'
					: 'Use tools to gather exact facts. Do not invent sources or numbers.',
			useTools: true,
		},
		{
			id: 'w2',
			role: 'reason',
			model: reasonModel,
			focus:
				'Using the facts from the tools worker, analyze/compare/cross-check. Flag gaps or conflicts. For fraud/nominee pattern questions: separate observations from interpretation; use caution tiers; do not hard-label shells/fraud without multiple concrete indicators. Do not invent citations.',
			useTools: false,
		},
	];
	return {
		mode: 'auto',
		pipeline: 'multi',
		model: reasonModel,
		mergeModel: reasonModel,
		workers,
		reason,
		routerModel,
		candidates,
		factCheckModel: factCheckModel ?? null,
	};
}

/** Fast deterministic route when the LLM planner is skipped or fails. */
export function heuristicRouteModel(
	question: string,
	candidates: string[],
	factCheckModel?: string | null,
): ResearchRouteDecision {
	const q = String(question || '');
	const toolsModel = toolsModelOf(candidates);
	const reasonModel = reasonModelOf(candidates);
	const fc = factCheckModel ?? null;

	if (shouldHeuristicMulti(q)) {
		return buildMultiPlan(q, candidates, 'heuristic: adaptive multi — tools/fetch + reason + merge', undefined, fc);
	}
	if (HARD_RE.test(q) && !LOCAL_DATA_RE.test(q)) {
		return {
			mode: 'auto',
			pipeline: 'single',
			model: reasonModel,
			reason: 'heuristic: open-ended / analytical question → stronger single model',
			candidates,
			factCheckModel: fc,
		};
	}
	if (needsTools(q)) {
		return {
			mode: 'auto',
			pipeline: 'single',
			model: toolsModel,
			reason: LOCAL_DATA_RE.test(q)
				? 'heuristic: local filing/chart/knowledge question → tools model'
				: 'heuristic: tool / fetch style question → fast single tools model',
			candidates,
			factCheckModel: fc,
		};
	}
	return {
		mode: 'auto',
		pipeline: 'single',
		model: toolsModel,
		reason: 'heuristic: default → fast single tools model',
		candidates,
		factCheckModel: fc,
	};
}

function parseJsonObject(content: string): Record<string, unknown> | null {
	const raw = String(content || '').trim();
	if (!raw) return null;
	const fenced = raw.match(/\{[\s\S]*\}/);
	const slice = fenced ? fenced[0] : raw;
	try {
		const parsed = JSON.parse(slice);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function normalizeWorkerRole(value: unknown): ResearchWorkerRole {
	const r = String(value || '').trim().toLowerCase();
	if (r === 'fetch' || r === 'critique' || r === 'reason' || r === 'tools') return r;
	return 'tools';
}

function sanitizePlannerPlan(
	parsed: Record<string, unknown>,
	question: string,
	candidates: string[],
	routerModel: string,
	factCheckModel: string | null,
): ResearchRouteDecision | null {
	const mode = String(parsed.mode || '').trim().toLowerCase();
	const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : 'planner decision';

	if (mode === 'single') {
		let model =
			resolveInstalledModel(typeof parsed.model === 'string' ? parsed.model : null, candidates) ||
			heuristicRouteModel(question, candidates, factCheckModel).model;
		// Planner sometimes picks a reason-only model for toolish / local-data questions.
		if (needsTools(question) && model === reasonModelOf(candidates) && toolsModelOf(candidates) !== model) {
			model = toolsModelOf(candidates);
		}
		return {
			mode: 'auto',
			pipeline: 'single',
			model,
			reason,
			routerModel,
			candidates,
			factCheckModel,
		};
	}

	if (mode === 'pipeline' || mode === 'multi') {
		const rawWorkers = Array.isArray(parsed.workers) ? parsed.workers : [];
		const workers: ResearchWorkerPlan[] = [];
		for (let i = 0; i < rawWorkers.length && workers.length < 2; i++) {
			const w = rawWorkers[i];
			if (!w || typeof w !== 'object') continue;
			const rec = w as Record<string, unknown>;
			const role = normalizeWorkerRole(rec.role);
			const preferred =
				role === 'reason' || role === 'critique'
					? [String(rec.model || ''), ...PREFERRED_REASON_MODELS]
					: [String(rec.model || ''), ...PREFERRED_TOOLS_MODELS];
			const resolvedPrefs = preferred
				.map((p) => resolveInstalledModel(p, candidates) || p)
				.filter(Boolean);
			const model = pickAvailable(candidates, resolvedPrefs, toolsModelOf(candidates));
			workers.push({
				id: `w${workers.length + 1}`,
				role,
				model,
				focus: String(rec.focus || rec.task || '').trim() || `${role} worker`,
				useTools: rec.useTools === false ? false : role === 'reason' || role === 'critique' ? false : true,
			});
		}
		// Ensure multi plans are tools+reason, not two tools workers.
		if (workers.length === 2 && workers[0]!.useTools && workers[1]!.useTools) {
			workers[1] = {
				id: 'w2',
				role: 'reason',
				model: reasonModelOf(candidates),
				focus:
					'Analyze/compare the tools worker findings. Separate observations from fraud/nominee interpretation; no hard labels without multiple indicators. Do not invent citations.',
				useTools: false,
			};
		}
		if (workers.length < 2) {
			if (shouldHeuristicMulti(question)) {
				return buildMultiPlan(
					question,
					candidates,
					reason || 'planner multi (completed by heuristic)',
					routerModel,
					factCheckModel,
				);
			}
			return {
				mode: 'auto',
				pipeline: 'single',
				model: needsTools(question) ? toolsModelOf(candidates) : reasonModelOf(candidates),
				reason: `${reason} (planner multi incomplete → single)`,
				routerModel,
				candidates,
				factCheckModel,
			};
		}
		const mergeModel =
			resolveInstalledModel(typeof parsed.mergeModel === 'string' ? parsed.mergeModel : null, candidates) ||
			reasonModelOf(candidates);
		return {
			mode: 'auto',
			pipeline: 'multi',
			model: mergeModel,
			mergeModel,
			workers,
			reason,
			routerModel,
			candidates,
			factCheckModel,
		};
	}

	return null;
}

/**
 * Orchestrator planner: adaptive single specialist vs tools/fetch + reason + merge.
 * Caps at 2 workers. Falls back to heuristics if the planner call fails.
 */
export async function routeResearchModel(options: {
	question: string;
	availableModels?: string[];
	forceModel?: string | null;
}): Promise<ResearchRouteDecision> {
	const forced = String(options.forceModel || '').trim();
	if (forced && forced !== RESEARCH_AUTO_MODEL) {
		const installed = options.availableModels?.length
			? options.availableModels
			: (await ollamaTags(getOllamaBaseUrl())).models;
		return {
			mode: 'manual',
			pipeline: 'single',
			model: resolveInstalledModel(forced, installed) || forced,
			reason: 'manual model selection',
			candidates: [resolveInstalledModel(forced, installed) || forced],
			factCheckModel: factCheckModelOf(installed),
		};
	}

	let installed = options.availableModels;
	if (!installed?.length) {
		const tags = await ollamaTags(getOllamaBaseUrl());
		installed = tags.models;
	}
	const candidates = listAutoChatCandidates(installed || []);
	const factCheckModel = factCheckModelOf(installed || []);
	const fallback = heuristicRouteModel(options.question, candidates, factCheckModel);
	const routerModel = pickAvailable(candidates, PREFERRED_ROUTER_MODELS, DEFAULT_RESEARCH_MODEL);

	try {
		const { message } = await ollamaChat({
			model: routerModel,
			messages: [
				{
					role: 'system',
					content: `You are a planner for a local multi-model research agent. Choose ONE path.

Prefer mode "single" for simple lookups, fetches, or short answers.
Use mode "pipeline" only when the question needs both tool facts AND analysis/cross-check (e.g. compare sources, reconcile a pasted URL with claims, multi-part synthesis, compare Bryan filing trends). Max 2 workers.

For Bryan County filings, charts, mortgages, grantor/grantee, or knowledge-store questions: workers[0] must be tools/fetch with useTools true (prefer ornith:latest or granite4.2:8b/qwen3.5:9b). Never answer filing facts without tools.

Worker roles: tools|fetch (useTools true, prefer ornith:latest or qwen3.5:9b/granite4.2/qwen2.5:7b), reason|critique (useTools false, prefer nemotron-3.5-lightning:latest or qwen2.5:14b).
mergeModel should be a strong free model (prefer nemotron-3.5-lightning:latest or qwen2.5:14b). Use exact candidate names from the list.

Reply JSON only, one of:
{"mode":"single","model":"<name>","reason":"<short>"}
{"mode":"pipeline","reason":"<short>","mergeModel":"<name>","workers":[{"role":"tools","model":"<name>","focus":"<task>","useTools":true},{"role":"reason","model":"<name>","focus":"<task>","useTools":false}]}`,
				},
				{
					role: 'user',
					content: `Candidates:\n${candidates.map((m) => `- ${m}`).join('\n')}\n\nQuestion:\n${String(options.question || '').trim()}`,
				},
			],
		});
		const parsed = parseJsonObject(String(message.content || message.thinking || ''));
		if (parsed) {
			const plan = sanitizePlannerPlan(parsed, options.question, candidates, routerModel, factCheckModel);
			if (plan) {
				if (
					plan.pipeline === 'multi' &&
					!shouldHeuristicMulti(options.question) &&
					!HARD_RE.test(options.question)
				) {
					return {
						mode: 'auto',
						pipeline: 'single',
						model: toolsModelOf(candidates),
						reason: `${plan.reason} (adaptive: collapsed multi → single tools)`,
						routerModel,
						candidates,
						factCheckModel,
					};
				}
				return plan;
			}
		}
	} catch {
		/* heuristic fallback */
	}

	return { ...fallback, routerModel };
}
