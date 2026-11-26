/**
 * Normalize FINRA BrokerCheck / SEC IAPD disclosure records from the visualizer
 * merged/{individual|firm}/{crd} payload for profile overview display.
 */

import {
	getCachedOrFetchVisualizerFirmDetail,
	getCachedOrFetchVisualizerIndividual,
} from '@/lib/research/finraVisualizerMirror';
import { finraApiUrl } from '@/lib/research/finraApp';
import {
	eventsNeedPdfEnrichment,
	loadBrokercheckPdfDisclosures,
} from '@/lib/research/brokercheckPdfDisclosures';
import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import { normalizeIsoDate, sha256Key } from '@/lib/research/profiles/normalize';
import { upsertTimelineEntry } from '@/lib/research/profiles/store';
import type {
	FinraDisclosureDetailField,
	FinraDisclosureEvent,
	FinraDisclosureTypeCount,
	ProfileFinraDisclosures,
} from '@/lib/research/finraDisclosuresShared';

/** Cap returned PDF-backed firm events so the overview stays usable. */
const FIRM_PDF_EVENT_CAP = 60;
/** Cap dated disclosure rows written onto a firm timeline. */
const FIRM_TIMELINE_EVENT_CAP = 120;
const DISCLOSURE_TIMELINE_CORPUS = 'finra-brokercheck';

export type {
	FinraDisclosureDetailField,
	FinraDisclosureEvent,
	FinraDisclosureTypeCount,
	ProfileFinraDisclosures,
} from '@/lib/research/finraDisclosuresShared';
export { hasDisplayableDisclosures } from '@/lib/research/finraDisclosuresShared';

function flagYes(v: unknown): boolean | null {
	if (v == null || v === '') return null;
	const s = String(v).trim().toUpperCase();
	if (s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1') return true;
	if (s === 'N' || s === 'NO' || s === 'FALSE' || s === '0') return false;
	return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickStr(...vals: unknown[]): string | null {
	for (const v of vals) {
		if (typeof v === 'string' && v.trim()) return v.trim();
		if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	}
	return null;
}

function formatDetailValue(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === 'string') {
		const t = v.replace(/\r\n/g, '\n').trim();
		return t || null;
	}
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v)) {
		const parts = v
			.map((x) => formatDetailValue(x))
			.filter((x): x is string => Boolean(x));
		return parts.length ? parts.join('; ') : null;
	}
	if (typeof v === 'object') {
		try {
			return JSON.stringify(v);
		} catch {
			return null;
		}
	}
	return null;
}

const SKIP_DETAIL_KEYS = new Set([
	'displayaaolinkifexists',
	'arbitrationclaimfileddetail',
	'arbitrationdocketnumber',
]);

function detailFields(detail: unknown): FinraDisclosureDetailField[] {
	const rec = asRecord(detail);
	if (!rec) return [];
	const out: FinraDisclosureDetailField[] = [];
	for (const [k, v] of Object.entries(rec)) {
		if (SKIP_DETAIL_KEYS.has(k.toLowerCase())) continue;
		const value = formatDetailValue(v);
		if (!value) continue;
		out.push({ label: k, value });
	}
	return out;
}

function isDetailedEvent(row: Record<string, unknown>): boolean {
	return Boolean(
		row.eventDate ||
			row.disclosureResolution ||
			row.disclosureDetail ||
			(row.disclosureType && !('disclosureCount' in row)),
	) && !('disclosureCount' in row && !row.eventDate && !row.disclosureDetail);
}

function normalizeEvents(rows: unknown[], sources: Array<'finra' | 'sec'>): FinraDisclosureEvent[] {
	const out: FinraDisclosureEvent[] = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (!row) continue;
		if (!isDetailedEvent(row)) continue;
		const disclosureType = pickStr(row.disclosureType) || 'Disclosure';
		out.push({
			eventDate: pickStr(row.eventDate),
			disclosureType,
			resolution: pickStr(row.disclosureResolution, row.resolution),
			sources: [...sources],
			fields: detailFields(row.disclosureDetail),
		});
	}
	return out;
}

function normalizeTypeCounts(rows: unknown[]): FinraDisclosureTypeCount[] {
	const out: FinraDisclosureTypeCount[] = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (!row) continue;
		const disclosureType = pickStr(row.disclosureType);
		const countRaw = row.disclosureCount ?? row.count;
		const count =
			typeof countRaw === 'number' ? countRaw
			: typeof countRaw === 'string' && /^\d+$/.test(countRaw.trim()) ? Number(countRaw.trim())
			: null;
		if (!disclosureType || count == null || count <= 0) continue;
		out.push({ disclosureType, count });
	}
	return out;
}

function eventDedupeKey(e: FinraDisclosureEvent): string {
	return [
		e.eventDate || '',
		e.disclosureType,
		e.resolution || '',
		e.fields.find((f) => /allegation/i.test(f.label))?.value?.slice(0, 80) || '',
	].join('|');
}

function mergeEvents(a: FinraDisclosureEvent[], b: FinraDisclosureEvent[]): FinraDisclosureEvent[] {
	const map = new Map<string, FinraDisclosureEvent>();
	for (const e of [...a, ...b]) {
		const k = eventDedupeKey(e);
		const prev = map.get(k);
		if (!prev) {
			map.set(k, e);
			continue;
		}
		const sources = Array.from(new Set([...prev.sources, ...e.sources])) as Array<'finra' | 'sec'>;
		const fields =
			prev.fields.length >= e.fields.length ? prev.fields
			: e.fields.length ? e.fields
			: prev.fields;
		map.set(k, { ...prev, sources, fields });
	}
	return [...map.values()].sort((x, y) => {
		const dx = x.eventDate || '';
		const dy = y.eventDate || '';
		if (dx && dy) {
			// MM/DD/YYYY or ISO — prefer lexicographic reverse after normalizing year-first when possible
			const nx = normalizeSortDate(dx);
			const ny = normalizeSortDate(dy);
			if (nx !== ny) return ny.localeCompare(nx);
		}
		if (dx && !dy) return -1;
		if (!dx && dy) return 1;
		return x.disclosureType.localeCompare(y.disclosureType);
	});
}

function normalizeSortDate(raw: string): string {
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const mdY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
	if (mdY) {
		return `${mdY[3]}-${mdY[1].padStart(2, '0')}-${mdY[2].padStart(2, '0')}`;
	}
	return raw;
}

function extractFromNode(
	node: Record<string, unknown> | null | undefined,
	defaultSources: Array<'finra' | 'sec'>,
): {
	finraFlag: boolean | null;
	secFlag: boolean | null;
	events: FinraDisclosureEvent[];
	typeCounts: FinraDisclosureTypeCount[];
} {
	if (!node) {
		return { finraFlag: null, secFlag: null, events: [], typeCounts: [] };
	}
	const finraFlag = flagYes(
		node.disclosureFlag ?? node.bdDisclosureFlag ?? node.bcDisclosureFlag,
	);
	const secFlag = flagYes(node.iaDisclosureFlag ?? node.secDisclosureFlag);
	const discRows = Array.isArray(node.disclosures) ? node.disclosures : [];
	const events = normalizeEvents(discRows, defaultSources);
	const typeCountsFromDisc = events.length ? [] : normalizeTypeCounts(discRows);
	const iaRollup = Array.isArray(node.iaDisclosures) ? normalizeTypeCounts(node.iaDisclosures) : [];
	const typeCounts = [...typeCountsFromDisc];
	for (const c of iaRollup) {
		if (!typeCounts.some((t) => t.disclosureType === c.disclosureType)) typeCounts.push(c);
	}
	return { finraFlag, secFlag, events, typeCounts };
}

function digSourceContent(
	sources: Record<string, unknown> | null | undefined,
	key: 'finra' | 'sec',
): Record<string, unknown> | null {
	const side = asRecord(sources?.[key]);
	if (!side) return null;
	// Individual: sources.finra.bccontent / sources.sec.iacontent
	const bc = asRecord(side.bccontent);
	if (bc) return bc;
	const ia = asRecord(side.iacontent);
	if (ia) return ia;
	// Firm: disclosures live on the side object itself
	if (Array.isArray(side.disclosures) || side.bdDisclosureFlag != null || side.iaDisclosureFlag != null) {
		return side;
	}
	return side;
}

function fieldMap(fields: FinraDisclosureDetailField[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const f of fields) {
		const k = f.label.trim().toLowerCase();
		if (!k || m.has(k)) continue;
		m.set(k, f.value);
	}
	return m;
}

function enrichEventFromPdf(api: FinraDisclosureEvent, pdf: FinraDisclosureEvent): FinraDisclosureEvent {
	const apiMap = fieldMap(api.fields);
	const mergedFields = [...api.fields];
	for (const f of pdf.fields) {
		const k = f.label.trim().toLowerCase();
		const existing = apiMap.get(k);
		if (existing && existing.trim().length >= f.value.trim().length) continue;
		if (existing) {
			const idx = mergedFields.findIndex((x) => x.label.trim().toLowerCase() === k);
			if (idx >= 0) mergedFields[idx] = f;
			else mergedFields.push(f);
		} else {
			mergedFields.push(f);
		}
		apiMap.set(k, f.value);
	}
	return {
		...api,
		eventDate: api.eventDate || pdf.eventDate,
		resolution: api.resolution || pdf.resolution,
		sources: Array.from(new Set([...api.sources, ...pdf.sources])) as Array<'finra' | 'sec'>,
		fields: mergedFields,
	};
}

function softMatchPdfEvent(api: FinraDisclosureEvent, pdf: FinraDisclosureEvent): boolean {
	if (api.disclosureType.toLowerCase() !== pdf.disclosureType.toLowerCase()) return false;
	const aAlleg = api.fields.find((f) => /allegation/i.test(f.label))?.value?.slice(0, 60).toLowerCase() || '';
	const pAlleg = pdf.fields.find((f) => /allegation/i.test(f.label))?.value?.slice(0, 60).toLowerCase() || '';
	if (aAlleg && pAlleg && (aAlleg.includes(pAlleg.slice(0, 40)) || pAlleg.includes(aAlleg.slice(0, 40)))) {
		return true;
	}
	const ad = normalizeSortDate(api.eventDate || '');
	const pd = normalizeSortDate(pdf.eventDate || '');
	if (ad && pd && ad === pd) return true;
	if (api.resolution && pdf.resolution && api.resolution.toLowerCase() === pdf.resolution.toLowerCase() && ad && pd) {
		return ad === pd;
	}
	return false;
}

function mergeApiWithPdfEvents(
	apiEvents: FinraDisclosureEvent[],
	pdfEvents: FinraDisclosureEvent[],
): FinraDisclosureEvent[] {
	if (!pdfEvents.length) return apiEvents;
	if (!apiEvents.length) return pdfEvents;

	const usedPdf = new Set<number>();
	const out: FinraDisclosureEvent[] = apiEvents.map((api) => {
		const idx = pdfEvents.findIndex((p, i) => !usedPdf.has(i) && softMatchPdfEvent(api, p));
		if (idx < 0) return api;
		usedPdf.add(idx);
		return enrichEventFromPdf(api, pdfEvents[idx]!);
	});

	// If API was thin counts-only path we already returned early; here only add unmatched PDF
	// rows when API had fewer detailed events than PDF (e.g. missing one).
	if (out.length < pdfEvents.length && out.every((e) => e.fields.some((f) => /allegation/i.test(f.label)))) {
		for (let i = 0; i < pdfEvents.length; i++) {
			if (usedPdf.has(i)) continue;
			out.push(pdfEvents[i]!);
		}
	}
	return mergeEvents(out, []);
}

async function maybeEnrichFromPdf(input: {
	crd: string;
	crdKind: 'individual' | 'firm';
	forceRefresh?: boolean;
	events: FinraDisclosureEvent[];
	typeCounts: FinraDisclosureTypeCount[];
	finraFlag: boolean | null;
}): Promise<{
	events: FinraDisclosureEvent[];
	fromPdf: boolean;
	pdfUrl: string | null;
	eventsTotal: number | null;
}> {
	const wantsPdf =
		input.forceRefresh ||
		eventsNeedPdfEnrichment(input.events) ||
		(input.events.length === 0 &&
			(input.typeCounts.some((t) => t.count > 0) || input.finraFlag === true));

	if (!wantsPdf) {
		return { events: input.events, fromPdf: false, pdfUrl: null, eventsTotal: null };
	}

	const pdf = await loadBrokercheckPdfDisclosures({
		crd: input.crd,
		crdKind: input.crdKind,
		forceRefresh: input.forceRefresh,
	});
	if (!pdf.ok || !pdf.events.length) {
		return {
			events: input.events,
			fromPdf: false,
			pdfUrl: pdf.pdfUrl || null,
			eventsTotal: null,
		};
	}

	let events =
		input.events.length === 0 ? pdf.events : mergeApiWithPdfEvents(input.events, pdf.events);

	let eventsTotal: number | null = null;
	if (input.crdKind === 'firm' && events.length > FIRM_PDF_EVENT_CAP) {
		eventsTotal = events.length;
		events = events.slice(0, FIRM_PDF_EVENT_CAP);
	}

	return {
		events,
		fromPdf: true,
		pdfUrl: pdf.pdfUrl,
		eventsTotal,
	};
}

export async function loadProfileFinraDisclosures(input: {
	crd: string;
	crdKind: 'individual' | 'firm';
	forceRefresh?: boolean;
}): Promise<ProfileFinraDisclosures> {
	const clean = String(input.crd || '').replace(/\D/g, '');
	const crdKind = input.crdKind;
	const empty = (extra?: Partial<ProfileFinraDisclosures>): ProfileFinraDisclosures => ({
		ok: true,
		crd: clean,
		crdKind,
		found: false,
		fromCache: false,
		hasFinraData: false,
		hasSecData: false,
		finraDisclosureFlag: null,
		secDisclosureFlag: null,
		events: [],
		typeCounts: [],
		dashboardUrl:
			crdKind === 'firm' ?
				finraApiUrl(`/dashboard/firm/${clean}?disable_analytics=1`)
			:	finraApiUrl(`/dashboard/individual/${clean}?disable_analytics=1`),
		brokercheckUrl:
			crdKind === 'firm' ?
				`https://brokercheck.finra.org/firm/summary/${clean}`
			:	`https://brokercheck.finra.org/individual/summary/${clean}`,
		brokercheckPdfUrl:
			crdKind === 'firm' ?
				`https://files.brokercheck.finra.org/firm/firm_${clean}.pdf`
			:	`https://files.brokercheck.finra.org/individual/individual_${clean}.pdf`,
		fromPdf: false,
		eventsTotal: null,
		adviserInfoUrl:
			crdKind === 'firm' ?
				`https://adviserinfo.sec.gov/firm/summary/${clean}`
			:	`https://adviserinfo.sec.gov/individual/summary/${clean}`,
		sourceUrl:
			crdKind === 'firm' ?
				finraApiUrl(`/api/finra/merged/firm/${clean}`)
			:	finraApiUrl(`/api/finra/merged/individual/${clean}`),
		...extra,
	});

	if (!clean) return empty();

	if (crdKind === 'firm') {
		const { snapshot, fromCache } = await getCachedOrFetchVisualizerFirmDetail(clean, {
			forceRefresh: input.forceRefresh,
		});
		if (!snapshot?.found || !snapshot.payload) {
			return empty({ fromCache, sourceUrl: snapshot?.sourceUrl || empty().sourceUrl });
		}
		const payload = snapshot.payload;
		const fromNode = extractFromNode(payload, ['finra']);
		const finraFlag = fromNode.finraFlag;
		const secFlag = fromNode.secFlag ?? flagYes(payload.iaDisclosureFlag);
		const hasFinraData = payload.hasFinraData !== false;
		const hasSecData = Boolean(payload.hasSecData);
		const typeCounts = fromNode.typeCounts;
		const enriched = await maybeEnrichFromPdf({
			crd: clean,
			crdKind: 'firm',
			forceRefresh: input.forceRefresh,
			events: fromNode.events,
			typeCounts,
			finraFlag,
		});
		return {
			...empty({
				found: true,
				fromCache: fromCache && !enriched.fromPdf,
				hasFinraData,
				hasSecData,
				finraDisclosureFlag: finraFlag,
				secDisclosureFlag: secFlag,
				events: enriched.events,
				typeCounts,
				fromPdf: enriched.fromPdf,
				brokercheckPdfUrl: enriched.pdfUrl,
				eventsTotal: enriched.eventsTotal,
				sourceUrl: snapshot.sourceUrl,
			}),
		};
	}

	const { snapshot, fromCache } = await getCachedOrFetchVisualizerIndividual(clean, {
		forceRefresh: input.forceRefresh,
	});
	if (!snapshot?.found || !snapshot.payload) {
		return empty({ fromCache, sourceUrl: snapshot?.sourceUrl || empty().sourceUrl });
	}

	const payload = snapshot.payload;
	const fromMerged = extractFromNode(payload, ['finra', 'sec']);

	// Also pull side-specific copies when the live response was stored with sources
	// (cached payload is usually the merged node only — that's fine).
	let finraEvents = fromMerged.events;
	let secEvents: FinraDisclosureEvent[] = [];
	let finraFlag = fromMerged.finraFlag;
	let secFlag = fromMerged.secFlag;
	let typeCounts = fromMerged.typeCounts;

	// If payload still has nested sources (rare on cache), merge them.
	const sources = asRecord(payload.sources);
	if (sources) {
		const finraContent = digSourceContent(sources, 'finra');
		const secContent = digSourceContent(sources, 'sec');
		const fromFinra = extractFromNode(finraContent, ['finra']);
		const fromSec = extractFromNode(secContent, ['sec']);
		finraEvents = mergeEvents(finraEvents, fromFinra.events);
		secEvents = fromSec.events;
		finraFlag = finraFlag ?? fromFinra.finraFlag;
		secFlag = secFlag ?? fromSec.secFlag;
		if (!typeCounts.length) typeCounts = fromFinra.typeCounts.length ? fromFinra.typeCounts : fromSec.typeCounts;
	}

	const mergedEvents = mergeEvents(finraEvents, secEvents);
	const enriched = await maybeEnrichFromPdf({
		crd: clean,
		crdKind: 'individual',
		forceRefresh: input.forceRefresh,
		events: mergedEvents,
		typeCounts,
		finraFlag,
	});

	return {
		...empty({
			found: true,
			fromCache: fromCache && !enriched.fromPdf,
			hasFinraData: payload.hasFinraData !== false,
			hasSecData: Boolean(payload.hasSecData) || secFlag === true || secEvents.length > 0,
			finraDisclosureFlag: finraFlag,
			secDisclosureFlag: secFlag,
			events: enriched.events,
			typeCounts,
			fromPdf: enriched.fromPdf,
			brokercheckPdfUrl: enriched.pdfUrl,
			eventsTotal: enriched.eventsTotal,
			sourceUrl: snapshot.sourceUrl,
		}),
	};
}

function fieldValue(fields: FinraDisclosureDetailField[], ...labels: string[]): string | null {
	const wanted = labels.map((l) => l.toLowerCase());
	for (const f of fields) {
		const lab = f.label.trim().toLowerCase();
		if (wanted.some((w) => lab === w || lab.startsWith(w))) {
			const v = f.value.trim();
			if (v) return v;
		}
	}
	return null;
}

function disclosureTimelineTitle(ev: FinraDisclosureEvent, profileName?: string | null): string {
	const bits = ['BrokerCheck', ev.disclosureType];
	if (ev.resolution) bits.push(ev.resolution);
	const base = bits.join(' — ');
	const name = String(profileName || '').trim();
	if (name && name.length <= 48) return `${base}: ${name}`;
	return base;
}

function disclosureTimelineSummary(ev: FinraDisclosureEvent, crd: string): string {
	const parts: string[] = [];
	const alleg = fieldValue(ev.fields, 'allegations');
	if (alleg) parts.push(alleg.length > 420 ? `${alleg.slice(0, 417)}…` : alleg);

	const moneyBits = [
		fieldValue(ev.fields, 'settlement amount') ?
			`Settlement ${fieldValue(ev.fields, 'settlement amount')}`
		:	null,
		fieldValue(ev.fields, 'relief awarded') ? `Awarded ${fieldValue(ev.fields, 'relief awarded')}` : null,
		fieldValue(ev.fields, 'sanctions ordered'),
		fieldValue(ev.fields, 'sanction details'),
	].filter(Boolean);
	if (moneyBits.length) parts.push(moneyBits.join(' · '));

	const metaBits = [
		fieldValue(ev.fields, 'employing firm') ? `Firm: ${fieldValue(ev.fields, 'employing firm')}` : null,
		fieldValue(ev.fields, 'product type') ? `Product: ${fieldValue(ev.fields, 'product type')}` : null,
		fieldValue(ev.fields, 'initiated by') ? `Initiated by ${fieldValue(ev.fields, 'initiated by')}` : null,
		fieldValue(ev.fields, 'docket/case number', 'case number') ?
			`Case ${fieldValue(ev.fields, 'docket/case number', 'case number')}`
		:	null,
	].filter(Boolean);
	if (metaBits.length) parts.push(metaBits.join(' · '));

	parts.push(`CRD# ${crd}`);
	return parts.join('\n').slice(0, 2000);
}

function clearUndatedDisclosureStubs(profileId: string): number {
	const db = getProfilesDb();
	const result = db
		.prepare(
			`DELETE FROM timeline_entries
       WHERE profile_id = ?
         AND angle = 'regulatory_finra'
         AND entry_kind = 'filing'
         AND event_date IS NULL
         AND (
           title LIKE 'FINRA Regulatory Event:%'
           OR title LIKE 'FINRA Civil Event:%'
           OR title LIKE 'FINRA Arbitration:%'
           OR title LIKE 'FINRA Customer Dispute:%'
           OR (summary LIKE '%disclosure record%' AND title LIKE 'FINRA %')
         )`,
		)
		.run(profileId);
	return Number(result.changes || 0);
}

/**
 * Write dated BrokerCheck / IAPD disclosure events onto the profile timeline.
 * Skips undated rows; upserts by stable dedupe key so reloads are idempotent.
 */
export function ingestFinraDisclosureEventsToTimeline(input: {
	profileId: string;
	crd: string;
	crdKind: 'individual' | 'firm';
	profileName?: string | null;
	events: FinraDisclosureEvent[];
	sourceCorpus?: string;
	maxEvents?: number;
}): {
	added: number;
	updated: number;
	skippedUndated: number;
	clearedStubs: number;
	written: number;
} {
	const profileId = String(input.profileId || '').trim();
	const crd = String(input.crd || '').replace(/\D/g, '');
	const corpus = input.sourceCorpus || DISCLOSURE_TIMELINE_CORPUS;
	if (!profileId || !crd || !input.events?.length) {
		return { added: 0, updated: 0, skippedUndated: 0, clearedStubs: 0, written: 0 };
	}

	const clearedStubs = clearUndatedDisclosureStubs(profileId);

	const dated = input.events
		.map((ev) => {
			const iso = normalizeIsoDate(ev.eventDate).date;
			return { ev, iso };
		})
		.filter((x): x is { ev: FinraDisclosureEvent; iso: string } => Boolean(x.iso))
		.sort((a, b) => b.iso.localeCompare(a.iso));

	const skippedUndated = input.events.length - dated.length;
	const cap =
		input.maxEvents ??
		(input.crdKind === 'firm' ? FIRM_TIMELINE_EVENT_CAP : Math.max(dated.length, 40));
	const slice = dated.slice(0, cap);

	let added = 0;
	let updated = 0;

	withProfilesTransaction((db) => {
		for (const { ev, iso } of slice) {
			const alleg = fieldValue(ev.fields, 'allegations') || '';
			const caseNo = fieldValue(ev.fields, 'docket/case number', 'case number') || '';
			const dedupeHint = [
				'finra-disclosure',
				crd,
				ev.disclosureType,
				iso,
				ev.resolution || '',
				caseNo.slice(0, 40),
				alleg.slice(0, 80),
			].join(':');

			const dedupeKey = sha256Key([profileId, corpus, iso, dedupeHint]);
			const before = db
				.prepare('SELECT id FROM timeline_entries WHERE dedupe_key = ?')
				.get(dedupeKey) as { id?: string } | undefined;

			upsertTimelineEntry(
				{
					profileId,
					eventDate: iso,
					datePrecision: 'day',
					title: disclosureTimelineTitle(ev, input.profileName),
					summary: disclosureTimelineSummary(ev, crd),
					angle: 'regulatory_finra',
					entryKind: 'filing',
					sourceCorpus: corpus,
					dedupeHint,
					metadata: {
						kind: 'finra_disclosure',
						crd,
						crdKind: input.crdKind,
						disclosureType: ev.disclosureType,
						resolution: ev.resolution,
						sources: ev.sources,
					},
					confidence: 0.95,
				},
				db,
			);
			if (before?.id) updated += 1;
			else added += 1;
		}
	});

	return {
		added,
		updated,
		skippedUndated,
		clearedStubs,
		written: slice.length,
	};
}

/**
 * Prefer full PDF event list for timeline when the overview response was capped.
 */
export async function loadDisclosureEventsForTimeline(input: {
	crd: string;
	crdKind: 'individual' | 'firm';
	overview: ProfileFinraDisclosures;
}): Promise<FinraDisclosureEvent[]> {
	const overview = input.overview;
	if (!overview.found) return [];
	const capped =
		overview.eventsTotal != null && overview.eventsTotal > overview.events.length;
	if (!capped && overview.events.length > 0) return overview.events;

	const pdf = await loadBrokercheckPdfDisclosures({
		crd: input.crd,
		crdKind: input.crdKind,
	});
	if (pdf.ok && pdf.events.length) return pdf.events;
	return overview.events;
}

