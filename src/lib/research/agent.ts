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
import {
	runResearchTool,
	selectResearchToolsForQuestion,
} from '@/lib/research/tools';
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
			? `\n${knowledgeSnippets.trim()}\n- Local knowledge snippets are already attached above for this question. Prefer answering from them. Call search_knowledge only for a narrower/refined query, a different project, or when the snippets are clearly insufficient.\n`
			: '';

	return `You are a local AI research assistant running on the developer's machine via Ollama.
You help with research questions: summarizing sources, cross-checking URLs, comparing claims, drafting concise findings, searching a local knowledge store, charting Bryan County filing volume over time, hunting for fraud / possible-fraud *patterns* in filings and name graphs, answering Oklahoma/Texas seismic questions from the USGS ComCat digests in the OK TX Seismic project, answering Oklahoma/Texas tornado questions from NOAA SPC + NCEI digests in the OK TX Tornadoes project, searching local authority initiative timelines (ICE/DHS/DEA/WH EOs), searching entity dossiers (people/orgs/places cross-linked to those events), searching the local YouTube concealment-scrub archive (captions/cards/OCR for channels the user added), searching offline Wikipedia via kiwix-serve when available, and (when enabled) inspecting a FINRA canvas graph snapshot from the live visualizer.
${focusLine}
Rules:
- Use tools for facts when the user pastes a URL or asks you to look something up. Do not invent page contents, quotes, or citations.
- When the user pastes any http(s) URL (page, API, or PDF), call fetch_url with that URL. Open fetch is on by default for public hosts (private/local still blocked). For HTML pages, linked PDFs are downloaded under .data/fetched/pdfs/ and text-extracted (default maxPdfs=20 — enough for USGS pubs with report+plates). If discoveredPdfCount > pdfDownloads length, call fetch_url again with a higher maxPdfs. Prefer extracted PDF text for citations; scanned plates may have empty text but files are still saved.
- Prefer search_knowledge before inventing prior facts from earlier sessions. Empty hits mean no local memory for that query.
- For Oklahoma/Texas earthquakes since 2016 (USGS ComCat M≥2.5 digests), select/search the OK TX Seismic knowledge project. Cite magnitudes, places, times, and USGS URLs from hits only; do not invent event counts.
- For Oklahoma/Texas tornadoes since 2016 (NOAA SPC tracks + NCEI Storm Events narratives), select/search the OK TX Tornadoes knowledge project. Prefer SPC digests for track/EF counts and NCEI digests for county narratives. Cite dates, EF ratings, fatalities, and counties from hits only; do not invent counts.
- For ICE/DHS/DEA/White House EO promo timelines, signed directives, domestic vs international audience, or heavy-focus cities/counties (esp. OK–TX corridor): call search_authority_timelines. Treat hits as source-linked leads; promo framing ≠ verified ops levels. You may also search_knowledge on the Authority Initiatives project for digests.
- For CDC Museum COVID-19 chronology (diseases, variants/strains, vaccines, treatments/therapeutics, pharma companies, named persons, Warp Speed, Remdesivir pricing, CARES/$ funding as worded on the CDC page): call search_cdc_covid_timeline. Use financialsOnly=true for dollar figures; entityType=company|person|vaccine|treatment|variant|disease|org as needed. CDC narrative leads only — not a full pharma P&L. The page does not use the word “superstrain”; map that ask to variants/VOCs.
- For DoD / War.gov Coronavirus Response Timeline (Force Health Protection, vaccine mandates, NORTHCOM/FEMA/DLA support, Warp Speed, DOD vs Federal vs Virus vs Vaccine filters): call search_dod_covid_timeline. Pair with search_cdc_covid_timeline when comparing civilian vs defense narratives. Live war.gov may 403; local corpus is from Wayback.
- For Imperial War Museums (IWM) Timeline of Conflict Since 1914 (36 conflicts from 1899 Boer War through WWI, WWII, Cold War, decolonisation emergencies, Suez, Falklands, Troubles, Gulf, Bosnia, Afghanistan, Iraq, Syria, Ukraine, Yemen, ISIS + 26 full linked IWM history articles): call search_iwm_conflict_timeline (or inspect historic_event:iwm-timeline-of-conflict-since-1914 via get_profile_timeline).
- For New York & Boston financial history, labor/union history, regional conflicts, and Dallas–Fort Worth military/defense/industrial tech companies (Bell Textron, Halliburton, Rockwell Collins / Collins Aerospace, Emerson Electric, Tubacex, Lockheed Martin, Air Force Plant 4, Texas Instruments, Vought/LTV, L3Harris/E-Systems, RTX, General Dynamics + SEC EDGAR CIKs/former names): call search_regional_history (or search_profiles / get_profile_timeline on the corresponding historic_event/firm profiles).
- For prior Gemini / Google Takeout chats the user imported under .data/gemini-qa: call search_gemini_qa (and/or search_knowledge on project “Gemini Q&A”). Empty corpus usually means Takeout only had empty Gemini stubs — need My Activity→Gemini Apps or chat JSON/MD re-import.
- For people/org/place dossiers (Karp, Thiel, Vance, Palantir, Halliburton, Rockefeller hub, Campion Trail, alias buckets, etc.) and entity↔authority edges: call search_entity_dossiers. Do not invent conspiracy links; cite dossier evidence URLs/notes only. Alias buckets stay candidate until pinned.
- For cross-source entity alignment across ALL local corpora (people, firms, education, non-profits, medical hospitals, government, and historic events): call search_profiles to find unified profiles and their links; call enrich_profile to research and fill missing details from local offline Wikipedia, FINRA BrokerCheck (by CRD), county deeds/Research Drive, and Bryan County UCC filings (strictly validated: NEVER merges name-only matches — holds uncorroborated matches as possible_match_name_only notes until validated by address, firm, military base, institution, or identifier); call get_profile_timeline on a historic_event or actor to compare multiple source angles and surface chronological timeline gaps with cross-source gap-fill leads; call find_profile_alignments to inspect candidate cross-corpus matches. Always respect caution tiers (observation / closer_look / stronger_indicator) and treat proposed alignments & possible_match_name_only notes as leads to verify, not proven conclusions.
- When the user pastes founding/start dates, end/status, merger/predecessor history, address/HQ, EIN/URL, or asks to add/save/update firms (or other entities) into the app Profiles data: call upsert_profile for each entity (search_profiles first to reuse existing slugs). On the FIRST call include everything available from the paste in one shot: startDate/endDate, summary, aliases, locations (raw street + role hq|associated), identifiers (irs_ein, url, …), and links (owned_by subsidiary→parent; business_tie for predecessor/successor/merger with a clear roleLabel). Use endDate="" to clear a wrong end on still-active firms. For follow-up detail fills, pass slug=firm:… and omit name when the display name contains & or other XML-special characters (Ollama tool XML breaks on unescaped &). Phone / registered agent go in summary or metadata (no phone identifier scheme). Then briefly confirm created/updated slugs and UI paths. Use enrich_profile afterward only when they want Wikipedia/BrokerCheck research on an existing card.
- For encyclopedia background from the local offline English Wikipedia ZIM: call search_wikipedia (kiwix-serve on :8765). If the tool says the ZIM is still downloading or the server is down, say so — do not invent article text.
- For YouTube videos the user added to this app (ControlAltHistory, MindUnveiled, eyes_wideopen, dig.archaeology, FRESHboosters, PhilipThompson, HiddenAmuraKa, UTDGeoscienceStudio, TheMysteryAbyss, Fall of Civilizations, Timeline World History, EpicHistoryTV, History Matters, Global History Scope, Dr. Joanne Freeman, Ancient Lives, Silk Road Asian History, Spark, Ottoman History, History’s Mysteries WWI doc, The Great War, Old Britannia, History Mapped Out, Interesting Books Reviewed, questions playlist, Athens Unveiled, deep SCRUB-01…05): call search_concealment_scrubs. For timeline / chronology / “years mentioned” questions, pass timelinesOnly=true (and limit≥2). Prefer deep SCRUB cards when present. Quote timeline tables from the tool excerpts; label them as narration/OCR leads, not verified facts. Never claim you lack YouTube access when this local archive exists — do not fall back to Bryan County filings for video questions.
- For Texas Trinity Aquifer / TWDB groundwater PDFs (GAMs, advisories, GMPs, water levels): call search_twdb_trinity (and/or search_knowledge on project “TWDB Trinity Aquifer”). Do not stall asking A/B/C/D download options when the user already wants the full corpus organized for retrieval — assume local corpus build is the path; report progress from tool errors if not ready yet.
- For International Society for Digital Earth / digitalearth-isde.org / Big Earth Data / ISDE lectures: call search_digital_earth (pages, PDFs, data-layer refs, videos with English transcripts). Prefer transcript.en excerpts for speech content.
- For Petersburg Quantum Weeks / pqw.itmo.ru / PQW 2026 / ITMO quantum school/conference: call search_pqw_itmo (EN/RU pages, speakers, program PDFs, Book of Abstracts).
- For META 2025 / metaconferences.org/META25 / metamaterials Malaga 2025: call search_meta25 (pages, proceedings/program PDFs, plenaries, META 2025 videos). Do not use it for META 2026/2027 promo.
- For Physics Congress 2026 / physics-congress.kz / Nazarbayev University Astana / ISOS2026 / Dynamics Days / Kazakh Physical Society meeting: call search_physics_congress.
- For FINRA/SEC identity (person/firm/CRD) across the full corpus: call search_finra_sidecar (prod flat-file search index). That is the always-on name/CRD index — not limited to the on-screen canvas. Firm CRDs and Individual CRDs are different: the same digits can be a firm (e.g. 288811 = Florida Financial Advisors on dashboard/firm/288811) or a person. Numeric CRD queries probe /api/finra/merged/firm/{crd} and /api/finra/merged/individual/{crd} separately; report hits with entity/crdKind and “Firm CRD#” vs “Individual CRD#”. Never treat a firm CRD as a person or call lookup_brokercheck on a firm CRD.
- For deeper BrokerCheck/AdviserInfo detail (exams, disclosures, or when sidecar is thin): call lookup_brokercheck with the numeric INDIVIDUAL (person) CRD only. Do this even when "Question about node graph" is unchecked — that checkbox is only for the live canvas snapshot. Always list firms from the tool employments array; do not invent empty Employments when the tool returned firms.
- For firm rosters / all broker CRD connections / people at a firm: call lookup_firm_connections with the Firm CRD (e.g. ROCKEFELLER FINANCIAL LLC :: Firm CRD# 291361 → firmCrd=291361; Florida Financial Advisors :: Firm CRD# 288811). Query the live visualizer API — never tell the user to open the live graph for this. Prefer bucket=current unless they ask for previous/all. List people as Name :: Individual CRD#. If the roster is large, report totals, show the returned page, and point to fullRosterMarkdown / fullRosterJson for the complete list (or paginate with offset).
- For name-pattern / crosswalk questions linking FINRA/SEC CRDs to Bryan deeds or unclaimed-property-style parties: call search_finra_sidecar for CRD identity; optionally use inspect_canvas_graph when a canvas is attached for on-graph context; then search_knowledge for grantor/grantee and unclaimed/nominee-like strings. Report Name :: CRD# beside matching instruments; never invent CRDs or filings.
- When the user asks for a chart, trend, volume over a period, monthly/weekly/daily counts, or document-type breakdown of Bryan County filings, call chart_filings (default PNG for easy online sharing; format=jpeg if they ask for JPG). Embed the returned imageUrl as markdown ![title](imageUrl) and summarize the top buckets in text.
- When the user asks for a logo or vector mark, call make_logo (default SVG). Use format=png or jpeg on make_logo only if they want a raster logo to share.
- Do not claim durable memory unless search_knowledge returned hits or knowledge snippets are attached below.
- Only use inspect_canvas_graph when a canvas snapshot is attached for a node-graph question.
- Prefer short, structured answers. Lead with observations, then brief notes.
- If a tool fails or a host is blocked, say so clearly. Private hosts need RESEARCH_FETCH_HOSTS; open fetch can be disabled with RESEARCH_OPEN_FETCH=0.
- Do not claim you browsed the live web unless fetch_url succeeded.
- When listing people from the canvas, use: Name :: CRD# 1234567
- Keep answers concise.

Fraud / anomaly pattern rules (critical):
- DO actively look for possible fraud, concealment, nominee/shell, straw-party, circular transfer, unclaimed-property, or CRD↔deed anomalies when the user asks about patterns, shells, nominees, fraud, or crosswalks.
- Separate (1) raw observations (instrument, type, parties, dates, counts, URLs) from (2) interpretation.
- Label findings with caution tiers — never jump to a hard verdict from thin evidence:
  • Observation — factual pattern only (e.g. "Name X appears on N instruments").
  • Worth a closer look — unusual but explainable (e.g. many UCCs from a known lender brand; family *Oil Holdings* LLCs on a trustee deed; restaurant LLC buying property).
  • Stronger indicators — clearer red flags with multiple concrete signals (e.g. numbered/address-mill LLCs repeating across unrelated tracts; "as trustee" with no named trust; same grantor=grantee loops plus rapid flips; same string on deeds and unclaimed-property/CRD contexts with no benign explanation in the hits).
- Do NOT call parties "shells", "nominees", "fraudulent", or "mills" unless stronger indicators are present in the retrieved hits. An LLC name alone, oil & gas lessee names, operating businesses, or high-volume secured lenders (e.g. GoodLeap-style UCC filers) are NOT proof of a shell.
- Stay inside the requested document types when the user limits them (e.g. WD/QCD/MTG). If you use other types, say so explicitly.
- Prefer counts and repeated instruments over vibes. Cite instrument IDs and detail URLs. Say what would be needed to upgrade a "closer look" item (SOS formation data, shared addresses, canvas CRD match, unclaimed-ad text, etc.).
- Never invent filings, CRDs, or fraud. If evidence is thin, say "insufficient to conclude" and stop.

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

	const activeTools = options.useTools
		? selectResearchToolsForQuestion(options.question, options.aboutNodeGraph)
		: undefined;

	const xmlToolHint =
		'Your previous tool call failed Ollama XML parsing (often an unescaped & in a parameter). Retry the tool call: prefer slug=firm:… and omit name when it contains &; put street addresses in locations[].raw and EIN/URL in identifiers[]; put phone in summary/metadata.';

	try {
		let xmlRetries = 0;
		for (let round = 0; round < options.maxRounds; round++) {
			let message: OllamaChatMessage;
			try {
				({ message } = await ollamaChat({
					model: options.model,
					messages,
					tools: activeTools,
				}));
			} catch (chatErr: unknown) {
				const errText = chatErr instanceof Error ? chatErr.message : String(chatErr);
				const isXml =
					/XML syntax error/i.test(errText) ||
					(/element\s*<function>/i.test(errText) && /parameter/i.test(errText));
				if (isXml && xmlRetries < 2 && options.useTools) {
					xmlRetries += 1;
					messages.push({ role: 'user', content: xmlToolHint });
					round -= 1;
					continue;
				}
				throw chatErr;
			}
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

		// Rounds exhausted while the model still wanted tools — force one final
		// no-tools synthesis from whatever evidence is already in the thread.
		const synthesizeHint =
			toolTrace.length > 0
				? `You have used all ${options.maxRounds} tool rounds. Do NOT call any more tools. Using only the tool results already in this conversation, write a clear final answer to the user's question. Cite concrete evidence from those results. If evidence is incomplete, say what you found and what is still missing.`
				: `You have used all ${options.maxRounds} tool rounds without usable tool results. Do NOT call any more tools. Answer from what you already know in this conversation, and clearly say what you could not verify.`;
		messages.push({ role: 'user', content: synthesizeHint });
		try {
			const { message: finalMessage } = await ollamaChat({
				model: options.model,
				messages,
				// Explicitly omit tools so the model must produce prose.
			});
			messages.push(finalMessage);
			const synthesized = assistantMessageText(finalMessage).trim();
			if (synthesized) {
				return {
					ok: true,
					answer: synthesized,
					messages,
					toolTrace,
				};
			}
		} catch (synthErr: unknown) {
			const synthText = synthErr instanceof Error ? synthErr.message : String(synthErr);
			console.error('[agent] synthesize-on-limit failed', synthText);
		}

		const fallbackBits = toolTrace
			.slice(0, 6)
			.map((t) => {
				const preview = stringifyToolResultForModel(t.result).slice(0, 400);
				return `- ${t.tool}: ${preview}`;
			})
			.join('\n');
		return {
			ok: true,
			answer:
				toolTrace.length > 0
					? `Tool-round limit reached after ${options.maxRounds} rounds; synthesis also failed. Partial tool evidence:\n${fallbackBits}\n\nAsk a more specific follow-up, or raise RESEARCH_AGENT_MAX_ROUNDS.`
					: 'I hit the tool-round limit before a final answer. Check the tool trace and ask a more specific follow-up.',
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
- Prefer concrete tool facts (URLs fetched, quotes, numbers, dates, instrument IDs) over speculation.
- Resolve conflicts explicitly; if workers disagree, say so and prefer tool-backed claims.
- Do not invent citations absent from the worker findings.
- For fraud / nominee / shell / pattern questions: keep observation vs interpretation separate. Use caution tiers (observation / worth a closer look / stronger indicators). Do not hard-label shells, nominees, or fraud unless multiple concrete indicators appear in the worker findings.
- Keep the answer concise. Lead with the strongest evidenced list, then brief caveats.`,
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
SUPPORTED — if key factual claims (instruments, parties, dates, counts) are backed by the evidence
UNSUPPORTED: <one short sentence> — if important claims lack evidence, contradict the tools, or hard-label fraud/shell/nominee without clear indicators in the evidence
MIXED: <one short sentence> — if facts are partly supported but interpretive labels overreach
Treat "shell", "nominee", "fraudulent", and "mill" as claims that need stronger multi-signal evidence, not LLC-looking names alone.
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
	const envDefault = Number(process.env.RESEARCH_AGENT_MAX_ROUNDS);
	const defaultRounds =
		Number.isFinite(envDefault) && envDefault > 0 ? Math.floor(envDefault) : 8;
	// Soft default 8; hard cap 12 (was 5 / 8). Env RESEARCH_AGENT_MAX_ROUNDS overrides default.
	const maxRounds = Math.max(1, Math.min(12, options.maxRounds ?? defaultRounds));
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
