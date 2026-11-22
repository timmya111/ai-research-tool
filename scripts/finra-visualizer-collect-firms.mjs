#!/usr/bin/env node
/**
 * Collect all firms, CRDs, metadata, and current/previous broker connections from
 * https://finra-sec-data-visualizer-canvas.vercel.app/api/finra/* into
 * .data/finra-visualizer/ (resumable JSONL + JSON catalog), and ingest into
 * .data/profiles/profiles.sqlite.
 *
 * Usage:
 *   node scripts/finra-visualizer-collect-firms.mjs                  # full catalog + connections + ingest
 *   node scripts/finra-visualizer-collect-firms.mjs --catalog-only   # Phase 1 only (discover all firms & CRDs)
 *   node scripts/finra-visualizer-collect-firms.mjs --skip-catalog   # Resume Phase 2 connections + Phase 3 ingest
 *   node scripts/finra-visualizer-collect-firms.mjs --ingest-only    # Phase 3 only (ingest saved JSONL into profiles.sqlite)
 *   node scripts/finra-visualizer-collect-firms.mjs --limit 500      # Cap Phase 2 connections to N firms (for quick testing)
 *   node scripts/finra-visualizer-collect-firms.mjs --concurrency 12 # Parallel HTTP requests (default 10)
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const ORIGIN = (process.env.NEXT_PUBLIC_FINRA_APP_ORIGIN || 'https://finra-sec-data-visualizer-canvas.vercel.app').replace(/\/+$/, '');
const OUT_DIR = path.join(ROOT, '.data', 'finra-visualizer');
const CATALOG_PATH = path.join(OUT_DIR, 'firms_catalog.json');
const CONNECTIONS_JSONL = path.join(OUT_DIR, 'firm_connections.jsonl');
const SUMMARY_PATH = path.join(OUT_DIR, 'summary.json');

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const catalogOnly = argv.includes('--catalog-only');
const skipCatalog = argv.includes('--skip-catalog');
const ingestOnly = argv.includes('--ingest-only');
const noIngest = argv.includes('--no-ingest');
const limitFirms = getArgNum('--limit', 0);
const concurrency = Math.min(20, Math.max(1, getArgNum('--concurrency', 10)));

fs.mkdirSync(OUT_DIR, { recursive: true });

async function fetchJsonWithRetry(url, retries = 3, timeoutMs = 35_000) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: controller.signal,
				headers: { Accept: 'application/json' },
			});
			clearTimeout(timer);
			if (res.status === 429 || res.status >= 500) {
				if (attempt < retries) {
					await new Promise((r) => setTimeout(r, 400 * attempt));
					continue;
				}
				return { ok: false, status: res.status, data: null };
			}
			if (!res.ok) return { ok: false, status: res.status, data: null };
			const text = await res.text();
			return { ok: true, status: res.status, data: text ? JSON.parse(text) : null };
		} catch (err) {
			clearTimeout(timer);
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, 400 * attempt));
				continue;
			}
			return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { ok: false, status: 0, data: null };
}

async function runPool(items, workerFn, maxConcurrent) {
	let idx = 0;
	const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
		while (true) {
			const current = idx++;
			if (current >= items.length) break;
			await workerFn(items[current], current);
		}
	});
	await Promise.all(workers);
}

/**
 * Build a comprehensive query list to maximize discovery of every firm in the FINRA/SEC visualizer index.
 * Combines:
 *  - Single letters & digits (a-z, 0-9)
 *  - Corporate/financial/industry/geographic keywords
 *  - Broad 3-letter English consonant-vowel & vowel-consonant prefixes (because the visualizer indexes >=3-char prefixes!)
 */
function buildDiscoveryQueries() {
	const set = new Set();
	// 1. Single chars
	for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') set.add(c);

	// 2. High-yield corporate, legal, financial, geographic, and common surname/name tokens
	const words = [
		'inc', 'llc', 'corp', 'corporation', 'ltd', 'limited', 'llp', 'company', 'partnership', 'plc', 'gmbh',
		'securities', 'capital', 'financial', 'investments', 'investment', 'advisors', 'advisory', 'advisers',
		'advisor', 'management', 'services', 'service', 'group', 'partners', 'partner', 'associates', 'wealth',
		'markets', 'market', 'brokerage', 'broker', 'brokers', 'dealers', 'dealer', 'trading', 'trade', 'asset',
		'assets', 'fund', 'funds', 'equity', 'equities', 'trust', 'bank', 'banking', 'bancorp', 'holdings',
		'holding', 'ventures', 'venture', 'global', 'american', 'america', 'national', 'first', 'united',
		'states', 'international', 'pacific', 'atlantic', 'western', 'eastern', 'northern', 'southern',
		'central', 'new', 'york', 'chicago', 'boston', 'texas', 'california', 'florida', 'dallas', 'houston',
		'credit', 'real', 'estate', 'realty', 'energy', 'oil', 'gas', 'insurance', 'planning', 'planners',
		'private', 'public', 'research', 'institutional', 'retail', 'direct', 'prime', 'clearing', 'execution',
		'exchange', 'options', 'futures', 'commodities', 'fixed', 'income', 'bond', 'bonds', 'municipal',
		'corporate', 'commercial', 'industrial', 'technology', 'technologies', 'strategic', 'strategies',
		'solutions', 'systems', 'enterprises', 'industries', 'resources', 'development', 'properties', 'property',
		'distributors', 'distribution', 'marketing', 'consulting', 'consultants', 'retirement', 'pension',
		'benefits', 'mortgage', 'lending', 'finance', 'funding', 'leasing', 'network', 'alliance', 'federated',
		'fidelity', 'vanguard', 'morgan', 'goldman', 'sachs', 'merrill', 'lynch', 'schwab', 'rockefeller',
		'smith', 'jones', 'williams', 'brown', 'miller', 'davis', 'wilson', 'moore', 'taylor', 'anderson',
		'thomas', 'jackson', 'white', 'harris', 'martin', 'thompson', 'clark', 'lewis', 'lee', 'walker',
		'hall', 'allen', 'young', 'king', 'wright', 'hill', 'scott', 'green', 'adams', 'baker', 'nelson',
		'carter', 'roberts', 'turner', 'phillips', 'campbell', 'parker', 'evans', 'edwards', 'collins',
		'stewart', 'morris', 'rogers', 'reed', 'cook', 'bell', 'murphy', 'bailey', 'cooper', 'richardson',
		'howard', 'ward', 'brooks', 'wood', 'james', 'bennett', 'gray', 'hughes', 'price', 'ross', 'foster',
		'the', 'and', 'for', 'usa', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
		'north', 'south', 'east', 'west', 'mid', 'sun', 'star', 'bay', 'oak', 'red', 'blue', 'silver', 'gold',
		'stone', 'park', 'lake', 'river', 'harbor', 'bridge', 'summit', 'crest', 'peak', 'ridge', 'valley',
		'beacon', 'heritage', 'liberty', 'freedom', 'patriot', 'pioneer', 'premier', 'horizon', 'vision',
		'vantage', 'veritas', 'vertex', 'nexus', 'atlas', 'apollo', 'titan', 'alpha', 'beta', 'delta', 'omega',
		'point', 'street', 'avenue', 'plaza', 'tower', 'center', 'square', 'wall', 'main', 'broad', 'state',
		'union', 'mutual', 'provident', 'prudential', 'guardian', 'equitable', 'standard', 'universal', 'general',
		'continental', 'republic', 'empire', 'crown', 'royal', 'imperial', 'sovereign', 'legacy', 'century',
		'millennium', 'cornerstone', 'keystone', 'milestone', 'landmark', 'benchmark', 'capstone', 'compass',
		'anchor', 'harbour', 'citadel', 'fortress', 'shield', 'aegis', 'vanguard', 'blackrock', 'blackstone',
		'carlyle', 'kkr', 'apollo', 'ubs', 'barclays', 'hsbc', 'citi', 'citigroup', 'wells', 'fargo', 'chase',
		'jp', 'bny', 'mellon', 'jefferies', 'lazard', 'cantor', 'fitzgerald', 'stifel', 'raymond', 'baird',
		'piper', 'sandler', 'cowen', 'needham', 'oppenheimer', 'wedbush', 'stephens', 'william', 'blair',
		'cpa', 'pc', 'pa', 'pllc', 'lp', 'jv', 'co',
	];
	for (const w of words) set.add(w);

	// 3. All 26*5 = 130 consonant/letter + vowel + common 3rd letters? Even cleaner:
	// Generate all 2-letter pairs + vowel (or vowel + consonant + consonant) common English 3-letter prefixes (~650 queries)
	const letters = 'abcdefghijklmnopqrstuvwxyz';
	const vowels = 'aeiou';
	const commonThird = 'nrstlcm';
	for (const a of letters) {
		for (const v of vowels) {
			// e.g. bar, ban, bel, cap, car, col, com, con, cor, fin, for, gar, gen, har, mar, mer, mon, mor, nor, par, pen, per, por, pro, ran, rel, rem, ren, res, roc, san, sec, ser, sol, sta, str, sun, tar, ter, tor, val, van, ver, war, wel, wil, win
			for (const c of commonThird) {
				set.add(`${a}${v}${c}`);
			}
		}
	}
	// Also common 2-consonant + vowel starts (st, ch, sh, th, br, cr, dr, fr, gr, pr, tr, bl, cl, fl, gl, pl, sl, sc, sk, sm, sn, sp, sw, wh)
	const clusters = ['st', 'ch', 'sh', 'th', 'br', 'cr', 'dr', 'fr', 'gr', 'pr', 'tr', 'bl', 'cl', 'fl', 'gl', 'pl', 'sl', 'sc', 'sm', 'sp', 'sw', 'wh', 'kn', 'wr', 'qu', 'ph', 'mc', 'al', 'an', 'ar', 'as', 'at', 'el', 'em', 'en', 'er', 'es', 'ev', 'ex', 'in', 'im', 'ir', 'is', 'of', 'ol', 'om', 'on', 'op', 'or', 'os', 'ov', 'un', 'up', 'ur', 'us'];
	for (const cl of clusters) {
		for (const v of vowels) {
			set.add(`${cl}${v}`);
		}
	}

	return [...set];
}

function normalizeFirmRow(rawHit) {
	const s = rawHit?._source && typeof rawHit._source === 'object' ? rawHit._source : rawHit || {};
	const crd = String(s.firm_id ?? s.firmId ?? s.firm_source_id ?? rawHit?._id ?? '')
		.trim()
		.replace(/[^\d]/g, '');
	if (!crd) return null;
	const name = String(s.firm_name || s.firmName || s.iaFirmName || `Firm ${crd}`).trim();
	const otherRaw = Array.isArray(s.firm_other_names)
		? s.firm_other_names
		: Array.isArray(s.otherNames)
			? s.otherNames
			: [];
	const otherNames = [...new Set(otherRaw.map((x) => String(x || '').trim()).filter(Boolean))];
	return {
		crd,
		name,
		otherNames,
		bcScope: s.firm_bc_scope || s.bcScope || null,
		iaScope: s.firm_ia_scope || s.iaScope || null,
		bdSecNumber: s.bdSecNumber || s.bd_sec_number || null,
		iaSecNumber: s.iaSecNumber || s.ia_sec_number || null,
		disclosureFlag: s.disclosureFlag || null,
		iaDisclosureFlag: s.iaDisclosureFlag || null,
	};
}

async function runPhase1Catalog() {
	const t0 = Date.now();
	const firms = new Map();

	// Load existing catalog if present so discovery is additive/resumable
	if (fs.existsSync(CATALOG_PATH)) {
		try {
			const prev = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
			if (Array.isArray(prev.firms)) {
				for (const f of prev.firms) {
					if (f?.crd) firms.set(String(f.crd), f);
				}
			}
		} catch {
			/* ignore */
		}
	}

	const queries = buildDiscoveryQueries();
	console.log(`[finra:phase1] Sweeping ${queries.length} discovery queries across ${ORIGIN}/api/finra/search (concurrency=${concurrency})...`);

	let completed = 0;
	let totalPages = 0;

	await runPool(
		queries,
		async (q) => {
			let start = 0;
			while (true) {
				const url = `${ORIGIN}/api/finra/search?query=${encodeURIComponent(q)}&type=firm&nrows=1000&start=${start}`;
				const res = await fetchJsonWithRetry(url);
				totalPages += 1;
				if (!res.ok || !res.data) break;
				const hits = res.data?.hits?.hits || [];
				for (const h of hits) {
					const norm = normalizeFirmRow(h);
					if (!norm) continue;
					if (!firms.has(norm.crd)) {
						firms.set(norm.crd, norm);
					} else {
						const prev = firms.get(norm.crd);
						if (norm.otherNames.length > (prev.otherNames?.length || 0)) {
							prev.otherNames = [...new Set([...(prev.otherNames || []), ...norm.otherNames])];
						}
						if (!prev.bcScope && norm.bcScope) prev.bcScope = norm.bcScope;
						if (!prev.iaScope && norm.iaScope) prev.iaScope = norm.iaScope;
						if (!prev.bdSecNumber && norm.bdSecNumber) prev.bdSecNumber = norm.bdSecNumber;
						if (!prev.iaSecNumber && norm.iaSecNumber) prev.iaSecNumber = norm.iaSecNumber;
					}
				}
				const total = Number(res.data?.total ?? res.data?.hits?.total ?? 0);
				if (!hits.length || start + hits.length >= total || start >= 20_000) break;
				start += hits.length;
			}
			completed += 1;
			if (completed % 150 === 0 || completed === queries.length) {
				console.log(`[finra:phase1] ${completed}/${queries.length} queries done (${totalPages} pages) -> ${firms.size} unique firms found`);
			}
		},
		concurrency,
	);

	const firmList = [...firms.values()].sort((a, b) => Number(a.crd) - Number(b.crd));
	fs.writeFileSync(
		CATALOG_PATH,
		JSON.stringify(
			{
				source: `${ORIGIN}/api/finra/search`,
				generatedAt: new Date().toISOString(),
				totalFirms: firmList.length,
				queriesSwept: queries.length,
				totalPagesFetched: totalPages,
				durationMs: Date.now() - t0,
				firms: firmList,
			},
			null,
			2,
		),
	);
	console.log(`[finra:phase1] Saved ${firmList.length} unique firms to ${CATALOG_PATH} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	return firmList;
}

async function loadExistingConnectionCrds() {
	const done = new Set();
	if (!fs.existsSync(CONNECTIONS_JSONL)) return done;
	const rl = readline.createInterface({
		input: fs.createReadStream(CONNECTIONS_JSONL, 'utf8'),
		crlfDelay: Infinity,
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj?.firmCrd) done.add(String(obj.firmCrd));
		} catch {
			/* ignore malformed tail */
		}
	}
	return done;
}

function mapConnectionPerson(row, isCurrentFallback) {
	if (!row || typeof row !== 'object') return null;
	const crd = String(row.individualId ?? row.ind_crd ?? row.crd ?? row.id ?? '')
		.trim()
		.replace(/[^\d]/g, '');
	if (!crd) return null;
	const name = String(row.name || row.ind_name || row.fullName || `Individual ${crd}`).trim();
	const isCurrent =
		typeof row.isCurrent === 'boolean'
			? row.isCurrent
			: /current/i.test(String(row.relationship || '')) || isCurrentFallback;
	return {
		crd,
		name,
		isCurrent,
		relationship: row.relationship ? String(row.relationship).trim() : null,
		bcScope: row.bcScope || row.ind_bc_scope || null,
		iaScope: row.iaScope || row.ind_ia_scope || null,
		address: row.address ? String(row.address).trim() : null,
	};
}

async function runPhase2Connections(firmList) {
	const t0 = Date.now();
	const alreadyDone = await loadExistingConnectionCrds();
	let pending = firmList.filter((f) => !alreadyDone.has(String(f.crd)));
	if (limitFirms > 0) pending = pending.slice(0, limitFirms);

	console.log(
		`[finra:phase2] Firms total=${firmList.length}, already collected=${alreadyDone.size}, pending=${pending.length} (concurrency=${concurrency})`,
	);
	if (pending.length === 0) return;

	const stream = fs.createWriteStream(CONNECTIONS_JSONL, { flags: 'a' });
	let doneCount = 0;
	let okCount = 0;
	let errCount = 0;
	let curEdges = 0;
	let prevEdges = 0;

	await runPool(
		pending,
		async (firm) => {
			const url = `${ORIGIN}/api/finra/firm/${firm.crd}/connections`;
			const res = await fetchJsonWithRetry(url, 3, 45_000);
			if (res.ok && res.data && typeof res.data === 'object') {
				const curRaw = Array.isArray(res.data.currentConnections) ? res.data.currentConnections : [];
				const prevRaw = Array.isArray(res.data.previousConnections) ? res.data.previousConnections : [];
				const current = [];
				const previous = [];
				const seenCur = new Set();
				for (const r of curRaw) {
					const p = mapConnectionPerson(r, true);
					if (p && !seenCur.has(p.crd)) {
						seenCur.add(p.crd);
						current.push(p);
					}
				}
				const seenPrev = new Set();
				for (const r of prevRaw) {
					const p = mapConnectionPerson(r, false);
					if (p && !seenPrev.has(p.crd)) {
						seenPrev.add(p.crd);
						previous.push(p);
					}
				}
				curEdges += current.length;
				prevEdges += previous.length;
				okCount += 1;
				stream.write(
					`${JSON.stringify({
						firmCrd: firm.crd,
						firmName: firm.name,
						found: res.data.found !== false,
						currentCount: current.length,
						previousCount: previous.length,
						current,
						previous,
						fetchedAt: new Date().toISOString(),
					})}\n`,
				);
			} else {
				errCount += 1;
			}
			doneCount += 1;
			if (doneCount % 250 === 0 || doneCount === pending.length) {
				const sec = ((Date.now() - t0) / 1000).toFixed(1);
				const rate = (doneCount / Math.max(0.1, (Date.now() - t0) / 1000)).toFixed(1);
				console.log(
					`[finra:phase2] ${doneCount}/${pending.length} (${rate}/s, ${sec}s) | ok=${okCount} err=${errCount} | current=${curEdges.toLocaleString()} prev=${prevEdges.toLocaleString()}`,
				);
			}
		},
		concurrency,
	);

	await new Promise((resolve) => stream.end(resolve));
	console.log(
		`[finra:phase2] Finished ${doneCount} firms in ${((Date.now() - t0) / 1000).toFixed(1)}s | ok=${okCount} err=${errCount} | current=${curEdges.toLocaleString()} previous=${prevEdges.toLocaleString()}`,
	);
}

async function runPhase3Ingest(firmList) {
	const t0 = Date.now();
	const { withProfilesTransaction } = await import('../src/lib/research/profiles/db.ts');
	const {
		upsertProfile,
		addAlias,
		addIdentifier,
		addLocation,
		upsertProfileLink,
		upsertSourceRecord,
	} = await import('../src/lib/research/profiles/store.ts');
	const { parseAddressParts } = await import('../src/lib/research/profiles/normalize.ts');

	const CORPUS = 'finra-visualizer';
	const firmIdByCrd = new Map();

	// 1. Ingest all firms in batches of 500 inside transactions
	console.log(`[finra:phase3] Ingesting ${firmList.length} firms into .data/profiles/profiles.sqlite...`);
	const BATCH = 500;
	for (let i = 0; i < firmList.length; i += BATCH) {
		const slice = firmList.slice(i, i + BATCH);
		withProfilesTransaction((tx) => {
			for (const f of slice) {
				const summaryParts = [`FINRA/SEC registered firm (CRD# ${f.crd})`];
				if (f.bcScope) summaryParts.push(`BrokerCheck: ${f.bcScope}`);
				if (f.iaScope) summaryParts.push(`IA: ${f.iaScope}`);
				if (f.bdSecNumber) summaryParts.push(`BD SEC# ${f.bdSecNumber}`);
				if (f.iaSecNumber) summaryParts.push(`IA SEC# ${f.iaSecNumber}`);
				const prof = upsertProfile(
					{
						profileType: 'firm',
						name: f.name,
						summary: summaryParts.join(' · '),
						sourceCorpus: CORPUS,
						metadata: {
							finraCrd: f.crd,
							finraBcScope: f.bcScope,
							finraIaScope: f.iaScope,
							bdSecNumber: f.bdSecNumber,
							iaSecNumber: f.iaSecNumber,
							disclosureFlag: f.disclosureFlag,
							iaDisclosureFlag: f.iaDisclosureFlag,
						},
					},
					tx,
				);
				firmIdByCrd.set(String(f.crd), prof.id);
				addIdentifier(
					{
						profileId: prof.id,
						scheme: 'finra_crd',
						value: String(f.crd),
						sourceCorpus: CORPUS,
					},
					tx,
				);
				for (const alt of f.otherNames || []) {
					if (alt && alt !== f.name) {
						addAlias(
							{
								profileId: prof.id,
								alias: alt,
								aliasKind: 'former_name',
								confidence: 0.95,
								sourceCorpus: CORPUS,
							},
							tx,
						);
					}
				}
			}
		});
	}
	console.log(`[finra:phase3] Upserted ${firmIdByCrd.size} firms in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	// 2. Stream firm_connections.jsonl and ingest connected people + current/previous links
	if (!fs.existsSync(CONNECTIONS_JSONL)) {
		console.log('[finra:phase3] No firm_connections.jsonl found yet; skipping connection links.');
		return;
	}

	const rl = readline.createInterface({
		input: fs.createReadStream(CONNECTIONS_JSONL, 'utf8'),
		crlfDelay: Infinity,
	});

	let firmsWithConns = 0;
	let peopleLinked = 0;
	let linksCreated = 0;
	const personIdCache = new Map();
	let chunkRows = [];

	const flushChunk = (rows) => {
		if (!rows.length) return;
		withProfilesTransaction((tx) => {
			for (const rec of rows) {
				const firmProfileId = firmIdByCrd.get(String(rec.firmCrd));
				if (!firmProfileId) continue;
				const srId = upsertSourceRecord(
					{
						corpus: CORPUS,
						sourceRef: `finra:firm:${rec.firmCrd}:connections`,
						sourceUrl: `${ORIGIN}/api/finra/firm/${rec.firmCrd}/connections`,
						title: `FINRA Connections: ${rec.firmName} (CRD# ${rec.firmCrd})`,
						excerpt: `${rec.currentCount} current · ${rec.previousCount} previous connected registrations.`,
					},
					tx,
				);

				const handleGroup = (arr, isCurrent) => {
					for (const p of arr || []) {
						let personId = personIdCache.get(p.crd);
						if (!personId) {
							const personProf = upsertProfile(
								{
									profileType: 'person',
									name: p.name,
									sourceCorpus: CORPUS,
									metadata: {
										finraCrd: p.crd,
										finraBcScope: p.bcScope,
										finraIaScope: p.iaScope,
									},
								},
								tx,
							);
							personId = personProf.id;
							personIdCache.set(p.crd, personId);
							addIdentifier(
								{
									profileId: personId,
									scheme: 'finra_crd',
									value: p.crd,
									sourceCorpus: CORPUS,
								},
								tx,
							);
							peopleLinked += 1;
						}
						if (p.address) {
							const parts = parseAddressParts(p.address);
							addLocation(
								{
									profileId: personId,
									raw: p.address,
									city: parts.city,
									county: parts.county,
									state: parts.state,
									country: parts.country,
									role: 'branch',
									sourceCorpus: CORPUS,
								},
								tx,
							);
						}
						const noteParts = [
							`status=${isCurrent ? 'current' : 'previous'}`,
							`CRD# ${p.crd}`,
							p.bcScope ? `bcScope=${p.bcScope}` : '',
							p.iaScope ? `iaScope=${p.iaScope}` : '',
							p.address ? `branch=${p.address}` : '',
						].filter(Boolean);
						upsertProfileLink(
							{
								fromProfileId: personId,
								toProfileId: firmProfileId,
								relationType: 'registered_at',
								roleLabel: isCurrent ? 'Current registration' : 'Previous registration',
								status: 'verified',
								confidence: 0.96,
								angle: 'regulatory_finra',
								sourceCorpus: CORPUS,
								sourceRecordId: srId,
								evidenceNote: noteParts.join('; '),
							},
							tx,
						);
						linksCreated += 1;
					}
				};

				handleGroup(rec.current, true);
				handleGroup(rec.previous, false);
				firmsWithConns += 1;
			}
		});
	};

	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			if (rec?.firmCrd && (rec.currentCount > 0 || rec.previousCount > 0)) {
				chunkRows.push(rec);
				if (chunkRows.length >= 25) {
					flushChunk(chunkRows);
					chunkRows = [];
					if (firmsWithConns % 500 === 0) {
						console.log(
							`[finra:phase3] Ingested connections for ${firmsWithConns} firms | uniquePeople=${peopleLinked.toLocaleString()} links=${linksCreated.toLocaleString()}`,
						);
					}
				}
			}
		} catch {
			/* skip */
		}
	}
	flushChunk(chunkRows);

	const summary = {
		generatedAt: new Date().toISOString(),
		source: ORIGIN,
		totalFirmsInCatalog: firmList.length,
		firmsWithConnectionsIngested: firmsWithConns,
		uniquePeopleIngested: peopleLinked,
		totalConnectionLinks: linksCreated,
		catalogPath: CATALOG_PATH,
		connectionsJsonlPath: CONNECTIONS_JSONL,
		durationMs: Date.now() - t0,
	};
	fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
	console.log('[finra:phase3] DONE:', JSON.stringify(summary, null, 2));
}

// Execute requested phases
let firmList = [];
if (!skipCatalog && !ingestOnly) {
	firmList = await runPhase1Catalog();
} else if (fs.existsSync(CATALOG_PATH)) {
	const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
	firmList = Array.isArray(raw.firms) ? raw.firms : [];
	console.log(`[finra] Loaded ${firmList.length} firms from ${CATALOG_PATH}`);
} else {
	throw new Error(`No catalog found at ${CATALOG_PATH}; run without --skip-catalog first.`);
}

if (!catalogOnly && !ingestOnly) {
	await runPhase2Connections(firmList);
}

if (!catalogOnly && !noIngest) {
	await runPhase3Ingest(firmList);
}
