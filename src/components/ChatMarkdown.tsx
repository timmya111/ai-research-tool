'use client';

import { Fragment, type ReactNode } from 'react';

type Block =
	| { type: 'table'; headers: string[]; rows: string[][] }
	| { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
	| { type: 'hr' }
	| { type: 'list'; ordered: boolean; items: string[] }
	| { type: 'paragraph'; text: string }
	| { type: 'blank' };

function isTableSep(line: string): boolean {
	const t = line.trim();
	if (!t.includes('|')) return false;
	return /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(t) && /-+/.test(t);
}

function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|')) s = s.slice(0, -1);
	return s.split('|').map((c) => c.trim());
}

function looksLikeTableStart(lines: string[], i: number): boolean {
	const a = lines[i]?.trim() ?? '';
	const b = lines[i + 1]?.trim() ?? '';
	if (!a.includes('|') || !b) return false;
	return isTableSep(b) && splitRow(a).length >= 2;
}

function parseBlocks(src: string): Block[] {
	const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? '';
		const trimmed = line.trim();

		if (!trimmed) {
			blocks.push({ type: 'blank' });
			i += 1;
			continue;
		}

		if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
			blocks.push({ type: 'hr' });
			i += 1;
			continue;
		}

		const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
		if (heading) {
			blocks.push({
				type: 'heading',
				level: Math.min(4, heading[1].length) as 1 | 2 | 3 | 4,
				text: heading[2].trim(),
			});
			i += 1;
			continue;
		}

		if (looksLikeTableStart(lines, i)) {
			const headers = splitRow(lines[i] ?? '');
			i += 2; // skip header + separator
			const rows: string[][] = [];
			while (i < lines.length) {
				const rowLine = lines[i] ?? '';
				if (!rowLine.trim() || !rowLine.includes('|') || isTableSep(rowLine)) break;
				const cells = splitRow(rowLine);
				while (cells.length < headers.length) cells.push('');
				rows.push(cells.slice(0, Math.max(headers.length, cells.length)));
				i += 1;
			}
			blocks.push({ type: 'table', headers, rows });
			continue;
		}

		const ordered = /^\d+\.\s+/.test(trimmed);
		const unordered = /^[-*+]\s+/.test(trimmed);
		if (ordered || unordered) {
			const items: string[] = [];
			while (i < lines.length) {
				const itemLine = (lines[i] ?? '').trim();
				if (!itemLine) break;
				if (ordered && !/^\d+\.\s+/.test(itemLine)) break;
				if (unordered && !/^[-*+]\s+/.test(itemLine)) break;
				items.push(itemLine.replace(ordered ? /^\d+\.\s+/ : /^[-*+]\s+/, ''));
				i += 1;
			}
			blocks.push({ type: 'list', ordered, items });
			continue;
		}

		const para: string[] = [line];
		i += 1;
		while (i < lines.length) {
			const next = lines[i] ?? '';
			const nt = next.trim();
			if (!nt) break;
			if (/^#{1,4}\s+/.test(nt) || /^---+$/.test(nt) || looksLikeTableStart(lines, i)) break;
			if (/^\d+\.\s+/.test(nt) || /^[-*+]\s+/.test(nt)) break;
			para.push(next);
			i += 1;
		}
		blocks.push({ type: 'paragraph', text: para.join('\n') });
	}

	return blocks;
}

function isNumericCell(text: string): boolean {
	const t = text.replace(/\*\*/g, '').replace(/,/g, '').trim();
	if (!t || t === '—' || t === '-') return false;
	return /^-?\d+(\.\d+)?%?$/.test(t) || /^m\s*[≥>=]?\s*\d/i.test(t);
}

/** Inline markdown: **bold**, `code`, [text](url) */
function renderInline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let key = 0;
	while ((m = re.exec(text)) != null) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		const token = m[0];
		if (token.startsWith('**')) {
			nodes.push(
				<strong key={key++} className="font-semibold">
					{token.slice(2, -2)}
				</strong>,
			);
		} else if (token.startsWith('`')) {
			nodes.push(
				<code
					key={key++}
					className="rounded px-1 py-0.5 text-[0.92em] bg-[var(--app-surface-hover)]"
				>
					{token.slice(1, -1)}
				</code>,
			);
		} else {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
			if (link) {
				nodes.push(
					<a
						key={key++}
						href={link[2]}
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 opacity-90 hover:opacity-100"
					>
						{link[1]}
					</a>,
				);
			} else {
				nodes.push(token);
			}
		}
		last = m.index + token.length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
	const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
	const numericCols = Array.from({ length: colCount }, (_, col) => {
		const samples = rows.map((r) => r[col] ?? '').filter(Boolean);
		if (samples.length === 0) return false;
		const hits = samples.filter(isNumericCell).length;
		return hits >= Math.ceil(samples.length * 0.6);
	});

	return (
		<div className="chat-md-table-wrap my-2.5 max-w-full overflow-x-auto rounded-md border border-[var(--app-border)]">
			<table className="chat-md-table w-max min-w-full border-collapse text-[12.5px] leading-snug">
				<thead>
					<tr className="bg-[var(--app-surface-hover)]">
						{headers.map((h, i) => (
							<th
								key={`h-${i}`}
								className={`border-b border-[var(--app-border)] px-2.5 py-1.5 font-semibold whitespace-nowrap ${
									numericCols[i] ? 'text-right' : 'text-left'
								}`}
							>
								{renderInline(h)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, ri) => (
						<tr
							key={`r-${ri}`}
							className="odd:bg-transparent even:bg-[color-mix(in_srgb,var(--app-surface-hover)_45%,transparent)]"
						>
							{Array.from({ length: colCount }, (_, ci) => {
								const cell = row[ci] ?? '';
								return (
									<td
										key={`c-${ri}-${ci}`}
										className={`border-b border-[var(--app-border)] px-2.5 py-1 align-top ${
											numericCols[ci]
												? 'text-right whitespace-nowrap tabular-nums'
												: 'text-left'
										}`}
									>
										{renderInline(cell)}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const headingClass: Record<1 | 2 | 3 | 4, string> = {
	1: 'mt-3 mb-1.5 text-[1.15em] font-semibold tracking-tight',
	2: 'mt-3 mb-1.5 text-[1.08em] font-semibold tracking-tight',
	3: 'mt-2.5 mb-1 text-[1.02em] font-semibold tracking-tight',
	4: 'mt-2 mb-1 text-[0.98em] font-semibold tracking-tight',
};

export default function ChatMarkdown({ content }: { content: string }) {
	const blocks = parseBlocks(content);

	return (
		<div className="chat-md text-[13.5px] leading-[1.45]">
			{blocks.map((block, i) => {
				if (block.type === 'blank') {
					return <div key={i} className="h-2" aria-hidden />;
				}
				if (block.type === 'hr') {
					return <hr key={i} className="my-3 border-0 border-t border-[var(--app-border)]" />;
				}
				if (block.type === 'heading') {
					const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4';
					return (
						<Tag key={i} className={headingClass[block.level]}>
							{renderInline(block.text)}
						</Tag>
					);
				}
				if (block.type === 'table') {
					return <TableBlock key={i} headers={block.headers} rows={block.rows} />;
				}
				if (block.type === 'list') {
					const ListTag = block.ordered ? 'ol' : 'ul';
					return (
						<ListTag
							key={i}
							className={`my-1.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
						>
							{block.items.map((item, j) => (
								<li key={j} className="my-0.5 pl-0.5">
									{renderInline(item)}
								</li>
							))}
						</ListTag>
					);
				}
				return (
					<p key={i} className="my-1.5 whitespace-pre-wrap">
						{block.text.split('\n').map((line, li, arr) => (
							<Fragment key={li}>
								{renderInline(line)}
								{li < arr.length - 1 ? <br /> : null}
							</Fragment>
						))}
					</p>
				);
			})}
		</div>
	);
}
