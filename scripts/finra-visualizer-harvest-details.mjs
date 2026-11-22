#!/usr/bin/env node
/**
 * Strictly READ-ONLY full details harvester for https://finra-sec-data-visualizer-canvas.vercel.app.
 * Collects:
 *   Phase 1: All cached individuals via GET /api/finra/search?type=individual
 *   Phase 2: All merged firm details via GET /api/finra/merged/firm/{crd}
 *            (HQ/mailing addresses, directOwners/officers/shareholders, approval date, disclosures, registrations)
 *   Phase 3: All merged individual details via GET /api/finra/merged/individual/{crd}
 *            (dated current & previous BD+IA employments, branch offices, exams, states, disclosures)
 *
 * All raw data is persisted locally under .data/finra-visualizer/ (resumable JSONL)
 * and ingested into .data/profiles/profiles.sqlite.
 *
 * Usage:
 *   node scripts/finra-visualizer-harvest-details.mjs                    # run all phases
 *   node scripts/finra-visualizer-harvest-details.mjs --firms-only       # Phase 2 only
 *   node scripts/finra-visualizer-harvest-details.mjs --individuals-only # Phase 1 + Phase 3 only
 *   node scripts/finra-visualizer-harvest-details.mjs --concurrency 16   # parallel GETs (default 14)
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

const ORIGIN = (
	process.env.NEXT_PUBLIC_FINRA_APP_ORIGIN || 'https://finra-sec-data-visualizer-canvas.vercel.app'
).replace(/\/+$/, '');
const OUT_DIR = path.join(ROOT, '.data', 'finra-visualizer');
const FIRMS_CATALOG = path.join(OUT_DIR, 'firms_catalog.json');
const INDS_CATALOG = path.join(OUT_DIR, 'individuals_catalog.json');
const FIRM_DETAILS_JSONL = path.join(OUT_DIR, 'firm_details.jsonl');
const IND_DETAILS_JSONL = path.join(OUT_DIR, 'individual_details.jsonl');
const HARVEST_SUMMARY = path.join(OUT_DIR, 'details_summary.json');

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const firmsOnly = argv.includes('--firms-only');
const individualsOnly = argv.includes('--individuals-only');
const limitFirms = getArgNum('--limit-firms', 0);
const limitInds = getArgNum('--limit-individuals', 0);
const concurrency = Math.min(20, Math.max(1, getArgNum('--concurrency', 14)));

fs.mkdirSync(OUT_DIR, { recursive: true });

async function readOnlyGetJson(url, retries = 3, timeoutMs = 30_000) {
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
		} catch {
			clearTimeout(timer);
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, 400 * attempt));
				continue;
			}
			return { ok: false, status: 0, data: null };
		}
	}
	return { ok: false, status: 0, data: null };
}

async function runPool(items, workerFn, maxConcurrent) {
	let idx = 0;
	await Promise.all(
		Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
			while (true) {
				const cur = idx++;
				if (cur >= items.length) break;
				await workerFn(items[cur], cur);
			}
		}),
	);
}

async function loadExistingIds(jsonlPath, keyName) {
	const seen = new Set();
	if (!fs.existsSync(jsonlPath)) return seen;
	const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath, 'utf8'), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			const j = JSON.parse(line);
			if (j?.[keyName]) seen.add(String(j[keyName]));
		} catch {
			/* ignore */
		}
	}
	return seen;
}

const { getProfilesDb } = await import('../src/lib/research/profiles/db.ts');
const { ingestFirmDetailPayloadIntoDb, ingestIndividualFromVisualizer } = await import(
	'../src/lib/research/finraVisualizerMirror.ts'
);

/**
 * Phase 1: Sweep /api/finra/search?type=individual to discover every cached individual in the visualizer.
 */
async function discoverCachedIndividuals() {
	const t0 = Date.now();
	const alpha = 'abcdefghijklmnopqrstuvwxyz'.split('');
	const digits = '0123456789'.split('');
	const vowels = ['a', 'e', 'i', 'o', 'u'];
	const common2 = [];
	for (const a of alpha) {
		for (const v of vowels) common2.push(a + v);
	}
	const commonNames = [
		'james', 'john', 'robert', 'michael', 'william', 'david', 'richard', 'joseph', 'thomas', 'charles',
		'christopher', 'daniel', 'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua',
		'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
		'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez',
		'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin', 'lee', 'thompson', 'white',
		'harris', 'clark', 'lewis', 'robinson', 'walker', 'young', 'allen', 'king', 'wright', 'scott',
		'hill', 'green', 'adams', 'baker', 'nelson', 'carter', 'mitchell', 'roberts', 'turner', 'phillips',
		'campbell', 'parker', 'evans', 'edwards', 'collins', 'stewart', 'morris', 'rogers', 'reed', 'cook',
	];
	// 3-letter common name prefixes (a-z x a,e,i,o,u x common consonants)
	const endCons = ['r', 'n', 'l', 's', 't', 'd', 'm', 'c', 'k', 'b', 'g', 'h', 'p', 'v', 'w'];
	const tri = [];
	for (const c1 of alpha) {
		for (const v of vowels) {
			for (const c2 of endCons.slice(0, 8)) tri.push(c1 + v + c2);
		}
	}
	const queries = [...new Set([...alpha, ...digits, ...common2, ...commonNames, ...tri])];
	const byCrd = new Map();

	let done = 0;
	await runPool(
		queries,
		async (q) => {
			let start = 0;
			const nrows = 1000;
			while (true) {
				const url = `${ORIGIN}/api/finra/search?query=${encodeURIComponent(q)}&type=individual&nrows=${nrows}&start=${start}`;
				const res = await readOnlyGetJson(url, 2, 20_000);
				if (!res.ok || !res.data?.hits?.hits) break;
				const hits = res.data.hits.hits;
				const total = Number(res.data.hits.total?.value ?? res.data.hits.total ?? hits.length);
				for (const h of hits) {
					const s = h?._source || h;
					const crd = String(s?.ind_source_id || s?.ind_crd || s?.crd || '').replace(/\D/g, '');
					if (!crd || byCrd.has(crd)) continue;
					const name = [s?.ind_firstname, s?.ind_middlename, s?.ind_lastname]
						.filter(Boolean)
						.join(' ')
						.replace(/\s+/g, ' ')
						.trim();
					byCrd.set(crd, { crd, name });
				}
				start += hits.length;
				if (hits.length < nrows || start >= total || start >= 10000) break;
			}
			done += 1;
			if (done % 150 === 0 || done === queries.length) {
				console.log(
					`[harvest:phase1-inds] ${done}/${queries.length} queries (${((Date.now() - t0) / 1000).toFixed(1)}s) | unique cached individuals=${byCrd.size.toLocaleString()}`,
				);
			}
		},
		concurrency,
	);

	const list = [...byCrd.values()];
	fs.writeFileSync(
		INDS_CATALOG,
		JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, individuals: list }, null, 2),
	);
	console.log(`[harvest:phase1-inds] Saved ${list.length.toLocaleString()} cached individuals to ${INDS_CATALOG}`);
	return list;
}

/**
 * Phase 2: Harvest full merged firm details (/api/finra/merged/firm/{crd}) for all firms & ingest into SQLite.
 */
async function harvestAllFirmDetails() {
	const t0 = Date.now();
	const db = getProfilesDb();
	const firmCrds = new Set();

	if (fs.existsSync(FIRMS_CATALOG)) {
		const raw = JSON.parse(fs.readFileSync(FIRMS_CATALOG, 'utf8'));
		for (const f of raw.firms || []) {
			const c = String(f.crd || '').replace(/\D/g, '');
			if (c) firmCrds.add(c);
		}
	}
	const dbRows = db
		.prepare(
			`SELECT pi.normalized_value AS crd FROM profile_identifiers pi
       JOIN profiles p ON p.id = pi.profile_id
       WHERE pi.scheme = 'finra_crd' AND p.profile_type = 'firm'`,
		)
		.all();
	for (const r of dbRows) {
		const c = String(r.crd || '').replace(/\D/g, '');
		if (c) firmCrds.add(c);
	}

	const alreadyDone = await loadExistingIds(FIRM_DETAILS_JSONL, 'firmCrd');
	let pending = [...firmCrds].filter((c) => !alreadyDone.has(c));
	if (limitFirms > 0) pending = pending.slice(0, limitFirms);
	console.log(
		`[harvest:phase2-firms] Total firms=${firmCrds.size.toLocaleString()} | already=${alreadyDone.size.toLocaleString()} | pending=${pending.length.toLocaleString()} (concurrency=${concurrency})`,
	);

	if (pending.length === 0) return { fetched: 0, found: 0, locations: 0, owners: 0, milestones: 0 };

	const stream = fs.createWriteStream(FIRM_DETAILS_JSONL, { flags: 'a' });
	let done = 0;
	let foundCount = 0;
	let errCount = 0;
	let totalLocations = 0;
	let totalOwners = 0;
	let totalMilestones = 0;

	await runPool(
		pending,
		async (crd) => {
			const url = `${ORIGIN}/api/finra/merged/firm/${crd}`;
			const res = await readOnlyGetJson(url, 3, 25_000);
			const now = new Date().toISOString();
			if (res.ok && res.data) {
				const node =
					(res.data.finraNode && typeof res.data.finraNode === 'object'
						? res.data.finraNode
						: res.data.merged && typeof res.data.merged === 'object'
							? res.data.merged
							: res.data) || res.data;
				const found = res.data.found !== false && Boolean(node.basicInformation);
				stream.write(`${JSON.stringify({ firmCrd: crd, found, fetchedAt: now, sourceUrl: url, payload: found ? node : null })}\n`);
				if (found) {
					foundCount += 1;
					try {
						const ing = ingestFirmDetailPayloadIntoDb(crd, node, url, now);
						totalLocations += ing.locationsAdded;
						totalOwners += ing.ownersLinked;
						totalMilestones += ing.timelineAdded;
					} catch {
						/* continue */
					}
				}
			} else {
				errCount += 1;
			}
			done += 1;
			if (done % 250 === 0 || done === pending.length) {
				const sec = (Date.now() - t0) / 1000;
				console.log(
					`[harvest:phase2-firms] ${done.toLocaleString()}/${pending.length.toLocaleString()} (${(done / Math.max(0.1, sec)).toFixed(1)}/s, ${sec.toFixed(1)}s) | found=${foundCount.toLocaleString()} err=${errCount} | locs=${totalLocations.toLocaleString()} owners=${totalOwners.toLocaleString()} milestones=${totalMilestones.toLocaleString()}`,
				);
			}
		},
		concurrency,
	);

	await new Promise((r) => stream.end(r));
	return { fetched: done, found: foundCount, err: errCount, locations: totalLocations, owners: totalOwners, milestones: totalMilestones };
}

/**
 * Phase 3: Harvest all cached merged individual details (/api/finra/merged/individual/{crd}) & ingest into SQLite.
 */
async function harvestAllIndividualDetails(indList) {
	const t0 = Date.now();
	const alreadyDone = await loadExistingIds(IND_DETAILS_JSONL, 'crd');
	let pending = indList.map((x) => String(x.crd)).filter((c) => c && !alreadyDone.has(c));
	if (limitInds > 0) pending = pending.slice(0, limitInds);

	console.log(
		`[harvest:phase3-inds] Total discovered=${indList.length.toLocaleString()} | already=${alreadyDone.size.toLocaleString()} | pending=${pending.length.toLocaleString()} (concurrency=${concurrency})`,
	);
	if (pending.length === 0) return { fetched: 0, found: 0, links: 0, locations: 0 };

	const stream = fs.createWriteStream(IND_DETAILS_JSONL, { flags: 'a' });
	let done = 0;
	let foundCount = 0;
	let totalLinks = 0;
	let totalLocations = 0;

	await runPool(
		pending,
		async (crd) => {
			try {
				const res = await ingestIndividualFromVisualizer(crd);
				stream.write(
					`${JSON.stringify({
						crd,
						found: res.found,
						name: res.name,
						employmentsCount: res.employmentsCount,
						currentCount: res.currentCount,
						previousCount: res.previousCount,
						linksUpdated: res.linksUpdated,
						fetchedAt: new Date().toISOString(),
					})}\n`,
				);
				if (res.found) {
					foundCount += 1;
					totalLinks += res.linksUpdated;
					totalLocations += res.locationsAdded;
				}
			} catch {
				/* skip */
			}
			done += 1;
			if (done % 250 === 0 || done === pending.length) {
				const sec = (Date.now() - t0) / 1000;
				console.log(
					`[harvest:phase3-inds] ${done.toLocaleString()}/${pending.length.toLocaleString()} (${(done / Math.max(0.1, sec)).toFixed(1)}/s, ${sec.toFixed(1)}s) | found=${foundCount.toLocaleString()} links=${totalLinks.toLocaleString()} locs=${totalLocations.toLocaleString()}`,
				);
			}
		},
		concurrency,
	);

	await new Promise((r) => stream.end(r));
	return { fetched: done, found: foundCount, links: totalLinks, locations: totalLocations };
}

const tStart = Date.now();
const summary = { startedAt: new Date().toISOString(), source: ORIGIN };

if (!individualsOnly) {
	summary.firms = await harvestAllFirmDetails();
}
if (!firmsOnly) {
	let inds = [];
	if (fs.existsSync(INDS_CATALOG)) {
		const raw = JSON.parse(fs.readFileSync(INDS_CATALOG, 'utf8'));
		inds = Array.isArray(raw.individuals) ? raw.individuals : [];
		console.log(`[harvest] Loaded ${inds.length.toLocaleString()} cached individuals from ${INDS_CATALOG}`);
	} else {
		inds = await discoverCachedIndividuals();
	}
	summary.individuals = await harvestAllIndividualDetails(inds);
}

summary.finishedAt = new Date().toISOString();
summary.durationSec = Number(((Date.now() - tStart) / 1000).toFixed(1));
fs.writeFileSync(HARVEST_SUMMARY, JSON.stringify(summary, null, 2));
console.log('[harvest] COMPLETE:', JSON.stringify(summary, null, 2));
