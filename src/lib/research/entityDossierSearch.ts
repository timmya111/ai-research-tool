/**
 * Search local entity dossiers / alias buckets / edges under `.data/entity-dossiers/`.
 */
import fs from 'fs';
import path from 'path';

export type EntityDossierSearchArgs = {
	query?: string;
	slug?: string;
	kind?: string;
	status?: string;
	includeBuckets?: boolean;
	includeEdges?: boolean;
	limit?: number;
};

type Dossier = {
	slug?: string;
	kind?: string;
	displayName?: string;
	aliases?: string[];
	status?: string;
	summary?: string;
	businesses?: Array<{ name?: string; ticker?: string; cik?: string; role?: string }>;
	geos?: Array<{ city?: string; county?: string; state?: string; label?: string }>;
	links?: Array<{ label?: string; url?: string }>;
	relatedSlugs?: string[];
	updatedAt?: string;
};

type Edge = {
	id?: string;
	from?: string;
	to?: string;
	kind?: string;
	evidence?: Array<{ url?: string; note?: string; eventId?: string }>;
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'entity-dossiers');
	return path.join(process.cwd(), '.data', 'entity-dossiers');
}

function clampLimit(n: unknown, fallback = 12): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(40, Math.floor(v)));
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

function loadJsonDir(dir: string): Dossier[] {
	if (!fs.existsSync(dir)) return [];
	const out: Dossier[] = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		try {
			out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Dossier);
		} catch {
			/* skip */
		}
	}
	return out;
}

function loadEdges(): Edge[] {
	const file = path.join(dataRoot(), 'edges.jsonl');
	if (!fs.existsSync(file)) return [];
	const out: Edge[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as Edge);
		} catch {
			/* skip */
		}
	}
	return out;
}

function haystack(d: Dossier): string {
	const biz = (d.businesses || [])
		.map((b) => [b.name, b.ticker, b.cik, b.role].filter(Boolean).join(' '))
		.join(' ');
	const geos = (d.geos || [])
		.map((g) => [g.city, g.county, g.state, g.label].filter(Boolean).join(' '))
		.join(' ');
	return [
		d.slug,
		d.kind,
		d.displayName,
		d.summary,
		d.status,
		...(d.aliases || []),
		...(d.relatedSlugs || []),
		biz,
		geos,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function scoreDoc(d: Dossier, tokens: string[]): number {
	if (!tokens.length) return 1;
	const h = haystack(d);
	let score = 0;
	for (const t of tokens) {
		if (h.includes(t)) score += 1;
		if (String(d.slug || '').toLowerCase() === t) score += 3;
		if (String(d.displayName || '')
			.toLowerCase()
			.includes(t))
			score += 2;
	}
	if (d.status === 'pinned') score += 0.5;
	return score;
}

function slim(d: Dossier): Record<string, unknown> {
	return {
		slug: d.slug,
		kind: d.kind,
		displayName: d.displayName,
		aliases: d.aliases,
		status: d.status,
		summary: d.summary ? String(d.summary).slice(0, 500) : undefined,
		businesses: d.businesses,
		geos: d.geos,
		links: (d.links || []).slice(0, 8),
		relatedSlugs: d.relatedSlugs,
		updatedAt: d.updatedAt,
	};
}

export async function searchEntityDossiers(args: EntityDossierSearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const query = String(args.query || '').trim();
	const slug = String(args.slug || '')
		.trim()
		.toLowerCase();
	const kind = String(args.kind || '')
		.trim()
		.toLowerCase();
	const status = String(args.status || '')
		.trim()
		.toLowerCase();
	const includeBuckets = args.includeBuckets !== false;
	const includeEdges = args.includeEdges !== false;
	const limit = clampLimit(args.limit, 12);
	const tokens = tokenize(query || slug);

	const root = dataRoot();
	const dossiers = loadJsonDir(path.join(root, 'dossiers'));
	const buckets = includeBuckets ? loadJsonDir(path.join(root, 'buckets')) : [];
	const all = [...dossiers, ...buckets];

	if (!all.length) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `No dossiers under ${root}. Run pnpm entities:seed && pnpm entities:enrich.`,
			},
		};
	}

	if (slug) {
		const exact = all.find((d) => String(d.slug || '').toLowerCase() === slug);
		if (!exact) {
			return {
				ok: false,
				result: { ok: false, error: `No dossier/bucket for slug=${slug}`, available: all.map((d) => d.slug) },
			};
		}
		const edges = includeEdges
			? loadEdges().filter(
					(e) =>
						String(e.from || '').toLowerCase() === slug || String(e.to || '').toLowerCase() === slug,
				)
			: [];
		return {
			ok: true,
			result: {
				ok: true,
				mode: 'slug',
				dossier: slim(exact),
				edges: edges.slice(0, 40),
				edgeCount: edges.length,
				path: root,
				note: 'Local seed/enrich dossier. Edges require evidence URLs or seed notes.',
			},
		};
	}

	const filtered = all.filter((d) => {
		if (kind && String(d.kind || '').toLowerCase() !== kind) return false;
		if (status && String(d.status || '').toLowerCase() !== status) return false;
		if (tokens.length && scoreDoc(d, tokens) < 1) return false;
		return true;
	});

	const ranked = filtered
		.map((d) => ({ d, score: scoreDoc(d, tokens) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	const hits: Array<Record<string, unknown> & { slug?: string; score: number }> = ranked.map(
		({ d, score }) => ({ ...slim(d), slug: d.slug, score }),
	);

	let relatedEdges: Edge[] = [];
	if (includeEdges && hits.length) {
		const slugs = new Set(hits.map((h) => String(h.slug || '').toLowerCase()).filter(Boolean));
		relatedEdges = loadEdges()
			.filter(
				(e) =>
					slugs.has(String(e.from || '').toLowerCase()) || slugs.has(String(e.to || '').toLowerCase()),
			)
			.slice(0, 40);
	}

	return {
		ok: true,
		result: {
			ok: true,
			query: query || null,
			filters: { kind: kind || null, status: status || null, includeBuckets, includeEdges },
			dossierCount: dossiers.length,
			bucketCount: buckets.length,
			matched: filtered.length,
			returned: hits.length,
			hits,
			relatedEdges,
			path: root,
			note: 'Local entity dossiers. Alias buckets stay candidate until pinned. Do not invent conspiracy links.',
		},
	};
}
