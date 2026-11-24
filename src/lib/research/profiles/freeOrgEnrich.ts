/**
 * Free-only org enrich: street HQ, founding/start date, and active status.
 *
 * Sources (no paid Places APIs):
 *  - IRS EO BMF local CSVs (nonprofit ruling + STATUS + street)
 *  - College Scorecard API + IPEDS HD (education address + operating)
 *  - Wikidata SPARQL (P6375/P969 address, P625 coords, P571 inception, P576 dissolved)
 *  - ProPublica Nonprofit Explorer API v2 (ruling_date, address, EIN)
 *  - Nominatim / OpenStreetMap (structured address; ≤1 req/s)
 */

import type { ProfileType } from '@/lib/research/profiles/types';
import {
	lookupCollegeScorecard,
	lookupIpedsHd,
	lookupIrsEoBmf,
} from '@/lib/research/profiles/freeOrgBulk';

const UA =
	process.env.FREE_ORG_ENRICH_UA ||
	'AI-Research-Tool/1.0 (local research; +http://localhost:3333)';

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PROPUBLICA = 'https://projects.propublica.org/nonprofits/api/v2';

export type FreeOrgAddress = {
	raw: string;
	city?: string | null;
	state?: string | null;
	country?: string | null;
	lat?: number | null;
	lon?: number | null;
	source:
		| 'wikidata'
		| 'nominatim'
		| 'propublica'
		| 'irs-eo-bmf'
		| 'college-scorecard'
		| 'ipeds-hd';
	sourceUrl?: string;
};

export type FreeOrgEnrichResult = {
	address?: FreeOrgAddress;
	startDate?: string;
	endDate?: string | null;
	status?: 'active' | 'archived';
	wikidataQid?: string;
	ein?: string;
	evidence: Array<{ field: string; source: string; value: string; url?: string }>;
};

export type FreeOrgEnrichInput = {
	name: string;
	profileType: ProfileType;
	ein?: string | null;
	countryHint?: string | null;
	/** Skip Nominatim (e.g. when only dates needed). */
	skipNominatim?: boolean;
	/** Skip ProPublica. */
	skipProPublica?: boolean;
	/** Skip IRS EO BMF local CSVs. */
	skipIrsBmf?: boolean;
	/** Skip College Scorecard / IPEDS. */
	skipScorecard?: boolean;
};

let lastNominatimAt = 0;

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, {
		...init,
		headers: {
			Accept: 'application/json',
			'User-Agent': UA,
			...(init?.headers || {}),
		},
		signal: AbortSignal.timeout(45_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

import {
	isPlausibleStreetHq,
	isShortOrAcronymName,
	nameLooksLikeHit,
	looksLikeSecuritiesJunk,
} from '@/lib/research/profiles/freeOrgShared';

export {
	isPlausibleStreetHq,
	isShortOrAcronymName,
	nameLooksLikeHit,
	looksLikeSecuritiesJunk,
};

function parseWktPoint(wkt: string): { lat: number; lon: number } | null {
	const m = String(wkt || '').match(/Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
	if (!m) return null;
	const lon = Number(m[1]);
	const lat = Number(m[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	return { lat, lon };
}

function isoDateFromWikidata(v: string): string | null {
	const s = String(v || '').trim();
	const m = s.match(/^(-?\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
	if (!m) return null;
	const y = m[1];
	const mo = m[2] || '01';
	const d = m[3] || '01';
	if (mo === '00' || d === '00') return y;
	return `${y}-${mo}-${d}`;
}

function rulingToIso(ruling: string): string | null {
	const s = String(ruling || '').trim();
	// ProPublica: YYYY-MM-DD or YYYYMM
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
	if (/^\d{4}$/.test(s)) return s;
	return null;
}

function formatEin(raw: string): string | null {
	const digits = String(raw || '').replace(/\D/g, '');
	if (digits.length !== 9) return null;
	return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

async function lookupWikidata(name: string): Promise<{
	qid?: string;
	address?: FreeOrgAddress;
	startDate?: string;
	endDate?: string;
}> {
	const label = String(name || '')
		.replace(/\s*\([^)]*\)\s*/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	if (label.length < 3) return {};

	const sparql = `
SELECT ?item ?itemLabel ?addr ?coord ?inception ?dissolved WHERE {
  ?item rdfs:label "${label.replace(/"/g, '\\"')}"@en.
  OPTIONAL { ?item wdt:P6375 ?addr. }
  OPTIONAL { ?item wdt:P969 ?addr2. BIND(COALESCE(?addr, ?addr2) AS ?addr) }
  OPTIONAL { ?item wdt:P625 ?coord. }
  OPTIONAL { ?item wdt:P571 ?inception. }
  OPTIONAL { ?item wdt:P576 ?dissolved. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 8`.trim();

	const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(sparql)}`;
	const data = (await fetchJson(url)) as {
		results?: {
			bindings?: Array<Record<string, { value?: string }>>;
		};
	};
	const rows = data.results?.bindings || [];
	let best: {
		qid?: string;
		address?: FreeOrgAddress;
		startDate?: string;
		endDate?: string;
	} = {};

	for (const row of rows) {
		const itemUri = String(row.item?.value || '');
		const qid = itemUri.match(/\/(Q\d+)$/)?.[1];
		const itemLabel = String(row.itemLabel?.value || '');
		if (qid && itemLabel && !nameLooksLikeHit(name, itemLabel)) continue;

		const addrRaw = String(row.addr?.value || '').trim();
		const coord = parseWktPoint(String(row.coord?.value || ''));
		const inception = isoDateFromWikidata(String(row.inception?.value || ''));
		const dissolved = isoDateFromWikidata(String(row.dissolved?.value || ''));

		if (!best.qid && qid) best.qid = qid;
		if (!best.startDate && inception) best.startDate = inception;
		if (!best.endDate && dissolved) best.endDate = dissolved;

		if (!best.address && addrRaw && isPlausibleStreetHq(addrRaw)) {
			best.address = {
				raw: addrRaw,
				lat: coord?.lat ?? null,
				lon: coord?.lon ?? null,
				source: 'wikidata',
				sourceUrl: qid ? `https://www.wikidata.org/wiki/${qid}` : undefined,
			};
		} else if (!best.address && coord && qid) {
			// coords alone are not a street HQ — keep qid/dates only
		}

		if (best.address && best.startDate) break;
	}

	// Fallback: wbsearchentities when exact label miss
	if (!best.qid) {
		const searchUrl =
			'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=' +
			encodeURIComponent(label);
		const search = (await fetchJson(searchUrl)) as {
			search?: Array<{ id?: string; label?: string }>;
		};
		const hit = (search.search || []).find((h) => nameLooksLikeHit(name, String(h.label || '')));
		if (hit?.id) {
			const qid = hit.id;
			const detailSparql = `
SELECT ?addr ?coord ?inception ?dissolved WHERE {
  OPTIONAL { wd:${qid} wdt:P6375 ?addr. }
  OPTIONAL { wd:${qid} wdt:P969 ?addr2. BIND(COALESCE(?addr, ?addr2) AS ?addr) }
  OPTIONAL { wd:${qid} wdt:P625 ?coord. }
  OPTIONAL { wd:${qid} wdt:P571 ?inception. }
  OPTIONAL { wd:${qid} wdt:P576 ?dissolved. }
}
LIMIT 5`.trim();
			const detailUrl = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(detailSparql)}`;
			const detail = (await fetchJson(detailUrl)) as {
				results?: { bindings?: Array<Record<string, { value?: string }>> };
			};
			const d0 = detail.results?.bindings?.[0];
			best.qid = qid;
			if (d0) {
				const addrRaw = String(d0.addr?.value || '').trim();
				const coord = parseWktPoint(String(d0.coord?.value || ''));
				const inception = isoDateFromWikidata(String(d0.inception?.value || ''));
				const dissolved = isoDateFromWikidata(String(d0.dissolved?.value || ''));
				if (inception) best.startDate = inception;
				if (dissolved) best.endDate = dissolved;
				if (addrRaw && isPlausibleStreetHq(addrRaw)) {
					best.address = {
						raw: addrRaw,
						lat: coord?.lat ?? null,
						lon: coord?.lon ?? null,
						source: 'wikidata',
						sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
					};
				}
			}
		}
	}

	return best;
}

async function lookupProPublica(
	name: string,
	ein?: string | null,
): Promise<{
	address?: FreeOrgAddress;
	startDate?: string;
	status?: 'active' | 'archived';
	ein?: string;
}> {
	let org: Record<string, unknown> | null = null;
	const einDigits = String(ein || '').replace(/\D/g, '');

	if (einDigits.length === 9) {
		const data = (await fetchJson(`${PROPUBLICA}/organizations/${einDigits}.json`)) as {
			organization?: Record<string, unknown>;
		};
		org = data.organization || null;
	} else {
		const data = (await fetchJson(
			`${PROPUBLICA}/search.json?q=${encodeURIComponent(name.slice(0, 80))}`,
		)) as {
			organizations?: Array<Record<string, unknown>>;
		};
		const orgs = data.organizations || [];
		// Prefer exact/fuzzy name hit; for short acronyms trust ProPublica's top ranked result.
		let hit =
			orgs.find((o) => nameLooksLikeHit(name, String(o.name || ''))) ||
			(isShortOrAcronymName(name) && orgs[0] ? orgs[0] : null);
		if (!hit) return {};
		const id = String(hit.ein || '').replace(/\D/g, '');
		if (id.length === 9) {
			const full = (await fetchJson(`${PROPUBLICA}/organizations/${id}.json`)) as {
				organization?: Record<string, unknown>;
			};
			org = full.organization || hit;
		} else {
			org = hit;
		}
	}

	if (!org) return {};
	const orgName = String(org.name || '');
	const fromEinLookup = einDigits.length === 9;
	// EIN lookups and acronym top-hits may not fuzzy-match the short query string.
	if (
		orgName &&
		!fromEinLookup &&
		!isShortOrAcronymName(name) &&
		!nameLooksLikeHit(name, orgName)
	) {
		return {};
	}

	const out: {
		address?: FreeOrgAddress;
		startDate?: string;
		status?: 'active' | 'archived';
		ein?: string;
	} = {};

	const formattedEin = formatEin(String(org.ein || einDigits));
	if (formattedEin) out.ein = formattedEin;

	const ruling = rulingToIso(String(org.ruling_date || org.ruling_date_raw || ''));
	if (ruling) out.startDate = ruling;

	// revoked orgs often have revoked indicator in filings; treat missing recent activity softly
	if (org.revocation != null || /revok/i.test(String(org.classification || ''))) {
		out.status = 'archived';
	} else {
		out.status = 'active';
	}

	const line1 = String(org.address || org.street || '').trim();
	const city = String(org.city || '').trim();
	const state = String(org.state || '').trim();
	const zip = String(org.zipcode || org.zip || '').trim();
	const raw = [line1, city && state ? `${city}, ${state}` : city || state, zip]
		.filter(Boolean)
		.join(', ');
	if (raw && isPlausibleStreetHq(raw)) {
		out.address = {
			raw,
			city: city || null,
			state: state || null,
			country: 'US',
			source: 'propublica',
			sourceUrl: formattedEin
				? `https://projects.propublica.org/nonprofits/organizations/${formattedEin.replace(/\D/g, '')}`
				: undefined,
		};
	}

	return out;
}

function nominatimClassOk(profileType: ProfileType, cls: string, typ: string): boolean {
	const c = `${cls}/${typ}`.toLowerCase();
	if (profileType === 'education') {
		return /university|college|school|education|campus/.test(c);
	}
	if (profileType === 'medical_hospital') {
		return /hospital|clinic|healthcare|doctors/.test(c);
	}
	if (profileType === 'nonprofit') {
		return /ngo|charity|community|social|foundation|association|office|building|amenity/.test(c);
	}
	if (profileType === 'government') {
		return /government|townhall|public|administrative|embassy|military|office|building/.test(c);
	}
	return true;
}

async function lookupNominatim(
	name: string,
	profileType: ProfileType,
	countryHint?: string | null,
): Promise<FreeOrgAddress | null> {
	const wait = 1100 - (Date.now() - lastNominatimAt);
	if (wait > 0) await sleep(wait);
	lastNominatimAt = Date.now();

	const params = new URLSearchParams({
		q: name.slice(0, 120),
		format: 'json',
		addressdetails: '1',
		limit: '5',
	});
	if (countryHint && /^[a-z]{2}$/i.test(countryHint)) {
		params.set('countrycodes', countryHint.toLowerCase());
	}

	const data = (await fetchJson(`${NOMINATIM}?${params}`)) as Array<{
		display_name?: string;
		name?: string;
		lat?: string;
		lon?: string;
		class?: string;
		type?: string;
		address?: Record<string, string>;
	}>;

	for (const hit of data || []) {
		const label = String(hit.name || hit.display_name || '');
		if (!nameLooksLikeHit(name, label.split(',')[0] || label)) continue;
		if (!nominatimClassOk(profileType, String(hit.class || ''), String(hit.type || ''))) continue;

		const a = hit.address || {};
		const house = a.house_number || '';
		const road = a.road || a.pedestrian || a.footway || '';
		const city = a.city || a.town || a.village || a.municipality || '';
		const state = a.state || '';
		const postcode = a.postcode || '';
		const country = a.country || '';
		const line1 = [house, road].filter(Boolean).join(' ').trim();
		const raw = [line1 || null, city && state ? `${city}, ${state}` : city || state, postcode, country]
			.filter(Boolean)
			.join(', ');
		if (!raw || !isPlausibleStreetHq(raw)) {
			// Sometimes display_name is the only street-bearing string
			const disp = String(hit.display_name || '');
			if (!isPlausibleStreetHq(disp)) continue;
			return {
				raw: disp,
				city: city || null,
				state: state || null,
				country: country || null,
				lat: Number(hit.lat) || null,
				lon: Number(hit.lon) || null,
				source: 'nominatim',
				sourceUrl: 'https://www.openstreetmap.org/',
			};
		}
		return {
			raw,
			city: city || null,
			state: state || null,
			country: country || null,
			lat: Number(hit.lat) || null,
			lon: Number(hit.lon) || null,
			source: 'nominatim',
			sourceUrl: 'https://www.openstreetmap.org/',
		};
	}
	return null;
}

/**
 * Lookup free address / founding date / status for an org profile.
 */
export async function lookupOrgFreeEnrich(
	input: FreeOrgEnrichInput,
): Promise<FreeOrgEnrichResult> {
	const evidence: FreeOrgEnrichResult['evidence'] = [];
	const result: FreeOrgEnrichResult = { evidence };

	if (looksLikeSecuritiesJunk(input.name, input.profileType)) {
		return result;
	}

	const shortName = isShortOrAcronymName(input.name);
	const runProPublica = input.profileType === 'nonprofit' && !input.skipProPublica;
	// Acronym nonprofits: ProPublica first (Wikidata label collisions are common).
	const proPublicaFirst = runProPublica && (shortName || Boolean(input.ein));

	const mergeBulk = (bulk: Awaited<ReturnType<typeof lookupIrsEoBmf>>) => {
		if (!bulk) return;
		if (bulk.ein && !result.ein) result.ein = bulk.ein;
		if (bulk.address && !result.address) result.address = bulk.address;
		if (bulk.startDate && !result.startDate) result.startDate = bulk.startDate;
		if (bulk.endDate && !result.endDate) result.endDate = bulk.endDate;
		if (bulk.status === 'archived') result.status = 'archived';
		else if (bulk.status === 'active' && result.status !== 'archived') result.status = 'active';
		for (const e of bulk.evidence) evidence.push(e);
	};

	// IRS EO BMF (local CSVs) — strong nonprofit ruling date + status
	if (input.profileType === 'nonprofit' && !input.skipIrsBmf) {
		try {
			mergeBulk(await lookupIrsEoBmf({ name: input.name, ein: input.ein }));
		} catch {
			/* soft-fail */
		}
	}

	// College Scorecard API + IPEDS HD for U.S. education address/operating status
	if (input.profileType === 'education' && !input.skipScorecard) {
		try {
			mergeBulk(await lookupCollegeScorecard({ name: input.name }));
		} catch {
			/* soft-fail */
		}
		try {
			mergeBulk(await lookupIpedsHd({ name: input.name, ein: input.ein }));
		} catch {
			/* soft-fail */
		}
	}

	const applyProPublica = async () => {
		if (!runProPublica) return;
		try {
			const pp = await lookupProPublica(input.name, input.ein);
			if (pp.ein) {
				result.ein = pp.ein;
				evidence.push({ field: 'ein', source: 'propublica', value: pp.ein });
			}
			if (pp.address && !result.address) {
				result.address = pp.address;
				evidence.push({
					field: 'address',
					source: 'propublica',
					value: pp.address.raw,
					url: pp.address.sourceUrl,
				});
			}
			if (pp.startDate && !result.startDate) {
				result.startDate = pp.startDate;
				evidence.push({ field: 'startDate', source: 'propublica', value: pp.startDate });
			}
			if (pp.status === 'archived') {
				result.status = 'archived';
				evidence.push({ field: 'status', source: 'propublica', value: 'archived' });
			} else if (pp.status === 'active' && result.status !== 'archived') {
				result.status = 'active';
			}
		} catch {
			/* soft-fail */
		}
	};

	if (proPublicaFirst) await applyProPublica();

	try {
		const wd = await lookupWikidata(input.name);
		if (wd.qid) {
			result.wikidataQid = wd.qid;
			evidence.push({
				field: 'wikidataQid',
				source: 'wikidata',
				value: wd.qid,
				url: `https://www.wikidata.org/wiki/${wd.qid}`,
			});
		}
		if (wd.address && !result.address) {
			result.address = wd.address;
			evidence.push({
				field: 'address',
				source: 'wikidata',
				value: wd.address.raw,
				url: wd.address.sourceUrl,
			});
		}
		if (wd.startDate && !result.startDate) {
			result.startDate = wd.startDate;
			evidence.push({ field: 'startDate', source: 'wikidata', value: wd.startDate });
		}
		// Only apply dissolved/end when we did not already confirm an active nonprofit filing.
		if (wd.endDate && result.status !== 'active') {
			result.endDate = wd.endDate;
			result.status = 'archived';
			evidence.push({ field: 'endDate', source: 'wikidata', value: wd.endDate });
		}
	} catch {
		/* soft-fail */
	}

	if (runProPublica && !proPublicaFirst) await applyProPublica();

	// Skip Nominatim for short acronyms without a street yet from structured sources.
	if (!result.address && !input.skipNominatim && !shortName) {
		try {
			const nom = await lookupNominatim(input.name, input.profileType, input.countryHint);
			if (nom) {
				result.address = nom;
				evidence.push({
					field: 'address',
					source: 'nominatim',
					value: nom.raw,
					url: nom.sourceUrl,
				});
			}
		} catch {
			/* soft-fail */
		}
	}

	return result;
}
