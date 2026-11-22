/**
 * Search the local Imperial War Museums "Timeline of conflict since 1914" corpus
 * under `.data/iwm-conflict-timeline/` (36 conflicts 1899–present + linked IWM history articles).
 */
import fs from 'node:fs';
import path from 'node:path';

export type IwmConflictSearchArgs = {
	query?: string;
	fromYear?: number | string;
	toYear?: number | string;
	region?: string;
	section?: string;
	ongoingOnly?: boolean;
	includeArticleText?: boolean;
	includeSitePages?: boolean;
	limit?: number;
};

type IwmEvent = {
	id: string;
	kind: string;
	title: string;
	start_year: number;
	end_year: number | null;
	date: string;
	end_date: string | null;
	ongoing: boolean;
	date_label: string;
	source_url: string;
	article_url: string | null;
	article_slug: string | null;
	article_title: string | null;
	summary: string;
	headings: string[];
	dated_mentions: string[];
	regions: string[];
	article_chars: number;
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'iwm-conflict-timeline');
	return path.join(process.cwd(), '.data', 'iwm-conflict-timeline');
}

function siteRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'iwm-site');
	return path.join(process.cwd(), '.data', 'iwm-site');
}

type SiteCatalogEntry = {
	ok?: boolean;
	section?: string;
	title?: string;
	digest?: string;
	textChars?: number;
	years?: string[];
};

function searchSiteCatalog(
	tokens: string[],
	sectionFilter: string,
	limit: number,
	includeText: boolean,
): { totalSitePages: number; hits: Array<Record<string, unknown>> } {
	const sRoot = siteRoot();
	const catFile = path.join(sRoot, 'catalog.json');
	if (!fs.existsSync(catFile)) return { totalSitePages: 0, hits: [] };
	let pages: Record<string, SiteCatalogEntry> = {};
	try {
		const raw = JSON.parse(fs.readFileSync(catFile, 'utf8')) as { pages?: Record<string, SiteCatalogEntry> };
		pages = raw.pages || {};
	} catch {
		return { totalSitePages: 0, hits: [] };
	}

	const entries = Object.entries(pages).filter(([, info]) => Boolean(info?.ok));
	const totalSitePages = entries.length;
	if (!tokens.length && !sectionFilter) {
		return { totalSitePages, hits: [] };
	}

	const scored: Array<{ url: string; info: SiteCatalogEntry; score: number; snippet: string }> = [];
	for (const [url, info] of entries) {
		const sec = String(info.section || '').toLowerCase();
		if (sectionFilter && sec !== sectionFilter) continue;
		const title = String(info.title || '');
		const titleLow = title.toLowerCase();
		const urlLow = url.toLowerCase();
		let score = 0;

		if (tokens.length === 0) {
			score = 1;
		} else {
			for (const t of tokens) {
				if (titleLow.includes(t)) score += 4;
				if (urlLow.includes(t)) score += 2;
				if ((info.years || []).includes(t)) score += 1;
			}
			// If title/url matched at least once OR query is specific, inspect digest text
			if (score === 0 && info.digest) {
				const dPath = path.join(sRoot, info.digest);
				if (fs.existsSync(dPath)) {
					try {
						const md = fs.readFileSync(dPath, 'utf8');
						const low = md.toLowerCase();
						for (const t of tokens) {
							if (low.includes(t)) score += 1;
						}
					} catch {
						/* skip */
					}
				}
			}
			if (score === 0) continue;
		}

		let snippet = '';
		if (info.digest) {
			const dPath = path.join(sRoot, info.digest);
			if (fs.existsSync(dPath)) {
				try {
					const md = fs.readFileSync(dPath, 'utf8');
					if (includeText) {
						snippet = md.slice(0, 1200);
					} else if (tokens.length > 0) {
						const low = md.toLowerCase();
						const idx = tokens
							.map((t) => low.indexOf(t))
							.filter((i) => i >= 0)
							.sort((a, b) => a - b)[0];
						const start = idx != null ? Math.max(0, idx - 120) : 0;
						snippet = md.slice(start, start + 420).replace(/\s+/g, ' ').trim();
					} else {
						snippet = md.slice(0, 320).replace(/\s+/g, ' ').trim();
					}
				} catch {
					/* skip */
				}
			}
		}

		scored.push({ url, info, score, snippet });
	}

	scored.sort((a, b) => b.score - a.score || (b.info.textChars || 0) - (a.info.textChars || 0));
	return {
		totalSitePages,
		hits: scored.slice(0, limit).map(({ url, info, score, snippet }) => ({
			url,
			section: info.section,
			title: info.title,
			years: info.years,
			textChars: info.textChars,
			snippet,
			score,
		})),
	};
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

function readEvents(root: string): IwmEvent[] {
	const file = path.join(root, 'events', 'events.jsonl');
	if (!fs.existsSync(file)) return [];
	const out: IwmEvent[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as IwmEvent);
		} catch {
			/* skip */
		}
	}
	return out;
}

function readArticleMarkdown(root: string, slug: string | null): string {
	if (!slug) return '';
	const p = path.join(root, 'articles', `${slug}.md`);
	if (!fs.existsSync(p)) return '';
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

export async function searchIwmConflictTimeline(args: IwmConflictSearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const root = dataRoot();
	const events = readEvents(root);
	if (!events.length) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `No IWM timeline found under ${root}. Run pnpm iwm:build.`,
			},
		};
	}

	const query = String(args.query || '').trim();
	const tokens = tokenize(query);
	const fromYear = args.fromYear != null && String(args.fromYear).trim() ? Number(args.fromYear) : null;
	const toYear = args.toYear != null && String(args.toYear).trim() ? Number(args.toYear) : null;
	const region = String(args.region || '').trim().toLowerCase();
	const ongoingOnly = Boolean(args.ongoingOnly);
	const includeArticleText = Boolean(args.includeArticleText);
	const limit = Math.max(1, Math.min(40, Math.floor(Number(args.limit ?? 15))));

	const scored: Array<{ ev: IwmEvent; score: number; articleSnippet?: string }> = [];

	for (const ev of events) {
		if (ongoingOnly && !ev.ongoing) continue;
		if (fromYear != null && Number.isFinite(fromYear)) {
			const effectiveEnd = ev.ongoing ? 2099 : (ev.end_year ?? ev.start_year);
			if (effectiveEnd < fromYear) continue;
		}
		if (toYear != null && Number.isFinite(toYear)) {
			if (ev.start_year > toYear) continue;
		}
		if (region) {
			const regHit = (ev.regions || []).some((r) => r.toLowerCase().includes(region));
			if (!regHit && !ev.title.toLowerCase().includes(region)) continue;
		}

		const articleMd =
			tokens.length > 0 || includeArticleText ? readArticleMarkdown(root, ev.article_slug) : '';
		const hay = [
			ev.title,
			ev.date_label,
			ev.summary,
			...(ev.headings || []),
			...(ev.dated_mentions || []),
			...(ev.regions || []),
			articleMd.slice(0, 6000),
		]
			.join(' ')
			.toLowerCase();

		let score = 1;
		if (tokens.length > 0) {
			score = 0;
			for (const t of tokens) {
				if (ev.title.toLowerCase().includes(t)) score += 4;
				if (ev.summary.toLowerCase().includes(t)) score += 2;
				if (hay.includes(t)) score += 1;
			}
			if (score === 0) continue;
		}

		let articleSnippet: string | undefined;
		if (includeArticleText && articleMd) {
			articleSnippet = articleMd.slice(0, 1400);
		} else if (tokens.length > 0 && articleMd) {
			const lower = articleMd.toLowerCase();
			const firstIdx = tokens
				.map((t) => lower.indexOf(t))
				.filter((i) => i >= 0)
				.sort((a, b) => a - b)[0];
			if (firstIdx != null) {
				const start = Math.max(0, firstIdx - 140);
				articleSnippet = articleMd.slice(start, start + 520).replace(/\s+/g, ' ').trim();
			}
		}

		scored.push({ ev, score, articleSnippet });
	}

	scored.sort((a, b) => {
		if (tokens.length > 0 && b.score !== a.score) return b.score - a.score;
		return a.ev.start_year - b.ev.start_year;
	});

	const section = String(args.section || '').trim().toLowerCase();
	const includeSitePages = args.includeSitePages !== false;
	const siteRes = includeSitePages
		? searchSiteCatalog(tokens, section, Math.min(12, limit), includeArticleText)
		: { totalSitePages: 0, hits: [] };

	return {
		ok: true,
		result: {
			ok: true,
			source: 'https://www.iwm.org.uk/history/first-world-war/timeline-of-conflict-since-1914',
			totalCorpusEvents: events.length,
			totalCrawledSitePages: siteRes.totalSitePages,
			matched: scored.length,
			hits: scored.slice(0, limit).map(({ ev, score, articleSnippet }) => ({
				id: ev.id,
				kind: ev.kind,
				title: ev.title,
				dateLabel: ev.date_label,
				startYear: ev.start_year,
				endYear: ev.end_year,
				ongoing: ev.ongoing,
				regions: ev.regions,
				summary: ev.summary,
				datedMentions: ev.dated_mentions.slice(0, 8),
				articleUrl: ev.article_url || ev.source_url,
				articleTitle: ev.article_title,
				articleSnippet,
				score,
			})),
			siteHits: siteRes.hits,
		},
	};
}
