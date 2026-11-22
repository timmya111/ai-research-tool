/**
 * Search local CDC Museum COVID-19 timeline under `.data/cdc-covid-timeline/`.
 * CDC narrative leads only — not a full pharma ledger or clinical proof corpus.
 */
import fs from 'fs';
import path from 'path';

export type CdcCovidSearchArgs = {
	query?: string;
	from?: string;
	to?: string;
	entityType?: string;
	entity?: string;
	financialsOnly?: boolean;
	limit?: number;
};

type CdcEvent = {
	id?: string;
	date?: string;
	date_label?: string;
	section?: string;
	text?: string;
	paragraphs?: string[];
	url?: string;
	source?: string;
	tags?: {
		companies?: string[];
		persons?: string[];
		vaccines?: string[];
		treatments?: string[];
		variants_strains?: string[];
		diseases?: string[];
		orgs?: string[];
		financials?: string[];
	};
	topics?: string[];
};

type CdcEntity = {
	type: string;
	name: string;
	mentions: number;
	event_ids: string[];
	dates: string[];
	snippets: string[];
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'cdc-covid-timeline');
	return path.join(process.cwd(), '.data', 'cdc-covid-timeline');
}

function clampLimit(n: unknown, fallback = 12): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(40, Math.floor(v)));
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9$]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

function loadEvents(): CdcEvent[] {
	const p = path.join(dataRoot(), 'events', 'events.jsonl');
	if (!fs.existsSync(p)) return [];
	const out: CdcEvent[] = [];
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as CdcEvent);
		} catch {
			/* skip */
		}
	}
	return out;
}

function loadEntities(): CdcEntity[] {
	const p = path.join(dataRoot(), 'entities', 'entities.json');
	if (!fs.existsSync(p)) return [];
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8')) as CdcEntity[];
	} catch {
		return [];
	}
}

function haystack(e: CdcEvent): string {
	const t = e.tags || {};
	return [
		e.date,
		e.date_label,
		e.section,
		e.text,
		...(e.topics || []),
		...(t.companies || []),
		...(t.persons || []),
		...(t.vaccines || []),
		...(t.treatments || []),
		...(t.variants_strains || []),
		...(t.diseases || []),
		...(t.orgs || []),
		...(t.financials || []),
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function scoreEvent(e: CdcEvent, tokens: string[]): number {
	if (!tokens.length) return 1;
	const h = haystack(e);
	let s = 0;
	for (const tok of tokens) {
		if (h.includes(tok)) s += tok.length >= 5 ? 3 : 2;
	}
	if (e.tags?.financials?.length && tokens.some((t) => ['fund', 'funding', 'billion', 'million', 'cares', 'price', 'contract', 'award', '$'].includes(t) || t.startsWith('$'))) {
		s += 2;
	}
	return s;
}

export function searchCdcCovidTimeline(args: CdcCovidSearchArgs = {}): Record<string, unknown> {
	const root = dataRoot();
	const eventsPath = path.join(root, 'events', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) {
		return {
			ok: false,
			error: 'CDC COVID timeline corpus missing. Expected .data/cdc-covid-timeline/events/events.jsonl',
			source: 'https://www.cdc.gov/museum/timeline/covid19.html',
		};
	}

	const limit = clampLimit(args.limit, args.financialsOnly ? 20 : 12);
	const tokens = tokenize(args.query || '');
	const from = args.from ? String(args.from).slice(0, 10) : '';
	const to = args.to ? String(args.to).slice(0, 10) : '';
	const entityType = String(args.entityType || '')
		.trim()
		.toLowerCase();
	const entityName = String(args.entity || '')
		.trim()
		.toLowerCase();
	const financialsOnly = Boolean(args.financialsOnly);

	const typeMap: Record<string, keyof NonNullable<CdcEvent['tags']>> = {
		company: 'companies',
		companies: 'companies',
		person: 'persons',
		persons: 'persons',
		people: 'persons',
		vaccine: 'vaccines',
		vaccines: 'vaccines',
		treatment: 'treatments',
		treatments: 'treatments',
		cure: 'treatments',
		cures: 'treatments',
		therapeutic: 'treatments',
		variant: 'variants_strains',
		variants: 'variants_strains',
		strain: 'variants_strains',
		strains: 'variants_strains',
		superstrain: 'variants_strains',
		disease: 'diseases',
		diseases: 'diseases',
		org: 'orgs',
		orgs: 'orgs',
		agency: 'orgs',
	};

	const tagKey = entityType ? typeMap[entityType] : undefined;
	const events = loadEvents();
	const scored: Array<{ score: number; e: CdcEvent }> = [];

	for (const e of events) {
		if (from && e.date && e.date < from) continue;
		if (to && e.date && e.date > to) continue;
		if (financialsOnly && !(e.tags?.financials && e.tags.financials.length)) continue;
		if (tagKey) {
			const list = (e.tags?.[tagKey] as string[] | undefined) || [];
			if (!list.length) continue;
			if (entityName && !list.some((n) => n.toLowerCase().includes(entityName))) continue;
		} else if (entityName) {
			const h = haystack(e);
			if (!h.includes(entityName)) continue;
		}
		const score = scoreEvent(e, tokens);
		if (tokens.length && score <= 0) continue;
		scored.push({ score, e });
	}

	scored.sort((a, b) => b.score - a.score || String(a.e.date).localeCompare(String(b.e.date)));
	const hits = scored.slice(0, limit).map(({ score, e }) => ({
		score,
		id: e.id,
		date: e.date,
		date_label: e.date_label,
		section: e.section,
		url: e.url,
		tags: e.tags,
		topics: e.topics,
		excerpt: (e.text || '').slice(0, 1200),
	}));

	const entities = loadEntities();
	let entityHits = entities;
	if (tagKey) {
		const wantType =
			tagKey === 'companies'
				? 'company'
				: tagKey === 'persons'
					? 'person'
					: tagKey === 'vaccines'
						? 'vaccine'
						: tagKey === 'treatments'
							? 'treatment'
							: tagKey === 'variants_strains'
								? 'variant_strain'
								: tagKey === 'diseases'
									? 'disease'
									: tagKey === 'orgs'
										? 'org'
										: '';
		entityHits = entities.filter((x) => x.type === wantType);
	}
	if (entityName) {
		entityHits = entityHits.filter((x) => x.name.toLowerCase().includes(entityName));
	}
	if (tokens.length && !entityName && !tagKey) {
		entityHits = entityHits.filter((x) => {
			const h = `${x.name} ${x.snippets.join(' ')}`.toLowerCase();
			return tokens.some((t) => h.includes(t));
		});
	}
	entityHits = entityHits.slice(0, Math.min(20, limit + 8));

	return {
		ok: true,
		source: 'https://www.cdc.gov/museum/timeline/covid19.html',
		note: 'CDC Museum select timeline — institutional narrative leads. Dollar figures are as worded on the page; not a complete pharma financial corpus. No literal “superstrain” term on this page; variants/VOCs are tagged under variants_strains.',
		query: args.query || null,
		from: from || null,
		to: to || null,
		returned: hits.length,
		totalMatched: scored.length,
		corpusEvents: events.length,
		hits,
		entities: entityHits.map((x) => ({
			type: x.type,
			name: x.name,
			mentions: x.mentions,
			first: x.dates?.[0] || null,
			last: x.dates?.[x.dates.length - 1] || null,
			snippet: (x.snippets?.[0] || '').slice(0, 320),
		})),
	};
}
