import sharp from 'sharp';
import type { ChartImageFormat } from '@/lib/research/charts/paths';

/**
 * Rasterize an SVG string to PNG or JPEG bytes (SVG passthrough returns UTF-8 buffer).
 * Charts are authored at 5× density; sharp renders at intrinsic SVG width/height.
 */
export async function rasterizeChartSvg(
	svg: string,
	format: ChartImageFormat,
): Promise<{ buffer: Buffer; mimeType: string }> {
	if (format === 'svg') {
		return { buffer: Buffer.from(svg, 'utf8'), mimeType: 'image/svg+xml' };
	}

	const pipeline = sharp(Buffer.from(svg, 'utf8'), {
		density: 72, // SVG user units already at 5×; keep 1:1 with width/height attrs
	});

	if (format === 'jpeg') {
		const buffer = await pipeline
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: 92, mozjpeg: true })
			.toBuffer();
		return { buffer, mimeType: 'image/jpeg' };
	}

	const buffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
	return { buffer, mimeType: 'image/png' };
}
