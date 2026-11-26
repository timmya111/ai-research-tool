/**
 * Infer person gender from honorifics in the display name (Mrs. / Miss / Ms. / Mr.).
 * Used for Family / Relatives labels and metadata.gender backfill.
 */

export type PersonGender = 'female' | 'male';

const MRS_RE = /^Mrs\.?\s+/i;
const MISS_RE = /^Miss\.?\s+/i;
/** Require the period so bare "MS Mitali" (initials) is not treated as Ms. */
const MS_RE = /^Ms\.\s+/i;
const MR_RE = /^Mr\.?\s+/i;

export function inferGenderFromPersonName(name: string | null | undefined): PersonGender | null {
	const n = String(name || '').trim();
	if (!n) return null;
	if (MRS_RE.test(n) || MISS_RE.test(n) || MS_RE.test(n)) return 'female';
	if (MR_RE.test(n)) return 'male';
	return null;
}

/** Normalize stored metadata gender values. */
export function normalizePersonGender(raw: unknown): PersonGender | null {
	const s = String(raw || '')
		.trim()
		.toLowerCase();
	if (!s) return null;
	if (s === 'female' || s === 'f' || s === 'woman' || s === 'girl') return 'female';
	if (s === 'male' || s === 'm' || s === 'man' || s === 'boy') return 'male';
	return null;
}

/**
 * Merge inferred honorific gender into metadata when gender is unset.
 * Does not overwrite an explicit metadata.gender.
 */
export function withInferredPersonGender(
	name: string,
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	const meta = { ...(metadata && typeof metadata === 'object' ? metadata : {}) };
	if (normalizePersonGender(meta.gender) || normalizePersonGender(meta.sex)) return meta;
	const inferred = inferGenderFromPersonName(name);
	if (!inferred) return meta;
	meta.gender = inferred;
	return meta;
}

/**
 * Subject-side roleLabel ("son of", "brother of") → peer-centric kinship word
 * (same naming convention for every relative: mother/father, sister/brother, …).
 * Gendered when known; neutral parent/grandparent/sibling when unknown.
 */
export function peerKinshipLabelFromSubjectRole(
	role: string | null | undefined,
	peerGender: PersonGender | null,
): string | null {
	const raw = String(role || '').trim();
	if (!raw) return null;
	const r = raw.toLowerCase();

	const parent =
		peerGender === 'female' ? 'mother' : peerGender === 'male' ? 'father' : 'parent';
	const grandparent =
		peerGender === 'female' ? 'grandmother' : peerGender === 'male' ? 'grandfather' : 'grandparent';
	const sibling =
		peerGender === 'female' ? 'sister' : peerGender === 'male' ? 'brother' : 'sibling';
	const child =
		peerGender === 'female' ? 'daughter' : peerGender === 'male' ? 'son' : 'child';
	const grandchild =
		peerGender === 'female' ? 'granddaughter' : peerGender === 'male' ? 'grandson' : 'grandchild';

	// Subject-of-peer phrasing → peer's relation to subject (one convention for the tree).
	if (/^(son|daughter|child)\s+of\b/i.test(raw)) return parent;
	if (/^(grandson|granddaughter|grandchild)\s+of\b/i.test(raw)) return grandparent;
	if (/^(brother|sister|sibling)\s+of\b/i.test(raw)) return sibling;
	if (/^(father|mother|parent)\s+of\b/i.test(raw)) return child;
	if (/^(grandfather|grandmother|grandparent)\s+of\b/i.test(raw)) return grandchild;
	if (/^(nephew|niece)\s+of\b/i.test(raw)) {
		return peerGender === 'female' ? 'aunt' : peerGender === 'male' ? 'uncle' : 'uncle/aunt';
	}
	if (/^(uncle|aunt)\s+of\b/i.test(raw) || /^(great[- ]?)?(uncle|aunt)\s+of\b/i.test(raw)) {
		return peerGender === 'female' ? 'niece' : peerGender === 'male' ? 'nephew' : 'nephew/niece';
	}
	if (/^cousins?\s+of\b/i.test(raw)) return 'cousin';

	// Already peer-centric — gender when we can.
	if (/^parents?\b/.test(r)) return parent;
	if (/^grandparents?\b/.test(r)) return grandparent;
	if (/^siblings?\b/.test(r)) return sibling;
	if (/^children\b|^child\b/.test(r)) return child;
	if (/^grandchildren\b|^grandchild\b/.test(r)) return grandchild;
	if (/\bfather\b/.test(r)) return peerGender === 'female' ? 'mother' : 'father';
	if (/\bmother\b/.test(r)) return peerGender === 'male' ? 'father' : 'mother';
	if (/\bbrother\b/.test(r)) return peerGender === 'female' ? 'sister' : peerGender === 'male' ? 'brother' : raw;
	if (/\bsister\b/.test(r)) return peerGender === 'male' ? 'brother' : peerGender === 'female' ? 'sister' : raw;
	if (/\bgrandfather\b/.test(r)) return peerGender === 'female' ? 'grandmother' : 'grandfather';
	if (/\bgrandmother\b/.test(r)) return peerGender === 'male' ? 'grandfather' : 'grandmother';

	return null;
}

/** Display role for Family / Relatives: peer-centric kinship label, else original. */
export function formatFamilyPeerRoleLabel(
	role: string | null | undefined,
	peerName: string | null | undefined,
	peerGenderHint?: PersonGender | null,
): string | null {
	const raw = String(role || '').trim();
	if (!raw) return null;
	const gender = peerGenderHint || inferGenderFromPersonName(peerName);
	const mapped = peerKinshipLabelFromSubjectRole(raw, gender);
	return mapped || raw;
}
