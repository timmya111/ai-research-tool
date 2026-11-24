#!/usr/bin/env node
/**
 * Enrich CRD firm profiles from FINRA visualizer merged firm details:
 * firmType / BC+IA scope, approval date, SEC BD/IA file numbers, other names,
 * disclosures, registered states/SROs, and a richer summary when the current
 * one is thin.
 *
 * Default queue: CRD firms missing metadata.finraFirmType (never detail-synced).
 *
 * Usage:
 *   node scripts/backfill-crd-firm-finra-details.mjs
 *   node scripts/backfill-crd-firm-finra-details.mjs --limit 500 --concurrency 4
 *   node scripts/backfill-crd-firm-finra-details.mjs --active-only --limit 1000
 *   node scripts/backfill-crd-firm-finra-details.mjs --offset 500 --limit 500
 *   node scripts/backfill-crd-firm-finra-details.mjs --force   # re-sync even if finraFirmType set
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
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
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
const { ingestFirmDetailsFromVisualizer } = await import(
	'../src/lib/research/finraVisualizerMirror.ts'
);

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const activeOnly = argv.includes('--active-only');
const force = argv.includes('--force');
const limit = getArgNum('--limit', 0);
const offset = getArgNum('--offset', 0);
const concurrency = Math.min(12, Math.max(1, getArgNum('--concurrency', 4)));

const db = getProfilesDb();
const rows = db
	.prepare(
		`
SELECT p.id AS profile_id, p.slug, p.name, pi.value AS crd,
       length(COALESCE(p.summary,'')) AS summary_len,
       json_extract(p.metadata_json,'$.finraFirmType') AS firm_type,
       json_extract(p.metadata_json,'$.finraBcScope') AS bc_scope,
       json_extract(p.metadata_json,'$.finraIaScope') AS ia_scope,
       json_extract(p.metadata_json,'$.finraLastSyncedAt') AS last_synced
FROM profiles p
JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
WHERE p.profile_type = 'firm'
  AND (
    ? = 1
    OR json_extract(p.metadata_json,'$.finraFirmType') IS NULL
    OR length(COALESCE(p.summary,'')) < 80
  )
ORDER BY
  CASE
    WHEN json_extract(p.metadata_json,'$.finraBcScope') = 'ACTIVE'
      OR json_extract(p.metadata_json,'$.finraIaScope') = 'ACTIVE' THEN 0
    ELSE 1
  END,
  length(COALESCE(p.summary,'')) ASC,
  p.name ASC
`,
	)
	.all(force ? 1 : 0);

let queue = rows
	.map((r) => ({
		profileId: String(r.profile_id),
		slug: String(r.slug),
		name: String(r.name),
		crd: String(r.crd).replace(/\D/g, ''),
		summaryLen: Number(r.summary_len) || 0,
		firmType: r.firm_type != null ? String(r.firm_type) : null,
		bcScope: r.bc_scope != null ? String(r.bc_scope) : null,
		iaScope: r.ia_scope != null ? String(r.ia_scope) : null,
	}))
	.filter((r) => r.crd);

if (activeOnly) {
	queue = queue.filter((r) => r.bcScope === 'ACTIVE' || r.iaScope === 'ACTIVE');
}
if (offset > 0) queue = queue.slice(offset);
if (limit > 0) queue = queue.slice(0, limit);

const progressPath = path.join(ROOT, '.data', 'monitors', 'crd-firm-finra-details-progress.json');
fs.mkdirSync(path.dirname(progressPath), { recursive: true });

console.log(
	JSON.stringify(
		{
			candidates: queue.length,
			totalMatchedBeforeSlice: rows.length,
			activeOnly,
			force,
			offset,
			limit: limit || null,
			concurrency,
			sample: queue.slice(0, 5).map((q) => ({
				slug: q.slug,
				crd: q.crd,
				summaryLen: q.summaryLen,
				firmType: q.firmType,
			})),
		},
		null,
		2,
	),
);

const stats = {
	processed: 0,
	found: 0,
	notFound: 0,
	errors: 0,
	locationsAdded: 0,
	aliasesAdded: 0,
	ownersLinked: 0,
	timelineAdded: 0,
};

async function processOne(item) {
	try {
		const res = await ingestFirmDetailsFromVisualizer(item.crd, {
			forceRefresh: true,
			profileIdOverride: item.profileId,
		});
		stats.processed += 1;
		if (!res.found) {
			stats.notFound += 1;
			return;
		}
		stats.found += 1;
		stats.locationsAdded += res.locationsAdded || 0;
		stats.aliasesAdded += res.aliasesAdded || 0;
		stats.ownersLinked += res.ownersLinked || 0;
		stats.timelineAdded += res.timelineAdded || 0;
		if (stats.found <= 15 || stats.found % 50 === 0) {
			console.log(
				`OK ${item.slug} CRD#${item.crd} loc+=${res.locationsAdded} alias+=${res.aliasesAdded} owners+=${res.ownersLinked}`,
			);
		}
	} catch (err) {
		stats.errors += 1;
		console.error(`ERR ${item.slug} CRD#${item.crd}:`, err instanceof Error ? err.message : err);
	}
}

let idx = 0;
async function worker() {
	while (idx < queue.length) {
		const i = idx++;
		await processOne(queue[i]);
		if (stats.processed % 25 === 0 || stats.processed === queue.length) {
			const snap = {
				...stats,
				remaining: queue.length - stats.processed,
				updatedAt: new Date().toISOString(),
			};
			console.log(JSON.stringify(snap));
			try {
				fs.writeFileSync(progressPath, JSON.stringify(snap, null, 2));
			} catch {
				/* ignore */
			}
		}
	}
}

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.all(workers);

const after = db
	.prepare(
		`
SELECT
  COUNT(*) AS crd_firms,
  SUM(CASE WHEN json_extract(metadata_json,'$.finraFirmType') IS NOT NULL THEN 1 ELSE 0 END) AS with_firm_type,
  SUM(CASE WHEN length(COALESCE(summary,'')) >= 80 THEN 1 ELSE 0 END) AS summary_80plus
FROM profiles p
WHERE profile_type='firm'
  AND EXISTS (SELECT 1 FROM profile_identifiers i WHERE i.profile_id=p.id AND i.scheme='finra_crd')
`,
	)
	.get();

const final = { ...stats, after, progressPath };
console.log(JSON.stringify(final, null, 2));
fs.writeFileSync(progressPath, JSON.stringify({ ...final, done: true, updatedAt: new Date().toISOString() }, null, 2));
