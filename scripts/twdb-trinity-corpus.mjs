#!/usr/bin/env node
/**
 * Download + text-extract TWDB Trinity Aquifer PDFs into a retrieval-optimized corpus
 * that can restructure itself from content stats + retrieval feedback.
 *
 * Layout:
 *   .data/twdb-trinity-aquifer/
 *     catalog.json          — master index
 *     structure.json        — evolving taxonomy / facet rules
 *     retrieval-log.jsonl   — query → hit feedback for learning
 *     pdfs/                 — original PDFs
 *     digests/              — per-doc markdown (YAML frontmatter + text)
 *     by-facet/{facet}/{value}/ — symlinks into digests for browse paths
 *     OVERVIEW.md INDEX.md
 *
 * Usage:
 *   node scripts/twdb-trinity-corpus.mjs              # full run
 *   node scripts/twdb-trinity-corpus.mjs --limit 10
 *   node scripts/twdb-trinity-corpus.mjs --restructure-only
 *   node scripts/twdb-trinity-corpus.mjs --ingest-only
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, '.data', 'twdb-trinity-aquifer');
const SOURCE_PAGE =
	process.env.TWDB_TRINITY_URL ||
	'https://www.twdb.texas.gov/groundwater/aquifer/majors/trinity.asp';
const BASE_URL = 'https://www.twdb.texas.gov';
const SLEEP_MS = Number(process.env.TWDB_SLEEP_MS || 150);
const MAX_PDF_BYTES = Number(process.env.TWDB_MAX_PDF_BYTES || 80 * 1024 * 1024);

const DIRS = {
	pdfs: path.join(CORPUS, 'pdfs'),
	digests: path.join(CORPUS, 'digests'),
	byFacet: path.join(CORPUS, 'by-facet'),
};

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs() {
	fs.mkdirSync(DIRS.pdfs, { recursive: true });
	fs.mkdirSync(DIRS.digests, { recursive: true });
	fs.mkdirSync(DIRS.byFacet, { recursive: true });
	fs.mkdirSync(CORPUS, { recursive: true });
}

function loadJson(file, fallback) {
	if (!fs.existsSync(file)) return fallback;
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function saveJson(file, data) {
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function defaultStructure() {
	return {
		version: 1,
		updatedAt: null,
		label: 'TWDB Trinity Aquifer adaptive structure',
		preferredChunkHint: 'Prefer section headings, GMA ids, county names, aquifer units, and numeric tables.',
		facets: {
			docType: {
				label: 'Document type',
				values: {
					gam: { aliases: ['gam', 'groundwater availability model', 'model run'], weight: 1 },
					advisory: { aliases: ['aa-', '/aa/', 'advisory'], weight: 1 },
					report: { aliases: ['numbered_reports', '/r3', 'report'], weight: 1 },
					gmp: { aliases: ['gmp', 'management plan', 'gcd'], weight: 1 },
					water_level: { aliases: ['water-level', 'water level', 'wl-'], weight: 1 },
					hydraulic: { aliases: ['hydraulic', 'transmissivity', 'storativity', 'conductivity'], weight: 1 },
					org: { aliases: ['org-chart', 'public_comment', 'lend_rate'], weight: 0.2 },
					other: { aliases: [], weight: 0.1 },
				},
			},
			gma: {
				label: 'Groundwater Management Area',
				pattern: '\\bGMA[-\\s]?(\\d{1,2})\\b',
				values: {},
			},
			year: { label: 'Year', values: {} },
			county: { label: 'Texas county mentions', values: {} },
			topic: {
				label: 'Topics',
				values: {
					water_levels: { aliases: ['water level', 'hydrograph', 'potentiometric'], weight: 1 },
					recharge: { aliases: ['recharge'], weight: 1 },
					pumping: { aliases: ['pumping', 'withdrawals', 'production'], weight: 1 },
					quality: { aliases: ['water quality', 'chloride', 'tds'], weight: 1 },
					management: { aliases: ['desired future condition', 'dfc', 'management'], weight: 1 },
					geology: { aliases: ['stratigraphy', 'formation', 'paluxy', 'glen rose', 'travis peak', 'hosston'], weight: 1 },
				},
			},
		},
		learning: {
			minFacetHitsToPromote: 3,
			recentQueryBoost: 0.15,
			notes: [],
		},
	};
}

function sha1(s) {
	return crypto.createHash('sha1').update(s).digest('hex');
}

function safeName(url) {
	const base = path.basename(new URL(url).pathname) || 'doc.pdf';
	const cleaned = base.replace(/[^\w.\-]+/g, '_').slice(0, 100);
	return `${sha1(url).slice(0, 10)}-${cleaned}`;
}

function extractPdfText(buf) {
	const result = spawnSync('pdftotext', ['-layout', '-nopgbrk', '-', '-'], {
		input: buf,
		encoding: 'buffer',
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const err = String(result.stderr || result.error || 'pdftotext failed');
		return { text: '', error: err.slice(0, 240) };
	}
	return { text: Buffer.from(result.stdout || []).toString('utf8').trim(), error: null };
}

function classify(url, text, structure) {
	const hay = `${url}\n${text.slice(0, 20_000)}`.toLowerCase();
	const facets = {};

	// docType
	let bestType = 'other';
	let bestScore = -1;
	for (const [name, meta] of Object.entries(structure.facets.docType.values)) {
		let score = 0;
		for (const a of meta.aliases || []) {
			if (a && hay.includes(String(a).toLowerCase())) score += meta.weight || 1;
		}
		if (score > bestScore) {
			bestScore = score;
			bestType = name;
		}
	}
	facets.docType = bestType;

	// GMA
	const gmas = new Set();
	const gmaRe = new RegExp(structure.facets.gma.pattern || '\\bGMA[-\\s]?(\\d{1,2})\\b', 'gi');
	for (const m of `${url}\n${text}`.matchAll(gmaRe)) {
		gmas.add(`GMA-${m[1]}`);
	}
	facets.gma = [...gmas].sort();

	// years
	const years = new Set();
	for (const m of `${url}\n${text.slice(0, 50_000)}`.matchAll(/\b(19|20)\d{2}\b/g)) {
		const y = Number(m[0]);
		if (y >= 1950 && y <= 2030) years.add(y);
	}
	facets.years = [...years].sort((a, b) => b - a).slice(0, 12);

	// topics
	const topics = [];
	for (const [name, meta] of Object.entries(structure.facets.topic.values)) {
		if ((meta.aliases || []).some((a) => hay.includes(String(a).toLowerCase()))) topics.push(name);
	}
	facets.topics = topics;

	// title guess
	const firstLine = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 8 && l.length < 180 && !/^%PDF/i.test(l));
	const fileTitle = path.basename(new URL(url).pathname).replace(/\.pdf$/i, '');
	facets.title = firstLine || fileTitle;

	return facets;
}

function yamlFrontmatter(obj) {
	const lines = ['---'];
	const dump = (key, val, indent = 0) => {
		const pad = '  '.repeat(indent);
		if (val == null) return;
		if (Array.isArray(val)) {
			lines.push(`${pad}${key}:`);
			for (const v of val) lines.push(`${pad}  - ${JSON.stringify(v)}`);
			return;
		}
		if (typeof val === 'object') {
			lines.push(`${pad}${key}:`);
			for (const [k, v] of Object.entries(val)) dump(k, v, indent + 1);
			return;
		}
		lines.push(`${pad}${key}: ${JSON.stringify(val)}`);
	};
	for (const [k, v] of Object.entries(obj)) dump(k, v);
	lines.push('---', '');
	return lines.join('\n');
}

async function fetchPagePdfUrls() {
	const res = await fetch(SOURCE_PAGE, {
		headers: { 'User-Agent': 'ai-research-tool-twdb/1.0' },
		redirect: 'follow',
	});
	const html = await res.text();
	const hrefs = [...html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)].map((m) => m[1]);
	const uniq = [];
	const seen = new Set();
	for (const h of hrefs) {
		try {
			const abs = new URL(h.split('#')[0], SOURCE_PAGE).href;
			if (!/\.pdf$/i.test(abs.split('?')[0])) continue;
			if (seen.has(abs)) continue;
			seen.add(abs);
			uniq.push(abs);
		} catch {
			/* skip */
		}
	}
	return { html, urls: uniq, status: res.status };
}

async function downloadOne(url) {
	const res = await fetch(url, {
		headers: { 'User-Agent': 'ai-research-tool-twdb/1.0', Accept: 'application/pdf,*/*' },
		redirect: 'follow',
	});
	const buf = Buffer.from(await res.arrayBuffer());
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	if (buf.length > MAX_PDF_BYTES) throw new Error(`too large ${buf.length}`);
	if (buf.subarray(0, 5).toString('utf8') !== '%PDF-') throw new Error('not a PDF');
	return buf;
}

function writeDigest(entry, text) {
	const id = entry.id;
	const body = [
		yamlFrontmatter({
			id,
			corpus: 'twdb-trinity-aquifer',
			sourceUrl: entry.url,
			savedPdf: entry.savedPdf,
			docType: entry.facets.docType,
			gma: entry.facets.gma,
			years: entry.facets.years,
			topics: entry.facets.topics,
			title: entry.facets.title,
			textChars: text.length,
			extractedAt: entry.extractedAt,
		}),
		`# ${entry.facets.title}`,
		'',
		`Source: ${entry.url}`,
		'',
		'## Extracted text',
		'',
		text || '_(no selectable text — likely scanned plates/maps)_',
		'',
		'---',
		'_TWDB Trinity Aquifer corpus. Official agency publications; cite source URLs._',
		'',
	].join('\n');
	const digestRel = path.join('digests', `${id}.md`);
	const digestAbs = path.join(CORPUS, digestRel);
	fs.writeFileSync(digestAbs, body);
	entry.digest = digestRel;
	return digestRel;
}

function clearFacetTree() {
	if (!fs.existsSync(DIRS.byFacet)) return;
	fs.rmSync(DIRS.byFacet, { recursive: true, force: true });
	fs.mkdirSync(DIRS.byFacet, { recursive: true });
}

function linkFacet(facet, value, digestRel, id) {
	const dir = path.join(DIRS.byFacet, facet, String(value).replace(/[^\w.\-]+/g, '_'));
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(CORPUS, digestRel);
	const link = path.join(dir, `${id}.md`);
	try {
		if (fs.existsSync(link)) fs.unlinkSync(link);
		fs.symlinkSync(path.relative(dir, target), link);
	} catch {
		fs.copyFileSync(target, link);
	}
}

function rebuildFacets(catalog, structure) {
	clearFacetTree();
	const counts = { docType: {}, gma: {}, year: {}, topic: {} };
	for (const e of catalog.documents || []) {
		if (!e.digest || !e.facets) continue;
		linkFacet('docType', e.facets.docType || 'other', e.digest, e.id);
		counts.docType[e.facets.docType || 'other'] = (counts.docType[e.facets.docType || 'other'] || 0) + 1;
		for (const g of e.facets.gma || []) {
			linkFacet('gma', g, e.digest, e.id);
			counts.gma[g] = (counts.gma[g] || 0) + 1;
		}
		for (const y of (e.facets.years || []).slice(0, 3)) {
			linkFacet('year', y, e.digest, e.id);
			counts.year[y] = (counts.year[y] || 0) + 1;
		}
		for (const t of e.facets.topics || []) {
			linkFacet('topic', t, e.digest, e.id);
			counts.topic[t] = (counts.topic[t] || 0) + 1;
		}
	}
	structure.facetCounts = counts;
	structure.updatedAt = new Date().toISOString();
	return structure;
}

function learnFromRetrieval(structure, catalog) {
	const logPath = path.join(CORPUS, 'retrieval-log.jsonl');
	if (!fs.existsSync(logPath)) return structure;
	const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-500);
	const termHits = new Map();
	for (const line of lines) {
		try {
			const row = JSON.parse(line);
			const q = String(row.query || '').toLowerCase();
			for (const tok of q.split(/[^a-z0-9\-]+/).filter((t) => t.length >= 3)) {
				termHits.set(tok, (termHits.get(tok) || 0) + 1);
			}
			for (const hit of row.hits || []) {
				const doc = (catalog.documents || []).find((d) => d.id === hit.id);
				if (!doc?.facets) continue;
				// boost topic aliases from successful hits
			}
		} catch {
			/* skip */
		}
	}
	const promote = [];
	for (const [term, n] of [...termHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
		if (n >= (structure.learning?.minFacetHitsToPromote || 3)) promote.push({ term, n });
	}
	// Add frequent query terms as topic aliases if missing
	const topicValues = structure.facets.topic.values;
	for (const { term, n } of promote) {
		let found = false;
		for (const meta of Object.values(topicValues)) {
			if ((meta.aliases || []).includes(term)) {
				found = true;
				meta.weight = (meta.weight || 1) + (structure.learning?.recentQueryBoost || 0.15);
				break;
			}
		}
		if (!found && !['the', 'and', 'for', 'pdf', 'twdb', 'from'].includes(term)) {
			topicValues[`q_${term}`] = { aliases: [term], weight: 1, learned: true, hits: n };
		}
	}
	structure.learning = structure.learning || {};
	structure.learning.lastPromoted = promote.slice(0, 20);
	structure.learning.notes = [
		...(structure.learning.notes || []).slice(-20),
		{
			at: new Date().toISOString(),
			msg: `Promoted ${promote.length} retrieval terms into topic facets`,
		},
	];
	return structure;
}

function writeOverview(catalog, structure) {
	const docs = catalog.documents || [];
	const ok = docs.filter((d) => d.ok).length;
	const lines = [
		'# TWDB Trinity Aquifer corpus',
		'',
		`- Source page: ${SOURCE_PAGE}`,
		`- Documents: ${docs.length} (ok=${ok})`,
		`- Updated: ${catalog.updatedAt}`,
		`- Structure version: ${structure.version}`,
		'',
		'## Facet counts',
		'',
		'```json',
		JSON.stringify(structure.facetCounts || {}, null, 2),
		'```',
		'',
		'## Browse',
		'',
		'- `pdfs/` — originals',
		'- `digests/` — text + YAML frontmatter (best for RAG ingest)',
		'- `by-facet/` — docType / gma / year / topic views (rewritten as structure learns)',
		'- `retrieval-log.jsonl` — query feedback for adaptive restructuring',
		'',
		'## Commands',
		'',
		'```bash',
		'pnpm twdb:trinity          # download/extract/restructure',
		'pnpm twdb:trinity:ingest   # push digests into knowledge project',
		'pnpm twdb:trinity:restructure',
		'```',
		'',
	];
	fs.writeFileSync(path.join(CORPUS, 'OVERVIEW.md'), lines.join('\n'));
	const index = [
		'# Index',
		'',
		...docs.map(
			(d) =>
				`- [${d.facets?.title || d.id}](${d.digest || d.savedPdf || d.url}) · ${d.facets?.docType || '?'} · ${(d.facets?.gma || []).join(',') || 'no-GMA'} · chars=${d.textChars || 0}`,
		),
		'',
	];
	fs.writeFileSync(path.join(CORPUS, 'INDEX.md'), index.join('\n'));
}

async function ingestKnowledge(catalog) {
	const BASE_URL_API = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
	const PROJECT_NAME = process.env.TWDB_PROJECT_NAME || 'TWDB Trinity Aquifer';
	const api = async (pathname, { method = 'GET', body } = {}) => {
		const res = await fetch(`${BASE_URL_API}${pathname}`, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
		return data;
	};
	const listed = await api('/api/knowledge/projects');
	let project = (listed.projects || []).find(
		(p) => String(p.name || '').toLowerCase() === PROJECT_NAME.toLowerCase(),
	);
	if (!project) {
		const created = await api('/api/knowledge/projects', { method: 'POST', body: { name: PROJECT_NAME } });
		project = created.project || created;
	}
	const projectId = project.id;
	// overview first
	for (const name of ['OVERVIEW.md', 'INDEX.md']) {
		const fp = path.join(CORPUS, name);
		if (!fs.existsSync(fp)) continue;
		const text = fs.readFileSync(fp, 'utf8').slice(0, 47_000);
		await api('/api/knowledge', { method: 'POST', body: { projectId, title: `TWDB ${name}`, text } });
	}
	let n = 0;
	for (const d of catalog.documents || []) {
		if (!d.digest) continue;
		const fp = path.join(CORPUS, d.digest);
		if (!fs.existsSync(fp)) continue;
		const text = fs.readFileSync(fp, 'utf8').slice(0, 47_000);
		await api('/api/knowledge', {
			method: 'POST',
			body: { projectId, title: d.facets?.title || d.id, text, url: d.url },
		});
		n += 1;
		if (n % 20 === 0) console.log(`[twdb-ingest] ${n}`);
		await sleep(30);
	}
	console.log(`[twdb-ingest] done project=${PROJECT_NAME} id=${projectId} docs=${n}`);
	return { projectId, n };
}

async function main() {
	const args = process.argv.slice(2);
	const limitIdx = args.indexOf('--limit');
	const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0;
	const restructureOnly = args.includes('--restructure-only');
	const ingestOnly = args.includes('--ingest-only');

	ensureDirs();
	const catalogPath = path.join(CORPUS, 'catalog.json');
	const structurePath = path.join(CORPUS, 'structure.json');
	let catalog = loadJson(catalogPath, {
		version: 1,
		sourcePage: SOURCE_PAGE,
		documents: [],
		updatedAt: null,
	});
	let structure = loadJson(structurePath, defaultStructure());

	if (ingestOnly) {
		await ingestKnowledge(catalog);
		return;
	}

	if (!restructureOnly) {
		console.log(`[twdb] fetching index ${SOURCE_PAGE}`);
		const { urls, status } = await fetchPagePdfUrls();
		console.log(`[twdb] page status=${status} unique_pdfs=${urls.length}`);
		catalog.sourcePage = SOURCE_PAGE;
		catalog.listedUrls = urls;
		const byUrl = new Map((catalog.documents || []).map((d) => [d.url, d]));
		let i = 0;
		for (const url of urls) {
			if (limit && i >= limit) break;
			const existing = byUrl.get(url);
			if (existing?.ok && existing.savedPdf && fs.existsSync(path.join(CORPUS, existing.savedPdf))) {
				// refresh classification from existing digest text if present
				i += 1;
				continue;
			}
			i += 1;
			const id = sha1(url).slice(0, 12);
			console.log(`[twdb] ${i}/${urls.length} ${url}`);
			try {
				const buf = await downloadOne(url);
				const fileName = safeName(url);
				const savedPdf = path.join('pdfs', fileName);
				fs.writeFileSync(path.join(CORPUS, savedPdf), buf);
				const { text, error } = extractPdfText(buf);
				const facets = classify(url, text, structure);
				const entry = {
					id,
					url,
					ok: true,
					savedPdf,
					byteLength: buf.length,
					textChars: text.length,
					extractError: error,
					facets,
					extractedAt: new Date().toISOString(),
				};
				writeDigest(entry, text);
				byUrl.set(url, entry);
			} catch (e) {
				byUrl.set(url, {
					id: sha1(url).slice(0, 12),
					url,
					ok: false,
					error: e instanceof Error ? e.message : String(e),
					extractedAt: new Date().toISOString(),
					facets: { docType: 'other', gma: [], years: [], topics: [], title: path.basename(url) },
				});
				console.warn(`[twdb] FAIL ${url}: ${e instanceof Error ? e.message : e}`);
			}
			catalog.documents = [...byUrl.values()];
			catalog.updatedAt = new Date().toISOString();
			saveJson(catalogPath, catalog);
			await sleep(SLEEP_MS);
		}
		catalog.documents = [...byUrl.values()];
	}

	structure = learnFromRetrieval(structure, catalog);
	// reclassify all with updated structure
	for (const e of catalog.documents || []) {
		if (!e.digest) continue;
		const fp = path.join(CORPUS, e.digest);
		if (!fs.existsSync(fp)) continue;
		const raw = fs.readFileSync(fp, 'utf8');
		const text = raw.split('## Extracted text')[1] || raw;
		e.facets = classify(e.url, text, structure);
		writeDigest(e, text.replace(/^\s*\n/, '').replace(/\n---[\s\S]*$/, '').trim());
	}
	structure = rebuildFacets(catalog, structure);
	catalog.updatedAt = new Date().toISOString();
	saveJson(catalogPath, catalog);
	saveJson(structurePath, structure);
	writeOverview(catalog, structure);
	console.log(
		`[twdb] complete docs=${catalog.documents.length} ok=${catalog.documents.filter((d) => d.ok).length}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
