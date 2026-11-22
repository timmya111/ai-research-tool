/**
 * Search local Digital Earth ISDE corpus (.data/digitalearth-isde).
 */
import fs from 'fs';
import path from 'path';

export type DigitalEarthSearchArgs = {
	query?: string;
	kind?: 'page' | 'pdf' | 'video' | 'data_layer' | 'any';
	limit?: number;
};

function root() {
	return path.join(process.cwd(), '.data', 'digitalearth-isde');
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

export async function searchDigitalEarth(args: DigitalEarthSearchArgs) {
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
				error: 'Digital Earth corpus not ready. Run pnpm digitalearth:all',
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
		for (const [url, meta] of Object.entries(catalog.pages || {}) as [string, any][]) {
			if (!meta?.ok) continue;
			const title = meta.title || url;
			const sc = score(`${title}\n${url}`);
			if (toks.length && sc < 1) continue;
			hits.push({ kind: 'page', url, title, digest: meta.digest, score: sc });
		}
	}
	if (kind === 'any' || kind === 'video') {
		for (const [url, meta] of Object.entries(catalog.videos || {}) as [string, any][]) {
			const title = meta.title || url;
			const sc = score(`${title}\n${url}\n${meta.language || ''}`);
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
	if (kind === 'any' || kind === 'pdf') {
		for (const [url, meta] of Object.entries(catalog.assets || {}) as [string, any][]) {
			if (!meta?.ok) continue;
			if (!String(url).toLowerCase().includes('.pdf') && !String(meta.path || '').endsWith('.pdf')) continue;
			const sc = score(`${url}\n${meta.path || ''}`);
			if (toks.length && sc < 1) continue;
			hits.push({ kind: 'pdf', url, path: meta.path, textChars: meta.textChars, score: sc });
		}
	}
	if (kind === 'any' || kind === 'data_layer') {
		const layersPath = path.join(base, 'data-layers.json');
		if (fs.existsSync(layersPath)) {
			const layers = JSON.parse(fs.readFileSync(layersPath, 'utf8'));
			for (const ref of layers.references || []) {
				const hay = `${ref.url || ''}\n${ref.snippet || ''}\n${ref.match || ''}`;
				const sc = score(hay);
				if (toks.length && sc < 1) continue;
				hits.push({ kind: 'data_layer', ...ref, score: sc + 0.25 });
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
			note: 'Local Digital Earth ISDE archive. Video English transcripts are whisper+Ollama translations when source ≠ English.',
		},
	};
}
