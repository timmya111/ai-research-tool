import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { detectProfileCountryCodes } from '@/lib/research/profiles/countries';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	buildSafeFtsQuery,
	deduplicateLocations,
	isTooGenericLocation,
	makeProfileSlug,
	normalizeIsoDate,
	normalizeLocationRecord,
	normalizeText,
	sha256Key,
} from '@/lib/research/profiles/normalize';
import { getProfilesDir } from '@/lib/research/profiles/paths';
import {
	PROFILE_TYPES,
	type AliasKind,
	type AlignmentCandidate,
	type AlignmentEvidenceItem,
	type AlignmentKind,
	type AlignmentStatus,
	type CautionTier,
	type DatePrecision,
	type IdentifierScheme,
	type LinkStatus,
	type LocationRole,
	type PersonEmploymentEntry,
	type Profile,
	type ProfileAlias,
	type ProfileDetail,
	type ProfileIdentifier,
	type ProfileLink,
	type ProfileLocation,
	type ProfileRelationType,
	type ProfileStats,
	type ProfileStatus,
	type ProfileType,
	type TimelineAngle,
	type TimelineEntry,
	type TimelineEntryKind,
} from '@/lib/research/profiles/types';

function safeJsonParse<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== 'string' || !raw.trim()) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function rowToProfile(r: Record<string, unknown>): Profile {
	return {
		id: String(r.id),
		slug: String(r.slug),
		profileType: String(r.profile_type) as ProfileType,
		name: String(r.name),
		normalizedName: String(r.normalized_name),
		status: String(r.status || 'active') as ProfileStatus,
		summary: String(r.summary || ''),
		startDate: r.start_date != null ? String(r.start_date) : null,
		endDate: r.end_date != null ? String(r.end_date) : null,
		metadata: safeJsonParse<Record<string, unknown>>(r.metadata_json, {}),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	};
}

function rowToTimeline(r: Record<string, unknown>): TimelineEntry {
	return {
		id: String(r.id),
		dedupeKey: String(r.dedupe_key),
		profileId: String(r.profile_id),
		eventDate: r.event_date != null ? String(r.event_date) : null,
		datePrecision: String(r.date_precision || 'day') as DatePrecision,
		endDate: r.end_date != null ? String(r.end_date) : null,
		title: String(r.title),
		summary: String(r.summary || ''),
		angle: String(r.angle || 'general') as TimelineAngle,
		entryKind: String(r.entry_kind || 'event') as TimelineEntryKind,
		geoKey: r.geo_key != null ? String(r.geo_key) : null,
		geoLabel: r.geo_label != null ? String(r.geo_label) : null,
		confidence: Number(r.confidence ?? 1),
		sourceCorpus: String(r.source_corpus),
		sourceRecordId: r.source_record_id != null ? String(r.source_record_id) : null,
		sourceUrl: r.source_url != null ? String(r.source_url) : null,
		sourceRef: r.source_ref != null ? String(r.source_ref) : null,
		originProfileId: r.origin_profile_id != null ? String(r.origin_profile_id) : undefined,
		originProfileName: r.origin_profile_name != null ? String(r.origin_profile_name) : undefined,
		originProfileType:
			r.origin_profile_type != null ? (String(r.origin_profile_type) as ProfileType) : undefined,
		metadata: safeJsonParse<Record<string, unknown>>(r.metadata_json, {}),
		createdAt: String(r.created_at),
	};
}

function rowToLink(r: Record<string, unknown>): ProfileLink {
	return {
		id: String(r.id),
		dedupeKey: String(r.dedupe_key),
		fromProfileId: String(r.from_profile_id),
		toProfileId: String(r.to_profile_id),
		relationType: String(r.relation_type) as ProfileRelationType,
		roleLabel: r.role_label != null ? String(r.role_label) : null,
		startDate: r.start_date != null ? String(r.start_date) : null,
		endDate: r.end_date != null ? String(r.end_date) : null,
		status: String(r.status || 'observed') as LinkStatus,
		confidence: Number(r.confidence ?? 0.8),
		angle: String(r.angle || 'general') as TimelineAngle,
		sourceCorpus: String(r.source_corpus),
		sourceRecordId: r.source_record_id != null ? String(r.source_record_id) : null,
		evidenceNote: String(r.evidence_note || ''),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
		fromName: r.from_name != null ? String(r.from_name) : undefined,
		fromSlug: r.from_slug != null ? String(r.from_slug) : undefined,
		fromType: r.from_type != null ? (String(r.from_type) as ProfileType) : undefined,
		toName: r.to_name != null ? String(r.to_name) : undefined,
		toSlug: r.to_slug != null ? String(r.to_slug) : undefined,
		toType: r.to_type != null ? (String(r.to_type) as ProfileType) : undefined,
	};
}

function rowToAlignment(r: Record<string, unknown>): AlignmentCandidate {
	return {
		id: String(r.id),
		dedupeKey: String(r.dedupe_key),
		alignmentKind: String(r.alignment_kind) as AlignmentKind,
		leftProfileId: String(r.left_profile_id),
		rightProfileId: r.right_profile_id != null ? String(r.right_profile_id) : null,
		score: Number(r.score ?? 0.5),
		cautionTier: String(r.caution_tier || 'observation') as CautionTier,
		status: String(r.status || 'proposed') as AlignmentStatus,
		rationale: String(r.rationale || ''),
		evidence: safeJsonParse<AlignmentEvidenceItem[]>(r.evidence_json, []),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
		leftName: r.left_name != null ? String(r.left_name) : undefined,
		leftSlug: r.left_slug != null ? String(r.left_slug) : undefined,
		leftType: r.left_type != null ? (String(r.left_type) as ProfileType) : undefined,
		rightName: r.right_name != null ? String(r.right_name) : null,
		rightSlug: r.right_slug != null ? String(r.right_slug) : null,
		rightType: r.right_type != null ? (String(r.right_type) as ProfileType) : null,
	};
}

export type UpsertProfileInput = {
	profileType: ProfileType;
	name: string;
	slug?: string;
	status?: ProfileStatus;
	summary?: string;
	startDate?: string | null;
	endDate?: string | null;
	metadata?: Record<string, unknown>;
	sourceCorpus?: string;
};

export function upsertProfile(input: UpsertProfileInput, dbOverride?: DatabaseSync): Profile {
	const db = dbOverride ?? getProfilesDb();
	const cleanName = String(input.name || '').trim();
	if (!cleanName) throw new Error('Profile name is required');
	if (!PROFILE_TYPES.includes(input.profileType)) {
		throw new Error(`Invalid profileType: ${input.profileType}`);
	}

	const slug = input.slug ? makeProfileSlug(input.profileType, input.slug) : makeProfileSlug(input.profileType, cleanName);
	const normalizedName = normalizeText(cleanName);
	const now = new Date().toISOString();

	const existing = db.prepare('SELECT * FROM profiles WHERE slug = ?').get(slug) as
		| Record<string, unknown>
		| undefined;

	if (existing) {
		const prevMeta = safeJsonParse<Record<string, unknown>>(existing.metadata_json, {});
		const mergedMeta: Record<string, unknown> = { ...prevMeta, ...(input.metadata || {}) };
		if (input.sourceCorpus) {
			const prevCorpora = Array.isArray(prevMeta.corpora)
				? (prevMeta.corpora as unknown[]).map(String)
				: [];
			if (!prevCorpora.includes(input.sourceCorpus)) {
				mergedMeta.corpora = [...prevCorpora, input.sourceCorpus];
			}
		}

		// Preserve pinned status if already pinned unless explicitly overriding to archived
		const nextStatus: ProfileStatus =
			existing.status === 'pinned' && input.status !== 'archived'
				? 'pinned'
				: input.status || (String(existing.status) as ProfileStatus);

		const nextSummary =
			input.summary && input.summary.trim().length > String(existing.summary || '').trim().length
				? input.summary.trim()
				: String(existing.summary || '');

		const nextStart = input.startDate || (existing.start_date != null ? String(existing.start_date) : null);
		const nextEnd = input.endDate || (existing.end_date != null ? String(existing.end_date) : null);

		db.prepare(
			`UPDATE profiles
       SET name = ?, normalized_name = ?, status = ?, summary = ?,
           start_date = ?, end_date = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
		).run(
			cleanName.length >= String(existing.name || '').length ? cleanName : String(existing.name),
			normalizedName,
			nextStatus,
			nextSummary,
			nextStart,
			nextEnd,
			JSON.stringify(mergedMeta),
			now,
			String(existing.id),
		);

		const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(String(existing.id)) as Record<
			string,
			unknown
		>;
		return rowToProfile(updated);
	}

	const id = crypto.randomUUID();
	const meta: Record<string, unknown> = { ...(input.metadata || {}) };
	if (input.sourceCorpus) {
		meta.corpora = [input.sourceCorpus];
	}

	db.prepare(
		`INSERT INTO profiles(
       id, slug, profile_type, name, normalized_name, status, summary,
       start_date, end_date, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		slug,
		input.profileType,
		cleanName,
		normalizedName,
		input.status || 'active',
		String(input.summary || '').trim(),
		input.startDate || null,
		input.endDate || null,
		JSON.stringify(meta),
		now,
		now,
	);

	// Always index canonical name as an alias too for uniform alias matching
	addAlias(
		{
			profileId: id,
			alias: cleanName,
			aliasKind: 'name',
			confidence: 1.0,
			sourceCorpus: input.sourceCorpus || null,
		},
		db,
	);

	const inserted = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown>;
	return rowToProfile(inserted);
}

export function updateProfileFields(
	idOrSlug: string,
	patch: {
		name?: string;
		profileType?: ProfileType;
		status?: ProfileStatus;
		summary?: string;
		startDate?: string | null;
		endDate?: string | null;
		metadata?: Record<string, unknown>;
	},
	dbOverride?: DatabaseSync,
): Profile | null {
	const db = dbOverride || getProfilesDb();
	const current = getProfile(idOrSlug, db);
	if (!current) return null;

	const nextName = patch.name != null && patch.name.trim() ? patch.name.trim() : current.name;
	const nextType =
		patch.profileType && PROFILE_TYPES.includes(patch.profileType)
			? patch.profileType
			: current.profileType;
	const nextStatus = patch.status || current.status;
	const nextSummary = patch.summary !== undefined ? String(patch.summary).trim() : current.summary;
	const nextStart = patch.startDate !== undefined ? patch.startDate : current.startDate;
	const nextEnd = patch.endDate !== undefined ? patch.endDate : current.endDate;
	const nextMeta = patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata;
	const now = new Date().toISOString();

	db.prepare(
		`UPDATE profiles
     SET name = ?, normalized_name = ?, profile_type = ?, status = ?,
         summary = ?, start_date = ?, end_date = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`,
	).run(
		nextName,
		normalizeText(nextName),
		nextType,
		nextStatus,
		nextSummary,
		nextStart,
		nextEnd,
		JSON.stringify(nextMeta),
		now,
		current.id,
	);

	return getProfile(current.id, db);
}

export function deleteProfile(idOrSlug: string): boolean {
	const db = getProfilesDb();
	const current = getProfile(idOrSlug, db);
	if (!current) return false;
	const info = db.prepare('DELETE FROM profiles WHERE id = ?').run(current.id);
	return Number(info.changes || 0) > 0;
}

export function getProfile(idOrSlug: string, dbOverride?: DatabaseSync): Profile | null {
	const db = dbOverride ?? getProfilesDb();
	const key = String(idOrSlug || '').trim();
	if (!key) return null;
	const row = db
		.prepare('SELECT * FROM profiles WHERE id = ? OR slug = ? LIMIT 1')
		.get(key, key) as Record<string, unknown> | undefined;
	return row ? rowToProfile(row) : null;
}

export function addAlias(
	input: {
		profileId: string;
		alias: string;
		aliasKind?: AliasKind;
		confidence?: number;
		sourceCorpus?: string | null;
	},
	dbOverride?: DatabaseSync,
): void {
	const db = dbOverride ?? getProfilesDb();
	const clean = String(input.alias || '').trim();
	const norm = normalizeText(clean);
	if (!clean || norm.length < 2) return;
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT OR IGNORE INTO profile_aliases(
       id, profile_id, alias, normalized_alias, alias_kind, confidence, source_corpus
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.profileId,
		clean,
		norm,
		input.aliasKind || 'name',
		input.confidence ?? 1.0,
		input.sourceCorpus || null,
	);
}

export function addIdentifier(
	input: {
		profileId: string;
		scheme: IdentifierScheme;
		value: string;
		sourceCorpus?: string | null;
	},
	dbOverride?: DatabaseSync,
): void {
	const db = dbOverride ?? getProfilesDb();
	const clean = String(input.value || '').trim();
	if (!clean) return;
	const norm = clean.toLowerCase().replace(/\s+/g, '');
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT OR IGNORE INTO profile_identifiers(
       id, profile_id, scheme, value, normalized_value, source_corpus
     ) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(id, input.profileId, input.scheme, clean, norm, input.sourceCorpus || null);
}

export function addLocation(
	input: {
		profileId: string;
		raw: string;
		city?: string | null;
		county?: string | null;
		state?: string | null;
		country?: string | null;
		lat?: number | null;
		lon?: number | null;
		role?: LocationRole;
		sourceCorpus?: string | null;
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	const norm = normalizeLocationRecord({
		raw: input.raw,
		city: input.city,
		county: input.county,
		state: input.state,
		country: input.country,
	});
	if (isTooGenericLocation(norm)) return norm.geoKey;
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT OR IGNORE INTO profile_locations(
       id, profile_id, raw, city, county, state, country, geo_key, lat, lon, role, source_corpus
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.profileId,
		norm.raw || norm.geoKey,
		norm.city,
		norm.county,
		norm.state,
		norm.country,
		norm.geoKey,
		typeof input.lat === 'number' && Number.isFinite(input.lat) ? input.lat : null,
		typeof input.lon === 'number' && Number.isFinite(input.lon) ? input.lon : null,
		input.role || 'associated',
		input.sourceCorpus || null,
	);
	return norm.geoKey;
}

export function upsertSourceRecord(
	input: {
		corpus: string;
		sourceRef: string;
		sourceUrl?: string | null;
		title: string;
		publishedDate?: string | null;
		excerpt?: string;
		metadata?: Record<string, unknown>;
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	const existing = db
		.prepare('SELECT id FROM source_records WHERE corpus = ? AND source_ref = ?')
		.get(input.corpus, input.sourceRef) as { id?: string } | undefined;
	if (existing?.id) return String(existing.id);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO source_records(
       id, corpus, source_ref, source_url, title, published_date, excerpt, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.corpus,
		input.sourceRef,
		input.sourceUrl || null,
		String(input.title || input.sourceRef).slice(0, 400),
		input.publishedDate || null,
		String(input.excerpt || '').slice(0, 1200),
		JSON.stringify(input.metadata || {}),
		now,
	);
	return id;
}

export function upsertTimelineEntry(
	input: {
		profileId: string;
		eventDate?: string | null;
		datePrecision?: DatePrecision;
		endDate?: string | null;
		title: string;
		summary?: string;
		angle?: TimelineAngle;
		entryKind?: TimelineEntryKind;
		geoKey?: string | null;
		geoLabel?: string | null;
		confidence?: number;
		sourceCorpus: string;
		sourceRecordId?: string | null;
		metadata?: Record<string, unknown>;
		dedupeHint?: string;
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	const parsed = normalizeIsoDate(input.eventDate);
	const eventDate = parsed.date;
	const precision: DatePrecision = input.datePrecision || parsed.precision;
	const cleanTitle = String(input.title || '').trim().slice(0, 400);
	const dedupeKey = sha256Key([
		input.profileId,
		input.sourceCorpus,
		eventDate || 'nodate',
		input.dedupeHint || cleanTitle,
	]);

	const existing = db
		.prepare('SELECT id FROM timeline_entries WHERE dedupe_key = ?')
		.get(dedupeKey) as { id?: string } | undefined;
	if (existing?.id) {
		db.prepare(
			`UPDATE timeline_entries
       SET summary = CASE WHEN length(?) > length(summary) THEN ? ELSE summary END,
           geo_key = COALESCE(geo_key, ?),
           geo_label = COALESCE(geo_label, ?)
       WHERE id = ?`,
		).run(
			String(input.summary || '').slice(0, 2000),
			String(input.summary || '').slice(0, 2000),
			input.geoKey || null,
			input.geoLabel || null,
			String(existing.id),
		);
		return String(existing.id);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO timeline_entries(
       id, dedupe_key, profile_id, event_date, date_precision, end_date,
       title, summary, angle, entry_kind, geo_key, geo_label, confidence,
       source_corpus, source_record_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		dedupeKey,
		input.profileId,
		eventDate,
		precision,
		input.endDate || null,
		cleanTitle,
		String(input.summary || '').slice(0, 2000),
		input.angle || 'general',
		input.entryKind || 'event',
		input.geoKey || null,
		input.geoLabel || null,
		input.confidence ?? 1.0,
		input.sourceCorpus,
		input.sourceRecordId || null,
		JSON.stringify(input.metadata || {}),
		now,
	);
	return id;
}

export function upsertProfileLink(
	input: {
		fromProfileId: string;
		toProfileId: string;
		relationType: ProfileRelationType;
		roleLabel?: string | null;
		startDate?: string | null;
		endDate?: string | null;
		status?: LinkStatus;
		confidence?: number;
		angle?: TimelineAngle;
		sourceCorpus: string;
		sourceRecordId?: string | null;
		evidenceNote?: string;
		dedupeHint?: string | null;
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	if (input.fromProfileId === input.toProfileId) return '';
	const dedupeParts = [
		input.fromProfileId,
		input.toProfileId,
		input.relationType,
		input.sourceCorpus,
		input.roleLabel || '',
	];
	if (input.dedupeHint) dedupeParts.push(input.dedupeHint);
	const dedupeKey = sha256Key(dedupeParts);

	const existing = db.prepare('SELECT id FROM profile_links WHERE dedupe_key = ?').get(dedupeKey) as
		| { id?: string }
		| undefined;
	const now = new Date().toISOString();
	if (existing?.id) {
		db.prepare(
			`UPDATE profile_links
       SET confidence = MAX(confidence, ?),
           start_date = COALESCE(?, start_date),
           end_date = COALESCE(?, end_date),
           evidence_note = CASE WHEN length(?) > length(evidence_note) THEN ? ELSE evidence_note END,
           updated_at = ?
       WHERE id = ?`,
		).run(
			input.confidence ?? 0.8,
			input.startDate || null,
			input.endDate || null,
			String(input.evidenceNote || ''),
			String(input.evidenceNote || ''),
			now,
			String(existing.id),
		);
		return String(existing.id);
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO profile_links(
       id, dedupe_key, from_profile_id, to_profile_id, relation_type, role_label,
       start_date, end_date, status, confidence, angle, source_corpus,
       source_record_id, evidence_note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		dedupeKey,
		input.fromProfileId,
		input.toProfileId,
		input.relationType,
		input.roleLabel || null,
		input.startDate || null,
		input.endDate || null,
		input.status || 'observed',
		input.confidence ?? 0.8,
		input.angle || 'general',
		input.sourceCorpus,
		input.sourceRecordId || null,
		String(input.evidenceNote || '').slice(0, 800),
		now,
		now,
	);
	return id;
}

export function upsertAlignmentCandidate(
	input: {
		dedupeKey: string;
		alignmentKind: AlignmentKind;
		leftProfileId: string;
		rightProfileId?: string | null;
		score: number;
		cautionTier: CautionTier;
		rationale: string;
		evidence: AlignmentEvidenceItem[];
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	const now = new Date().toISOString();
	const existing = db
		.prepare('SELECT id, status FROM alignment_candidates WHERE dedupe_key = ?')
		.get(input.dedupeKey) as { id?: string; status?: string } | undefined;

	if (existing?.id) {
		// Preserve user confirmed/dismissed triage status
		db.prepare(
			`UPDATE alignment_candidates
       SET score = ?, caution_tier = ?, rationale = ?, evidence_json = ?, updated_at = ?
       WHERE id = ?`,
		).run(
			Math.max(0, Math.min(1, Number(input.score.toFixed(3)))),
			input.cautionTier,
			input.rationale.slice(0, 1000),
			JSON.stringify(input.evidence.slice(0, 16)),
			now,
			String(existing.id),
		);
		return String(existing.id);
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO alignment_candidates(
       id, dedupe_key, alignment_kind, left_profile_id, right_profile_id,
       score, caution_tier, status, rationale, evidence_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
	).run(
		id,
		input.dedupeKey,
		input.alignmentKind,
		input.leftProfileId,
		input.rightProfileId || null,
		Math.max(0, Math.min(1, Number(input.score.toFixed(3)))),
		input.cautionTier,
		input.rationale.slice(0, 1000),
		JSON.stringify(input.evidence.slice(0, 16)),
		now,
		now,
	);
	return id;
}

export function updateAlignmentStatus(
	id: string,
	status: AlignmentStatus,
): AlignmentCandidate | null {
	const db = getProfilesDb();
	const now = new Date().toISOString();
	const info = db
		.prepare('UPDATE alignment_candidates SET status = ?, updated_at = ? WHERE id = ?')
		.run(status, now, id);
	if (!Number(info.changes || 0)) return null;

	const row = db
		.prepare(
			`SELECT ac.*,
              lp.name AS left_name, lp.slug AS left_slug, lp.profile_type AS left_type,
              rp.name AS right_name, rp.slug AS right_slug, rp.profile_type AS right_type
       FROM alignment_candidates ac
       JOIN profiles lp ON lp.id = ac.left_profile_id
       LEFT JOIN profiles rp ON rp.id = ac.right_profile_id
       WHERE ac.id = ?`,
		)
		.get(id) as Record<string, unknown> | undefined;
	return row ? rowToAlignment(row) : null;
}

export type ListProfilesFilter = {
	query?: string;
	profileType?: ProfileType | 'all' | 'actors' | 'narratives';
	/** Filter profiles tagged with a main category label (e.g. firm, education, government, medical_hospital, nonprofit, foreign, historic_event) */
	tag?: ProfileType;
	status?: ProfileStatus;
	corpus?: string;
	geo?: string;
	limit?: number;
	offset?: number;
};

export function listProfiles(filter: ListProfilesFilter = {}): {
	profiles: Profile[];
	total: number;
} {
	const db = getProfilesDb();
	const limit = Math.max(1, Math.min(200, Math.floor(Number(filter.limit ?? 50))));
	const offset = Math.max(0, Math.floor(Number(filter.offset ?? 0)));

	const where: string[] = [];
	const params: Array<string | number> = [];

	if (filter.profileType && filter.profileType !== 'all') {
		if (filter.profileType === 'actors') {
			where.push(
				`p.profile_type IN ('person','firm','education','nonprofit','medical_hospital','government','foreign')`,
			);
		} else if (filter.profileType === 'narratives') {
			where.push(`p.profile_type = 'historic_event'`);
		} else {
			where.push('p.profile_type = ?');
			params.push(filter.profileType);
		}
	}

	if (filter.status) {
		where.push('p.status = ?');
		params.push(filter.status);
	}

	if (filter.tag && PROFILE_TYPES.includes(filter.tag)) {
		where.push(
			`(
         EXISTS (
           SELECT 1 FROM profile_links pl
           JOIN profiles peer ON peer.id = CASE WHEN pl.from_profile_id = p.id THEN pl.to_profile_id ELSE pl.from_profile_id END
           WHERE (pl.from_profile_id = p.id OR pl.to_profile_id = p.id)
             AND peer.profile_type = ?
         )
         OR p.metadata_json LIKE ?
       )`,
		);
		params.push(filter.tag, `%"${filter.tag}"%`);
	}

	if (filter.corpus) {
		where.push(`p.metadata_json LIKE ?`);
		params.push(`%"${filter.corpus.replace(/[%_"]/g, '')}"%`);
	}

	if (filter.geo) {
		const g = normalizeText(filter.geo);
		if (g) {
			where.push(
				`EXISTS (
           SELECT 1 FROM profile_locations pl
           WHERE pl.profile_id = p.id
             AND (lower(pl.raw) LIKE ? OR lower(pl.geo_key) LIKE ? OR lower(COALESCE(pl.city,'')) LIKE ? OR lower(COALESCE(pl.county,'')) LIKE ? OR lower(COALESCE(pl.state,'')) LIKE ?)
         )`,
			);
			const like = `%${g}%`;
			params.push(like, like, like, like, like);
		}
	}

	const q = String(filter.query || '').trim();
	if (q) {
		const fts = buildSafeFtsQuery(q);
		const normQ = normalizeText(q);
		const like = `%${normQ}%`;
		if (fts) {
			where.push(
				`(
           p.rowid IN (SELECT rowid FROM profiles_fts WHERE profiles_fts MATCH ?)
           OR p.normalized_name LIKE ?
           OR EXISTS (SELECT 1 FROM profile_aliases pa WHERE pa.profile_id = p.id AND pa.normalized_alias LIKE ?)
           OR EXISTS (SELECT 1 FROM profile_identifiers pi WHERE pi.profile_id = p.id AND pi.normalized_value LIKE ?)
         )`,
			);
			params.push(fts, like, like, `%${q.toLowerCase().replace(/\s+/g, '')}%`);
		} else {
			where.push(`(p.normalized_name LIKE ? OR p.slug LIKE ?)`);
			params.push(like, like);
		}
	}

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const totalRow = db
		.prepare(`SELECT COUNT(*) AS c FROM profiles p ${whereSql}`)
		.get(...params) as { c?: number } | undefined;
	const total = Number(totalRow?.c || 0);

	const rows = db
		.prepare(
			`SELECT p.*,
              (SELECT COUNT(*) FROM profile_aliases pa WHERE pa.profile_id = p.id) AS alias_count,
              (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_count,
              (SELECT COUNT(*) FROM timeline_entries te WHERE te.profile_id = p.id) AS timeline_count,
              (SELECT COUNT(*) FROM alignment_candidates ac WHERE ac.left_profile_id = p.id OR ac.right_profile_id = p.id) AS alignment_count,
              (SELECT ploc.raw FROM profile_locations ploc WHERE ploc.profile_id = p.id ORDER BY CASE ploc.role WHEN 'residence' THEN 0 WHEN 'branch' THEN 1 WHEN 'hq' THEN 2 ELSE 3 END, ploc.raw ASC LIMIT 1) AS primary_location,
              (SELECT GROUP_CONCAT(DISTINCT peer.profile_type)
               FROM profile_links pl
               JOIN profiles peer ON peer.id = CASE WHEN pl.from_profile_id = p.id THEN pl.to_profile_id ELSE pl.from_profile_id END
               WHERE (pl.from_profile_id = p.id OR pl.to_profile_id = p.id)
                 AND peer.profile_type != 'person') AS linked_categories
       FROM profiles p
       ${whereSql}
       ORDER BY
         CASE p.status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
         CASE p.profile_type WHEN 'historic_event' THEN 0 ELSE 1 END,
         (link_count + timeline_count * 2 + alignment_count * 3) DESC,
         p.name ASC
       LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Array<Record<string, unknown>>;

	const profiles = rows.map((r) => {
		const prof = rowToProfile(r);
		prof.aliasCount = Number(r.alias_count || 0);
		prof.linkCount = Number(r.link_count || 0);
		prof.timelineCount = Number(r.timeline_count || 0);
		prof.alignmentCount = Number(r.alignment_count || 0);
		prof.corpora = Array.isArray(prof.metadata.corpora)
			? (prof.metadata.corpora as unknown[]).map(String)
			: [];
		prof.primaryLocation =
			r.primary_location != null ? normalizeLocationRecord({ raw: String(r.primary_location) }).raw : null;
		const tagSet = new Set<ProfileType>();
		if (typeof r.linked_categories === 'string' && r.linked_categories.trim()) {
			for (const c of r.linked_categories.split(',')) {
				const t = c.trim() as ProfileType;
				if (PROFILE_TYPES.includes(t) && t !== 'person') tagSet.add(t);
			}
		}
		if (Array.isArray(prof.metadata.categoryTags)) {
			for (const c of prof.metadata.categoryTags) {
				const t = String(c) as ProfileType;
				if (PROFILE_TYPES.includes(t) && t !== 'person') tagSet.add(t);
			}
		}
		prof.categoryTags = [...tagSet];
		return prof;
	});

	// Batch-load locations & identifiers for the returned page so country flags resolve fast with zero N+1 queries
	if (profiles.length > 0) {
		const ids = profiles.map((p) => p.id);
		const placeholders = ids.map(() => '?').join(',');
		const locByPid = new Map<
			string,
			Array<{ raw: string; city: string | null; state: string | null; country: string | null; geoKey: string }>
		>();
		const locRows = db
			.prepare(
				`SELECT profile_id, raw, city, state, country, geo_key
         FROM profile_locations
         WHERE profile_id IN (${placeholders})`,
			)
			.all(...ids) as Array<Record<string, unknown>>;
		for (const lr of locRows) {
			const pid = String(lr.profile_id);
			const list = locByPid.get(pid) || [];
			list.push({
				raw: String(lr.raw || ''),
				city: lr.city != null ? String(lr.city) : null,
				state: lr.state != null ? String(lr.state) : null,
				country: lr.country != null ? String(lr.country) : null,
				geoKey: String(lr.geo_key || ''),
			});
			locByPid.set(pid, list);
		}

		const idByPid = new Map<string, Array<{ scheme: string; value: string }>>();
		const idRows = db
			.prepare(
				`SELECT profile_id, scheme, value
         FROM profile_identifiers
         WHERE profile_id IN (${placeholders})`,
			)
			.all(...ids) as Array<Record<string, unknown>>;
		for (const ir of idRows) {
			const pid = String(ir.profile_id);
			const list = idByPid.get(pid) || [];
			list.push({ scheme: String(ir.scheme), value: String(ir.value) });
			idByPid.set(pid, list);
		}

		const aliasByPid = new Map<string, string[]>();
		const aliasRows = db
			.prepare(
				`SELECT profile_id, alias
         FROM profile_aliases
         WHERE profile_id IN (${placeholders})
           AND alias_kind IN ('name', 'former_name')`,
			)
			.all(...ids) as Array<Record<string, unknown>>;
		for (const ar of aliasRows) {
			const pid = String(ar.profile_id);
			const list = aliasByPid.get(pid) || [];
			list.push(String(ar.alias || ''));
			aliasByPid.set(pid, list);
		}

		for (const prof of profiles) {
			prof.countryCodes = detectProfileCountryCodes({
				name: prof.name,
				profileType: prof.profileType,
				summary: prof.summary,
				locations: locByPid.get(prof.id) || [],
				identifiers: idByPid.get(prof.id) || [],
				metadata: prof.metadata,
			});
			const canonLow = prof.name.trim().toLowerCase().replace(/\s+/g, ' ');
			const seen = new Set<string>([canonLow]);
			prof.alternateNames = (aliasByPid.get(prof.id) || [])
				.map((a) => a.replace(/[\[\]]+/g, '').replace(/\s+/g, ' ').trim())
				.filter((raw) => {
					const low = raw.toLowerCase();
					if (!low || seen.has(low)) return false;
					seen.add(low);
					return true;
				})
				.sort((a, b) => b.length - a.length)
				.slice(0, 2);
		}
	}

	return { profiles, total };
}

export function getProfileDetail(idOrSlug: string): ProfileDetail | null {
	const db = getProfilesDb();
	const profile = getProfile(idOrSlug, db);
	if (!profile) return null;

	const aliasRows = db
		.prepare('SELECT * FROM profile_aliases WHERE profile_id = ? ORDER BY confidence DESC, alias ASC')
		.all(profile.id) as Array<Record<string, unknown>>;
	const aliases: ProfileAlias[] = aliasRows.map((r) => ({
		id: String(r.id),
		profileId: String(r.profile_id),
		alias: String(r.alias),
		normalizedAlias: String(r.normalized_alias),
		aliasKind: String(r.alias_kind || 'name') as AliasKind,
		confidence: Number(r.confidence ?? 1),
		sourceCorpus: r.source_corpus != null ? String(r.source_corpus) : null,
	}));

	const identRows = db
		.prepare('SELECT * FROM profile_identifiers WHERE profile_id = ? ORDER BY scheme ASC, value ASC')
		.all(profile.id) as Array<Record<string, unknown>>;
	const identifiers: ProfileIdentifier[] = identRows.map((r) => ({
		id: String(r.id),
		profileId: String(r.profile_id),
		scheme: String(r.scheme) as IdentifierScheme,
		value: String(r.value),
		normalizedValue: String(r.normalized_value),
		sourceCorpus: r.source_corpus != null ? String(r.source_corpus) : null,
	}));

	const locRows = db
		.prepare('SELECT * FROM profile_locations WHERE profile_id = ? ORDER BY role ASC, raw ASC')
		.all(profile.id) as Array<Record<string, unknown>>;
	const rawLocations: ProfileLocation[] = locRows.map((r) => ({
		id: String(r.id),
		profileId: String(r.profile_id),
		raw: String(r.raw),
		city: r.city != null ? String(r.city) : null,
		county: r.county != null ? String(r.county) : null,
		state: r.state != null ? String(r.state) : null,
		country: r.country != null ? String(r.country) : null,
		geoKey: String(r.geo_key),
		lat: r.lat != null ? Number(r.lat) : null,
		lon: r.lon != null ? Number(r.lon) : null,
		role: String(r.role || 'associated') as LocationRole,
		sourceCorpus: r.source_corpus != null ? String(r.source_corpus) : null,
	}));
	const locations: ProfileLocation[] = deduplicateLocations(rawLocations);

	const LINK_DETAIL_LIMIT = 2000;
	const linkRows = db
		.prepare(
			`SELECT pl.*,
              fp.name AS from_name, fp.slug AS from_slug, fp.profile_type AS from_type,
              tp.name AS to_name, tp.slug AS to_slug, tp.profile_type AS to_type
       FROM profile_links pl
       JOIN profiles fp ON fp.id = pl.from_profile_id
       JOIN profiles tp ON tp.id = pl.to_profile_id
       WHERE pl.from_profile_id = ? OR pl.to_profile_id = ?
       ORDER BY
         CASE WHEN COALESCE(pl.start_date, pl.end_date) IS NOT NULL THEN 0 ELSE 1 END ASC,
         COALESCE(pl.start_date, pl.end_date, '') DESC,
         CASE
           WHEN LOWER(COALESCE(pl.role_label, '')) LIKE '%current%'
             OR LOWER(COALESCE(pl.evidence_note, '')) LIKE '%status=current%' THEN 0
           WHEN LOWER(COALESCE(pl.role_label, '')) LIKE '%previous%'
             OR LOWER(COALESCE(pl.role_label, '')) LIKE '%former%'
             OR LOWER(COALESCE(pl.evidence_note, '')) LIKE '%status=previous%' THEN 2
           ELSE 1
         END ASC,
         pl.confidence DESC,
         pl.created_at DESC
       LIMIT ${LINK_DETAIL_LIMIT}`,
		)
		.all(profile.id, profile.id) as Array<Record<string, unknown>>;
	const links = linkRows.map(rowToLink);
	const rawLinkTotal =
		linkRows.length >= LINK_DETAIL_LIMIT
			? Number(
					(
						db
							.prepare('SELECT COUNT(*) AS c FROM profile_links WHERE from_profile_id = ? OR to_profile_id = ?')
							.get(profile.id, profile.id) as { c?: number }
					)?.c || linkRows.length,
				)
			: linkRows.length;

	const alignRows = db
		.prepare(
			`SELECT ac.*,
              lp.name AS left_name, lp.slug AS left_slug, lp.profile_type AS left_type,
              rp.name AS right_name, rp.slug AS right_slug, rp.profile_type AS right_type
       FROM alignment_candidates ac
       JOIN profiles lp ON lp.id = ac.left_profile_id
       LEFT JOIN profiles rp ON rp.id = ac.right_profile_id
       WHERE ac.left_profile_id = ? OR ac.right_profile_id = ?
       ORDER BY
         CASE ac.status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
         ac.score DESC
       LIMIT 100`,
		)
		.all(profile.id, profile.id) as Array<Record<string, unknown>>;
	const alignments = alignRows.map(rowToAlignment);

	const timelineRows = db
		.prepare(
			`SELECT te.*, sr.source_url, sr.source_ref
       FROM timeline_entries te
       LEFT JOIN source_records sr ON sr.id = te.source_record_id
       WHERE te.profile_id = ?
       ORDER BY COALESCE(te.event_date, '9999') ASC, te.created_at ASC
       LIMIT 50`,
		)
		.all(profile.id) as Array<Record<string, unknown>>;
	const recentTimeline = timelineRows.map(rowToTimeline);

	const timelineTotal = Number(
		(
			db
				.prepare('SELECT COUNT(*) AS c FROM timeline_entries WHERE profile_id = ?')
				.get(profile.id) as { c?: number }
		)?.c || 0,
	);
	const alignTotal = Number(
		(
			db
				.prepare(
					'SELECT COUNT(*) AS c FROM alignment_candidates WHERE left_profile_id = ? OR right_profile_id = ?',
				)
				.get(profile.id, profile.id) as { c?: number }
		)?.c || 0,
	);

	profile.corpora = Array.isArray(profile.metadata.corpora)
		? (profile.metadata.corpora as unknown[]).map(String)
		: [];
	profile.primaryLocation = locations[0]?.raw || null;

	// Compute main category labels as tags from linked orgs/events + manual metadata.categoryTags
	const tagSet = new Set<ProfileType>();
	for (const l of links) {
		const peerType = l.fromProfileId === profile.id ? l.toType : l.fromType;
		if (peerType && peerType !== 'person' && PROFILE_TYPES.includes(peerType)) {
			tagSet.add(peerType);
		}
	}
	if (Array.isArray(profile.metadata.categoryTags)) {
		for (const raw of profile.metadata.categoryTags) {
			const t = String(raw) as ProfileType;
			if (PROFILE_TYPES.includes(t) && t !== 'person') tagSet.add(t);
		}
	}
	const categoryTags = [...tagSet];
	profile.categoryTags = categoryTags;

	// Build structured employment history for person profiles from org links
	const EMPLOYMENT_RELS = new Set<ProfileRelationType>([
		'employed_by',
		'registered_at',
		'alumni_or_faculty',
		'affiliated_with',
		'business_tie',
	]);
	const ORG_TYPES = new Set<ProfileType>([
		'firm',
		'education',
		'nonprofit',
		'medical_hospital',
		'government',
		'foreign',
	]);

	const REL_PRIORITY: Record<string, number> = {
		employed_by: 10,
		registered_at: 9,
		alumni_or_faculty: 9,
		affiliated_with: 7,
		funded_by: 7,
		regulator_of: 7,
		family_or_associate: 6,
		participated_in: 6,
		authored_or_spoke: 6,
		part_of_subject: 5,
		business_tie: 4,
		location_overlap: 3,
		temporal_overlap: 3,
		mentioned_in: 2,
		possible_alignment: 1,
	};

	function mergeRoleLabels(existingRole: string | null, incomingRole: string | null): string | null {
		const rawParts = [existingRole, incomingRole]
			.filter(Boolean)
			.flatMap((s) => String(s).split(','))
			.map((s) => s.trim())
			.filter(Boolean);
		if (!rawParts.length) return null;
		// Sort longest/most-specific first so "Co-founder and CEO" absorbs redundant "CEO" / "Founder"
		const sorted = [...new Set(rawParts)].sort((a, b) => b.length - a.length);
		const kept: string[] = [];
		for (const part of sorted) {
			const low = part.toLowerCase();
			const covered = kept.some((k) => {
				const kLow = k.toLowerCase();
				if (kLow === low || kLow.includes(low)) return true;
				if (low === 'founder' && kLow.includes('co-founder')) return true;
				return false;
			});
			if (!covered) kept.push(part);
		}
		return kept.join(', ').slice(0, 140) || null;
	}

	const employmentHistory: PersonEmploymentEntry[] = [];
	if (profile.profileType === 'person') {
		const byEmpKey = new Map<string, PersonEmploymentEntry>();
		for (const l of links) {
			const isOut = l.fromProfileId === profile.id;
			const peerId = isOut ? l.toProfileId : l.fromProfileId;
			const peerName = isOut ? l.toName : l.fromName;
			const peerSlug = isOut ? l.toSlug : l.fromSlug;
			const peerType = (isOut ? l.toType : l.fromType) || 'firm';
			if (!ORG_TYPES.has(peerType)) continue;
			if (!EMPLOYMENT_RELS.has(l.relationType)) continue;

			const roleStr = l.roleLabel || '';
			const noteStr = l.evidenceNote || '';
			let isCurrent: boolean | null = null;
			if (
				/current/i.test(roleStr) ||
				/status=current/i.test(noteStr) ||
				(l.startDate && !l.endDate && l.sourceCorpus === 'manual')
			) {
				isCurrent = true;
			} else if (/previous|former/i.test(roleStr) || /status=previous/i.test(noteStr) || Boolean(l.endDate)) {
				isCurrent = false;
			}
			const branchMatch = noteStr.match(/branch=([^;]+)/i);
			const empLocation = branchMatch ? branchMatch[1].trim() : null;
			const firmCrdMatch = noteStr.match(/firmCrd=(\d+)/i);
			const secMatch = noteStr.match(/sec=([^;]+)/i);
			const iaOnlyMatch = noteStr.match(/iaOnly=([A-Za-z0-9]+)/i);
			const firmBcScopeMatch = noteStr.match(/firmBcScope=([^;]+)/i);

			const candidate: PersonEmploymentEntry = {
				id: l.id,
				orgProfileId: peerId,
				orgSlug: peerSlug || null,
				orgName: peerName || 'Unknown organization',
				orgCategory: peerType,
				firmCrd: firmCrdMatch ? firmCrdMatch[1].trim() : null,
				secNumber: secMatch ? secMatch[1].trim() : null,
				iaOnly: iaOnlyMatch ? /^y|true|1$/i.test(iaOnlyMatch[1].trim()) : false,
				firmFinraScope: firmBcScopeMatch ? firmBcScopeMatch[1].trim() : null,
				role: l.roleLabel,
				relationType: l.relationType,
				startDate: l.startDate,
				endDate: l.endDate,
				isCurrent,
				location: empLocation,
				sourceCorpus: l.sourceCorpus,
				evidenceNote: l.evidenceNote,
			};

			const dedupeEmpKey = `${peerId}|${l.startDate || ''}|${l.endDate || ''}`;
			const existing = byEmpKey.get(dedupeEmpKey);
			if (!existing) {
				byEmpKey.set(dedupeEmpKey, candidate);
			} else {
				const existingScore =
					(existing.role ? 2 : 0) +
					(REL_PRIORITY[existing.relationType] || 0) +
					(existing.location ? 1 : 0);
				const candScore =
					(candidate.role ? 2 : 0) +
					(REL_PRIORITY[candidate.relationType] || 0) +
					(candidate.location ? 1 : 0);
				const winner = candScore > existingScore ? { ...candidate } : { ...existing };
				const loser = candScore > existingScore ? existing : candidate;
				winner.role = mergeRoleLabels(winner.role, loser.role);
				winner.location = winner.location || loser.location;
				winner.firmCrd = winner.firmCrd || loser.firmCrd;
				winner.secNumber = winner.secNumber || loser.secNumber;
				winner.iaOnly = Boolean(winner.iaOnly || loser.iaOnly);
				winner.firmFinraScope = winner.firmFinraScope || loser.firmFinraScope;
				if (winner.isCurrent == null && loser.isCurrent != null) winner.isCurrent = loser.isCurrent;
				byEmpKey.set(dedupeEmpKey, winner);
			}
		}

		// Drop undated duplicate entries for an org if a dated entry for the same org exists (merging role/location)
		const datedByOrg = new Map<string, PersonEmploymentEntry[]>();
		const undatedByOrg = new Map<string, PersonEmploymentEntry>();
		for (const entry of byEmpKey.values()) {
			const oid = entry.orgProfileId || entry.orgName;
			if (entry.startDate || entry.endDate) {
				const list = datedByOrg.get(oid) || [];
				list.push(entry);
				datedByOrg.set(oid, list);
			} else {
				undatedByOrg.set(oid, entry);
			}
		}
		for (const [oid, list] of datedByOrg.entries()) {
			const undated = undatedByOrg.get(oid);
			if (undated && list.length > 0) {
				list[0].role = mergeRoleLabels(list[0].role, undated.role);
				list[0].location = list[0].location || undated.location;
				if (list[0].isCurrent == null && undated.isCurrent != null) list[0].isCurrent = undated.isCurrent;
				undatedByOrg.delete(oid);
			}
			employmentHistory.push(...list);
		}
		employmentHistory.push(...undatedByOrg.values());

		// Sort current first, then newest startDate/endDate desc, then org name
		employmentHistory.sort((a, b) => {
			if (a.isCurrent !== b.isCurrent) {
				if (a.isCurrent === true) return -1;
				if (b.isCurrent === true) return 1;
			}
			const da = a.startDate || a.endDate || '';
			const dbDate = b.startDate || b.endDate || '';
			if (da !== dbDate) return dbDate.localeCompare(da);
			return a.orgName.localeCompare(b.orgName);
		});
	}

	// Deduplicate connected profile links by peerId (collapsing bidirectional & multi-corpus duplicate links)
	const linkByPeer = new Map<string, ProfileLink>();
	for (const l of links) {
		const isOut = l.fromProfileId === profile.id;
		const peerId = isOut ? l.toProfileId : l.fromProfileId;
		const existing = linkByPeer.get(peerId);
		if (!existing) {
			linkByPeer.set(peerId, { ...l, sources: [l.sourceCorpus] });
			continue;
		}
		const existScore =
			(REL_PRIORITY[existing.relationType] || 0) * 3 +
			(existing.startDate || existing.endDate ? 4 : 0) +
			(existing.roleLabel ? 2 : 0) +
			(existing.fromProfileId === profile.id ? 1 : 0);
		const candScore =
			(REL_PRIORITY[l.relationType] || 0) * 3 +
			(l.startDate || l.endDate ? 4 : 0) +
			(l.roleLabel ? 2 : 0) +
			(l.fromProfileId === profile.id ? 1 : 0);

		const winner = candScore > existScore ? { ...l } : { ...existing };
		const loser = candScore > existScore ? existing : l;
		winner.roleLabel = mergeRoleLabels(winner.roleLabel, loser.roleLabel);
		winner.startDate =
			winner.startDate && loser.startDate
				? winner.startDate < loser.startDate
					? winner.startDate
					: loser.startDate
				: winner.startDate || loser.startDate;
		winner.endDate =
			winner.endDate && loser.endDate
				? winner.endDate > loser.endDate
					? winner.endDate
					: loser.endDate
				: winner.endDate || loser.endDate;
		winner.confidence = Math.max(winner.confidence, loser.confidence);
		const mergedSources = new Set<string>([
			...(existing.sources || [existing.sourceCorpus]),
			l.sourceCorpus,
		]);
		winner.sources = [...mergedSources];
		linkByPeer.set(peerId, winner);
	}
	const dedupedLinks = [...linkByPeer.values()].sort((a, b) => {
		const da = a.startDate || a.endDate || '';
		const dbDate = b.startDate || b.endDate || '';
		if (da && !dbDate) return -1;
		if (!da && dbDate) return 1;
		if (da !== dbDate) return dbDate.localeCompare(da);
		const rankStatus = (l: ProfileLink) => {
			const r = `${l.roleLabel || ''} ${l.evidenceNote || ''}`.toLowerCase();
			if (r.includes('current')) return 0;
			if (r.includes('previous') || r.includes('former') || Boolean(l.endDate)) return 2;
			return 1;
		};
		const ra = rankStatus(a);
		const rb = rankStatus(b);
		if (ra !== rb) return ra - rb;
		return b.confidence - a.confidence;
	});

	// Batch-resolve country flags ONCE for all connected peer profiles (employmentHistory + dedupedLinks)
	const allPeerIds = [
		...new Set([
			...employmentHistory.map((e) => e.orgProfileId).filter((x): x is string => Boolean(x)),
			...dedupedLinks.map((l) => (l.fromProfileId === profile.id ? l.toProfileId : l.fromProfileId)),
		]),
	];
	if (allPeerIds.length > 0) {
		const peerInfoById = new Map<
			string,
			{ name: string; profileType: string; summary: string; metadata: Record<string, unknown> }
		>();
		const peerLocsById = new Map<
			string,
			Array<{ raw: string; city: string | null; state: string | null; country: string | null; geoKey: string }>
		>();
		const peerIdentsById = new Map<string, Array<{ scheme: string; value: string }>>();

		const CHUNK = 500;
		for (let i = 0; i < allPeerIds.length; i += CHUNK) {
			const chunkIds = allPeerIds.slice(i, i + CHUNK);
			const placeholders = chunkIds.map(() => '?').join(',');
			const peerRows = db
				.prepare(`SELECT id, name, profile_type, summary, metadata_json FROM profiles WHERE id IN (${placeholders})`)
				.all(...chunkIds) as Array<Record<string, unknown>>;
			for (const r of peerRows) {
				peerInfoById.set(String(r.id), {
					name: String(r.name || ''),
					profileType: String(r.profile_type || 'firm'),
					summary: String(r.summary || ''),
					metadata: safeJsonParse<Record<string, unknown>>(r.metadata_json, {}),
				});
			}

			const peerLocRows = db
				.prepare(
					`SELECT profile_id, raw, city, state, country, geo_key FROM profile_locations WHERE profile_id IN (${placeholders})`,
				)
				.all(...chunkIds) as Array<Record<string, unknown>>;
			for (const lr of peerLocRows) {
				const pid = String(lr.profile_id);
				const list = peerLocsById.get(pid) || [];
				list.push({
					raw: String(lr.raw || ''),
					city: lr.city != null ? String(lr.city) : null,
					state: lr.state != null ? String(lr.state) : null,
					country: lr.country != null ? String(lr.country) : null,
					geoKey: String(lr.geo_key || ''),
				});
				peerLocsById.set(pid, list);
			}

			const peerIdentRows = db
				.prepare(`SELECT profile_id, scheme, value FROM profile_identifiers WHERE profile_id IN (${placeholders})`)
				.all(...chunkIds) as Array<Record<string, unknown>>;
			for (const ir of peerIdentRows) {
				const pid = String(ir.profile_id);
				const list = peerIdentsById.get(pid) || [];
				list.push({ scheme: String(ir.scheme), value: String(ir.value) });
				peerIdentsById.set(pid, list);
			}
		}

		const peerFlagsCache = new Map<string, string[]>();
		const getPeerFlags = (pid: string, extraLoc?: string | null): string[] => {
			if (!extraLoc && peerFlagsCache.has(pid)) return peerFlagsCache.get(pid)!;
			const info = peerInfoById.get(pid);
			const locs = [...(peerLocsById.get(pid) || []), ...(extraLoc ? [{ raw: extraLoc }] : [])];
			const codes = detectProfileCountryCodes({
				name: info?.name || '',
				profileType: info?.profileType,
				summary: info?.summary || '',
				locations: locs,
				identifiers: peerIdentsById.get(pid) || [],
				metadata: info?.metadata || {},
			});
			if (!extraLoc) peerFlagsCache.set(pid, codes);
			return codes;
		};

		for (const emp of employmentHistory) {
			if (emp.orgProfileId) {
				emp.orgCountryCodes = getPeerFlags(emp.orgProfileId, emp.location);
				const peerMeta = peerInfoById.get(emp.orgProfileId)?.metadata || {};
				if (!emp.firmCrd) {
					const crdIdent = (peerIdentsById.get(emp.orgProfileId) || []).find((i) => i.scheme === 'finra_crd');
					emp.firmCrd = crdIdent?.value || (peerMeta.finraCrd ? String(peerMeta.finraCrd) : null);
				}
				if (!emp.secNumber) {
					const sec = peerMeta.bdSecNumber || peerMeta.iaSecNumber;
					if (sec) emp.secNumber = String(sec);
				}
				if (!emp.firmFinraScope && peerMeta.finraBcScope) {
					emp.firmFinraScope = String(peerMeta.finraBcScope);
				}
			}
		}
		for (const l of dedupedLinks) {
			const peerId = l.fromProfileId === profile.id ? l.toProfileId : l.fromProfileId;
			l.peerCountryCodes = getPeerFlags(peerId);
		}
	}

	profile.countryCodes = detectProfileCountryCodes({
		name: profile.name,
		profileType: profile.profileType,
		summary: profile.summary,
		locations,
		identifiers,
		metadata: profile.metadata,
	});
	const canonLowDetail = profile.name.trim().toLowerCase().replace(/\s+/g, ' ');
	const seenDetailAlt = new Set<string>([canonLowDetail]);
	profile.alternateNames = aliases
		.filter((a) => a.aliasKind === 'name' || a.aliasKind === 'former_name')
		.map((a) => a.alias.replace(/[\[\]]+/g, '').replace(/\s+/g, ' ').trim())
		.filter((raw) => {
			const low = raw.toLowerCase();
			if (!low || seenDetailAlt.has(low)) return false;
			seenDetailAlt.add(low);
			return true;
		})
		.sort((a, b) => b.length - a.length)
		.slice(0, 2);

	return {
		profile,
		aliases,
		identifiers,
		locations,
		links: dedupedLinks,
		alignments,
		recentTimeline,
		employmentHistory,
		categoryTags,
		counts: {
			aliases: aliases.length,
			identifiers: identifiers.length,
			locations: locations.length,
			links: linkRows.length >= LINK_DETAIL_LIMIT ? Math.max(dedupedLinks.length, rawLinkTotal) : dedupedLinks.length,
			timelineEntries: timelineTotal,
			alignments: alignTotal,
			employmentHistory: employmentHistory.length,
		},
	};
}

export function addPersonEmployment(input: {
	personIdOrSlug: string;
	orgName: string;
	orgCategory?: ProfileType;
	role?: string | null;
	startDate?: string | null;
	endDate?: string | null;
	isCurrent?: boolean;
	location?: string | null;
	notes?: string | null;
	sourceCorpus?: string;
}, dbOverride?: DatabaseSync): { linkId: string; orgProfile: Profile } | null {
	const db = dbOverride ?? getProfilesDb();
	const person = getProfile(input.personIdOrSlug, db);
	if (!person) return null;

	const orgName = String(input.orgName || '').trim();
	if (!orgName) throw new Error('orgName is required');

	const allowedOrgCategories: ProfileType[] = [
		'firm',
		'education',
		'nonprofit',
		'medical_hospital',
		'government',
		'foreign',
	];
	const orgType: ProfileType =
		input.orgCategory && allowedOrgCategories.includes(input.orgCategory)
			? input.orgCategory
			: 'firm';
	const corpus = input.sourceCorpus || 'manual';

	const orgProfile = upsertProfile(
		{
			profileType: orgType,
			name: orgName,
			sourceCorpus: corpus,
		},
		db,
	);

	const locClean = input.location ? String(input.location).trim() : '';
	let geoKey: string | null = null;
	if (locClean) {
		geoKey = addLocation(
			{
				profileId: person.id,
				raw: locClean,
				role: 'branch',
				sourceCorpus: corpus,
			},
			db,
		);
		addLocation(
			{
				profileId: orgProfile.id,
				raw: locClean,
				role: 'associated',
				sourceCorpus: corpus,
			},
			db,
		);
	}

	const roleBase = input.role ? String(input.role).trim() : '';
	const roleLabel =
		roleBase || (input.isCurrent === true ? 'Current employment' : input.isCurrent === false ? 'Previous employment' : null);

	const relType: ProfileRelationType =
		orgType === 'education' ? 'alumni_or_faculty' : 'employed_by';

	const evidenceParts = [
		input.notes ? String(input.notes).trim() : '',
		locClean ? `branch=${locClean}` : '',
		input.isCurrent === true ? 'status=current' : input.isCurrent === false ? 'status=previous' : '',
	].filter(Boolean);

	const linkId = upsertProfileLink(
		{
			fromProfileId: person.id,
			toProfileId: orgProfile.id,
			relationType: relType,
			roleLabel,
			startDate: input.startDate ? String(input.startDate).trim() : null,
			endDate: input.endDate ? String(input.endDate).trim() : null,
			status: 'verified',
			confidence: 0.95,
			angle: orgType === 'education' ? 'academic_research' : orgType === 'government' ? 'policy' : 'corporate',
			sourceCorpus: corpus,
			evidenceNote: evidenceParts.join('; ') || `Employment at ${orgName}`,
		},
		db,
	);

	// Also record on the person's timeline so employment history participates in timeline alignment
	const startDate = input.startDate ? String(input.startDate).trim() : null;
	const endDate = input.endDate ? String(input.endDate).trim() : null;
	if (startDate || endDate) {
		upsertTimelineEntry(
			{
				profileId: person.id,
				eventDate: startDate || endDate,
				endDate,
				title: `${roleLabel ? `${roleLabel} at ` : 'Employed at '}${orgName}`,
				summary: evidenceParts.join(' · ') || `${orgName} (${orgType})`,
				angle: orgType === 'education' ? 'academic_research' : orgType === 'government' ? 'policy' : 'corporate',
				entryKind: 'employment',
				geoKey,
				geoLabel: locClean || null,
				sourceCorpus: corpus,
				dedupeHint: `emp:${orgProfile.slug}:${roleLabel || ''}:${startDate || ''}`,
			},
			db,
		);
	}

	return { linkId, orgProfile };
}

/**
 * Merge `mergeIdOrSlug` into `keepIdOrSlug`: transfers aliases, identifiers, locations,
 * timeline entries, links (deduped, no self-loops), alignment candidates, and metadata
 * (corpora/categoryTags/summary/dates), adds the merged profile's name as an alias on
 * `keep`, and deletes the duplicate `merge` profile.
 */
export function mergeProfiles(
	keepIdOrSlug: string,
	mergeIdOrSlug: string,
	dbOverride?: DatabaseSync,
): { kept: Profile; mergedId: string; mergedName: string } | null {
	const db = dbOverride ?? getProfilesDb();
	const keep = getProfile(keepIdOrSlug, db);
	const merge = getProfile(mergeIdOrSlug, db);
	if (!keep || !merge || keep.id === merge.id) return null;

	const runMerge = (tx: DatabaseSync) => {
		const now = new Date().toISOString();

		// 1. Merge metadata (corpora, categoryTags), summary, status, dates
		const keepCorpora = Array.isArray(keep.metadata.corpora) ? keep.metadata.corpora.map(String) : [];
		const mergeCorpora = Array.isArray(merge.metadata.corpora) ? merge.metadata.corpora.map(String) : [];
		const keepTags = Array.isArray(keep.metadata.categoryTags) ? keep.metadata.categoryTags.map(String) : [];
		const mergeTags = Array.isArray(merge.metadata.categoryTags) ? merge.metadata.categoryTags.map(String) : [];

		const mergedMeta: Record<string, unknown> = {
			...merge.metadata,
			...keep.metadata,
			corpora: [...new Set([...keepCorpora, ...mergeCorpora])],
		};
		const combinedTags = [...new Set([...keepTags, ...mergeTags])];
		if (combinedTags.length) mergedMeta.categoryTags = combinedTags;

		const nextStatus: ProfileStatus =
			keep.status === 'pinned' || merge.status === 'pinned' ? 'pinned' : keep.status;
		const nextSummary =
			merge.summary.trim().length > keep.summary.trim().length ? merge.summary.trim() : keep.summary.trim();
		const nextStart =
			keep.startDate && merge.startDate
				? keep.startDate < merge.startDate
					? keep.startDate
					: merge.startDate
				: keep.startDate || merge.startDate;
		const nextEnd =
			keep.endDate && merge.endDate
				? keep.endDate > merge.endDate
					? keep.endDate
					: merge.endDate
				: keep.endDate || merge.endDate;

		tx.prepare(
			`UPDATE profiles
       SET status = ?, summary = ?, start_date = ?, end_date = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
		).run(nextStatus, nextSummary, nextStart, nextEnd, JSON.stringify(mergedMeta), now, keep.id);

		// 2. Preserve merged name + all aliases
		addAlias({ profileId: keep.id, alias: merge.name, aliasKind: 'former_name', confidence: 0.95 }, tx);
		const mergeAliases = tx
			.prepare('SELECT alias, alias_kind, confidence, source_corpus FROM profile_aliases WHERE profile_id = ?')
			.all(merge.id) as Array<Record<string, unknown>>;
		for (const a of mergeAliases) {
			addAlias(
				{
					profileId: keep.id,
					alias: String(a.alias),
					aliasKind: String(a.alias_kind || 'name') as AliasKind,
					confidence: Number(a.confidence ?? 1),
					sourceCorpus: a.source_corpus != null ? String(a.source_corpus) : null,
				},
				tx,
			);
		}

		// 3. Move identifiers (ignore duplicates)
		const mergeIdents = tx
			.prepare('SELECT scheme, value, source_corpus FROM profile_identifiers WHERE profile_id = ?')
			.all(merge.id) as Array<Record<string, unknown>>;
		for (const i of mergeIdents) {
			addIdentifier(
				{
					profileId: keep.id,
					scheme: String(i.scheme) as IdentifierScheme,
					value: String(i.value),
					sourceCorpus: i.source_corpus != null ? String(i.source_corpus) : null,
				},
				tx,
			);
		}

		// 4. Move locations (ignore duplicates)
		const mergeLocs = tx
			.prepare(
				'SELECT raw, city, county, state, country, lat, lon, role, source_corpus FROM profile_locations WHERE profile_id = ?',
			)
			.all(merge.id) as Array<Record<string, unknown>>;
		for (const loc of mergeLocs) {
			addLocation(
				{
					profileId: keep.id,
					raw: String(loc.raw),
					city: loc.city != null ? String(loc.city) : null,
					county: loc.county != null ? String(loc.county) : null,
					state: loc.state != null ? String(loc.state) : null,
					country: loc.country != null ? String(loc.country) : null,
					lat: loc.lat != null ? Number(loc.lat) : null,
					lon: loc.lon != null ? Number(loc.lon) : null,
					role: String(loc.role || 'associated') as LocationRole,
					sourceCorpus: loc.source_corpus != null ? String(loc.source_corpus) : null,
				},
				tx,
			);
		}

		// 5. Re-attach timeline entries (re-keying dedupe_key via upsert)
		const mergeTimeline = tx
			.prepare('SELECT * FROM timeline_entries WHERE profile_id = ?')
			.all(merge.id) as Array<Record<string, unknown>>;
		for (const te of mergeTimeline) {
			upsertTimelineEntry(
				{
					profileId: keep.id,
					eventDate: te.event_date != null ? String(te.event_date) : null,
					datePrecision: String(te.date_precision || 'day') as DatePrecision,
					endDate: te.end_date != null ? String(te.end_date) : null,
					title: String(te.title),
					summary: String(te.summary || ''),
					angle: String(te.angle || 'general') as TimelineAngle,
					entryKind: String(te.entry_kind || 'event') as TimelineEntryKind,
					geoKey: te.geo_key != null ? String(te.geo_key) : null,
					geoLabel: te.geo_label != null ? String(te.geo_label) : null,
					confidence: Number(te.confidence ?? 1),
					sourceCorpus: String(te.source_corpus),
					sourceRecordId: te.source_record_id != null ? String(te.source_record_id) : null,
					metadata: safeJsonParse<Record<string, unknown>>(te.metadata_json, {}),
				},
				tx,
			);
		}

		// 6. Rewrite profile_links (skip self-loops, dedupe via upsertProfileLink)
		const mergeLinks = tx
			.prepare('SELECT * FROM profile_links WHERE from_profile_id = ? OR to_profile_id = ?')
			.all(merge.id, merge.id) as Array<Record<string, unknown>>;
		for (const l of mergeLinks) {
			const nextFrom = String(l.from_profile_id) === merge.id ? keep.id : String(l.from_profile_id);
			const nextTo = String(l.to_profile_id) === merge.id ? keep.id : String(l.to_profile_id);
			if (nextFrom === nextTo) continue;
			upsertProfileLink(
				{
					fromProfileId: nextFrom,
					toProfileId: nextTo,
					relationType: String(l.relation_type) as ProfileRelationType,
					roleLabel: l.role_label != null ? String(l.role_label) : null,
					startDate: l.start_date != null ? String(l.start_date) : null,
					endDate: l.end_date != null ? String(l.end_date) : null,
					status: String(l.status || 'observed') as LinkStatus,
					confidence: Number(l.confidence ?? 0.8),
					angle: String(l.angle || 'general') as TimelineAngle,
					sourceCorpus: String(l.source_corpus),
					sourceRecordId: l.source_record_id != null ? String(l.source_record_id) : null,
					evidenceNote: String(l.evidence_note || ''),
				},
				tx,
			);
		}

		// 7. Delete alignments directly linking keep <-> merge, and delete the merged profile (cascade cleans remaining rows)
		tx.prepare(
			`DELETE FROM alignment_candidates
       WHERE (left_profile_id = ? AND right_profile_id = ?)
          OR (left_profile_id = ? AND right_profile_id = ?)`,
		).run(keep.id, merge.id, merge.id, keep.id);

		tx.prepare('DELETE FROM profiles WHERE id = ?').run(merge.id);
	};

	if (dbOverride) {
		runMerge(dbOverride);
	} else {
		db.exec('BEGIN IMMEDIATE;');
		try {
			runMerge(db);
			db.exec('COMMIT;');
		} catch (error) {
			try {
				db.exec('ROLLBACK;');
			} catch {
				/* ignore */
			}
			throw error;
		}
	}

	const kept = getProfile(keep.id, db);
	if (!kept) return null;
	return { kept, mergedId: merge.id, mergedName: merge.name };
}

export function getProfileStats(): ProfileStats {
	const db = getProfilesDb();
	const byType: Record<ProfileType, number> = {
		person: 0,
		firm: 0,
		education: 0,
		nonprofit: 0,
		medical_hospital: 0,
		government: 0,
		foreign: 0,
		historic_event: 0,
	};

	const typeRows = db
		.prepare('SELECT profile_type, COUNT(*) AS c FROM profiles GROUP BY profile_type')
		.all() as Array<{ profile_type: string; c: number }>;
	let totalProfiles = 0;
	for (const r of typeRows) {
		const t = r.profile_type as ProfileType;
		if (t in byType) byType[t] = Number(r.c || 0);
		totalProfiles += Number(r.c || 0);
	}

	const countOf = (table: string): number =>
		Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number })?.c || 0);

	const alignmentsByStatus: Record<AlignmentStatus, number> = {
		proposed: 0,
		confirmed: 0,
		dismissed: 0,
	};
	for (const r of db
		.prepare('SELECT status, COUNT(*) AS c FROM alignment_candidates GROUP BY status')
		.all() as Array<{ status: string; c: number }>) {
		if (r.status in alignmentsByStatus) {
			alignmentsByStatus[r.status as AlignmentStatus] = Number(r.c || 0);
		}
	}

	const alignmentsByKind: Record<string, number> = {};
	for (const r of db
		.prepare('SELECT alignment_kind, COUNT(*) AS c FROM alignment_candidates GROUP BY alignment_kind')
		.all() as Array<{ alignment_kind: string; c: number }>) {
		alignmentsByKind[String(r.alignment_kind)] = Number(r.c || 0);
	}

	const corpora = (
		db
			.prepare('SELECT corpus, COUNT(*) AS records FROM source_records GROUP BY corpus ORDER BY records DESC')
			.all() as Array<{ corpus: string; records: number }>
	).map((r) => ({ corpus: String(r.corpus), records: Number(r.records || 0) }));

	return {
		totalProfiles,
		byType,
		totalAliases: countOf('profile_aliases'),
		totalIdentifiers: countOf('profile_identifiers'),
		totalLocations: countOf('profile_locations'),
		totalSourceRecords: countOf('source_records'),
		totalTimelineEntries: countOf('timeline_entries'),
		totalLinks: countOf('profile_links'),
		totalAlignments: countOf('alignment_candidates'),
		alignmentsByStatus,
		alignmentsByKind,
		corpora,
		path: getProfilesDir(),
	};
}

export { rowToAlignment, rowToLink, rowToProfile, rowToTimeline };
