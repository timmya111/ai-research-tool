/**
 * Search local Gemini Q&A import under `.data/gemini-qa/` (digests + conversation index).
 */
import fs from 'fs';
import path from 'path';

export type GeminiQaSearchArgs = {
	query?: string;
	limit?: number;
};

type IndexRow = {
	id: string;
	title: string;
	turns?: number;
	sourceFile?: string;
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'gemini-qa');
	return path.join(process.cwd(), '.data', 'gemini-qa');
}

function clampLimit(n: unknown, fallback = 10): number {
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

function loadIndex(): IndexRow[] {
	const p = path.join(dataRoot(), 'conversations', 'index.json');
	if (!fs.existsSync(p)) return [];
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8')) as IndexRow[];
	} catch {
		return [];
	}
}

function digestPathFor(id: string): string | null {
	const digests = path.join(dataRoot(), 'digests');
	if (!fs.existsSync(digests)) return null;
	const safe = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
	const candidates = [
		path.join(digests, `${safe}.md`),
		...fs.readdirSync(digests).filter((f) => f.endsWith('.md') && f.includes(safe)).map((f) => path.join(digests, f)),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	// fallback: conversations json → any digest sharing prefix
	const jsonPath = path.join(dataRoot(), 'conversations', `${safe}.json`);
	if (fs.existsSync(jsonPath)) {
		const md = path.join(digests, `${safe}.md`);
		if (fs.existsSync(md)) return md;
	}
	return null;
}

function scoreText(hay: string, tokens: string[]): number {
	if (!tokens.length) return 1;
	let s = 0;
	for (const tok of tokens) {
		if (hay.includes(tok)) s += tok.length >= 5 ? 3 : 2;
	}
	return s;
}

export function searchGeminiQa(args: GeminiQaSearchArgs = {}): Record<string, unknown> {
	const root = dataRoot();
	const overviewPath = path.join(root, 'digests', 'OVERVIEW.md');

	if (!fs.existsSync(root)) {
		return {
			ok: false,
			error: 'Gemini Q&A corpus missing. Expected .data/gemini-qa/. Run: pnpm gemini-qa:import /path/to/takeout.zip',
		};
	}

	const index = loadIndex();
	const limit = clampLimit(args.limit, 10);
	const tokens = tokenize(args.query || '');

	if (!index.length) {
		const overview = fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, 'utf8').slice(0, 2000) : '';
		return {
			ok: true,
			note: 'Gemini Q&A folder is present but has 0 conversations. Current Google Takeout Gemini export often only includes empty gemini_gems_data.html / gemini_scheduled_actions_data.html stubs. Re-export Takeout with My Activity → Gemini Apps, or drop chat JSON/MD into .data/gemini-qa/raw/ and re-import.',
			returned: 0,
			totalMatched: 0,
			corpusConversations: 0,
			hits: [],
			overviewExcerpt: overview,
		};
	}

	const scored: Array<{ score: number; row: IndexRow; excerpt: string; path: string | null }> = [];
	for (const row of index) {
		const dp = digestPathFor(row.id);
		let body = `${row.title}\n`;
		if (dp && fs.existsSync(dp)) {
			body += fs.readFileSync(dp, 'utf8');
		} else {
			const jp = path.join(root, 'conversations', `${row.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}.json`);
			if (fs.existsSync(jp)) body += fs.readFileSync(jp, 'utf8');
		}
		const hay = body.toLowerCase();
		const score = scoreText(hay, tokens);
		if (tokens.length && score <= 0) continue;
		scored.push({
			score,
			row,
			path: dp,
			excerpt: body.slice(0, 1200),
		});
	}
	scored.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title));
	const hits = scored.slice(0, limit).map((x) => ({
		score: x.score,
		id: x.row.id,
		title: x.row.title,
		turns: x.row.turns || 0,
		sourceFile: x.row.sourceFile || null,
		digestPath: x.path,
		excerpt: x.excerpt,
	}));

	return {
		ok: true,
		source: '.data/gemini-qa',
		query: args.query || null,
		returned: hits.length,
		totalMatched: scored.length,
		corpusConversations: index.length,
		hits,
		hint: 'Also search_knowledge on project “Gemini Q&A” after ingest.',
	};
}
