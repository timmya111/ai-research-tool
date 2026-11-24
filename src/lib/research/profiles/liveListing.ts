/**
 * Detect whether a firm is linked to an external live listing / registry URL
 * (MineralAnswers producer page, BrokerCheck, company site, etc.).
 * Excludes our FINRA visualizer URLs and archival EDGAR browse links.
 *
 * Also ranks website URLs so merges prefer an official company site as primary
 * while still keeping MineralAnswers / Wikipedia / etc. as secondary url= rows.
 */

const LIVE_LISTING_META_KEYS = [
	'mineralAnswersUrl',
	'mineralAnswersTxUrl',
	'mineralAnswersOkUrl',
	'brokercheckUrl',
	'brokerCheckUrl',
	'adviserInfoUrl',
	'companyUrl',
	'website',
	'websiteUrl',
	'homepage',
] as const;

function hostnameOfUrl(raw: string): string | null {
	const text = String(raw || '').trim();
	if (!text) return null;
	try {
		const withProto = /^https?:\/\//i.test(text) ? text : `https://${text}`;
		return new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
	} catch {
		return null;
	}
}

/** True for external directories / company listings; false for our app + archival filing browsers. */
export function isLiveListingUrl(raw: string): boolean {
	const host = hostnameOfUrl(raw);
	if (!host) return false;
	if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.local')) return false;
	if (host.includes('finra-sec-data-visualizer')) return false;
	if (host === 'sec.gov' || host.endsWith('.sec.gov')) {
		// adviserinfo is a live IA registry; plain EDGAR browse is archival
		return host.includes('adviserinfo');
	}
	if (host.includes('wikipedia.org') || host.includes('wikidata.org')) return false;
	return true;
}

/**
 * Higher = better primary website for a profile card.
 * Official company domains beat registries, MineralAnswers, Wikipedia, social, and app URLs.
 */
export function urlPreferenceScore(raw: string): number {
	const host = hostnameOfUrl(raw);
	if (!host) return 0;
	if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.local')) return 0;
	if (host.includes('finra-sec-data-visualizer')) return 5;
	if (host.includes('wikipedia.org') || host.includes('wikidata.org')) return 30;
	if (
		host.includes('youtube.com') ||
		host === 'youtu.be' ||
		host.includes('linkedin.com') ||
		host.includes('twitter.com') ||
		host === 'x.com' ||
		host.includes('facebook.com') ||
		host.includes('instagram.com')
	) {
		return 20;
	}
	if (
		host.includes('bloomberg.com') ||
		host.includes('reuters.com') ||
		host.includes('nytimes.com') ||
		host.includes('wsj.com') ||
		host.includes('ft.com')
	) {
		return 25;
	}
	if (host.includes('mineralanswers.com')) return 50;
	if (host.includes('okcountyrecords.com') || host.includes('oklahomacounty.org')) return 45;
	if (host.includes('brokercheck.finra.org') || host.includes('finra.org')) return 70;
	if (host.includes('adviserinfo.sec.gov')) return 70;
	if (host === 'sec.gov' || host.endsWith('.sec.gov')) return 40;
	// Generic https host → treat as official / company site
	return 100;
}

/** True when the URL looks like a first-party company / org website. */
export function isOfficialWebsiteUrl(raw: string): boolean {
	return urlPreferenceScore(raw) >= 100;
}

/** Pick the best primary website from a list (official company site preferred). */
export function pickPreferredWebsiteUrl(urls: Array<string | null | undefined>): string | null {
	let best: string | null = null;
	let bestScore = -1;
	for (const raw of urls) {
		const u = String(raw || '').trim();
		if (!u || !/^https?:\/\//i.test(u)) continue;
		const score = urlPreferenceScore(u);
		if (score > bestScore) {
			bestScore = score;
			best = u;
		} else if (score === bestScore && best && u.length < best.length) {
			// Prefer shorter canonical homepage over deep links at the same tier
			best = u;
		}
	}
	return bestScore > 0 ? best : null;
}

/** Sort url identifiers so official sites come first; other schemes unchanged relative order. */
export function sortIdentifiersByUrlPreference<T extends { scheme: string; value: string }>(
	identifiers: T[],
): T[] {
	return [...identifiers].sort((a, b) => {
		const sa = String(a.scheme || '').toLowerCase();
		const sb = String(b.scheme || '').toLowerCase();
		if (sa !== sb) return sa.localeCompare(sb);
		if (sa === 'url') {
			const diff = urlPreferenceScore(b.value) - urlPreferenceScore(a.value);
			if (diff !== 0) return diff;
		}
		return String(a.value).localeCompare(String(b.value));
	});
}

function urlsFromMetadata(meta: Record<string, unknown> | null | undefined): string[] {
	if (!meta || typeof meta !== 'object') return [];
	const out: string[] = [];
	for (const key of LIVE_LISTING_META_KEYS) {
		const v = meta[key];
		if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) out.push(v.trim());
	}
	return out;
}

export function detectFirmLiveSourceUrl(
	meta: Record<string, unknown> | null | undefined,
	identifiers?: Array<{ scheme: string; value: string }> | null,
): boolean {
	for (const u of urlsFromMetadata(meta)) {
		if (isLiveListingUrl(u)) return true;
	}
	for (const id of identifiers || []) {
		if (String(id.scheme || '').toLowerCase() !== 'url') continue;
		if (isLiveListingUrl(id.value)) return true;
	}
	return false;
}

/** True when FINRA BrokerCheck or SEC IA scope from the visualizer/API is ACTIVE. */
export function detectFirmActiveFinraScope(
	meta: Record<string, unknown> | null | undefined,
): boolean {
	if (!meta || typeof meta !== 'object') return false;
	const bc = String(meta.finraBcScope || '').trim().toUpperCase();
	const ia = String(meta.finraIaScope || '').trim().toUpperCase();
	return bc === 'ACTIVE' || ia === 'ACTIVE';
}
