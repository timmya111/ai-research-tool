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

export function nameLooksLikeHit(orgName: string, title: string): boolean {
	const rawA = String(orgName || '').trim();
	const rawB = String(title || '').trim();
	if (!rawA || !rawB) return false;
	// Short / acronym queries must match the label exactly (ignore case/punct).
	if (isShortOrAcronymName(rawA)) {
		const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
		return compact(rawA) === compact(rawB.split(',')[0] || rawB);
	}
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
	if (a.includes(b) || b.includes(a)) return true;
	const at = a.split(' ').filter((t) => t.length > 2);
	const bt = new Set(b.split(' ').filter((t) => t.length > 2));
	if (at.length === 0) return false;
	const overlap = at.filter((t) => bt.has(t)).length;
	return overlap >= Math.min(2, at.length) && overlap / at.length >= 0.5;
}

/** Skip mistyped securities / broker cards parked under government. */
export function looksLikeSecuritiesJunk(name: string, profileType: ProfileType): boolean {
	if (profileType !== 'government') return false;
	return /\b(securities|broker|brokerage|capital management|investment advisors?|mutual fund|holding company|llc|l\.l\.c|incorporated|inc\.?)\b/i.test(
		name,
	);
}

