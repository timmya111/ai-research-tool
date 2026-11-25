'use client';

import { useCallback, useEffect, useState } from 'react';
import {
	CONTROL_BTN,
	CONTROL_INPUT,
	INNER_SURFACE,
	NOTICE_STRIP,
	PANEL_DIVIDER,
	PANEL_OUTLINE,
	PRIMARY_BTN,
} from '@/lib/research/uiTheme';

const LS_PROJECT_KEY = 'research.activeProjectId';
const LS_PANEL_OPEN_KEY = 'research.knowledgePanelOpen.v2';

export type KnowledgeProject = {
	id: string;
	name: string;
	createdAt?: string;
	updatedAt?: string;
	documentCount?: number;
};

type KnowledgeDocListItem = {
	id: string;
	projectId: string;
	sourceType: string;
	title: string;
	url: string | null;
	createdAt: string;
	updatedAt?: string;
};

type KnowledgeStatus = {
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

type Props = {
	knowledgeStatus?: KnowledgeStatus | null;
	projectId: string | null;
	onProjectIdChange: (id: string | null) => void;
	/** Bump to reload document list (e.g. after chat persist). */
	refreshToken?: number;
};

function badgeClass(sourceType: string): string {
	if (sourceType === 'chat') return 'border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] text-[#c5d4ff]';
	if (sourceType === 'fetch') return 'border border-[#F97316]/40 bg-[#F97316]/15 text-[#FFEDD5]';
	if (sourceType === 'file') return 'border border-[#3b82f6]/35 bg-[lab(5_4.06_-17.11_/0.4)] text-[#e8eeff]';
	if (sourceType === 'image') return 'border border-[#F97316]/30 bg-[#F97316]/10 text-[#FFEDD5]';
	return 'border border-[#3b82f6]/30 bg-[lab(5_4.06_-17.11_/0.35)] text-[#e8eeff]';
}

export default function KnowledgePanel({
	knowledgeStatus,
	projectId,
	onProjectIdChange,
	refreshToken = 0,
}: Props) {
	const [open, setOpen] = useState(false);
	const [projects, setProjects] = useState<KnowledgeProject[]>([]);
	const [docs, setDocs] = useState<KnowledgeDocListItem[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [savingNote, setSavingNote] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [noteTitle, setNoteTitle] = useState('');
	const [noteText, setNoteText] = useState('');
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [previewText, setPreviewText] = useState<string | null>(null);
	const [reindexing, setReindexing] = useState(false);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			try {
				const v = window.localStorage.getItem(LS_PANEL_OPEN_KEY);
				if (v === '0') setOpen(false);
				else if (v === '1') setOpen(true);
			} catch {
				/* ignore */
			}
		}, 0);
		return () => window.clearTimeout(timer);
	}, []);

	const toggleOpen = useCallback(() => {
		setOpen((prev) => {
			const next = !prev;
			try {
				window.localStorage.setItem(LS_PANEL_OPEN_KEY, next ? '1' : '0');
			} catch {
				/* ignore */
			}
			return next;
		});
	}, []);

	const loadProjects = useCallback(async () => {
		const res = await fetch('/api/knowledge/projects', { cache: 'no-store' });
		const data = await res.json();
		if (!res.ok || !data?.ok) throw new Error(data?.error || `projects failed (${res.status})`);
		const list = Array.isArray(data.projects) ? (data.projects as KnowledgeProject[]) : [];
		setProjects(list);

		const stored =
			typeof window !== 'undefined' ? window.localStorage.getItem(LS_PROJECT_KEY) : null;
		// Prefer Bryan County filings project for the current focus of the app.
		const preferred =
			list.find((p) => p.name === 'Bryan County')?.id ||
			(stored && list.find((p) => p.id === stored)?.id) ||
			list.find((p) => p.name === 'Default')?.id ||
			list[0]?.id ||
			null;
		onProjectIdChange(preferred);
		if (preferred && typeof window !== 'undefined') {
			window.localStorage.setItem(LS_PROJECT_KEY, preferred);
		}
		return list;
	}, [onProjectIdChange]);

	const loadDocs = useCallback(async (pid: string) => {
		const res = await fetch(
			`/api/knowledge?projectId=${encodeURIComponent(pid)}&limit=50`,
			{ cache: 'no-store' },
		);
		const data = await res.json();
		if (!res.ok || !data?.ok) throw new Error(data?.error || `list failed (${res.status})`);
		setDocs(Array.isArray(data.documents) ? data.documents : []);
		setTotal(Number(data.total) || 0);
	}, []);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await loadProjects();
			const pid =
				projectId && list.some((p) => p.id === projectId)
					? projectId
					: list.find((p) => p.name === 'Default')?.id || list[0]?.id || null;
			if (pid) await loadDocs(pid);
			else {
				setDocs([]);
				setTotal(0);
			}
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [loadDocs, loadProjects, projectId]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void refresh();
		}, 0);
		return () => window.clearTimeout(timer);
		// intentionally mount-only; project changes reload docs below
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!projectId) return;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(LS_PROJECT_KEY, projectId);
		}
		let cancelled = false;
		(async () => {
			try {
				await loadDocs(projectId);
			} catch (e: unknown) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [loadDocs, projectId, refreshToken]);

	const selectProject = (id: string) => {
		onProjectIdChange(id);
	};

	const createProject = async () => {
		const name = window.prompt('New project name');
		if (!name?.trim()) return;
		setError(null);
		try {
			const res = await fetch('/api/knowledge/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `create failed (${res.status})`);
			await loadProjects();
			if (data.id) {
				onProjectIdChange(String(data.id));
			}
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const renameProject = async () => {
		if (!projectId) return;
		const current = projects.find((p) => p.id === projectId);
		const name = window.prompt('Rename project', current?.name || '');
		if (!name?.trim()) return;
		setError(null);
		try {
			const res = await fetch(`/api/knowledge/projects/${encodeURIComponent(projectId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `rename failed (${res.status})`);
			await loadProjects();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const removeProject = async () => {
		if (!projectId) return;
		const current = projects.find((p) => p.id === projectId);
		if (
			!window.confirm(
				`Delete project “${current?.name || projectId}” and ALL its documents from disk permanently?`,
			)
		) {
			return;
		}
		setError(null);
		try {
			const res = await fetch(`/api/knowledge/projects/${encodeURIComponent(projectId)}`, {
				method: 'DELETE',
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `delete failed (${res.status})`);
			await refresh();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const addNote = async () => {
		if (!projectId) {
			setError('Select a project before adding a note.');
			return;
		}
		const text = noteText.trim();
		if (!text) {
			setError('Note text required.');
			return;
		}
		setSavingNote(true);
		setError(null);
		try {
			const res = await fetch('/api/knowledge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId,
					title: noteTitle.trim() || undefined,
					text,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `note failed (${res.status})`);
			setNoteText('');
			setNoteTitle('');
			await loadDocs(projectId);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingNote(false);
		}
	};

	const previewDoc = async (id: string) => {
		if (previewId === id) {
			setPreviewId(null);
			setPreviewText(null);
			return;
		}
		setError(null);
		try {
			const res = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `get failed (${res.status})`);
			setPreviewId(id);
			setPreviewText(String(data.document?.rawText || ''));
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteDoc = async (id: string, title: string) => {
		if (!window.confirm(`Delete “${title}” from disk permanently?`)) return;
		setError(null);
		try {
			const res = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `delete failed (${res.status})`);
			if (previewId === id) {
				setPreviewId(null);
				setPreviewText(null);
			}
			if (projectId) await loadDocs(projectId);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const runReindex = async (scope: 'project' | 'all') => {
		const label =
			scope === 'project'
				? 'Re-embed all chunks in this project with the current embed model?'
				: 'Re-embed ALL chunks in the knowledge store with the current embed model?';
		if (!window.confirm(label)) return;
		if (scope === 'project' && !projectId) {
			setError('Select a project first.');
			return;
		}
		setReindexing(true);
		setError(null);
		try {
			const res = await fetch('/api/knowledge/reindex', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(scope === 'project' ? { projectId } : {}),
			});
			const data = await res.json();
			if (!res.ok || data?.ok === false) {
				throw new Error(data?.error || `reindex failed (${res.status})`);
			}
			await refresh();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setReindexing(false);
		}
	};

	const embedMissing = knowledgeStatus && knowledgeStatus.embedModelInstalled === false;

	return (
		<section className={`mb-4 overflow-hidden ${PANEL_OUTLINE}`}>
			<button
				type="button"
				className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-sm font-semibold text-[#e8eeff]"
				onClick={toggleOpen}
				aria-expanded={open}
			>
				<span>Knowledge store {projectId ? `(${total} docs)` : ''}</span>
				<span className="text-xs font-normal opacity-70">{open ? 'Hide' : 'Show'}</span>
			</button>

			{open ? (
				<div className={`space-y-3 border-t px-3 py-3 ${PANEL_DIVIDER}`}>
					<div className="flex flex-wrap items-center gap-2">
						<label className="flex items-center gap-2 text-[13px]">
							<span className="opacity-80">Project</span>
							<select
								value={projectId || ''}
								onChange={(e) => selectProject(e.target.value)}
								className={`min-w-[160px] px-2 py-1.5 ${CONTROL_INPUT}`}
							>
								{projects.length === 0 ? <option value="">No projects</option> : null}
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
										{typeof p.documentCount === 'number' ? ` (${p.documentCount})` : ''}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							onClick={() => void createProject()}
							className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
						>
							New
						</button>
						<button
							type="button"
							onClick={() => void renameProject()}
							disabled={!projectId}
							className={`cursor-pointer px-2 py-1 text-xs disabled:opacity-40 ${CONTROL_BTN}`}
						>
							Rename
						</button>
						<button
							type="button"
							onClick={() => void removeProject()}
							disabled={!projectId || projects.length <= 1}
							className={`cursor-pointer px-2 py-1 text-xs disabled:opacity-40 ${CONTROL_BTN}`}
						>
							Delete project
						</button>
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={loading || reindexing}
							className={`cursor-pointer px-2 py-1 text-xs ${CONTROL_BTN}`}
						>
							{loading ? 'Refreshing…' : 'Refresh'}
						</button>
						<button
							type="button"
							onClick={() => void runReindex('project')}
							disabled={!projectId || reindexing}
							className={`cursor-pointer px-2 py-1 text-xs disabled:opacity-40 ${CONTROL_BTN}`}
							title="Re-embed chunks for the active project"
						>
							{reindexing ? 'Reindexing…' : 'Reindex project'}
						</button>
					</div>

					{knowledgeStatus?.path ? (
						<p className="m-0 text-xs opacity-70">
							Disk path: <code className="text-[0.95em]">{knowledgeStatus.path}</code>
							{typeof knowledgeStatus.chunkCount === 'number'
								? ` · ${knowledgeStatus.chunkCount} chunks`
								: ''}
						</p>
					) : knowledgeStatus?.restricted ? (
						<p className="m-0 text-xs opacity-70">Store path hidden (non-loopback status).</p>
					) : null}

					{embedMissing ? (
						<p className={`m-0 px-2 py-1.5 text-xs ${NOTICE_STRIP}`}>
							Embed model missing. Run{' '}
							<code>ollama pull {knowledgeStatus?.embedModel || 'nomic-embed-text'}</code> for
							search and note saving.
						</p>
					) : null}

					{knowledgeStatus?.needsReindex ? (
						<div className={`flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs ${NOTICE_STRIP}`}>
							<span>
								Embed model/dims changed — reindex (or wipe the data dir) before searching.
							</span>
							<button
								type="button"
								onClick={() => void runReindex('all')}
								disabled={reindexing}
								className={`cursor-pointer px-2 py-0.5 text-[11px] font-semibold ${CONTROL_BTN}`}
							>
								{reindexing ? 'Reindexing…' : 'Reindex all'}
							</button>
						</div>
					) : null}

					<div className={`p-2 ${INNER_SURFACE}`}>
						<p className="mb-1.5 text-xs font-semibold">Add note</p>
						<input
							type="text"
							value={noteTitle}
							onChange={(e) => setNoteTitle(e.target.value)}
							placeholder="Title (optional)"
							disabled={!projectId || savingNote}
							className={`mb-1.5 w-full px-2 py-1.5 text-sm ${CONTROL_INPUT}`}
						/>
						<textarea
							value={noteText}
							onChange={(e) => setNoteText(e.target.value)}
							placeholder="Note text (saved to local disk under this project)…"
							rows={3}
							disabled={!projectId || savingNote}
							className={`mb-1.5 w-full resize-y px-2 py-1.5 text-sm ${CONTROL_INPUT}`}
						/>
						<button
							type="button"
							onClick={() => void addNote()}
							disabled={!projectId || savingNote || !noteText.trim()}
							className={`cursor-pointer px-2.5 py-1.5 text-xs disabled:cursor-wait ${PRIMARY_BTN}`}
						>
							{savingNote ? 'Saving…' : 'Save note'}
						</button>
						{!projectId ? (
							<p className="mt-1.5 mb-0 text-xs opacity-70">Select a project to save notes.</p>
						) : null}
					</div>

					{error ? <p className="m-0 text-sm text-rose-300">{error}</p> : null}

					<ul className="m-0 max-h-64 list-none space-y-2 overflow-auto p-0">
						{docs.length === 0 ? (
							<li className="text-xs opacity-60">No documents in this project yet.</li>
						) : (
							docs.map((doc) => (
								<li
									key={doc.id}
									className={`px-2.5 py-2 ${INNER_SURFACE}`}
								>
									<div className="flex flex-wrap items-start justify-between gap-2">
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span
													className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${badgeClass(doc.sourceType)}`}
												>
													{doc.sourceType}
												</span>
												<span className="truncate text-sm font-medium">{doc.title}</span>
											</div>
											<p className="m-0 mt-0.5 text-[11px] opacity-60">
												{new Date(doc.createdAt).toLocaleString()}
												{doc.url ? ` · ${doc.url}` : ''}
											</p>
										</div>
										<div className="flex gap-1">
											<button
												type="button"
												onClick={() => void previewDoc(doc.id)}
												className={`cursor-pointer px-1.5 py-0.5 text-[11px] ${CONTROL_BTN}`}
											>
												{previewId === doc.id ? 'Hide' : 'Preview'}
											</button>
											<button
												type="button"
												onClick={() => void deleteDoc(doc.id, doc.title)}
												className={`cursor-pointer px-1.5 py-0.5 text-[11px] ${CONTROL_BTN}`}
											>
												Delete
											</button>
										</div>
									</div>
									{previewId === doc.id && previewText != null ? (
										<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#3b82f6]/25 bg-black/25 p-2 text-[11px] leading-snug">
											{previewText}
										</pre>
									) : null}
								</li>
							))
						)}
					</ul>
				</div>
			) : null}
		</section>
	);
}
