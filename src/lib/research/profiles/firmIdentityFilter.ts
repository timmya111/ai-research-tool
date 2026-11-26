/**
 * Public-entity name filter: map well-known firms to ticker/exchange and
 * correct wrong profileType (e.g. Walmart must not be `government`).
 *
 * Strong-ID order for firms: ticker → sec_cik → irs_ein → url.
 * Yahoo Finance enrichment is separate (async) — see yahooFinance.ts.
 */
import type { ProfileType } from '@/lib/research/profiles/types';
import { getProfilesDb } from '@/lib/research/profiles/db';

export type KnownPublicFirm = {
	ticker: string;
	exchange: string;
	legalName: string;
	/** Country of listing — required for ticker identity. */
	listingCountry: 'US';
};

const NAME_RULES: Array<{ re: RegExp; firm: KnownPublicFirm }> = [
	{
		re: /\bwal-?mart\b/i,
		firm: { ticker: 'WMT', exchange: 'NYSE', legalName: 'Walmart Inc.', listingCountry: 'US' },
	},
	{
		re: /\bexxon\s*mobil\b|\bexxonmobil\b/i,
		firm: {
			ticker: 'XOM',
			exchange: 'NYSE',
			legalName: 'Exxon Mobil Corporation',
			listingCountry: 'US',
		},
	},
	{
		re: /\bverizon\b/i,
		firm: {
			ticker: 'VZ',
			exchange: 'NYSE',
			legalName: 'Verizon Communications Inc.',
			listingCountry: 'US',
		},
	},
	{
		re: /\bdeere\b|\bjohn\s*deere\b/i,
		firm: { ticker: 'DE', exchange: 'NYSE', legalName: 'Deere & Company', listingCountry: 'US' },
	},
	{
		re: /\bmastec\b/i,
		firm: { ticker: 'MTZ', exchange: 'NYSE', legalName: 'MasTec, Inc.', listingCountry: 'US' },
	},
	{
		re: /\bfluor\b/i,
		firm: { ticker: 'FLR', exchange: 'NYSE', legalName: 'Fluor Corporation', listingCountry: 'US' },
	},
	{
		re: /\bsouthwest\s+airlines\b/i,
		firm: {
			ticker: 'LUV',
			exchange: 'NYSE',
			legalName: 'Southwest Airlines Co.',
			listingCountry: 'US',
		},
	},
	{
		re: /\btexas\s+instruments\b/i,
		firm: {
			ticker: 'TXN',
			exchange: 'NASDAQ',
			legalName: 'Texas Instruments Incorporated',
			listingCountry: 'US',
		},
	},
	{
		re: /\bkimberly-?clark\b/i,
		firm: {
			ticker: 'KMB',
			exchange: 'NYSE',
			legalName: 'Kimberly-Clark Corporation',
			listingCountry: 'US',
		},
	},
	{
		re: /\bmckesson\b/i,
		firm: {
			ticker: 'MCK',
			exchange: 'NYSE',
			legalName: 'McKesson Corporation',
			listingCountry: 'US',
		},
	},
	{
		re: /\bcaterpillar\b/i,
		firm: { ticker: 'CAT', exchange: 'NYSE', legalName: 'Caterpillar Inc.', listingCountry: 'US' },
	},
	{
		re: /\bcommercial\s+metals\b/i,
		firm: {
			ticker: 'CMC',
			exchange: 'NYSE',
			legalName: 'Commercial Metals Company',
			listingCountry: 'US',
		},
	},
];

/** Types that must not host a ticker-listed public company. */
export const INVALID_TYPES_FOR_PUBLIC_FIRM = new Set<ProfileType>([
	'government',
	'person',
	'historic_event',
	'region',
	'education',
	'medical_hospital',
]);

export function matchKnownPublicFirm(name: string): KnownPublicFirm | null {
	const n = String(name || '').trim();
	if (!n) return null;
	for (const row of NAME_RULES) {
		if (row.re.test(n)) return row.firm;
	}
	return null;
}

export type FirmIdentityResolution = {
	known: KnownPublicFirm | null;
	requestedType: ProfileType;
	resolvedType: ProfileType;
	correctedType: boolean;
	warnings: string[];
	existingFirm: {
		id: string;
		slug: string;
		name: string;
		status: string;
	} | null;
};

export function findFirmByTicker(ticker: string): FirmIdentityResolution['existingFirm'] {
	const sym = String(ticker || '')
		.trim()
		.toUpperCase();
	if (!sym) return null;
	const db = getProfilesDb();
	const row = db
		.prepare(
			`SELECT p.id, p.slug, p.name, p.status
       FROM profile_identifiers i
       JOIN profiles p ON p.id = i.profile_id
       WHERE p.profile_type = 'firm'
         AND lower(i.scheme) = 'ticker'
         AND upper(i.normalized_value) = ?
       ORDER BY CASE p.status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END
       LIMIT 1`,
		)
		.get(sym) as { id: string; slug: string; name: string; status: string } | undefined;
	return row
		? { id: String(row.id), slug: String(row.slug), name: String(row.name), status: String(row.status) }
		: null;
}

/**
 * Resolve how a create/upsert should treat a public-facing name.
 * Does not call the network — safe for the request path.
 */
export function resolveFirmIdentityOnCreate(
	name: string,
	requestedType: ProfileType,
): FirmIdentityResolution {
	const warnings: string[] = [];
	const known = matchKnownPublicFirm(name);
	let resolvedType = requestedType;
	let correctedType = false;

	if (known) {
		const existingFirm = findFirmByTicker(known.ticker);
		if (INVALID_TYPES_FOR_PUBLIC_FIRM.has(requestedType)) {
			resolvedType = 'firm';
			correctedType = true;
			warnings.push(
				`Corrected profileType ${requestedType} → firm because "${name}" maps to ticker ${known.ticker} (${known.exchange})`,
			);
		} else if (requestedType !== 'firm' && requestedType !== 'nonprofit') {
			// Allow nonprofit only if caller insisted; still prefer firm for listed cos.
			resolvedType = 'firm';
			correctedType = true;
			warnings.push(
				`Normalized profileType ${requestedType} → firm for listed company ${known.ticker}`,
			);
		}
		return { known, requestedType, resolvedType, correctedType, warnings, existingFirm };
	}

	return {
		known: null,
		requestedType,
		resolvedType,
		correctedType: false,
		warnings,
		existingFirm: null,
	};
}
