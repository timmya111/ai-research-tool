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
	const raw = String(role || '')
		.trim()
		.replace(/\s*\(user-confirmed\)\s*$/i, '')
		.trim();
	if (!raw) return null;
	const r = raw.toLowerCase();

	const parent =
		peerGender === 'female' ? 'mother' : peerGender === 'male' ? 'father' : 'parent';
	const grandparent =
		peerGender === 'female' ? 'grandmother' : peerGender === 'male' ? 'grandfather' : 'grandparent';
	const greatGrandparent =
		peerGender === 'female' ? 'great-grandmother'
		: peerGender === 'male' ? 'great-grandfather'
		: 'great-grandparent';
	const sibling =
		peerGender === 'female' ? 'sister' : peerGender === 'male' ? 'brother' : 'sibling';
	const child =
		peerGender === 'female' ? 'daughter' : peerGender === 'male' ? 'son' : 'child';
	const grandchild =
		peerGender === 'female' ? 'granddaughter' : peerGender === 'male' ? 'grandson' : 'grandchild';
	const uncleAunt =
		peerGender === 'female' ? 'aunt' : peerGender === 'male' ? 'uncle' : 'uncle/aunt';
	const greatUncleAunt =
		peerGender === 'female' ? 'great-aunt' : peerGender === 'male' ? 'great-uncle' : 'great-uncle/aunt';
	const nephewNiece =
		peerGender === 'female' ? 'niece' : peerGender === 'male' ? 'nephew' : 'nephew/niece';

	// Peer-is-X-of-subject (common on family_or_associate links): "father of …", "Great-uncle of Timothy".
	if (/^(?:adoptive\s+|step\s+)?great[- ]?grand(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return greatGrandparent;
	}
	if (/^(?:adoptive\s+|step\s+)?(?:maternal\s+|paternal\s+)?grand(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return grandparent;
	}
	if (/^(?:adoptive\s+|step\s+)?(?:birth\s+)?(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return parent;
	}
	if (/^(?:great[- ]?)?(?:uncle|aunt)s?\s+of\b/i.test(raw)) {
		return /great/i.test(raw) ? greatUncleAunt : uncleAunt;
	}

	// Subject-is-X-of-peer → invert for the peer's label: "Son of Laura", "Great-nephew of Hopper".
	if (/^(?:great[- ]?)?grand(?:son|daughter|child)\s+of\b/i.test(raw)) {
		return /great/i.test(raw) ? greatGrandparent : grandparent;
	}
	if (/^(?:son|daughter|child)\s+of\b/i.test(raw)) return parent;
	if (/^(?:brother|sister|sibling)\s+of\b/i.test(raw)) return sibling;
	if (/^(?:great[- ]?)?(?:nephew|niece)\s+of\b/i.test(raw)) {
		return /great/i.test(raw) ? greatUncleAunt : uncleAunt;
	}
	if (/^cousins?\s+of\b/i.test(raw)) return 'cousin';

	// Already peer-centric — gender when we can.
	if (/great[- ]?grand(?:father|mother|parent)/i.test(r)) return greatGrandparent;
	if (/^parents?\b/.test(r) || /\badoptive\s+(?:father|mother|parent)\b/.test(r)) return parent;
	if (/^grandparents?\b/.test(r)) return grandparent;
	if (/^siblings?\b/.test(r)) return sibling;
	if (/^children\b|^child\b/.test(r)) return child;
	if (/^grandchildren\b|^grandchild\b/.test(r)) return grandchild;
	if (/great[- ]?(?:uncle|aunt)/i.test(r)) return greatUncleAunt;
	if (/\bfather\b/.test(r)) return peerGender === 'female' ? 'mother' : 'father';
	if (/\bmother\b/.test(r)) return peerGender === 'male' ? 'father' : 'mother';
	if (/\bbrother\b/.test(r)) return peerGender === 'female' ? 'sister' : peerGender === 'male' ? 'brother' : raw;
	if (/\bsister\b/.test(r)) return peerGender === 'male' ? 'brother' : peerGender === 'female' ? 'sister' : raw;
	if (/\bgrandfather\b/.test(r)) return peerGender === 'female' ? 'grandmother' : 'grandfather';
	if (/\bgrandmother\b/.test(r)) return peerGender === 'male' ? 'grandfather' : 'grandmother';
	if (/\buncle\b/.test(r)) return peerGender === 'female' ? 'aunt' : 'uncle';
	if (/\baunt\b/.test(r)) return peerGender === 'male' ? 'uncle' : 'aunt';
	if (/\bnephew\b/.test(r)) return peerGender === 'female' ? 'niece' : 'nephew';
	if (/\bniece\b/.test(r)) return peerGender === 'male' ? 'nephew' : 'niece';

	return null;
}

/** Display role for Family / Relatives: peer-centric kinship label, else original. */
export function formatFamilyPeerRoleLabel(
	role: string | null | undefined,
	peerName: string | null | undefined,
	peerGenderHint?: PersonGender | null,
): string | null {
	const raw = String(role || '')
		.trim()
		.replace(/\s*\(user-confirmed\)\s*$/i, '')
		.trim();
	if (!raw) return null;
	const gender = peerGenderHint || inferGenderFromPersonName(peerName);
	const mapped = peerKinshipLabelFromSubjectRole(raw, gender);
	return mapped || raw;
}
