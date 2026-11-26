/**
 * Mirror person employment / registration spans onto timeline_entries so the
 * Timeline tab can render career chapters that nest exams & disclosures.
 */

import { getProfilesDb, withProfilesTransaction } from '@/lib/research/profiles/db';
import { normalizeIsoDate } from '@/lib/research/profiles/normalize';
import { upsertTimelineEntry } from '@/lib/research/profiles/store';
import type { ProfileRelationType, ProfileType } from '@/lib/research/profiles/types';

const EMPLOYMENT_RELS = new Set([
	'employed_by',
	'registered_at',
	'alumni_or_faculty',
	'affiliated_with',
	'business_tie',
]);

const ORG_TYPES = new Set([
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
]);

const SPAN_CORPUS = 'employment-span';
const SPAN_KIND = 'employment_span';

type EmpRow = {
	linkId: string;
	orgProfileId: string;
	orgName: string;
	orgSlug: string | null;
	orgType: ProfileType;
	relationType: ProfileRelationType;
	roleLabel: string | null;
	startDate: string | null;
	endDate: string | null;
	evidenceNote: string;
	sourceCorpus: string;
};

function parseIso(raw: string | null | undefined): string | null {
	if (!raw) return null;
	return normalizeIsoDate(raw).date || (/^\d{4}$/.test(raw.trim()) ? raw.trim() : null);
}

function isCurrentEmp(role: string | null, note: string, endDate: string | null): boolean {
	if (/current/i.test(role || '') || /status=current/i.test(note)) return true;
	if (/previous|former/i.test(role || '') || /status=previous/i.test(note) || endDate) return false;
	return !endDate;
}

function branchFromNote(note: string): string | null {
	const m = note.match(/branch=([^;]+)/i);
	return m ? m[1]!.trim() : null;
}

function firmCrdFromNote(note: string): string | null {
	const m = note.match(/firmCrd=(\d+)/i);
	return m ? m[1]!.trim() : null;
}

function spanTitle(
	orgName: string,
	isCurrent: boolean,
	relationType: string,
	roleLabel?: string | null,
): string {
	const role = String(roleLabel || '').trim();
	const suffix = isCurrent ? ' (current)' : '';
	if (role) return `${role} at ${orgName}${suffix}`;
	const verb =
		relationType === 'registered_at' ? 'Registered at'
		: relationType === 'alumni_or_faculty' ? 'At'
		: relationType === 'affiliated_with' ? 'Affiliated with'
		: 'Employed at';
	return `${verb} ${orgName}${suffix}`;
}

function spanSummary(input: {
	start: string;
	end: string | null;
	isCurrent: boolean;
	location: string | null;
	firmCrd: string | null;
	role: string | null;
}): string {
	const parts: string[] = [];
	const startLabel = input.start;
	const endLabel = input.isCurrent || !input.end ? 'Present' : input.end;
	parts.push(`${startLabel} → ${endLabel}`);
	if (input.location) parts.push(input.location);
	if (input.role) parts.push(input.role);
	if (input.firmCrd) parts.push(`Firm CRD# ${input.firmCrd}`);
	return parts.join(' · ');
}

function loadEmploymentRows(profileId: string): EmpRow[] {
	const db = getProfilesDb();
	const rows = db
		.prepare(
			`SELECT
         pl.id AS link_id,
         pl.relation_type,
         pl.role_label,
         pl.start_date,
         pl.end_date,
         pl.evidence_note,
         pl.source_corpus,
         pl.from_profile_id,
         pl.to_profile_id,
         pf.name AS from_name,
         pf.slug AS from_slug,
         pf.profile_type AS from_type,
         pt.name AS to_name,
         pt.slug AS to_slug,
         pt.profile_type AS to_type
       FROM profile_links pl
       JOIN profiles pf ON pf.id = pl.from_profile_id
       JOIN profiles pt ON pt.id = pl.to_profile_id
       WHERE pl.from_profile_id = ? OR pl.to_profile_id = ?`,
		)
		.all(profileId, profileId) as Array<Record<string, unknown>>;

	const out: EmpRow[] = [];
	for (const r of rows) {
		const fromId = String(r.from_profile_id || '');
		const isOut = fromId === profileId;
		const peerId = isOut ? String(r.to_profile_id || '') : String(r.from_profile_id || '');
		const peerName = isOut ? String(r.to_name || '') : String(r.from_name || '');
		const peerSlug = isOut ? (r.to_slug ? String(r.to_slug) : null) : r.from_slug ? String(r.from_slug) : null;
		const peerType = (isOut ? String(r.to_type || '') : String(r.from_type || '')) as ProfileType;
		const relationType = String(r.relation_type || '') as ProfileRelationType;
		if (!ORG_TYPES.has(peerType)) continue;
		if (!EMPLOYMENT_RELS.has(relationType)) continue;
		// Prefer firm registrations / jobs over loose affiliations when undated noise
		out.push({
			linkId: String(r.link_id || ''),
			orgProfileId: peerId,
			orgName: peerName || 'Unknown organization',
			orgSlug: peerSlug,
			orgType: peerType,
			relationType,
			roleLabel: r.role_label != null ? String(r.role_label) : null,
			startDate: r.start_date != null ? String(r.start_date) : null,
			endDate: r.end_date != null ? String(r.end_date) : null,
			evidenceNote: String(r.evidence_note || ''),
			sourceCorpus: String(r.source_corpus || ''),
		});
	}
	return out;
}

/**
 * Replace employment_span timeline rows for a person from their org links.
 * Idempotent: clears prior span rows for the profile, then upserts current ones.
 */
export function syncEmploymentSpansToTimeline(profileId: string): {
	written: number;
	skippedUndated: number;
	cleared: number;
} {
	const id = String(profileId || '').trim();
	if (!id) return { written: 0, skippedUndated: 0, cleared: 0 };

	const rows = loadEmploymentRows(id);
	let skippedUndated = 0;
	const spans: Array<{
		row: EmpRow;
		start: string;
		end: string | null;
		isCurrent: boolean;
	}> = [];

	const seen = new Set<string>();
	for (const row of rows) {
		const start = parseIso(row.startDate);
		if (!start) {
			skippedUndated += 1;
			continue;
		}
		const end = parseIso(row.endDate);
		const isCurrent = isCurrentEmp(row.roleLabel, row.evidenceNote, end);
		const key = `${row.orgProfileId}|${start}|${end || ''}|${row.relationType}`;
		if (seen.has(key)) continue;
		seen.add(key);
		spans.push({ row, start, end, isCurrent });
	}

	let cleared = 0;
	let written = 0;

	withProfilesTransaction((db) => {
		const del = db
			.prepare(
				`DELETE FROM timeline_entries
         WHERE profile_id = ?
           AND entry_kind = 'employment'
           AND (
             source_corpus = ?
             OR metadata_json LIKE '%"kind":"employment_span"%'
             OR metadata_json LIKE '%"kind": "employment_span"%'
           )`,
			)
			.run(id, SPAN_CORPUS);
		cleared = Number(del.changes || 0);

		for (const span of spans) {
			const location = branchFromNote(span.row.evidenceNote);
			const firmCrd = firmCrdFromNote(span.row.evidenceNote);
			const title = spanTitle(
				span.row.orgName,
				span.isCurrent,
				span.row.relationType,
				span.row.roleLabel,
			);
			const summary = spanSummary({
				start: span.start,
				end: span.end,
				isCurrent: span.isCurrent,
				location,
				firmCrd,
				role: span.row.roleLabel,
			});
			const dedupeHint = [
				'employment-span',
				span.row.orgProfileId,
				span.start,
				span.end || 'present',
				span.row.relationType,
			].join(':');

			upsertTimelineEntry(
				{
					profileId: id,
					eventDate: span.start,
					endDate: span.isCurrent ? null : span.end,
					datePrecision: span.end || span.isCurrent ? 'range' : 'day',
					title,
					summary,
					angle: span.row.orgType === 'education' ? 'academic_research' : 'corporate',
					entryKind: 'employment',
					sourceCorpus: SPAN_CORPUS,
					geoLabel: location,
					dedupeHint,
					metadata: {
						kind: SPAN_KIND,
						linkId: span.row.linkId,
						orgProfileId: span.row.orgProfileId,
						orgSlug: span.row.orgSlug,
						orgName: span.row.orgName,
						orgType: span.row.orgType,
						relationType: span.row.relationType,
						roleLabel: span.row.roleLabel,
						firmCrd,
						isCurrent: span.isCurrent,
					},
					confidence: 0.9,
				},
				db,
			);
			written += 1;
		}
	});

	return { written, skippedUndated, cleared };
}

export function isEmploymentSpanEntry(entry: {
	entryKind?: string | null;
	metadata?: Record<string, unknown> | null;
}): boolean {
	if (String(entry.entryKind || '') === 'employment') return true;
	return String(entry.metadata?.kind || '') === SPAN_KIND;
}
