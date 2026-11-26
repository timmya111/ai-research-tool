/**
 * Format Research Drive OCR digests for timeline / evidence display.
 * Digests store markdown headers (Source path, Method, ## Extracted text); UI should show OCR body + a short keyword title.
 */

const DIGEST_HEADER_LINE_RE =
	/^(?:#{1,3}\s+.*|\*\*Source path:\*\*.*|\*\*Method:\*\*.*|\*\*Model:\*\*.*|\*\*Folder:\*\*.*|\*\*Bytes:\*\*.*|\*\*OCR at:\*\*.*|\*\*Translated:\*\*.*|Source path:.*|Method:.*|Model:.*|Folder:.*|Bytes:.*|OCR at:.*)$/i;

const NOTE_PREFIX_RE = /^\[note\]\s*/i;
const PROJECT_TITLE_RE = /^\[([^\]]+)\]\s*(.+)$/;
const STAGING_FOOTER_RE = /\n*---\s*\n*_?Local research-drive staging[\s\S]*$/i;

const KEYWORD_PATTERNS: Array<{ re: RegExp; title: string }> = [
	// Prefer page-specific cues before generic decree headings (multi-page adoption packets).
	{ re: /\bparent[- ]child\s+relationship\s+shall\s+exist\b/i, title: 'Parent-child relationship order' },
	{ re: /\bIT\s+IS\s+FURTHER\s+ORDERED\s+that\s+the\s+child\s+shall\s+henceforth\b/i, title: 'Name-change order' },
	{ re: /\btrial\s+on\s+the\s+merits\s+was\s+held\b/i, title: 'Adoption trial' },
	{ re: /\bPetitioners?,?\s+[A-Z][A-Z\s.,]+(?:ADAMS|appeared)\b/i, title: 'Adoption trial' },
	{ re: /\bDECREE\s+OF\s+ADOPTION\b/i, title: 'Decree of Adoption' },
	{ re: /\bADOPTION\s+DECREE\b/i, title: 'Adoption Decree' },
	{ re: /\bBIRTH\s+CERTIFICATE\b/i, title: 'Birth certificate' },
	{ re: /\bCERTIFICATE\s+OF\s+BIRTH\b/i, title: 'Birth certificate' },
	{ re: /\bMARRIAGE\s+LICENSE\b/i, title: 'Marriage license' },
	{ re: /\bDEATH\s+CERTIFICATE\b/i, title: 'Death certificate' },
	{ re: /\bOBITUARY\b/i, title: 'Obituary' },
	{ re: /\bPhone\s+Numbers?\b/i, title: 'Phone numbers' },
	{ re: /\bRelatives?\b.*\bSee all relatives\b/i, title: 'Phone numbers & relatives' },
	{ re: /\bFUNERAL\b/i, title: 'Funeral record' },
	{ re: /\bWARRANTY\s+DEED\b/i, title: 'Warranty deed' },
	{ re: /\bQUITCLAIM\b/i, title: 'Quitclaim deed' },
];

export function isResearchDriveTimelineTitle(title: string | null | undefined): boolean {
	const t = String(title || '').trim();
	return /^\[Research Drive\]/i.test(t) || /^Research Drive:/i.test(t);
}

export function isResearchDriveCorpus(corpus: string | null | undefined): boolean {
	const c = String(corpus || '').trim().toLowerCase();
	return c === 'knowledge-sqlite' || c === 'research-drive' || c.startsWith('knowledge:research');
}

/** Pull the OCR body out of a digest or timeline summary snippet. */
export function extractResearchDriveOcrText(raw: string | null | undefined): string {
	let s = String(raw || '').replace(/\r\n/g, '\n').trim();
	if (!s) return '';

	s = s.replace(NOTE_PREFIX_RE, '');
	s = s.replace(STAGING_FOOTER_RE, '').trim();

	const extracted = s.split(/##\s*Extracted text\s*/i);
	if (extracted.length > 1) {
		s = extracted.slice(1).join('\n').trim();
	} else {
		// Flattened one-line snippets: drop leading digest meta until OCR-looking prose.
		s = s
			.replace(
				/^[\s\S]*?(?:\*\*OCR at:\*\*[^*\n]*\*?|OCR at:[^\n]*)\s*/i,
				'',
			)
			.replace(/^#{1,3}\s+[^\n]+\n+/, '')
			.trim();
		// Drop remaining **Source path:** … **OCR at:** runs if still present inline.
		s = s
			.replace(
				/(?:\*\*)?(?:Source path|Method|Model|Folder|Bytes|OCR at|Translated)(?:\*\*)?:\s*`?[^`\n*]*`?\s*/gi,
				'',
			)
			.trim();
		// Screenshot digests often start with the filename before the UI OCR.
		s = s.replace(/^Screenshot\s+20\d{2}-\d{2}-\d{2}[^\n]*?(?=Phone\s+Numbers|Relatives|Addresses|Names)/i, '').trim();
		s = s.replace(/^IMG[_\s-]?\d+[^\n]*?(?=[A-Z]{2,})/i, '').trim();
	}

	const lines = s.split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) {
			if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
			continue;
		}
		if (DIGEST_HEADER_LINE_RE.test(t)) continue;
		if (/^_Local research-drive staging/i.test(t)) continue;
		kept.push(line.replace(/\s+$/g, ''));
	}
	return kept.join('\n').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Short keyword title from OCR body (fallback: cleaned filename / existing title). */
export function keywordTitleFromResearchDriveOcr(
	ocrText: string,
	fallbackTitle?: string | null,
): string {
	const body = String(ocrText || '').replace(/\s+/g, ' ').trim();
	const head = body.slice(0, 280);
	// Cover/caption pages lead with the decree heading before the trial narrative.
	if (/\bDECREE\s+OF\s+ADOPTION\b/i.test(head)) return 'Decree of Adoption';
	if (/\bADOPTION\s+DECREE\b/i.test(head)) return 'Adoption Decree';
	for (const { re, title } of KEYWORD_PATTERNS) {
		if (re.test(body)) return title;
	}

	// First ALL-CAPS run of 2–6 words (court form headings).
	const caps = body.match(/\b([A-Z][A-Z0-9][A-Z0-9 /&-]{4,60}[A-Z0-9])\b/);
	if (caps) {
		const phrase = caps[1]!.replace(/\s+/g, ' ').trim();
		if (phrase.split(' ').length <= 6) {
			return phrase
				.toLowerCase()
				.replace(/\b\w/g, (c) => c.toUpperCase())
				.slice(0, 80);
		}
	}

	const fb = String(fallbackTitle || '').trim();
	const m = fb.match(PROJECT_TITLE_RE);
	const rawName = (m ? m[2] : fb).replace(/^\[Research Drive\]\s*/i, '').trim();
	if (rawName && !/^IMG[_\s-]?\d+/i.test(rawName) && !/^Screenshot\b/i.test(rawName)) {
		return rawName.slice(0, 80);
	}
	if (/^Screenshot\b/i.test(rawName)) return 'Screenshot lead';
	if (/^IMG[_\s-]?\d+/i.test(rawName)) return 'Document scan';
	return rawName.slice(0, 80) || 'Research Drive document';
}

export type FormattedResearchDriveTimeline = {
	title: string;
	summary: string;
	isResearchDrive: boolean;
};

export function formatResearchDriveTimelineEntry(opts: {
	title?: string | null;
	summary?: string | null;
	sourceCorpus?: string | null;
}): FormattedResearchDriveTimeline {
	const title = String(opts.title || '').trim();
	const summary = String(opts.summary || '').trim();
	const isRd =
		isResearchDriveTimelineTitle(title) ||
		isResearchDriveCorpus(opts.sourceCorpus) ||
		/\*\*Source path:\*\*|##\s*Extracted text/i.test(summary);

	if (!isRd) {
		return { title, summary, isResearchDrive: false };
	}

	const ocr = extractResearchDriveOcrText(summary || title);
	const keyword = keywordTitleFromResearchDriveOcr(ocr, title);
	// Prefer folder citation (research-drive/Personal) over raw IMG_ / Screenshot filenames.
	let body = ocr || summary;
	body = body
		.replace(
			/\bResearch Drive:\s*((?:Personal|Family|Landlord|geology|Land)(?:\/[^\s,;]+)?)\s*\/?\s*IMG[_\s-]?\d+[^\n.]*/gi,
			(_m, folder: string) => `research-drive/${String(folder).replace(/^research-drive\//i, '')}`,
		)
		.replace(
			/\b(?:Source|Sources):\s*(?:Research Drive\s+)?(?:Personal\/)?IMG[_\s-]?\d+(?:\s*[\/,–—-]\s*(?:IMG[_\s-]?\d+)*)*/gi,
			'Source: research-drive/Personal',
		)
		.replace(/\bPersonal\/IMG[_\s-]?\d+\.[A-Za-z0-9]+/gi, 'research-drive/Personal')
		.replace(/\bFamily\/[^\s,;]*IMG[_\s-]?\d+[^\s,;]*/gi, 'research-drive/Family')
		.trim();
	return {
		title: keyword,
		summary: body,
		isResearchDrive: true,
	};
}
