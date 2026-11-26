/** Shared free-org enrich helpers (avoid circular imports). */

import type { ProfileType } from '@/lib/research/profiles/types';

export function isPlausibleStreetHq(raw: string): boolean {
	const s = String(raw || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (s.length < 10 || s.length > 220) return false;
	const noCite = s.replace(/\[\s*\d+\s*\]/g, '').replace(/\[\s*[a-z]\s*\]/gi, '');
	if (!/[0-9]/.test(noCite)) return false;
	if (
		/\$|€|£|¥|billion|million|kUSD|Euronext|NASDAQ|NYSE|CAC\s*\d|component|revenue|employees|endowment|budget/i.test(
			s,
		)
	) {
		return false;
	}
	if (/^(US\$|USD|EUR|CHF)/i.test(s)) return false;
	if (
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(
			s,
		) &&
		/\b(19|20)\d{2}\b/.test(s) &&
		!/\b(street|st\.?|road|avenue|tower|building|plaza|strasse|district|drive|blvd)\b/i.test(s)
	) {
		return false;
	}
	if (
		/\b\d+\s+(stores?|countries|nations|continents|cities|faculty|students|beds|members|hectares|acres|hospitals?|campuses|facilities)\b/i.test(
			s,
		)
	) {
		return false;
	}
	if (/\d+\.\d+\s*;\s*-?\d+\.\d+/.test(s)) return false;
	const streetHint =
		/\b(street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|way|plaza|tower|building|suite|floor|strasse|straße|str\.|rue|via|calle|avenida|gasse|weg|plein|quai|kai|chome|machi|ku\b|district|mall|hall|parkway|pkwy|circle|court|ct\.?|no\.?\s*\d)/i.test(
			noCite,
		) || /^\d{1,6}\s+[A-Za-z]/.test(noCite);
	return streetHint;
}

export function isShortOrAcronymName(name: string): boolean {
	const s = String(name || '').trim();
	if (s.length <= 5) return true;
	if (/^[A-Z0-9][A-Z0-9.&-]{1,7}$/.test(s)) return true;
	return false;
}

/** True when the education name is clearly non-U.S. (skip IPEDS / Scorecard). */
export function looksLikeForeignEducationName(name: string): boolean {
	const n = String(name || '').toLowerCase();
	if (!n) return false;
	if (
		/\b(universidade|università|université|universidad|universiteit|universität|univerzita|universitet)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (/\bfederal university of\b/.test(n)) return true;
	if (
		/\b(brazil|brasil|india|china|beijing|shanghai|moscow|russia|ukraine|poland|hungary|budapest|bangladesh|qatar|singapore|tokyo|japan|korea|seoul|tehran|iran|egypt|cairo|nigeria|kenya|ghana|mexico|argentina|chile|colombia|peru|vietnam|thailand|indonesia|malaysia|philippines|pakistan|turkey|türkiye|israel|palestine|saudi|emirates|uae)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (/\b(all india|birla institute|bauman moscow|charles university|anna university)\b/.test(n)) {
		return true;
	}
	return false;
}

/** Distinct org-type token when present — university ≠ college ≠ institute. */
export function extractOrgTypeToken(name: string): string | null {
	const n = String(name || '').toLowerCase();
	if (/\buniversit(y|ies)\b/.test(n)) return 'university';
	if (/\bcolleges?\b/.test(n)) return 'college';
	if (/\binstitutes?\b/.test(n)) return 'institute';
	if (/\bschools?\b/.test(n)) return 'school';
	if (/\bhospitals?\b/.test(n)) return 'hospital';
	if (/\b(academy|academies)\b/.test(n)) return 'academy';
	return null;
}

export function nameLooksLikeHit(orgName: string, title: string): boolean {
	const rawA = String(orgName || '').trim();
	const rawB = String(title || '').trim();
	if (!rawA || !rawB) return false;
	// Short / acronym queries must match the label exactly (ignore case/punct).
	if (isShortOrAcronymName(rawA)) {
		const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
		return compact(rawA) === compact(rawB.split(',')[0] || rawB);
	}
	// "Carleton University" must not match "Carleton College" (IPEDS HD / Scorecard).
	const typeA = extractOrgTypeToken(rawA);
	const typeB = extractOrgTypeToken(rawB);
	if (typeA && typeB && typeA !== typeB) return false;
	const norm = (s: string) =>
		String(s || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.replace(
				/\b(inc|llc|ltd|limited|corp|corporation|company|co|group|plc|ag|sa|nv|se|the|university|college|hospital|center|centre|foundation|department|agency|museum|institute)\b/g,
				' ',
			)
			.replace(/\s+/g, ' ')
			.trim();
	const a = norm(orgName);
	const b = norm(title);
	if (!a || !b) return false;
	if (a === b) return true;
	// Whole tokens only. Raw includes() treated IRS short names as hits inside
	// longer words ("Sea" ⊂ "research", "national" ⊂ "international") and copied
	// that org's EIN and street onto unrelated profiles.
	const at = a.split(' ').filter((t) => t.length > 2);
	const bt = b.split(' ').filter((t) => t.length > 2);
	if (at.length === 0 || bt.length === 0) return false;
	const aSet = new Set(at);
	const bSet = new Set(bt);
	const shorter = at.length <= bt.length ? at : bt;
	const longer = at.length <= bt.length ? bSet : aSet;
	const contained = shorter.every((t) => longer.has(t));
	// One shared token is enough only when it is a distinctive whole word
	// (length >= 5), so "sea" cannot match by itself.
	if (contained && (shorter.length >= 2 || shorter[0].length >= 5)) return true;
	const overlap = at.filter((t) => bSet.has(t)).length;
	return overlap >= Math.min(2, at.length) && overlap / at.length >= 0.5;
}

/**
 * Foreign / non-US nonprofit names must not query IRS EO BMF or US ProPublica
 * chapter stubs — short US registrant names contaminate international cards.
 */
export function looksLikeForeignNonprofitName(name: string): boolean {
	const n = String(name || '').toLowerCase();
	if (!n) return false;
	if (
		/\b(china|chinese|beijing|shanghai|hong kong|japan|japanese|korea|korean|india|indian|sri lanka|mongolia|taiwan|thailand|vietnam|indonesia|malaysia|philippines|bangladesh|pakistan)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (
		/\b(africa|african|austria|austrian|denmark|danish|sweden|swedish|norway|norwegian|germany|german|goethe|france|french|netherlands|dutch|belgium|belgian|swiss|switzerland|italy|italian|spain|spanish|portugal|portuguese|brazil|brazilian|canada|canadian|mexico|mexican|argentina|chile|peru|colombia|russia|russian|ukraine|poland|hungary|turkey|israel|saudi|emirates|uae|dubai|egypt|nigeria|kenya|ghana|uganda|senegal|morocco|hague)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (
		/\b(icrc|red cross|imperial war|calouste|gulbenkian|boao|caritas internationalis|actionaid|amnesty international|care international|grameen|fung global|médecins|medecins sans|doctors without borders|world health organization|unicef|unesco|oecd|asian strategy|asli|wifo|brac)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (/\b(association pour|association la |institut für|instituto |fundação|fundacion)\b/.test(n)) {
		return true;
	}
	// Chan Zuckerberg Initiative / Biohub must not inherit Foundation BMF street/EIN
	if (/\bchan zuckerberg\b/.test(n) && !/\bfoundation\b/.test(n)) return true;
	return false;
}

/** Known contaminant BMF / ProPublica streets — never write as HQ. */
export function isContaminantFreeOrgAddress(raw: string): boolean {
	const s = String(raw || '').toLowerCase().replace(/\s+/g, ' ');
	if (!s) return false;
	if (s.includes('capitol hil')) return true;
	if (s.includes('17870 copper queen')) return true;
	if (s.includes('314 lytton')) return true;
	if (s.includes('10 mela ln')) return true;
	if (s.includes('9388 lightwave')) return true;
	return false;
}

/** IRS EINs previously stripped as contamination — never reattach. */
export const BLOCKED_IRS_EINS = new Set([
	'23-7066476',
	'20-1269904',
	'52-1419397', // ASHG only; never Genetics Society of America
	'45-5002209', // CZI Foundation — not Initiative/Biohub
	'56-1909683',
	'47-1121853',
	'26-3898882',
	'26-0102131',
	'38-4357064',
]);

/** Skip mistyped securities / broker cards parked under government. */
export function looksLikeSecuritiesJunk(name: string, profileType: ProfileType): boolean {
	if (profileType !== 'government') return false;
	return /\b(securities|broker|brokerage|capital management|investment advisors?|mutual fund|holding company|llc|l\.l\.c|incorporated|inc\.?)\b/i.test(
		name,
	);
}

