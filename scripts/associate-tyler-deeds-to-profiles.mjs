#!/usr/bin/env node
/**
 * Associate Tyler index JSONL (grantor/grantee) to profiles by exact name match.
 *
 *   node scripts/associate-tyler-deeds-to-profiles.mjs --dir rockwall-deeds --county "Rockwall County"
 *   node scripts/associate-tyler-deeds-to-profiles.mjs --dir rockwall-deeds --county "Rockwall County" --dry-run --limit 5000
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

const argv = process.argv.slice(2);
function arg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}

const dryRun = argv.includes('--dry-run');
const dirArg = String(arg('--dir', 'rockwall-deeds') || 'rockwall-deeds').trim();
const county = String(arg('--county', 'Rockwall County') || 'Rockwall County').trim();
const limitRaw = arg('--limit');
const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : undefined;
const deedsDir = path.isAbsolute(dirArg) ? dirArg : path.join(ROOT, '.data', dirArg);

const { associateTylerJsonlToProfiles } = await import(
	'../src/lib/research/profiles/associateDeeds.ts'
);

console.log(
	JSON.stringify({ dryRun, deedsDir, county, limit: limit ?? 'all' }),
);

const report = associateTylerJsonlToProfiles({
	deedsDir,
	countyLabel: county,
	limit,
	dryRun,
});

console.log(JSON.stringify(report, null, 2));
