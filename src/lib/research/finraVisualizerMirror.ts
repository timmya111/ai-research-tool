import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finraApiUrl } from '@/lib/research/finraApp';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import { normalizeIsoDate, parseAddressParts } from '@/lib/research/profiles/normalize';
import {
	addAlias,
	addIdentifier,
	addLocation,
	updateProfileFields,
	upsertProfile,
	upsertProfileLink,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';

export const FINRA_DAILY_TTL_MS = 24 * 60 * 60 * 1000;

const BASE_DIR = path.join(process.cwd(), '.data', 'finra-visualizer');
const IND_CACHE_DIR = path.join(BASE_DIR, 'cache', 'individuals');
const FIRM_CACHE_DIR = path.join(BASE_DIR, 'cache', 'firms');
const FIRM_DETAILS_CACHE_DIR = path.join(BASE_DIR, 'cache', 'firm_details');
const SYNC_STATE_PATH = path.join(BASE_DIR, 'sync_state.json');
const CHANGE_LOG_PATH = path.join(BASE_DIR, 'change_log.jsonl');

function ensureDirs() {
	fs.mkdirSync(IND_CACHE_DIR, { recursive: true });
	fs.mkdirSync(FIRM_CACHE_DIR, { recursive: true });
	fs.mkdirSync(FIRM_DETAILS_CACHE_DIR, { recursive: true });
}

export type VisualizerEmploymentEntry = {
	firmCrd: string;
	firmName: string;
	bdSecNumber: string | null;
	iaSecNumber: string | null;
	iaOnly: boolean;
	firmBcScope: string | null;
	firmIaScope: string | null;
	startDate: string | null;
	endDate: string | null;
	isCurrent: boolean;
	city: string | null;
	state: string | null;
	country: string | null;
	branchAddresses: string[];
};

export type LocalIndividualSnapshot = {
	crd: string;
	found: boolean;
	fetchedAt: string;
	sourceUrl: string;
	contentHash: string;
	payload: Record<string, unknown> | null;
};

export type LocalFirmConnectionsSnapshot = {
	firmCrd: string;
	found: boolean;
	fetchedAt: string;
	sourceUrl: string;
	contentHash: string;
	currentCount: number;
	previousCount: number;
	current: Array<{ crd: string; name: string; bcScope: string | null; iaScope: string | null; address: string | null }>;
	previous: Array<{ crd: string; name: string; bcScope: string | null; iaScope: string | null; address: string | null }>;
};

export type SyncEntityState = {
	lastCheckedAt: string;
	contentHash: string;
	name?: string;
	currentCount?: number;
	previousCount?: number;
	found?: boolean;
};

export type FinraSyncState = {
	lastDailyRunAt: string | null;
	individuals: Record<string, SyncEntityState>;
	firms: Record<string, SyncEntityState>;
};

export type FinraChangeLogEntry = {
	detectedAt: string;
	entityType: 'individual' | 'firm';
	crd: string;
	name: string;
	sourceUrl: string;
	summary: string;
	details: Record<string, unknown>;
};

function sha256(val: unknown): string {
	return crypto.createHash('sha256').update(JSON.stringify(val)).digest('hex');
}

function parseFinraDate(raw: unknown): string | null {
	if (!raw || typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return normalizeIsoDate(trimmed).date || null;
}

export function readFinraSyncState(): FinraSyncState {
	try {
		if (fs.existsSync(SYNC_STATE_PATH)) {
			const parsed = JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8')) as Partial<FinraSyncState>;
			return {
				lastDailyRunAt: typeof parsed.lastDailyRunAt === 'string' ? parsed.lastDailyRunAt : null,
				individuals: parsed.individuals && typeof parsed.individuals === 'object' ? parsed.individuals : {},
				firms: parsed.firms && typeof parsed.firms === 'object' ? parsed.firms : {},
			};
		}
	} catch {
		/* start fresh */
	}
	return { lastDailyRunAt: null, individuals: {}, firms: {} };
}

function writeFinraSyncState(state: FinraSyncState): void {
	ensureDirs();
	fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function appendChangeLog(entry: FinraChangeLogEntry): void {
	ensureDirs();
	fs.appendFileSync(CHANGE_LOG_PATH, `${JSON.stringify(entry)}\n`);
}

export function readRecentFinraChanges(limit = 50): FinraChangeLogEntry[] {
	if (!fs.existsSync(CHANGE_LOG_PATH)) return [];
	try {
		const lines = fs
			.readFileSync(CHANGE_LOG_PATH, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean);
		return lines
			.slice(-Math.max(1, limit))
			.reverse()
			.map((l) => JSON.parse(l) as FinraChangeLogEntry);
	} catch {
		return [];
	}
}

function isFreshWithinDay(isoTimestamp: string | null | undefined, ttlMs = FINRA_DAILY_TTL_MS): boolean {
	if (!isoTimestamp) return false;
	const ts = Date.parse(isoTimestamp);
	if (!Number.isFinite(ts)) return false;
	return Date.now() - ts < ttlMs;
}

/**
 * Strictly READ-ONLY GET helper against the live FINRA/SEC visualizer API.
 */
async function readOnlyGetJson(
	url: string,
	timeoutMs = 25_000,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			cache: 'no-store',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) return { ok: false, status: res.status, data: null };
		const data = (await res.json()) as Record<string, unknown>;
		return { ok: true, status: res.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	} finally {
		clearTimeout(timer);
	}
}

export function extractVisualizerEmployments(payload: Record<string, unknown> | null): VisualizerEmploymentEntry[] {
	if (!payload || payload.found === false) return [];

	type RawEmp = Record<string, unknown>;
	const rawList: Array<{ emp: RawEmp; isCurrent: boolean }> = [];
	const pushArr = (arr: unknown, isCurrent: boolean) => {
		if (!Array.isArray(arr)) return;
		for (const item of arr) {
			if (item && typeof item === 'object') rawList.push({ emp: item as RawEmp, isCurrent });
		}
	};
	pushArr(payload.currentEmployments, true);
	pushArr(payload.currentIAEmployments, true);
	pushArr(payload.previousEmployments, false);
	pushArr(payload.previousIAEmployments, false);

	// Preserve distinct non-overlapping stints at the same firm (e.g. two separate periods at National Planning Corp),
	// while merging dual BD+IA registrations that overlap at the same firm.
	const entries: VisualizerEmploymentEntry[] = [];
	const dayDiff = (a: string | null, b: string | null): number => {
		if (!a || !b) return 9999;
		const ta = Date.parse(a);
		const tb = Date.parse(b);
		if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 9999;
		return Math.abs(ta - tb) / 86_400_000;
	};

	for (const { emp, isCurrent } of rawList) {
		const firmCrd = String(emp.firmId ?? '').replace(/\D/g, '');
		if (!firmCrd) continue;
		const firmName = String(emp.firmName || '').replace(/\s+/g, ' ').trim();
		const bdSecNumber = emp.bdSECNumber ? String(emp.bdSECNumber).trim() : null;
		const iaSecNumber = emp.iaSECNumber ? String(emp.iaSECNumber).trim() : null;
		const iaOnly = String(emp.iaOnly || '').toUpperCase() === 'Y';
		const firmBcScope = typeof emp.firmBCScope === 'string' && emp.firmBCScope.trim() ? emp.firmBCScope.trim() : null;
		const firmIaScope = typeof emp.firmIAScope === 'string' && emp.firmIAScope.trim() ? emp.firmIAScope.trim() : null;
		const startDate = parseFinraDate(emp.registrationBeginDate);
		const endDate = isCurrent ? null : parseFinraDate(emp.registrationEndDate);
		const city = typeof emp.city === 'string' && emp.city.trim() ? emp.city.trim() : null;
		const state = typeof emp.state === 'string' && emp.state.trim() ? emp.state.trim() : null;
		const country = typeof emp.country === 'string' && emp.country.trim() ? emp.country.trim() : null;

		const branchAddresses: string[] = [];
		if (Array.isArray(emp.branchOfficeLocations)) {
			for (const b of emp.branchOfficeLocations as Array<Record<string, unknown>>) {
				const parts = [b.street1, b.street2, b.city, b.state, b.zipCode]
					.map((x) => (typeof x === 'string' ? x.trim() : ''))
					.filter(Boolean);
				if (parts.length) branchAddresses.push(parts.join(', '));
			}
		}
		if (branchAddresses.length === 0 && (city || state)) {
			const cleanCity = city ? city.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : null;
			branchAddresses.push([cleanCity, state].filter(Boolean).join(', '));
		}

		// Merge ONLY if same firmCrd + same current/previous bucket AND (both current OR start/end dates match closely)
		const match = entries.find((ex) => {
			if (ex.firmCrd !== firmCrd || ex.isCurrent !== isCurrent) return false;
			if (isCurrent) return true;
			return dayDiff(ex.startDate, startDate) <= 45 && dayDiff(ex.endDate, endDate) <= 45;
		});

		if (!match) {
			entries.push({
				firmCrd,
				firmName,
				bdSecNumber,
				iaSecNumber,
				iaOnly,
				firmBcScope,
				firmIaScope,
				startDate,
				endDate,
				isCurrent,
				city,
				state,
				country,
				branchAddresses: [...new Set(branchAddresses)],
			});
			continue;
		}

		if (startDate && (!match.startDate || startDate < match.startDate)) match.startDate = startDate;
		if (!isCurrent && endDate && (!match.endDate || endDate > match.endDate)) match.endDate = endDate;
		if (!match.firmName && firmName) match.firmName = firmName;
		if (!match.bdSecNumber && bdSecNumber) match.bdSecNumber = bdSecNumber;
		if (!match.iaSecNumber && iaSecNumber) match.iaSecNumber = iaSecNumber;
		if (!iaOnly) match.iaOnly = false; // If either record is BD, not IA-only
		if (!match.firmBcScope && firmBcScope) match.firmBcScope = firmBcScope;
		if (!match.firmIaScope && firmIaScope) match.firmIaScope = firmIaScope;
		for (const addr of branchAddresses) {
			if (!match.branchAddresses.includes(addr)) match.branchAddresses.push(addr);
		}
	}

	return entries.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		const da = a.startDate || a.endDate || '';
		const dbDate = b.startDate || b.endDate || '';
		if (da !== dbDate) return dbDate.localeCompare(da);
		return a.firmName.localeCompare(b.firmName);
	});
}

function individualCanonicalHash(payload: Record<string, unknown> | null): string {
	if (!payload || payload.found === false) return sha256({ found: false });
	const bi = (payload.basicInformation || {}) as Record<string, unknown>;
	const emps = extractVisualizerEmployments(payload).map((e) => ({
		f: e.firmCrd,
		c: e.isCurrent,
		s: e.startDate,
		e: e.endDate,
	}));
	return sha256({
		found: true,
		name: `${bi.firstName || ''} ${bi.middleName || ''} ${bi.lastName || ''}`.trim(),
		bcScope: bi.bcScope || null,
		iaScope: bi.iaScope || null,
		disclosures: Array.isArray(payload.disclosures) ? payload.disclosures.length : 0,
		iaDisclosures: Array.isArray(payload.iaDisclosures) ? payload.iaDisclosures.length : 0,
		emps,
	});
}

export function readLocalIndividualSnapshot(crd: string): LocalIndividualSnapshot | null {
	const clean = String(crd || '').replace(/\D/g, '');
	if (!clean) return null;
	const file = path.join(IND_CACHE_DIR, `${clean}.json`);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as LocalIndividualSnapshot;
	} catch {
		return null;
	}
}

/**
 * Local-first read of an individual from the read-only FINRA visualizer API.
 * Uses local disk cache if fresh within 24 hours; only calls the live API once per day (or when forceRefresh=true).
 */
export async function getCachedOrFetchVisualizerIndividual(
	crd: string,
	opts?: { forceRefresh?: boolean; ttlMs?: number },
): Promise<{
	snapshot: LocalIndividualSnapshot | null;
	fromCache: boolean;
	changed: boolean;
	previousSnapshot: LocalIndividualSnapshot | null;
}> {
	const clean = String(crd || '').replace(/\D/g, '');
	if (!clean) return { snapshot: null, fromCache: false, changed: false, previousSnapshot: null };

	ensureDirs();
	const prior = readLocalIndividualSnapshot(clean);
	const ttlMs = opts?.ttlMs ?? FINRA_DAILY_TTL_MS;

	if (prior && !opts?.forceRefresh && isFreshWithinDay(prior.fetchedAt, ttlMs)) {
		return { snapshot: prior, fromCache: true, changed: false, previousSnapshot: prior };
	}

	const url = finraApiUrl(`/api/finra/merged/individual/${clean}`);
	const res = await readOnlyGetJson(url);
	if (!res.ok || !res.data) {
		// If live site temporarily fails, gracefully serve the local cached copy!
		if (prior) return { snapshot: prior, fromCache: true, changed: false, previousSnapshot: prior };
		return { snapshot: null, fromCache: false, changed: false, previousSnapshot: null };
	}

	// Prefer merged (BrokerCheck + IAPD combined) — same shape as /api/finra/merged/individual/{crd}.
	const nodePayload =
		(res.data.merged && typeof res.data.merged === 'object'
			? (res.data.merged as Record<string, unknown>)
			: res.data.finraNode && typeof res.data.finraNode === 'object'
				? (res.data.finraNode as Record<string, unknown>)
				: res.data) || res.data;

	const found =
		res.data.found !== false &&
		Boolean(
			nodePayload.basicInformation ||
				(Array.isArray(nodePayload.currentEmployments) && nodePayload.currentEmployments.length > 0) ||
				(Array.isArray(nodePayload.previousEmployments) && nodePayload.previousEmployments.length > 0) ||
				(Array.isArray(nodePayload.currentIAEmployments) && nodePayload.currentIAEmployments.length > 0) ||
				(Array.isArray(nodePayload.previousIAEmployments) && nodePayload.previousIAEmployments.length > 0),
		);

	const contentHash = individualCanonicalHash(found ? nodePayload : null);
	const now = new Date().toISOString();
	const nextSnap: LocalIndividualSnapshot = {
		crd: clean,
		found,
		fetchedAt: now,
		sourceUrl: url,
		contentHash,
		payload: found ? nodePayload : null,
	};

	const changed = !prior || prior.contentHash !== contentHash;
	fs.writeFileSync(path.join(IND_CACHE_DIR, `${clean}.json`), JSON.stringify(nextSnap));

	const state = readFinraSyncState();
	const bi = (nodePayload.basicInformation || {}) as Record<string, unknown>;
	const fullName = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
	const emps = extractVisualizerEmployments(nextSnap.payload);
	state.individuals[clean] = {
		lastCheckedAt: now,
		contentHash,
		name: fullName || prior?.payload ? fullName : undefined,
		currentCount: emps.filter((e) => e.isCurrent).length,
		previousCount: emps.filter((e) => !e.isCurrent).length,
		found,
	};
	writeFinraSyncState(state);

	if (prior && changed && found) {
		const prevEmps = extractVisualizerEmployments(prior.payload);
		const prevMap = new Map(prevEmps.map((e) => [e.firmCrd, e]));
		const nextMap = new Map(emps.map((e) => [e.firmCrd, e]));
		const added = emps.filter((e) => !prevMap.has(e.firmCrd)).map((e) => `${e.firmName} (${e.firmCrd})`);
		const statusChanged = emps
			.filter((e) => {
				const p = prevMap.get(e.firmCrd);
				return p && (p.isCurrent !== e.isCurrent || p.startDate !== e.startDate || p.endDate !== e.endDate);
			})
			.map((e) => `${e.firmName}: ${e.isCurrent ? 'Current' : 'Old'} (${e.startDate || '?'}→${e.endDate || 'Present'})`);
		const removed = prevEmps.filter((e) => !nextMap.has(e.firmCrd)).map((e) => `${e.firmName} (${e.firmCrd})`);

		appendChangeLog({
			detectedAt: now,
			entityType: 'individual',
			crd: clean,
			name: fullName || `CRD# ${clean}`,
			sourceUrl: url,
			summary: `Individual CRD# ${clean} updated (${added.length} added, ${statusChanged.length} modified, ${removed.length} removed).`,
			details: { added, statusChanged, removed },
		});
	}

	return { snapshot: nextSnap, fromCache: false, changed, previousSnapshot: prior };
}

export type IngestVisualizerIndividualResult = {
	crd: string;
	found: boolean;
	fromCache: boolean;
	changed: boolean;
	profileId: string | null;
	name: string | null;
	employmentsCount: number;
	currentCount: number;
	previousCount: number;
	linksUpdated: number;
	locationsAdded: number;
	sourceUrl: string;
};

/**
 * Ingest a FINRA individual's full dated employment history, aliases, branch locations,
 * exams, and firm links from the local-first read-only visualizer mirror into profiles.sqlite.
 */
export async function ingestIndividualFromVisualizer(
	crd: string,
	opts?: { forceRefresh?: boolean; profileIdOverride?: string | null },
): Promise<IngestVisualizerIndividualResult> {
	const clean = String(crd || '').replace(/\D/g, '');
	const sourceUrl = finraApiUrl(`/api/finra/individual/${clean}`);
	if (!clean) {
		return {
			crd: clean,
			found: false,
			fromCache: false,
			changed: false,
			profileId: null,
			name: null,
			employmentsCount: 0,
			currentCount: 0,
			previousCount: 0,
			linksUpdated: 0,
			locationsAdded: 0,
			sourceUrl,
		};
	}

	const { snapshot, fromCache, changed } = await getCachedOrFetchVisualizerIndividual(clean, {
		forceRefresh: opts?.forceRefresh,
	});

	if (!snapshot || !snapshot.found || !snapshot.payload) {
		return {
			crd: clean,
			found: false,
			fromCache,
			changed: false,
			profileId: null,
			name: null,
			employmentsCount: 0,
			currentCount: 0,
			previousCount: 0,
			linksUpdated: 0,
			locationsAdded: 0,
			sourceUrl,
		};
	}

	const payload = snapshot.payload;
	const bi = (payload.basicInformation || {}) as Record<string, unknown>;
	const fullName = [bi.firstName, bi.middleName, bi.lastName]
		.map((x) => (typeof x === 'string' ? x.trim() : ''))
		.filter(Boolean)
		.join(' ')
		.replace(/\s+/g, ' ');
	const emps = extractVisualizerEmployments(payload);
	const CORPUS = 'finra-visualizer';

	let profileId = opts?.profileIdOverride || null;
	let linksUpdated = 0;
	let locationsAdded = 0;

	const exams: Array<{ category?: string; name?: string; examTakenDate?: string }> = [];
	for (const key of ['stateExamCategory', 'principalExamCategory', 'productExamCategory'] as const) {
		if (Array.isArray(payload[key])) {
			for (const ex of payload[key] as Array<Record<string, unknown>>) {
				exams.push({
					category: typeof ex.examCategory === 'string' ? ex.examCategory : undefined,
					name: typeof ex.examName === 'string' ? ex.examName : undefined,
					examTakenDate: typeof ex.examTakenDate === 'string' ? ex.examTakenDate : undefined,
				});
			}
		}
	}
	const examLabels = exams
		.map((ex) => [ex.category, ex.name].filter(Boolean).join(' — '))
		.filter(Boolean);
	const regStates = Array.isArray(payload.registeredStates)
		? (payload.registeredStates as Array<Record<string, unknown>>)
				.map((s) => String(s.state || ''))
				.filter(Boolean)
		: [];
	const regSros = Array.isArray(payload.registeredSROs)
		? (payload.registeredSROs as Array<Record<string, unknown>>)
				.map((s) => String(s.sro || ''))
				.filter(Boolean)
		: [];
	const disclosureCount =
		(Array.isArray(payload.disclosures) ? payload.disclosures.length : 0) +
		(Array.isArray(payload.iaDisclosures) ? payload.iaDisclosures.length : 0);

	withProfilesTransaction((tx) => {
		if (!profileId) {
			const existingByCrd = tx
				.prepare(
					`SELECT p.id FROM profile_identifiers pi
           JOIN profiles p ON p.id = pi.profile_id
           WHERE pi.scheme = 'finra_crd' AND pi.normalized_value = ? AND p.profile_type = 'person'
           LIMIT 1`,
				)
				.get(clean) as { id?: string } | undefined;
			if (existingByCrd?.id) {
				profileId = String(existingByCrd.id);
			}
		}

		if (!profileId) {
			const created = upsertProfile(
				{
					profileType: 'person',
					name: fullName || `FINRA Individual CRD# ${clean}`,
					sourceCorpus: CORPUS,
					metadata: {
						finraCrd: clean,
						finraBcScope: bi.bcScope || null,
						finraIaScope: bi.iaScope || null,
					},
				},
				tx,
			);
			profileId = created.id;
		}

		// Update rich metadata on person profile
		const curRow = tx.prepare('SELECT metadata_json, summary FROM profiles WHERE id = ?').get(profileId) as
			| { metadata_json?: string; summary?: string }
			| undefined;
		let prevMeta: Record<string, unknown> = {};
		try {
			prevMeta = curRow?.metadata_json ? (JSON.parse(curRow.metadata_json) as Record<string, unknown>) : {};
		} catch {
			prevMeta = {};
		}
		const prevCorpora = Array.isArray(prevMeta.corpora) ? prevMeta.corpora.map(String) : [];
		const nextCorpora = prevCorpora.includes(CORPUS) ? prevCorpora : [...prevCorpora, CORPUS];

		const curFirmNames = emps.filter((e) => e.isCurrent).map((e) => e.firmName).filter(Boolean);
		const summaryText =
			curRow?.summary && curRow.summary.trim().length >= 30
				? curRow.summary
				: [
						`FINRA/SEC registered individual (CRD# ${clean})`,
						bi.bcScope ? `BrokerCheck: ${String(bi.bcScope)}` : '',
						bi.iaScope ? `IA: ${String(bi.iaScope)}` : '',
						curFirmNames.length ? `Current: ${curFirmNames.slice(0, 2).join(', ')}` : '',
					]
						.filter(Boolean)
						.join(' · ');

		const daysSinceStr =
			(typeof bi.daysInIndustryCalculatedDate === 'string' && bi.daysInIndustryCalculatedDate) ||
			(typeof bi.daysInIndustryCalculatedDateIAPD === 'string' && bi.daysInIndustryCalculatedDateIAPD) ||
			null;
		const daysSinceIso = daysSinceStr ? parseFinraDate(daysSinceStr) : null;
		const yearsExp =
			daysSinceIso && Number.isFinite(Date.parse(daysSinceIso))
				? Math.max(0, Math.floor((Date.now() - Date.parse(daysSinceIso)) / (365.25 * 86_400_000)))
				: undefined;
		const regCountObj = (payload.registrationCount || {}) as Record<string, unknown>;
		const uniqueFirmCrds = new Set(emps.map((e) => e.firmCrd));
		const primaryOffice = emps.find((e) => e.isCurrent && e.branchAddresses.length > 0)?.branchAddresses[0] || undefined;

		updateProfileFields(
			profileId,
			{
				summary: summaryText,
				metadata: {
					...prevMeta,
					corpora: nextCorpora,
					finraCrd: clean,
					finraBcScope: bi.bcScope || prevMeta.finraBcScope || null,
					finraIaScope: bi.iaScope || prevMeta.finraIaScope || null,
					hasFinraData:
						payload.hasFinraData === true || payload.hasFinraData === false
							? payload.hasFinraData
							: prevMeta.hasFinraData ?? Boolean(bi.bcScope),
					hasSecData:
						payload.hasSecData === true || payload.hasSecData === false
							? payload.hasSecData
							: prevMeta.hasSecData ?? Boolean(bi.iaScope),
					finraVisualizerUrl: finraApiUrl(`/individual/${clean}`),
					finraDaysInIndustrySince: daysSinceStr || undefined,
					finraYearsExperience: yearsExp != null ? `${yearsExp} yrs` : undefined,
					finraFirmsAllTime: uniqueFirmCrds.size || undefined,
					finraPrimaryOffice: primaryOffice,
					finraStateLicenses: regStates.length || undefined,
					finraRegCount: regCountObj.approvedFinraRegistrationCount ?? undefined,
					finraSroCount: regCountObj.approvedSRORegistrationCount ?? undefined,
					finraStateBrokerCount: regCountObj.approvedStateRegistrationCount ?? undefined,
					finraStateIaCount: regCountObj.approvedIAStateRegistrationCount ?? undefined,
					finraDisclosureCount: disclosureCount,
					finraExams: examLabels.length ? examLabels : undefined,
					finraRegisteredStates: regStates.length ? regStates : undefined,
					finraRegisteredSROs: regSros.length ? regSros : undefined,
					finraLastSyncedAt: snapshot.fetchedAt,
				},
			},
			tx,
		);

		addIdentifier(
			{
				profileId,
				scheme: 'finra_crd',
				value: clean,
				sourceCorpus: CORPUS,
			},
			tx,
		);

		const otherNames = Array.isArray(bi.otherNames) ? bi.otherNames.map(String) : [];
		for (const alt of otherNames) {
			const cleaned = alt.replace(/\s+/g, ' ').trim();
			if (cleaned && cleaned.toLowerCase() !== fullName.toLowerCase()) {
				addAlias(
					{
						profileId,
						alias: cleaned,
						aliasKind: 'former_name',
						confidence: 0.96,
						sourceCorpus: CORPUS,
					},
					tx,
				);
			}
		}

		const srId = upsertSourceRecord(
			{
				corpus: CORPUS,
				sourceRef: `finra:individual:${clean}`,
				sourceUrl,
				title: `FINRA/SEC Individual Profile: ${fullName || clean} (CRD# ${clean})`,
				excerpt: `${emps.filter((e) => e.isCurrent).length} current · ${emps.filter((e) => !e.isCurrent).length} previous firm registrations.`,
			},
			tx,
		);

		const updateExistingLink = tx.prepare(
			`UPDATE profile_links
       SET start_date = COALESCE(?, start_date),
           end_date = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, end_date) END,
           role_label = CASE
             WHEN role_label IS NULL OR LOWER(role_label) IN ('current registration', 'previous registration')
             THEN ?
             ELSE role_label
           END,
           evidence_note = ?,
           updated_at = ?
       WHERE id = ?`,
		);
		const now = new Date().toISOString();
		const usedFirmIds = new Set<string>();

		for (const emp of emps) {
			// Match firm by CRD first so we never create duplicate firm rows
			const firmRow = tx
				.prepare(
					`SELECT p.id FROM profile_identifiers pi
           JOIN profiles p ON p.id = pi.profile_id
           WHERE pi.scheme = 'finra_crd' AND pi.normalized_value = ? AND p.profile_type = 'firm'
           LIMIT 1`,
				)
				.get(emp.firmCrd) as { id?: string } | undefined;

			let firmProfileId = firmRow?.id ? String(firmRow.id) : null;
			if (!firmProfileId) {
				const createdFirm = upsertProfile(
					{
						profileType: 'firm',
						name: emp.firmName || `FINRA Firm CRD# ${emp.firmCrd}`,
						sourceCorpus: CORPUS,
						metadata: {
							finraCrd: emp.firmCrd,
							bdSecNumber: emp.bdSecNumber,
							iaSecNumber: emp.iaSecNumber,
							finraBcScope: emp.firmBcScope,
							finraIaScope: emp.firmIaScope,
						},
					},
					tx,
				);
				firmProfileId = createdFirm.id;
				addIdentifier(
					{
						profileId: firmProfileId,
						scheme: 'finra_crd',
						value: emp.firmCrd,
						sourceCorpus: CORPUS,
					},
					tx,
				);
			}

			const roleLabel = emp.isCurrent ? 'Current registration' : 'Previous registration';
			const secNum = emp.bdSecNumber || emp.iaSecNumber || null;
			const noteParts = [
				`status=${emp.isCurrent ? 'current' : 'previous'}`,
				`CRD# ${clean}`,
				`firmCrd=${emp.firmCrd}`,
				secNum ? `sec=${secNum}` : '',
				emp.iaOnly ? 'iaOnly=Y' : '',
				emp.firmBcScope ? `firmBcScope=${emp.firmBcScope}` : '',
				emp.branchAddresses[0] ? `branch=${emp.branchAddresses[0]}` : '',
			].filter(Boolean);
			const richNote = noteParts.join('; ');

			// First stint at a firm updates any existing undated/matching link; additional distinct stints insert separate rows
			const isFirstStintAtFirm = !usedFirmIds.has(firmProfileId);
			usedFirmIds.add(firmProfileId);

			const existingMatch = isFirstStintAtFirm
				? (tx
						.prepare(
							`SELECT id FROM profile_links
               WHERE from_profile_id = ? AND to_profile_id = ?
                 AND (start_date IS NULL OR start_date = ?)
               LIMIT 1`,
						)
						.get(profileId, firmProfileId, emp.startDate || '') as { id?: string } | undefined)
				: (tx
						.prepare(
							`SELECT id FROM profile_links
               WHERE from_profile_id = ? AND to_profile_id = ? AND start_date = ?
               LIMIT 1`,
						)
						.get(profileId, firmProfileId, emp.startDate || '') as { id?: string } | undefined);

			if (existingMatch?.id) {
				updateExistingLink.run(
					emp.startDate,
					emp.isCurrent ? 1 : 0,
					emp.endDate,
					roleLabel,
					richNote,
					now,
					String(existingMatch.id),
				);
				linksUpdated += 1;
			} else {
				upsertProfileLink(
					{
						fromProfileId: profileId,
						toProfileId: firmProfileId,
						relationType: 'registered_at',
						roleLabel,
						startDate: emp.startDate,
						endDate: emp.endDate,
						status: 'verified',
						confidence: 0.97,
						angle: 'regulatory_finra',
						sourceCorpus: CORPUS,
						sourceRecordId: srId,
						evidenceNote: richNote,
						dedupeHint: `${emp.startDate || ''}|${emp.endDate || ''}`,
					},
					tx,
				);
				linksUpdated += 1;
			}

			// Add branch locations on the person profile (limit 2 per employment)
			for (const addr of emp.branchAddresses.slice(0, 2)) {
				const parts = parseAddressParts(addr);
				addLocation(
					{
						profileId,
						raw: addr,
						city: parts.city,
						county: parts.county,
						state: parts.state,
						country: parts.country,
						role: 'branch',
						sourceCorpus: CORPUS,
					},
					tx,
				);
				locationsAdded += 1;
			}
		}

		// Record exam milestones on timeline
		for (const ex of exams) {
			const exDate = parseFinraDate(ex.examTakenDate);
			const label = [ex.category, ex.name].filter(Boolean).join(' — ');
			if (!label) continue;
			upsertTimelineEntry(
				{
					profileId,
					eventDate: exDate,
					datePrecision: exDate ? 'day' : 'unknown',
					title: `FINRA Exam Passed: ${label}`,
					summary: `CRD# ${clean}`,
					angle: 'regulatory_finra',
					entryKind: 'milestone',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `finra-exam:${ex.category || ex.name}:${exDate || ''}`,
				},
				tx,
			);
		}
	});

	return {
		crd: clean,
		found: true,
		fromCache,
		changed,
		profileId,
		name: fullName || null,
		employmentsCount: emps.length,
		currentCount: emps.filter((e) => e.isCurrent).length,
		previousCount: emps.filter((e) => !e.isCurrent).length,
		linksUpdated,
		locationsAdded,
		sourceUrl,
	};
}

export type LocalFirmDetailSnapshot = {
	firmCrd: string;
	found: boolean;
	fetchedAt: string;
	sourceUrl: string;
	contentHash: string;
	payload: Record<string, unknown> | null;
};

export type IngestVisualizerFirmDetailResult = {
	firmCrd: string;
	found: boolean;
	fromCache: boolean;
	changed: boolean;
	profileId: string | null;
	firmName: string | null;
	locationsAdded: number;
	ownersLinked: number;
	aliasesAdded: number;
	timelineAdded: number;
	sourceUrl: string;
};

function formatAddressObj(addr: unknown): string | null {
	if (!addr || typeof addr !== 'object') return null;
	const a = addr as Record<string, unknown>;
	const parts = [a.street1, a.street2, a.city, a.state, a.postalCode || a.zipCode]
		.map((x) => (typeof x === 'string' ? x.trim() : ''))
		.filter(Boolean);
	if (!parts.length) return null;
	return parts.join(', ');
}

function isCorporateOwnerName(name: string, position: string): boolean {
	if (/\b(?:llc|inc\.?|corp\.?|corporation|ltd\.?|lp|l\.p\.|company|holdings?|group|trust|partners|capital|bank|bancorp|financial|management|enterprises|investments|association)\b/i.test(name)) {
		return true;
	}
	if (/\b(?:shareholder|parent|holding|owner|member|general partner|limited partner)\b/i.test(position) && !name.includes(',')) {
		return true;
	}
	return false;
}

function normalizeOwnerPersonName(raw: string): string {
	const cleaned = raw.replace(/\s+/g, ' ').trim();
	// Convert "AXELROD, SUSAN F" -> "Susan F Axelrod"
	if (cleaned.includes(',')) {
		const [last, rest] = cleaned.split(',', 2).map((s) => s.trim());
		if (last && rest) return `${rest} ${last}`.replace(/\s+/g, ' ').trim();
	}
	return cleaned;
}

export async function getCachedOrFetchVisualizerFirmDetail(
	firmCrd: string,
	opts?: { forceRefresh?: boolean; ttlMs?: number },
): Promise<{
	snapshot: LocalFirmDetailSnapshot | null;
	fromCache: boolean;
	changed: boolean;
}> {
	const clean = String(firmCrd || '').replace(/\D/g, '');
	if (!clean) return { snapshot: null, fromCache: false, changed: false };
	ensureDirs();

	const cacheFile = path.join(FIRM_DETAILS_CACHE_DIR, `${clean}.json`);
	let prior: LocalFirmDetailSnapshot | null = null;
	try {
		if (fs.existsSync(cacheFile)) {
			prior = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as LocalFirmDetailSnapshot;
		}
	} catch {
		prior = null;
	}

	const ttlMs = opts?.ttlMs ?? FINRA_DAILY_TTL_MS;
	if (prior && !opts?.forceRefresh && isFreshWithinDay(prior.fetchedAt, ttlMs)) {
		return { snapshot: prior, fromCache: true, changed: false };
	}

	const url = finraApiUrl(`/api/finra/merged/firm/${clean}`);
	const res = await readOnlyGetJson(url);
	if (!res.ok || !res.data) {
		if (prior) return { snapshot: prior, fromCache: true, changed: false };
		return { snapshot: null, fromCache: false, changed: false };
	}

	const node =
		(res.data.finraNode && typeof res.data.finraNode === 'object'
			? (res.data.finraNode as Record<string, unknown>)
			: res.data.merged && typeof res.data.merged === 'object'
				? (res.data.merged as Record<string, unknown>)
				: res.data) || res.data;
	const found = res.data.found !== false && Boolean(node.basicInformation);
	const contentHash = sha256(
		found
			? {
					bi: node.basicInformation,
					addr: node.firmAddressDetails || node.iaFirmAddressDetails || null,
					owners: Array.isArray(node.directOwners) ? node.directOwners.length : 0,
					disclosures: Array.isArray(node.disclosures) ? node.disclosures.length : 0,
				}
			: { found: false },
	);
	const now = new Date().toISOString();
	const nextSnap: LocalFirmDetailSnapshot = {
		firmCrd: clean,
		found,
		fetchedAt: now,
		sourceUrl: url,
		contentHash,
		payload: found ? node : null,
	};
	const changed = !prior || prior.contentHash !== contentHash;
	fs.writeFileSync(cacheFile, JSON.stringify(nextSnap));

	return { snapshot: nextSnap, fromCache: false, changed };
}

/**
 * Ingest full merged firm dossier (addresses, direct owners/officers/shareholders,
 * approval date, corporate structure, registrations, disclosures) into profiles.sqlite.
 */
export function ingestFirmDetailPayloadIntoDb(
	firmCrd: string,
	node: Record<string, unknown>,
	sourceUrl: string,
	fetchedAt: string,
	profileIdOverride?: string | null,
): {
	profileId: string;
	firmName: string;
	locationsAdded: number;
	ownersLinked: number;
	aliasesAdded: number;
	timelineAdded: number;
} {
	const clean = String(firmCrd).replace(/\D/g, '');
	const bi = (node.basicInformation || {}) as Record<string, unknown>;
	const firmName = String(bi.firmName || bi.iaFirmName || `FINRA Firm CRD# ${clean}`).replace(/\s+/g, ' ').trim();
	const firmAddr = (node.firmAddressDetails || {}) as Record<string, unknown>;
	const iaAddr = (node.iaFirmAddressDetails || {}) as Record<string, unknown>;
	const regs = (node.registrations || {}) as Record<string, unknown>;
	const disclosures = Array.isArray(node.disclosures) ? (node.disclosures as Array<Record<string, unknown>>) : [];
	const directOwners = Array.isArray(node.directOwners) ? (node.directOwners as Array<Record<string, unknown>>) : [];
	const indirectOwners = Array.isArray(node.indirectOwners)
		? (node.indirectOwners as Array<Record<string, unknown>>)
		: [];
	const CORPUS = 'finra-visualizer';

	let profileId = profileIdOverride || null;
	let locationsAdded = 0;
	let ownersLinked = 0;
	let aliasesAdded = 0;
	let timelineAdded = 0;

	const approvedRaw =
		typeof firmAddr.finraLastApprovalDate === 'string' ? firmAddr.finraLastApprovalDate : null;
	const approvedDate = approvedRaw ? normalizeIsoDate(approvedRaw.slice(0, 10)).date : null;

	const officeAddr = formatAddressObj(firmAddr.officeAddress) || formatAddressObj(iaAddr.officeAddress);
	const mailingAddr = formatAddressObj(firmAddr.mailingAddress);
	const iaOfficeAddr = formatAddressObj(iaAddr.officeAddress);

	withProfilesTransaction((tx) => {
		if (!profileId) {
			const existing = tx
				.prepare(
					`SELECT p.id FROM profile_identifiers pi
           JOIN profiles p ON p.id = pi.profile_id
           WHERE pi.scheme = 'finra_crd' AND pi.normalized_value = ? AND p.profile_type = 'firm'
           LIMIT 1`,
				)
				.get(clean) as { id?: string } | undefined;
			if (existing?.id) profileId = String(existing.id);
		}
		if (!profileId) {
			const created = upsertProfile(
				{
					profileType: 'firm',
					name: firmName,
					sourceCorpus: CORPUS,
					metadata: { finraCrd: clean },
				},
				tx,
			);
			profileId = created.id;
		}

		addIdentifier({ profileId, scheme: 'finra_crd', value: clean, sourceCorpus: CORPUS }, tx);

		const curRow = tx.prepare('SELECT metadata_json, summary, start_date FROM profiles WHERE id = ?').get(profileId) as
			| { metadata_json?: string; summary?: string; start_date?: string | null }
			| undefined;
		let prevMeta: Record<string, unknown> = {};
		try {
			prevMeta = curRow?.metadata_json ? (JSON.parse(curRow.metadata_json) as Record<string, unknown>) : {};
		} catch {
			prevMeta = {};
		}
		const prevCorpora = Array.isArray(prevMeta.corpora) ? prevMeta.corpora.map(String) : [];
		const nextCorpora = prevCorpora.includes(CORPUS) ? prevCorpora : [...prevCorpora, CORPUS];

		const stateList = Array.isArray(regs.stateList)
			? (regs.stateList as Array<Record<string, unknown>>).map((s) => String(s.state || '')).filter(Boolean)
			: [];
		const sroList = Array.isArray(regs.sroList)
			? (regs.sroList as Array<Record<string, unknown>>).map((s) => String(s.sro || '')).filter(Boolean)
			: [];

		const summaryParts = [`FINRA/SEC registered firm (CRD# ${clean})`];
		if (bi.firmType) summaryParts.push(String(bi.firmType));
		if (bi.formedState) summaryParts.push(`Formed in ${String(bi.formedState)}`);
		if (bi.bcScope) summaryParts.push(`BrokerCheck: ${String(bi.bcScope)}`);
		if (bi.iaScope) summaryParts.push(`IA: ${String(bi.iaScope)}`);
		if (approvedDate) summaryParts.push(`Approved ${approvedDate}`);

		updateProfileFields(
			profileId,
			{
				summary:
					curRow?.summary && curRow.summary.trim().length > summaryParts.join(' · ').length + 25
						? curRow.summary
						: summaryParts.join(' · '),
				startDate: curRow?.start_date || approvedDate || undefined,
				metadata: {
					...prevMeta,
					corpora: nextCorpora,
					finraCrd: clean,
					finraBcScope: bi.bcScope || prevMeta.finraBcScope || null,
					finraIaScope: bi.iaScope || prevMeta.finraIaScope || null,
					bdSecNumber: bi.bdSECNumber || prevMeta.bdSecNumber || null,
					iaSecNumber: bi.iaSECNumber || prevMeta.iaSecNumber || null,
					finraFirmType: bi.firmType || undefined,
					finraFormedState: bi.formedState || undefined,
					finraFirmSize: bi.firmSize || undefined,
					finraFirmStatus: bi.firmStatus || undefined,
					finraDistrict: bi.districtName || undefined,
					finraApprovedDate: approvedDate || undefined,
					finraPhone: firmAddr.businessPhoneNumber || undefined,
					finraDisclosureCount: disclosures.length || undefined,
					finraRegisteredStates: stateList.length ? stateList : undefined,
					finraRegisteredSROs: sroList.length ? sroList : undefined,
					hasFinraData:
						node.hasFinraData === true ||
						node.hasFinraData === false
							? node.hasFinraData
							: prevMeta.hasFinraData ?? Boolean(bi.bcScope),
					hasSecData:
						node.hasSecData === true || node.hasSecData === false
							? node.hasSecData
							: prevMeta.hasSecData ?? Boolean(bi.iaScope),
					finraVisualizerUrl: finraApiUrl(`/firm/${clean}`),
					finraLastSyncedAt: fetchedAt,
				},
			},
			tx,
		);

		// Aliases
		const otherNames = [
			...(Array.isArray(bi.otherNames) ? bi.otherNames.map(String) : []),
			typeof bi.iaFirmName === 'string' ? bi.iaFirmName : '',
		];
		for (const alt of otherNames) {
			const c = alt.replace(/\s+/g, ' ').trim();
			if (c && c.toLowerCase() !== firmName.toLowerCase()) {
				addAlias({ profileId, alias: c, aliasKind: 'former_name', confidence: 0.95, sourceCorpus: CORPUS }, tx);
				aliasesAdded += 1;
			}
		}

		// Locations (HQ + Mailing + IA office)
		const addLoc = (raw: string | null, role: 'hq' | 'branch') => {
			if (!raw) return;
			const parts = parseAddressParts(raw);
			addLocation(
				{
					profileId: profileId!,
					raw,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country,
					role,
					sourceCorpus: CORPUS,
				},
				tx,
			);
			locationsAdded += 1;
		};
		addLoc(officeAddr, 'hq');
		if (iaOfficeAddr && iaOfficeAddr !== officeAddr) addLoc(iaOfficeAddr, 'branch');
		if (mailingAddr && mailingAddr !== officeAddr && mailingAddr !== iaOfficeAddr) addLoc(mailingAddr, 'branch');

		const srId = upsertSourceRecord(
			{
				corpus: CORPUS,
				sourceRef: `finra:firm:${clean}:merged`,
				sourceUrl,
				title: `FINRA/SEC Firm Profile: ${firmName} (CRD# ${clean})`,
				excerpt: `${directOwners.length} direct owners/officers · ${disclosures.length} disclosures.`,
			},
			tx,
		);

		// Direct & Indirect Owners (Executives, Directors, Corporate Shareholders)
		for (const owner of [...directOwners, ...indirectOwners]) {
			const rawName = String(owner.legalName || owner.name || '').replace(/\s+/g, ' ').trim();
			if (!rawName) continue;
			const position = String(owner.position || owner.status || 'Direct Owner').replace(/\s+/g, ' ').trim();
			const ownerCrd = String(owner.crdNumber || owner.crd || '').replace(/\D/g, '');
			const isCorp = !ownerCrd && isCorporateOwnerName(rawName, position);

			let ownerProfileId: string | null = null;
			if (ownerCrd) {
				const foundOwner = tx
					.prepare(
						`SELECT p.id FROM profile_identifiers pi
             JOIN profiles p ON p.id = pi.profile_id
             WHERE pi.scheme = 'finra_crd' AND pi.normalized_value = ?
             LIMIT 1`,
					)
					.get(ownerCrd) as { id?: string } | undefined;
				if (foundOwner?.id) ownerProfileId = String(foundOwner.id);
			}

			if (!ownerProfileId) {
				const cleanName = isCorp ? rawName : normalizeOwnerPersonName(rawName);
				const created = upsertProfile(
					{
						profileType: isCorp ? 'firm' : 'person',
						name: cleanName,
						sourceCorpus: CORPUS,
						metadata: ownerCrd ? { finraCrd: ownerCrd } : {},
					},
					tx,
				);
				ownerProfileId = created.id;
				if (ownerCrd) {
					addIdentifier(
						{ profileId: ownerProfileId, scheme: 'finra_crd', value: ownerCrd, sourceCorpus: CORPUS },
						tx,
					);
				}
			}

			upsertProfileLink(
				{
					fromProfileId: ownerProfileId,
					toProfileId: profileId,
					relationType: isCorp ? 'business_tie' : 'employed_by',
					roleLabel: position,
					status: 'verified',
					confidence: 0.97,
					angle: 'regulatory_finra',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					evidenceNote: `status=current; direct_owner; position=${position}${ownerCrd ? `; CRD# ${ownerCrd}` : ''}`,
				},
				tx,
			);
			ownersLinked += 1;
		}

		// Timeline: FINRA approval date
		if (approvedDate) {
			upsertTimelineEntry(
				{
					profileId,
					eventDate: approvedDate,
					datePrecision: 'day',
					title: `FINRA Registration Approved: ${firmName}`,
					summary: `CRD# ${clean}${bi.formedState ? ` · Formed in ${String(bi.formedState)}` : ''}`,
					angle: 'regulatory_finra',
					entryKind: 'milestone',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `finra-firm-approved:${clean}:${approvedDate}`,
				},
				tx,
			);
			timelineAdded += 1;
		}

		// Timeline: top regulatory disclosures (cap 15 per firm)
		for (const disc of disclosures.slice(0, 15)) {
			const dType = String(disc.disclosureType || 'Regulatory Disclosure').trim();
			const dDate = parseFinraDate(disc.eventDate);
			const det = (disc.disclosureDetail || {}) as Record<string, unknown>;
			const initiatedBy = typeof det['Initiated By'] === 'string' ? det['Initiated By'] : '';
			const resolution = typeof det.Resolution === 'string' ? det.Resolution : '';
			const summary = [initiatedBy ? `Initiated by ${initiatedBy}` : '', resolution].filter(Boolean).join(' — ');
			upsertTimelineEntry(
				{
					profileId,
					eventDate: dDate,
					datePrecision: dDate ? 'day' : 'unknown',
					title: `FINRA ${dType}: ${firmName}`,
					summary: summary || `CRD# ${clean} disclosure record`,
					angle: 'regulatory_finra',
					entryKind: 'filing',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `finra-disc:${clean}:${dType}:${dDate || ''}:${initiatedBy.slice(0, 30)}`,
				},
				tx,
			);
			timelineAdded += 1;
		}
	});

	return {
		profileId: profileId!,
		firmName,
		locationsAdded,
		ownersLinked,
		aliasesAdded,
		timelineAdded,
	};
}

export async function ingestFirmDetailsFromVisualizer(
	firmCrd: string,
	opts?: { forceRefresh?: boolean; profileIdOverride?: string | null },
): Promise<IngestVisualizerFirmDetailResult> {
	const clean = String(firmCrd || '').replace(/\D/g, '');
	const sourceUrl = finraApiUrl(`/api/finra/merged/firm/${clean}`);
	const { snapshot, fromCache, changed } = await getCachedOrFetchVisualizerFirmDetail(clean, {
		forceRefresh: opts?.forceRefresh,
	});
	if (!snapshot || !snapshot.found || !snapshot.payload) {
		return {
			firmCrd: clean,
			found: false,
			fromCache,
			changed: false,
			profileId: null,
			firmName: null,
			locationsAdded: 0,
			ownersLinked: 0,
			aliasesAdded: 0,
			timelineAdded: 0,
			sourceUrl,
		};
	}

	const res = ingestFirmDetailPayloadIntoDb(
		clean,
		snapshot.payload,
		snapshot.sourceUrl,
		snapshot.fetchedAt,
		opts?.profileIdOverride,
	);
	return {
		firmCrd: clean,
		found: true,
		fromCache,
		changed,
		...res,
		sourceUrl: snapshot.sourceUrl,
	};
}

/**
 * Daily read-only change-check against https://finra-sec-data-visualizer-canvas.vercel.app.
 * Respects a 24-hour TTL per entity and only writes to SQLite + change_log.jsonl when changes are detected.
 */
export async function runDailyFinraChangeCheck(opts?: {
	force?: boolean;
	maxIndividuals?: number;
	maxFirms?: number;
	concurrency?: number;
}): Promise<{
	skippedReason?: string;
	checkedAt: string;
	individualsChecked: number;
	individualsChanged: number;
	firmsChecked: number;
	firmsChanged: number;
	changes: FinraChangeLogEntry[];
	durationMs: number;
}> {
	const t0 = Date.now();
	const state = readFinraSyncState();
	const nowIso = new Date().toISOString();

	if (!opts?.force && isFreshWithinDay(state.lastDailyRunAt)) {
		return {
			skippedReason: `Already ran daily check at ${state.lastDailyRunAt} (next check after 24h; pass force=true to override).`,
			checkedAt: nowIso,
			individualsChecked: 0,
			individualsChanged: 0,
			firmsChecked: 0,
			firmsChanged: 0,
			changes: [],
			durationMs: Date.now() - t0,
		};
	}

	ensureDirs();
	const db = getProfilesDb();
	const maxInds = Math.max(0, Math.min(5000, Math.floor(Number(opts?.maxIndividuals ?? 500))));
	const maxFirms = Math.max(0, Math.min(5000, Math.floor(Number(opts?.maxFirms ?? 250))));
	const concurrency = Math.max(1, Math.min(12, Math.floor(Number(opts?.concurrency ?? 6))));

	// 1. Collect tracked individuals (cached individuals + pinned FINRA people in DB)
	const trackedIndCrds = new Set<string>(Object.keys(state.individuals));
	const pinnedPeople = db
		.prepare(
			`SELECT pi.normalized_value AS crd
       FROM profiles p
       JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
       WHERE p.profile_type = 'person' AND p.status = 'pinned'
       LIMIT 500`,
		)
		.all() as Array<{ crd: string }>;
	for (const r of pinnedPeople) trackedIndCrds.add(String(r.crd));

	const dueIndividuals = [...trackedIndCrds]
		.filter((crd) => opts?.force || !isFreshWithinDay(state.individuals[crd]?.lastCheckedAt))
		.slice(0, maxInds);

	// 2. Collect tracked firms (cached firms + pinned FINRA firms + firms already synced)
	const trackedFirmCrds = new Set<string>(Object.keys(state.firms));
	const pinnedFirms = db
		.prepare(
			`SELECT pi.normalized_value AS crd
       FROM profiles p
       JOIN profile_identifiers pi ON pi.profile_id = p.id AND pi.scheme = 'finra_crd'
       WHERE p.profile_type = 'firm' AND p.status = 'pinned'
       LIMIT 250`,
		)
		.all() as Array<{ crd: string }>;
	for (const r of pinnedFirms) trackedFirmCrds.add(String(r.crd));

	const dueFirms = [...trackedFirmCrds]
		.filter((crd) => opts?.force || !isFreshWithinDay(state.firms[crd]?.lastCheckedAt))
		.slice(0, maxFirms);

	let individualsChecked = 0;
	let individualsChanged = 0;
	let firmsChecked = 0;
	let firmsChanged = 0;
	const newChanges: FinraChangeLogEntry[] = [];

	// Check due individuals
	let iIdx = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, dueIndividuals.length) }, async () => {
			while (true) {
				const k = iIdx++;
				if (k >= dueIndividuals.length) break;
				const crd = dueIndividuals[k];
				const res = await ingestIndividualFromVisualizer(crd, { forceRefresh: true });
				individualsChecked += 1;
				if (res.changed && res.found) individualsChanged += 1;
			}
		}),
	);

	// Check due firms (connections endpoint, strictly read-only GET)
	let fIdx = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, dueFirms.length) }, async () => {
			while (true) {
				const k = fIdx++;
				if (k >= dueFirms.length) break;
				const firmCrd = dueFirms[k];
				const url = finraApiUrl(`/api/finra/firm/${firmCrd}/connections`);
				const res = await readOnlyGetJson(url);
				firmsChecked += 1;
				if (!res.ok || !res.data) continue;

				const curArr = Array.isArray(res.data.currentConnections)
					? (res.data.currentConnections as Array<Record<string, unknown>>)
					: [];
				const prevArr = Array.isArray(res.data.previousConnections)
					? (res.data.previousConnections as Array<Record<string, unknown>>)
					: [];
				const curIds = curArr
					.map((r) => String(r.individualId || r.crd || '').replace(/\D/g, ''))
					.filter(Boolean)
					.sort();
				const prevIds = prevArr
					.map((r) => String(r.individualId || r.crd || '').replace(/\D/g, ''))
					.filter(Boolean)
					.sort();
				const nextHash = sha256({ curIds, prevIds });

				const cachePath = path.join(FIRM_CACHE_DIR, `${firmCrd}.json`);
				let prevSnap: LocalFirmConnectionsSnapshot | null = null;
				try {
					if (fs.existsSync(cachePath)) {
						prevSnap = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as LocalFirmConnectionsSnapshot;
					}
				} catch {
					prevSnap = null;
				}

				const changed = Boolean(prevSnap && prevSnap.contentHash !== nextHash);
				const mapRow = (r: Record<string, unknown>) => ({
					crd: String(r.individualId || r.crd || '').replace(/\D/g, ''),
					name: String(r.name || '').replace(/\s+/g, ' ').trim(),
					bcScope: typeof r.bcScope === 'string' ? r.bcScope : null,
					iaScope: typeof r.iaScope === 'string' ? r.iaScope : null,
					address: typeof r.address === 'string' ? r.address : null,
				});
				const nextSnap: LocalFirmConnectionsSnapshot = {
					firmCrd,
					found: res.data.found !== false,
					fetchedAt: nowIso,
					sourceUrl: url,
					contentHash: nextHash,
					currentCount: curIds.length,
					previousCount: prevIds.length,
					current: curArr.map(mapRow).filter((x) => x.crd && x.name),
					previous: prevArr.map(mapRow).filter((x) => x.crd && x.name),
				};
				fs.writeFileSync(cachePath, JSON.stringify(nextSnap));

				const curState = readFinraSyncState();
				curState.firms[firmCrd] = {
					lastCheckedAt: nowIso,
					contentHash: nextHash,
					currentCount: curIds.length,
					previousCount: prevIds.length,
					found: nextSnap.found,
				};
				writeFinraSyncState(curState);

				if (changed && prevSnap) {
					firmsChanged += 1;
					const prevCurSet = new Set(prevSnap.current.map((x) => x.crd));
					const nextCurSet = new Set(nextSnap.current.map((x) => x.crd));
					const addedCurrent = nextSnap.current.filter((x) => !prevCurSet.has(x.crd)).map((x) => `${x.name} (${x.crd})`);
					const leftCurrent = prevSnap.current.filter((x) => !nextCurSet.has(x.crd)).map((x) => `${x.name} (${x.crd})`);
					const entry: FinraChangeLogEntry = {
						detectedAt: nowIso,
						entityType: 'firm',
						crd: firmCrd,
						name: `Firm CRD# ${firmCrd}`,
						sourceUrl: url,
						summary: `Firm CRD# ${firmCrd} roster changed (+${addedCurrent.length} new current, -${leftCurrent.length} departed).`,
						details: { addedCurrent: addedCurrent.slice(0, 50), leftCurrent: leftCurrent.slice(0, 50) },
					};
					appendChangeLog(entry);
					newChanges.push(entry);
				}
			}
		}),
	);

	const finalState = readFinraSyncState();
	finalState.lastDailyRunAt = nowIso;
	writeFinraSyncState(finalState);

	return {
		checkedAt: nowIso,
		individualsChecked,
		individualsChanged,
		firmsChecked,
		firmsChanged,
		changes: newChanges,
		durationMs: Date.now() - t0,
	};
}
