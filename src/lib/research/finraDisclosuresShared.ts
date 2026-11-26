/**
 * Client-safe FINRA/SEC disclosure types and helpers (no Node fs).
 */

export type FinraDisclosureDetailField = {
	label: string;
	value: string;
};

export type FinraDisclosureEvent = {
	eventDate: string | null;
	disclosureType: string;
	resolution: string | null;
	/** BrokerCheck (FINRA) and/or SEC IAPD presence for this event. */
	sources: Array<'finra' | 'sec'>;
	fields: FinraDisclosureDetailField[];
};

export type FinraDisclosureTypeCount = {
	disclosureType: string;
	count: number;
};

export type ProfileFinraDisclosures = {
	ok: true;
	crd: string;
	crdKind: 'individual' | 'firm';
	found: boolean;
	fromCache: boolean;
	hasFinraData: boolean;
	hasSecData: boolean;
	/** BrokerCheck disclosure flag (Y/N). */
	finraDisclosureFlag: boolean | null;
	/** SEC/IA disclosure flag (Y/N). */
	secDisclosureFlag: boolean | null;
	/** Detailed events (typical for individuals). */
	events: FinraDisclosureEvent[];
	/** Type→count summaries (typical for firms; also used for IA rollups). */
	typeCounts: FinraDisclosureTypeCount[];
	/** True when event bodies were filled/merged from the BrokerCheck PDF. */
	fromPdf?: boolean;
	/** BrokerCheck report PDF (files.brokercheck.finra.org). */
	brokercheckPdfUrl?: string | null;
	/** When PDF/API returned more events than returned in `events`. */
	eventsTotal?: number | null;
	dashboardUrl: string;
	brokercheckUrl: string | null;
	adviserInfoUrl: string | null;
	sourceUrl: string;
};

/** True when the overview should render a Disclosures block. */
export function hasDisplayableDisclosures(d: ProfileFinraDisclosures | null | undefined): boolean {
	if (!d?.found) return false;
	if (d.events.length > 0) return true;
	if (d.typeCounts.some((t) => t.count > 0)) return true;
	if (d.finraDisclosureFlag === true || d.secDisclosureFlag === true) return true;
	return false;
}
