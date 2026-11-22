/**
 * Search the local Regional History corpus under `.data/regional-history-corpus/`:
 *   - ny_boston_finance: New York & Boston financial history (Wall Street, NYSE, NY/Boston Fed, State Street, Fidelity, BNY, JPM, Goldman, panics/crashes)
 *   - ny_boston_labor_unions: New York & Boston labor & union history (Lawrence Bread & Roses, Boston Police Strike, Lowell Mill Girls, Triangle Fire, ILGWU, ILA, IWW, AFL)
 *   - ny_boston_conflicts: Regional conflicts in NY & Boston (King Philip's War, Boston Massacre/Tea Party, Lexington/Concord, Siege of Boston, NY/NJ Campaign, Shays' Rebellion, Draft Riots, Wall Street Bombing, 9/11)
 *   - dfw_military_tech: Dallas–Fort Worth military/defense/industrial tech companies (Bell Textron, Halliburton, Rockwell Collins / Collins Aerospace, Emerson Electric, Tubacex, Lockheed Martin, Air Force Plant 4, Texas Instruments, Vought/LTV, L3Harris/E-Systems, RTX, General Dynamics)
 */
import fs from 'node:fs';
import path from 'node:path';

export type RegionalHistorySearchArgs = {
	query?: string;
	track?: string;
	profileType?: string;
	fromYear?: number | string;
	toYear?: number | string;
	includeArticleText?: boolean;
	limit?: number;
};

type SeedProfile = {
	slug: string;
	wikiTitle: string;
	track: string;
	profileType: string;
	name: string;
	geo: string;
	secHq?: string | null;
	angle: string;
	startDate?: string | null;
	endDate?: string | null;
	aliases?: string[];
	cik?: string | null;
	ticker?: string | null;
	sicDescription?: string | null;
	url: string;
	summary: string;
	charCount: number;
	milestones?: Array<{ date: string; precision: string; text: string }>;
};

function dataRoot(): string {
	const env = String(process.env.RESEARCH_DATA_DIR || '').trim();
	if (env) return path.resolve(env, '..', 'regional-history-corpus');
	return path.join(process.cwd(), '.data', 'regional-history-corpus');
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

export async function searchRegionalHistory(args: RegionalHistorySearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const root = dataRoot();
	const seedPath = path.join(root, 'profiles', 'seed-profiles.json');
	if (!fs.existsSync(seedPath)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `No regional history corpus under ${root}. Run pnpm regional:build.`,
			},
		};
	}

	const profiles = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedProfile[];
	const query = String(args.query || '').trim();
	const tokens = tokenize(query);
	const track = String(args.track || '').trim().toLowerCase();
	const profileType = String(args.profileType || '').trim().toLowerCase();
	const fromYear = args.fromYear != null && String(args.fromYear).trim() ? Number(args.fromYear) : null;
	const toYear = args.toYear != null && String(args.toYear).trim() ? Number(args.toYear) : null;
	const includeArticleText = Boolean(args.includeArticleText);
	const limit = Math.max(1, Math.min(30, Math.floor(Number(args.limit ?? 12))));

	const scored: Array<{ p: SeedProfile; score: number; snippet?: string }> = [];

	for (const p of profiles) {
		if (track && p.track.toLowerCase() !== track) continue;
		if (profileType && p.profileType.toLowerCase() !== profileType) continue;

		if (fromYear != null && Number.isFinite(fromYear)) {
			const endY = p.endDate ? Number(p.endDate.slice(0, 4)) : 2099;
			if (Number.isFinite(endY) && endY < fromYear) continue;
		}
		if (toYear != null && Number.isFinite(toYear)) {
			const startY = p.startDate ? Number(p.startDate.slice(0, 4)) : null;
			if (startY != null && Number.isFinite(startY) && startY > toYear) continue;
		}

		const artPath = path.join(root, 'articles', `${p.slug}.md`);
		const articleMd =
			(tokens.length > 0 || includeArticleText) && fs.existsSync(artPath)
				? fs.readFileSync(artPath, 'utf8')
				: '';

		let score = 1;
		if (tokens.length > 0) {
			score = 0;
			const titleLow = p.name.toLowerCase();
			const aliasLow = (p.aliases || []).join(' ').toLowerCase();
			const sumLow = p.summary.toLowerCase();
			const artLow = articleMd.slice(0, 12000).toLowerCase();
			for (const t of tokens) {
				if (titleLow.includes(t)) score += 5;
				if (aliasLow.includes(t)) score += 3;
				if (sumLow.includes(t)) score += 2;
				if (p.geo.toLowerCase().includes(t)) score += 2;
				if (artLow.includes(t)) score += 1;
			}
			if (score === 0) continue;
		}

		let snippet: string | undefined;
		if (includeArticleText && articleMd) {
			snippet = articleMd.slice(0, 1500);
		} else if (tokens.length > 0 && articleMd) {
			const low = articleMd.toLowerCase();
			const idx = tokens
				.map((t) => low.indexOf(t))
				.filter((i) => i >= 0)
				.sort((a, b) => a - b)[0];
			if (idx != null) {
				const start = Math.max(0, idx - 140);
				snippet = articleMd.slice(start, start + 500).replace(/\s+/g, ' ').trim();
			}
		}

		scored.push({ p, score, snippet });
	}

	scored.sort((a, b) => {
		if (tokens.length > 0 && b.score !== a.score) return b.score - a.score;
		return String(a.p.startDate || '9999').localeCompare(String(b.p.startDate || '9999'));
	});

	return {
		ok: true,
		result: {
			ok: true,
			totalArticles: profiles.length,
			matched: scored.length,
			hits: scored.slice(0, limit).map(({ p, score, snippet }) => ({
				slug: p.slug,
				name: p.name,
				track: p.track,
				profileType: p.profileType,
				geo: p.geo,
				secHq: p.secHq,
				cik: p.cik,
				ticker: p.ticker,
				sicDescription: p.sicDescription,
				startDate: p.startDate,
				endDate: p.endDate,
				aliases: p.aliases,
				summary: p.summary,
				milestones: (p.milestones || []).slice(0, 5),
				url: p.url,
				snippet,
				score,
			})),
		},
	};
}
