import crypto from 'crypto';
import fs from 'fs';
import {
	aggregateBryanFilings,
	type AggregateOptions,
	type AggregateResult,
	type ChartKind,
	type ChartPeriod,
} from '@/lib/research/charts/aggregate';
import { chartFilePath, ensureChartsDir } from '@/lib/research/charts/paths';
import { renderBarChartSvg } from '@/lib/research/charts/svg';

export type ChartFilingsArgs = {
	projectId: string;
	period?: ChartPeriod | string;
	kind?: ChartKind | string;
	from?: string | null;
	to?: string | null;
	docType?: string | null;
	limitBuckets?: number;
	limitTypes?: number;
};

export type ChartFilingsResult = {
	ok: true;
	chartId: string;
	imageUrl: string;
	imagePath: string;
	mimeType: 'image/svg+xml';
	title: string;
	subtitle: string;
	kind: ChartKind;
	period: ChartPeriod;
	projectId: string;
	totalMatched: number;
	totalInProject: number;
	buckets: AggregateResult['buckets'];
	hint: string;
};

function normalizePeriod(raw: unknown): ChartPeriod {
	const s = String(raw || 'month').trim().toLowerCase();
	if (s === 'day' || s === 'daily') return 'day';
	if (s === 'week' || s === 'weekly') return 'week';
	return 'month';
}

function normalizeKind(raw: unknown): ChartKind {
	const s = String(raw || 'volume').trim().toLowerCase();
	if (s === 'by_type' || s === 'type' || s === 'types' || s === 'breakdown') return 'by_type';
	return 'volume';
}

/**
 * Aggregate Bryan filings, write an SVG under .data/charts, return a localhost image URL.
 */
export function createBryanFilingChart(args: ChartFilingsArgs): ChartFilingsResult {
	const projectId = String(args.projectId || '').trim();
	if (!projectId) {
		throw new Error('projectId required');
	}

	const options: AggregateOptions = {
		projectId,
		period: normalizePeriod(args.period),
		kind: normalizeKind(args.kind),
		from: args.from,
		to: args.to,
		docType: args.docType,
		limitBuckets: args.limitBuckets,
		limitTypes: args.limitTypes,
	};

	const agg = aggregateBryanFilings(options);
	const svg = renderBarChartSvg({
		title: agg.title,
		subtitle: agg.subtitle,
		buckets: agg.buckets,
	});

	ensureChartsDir();
	const chartId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
	const imagePath = chartFilePath(chartId);
	fs.writeFileSync(imagePath, svg, 'utf8');

	const imageUrl = `/api/charts/${chartId}`;

	return {
		ok: true,
		chartId,
		imageUrl,
		imagePath,
		mimeType: 'image/svg+xml',
		title: agg.title,
		subtitle: agg.subtitle,
		kind: agg.kind,
		period: agg.period,
		projectId,
		totalMatched: agg.totalMatched,
		totalInProject: agg.totalInProject,
		buckets: agg.buckets,
		hint: `Include this markdown image in your answer so the user sees the chart: ![${agg.title}](${imageUrl}). Also summarize the bucket counts from the tool result (do not invent zeros).`,
	};
}

export { aggregateBryanFilings } from '@/lib/research/charts/aggregate';
export { renderBarChartSvg } from '@/lib/research/charts/svg';
