/**
 * Offline Wikipedia search via local kiwix-serve (/search?pattern=&format=xml).
 * ZIM lives under .data/wikipedia/; server default http://127.0.0.1:8765
 */
import fs from 'fs';
import path from 'path';

export type WikipediaSearchArgs = {
	query?: string;
	limit?: number;
	start?: number;
	/** Fetch readable extracts for top title matches (default true). */
	includeExtracts?: boolean;
	/** Max articles to fetch extracts for (default 2, max 5). */
	extractLimit?: number;
	/** Max chars per extract (default 6000, max 20000). */
	extractChars?: number;
};

function zimDir(): string {
	return path.join(process.cwd(), '.data', 'wikipedia');
}

function zimCandidates(): string[] {
	const dir = zimDir();
	const names = [
		'wikipedia_en_all_maxi.zim',
		'wikipedia_en_all_maxi_2026-08.zim',
	];
	return names.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

function kiwixOrigin(): string {
	const raw = String(process.env.KIWIX_SERVE_ORIGIN || process.env.RESEARCH_KIWIX_ORIGIN || '')
		.trim()
		.replace(/\/$/, '');
	return raw || 'http://127.0.0.1:8765';
}

function clampLimit(n: unknown, fallback = 8): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(25, Math.floor(v)));
}

function stripTags(s: string): string {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseXmlHits(xml: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
	const hits: Array<{ title: string; url: string; snippet: string }> = [];
	// OpenSearch / kiwix XML: <entry> or <item> style; also HTML fallback parsing
	const entryRe = /<(?:entry|item)>([\s\S]*?)<\/(?:entry|item)>/gi;
	let m: RegExpExecArray | null;
	while ((m = entryRe.exec(xml)) && hits.length < limit) {
		const block = m[1];
		const title = stripTags((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
		const link =
			stripTags((block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '') ||
			stripTags((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '') ||
			stripTags((block.match(/<id>([\s\S]*?)<\/id>/i) || [])[1] || '');
		const snippet = stripTags(
			(block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] ||
				(block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] ||
				(block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] ||
				'',
		);
		// Skip channel/namespace noise titles that appear as bare "Wikipedia"
		if (!title && !link) continue;
		if (/^wikipedia$/i.test(title.trim())) continue;
		hits.push({
			title: title || link,
			url: link,
			snippet: snippet.slice(0, 400),
		});
	}
	if (hits.length) return hits;

	// HTML results fallback: <li>…<a href="/…">Title</a>…snippet
	for (const block of xml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
		if (hits.length >= limit) break;
		const b = block[1];
		const am = b.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!am) continue;
		const title = stripTags(am[2]);
		if (!title || title.length < 2) continue;
		const cite = stripTags((b.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i) || [])[1] || '');
		hits.push({
			title,
			url: am[1],
			snippet: cite.slice(0, 400) || stripTags(b).slice(0, 400),
		});
	}
	return hits;
}

function downloadStatus(): Record<string, unknown> {
	const dest = path.join(zimDir(), 'wikipedia_en_all_maxi_2026-08.zim');
	const expected = 127_418_087_648;
	const exists = fs.existsSync(dest);
	const size = exists ? fs.statSync(dest).size : 0;
	const symlink = path.join(zimDir(), 'wikipedia_en_all_maxi.zim');
	return {
		path: dest,
		exists,
		bytes: size,
		expectedBytes: expected,
		pct: exists ? Math.round((1000 * size) / expected) / 10 : 0,
		ready: exists && size > expected,
		symlinkExists: fs.existsSync(symlink),
	};
}

export async function searchWikipedia(args: WikipediaSearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const query = String(args.query || '').trim();
	if (!query) {
		return { ok: false, result: { ok: false, error: 'query is required' } };
	}
	const limit = clampLimit(args.limit, 8);
	const start = Math.max(0, Math.floor(Number(args.start) || 0));
	const origin = kiwixOrigin();
	const zim = downloadStatus();
	const candidates = zimCandidates();

	if (!zim.ready && !candidates.length) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `Wikipedia ZIM not ready yet (${zim.pct}% of ~119GB). Download continues under .data/wikipedia/.`,
				download: zim,
				hint: 'After download completes, run: bash ~/.grok/long-running-background-tasks/run_kiwix_serve.sh',
			},
		};
	}

	const url = new URL('/search', origin);
	url.searchParams.set('pattern', query);
	url.searchParams.set('format', 'xml');
	url.searchParams.set('pageLength', String(limit));
	// kiwix-serve OpenSearch uses 0-based `start` (start=0 is the first/best hit).
	url.searchParams.set('start', String(start));

	let res: Response;
	try {
		res = await fetch(url.toString(), {
			headers: { accept: 'application/xml,text/xml,text/html,*/*' },
			signal: AbortSignal.timeout(20_000),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			result: {
				ok: false,
				error: `kiwix-serve unreachable at ${origin}: ${message}`,
				download: zim,
				zimFiles: candidates,
				hint:
					zim.ready || candidates.length
						? `Start server: bash ~/.grok/long-running-background-tasks/run_kiwix_serve.sh (Docker ghcr.io/kiwix/kiwix-serve on ${origin})`
						: 'Wait for ZIM download to finish, then start kiwix-serve.',
			},
		};
	}

	const body = await res.text();
	if (!res.ok) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `kiwix-serve HTTP ${res.status}`,
				origin,
				bodyPreview: body.slice(0, 300),
				download: zim,
			},
		};
	}

	const hits = parseXmlHits(body, limit).map((h) => ({
		...h,
		url: h.url.startsWith('http') ? h.url : `${origin}${h.url.startsWith('/') ? '' : '/'}${h.url}`,
	}));

	const wantExtracts = args.includeExtracts !== false;
	const extractLimit = Math.max(
		0,
		Math.min(5, Math.floor(Number(args.extractLimit ?? 2) || 2)),
	);
	const extractChars = Math.max(
		500,
		Math.min(20_000, Math.floor(Number(args.extractChars ?? 6000) || 6000)),
	);

	type HitWithExtract = {
		title: string;
		url: string;
		snippet: string;
		extract?: string;
		extractChars?: number;
	};

	const enriched: HitWithExtract[] = hits.map((h) => ({ ...h }));
	if (wantExtracts && extractLimit > 0 && enriched.length) {
		const qNorm = normalizeTitle(query);
		const ranked = [...enriched].sort((a, b) => {
			const as = titleMatchScore(normalizeTitle(a.title), qNorm);
			const bs = titleMatchScore(normalizeTitle(b.title), qNorm);
			return bs - as;
		});
		const toFetch = ranked.slice(0, extractLimit);
		await Promise.all(
			toFetch.map(async (hit) => {
				const extract = await fetchKiwixExtract(hit.url, extractChars);
				if (!extract) return;
				const target = enriched.find((h) => h.url === hit.url);
				if (!target) return;
				target.extract = extract;
				target.extractChars = extract.length;
			}),
		);
	}

	const exact =
		enriched.find((h) => normalizeTitle(h.title) === normalizeTitle(query)) ||
		enriched.find((h) => titleMatchScore(normalizeTitle(h.title), normalizeTitle(query)) >= 8) ||
		null;

	return {
		ok: true,
		result: {
			ok: true,
			query,
			origin,
			returned: enriched.length,
			hits: enriched,
			bestTitleMatch: exact
				? { title: exact.title, url: exact.url, hasExtract: Boolean(exact.extract) }
				: null,
			download: zim,
			note:
				'Offline Wikipedia via local kiwix-serve. Prefer hits[].extract (full article text) when present. Do not invent facts beyond extracts/snippets. If no on-topic extract, call web_search then fetch_url.',
		},
	};
}

function normalizeTitle(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/[_/]+/g, ' ')
		.replace(/[^\p{L}\p{N}\s,.-]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Higher is better; exact place titles should outrank loose token overlap. */
function titleMatchScore(titleNorm: string, queryNorm: string): number {
	if (!titleNorm || !queryNorm) return 0;
	if (titleNorm === queryNorm) return 100;
	if (titleNorm.startsWith(queryNorm) || queryNorm.startsWith(titleNorm)) return 40;
	const tParts = new Set(titleNorm.split(/[\s,]+/).filter(Boolean));
	const qParts = queryNorm.split(/[\s,]+/).filter(Boolean);
	if (!qParts.length) return 0;
	let hit = 0;
	for (const p of qParts) if (tParts.has(p)) hit += 1;
	const ratio = hit / qParts.length;
	return Math.round(ratio * 20) + (hit >= 2 ? 5 : 0);
}

async function fetchKiwixExtract(articleUrl: string, maxChars: number): Promise<string | null> {
	try {
		const res = await fetch(articleUrl, {
			headers: { accept: 'text/html,*/*' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) return null;
		const html = await res.text();
		const text = htmlToPlainText(html);
		if (text.length < 80) return null;
		return text.slice(0, maxChars);
	} catch {
		return null;
	}
}

function htmlToPlainText(html: string): string {
	let s = String(html || '');
	// Drop chrome early
	s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
	s = s.replace(/<(header|footer)[\s\S]*?<\/\1>/gi, ' ');
	// Prefer mw-content / mw-parser-output when present
	const main =
		(s.match(/<div[^>]+id="mw-content-text"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]+id="mw-/i) || [])[1] ||
		(s.match(/<div[^>]+class="[^"]*mw-parser-output[^"]*"[^>]*>([\s\S]*?)$/i) || [])[1] ||
		s;
	return stripTags(main).replace(/\s+/g, ' ').trim();
}
