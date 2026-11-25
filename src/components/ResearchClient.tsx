'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatMarkdown from '@/components/ChatMarkdown';
import { ComposerAttach } from '@/components/ComposerAttach';
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
import {
	DEFAULT_RESEARCH_MODEL,
	filterFreeLocalOllamaModels,
	PREFERRED_CHAT_MODELS,
} from '@/lib/research/ollama';
import { isResearchChatModel, RESEARCH_AUTO_MODEL } from '@/lib/research/orchestrator';
import {
	CHIP,
	CHIP_ACCENT,
	CONTROL_BTN,
	CONTROL_INPUT,
	INNER_SURFACE,
	NOTICE_STRIP,
	PANEL_BG,
	PANEL_DIVIDER,
	PANEL_OUTLINE,
	PRIMARY_BTN,
} from '@/lib/research/uiTheme';

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
	profiles?: {
		ok?: boolean;
		restricted?: boolean;
		totalProfiles?: number;
		totalAlignments?: number;
	};
};

type SuggestedExample = {
	label: string;
	question: string;
	/** Capture FINRA canvas + treat as node-graph question when clicked. */
	useCanvas?: boolean;
	/** Prefer this knowledge project name when the chip is clicked. */
	projectName?: string;
};

const BRYAN_PROJECT_NAME = 'Bryan County';
const SEISMIC_PROJECT_NAME = 'OK TX Seismic';
const TORNADO_PROJECT_NAME = 'OK TX Tornadoes';
const RESEARCH_DRIVE_PROJECT_NAME = 'Research Drive';

/**
 * Suggested research chips: Bryan OKCR knowledge (2016→current), charts, and
 * FINRA/SEC canvas ↔ deed / unclaimed-name pattern crosswalks.
 */
const BRYAN_EXAMPLES: SuggestedExample[] = [
	{
		label: 'CRD ↔ deed / unclaimed names',
		useCanvas: true,
		question:
			'Cross-check FINRA/SEC CRD names against Bryan County deed parties and unclaimed-property-style name patterns. Steps: (1) Call search_finra_sidecar for distinctive person/firm names (and variants) to resolve Name :: CRD# from the full prod flat-file index — not only the on-screen canvas. If a canvas snapshot is attached, you may also call inspect_canvas_graph for on-graph context. (2) For each CRD hit, call search_knowledge for grantor/grantee matches on WD, QCD, MTG, REL MTG, and similar deeds. (3) Also search unclaimed / treasurer / escheat / abandoned wording. (4) Report a table: CRD name, CRD#, Bryan instrument + type + recorded + grantor/grantee, match strength. Use caution tiers: observation / worth a closer look / stronger indicators. Do not call anyone a shell, nominee, or fraud unless multiple concrete indicators appear. Say when sidecar or knowledge is empty. Do not invent CRDs or filings.',
	},
	{
		label: 'Latest filings (full fields)',
		question:
			'Using the Bryan County knowledge store (filings roughly 2016 through current), list the 8 most recent Bryan County filings by recorded date. For each, show full details: instrument, type, county, recorded date, instrument date, grantor, grantee, book, pages, legal description, filing fees, mortgage amount, consideration, image count, record id, and detail URL.',
	},
	{
		label: 'MTG vs WD volume (chart)',
		question:
			'Compare Bryan County mortgage (MTG) vs warranty deed (WD) filing volume over time. Call chart_filings twice (or with filters) for kind=volume period=month docType=MTG and docType=WD, embed the chart image(s), and explain months where the two series diverge.',
	},
	{
		label: 'Mortgages to Vision Bank',
		question:
			'Using the Bryan County knowledge store, find MTG (mortgage) filings where the grantee is VISION BANK. For each match, show full filing details: instrument, type, recorded date, grantor, grantee, book, pages, legal description, images, and detail URL.',
	},
	{
		label: 'Recent warranty deeds (WD)',
		question:
			'Using the Bryan County knowledge store, find recent WD (warranty deed) filings. For each, show: instrument, type, recorded date, grantor, grantee, book, pages, legal description, consideration, images, and detail URL.',
	},
	{
		label: 'Search a grantor name',
		question:
			'Using the Bryan County knowledge store, search filings involving grantor WESTSIDE BAPTIST CHURCH (or close variants). For each hit, show complete filing details: instrument, type, recorded, grantor, grantee, book, pages, legal, images, and detail URL.',
	},
	{
		label: 'Possible fraud / nominee patterns',
		question:
			'Using the Bryan County knowledge store, hunt for possible fraud or concealment patterns on WD, QCD, and MTG filings (stay on those types unless you explicitly note extras). Look for: numbered or address-mill LLCs; “as trustee” with no named trust; same grantor=grantee loops; rapid flip chains; generic holding names that repeat across unrelated tracts. For each hit give instrument, type, recorded date, grantor, grantee, detail URL, and how often the name repeats. Structure the answer as (1) observations with counts, (2) worth a closer look, (3) stronger indicators only if multiple concrete signals appear. Do NOT hard-label parties as shells, nominees, or fraudulent from an LLC name alone, oil & gas lessees, restaurants, or high-volume UCC lenders. Prefer “insufficient to conclude” when evidence is thin.',
	},
	{
		label: 'Doc-type mix + examples',
		question:
			'Using the Bryan County knowledge store, summarize which document types are present (MTG, WD, REL MTG, UCC, QCD, etc.) now that 2016→current is backfilled. Call chart_filings with kind=by_type, embed the image, and give 3 example filings with full details each.',
	},
	{
		label: 'Chart: filings by month',
		question:
			'Create a chart of Bryan County filing volume by month across the full stored history. Call chart_filings with kind=volume and period=month, embed the image, and briefly summarize the busiest months.',
	},
	{
		label: 'Chart: filings by type',
		question:
			'Create a chart breaking down Bryan County filings by document type. Call chart_filings with kind=by_type, embed the image, and list the top types with counts.',
	},
];

/**
 * USGS ComCat seismic chips (Oklahoma + Texas, M≥2.5 since 2016).
 * Prefer the "OK TX Seismic" knowledge project with Auto-retrieve on.
 */
const SEISMIC_EXAMPLES: SuggestedExample[] = [
	{
		label: 'OK seismic overview since 2016',
		projectName: SEISMIC_PROJECT_NAME,
		question:
			'Using the OK TX Seismic knowledge store (USGS ComCat M≥2.5 since 2016), summarize Oklahoma earthquake activity: total events if stated, strongest years, max magnitudes, and notable M≥4 events. Cite digest titles/months. Do not invent counts.',
	},
	{
		label: 'TX seismic overview since 2016',
		projectName: SEISMIC_PROJECT_NAME,
		question:
			'Using the OK TX Seismic knowledge store (USGS ComCat M≥2.5 since 2016), summarize Texas earthquake activity: yearly pattern, max magnitudes, and notable M≥4 events with place and USGS links when present. Do not invent counts.',
	},
	{
		label: 'Strongest OK/TX quakes',
		projectName: SEISMIC_PROJECT_NAME,
		question:
			'From the OK TX Seismic knowledge store, list the strongest Oklahoma and Texas earthquakes since 2016 (prefer M≥4). For each: time, magnitude, place, depth if present, and USGS event URL.',
	},
	{
		label: 'Compare OK vs TX by year',
		projectName: SEISMIC_PROJECT_NAME,
		question:
			'Using OK TX Seismic yearly summaries in the knowledge store, compare Oklahoma vs Texas earthquake counts and max magnitudes by year since 2016. Make a compact year table from the stored digests only.',
	},
	{
		label: 'Search a place (e.g. Waynoka)',
		projectName: SEISMIC_PROJECT_NAME,
		question:
			'Using the OK TX Seismic knowledge store, search for earthquakes near Waynoka, Oklahoma (and close place-name variants). List time, magnitude, place, depth, and USGS URL for each hit.',
	},
];

/**
 * NOAA SPC + NCEI tornado chips (Oklahoma + Texas since 2016).
 * Prefer the "OK TX Tornadoes" knowledge project with Auto-retrieve on.
 */
const TORNADO_EXAMPLES: SuggestedExample[] = [
	{
		label: 'OK tornadoes since 2016',
		projectName: TORNADO_PROJECT_NAME,
		question:
			'Using the OK TX Tornadoes knowledge store (NOAA SPC actual tracks + NCEI narratives since 2016), summarize Oklahoma tornado activity: yearly counts if present, EF breakdown, fatalities/injuries, and notable EF2+ or fatal events. Cite digest titles. Do not invent counts.',
	},
	{
		label: 'TX tornadoes since 2016',
		projectName: TORNADO_PROJECT_NAME,
		question:
			'Using the OK TX Tornadoes knowledge store (NOAA SPC + NCEI since 2016), summarize Texas tornado activity: yearly pattern, EF ratings, fatalities, and strongest events with county/date when present. Do not invent counts.',
	},
	{
		label: 'EF2+ / fatal tornadoes',
		projectName: TORNADO_PROJECT_NAME,
		question:
			'From the OK TX Tornadoes knowledge store, list notable Oklahoma and Texas tornadoes that were EF2+ or caused fatalities since 2016. For each: date, state, EF rating, path/length if present, fatalities/injuries, and any NCEI narrative snippets.',
	},
	{
		label: 'Compare OK vs TX tornado years',
		projectName: TORNADO_PROJECT_NAME,
		question:
			'Using OK TX Tornadoes SPC yearly summaries, compare Oklahoma vs Texas tornado counts and fatalities by year since 2016. Make a compact year table from the stored digests only.',
	},
	{
		label: 'Search a county (e.g. Murray OK)',
		projectName: TORNADO_PROJECT_NAME,
		question:
			'Using the OK TX Tornadoes knowledge store, search for tornadoes in Murray County, Oklahoma (and close variants). Prefer NCEI narrative digests for county context and SPC digests for track/EF details.',
	},
];

/**
 * Research Drive OCR / family-record chips (local staging under .data/research-drive/).
 * Prefer the "Research Drive" knowledge project with Auto-retrieve on.
 */
const RESEARCH_DRIVE_EXAMPLES: SuggestedExample[] = [
	{
		label: 'Ella Macek · Fort Bend marriage',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'Using the Research Drive knowledge store, provide information on Ella Macek associated with marriage in Fort Bend. Prefer OCR digests for IMG_1628 / IMG_1629 (Arthur Timothy King folder) and any Ella Olga Hejl Macek biography notes. Say whether she is a party to a marriage or an official on the license. Cite book/page, dates, and parties from the hits only.',
	},
	{
		label: 'King–Park license: clerk or spouse?',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'On the Arthur Timothy King and Kui-Suk Park Fort Bend marriage license (Research Drive OCR), was Ella Macek a spouse or the county clerk/deputy? Cite the local OCR evidence (IMG_1628, IMG_1629) with book/page and issue date.',
	},
	{
		label: 'King–Park book / page / issue date',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'From Research Drive OCR of the King–Park Fort Bend marriage records, what book and page number recorded the marriage, and what date was the license issued in Richmond? Name the clerk who signed.',
	},
	{
		label: 'Ella Olga Hejl · 1940 marriage',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'When and where did Ella Olga Hejl marry Charles Wesley Macek? How does that relate to Fort Bend County? Use the Research Drive biography note and OCR; distinguish her own marriage from licenses she signed as clerk.',
	},
	{
		label: 'Ella Macek · Fort Bend life beyond clerk',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'Besides signing Fort Bend marriage licenses as county clerk/deputy, what Fort Bend work or residence is Ella Olga Macek associated with in the Research Drive knowledge store? Summarize birth, marriage, library/bookmobile work, Rosenberg/Needville residence, and death when present.',
	},
	{
		label: 'Ella Macek · clerk vs own marriage summary',
		projectName: RESEARCH_DRIVE_PROJECT_NAME,
		question:
			'Summarize Ella Macek in a short table: (1) clerk/deputy role on the 1974 King–Park Fort Bend license, (2) her own 1940 marriage to Charles Wesley Macek, (3) later Fort Bend life. Cite Research Drive OCR and biography notes only; do not invent details.',
	},
];

const LS_REMEMBER = 'research.persistChat';
const LS_FETCHES = 'research.persistFetches';
const LS_RAG = 'research.ragAuto';
/** Collapsible block under KnowledgePanel (toggles, model, canvas, suggested questions). */
const LS_BELOW_KNOWLEDGE = 'research.belowKnowledgeOpen.v2';

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
	const [model, setModel] = useState(DEFAULT_RESEARCH_MODEL);
	const [showAdvancedModel, setShowAdvancedModel] = useState(false);
	const [question, setQuestion] = useState('');
	const [history, setHistory] = useState<ChatTurn[]>([]);
	/** Always-current history for Ask (avoids stale closure when posting to /api/chat). */
	const historyRef = useRef<ChatTurn[]>([]);
	historyRef.current = history;
	/** False until `/api/chat/session` has hydrated (avoids wiping disk with []). */
	const [sessionReady, setSessionReady] = useState(false);
	const [sessionMeta, setSessionMeta] = useState<{ id: string; createdAt: string } | null>(null);
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
	/** Options / suggested questions under knowledge store; closed by default, remembered in localStorage. */
	const [belowKnowledgeOpen, setBelowKnowledgeOpen] = useState(false);
	const liveWindowRef = useRef<Window | null>(null);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			try {
				const v = window.localStorage.getItem(LS_BELOW_KNOWLEDGE);
				if (v === '0') setBelowKnowledgeOpen(false);
				else if (v === '1') setBelowKnowledgeOpen(true);
			} catch {
				/* ignore */
			}
		}, 0);
		return () => window.clearTimeout(timer);
	}, []);

	const toggleBelowKnowledge = useCallback(() => {
		setBelowKnowledgeOpen((prev) => {
			const next = !prev;
			try {
				window.localStorage.setItem(LS_BELOW_KNOWLEDGE, next ? '1' : '0');
			} catch {
				/* ignore */
			}
			return next;
		});
	}, []);

	const preferredModels = useMemo(() => {
		const models = filterFreeLocalOllamaModels(status?.models || []).filter(isResearchChatModel);
		const prefer = [...PREFERRED_CHAT_MODELS];
		const ordered = [...prefer.filter((m) => models.includes(m)), ...models.filter((m) => !prefer.includes(m))];
		return ordered.length ? ordered : prefer;
	}, [status]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setPersistChat(readFlag(LS_REMEMBER, projectId));
			setPersistFetches(readFlag(LS_FETCHES, projectId));
			setRagAuto(readFlag(LS_RAG, projectId));
		}, 0);
		return () => window.clearTimeout(timer);
	}, [projectId]);

	useEffect(() => {
		const prev = document.title;
		document.title = 'AI Research Tool';
		return () => {
			document.title = prev;
		};
	}, []);

	/** Load durable chat session from `.data/chat-sessions/current.json`. */
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/api/chat/session', { cache: 'no-store' });
				const data = await res.json();
				if (cancelled) return;
				if (res.ok && data?.ok && data.session) {
					const turns = Array.isArray(data.session.turns) ? data.session.turns : [];
					setHistory(
						turns.map(
							(t: {
								role?: string;
								content?: string;
								question?: string;
								toolTrace?: unknown[];
								chartUrls?: string[];
								saved?: boolean;
							}) => ({
								role: t.role === 'user' || t.role === 'assistant' ? t.role : 'assistant',
								content: String(t.content ?? ''),
								question: t.question != null ? String(t.question) : undefined,
								toolTrace: Array.isArray(t.toolTrace) ? t.toolTrace : undefined,
								chartUrls: Array.isArray(t.chartUrls)
									? t.chartUrls.map((u) => String(u || '')).filter(Boolean)
									: undefined,
								saved: Boolean(t.saved),
							}),
						),
					);
					setSessionMeta({
						id: String(data.session.id || ''),
						createdAt: String(data.session.createdAt || ''),
					});
				}
			} catch {
				/* start empty if session API is down */
			} finally {
				if (!cancelled) setSessionReady(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	/** Persist full Q&A history to disk after every change (until New session). */
	useEffect(() => {
		if (!sessionReady) return;
		const timer = window.setTimeout(() => {
			const turns = history.map((t) => ({
				role: t.role,
				content: t.content,
				question: t.question,
				toolTrace: t.toolTrace,
				chartUrls: t.chartUrls,
				saved: t.saved,
			}));
			void fetch('/api/chat/session', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					turns,
					id: sessionMeta?.id,
					createdAt: sessionMeta?.createdAt,
				}),
			})
				.then(async (res) => {
					const data = await res.json().catch(() => null);
					if (res.ok && data?.ok && data.session?.id) {
						setSessionMeta({
							id: String(data.session.id),
							createdAt: String(data.session.createdAt || sessionMeta?.createdAt || ''),
						});
					}
				})
				.catch(() => {
					/* ignore transient save errors */
				});
		}, 400);
		return () => window.clearTimeout(timer);
	}, [history, sessionReady, sessionMeta?.id, sessionMeta?.createdAt]);

	const startNewSession = useCallback(async () => {
		if (busy) return;
		if (history.length > 0) {
			const ok = window.confirm(
				'Start a new chat session?\n\nThe current Q&A will leave the screen. It is archived under .data/chat-sessions/archive/ on disk.',
			);
			if (!ok) return;
		}
		setError(null);
		try {
			const res = await fetch('/api/chat/session', { method: 'DELETE' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `new session failed (${res.status})`);
			setHistory([]);
			setToolTrace(null);
			setWorkerTraces(null);
			setLastRoute(null);
			setFetchToast(null);
			if (data.session) {
				setSessionMeta({
					id: String(data.session.id || ''),
					createdAt: String(data.session.createdAt || ''),
				});
			}
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [busy, history.length]);

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
				const free = filterFreeLocalOllamaModels(data.models || []).filter(isResearchChatModel);
				if (data.defaultModel && free.includes(data.defaultModel)) setModel(data.defaultModel);
				else if (free.includes(DEFAULT_RESEARCH_MODEL)) setModel(DEFAULT_RESEARCH_MODEL);
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
		opts?: { projectId?: string | null; ragAuto?: boolean; aboutNodeGraph?: boolean },
	) => {
		const q = String(overrideQuestion ?? question).trim();
		if (!q || busy || !sessionReady) return;
		setBusy(true);
		setError(null);
		setToolTrace(null);
		setWorkerTraces(null);
		setLastRoute(null);
		setHistory((prev) => [...prev, { role: 'user', content: q }]);
		setQuestion('');
		try {
			const useGraph =
				opts?.aboutNodeGraph !== undefined ? opts.aboutNodeGraph : aboutNodeGraph;
			const snap: CanvasSnapshot | null = useGraph ? await refreshCanvasInfo() : null;
			if (!useGraph) void refreshCanvasInfo();
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
					// Full session until New session; server compactSessionHistory keeps it in budget.
					history: historyRef.current.map((t) => ({ role: t.role, content: t.content })),
					availableModels: status?.models || preferredModels,
					aboutNodeGraph: useGraph,
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
		model,
		persistChat,
		persistFetches,
		preferredModels,
		projectId,
		question,
		ragAuto,
		refreshCanvasInfo,
		sessionReady,
		status,
	]);

	const applyBryanExample = useCallback(
		async (example: SuggestedExample) => {
			if (busy) return;
			setError(null);
			const wantedName = example.projectName || BRYAN_PROJECT_NAME;
			let activeId: string | null = projectId;
			try {
				const res = await fetch('/api/knowledge/projects', { cache: 'no-store' });
				const data = await res.json();
				const list = Array.isArray(data?.projects) ? data.projects : [];
				const wanted = list.find(
					(p: { name?: string }) => String(p?.name || '') === wantedName,
				) as { id?: string } | undefined;
				if (wanted?.id) {
					activeId = wanted.id;
					setProjectId(wanted.id);
					try {
						window.localStorage.setItem('research.activeProjectId', wanted.id);
					} catch {
						/* ignore */
					}
				} else if (wantedName === SEISMIC_PROJECT_NAME) {
					setError(
						`Knowledge project "${SEISMIC_PROJECT_NAME}" not found. Run pnpm seismic:download && pnpm seismic:ingest.`,
					);
					return;
				} else if (wantedName === TORNADO_PROJECT_NAME) {
					setError(
						`Knowledge project "${TORNADO_PROJECT_NAME}" not found. Run pnpm tornado:download && pnpm tornado:ingest.`,
					);
					return;
				} else if (wantedName === RESEARCH_DRIVE_PROJECT_NAME) {
					setError(
						`Knowledge project "${RESEARCH_DRIVE_PROJECT_NAME}" not found. Run pnpm research-drive:ocr && pnpm research-drive:ingest.`,
					);
					return;
				}
			} catch {
				/* keep current project */
			}
			setRagAuto(true);
			if (activeId) writeFlag(LS_RAG, activeId, true);
			if (example.useCanvas) setAboutNodeGraph(true);
			await ask(example.question, {
				projectId: activeId,
				ragAuto: true,
				aboutNodeGraph: Boolean(example.useCanvas) || aboutNodeGraph,
			});
		},
		[aboutNodeGraph, ask, busy, projectId],
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
				disabled={busy || !sessionReady}
				className={`max-h-40 min-h-[52px] flex-1 resize-y p-2.5 font-[inherit] ${CONTROL_INPUT}`}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void ask();
					}
				}}
			/>
			<div className="flex flex-col items-center gap-1.5">
				<ComposerAttach
					projectId={projectId}
					disabled={busy || !sessionReady}
					onAttached={() => {
						setKnowledgeRefreshToken((n) => n + 1);
						setError(null);
					}}
					onError={(message) => setError(message)}
				/>
				<button
					type="submit"
					disabled={busy || !sessionReady || !question.trim()}
					className={`min-h-[36px] min-w-[64px] cursor-pointer px-2.5 py-1.5 text-sm disabled:cursor-wait ${PRIMARY_BTN}`}
				>
					{busy ? '…' : 'Ask'}
				</button>
			</div>
		</form>
	);

	const chatPanel = (
		<section
			className={
				chatExpanded
					? `z-40 flex flex-col border-b ${PANEL_DIVIDER} ${PANEL_BG}`
					: `relative mb-3 flex min-h-[280px] flex-col ${PANEL_OUTLINE}`
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
						}
					: undefined
			}
		>
			<div className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 ${PANEL_DIVIDER}`}>
				<div className="min-w-0">
					<p className="m-0 text-xs font-semibold opacity-80">Q&amp;A</p>
					{sessionReady && history.length > 0 ? (
						<p className="m-0 truncate text-[10px] opacity-55">
							{history.length} message{history.length === 1 ? '' : 's'} · model keeps this thread’s
							context · saved until New session
							{sessionMeta?.createdAt
								? ` · started ${new Date(sessionMeta.createdAt).toLocaleString()}`
								: ''}
						</p>
					) : sessionReady ? (
						<p className="m-0 text-[10px] opacity-55">
							Follow-ups stay on subject until New session (full thread remembered)
						</p>
					) : (
						<p className="m-0 text-[10px] opacity-55">Loading session…</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						onClick={() => void startNewSession()}
						disabled={busy || !sessionReady}
						title="Clear the chat and start a fresh session (current history is archived on disk)"
						className={`cursor-pointer px-2 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${CONTROL_BTN}`}
					>
						New session
					</button>
					<button
						type="button"
						onClick={() => setChatExpanded((v) => !v)}
						title={chatExpanded ? 'Exit full-height chat (Esc)' : 'Make chat sticky and full height'}
						aria-pressed={chatExpanded}
						className={`cursor-pointer px-2 py-1 text-[11px] font-semibold ${CONTROL_BTN}`}
					>
						{chatExpanded ? 'Exit full height' : 'Full height'}
					</button>
				</div>
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
						{sessionReady
							? 'No messages yet. The model remembers this whole thread (for follow-ups like “tell me more”) until you click New session. Pick a suggested question above (with Auto-retrieve on) to see full filing details from the local knowledge store.'
							: 'Loading saved chat session…'}
					</p>
				) : (
					history.map((turn, index) => (
						<div
							key={`${turn.role}-${index}`}
							className={`rounded-[10px] border px-3 py-2.5 leading-snug ${
								turn.role === 'user'
									? 'max-w-[92%] self-end whitespace-pre-wrap border-[#F97316]/35'
									: `max-w-full self-start border-[#3b82f6]/25 sm:max-w-[96%]`
							}`}
							style={{
								background: turn.role === 'user' ? 'var(--app-chat-user)' : 'var(--app-chat-assistant)',
							}}
						>
							<div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] opacity-60">
								<span>{turn.role === 'user' ? 'You' : 'Assistant'}</span>
								{turn.role === 'assistant' && turn.saved ? (
									<span className="rounded border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-1.5 py-0.5 text-[10px] font-semibold text-[#c5d4ff]">
										{persistChat ? 'Remembered' : 'Saved'}
									</span>
								) : null}
								{turn.role === 'assistant' && turn.question && !turn.saved && !persistChat ? (
									<button
										type="button"
										disabled={!projectId || turn.saving || busy}
										onClick={() => void saveTurn(index)}
										className={`cursor-pointer px-1.5 py-0.5 text-[11px] font-semibold disabled:opacity-40 ${CONTROL_BTN}`}
									>
										{turn.saving ? 'Saving…' : 'Save to knowledge'}
									</button>
								) : null}
							</div>
							{turn.role === 'assistant' ? (
								<ChatMarkdown content={displayAnswerContent(turn.content, turn.chartUrls || [])} />
							) : (
								displayAnswerContent(turn.content, turn.chartUrls || [])
							)}
							{turn.role === 'assistant' && turn.chartUrls && turn.chartUrls.length > 0 ? (
								<div className="mt-2 flex flex-col gap-2">
									{turn.chartUrls.map((url) => (
										<a
											key={url}
											href={url}
											target="_blank"
											rel="noreferrer"
											className="block overflow-hidden rounded-md border border-[#3b82f6]/35 bg-[#0a1228]"
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
		<div className={`min-h-dvh ${PANEL_BG}`}>
		<main className={`mx-auto max-w-[920px] px-4 py-5 pb-[calc(7.5rem+env(safe-area-inset-bottom))] ${PANEL_BG}`}>
			<header className="mb-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="m-0 text-[13px] opacity-70">local only · Ollama</p>
					<div className="flex items-center gap-2">
						<Link
							href="/profiles"
							className={`px-2.5 py-1 text-xs font-semibold no-underline ${CONTROL_BTN}`}
						>
							Profiles &amp; Alignment
							{status?.profiles?.totalProfiles != null
								? ` (${status.profiles.totalProfiles.toLocaleString()})`
								: ''}{' '}
							→
						</Link>
						<ThemeToggle />
					</div>
				</div>
				<h1 className="my-1.5 text-[24px] font-semibold tracking-tight">AI Research Tool</h1>
				<p className="m-0 max-w-4xl text-xs leading-relaxed opacity-80">
					Query local <strong>Bryan County</strong> OKCountyRecords filings (2016→current): grantor, grantee,
					legal, book/pages, charts, and detail URLs. Connect the <strong>FINRA/SEC canvas</strong> and use{' '}
					<strong>CRD ↔ deed / unclaimed names</strong> to hunt shared name patterns. Select the Bryan
					project, turn on <strong>Auto-retrieve</strong>, then pick a suggested question below.
				</p>
			</header>

			<KnowledgePanel
				knowledgeStatus={status?.knowledge}
				projectId={projectId}
				onProjectIdChange={setProjectId}
				refreshToken={knowledgeRefreshToken}
			/>

			{fetchToast ? (
				<section className={`mb-4 flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm ${NOTICE_STRIP}`}>
					<span className="font-semibold">
						Save {fetchToast.count} successful fetch{fetchToast.count === 1 ? '' : 'es'} to this project?
					</span>
					<button
						type="button"
						onClick={() => void savePendingFetches()}
						disabled={savingFetches || !projectId}
						className={`cursor-pointer px-2.5 py-1 text-xs ${PRIMARY_BTN}`}
					>
						{savingFetches ? 'Saving…' : 'Save fetches'}
					</button>
					<button
						type="button"
						onClick={() => setFetchToast(null)}
						disabled={savingFetches}
						className={`cursor-pointer px-2.5 py-1 text-xs ${CONTROL_BTN}`}
					>
						Dismiss
					</button>
				</section>
			) : null}

			<section className={`mb-4 overflow-hidden ${PANEL_OUTLINE}`}>
				<button
					type="button"
					onClick={toggleBelowKnowledge}
					aria-expanded={belowKnowledgeOpen}
					aria-controls="research-options-panel"
					className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-sm font-semibold text-[#e8eeff]"
				>
					<span>Options &amp; suggested questions</span>
					<span className="text-xs font-normal opacity-70">
						{belowKnowledgeOpen ? 'Hide' : 'Show'}
					</span>
				</button>
				{belowKnowledgeOpen ? (
					<div
						id="research-options-panel"
						className={`space-y-3 border-t px-3 py-3 ${PANEL_DIVIDER}`}
					>
						<section className={`space-y-2 px-3 py-2.5 ${NOTICE_STRIP}`}>
							<p className="m-0 text-xs font-semibold text-[#e8eeff]">
								Disk retention — toggles write research (including FINRA-related Q&amp;A) to local disk
								under the active project
								{status?.knowledge?.path ? (
									<>
										{' '}
										(<code className="text-[0.95em]">{status.knowledge.path}</code>)
									</>
								) : null}
								. Defaults stay off.
							</p>
							{!projectId ? (
								<p className="m-0 text-xs opacity-80">
									Select a project above to enable remember / save toggles.
								</p>
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
							className={`flex cursor-pointer select-none items-center gap-2.5 px-3 py-2.5 text-sm font-semibold ${
								aboutNodeGraph ? 'border border-[#F97316]/45 bg-[#F97316]/15' : INNER_SURFACE
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
									: 'Off · leave unchecked for CRD / firm roster / BrokerCheck'}
							</span>
						</label>

						<section className={`flex flex-wrap items-center gap-3 p-3 ${INNER_SURFACE}`}>
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
									{autoMode ? 'one GPU-resident model, no planner swap' : 'manual override'}
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
										className={`min-w-[180px] px-2 py-1.5 ${CONTROL_INPUT}`}
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
									className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
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
								className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
							>
								Connect live graph
							</button>
							<button
								type="button"
								onClick={() => void refreshCanvasInfo()}
								disabled={busy}
								className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
							>
								Refresh canvas
							</button>
							<button
								type="button"
								onClick={() => setShowPaste((v) => !v)}
								disabled={busy}
								className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
							>
								{showPaste ? 'Hide paste' : 'Paste snapshot'}
							</button>
						</section>

						{showPaste ? (
							<section className={`p-3 ${INNER_SURFACE}`}>
								<p className="mb-2 text-xs opacity-70">
									Paste canvas snapshot JSON from the live app (Copy canvas for research), then Apply.
								</p>
								<textarea
									value={pastedJson}
									onChange={(e) => setPastedJson(e.target.value)}
									rows={5}
									placeholder='{"nodeCount":…,"nodes":[…],…}'
									className={`mb-2 w-full resize-y p-2 font-mono text-xs ${CONTROL_INPUT}`}
								/>
								<button
									type="button"
									onClick={applyPastedJson}
									className={`cursor-pointer px-2.5 py-1.5 text-xs font-semibold ${CONTROL_BTN}`}
								>
									Apply pasted snapshot
								</button>
							</section>
						) : null}

						<section className={`px-3 py-3 ${INNER_SURFACE}`}>
							<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
								<p className="m-0 text-sm font-semibold text-[#e8eeff]">
									Suggested research questions
								</p>
								<p className="m-0 text-[11px] opacity-70">
									Click to ask · Auto-retrieve on · Bryan project · CRD chip also captures canvas
								</p>
							</div>
							<div className="flex flex-wrap gap-2">
								{BRYAN_EXAMPLES.map((example) => (
									<button
										key={example.label}
										type="button"
										disabled={busy}
										title={example.question}
										onClick={() => void applyBryanExample(example)}
										className={`max-w-full cursor-pointer px-2.5 py-1.5 text-left text-xs font-medium disabled:opacity-50 ${
											example.useCanvas ? CHIP_ACCENT : CHIP
										}`}
									>
										{example.label}
									</button>
								))}
							</div>
							<div className={`mt-3 border-t pt-3 ${PANEL_DIVIDER}`}>
								<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
									<p className="m-0 text-sm font-semibold text-[#e8eeff]">
										Oklahoma / Texas seismic (USGS)
									</p>
									<p className="m-0 text-[11px] opacity-70">
										Select project <strong>OK TX Seismic</strong> · Auto-retrieve on · M≥2.5 since 2016
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									{SEISMIC_EXAMPLES.map((example) => (
										<button
											key={example.label}
											type="button"
											disabled={busy}
											title={example.question}
											onClick={() => void applyBryanExample(example)}
											className={`max-w-full cursor-pointer px-2.5 py-1.5 text-left text-xs font-medium disabled:opacity-50 ${CHIP}`}
										>
											{example.label}
										</button>
									))}
								</div>
							</div>
							<div className={`mt-3 border-t pt-3 ${PANEL_DIVIDER}`}>
								<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
									<p className="m-0 text-sm font-semibold text-[#e8eeff]">
										Oklahoma / Texas tornadoes (SPC + NCEI)
									</p>
									<p className="m-0 text-[11px] opacity-70">
										Select project <strong>OK TX Tornadoes</strong> · Auto-retrieve on · since 2016
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									{TORNADO_EXAMPLES.map((example) => (
										<button
											key={example.label}
											type="button"
											disabled={busy}
											title={example.question}
											onClick={() => void applyBryanExample(example)}
											className={`max-w-full cursor-pointer px-2.5 py-1.5 text-left text-xs font-medium disabled:opacity-50 ${CHIP}`}
										>
											{example.label}
										</button>
									))}
								</div>
							</div>
							<div className={`mt-3 border-t pt-3 ${PANEL_DIVIDER}`}>
								<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
									<p className="m-0 text-sm font-semibold text-[#e8eeff]">
										Research Drive (OCR / family records)
									</p>
									<p className="m-0 text-[11px] opacity-70">
										Selects project <strong>Research Drive</strong> · Auto-retrieve on · Ella Macek /
										Fort Bend
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									{RESEARCH_DRIVE_EXAMPLES.map((example) => (
										<button
											key={example.label}
											type="button"
											disabled={busy}
											title={example.question}
											onClick={() => void applyBryanExample(example)}
											className={`max-w-full cursor-pointer px-2.5 py-1.5 text-left text-xs font-medium disabled:opacity-50 ${CHIP}`}
										>
											{example.label}
										</button>
									))}
								</div>
							</div>
						</section>
					</div>
				) : null}
			</section>

			{/* Opaque scrim so page body (header, knowledge, chips) cannot show through. */}
			{chatExpanded ? (
				<div
					aria-hidden="true"
					onClick={() => setChatExpanded(false)}
					className={PANEL_BG}
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 35,
						opacity: 1,
					}}
				/>
			) : null}
			{/* Spacer keeps page scroll position when chat is pulled into the overlay. */}
			{chatExpanded ? (
				<div
					aria-hidden="true"
					className={`mb-3 min-h-[280px] border border-dashed px-3 py-6 text-center text-xs opacity-60 ${PANEL_OUTLINE}`}
				>
					Q&amp;A is in full-height mode. Use <strong>Exit full height</strong> or Esc to restore the inline
					panel.
				</div>
			) : null}
			{chatPanel}

			{workerTraces && workerTraces.length > 0 ? (
				<details className="mt-4">
					<summary className="cursor-pointer">Worker traces ({workerTraces.length})</summary>
					<pre className={`overflow-auto p-3 text-xs leading-snug ${INNER_SURFACE}`}>
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
					<pre className={`overflow-auto p-3 text-xs leading-snug ${INNER_SURFACE}`}>
						{JSON.stringify(toolTrace, null, 2)}
					</pre>
				</details>
			) : null}

			<div
				className={`fixed inset-x-0 bottom-0 z-50 border-t px-4 pt-3 backdrop-blur ${PANEL_DIVIDER}`}
				style={{
					paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
					background: 'var(--app-ask-bar-bg)',
					boxShadow: 'var(--app-ask-bar-shadow)',
				}}
			>
				{error ? (
					<p className="mx-auto mb-2 max-w-[920px] text-sm text-rose-300">{error}</p>
				) : null}
				{askForm}
			</div>
		</main>
		</div>
	);
}
