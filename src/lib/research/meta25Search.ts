/**
 * Search local META 2025 conference archive (.data/meta25).
 * Newer-conference promo (META 2026/2027) is excluded from the corpus.
 */
import fs from 'fs';
import path from 'path';

export type Meta25SearchArgs = {
	query?: string;
	kind?: 'page' | 'pdf' | 'video' | 'speaker' | 'any';
	limit?: number;
};

function root() {
	return path.join(process.cwd(), '.data', 'meta25');
}

function clamp(n: unknown, d = 8) {
	const v = Number(n);
	if (!Number.isFinite(v)) return d;
	return Math.max(1, Math.min(30, Math.floor(v)));
}

function tokens(q: string) {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9\-]+/i)
		.filter((t) => t.length >= 2);
}

export async function searchMeta25(args: Meta25SearchArgs) {
	const query = String(args.query || '').trim();
	const kind = String(args.kind || 'any').toLowerCase();
	const limit = clamp(args.limit, 8);
	const toks = tokens(query);
	const base = root();
	const catalogPath = path.join(base, 'catalog.json');
	if (!fs.existsSync(catalogPath)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'META 2025 corpus not ready. Run pnpm meta25:all',
			},
		};
	}
	const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
	const hits: Array<Record<string, unknown>> = [];

	const score = (hay: string) => {
		const h = hay.toLowerCase();
		if (!toks.length) return 1;
		return toks.reduce((s, t) => s + (h.includes(t) ? 1 : 0), 0);
	};

	if (kind === 'any' || kind === 'page') {
		for (const [url, meta] of Object.entries(catalog.pages || {}) as Array<[string, Record<string, unknown>]>) {
			if (!meta?.ok) continue;
			const title = String(meta.title || url);
			const sc = score(`${title}\n${url}`);
			if (toks.length && sc < 1) continue;
			hits.push({ kind: 'page', url, title, digest: meta.digest, score: sc });
		}
	}

	if (kind === 'any' || kind === 'pdf') {
		for (const [url, meta] of Object.entries(catalog.assets || {}) as Array<[string, Record<string, unknown>]>) {
			if (!meta?.ok) continue;
			const p = String(meta.path || '');
			if (!String(url).toLowerCase().includes('.pdf') && !p.endsWith('.pdf')) continue;
			const sc = score(`${url}\n${p}`);
			if (toks.length && sc < 1) continue;
			hits.push({
				kind: 'pdf',
				url,
				path: meta.path,
				textChars: meta.textChars,
				digest: meta.digest,
				score: sc + Math.min(1.5, Number(meta.textChars || 0) / 80000),
			});
		}
	}

	if (kind === 'any' || kind === 'video') {
		for (const [url, meta] of Object.entries(catalog.videos || {}) as Array<[string, Record<string, unknown>]>) {
			const title = meta.title || url;
			const sc = score(`${title}\n${url}`);
			if (toks.length && sc < 1) continue;
			hits.push({
				kind: 'video',
				url,
				title,
				language: meta.language,
				digest: meta.digest,
				transcriptEn: meta.transcriptEnPath,
				score: sc + (meta.transcriptPath ? 0.5 : 0),
			});
		}
	}

	if (kind === 'any' || kind === 'speaker') {
		const speakersPath = path.join(base, 'speakers.json');
		if (fs.existsSync(speakersPath)) {
			const data = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
			for (const sp of data.speakers || []) {
				const hay = `${sp.name || ''}\n${sp.affiliation || ''}\n${sp.talk || ''}\n${sp.role || ''}`;
				const sc = score(hay);
				if (toks.length && sc < 1) continue;
				hits.push({ kind: 'speaker', ...sp, score: sc + 0.2 });
			}
		}
	}

	hits.sort((a, b) => Number(b.score) - Number(a.score));
	const out = hits.slice(0, limit).map((h) => {
		if (h.digest) {
			const fp = path.join(base, String(h.digest));
			if (fs.existsSync(fp)) {
				h.excerpt = fs.readFileSync(fp, 'utf8').slice(0, 1500);
			}
		}
		if (h.transcriptEn) {
			const fp = path.join(base, String(h.transcriptEn));
			if (fs.existsSync(fp)) {
				h.transcriptExcerpt = fs.readFileSync(fp, 'utf8').slice(0, 1500);
			}
		}
		return h;
	});

	return {
		ok: true,
		result: {
			ok: true,
			query: query || null,
			kind,
			returned: out.length,
			hits: out,
			note: 'Local META 2025 (Malaga) archive. META 2026/2027 promotional material is excluded.',
		},
	};
}
