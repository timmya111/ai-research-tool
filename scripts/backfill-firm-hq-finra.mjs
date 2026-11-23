#!/usr/bin/env node
/**
 * Backfill firm street HQs from FINRA visualizer merged firm details.
 * Targets firm profiles that lack a digit-bearing location and have a finra_crd.
 *
 * Usage:
 *   node scripts/backfill-firm-hq-finra.mjs                  # all missing-street CRD firms
 *   node scripts/backfill-firm-hq-finra.mjs --active-only    # ACTIVE BC/IA first
 *   node scripts/backfill-firm-hq-finra.mjs --limit 200
 *   node scripts/backfill-firm-hq-finra.mjs --concurrency 6
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

const { getProfilesDb } = await import('../src/lib/research/profiles/db.ts');
const { ingestFirmDetailsFromVisualizer } = await import(
	'../src/lib/research/finraVisualizerMirror.ts'
);

const argv = process.argv.slice(2);
function getArgNum(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const activeOnly = argv.includes('--active-only');
const limit = getArgNum('--limit', 0);
const concurrency = Math.min(12, Math.max(1, getArgNum('--concurrency', 6)));

const db = getProfilesDb();
const rows = db
	.prepare(
		`
SELECT p.id AS profile_id, p.slug, p.name, pi.value AS crd,
       json_extract(p.metadata_json,'$.finraBcScope') AS bc_scope,
       json_extract(p.metadata_json,'$.finraIaScope') AS ia_scope
FROM profiles p
JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
WHERE p.profile_type = 'firm'
  AND NOT EXISTS (
    SELECT 1 FROM profile_locations pl
    WHERE pl.profile_id = p.id AND pl.raw GLOB '*[0-9]*'
  )
ORDER BY
  CASE
    WHEN json_extract(p.metadata_json,'$.finraBcScope') = 'ACTIVE'
      OR json_extract(p.metadata_json,'$.finraIaScope') = 'ACTIVE' THEN 0
    ELSE 1
  END,
  p.name ASC
`,
	)
	.all();

let queue = rows.map((r) => ({
	profileId: String(r.profile_id),
	slug: String(r.slug),
	name: String(r.name),
	crd: String(r.crd).replace(/\D/g, ''),
	bcScope: r.bc_scope != null ? String(r.bc_scope) : null,
	iaScope: r.ia_scope != null ? String(r.ia_scope) : null,
})).filter((r) => r.crd);

if (activeOnly) {
	queue = queue.filter((r) => r.bcScope === 'ACTIVE' || r.iaScope === 'ACTIVE');
}
if (limit > 0) queue = queue.slice(0, limit);

console.log(
	JSON.stringify(
		{
			candidates: queue.length,
			activeOnly,
			limit: limit || null,
			concurrency,
			sample: queue.slice(0, 5).map((q) => ({ slug: q.slug, crd: q.crd, bc: q.bcScope })),
		},
		null,
		2,
	),
);

const stats = {
	processed: 0,
	withStreet: 0,
	noAddress: 0,
	notFound: 0,
	errors: 0,
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
		if (res.locationsAdded > 0) {
			stats.withStreet += 1;
			if (stats.withStreet <= 20 || stats.withStreet % 50 === 0) {
				console.log(
					`+ street ${item.slug} CRD#${item.crd} locations+=${res.locationsAdded}`,
				);
			}
		} else {
			stats.noAddress += 1;
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
		if (stats.processed % 25 === 0) {
			console.log(JSON.stringify({ ...stats, remaining: queue.length - stats.processed }));
		}
	}
}

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.all(workers);

const stillMissing = db
	.prepare(
		`
SELECT COUNT(*) AS c FROM profiles p
WHERE p.profile_type = 'firm'
AND NOT EXISTS (
  SELECT 1 FROM profile_locations pl
  WHERE pl.profile_id = p.id AND pl.raw GLOB '*[0-9]*'
)
`,
	)
	.get();

console.log(
	JSON.stringify(
		{
			done: true,
			...stats,
			firmsStillMissingStreet: stillMissing?.c ?? null,
		},
		null,
		2,
	),
);
