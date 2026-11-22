/**
 * Search the local TWDB Trinity Aquifer corpus and append retrieval feedback
 * so structure.json can re-learn facet aliases over time.
 */
import fs from 'fs';
import path from 'path';

export type TwdbTrinitySearchArgs = {
	query?: string;
	docType?: string;
	gma?: string;
	topic?: string;
	year?: number | string;
	limit?: number;
};

type Doc = {
	id: string;
	url: string;
	ok?: boolean;
	digest?: string;
	savedPdf?: string;
	textChars?: number;
	facets?: {
		title?: string;
		docType?: string;
		gma?: string[];
		years?: number[];
		topics?: string[];
	};
};

function corpusRoot(): string {
	return path.join(process.cwd(), '.data', 'twdb-trinity-aquifer');
}

function clampLimit(n: unknown, fallback = 8): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(30, Math.floor(v)));
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9\-]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

function loadCatalog(): { documents: Doc[] } {
	const p = path.join(corpusRoot(), 'catalog.json');
	if (!fs.existsSync(p)) return { documents: [] };
	return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readDigestExcerpt(digestRel: string | undefined, maxChars: number): string {
	if (!digestRel) return '';
	const fp = path.join(corpusRoot(), digestRel);
	if (!fs.existsSync(fp)) return '';
	const raw = fs.readFileSync(fp, 'utf8');
	const body = raw.split('## Extracted text')[1] || raw;
	return body.trim().slice(0, maxChars);
}

function scoreDoc(doc: Doc, tokens: string[], excerpt: string): number {
	if (!tokens.length) return 1;
	const hay = `${doc.facets?.title || ''}\n${doc.url}\n${(doc.facets?.topics || []).join(' ')}\n${(doc.facets?.gma || []).join(' ')}\n${excerpt}`
		.toLowerCase();
	let score = 0;
	for (const t of tokens) {
		if (hay.includes(t)) score += 1;
		if ((doc.facets?.title || '').toLowerCase().includes(t)) score += 2;
	}
	if ((doc.textChars || 0) > 500) score += 0.25;
	return score;
}

function appendRetrievalLog(entry: Record<string, unknown>) {
	const root = corpusRoot();
	fs.mkdirSync(root, { recursive: true });
	fs.appendFileSync(path.join(root, 'retrieval-log.jsonl'), `${JSON.stringify(entry)}\n`);
}

export async function searchTwdbTrinity(args: TwdbTrinitySearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const query = String(args.query || '').trim();
	const docType = String(args.docType || '')
		.trim()
		.toLowerCase();
	const gma = String(args.gma || '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '');
	const topic = String(args.topic || '')
		.trim()
		.toLowerCase();
	const year = args.year != null && String(args.year).trim() !== '' ? Number(args.year) : null;
	const limit = clampLimit(args.limit, 8);
	const tokens = tokenize(query);

	const root = corpusRoot();
	if (!fs.existsSync(path.join(root, 'catalog.json'))) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'TWDB Trinity corpus not built yet. Run: pnpm twdb:trinity',
			},
		};
	}

	const catalog = loadCatalog();
	const docs = (catalog.documents || []).filter((d) => d.ok !== false);
	const filtered = docs.filter((d) => {
		if (docType && String(d.facets?.docType || '').toLowerCase() !== docType) return false;
		if (gma) {
			const want = gma.startsWith('GMA') ? gma : `GMA-${gma}`;
			if (!(d.facets?.gma || []).map((x) => x.toUpperCase()).includes(want)) return false;
		}
		if (topic && !(d.facets?.topics || []).map((t) => t.toLowerCase()).includes(topic)) return false;
		if (year && !(d.facets?.years || []).includes(year)) return false;
		return true;
	});

	const ranked = filtered
		.map((d) => {
			const excerpt = readDigestExcerpt(d.digest, 1800);
			return { d, excerpt, score: scoreDoc(d, tokens, excerpt) };
		})
		.filter((x) => (tokens.length ? x.score > 0 : true))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	const hits = ranked.map(({ d, excerpt, score }) => ({
		id: d.id,
		title: d.facets?.title,
		docType: d.facets?.docType,
		gma: d.facets?.gma,
		years: d.facets?.years,
		topics: d.facets?.topics,
		url: d.url,
		savedPdf: d.savedPdf,
		digest: d.digest,
		textChars: d.textChars,
		score,
		excerpt: excerpt.slice(0, 1200),
	}));

	appendRetrievalLog({
		at: new Date().toISOString(),
		query: query || null,
		filters: { docType: docType || null, gma: gma || null, topic: topic || null, year },
		hitIds: hits.map((h) => h.id),
		hits: hits.map((h) => ({ id: h.id, score: h.score, docType: h.docType })),
	});

	return {
		ok: true,
		result: {
			ok: true,
			query: query || null,
			corpus: root,
			total: docs.length,
			matched: ranked.length,
			returned: hits.length,
			hits,
			note: 'Local TWDB Trinity Aquifer corpus. Retrieval is logged to improve facet structure over time (pnpm twdb:trinity:restructure).',
		},
	};
}
