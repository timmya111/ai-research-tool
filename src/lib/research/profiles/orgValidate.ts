/**
 * Org corpus validation: cluster duplicates / near-names for firm, education,
 * nonprofit, medical_hospital, government — with aggressive non-firm merges and
 * strict firm gates (shared major ID or styling twin; never distinct CRDs).
 */
import type { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeText, stripLegalSuffixes } from '@/lib/research/profiles/normalize';
import {
	getMajorIdentityMap,
	mergeProfiles,
	profilesHaveConflictingMajorIds,
	profilesShareMajorIdentity,
	touchProfilesForUserAction,
} from '@/lib/research/profiles/store';
import type { ProfileType } from '@/lib/research/profiles/types';

export const ORG_VALIDATE_TYPES: ProfileType[] = [
	'medical_hospital',
	'nonprofit',
	'education',
	'government',
	'firm',
];

const NON_FIRM = new Set<ProfileType>([
	'medical_hospital',
	'nonprofit',
	'education',
	'government',
]);

const SUFFIX_TAIL_RE =
	/\s+(?:inc|incorporated|llc|l l c|lp|l p|llp|corp|corporation|co|company|ltd|limited|plc|gmbh|s a|n a|national association)$/i;

const BANKISH_RE =
	/\b(bank|bancorp|bancshares|credit union|savings|federal savings|n\.?\s*a\.?|national association)\b/i;

export type OrgValidateRow = {
	id: string;
	name: string;
	slug: string;
	profileType: ProfileType;
	normalizedName: string;
	status: string;
	summaryLen: number;
	linkCount: number;
	userTouched: boolean;
	city: string | null;
	geoKey: string | null;
	hasMajorId: boolean;
	crdCount: number;
};

export type OrgMergePair = {
	keepId: string;
	mergeId: string;
	keepName: string;
	mergeName: string;
	profileType: ProfileType;
	reason: 'exact_normalized' | 'legal_suffix_twin' | 'acronym_or_extension_twin';
	confidence: number;
	autoMerge: boolean;
	blockReason?: string;
};

export type OrgClusterReport = {
	scanned: number;
	clusters: number;
	autoMergePairs: OrgMergePair[];
	reviewPairs: OrgMergePair[];
	blockedPairs: OrgMergePair[];
};

function hasMajorIds(map: Map<string, Set<string>>): boolean {
	for (const s of map.values()) {
		if (s.size > 0) return true;
	}
	return false;
}

function tokenSet(s: string): Set<string> {
	return new Set(
		String(s || '')
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length >= 2),
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter += 1;
	return inter / (a.size + b.size - inter);
}

/** Smaller token set mostly contained in the larger (e.g. Cleveland Clinic ⊂ Cleveland Clinic Foundation). */
function containment(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let inter = 0;
	for (const t of small) if (large.has(t)) inter += 1;
	return inter / small.size;
}

function canonicalBase(normalizedName: string): string {
	const base = String(normalizedName || '')
		.replace(SUFFIX_TAIL_RE, '')
		.trim();
	const stripped = stripLegalSuffixes(base || normalizedName);
	return stripped.length >= 5 ? stripped : base;
}

function loadOrgRows(db: DatabaseSync, types: ProfileType[]): OrgValidateRow[] {
	const ph = types.map(() => '?').join(',');
	const rows = db
		.prepare(
			`SELECT p.id, p.name, p.slug, p.profile_type, p.normalized_name, p.status,
              length(trim(COALESCE(p.summary,''))) AS summary_len,
              json_extract(p.metadata_json, '$.userTouchedAt') AS touched,
              (SELECT COUNT(*) FROM profile_links pl
                WHERE pl.from_profile_id = p.id OR pl.to_profile_id = p.id) AS link_count,
              (SELECT l.city FROM profile_locations l
                WHERE l.profile_id = p.id
                ORDER BY CASE l.role WHEN 'hq' THEN 0 WHEN 'office' THEN 1 ELSE 2 END,
                         length(COALESCE(l.raw,'')) DESC
                LIMIT 1) AS city,
              (SELECT l.geo_key FROM profile_locations l
                WHERE l.profile_id = p.id
                ORDER BY CASE l.role WHEN 'hq' THEN 0 WHEN 'office' THEN 1 ELSE 2 END,
                         length(COALESCE(l.raw,'')) DESC
                LIMIT 1) AS geo_key,
              (SELECT COUNT(*) FROM profile_identifiers i
                WHERE i.profile_id = p.id
                  AND lower(i.scheme) IN ('finra_crd','sec_cik','irs_ein','ticker','cusip')) AS major_n,
              (SELECT COUNT(*) FROM profile_identifiers i
                WHERE i.profile_id = p.id AND lower(i.scheme) = 'finra_crd') AS crd_n
       FROM profiles p
       WHERE p.profile_type IN (${ph})`,
		)
		.all(...types) as Array<Record<string, unknown>>;

	return rows.map((r) => ({
		id: String(r.id),
		name: String(r.name || ''),
		slug: String(r.slug || ''),
		profileType: String(r.profile_type) as ProfileType,
		normalizedName: String(r.normalized_name || ''),
		status: String(r.status || 'active'),
		summaryLen: Number(r.summary_len || 0),
		linkCount: Number(r.link_count || 0),
		userTouched: r.touched != null && String(r.touched).trim() !== '',
		city: r.city != null ? String(r.city).trim() || null : null,
		geoKey: r.geo_key != null ? String(r.geo_key).trim() || null : null,
		hasMajorId: Number(r.major_n || 0) > 0,
		crdCount: Number(r.crd_n || 0),
	}));
}

function pickKeep(a: OrgValidateRow, b: OrgValidateRow): { keep: OrgValidateRow; merge: OrgValidateRow } {
	const score = (r: OrgValidateRow) =>
		(r.status === 'pinned' ? 1000 : 0) +
		(r.userTouched ? 500 : 0) +
		(r.hasMajorId ? 200 : 0) +
		Math.min(r.summaryLen, 5000) / 10 +
		r.linkCount * 5 +
		r.name.length;
	return score(a) >= score(b) ? { keep: a, merge: b } : { keep: b, merge: a };
}

function sameCityOrGeo(a: OrgValidateRow, b: OrgValidateRow): boolean {
	if (a.geoKey && b.geoKey && a.geoKey === b.geoKey) return true;
	const ca = (a.city || '').toLowerCase();
	const cb = (b.city || '').toLowerCase();
	if (ca && cb && ca === cb) return true;
	return false;
}

function bothLackLocation(a: OrgValidateRow, b: OrgValidateRow): boolean {
	return !a.city && !a.geoKey && !b.city && !b.geoKey;
}

function evaluatePair(
	a: OrgValidateRow,
	b: OrgValidateRow,
	db: DatabaseSync,
	reason: OrgMergePair['reason'],
	confidence: number,
): OrgMergePair {
	const { keep, merge } = pickKeep(a, b);
	const pair: OrgMergePair = {
		keepId: keep.id,
		mergeId: merge.id,
		keepName: keep.name,
		mergeName: merge.name,
		profileType: keep.profileType,
		reason,
		confidence,
		autoMerge: false,
	};

	if (keep.profileType !== merge.profileType) {
		pair.blockReason = 'cross_type';
		return pair;
	}
	if (profilesHaveConflictingMajorIds(keep.id, merge.id, db)) {
		pair.blockReason = 'conflicting_major_ids';
		return pair;
	}
	if (keep.crdCount > 0 && merge.crdCount > 0 && !profilesShareMajorIdentity(keep.id, merge.id, db)) {
		pair.blockReason = 'distinct_finra_crd';
		return pair;
	}

	const keepIds = getMajorIdentityMap(keep.id, db);
	const mergeIds = getMajorIdentityMap(merge.id, db);
	const keepHas = hasMajorIds(keepIds);
	const mergeHas = hasMajorIds(mergeIds);
	const share = profilesShareMajorIdentity(keep.id, merge.id, db);

	if (keep.profileType === 'firm') {
		const bankish = BANKISH_RE.test(keep.name) || BANKISH_RE.test(merge.name);
		if (bankish && !share && (keepHas || mergeHas)) {
			pair.blockReason = 'bank_without_shared_id';
			return pair;
		}
		// Firm styling twin: shared major ID, both empty, or one-sided IDs (absorb thin twin).
		// Conflicting major IDs / distinct CRDs already blocked above.
		if (share || !keepHas || !mergeHas) {
			pair.autoMerge = true;
			return pair;
		}
		pair.blockReason = 'firm_needs_shared_or_empty_ids';
		return pair;
	}

	// Non-firm: exact / legal-suffix / acronym-or-safe-extension twins auto-merge.
	if (
		reason === 'exact_normalized' ||
		reason === 'legal_suffix_twin' ||
		reason === 'acronym_or_extension_twin'
	) {
		pair.autoMerge = true;
		return pair;
	}
	return pair;
}

/**
 * Build merge pairs for the given org types.
 * Within each type: exact normalized, legal-suffix twins, and (non-firm) near-name+city.
 */
export function clusterOrgDuplicates(
	opts: { types?: ProfileType[]; db?: DatabaseSync } = {},
): OrgClusterReport {
	const db = opts.db ?? getProfilesDb();
	const types = (opts.types?.length ? opts.types : ORG_VALIDATE_TYPES).filter((t) =>
		ORG_VALIDATE_TYPES.includes(t),
	) as ProfileType[];
	const rows = loadOrgRows(db, types);
	const byType = new Map<ProfileType, OrgValidateRow[]>();
	for (const r of rows) {
		const list = byType.get(r.profileType) || [];
		list.push(r);
		byType.set(r.profileType, list);
	}

	const seenPair = new Set<string>();
	const autoMergePairs: OrgMergePair[] = [];
	const reviewPairs: OrgMergePair[] = [];
	const blockedPairs: OrgMergePair[] = [];
	let clusters = 0;

	const pushPair = (pair: OrgMergePair) => {
		const key = [pair.keepId, pair.mergeId].sort().join('|');
		if (seenPair.has(key)) return;
		seenPair.add(key);
		if (pair.autoMerge) autoMergePairs.push(pair);
		else if (pair.blockReason) blockedPairs.push(pair);
		else reviewPairs.push(pair);
	};

	for (const [ptype, list] of byType) {
		// Exact normalized_name
		const byNorm = new Map<string, OrgValidateRow[]>();
		for (const r of list) {
			const k = r.normalizedName;
			if (!k || k.length < 3) continue;
			const g = byNorm.get(k) || [];
			g.push(r);
			byNorm.set(k, g);
		}
		for (const group of byNorm.values()) {
			if (group.length < 2) continue;
			clusters += 1;
			const keep = group.slice().sort((a, b) => pickKeep(a, b).keep.id === a.id ? -1 : 1)[0]!;
			for (const other of group) {
				if (other.id === keep.id) continue;
				pushPair(evaluatePair(keep, other, db, 'exact_normalized', 1));
			}
		}

		// Legal-suffix twins (skip ultra-generic bases like bare "company")
		const GENERIC_BASE = new Set([
			'company',
			'group',
			'partners',
			'holdings',
			'capital',
			'financial',
			'international',
			'global',
			'limited',
			'corp',
			'corporation',
		]);
		const byBase = new Map<string, OrgValidateRow[]>();
		for (const r of list) {
			const base = r.normalizedName.replace(SUFFIX_TAIL_RE, '').trim();
			if (base.length < 6 || GENERIC_BASE.has(base)) continue;
			const key = base;
			const g = byBase.get(key) || [];
			g.push(r);
			byBase.set(key, g);
		}
		for (const group of byBase.values()) {
			if (group.length < 2) continue;
			const bases = new Set(group.map((g) => g.normalizedName.replace(SUFFIX_TAIL_RE, '').trim()));
			if (bases.size !== 1) continue;
			clusters += 1;
			const sorted = group.slice().sort((a, b) => (pickKeep(a, b).keep.id === a.id ? -1 : 1));
			const keep = sorted[0]!;
			for (const other of sorted.slice(1)) {
				pushPair(evaluatePair(keep, other, db, 'legal_suffix_twin', 0.98));
			}
		}

		// Non-firm near-name (aggressive for clear twins only):
		// - parenthetical acronym: "Foo (XYZ)" vs "Foo"
		// - one name is the other plus an allowed org suffix (Foundation, …)
		// Do NOT merge hospital-system campuses or "Office of X" peers via loose containment.
		if (!NON_FIRM.has(ptype)) continue;
		const ALLOWED_EXTENSION_RE =
			/^(inc|incorporated|llc|corp|corporation|ltd|limited|alumni association)$/i;
		const isSafeTwin = (shortRow: OrgValidateRow, longRow: OrgValidateRow): number => {
			const shorter = shortRow.normalizedName;
			const longer = longRow.normalizedName;
			if (shorter.length < 8 || !longer.startsWith(shorter) || longer === shorter) return 0;
			const rest = longer.slice(shorter.length).trim();
			if (!rest) return 0;
			// "… Foundation" only when the base is already a clinic/hospital/university/institute
			// (Cleveland Clinic Foundation ✓; United Nations Foundation ✗).
			if (/^(the )?foundation$/i.test(rest)) {
				if (/\b(clinic|hospital|medical|university|institute|college|school)\b/i.test(shorter)) {
					return 0.94;
				}
				return 0;
			}
			if (ALLOWED_EXTENSION_RE.test(rest)) return 0.94;
			// Acronym twin: longer display name has (REST) in ALL CAPS (MIT/DOJ), not (China).
			if (/^[a-z]{2,8}$/i.test(rest)) {
				const m = longRow.name.match(/\(([A-Za-z0-9]{2,8})\)/);
				if (m && m[1]!.toLowerCase() === rest.toLowerCase() && m[1] === m[1]!.toUpperCase()) {
					return 0.97;
				}
			}
			return 0;
		};
		const withCanon = list.map((r) => ({
			row: r,
			norm: r.normalizedName,
		}));
		// Index under every token ≥4 chars so "Cleveland Clinic" meets "… Foundation".
		const byToken = new Map<string, typeof withCanon>();
		for (const item of withCanon) {
			const toks = [...tokenSet(item.norm)].filter((t) => t.length >= 4);
			const keys = toks.length ? toks : [];
			for (const key of keys.slice(0, 6)) {
				const g = byToken.get(key) || [];
				if (!g.some((x) => x.row.id === item.row.id)) g.push(item);
				byToken.set(key, g);
			}
		}
		for (const bucket of byToken.values()) {
			if (bucket.length < 2 || bucket.length > 80) continue;
			for (let i = 0; i < bucket.length; i++) {
				for (let j = i + 1; j < bucket.length; j++) {
					const a = bucket[i]!;
					const b = bucket[j]!;
					if (a.norm === b.norm) continue;
					const baseA = a.norm.replace(SUFFIX_TAIL_RE, '').trim();
					const baseB = b.norm.replace(SUFFIX_TAIL_RE, '').trim();
					if (baseA === baseB) continue;

					const [shortItem, longItem] =
						a.norm.length <= b.norm.length ? [a, b] : [b, a];
					const conf = isSafeTwin(shortItem.row, longItem.row);
					if (!conf) continue;
					clusters += 1;
					pushPair(
						evaluatePair(a.row, b.row, db, 'acronym_or_extension_twin', conf),
					);
				}
			}
		}
	}

	return {
		scanned: rows.length,
		clusters,
		autoMergePairs,
		reviewPairs,
		blockedPairs,
	};
}

export type ApplyOrgMergesResult = {
	attempted: number;
	merged: number;
	failed: Array<{ keepId: string; mergeId: string; error: string }>;
};

export function applyOrgMergePairs(
	pairs: OrgMergePair[],
	opts: { dryRun?: boolean; db?: DatabaseSync; limit?: number } = {},
): ApplyOrgMergesResult {
	const db = opts.db ?? getProfilesDb();
	const limit = opts.limit && opts.limit > 0 ? opts.limit : pairs.length;
	const result: ApplyOrgMergesResult = { attempted: 0, merged: 0, failed: [] };
	const auto = pairs.filter((p) => p.autoMerge).slice(0, limit);
	// Avoid merging the same mergeId twice if it appears in multiple pairs
	const dead = new Set<string>();
	for (const pair of auto) {
		if (dead.has(pair.keepId) || dead.has(pair.mergeId)) continue;
		result.attempted += 1;
		if (opts.dryRun) {
			result.merged += 1;
			dead.add(pair.mergeId);
			continue;
		}
		try {
			const res = mergeProfiles(pair.keepId, pair.mergeId, db);
			if (!res) {
				result.failed.push({
					keepId: pair.keepId,
					mergeId: pair.mergeId,
					error: 'mergeProfiles returned null',
				});
				continue;
			}
			touchProfilesForUserAction([res.kept.id], db);
			dead.add(pair.mergeId);
			result.merged += 1;
		} catch (err) {
			result.failed.push({
				keepId: pair.keepId,
				mergeId: pair.mergeId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return result;
}

export function cityKeyFromGeo(geoKey: string | null | undefined): string | null {
	const g = String(geoKey || '').toLowerCase();
	if (!g) return null;
	// us:ok:city:durant → durant
	const m = g.match(/:city:([^:]+)$/);
	return m ? m[1] : null;
}
