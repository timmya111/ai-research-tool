import fs from 'node:fs';
import path from 'node:path';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	extractDatesFromProse,
	lookupLocalKiwixEntityDates,
} from '@/lib/research/profiles/dateResolver';
import { normalizeIsoDate } from '@/lib/research/profiles/normalize';
import { addIdentifier } from '@/lib/research/profiles/store';
import type { ProfileType } from '@/lib/research/profiles/types';

function parseUsOrIso(raw: unknown): string | null {
	const s = String(raw || '').trim();
	if (!s || /^unknown$/i.test(s)) return null;
	const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (us) {
		const y = Number(us[3]);
		if (y >= 1700 && y <= 2030) {
			return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
		}
	}
	const norm = normalizeIsoDate(s).date;
	if (!norm) return null;
	const yr = Number(norm.slice(0, 4));
	return yr >= 1000 && yr <= 2030 ? norm : null;
}

function extractFinraFirmDates(payload: Record<string, unknown>): {
	startDate: string | null;
	endDate: string | null;
} {
	const basic = (payload.basicInformation || {}) as Record<string, unknown>;
	const formed = parseUsOrIso(basic.formedDate);
	const statusRaw = String(basic.firmStatus || '').trim().toLowerCase();
	const bcScope = String(basic.bcScope || '').trim().toUpperCase();
	const iaScope = String(basic.iaScope || '').trim().toUpperCase();
	const statusDate = parseUsOrIso(basic.firmStatusDate);

	// Check earliest registration approval date if formedDate is absent
	let earliestReg: string | null = null;
	const pushReg = (d: string | null) => {
		if (!d) return;
		if (!earliestReg || d < earliestReg) earliestReg = d;
	};
	for (const arrKey of ['firmRegistrationHistory', 'iaRegistrationHistory', 'registrations', 'bcRegistrations']) {
		const arr = payload[arrKey];
		if (!Array.isArray(arr)) continue;
		for (const item of arr) {
			if (!item || typeof item !== 'object') continue;
			const r = item as Record<string, unknown>;
			pushReg(parseUsOrIso(r.beginDate || r.approvedDate || r.statusDate || r.effectiveDate));
		}
	}
	const startDate = formed || earliestReg;

	// End date only when firm is explicitly terminated/expelled/revoked/withdrawn/inactive
	let endDate: string | null = null;
	const isTerminated =
		/(?:terminated|expelled|revoked|withdrawn|cancelled|canceled|inactive|ceased)/.test(statusRaw) ||
		(bcScope === 'INACTIVE' && iaScope !== 'ACTIVE');
	if (isTerminated && statusDate && (!startDate || statusDate >= startDate)) {
		endDate = statusDate;
	}
	return { startDate, endDate };
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const idx = cursor;
			cursor += 1;
			if (idx >= items.length) break;
			await fn(items[idx]!, idx);
		}
	});
	await Promise.all(workers);
}

async function main() {
	const db = getProfilesDb();
	db.exec('PRAGMA busy_timeout = 15000;');
	const now = new Date().toISOString();

	const updateDatesStmt = db.prepare(
		`UPDATE profiles
     SET start_date = COALESCE(NULLIF(start_date, ''), ?),
         end_date = COALESCE(NULLIF(end_date, ''), ?),
         updated_at = ?
     WHERE id = ?`,
	);

	// =========================================================================
	// PASS 1: Local FINRA BrokerCheck firm_details.jsonl + brokercheck-reports/firm/*.json
	// =========================================================================
	const finraByCrd = new Map<string, { startDate: string | null; endDate: string | null }>();

	const firmJsonlPath = path.resolve(process.cwd(), '.data/finra-visualizer/firm_details.jsonl');
	if (fs.existsSync(firmJsonlPath)) {
		const lines = fs.readFileSync(firmJsonlPath, 'utf8').split('\n');
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as { firmCrd?: string | number; found?: boolean; payload?: Record<string, unknown> };
				if (!rec.found || !rec.payload) continue;
				const crd = String(rec.firmCrd || (rec.payload.basicInformation as Record<string, unknown> | undefined)?.firmId || '').trim();
				if (!crd) continue;
				const dates = extractFinraFirmDates(rec.payload);
				if (dates.startDate || dates.endDate) finraByCrd.set(crd, dates);
			} catch {
				/* skip malformed line */
			}
		}
	}

	const bcFirmDir = path.resolve(process.cwd(), '.data/brokercheck-reports/firm');
	if (fs.existsSync(bcFirmDir)) {
		for (const fname of fs.readdirSync(bcFirmDir)) {
			if (!fname.endsWith('.json')) continue;
			const crd = fname.replace(/\.json$/i, '');
			const existing = finraByCrd.get(crd);
			if (existing?.startDate && existing?.endDate) continue;
			try {
				const rec = JSON.parse(fs.readFileSync(path.join(bcFirmDir, fname), 'utf8')) as {
					found?: boolean;
					payload?: Record<string, unknown>;
				};
				if (!rec.found || !rec.payload) continue;
				const dates = extractFinraFirmDates(rec.payload);
				if (dates.startDate || dates.endDate) {
					finraByCrd.set(crd, {
						startDate: existing?.startDate || dates.startDate,
						endDate: existing?.endDate || dates.endDate,
					});
				}
			} catch {
				/* skip malformed */
			}
		}
	}

	let pass1Start = 0;
	let pass1End = 0;
	const finraFirms = db
		.prepare(
			`SELECT p.id, p.start_date, p.end_date, pi.value AS crd
       FROM profiles p
       JOIN profile_identifiers pi ON pi.profile_id = p.id
       WHERE p.profile_type = 'firm' AND pi.scheme = 'finra_crd'`,
		)
		.all() as Array<{ id: string; start_date: string | null; end_date: string | null; crd: string }>;

	db.exec('BEGIN IMMEDIATE;');
	try {
		for (const row of finraFirms) {
			const hit = finraByCrd.get(String(row.crd || '').trim());
			if (!hit) continue;
			const addStart = !row.start_date && hit.startDate ? hit.startDate : null;
			const addEnd = !row.end_date && hit.endDate ? hit.endDate : null;
			if (!addStart && !addEnd) continue;
			updateDatesStmt.run(addStart, addEnd, now, row.id);
			if (addStart) pass1Start += 1;
			if (addEnd) pass1End += 1;
		}
		db.exec('COMMIT;');
	} catch (e) {
		db.exec('ROLLBACK;');
		throw e;
	}
	console.log(`[Pass 1 - FINRA local] indexed=${finraByCrd.size} | +start=${pass1Start} | +end=${pass1End}`);

	// =========================================================================
	// PASS 2: Local IRS EO-BMF nonprofit ruling dates
	// =========================================================================
	const einProfiles = db
		.prepare(
			`SELECT p.id, p.start_date, pi.value AS ein
       FROM profiles p
       JOIN profile_identifiers pi ON pi.profile_id = p.id
       WHERE pi.scheme = 'irs_ein' AND (p.start_date IS NULL OR p.start_date = '')`,
		)
		.all() as Array<{ id: string; start_date: string | null; ein: string }>;
	const einNeeded = new Map<string, string[]>();
	for (const r of einProfiles) {
		const digits = String(r.ein || '').replace(/\D/g, '').padStart(9, '0');
		if (digits.length !== 9) continue;
		const arr = einNeeded.get(digits) || [];
		arr.push(r.id);
		einNeeded.set(digits, arr);
	}
	let pass2Start = 0;
	const irsDir = path.resolve(process.cwd(), '.data/irs/eo-bmf');
	if (einNeeded.size > 0 && fs.existsSync(irsDir)) {
		db.exec('BEGIN IMMEDIATE;');
		try {
			for (const fname of fs.readdirSync(irsDir)) {
				if (!fname.endsWith('.csv')) continue;
				const lines = fs.readFileSync(path.join(irsDir, fname), 'utf8').split('\n');
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (!line) continue;
					const comma = line.indexOf(',');
					if (comma < 6) continue;
					const ein = line.slice(0, comma).replace(/\D/g, '').padStart(9, '0');
					const pids = einNeeded.get(ein);
					if (!pids) continue;
					const cols = line.split(',');
					const ruling = String(cols[11] || '').trim();
					if (/^\d{6}$/.test(ruling)) {
						const yr = Number(ruling.slice(0, 4));
						const mo = ruling.slice(4, 6);
						if (yr >= 1900 && yr <= 2030 && Number(mo) >= 1 && Number(mo) <= 12) {
							const iso = `${yr}-${mo}`;
							for (const pid of pids) {
								updateDatesStmt.run(iso, null, now, pid);
								pass2Start += 1;
							}
							einNeeded.delete(ein);
						}
					}
				}
			}
			db.exec('COMMIT;');
		} catch (e) {
			db.exec('ROLLBACK;');
			throw e;
		}
	}
	console.log(`[Pass 2 - IRS EO-BMF] +start=${pass2Start}`);

	// =========================================================================
	// PASS 3: Prose extraction across ALL profiles + historic_event timeline fallback
	// =========================================================================
	let pass3Start = 0;
	let pass3End = 0;
	const proseCandidates = db
		.prepare(
			`SELECT id, name, profile_type, start_date, end_date, summary
       FROM profiles
       WHERE length(coalesce(summary, '')) >= 20
         AND (start_date IS NULL OR start_date = '' OR end_date IS NULL OR end_date = '')`,
		)
		.all() as Array<{
		id: string;
		name: string;
		profile_type: ProfileType;
		start_date: string | null;
		end_date: string | null;
		summary: string;
	}>;

	db.exec('BEGIN IMMEDIATE;');
	try {
		for (const p of proseCandidates) {
			const res = extractDatesFromProse(p.summary, p.profile_type, p.name);
			const addStart = !p.start_date && res.startDate ? res.startDate : null;
			const addEnd = !p.end_date && res.endDate ? res.endDate : null;
			if (!addStart && !addEnd) continue;
			updateDatesStmt.run(addStart, addEnd, now, p.id);
			if (addStart) pass3Start += 1;
			if (addEnd) pass3End += 1;
		}

		// Historic events still missing start_date -> earliest timeline entry date
		const undatedEvents = db
			.prepare(
				`SELECT p.id, min(t.event_date) AS min_d, max(coalesce(t.end_date, t.event_date)) AS max_d
         FROM profiles p
         JOIN timeline_entries t ON t.profile_id = p.id
         WHERE p.profile_type = 'historic_event'
           AND (p.start_date IS NULL OR p.start_date = '')
           AND t.event_date IS NOT NULL AND t.event_date != ''
         GROUP BY p.id`,
			)
			.all() as Array<{ id: string; min_d: string | null; max_d: string | null }>;
		for (const ev of undatedEvents) {
			const s = parseUsOrIso(ev.min_d);
			const e = parseUsOrIso(ev.max_d);
			if (!s) continue;
			updateDatesStmt.run(s, e && e > s ? e : null, now, ev.id);
			pass3Start += 1;
		}
		db.exec('COMMIT;');
	} catch (e) {
		db.exec('ROLLBACK;');
		throw e;
	}
	console.log(`[Pass 3 - Prose & timeline] +start=${pass3Start} | +end=${pass3End}`);

	// =========================================================================
	// PASS 4 & 5: Offline Local Kiwix Wikipedia ZIM Infobox + Category Extraction
	// Zero rate limits, ~2ms/article — covers ALL non-FINRA missing-date profiles
	// PLUS all profiles with existing wikipedia.org URLs missing start_date or end_date!
	// =========================================================================
	const wikiUrlByProfile = new Map<string, string>();
	for (const r of db
		.prepare(
			`SELECT profile_id, value FROM profile_identifiers WHERE scheme = 'url' AND lower(value) LIKE '%wikipedia.org/wiki/%'`,
		)
		.all() as Array<{ profile_id: string; value: string }>) {
		if (!wikiUrlByProfile.has(r.profile_id)) wikiUrlByProfile.set(r.profile_id, r.value);
	}

	const wikiTargets = db
		.prepare(
			`SELECT p.id, p.slug, p.name, p.profile_type, p.start_date, p.end_date
       FROM profiles p
       WHERE (
         (p.start_date IS NULL OR p.start_date = '')
         AND p.id NOT IN (SELECT profile_id FROM profile_identifiers WHERE scheme = 'finra_crd')
         AND coalesce(p.summary, '') NOT LIKE 'FINRA%'
         AND coalesce(p.summary, '') NOT LIKE 'Listed in a Murray College%'
         AND coalesce(p.summary, '') NOT LIKE 'Listed in mom''s personal phone book%'
         AND p.profile_type != 'region'
       )
       OR (
         p.id IN (SELECT profile_id FROM profile_identifiers WHERE scheme = 'url' AND lower(value) LIKE '%wikipedia.org/wiki/%')
         AND (p.start_date IS NULL OR p.start_date = '' OR p.end_date IS NULL OR p.end_date = '')
       )
       ORDER BY
         CASE p.profile_type
           WHEN 'historic_event' THEN 0
           WHEN 'nonprofit' THEN 1
           WHEN 'education' THEN 2
           WHEN 'medical_hospital' THEN 3
           WHEN 'government' THEN 4
           WHEN 'firm' THEN 5
           WHEN 'person' THEN 6
           ELSE 7
         END,
         p.name`,
		)
		.all() as Array<{
		id: string;
		slug: string;
		name: string;
		profile_type: ProfileType;
		start_date: string | null;
		end_date: string | null;
	}>;

	console.log(`[Pass 5 - Local Kiwix Wikipedia ZIM] targets=${wikiTargets.length}`);

	let pass5Start = 0;
	let pass5End = 0;
	let checked = 0;
	const pendingUpdates: Array<{
		id: string;
		startDate: string | null;
		endDate: string | null;
		wikiUrl: string | null;
	}> = [];

	const flushUpdates = () => {
		if (pendingUpdates.length === 0) return;
		const batch = pendingUpdates.splice(0, pendingUpdates.length);
		db.exec('BEGIN IMMEDIATE;');
		try {
			for (const u of batch) {
				updateDatesStmt.run(u.startDate, u.endDate, now, u.id);
				if (u.startDate) pass5Start += 1;
				if (u.endDate) pass5End += 1;
				if (u.wikiUrl) {
					addIdentifier({ profileId: u.id, scheme: 'url', value: u.wikiUrl, sourceCorpus: 'date-backfill-kiwix' }, db);
				}
			}
			db.exec('COMMIT;');
		} catch (e) {
			db.exec('ROLLBACK;');
			throw e;
		}
	};

	await runPool(wikiTargets, 8, async (t) => {
		const hit = await lookupLocalKiwixEntityDates({
			name: t.name,
			profileType: t.profile_type,
			existingWikiUrl: wikiUrlByProfile.get(t.id) || null,
		});
		checked += 1;
		if (hit) {
			const addStart = !t.start_date && hit.startDate ? hit.startDate : null;
			const addEnd = !t.end_date && hit.endDate ? hit.endDate : null;
			if (addStart || addEnd) {
				pendingUpdates.push({
					id: t.id,
					startDate: addStart,
					endDate: addEnd,
					wikiUrl: hit.wikiUrl,
				});
			}
		}
		if (pendingUpdates.length >= 250) {
			flushUpdates();
		}
		if (checked % 3000 === 0) {
			flushUpdates();
			console.log(`  [Pass 5 progress] checked=${checked}/${wikiTargets.length} | +start=${pass5Start} | +end=${pass5End}`);
		}
	});
	flushUpdates();
	console.log(`[Pass 5 - Local Kiwix total] checked=${checked} | +start=${pass5Start} | +end=${pass5End}`);

	// =========================================================================
	// PASS 6: Clean up Humble Oil & Refining Co (fix bogus 1882 ExxonMobil date bullet + ensure 1911–1973 dates)
	// =========================================================================
	const humble = db
		.prepare(`SELECT id, start_date, end_date, summary FROM profiles WHERE slug = 'firm:humble-oil-refining-co'`)
		.get() as { id: string; start_date: string | null; end_date: string | null; summary: string } | undefined;
	if (humble) {
		const cleanSummary = [
			'Humble Oil & Refining Co. (1911–1973) was a Texas-based oil exploration, production, refining, and marketing company founded in Humble, Texas in 1911 and reincorporated as Humble Oil & Refining Company in 1917. Standard Oil Company of New Jersey (Jersey Standard) acquired a controlling interest in 1919 and full ownership in 1959; on January 1, 1973, Humble Oil merged into Exxon Company, U.S.A. (now part of ExxonMobil).',
			'',
			'## Timeline',
			'- **1973-01-01** — Merged into Exxon Company, U.S.A. as part of Jersey Standard’s nationwide consolidation under the Exxon brand.',
			'- **1959** — Standard Oil Company of New Jersey completed full acquisition of Humble Oil & Refining Company.',
			'- **1919** — Standard Oil Company of New Jersey (Jersey Standard) acquired a 50% controlling interest in Humble Oil & Refining Company for $17 million.',
			'- **1917-06-21** — Reincorporated as Humble Oil & Refining Company in Houston, Texas.',
			'- **1911** — Founded as Humble Oil Company in Humble, Texas.',
			'',
			'## Sources',
			'- https://en.wikipedia.org/wiki/Humble_Oil',
		].join('\n');
		db.prepare(
			`UPDATE profiles SET start_date = ?, end_date = ?, summary = ?, updated_at = ? WHERE id = ?`,
		).run('1911', '1973-01-01', cleanSummary, now, humble.id);
		// Remove bogus 1882-08-05 timeline row copied from ExxonMobil
		db.prepare(`DELETE FROM timeline_entries WHERE profile_id = ? AND event_date = '1882-08-05'`).run(humble.id);
		console.log('[Pass 6] Updated firm:humble-oil-refining-co -> 1911 to 1973-01-01');
	}

	// Print final coverage stats
	console.log('\n=== FINAL DATE COVERAGE BY PROFILE_TYPE ===');
	console.log(
		db
			.prepare(
				`SELECT profile_type,
                count(*) AS total,
                sum(CASE WHEN start_date IS NOT NULL AND start_date != '' THEN 1 ELSE 0 END) AS has_start,
                sum(CASE WHEN end_date IS NOT NULL AND end_date != '' THEN 1 ELSE 0 END) AS has_end
         FROM profiles
         GROUP BY profile_type
         ORDER BY total DESC`,
			)
			.all(),
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
