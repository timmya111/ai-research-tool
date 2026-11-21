export type BryanFeedItem = {
	id: string;
	site: string;
	instrumentNo: string;
	instrument: string;
	docType: string;
	images: number | null;
	href: string;
	county: string;
};

export type BryanFilingDetail = BryanFeedItem & {
	recorded: string | null;
	instrumentDate: string | null;
	book: string | null;
	pages: string | null;
	grantor: string | null;
	grantee: string | null;
	legal: string | null;
	filingFees: string | null;
	mortgageAmount: string | null;
	consideration: string | null;
	scrapedAt: string;
};

export const BRYAN_REALTIME_URL = 'https://okcountyrecords.com/real-time/bryan';
export const BRYAN_PROJECT_NAME = 'Bryan County';

export function parseFeedCardText(cardText: string): { docType: string; county: string; images: number | null } {
	const lines = String(cardText || '')
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	const docType = lines[0] || 'UNKNOWN';
	const county = lines.find((l) => /county/i.test(l)) || 'Bryan County';
	const imgLine = lines.find((l) => /image/i.test(l)) || '';
	const imgMatch = imgLine.match(/(\d+)\s+images?/i);
	return {
		docType,
		county,
		images: imgMatch ? Number(imgMatch[1]) : null,
	};
}

function cleanParty(value: string | null | undefined): string | null {
	const v = String(value || '')
		.replace(/\bSearch\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!v || /^parties$/i.test(v) || /^grantor$/i.test(v) || /^grantee$/i.test(v) || /^legal/i.test(v)) {
		return null;
	}
	return v;
}

export function parseDetailFromText(text: string, base: BryanFeedItem): BryanFilingDetail {
	const t = String(text || '');
	const field = (label: string): string | null => {
		const re = new RegExp(`${label}\\s*\\t\\s*([^\\n]+)`, 'i');
		const m = t.match(re);
		if (m) return m[1].trim();
		const re2 = new RegExp(`${label}\\s+([^\\n]+)`, 'i');
		const m2 = t.match(re2);
		return m2 ? m2[1].trim() : null;
	};
	const partyAfter = (label: string): string | null => {
		const re = new RegExp(`${label}\\s*[\\n\\r]+\\s*([^\\n\\r]+)`, 'i');
		const m = t.match(re);
		return m ? cleanParty(m[1]) : null;
	};

	return {
		...base,
		recorded: field('Recorded on') || field('Recorded'),
		instrumentDate: field('Instrument date'),
		book: field('Book'),
		pages: field('Pages'),
		grantor: partyAfter('Grantor'),
		grantee: partyAfter('Grantee'),
		legal: partyAfter('Legal Description'),
		filingFees: field('Filing Fees'),
		mortgageAmount: field('Mortgage amount'),
		consideration: field('Consideration amount'),
		scrapedAt: new Date().toISOString(),
	};
}

export function formatBryanFilingNote(detail: BryanFilingDetail): { title: string; text: string; url: string } {
	const title = `${detail.docType} ${detail.instrument}`.trim();
	const countyLabel = detail.county || 'Oklahoma County Records';
	const site = detail.site || 'bryan';
	const lines = [
		`## ${countyLabel} OKCR filing`,
		`- Instrument: ${detail.instrument}`,
		`- Type: ${detail.docType}`,
		`- County: ${countyLabel}`,
		`- Recorded: ${detail.recorded || 'unknown'}`,
		`- Instrument date: ${detail.instrumentDate || 'unknown'}`,
		`- Grantor: ${detail.grantor || 'unknown'}`,
		`- Grantee: ${detail.grantee || 'unknown'}`,
		`- Book: ${detail.book || 'unknown'}`,
		`- Pages: ${detail.pages || 'unknown'}`,
		`- Legal: ${detail.legal || 'unknown'}`,
		`- Filing fees: ${detail.filingFees || 'unknown'}`,
		`- Mortgage amount: ${detail.mortgageAmount || 'unknown'}`,
		`- Consideration: ${detail.consideration || 'unknown'}`,
		`- Images: ${detail.images ?? 'unknown'}`,
		`- Detail URL: ${detail.href}`,
		`- Record id: ${detail.id}`,
		`- Scraped at: ${detail.scrapedAt}`,
		'',
		`Source: https://okcountyrecords.com/real-time/${site}`,
	];
	return { title, text: lines.join('\n'), url: detail.href };
}
