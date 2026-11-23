'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AlignmentEvidenceItem } from '@/lib/research/profiles/types';

function formatSourceCorpusLabel(corpus: string | null | undefined): string {
	const c = String(corpus || '').trim();
	if (!c) return 'source';
	if (c.startsWith('knowledge:')) return c.slice('knowledge:'.length) || c;
	return c;
}

function scrubLabels(text: string | null | undefined): string {
	return String(text || '')
		.replace(/\bepstein\b/gi, 'source')
		.trim();
}

function knowledgeDocId(sourceRef: string | null | undefined): string | null {
	const m = String(sourceRef || '').match(/^knowledge:doc:([0-9a-f-]{36})$/i);
	return m ? m[1] : null;
}

function extractResearchDrivePath(text: string | null | undefined): string | null {
	const s = String(text || '');
	const m =
		s.match(/\*\*Source path:\*\*\s*`([^`]+)`/i) ||
		s.match(/Source path:\s*`([^`]+)`/i) ||
		s.match(/Source path:\s*([^\n]+)/i);
	if (!m) return null;
	const p = m[1].trim().replace(/^`|`$/g, '');
	if (!p || p.includes('..') || pathLooksAbsolute(p)) return null;
	return p;
}

function pathLooksAbsolute(p: string): boolean {
	return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

function evidenceKey(ev: AlignmentEvidenceItem, idx: number): string {
	return ev.sourceRef || ev.url || `${ev.corpus}:${ev.label}:${idx}`;
}

type LoadedDoc = {
	id: string;
	title: string;
	rawText: string;
	url: string | null;
	sourcePath: string | null;
};

type Props = {
	evidence: AlignmentEvidenceItem[];
	/** Max chips to show before "show all" */
	initialLimit?: number;
	compact?: boolean;
};

export default function AlignmentEvidenceList({
	evidence,
	initialLimit = 8,
	compact = false,
}: Props) {
	const items = useMemo(() => {
		const seen = new Set<string>();
		const out: AlignmentEvidenceItem[] = [];
		for (const ev of evidence || []) {
			const k = ev.sourceRef || `${ev.corpus}|${ev.label}|${ev.snippet || ''}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(ev);
		}
		return out;
	}, [evidence]);

	const [showAll, setShowAll] = useState(false);
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [loadingKey, setLoadingKey] = useState<string | null>(null);
	const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
	const [docsByKey, setDocsByKey] = useState<Record<string, LoadedDoc>>({});

	const visible = showAll ? items : items.slice(0, initialLimit);

	const loadDoc = useCallback(async (key: string, docId: string) => {
		if (docsByKey[key]) return;
		setLoadingKey(key);
		setErrorByKey((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
		try {
			const res = await fetch(`/api/knowledge/${encodeURIComponent(docId)}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `load failed (${res.status})`);
			const rawText = String(data.document?.rawText || '');
			const sourcePath =
				extractResearchDrivePath(rawText) ||
				(typeof data.document?.metadata?.sourcePath === 'string'
					? String(data.document.metadata.sourcePath)
					: null);
			setDocsByKey((prev) => ({
				...prev,
				[key]: {
					id: docId,
					title: String(data.document?.title || docId),
					rawText,
					url: data.document?.url != null ? String(data.document.url) : null,
					sourcePath,
				},
			}));
		} catch (e: unknown) {
			setErrorByKey((prev) => ({
				...prev,
				[key]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setLoadingKey(null);
		}
	}, [docsByKey]);

	const toggle = useCallback(
		(ev: AlignmentEvidenceItem, idx: number) => {
			const key = evidenceKey(ev, idx);
			if (openKey === key) {
				setOpenKey(null);
				return;
			}
			setOpenKey(key);
			const docId = knowledgeDocId(ev.sourceRef);
			if (docId) void loadDoc(key, docId);
		},
		[loadDoc, openKey],
	);

	if (!items.length) return null;

	return (
		<div className={compact ? 'mt-1.5 space-y-1.5' : 'mt-2 space-y-2'}>
			<div className="text-[10px] font-semibold uppercase tracking-wide opacity-60">
				Source evidence — click to open
			</div>
			<div className="flex flex-col gap-1.5">
				{visible.map((ev, idx) => {
					const key = evidenceKey(ev, idx);
					const open = openKey === key;
					const doc = docsByKey[key];
					const docId = knowledgeDocId(ev.sourceRef);
					const snippet = scrubLabels(ev.snippet);
					const err = errorByKey[key];
					const imagePath = doc?.sourcePath || extractResearchDrivePath(snippet);
					const imageUrl = imagePath
						? `/api/research-drive/file?path=${encodeURIComponent(imagePath)}`
						: null;

					return (
						<div
							key={key}
							className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]"
						>
							<button
								type="button"
								onClick={() => toggle(ev, idx)}
								aria-expanded={open}
								className="flex w-full cursor-pointer items-start gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-[11px] hover:bg-[var(--app-surface)]"
							>
								<span className="mt-0.5 shrink-0 text-[10px] opacity-50">{open ? '▼' : '▶'}</span>
								<span className="min-w-0 flex-1">
									<strong className="text-[#F97316]">{formatSourceCorpusLabel(ev.corpus)}</strong>
									<span className="opacity-80">
										:{' '}
										{scrubLabels(ev.label)}
										{ev.date ? ` (${ev.date})` : ''}
									</span>
									{docId ? (
										<span className="ml-1.5 inline-block rounded bg-sky-500/10 px-1 py-0.5 text-[9px] text-sky-800 dark:text-sky-200">
											knowledge doc
										</span>
									) : null}
									{ev.url ? (
										<span className="ml-1.5 inline-block rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] text-emerald-800 dark:text-emerald-200">
											has URL
										</span>
									) : null}
									{!open && snippet ? (
										<span className="mt-0.5 block line-clamp-2 opacity-65">{snippet}</span>
									) : null}
								</span>
							</button>

							{open ? (
								<div className="space-y-2 border-t border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-[11px]">
									{ev.url ? (
										<p className="m-0">
											<a
												href={ev.url}
												target="_blank"
												rel="noreferrer"
												className="text-[#F97316] underline"
											>
												Open linked URL
											</a>
										</p>
									) : null}

									{snippet && !doc ? (
										<div>
											<div className="mb-0.5 text-[10px] font-semibold opacity-60">Match snippet</div>
											<pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[10px] leading-relaxed opacity-90">
												{snippet}
											</pre>
										</div>
									) : null}

									{loadingKey === key ? (
										<p className="m-0 text-[10px] opacity-70">Loading full document…</p>
									) : null}
									{err ? <p className="m-0 text-[10px] text-red-600 dark:text-red-400">{err}</p> : null}

									{doc ? (
										<div className="space-y-2">
											<div className="flex flex-wrap items-center gap-2 text-[10px] opacity-70">
												<span>Full OCR / text: {doc.title}</span>
												{doc.sourcePath ? <span>· file `{doc.sourcePath}`</span> : null}
												{doc.url ? (
													<a
														href={doc.url}
														target="_blank"
														rel="noreferrer"
														className="text-[#F97316] underline"
													>
														source URL
													</a>
												) : null}
											</div>
											{imageUrl ? (
												<div>
													<div className="mb-1 text-[10px] font-semibold opacity-60">
														Original file preview
													</div>
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img
														src={imageUrl}
														alt={doc.sourcePath || doc.title}
														className="max-h-[420px] w-auto max-w-full rounded border border-[var(--app-border)] object-contain bg-black/5"
													/>
												</div>
											) : null}
											<pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[10px] leading-relaxed">
												{doc.rawText || '(empty document)'}
											</pre>
										</div>
									) : null}

									{!docId && !snippet && !ev.url ? (
										<p className="m-0 text-[10px] opacity-60">
											No snippet or document id on this evidence chip.
											{ev.sourceRef ? ` Ref: ${ev.sourceRef}` : ''}
										</p>
									) : null}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			{items.length > initialLimit ? (
				<button
					type="button"
					onClick={() => setShowAll((v) => !v)}
					className="cursor-pointer border-0 bg-transparent p-0 text-[10px] text-[#F97316] underline"
				>
					{showAll ? 'Show fewer sources' : `Show all ${items.length} sources`}
				</button>
			) : null}
		</div>
	);
}
