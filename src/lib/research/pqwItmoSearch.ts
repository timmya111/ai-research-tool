/**
 * Search local Petersburg Quantum Weeks (PQW / ITMO) corpus (.data/pqw-itmo).
 */
import fs from 'fs';
import path from 'path';

export type PqwItmoSearchArgs = {
	query?: string;
	kind?: 'page' | 'pdf' | 'speaker' | 'any';
	limit?: number;
};

function root() {
	return path.join(process.cwd(), '.data', 'pqw-itmo');
}

function clamp(n: unknown, d = 8) {
	const v = Number(n);
	if (!Number.isFinite(v)) return d;
	return Math.max(1, Math.min(30, Math.floor(v)));
}

function tokens(q: string) {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9\-а-яё]+/i)
		.filter((t) => t.length >= 2);
}

export async function searchPqwItmo(args: PqwItmoSearchArgs) {
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
				error: 'PQW ITMO corpus not ready. Run pnpm pqw:all',
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
			const sc = score(`${title}\n${url}\n${String(meta.lang || '')}`);
			if (toks.length && sc < 1) continue;
			hits.push({
				kind: 'page',
				url,
				title,
				lang: meta.lang,
				digest: meta.digestEn || meta.digest,
				score: sc + (meta.lang === 'en' ? 0.15 : 0),
			});
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
				score: sc + Math.min(1, Number(meta.textChars || 0) / 50000),
			});
		}
	}

	if (kind === 'any' || kind === 'speaker') {
		const speakersPath = path.join(base, 'speakers.json');
		if (fs.existsSync(speakersPath)) {
			const data = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
			const allSpeakers: Array<Record<string, unknown>> = [
				...((data.speakers || []) as Array<Record<string, unknown>>),
				...((data.programCommittee || []) as Array<Record<string, unknown>>).map(
					(s): Record<string, unknown> => ({ ...s, role: 'committee' }),
				),
			];
			for (const sp of allSpeakers) {
				const hay = `${sp.name || ''}\n${sp.affiliation || ''}\n${sp.country || ''}\n${sp.role || 'speaker'}`;
				const sc = score(hay);
				if (toks.length && sc < 1) continue;
				hits.push({
					kind: 'speaker',
					name: sp.name,
					affiliation: sp.affiliation,
					country: sp.country,
					role: sp.role || 'speaker',
					score: sc + 0.2,
				});
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
			note: 'Local Petersburg Quantum Weeks 2026 archive (pqw.itmo.ru EN/RU + PDFs). RU digests include English translations when available.',
		},
	};
}
