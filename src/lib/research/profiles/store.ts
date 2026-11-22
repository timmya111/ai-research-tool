import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	buildSafeFtsQuery,
	makeProfileSlug,
	normalizeGeoKey,
	normalizeIsoDate,
	normalizeText,
	normalizeUsState,
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
): Profile | null {
	const db = getProfilesDb();
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
	const raw = String(input.raw || '').trim();
	const state = normalizeUsState(input.state);
	const geoKey = normalizeGeoKey({
		raw,
		city: input.city,
		county: input.county,
		state,
		country: input.country,
	});
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT OR IGNORE INTO profile_locations(
       id, profile_id, raw, city, county, state, country, geo_key, lat, lon, role, source_corpus
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.profileId,
		raw || geoKey,
		input.city ? String(input.city).trim() : null,
		input.county ? String(input.county).trim() : null,
		state,
		input.country ? String(input.country).trim() : null,
		geoKey,
		typeof input.lat === 'number' && Number.isFinite(input.lat) ? input.lat : null,
		typeof input.lon === 'number' && Number.isFinite(input.lon) ? input.lon : null,
		input.role || 'associated',
		input.sourceCorpus || null,
	);
	return geoKey;
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
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	if (input.fromProfileId === input.toProfileId) return '';
	const dedupeKey = sha256Key([
		input.fromProfileId,
		input.toProfileId,
		input.relationType,
		input.sourceCorpus,
		input.roleLabel || '',
	]);

	const existing = db.prepare('SELECT id FROM profile_links WHERE dedupe_key = ?').get(dedupeKey) as
		| { id?: string }
		| undefined;
	const now = new Date().toISOString();
	if (existing?.id) {
		db.prepare(
			`UPDATE profile_links
       SET confidence = MAX(confidence, ?),
           evidence_note = CASE WHEN length(?) > length(evidence_note) THEN ? ELSE evidence_note END,
           updated_at = ?
       WHERE id = ?`,
		).run(
			input.confidence ?? 0.8,
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
			where.push(`p.profile_type IN ('person','firm','university','nonprofit','agency')`);
		} else if (filter.profileType === 'narratives') {
			where.push(`p.profile_type IN ('subject_matter','historic_event')`);
		} else {
			where.push('p.profile_type = ?');
			params.push(filter.profileType);
		}
	}

	if (filter.status) {
		where.push('p.status = ?');
		params.push(filter.status);
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
              (SELECT COUNT(*) FROM alignment_candidates ac WHERE ac.left_profile_id = p.id OR ac.right_profile_id = p.id) AS alignment_count
       FROM profiles p
       ${whereSql}
       ORDER BY
         CASE p.status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
         CASE p.profile_type WHEN 'subject_matter' THEN 0 WHEN 'historic_event' THEN 1 ELSE 2 END,
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
		return prof;
	});

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
	const locations: ProfileLocation[] = locRows.map((r) => ({
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

	const linkRows = db
		.prepare(
			`SELECT pl.*,
              fp.name AS from_name, fp.slug AS from_slug, fp.profile_type AS from_type,
              tp.name AS to_name, tp.slug AS to_slug, tp.profile_type AS to_type
       FROM profile_links pl
       JOIN profiles fp ON fp.id = pl.from_profile_id
       JOIN profiles tp ON tp.id = pl.to_profile_id
       WHERE pl.from_profile_id = ? OR pl.to_profile_id = ?
       ORDER BY pl.confidence DESC, pl.created_at DESC
       LIMIT 250`,
		)
		.all(profile.id, profile.id) as Array<Record<string, unknown>>;
	const links = linkRows.map(rowToLink);

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

	const linkTotal = Number(
		(
			db
				.prepare('SELECT COUNT(*) AS c FROM profile_links WHERE from_profile_id = ? OR to_profile_id = ?')
				.get(profile.id, profile.id) as { c?: number }
		)?.c || 0,
	);
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

	return {
		profile,
		aliases,
		identifiers,
		locations,
		links,
		alignments,
		recentTimeline,
		counts: {
			aliases: aliases.length,
			identifiers: identifiers.length,
			locations: locations.length,
			links: linkTotal,
			timelineEntries: timelineTotal,
			alignments: alignTotal,
		},
	};
}

export function getProfileStats(): ProfileStats {
	const db = getProfilesDb();
	const byType: Record<ProfileType, number> = {
		person: 0,
		firm: 0,
		university: 0,
		nonprofit: 0,
		agency: 0,
		subject_matter: 0,
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
