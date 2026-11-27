/**
 * Yahoo Finance firm profile enricher (US listings).
 *
 * Direct query*.finance.yahoo.com APIs are rate-limited (429). Background
 * access uses FlareSolverr → https://finance.yahoo.com/quote/{TICKER}/profile/
 * (~15–20s). Never block interactive create on this — call scheduleYahooFirmEnrich.
 */
import {
	buildProfileIdentityContext,
	evaluateIdentityMatch,
	hasStrongLocationAlignments,
} from '@/lib/research/profiles/identity';
import {
	addAlias,
	addIdentifier,
	addLocation,
	getProfile,
	getProfileDetail,
	upsertProfile,
} from '@/lib/research/profiles/store';

const FLARE = (process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');
const CORPUS = 'yahoo-finance-profile';
const STALE_MS = Number(process.env.RESEARCH_YAHOO_STALE_MS || 30 * 24 * 60 * 60 * 1000);

export type YahooFirmProfile = {
	ticker: string;
	legalName: string | null;
	address: string | null;
	city: string | null;
	state: string | null;
	zip: string | null;
	country: string | null;
	phone: string | null;
	website: string | null;
	sector: string | null;
	industry: string | null;
	fullTimeEmployees: number | null;
	description: string | null;
	officers: Array<{ name: string; title: string }>;
	sourceUrl: string;
};

function yahooEnabled(): boolean {
	return !/^(0|false|no)$/i.test(String(process.env.RESEARCH_YAHOO_ENRICH ?? '1'));
}

export async function flaresolverrHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`${FLARE}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return false;
		const j = (await res.json()) as { status?: string };
		return j.status === 'ok' || res.status === 200;
	} catch {
		return false;
	}
}

async function flareGet(url: string): Promise<string> {
	const res = await fetch(`${FLARE}/v1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 90000 }),
		signal: AbortSignal.timeout(120000),
	});
	if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
	const data = (await res.json()) as {
		solution?: { response?: string; status?: number };
	};
	const html = data.solution?.response || '';
	if (!html || (data.solution?.status && data.solution.status >= 400)) {
		throw new Error(`Yahoo/FlareSolverr empty or bad status=${data.solution?.status}`);
	}
	return html;
}

function stripTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, '\n')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n+/g, '\n');
}

export function parseYahooProfileHtml(html: string, ticker: string): YahooFirmProfile {
	const text = stripTags(html);
	const out: YahooFirmProfile = {
		ticker: String(ticker || '').toUpperCase(),
		legalName: null,
		address: null,
		city: null,
		state: null,
		zip: null,
		country: null,
		phone: null,
		website: null,
		sector: null,
		industry: null,
		fullTimeEmployees: null,
		description: null,
		officers: [],
		sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/profile/`,
	};

	const addrBlock = text.match(
		/(\d+[^\n]*)\n([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\nUnited States/,
	);
	if (addrBlock) {
		out.address = addrBlock[1].trim();
		out.city = addrBlock[2].trim();
		out.state = addrBlock[3].trim();
		out.zip = addrBlock[4].trim();
		out.country = 'United States';
	}

	const phone = text.match(/\n(\d{3}-\d{3}-\d{4})\n/);
	if (phone) out.phone = phone[1];

	const web = text.match(/\n(https?:\/\/[^\s\n]+)\n\s*Sector:/);
	if (web) out.website = web[1].trim();

	const sector = text.match(/Sector:\s*\n\s*([^\n]+)\n\s*Industry:\s*\n\s*([^\n]+)/);
	if (sector) {
		out.sector = sector[1].trim();
		out.industry = sector[2].trim();
	}

	const emp = text.match(/Full Time Employees:\s*\n\s*([0-9,]+)/i);
	if (emp) out.fullTimeEmployees = Number(String(emp[1]).replace(/,/g, '')) || null;

	const descIdx = text.search(/\nDescription\s*\n/);
	if (descIdx >= 0) {
		const after = text.slice(descIdx).replace(/^\nDescription\s*\n+/, '');
		const para = after.split(/\n\s*\n/)[0] || '';
		out.description = para.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
	}

	const anchor = text.search(/\n\d+[^\n]*\n[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}/);
	const chunk = anchor > 0 ? text.slice(Math.max(0, anchor - 3500), anchor) : text.slice(0, 8000);
	const officerRe =
		/((?:Mr\.|Ms\.|Mrs\.)\s+[A-Za-z .'-]+(?:\s+(?:Jr\.|Sr\.|Ph\.D\.|J\.D\.))?)\n([A-Za-z][^\n]{3,120})\n/g;
	let m: RegExpExecArray | null;
	while ((m = officerRe.exec(chunk))) {
		const name = m[1].replace(/^(?:Mr\.|Ms\.|Mrs\.)\s+/, '').trim();
		const title = m[2].trim();
		if (/^--|^\d|Corporate Governance|Sector:|Industry:/.test(title)) continue;
		if (out.officers.some((o) => o.name === name)) continue;
		out.officers.push({ name, title });
	}

	const legal = text.match(
		/\n((?:[A-Z][A-Za-z0-9 &.,'-]{1,80}(?:Inc\.|Corporation|Company|Co\.)))\n\s*\n\s*\d/,
	);
	if (legal) out.legalName = legal[1].trim();

	return out;
}

export async function fetchYahooFirmProfile(ticker: string): Promise<YahooFirmProfile> {
	const sym = String(ticker || '')
		.trim()
		.toUpperCase();
	if (!sym) throw new Error('ticker required');
	const html = await flareGet(`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/profile/`);
	return parseYahooProfileHtml(html, sym);
}

function needsYahooEnrich(profileId: string): boolean {
	const p = getProfile(profileId);
	if (!p || p.profileType !== 'firm') return false;
	const at = p.metadata?.yahooEnrichedAt;
	if (!at || typeof at !== 'string') return true;
	const ts = Date.parse(at);
	if (!Number.isFinite(ts)) return true;
	return Date.now() - ts > STALE_MS;
}

export function applyYahooFirmProfile(
	profileId: string,
	yahoo: YahooFirmProfile,
	opts?: { exchange?: string },
): void {
	const existing = getProfile(profileId);
	if (!existing || existing.profileType !== 'firm') {
		throw new Error('Yahoo enrich requires an existing firm profile');
	}
	// Snapshot identity context BEFORE writing Yahoo's identifiers/summary so location
	// authorization cannot self-corroborate against freshly added Yahoo fields.
	const preDetailForLoc = getProfileDetail(profileId);

	const summaryParts: string[] = [];
	if (yahoo.description) summaryParts.push(yahoo.description);
	const bits = [
		`Ticker ${yahoo.ticker}`,
		yahoo.sector || null,
		yahoo.industry || null,
		yahoo.fullTimeEmployees ? `employees ~${yahoo.fullTimeEmployees.toLocaleString()}` : null,
	].filter(Boolean);
	if (bits.length) summaryParts.push(bits.join(' · ') + '.');
	summaryParts.push(`Source: ${yahoo.sourceUrl}`);

	const prevSummary = String(existing.summary || '').trim();
	const nextSummary =
		prevSummary && prevSummary.length > 80 && !/yahoo finance/i.test(prevSummary)
			? `${summaryParts.join('\n\n')}\n\n---\n\n${prevSummary}`
			: summaryParts.join('\n\n');

	upsertProfile({
		profileType: 'firm',
		name: existing.name,
		slug: existing.slug.replace(/^firm:/, ''),
		status: existing.status === 'archived' ? 'active' : existing.status,
		summary: nextSummary,
		metadata: {
			...existing.metadata,
			ticker: yahoo.ticker,
			exchange: opts?.exchange || existing.metadata?.exchange || 'NYSE',
			website: yahoo.website || existing.metadata?.website,
			yahooFinanceUrl: yahoo.sourceUrl,
			phone: yahoo.phone || existing.metadata?.phone,
			sector: yahoo.sector || existing.metadata?.sector,
			industry: yahoo.industry || existing.metadata?.industry,
			fullTimeEmployees: yahoo.fullTimeEmployees ?? existing.metadata?.fullTimeEmployees,
			legalName: yahoo.legalName || existing.metadata?.legalName,
			yahooEnrichedAt: new Date().toISOString(),
			corpora: Array.from(
				new Set([
					...(Array.isArray(existing.metadata?.corpora)
						? (existing.metadata.corpora as unknown[]).map(String)
						: []),
					CORPUS,
				]),
			),
		},
		sourceCorpus: CORPUS,
	});

	addIdentifier({
		profileId,
		scheme: 'ticker',
		value: yahoo.ticker,
		sourceCorpus: CORPUS,
	});
	if (yahoo.website) {
		addIdentifier({ profileId, scheme: 'url', value: yahoo.website, sourceCorpus: CORPUS });
	}
	addIdentifier({
		profileId,
		scheme: 'url',
		value: yahoo.sourceUrl,
		sourceCorpus: CORPUS,
	});
	if (yahoo.legalName) {
		addAlias({ profileId, alias: yahoo.legalName, aliasKind: 'other_name', sourceCorpus: CORPUS });
	}
	if (yahoo.address || (yahoo.city && yahoo.state)) {
		const raw = [
			yahoo.address,
			yahoo.city && yahoo.state ? `${yahoo.city}, ${yahoo.state}${yahoo.zip ? ` ${yahoo.zip}` : ''}` : null,
			yahoo.country,
		]
			.filter(Boolean)
			.join(', ');
		const yahooEval = preDetailForLoc
			? evaluateIdentityMatch(buildProfileIdentityContext(preDetailForLoc), {
					candidateName: yahoo.legalName || existing.name,
					candidateAliases: yahoo.legalName ? [yahoo.legalName] : [],
					candidateIdentifiers: [
						{ scheme: 'ticker', value: yahoo.ticker },
						...(yahoo.website ? [{ scheme: 'url', value: yahoo.website }] : []),
					],
					candidateExchange: opts?.exchange || (existing.metadata?.exchange ? String(existing.metadata.exchange) : 'NYSE'),
					candidateLocations: [raw],
					candidateFirms: yahoo.officers.map((o) => o.name).filter(Boolean),
					candidateText: [
						yahoo.legalName || existing.name,
						yahoo.ticker,
						yahoo.sector || '',
						yahoo.industry || '',
						yahoo.website || '',
						raw,
						yahoo.description || '',
					]
						.filter(Boolean)
						.join(' '),
				})
			: null;
		if (hasStrongLocationAlignments(yahooEval, 2)) {
			addLocation({
				profileId,
				raw,
				city: yahoo.city,
				state: yahoo.state,
				country: yahoo.country === 'United States' ? 'US' : yahoo.country,
				role: 'hq',
				sourceCorpus: CORPUS,
			});
		}
	}
}

/** Fire-and-forget enrich when FlareSolverr is up and the firm card is stale. */
export function scheduleYahooFirmEnrich(
	profileId: string,
	ticker: string,
	opts?: { exchange?: string; force?: boolean },
): void {
	if (!yahooEnabled()) return;
	if (!opts?.force && !needsYahooEnrich(profileId)) return;

	void (async () => {
		try {
			if (!(await flaresolverrHealthy())) {
				console.warn('[yahoo-finance] FlareSolverr not healthy — skip enrich', ticker);
				return;
			}
			const yahoo = await fetchYahooFirmProfile(ticker);
			if (!yahoo.description && !yahoo.sector && !yahoo.address) {
				console.warn('[yahoo-finance] sparse parse — skip apply', ticker);
				return;
			}
			applyYahooFirmProfile(profileId, yahoo, { exchange: opts?.exchange });
			console.info('[yahoo-finance] enriched', ticker, profileId);
		} catch (err) {
			console.warn(
				'[yahoo-finance] enrich failed',
				ticker,
				err instanceof Error ? err.message : String(err),
			);
		}
	})();
}
