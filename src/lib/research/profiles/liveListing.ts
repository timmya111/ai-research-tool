/**
 * Detect whether a firm is linked to an external live listing / registry URL
 * (MineralAnswers producer page, BrokerCheck, company site, etc.).
 * Excludes our FINRA visualizer URLs and archival EDGAR browse links.
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
