'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
};

type StatusPayload = {
	ok: boolean;
	baseUrl?: string;
	defaultModel?: string;
	models?: string[];
	error?: string | null;
};

const EXAMPLES = [
	'Summarize the nodes currently on my canvas.',
	'Which people on the canvas connect to two different firms?',
	'Fetch https://finra-sec-data-visualizer-canvas.vercel.app/api/finra/health and summarize status.',
	'Fetch https://en.wikipedia.org/wiki/Large_language_model and summarize the lead section in 5 bullets.',
	'What time is it on this machine right now?',
];

export default function ResearchClient() {
	const [status, setStatus] = useState<StatusPayload | null>(null);
	const [autoMode, setAutoMode] = useState(true);
	const [model, setModel] = useState('qwen2.5:7b');
	const [showAdvancedModel, setShowAdvancedModel] = useState(false);
	const [question, setQuestion] = useState('');
	const [history, setHistory] = useState<ChatTurn[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
	const liveWindowRef = useRef<Window | null>(null);

	const preferredModels = useMemo(() => {
		const models = filterFreeLocalOllamaModels(status?.models || []);
		const prefer = ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3.6:latest', 'llama3.2:latest'];
		const ordered = [...prefer.filter((m) => models.includes(m)), ...models.filter((m) => !prefer.includes(m))];
		return ordered.length ? ordered : prefer;
	}, [status]);

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

	const ask = useCallback(async () => {
		const q = question.trim();
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
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					question: q,
					model: requestedModel,
					history: history.slice(-8),
					availableModels: status?.models || preferredModels,
					aboutNodeGraph,
					canvasSnapshot: snap,
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
			setHistory((prev) => [
				...prev,
				{
					role: 'assistant',
					content: String(data.answer || ''),
				},
			]);
			setToolTrace(Array.isArray(data.toolTrace) ? data.toolTrace : []);
			setWorkerTraces(Array.isArray(data.workerTraces) ? data.workerTraces : null);
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
		busy,
		history,
		model,
		preferredModels,
		question,
		refreshCanvasInfo,
		status?.models,
	]);

	return (
		<main className="mx-auto max-w-[920px] px-4 py-5 pb-12 text-[var(--foreground)]">
			<header className="mb-4">
				<p className="m-0 text-[13px] opacity-70">local only · Ollama</p>
				<h1 className="my-1.5 text-[28px] font-semibold tracking-tight">AI Research Tool</h1>
				<p className="m-0 leading-snug opacity-80">
					Ask research questions, fetch the live FINRA app API via <code className="text-[0.95em]">fetch_url</code>
					, and attach a canvas snapshot from the live graph window (or paste JSON).
				</p>
			</header>

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

			<section className="mb-4 flex flex-wrap gap-2">
				{EXAMPLES.map((example) => (
					<button
						key={example}
						type="button"
						disabled={busy}
						onClick={() => setQuestion(example)}
						className="max-w-full cursor-pointer rounded-full border border-zinc-300 bg-transparent px-2.5 py-1.5 text-left text-xs dark:border-zinc-600"
					>
						{example}
					</button>
				))}
			</section>

			<section className="mb-3 flex min-h-[280px] flex-col gap-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
				{history.length === 0 ? (
					<p className="m-0 opacity-60">No messages yet. Try an example above.</p>
				) : (
					history.map((turn, index) => (
						<div
							key={`${turn.role}-${index}`}
							className={`max-w-[92%] rounded-[10px] px-3 py-2.5 leading-snug whitespace-pre-wrap ${
								turn.role === 'user'
									? 'self-end bg-orange-500/15'
									: 'self-start bg-black/5 dark:bg-white/5'
							}`}
						>
							<div className="mb-1 text-[11px] opacity-60">{turn.role === 'user' ? 'You' : 'Assistant'}</div>
							{turn.content}
						</div>
					))
				)}
			</section>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					void ask();
				}}
				className="flex items-start gap-2"
			>
				<textarea
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask a research question, paste a live API URL, or ask about the canvas…"
					rows={3}
					disabled={busy}
					className="flex-1 resize-y rounded-lg border border-zinc-300 bg-transparent p-2.5 font-[inherit] dark:border-zinc-600"
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
					className="min-w-[88px] rounded-lg border-none bg-[#F97316] px-3.5 py-2.5 font-semibold text-white disabled:cursor-wait"
				>
					{busy ? 'Working…' : 'Ask'}
				</button>
			</form>

			{error ? <p className="mt-2.5 text-red-700 dark:text-red-400">{error}</p> : null}

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
		</main>
	);
}
