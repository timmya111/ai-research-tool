'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import KnowledgePanel from '@/components/KnowledgePanel';
import ThemeToggle from '@/components/ThemeToggle';
import type { CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { parseCanvasSnapshotJson } from '@/lib/research/canvasSnapshot';
import {
	captureCanvasSnapshotForResearch,
	formatCanvasInfo,
	openLiveFinraGraphWindow,
} from '@/lib/research/captureCanvasSnapshotClient';
import { getFinraAppOrigin } from '@/lib/research/finraApp';
import { filterFreeLocalOllamaModels } from '@/lib/research/ollama';
import { RESEARCH_AUTO_MODEL } from '@/lib/research/orchestrator';

type ChatTurn = {
	role: 'user' | 'assistant';
	content: string;
	/** Assistant turns: paired user question for per-turn Save */
	question?: string;
	toolTrace?: unknown[];
	/** Server-rendered chart image URLs from chart_filings */
	chartUrls?: string[];
	saved?: boolean;
	saving?: boolean;
};

type StatusPayload = {
	ok: boolean;
	baseUrl?: string;
	defaultModel?: string;
	models?: string[];
	error?: string | null;
	knowledge?: {
		ok?: boolean;
		restricted?: boolean;
		path?: string;
		documentCount?: number;
		chunkCount?: number;
		projectCount?: number;
		embedModel?: string;
		embedModelInstalled?: boolean;
		needsReindex?: boolean;
		error?: string | null;
	};
};

const BRYAN_PROJECT_NAME = 'Bryan County';

/** Default chips focused on OKCountyRecords Bryan filings stored in local knowledge. */
const BRYAN_EXAMPLES = [
	{
		label: 'Latest filings (full fields)',
		question:
			'Using only the Bryan County knowledge store, list the 8 most recent Bryan County filings. For each filing, show the full details: instrument, type, county, recorded date, instrument date, grantor, grantee, book, pages, legal description, filing fees, mortgage amount, consideration, image count, record id, and detail URL.',
	},
	{
		label: 'Mortgages to Vision Bank',
		question:
			'Using only the Bryan County knowledge store, find MTG (mortgage) filings where the grantee is VISION BANK. For each match, show the full filing details: instrument, type, recorded date, grantor, grantee, book, pages, legal description, images, and detail URL.',
	},
	{
		label: 'Warranty deeds (WD)',
		question:
			'Using only the Bryan County knowledge store, find recent WD (warranty deed) filings. For each, display the full details: instrument, type, recorded date, grantor, grantee, book, pages, legal description, consideration, images, and detail URL.',
	},
	{
		label: 'Lookup instrument I-2026-790823',
		question:
			'Using only the Bryan County knowledge store, look up instrument I-2026-790823 and display every stored field in full: instrument, type, county, recorded date, instrument date, grantor, grantee, book, pages, legal description, filing fees, mortgage amount, consideration, images, record id, scraped time, and detail URL.',
	},
	{
		label: 'Search a grantor name',
		question:
			'Using only the Bryan County knowledge store, search filings involving grantor WESTSIDE BAPTIST CHURCH (or similar). For each hit, show the complete filing details: instrument, type, recorded, grantor, grantee, book, pages, legal, images, and detail URL.',
	},
	{
		label: 'How many Bryan docs?',
		question:
			'Using only the Bryan County knowledge store, summarize what kinds of Bryan County document types are present (MTG, WD, REL MTG, UCC, etc.) and give 3 example filings with full details each (instrument, type, recorded, grantor, grantee, book, pages, legal, detail URL).',
	},
	{
		label: 'Chart: filings by month',
		question:
			'Create a chart of Bryan County filing volume by month for all stored recorded dates. Call chart_filings with kind=volume and period=month, embed the image, and briefly summarize the busiest months.',
	},
	{
		label: 'Chart: filings by type',
		question:
			'Create a chart breaking down Bryan County filings by document type (MTG, WD, REL MTG, etc.). Call chart_filings with kind=by_type, embed the image, and list the top types with counts.',
	},
	{
		label: 'Chart: MTG by month',
		question:
			'Create a monthly chart of Bryan County MTG (mortgage) filings only. Call chart_filings with kind=volume, period=month, docType=MTG, embed the image, and note any volume spikes.',
	},
];

const LS_REMEMBER = 'research.persistChat';
const LS_FETCHES = 'research.persistFetches';
const LS_RAG = 'research.ragAuto';

function extractChartUrls(toolTrace: unknown, answer?: string): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	const push = (raw: unknown) => {
		const u = String(raw || '').trim();
		if (!u || seen.has(u)) return;
		if (!u.startsWith('/api/charts/')) return;
		seen.add(u);
		urls.push(u);
	};
	if (Array.isArray(toolTrace)) {
		for (const entry of toolTrace) {
			if (!entry || typeof entry !== 'object') continue;
			const tool = String((entry as { tool?: string }).tool || '');
			if (tool !== 'chart_filings' && tool !== 'make_logo') continue;
			const result = (entry as { result?: Record<string, unknown> }).result;
			if (!result || typeof result !== 'object') continue;
			push(result.imageUrl);
		}
	}
	const text = String(answer || '');
	const mdRe = /!\[[^\]]*]\((\/api\/charts\/[a-zA-Z0-9_-]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = mdRe.exec(text)) != null) push(m[1]);
	return urls;
}

/** Strip markdown image syntax for charts (shown as <img>) so bubbles stay readable. */
function displayAnswerContent(content: string, chartUrls: string[]): string {
	let text = String(content || '');
	if (chartUrls.length > 0) {
		text = text.replace(/!\[[^\]]*]\(\/api\/charts\/[a-zA-Z0-9_-]+\)\s*/g, '').trim();
	}
	return text;
}

function countSuccessfulFetches(toolTrace: unknown): number {
	if (!Array.isArray(toolTrace)) return 0;
	let n = 0;
	for (const entry of toolTrace) {
		if (!entry || typeof entry !== 'object') continue;
		const tool = String((entry as { tool?: string }).tool || '');
		if (tool !== 'fetch_url') continue;
		const result = (entry as { result?: Record<string, unknown> }).result;
		if (!result || typeof result !== 'object') continue;
		if (result.ok !== true) continue;
		const status = result.status;
		if (typeof status === 'number' && (status < 200 || status >= 400)) continue;
		if (result.body == null) continue;
		n += 1;
	}
	return n;
}

function readFlag(key: string, projectId: string | null): boolean {
	if (!projectId || typeof window === 'undefined') return false;
	try {
		return window.localStorage.getItem(`${key}.${projectId}`) === '1';
	} catch {
		return false;
	}
}

function writeFlag(key: string, projectId: string | null, value: boolean) {
	if (!projectId || typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(`${key}.${projectId}`, value ? '1' : '0');
	} catch {
		/* ignore */
	}
}

export default function ResearchClient() {
	const [status, setStatus] = useState<StatusPayload | null>(null);
	const [autoMode, setAutoMode] = useState(true);
	const [model, setModel] = useState('qwen2.5:7b');
	const [showAdvancedModel, setShowAdvancedModel] = useState(false);
	const [question, setQuestion] = useState('');
	const [history, setHistory] = useState<ChatTurn[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Sticky Q&A panel that fills the viewport above the ask bar. */
	const [chatExpanded, setChatExpanded] = useState(false);
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const [toolTrace, setToolTrace] = useState<unknown[] | null>(null);
	const [lastRoute, setLastRoute] = useState<{
		mode?: string;
		model?: string;
		reason?: string;
		pipeline?: string;
		workers?: Array<{ id?: string; role?: string; model?: string }>;
		mergeModel?: string;
	} | null>(null);
	const [workerTraces, setWorkerTraces] = useState<unknown[] | null>(null);
	const [aboutNodeGraph, setAboutNodeGraph] = useState(false);
	const [canvasInfo, setCanvasInfo] = useState('Canvas: not checked yet');
	const [canvasSnapshot, setCanvasSnapshot] = useState<CanvasSnapshot | null>(null);
	const [pastedJson, setPastedJson] = useState('');
	const [showPaste, setShowPaste] = useState(false);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [persistChat, setPersistChat] = useState(false);
	const [persistFetches, setPersistFetches] = useState(false);
	const [ragAuto, setRagAuto] = useState(false);
	const [knowledgeRefreshToken, setKnowledgeRefreshToken] = useState(0);
	const [fetchToast, setFetchToast] = useState<{
		count: number;
		toolTrace: unknown[];
	} | null>(null);
	const [savingFetches, setSavingFetches] = useState(false);
	const liveWindowRef = useRef<Window | null>(null);

	const preferredModels = useMemo(() => {
		const models = filterFreeLocalOllamaModels(status?.models || []);
		const prefer = ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3.6:latest', 'llama3.2:latest'];
		const ordered = [...prefer.filter((m) => models.includes(m)), ...models.filter((m) => !prefer.includes(m))];
		return ordered.length ? ordered : prefer;
	}, [status]);

	useEffect(() => {
		setPersistChat(readFlag(LS_REMEMBER, projectId));
		setPersistFetches(readFlag(LS_FETCHES, projectId));
		setRagAuto(readFlag(LS_RAG, projectId));
	}, [projectId]);

	const refreshCanvasInfo = useCallback(async () => {
		try {
			const snap = await captureCanvasSnapshotForResearch({
				liveWindow: liveWindowRef.current,
				pastedJson: pastedJson || null,
				previous: canvasSnapshot,
			});
			setCanvasSnapshot(snap);
			setCanvasInfo(formatCanvasInfo(snap));
			return snap;
		} catch {
			setCanvasInfo('Canvas: unavailable');
			return null;
		}
	}, [canvasSnapshot, pastedJson]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/api/status', { cache: 'no-store' });
				const data = (await res.json()) as StatusPayload;
				if (cancelled) return;
				setStatus(data);
				const free = filterFreeLocalOllamaModels(data.models || []);
				if (data.defaultModel && free.includes(data.defaultModel)) setModel(data.defaultModel);
				else if (free.includes('qwen2.5:7b')) setModel('qwen2.5:7b');
				else if (free[0]) setModel(free[0]);
			} catch (e: unknown) {
				if (!cancelled) {
					const message = e instanceof Error ? e.message : String(e);
					setStatus({ ok: false, error: message });
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const connectLiveGraph = useCallback(() => {
		const popup = openLiveFinraGraphWindow();
		liveWindowRef.current = popup;
		setCanvasInfo(`Canvas: connected window → ${getFinraAppOrigin()} (load the graph, then Refresh)`);
	}, []);

	const applyPastedJson = useCallback(() => {
		const parsed = parseCanvasSnapshotJson(pastedJson);
		if (!parsed || parsed.nodeCount <= 0) {
			setError('Paste a valid canvas snapshot JSON (with nodes).');
			return;
		}
		const snap = { ...parsed, source: 'paste' as const };
		setCanvasSnapshot(snap);
		setCanvasInfo(formatCanvasInfo(snap));
		setError(null);
		setShowPaste(false);
	}, [pastedJson]);

	const bumpKnowledge = useCallback(() => {
		window.setTimeout(() => setKnowledgeRefreshToken((n) => n + 1), 2500);
	}, []);

	const ask = useCallback(async (
		overrideQuestion?: string,
		opts?: { projectId?: string | null; ragAuto?: boolean },
	) => {
		const q = String(overrideQuestion ?? question).trim();
		if (!q || busy) return;
		setBusy(true);
		setError(null);
		setToolTrace(null);
		setWorkerTraces(null);
		setLastRoute(null);
		setHistory((prev) => [...prev, { role: 'user', content: q }]);
		setQuestion('');
		try {
			const snap: CanvasSnapshot | null = aboutNodeGraph ? await refreshCanvasInfo() : null;
			if (!aboutNodeGraph) void refreshCanvasInfo();
			const requestedModel = autoMode ? RESEARCH_AUTO_MODEL : model;
			const activeProjectId = opts?.projectId !== undefined ? opts.projectId : projectId;
			const activeRag = opts?.ragAuto !== undefined ? opts.ragAuto : ragAuto;
			const canPersist = Boolean(activeProjectId);
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					question: q,
					model: requestedModel,
					history: history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
					availableModels: status?.models || preferredModels,
					aboutNodeGraph,
					canvasSnapshot: snap,
					projectId: activeProjectId || undefined,
					persistChat: canPersist && persistChat,
					persistFetches: canPersist && persistFetches,
					ragAuto: canPersist ? activeRag : false,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) {
				throw new Error(data?.error || `chat failed (${res.status})`);
			}
			const route = data?.route && typeof data.route === 'object' ? data.route : null;
			setLastRoute(
				route
					? {
							mode: route.mode,
							model: route.model || data.model,
							reason: route.reason,
							pipeline: route.pipeline,
							workers: Array.isArray(route.workers) ? route.workers : undefined,
							mergeModel: route.mergeModel,
						}
					: { mode: autoMode ? 'auto' : 'manual', model: data.model, pipeline: 'single' },
			);
			const trace = Array.isArray(data.toolTrace) ? data.toolTrace : [];
			const answer = String(data.answer || '');
			const chartUrls = extractChartUrls(trace, answer);
			setHistory((prev) => [
				...prev,
				{
					role: 'assistant',
					content: answer,
					question: q,
					toolTrace: trace,
					chartUrls,
					saved: Boolean(data?.knowledge?.persistChat),
				},
			]);
			setToolTrace(trace);
			setWorkerTraces(Array.isArray(data.workerTraces) ? data.workerTraces : null);
			if (data?.knowledge?.persistScheduled) bumpKnowledge();

			const fetchCount = countSuccessfulFetches(trace);
			if (canPersist && !persistFetches && fetchCount > 0) {
				setFetchToast({ count: fetchCount, toolTrace: trace });
			} else {
				setFetchToast(null);
			}
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			setError(message);
			setHistory((prev) => [...prev, { role: 'assistant', content: `Error: ${message}` }]);
		} finally {
			setBusy(false);
		}
	}, [
		aboutNodeGraph,
		autoMode,
		bumpKnowledge,
		busy,
		history,
		model,
		persistChat,
		persistFetches,
		preferredModels,
		projectId,
		question,
		ragAuto,
		refreshCanvasInfo,
		status?.models,
	]);

	const applyBryanExample = useCallback(
		async (exampleQuestion: string) => {
			if (busy) return;
			setError(null);
			let bryanId: string | null = projectId;
			try {
				const res = await fetch('/api/knowledge/projects', { cache: 'no-store' });
				const data = await res.json();
				const list = Array.isArray(data?.projects) ? data.projects : [];
				const bryan = list.find(
					(p: { name?: string }) => String(p?.name || '') === BRYAN_PROJECT_NAME,
				) as { id?: string } | undefined;
				if (bryan?.id) {
					bryanId = bryan.id;
					setProjectId(bryan.id);
					try {
						window.localStorage.setItem('research.activeProjectId', bryan.id);
					} catch {
						/* ignore */
					}
				}
			} catch {
				/* keep current project */
			}
			setRagAuto(true);
			if (bryanId) writeFlag(LS_RAG, bryanId, true);
			await ask(exampleQuestion, { projectId: bryanId, ragAuto: true });
		},
		[ask, busy, projectId],
	);

	const savePendingFetches = useCallback(async () => {
		if (!fetchToast || !projectId || savingFetches) return;
		setSavingFetches(true);
		setError(null);
		try {
			const res = await fetch('/api/knowledge/fetches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId,
					toolTrace: fetchToast.toolTrace,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `save fetches failed (${res.status})`);
			setFetchToast(null);
			setKnowledgeRefreshToken((n) => n + 1);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingFetches(false);
		}
	}, [fetchToast, projectId, savingFetches]);

	const saveTurn = useCallback(
		async (index: number) => {
			const turn = history[index];
			if (!turn || turn.role !== 'assistant' || !turn.question || turn.saved || turn.saving) return;
			if (!projectId) {
				setError('Select a project before saving to the knowledge store.');
				return;
			}
			setHistory((prev) => prev.map((t, i) => (i === index ? { ...t, saving: true } : t)));
			setError(null);
			try {
				const res = await fetch('/api/knowledge/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						projectId,
						question: turn.question,
						answer: turn.content,
						toolTrace: turn.toolTrace || [],
					}),
				});
				const data = await res.json();
				if (!res.ok || !data?.ok) throw new Error(data?.error || `save failed (${res.status})`);
				setHistory((prev) =>
					prev.map((t, i) => (i === index ? { ...t, saving: false, saved: true } : t)),
				);
				setKnowledgeRefreshToken((n) => n + 1);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				setError(message);
				setHistory((prev) => prev.map((t, i) => (i === index ? { ...t, saving: false } : t)));
			}
		},
		[history, projectId],
	);

	const togglesDisabled = !projectId || busy;

	useEffect(() => {
		const el = chatScrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [history, busy, chatExpanded]);

	useEffect(() => {
		if (!chatExpanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setChatExpanded(false);
		};
		window.addEventListener('keydown', onKey);
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prev;
		};
	}, [chatExpanded]);

	const askForm = (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void ask();
			}}
			className="mx-auto flex w-full max-w-[920px] items-end gap-2"
		>
			<textarea
				value={question}
				onChange={(e) => setQuestion(e.target.value)}
				placeholder="Ask about Bryan County filings (grantor, grantee, instrument, legal…)…"
				rows={2}
				disabled={busy}
				className="max-h-40 min-h-[52px] flex-1 resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-2.5 font-[inherit] text-[var(--app-fg)]"
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void ask();
					}
				}}
			/>
			<button
				type="submit"
				disabled={busy || !question.trim()}
				className="min-h-[52px] min-w-[88px] rounded-lg border-none bg-[#F97316] px-3.5 py-2.5 font-semibold text-white disabled:cursor-wait"
			>
				{busy ? 'Working…' : 'Ask'}
			</button>
		</form>
	);

	const chatPanel = (
		<section
			className={
				chatExpanded
					? 'z-40 flex flex-col border-b border-[var(--app-border)]'
					: 'relative mb-3 flex min-h-[280px] flex-col rounded-lg border border-[var(--app-border)]'
			}
			style={
				chatExpanded
					? {
							position: 'fixed',
							top: 0,
							left: 0,
							right: 0,
							bottom: 'calc(5.75rem + env(safe-area-inset-bottom, 0px))',
							zIndex: 40,
							backgroundColor: 'var(--app-bg)',
						}
					: { backgroundColor: 'var(--app-surface)' }
			}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] px-3 py-2">
				<p className="m-0 text-xs font-semibold opacity-80">Q&amp;A</p>
				<button
					type="button"
					onClick={() => setChatExpanded((v) => !v)}
					title={chatExpanded ? 'Exit full-height chat (Esc)' : 'Make chat sticky and full height'}
					aria-pressed={chatExpanded}
					className="cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold"
				>
					{chatExpanded ? 'Exit full height' : 'Full height'}
				</button>
			</div>
			<div
				ref={chatScrollRef}
				className="flex flex-col gap-3 overflow-y-auto px-3 py-3"
				style={
					chatExpanded
						? { flex: '1 1 auto', minHeight: 0, height: '100%' }
						: { minHeight: 240, maxHeight: 'min(60vh, 560px)' }
				}
			>
				{history.length === 0 ? (
					<p className="m-0 opacity-60">
						No messages yet. Pick a Bryan County suggested question above (with Auto-retrieve on) to see
						full filing details from the local knowledge store.
					</p>
				) : (
					history.map((turn, index) => (
						<div
							key={`${turn.role}-${index}`}
							className={`max-w-[92%] rounded-[10px] px-3 py-2.5 leading-snug whitespace-pre-wrap ${
								turn.role === 'user' ? 'self-end' : 'self-start'
							}`}
							style={{
								background: turn.role === 'user' ? 'var(--app-chat-user)' : 'var(--app-chat-assistant)',
							}}
						>
							<div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] opacity-60">
								<span>{turn.role === 'user' ? 'You' : 'Assistant'}</span>
								{turn.role === 'assistant' && turn.saved ? (
									<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200">
										{persistChat ? 'Remembered' : 'Saved'}
									</span>
								) : null}
								{turn.role === 'assistant' && turn.question && !turn.saved && !persistChat ? (
									<button
										type="button"
										disabled={!projectId || turn.saving || busy}
										onClick={() => void saveTurn(index)}
										className="cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-[11px] font-semibold text-[var(--app-fg)] opacity-100 disabled:opacity-40"
									>
										{turn.saving ? 'Saving…' : 'Save to knowledge'}
									</button>
								) : null}
							</div>
							{displayAnswerContent(turn.content, turn.chartUrls || [])}
							{turn.role === 'assistant' && turn.chartUrls && turn.chartUrls.length > 0 ? (
								<div className="mt-2 flex flex-col gap-2">
									{turn.chartUrls.map((url) => (
										<a
											key={url}
											href={url}
											target="_blank"
											rel="noreferrer"
											className="block overflow-hidden rounded-md border border-[var(--app-border)] bg-white"
										>
											{/* eslint-disable-next-line @next/next/no-img-element */}
											<img
												src={url}
												alt="Bryan County filings chart"
												className="block h-auto w-full max-w-full"
											/>
										</a>
									))}
								</div>
							) : null}
						</div>
					))
				)}
			</div>
		</section>
	);

	return (
		<main className="mx-auto max-w-[920px] px-4 py-5 pb-[calc(7.5rem+env(safe-area-inset-bottom))] text-[var(--app-fg)]">
			<header className="mb-4">
				<div className="flex items-start justify-between gap-3">
					<p className="m-0 text-[13px] opacity-70">local only · Ollama</p>
					<ThemeToggle />
				</div>
				<h1 className="my-1.5 text-[28px] font-semibold tracking-tight">AI Research Tool</h1>
				<p className="m-0 leading-snug opacity-80">
					Focus for now: query local <strong>Bryan County</strong> OKCountyRecords filings (grantor, grantee,
					legal, book/pages, and detail URLs). Select that project, turn on <strong>Auto-retrieve</strong>,
					then use the suggested questions below. FINRA/SEC canvas integration comes next.
				</p>
			</header>

			<KnowledgePanel
				knowledgeStatus={status?.knowledge}
				projectId={projectId}
				onProjectIdChange={setProjectId}
				refreshToken={knowledgeRefreshToken}
			/>

			{fetchToast ? (
				<section className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 text-sm">
					<span className="font-semibold">
						Save {fetchToast.count} successful fetch{fetchToast.count === 1 ? '' : 'es'} to this project?
					</span>
					<button
						type="button"
						onClick={() => void savePendingFetches()}
						disabled={savingFetches || !projectId}
						className="cursor-pointer rounded-md border-none bg-[#F97316] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
					>
						{savingFetches ? 'Saving…' : 'Save fetches'}
					</button>
					<button
						type="button"
						onClick={() => setFetchToast(null)}
						disabled={savingFetches}
						className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2.5 py-1 text-xs dark:border-zinc-600"
					>
						Dismiss
					</button>
				</section>
			) : null}

			<section className="mb-4 space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2.5">
				<p className="m-0 text-xs font-semibold text-amber-950 dark:text-amber-100">
					Disk retention — toggles write research (including FINRA-related Q&amp;A) to local disk under the
					active project
					{status?.knowledge?.path ? (
						<>
							{' '}
							(<code className="text-[0.95em]">{status.knowledge.path}</code>)
						</>
					) : null}
					. Defaults stay off.
				</p>
				{!projectId ? (
					<p className="m-0 text-xs opacity-80">Select a project above to enable remember / save toggles.</p>
				) : null}
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					<label className="flex cursor-pointer select-none items-center gap-2 text-[13px] font-semibold">
						<input
							type="checkbox"
							checked={persistChat}
							disabled={togglesDisabled}
							onChange={(e) => {
								const on = e.target.checked;
								setPersistChat(on);
								writeFlag(LS_REMEMBER, projectId, on);
							}}
							className="h-[15px] w-[15px]"
						/>
						<span>Remember answers</span>
						<span className="font-normal opacity-70">save Q+A (+ tools) after each ask</span>
					</label>
					<label className="flex cursor-pointer select-none items-center gap-2 text-[13px] font-semibold">
						<input
							type="checkbox"
							checked={persistFetches}
							disabled={togglesDisabled}
							onChange={(e) => {
								const on = e.target.checked;
								setPersistFetches(on);
								writeFlag(LS_FETCHES, projectId, on);
							}}
							className="h-[15px] w-[15px]"
						/>
						<span>Save successful fetches</span>
						<span className="font-normal opacity-70">index fetch_url bodies</span>
					</label>
					<label className="flex cursor-pointer select-none items-center gap-2 text-[13px] font-semibold">
						<input
							type="checkbox"
							checked={ragAuto}
							disabled={togglesDisabled}
							onChange={(e) => {
								const on = e.target.checked;
								setRagAuto(on);
								writeFlag(LS_RAG, projectId, on);
							}}
							className="h-[15px] w-[15px]"
						/>
						<span>Auto-retrieve</span>
						<span className="font-normal opacity-70">inject local snippets before answering</span>
					</label>
				</div>
			</section>

			<label
				className={`mb-4 flex cursor-pointer select-none items-center gap-2.5 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm font-semibold dark:border-zinc-700 ${
					aboutNodeGraph ? 'bg-orange-500/10' : 'bg-zinc-50 dark:bg-zinc-900/60'
				}`}
			>
				<input
					type="checkbox"
					checked={aboutNodeGraph}
					onChange={(e) => setAboutNodeGraph(e.target.checked)}
					disabled={busy}
					className="h-4 w-4"
				/>
				<span>Question about node graph</span>
				<span className="text-xs font-normal opacity-70">
					{aboutNodeGraph
						? 'Attaches live/pasted canvas · uses inspect_canvas_graph'
						: 'Off · general research / API fetch only'}
				</span>
			</label>

			<section className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900/60">
				<label className="flex cursor-pointer select-none items-center gap-2 text-[13px] font-semibold">
					<input
						type="checkbox"
						checked={autoMode}
						onChange={(e) => {
							const on = e.target.checked;
							setAutoMode(on);
							if (on) setShowAdvancedModel(false);
						}}
						disabled={busy}
						className="h-[15px] w-[15px]"
					/>
					<span>Auto model</span>
					<span className="font-normal opacity-70">
						{autoMode ? 'plans single or tools+reason→merge' : 'manual override'}
					</span>
				</label>
				{!autoMode || showAdvancedModel ? (
					<label className="flex items-center gap-2">
						<span className="text-[13px] opacity-80">Model</span>
						<select
							value={model}
							onChange={(e) => {
								setModel(e.target.value);
								setAutoMode(false);
							}}
							disabled={busy}
							className="min-w-[180px] rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-600 dark:bg-zinc-950"
						>
							{preferredModels.map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</select>
					</label>
				) : (
					<button
						type="button"
						onClick={() => {
							setShowAdvancedModel(true);
							setAutoMode(false);
						}}
						disabled={busy}
						className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
					>
						Advanced…
					</button>
				)}
				<span className="text-[13px] opacity-75">
					{status == null
						? 'Checking Ollama…'
						: status.ok
							? `Ollama ok · ${status.models?.length || 0} free models`
							: `Ollama unreachable: ${status.error || 'unknown error'}`}
				</span>
				<span className="text-[13px] opacity-75">{canvasInfo}</span>
				{lastRoute?.model ? (
					<span className="max-w-full text-xs opacity-85">
						Last route:{' '}
						{lastRoute.pipeline === 'multi'
							? `Auto multi → ${(lastRoute.workers || []).map((w) => `${w.role}:${w.model}`).join(' + ')} → merge:${lastRoute.mergeModel || lastRoute.model}`
							: lastRoute.mode === 'auto'
								? `Auto → ${lastRoute.model}`
								: lastRoute.model}
						{lastRoute.reason ? ` · ${lastRoute.reason}` : ''}
					</span>
				) : null}
				<button
					type="button"
					onClick={connectLiveGraph}
					disabled={busy}
					className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
				>
					Connect live graph
				</button>
				<button
					type="button"
					onClick={() => void refreshCanvasInfo()}
					disabled={busy}
					className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
				>
					Refresh canvas
				</button>
				<button
					type="button"
					onClick={() => setShowPaste((v) => !v)}
					disabled={busy}
					className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
				>
					{showPaste ? 'Hide paste' : 'Paste snapshot'}
				</button>
			</section>

			{showPaste ? (
				<section className="mb-4 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
					<p className="mb-2 text-xs opacity-70">
						Paste canvas snapshot JSON from the live app (Copy canvas for research), then Apply.
					</p>
					<textarea
						value={pastedJson}
						onChange={(e) => setPastedJson(e.target.value)}
						rows={5}
						placeholder='{"nodeCount":…,"nodes":[…],…}'
						className="mb-2 w-full resize-y rounded-md border border-zinc-300 bg-transparent p-2 font-mono text-xs dark:border-zinc-600"
					/>
					<button
						type="button"
						onClick={applyPastedJson}
						className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2.5 py-1.5 text-xs font-semibold dark:border-zinc-600"
					>
						Apply pasted snapshot
					</button>
				</section>
			) : null}

			<section className="mb-4 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-3">
				<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
					<p className="m-0 text-sm font-semibold text-emerald-950 dark:text-emerald-100">
						Bryan County · suggested questions
					</p>
					<p className="m-0 text-[11px] opacity-70">
						Click to ask immediately · Auto-retrieve on · Bryan County project
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					{BRYAN_EXAMPLES.map((example) => (
						<button
							key={example.label}
							type="button"
							disabled={busy}
							title={example.question}
							onClick={() => void applyBryanExample(example.question)}
							className="max-w-full cursor-pointer rounded-full border border-emerald-700/30 bg-white/80 px-2.5 py-1.5 text-left text-xs font-medium text-emerald-950 dark:border-emerald-400/30 dark:bg-zinc-950/60 dark:text-emerald-50"
						>
							{example.label}
						</button>
					))}
				</div>
			</section>

			{/* Opaque scrim so page body (header, knowledge, chips) cannot show through. */}
			{chatExpanded ? (
				<div
					aria-hidden="true"
					onClick={() => setChatExpanded(false)}
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 35,
						backgroundColor: 'var(--app-bg)',
						opacity: 1,
					}}
				/>
			) : null}
			{/* Spacer keeps page scroll position when chat is pulled into the overlay. */}
			{chatExpanded ? (
				<div
					aria-hidden="true"
					className="mb-3 min-h-[280px] rounded-lg border border-dashed border-[var(--app-border)] px-3 py-6 text-center text-xs opacity-60"
				>
					Q&amp;A is in full-height mode. Use <strong>Exit full height</strong> or Esc to restore the inline
					panel.
				</div>
			) : null}
			{chatPanel}

			{workerTraces && workerTraces.length > 0 ? (
				<details className="mt-4">
					<summary className="cursor-pointer">Worker traces ({workerTraces.length})</summary>
					<pre className="overflow-auto rounded-lg bg-black/5 p-3 text-xs leading-snug dark:bg-white/5">
						{JSON.stringify(
							(workerTraces as Array<Record<string, unknown>>).map((w) => ({
								id: w.id,
								role: w.role,
								model: w.model,
								answer: w.answer,
								tools: Array.isArray(w.toolTrace) ? w.toolTrace.length : 0,
							})),
							null,
							2,
						)}
					</pre>
				</details>
			) : null}

			{toolTrace && toolTrace.length > 0 ? (
				<details className="mt-4">
					<summary className="cursor-pointer">Tool trace ({toolTrace.length})</summary>
					<pre className="overflow-auto rounded-lg bg-black/5 p-3 text-xs leading-snug dark:bg-white/5">
						{JSON.stringify(toolTrace, null, 2)}
					</pre>
				</details>
			) : null}

			<div
				className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--app-border)] px-4 pt-3 backdrop-blur"
				style={{
					paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
					background: 'var(--app-ask-bar-bg)',
					boxShadow: 'var(--app-ask-bar-shadow)',
				}}
			>
				{error ? (
					<p className="mx-auto mb-2 max-w-[920px] text-sm text-red-700 dark:text-red-400">{error}</p>
				) : null}
				{askForm}
			</div>
		</main>
	);
}
