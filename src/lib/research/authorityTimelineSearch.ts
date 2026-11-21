/**
 * Search local authority timeline events under `.data/authority-timelines/`.
 * Source-linked leads only — promo framing ≠ verified ops levels.
 */
import fs from 'fs';
import path from 'path';

export type AuthoritySearchArgs = {
	query?: string;
	agency?: string;
	from?: string;
	to?: string;
	materialType?: string;
	corridorOnly?: boolean;
	limit?: number;
};

type AuthorityEvent = {
	id?: string;
	agency?: string;
	date?: string;
	title?: string;
	summary?: string;
	url?: string;
	materialType?: string;
	audience?: string;
	geos?: Array<{ city?: string; county?: string; state?: string; label?: string }>;
	topics?: string[];
	signals?: Record<string, unknown>;
	corridor?: boolean;
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'authority-timelines');
	return path.join(process.cwd(), '.data', 'authority-timelines');
}

function eventsPath(): string {
	return path.join(dataRoot(), 'events', 'events.jsonl');
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

function haystack(e: AuthorityEvent): string {
	const geos = (e.geos || [])
		.map((g) => [g.city, g.county, g.state, g.label].filter(Boolean).join(' '))
		.join(' ');
	return [e.agency, e.date, e.title, e.summary, e.url, e.materialType, e.audience, geos, ...(e.topics || [])]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function scoreEvent(e: AuthorityEvent, tokens: string[]): number {
	if (!tokens.length) return 1;
	const h = haystack(e);
	let score = 0;
	for (const t of tokens) {
		if (h.includes(t)) score += 1;
		if (String(e.title || '')
			.toLowerCase()
			.includes(t))
			score += 1;
	}
	if (e.signals?.isPromo || e.signals?.isSignedDirective) score += 0.5;
	if (e.corridor || (e.geos && e.geos.length)) score += 0.25;
	return score;
}

function loadEvents(): AuthorityEvent[] {
	const file = eventsPath();
	if (!fs.existsSync(file)) return [];
	const out: AuthorityEvent[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as AuthorityEvent);
		} catch {
			/* skip bad line */
		}
	}
	return out;
}

function loadAggregateSnippet(name: string, maxChars = 1200): string | null {
	const p = path.join(dataRoot(), 'aggregates', name);
	if (!fs.existsSync(p)) return null;
	const raw = fs.readFileSync(p, 'utf8');
	return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
}

export async function searchAuthorityTimelines(args: AuthoritySearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const query = String(args.query || '').trim();
	const agency = String(args.agency || '')
		.trim()
		.toUpperCase();
	const from = String(args.from || '').trim();
	const to = String(args.to || '').trim();
	const materialType = String(args.materialType || '')
		.trim()
		.toLowerCase();
	const corridorOnly = Boolean(args.corridorOnly);
	const limit = clampLimit(args.limit, 12);
	const tokens = tokenize(query);

	const events = loadEvents();
	if (!events.length) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `No authority events at ${eventsPath()}. Run pnpm authority:download && pnpm authority:aggregate.`,
			},
		};
	}

	const filtered = events.filter((e) => {
		if (agency && String(e.agency || '').toUpperCase() !== agency) return false;
		if (from && String(e.date || '') < from) return false;
		if (to && String(e.date || '') > to) return false;
		if (materialType && String(e.materialType || '').toLowerCase() !== materialType) return false;
		if (corridorOnly) {
			const geos = Array.isArray(e.geos) ? e.geos : [];
			const hasCorridorGeo = geos.some((g) => Boolean((g as { corridor?: boolean }).corridor));
			if (!e.corridor && !hasCorridorGeo) return false;
		}
		if (tokens.length && scoreEvent(e, tokens) < 1) return false;
		return true;
	});

	const ranked = filtered
		.map((e) => ({ e, score: scoreEvent(e, tokens) }))
		.sort((a, b) => b.score - a.score || String(b.e.date || '').localeCompare(String(a.e.date || '')))
		.slice(0, limit);

	const hits = ranked.map(({ e, score }) => ({
		id: e.id,
		agency: e.agency,
		date: e.date,
		title: e.title,
		summary: e.summary ? String(e.summary).slice(0, 400) : undefined,
		url: e.url,
		materialType: e.materialType,
		audience: e.audience,
		geos: e.geos,
		topics: e.topics,
		score,
	}));

	const byAgency: Record<string, number> = {};
	for (const e of events) {
		const a = String(e.agency || 'UNK');
		byAgency[a] = (byAgency[a] || 0) + 1;
	}

	return {
		ok: true,
		result: {
			ok: true,
			query: query || null,
			filters: { agency: agency || null, from: from || null, to: to || null, materialType: materialType || null, corridorOnly },
			totalEvents: events.length,
			matched: filtered.length,
			returned: hits.length,
			byAgency,
			hits,
			note: 'Source-linked leads from local .data/authority-timelines. Promo framing ≠ verified deployment levels.',
			aggregatesHint: {
				geoFocus: loadAggregateSnippet('geo-focus.json', 600),
				okTxCorridor: loadAggregateSnippet('ok-tx-corridor.json', 600),
			},
			path: eventsPath(),
		},
	};
}
