#!/usr/bin/env node
/**
 * Populate and align the unified profiles SQLite store (.data/profiles/profiles.sqlite)
 * from all structured `.data/*` corpora + read-only knowledge.sqlite FTS5 cross-matching.
 *
 * Usage:
 *   pnpm profiles:backfill
 *   node scripts/profiles-backfill.mjs --no-align
 *   node scripts/profiles-backfill.mjs --align-only
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

const args = new Set(process.argv.slice(2));
const alignOnly = args.has('--align-only');
const noAlign = args.has('--no-align');
const noKnowledge = args.has('--no-knowledge');

const { runProfilesBackfill } = await import('../src/lib/research/profiles/backfill.ts');
const { runAlignmentPass } = await import('../src/lib/research/profiles/align.ts');
const { getProfileStats } = await import('../src/lib/research/profiles/store.ts');

if (alignOnly) {
	const report = runAlignmentPass({ includeKnowledgeCrossMatch: !noKnowledge });
	console.log('[profiles:align]', JSON.stringify(report, null, 2));
} else {
	const report = runProfilesBackfill({
		runAlignment: !noAlign,
		includeKnowledgeCrossMatch: !noKnowledge,
	});
	console.log('[profiles:backfill]', JSON.stringify(report, null, 2));
}

const stats = getProfileStats();
console.log('[profiles:stats]', JSON.stringify(stats, null, 2));
