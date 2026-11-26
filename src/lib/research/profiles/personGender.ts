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
 * Prefer explicit peer gender from peer-centric role wording ("father of", "Great-aunt …")
 * when peer metadata gender is unset. Ignores subject-side words (son/nephew/…) that invert.
 */
function genderFromRoleWording(raw: string): PersonGender | null {
	const r = raw.toLowerCase();
	// Subject-of-peer phrasing — peer gender is unknown from these words alone.
	if (/^(?:great[- ]?)?(?:son|daughter|child|nephew|niece|grandson|granddaughter|grandchild|brother|sister|sibling)\s+of\b/i.test(raw)) {
		return null;
	}
	if (
		/\b(?:mother|grandmother|great[- ]?grandmother|aunt|great[- ]?aunt|wife|widow)\b/.test(r)
	) {
		return 'female';
	}
	if (
		/\b(?:father|grandfather|great[- ]?grandfather|uncle|great[- ]?uncle|husband|widower)\b/.test(r)
	) {
		return 'male';
	}
	return null;
}

/**
 * Subject-side roleLabel ("son of", "brother of") → peer-centric kinship word
 * (same naming convention for every relative: mother/father, sister/brother, …).
 * Gendered when known from peer metadata or from the role wording; neutral otherwise.
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
	const g = peerGender || genderFromRoleWording(raw);

	const parent = g === 'female' ? 'mother' : g === 'male' ? 'father' : 'parent';
	const grandparent = g === 'female' ? 'grandmother' : g === 'male' ? 'grandfather' : 'grandparent';
	const greatGrandparent =
		g === 'female' ? 'great-grandmother' : g === 'male' ? 'great-grandfather' : 'great-grandparent';
	const sibling = g === 'female' ? 'sister' : g === 'male' ? 'brother' : 'sibling';
	const child = g === 'female' ? 'daughter' : g === 'male' ? 'son' : 'child';
	const grandchild = g === 'female' ? 'granddaughter' : g === 'male' ? 'grandson' : 'grandchild';
	const greatGrandchild =
		g === 'female' ? 'great-granddaughter' : g === 'male' ? 'great-grandson' : 'great-grandchild';
	const uncleAunt = g === 'female' ? 'aunt' : g === 'male' ? 'uncle' : 'uncle/aunt';
	const greatUncleAunt = g === 'female' ? 'great-aunt' : g === 'male' ? 'great-uncle' : 'great-uncle/aunt';
	const nephewNiece = g === 'female' ? 'niece' : g === 'male' ? 'nephew' : 'nephew/niece';
	const greatNephewNiece =
		g === 'female' ? 'great-niece' : g === 'male' ? 'great-nephew' : 'great-nephew/niece';

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

	// Already peer-centric — gender when we can (incl. outbound-inverted labels like "son", "great-nephew").
	if (/great[- ]?grand(?:father|mother|parent)/i.test(r)) return greatGrandparent;
	if (/great[- ]?grand(?:son|daughter|child)/i.test(r)) return greatGrandchild;
	if (/^parents?\b/.test(r) || /\badoptive\s+(?:father|mother|parent)\b/.test(r)) return parent;
	if (/^grandparents?\b/.test(r)) return grandparent;
	if (/^siblings?\b/.test(r)) return sibling;
	if (/^children\b|^child\b/.test(r)) return child;
	if (/^grandchildren\b|^grandchild\b/.test(r)) return grandchild;
	if (/great[- ]?(?:uncle|aunt)/i.test(r)) return greatUncleAunt;
	if (/great[- ]?(?:nephew|niece)/i.test(r)) return greatNephewNiece;
	if (/\bfather\b/.test(r)) return g === 'female' ? 'mother' : 'father';
	if (/\bmother\b/.test(r)) return g === 'male' ? 'father' : 'mother';
	if (/\bbrother\b/.test(r)) return g === 'female' ? 'sister' : g === 'male' ? 'brother' : raw;
	if (/\bsister\b/.test(r)) return g === 'male' ? 'brother' : g === 'female' ? 'sister' : raw;
	if (/\bgrandfather\b/.test(r)) return g === 'female' ? 'grandmother' : 'grandfather';
	if (/\bgrandmother\b/.test(r)) return g === 'male' ? 'grandfather' : 'grandmother';
	if (/\buncle\b/.test(r)) return g === 'female' ? 'aunt' : 'uncle';
	if (/\baunt\b/.test(r)) return g === 'male' ? 'uncle' : 'aunt';
	if (/\bsons?\b/.test(r)) return child;
	if (/\bdaughters?\b/.test(r)) return child;
	if (/\bgrandsons?\b|\bgranddaughters?\b/.test(r)) return grandchild;
	if (/\bnephew\b/.test(r)) return g === 'female' ? 'niece' : 'nephew';
	if (/\bniece\b/.test(r)) return g === 'male' ? 'nephew' : 'niece';

	return null;
}

/**
 * When the open profile is the FROM side of a link whose roleLabel names FROM's
 * kinship to TO ("father of …", "Great-uncle of Timothy"), invert so the peer
 * (TO) is labeled from the subject's point of view (son, great-nephew, …).
 */
export function invertFamilyRoleForOutbound(
	role: string | null | undefined,
	peerGender: PersonGender | null,
): string | null {
	const raw = String(role || '')
		.trim()
		.replace(/\s*\(user-confirmed\)\s*$/i, '')
		.trim();
	if (!raw) return null;
	const r = raw.toLowerCase();
	const child = peerGender === 'female' ? 'daughter' : peerGender === 'male' ? 'son' : 'child';
	const grandchild =
		peerGender === 'female' ? 'granddaughter' : peerGender === 'male' ? 'grandson' : 'grandchild';
	const greatGrandchild =
		peerGender === 'female' ? 'great-granddaughter'
		: peerGender === 'male' ? 'great-grandson'
		: 'great-grandchild';
	const nephewNiece =
		peerGender === 'female' ? 'niece' : peerGender === 'male' ? 'nephew' : 'nephew/niece';
	const greatNephewNiece =
		peerGender === 'female' ? 'great-niece' : peerGender === 'male' ? 'great-nephew' : 'great-nephew/niece';
	const sibling =
		peerGender === 'female' ? 'sister' : peerGender === 'male' ? 'brother' : 'sibling';
	const parent =
		peerGender === 'female' ? 'mother' : peerGender === 'male' ? 'father' : 'parent';
	const spouse = peerGender === 'female' ? 'wife' : peerGender === 'male' ? 'husband' : 'spouse';

	// Subject-is-X-of-peer already peer-centric for outbound ("Son of Laura" on child's card → Laura).
	if (/^(?:great[- ]?)?(?:son|daughter|child|nephew|niece|grandson|granddaughter|grandchild|brother|sister|sibling)\s+of\b/i.test(raw)) {
		return null; // caller keeps original; peerKinshipLabelFromSubjectRole inverts
	}

	if (/^(?:adoptive\s+|step\s+)?great[- ]?grand(?:father|mother|parent)s?\s+of\b/i.test(raw) || /great[- ]?grand(?:father|mother|parent)/i.test(r)) {
		return greatGrandchild;
	}
	if (/^(?:adoptive\s+|step\s+)?(?:maternal\s+|paternal\s+)?grand(?:father|mother|parent)s?\s+of\b/i.test(raw) || /\bgrand(?:father|mother|parent)\b/i.test(r)) {
		return grandchild;
	}
	if (/^(?:adoptive\s+|step\s+)?(?:birth\s+)?(?:father|mother|parent)s?\s+of\b/i.test(raw) || /\b(?:father|mother|parent)\b/i.test(r)) {
		return child;
	}
	if (/^(?:great[- ]?)?(?:uncle|aunt)s?\s+of\b/i.test(raw) || /great[- ]?(?:uncle|aunt)/i.test(r)) {
		return /great/i.test(raw) ? greatNephewNiece : nephewNiece;
	}
	if (/\b(?:uncle|aunt)\b/i.test(r)) return nephewNiece;
	if (/^(?:brother|sister|sibling)s?\s+of\b/i.test(raw) || /\b(?:brother|sister|sibling)\b/i.test(r)) return sibling;
	if (/\b(?:son|daughter|child)\b/i.test(r)) return parent;
	if (/\b(?:wife|husband|spouse)\b/i.test(r)) return spouse;
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
