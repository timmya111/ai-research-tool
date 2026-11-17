'use client';

import { useCallback, useEffect, useState } from 'react';

const LS_PROJECT_KEY = 'research.activeProjectId';

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
	if (sourceType === 'chat') return 'bg-sky-500/15 text-sky-800 dark:text-sky-200';
	if (sourceType === 'fetch') return 'bg-violet-500/15 text-violet-800 dark:text-violet-200';
	return 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200';
}

export default function KnowledgePanel({
	knowledgeStatus,
	projectId,
	onProjectIdChange,
	refreshToken = 0,
}: Props) {
	const [open, setOpen] = useState(true);
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
		void refresh();
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
		<section className="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60">
			<button
				type="button"
				className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-semibold"
				onClick={() => setOpen((v) => !v)}
			>
				<span>Knowledge store {projectId ? `(${total} docs)` : ''}</span>
				<span className="text-xs font-normal opacity-70">{open ? 'Hide' : 'Show'}</span>
			</button>

			{open ? (
				<div className="space-y-3 border-t border-zinc-300 px-3 py-3 dark:border-zinc-700">
					<div className="flex flex-wrap items-center gap-2">
						<label className="flex items-center gap-2 text-[13px]">
							<span className="opacity-80">Project</span>
							<select
								value={projectId || ''}
								onChange={(e) => selectProject(e.target.value)}
								className="min-w-[160px] rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-600 dark:bg-zinc-950"
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
							className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
						>
							New
						</button>
						<button
							type="button"
							onClick={() => void renameProject()}
							disabled={!projectId}
							className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-600"
						>
							Rename
						</button>
						<button
							type="button"
							onClick={() => void removeProject()}
							disabled={!projectId || projects.length <= 1}
							className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-600"
						>
							Delete project
						</button>
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={loading || reindexing}
							className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
						>
							{loading ? 'Refreshing…' : 'Refresh'}
						</button>
						<button
							type="button"
							onClick={() => void runReindex('project')}
							disabled={!projectId || reindexing}
							className="cursor-pointer rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs disabled:opacity-40 dark:border-zinc-600"
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
						<p className="m-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs">
							Embed model missing. Run{' '}
							<code>ollama pull {knowledgeStatus?.embedModel || 'nomic-embed-text'}</code> for
							search and note saving.
						</p>
					) : null}

					{knowledgeStatus?.needsReindex ? (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs">
							<span>
								Embed model/dims changed — reindex (or wipe the data dir) before searching.
							</span>
							<button
								type="button"
								onClick={() => void runReindex('all')}
								disabled={reindexing}
								className="cursor-pointer rounded border border-amber-700/40 bg-transparent px-2 py-0.5 text-[11px] font-semibold"
							>
								{reindexing ? 'Reindexing…' : 'Reindex all'}
							</button>
						</div>
					) : null}

					<div className="rounded-md border border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-950">
						<p className="mb-1.5 text-xs font-semibold">Add note</p>
						<input
							type="text"
							value={noteTitle}
							onChange={(e) => setNoteTitle(e.target.value)}
							placeholder="Title (optional)"
							disabled={!projectId || savingNote}
							className="mb-1.5 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-600"
						/>
						<textarea
							value={noteText}
							onChange={(e) => setNoteText(e.target.value)}
							placeholder="Note text (saved to local disk under this project)…"
							rows={3}
							disabled={!projectId || savingNote}
							className="mb-1.5 w-full resize-y rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-600"
						/>
						<button
							type="button"
							onClick={() => void addNote()}
							disabled={!projectId || savingNote || !noteText.trim()}
							className="cursor-pointer rounded-md border-none bg-[#F97316] px-2.5 py-1.5 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-50"
						>
							{savingNote ? 'Saving…' : 'Save note'}
						</button>
						{!projectId ? (
							<p className="mt-1.5 mb-0 text-xs opacity-70">Select a project to save notes.</p>
						) : null}
					</div>

					{error ? <p className="m-0 text-sm text-red-700 dark:text-red-400">{error}</p> : null}

					<ul className="m-0 max-h-64 list-none space-y-2 overflow-auto p-0">
						{docs.length === 0 ? (
							<li className="text-xs opacity-60">No documents in this project yet.</li>
						) : (
							docs.map((doc) => (
								<li
									key={doc.id}
									className="rounded-md border border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-700 dark:bg-zinc-950"
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
												className="cursor-pointer rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-[11px] dark:border-zinc-600"
											>
												{previewId === doc.id ? 'Hide' : 'Preview'}
											</button>
											<button
												type="button"
												onClick={() => void deleteDoc(doc.id, doc.title)}
												className="cursor-pointer rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-[11px] dark:border-zinc-600"
											>
												Delete
											</button>
										</div>
									</div>
									{previewId === doc.id && previewText != null ? (
										<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px] leading-snug dark:bg-white/5">
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
