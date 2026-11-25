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

	if (tool === 'web_search') {
		const hits =
			typeof (result as { returned?: unknown }).returned === 'number'
				? ` hits=${(result as { returned: number }).returned}`
				: Array.isArray((result as { hits?: unknown[] }).hits)
					? ` hits=${((result as { hits: unknown[] }).hits).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		const top =
			Array.isArray((result as { hits?: Array<{ title?: string; url?: string }> }).hits) &&
			(result as { hits: Array<{ title?: string; url?: string }> }).hits[0]
				? ` top=${collapse(
						String(
							(result as { hits: Array<{ title?: string; url?: string }> }).hits[0].title ||
								(result as { hits: Array<{ title?: string; url?: string }> }).hits[0].url ||
								'',
						),
						80,
					)}`
				: '';
		return `- web_search ok=${ok}${hits}${q}${top} :: ${digestBody(result.error || result.hint || result, 200)}`;
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

	if (tool === 'search_finra_sidecar') {
		const hits =
			typeof (result as { returned?: unknown }).returned === 'number'
				? ` hits=${(result as { returned: number }).returned}`
				: Array.isArray((result as { hits?: unknown[] }).hits)
					? ` hits=${((result as { hits: unknown[] }).hits).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_finra_sidecar ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'lookup_brokercheck') {
		const crd = entry.args?.crd != null ? ` crd=${collapse(String(entry.args.crd), 20)}` : '';
		const profile =
			result.profile && typeof result.profile === 'object'
				? (result.profile as Record<string, unknown>)
				: null;
		const emp =
			profile && typeof profile.employmentCount === 'number'
				? ` employments=${profile.employmentCount}`
				: '';
		const name = profile?.display != null ? ` ${collapse(String(profile.display), 80)}` : '';
		return `- lookup_brokercheck ok=${ok}${crd}${emp}${name} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'lookup_firm_connections') {
		const firm =
			entry.args?.firmCrd != null ? ` firm=${collapse(String(entry.args.firmCrd), 20)}` : '';
		const totals =
			result.totals && typeof result.totals === 'object'
				? (result.totals as Record<string, unknown>)
				: null;
		const counts =
			totals && totals.combined != null
				? ` current=${totals.current ?? '?'} previous=${totals.previous ?? '?'} combined=${totals.combined}`
				: '';
		const ret = result.returned != null ? ` returned=${result.returned}` : '';
		return `- lookup_firm_connections ok=${ok}${firm}${counts}${ret} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_authority_timelines') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		const agency = entry.args?.agency != null ? ` agency=${collapse(String(entry.args.agency), 12)}` : '';
		return `- search_authority_timelines ok=${ok}${hits}${agency}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_cdc_covid_timeline') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		const et = entry.args?.entityType != null ? ` type=${collapse(String(entry.args.entityType), 16)}` : '';
		const en = entry.args?.entity != null ? ` entity=${collapse(String(entry.args.entity), 24)}` : '';
		return `- search_cdc_covid_timeline ok=${ok}${hits}${et}${en}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_dod_covid_timeline') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		const cat = entry.args?.category != null ? ` cat=${collapse(String(entry.args.category), 12)}` : '';
		const et = entry.args?.entityType != null ? ` type=${collapse(String(entry.args.entityType), 16)}` : '';
		return `- search_dod_covid_timeline ok=${ok}${hits}${cat}${et}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_gemini_qa') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		const n =
			typeof result.corpusConversations === 'number' ? ` corpus=${result.corpusConversations}` : '';
		return `- search_gemini_qa ok=${ok}${hits}${n}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_entity_dossiers') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: result.dossier
					? ' hits=1'
					: Array.isArray(result.hits)
						? ` hits=${(result.hits as unknown[]).length}`
						: '';
		const q =
			entry.args?.slug != null
				? ` slug=${collapse(String(entry.args.slug), 40)}`
				: entry.args?.query != null
					? ` q=${collapse(String(entry.args.query), 60)}`
					: '';
		return `- search_entity_dossiers ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_wikipedia') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_wikipedia ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_digital_earth') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_digital_earth ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_pqw_itmo') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_pqw_itmo ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_meta25') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_meta25 ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_physics_congress') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_physics_congress ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_twdb_trinity') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q = entry.args?.query != null ? ` q=${collapse(String(entry.args.query), 60)}` : '';
		return `- search_twdb_trinity ok=${ok}${hits}${q} :: ${digestBody(result, 240)}`;
	}

	if (tool === 'search_concealment_scrubs') {
		const hits =
			typeof result.returned === 'number'
				? ` hits=${result.returned}`
				: Array.isArray(result.hits)
					? ` hits=${(result.hits as unknown[]).length}`
					: '';
		const q =
			entry.args?.videoId != null
				? ` id=${collapse(String(entry.args.videoId), 20)}`
				: entry.args?.query != null
					? ` q=${collapse(String(entry.args.query), 60)}`
					: '';
		const ch = entry.args?.channel != null ? ` ch=${collapse(String(entry.args.channel), 24)}` : '';
		return `- search_concealment_scrubs ok=${ok}${hits}${ch}${q} :: ${digestBody(result, 240)}`;
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
