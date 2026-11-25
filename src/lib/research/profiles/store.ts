import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
	countryToIsoAbbrev,
	detectProfileCountryCodes,
	getCountryFilterHints,
} from '@/lib/research/profiles/countries';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	defaultConfidenceForRelation,
	relationPriority,
} from '@/lib/research/profiles/edgeWeights';
import {
	detectFirmActiveFinraScope,
	detectFirmLiveSourceUrl,
	pickPreferredWebsiteUrl,
	sortIdentifiersByUrlPreference,
} from '@/lib/research/profiles/liveListing';
import {
	buildSafeFtsQuery,
	deduplicateLocations,
	formatCompactCityStateLocation,
	isTooGenericLocation,
	makeProfileSlug,
	normalizeIsoDate,
	normalizeLocationRecord,
	normalizeText,
	pickBestFullAddress,
	pickBestLocation,
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

function syncLifeDateMetadata(
	profileType: ProfileType,
	meta: Record<string, unknown>,
	startDate: string | null,
	endDate: string | null,
): Record<string, unknown> {
	if (profileType !== 'person') return meta;
	const next = { ...meta };
	if (startDate) next.birthDate = startDate;
	else delete next.birthDate;
	if (endDate) {
		next.deathDate = endDate;
		next.deceased = true;
	} else {
		delete next.deathDate;
		if (next.deceased === true) delete next.deceased;
	}
	return next;
}

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
	const inputStart =
		input.startDate !== undefined && input.startDate !== null
			? normalizeIsoDate(String(input.startDate)).date
			: input.startDate === null
				? null
				: undefined;
	const inputEnd =
		input.endDate !== undefined && input.endDate !== null
			? normalizeIsoDate(String(input.endDate)).date
			: input.endDate === null
				? null
				: undefined;

	const existing = db.prepare('SELECT * FROM profiles WHERE slug = ?').get(slug) as
		| Record<string, unknown>
		| undefined;

	if (existing) {
		const prevMeta = safeJsonParse<Record<string, unknown>>(existing.metadata_json, {});
		let mergedMeta: Record<string, unknown> = { ...prevMeta, ...(input.metadata || {}) };
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

		const nextStart =
			inputStart !== undefined
				? inputStart
				: existing.start_date != null
					? String(existing.start_date)
					: null;
		const nextEnd =
			inputEnd !== undefined ? inputEnd : existing.end_date != null ? String(existing.end_date) : null;
		mergedMeta = syncLifeDateMetadata(input.profileType, mergedMeta, nextStart, nextEnd);

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
	let meta: Record<string, unknown> = { ...(input.metadata || {}) };
	if (input.sourceCorpus) {
		meta.corpora = [input.sourceCorpus];
	}
	const startDate = inputStart ?? null;
	const endDate = inputEnd ?? null;
	meta = syncLifeDateMetadata(input.profileType, meta, startDate, endDate);

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
		startDate,
		endDate,
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

/** Allocate `type:slug` unique against profiles.slug, allowing the current row to keep its slug. */
function allocateUniqueProfileSlug(
	db: DatabaseSync,
	profileType: ProfileType,
	nameOrSlug: string,
	excludeProfileId?: string,
): string {
	const base = makeProfileSlug(profileType, nameOrSlug);
	let candidate = base;
	for (let n = 2; n < 80; n += 1) {
		const row = db.prepare('SELECT id FROM profiles WHERE slug = ? LIMIT 1').get(candidate) as
			| { id?: string }
			| undefined;
		if (!row?.id || (excludeProfileId && String(row.id) === excludeProfileId)) {
			return candidate;
		}
		const bare = base.includes(':') ? base.slice(base.indexOf(':') + 1) : base;
		candidate = `${profileType}:${bare}-${n}`;
	}
	const bare = base.includes(':') ? base.slice(base.indexOf(':') + 1) : base;
	return `${profileType}:${bare}-${crypto.randomUUID().slice(0, 8)}`;
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
	const nextStart =
		patch.startDate !== undefined
			? patch.startDate
				? normalizeIsoDate(String(patch.startDate)).date
				: null
			: current.startDate;
	const nextEnd =
		patch.endDate !== undefined
			? patch.endDate
				? normalizeIsoDate(String(patch.endDate)).date
				: null
			: current.endDate;
	let nextMeta = patch.metadata ? { ...current.metadata, ...patch.metadata } : { ...current.metadata };
	if (patch.startDate !== undefined || patch.endDate !== undefined) {
		nextMeta = syncLifeDateMetadata(nextType, nextMeta, nextStart, nextEnd);
	}
	const now = new Date().toISOString();

	const nameOrTypeChanged =
		nextName !== current.name || nextType !== current.profileType;
	let nextSlug = current.slug;
	if (nameOrTypeChanged) {
		nextSlug = allocateUniqueProfileSlug(db, nextType, nextName, current.id);
	}

	db.prepare(
		`UPDATE profiles
     SET name = ?, normalized_name = ?, profile_type = ?, status = ?,
         summary = ?, start_date = ?, end_date = ?, metadata_json = ?, slug = ?, updated_at = ?
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
		nextSlug,
		now,
		current.id,
	);

	// Keep old slug as alias so /profiles/{type}/{old-slug} still resolves.
	if (nextSlug !== current.slug) {
		addAlias(
			{
				profileId: current.id,
				alias: current.slug,
				aliasKind: 'slug',
				confidence: 1,
				sourceCorpus: 'manual',
			},
			db,
		);
		// Also keep the old bare slug part as a name alias when it differs from the new name.
		const oldBare = current.slug.includes(':')
			? current.slug.slice(current.slug.indexOf(':') + 1).replace(/-/g, ' ')
			: current.slug;
		if (oldBare && normalizeText(oldBare) !== normalizeText(nextName)) {
			addAlias(
				{
					profileId: current.id,
					alias: current.name,
					aliasKind: 'former_name',
					confidence: 0.95,
					sourceCorpus: 'manual',
				},
				db,
			);
		}
	}

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
	if (row) return rowToProfile(row);

	// Former slugs kept as alias_kind='slug' after rename (bookmarks / old URLs).
	const viaSlugAlias = db
		.prepare(
			`SELECT p.*
       FROM profile_aliases a
       JOIN profiles p ON p.id = a.profile_id
       WHERE a.alias_kind = 'slug' AND (a.alias = ? OR a.normalized_alias = ?)
       LIMIT 1`,
		)
		.get(key, normalizeText(key)) as Record<string, unknown> | undefined;
	if (viaSlugAlias) return rowToProfile(viaSlugAlias);

	return null;
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

	// FINRA CRD belongs only on person (individual) or firm (org) profiles.
	if (String(input.scheme || '').toLowerCase() === 'finra_crd') {
		const row = db
			.prepare(`SELECT id, slug, profile_type, metadata_json FROM profiles WHERE id = ?`)
			.get(input.profileId) as
			| { id: string; slug: string; profile_type: string; metadata_json: string }
			| undefined;
		if (row && row.profile_type !== 'person' && row.profile_type !== 'firm') {
			const oldSlug = String(row.slug || '');
			let meta: Record<string, unknown> = {};
			try {
				meta = JSON.parse(String(row.metadata_json || '{}') || '{}') as Record<string, unknown>;
			} catch {
				meta = {};
			}
			meta.hasFinra = true;
			meta.hasFinraData = true;
			if (/^\d{1,10}$/.test(clean)) meta.finraCrd = clean;
			meta.reclassifiedFrom = row.profile_type;
			meta.reclassifyReason = 'Has FINRA CRD — must be firm or person';
			updateProfileFields(
				row.id,
				{
					profileType: 'firm',
					metadata: meta,
				},
				db,
			);
			if (oldSlug) {
				addAlias(
					{
						profileId: row.id,
						alias: oldSlug,
						aliasKind: 'slug',
						sourceCorpus: input.sourceCorpus || 'manual',
					},
					db,
				);
			}
		}
	}
}

export function deleteAlias(
	input: { id: string; profileId: string },
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride ?? getProfilesDb();
	const id = String(input.id || '').trim();
	const profileId = String(input.profileId || '').trim();
	if (!id || !profileId) return false;
	const info = db
		.prepare('DELETE FROM profile_aliases WHERE id = ? AND profile_id = ?')
		.run(id, profileId);
	return Number(info.changes || 0) > 0;
}

export function updateAlias(
	input: {
		id: string;
		profileId: string;
		alias?: string;
		aliasKind?: AliasKind;
	},
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride ?? getProfilesDb();
	const id = String(input.id || '').trim();
	const profileId = String(input.profileId || '').trim();
	if (!id || !profileId) return false;
	const existing = db
		.prepare('SELECT * FROM profile_aliases WHERE id = ? AND profile_id = ?')
		.get(id, profileId) as Record<string, unknown> | undefined;
	if (!existing) return false;

	const nextAlias =
		input.alias != null ? String(input.alias).trim() : String(existing.alias || '');
	const nextNorm = normalizeText(nextAlias);
	if (!nextAlias || nextNorm.length < 2) return false;
	const nextKind = (input.aliasKind || String(existing.alias_kind || 'name')) as AliasKind;

	try {
		db.prepare(
			`UPDATE profile_aliases
       SET alias = ?, normalized_alias = ?, alias_kind = ?
       WHERE id = ? AND profile_id = ?`,
		).run(nextAlias, nextNorm, nextKind, id, profileId);
		return true;
	} catch {
		// Unique (profile_id, normalized_alias, alias_kind) collision
		return false;
	}
}

/**
 * Replace all `other_name` aliases for a profile with the given list.
 * Used by the under-title “other names” editor. Leaves former_name / slug / etc.
 */
export function replaceOtherNames(
	input: { profileId: string; names: string[] },
	dbOverride?: DatabaseSync,
): void {
	const db = dbOverride ?? getProfilesDb();
	const profileId = String(input.profileId || '').trim();
	if (!profileId) return;
	const profile = getProfile(profileId, db);
	const canonical = normalizeText(profile?.name || '');

	db.prepare(
		`DELETE FROM profile_aliases WHERE profile_id = ? AND alias_kind = 'other_name'`,
	).run(profileId);

	const seen = new Set<string>();
	for (const raw of input.names) {
		const clean = String(raw || '')
			.replace(/[\[\]]+/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		const norm = normalizeText(clean);
		if (!clean || norm.length < 2) continue;
		if (canonical && norm === canonical) continue;
		if (seen.has(norm)) continue;
		seen.add(norm);
		addAlias(
			{
				profileId,
				alias: clean,
				aliasKind: 'other_name',
				confidence: 1,
				sourceCorpus: 'manual',
			},
			db,
		);
	}
}

export function deleteIdentifier(
	input: { id: string; profileId: string },
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride ?? getProfilesDb();
	const id = String(input.id || '').trim();
	const profileId = String(input.profileId || '').trim();
	if (!id || !profileId) return false;
	const info = db
		.prepare('DELETE FROM profile_identifiers WHERE id = ? AND profile_id = ?')
		.run(id, profileId);
	return Number(info.changes || 0) > 0;
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
		confirmed?: boolean;
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
	const role = input.role || 'associated';
	const raw = norm.raw || norm.geoKey;
	const lat = typeof input.lat === 'number' && Number.isFinite(input.lat) ? input.lat : null;
	const lon = typeof input.lon === 'number' && Number.isFinite(input.lon) ? input.lon : null;
	const sourceCorpus = input.sourceCorpus || null;
	const confirmed = input.confirmed ? 1 : 0;
	// UNIQUE(profile_id, geo_key, role) is city-grain — a street address shares the city geo_key
	// with a prior "Dallas, TX" row. Upgrade city-only raws to the more specific street string.
	const existing = db
		.prepare(
			`SELECT id, raw, confirmed FROM profile_locations
       WHERE profile_id = ? AND geo_key = ? AND role = ?
       LIMIT 1`,
		)
		.get(input.profileId, norm.geoKey, role) as
		| { id?: string; raw?: string; confirmed?: number }
		| undefined;
	if (existing?.id) {
		const oldRaw = String(existing.raw || '');
		const oldHasStreet = /\d/.test(oldRaw);
		const newHasStreet = /\d/.test(raw);
		const shouldUpgrade =
			(newHasStreet && !oldHasStreet) || (!oldHasStreet && !newHasStreet && raw.length > oldRaw.length);
		if (shouldUpgrade || (input.confirmed && !existing.confirmed)) {
			db.prepare(
				`UPDATE profile_locations
         SET raw = CASE WHEN ? THEN ? ELSE raw END,
             city = COALESCE(?, city), county = COALESCE(?, county),
             state = COALESCE(?, state), country = COALESCE(?, country),
             lat = COALESCE(?, lat), lon = COALESCE(?, lon),
             source_corpus = COALESCE(?, source_corpus),
             confirmed = CASE WHEN ? THEN 1 ELSE confirmed END
         WHERE id = ?`,
			).run(
				shouldUpgrade ? 1 : 0,
				raw,
				norm.city,
				norm.county,
				norm.state,
				norm.country,
				lat,
				lon,
				sourceCorpus,
				confirmed,
				existing.id,
			);
		}
		return norm.geoKey;
	}
	db.prepare(
		`INSERT INTO profile_locations(
       id, profile_id, raw, city, county, state, country, geo_key, lat, lon, role, source_corpus, confirmed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		crypto.randomUUID(),
		input.profileId,
		raw,
		norm.city,
		norm.county,
		norm.state,
		norm.country,
		norm.geoKey,
		lat,
		lon,
		role,
		sourceCorpus,
		confirmed,
	);
	return norm.geoKey;
}

export function updateLocation(
	input: {
		id: string;
		profileId: string;
		raw?: string;
		city?: string | null;
		county?: string | null;
		state?: string | null;
		country?: string | null;
		role?: LocationRole;
		confirmed?: boolean;
	},
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride ?? getProfilesDb();
	const existing = db
		.prepare('SELECT * FROM profile_locations WHERE id = ? AND profile_id = ?')
		.get(input.id, input.profileId) as Record<string, unknown> | undefined;
	if (!existing) return false;

	const nextRaw = input.raw != null ? String(input.raw).trim() : String(existing.raw || '');
	if (!nextRaw) return false;

	const norm = normalizeLocationRecord({
		raw: nextRaw,
		city: input.city !== undefined ? input.city : existing.city != null ? String(existing.city) : null,
		county:
			input.county !== undefined
				? input.county
				: existing.county != null
					? String(existing.county)
					: null,
		state:
			input.state !== undefined ? input.state : existing.state != null ? String(existing.state) : null,
		country:
			input.country !== undefined
				? input.country
				: existing.country != null
					? String(existing.country)
					: null,
	});
	if (isTooGenericLocation(norm)) return false;

	const role = (input.role || String(existing.role || 'associated')) as LocationRole;
	const raw = norm.raw || norm.geoKey;
	const confirmed =
		input.confirmed !== undefined ? (input.confirmed ? 1 : 0) : Number(existing.confirmed || 0);

	// Role/geo change may collide with UNIQUE(profile_id, geo_key, role).
	const clash = db
		.prepare(
			`SELECT id FROM profile_locations
       WHERE profile_id = ? AND geo_key = ? AND role = ? AND id != ?
       LIMIT 1`,
		)
		.get(input.profileId, norm.geoKey, role, input.id) as { id?: string } | undefined;
	if (clash?.id) {
		// Merge into the existing row: keep the more specific raw, take confirmed OR, delete this row.
		const clashRow = db
			.prepare('SELECT raw, confirmed FROM profile_locations WHERE id = ?')
			.get(clash.id) as { raw?: string; confirmed?: number } | undefined;
		const clashRaw = String(clashRow?.raw || '');
		const preferNew =
			(/\d/.test(raw) && !/\d/.test(clashRaw)) ||
			(!/\d/.test(clashRaw) && !/\d/.test(raw) && raw.length > clashRaw.length);
		db.prepare(
			`UPDATE profile_locations
       SET raw = ?, city = COALESCE(?, city), county = COALESCE(?, county),
           state = COALESCE(?, state), country = COALESCE(?, country),
           confirmed = CASE WHEN ? OR confirmed = 1 THEN 1 ELSE 0 END
       WHERE id = ?`,
		).run(
			preferNew ? raw : clashRaw || raw,
			norm.city,
			norm.county,
			norm.state,
			norm.country,
			confirmed,
			clash.id,
		);
		db.prepare('DELETE FROM profile_locations WHERE id = ?').run(input.id);
		return true;
	}

	db.prepare(
		`UPDATE profile_locations
     SET raw = ?, city = ?, county = ?, state = ?, country = ?,
         geo_key = ?, role = ?, confirmed = ?
     WHERE id = ? AND profile_id = ?`,
	).run(
		raw,
		norm.city,
		norm.county,
		norm.state,
		norm.country,
		norm.geoKey,
		role,
		confirmed,
		input.id,
		input.profileId,
	);
	return true;
}

export function deleteLocation(
	input: { id: string; profileId: string },
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride ?? getProfilesDb();
	const result = db
		.prepare('DELETE FROM profile_locations WHERE id = ? AND profile_id = ?')
		.run(input.id, input.profileId);
	return Number(result.changes || 0) > 0;
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
			input.confidence ?? defaultConfidenceForRelation(input.relationType),
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
		input.confidence ?? defaultConfidenceForRelation(input.relationType),
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
		/** Initial triage status on insert only; existing confirmed/dismissed rows are preserved. */
		status?: AlignmentStatus;
	},
	dbOverride?: DatabaseSync,
): string {
	const db = dbOverride ?? getProfilesDb();
	const now = new Date().toISOString();
	const existing = db
		.prepare('SELECT id, status FROM alignment_candidates WHERE dedupe_key = ?')
		.get(input.dedupeKey) as { id?: string; status?: string } | undefined;

	if (existing?.id) {
		// Preserve dismissed / already-confirmed triage. Allow auto paths to
		// upgrade proposed → confirmed (org CSM) or proposed → dismissed
		// (e.g. building colocation with disjoint FINRA CRDs).
		const prev = String(existing.status || 'proposed') as AlignmentStatus;
		const upgradeToConfirmed =
			input.status === 'confirmed' && prev === 'proposed';
		const upgradeToDismissed =
			input.status === 'dismissed' && prev === 'proposed';
		if (upgradeToConfirmed || upgradeToDismissed) {
			const nextStatus = upgradeToConfirmed ? 'confirmed' : 'dismissed';
			db.prepare(
				`UPDATE alignment_candidates
         SET score = ?, caution_tier = ?, status = ?, rationale = ?, evidence_json = ?, updated_at = ?
         WHERE id = ?`,
			).run(
				Math.max(0, Math.min(1, Number(input.score.toFixed(3)))),
				input.cautionTier,
				nextStatus,
				input.rationale.slice(0, 1000),
				JSON.stringify(input.evidence.slice(0, 16)),
				now,
				String(existing.id),
			);
		} else {
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
		}
		return String(existing.id);
	}

	const insertStatus: AlignmentStatus =
		input.status === 'confirmed' || input.status === 'dismissed' ? input.status : 'proposed';
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO alignment_candidates(
       id, dedupe_key, alignment_kind, left_profile_id, right_profile_id,
       score, caution_tier, status, rationale, evidence_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.dedupeKey,
		input.alignmentKind,
		input.leftProfileId,
		input.rightProfileId || null,
		Math.max(0, Math.min(1, Number(input.score.toFixed(3)))),
		input.cautionTier,
		insertStatus,
		input.rationale.slice(0, 1000),
		JSON.stringify(input.evidence.slice(0, 16)),
		now,
		now,
	);
	return id;
}

/** Mark profile(s) as user-touched so left-panel browse floats them above ingest churn. */
/** Bump metadata.userTouchedAt so the profile floats to the top of the left list. */
export function touchProfilesForUserAction(
	profileIds: Array<string | null | undefined>,
	db?: DatabaseSync,
	atIso?: string,
): void {
	db = db || getProfilesDb();
	const now = atIso || new Date().toISOString();
	const ids = [...new Set(profileIds.map((id) => String(id || '').trim()).filter(Boolean))];
	if (!ids.length) return;
	const select = db.prepare('SELECT metadata_json FROM profiles WHERE id = ?');
	const update = db.prepare(
		`UPDATE profiles SET metadata_json = ?, updated_at = ? WHERE id = ?`,
	);
	for (const pid of ids) {
		const row = select.get(pid) as { metadata_json?: string } | undefined;
		if (!row) continue;
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
		} catch {
			meta = {};
		}
		meta.userTouchedAt = now;
		update.run(JSON.stringify(meta), now, pid);
	}
}

export function updateAlignmentStatus(
	id: string,
	status: AlignmentStatus,
): AlignmentCandidate | null {
	const db = getProfilesDb();
	const now = new Date().toISOString();
	const existing = db
		.prepare(
			`SELECT left_profile_id, right_profile_id FROM alignment_candidates WHERE id = ?`,
		)
		.get(id) as { left_profile_id?: string; right_profile_id?: string | null } | undefined;
	const info = db
		.prepare('UPDATE alignment_candidates SET status = ?, updated_at = ? WHERE id = ?')
		.run(status, now, id);
	if (!Number(info.changes || 0)) return null;

	// Accept (confirmed): bump involved profiles so they rise to the top of the left list.
	if (status === 'confirmed' && existing) {
		touchProfilesForUserAction(
			[existing.left_profile_id, existing.right_profile_id],
			db,
			now,
		);
	}

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
	/** Filter profiles tagged with a main category label (e.g. firm, education, government, medical_hospital, nonprofit, historic_event) */
	tag?: ProfileType;
	status?: ProfileStatus;
	corpus?: string;
	geo?: string;
	/** Flag / country code (ISO or special: un, eu) matching detected country flags. */
	countryCode?: string;
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
				`p.profile_type IN ('person','firm','education','nonprofit','medical_hospital','government')`,
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

	// Soft interview/opinion journalism is archived out of historic timelines — never list it.
	where.push(`COALESCE(json_extract(p.metadata_json, '$.newsSkipReason'), '') != 'soft_journalism'`);

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

	if (filter.countryCode) {
		const hints = getCountryFilterHints(filter.countryCode);
		if (hints) {
			const locParts: string[] = [];
			const locParams: string[] = [];
			for (const c of hints.locationCountries) {
				// Exact country-field match only (safe for short codes like us/un/eu)
				locParts.push(`lower(COALESCE(pl.country,'')) = ?`);
				locParams.push(c);
			}
			for (const prefix of hints.geoPrefixes) {
				locParts.push(`lower(COALESCE(pl.geo_key,'')) LIKE ?`);
				locParams.push(`${prefix}%`);
			}
			for (const term of hints.textTerms) {
				// Avoid short tokens in LIKE (e.g. "un" matching "Manhattan")
				if (term.length < 4) continue;
				locParts.push(`lower(COALESCE(pl.raw,'')) LIKE ?`);
				locParams.push(`%${term}%`);
			}
			const textParts: string[] = [];
			const textParams: string[] = [];
			for (const term of hints.textTerms) {
				if (term.length < 4) continue;
				textParts.push(`lower(p.name) LIKE ?`);
				textParams.push(`%${term}%`);
				textParts.push(`lower(COALESCE(p.summary,'')) LIKE ?`);
				textParams.push(`%${term}%`);
				textParts.push(`lower(COALESCE(p.metadata_json,'')) LIKE ?`);
				textParams.push(`%${term}%`);
			}
			const clauses: string[] = [];
			if (locParts.length) {
				clauses.push(
					`EXISTS (
             SELECT 1 FROM profile_locations pl
             WHERE pl.profile_id = p.id AND (${locParts.join(' OR ')})
           )`,
				);
				params.push(...locParams);
			}
			if (textParts.length) {
				clauses.push(`(${textParts.join(' OR ')})`);
				params.push(...textParams);
			}
			if (clauses.length) {
				where.push(`(${clauses.join(' OR ')})`);
			}
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

	// Left-list browse: user Accept/Merge/Apply-edit touches (`metadata.userTouchedAt`) float above
	// ingest churn (`updated_at` from FINRA sync). Then newest-changed, then name.
	// Text search: rank name/alias matches above FTS summary hits, then the same recency keys.
	const orderParams: Array<string | number> = [];
	let orderSql: string;
	const updatedThenName = `CASE
             WHEN json_extract(p.metadata_json, '$.userTouchedAt') IS NOT NULL THEN 0
             ELSE 1
           END ASC,
           COALESCE(json_extract(p.metadata_json, '$.userTouchedAt'), '') DESC,
           datetime(p.updated_at) DESC,
           p.name ASC`;
	if (q) {
		// Closest name matches first (exact → prefix → contains). Prefer primary name over
		// alias; among prefix/contains hits, shorter names rank closer. Recency is secondary.
		const normQ = normalizeText(q);
		const like = `%${normQ}%`;
		const prefix = `${normQ}%`;
		orderSql = `CASE
             WHEN p.normalized_name = ? THEN 0
             WHEN EXISTS (
               SELECT 1 FROM profile_aliases pa
               WHERE pa.profile_id = p.id AND pa.normalized_alias = ?
             ) THEN 1
             WHEN p.normalized_name LIKE ? THEN 2
             WHEN EXISTS (
               SELECT 1 FROM profile_aliases pa
               WHERE pa.profile_id = p.id AND pa.normalized_alias LIKE ?
             ) THEN 3
             WHEN p.normalized_name LIKE ? THEN 4
             WHEN EXISTS (
               SELECT 1 FROM profile_aliases pa
               WHERE pa.profile_id = p.id AND pa.normalized_alias LIKE ?
             ) THEN 5
             WHEN lower(p.slug) LIKE ? THEN 6
             WHEN EXISTS (
               SELECT 1 FROM profile_identifiers pi
               WHERE pi.profile_id = p.id AND pi.normalized_value LIKE ?
             ) THEN 7
             ELSE 8
           END ASC,
           length(p.normalized_name) ASC,
           p.name ASC`;
		orderParams.push(
			normQ,
			normQ,
			prefix,
			prefix,
			like,
			like,
			like,
			`%${q.toLowerCase().replace(/\s+/g, '')}%`,
		);
	} else if (
		filter.profileType === 'historic_event' ||
		filter.profileType === 'narratives'
	) {
		// Historic Events tab: most recent event date first; undated last.
		orderSql = `CASE
             WHEN COALESCE(p.start_date, p.end_date) IS NULL THEN 1
             ELSE 0
           END ASC,
           COALESCE(p.start_date, p.end_date, '') DESC,
           p.name ASC`;
	} else {
		orderSql = updatedThenName;
	}

	const rows = db
		.prepare(
			`SELECT p.*,
              (SELECT COUNT(*) FROM profile_aliases pa WHERE pa.profile_id = p.id) AS alias_count,
              (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_count,
              (SELECT COUNT(*) FROM timeline_entries te WHERE te.profile_id = p.id) AS timeline_count,
              (SELECT COUNT(*) FROM alignment_candidates ac WHERE ac.left_profile_id = p.id OR ac.right_profile_id = p.id) AS alignment_count,
              (SELECT ploc.raw FROM profile_locations ploc WHERE ploc.profile_id = p.id
               ORDER BY CASE WHEN COALESCE(ploc.confirmed, 0) = 1 THEN 0 ELSE 1 END,
                        CASE WHEN ploc.role = 'residence' AND COALESCE(ploc.confirmed, 0) = 0 THEN 9
                             WHEN ploc.role = 'residence' THEN 0
                             WHEN ploc.role = 'hq' THEN 1
                             WHEN ploc.role = 'branch' THEN 2
                             ELSE 3 END,
                        CASE WHEN ploc.raw GLOB '*[0-9]*' THEN 0 ELSE 1 END,
                        length(ploc.raw) DESC, ploc.raw ASC
               LIMIT 1) AS primary_location,
              (SELECT GROUP_CONCAT(DISTINCT peer.profile_type)
               FROM profile_links pl
               JOIN profiles peer ON peer.id = CASE WHEN pl.from_profile_id = p.id THEN pl.to_profile_id ELSE pl.from_profile_id END
               WHERE (pl.from_profile_id = p.id OR pl.to_profile_id = p.id)
                 AND peer.profile_type != 'person') AS linked_categories
       FROM profiles p
       ${whereSql}
       ORDER BY
         ${orderSql}
       LIMIT ? OFFSET ?`,
		)
		.all(...params, ...orderParams, limit, offset) as Array<Record<string, unknown>>;

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
			const idents = idByPid.get(prof.id) || [];
			const locs = locByPid.get(prof.id) || [];
			prof.countryCodes = detectProfileCountryCodes({
				name: prof.name,
				profileType: prof.profileType,
				summary: prof.summary,
				locations: locs,
				identifiers: idents,
				metadata: prof.metadata,
			});
			// Left-list: compact City, ST (omit USA; append ISO when abroad) for all types.
			{
				const best = pickBestLocation(locs);
				prof.primaryLocation = best
					? formatCompactCityStateLocation(best, {
							countryAbbrev: countryToIsoAbbrev(best.country),
						})
					: null;
			}
			if (prof.profileType === 'person' || prof.profileType === 'firm') {
				const metaCrd = String(prof.metadata?.finraCrd || '').trim();
				const identCrd = idents.find((i) => i.scheme.toLowerCase() === 'finra_crd')?.value?.trim() || '';
				const crd = /^\d{1,10}$/.test(metaCrd) ? metaCrd : /^\d{1,10}$/.test(identCrd) ? identCrd : '';
				prof.finraCrd = crd || null;
			}
			if (prof.profileType === 'firm') {
				prof.hasLiveSourceUrl = detectFirmLiveSourceUrl(prof.metadata, idents);
				prof.hasActiveFinraScope = detectFirmActiveFinraScope(prof.metadata);
			}
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
	// Hidden soft-journalism cards: treat as not found so direct URLs cannot open them.
	if (String((profile.metadata as Record<string, unknown> | null)?.newsSkipReason || '') === 'soft_journalism') {
		return null;
	}

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
	const identifiers: ProfileIdentifier[] = sortIdentifiersByUrlPreference(
		identRows.map((r) => ({
			id: String(r.id),
			profileId: String(r.profile_id),
			scheme: String(r.scheme) as IdentifierScheme,
			value: String(r.value),
			normalizedValue: String(r.normalized_value),
			sourceCorpus: r.source_corpus != null ? String(r.source_corpus) : null,
		})),
	);
	if (profile.profileType === 'firm') {
		profile.hasLiveSourceUrl = detectFirmLiveSourceUrl(profile.metadata, identifiers);
		profile.hasActiveFinraScope = detectFirmActiveFinraScope(profile.metadata);
	}
	// Surface preferred website in metadata for UI "Website ↗" when missing.
	const preferredWebsite = pickPreferredWebsiteUrl([
		typeof profile.metadata.website === 'string' ? profile.metadata.website : null,
		typeof profile.metadata.companyUrl === 'string' ? profile.metadata.companyUrl : null,
		...identifiers.filter((i) => i.scheme === 'url').map((i) => i.value),
	]);
	if (preferredWebsite) {
		if (profile.metadata.website !== preferredWebsite) {
			profile.metadata = { ...profile.metadata, website: preferredWebsite };
		}
		if (!profile.metadata.companyUrl) {
			profile.metadata = { ...profile.metadata, companyUrl: preferredWebsite };
		}
	}

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
		confirmed: Boolean(r.confirmed),
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
       ORDER BY te.event_date IS NULL ASC, te.event_date DESC, te.created_at DESC
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
	// Prefer digit-bearing street HQ over country/city-only rows (same rule as listProfiles SQL)
	profile.primaryLocation = pickBestFullAddress(locations) || locations[0]?.raw || null;

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
	]);

	const REL_PRIORITY: Record<string, number> = new Proxy(
		{} as Record<string, number>,
		{
			get: (_t, prop: string) => relationPriority(prop as ProfileRelationType),
		},
	);

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
			{
				name: string;
				profileType: string;
				summary: string;
				startDate: string | null;
				endDate: string | null;
				metadata: Record<string, unknown>;
			}
		>();
		const peerLocsById = new Map<
			string,
			Array<{
				raw: string;
				city: string | null;
				county: string | null;
				state: string | null;
				country: string | null;
				geoKey: string;
				role: string | null;
			}>
		>();
		const peerIdentsById = new Map<string, Array<{ scheme: string; value: string }>>();

		const CHUNK = 500;
		for (let i = 0; i < allPeerIds.length; i += CHUNK) {
			const chunkIds = allPeerIds.slice(i, i + CHUNK);
			const placeholders = chunkIds.map(() => '?').join(',');
			const peerRows = db
				.prepare(
					`SELECT id, name, profile_type, summary, start_date, end_date, metadata_json FROM profiles WHERE id IN (${placeholders})`,
				)
				.all(...chunkIds) as Array<Record<string, unknown>>;
			for (const r of peerRows) {
				peerInfoById.set(String(r.id), {
					name: String(r.name || ''),
					profileType: String(r.profile_type || 'firm'),
					summary: String(r.summary || ''),
					startDate: r.start_date != null ? String(r.start_date) : null,
					endDate: r.end_date != null ? String(r.end_date) : null,
					metadata: safeJsonParse<Record<string, unknown>>(r.metadata_json, {}),
				});
			}

			const peerLocRows = db
				.prepare(
					`SELECT profile_id, raw, city, county, state, country, geo_key, role, confirmed FROM profile_locations WHERE profile_id IN (${placeholders})`,
				)
				.all(...chunkIds) as Array<Record<string, unknown>>;
			for (const lr of peerLocRows) {
				const pid = String(lr.profile_id);
				const list = peerLocsById.get(pid) || [];
				list.push({
					raw: String(lr.raw || ''),
					city: lr.city != null ? String(lr.city) : null,
					county: lr.county != null ? String(lr.county) : null,
					state: lr.state != null ? String(lr.state) : null,
					country: lr.country != null ? String(lr.country) : null,
					geoKey: String(lr.geo_key || ''),
					role: lr.role != null ? String(lr.role) : null,
					confirmed: Boolean(lr.confirmed),
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
				if (!emp.location) {
					emp.location = pickBestFullAddress(peerLocsById.get(emp.orgProfileId) || []);
				}
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
			const peerInfo = peerInfoById.get(peerId);
			if (peerInfo) {
				l.peerStartDate = peerInfo.startDate;
				l.peerEndDate = peerInfo.endDate;
				l.peerSummary = peerInfo.summary || null;
			}
			l.peerPrimaryLocation = pickBestFullAddress(peerLocsById.get(peerId) || []);
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
	/** Prefer an existing org card when known (slug or id). */
	orgIdOrSlug?: string | null;
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
	];
	const orgType: ProfileType =
		input.orgCategory && allowedOrgCategories.includes(input.orgCategory)
			? input.orgCategory
			: 'firm';
	const corpus = input.sourceCorpus || 'manual';

	const resolveExistingOrg = (): Profile | null => {
		if (input.orgIdOrSlug) {
			const byKey = getProfile(String(input.orgIdOrSlug).trim(), db);
			if (byKey && allowedOrgCategories.includes(byKey.profileType)) return byKey;
		}
		const candidates = [orgName];
		const byName = db
			.prepare(
				`SELECT * FROM profiles
         WHERE profile_type = ? AND name = ? COLLATE NOCASE
         LIMIT 1`,
			)
			.get(orgType, orgName) as Record<string, unknown> | undefined;
		if (byName) return rowToProfile(byName);
		const byAlias = db
			.prepare(
				`SELECT p.*
         FROM profile_aliases a
         JOIN profiles p ON p.id = a.profile_id
         WHERE p.profile_type = ? AND a.alias = ? COLLATE NOCASE
         LIMIT 1`,
			)
			.get(orgType, orgName) as Record<string, unknown> | undefined;
		if (byAlias) return rowToProfile(byAlias);
		// Cross-type fallback among org actor types (e.g. WHO stored as nonprofit vs government)
		const cross = db
			.prepare(
				`SELECT * FROM profiles
         WHERE profile_type IN ('firm','education','nonprofit','medical_hospital','government')
           AND name = ? COLLATE NOCASE
         LIMIT 1`,
			)
			.get(orgName) as Record<string, unknown> | undefined;
		if (cross) return rowToProfile(cross);
		const crossAlias = db
			.prepare(
				`SELECT p.*
         FROM profile_aliases a
         JOIN profiles p ON p.id = a.profile_id
         WHERE p.profile_type IN ('firm','education','nonprofit','medical_hospital','government')
           AND a.alias = ? COLLATE NOCASE
         LIMIT 1`,
			)
			.get(orgName) as Record<string, unknown> | undefined;
		if (crossAlias) return rowToProfile(crossAlias);
		void candidates;
		return null;
	};

	const existingOrg = resolveExistingOrg();
	const orgProfile =
		existingOrg ||
		upsertProfile(
			{
				profileType: orgType,
				name: orgName,
				sourceCorpus: corpus,
			},
			db,
		);

	// Keep requested display name as an alias when we reused a differently named org card
	if (existingOrg && existingOrg.name.toLowerCase() !== orgName.toLowerCase()) {
		addAlias(
			{
				profileId: orgProfile.id,
				alias: orgName,
				aliasKind: 'name',
				confidence: 0.95,
				sourceCorpus: corpus,
			},
			db,
		);
	}

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
		// Prefer HQ on the org card when it has no HQ yet (full street addresses help employment + geo weighting)
		const orgHasHq = Boolean(
			db
				.prepare(
					`SELECT 1 AS ok FROM profile_locations
           WHERE profile_id = ? AND role = 'hq' AND trim(raw) != ''
           LIMIT 1`,
				)
				.get(orgProfile.id) as { ok?: number } | undefined,
		);
		addLocation(
			{
				profileId: orgProfile.id,
				raw: locClean,
				role: orgHasHq ? 'associated' : 'hq',
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

	const startDate = input.startDate
		? normalizeIsoDate(String(input.startDate).trim()).date
		: null;
	const endDate = input.endDate ? normalizeIsoDate(String(input.endDate).trim()).date : null;

	const linkId = upsertProfileLink(
		{
			fromProfileId: person.id,
			toProfileId: orgProfile.id,
			relationType: relType,
			roleLabel,
			startDate,
			endDate,
			status: 'verified',
			confidence: 0.95,
			angle: orgType === 'education' ? 'academic_research' : orgType === 'government' ? 'policy' : 'corporate',
			sourceCorpus: corpus,
			evidenceNote: evidenceParts.join('; ') || `Employment at ${orgName}`,
		},
		db,
	);

	// Also record on the person's timeline so employment history participates in timeline alignment
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

/** Major firm/person identity schemes — shared value required to auto-merge distinct cards. */
export const MAJOR_IDENTITY_SCHEMES = [
	'finra_crd',
	'sec_cik',
	'ticker',
	'irs_ein',
	'cusip',
] as const;

export type MajorIdentityScheme = (typeof MAJOR_IDENTITY_SCHEMES)[number];

function countOfficialNameIds(profileId: string, db: DatabaseSync): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM profile_identifiers
       WHERE profile_id = ?
         AND lower(scheme) IN ('finra_crd','sec_cik','ticker','irs_ein','cusip','orcid','ror')`,
		)
		.get(profileId) as { n?: number } | undefined;
	return Number(row?.n || 0);
}

/** Map of scheme → distinct identifier values for a profile. */
export function getMajorIdentityMap(
	profileId: string,
	dbOverride?: DatabaseSync,
): Map<string, Set<string>> {
	const db = dbOverride || getProfilesDb();
	const out = new Map<string, Set<string>>();
	const rows = db
		.prepare(
			`SELECT lower(scheme) AS scheme, value
       FROM profile_identifiers
       WHERE profile_id = ?
         AND lower(scheme) IN ('finra_crd','sec_cik','ticker','irs_ein','cusip')`,
		)
		.all(profileId) as Array<{ scheme?: string; value?: string }>;
	for (const r of rows) {
		const scheme = String(r.scheme || '').trim();
		const value = String(r.value || '').trim().toLowerCase();
		if (!scheme || !value) continue;
		const set = out.get(scheme) || new Set<string>();
		set.add(value);
		out.set(scheme, set);
	}
	return out;
}

/** True when both profiles share at least one major-ID value on the same scheme. */
export function profilesShareMajorIdentity(
	aId: string,
	bId: string,
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride || getProfilesDb();
	const a = getMajorIdentityMap(aId, db);
	const b = getMajorIdentityMap(bId, db);
	for (const [scheme, vals] of a) {
		const other = b.get(scheme);
		if (!other) continue;
		for (const v of vals) {
			if (other.has(v)) return true;
		}
	}
	return false;
}

/**
 * True when both sides carry major IDs on the same scheme with no overlapping value
 * (e.g. two different FINRA CRDs / CIKs) — must stay separate profiles.
 */
export function profilesHaveConflictingMajorIds(
	aId: string,
	bId: string,
	dbOverride?: DatabaseSync,
): boolean {
	const db = dbOverride || getProfilesDb();
	const a = getMajorIdentityMap(aId, db);
	const b = getMajorIdentityMap(bId, db);
	for (const scheme of MAJOR_IDENTITY_SCHEMES) {
		const av = a.get(scheme);
		const bv = b.get(scheme);
		if (!av?.size || !bv?.size) continue;
		let shared = false;
		for (const v of av) {
			if (bv.has(v)) {
				shared = true;
				break;
			}
		}
		if (!shared) return true;
	}
	return false;
}

/**
 * Canonical display name for a merge: prefer the name tied to official IDs;
 * otherwise the longer name. Shorter / non-canonical forms become other_name aliases.
 */
function pickMergeCanonicalName(
	aName: string,
	bName: string,
	aOfficialIds: number,
	bOfficialIds: number,
): { canonical: string; otherNames: string[] } {
	const a = String(aName || '').trim();
	const b = String(bName || '').trim();
	if (!a && !b) return { canonical: '', otherNames: [] };
	if (!a) return { canonical: b, otherNames: [] };
	if (!b) return { canonical: a, otherNames: [] };
	const same = a.toLowerCase() === b.toLowerCase();
	if (aOfficialIds > 0 && bOfficialIds === 0) {
		return { canonical: a, otherNames: same ? [] : [b] };
	}
	if (bOfficialIds > 0 && aOfficialIds === 0) {
		return { canonical: b, otherNames: same ? [] : [a] };
	}
	// Both (or neither) have official IDs → longest display name wins.
	if (b.length > a.length) return { canonical: b, otherNames: same ? [] : [a] };
	if (a.length > b.length) return { canonical: a, otherNames: same ? [] : [b] };
	return { canonical: a, otherNames: same ? [] : [b] };
}

/**
 * Merge `mergeIdOrSlug` into `keepIdOrSlug`: transfers aliases, identifiers, locations,
 * timeline entries, links (deduped, no self-loops), alignment candidates, and metadata
 * (corpora/categoryTags/summary/dates), picks canonical display name (official-ID name or
 * longest), stores the shorter as other_name, and deletes the duplicate `merge` profile.
 *
 * If the merge target has official IDs and keep does not (or has a longer legal name when
 * ID counts tie), roles are swapped so the stronger card’s slug survives.
 */
export function mergeProfiles(
	keepIdOrSlug: string,
	mergeIdOrSlug: string,
	dbOverride?: DatabaseSync,
): { kept: Profile; mergedId: string; mergedName: string } | null {
	const db = dbOverride ?? getProfilesDb();
	let keep = getProfile(keepIdOrSlug, db);
	let merge = getProfile(mergeIdOrSlug, db);
	if (!keep || !merge || keep.id === merge.id) return null;

	// Never collapse two entities that each have a distinct major ID (CRD/CIK/ticker/EIN/CUSIP).
	// One profile per ID — same/similar names alone are not enough.
	if (profilesHaveConflictingMajorIds(keep.id, merge.id, db)) {
		return null;
	}

	// Swap keep/merge only when the merge target has more official IDs.
	// Display-name length is applied below via pickMergeCanonicalName — do not swap
	// the surviving slug just because a predecessor name is slightly longer
	// (e.g. "BMG Interactive" vs "Rockstar Games").
	let keepOfficial = countOfficialNameIds(keep.id, db);
	let mergeOfficial = countOfficialNameIds(merge.id, db);
	if (mergeOfficial > keepOfficial) {
		const tmp = keep;
		keep = merge;
		merge = tmp;
		const tmpN = keepOfficial;
		keepOfficial = mergeOfficial;
		mergeOfficial = tmpN;
	}

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

		// Prefer an official company website as primary; secondary urls stay as identifiers.
		const keepUrlRows = tx
			.prepare(
				`SELECT value FROM profile_identifiers WHERE profile_id = ? AND scheme = 'url'`,
			)
			.all(keep.id) as Array<{ value: string }>;
		const mergeUrlRows = tx
			.prepare(
				`SELECT value FROM profile_identifiers WHERE profile_id = ? AND scheme = 'url'`,
			)
			.all(merge.id) as Array<{ value: string }>;
		const metaUrlCandidates = [
			mergedMeta.website,
			mergedMeta.companyUrl,
			mergedMeta.websiteUrl,
			mergedMeta.homepage,
			keep.metadata.website,
			keep.metadata.companyUrl,
			merge.metadata.website,
			merge.metadata.companyUrl,
		];
		const preferredWebsite = pickPreferredWebsiteUrl([
			...keepUrlRows.map((r) => r.value),
			...mergeUrlRows.map((r) => r.value),
			...metaUrlCandidates.map((v) => (typeof v === 'string' ? v : null)),
		]);
		if (preferredWebsite) {
			mergedMeta.website = preferredWebsite;
			mergedMeta.companyUrl = preferredWebsite;
		}

		const nextStatus: ProfileStatus =
			keep.status === 'pinned' || merge.status === 'pinned' ? 'pinned' : keep.status;
		// Keep both summaries when each has unique content (do not drop the shorter side).
		// Strip embedded images / data-URIs so merged overview text stays prose-only.
		const stripSummaryImages = (s: string) =>
			String(s || '')
				.replace(/!\[[^\]]*]\(\s*(?:data:image\/[^)\s]+|[^)\s]+\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?)(?:\?[^)\s]*)?)\s*\)/gi, '')
				.replace(/<img\b[^>]*>/gi, '')
				.replace(/data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=\s]+/gi, '')
				.replace(/\n{3,}/g, '\n\n')
				.trim();
		const keepSum = stripSummaryImages(keep.summary);
		const mergeSum = stripSummaryImages(merge.summary);
		let nextSummary = keepSum || mergeSum;
		if (keepSum && mergeSum) {
			const keepNorm = keepSum.toLowerCase();
			const mergeNorm = mergeSum.toLowerCase();
			if (keepNorm === mergeNorm) {
				nextSummary = keepSum.length >= mergeSum.length ? keepSum : mergeSum;
			} else if (keepNorm.includes(mergeNorm)) {
				nextSummary = keepSum;
			} else if (mergeNorm.includes(keepNorm)) {
				nextSummary = mergeSum;
			} else {
				nextSummary = `${keepSum}\n\n${mergeSum}`;
			}
		}
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

		const namePick = pickMergeCanonicalName(
			keep.name,
			merge.name,
			keepOfficial,
			mergeOfficial,
		);
		const canonicalName = namePick.canonical || keep.name;
		mergedMeta.mergeCanonicalNameRule =
			keepOfficial !== mergeOfficial
				? 'official_id'
				: 'longest_name';

		tx.prepare(
			`UPDATE profiles
       SET name = ?, normalized_name = ?, status = ?, summary = ?, start_date = ?, end_date = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
		).run(
			canonicalName,
			normalizeText(canonicalName),
			nextStatus,
			nextSummary,
			nextStart,
			nextEnd,
			JSON.stringify(mergedMeta),
			now,
			keep.id,
		);

		// 2. Shorter / non-canonical names → other_name; transfer all aliases from merge
		for (const other of namePick.otherNames) {
			addAlias(
				{
					profileId: keep.id,
					alias: other,
					aliasKind: 'other_name',
					confidence: 0.95,
				},
				tx,
			);
		}
		// If keep's original name lost the display slot, keep it as other_name too.
		if (
			keep.name.trim() &&
			keep.name.trim().toLowerCase() !== canonicalName.trim().toLowerCase()
		) {
			addAlias(
				{
					profileId: keep.id,
					alias: keep.name.trim(),
					aliasKind: 'other_name',
					confidence: 0.95,
				},
				tx,
			);
		}
		const mergeAliases = tx
			.prepare('SELECT alias, alias_kind, confidence, source_corpus FROM profile_aliases WHERE profile_id = ?')
			.all(merge.id) as Array<Record<string, unknown>>;
		for (const a of mergeAliases) {
			const alias = String(a.alias || '').trim();
			if (!alias) continue;
			const kindRaw = String(a.alias_kind || 'name');
			const kind =
				alias.toLowerCase() === canonicalName.trim().toLowerCase()
					? ('name' as AliasKind)
					: kindRaw === 'name' &&
						  namePick.otherNames.some((o) => o.toLowerCase() === alias.toLowerCase())
						? ('other_name' as AliasKind)
						: (kindRaw as AliasKind);
			addAlias(
				{
					profileId: keep.id,
					alias,
					aliasKind: kind,
					confidence: Number(a.confidence ?? 1),
					sourceCorpus: a.source_corpus != null ? String(a.source_corpus) : null,
				},
				tx,
			);
		}

		// 3. Move identifiers (ignore duplicates). URLs: keep all distinct values;
		// preferred official site is already written to metadata.website / companyUrl.
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
		// Recompute preferred website after identifier transfer (merge may have added a better url).
		const allUrlRows = tx
			.prepare(
				`SELECT value FROM profile_identifiers WHERE profile_id = ? AND scheme = 'url'`,
			)
			.all(keep.id) as Array<{ value: string }>;
		const preferredAfter = pickPreferredWebsiteUrl([
			...allUrlRows.map((r) => r.value),
			typeof mergedMeta.website === 'string' ? mergedMeta.website : null,
			typeof mergedMeta.companyUrl === 'string' ? mergedMeta.companyUrl : null,
		]);
		if (preferredAfter && preferredAfter !== mergedMeta.website) {
			mergedMeta.website = preferredAfter;
			mergedMeta.companyUrl = preferredAfter;
			tx.prepare(
				`UPDATE profiles SET metadata_json = ?, updated_at = ? WHERE id = ?`,
			).run(JSON.stringify(mergedMeta), new Date().toISOString(), keep.id);
		}

		// 4. Move locations (ignore duplicates)
		const mergeLocs = tx
			.prepare(
				'SELECT raw, city, county, state, country, lat, lon, role, source_corpus, confirmed FROM profile_locations WHERE profile_id = ?',
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
					confirmed: Boolean(loc.confirmed),
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

		// 8. Touch keep last so left-panel browse floats it above ingest churn
		const touchAt = new Date().toISOString();
		touchProfilesForUserAction([keep.id], tx, touchAt);
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
