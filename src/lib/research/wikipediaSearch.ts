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
		if (title || link) {
			hits.push({
				title: title || link,
				url: link,
				snippet: snippet.slice(0, 400),
			});
		}
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
	url.searchParams.set('start', String(start + 1)); // kiwix is 1-based

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

	return {
		ok: true,
		result: {
			ok: true,
			query,
			origin,
			returned: hits.length,
			hits,
			download: zim,
			note: 'Offline Wikipedia via local kiwix-serve. Cite titles/snippets only; do not invent article text beyond hits.',
		},
	};
}
