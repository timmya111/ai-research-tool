#!/usr/bin/env node
/**
 * Fast, resumable batch ingestion of CFPB complaints, GovInfo USCOURTS federal court PDFs,
 * and OSCN Oklahoma dockets across ALL firms in profiles.sqlite.
 *
 * Uses CFPB's 6,500-company dictionary to filter ALL 30,798+ firms in memory in <1 second,
 * then fetches full complaint records + state/issue aggregations with polite concurrency
 * ONLY for firms that actually have CFPB records (zero wasted calls!).
 *
 * Usage:
 *   node scripts/batch-ingest-legal-docs.mjs --scope=all-firms --concurrency=6
 *   node scripts/batch-ingest-legal-docs.mjs --scope=lbn --max-docs=4
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

const {
	ingestLegalDocsForProfile,
	loadCachedLegalDocsManifest,
	matchProfileToCfpbCompanies,
} = await import('@/lib/research/legalDocsPipeline');

const argv = process.argv.slice(2);
const argVal = (prefix) => {
	const hit = argv.find((a) => a.startsWith(prefix));
	return hit ? hit.slice(prefix.length).trim() : '';
};

const scope = argVal('--scope=') || 'all-firms';
const concurrency = Math.max(1, Math.min(8, Number(argVal('--concurrency=') || 5)));
const maxDocsPerSource = Math.max(1, Number(argVal('--max-docs=') || 4));
const force = argv.includes('--force');
const includeOscn = !argv.includes('--no-oscn');

const db = new DatabaseSync(path.join(ROOT, '.data', 'profiles', 'profiles.sqlite'), { readOnly: true });

// Load aliases for firms in one fast query
const aliasByPid = new Map();
for (const r of db
	.prepare(
		`SELECT pa.profile_id, pa.alias
     FROM profile_aliases pa
     JOIN profiles p ON p.id = pa.profile_id
     WHERE p.profile_type = 'firm'
       AND p.status NOT IN ('archived','merged')
       AND pa.alias_kind != 'slug'`,
	)
	.all()) {
	let arr = aliasByPid.get(r.profile_id);
	if (!arr) {
		arr = [];
		aliasByPid.set(r.profile_id, arr);
	}
	arr.push(r.alias);
}

const allFirms = db
	.prepare(
		`SELECT p.id, p.slug, p.name, p.profile_type, p.status,
            EXISTS(SELECT 1 FROM profile_locations pl WHERE pl.profile_id = p.id AND (upper(coalesce(pl.state,'')) = 'OK' OR lower(pl.raw) LIKE '%oklahoma%')) AS in_ok
     FROM profiles p
     WHERE p.profile_type = 'firm'
       AND p.status NOT IN ('archived','merged')
     ORDER BY CASE p.status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, p.updated_at DESC`,
	)
	.all();
db.close();

// Step 1: Match ALL firms in memory against CFPB's 6,500-company dictionary (1 HTTP request total!)
const matchedFirms = [];
for (const f of allFirms) {
	const aliases = aliasByPid.get(f.id) || [];
	const hits = await matchProfileToCfpbCompanies(f.name, aliases);
	if (hits.length > 0) {
		matchedFirms.push({ ...f, cfpbHits: hits });
	}
}

console.error(
	`Scanned ${allFirms.length.toLocaleString()} total firm profiles -> ${matchedFirms.length.toLocaleString()} matched CFPB companies!`,
);

let processed = 0;
let skippedCached = 0;
let totalDocs = 0;
let totalComplaintsSum = 0;
const topFirms = [];
let idx = 0;

async function worker() {
	while (true) {
		const cur = idx++;
		if (cur >= matchedFirms.length) break;
		const f = matchedFirms[cur];
		if (!force) {
			const cached = loadCachedLegalDocsManifest(f.slug);
			if (cached && cached.cfpbSummary && cached.cfpbSummary.totalMatching > 0) {
				skippedCached += 1;
				totalComplaintsSum += cached.cfpbSummary.totalMatching;
				continue;
			}
		}
		try {
			const sources = includeOscn && f.in_ok ? ['cfpb', 'oscn'] : ['cfpb'];
			const report = await ingestLegalDocsForProfile(f.slug, {
				sources,
				states: ['OK', 'TX'],
				oscnCounties: ['oklahoma', 'tulsa'],
				maxDocsPerSource,
				downloadPdfs: true,
				syncToProfile: true,
				touchProfile: false,
			});
			processed += 1;
			const cfpbTotal = report.cfpbSummary?.totalMatching || 0;
			if (cfpbTotal > 0) {
				totalDocs += report.documents.length;
				totalComplaintsSum += cfpbTotal;
				topFirms.push({
					slug: f.slug,
					name: f.name,
					status: f.status,
					cfpb: cfpbTotal,
					docs: report.documents.length,
				});
			}
		} catch (e) {
			console.error(`ERR ${f.slug}:`, e instanceof Error ? e.message : String(e));
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

topFirms.sort((a, b) => b.cfpb - a.cfpb);

console.log(
	JSON.stringify(
		{
			ok: true,
			scope,
			totalFirmsScanned: allFirms.length,
			firmsMatchedInCfpb: matchedFirms.length,
			newlyProcessed: processed,
			alreadyCached: skippedCached,
			docsWritten: totalDocs,
			totalComplaintsCovered: totalComplaintsSum,
			top25FirmsByCfpbComplaints: topFirms.slice(0, 25),
		},
		null,
		2,
	),
);
