import crypto from 'crypto';
import fs from 'fs';
import {
	aggregateBryanFilings,
	type AggregateOptions,
	type AggregateResult,
	type ChartKind,
	type ChartPeriod,
} from '@/lib/research/charts/aggregate';
import {
	chartFilePath,
	chartMimeType,
	ensureChartsDir,
	normalizeChartFormat,
	type ChartImageFormat,
} from '@/lib/research/charts/paths';
import { rasterizeChartSvg } from '@/lib/research/charts/rasterize';
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
	/** Default png (shareable). Use svg for logos/vector; jpeg also supported. */
	format?: ChartImageFormat | string;
};

export type ChartFilingsResult = {
	ok: true;
	chartId: string;
	imageUrl: string;
	imagePath: string;
	mimeType: string;
	format: ChartImageFormat;
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
 * Aggregate Bryan filings, write a shareable PNG (default) under .data/charts.
 * Pass format=svg for vector/logo-style export, or jpeg for photos-style compression.
 */
export async function createBryanFilingChart(args: ChartFilingsArgs): Promise<ChartFilingsResult> {
	const projectId = String(args.projectId || '').trim();
	if (!projectId) {
		throw new Error('projectId required');
	}

	const format = normalizeChartFormat(args.format, 'png');
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
	const { buffer } = await rasterizeChartSvg(svg, format);

	ensureChartsDir();
	const chartId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
	const imagePath = chartFilePath(chartId, format);
	fs.writeFileSync(imagePath, buffer);

	const imageUrl = `/api/charts/${chartId}`;

	return {
		ok: true,
		chartId,
		imageUrl,
		imagePath,
		mimeType: chartMimeType(format),
		format,
		title: agg.title,
		subtitle: agg.subtitle,
		kind: agg.kind,
		period: agg.period,
		projectId,
		totalMatched: agg.totalMatched,
		totalInProject: agg.totalInProject,
		buckets: agg.buckets,
		hint: `Include this markdown image in your answer: ![${agg.title}](${imageUrl}). Default format is PNG for easy online sharing. Summarize bucket counts from the tool result (do not invent zeros).`,
	};
}

export { aggregateBryanFilings } from '@/lib/research/charts/aggregate';
export { createLogo } from '@/lib/research/charts/logo';
export { renderBarChartSvg } from '@/lib/research/charts/svg';
