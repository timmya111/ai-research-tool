#!/usr/bin/env node
/**
 * Resumable backfill of FINRA BrokerCheck & SEC IAPD employment start/end dates
 * for connected firm individuals in .data/profiles/profiles.sqlite.
 *
 * Usage:
 *   node scripts/finra-backfill-employment-dates.mjs --firm 288811        # single firm CRD
 *   node scripts/finra-backfill-employment-dates.mjs --limit 5000         # first N undated people
 *   node scripts/finra-backfill-employment-dates.mjs --concurrency 24     # full resumable sweep
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

const argv = process.argv.slice(2);
function getArgStr(flag) {
	const i = argv.indexOf(flag);
	return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}
function getArgNum(flag, fallback) {
	const raw = getArgStr(flag);
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const firmArg = getArgStr('--firm');
const limitArg = getArgNum('--limit', 0);
const concurrency = Math.min(8, Math.max(1, getArgNum('--concurrency', 3)));
const paceMs = getArgNum('--pace-ms', 350);
const CACHE_JSONL = path.join(ROOT, '.data', 'finra-visualizer', 'individual_employments.jsonl');
fs.mkdirSync(path.dirname(CACHE_JSONL), { recursive: true });

const { getProfilesDb, withProfilesTransaction } = await import('../src/lib/research/profiles/db.ts');
const { fetchIndividualEmploymentDatesDetailed, hydrateFirmConnectionDates } = await import(
	'../src/lib/research/finraEmploymentDates.ts'
);

if (firmArg) {
	const db = getProfilesDb();
	const firmCrd = firmArg.replace(/\D/g, '');
	const row = db
		.prepare(
			`SELECT p.id, p.name FROM profiles p
       JOIN profile_identifiers pi ON pi.profile_id = p.id
       WHERE p.profile_type = 'firm' AND pi.scheme = 'finra_crd' AND pi.normalized_value = ?
       LIMIT 1`,
		)
		.get(firmCrd);
	if (!row) {
		console.error(`Firm CRD ${firmCrd} not found in profiles.sqlite`);
		process.exit(1);
	}
	console.log(`[finra-dates] Hydrating firm ${row.name} (CRD# ${firmCrd}) with rate-limit pacing...`);
	let totalUpdated = 0;
	let round = 0;
	let prevRemaining = null;
	while (true) {
		round += 1;
		const res = await hydrateFirmConnectionDates(String(row.id), {
			maxPeople: limitArg || 150,
			concurrency,
		});
		totalUpdated += res?.linksUpdated || 0;
		console.log(`[finra-dates] Round ${round}:`, JSON.stringify(res));
		if (!res || res.remainingUndated === 0 || (limitArg > 0 && round >= 1)) break;
		// No recoverable dates this round — stop rather than spin forever on the same people
		if ((res.peopleWithDates || 0) === 0 && (res.peopleChecked || 0) > 0 && !res.rateLimited) {
			console.log('[finra-dates] No new dates this round; stopping with remainingUndated=' + res.remainingUndated);
			break;
		}
		// Remaining count not dropping (e.g. cross-firm updates only) — stop
		if (prevRemaining != null && res.remainingUndated >= prevRemaining && !res.rateLimited) {
			console.log('[finra-dates] remainingUndated not decreasing (' + res.remainingUndated + '); stopping');
			break;
		}
		prevRemaining = res.remainingUndated;
		if (res.rateLimited) {
			console.log('[finra-dates] Hit FINRA/SEC rate limit — cooling down 65s...');
			await new Promise((r) => setTimeout(r, 65_000));
		} else {
			await new Promise((r) => setTimeout(r, 5_000));
		}
	}
	console.log(`[finra-dates] DONE for ${row.name}: totalLinksUpdated=${totalUpdated}`);
	process.exit(0);
}

// Full resumable sweep across all undated FINRA-connected people in profiles.sqlite
const db = getProfilesDb();
const t0 = Date.now();

// Load firm CRD -> profileId map once
const firmIdByCrd = new Map();
const firmRows = db
	.prepare(
		`SELECT pi.normalized_value AS crd, p.id AS pid
     FROM profile_identifiers pi
     JOIN profiles p ON p.id = pi.profile_id
     WHERE pi.scheme = 'finra_crd' AND p.profile_type = 'firm'`,
	)
	.all();
for (const r of firmRows) {
	firmIdByCrd.set(String(r.crd), String(r.pid));
}
console.log(`[finra-dates] Loaded ${firmIdByCrd.size.toLocaleString()} firm CRDs`);

// Load already-checked CRDs from JSONL checkpoint so restarts skip them
const checkedCrds = new Set();
if (fs.existsSync(CACHE_JSONL)) {
	const rl = readline.createInterface({
		input: fs.createReadStream(CACHE_JSONL, 'utf8'),
		crlfDelay: Infinity,
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj?.crd) checkedCrds.add(String(obj.crd));
		} catch {
			/* ignore */
		}
	}
	console.log(`[finra-dates] Resuming: ${checkedCrds.size.toLocaleString()} individuals already cached`);
}

// Query all people with undated registered_at links and a finra_crd
const allUndated = db
	.prepare(
		`SELECT DISTINCT
       p.id AS person_id,
       pi.normalized_value AS person_crd,
       p.metadata_json AS person_meta
     FROM profile_links pl
     JOIN profiles p ON p.id = pl.from_profile_id
     JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
     WHERE pl.relation_type = 'registered_at'
       AND pl.start_date IS NULL
       AND p.profile_type = 'person'`,
	)
	.all();

let pending = allUndated.filter((r) => !checkedCrds.has(String(r.person_crd)));
if (limitArg > 0) pending = pending.slice(0, limitArg);
console.log(
	`[finra-dates] Undated FINRA individuals: ${allUndated.length.toLocaleString()} | pending fetch: ${pending.length.toLocaleString()} (concurrency=${concurrency})`,
);

if (pending.length === 0) {
	console.log('[finra-dates] Nothing pending to fetch.');
	process.exit(0);
}

const outStream = fs.createWriteStream(CACHE_JSONL, { flags: 'a' });
let done = 0;
let withDates = 0;
let linksUpdated = 0;
let buffer = [];

function flushBuffer(items) {
	if (!items.length) return;
	const now = new Date().toISOString();
	withProfilesTransaction((tx) => {
		const stmt = tx.prepare(
			`UPDATE profile_links
       SET start_date = COALESCE(?, start_date),
           end_date = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, end_date) END,
           role_label = CASE
             WHEN role_label IS NULL OR LOWER(role_label) IN ('current registration', 'previous registration')
             THEN ?
             ELSE role_label
           END,
           updated_at = ?
       WHERE from_profile_id = ? AND to_profile_id = ?`,
		);
		for (const item of items) {
			for (const emp of item.employments) {
				const targetFirmId = firmIdByCrd.get(emp.firmCrd);
				if (!targetFirmId) continue;
				if (!emp.startDate && !emp.endDate) continue;
				const roleLabel = emp.isCurrent ? 'Current registration' : 'Previous registration';
				const res = stmt.run(
					emp.startDate,
					emp.isCurrent ? 1 : 0,
					emp.endDate,
					roleLabel,
					now,
					item.personId,
					targetFirmId,
				);
				linksUpdated += Number(res.changes || 0);
			}
		}
	});
}

let idx = 0;
let cooldownUntil = 0;
const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
	while (true) {
		const waitMs = cooldownUntil - Date.now();
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
		const i = idx++;
		if (i >= pending.length) break;
		const row = pending[i];
		let preferIa = true;
		if (row.person_meta) {
			try {
				const m = JSON.parse(row.person_meta);
				const ia = String(m.finraIaScope || '').toLowerCase();
				const bc = String(m.finraBcScope || '').toLowerCase();
				if (bc === 'active' && ia === 'notinscope') preferIa = false;
			} catch {
				/* default true */
			}
		}
		if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
		const res = await fetchIndividualEmploymentDatesDetailed(String(row.person_crd), { preferIa });
		if (res.rateLimited) {
			cooldownUntil = Math.max(cooldownUntil, Date.now() + 65_000);
			console.log('[finra-dates] Hit 429 rate limit — pausing workers 65s...');
			// Do not write to checkpoint so this CRD is retried on next run
			continue;
		}
		const employments = res.employments;
		if (employments.length > 0) {
			withDates += 1;
			buffer.push({ personId: String(row.person_id), employments });
		}
		outStream.write(`${JSON.stringify({ crd: String(row.person_crd), employments })}\n`);
		done += 1;

		if (buffer.length >= 200) {
			const batch = buffer;
			buffer = [];
			flushBuffer(batch);
		}
		if (done % 500 === 0 || done === pending.length) {
			const sec = (Date.now() - t0) / 1000;
			const rate = (done / Math.max(0.1, sec)).toFixed(1);
			console.log(
				`[finra-dates] ${done.toLocaleString()}/${pending.length.toLocaleString()} (${rate}/s, ${sec.toFixed(1)}s) | withDates=${withDates.toLocaleString()} | linksUpdated=${linksUpdated.toLocaleString()}`,
			);
		}
	}
});

await Promise.all(workers);
flushBuffer(buffer);
await new Promise((r) => outStream.end(r));
console.log(
	`[finra-dates] COMPLETE in ${((Date.now() - t0) / 1000).toFixed(1)}s | checked=${done.toLocaleString()} | withDates=${withDates.toLocaleString()} | linksUpdated=${linksUpdated.toLocaleString()}`,
);
