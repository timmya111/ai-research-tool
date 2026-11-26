'use client';

import type { ReactNode } from 'react';
import {
	approxSpanYears,
	formatCareerSpanLabel,
	nestTimelineIntoCareerChapters,
	timelineDateSortable,
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

function PointEntryCard<T extends NestableTimelineEntry>({
	entry,
	renderEntry,
}: {
	entry: T;
	renderEntry: (entry: T) => ReactNode;
}) {
	return <div className='relative'>{renderEntry(entry)}</div>;
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
	const { chapters, unassigned, hasSpans } = nestTimelineIntoCareerChapters(entries);
	if (!hasSpans) {
		return <>{renderUnassignedYearSections(entries)}</>;
	}

	return (
		<div className='space-y-5'>
			<p className='m-0 text-[11px] leading-snug opacity-70'>
				Career chapters group exams and disclosures inside each employment / registration span.
			</p>

			{chapters.map((ch) => {
				const org = orgNameFromSpan(ch.span);
				const years = approxSpanYears(ch.start, ch.end, ch.isCurrent);
				const spanLabel = formatCareerSpanLabel(ch.start, ch.end, ch.isCurrent);
				const firmCrd = ch.span.metadata?.firmCrd ? String(ch.span.metadata.firmCrd) : null;
				const loc = ch.span.geoLabel || (ch.span.metadata?.location ? String(ch.span.metadata.location) : null);
				const jumpSlug =
					(ch.span.metadata?.orgSlug ? String(ch.span.metadata.orgSlug) : null) ||
					ch.span.linkedProfileSlug ||
					null;

				return (
					<section
						key={ch.span.id}
						className={
							ch.isCurrent ?
								'overflow-hidden rounded-lg border border-emerald-500/40 bg-emerald-500/8'
							:	'overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]'
						}>
						<header className='flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-[var(--app-border)] px-3 py-2.5'>
							<div className='min-w-0 flex-1'>
								<div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
									<h3 className='m-0 text-sm font-semibold leading-snug'>{org}</h3>
									{ch.isCurrent ?
										<span className='rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white'>
											Current
										</span>
									:	null}
									{firmCrd ?
										<span className='rounded border border-[var(--app-border)] px-1.5 py-0.5 font-mono text-[10px] opacity-75'>
											CRD {firmCrd}
										</span>
									:	null}
								</div>
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
								{ch.nested.length === 0 ?
									'No milestones in span'
								:	`${ch.nested.length} milestone${ch.nested.length === 1 ? '' : 's'} inside`}
							</div>
						</header>

						{ch.nested.length > 0 ?
							<div className='relative ml-3 space-y-0 border-l-2 border-emerald-500/35 py-2 pl-3.5 pr-2.5'>
								{ch.nested.map((entry) => {
									const day = timelineDateSortable(entry.eventDate) || entry.eventDate || '';
									return (
										<article
											key={entry.id}
											className='relative pb-3 last:pb-1'>
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
								})}
							</div>
						:	<p className='m-0 px-3 py-2 text-[11px] opacity-60'>
								Registration span with no dated exams or disclosures in this window.
								{jumpSlug ? ' Open the firm card from Employment History for roster context.' : ''}
							</p>}
					</section>
				);
			})}

			{unassigned.length > 0 ?
				<section className='space-y-2'>
					<div className='flex items-baseline gap-2 border-b border-[var(--app-border)] pb-1'>
						<h3 className='m-0 text-xs font-semibold tracking-wide uppercase opacity-80'>
							Outside employment spans
						</h3>
						<span className='text-[10px] opacity-60'>{unassigned.length}</span>
					</div>
					{renderUnassignedYearSections(unassigned)}
				</section>
			:	null}
		</div>
	);
}
