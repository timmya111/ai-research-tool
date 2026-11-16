'use client';

import {
	isCanvasSnapshot,
	parseCanvasSnapshotJson,
	type CanvasSnapshot,
} from '@/lib/research/canvasSnapshot';
import { FINRA_CANVAS_WINDOW_NAME, getFinraAppOrigin } from '@/lib/research/finraApp';

const CHANNEL_NAME = 'finra-local-ai-canvas';

export function openLiveFinraGraphWindow(): Window | null {
	if (typeof window === 'undefined') return null;
	const origin = getFinraAppOrigin();
	const popup = window.open(origin + '/', FINRA_CANVAS_WINDOW_NAME);
	return popup;
}

/**
 * Ask an open live-graph window for a lean canvas snapshot via postMessage.
 * Requires the FINRA app to accept research-tool origins (localhost:3333).
 */
export async function requestLiveCanvasSnapshotViaPostMessage(
	targetWindow: Window | null | undefined,
	timeoutMs = 2500,
): Promise<CanvasSnapshot | null> {
	if (typeof window === 'undefined' || !targetWindow || targetWindow.closed) return null;
	const origin = getFinraAppOrigin();
	const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	return await new Promise((resolve) => {
		let done = false;
		const finish = (value: CanvasSnapshot | null) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			window.removeEventListener('message', onMessage);
			resolve(value);
		};

		const onMessage = (event: MessageEvent) => {
			if (event.origin !== origin) return;
			const data = event.data || {};
			if (data?.type !== 'canvas-snapshot' || String(data.requestId || '') !== requestId) return;
			if (data.snapshot && isCanvasSnapshot(data.snapshot)) {
				finish(data.snapshot as CanvasSnapshot);
			} else {
				finish(null);
			}
		};

		const timer = window.setTimeout(() => finish(null), timeoutMs);
		window.addEventListener('message', onMessage);
		try {
			targetWindow.postMessage({ type: 'request-canvas-snapshot', requestId }, origin);
		} catch {
			finish(null);
		}
	});
}

/** Same-origin BroadcastChannel fallback (only works if research tool shares the FINRA origin). */
async function requestLiveSnapshotBroadcast(timeoutMs = 400): Promise<CanvasSnapshot | null> {
	if (typeof BroadcastChannel === 'undefined') return null;
	const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return await new Promise((resolve) => {
		let done = false;
		let channel: BroadcastChannel | null = null;
		const finish = (value: CanvasSnapshot | null) => {
			if (done) return;
			done = true;
			try {
				channel?.close();
			} catch {
				/* ignore */
			}
			resolve(value);
		};
		try {
			channel = new BroadcastChannel(CHANNEL_NAME);
			const timer = window.setTimeout(() => finish(null), timeoutMs);
			channel.addEventListener('message', (event: MessageEvent) => {
				const data = event?.data || {};
				if (data?.type !== 'canvas-snapshot' || String(data.requestId || '') !== requestId) return;
				window.clearTimeout(timer);
				if (data.snapshot && isCanvasSnapshot(data.snapshot)) finish(data.snapshot as CanvasSnapshot);
				else finish(null);
			});
			channel.postMessage({ type: 'request-canvas-snapshot', requestId });
		} catch {
			finish(null);
		}
	});
}

export type CaptureCanvasOptions = {
	/** Window opened via openLiveFinraGraphWindow / named target */
	liveWindow?: Window | null;
	/** Last pasted snapshot JSON (fallback) */
	pastedJson?: string | null;
	/** Previously captured snapshot to keep if refresh fails */
	previous?: CanvasSnapshot | null;
};

/**
 * Prefer live postMessage from the connected FINRA graph window, then BroadcastChannel,
 * then pasted JSON, then the previous snapshot.
 */
export async function captureCanvasSnapshotForResearch(
	options: CaptureCanvasOptions = {},
): Promise<CanvasSnapshot | null> {
	const viaPost = await requestLiveCanvasSnapshotViaPostMessage(options.liveWindow);
	if (viaPost && (viaPost.nodeCount > 0 || (viaPost.nodes || []).length > 0)) return viaPost;

	const viaBc = await requestLiveSnapshotBroadcast();
	if (viaBc && (viaBc.nodeCount > 0 || (viaBc.nodes || []).length > 0)) return viaBc;

	if (options.pastedJson) {
		const pasted = parseCanvasSnapshotJson(options.pastedJson);
		if (pasted && pasted.nodeCount > 0) {
			return { ...pasted, source: 'paste' };
		}
	}

	if (options.previous && options.previous.nodeCount > 0) return options.previous;
	return viaPost || viaBc || null;
}

export function formatCanvasInfo(snap: CanvasSnapshot | null | undefined): string {
	if (!snap || snap.nodeCount <= 0) {
		return 'Canvas: none — Connect live graph (or paste snapshot JSON)';
	}
	return `Canvas: ${snap.nodeCount} nodes / ${snap.linkCount} links (${snap.source}${snap.truncated ? ', truncated' : ''})`;
}
