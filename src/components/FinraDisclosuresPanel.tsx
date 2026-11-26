'use client';

import { useMemo, useState } from 'react';
import type { FinraDisclosureEvent, ProfileFinraDisclosures } from '@/lib/research/finraDisclosuresShared';
import { hasDisplayableDisclosures } from '@/lib/research/finraDisclosuresShared';

function SourcePill({ kind }: { kind: 'finra' | 'sec' }) {
	return (
		<span
			className={
				kind === 'finra' ?
					'rounded border border-violet-500/40 bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200'
				:	'rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900 dark:text-sky-200'
			}>
			{kind === 'finra' ? 'FINRA' : 'SEC'}
		</span>
	);
}

const INITIAL_VISIBLE = 8;

function pickAllegation(ev: FinraDisclosureEvent): string | null {
	const f = ev.fields.find((x) => /allegation/i.test(x.label));
	return f?.value?.trim() || null;
}

function secondaryFields(ev: FinraDisclosureEvent) {
	return ev.fields.filter((f) => !/allegation/i.test(f.label));
}

function DisclosureEventCard({ ev }: { ev: FinraDisclosureEvent }) {
	const allegation = pickAllegation(ev);
	const rest = secondaryFields(ev);
	const [open, setOpen] = useState(Boolean(allegation) || rest.length <= 4);

	return (
		<li className='rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2'>
			<div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
				{ev.eventDate ?
					<span className='font-mono text-[11px] font-semibold tabular-nums'>{ev.eventDate}</span>
				:	null}
				<span className='text-[11px] font-semibold'>{ev.disclosureType}</span>
				{ev.resolution ?
					<span className='rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] font-medium opacity-80'>
						{ev.resolution}
					</span>
				:	null}
				<span className='flex gap-1'>
					{ev.sources.includes('finra') ?
						<SourcePill kind='finra' />
					:	null}
					{ev.sources.includes('sec') ?
						<SourcePill kind='sec' />
					:	null}
				</span>
				{rest.length > 0 ?
					<button
						type='button'
						onClick={() => setOpen((v) => !v)}
						className='ml-auto cursor-pointer border-0 bg-transparent text-[10px] font-medium opacity-70 hover:opacity-100'>
						{open ? 'Hide details' : 'Show details'}
					</button>
				:	null}
			</div>
			{allegation ?
				<p className='mt-1.5 mb-0 text-[11px] leading-snug whitespace-pre-wrap'>
					<span className='font-semibold opacity-70'>Allegations: </span>
					{allegation}
				</p>
			:	null}
			{open && rest.length > 0 ?
				<dl className='mt-1.5 m-0 grid gap-1'>
					{rest.map((f) => (
						<div
							key={f.label}
							className='text-[11px] leading-snug'>
							<dt className='inline font-semibold opacity-70'>{f.label}: </dt>
							<dd className='m-0 inline whitespace-pre-wrap'>{f.value}</dd>
						</div>
					))}
				</dl>
			:	null}
		</li>
	);
}

export function FinraDisclosuresPanel({
	data,
	loading,
	error,
}: {
	data: ProfileFinraDisclosures | null;
	loading?: boolean;
	error?: string | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showAll, setShowAll] = useState(false);

	const visibleEvents = useMemo(() => {
		if (!data?.events?.length) return [];
		if (showAll) return data.events;
		return data.events.slice(0, INITIAL_VISIBLE);
	}, [data?.events, showAll]);

	if (loading && !data) {
		return (
			<div className='mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[11px] opacity-70'>
				Checking FINRA / SEC disclosures…
			</div>
		);
	}
	if (error && !data) {
		return (
			<div className='mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-900 dark:text-rose-200'>
				Could not load disclosures: {error}
			</div>
		);
	}
	if (!hasDisplayableDisclosures(data) || !data) return null;

	const eventCount = data.events.length;
	const countTotal = data.typeCounts.reduce((n, t) => n + (t.count || 0), 0);
	const headlineCount = data.eventsTotal || eventCount || countTotal;
	const hiddenCount = Math.max(0, eventCount - visibleEvents.length);
	const truncatedMore =
		data.eventsTotal && data.eventsTotal > eventCount ? data.eventsTotal - eventCount : 0;
	const hasEventList = eventCount > 0;
	const hasTypeCounts = data.typeCounts.length > 0;

	return (
		<section className='mt-3 rounded-lg border border-amber-500/35 bg-amber-500/8 px-3 py-2.5'>
			<div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
				{hasEventList ?
					<button
						type='button'
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						className='m-0 cursor-pointer border-0 bg-transparent p-0 text-left text-xs font-semibold tracking-wide text-amber-950 uppercase dark:text-amber-100'>
						<span aria-hidden className='mr-1 inline-block w-3 font-mono opacity-70'>
							{expanded ? '▾' : '▸'}
						</span>
						Disclosures
						{headlineCount > 0 ? ` (${headlineCount})` : ''}
					</button>
				:	<h3 className='m-0 text-xs font-semibold tracking-wide text-amber-950 uppercase dark:text-amber-100'>
						Disclosures
						{headlineCount > 0 ? ` (${headlineCount})` : ''}
					</h3>}
				{data.finraDisclosureFlag === true ?
					<SourcePill kind='finra' />
				:	null}
				{data.secDisclosureFlag === true ?
					<SourcePill kind='sec' />
				:	null}
				{data.fromPdf ?
					<span className='rounded border border-amber-600/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium opacity-80'>
						from BrokerCheck PDF
					</span>
				:	null}
				{data.finraDisclosureFlag === true &&
				data.secDisclosureFlag !== true &&
				!data.events.some((e) => e.sources.includes('sec')) ?
					<span className='text-[10px] opacity-60'>BrokerCheck</span>
				:	null}
				{data.secDisclosureFlag === true ?
					<span className='text-[10px] opacity-60'>IAPD</span>
				:	null}
				<span className='ml-auto flex flex-wrap gap-2 text-[10px]'>
					{data.brokercheckUrl ?
						<a
							href={data.brokercheckUrl}
							target='_blank'
							rel='noreferrer'
							className='text-violet-800 underline decoration-violet-500/50 hover:decoration-violet-600 dark:text-violet-200'>
							BrokerCheck
						</a>
					:	null}
					{data.brokercheckPdfUrl ?
						<a
							href={data.brokercheckPdfUrl}
							target='_blank'
							rel='noreferrer'
							className='text-violet-800 underline decoration-violet-500/50 hover:decoration-violet-600 dark:text-violet-200'>
							PDF report
						</a>
					:	null}
					{data.adviserInfoUrl && (data.secDisclosureFlag === true || data.hasSecData) ?
						<a
							href={data.adviserInfoUrl}
							target='_blank'
							rel='noreferrer'
							className='text-sky-800 underline decoration-sky-500/50 hover:decoration-sky-600 dark:text-sky-200'>
							AdviserInfo
						</a>
					:	null}
					{data.dashboardUrl ?
						<a
							href={data.dashboardUrl}
							target='_blank'
							rel='noreferrer'
							className='opacity-70 underline hover:opacity-100'>
							Visualizer
						</a>
					:	null}
				</span>
			</div>

			{/* Type counts stay visible when collapsed (Regulatory Event 80, etc.). */}
			{hasTypeCounts ?
				<ul className='mt-2 mb-0 flex list-none flex-wrap gap-1.5 p-0'>
					{data.typeCounts.map((t) => (
						<li
							key={t.disclosureType}
							className='rounded-full border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 text-[10px] font-medium'>
							{t.disclosureType}{' '}
							<span className='font-mono tabular-nums opacity-70'>{t.count}</span>
						</li>
					))}
				</ul>
			:	null}

			{hasEventList && !expanded ?
				<button
					type='button'
					onClick={() => setExpanded(true)}
					className='mt-2 cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-amber-950 underline opacity-80 hover:opacity-100 dark:text-amber-100'>
					Show {eventCount} event{eventCount === 1 ? '' : 's'}
					{truncatedMore > 0 ? ` (${data.eventsTotal} in PDF)` : ''}
				</button>
			:	null}

			{hasEventList && expanded ?
				<>
					<ul className='mt-2 m-0 list-none space-y-2 p-0'>
						{visibleEvents.map((ev, idx) => (
							<DisclosureEventCard
								key={`${ev.eventDate || ''}-${ev.disclosureType}-${idx}`}
								ev={ev}
							/>
						))}
					</ul>
					<div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1'>
						{hiddenCount > 0 ?
							<button
								type='button'
								onClick={() => setShowAll(true)}
								className='cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-amber-950 underline opacity-80 hover:opacity-100 dark:text-amber-100'>
								Show {hiddenCount} more on this page
							</button>
						:	null}
						<button
							type='button'
							onClick={() => {
								setExpanded(false);
								setShowAll(false);
							}}
							className='cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-amber-950 underline opacity-80 hover:opacity-100 dark:text-amber-100'>
							Collapse events
						</button>
					</div>
					{truncatedMore > 0 ?
						<p className='mt-1.5 mb-0 text-[10px] leading-snug opacity-70'>
							Showing {eventCount} of {data.eventsTotal} parsed events. Open the PDF report for the
							full BrokerCheck disclosure section.
						</p>
					:	null}
				</>
			: !hasEventList && !hasTypeCounts ?
				<p className='mt-2 mb-0 text-[11px] leading-snug opacity-80'>
					Disclosure flag is set on{' '}
					{data.finraDisclosureFlag ? 'FINRA BrokerCheck' : null}
					{data.finraDisclosureFlag && data.secDisclosureFlag ? ' and ' : null}
					{data.secDisclosureFlag ? 'SEC IAPD' : null}
					, but detailed records were not returned. Open BrokerCheck / AdviserInfo for the full report.
				</p>
			:	null}
		</section>
	);
}
