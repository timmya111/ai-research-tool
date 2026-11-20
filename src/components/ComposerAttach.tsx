'use client';

import { useEffect, useRef, useState } from 'react';

type AttachMode = 'menu' | 'note' | 'paste' | null;

type Props = {
	projectId: string | null;
	disabled?: boolean;
	onAttached?: (info: { title?: string; count?: number }) => void;
	onError?: (message: string) => void;
};

export function ComposerAttach({ projectId, disabled, onAttached, onError }: Props) {
	const [open, setOpen] = useState<AttachMode>(null);
	const [busy, setBusy] = useState(false);
	const [title, setTitle] = useState('');
	const [text, setText] = useState('');
	const [url, setUrl] = useState('');
	const rootRef = useRef<HTMLDivElement | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const imageRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			const el = rootRef.current;
			if (!el) return;
			if (e.target instanceof Node && !el.contains(e.target)) setOpen(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(null);
		};
		document.addEventListener('mousedown', onDoc);
		window.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			window.removeEventListener('keydown', onKey);
		};
	}, [open]);

	const requireProject = () => {
		if (projectId) return true;
		onError?.('Select or create a knowledge project before attaching.');
		return false;
	};

	const saveJson = async (body: Record<string, unknown>) => {
		if (!requireProject()) return;
		setBusy(true);
		try {
			const res = await fetch('/api/knowledge/attachments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId, ...body }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `attach failed (${res.status})`);
			setTitle('');
			setText('');
			setUrl('');
			setOpen(null);
			onAttached?.({ title: data.title, count: 1 });
		} catch (e: unknown) {
			onError?.(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const uploadFiles = async (files: FileList | File[] | null, kind: 'file' | 'image') => {
		if (!requireProject() || !files || files.length === 0) return;
		setBusy(true);
		try {
			const form = new FormData();
			form.set('projectId', projectId!);
			if (title.trim()) form.set('title', title.trim());
			for (const file of Array.from(files).slice(0, 8)) {
				form.append('files', file);
			}
			const res = await fetch('/api/knowledge/attachments', {
				method: 'POST',
				body: form,
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) {
				const firstErr = Array.isArray(data?.results)
					? data.results.find((r: { ok?: boolean; error?: string }) => !r.ok)?.error
					: null;
				throw new Error(firstErr || data?.error || `upload failed (${res.status})`);
			}
			const okCount = Array.isArray(data.results)
				? data.results.filter((r: { ok?: boolean }) => r.ok).length
				: 1;
			const firstTitle = Array.isArray(data.results)
				? data.results.find((r: { ok?: boolean; title?: string }) => r.ok)?.title
				: undefined;
			setTitle('');
			setOpen(null);
			onAttached?.({ title: firstTitle, count: okCount });
		} catch (e: unknown) {
			onError?.(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
			if (kind === 'file' && fileRef.current) fileRef.current.value = '';
			if (kind === 'image' && imageRef.current) imageRef.current.value = '';
		}
	};

	return (
		<div ref={rootRef} className="relative flex flex-col items-stretch">
			<button
				type="button"
				disabled={disabled || busy}
				aria-label="Attach note, paste, file, or screenshot"
				title="Attach note / paste / files / screenshots"
				aria-expanded={open != null}
				onClick={() => setOpen((v) => (v ? null : 'menu'))}
				className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-surface-hover)] text-sm font-bold leading-none text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-60"
			>
				{busy ? '…' : '+'}
			</button>

			{open === 'menu' ? (
				<div
					role="menu"
					className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-56 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] shadow-lg"
				>
					<p className="border-b border-[var(--app-border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-60">
						Add to knowledge
					</p>
					<button
						type="button"
						role="menuitem"
						className="block w-full cursor-pointer px-2.5 py-2 text-left text-xs hover:bg-[var(--app-surface-hover)]"
						onClick={() => setOpen('note')}
					>
						Note
					</button>
					<button
						type="button"
						role="menuitem"
						className="block w-full cursor-pointer px-2.5 py-2 text-left text-xs hover:bg-[var(--app-surface-hover)]"
						onClick={() => setOpen('paste')}
					>
						Paste web content
					</button>
					<button
						type="button"
						role="menuitem"
						className="block w-full cursor-pointer px-2.5 py-2 text-left text-xs hover:bg-[var(--app-surface-hover)]"
						onClick={() => fileRef.current?.click()}
					>
						Upload documents
					</button>
					<button
						type="button"
						role="menuitem"
						className="block w-full cursor-pointer px-2.5 py-2 text-left text-xs hover:bg-[var(--app-surface-hover)]"
						onClick={() => imageRef.current?.click()}
					>
						Screenshot / image
						<span className="mt-0.5 block text-[10px] font-normal opacity-60">
							OCR names from URL / logo / text
						</span>
					</button>
				</div>
			) : null}

			{open === 'note' || open === 'paste' ? (
				<div className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-[min(92vw,22rem)] rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-2.5 shadow-lg">
					<p className="m-0 mb-2 text-xs font-semibold">
						{open === 'paste' ? 'Paste saved web content' : 'Add note'}
					</p>
					<input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder={open === 'paste' ? 'Title (optional — auto from content/URL)' : 'Title (optional)'}
						className="mb-1.5 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1.5 text-xs"
					/>
					{open === 'paste' ? (
						<input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="Source URL (optional)"
							className="mb-1.5 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1.5 text-xs"
						/>
					) : null}
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={6}
						placeholder={
							open === 'paste'
								? 'Paste article text or HTML copied from the web…'
								: 'Write a freeform research note…'
						}
						className="mb-2 w-full resize-y rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1.5 text-xs"
					/>
					<div className="flex justify-end gap-1.5">
						<button
							type="button"
							className="cursor-pointer rounded-md border border-[var(--app-border)] px-2 py-1 text-[11px]"
							onClick={() => setOpen('menu')}
							disabled={busy}
						>
							Back
						</button>
						<button
							type="button"
							disabled={busy || !text.trim()}
							className="cursor-pointer rounded-md border-none bg-[#F97316] px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
							onClick={() =>
								void saveJson(
									open === 'paste'
										? { mode: 'paste', text, title: title || undefined, url: url || undefined }
										: { mode: 'note', text, title: title || undefined },
								)
							}
						>
							{busy ? 'Saving…' : 'Save'}
						</button>
					</div>
				</div>
			) : null}

			<input
				ref={fileRef}
				type="file"
				multiple
				accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.log,.yml,.yaml,text/*,application/pdf,application/json"
				className="hidden"
				onChange={(e) => void uploadFiles(e.target.files, 'file')}
			/>
			<input
				ref={imageRef}
				type="file"
				multiple
				accept="image/*,.png,.jpg,.jpeg,.webp,.gif"
				className="hidden"
				onChange={(e) => void uploadFiles(e.target.files, 'image')}
			/>
		</div>
	);
}
