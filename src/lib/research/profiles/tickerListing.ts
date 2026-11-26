/**
 * A stock ticker is a company identifier only for one listing:
 * the same symbol, the same listing country, and the same market.
 * NYSE:BA (Boeing, US) is not LSE:BA (BAE Systems, GB).
 * A symbol with no known country or market does not match anything.
 */

export type TickerListing = {
	symbol: string;
	/** Canonical venue, e.g. NYSE, NASDAQ, LSE, HKEX, XETRA. */
	market: string;
	/** ISO 3166-1 alpha-2 listing country. */
	country: string;
};

type Venue = { market: string; country: string | null };

/** Exchange aliases → venue. Null country means the label is a multi-country group. */
const VENUES: Record<string, Venue> = {
	NYSE: { market: 'NYSE', country: 'US' },
	NASDAQ: { market: 'NASDAQ', country: 'US' },
	NASD: { market: 'NASDAQ', country: 'US' },
	NDAQ: { market: 'NASDAQ', country: 'US' },
	AMEX: { market: 'NYSEAMERICAN', country: 'US' },
	NYSEAMERICAN: { market: 'NYSEAMERICAN', country: 'US' },
	NYSEMKT: { market: 'NYSEAMERICAN', country: 'US' },
	OTC: { market: 'OTC', country: 'US' },
	OTCBB: { market: 'OTC', country: 'US' },
	PINK: { market: 'OTC', country: 'US' },
	CBOE: { market: 'CBOE', country: 'US' },
	LSE: { market: 'LSE', country: 'GB' },
	LON: { market: 'LSE', country: 'GB' },
	SEHK: { market: 'HKEX', country: 'HK' },
	HKEX: { market: 'HKEX', country: 'HK' },
	HK: { market: 'HKEX', country: 'HK' },
	XETRA: { market: 'XETRA', country: 'DE' },
	FRA: { market: 'XETRA', country: 'DE' },
	BIT: { market: 'BIT', country: 'IT' },
	MIL: { market: 'BIT', country: 'IT' },
	OSL: { market: 'OSL', country: 'NO' },
	OSE: { market: 'OSL', country: 'NO' },
	TSX: { market: 'TSX', country: 'CA' },
	TYO: { market: 'TSE', country: 'JP' },
	JPX: { market: 'TSE', country: 'JP' },
	ASX: { market: 'ASX', country: 'AU' },
	SIX: { market: 'SIX', country: 'CH' },
	SWX: { market: 'SIX', country: 'CH' },
	SSE: { market: 'SSE', country: 'CN' },
	SHA: { market: 'SSE', country: 'CN' },
	SHE: { market: 'SZSE', country: 'CN' },
	SZSE: { market: 'SZSE', country: 'CN' },
	KRX: { market: 'KRX', country: 'KR' },
	KOSPI: { market: 'KRX', country: 'KR' },
	SGX: { market: 'SGX', country: 'SG' },
	BMV: { market: 'BMV', country: 'MX' },
	B3: { market: 'B3', country: 'BR' },
	BME: { market: 'BME', country: 'ES' },
	EPA: { market: 'EURONEXT', country: 'FR' },
	PAR: { market: 'EURONEXT', country: 'FR' },
	AMS: { market: 'EURONEXT', country: 'NL' },
	EBR: { market: 'EURONEXT', country: 'BE' },
	ELI: { market: 'EURONEXT', country: 'PT' },
	LIS: { market: 'EURONEXT', country: 'PT' },
	STO: { market: 'OMX', country: 'SE' },
	HEL: { market: 'OMX', country: 'FI' },
	CPH: { market: 'OMX', country: 'DK' },
	// Multi-country labels. A country must come from somewhere else.
	EURONEXT: { market: 'EURONEXT', country: null },
	OMX: { market: 'OMX', country: null },
};

/** Yahoo-style suffix → venue. Single-letter share classes (.A, .B) are not venues. */
const SUFFIXES: Record<string, Venue> = {
	HK: VENUES.HKEX,
	L: VENUES.LSE,
	LON: VENUES.LSE,
	PA: VENUES.EPA,
	DE: VENUES.XETRA,
	F: VENUES.XETRA,
	MI: VENUES.BIT,
	OL: VENUES.OSL,
	ST: VENUES.STO,
	HE: VENUES.HEL,
	CO: VENUES.CPH,
	TO: VENUES.TSX,
	T: VENUES.TYO,
	AX: VENUES.ASX,
	SW: VENUES.SIX,
	SS: VENUES.SSE,
	SZ: VENUES.SZSE,
	KS: VENUES.KRX,
	TW: { market: 'TWSE', country: 'TW' },
	SI: VENUES.SGX,
	MX: VENUES.BMV,
	SA: VENUES.B3,
	MC: VENUES.BME,
	AS: VENUES.AMS,
	BR: VENUES.EBR,
	LS: VENUES.ELI,
};

function venueFromToken(token: string): Venue | null {
	const key = token.toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (!key) return null;
	return VENUES[key] || null;
}

function pickVenue(parsed: Venue | null, hint: Venue | null): Venue | null {
	if (parsed && hint) {
		if (parsed.market !== hint.market) return null;
		const country = parsed.country || hint.country;
		if (!country) return null;
		if (parsed.country && hint.country && parsed.country !== hint.country) return null;
		return { market: parsed.market, country };
	}
	const venue = parsed || hint;
	if (!venue?.country) return null;
	return venue;
}

/**
 * Resolve a ticker value plus an optional exchange hint (metadata.exchange)
 * to one listing. Returns null when the country or market is missing,
 * or when the value and the hint name different venues.
 */
export function resolveTickerListing(
	symbol: string,
	exchangeHint?: string | null,
): TickerListing | null {
	let raw = String(symbol || '').trim().toUpperCase().replace(/\s+/g, '');
	if (!raw) return null;

	let parsed: Venue | null = null;
	const colon = raw.indexOf(':');
	if (colon > 0 && colon < raw.length - 1) {
		parsed = venueFromToken(raw.slice(0, colon));
		raw = raw.slice(colon + 1);
		if (!raw) return null;
	} else {
		const suffix = raw.match(/\.([A-Z]{1,4})$/);
		if (suffix && SUFFIXES[suffix[1]]) {
			parsed = SUFFIXES[suffix[1]];
			raw = raw.slice(0, -(suffix[1].length + 1));
			if (!raw) return null;
		}
	}

	const hint = venueFromToken(String(exchangeHint || ''));
	const venue = pickVenue(parsed, hint);
	if (!venue?.country) return null;
	return { symbol: raw, market: venue.market, country: venue.country };
}

/** Stable identity key. Empty when the listing is not fully known. */
export function tickerListingKey(listing: TickerListing | null): string {
	if (!listing) return '';
	return `${listing.country}:${listing.market}:${listing.symbol}`.toLowerCase();
}

export function sameTickerListing(
	leftSymbol: string,
	leftExchange: string | null | undefined,
	rightSymbol: string,
	rightExchange: string | null | undefined,
): boolean {
	const left = tickerListingKey(resolveTickerListing(leftSymbol, leftExchange));
	const right = tickerListingKey(resolveTickerListing(rightSymbol, rightExchange));
	return left !== '' && left === right;
}

/** UI label, e.g. "BA (LSE, GB)". Falls back to the raw symbol when the venue is unknown. */
export function formatTickerListing(symbol: string, exchangeHint?: string | null): string {
	const shown = String(symbol || '').trim();
	const listing = resolveTickerListing(shown, exchangeHint);
	if (!listing) {
		const ex = String(exchangeHint || '').trim();
		return ex ? `${shown} (${ex})` : shown;
	}
	return `${listing.symbol} (${listing.market}, ${listing.country})`;
}
