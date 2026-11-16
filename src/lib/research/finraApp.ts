/** Live FINRA SEC graph app origin (Vercel). Override with NEXT_PUBLIC_FINRA_APP_ORIGIN. */
export const DEFAULT_FINRA_APP_ORIGIN = 'https://finra-sec-data-visualizer-canvas.vercel.app';

export const FINRA_CANVAS_WINDOW_NAME = 'finra-canvas-research';

export function getFinraAppOrigin(): string {
	const fromEnv = String(process.env.NEXT_PUBLIC_FINRA_APP_ORIGIN || '')
		.trim()
		.replace(/\/$/, '');
	return fromEnv || DEFAULT_FINRA_APP_ORIGIN;
}

export function finraApiUrl(path: string): string {
	const origin = getFinraAppOrigin();
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return `${origin}${normalized}`;
}
