#!/usr/bin/env node
/**
 * Research and enrich captured entity profiles (people, firms, education, nonprofits,
 * hospitals, government, historic events) using local offline Wikipedia
 * (kiwix-serve), FINRA BrokerCheck (by CRD), local knowledge.sqlite (county deeds /
 * Research Drive), and Bryan County UCC filings.
 *
 * STRICT IDENTITY GUARD:
 * - Auto-merges details ONLY when validated by exact identifier OR (exact/fuzzy/initials
 *   name match + corroborating address/geo, firm/employer, military base, or institution).
 * - Name-only matches with NO corroborating second factor are NEVER merged — they are
 *   logged as `possible_match_name_only` notes for manual validation.
 *
 * Usage:
 *   pnpm profiles:enrich
 *   node scripts/profiles-enrich.mjs --limit 50 --pinned-only
 *   node scripts/profiles-enrich.mjs --profile person:alex-karp
 *   node scripts/profiles-enrich.mjs --type person --limit 40 --brokercheck
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
function getArgValue(flag) {
	const idx = argv.indexOf(flag);
	if (idx === -1 || idx + 1 >= argv.length) return null;
	return argv[idx + 1];
}

const singleProfile = getArgValue('--profile');
const limit = Number(getArgValue('--limit') || 40);
const profileType = getArgValue('--type') || 'all';
const pinnedOnly = argv.includes('--pinned-only');
const onlyMissing = argv.includes('--only-missing');
const includeBrokercheck = argv.includes('--brokercheck');
const noWikipedia = argv.includes('--no-wikipedia');
const noKnowledge = argv.includes('--no-knowledge');

const { enrichProfile, enrichBatchProfiles } = await import('../src/lib/research/profiles/enrich.ts');

if (singleProfile) {
	const report = await enrichProfile(singleProfile, {
		includeWikipedia: !noWikipedia,
		includeBrokercheck: true,
		includeKnowledge: !noKnowledge,
		includeBryanUcc: true,
	});
	console.log('[profiles:enrich:single]', JSON.stringify(report, null, 2));
} else {
	const report = await enrichBatchProfiles({
		limit,
		profileType,
		pinnedOnly,
		onlyMissingSummaryOrDetails: onlyMissing,
		includeWikipedia: !noWikipedia,
		includeBrokercheck,
		includeKnowledge: !noKnowledge,
		includeBryanUcc: true,
	});
	console.log('[profiles:enrich:batch]', JSON.stringify(report, null, 2));
}
