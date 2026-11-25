/**
 * Live web search via local SearXNG JSON API (default http://127.0.0.1:8888).
 * Returns ranked titles/URLs/snippets for the agent to fetch_url.
 */
export type WebSearchArgs = {
	query?: string;
	limit?: number;
	/** Optional SearXNG categories, e.g. "general" | "news" | "science" */
	categories?: string;
	/** Prefer these host substrings when ranking (e.g. census.gov, okhistory.org). */
	preferHosts?: string[];
};

export type WebSearchHit = {
	title: string;
	url: string;
	snippet: string;
	engine?: string | null;
	score?: number | null;
};

function searxOrigin(): string {
	const raw = String(process.env.SEARXNG_ORIGIN || process.env.RESEARCH_SEARXNG_ORIGIN || '')
		.trim()
		.replace(/\/$/, '');
	return raw || 'http://127.0.0.1:8888';
}

function clampLimit(n: unknown, fallback = 8): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(20, Math.floor(v)));
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/** Encyclopedia mirrors are orientation, not a sufficient sole source. */
export function isWikipediaFamilyHost(urlOrHost: string): boolean {
	const raw = String(urlOrHost || '').trim();
	if (!raw) return false;
	const host = raw.includes('://') ? hostOf(raw) : raw.toLowerCase();
	if (!host) return false;
	return (
		host === 'wikipedia.org' ||
		host.endsWith('.wikipedia.org') ||
		host.endsWith('.wikimedia.org') ||
		host.endsWith('.wikidata.org') ||
		host.endsWith('.wikiwand.com') ||
		host.endsWith('.mediawiki.org')
	);
}

export function edgeCaseWebQuery(query: string): string {
	const q = String(query || '').trim();
	if (!q) return '';
	return `${q} exceptions disputes official primary source -wikipedia`;
}

function rankBoost(url: string, preferHosts: string[]): number {
	const host = hostOf(url);
	if (!host) return 0;
	let boost = 0;
	for (const pref of preferHosts) {
		const p = String(pref || '')
			.trim()
			.toLowerCase();
		if (!p) continue;
		if (host === p || host.endsWith(`.${p}`) || host.includes(p)) boost += 5;
	}
	// Primary and institutional pages outrank an encyclopedia lead.
	if (host.endsWith('.gov') || host.endsWith('.mil')) boost += 4;
	if (host.endsWith('.edu')) boost += 3;
	if (host.includes('okhistory.org')) boost += 2;
	if (isWikipediaFamilyHost(host)) boost -= 2;
	return boost;
}

export async function searchWeb(args: WebSearchArgs = {}): Promise<{
	ok: boolean;
	query: string;
	origin: string;
	returned: number;
	hits: WebSearchHit[];
	wikipediaHits?: number;
	nonWikipediaHits?: number;
	edgeCaseQuery?: string;
	error?: string;
	hint?: string;
}> {
	const query = String(args.query || '').trim();
	const origin = searxOrigin();
	const limit = clampLimit(args.limit, 8);
	const categories = String(args.categories || 'general').trim() || 'general';
	const preferHosts = Array.isArray(args.preferHosts)
		? args.preferHosts.map(String).filter(Boolean)
		: [];

	if (!query) {
		return {
			ok: false,
			query: '',
			origin,
			returned: 0,
			hits: [],
			error: 'query is required',
		};
	}

	const url = new URL('/search', origin);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');
	url.searchParams.set('language', 'en');
	url.searchParams.set('categories', categories);

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 25_000);
	try {
		const res = await fetch(url.toString(), {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				'User-Agent': 'ai-research-tool/web_search',
			},
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			return {
				ok: false,
				query,
				origin,
				returned: 0,
				hits: [],
				error: `SearXNG HTTP ${res.status}`,
				hint:
					res.status === 403 || res.status === 429
						? 'SearXNG blocked or rate-limited the request.'
						: `Ensure SearXNG is running at ${origin} with JSON format enabled (docker: searxng on :8888).`,
			};
		}
		let data: { results?: Array<Record<string, unknown>> };
		try {
			data = JSON.parse(text) as { results?: Array<Record<string, unknown>> };
		} catch {
			return {
				ok: false,
				query,
				origin,
				returned: 0,
				hits: [],
				error: 'SearXNG returned non-JSON (is format=json enabled in settings.yml?)',
				hint: `Check ${origin}/search?q=test&format=json`,
			};
		}

		const raw = Array.isArray(data.results) ? data.results : [];
		const mapped: Array<WebSearchHit & { _rank: number }> = [];
		for (const r of raw) {
			const href = String(r.url || r.href || '').trim();
			const title = String(r.title || '').trim();
			if (!href || !/^https?:\/\//i.test(href)) continue;
			const snippet = String(r.content || r.snippet || r.description || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 400);
			const scoreRaw = r.score != null ? Number(r.score) : null;
			const score = Number.isFinite(scoreRaw as number) ? (scoreRaw as number) : null;
			const engine = r.engine != null ? String(r.engine) : null;
			mapped.push({
				title: title || href,
				url: href,
				snippet,
				engine,
				score,
				_rank: (score ?? 0) + rankBoost(href, preferHosts),
			});
		}
		mapped.sort((a, b) => b._rank - a._rank);
		const wiki = mapped.filter((h) => isWikipediaFamilyHost(h.url));
		const other = mapped.filter((h) => !isWikipediaFamilyHost(h.url));
		// Lead with non-Wikipedia pages. Keep at most two encyclopedia hits so a
		// small model still sees them, but cannot treat them as the whole result.
		const mixed: Array<WebSearchHit & { _rank: number }> = [];
		for (const hit of other) {
			if (mixed.length >= limit) break;
			mixed.push(hit);
		}
		let wikiKept = 0;
		for (const hit of wiki) {
			if (mixed.length >= limit || wikiKept >= 2) break;
			mixed.push(hit);
			wikiKept += 1;
		}
		const hits: WebSearchHit[] = mixed.map(({ _rank: _r, ...h }) => h);
		const nonWikipediaHits = hits.filter((h) => !isWikipediaFamilyHost(h.url)).length;
		const wikipediaHits = hits.length - nonWikipediaHits;
		const edgeCaseQuery = edgeCaseWebQuery(query);

		let hint: string;
		if (hits.length === 0) {
			hint = 'No web hits. Try a narrower query, or fetch_url on a known public URL.';
		} else if (nonWikipediaHits === 0) {
			hint = `Every hit is Wikipedia or a mirror. Do not answer from that alone. Call web_search again with edgeCaseQuery (${edgeCaseQuery}) and fetch_url a non-Wikipedia page (.gov, .edu, official organization, news, or a primary document). Look for exceptions, disputed dates, name changes, and boundary conditions.`;
		} else {
			hint = `Do not use Wikipedia as the only source. fetch_url exactly one non-Wikipedia URL from these hits (not every hit), then call web_search once with edgeCaseQuery (${edgeCaseQuery}) for exceptions, disputes, or a primary source the encyclopedia lead skips. Cite both and say where they disagree.`;
		}

		return {
			ok: true,
			query,
			origin,
			returned: hits.length,
			hits,
			wikipediaHits,
			nonWikipediaHits,
			edgeCaseQuery,
			hint,
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const aborted = /abort/i.test(message);
		return {
			ok: false,
			query,
			origin,
			returned: 0,
			hits: [],
			error: aborted ? 'SearXNG request timed out' : message,
			hint: `Start SearXNG: docker start searxng (port 8888). Settings live under .data/searxng/settings.yml.`,
		};
	} finally {
		clearTimeout(timer);
	}
}
