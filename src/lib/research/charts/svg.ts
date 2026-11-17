import type { AggregateBucket } from '@/lib/research/charts/aggregate';

/** Intrinsic pixel density vs logical layout (5 = 5× width/height/fonts/strokes). */
export const CHART_PIXEL_DENSITY = 5;

export type SvgChartInput = {
	title: string;
	subtitle: string;
	buckets: AggregateBucket[];
	/** CSS-ish palette; defaults are fine for light/dark embedding. */
	barColor?: string;
	/** Logical CSS width before density scale (default 900). */
	width?: number;
	/** Logical CSS height before density scale (default 420). */
	height?: number;
	/** Pixel density multiplier (default CHART_PIXEL_DENSITY = 5). */
	pixelDensity?: number;
};

function escapeXml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Render a vertical bar chart as standalone SVG.
 * Geometry is drawn in a high-density coordinate space (default 5×) so the
 * intrinsic bitmap-equivalent resolution is sharp when scaled in chat or opened full-size.
 */
export function renderBarChartSvg(input: SvgChartInput): string {
	const density = Math.max(1, Math.min(8, Number(input.pixelDensity) || CHART_PIXEL_DENSITY));
	const d = (n: number) => n * density;

	const logicalW = Math.max(480, Number(input.width) || 900);
	const logicalH = Math.max(280, Number(input.height) || 420);
	const width = d(logicalW);
	const height = d(logicalH);
	const barColor = input.barColor || '#F97316';

	const padL = d(56);
	const padR = d(24);
	const padT = d(64);
	const padB = d(72);
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const buckets = input.buckets;
	const maxVal = Math.max(1, ...buckets.map((b) => b.count));
	const n = Math.max(1, buckets.length);
	const gap = Math.min(d(12), plotW / n / 4);
	const barW = Math.max(d(4), (plotW - gap * (n + 1)) / n);
	const barRx = d(3);

	const fontTitle = d(18);
	const fontSub = d(12);
	const fontTick = d(11);
	const fontCount = d(10);
	const fontLabel = n > 10 ? d(10) : d(11);
	const fontEmpty = d(14);
	const strokeW = Math.max(1, d(1));

	const yTicks = 4;
	const tickLines: string[] = [];
	for (let i = 0; i <= yTicks; i++) {
		const v = Math.round((maxVal * (yTicks - i)) / yTicks);
		const y = padT + (plotH * i) / yTicks;
		tickLines.push(
			`<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#94a3b8" stroke-opacity="0.35" stroke-width="${strokeW}"/>`,
			`<text x="${padL - d(8)}" y="${y + d(4)}" text-anchor="end" font-size="${fontTick}" fill="#64748b" font-family="system-ui,sans-serif">${v}</text>`,
		);
	}

	const bars: string[] = [];
	buckets.forEach((b, i) => {
		const h = (b.count / maxVal) * plotH;
		const x = padL + gap + i * (barW + gap);
		const y = padT + plotH - h;
		const label = escapeXml(b.label);
		const rotate = n > 10;
		bars.push(
			`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(density, h).toFixed(1)}" rx="${barRx}" fill="${barColor}">`,
			`<title>${label}: ${b.count}</title>`,
			`</rect>`,
			`<text x="${(x + barW / 2).toFixed(1)}" y="${(y - d(6)).toFixed(1)}" text-anchor="middle" font-size="${fontCount}" fill="#334155" font-family="system-ui,sans-serif">${b.count}</text>`,
		);
		if (rotate) {
			const lx = x + barW / 2;
			const ly = padT + plotH + d(14);
			bars.push(
				`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" font-size="${fontLabel}" fill="#475569" font-family="system-ui,sans-serif" transform="rotate(-40 ${lx.toFixed(1)} ${ly.toFixed(1)})">${label}</text>`,
			);
		} else {
			bars.push(
				`<text x="${(x + barW / 2).toFixed(1)}" y="${(padT + plotH + d(18)).toFixed(1)}" text-anchor="middle" font-size="${fontLabel}" fill="#475569" font-family="system-ui,sans-serif">${label}</text>`,
			);
		}
	});

	const emptyNote =
		buckets.length === 0
			? `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="${fontEmpty}" fill="#64748b" font-family="system-ui,sans-serif">No filings matched this filter</text>`
			: '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(input.title)}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${padL}" y="${d(28)}" font-size="${fontTitle}" font-weight="600" fill="#0f172a" font-family="system-ui,sans-serif">${escapeXml(input.title)}</text>
  <text x="${padL}" y="${d(48)}" font-size="${fontSub}" fill="#64748b" font-family="system-ui,sans-serif">${escapeXml(input.subtitle)}</text>
  ${tickLines.join('\n  ')}
  ${bars.join('\n  ')}
  ${emptyNote}
</svg>
`;
}
