'use client';

import type { ReactNode } from 'react';
import {
	approxSpanYears,
	buildCareerChronologicalStream,
	formatCareerSpanLabel,
	nestTimelineIntoCareerChapters,
	timelineDateSortable,
	type CareerChapter,
	type CareerStreamItem,
	type NestableTimelineEntry,
} from '@/lib/research/profiles/employmentTimelineNest';

function orgNameFromSpan(span: NestableTimelineEntry): string {
	const meta = span.metadata || {};
	const fromMeta = String(meta.orgName || '').trim();
	if (fromMeta) return fromMeta;
	return String(span.title || '')
		.replace(/^(Registered at|Employed at|Affiliated with|At)\s+/i, '')
		.replace(/\s*\(current\)\s*$/i, '')
		.trim();
}

function roleFromSpan(span: NestableTimelineEntry): string | null {
	const meta = span.metadata || {};
	const role = String(meta.roleLabel || meta.role || '').trim();
	if (role) return role;
	const title = String(span.title || '');
	const m = title.match(/^(.*?)\s+at\s+/i);
	const fromTitle = m?.[1]?.trim() || '';
	if (fromTitle && !/^(registered|employed|affiliated)$/i.test(fromTitle)) return fromTitle;
	return null;
}

function PointEntryCard<T extends NestableTimelineEntry>({
	entry,
	renderEntry,
}: {
	entry: T;
	renderEntry: (entry: T) => ReactNode;
}) {
	return <div className='relative'>{renderEntry(entry)}</div>;
}

function StreamPoint<T extends NestableTimelineEntry>({
	entry,
	renderPointEntry,
}: {
	entry: T;
	renderPointEntry: (entry: T) => ReactNode;
}) {
	const day = timelineDateSortable(entry.eventDate) || entry.eventDate || '';
	return (
		<article className='relative pb-3 last:pb-1'>
			<span
				aria-hidden
				className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-emerald-500 bg-[var(--app-surface)]'
			/>
			<div className='mb-0.5 font-mono text-[11px] font-semibold opacity-80'>{day}</div>
			<PointEntryCard
				entry={entry}
				renderEntry={renderPointEntry}
			/>
		</article>
	);
}

function CareerChapterCard<T extends NestableTimelineEntry>({
	chapter,
	renderPointEntry,
	depth = 0,
}: {
	chapter: CareerChapter<T>;
	renderPointEntry: (entry: T) => ReactNode;
	depth?: number;
}) {
	const org = orgNameFromSpan(chapter.span);
	const role = roleFromSpan(chapter.span);
	const years = approxSpanYears(chapter.start, chapter.end, chapter.isCurrent);
	const spanLabel = formatCareerSpanLabel(chapter.start, chapter.end, chapter.isCurrent);
	const firmCrd = chapter.span.metadata?.firmCrd ? String(chapter.span.metadata.firmCrd) : null;
	const loc =
		chapter.span.geoLabel ||
		(chapter.span.metadata?.location ? String(chapter.span.metadata.location) : null);
	const jumpSlug =
		(chapter.span.metadata?.orgSlug ? String(chapter.span.metadata.orgSlug) : null) ||
		chapter.span.linkedProfileSlug ||
		null;

	const innerStream = buildCareerChronologicalStream(chapter.children, chapter.nested);
	const nestedCount =
		chapter.nested.length +
		chapter.children.reduce((n, c) => n + c.nested.length + c.children.length + 1, 0);

	return (
		<section
			className={
				chapter.isCurrent ?
					'overflow-hidden rounded-lg border border-emerald-500/40 bg-emerald-500/8'
				: depth > 0 ?
					'overflow-hidden rounded-lg border border-sky-500/30 bg-sky-500/5'
				:	'overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]'
			}>
			<header className='flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-[var(--app-border)] px-3 py-2.5'>
				<div className='min-w-0 flex-1'>
					<div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
						<h3 className={`m-0 font-semibold leading-snug ${depth > 0 ? 'text-xs' : 'text-sm'}`}>
							{org}
						</h3>
						{chapter.isCurrent ?
							<span className='rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white'>
								Current
							</span>
						:	null}
						{depth > 0 ?
							<span className='rounded border border-sky-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-800 opacity-80 dark:text-sky-200'>
								Within career
							</span>
						:	null}
						{firmCrd ?
							<span className='rounded border border-[var(--app-border)] px-1.5 py-0.5 font-mono text-[10px] opacity-75'>
								CRD {firmCrd}
							</span>
						:	null}
					</div>
					{role ?
						<p className='m-0 mt-0.5 text-[11px] leading-snug opacity-80'>{role}</p>
					:	null}
					<div className='mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] opacity-80'>
						<span className='font-mono font-semibold tabular-nums'>{spanLabel}</span>
						{years != null ?
							<span className='opacity-70'>
								{years < 1 ? `${Math.round(years * 12)} mo` : `${years} yr${years === 1 ? '' : 's'}`}
							</span>
						:	null}
						{loc ?
							<span className='opacity-70'>📍 {loc}</span>
						:	null}
					</div>
				</div>
				<div className='text-[10px] font-medium opacity-65'>
					{nestedCount === 0 ?
						'No milestones in span'
					:	`${nestedCount} item${nestedCount === 1 ? '' : 's'} inside`}
				</div>
			</header>

			{innerStream.length > 0 ?
				<div className='relative ml-3 space-y-2 border-l-2 border-emerald-500/35 py-2 pl-3.5 pr-2.5'>
					{innerStream.map((item) =>
						item.kind === 'chapter' ?
							<div
								key={item.chapter.span.id}
								className='pb-1'>
								<CareerChapterCard
									chapter={item.chapter}
									renderPointEntry={renderPointEntry}
									depth={depth + 1}
								/>
							</div>
						:	<StreamPoint
								key={item.entry.id}
								entry={item.entry}
								renderPointEntry={renderPointEntry}
							/>,
					)}
				</div>
			:	<p className='m-0 px-3 py-2 text-[11px] opacity-60'>
					Registration span with no dated exams or disclosures in this window.
					{jumpSlug ? ' Open the firm card from Employment History for roster context.' : ''}
				</p>}
		</section>
	);
}

function renderStreamItems<T extends NestableTimelineEntry>(
	stream: CareerStreamItem<T>[],
	renderPointEntry: (entry: T) => ReactNode,
	renderUnassignedYearSections: (entries: T[]) => ReactNode,
): ReactNode {
	const nodes: ReactNode[] = [];
	let pendingPoints: T[] = [];

	const flushPoints = (key: string) => {
		if (!pendingPoints.length) return;
		nodes.push(
			<div
				key={key}
				className='space-y-2'>
				{renderUnassignedYearSections(pendingPoints)}
			</div>,
		);
		pendingPoints = [];
	};

	stream.forEach((item, idx) => {
		if (item.kind === 'point') {
			pendingPoints.push(item.entry);
			return;
		}
		flushPoints(`pts-before-${item.chapter.span.id}-${idx}`);
		nodes.push(
			<CareerChapterCard
				key={item.chapter.span.id}
				chapter={item.chapter}
				renderPointEntry={renderPointEntry}
			/>,
		);
	});
	flushPoints('pts-tail');
	return nodes;
}

export function ProfileTimelineCareerView<T extends NestableTimelineEntry>({
	entries,
	renderPointEntry,
	renderUnassignedYearSections,
}: {
	entries: T[];
	/** Render a single point event (exam, disclosure, observation). */
	renderPointEntry: (entry: T) => ReactNode;
	/** Fallback year-bucket UI for events outside employment spans. */
	renderUnassignedYearSections: (entries: T[]) => ReactNode;
}) {
	const { stream, hasSpans } = nestTimelineIntoCareerChapters(entries);
	if (!hasSpans) {
		return <>{renderUnassignedYearSections(entries)}</>;
	}

	return (
		<div className='space-y-5'>
			<p className='m-0 text-[11px] leading-snug opacity-70'>
				Career chapters in dated order — longer employment ranges encapsulate shorter stints and
				milestones that fall inside them.
			</p>
			{renderStreamItems(stream, renderPointEntry, renderUnassignedYearSections)}
		</div>
	);
}
