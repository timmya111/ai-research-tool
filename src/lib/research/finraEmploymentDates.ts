import {
	extractVisualizerEmployments,
	getCachedOrFetchVisualizerIndividual,
} from '@/lib/research/finraVisualizerMirror';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import { normalizeIsoDate } from '@/lib/research/profiles/normalize';
import { getProfile } from '@/lib/research/profiles/store';

export type FinraFirmEmploymentDate = {
	firmCrd: string;
	firmName: string;
	startDate: string | null;
	endDate: string | null;
	isCurrent: boolean;
};

type RawEmpRecord = {
	firmId?: string | number | null;
	firmName?: string | null;
	registrationBeginDate?: string | null;
	registrationEndDate?: string | null;
};

function parseFinraDate(raw: unknown): string | null {
	if (!raw || typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const norm = normalizeIsoDate(trimmed);
	return norm.date || null;
}

function mergeEmploymentRecords(
	records: Array<{ emp: RawEmpRecord; isCurrent: boolean }>,
): FinraFirmEmploymentDate[] {
	const byFirm = new Map<string, FinraFirmEmploymentDate>();
	for (const { emp, isCurrent } of records) {
		const firmCrd = String(emp.firmId ?? '').replace(/\D/g, '');
		if (!firmCrd) continue;
		const firmName = String(emp.firmName || '').replace(/\s+/g, ' ').trim();
		const startDate = parseFinraDate(emp.registrationBeginDate);
		const endDate = isCurrent ? null : parseFinraDate(emp.registrationEndDate);

		const existing = byFirm.get(firmCrd);
		if (!existing) {
			byFirm.set(firmCrd, { firmCrd, firmName, startDate, endDate, isCurrent });
			continue;
		}
		// Prefer earliest hire/start date across dual BD+IA registrations at the same firm
		if (startDate && (!existing.startDate || startDate < existing.startDate)) {
			existing.startDate = startDate;
		}
		if (isCurrent) {
			existing.isCurrent = true;
			existing.endDate = null;
		} else if (!existing.isCurrent) {
			if (endDate && (!existing.endDate || endDate > existing.endDate)) {
				existing.endDate = endDate;
			}
		}
		if (!existing.firmName && firmName) existing.firmName = firmName;
	}
	return [...byFirm.values()];
}

type FetchOutcome = {
	payload: Record<string, unknown> | null;
	rateLimited: boolean;
	status: number;
};

async function fetchJsonQuiet(url: string, timeoutMs = 15_000, maxRetries = 2): Promise<FetchOutcome> {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: controller.signal,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'Mozilla/5.0 (compatible; AIResearchTool/1.0)',
				},
			});
			clearTimeout(timer);
			if (res.status === 429) {
				if (attempt < maxRetries) {
					await new Promise((r) => setTimeout(r, 4_000 * (attempt + 1)));
					continue;
				}
				return { payload: null, rateLimited: true, status: 429 };
			}
			if (!res.ok) return { payload: null, rateLimited: false, status: res.status };
			return {
				payload: (await res.json()) as Record<string, unknown>,
				rateLimited: false,
				status: res.status,
			};
		} catch {
			clearTimeout(timer);
			if (attempt < maxRetries) {
				await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
				continue;
			}
			return { payload: null, rateLimited: false, status: 0 };
		}
	}
	return { payload: null, rateLimited: false, status: 0 };
}

function extractEmploymentsFromPayload(
	payload: Record<string, unknown> | null,
): Array<{ emp: RawEmpRecord; isCurrent: boolean }> {
	if (!payload) return [];
	const hits = (payload.hits as { hits?: Array<{ _source?: Record<string, unknown> }> } | undefined)?.hits;
	const src = hits?.[0]?._source;
	if (!src) return [];
	const rawJson = typeof src.iacontent === 'string' ? src.iacontent : typeof src.content === 'string' ? src.content : null;
	if (!rawJson) return [];
	let content: Record<string, unknown>;
	try {
		content = JSON.parse(rawJson) as Record<string, unknown>;
	} catch {
		return [];
	}

	const out: Array<{ emp: RawEmpRecord; isCurrent: boolean }> = [];
	const pushAll = (arr: unknown, isCurrent: boolean) => {
		if (!Array.isArray(arr)) return;
		for (const item of arr) {
			if (item && typeof item === 'object') {
				out.push({ emp: item as RawEmpRecord, isCurrent });
			}
		}
	};
	pushAll(content.currentEmployments, true);
	pushAll(content.currentIAEmployments, true);
	pushAll(content.previousEmployments, false);
	pushAll(content.previousIAEmployments, false);
	return out;
}

export type FetchIndividualDatesResult = {
	employments: FinraFirmEmploymentDate[];
	rateLimited: boolean;
};

/**
 * Fetch an individual's full FINRA BrokerCheck + SEC IAPD employment start/end dates by CRD.
 * Tries SEC IAPD first when `preferIa` is true (since IAPD returns BOTH BD and IA dates),
 * and falls back to BrokerCheck (or queries both if target firm isn't found in the first response).
 */
export async function fetchIndividualEmploymentDatesDetailed(
	individualCrd: string,
	opts?: { preferIa?: boolean; targetFirmCrd?: string | null; visualizerOnly?: boolean },
): Promise<FetchIndividualDatesResult> {
	const crd = String(individualCrd || '').replace(/\D/g, '');
	if (!crd) return { employments: [], rateLimited: false };

	// 1. Local-first read-only FINRA visualizer mirror (24h local cache; zero FINRA 429 rate-limits)
	try {
		const { snapshot } = await getCachedOrFetchVisualizerIndividual(crd);
		if (snapshot?.found && snapshot.payload) {
			const visEmps = extractVisualizerEmployments(snapshot.payload).map((e) => ({
				firmCrd: e.firmCrd,
				firmName: e.firmName,
				startDate: e.startDate,
				endDate: e.endDate,
				isCurrent: e.isCurrent,
			}));
			if (visEmps.length > 0) {
				return { employments: visEmps, rateLimited: false };
			}
		}
	} catch {
		/* fall through to fallback */
	}

	if (opts?.visualizerOnly) {
		return { employments: [], rateLimited: false };
	}

	// 2. Fallback to SEC IAPD / FINRA BrokerCheck if not indexed in visualizer
	const iapdUrl = `https://api.adviserinfo.sec.gov/search/individual/${crd}`;
	const bcUrl = `https://api.brokercheck.finra.org/search/individual/${crd}`;
	const orderedUrls = opts?.preferIa !== false ? [iapdUrl, bcUrl] : [bcUrl, iapdUrl];

	const combined: Array<{ emp: RawEmpRecord; isCurrent: boolean }> = [];
	const target = opts?.targetFirmCrd ? String(opts.targetFirmCrd).replace(/\D/g, '') : null;
	let sawRateLimit = false;

	for (let i = 0; i < orderedUrls.length; i++) {
		const outcome = await fetchJsonQuiet(orderedUrls[i]);
		if (outcome.rateLimited) sawRateLimit = true;
		const rows = extractEmploymentsFromPayload(outcome.payload);
		if (rows.length > 0) {
			combined.push(...rows);
			if (!target || rows.some((r) => String(r.emp.firmId ?? '').replace(/\D/g, '') === target)) {
				break;
			}
		}
	}

	return {
		employments: mergeEmploymentRecords(combined),
		rateLimited: sawRateLimit && combined.length === 0,
	};
}

export async function fetchIndividualEmploymentDates(
	individualCrd: string,
	opts?: { preferIa?: boolean; targetFirmCrd?: string | null },
): Promise<FinraFirmEmploymentDate[]> {
	const res = await fetchIndividualEmploymentDatesDetailed(individualCrd, opts);
	return res.employments;
}

export type HydrateFirmDatesResult = {
	firmProfileId: string;
	firmName: string;
	firmCrd: string | null;
	peopleChecked: number;
	peopleWithDates: number;
	linksUpdated: number;
	remainingUndated: number;
	rateLimited: boolean;
	durationMs: number;
};

/**
 * Hydrate employment start/end dates (and accurate Current/Previous registration labels)
 * for all connected FINRA individuals of a firm profile, also propagating dates to any other
 * firm links those individuals have in profiles.sqlite.
 */
export async function hydrateFirmConnectionDates(
	firmIdOrSlug: string,
	opts?: { maxPeople?: number; concurrency?: number; force?: boolean },
): Promise<HydrateFirmDatesResult | null> {
	const t0 = Date.now();
	const db = getProfilesDb();
	const firm = getProfile(firmIdOrSlug, db);
	if (!firm) return null;

	const firmIdent = db
		.prepare(`SELECT normalized_value FROM profile_identifiers WHERE profile_id = ? AND scheme = 'finra_crd' LIMIT 1`)
		.get(firm.id) as { normalized_value?: string } | undefined;
	const firmCrd = firmIdent?.normalized_value ? String(firmIdent.normalized_value).replace(/\D/g, '') : null;

	const maxPeople = Math.max(1, Math.min(5000, Math.floor(Number(opts?.maxPeople ?? 150))));
	const concurrency = Math.max(1, Math.min(10, Math.floor(Number(opts?.concurrency ?? 4))));

	const dateFilter = opts?.force ? '' : 'AND pl.start_date IS NULL';
	const pendingRows = db
		.prepare(
			`SELECT DISTINCT
         p.id AS person_id,
         pi.normalized_value AS person_crd,
         p.metadata_json AS person_meta
       FROM profile_links pl
       JOIN profiles p ON p.id = CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END
       JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
       WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
         AND p.profile_type = 'person'
         ${dateFilter}
       ORDER BY
         CASE WHEN LOWER(COALESCE(pl.role_label, '')) LIKE '%current%' THEN 0 ELSE 1 END ASC
       LIMIT ?`,
		)
		.all(firm.id, firm.id, firm.id, maxPeople) as Array<{
		person_id: string;
		person_crd: string;
		person_meta?: string;
	}>;

	const totalUndatedBefore = Number(
		(
			db
				.prepare(
					`SELECT COUNT(DISTINCT p.id) AS c
           FROM profile_links pl
           JOIN profiles p ON p.id = CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END
           JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
           WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
             AND p.profile_type = 'person'
             AND pl.start_date IS NULL`,
				)
				.get(firm.id, firm.id, firm.id) as { c?: number }
		)?.c || 0,
	);

	if (pendingRows.length === 0) {
		return {
			firmProfileId: firm.id,
			firmName: firm.name,
			firmCrd,
			peopleChecked: 0,
			peopleWithDates: 0,
			linksUpdated: 0,
			remainingUndated: 0,
			rateLimited: false,
			durationMs: Date.now() - t0,
		};
	}

	// Build a fast lookup of firmCrd -> firmProfileId for cross-firm propagation
	const firmIdByCrd = new Map<string, string>();
	if (firmCrd) firmIdByCrd.set(firmCrd, firm.id);

	const results: Array<{ personId: string; personCrd: string; employments: FinraFirmEmploymentDate[] }> = [];
	let idx = 0;
	let consecutiveRateLimits = 0;
	let hitRateLimit = false;

	const workers = Array.from({ length: Math.min(concurrency, pendingRows.length) }, async () => {
		while (true) {
			if (consecutiveRateLimits >= 6) break;
			const i = idx++;
			if (i >= pendingRows.length) break;
			const row = pendingRows[i];
			let preferIa = true;
			if (row.person_meta) {
				try {
					const m = JSON.parse(row.person_meta) as Record<string, unknown>;
					const ia = String(m.finraIaScope || '').toLowerCase();
					const bc = String(m.finraBcScope || '').toLowerCase();
					if (bc === 'active' && ia === 'notinscope') preferIa = false;
				} catch {
					/* default true */
				}
			}
			const res = await fetchIndividualEmploymentDatesDetailed(row.person_crd, {
				preferIa,
				targetFirmCrd: firmCrd,
			});
			if (res.rateLimited) {
				consecutiveRateLimits += 1;
				hitRateLimit = true;
			} else {
				consecutiveRateLimits = 0;
			}
			results.push({ personId: row.person_id, personCrd: row.person_crd, employments: res.employments });
		}
	});
	await Promise.all(workers);

	// Resolve any other firm CRDs encountered so we update ALL firm links for these people
	const extraFirmCrds = new Set<string>();
	for (const r of results) {
		for (const e of r.employments) {
			if (!firmIdByCrd.has(e.firmCrd)) extraFirmCrds.add(e.firmCrd);
		}
	}
	const extraArr = [...extraFirmCrds];
	for (let i = 0; i < extraArr.length; i += 500) {
		const slice = extraArr.slice(i, i + 500);
		const ph = slice.map(() => '?').join(',');
		const rows = db
			.prepare(
				`SELECT pi.normalized_value AS crd, p.id AS pid
         FROM profile_identifiers pi
         JOIN profiles p ON p.id = pi.profile_id
         WHERE pi.scheme = 'finra_crd' AND p.profile_type = 'firm' AND pi.normalized_value IN (${ph})`,
			)
			.all(...slice) as Array<{ crd: string; pid: string }>;
		for (const rr of rows) {
			firmIdByCrd.set(String(rr.crd), String(rr.pid));
		}
	}

	let peopleWithDates = 0;
	let linksUpdated = 0;
	const now = new Date().toISOString();

	withProfilesTransaction((tx) => {
		const updateStmt = tx.prepare(
			`UPDATE profile_links
       SET start_date = COALESCE(?, start_date),
           end_date = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, end_date) END,
           role_label = CASE
             WHEN role_label IS NULL OR LOWER(role_label) IN ('current registration', 'previous registration')
             THEN ?
             ELSE role_label
           END,
           updated_at = ?
       WHERE (from_profile_id = ? AND to_profile_id = ?)
          OR (from_profile_id = ? AND to_profile_id = ?)`,
		);

		for (const r of results) {
			if (r.employments.length === 0) continue;
			let hitAny = false;
			for (const emp of r.employments) {
				const targetFirmId = firmIdByCrd.get(emp.firmCrd);
				if (!targetFirmId) continue;
				if (!emp.startDate && !emp.endDate) continue;
				const roleLabel = emp.isCurrent ? 'Current registration' : 'Previous registration';
				const res = updateStmt.run(
					emp.startDate,
					emp.isCurrent ? 1 : 0,
					emp.endDate,
					roleLabel,
					now,
					r.personId,
					targetFirmId,
					targetFirmId,
					r.personId,
				);
				const changed = Number(res.changes || 0);
				if (changed > 0) {
					linksUpdated += changed;
					hitAny = true;
				}
			}
			if (hitAny) peopleWithDates += 1;
		}
	});

	const remainingAfter = Number(
		(
			db
				.prepare(
					`SELECT COUNT(DISTINCT p.id) AS c
           FROM profile_links pl
           JOIN profiles p ON p.id = CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END
           JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
           WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
             AND p.profile_type = 'person'
             AND pl.start_date IS NULL`,
				)
				.get(firm.id, firm.id, firm.id) as { c?: number }
		)?.c || 0,
	);

	return {
		firmProfileId: firm.id,
		firmName: firm.name,
		firmCrd,
		peopleChecked: results.length,
		peopleWithDates,
		linksUpdated,
		remainingUndated: Math.min(remainingAfter, totalUndatedBefore),
		rateLimited: hitRateLimit,
		durationMs: Date.now() - t0,
	};
}
