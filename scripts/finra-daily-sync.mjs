#!/usr/bin/env node
/**
 * Once-a-day READ-ONLY change check against https://finra-sec-data-visualizer-canvas.vercel.app.
 * Keeps all fetched snapshots local under .data/finra-visualizer/cache/ and only updates
 * .data/profiles/profiles.sqlite + .data/finra-visualizer/change_log.jsonl when changes occur.
 *
 * Usage:
 *   node scripts/finra-daily-sync.mjs                      # once-per-24h daily diff check
 *   node scripts/finra-daily-sync.mjs --force              # force check regardless of 24h TTL
 *   node scripts/finra-daily-sync.mjs --individual 2204732 # ingest/check one individual CRD
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

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const indIdx = argv.indexOf('--individual');
const individualCrd = indIdx !== -1 && indIdx + 1 < argv.length ? argv[indIdx + 1] : null;

const { ingestIndividualFromVisualizer, runDailyFinraChangeCheck } = await import(
	'../src/lib/research/finraVisualizerMirror.ts'
);

if (individualCrd) {
	const res = await ingestIndividualFromVisualizer(individualCrd, { forceRefresh: force });
	console.log('[finra:daily-sync] individual:', JSON.stringify(res, null, 2));
	process.exit(0);
}

const report = await runDailyFinraChangeCheck({ force });
console.log('[finra:daily-sync] report:', JSON.stringify(report, null, 2));
