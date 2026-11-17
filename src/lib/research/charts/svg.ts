import type { AggregateBucket } from '@/lib/research/charts/aggregate';

export type SvgChartInput = {
	title: string;
	subtitle: string;
	buckets: AggregateBucket[];
	/** CSS-ish palette; defaults are fine for light/dark embedding. */
	barColor?: string;
	width?: number;
	height?: number;
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
 * Render a simple horizontal-friendly vertical bar chart as standalone SVG (no deps).
 */
export function renderBarChartSvg(input: SvgChartInput): string {
	const width = Math.max(480, Number(input.width) || 900);
	const height = Math.max(280, Number(input.height) || 420);
	const barColor = input.barColor || '#F97316';
	const padL = 56;
	const padR = 24;
	const padT = 64;
	const padB = 72;
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const buckets = input.buckets;
	const maxVal = Math.max(1, ...buckets.map((b) => b.count));
	const n = Math.max(1, buckets.length);
	const gap = Math.min(12, plotW / n / 4);
	const barW = Math.max(4, (plotW - gap * (n + 1)) / n);

	const yTicks = 4;
	const tickLines: string[] = [];
	for (let i = 0; i <= yTicks; i++) {
		const v = Math.round((maxVal * (yTicks - i)) / yTicks);
		const y = padT + (plotH * i) / yTicks;
		tickLines.push(
			`<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#94a3b8" stroke-opacity="0.35" stroke-width="1"/>`,
			`<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#64748b" font-family="system-ui,sans-serif">${v}</text>`,
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
			`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${barColor}">`,
			`<title>${label}: ${b.count}</title>`,
			`</rect>`,
			`<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155" font-family="system-ui,sans-serif">${b.count}</text>`,
		);
		if (rotate) {
			bars.push(
				`<text x="${(x + barW / 2).toFixed(1)}" y="${padT + plotH + 14}" text-anchor="end" font-size="10" fill="#475569" font-family="system-ui,sans-serif" transform="rotate(-40 ${(x + barW / 2).toFixed(1)} ${padT + plotH + 14})">${label}</text>`,
			);
		} else {
			bars.push(
				`<text x="${(x + barW / 2).toFixed(1)}" y="${padT + plotH + 18}" text-anchor="middle" font-size="11" fill="#475569" font-family="system-ui,sans-serif">${label}</text>`,
			);
		}
	});

	const emptyNote =
		buckets.length === 0
			? `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="14" fill="#64748b" font-family="system-ui,sans-serif">No filings matched this filter</text>`
			: '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(input.title)}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${padL}" y="28" font-size="18" font-weight="600" fill="#0f172a" font-family="system-ui,sans-serif">${escapeXml(input.title)}</text>
  <text x="${padL}" y="48" font-size="12" fill="#64748b" font-family="system-ui,sans-serif">${escapeXml(input.subtitle)}</text>
  ${tickLines.join('\n  ')}
  ${bars.join('\n  ')}
  ${emptyNote}
</svg>
`;
}
