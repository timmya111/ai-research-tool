type TraceEntry = {
	tool?: string;
	args?: Record<string, unknown>;
	result?: unknown;
};

function collapse(text: string, max: number): string {
	const one = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (one.length <= max) return one;
	return `${one.slice(0, Math.max(0, max - 1))}…`;
}

function digestBody(body: unknown, max = 240): string {
	if (typeof body === 'string') return collapse(body, max);
	try {
		return collapse(JSON.stringify(body), max);
	} catch {
		return collapse(String(body), max);
	}
}

function urlShort(url: unknown): string {
	try {
		const u = new URL(String(url || ''));
		return collapse(`${u.hostname}${u.pathname}`, 120);
	} catch {
		return collapse(String(url || ''), 120);
	}
}

function lineForEntry(entry: TraceEntry): string {
	const tool = String(entry.tool || 'unknown');
	const result = (entry.result && typeof entry.result === 'object' ? entry.result : {}) as Record<
		string,
		unknown
	>;
	const ok = result.ok === true || result.ok === false ? Boolean(result.ok) : !result.error;

	if (tool === 'fetch_url') {
		const status = result.status != null ? ` status=${result.status}` : '';
		const url = urlShort(result.finalUrl || result.requestedUrl);
		const digest =
			result.ok === false
				? collapse(String(result.error || 'error'), 240)
				: digestBody(result.body, 240);
		return `- fetch_url ok=${ok}${status} ${url} :: ${digest}`;
	}

	if (tool === 'inspect_canvas_graph') {
		const action = entry.args?.action != null ? ` action=${entry.args.action}` : '';
		const keys = Object.keys(result).slice(0, 8);
		const digest = digestBody(
			keys.length ? Object.fromEntries(keys.map((k) => [k, result[k]])) : result,
			240,
		);
		return `- inspect_canvas_graph ok=${ok}${action} :: ${digest}`;
	}

	if (tool === 'search_knowledge') {
		const hits =
			typeof (result as { returned?: unknown }).returned === 'number'
				? ` hits=${(result as { returned: number }).returned}`
				: Array.isArray((result as { hits?: unknown[] }).hits)
					? ` hits=${((result as { hits: unknown[] }).hits).length}`
					: '';
		return `- search_knowledge ok=${ok}${hits} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'current_time') {
		const iso = typeof result.iso === 'string' ? result.iso : digestBody(result, 240);
		return `- current_time ok=${ok} :: ${collapse(String(iso), 240)}`;
	}

	return `- ${tool} ok=${ok} :: ${digestBody(result, 240)}`;
}

/** Bounded toolTrace → text for chat documents (≤12 lines, section ≤4k). */
export function formatToolTraceSummary(toolTrace: unknown): string {
	const entries = Array.isArray(toolTrace) ? (toolTrace as TraceEntry[]) : [];
	if (!entries.length) return '## Tools\n(none)';

	const lines: string[] = ['## Tools'];
	const maxLines = 12;
	const slice = entries.slice(0, maxLines);
	for (const entry of slice) {
		lines.push(lineForEntry(entry));
	}
	if (entries.length > maxLines) {
		lines.push(`(+${entries.length - maxLines} more tools omitted)`);
	}

	let text = lines.join('\n');
	if (text.length > 4000) {
		text = `${text.slice(0, 3999)}…`;
	}
	return text;
}
