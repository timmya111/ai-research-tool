#!/usr/bin/env node
/**
 * Download BrokerCheck / FINRA-visualizer reports for every profile with a CRD
 * and apply relevant fields into Profiles.
 *
 * BrokerCheck PDF CDN (files.brokercheck.finra.org) returns 403 Access Denied.
 * This script persists JSON reports (same content the PDF summarizes) under
 *   .data/finra-visualizer/cache/firm_details/{crd}.json
 *   .data/finra-visualizer/cache/individuals/{crd}.json
 * and mirrors a copy under
 *   .data/brokercheck-reports/{firm|individual}/{crd}.json
 * Then ingests addresses, firm type/scope, aliases, owners, employment, exams,
 * disclosures metadata, and approval dates into profiles.sqlite.
 *
 * ADV PDFs from reports.adviserinfo.sec.gov are attempted when linked; many
 * currently 403 — failures are logged without stopping the batch.
 *
 * Usage:
 *   node scripts/backfill-crd-brokercheck-reports.mjs --type firm
 *   node scripts/backfill-crd-brokercheck-reports.mjs --type person --limit 5000
 *   node scripts/backfill-crd-brokercheck-reports.mjs --type all --concurrency 6
 *   node scripts/backfill-crd-brokercheck-reports.mjs --type firm --apply-cached-only
 *   node scripts/backfill-crd-brokercheck-reports.mjs --type person --offset 10000 --limit 10000
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { getProfilesDb } = await import('../src/lib/research/profiles/db.ts');
const {
	ingestFirmDetailsFromVisualizer,
	ingestIndividualFromVisualizer,
	ingestFirmDetailPayloadIntoDb,
} = await import('../src/lib/research/finraVisualizerMirror.ts');

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
function getArgStr(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return String(argv[i + 1] || fallback);
}

const typeArg = getArgStr('--type', 'all'); // firm | person | all
const limit = getArgNum('--limit', 0);
const offset = getArgNum('--offset', 0);
const concurrency = Math.min(12, Math.max(1, getArgNum('--concurrency', 5)));
const forceRefresh = argv.includes('--force');
const applyCachedOnly = argv.includes('--apply-cached-only');
const skipExistingReport = !argv.includes('--force') && !argv.includes('--redownload');
const tryAdvPdf = !argv.includes('--no-adv');

const FIRM_CACHE = path.join(ROOT, '.data/finra-visualizer/cache/firm_details');
const IND_CACHE = path.join(ROOT, '.data/finra-visualizer/cache/individuals');
const REPORT_FIRM = path.join(ROOT, '.data/brokercheck-reports/firm');
const REPORT_IND = path.join(ROOT, '.data/brokercheck-reports/individual');
const ADV_DIR = path.join(ROOT, '.data/brokercheck-reports/adv-pdf');
const PROGRESS = path.join(
	ROOT,
	`.data/monitors/crd-brokercheck-reports-${typeArg === 'all' ? 'all' : typeArg}.json`,
);

for (const d of [FIRM_CACHE, IND_CACHE, REPORT_FIRM, REPORT_IND, ADV_DIR, path.dirname(PROGRESS)]) {
	fs.mkdirSync(d, { recursive: true });
}

const db = getProfilesDb();

function loadQueue(profileType) {
	const rows = db
		.prepare(
			`
SELECT p.id AS profile_id, p.slug, p.name, pi.value AS crd
FROM profiles p
JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
WHERE p.profile_type = ?
  AND CAST(pi.value AS INTEGER) BETWEEN 1 AND 9999999
ORDER BY CAST(pi.value AS INTEGER) ASC
`,
		)
		.all(profileType);
	return rows
		.map((r) => ({
			profileId: String(r.profile_id),
			slug: String(r.slug),
			name: String(r.name),
			crd: String(r.crd).replace(/\D/g, ''),
			profileType,
		}))
		.filter((r) => r.crd);
}

function mirrorReport(kind, crd, cachePath) {
	const destDir = kind === 'firm' ? REPORT_FIRM : REPORT_IND;
	const dest = path.join(destDir, `${crd}.json`);
	try {
		if (fs.existsSync(cachePath)) {
			fs.copyFileSync(cachePath, dest);
			return dest;
		}
	} catch {
		/* ignore */
	}
	return null;
}

async function tryDownloadAdvPdfs(payload, crd) {
	if (!tryAdvPdf || !payload || typeof payload !== 'object') return { tried: 0, saved: 0 };
	const links = Array.isArray(payload.secDocumentLinks) ? payload.secDocumentLinks : [];
	const pdfHrefs = links
		.map((l) => String(l?.href || ''))
		.filter((h) => /\.pdf(?:$|\?)/i.test(h));
	let saved = 0;
	for (const href of pdfHrefs.slice(0, 3)) {
		try {
			const res = await fetch(href, {
				headers: {
					'User-Agent':
						'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
					Accept: 'application/pdf,*/*',
					Referer: 'https://adviserinfo.sec.gov/',
				},
			});
			const buf = Buffer.from(await res.arrayBuffer());
			if (!res.ok || buf.length < 500 || buf.slice(0, 4).toString() !== '%PDF') continue;
			const base = path.basename(new URL(href).pathname) || `${crd}.pdf`;
			const out = path.join(ADV_DIR, `${crd}_${base}`);
			fs.writeFileSync(out, buf);
			saved += 1;
		} catch {
			/* ignore */
		}
	}
	return { tried: pdfHrefs.length, saved };
}

const stats = {
	type: typeArg,
	processed: 0,
	found: 0,
	notFound: 0,
	errors: 0,
	fromCache: 0,
	mirrored: 0,
	advSaved: 0,
	locationsAdded: 0,
	aliasesAdded: 0,
	ownersLinked: 0,
	employments: 0,
	linksUpdated: 0,
};

function writeProgress(extra = {}) {
	const snap = {
		...stats,
		...extra,
		updatedAt: new Date().toISOString(),
	};
	fs.writeFileSync(PROGRESS, JSON.stringify(snap, null, 2));
	if (stats.processed % 50 === 0 || extra.done) {
		console.log(JSON.stringify(snap));
	}
}

async function processFirm(item) {
	const cachePath = path.join(FIRM_CACHE, `${item.crd}.json`);
	const reportPath = path.join(REPORT_FIRM, `${item.crd}.json`);
	try {
		if (applyCachedOnly) {
			if (!fs.existsSync(cachePath)) {
				stats.notFound += 1;
				stats.processed += 1;
				return;
			}
			const snap = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
			if (!snap?.found || !snap?.payload) {
				stats.notFound += 1;
				stats.processed += 1;
				return;
			}
			const res = ingestFirmDetailPayloadIntoDb(
				item.crd,
				snap.payload,
				snap.sourceUrl || `cache:${item.crd}`,
				snap.fetchedAt || new Date().toISOString(),
				item.profileId,
			);
			mirrorReport('firm', item.crd, cachePath);
			stats.found += 1;
			stats.fromCache += 1;
			stats.mirrored += 1;
			stats.locationsAdded += res.locationsAdded || 0;
			stats.aliasesAdded += res.aliasesAdded || 0;
			stats.ownersLinked += res.ownersLinked || 0;
			const adv = await tryDownloadAdvPdfs(snap.payload, item.crd);
			stats.advSaved += adv.saved;
			stats.processed += 1;
			return;
		}

		if (skipExistingReport && fs.existsSync(reportPath) && fs.existsSync(cachePath) && !forceRefresh) {
			// Still ensure ingest once if metadata thin — call ingest from cache
			const snap = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
			if (snap?.found && snap?.payload) {
				const res = ingestFirmDetailPayloadIntoDb(
					item.crd,
					snap.payload,
					snap.sourceUrl || `cache:${item.crd}`,
					snap.fetchedAt || new Date().toISOString(),
					item.profileId,
				);
				stats.found += 1;
				stats.fromCache += 1;
				stats.locationsAdded += res.locationsAdded || 0;
				stats.aliasesAdded += res.aliasesAdded || 0;
				stats.ownersLinked += res.ownersLinked || 0;
			} else {
				stats.notFound += 1;
			}
			stats.processed += 1;
			return;
		}

		const res = await ingestFirmDetailsFromVisualizer(item.crd, {
			forceRefresh,
			profileIdOverride: item.profileId,
		});
		stats.processed += 1;
		if (!res.found) {
			stats.notFound += 1;
			return;
		}
		stats.found += 1;
		if (res.fromCache) stats.fromCache += 1;
		stats.locationsAdded += res.locationsAdded || 0;
		stats.aliasesAdded += res.aliasesAdded || 0;
		stats.ownersLinked += res.ownersLinked || 0;
		if (mirrorReport('firm', item.crd, cachePath)) stats.mirrored += 1;
		if (fs.existsSync(cachePath)) {
			try {
				const snap = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
				const adv = await tryDownloadAdvPdfs(snap.payload, item.crd);
				stats.advSaved += adv.saved;
			} catch {
				/* ignore */
			}
		}
	} catch (err) {
		stats.errors += 1;
		stats.processed += 1;
		console.error(`ERR firm ${item.slug} CRD#${item.crd}:`, err instanceof Error ? err.message : err);
	}
}

async function processPerson(item) {
	const cachePath = path.join(IND_CACHE, `${item.crd}.json`);
	const reportPath = path.join(REPORT_IND, `${item.crd}.json`);
	try {
		if (applyCachedOnly) {
			if (!fs.existsSync(cachePath)) {
				stats.notFound += 1;
				stats.processed += 1;
				return;
			}
			const res = await ingestIndividualFromVisualizer(item.crd, {
				forceRefresh: false,
				profileIdOverride: item.profileId,
			});
			mirrorReport('individual', item.crd, cachePath);
			if (res.found) {
				stats.found += 1;
				stats.fromCache += 1;
				stats.employments += res.employmentsCount || 0;
				stats.linksUpdated += res.linksUpdated || 0;
				stats.locationsAdded += res.locationsAdded || 0;
				stats.mirrored += 1;
			} else stats.notFound += 1;
			stats.processed += 1;
			return;
		}

		if (skipExistingReport && fs.existsSync(reportPath) && fs.existsSync(cachePath) && !forceRefresh) {
			const res = await ingestIndividualFromVisualizer(item.crd, {
				forceRefresh: false,
				profileIdOverride: item.profileId,
			});
			if (res.found) {
				stats.found += 1;
				stats.fromCache += 1;
				stats.employments += res.employmentsCount || 0;
				stats.linksUpdated += res.linksUpdated || 0;
				stats.locationsAdded += res.locationsAdded || 0;
			} else stats.notFound += 1;
			stats.processed += 1;
			return;
		}

		const res = await ingestIndividualFromVisualizer(item.crd, {
			forceRefresh,
			profileIdOverride: item.profileId,
		});
		stats.processed += 1;
		if (!res.found) {
			stats.notFound += 1;
			return;
		}
		stats.found += 1;
		if (res.fromCache) stats.fromCache += 1;
		stats.employments += res.employmentsCount || 0;
		stats.linksUpdated += res.linksUpdated || 0;
		stats.locationsAdded += res.locationsAdded || 0;
		if (mirrorReport('individual', item.crd, cachePath)) stats.mirrored += 1;
	} catch (err) {
		stats.errors += 1;
		stats.processed += 1;
		console.error(`ERR person ${item.slug} CRD#${item.crd}:`, err instanceof Error ? err.message : err);
	}
}

let queue = [];
if (typeArg === 'firm' || typeArg === 'all') {
	queue = queue.concat(loadQueue('firm'));
}
if (typeArg === 'person' || typeArg === 'all') {
	queue = queue.concat(loadQueue('person'));
}
if (offset > 0) queue = queue.slice(offset);
if (limit > 0) queue = queue.slice(0, limit);

console.log(
	JSON.stringify(
		{
			queue: queue.length,
			type: typeArg,
			offset,
			limit: limit || null,
			concurrency,
			forceRefresh,
			applyCachedOnly,
			skipExistingReport,
			tryAdvPdf,
			sample: queue.slice(0, 5).map((q) => ({ type: q.profileType, slug: q.slug, crd: q.crd })),
		},
		null,
		2,
	),
);

stats.remaining = queue.length;
writeProgress({ phase: 'start', remaining: queue.length });

let idx = 0;
async function worker() {
	while (idx < queue.length) {
		const i = idx++;
		const item = queue[i];
		if (item.profileType === 'firm') await processFirm(item);
		else await processPerson(item);
		if (stats.processed % 25 === 0 || stats.processed === queue.length) {
			writeProgress({ remaining: queue.length - stats.processed });
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
writeProgress({ remaining: 0, done: true });
console.log(JSON.stringify({ done: true, ...stats, progressPath: PROGRESS }, null, 2));
