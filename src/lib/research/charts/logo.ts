import crypto from 'crypto';
import fs from 'fs';
import {
	chartFilePath,
	chartMimeType,
	ensureChartsDir,
	type ChartImageFormat,
} from '@/lib/research/charts/paths';
import { CHART_PIXEL_DENSITY } from '@/lib/research/charts/svg';
import { rasterizeChartSvg } from '@/lib/research/charts/rasterize';

export type MakeLogoArgs = {
	text: string;
	subtitle?: string | null;
	/** Default svg (vector for logos). png/jpeg also allowed for sharing. */
	format?: ChartImageFormat | string;
	bg?: string;
	fg?: string;
	accent?: string;
};

export type MakeLogoResult = {
	ok: true;
	chartId: string;
	imageUrl: string;
	imagePath: string;
	mimeType: string;
	format: ChartImageFormat;
	title: string;
	hint: string;
};

function escapeXml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function normalizeLogoFormat(raw: unknown): ChartImageFormat {
	const s = String(raw || 'svg')
		.trim()
		.toLowerCase();
	if (s === 'png') return 'png';
	if (s === 'jpg' || s === 'jpeg') return 'jpeg';
	return 'svg';
}

/** Simple wordmark / badge SVG for logos (vector by default). */
export function renderLogoSvg(args: {
	text: string;
	subtitle?: string | null;
	bg?: string;
	fg?: string;
	accent?: string;
}): string {
	const density = CHART_PIXEL_DENSITY;
	const d = (n: number) => n * density;
	const width = d(640);
	const height = d(200);
	const bg = args.bg || '#0f172a';
	const fg = args.fg || '#f8fafc';
	const accent = args.accent || '#F97316';
	const title = escapeXml(String(args.text || 'Logo').trim() || 'Logo');
	const subtitle = args.subtitle ? escapeXml(String(args.subtitle).trim()) : '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="100%" height="100%" rx="${d(24)}" fill="${bg}"/>
  <rect x="${d(28)}" y="${d(28)}" width="${d(10)}" height="${height - d(56)}" rx="${d(4)}" fill="${accent}"/>
  <text x="${d(56)}" y="${subtitle ? d(88) : d(112)}" font-size="${d(42)}" font-weight="700" fill="${fg}" font-family="system-ui,sans-serif">${title}</text>
  ${
		subtitle
			? `<text x="${d(56)}" y="${d(140)}" font-size="${d(20)}" fill="#94a3b8" font-family="system-ui,sans-serif">${subtitle}</text>`
			: ''
	}
</svg>
`;
}

export async function createLogo(args: MakeLogoArgs): Promise<MakeLogoResult> {
	const text = String(args.text || '').trim();
	if (!text) throw new Error('text required for logo');
	const format = normalizeLogoFormat(args.format);
	const svg = renderLogoSvg({
		text,
		subtitle: args.subtitle,
		bg: args.bg,
		fg: args.fg,
		accent: args.accent,
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
		title: text,
		hint: `Embed as ![${text}](${imageUrl}). Logo default is SVG for vector sharing; pass format=png or jpeg for raster.`,
	};
}
