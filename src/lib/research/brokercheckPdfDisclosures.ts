/**
 * Fetch BrokerCheck PDFs and parse Disclosure Event Details into structured events.
 * Used when the merged/API payload only has type counts or thin detail fields.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FinraDisclosureDetailField, FinraDisclosureEvent } from '@/lib/research/finraDisclosuresShared';

const PDF_ROOT = path.join(process.cwd(), '.data', 'brokercheck-pdfs');
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;

const LABEL_CANON: Array<{ match: string; label: string }> = [
	{ match: 'Employing firm when activities occurred which led to the complaint', label: 'Employing Firm' },
	{ match: 'Does the order constitute a final order based on', label: 'Final Fraud Order' },
	{ match: 'Is this an arbitration/CFTC', label: 'Arbitration/Civil' },
	{ match: 'Principal Sanction(s)/Relief Sought', label: 'Principal Sanction Sought' },
	{ match: 'Other Sanction(s)/Relief Sought', label: 'Other Sanction Sought' },
	{ match: 'Individual Contribution Amount', label: 'Individual Contribution' },
	{ match: 'Sum of All Relief Requested', label: 'Relief Requested' },
	{ match: 'Sum of All Relief Awarded', label: 'Relief Awarded' },
	{ match: 'Disputed Product Type', label: 'Product Type' },
	{ match: 'Principal Product Type', label: 'Product Type' },
	{ match: 'Other Product Type(s)', label: 'Other Product Type' },
	{ match: 'Docket/Case Number', label: 'Docket/Case Number' },
	{ match: 'Case Number', label: 'Case Number' },
	{ match: 'Case Initiated', label: 'Case Initiated' },
	{ match: 'Arbitration Forum', label: 'Arbitration Forum' },
	{ match: 'Date Complaint Received', label: 'Complaint Received' },
	{ match: 'Complaint Pending?', label: 'Complaint Pending' },
	{ match: 'Reporting Source', label: 'Reporting Source' },
	{ match: 'Current Status', label: 'Current Status' },
	{ match: 'Allegations', label: 'Allegations' },
	{ match: 'Product Type', label: 'Product Type' },
	{ match: 'Alleged Damages', label: 'Alleged Damages' },
	{ match: 'Is this an oral complaint?', label: 'Oral Complaint' },
	{ match: 'Is this a written complaint?', label: 'Written Complaint' },
	{ match: 'Settlement Amount', label: 'Settlement Amount' },
	{ match: 'Individual Contribution', label: 'Individual Contribution' },
	{ match: 'Broker Statement', label: 'Broker Statement' },
	{ match: 'Firm Statement', label: 'Firm Statement' },
	{ match: 'Initiated By', label: 'Initiated By' },
	{ match: 'Date Initiated', label: 'Date Initiated' },
	{ match: 'Resolution Date', label: 'Resolution Date' },
	{ match: 'Resolution', label: 'Resolution' },
	{ match: 'Sanctions Ordered', label: 'Sanctions Ordered' },
	{ match: 'Sanction Details', label: 'Sanction Details' },
	{ match: 'Other Sanctions Ordered', label: 'Other Sanctions' },
	{ match: 'URL for Regulatory Action', label: 'Regulatory Action URL' },
	{ match: 'Type of Event', label: 'Type of Event' },
	{ match: 'Disposition Date', label: 'Disposition Date' },
	{ match: 'Disposition', label: 'Disposition' },
	{ match: 'Status Date', label: 'Status Date' },
	{ match: 'Status', label: 'Status' },
];

const LABEL_ALT = [...LABEL_CANON]
	.sort((a, b) => b.match.length - a.match.length)
	.map((x) => x.match.replace(/\?$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	.join('|');

/**
 * BrokerCheck two-column layout: `Label:` / `Label?` / or `Label` + 2+ spaces then value.
 */
const LABEL_LINE_RE = new RegExp(`^\\s*(${LABEL_ALT})(?:\\s*[:?]|\\s{2,})\\s*(.*)$`, 'i');

const TYPE_HEADER_RE =
	/^\s*((?:Customer Dispute|Regulatory|Civil|Criminal|Bond|Judgment\/Lien|Judgment|Financial|Employment Separation After Allegations)\s*-\s*.+?)\s*$/i;

const ARB_HEADER_RE = /^\s*(Arbitration(?:\s+Award)?(?:\s*-\s*.+)?)\s*$/i;

const DISCLOSURE_N_RE = /^\s*Disclosure\s+(\d+)\s+of\s+(\d+)\s*$/i;

function pdfUrl(crdKind: 'individual' | 'firm', crd: string): string {
	return crdKind === 'firm' ?
			`https://files.brokercheck.finra.org/firm/firm_${crd}.pdf`
		:	`https://files.brokercheck.finra.org/individual/individual_${crd}.pdf`;
}

function ensureDirs(crdKind: 'individual' | 'firm') {
	fs.mkdirSync(path.join(PDF_ROOT, crdKind), { recursive: true });
}

function extractPdfText(buffer: Buffer): string {
	const result = spawnSync('pdftotext', ['-layout', '-nopgbrk', '-', '-'], {
		input: buffer,
		encoding: 'buffer',
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const err = String(result.stderr || result.error || 'pdftotext failed');
		throw new Error(`BrokerCheck PDF text extract failed: ${err.slice(0, 240)}`);
	}
	return Buffer.from(result.stdout || []).toString('utf8');
}

function stripFooters(text: string): string {
	// pdftotext often emits U+FFFD for the © glyph
	let out = text.replace(
		/(?:©|\uFFFD)?\s*20\d{2}\s+FINRA\.\s+All rights reserved\.[\s\S]*?(?:User Guidance|www\.finra\.org\/brokercheck)/gi,
		'\n',
	);
	out = out.replace(/^\s*www\.finra\.org\/brokercheck\s*$/gim, '');
	out = out.replace(/^\s*User Guidance\s*$/gim, '');
	out = out.replace(/^\s*Report about .*$/gim, '');
	out = out.replace(/^\s*End of Report\s*$/gim, '');
	out = out.replace(/^\s*This page is intentionally left blank\.\s*$/gim, '');
	return out;
}

function normalizeMultiLineLabels(block: string): string {
	let b = block;
	b = b.replace(
		/Employing firm when\s+([^\n]*)\n\s*activities occurred which led\s*\n\s*to the complaint:/gi,
		'Employing firm when activities occurred which led to the complaint: $1',
	);
	b = b.replace(
		/Is this an arbitration\/CFTC\s+([^\n]*)\n\s*reparation or civil litigation\?/gi,
		'Is this an arbitration/CFTC: $1',
	);
	b = b.replace(
		/Principal Sanction\(s\)\/Relief\s+([^\n]*)\n\s*Sought:/gi,
		(_m, v: string) => `Principal Sanction(s)/Relief Sought: ${String(v || '').trim()}`,
	);
	b = b.replace(/Principal Sanction\(s\)\/Relief\s*\n\s*Sought:/gi, 'Principal Sanction(s)/Relief Sought:');
	b = b.replace(
		/Other Sanction\(s\)\/Relief\s+([^\n]*)\n\s*Sought:/gi,
		(_m, v: string) => `Other Sanction(s)/Relief Sought: ${String(v || '').trim()}`,
	);
	b = b.replace(/Other Sanction\(s\)\/Relief\s*\n\s*Sought:/gi, 'Other Sanction(s)/Relief Sought:');
	b = b.replace(
		/Does the order constitute a\s+([^\n]*)\n\s*final order based on\s*\n\s*violations of any laws or\s*\n\s*regulations that prohibit\s*\n\s*fraudulent, manipulative, or\s*\n\s*deceptive conduct\?/gi,
		'Does the order constitute a final order based on: $1',
	);
	// Layout often splits "Individual Contribution Amount:" across lines with the
	// value sitting on the first line: "Individual Contribution   $0.00\nAmount:"
	b = b.replace(
		/Individual Contribution\s+(\$?[\d,]+\.\d{2})?\s*\n\s*Amount:/gi,
		(_m, amount: string | undefined) =>
			`Individual Contribution Amount: ${amount || ''}`.trimEnd(),
	);
	b = b.replace(/Individual Contribution\s*\n\s*Amount:/gi, 'Individual Contribution Amount:');
	return b;
}

function canonLabel(raw: string): string {
	const t = raw.trim().replace(/\?$/, '');
	const lower = t.toLowerCase();
	for (const row of LABEL_CANON) {
		const m = row.match.replace(/\?$/, '').toLowerCase();
		if (lower === m || lower.startsWith(m)) return row.label;
	}
	return t;
}

function parseFields(block: string): Record<string, string> {
	const normalized = normalizeMultiLineLabels(block);
	const lines = normalized.split(/\r?\n/);
	const matches: Array<{ lineIdx: number; label: string; first: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const m = LABEL_LINE_RE.exec(lines[i] || '');
		if (!m) continue;
		matches.push({ lineIdx: i, label: canonLabel(m[1]), first: (m[2] || '').trim() });
	}
	const fields: Record<string, string> = {};
	for (let j = 0; j < matches.length; j++) {
		const cur = matches[j]!;
		const endLine = j + 1 < matches.length ? matches[j + 1]!.lineIdx : lines.length;
		const parts: string[] = [];
		if (cur.first) parts.push(cur.first);
		for (let k = cur.lineIdx + 1; k < endLine; k++) {
			const t = (lines[k] || '').trim();
			if (!t) continue;
			if (/^(Customer Complaint Information|Disclosure\s+\d+\s+of|i)$/i.test(t)) continue;
			parts.push(t);
		}
		let val = parts.join(' ').replace(/\s+/g, ' ').trim();
		val = val.replace(/^(Allegations|Status|Resolution):\s*/i, '').trim();
		// Drop leftover page chrome that survived stripFooters
		val = val
			.replace(/(?:©|\uFFFD)?\s*20\d{2}\s+FINRA\.\s+All rights reserved\.[\s\S]*$/i, '')
			.replace(/\bReport about\b[\s\S]*$/i, '')
			.replace(/\bwww\.finra\.org\/brokercheck\b[\s\S]*$/i, '')
			.replace(/\bUser Guidance\b[\s\S]*$/i, '')
			.replace(/\bEnd of Report\b[\s\S]*$/i, '')
			.trim();
		if (!val || val === 'Amount:') continue;
		if (cur.label === 'Relief Awarded') {
			val = val.replace(/\s*There may be a non-monetary award[\s\S]*$/i, '').trim();
		}
		if (fields[cur.label]) continue; // first reporting source wins
		fields[cur.label] = val;
	}
	return fields;
}

function disclosureTypeFromHeader(header: string): string {
	const h = header.trim();
	if (/^Customer Dispute/i.test(h)) return 'Customer Dispute';
	if (/^Regulatory/i.test(h)) return 'Regulatory Event';
	if (/^Civil/i.test(h)) return 'Civil Event';
	if (/^Criminal/i.test(h)) return 'Criminal';
	if (/^Arbitration/i.test(h)) return 'Arbitration';
	if (/^Bond/i.test(h)) return 'Bond';
	if (/^Judgment/i.test(h)) return 'Judgment/Lien';
	if (/^Financial/i.test(h)) return 'Financial';
	if (/^Employment Separation/i.test(h)) return 'Employment Separation';
	return h.split('-')[0]?.trim() || 'Disclosure';
}

function resolutionFrom(header: string, fields: Record<string, string>): string | null {
	const fromField =
		fields.Resolution || fields.Disposition || fields.Status || fields['Current Status'] || null;
	if (fromField) return fromField;
	const dash = header.indexOf('-');
	if (dash >= 0) {
		const tail = header.slice(dash + 1).trim();
		if (tail && !/^Award\b/i.test(tail)) return tail;
	}
	return null;
}

function eventDateFrom(fields: Record<string, string>): string | null {
	return (
		fields['Complaint Received'] ||
		fields['Date Initiated'] ||
		fields['Case Initiated'] ||
		fields['Resolution Date'] ||
		fields['Disposition Date'] ||
		fields['Status Date'] ||
		null
	);
}

const PRIORITY_FIELD_ORDER = [
	'Allegations',
	'Employing Firm',
	'Product Type',
	'Other Product Type',
	'Alleged Damages',
	'Settlement Amount',
	'Relief Requested',
	'Relief Awarded',
	'Individual Contribution',
	'Sanctions Ordered',
	'Sanction Details',
	'Initiated By',
	'Docket/Case Number',
	'Case Number',
	'Arbitration Forum',
	'Complaint Received',
	'Date Initiated',
	'Case Initiated',
	'Resolution Date',
	'Disposition Date',
	'Status Date',
	'Broker Statement',
	'Firm Statement',
	'Regulatory Action URL',
	'Reporting Source',
];

function fieldsToList(fields: Record<string, string>): FinraDisclosureDetailField[] {
	const skip = new Set(['Resolution', 'Disposition', 'Status', 'Current Status', 'Type of Event']);
	const out: FinraDisclosureDetailField[] = [];
	const seen = new Set<string>();
	for (const key of PRIORITY_FIELD_ORDER) {
		const v = fields[key];
		if (!v || skip.has(key)) continue;
		out.push({ label: key, value: v });
		seen.add(key);
	}
	for (const [k, v] of Object.entries(fields)) {
		if (seen.has(k) || skip.has(k) || !v) continue;
		out.push({ label: k, value: v });
	}
	return out;
}

export function parseBrokercheckDisclosureText(text: string): FinraDisclosureEvent[] {
	const cleaned = stripFooters(text);
	const detailsIdx = cleaned.search(/Disclosure Event Details/i);
	const body = detailsIdx >= 0 ? cleaned.slice(detailsIdx) : cleaned;
	const lines = body.split(/\r?\n/);

	type Block = { typeHeader: string; body: string };
	const blocks: Block[] = [];
	let curType = 'Disclosure';
	let curLines: string[] | null = null;

	const flush = () => {
		if (curLines && curLines.length) {
			blocks.push({ typeHeader: curType, body: curLines.join('\n') });
		}
		curLines = null;
	};

	for (const ln of lines) {
		const typeMatch = TYPE_HEADER_RE.exec(ln);
		if (typeMatch) {
			flush();
			curType = typeMatch[1]!.trim();
			curLines = null;
			continue;
		}
		const arbMatch = ARB_HEADER_RE.exec(ln);
		if (arbMatch && !/arbitration claims filed against|arbitration awards involving|full text of arbitration/i.test(ln)) {
			flush();
			curType = arbMatch[1]!.trim();
			curLines = null;
			continue;
		}
		if (DISCLOSURE_N_RE.test(ln)) {
			flush();
			curLines = [ln];
			continue;
		}
		if (curLines) curLines.push(ln);
	}
	flush();

	const events: FinraDisclosureEvent[] = [];
	for (const block of blocks) {
		const fields = parseFields(block.body);
		if (!Object.keys(fields).length) continue;
		// Skip empty prose-only leftovers
		if (!fields.Allegations && !fields['Settlement Amount'] && !fields['Relief Awarded'] && !fields['Docket/Case Number'] && !fields['Case Number'] && !fields['Sanction Details']) {
			continue;
		}
		events.push({
			eventDate: eventDateFrom(fields),
			disclosureType: disclosureTypeFromHeader(block.typeHeader),
			resolution: resolutionFrom(block.typeHeader, fields),
			sources: ['finra'],
			fields: fieldsToList(fields),
		});
	}
	return events;
}

async function downloadPdf(url: string): Promise<Buffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: 'application/pdf,*/*',
				'User-Agent': 'ai-research-tool/brokercheck-pdf',
				Referer: 'https://brokercheck.finra.org/',
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} fetching BrokerCheck PDF`);
		const ab = await res.arrayBuffer();
		if (ab.byteLength > PDF_MAX_BYTES) throw new Error(`BrokerCheck PDF too large (${ab.byteLength} bytes)`);
		return Buffer.from(ab);
	} finally {
		clearTimeout(timer);
	}
}

export type BrokercheckPdfDisclosureResult = {
	ok: boolean;
	pdfUrl: string;
	fromCache: boolean;
	events: FinraDisclosureEvent[];
	error?: string;
};

export async function loadBrokercheckPdfDisclosures(input: {
	crd: string;
	crdKind: 'individual' | 'firm';
	forceRefresh?: boolean;
}): Promise<BrokercheckPdfDisclosureResult> {
	const crd = String(input.crd || '').replace(/\D/g, '');
	const crdKind = input.crdKind;
	const url = pdfUrl(crdKind, crd);
	if (!crd) return { ok: false, pdfUrl: url, fromCache: false, events: [], error: 'missing crd' };

	ensureDirs(crdKind);
	const pdfPath = path.join(PDF_ROOT, crdKind, `${crd}.pdf`);
	const txtPath = path.join(PDF_ROOT, crdKind, `${crd}.txt`);

	try {
		let fromCache = false;
		let text: string | null = null;

		if (!input.forceRefresh && fs.existsSync(txtPath)) {
			const st = fs.statSync(txtPath);
			// Reuse extracted text for 30 days
			if (Date.now() - st.mtimeMs < 30 * 24 * 60 * 60 * 1000) {
				text = fs.readFileSync(txtPath, 'utf8');
				fromCache = true;
			}
		}

		if (text == null) {
			let buf: Buffer;
			if (!input.forceRefresh && fs.existsSync(pdfPath)) {
				buf = fs.readFileSync(pdfPath);
				fromCache = true;
			} else {
				buf = await downloadPdf(url);
				fs.writeFileSync(pdfPath, buf);
				fromCache = false;
			}
			text = extractPdfText(buf);
			fs.writeFileSync(txtPath, text, 'utf8');
		}

		const events = parseBrokercheckDisclosureText(text);
		return { ok: true, pdfUrl: url, fromCache, events };
	} catch (err) {
		return {
			ok: false,
			pdfUrl: url,
			fromCache: false,
			events: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * True when API events are missing allegation text or are thin enough that the
 * BrokerCheck PDF can add employing firm / product / sanction detail.
 */
export function eventsNeedPdfEnrichment(events: FinraDisclosureEvent[]): boolean {
	if (!events.length) return true;
	return events.some((e) => {
		const hasAlleg = e.fields.some((f) => /allegation/i.test(f.label) && f.value.trim().length > 20);
		const hasEmploying = e.fields.some((f) => /employing firm/i.test(f.label));
		const hasSanction = e.fields.some((f) => /sanction|relief awarded|settlement amount/i.test(f.label));
		const fieldCount = e.fields.length;
		return !hasAlleg || fieldCount < 4 || (!hasEmploying && !hasSanction);
	});
}
