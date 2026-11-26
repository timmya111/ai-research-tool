#!/usr/bin/env node
/**
 * Org corpus validation pass: cluster duplicates, optional auto-merge, report.
 *
 *   node scripts/org-validate-pass.mjs --dry-run --types medical_hospital,nonprofit
 *   node scripts/org-validate-pass.mjs --types medical_hospital,nonprofit --merge
 *   node scripts/org-validate-pass.mjs --wave 1 --dry-run
 *   node scripts/org-validate-pass.mjs --types firm --dry-run --limit-merges 50
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
function has(flag) {
	return argv.includes(flag);
}
function getArg(flag, fallback = null) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}

const WAVE_TYPES = {
	0: ['medical_hospital', 'nonprofit'],
	1: ['medical_hospital', 'nonprofit', 'education', 'government'],
	2: ['firm'],
	3: ['firm'],
};

const dryRun = has('--dry-run') || !has('--merge');
const doMerge = has('--merge');
const wave = getArg('--wave');
const typesArg = getArg('--types');
const limitMerges = Number(getArg('--limit-merges') || 0) || undefined;

let types;
if (typesArg) {
	types = typesArg.split(',').map((s) => s.trim()).filter(Boolean);
} else if (wave != null && WAVE_TYPES[wave]) {
	types = WAVE_TYPES[wave];
} else {
	types = WAVE_TYPES[1];
}

const { clusterOrgDuplicates, applyOrgMergePairs } = await import(
	'../src/lib/research/profiles/orgValidate.ts'
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.data', 'profiles', 'org-validate', stamp);
fs.mkdirSync(outDir, { recursive: true });

console.log(`[org-validate] types=${types.join(',')} dryRun=${!doMerge || dryRun} merge=${doMerge}`);

const report = clusterOrgDuplicates({ types });
const summary = {
	stamp,
	types,
	scanned: report.scanned,
	clusters: report.clusters,
	autoMerge: report.autoMergePairs.length,
	review: report.reviewPairs.length,
	blocked: report.blockedPairs.length,
	sampleAuto: report.autoMergePairs.slice(0, 25).map((p) => ({
		type: p.profileType,
		reason: p.reason,
		keep: p.keepName,
		merge: p.mergeName,
		confidence: p.confidence,
	})),
	sampleBlocked: report.blockedPairs.slice(0, 15).map((p) => ({
		type: p.profileType,
		reason: p.reason,
		block: p.blockReason,
		keep: p.keepName,
		merge: p.mergeName,
	})),
};

fs.writeFileSync(path.join(outDir, 'clusters.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log('[org-validate] summary', JSON.stringify(summary, null, 2));

let mergeResult = null;
if (doMerge) {
	mergeResult = applyOrgMergePairs(report.autoMergePairs, {
		dryRun: false,
		limit: limitMerges,
	});
	fs.writeFileSync(path.join(outDir, 'merge-result.json'), JSON.stringify(mergeResult, null, 2));
	console.log('[org-validate] merge', JSON.stringify(mergeResult, null, 2));
} else {
	const preview = applyOrgMergePairs(report.autoMergePairs, {
		dryRun: true,
		limit: limitMerges,
	});
	fs.writeFileSync(path.join(outDir, 'merge-preview.json'), JSON.stringify(preview, null, 2));
	console.log('[org-validate] merge-preview (dry)', JSON.stringify(preview, null, 2));
}

console.log(`[org-validate] wrote ${outDir}`);
