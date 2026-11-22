/**
 * Search local Physics Congress 2026 corpus (.data/physics-congress).
 */
import fs from 'fs';
import path from 'path';

export type PhysicsCongressSearchArgs = {
	query?: string;
	kind?: 'page' | 'pdf' | 'speaker' | 'doc' | 'any';
	limit?: number;
};

function root() {
	return path.join(process.cwd(), '.data', 'physics-congress');
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

export async function searchPhysicsCongress(args: PhysicsCongressSearchArgs) {
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
				error: 'Physics Congress corpus not ready. Run pnpm physics-congress:all',
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

	if (kind === 'any' || kind === 'pdf' || kind === 'doc') {
		for (const [url, meta] of Object.entries(catalog.assets || {}) as Array<[string, Record<string, unknown>]>) {
			if (!meta?.ok) continue;
			const p = String(meta.path || '');
			const isPdf = String(url).toLowerCase().includes('.pdf') || p.endsWith('.pdf');
			const isDoc = p.includes('/docs/') || p.endsWith('.txt');
			if (kind === 'pdf' && !isPdf) continue;
			if (kind === 'doc' && !isDoc) continue;
			if (kind === 'any' && !isPdf && !isDoc && !meta.digest) continue;
			const sc = score(`${url}\n${p}`);
			if (toks.length && sc < 1) continue;
			hits.push({
				kind: isDoc ? 'doc' : 'pdf',
				url,
				path: meta.path,
				textChars: meta.textChars,
				digest: meta.digest,
				score: sc + Math.min(1, Number(meta.textChars || 0) / 40000),
			});
		}
	}

	if (kind === 'any' || kind === 'speaker') {
		const speakersPath = path.join(base, 'speakers.json');
		if (fs.existsSync(speakersPath)) {
			const data = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
			for (const sp of data.speakers || []) {
				const hay = `${sp.name || ''}\n${sp.affiliation || ''}\n${sp.bio || ''}`;
				const sc = score(hay);
				if (toks.length && sc < 1) continue;
				hits.push({ kind: 'speaker', ...sp, score: sc + 0.25 });
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
			note: 'Local Physics Congress 2026 (physics-congress.kz / Nazarbayev University, Astana) archive.',
		},
	};
}
