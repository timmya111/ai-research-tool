import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOllamaBaseUrl } from '@/lib/research/ollama';
import { getOcrModelCandidates } from '@/lib/research/ollamaVision';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { normalizeIsoDate, normalizeText, sha256Key, stripLegalSuffixes } from '@/lib/research/profiles/normalize';
import {
	findExistingProfileDuplicate,
	getProfile,
	touchProfilesForUserAction,
	upsertProfile,
	upsertProfileLink,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import type { ProfileRelationType, ProfileType } from '@/lib/research/profiles/types';

export type RelationshipEdgeType =
	| 'REPRESENTS_CREDITOR_OR_DEBT_BUYER'
	| 'CO_DEFENDANT_IN_LITIGATION'
	| 'GARNISHMENT_COUNTERPARTY_EMPLOYER'
	| 'GARNISHMENT_COUNTERPARTY_BANK'
	| 'CO_COUNSEL_IN_LITIGATION'
	| 'AMICUS_CURIAE_IN_LITIGATION'
	| 'CFPB_COMPLAINT_LINKED_STATE';

export interface FirmRelationshipEdge {
	sourceFirm: string;
	targetEntity: string;
	targetType: 'debt_buyer' | 'bank' | 'employer' | 'payroll_processor' | 'other';
	edgeType: RelationshipEdgeType;
	jurisdiction: 'OK' | 'TX' | 'FEDERAL' | 'OTHER';
	courtOrSource: string;
	caseOrRecordId?: string;
	evidenceSummary: string;
}

export type LegalDocSource = 'cfpb' | 'govinfo' | 'oscn' | 'courtlistener';

export type IngestedLegalDoc = {
	id: string;
	source: LegalDocSource;
	profileId: string;
	profileSlug: string;
	title: string;
	courtOrSource: string;
	caseOrRecordId: string;
	dateIssued: string | null;
	jurisdiction: 'OK' | 'TX' | 'FEDERAL' | 'OTHER';
	sourceUrl: string;
	pdfUrl: string | null;
	pdfPath: string | null;
	ocrJsonPath: string;
	extractionMethod: 'json' | 'html' | 'pdftotext' | 'pdftotext+vision-ocr' | 'vision-ocr' | 'metadata_only';
	ocrModel: string | null;
	pagesOcr: number;
	textChars: number;
	textExcerpt: string;
	edges: FirmRelationshipEdge[];
	fetchedAt: string;
	/** Set when this document was originally fetched for another profile and cross-matched by name/edge. */
	matchedVia?: string | null;
};

export type LegalDocsIngestionReport = {
	ok: true;
	profileId: string;
	profileSlug: string;
	profileName: string;
	query: string;
	sources: Record<
		LegalDocSource,
		{
			status: 'ok' | 'skipped' | 'auth_required' | 'error';
			recordsFound: number;
			docsDownloaded: number;
			docsOcrd: number;
			note?: string;
		}
	>;
	cfpbSummary: {
		totalMatching: number;
		byState: Record<string, number>;
		topIssues: Array<{ issue: string; count: number }>;
		narrativesFound: number;
	} | null;
	documents: IngestedLegalDoc[];
	edges: FirmRelationshipEdge[];
	profileSync: {
		sourceRecordsUpserted: number;
		timelineEntriesUpserted: number;
		linksUpserted: number;
	};
};

const LEGAL_DOCS_ROOT = path.join(process.cwd(), '.data', 'legal-docs');
const PDFS_DIR = path.join(LEGAL_DOCS_ROOT, 'pdfs');
const OCR_DIR = path.join(LEGAL_DOCS_ROOT, 'ocr');
const MANIFEST_DIR = path.join(LEGAL_DOCS_ROOT, 'manifests');

const USER_AGENT = 'ai-research-tool/1.0 (local-first legal research)';

function ensureDirs(): void {
	fs.mkdirSync(PDFS_DIR, { recursive: true });
	fs.mkdirSync(OCR_DIR, { recursive: true });
	fs.mkdirSync(MANIFEST_DIR, { recursive: true });
}

function safeFileSlug(raw: string): string {
	return String(raw || '')
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 96) || 'doc';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPdfToText(pdfPath: string): { ok: boolean; text: string; error?: string } {
	const res = spawnSync('pdftotext', ['-layout', '-nopgbrk', pdfPath, '-'], {
		encoding: 'utf8',
		maxBuffer: 25 * 1024 * 1024,
		timeout: 30_000,
	});
	if (res.status !== 0 || res.error) {
		return { ok: false, text: '', error: String(res.stderr || res.error || 'pdftotext failed') };
	}
	const text = String(res.stdout || '')
		.replace(/\uFFFD/g, ' ')
		.replace(/\r\n/g, '\n')
		.trim();
	return { ok: true, text };
}

async function pickInstalledVisionModel(): Promise<string | null> {
	try {
		const baseUrl = getOllamaBaseUrl();
		const res = await fetch(`${baseUrl}/api/tags`, {
			cache: 'no-store',
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { models?: Array<{ name?: string }> };
		const installed = (data.models || []).map((m) => String(m.name || '')).filter(Boolean);
		const set = new Set(installed);
		for (const c of getOcrModelCandidates()) {
			if (set.has(c)) return c;
			const base = c.split(':')[0];
			const hit = installed.find((m) => m === c || m.startsWith(`${base}:`));
			if (hit) return hit;
		}
		return null;
	} catch {
		return null;
	}
}

async function ocrImageWithOllama(imagePath: string, model: string): Promise<string> {
	const b64 = fs.readFileSync(imagePath).toString('base64');
	const baseUrl = getOllamaBaseUrl();
	const res = await fetch(`${baseUrl}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			stream: false,
			messages: [
				{
					role: 'user',
					content:
						'Transcribe all readable text from this court document page verbatim, preserving case caption, docket numbers, party names, counsel names, dates, and dollar amounts. Return plain text only.',
					images: [b64],
				},
			],
			options: { num_predict: 2048 },
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!res.ok) return '';
	const data = (await res.json()) as { message?: { content?: string } };
	return String(data.message?.content || '').trim();
}

/**
 * Extract text from a downloaded PDF using pdftotext first, then automatically fall back
 * to rasterizing pages with pdftoppm + local Ollama Vision OCR when the PDF is scanned/thin.
 */
export async function extractAndOcrPdf(
	pdfPath: string,
	opts?: { maxOcrPages?: number; forceVisionOcr?: boolean },
): Promise<{
	text: string;
	method: 'pdftotext' | 'pdftotext+vision-ocr' | 'vision-ocr';
	pagesOcr: number;
	ocrModel: string | null;
}> {
	const maxOcrPages = Math.max(1, Math.min(8, Number(opts?.maxOcrPages || 4)));
	const ptt = runPdfToText(pdfPath);
	const baseText = ptt.ok ? ptt.text : '';
	const needsVision = Boolean(opts?.forceVisionOcr) || baseText.replace(/\s+/g, '').length < 220;

	if (!needsVision) {
		return { text: baseText, method: 'pdftotext', pagesOcr: 0, ocrModel: null };
	}

	const model = await pickInstalledVisionModel();
	if (!model) {
		return { text: baseText, method: 'pdftotext', pagesOcr: 0, ocrModel: null };
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-ocr-'));
	try {
		const prefix = path.join(tmpDir, 'page');
		const ppm = spawnSync(
			'pdftoppm',
			['-png', '-r', '170', '-f', '1', '-l', String(maxOcrPages), pdfPath, prefix],
			{ encoding: 'utf8', timeout: 45_000 },
		);
		if (ppm.status !== 0) {
			return { text: baseText, method: 'pdftotext', pagesOcr: 0, ocrModel: null };
		}
		const pageFiles = fs
			.readdirSync(tmpDir)
			.filter((f) => f.endsWith('.png'))
			.sort()
			.map((f) => path.join(tmpDir, f));
		const ocrParts: string[] = [];
		for (const pf of pageFiles) {
			const pageText = await ocrImageWithOllama(pf, model);
			if (pageText) ocrParts.push(pageText);
		}
		const ocrCombined = ocrParts.join('\n\n--- PAGE BREAK ---\n\n').trim();
		if (ocrCombined.length > baseText.length) {
			return {
				text: baseText ? `${baseText}\n\n[Vision OCR]\n${ocrCombined}` : ocrCombined,
				method: baseText ? 'pdftotext+vision-ocr' : 'vision-ocr',
				pagesOcr: pageFiles.length,
				ocrModel: model,
			};
		}
		return { text: baseText, method: 'pdftotext', pagesOcr: pageFiles.length, ocrModel: model };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function classifyEntityKind(
	name: string,
	contextText: string,
): 'debt_buyer' | 'bank' | 'employer' | 'payroll_processor' | 'other' {
	const low = name.toLowerCase();
	if (/\b(?:adp|automatic data processing|paychex|paycom|workday|ceridian|gusto|ultipro)\b/.test(low)) {
		return 'payroll_processor';
	}
	if (
		/\b(?:bank|bancorp|credit union|capital one|synchrony|chase|jpmorgan|citibank|wells fargo|discover|barclays|american express)\b/.test(
			low,
		)
	) {
		return 'bank';
	}
	if (
		/\b(?:cavalry|midland|lvnv|resurgent|atlantic credit|unifund|asset acceptance|portfolio recovery|world wide asset|encore capital|sherman|jefferson capital|lending|funding|receivables|recovery|credit\s+management)\b/.test(
			low,
		)
	) {
		return 'debt_buyer';
	}
	if (/\b(?:garnishee|employer|wage garnishment)\b/i.test(contextText)) {
		return 'employer';
	}
	return 'other';
}

function inferJurisdiction(text: string): 'OK' | 'TX' | 'FEDERAL' | 'OTHER' {
	const low = text.toLowerCase();
	if (/\b(?:western district of oklahoma|northern district of oklahoma|eastern district of oklahoma|okwd|oknd|oked|state of oklahoma|oklahoma county|tulsa county|bryan county|oscn)\b/.test(low)) {
		return 'OK';
	}
	if (/\b(?:northern district of texas|eastern district of texas|southern district of texas|western district of texas|txnd|txed|txsd|txwd|state of texas|dallas county|tarrant county|harris county)\b/.test(low)) {
		return 'TX';
	}
	if (/\b(?:united states district court|u\.s\. district court|u\.s\. court of appeals|tenth circuit|fifth circuit|uscourts)\b/.test(low)) {
		return 'FEDERAL';
	}
	return 'OTHER';
}

const KNOWN_COUNTERPARTIES_RE: Array<{
	re: RegExp;
	canonical: string;
	type: FirmRelationshipEdge['targetType'];
}> = [
	{ re: /\bCavalry\s+SPV(?:,?\s*|\s+)I\.?(?:,\s*|\s+)LLC\b/i, canonical: 'Cavalry SPV I, LLC', type: 'debt_buyer' },
	{ re: /\bMidland\s+Funding(?:,\s*|\s+)LLC\b/i, canonical: 'Midland Funding LLC', type: 'debt_buyer' },
	{ re: /\bMidland\s+Credit\s+Management\b/i, canonical: 'Midland Credit Management, Inc.', type: 'debt_buyer' },
	{ re: /\bAtlantic\s+Credit\s*(?:&|and)\s*Finance\b/i, canonical: 'Atlantic Credit & Finance Inc.', type: 'debt_buyer' },
	{ re: /\bLVNV\s+Funding(?:,\s*|\s+)LLC\b/i, canonical: 'LVNV Funding LLC', type: 'debt_buyer' },
	{ re: /\bResurgent\s+Capital\s+Services\b/i, canonical: 'Resurgent Capital Services LP', type: 'debt_buyer' },
	{ re: /\bAsset\s+Acceptance(?:,\s*|\s+)L\.?L\.?C\.?\b/i, canonical: 'Asset Acceptance, LLC', type: 'debt_buyer' },
	{ re: /\bPortfolio\s+Recovery\s+Associates\b/i, canonical: 'Portfolio Recovery Associates, LLC', type: 'debt_buyer' },
	{ re: /\bUnifund\s+CCR\b/i, canonical: 'Unifund CCR Partners', type: 'debt_buyer' },
	{ re: /\bWorld\s+Wide\s+Asset\s+Purchasing\b/i, canonical: 'World Wide Asset Purchasing', type: 'debt_buyer' },
	{ re: /\bCapital\s+One(?:\s+Bank|\s+Financial)?\b/i, canonical: 'CAPITAL ONE FINANCIAL CORPORATION', type: 'bank' },
	{ re: /\bSynchrony\s+Bank\b/i, canonical: 'Synchrony Bank', type: 'bank' },
	{ re: /\bJ\.?P\.?\s*Morgan\s+Chase(?:\s+Bank(?:,?\s*N\.?A\.?)?)?\b/i, canonical: 'JPMorgan Chase & Co.', type: 'bank' },
	{ re: /\bBank\s+of\s+America(?:,?\s*N\.?A\.?)?\b/i, canonical: 'BANK OF AMERICA, NATIONAL ASSOCIATION', type: 'bank' },
	{ re: /\bWells\s+Fargo\s+Bank(?:,?\s*N\.?A\.?)?\b/i, canonical: 'WELLS FARGO BANK, N.A.', type: 'bank' },
	{ re: /\bFord\s+Motor\s+Credit(?:\s+Company(?:,?\s*LLC)?)?\b/i, canonical: 'FORD MOTOR CREDIT COMPANY', type: 'debt_buyer' },
	{ re: /\bGMAC(?:,?\s*LLC)\b/i, canonical: 'GMAC, LLC', type: 'debt_buyer' },
	{ re: /\bToyota\s+Motor\s+Credit(?:\s+Corporation)?\b/i, canonical: 'Toyota Motor Credit Corporation', type: 'debt_buyer' },
	{ re: /\bNuvell\s+Credit\s+Company(?:\s+LLC)?\b/i, canonical: 'Nuvell Credit Company LLC', type: 'debt_buyer' },
	{ re: /\bNuvell\s+National\s+Auto\s+Finance(?:\s+LLC)?\b/i, canonical: 'Nuvell National Auto Finance LLC', type: 'debt_buyer' },
	{ re: /\b(?:American\s+)?Suzuki\s+Financial\s+Services(?:\s+Company)?(?:\s+LLC)?\b/i, canonical: 'American Suzuki Financial Services Company LLC', type: 'debt_buyer' },
	{ re: /\bNissan\s+Motor\s+Acceptance(?:\s+Corp\.?)?\b/i, canonical: 'Nissan Motor Acceptance Corp.', type: 'debt_buyer' },
	{ re: /\bAmerican\s+Honda\s+Finance(?:\s+Corporation)?\b/i, canonical: 'American Honda Finance Corporation', type: 'debt_buyer' },
	{ re: /\bAmeriCredit\s+Financial(?:,\s*|\s+)Services(?:,?\s*Inc\.?)?\b/i, canonical: 'AmeriCredit Financial Services, Inc.', type: 'debt_buyer' },
	{ re: /\bCrowe\s*(?:&|and)\s*Dunlevy\b/i, canonical: 'Crowe & Dunlevy', type: 'other' },
	{ re: /\bSooner\s+State\s+Bank\b/i, canonical: 'Sooner State Bank', type: 'bank' },
	{ re: /\bGriffin\s+Communications(?:\s+L\.?\s*L\.?\s*C\.?)?\b/i, canonical: 'Griffin Communications, L.L.C.', type: 'other' },
	{ re: /\bNYT\s+Broadcasting(?:\s+LLC)?\b/i, canonical: 'NYT Broadcasting LLC', type: 'other' },
	{ re: /\bCitibank\b/i, canonical: 'Citibank, N.A.', type: 'bank' },
	{ re: /\bDiscover\s+Bank\b/i, canonical: 'Discover Bank', type: 'bank' },
	{ re: /\bBest\s+Buy\s+Co\.?(?:,?\s*Inc\.?)?\b/i, canonical: 'Best Buy Co., Inc.', type: 'employer' },
	{ re: /\bADP,?\s+LLC\b|\bAutomatic\s+Data\s+Processing\b/i, canonical: 'ADP, LLC', type: 'payroll_processor' },
];

function cleanDocInlineText(raw: string): string {
	return String(raw || '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Extract a concise, human-readable context excerpt around a matched entity in court OCR text,
 * and detect whether the match occurs in an Amicus Curiae block, Co-Counsel line, or pure case citation.
 */
function analyzeOcrEntityContext(
	fullText: string,
	re: RegExp,
): {
	matched: boolean;
	excerpt: string;
	isAmicus: boolean;
	isCoCounsel: boolean;
	isCitationOnly: boolean;
} {
	const clean = cleanDocInlineText(fullText);
	const m = re.exec(clean);
	if (!m || m.index == null) {
		return { matched: false, excerpt: '', isAmicus: false, isCoCounsel: false, isCitationOnly: false };
	}
	const idx = m.index;
	const hitLen = m[0].length;
	const before = clean.slice(Math.max(0, idx - 260), idx);
	const after = clean.slice(idx + hitLen, Math.min(clean.length, idx + hitLen + 750));
	const windowText = `${before}${m[0]}${after}`;

	const amicusPos = after.search(/\bAmicus\s+Curiae\b/i);
	const isAmicus =
		amicusPos !== -1 &&
		!/\b(?:Appellant|Appellee|Plaintiff|Defendant)\b/i.test(after.slice(0, amicusPos));
	const isCoCounsel =
		/\bappearing\s+for\s+(?:Appellant|Appellee|Plaintiff|Defendant)\b/i.test(after.slice(0, 140)) &&
		/\b(?:P\.C\.|LLP|PLLC|Crowe|Law|Attorneys?)\b/i.test(windowText);
	// Detect pure precedent citations such as "see also Capital One Auto Fin. v. Osborn, 515 F.3d 817"
	// or "See, e.g., Wright v. Santander Consumer USA Inc., No. 07-1483, 2007 WL 1892502"
	const nearBefore = clean.slice(Math.max(0, idx - 60), idx);
	const nearAfter = clean.slice(idx + hitLen, Math.min(clean.length, idx + hitLen + 100));
	const isCitationOnly =
		!isAmicus &&
		!isCoCounsel &&
		(/\b(?:see\s+also|see,?\s+e\.g\.|accord|cf\.|citing)\b/i.test(nearBefore) ||
			/\b\d+\s+(?:F\.3d|F\.2d|F\.\s*Supp|B\.R\.|U\.S\.|WL\s+\d+)\b/i.test(nearAfter));

	// Build a clean sentence-ish excerpt around the match
	const rawSlice = clean.slice(Math.max(0, idx - 90), Math.min(clean.length, idx + hitLen + 150)).trim();
	const excerpt = rawSlice.replace(/^\S+\s+/, (lead) => (idx > 90 ? `…${lead}` : lead)).slice(0, 220);
	return { matched: true, excerpt, isAmicus, isCoCounsel, isCitationOnly };
}

/**
 * Extract typed FirmRelationshipEdge records from an OCR'd/extracted court document or docket caption.
 */
export function extractEdgesFromCourtDocument(input: {
	sourceFirm: string;
	title: string;
	text: string;
	courtOrSource: string;
	caseOrRecordId: string;
	jurisdiction: FirmRelationshipEdge['jurisdiction'];
}): FirmRelationshipEdge[] {
	const edges: FirmRelationshipEdge[] = [];
	const seen = new Set<string>();
	const cleanTitle = cleanDocInlineText(input.title);
	const full = `${cleanTitle}\n${input.text}`;
	const low = full.toLowerCase();
	const sourceFirmNorm = normalizeText(input.sourceFirm);
	const isGarnishmentDoc = /\b(?:garnish(?:ee|ment)|wage\s+withholding|continuing\s+garnishment|payroll)\b/i.test(full);
	const isFdcpaCoDef =
		(/\b(?:fdcpa|fair\s+debt\s+collection\s+practices\s+act|co-defendant|defendants?)\b/i.test(full) ||
			/\bDefendant,\s+and\b/i.test(full)) &&
		/\bv\.?\s+/i.test(cleanTitle) &&
		!/^\s*love,?\s+beal/i.test(cleanTitle);

	const pushEdge = (
		rawTargetEntity: string,
		targetType: FirmRelationshipEdge['targetType'],
		edgeType: RelationshipEdgeType,
		evidenceSummary: string,
	) => {
		const targetEntity = cleanDocInlineText(rawTargetEntity)
			.replace(/\bSvcs\.?\b/g, 'Services')
			.replace(/\bServ\.?\b/g, 'Services')
			.replace(/[,;:\s]+$/g, '')
			.trim();
		const targetNorm = normalizeText(targetEntity);
		if (!targetNorm || targetNorm === sourceFirmNorm) return;
		const k = `${targetNorm}|${edgeType}|${input.caseOrRecordId}`;
		if (seen.has(k)) return;
		if (
			sourceFirmNorm.includes('love beal') &&
			(targetEntity.toLowerCase().includes('love, beal') || targetEntity.toLowerCase().includes('love beal'))
		) {
			return;
		}
		seen.add(k);
		edges.push({
			sourceFirm: input.sourceFirm,
			targetEntity,
			targetType,
			edgeType,
			jurisdiction: input.jurisdiction,
			courtOrSource: input.courtOrSource,
			caseOrRecordId: input.caseOrRecordId,
			evidenceSummary: cleanDocInlineText(evidenceSummary).slice(0, 340),
		});
	};

	// 1. Known counterparty entities mentioned in the caption or OCR text
	for (const known of KNOWN_COUNTERPARTIES_RE) {
		const ctx = analyzeOcrEntityContext(full, known.re);
		if (!ctx.matched) continue;
		// Skip pure precedent citations (e.g. "see also Capital One Auto Fin. v. Osborn, 515 F.3d 817")
		if (ctx.isCitationOnly) continue;

		let edgeType: RelationshipEdgeType = 'REPRESENTS_CREDITOR_OR_DEBT_BUYER';
		let detailDesc = `${cleanTitle} (${input.caseOrRecordId}, ${input.courtOrSource}) — "${ctx.excerpt}"`;
		if (ctx.isAmicus) {
			edgeType = 'AMICUS_CURIAE_IN_LITIGATION';
			detailDesc = `Amicus Curiae in ${cleanTitle} (${input.caseOrRecordId}, ${input.courtOrSource}).`;
		} else if (ctx.isCoCounsel) {
			edgeType = 'CO_COUNSEL_IN_LITIGATION';
			detailDesc = `Co-counsel in ${cleanTitle} (${input.caseOrRecordId}, ${input.courtOrSource}) — "${ctx.excerpt}"`;
		} else if (known.type === 'payroll_processor' || (known.type === 'employer' && isGarnishmentDoc)) {
			edgeType = 'GARNISHMENT_COUNTERPARTY_EMPLOYER';
		} else if (known.type === 'bank' && isGarnishmentDoc && !/\bplaintiff\b/i.test(low.slice(0, 400))) {
			edgeType = 'GARNISHMENT_COUNTERPARTY_BANK';
		} else if (isFdcpaCoDef && (known.type === 'debt_buyer' || known.type === 'bank' || known.type === 'other')) {
			edgeType = 'CO_DEFENDANT_IN_LITIGATION';
		}
		pushEdge(known.canonical, known.type, edgeType, detailDesc);
	}

	// 2. Also extract corporate co-party from "X v. Y" case caption when it ends with LLC/Inc/Corp/Bank/LP
	const captionM = cleanTitle.match(/^(.+?)\s+v\.?\s+(.+)$/i);
	if (captionM) {
		for (const side of [captionM[1]!, captionM[2]!]) {
			const cleaned = side.replace(/\bet\s+al\.?$/i, '').replace(/,\s*and$/i, '').trim();
			if (
				cleaned.length >= 4 &&
				cleaned.length <= 75 &&
				/\b(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|Bank|L\.P\.|LP|Partners|Funding|Financial|Recovery|Credit|Broadcasting|Communications)\b/i.test(cleaned) &&
				!/love,?\s+beal/i.test(cleaned)
			) {
				const kind = classifyEntityKind(cleaned, full);
				const edgeType: RelationshipEdgeType =
					kind === 'payroll_processor' || (kind === 'employer' && isGarnishmentDoc)
						? 'GARNISHMENT_COUNTERPARTY_EMPLOYER'
						: kind === 'bank' && isGarnishmentDoc
							? 'GARNISHMENT_COUNTERPARTY_BANK'
							: isFdcpaCoDef
								? 'CO_DEFENDANT_IN_LITIGATION'
								: 'REPRESENTS_CREDITOR_OR_DEBT_BUYER';
				pushEdge(
					cleaned,
					kind,
					edgeType,
					`Named party in ${cleanTitle} (${input.caseOrRecordId}, ${input.courtOrSource}).`,
				);
			}
		}
	}

	return edges;
}

const CFPB_COMPANIES_CACHE_PATH = path.join(LEGAL_DOCS_ROOT, 'cfpb-companies.json');
let cfpbCompanyIndex: Map<string, Array<{ key: string; docCount: number }>> | null = null;

function canonicalCfpbKey(raw: string): string {
	const cleaned = String(raw || '')
		.replace(/\s*\([^)]*\)\s*/g, ' ')
		.trim();
	let norm = normalizeText(cleaned).replace(/^the\s+/, '');
	const stripped = stripLegalSuffixes(norm);
	return (stripped.length >= 4 ? stripped : norm).trim();
}

async function getCfpbCompanyIndex(): Promise<Map<string, Array<{ key: string; docCount: number }>>> {
	if (cfpbCompanyIndex) return cfpbCompanyIndex;
	ensureDirs();
	let buckets: Array<{ key: string; doc_count: number }> = [];
	if (fs.existsSync(CFPB_COMPANIES_CACHE_PATH)) {
		try {
			const stat = fs.statSync(CFPB_COMPANIES_CACHE_PATH);
			if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
				const parsed = JSON.parse(fs.readFileSync(CFPB_COMPANIES_CACHE_PATH, 'utf8')) as Array<{
					key: string;
					doc_count: number;
				}>;
				if (Array.isArray(parsed) && parsed.length > 500) buckets = parsed;
			}
		} catch {
			/* ignore stale cache */
		}
	}
	if (buckets.length === 0) {
		const res = await fetch(
			'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?size=0',
			{ headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
		);
		if (res.ok) {
			const data = (await res.json()) as {
				aggregations?: { company?: { company?: { buckets?: Array<{ key: string; doc_count: number }> } } };
			};
			buckets = data.aggregations?.company?.company?.buckets || [];
			if (buckets.length > 0) {
				fs.writeFileSync(CFPB_COMPANIES_CACHE_PATH, JSON.stringify(buckets));
			}
		}
	}

	const map = new Map<string, Array<{ key: string; docCount: number }>>();
	const add = (k: string, item: { key: string; docCount: number }) => {
		if (!k || k.length < 3) return;
		let arr = map.get(k);
		if (!arr) {
			arr = [];
			map.set(k, arr);
		}
		if (!arr.some((x) => x.key === item.key)) arr.push(item);
	};
	for (const b of buckets) {
		const item = { key: String(b.key || ''), docCount: Number(b.doc_count || 0) };
		if (!item.key || item.docCount <= 0) continue;
		add(normalizeText(item.key), item);
		add(canonicalCfpbKey(item.key), item);
	}
	cfpbCompanyIndex = map;
	return map;
}

export async function matchProfileToCfpbCompanies(
	profileName: string,
	aliases: string[] = [],
): Promise<Array<{ key: string; docCount: number }>> {
	const index = await getCfpbCompanyIndex();
	const found = new Map<string, { key: string; docCount: number }>();
	const genericSingle = new Set([
		'american',
		'national',
		'united',
		'federal',
		'first',
		'general',
		'capital',
		'credit',
		'bank',
		'financial',
		'liberty',
		'heritage',
		'vanguard',
		'fidelity',
		'premier',
		'summit',
		'horizon',
		'alliance',
		'pacific',
		'atlantic',
		'southern',
		'northern',
		'western',
		'eastern',
		'central',
		'citizens',
		'republic',
		'standard',
		'frontier',
		'pioneer',
	]);
	for (const raw of [profileName, ...aliases]) {
		const clean = String(raw || '').trim();
		if (!clean || clean.length < 3) continue;
		const exact = normalizeText(clean);
		const canon = canonicalCfpbKey(clean);
		for (const k of [exact, canon]) {
			if (!k || k.length < 4) continue;
			if (!k.includes(' ') && genericSingle.has(k)) continue;
			const hits = index.get(k);
			if (!hits) continue;
			for (const h of hits) {
				// Prevent "The Boeing Company" matching "BOEING EMPLOYEES' CREDIT UNION"
				const hCanon = canonicalCfpbKey(h.key);
				if (hCanon === canon || normalizeText(h.key) === exact) {
					found.set(h.key, h);
				}
			}
		}
	}
	return [...found.values()].sort((a, b) => b.docCount - a.docCount).slice(0, 3);
}

/**
 * 1. CFPB Consumer Complaint Database Public API (no auth required).
 * Matches against CFPB's official 6,500-company dictionary and fetches exact state & issue
 * aggregations + latest complaints in a single HTTP request.
 */
async function fetchCfpbForProfile(input: {
	profileId: string;
	profileSlug: string;
	sourceFirm: string;
	query: string;
	aliases?: string[];
	states: string[];
	maxRecords: number;
}): Promise<{
	status: 'ok' | 'error';
	recordsFound: number;
	docs: IngestedLegalDoc[];
	edges: FirmRelationshipEdge[];
	summary: LegalDocsIngestionReport['cfpbSummary'];
	note?: string;
}> {
	try {
		const matchedCompanies = await matchProfileToCfpbCompanies(input.sourceFirm, [
			input.query,
			...(input.aliases || []),
		]);
		if (matchedCompanies.length === 0) {
			return {
				status: 'ok',
				recordsFound: 0,
				docs: [],
				edges: [],
				summary: null,
			};
		}

		const params = new URLSearchParams({
			size: String(Math.max(10, Math.min(40, input.maxRecords))),
			sort: 'created_date_desc',
		});
		for (const mc of matchedCompanies) {
			params.append('company', mc.key);
		}
		const url = `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?${params.toString()}`;
		const res = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			return {
				status: 'error',
				recordsFound: 0,
				docs: [],
				edges: [],
				summary: null,
				note: `CFPB API HTTP ${res.status}`,
			};
		}
		const data = (await res.json()) as {
			hits?: {
				total?: { value?: number };
				hits?: Array<{ _id?: string; _source?: Record<string, unknown> }>;
			};
			aggregations?: {
				state?: { state?: { buckets?: Array<{ key: string; doc_count: number }> } };
				issue?: { issue?: { buckets?: Array<{ key: string; doc_count: number }> } };
			};
		};
		const totalMatching = Number(data.hits?.total?.value || 0);
		if (totalMatching === 0) {
			return {
				status: 'ok',
				recordsFound: 0,
				docs: [],
				edges: [],
				summary: null,
			};
		}
		const hits = data.hits?.hits || [];
		const byState: Record<string, number> = {};
		for (const b of data.aggregations?.state?.state?.buckets || []) {
			if (b.key && b.doc_count > 0) byState[String(b.key).toUpperCase()] = Number(b.doc_count);
		}
		const topIssues = (data.aggregations?.issue?.issue?.buckets || [])
			.slice(0, 6)
			.map((b) => ({ issue: String(b.key), count: Number(b.doc_count) }));

		const narratives: Array<{ id: string; date: string; state: string; issue: string; text: string }> = [];
		for (const h of hits) {
			const s = h._source || {};
			const narr = String(s.complaint_what_happened || '').trim();
			if (narr) {
				narratives.push({
					id: String(s.complaint_id || h._id || ''),
					date: String(s.date_received || '').slice(0, 10),
					state: String(s.state || '?').toUpperCase(),
					issue: String(s.issue || ''),
					text: narr,
				});
			}
		}

		const edges: FirmRelationshipEdge[] = [];
		for (const st of input.states) {
			const stUp = st.toUpperCase();
			const stCount = byState[stUp] || 0;
			if (stCount > 0) {
				edges.push({
					sourceFirm: input.sourceFirm,
					targetEntity: `CFPB Complaints (${stUp})`,
					targetType: 'other',
					edgeType: 'CFPB_COMPLAINT_LINKED_STATE',
					jurisdiction: stUp === 'OK' || stUp === 'TX' ? stUp : 'OTHER',
					courtOrSource: 'CFPB Consumer Complaint Database API',
					caseOrRecordId: `cfpb-${stUp}-${safeFileSlug(input.profileSlug)}`,
					evidenceSummary: `${stCount.toLocaleString()} public CFPB consumer complaint(s) in ${stUp} for ${matchedCompanies.map((c) => c.key).join(' / ')}. Top issues: ${topIssues.slice(0, 3).map((x) => x.issue).join('; ')}.`,
				});
			}
		}

		const docId = `cfpb-${safeFileSlug(input.profileSlug)}`;
		const ocrJsonPath = path.join(OCR_DIR, `${docId}.json`);
		const topStatesStr = Object.entries(byState)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([k, v]) => `${k}: ${v.toLocaleString()}`)
			.join(', ');
		const lines = [
			`CFPB Consumer Complaint Database Summary — ${input.sourceFirm}`,
			`Matched CFPB Entity: ${matchedCompanies.map((c) => c.key).join('; ')}`,
			`Total matching complaints: ${totalMatching.toLocaleString()} (latest ${hits.length} sampled)`,
			`Top states: ${topStatesStr}`,
			`Top issues: ${topIssues.map((x) => `${x.issue} (${x.count.toLocaleString()})`).join('; ')}`,
			'',
			'Recent Complaints:',
			...hits.slice(0, 25).map((h) => {
				const s = h._source || {};
				return `- [${s.complaint_id}] ${String(s.date_received || '').slice(0, 10)} | ${s.state || '?'} | ${s.company || ''} | ${s.issue || ''}${s.sub_issue ? ` — ${s.sub_issue}` : ''} | Response: ${s.company_response || 'N/A'}`;
			}),
		];
		if (narratives.length > 0) {
			lines.push('', 'Public Narratives:');
			for (const n of narratives.slice(0, 10)) {
				lines.push(`- [${n.id}] (${n.date}, ${n.state}, ${n.issue}): ${n.text.slice(0, 500)}`);
			}
		}
		const fullText = lines.join('\n');
		const latestDate = hits[0]?._source?.date_received
			? String(hits[0]._source.date_received).slice(0, 10)
			: null;

		const doc: IngestedLegalDoc = {
			id: docId,
			source: 'cfpb',
			profileId: input.profileId,
			profileSlug: input.profileSlug,
			title: `CFPB Consumer Complaints — ${input.sourceFirm} (${totalMatching.toLocaleString()} total)`,
			courtOrSource: 'CFPB Consumer Complaint Database API',
			caseOrRecordId: docId,
			dateIssued: latestDate,
			jurisdiction: byState.OK ? 'OK' : byState.TX ? 'TX' : 'FEDERAL',
			sourceUrl: url,
			pdfUrl: null,
			pdfPath: null,
			ocrJsonPath,
			extractionMethod: 'json',
			ocrModel: null,
			pagesOcr: 0,
			textChars: fullText.length,
			textExcerpt: fullText.slice(0, 900),
			edges,
			fetchedAt: new Date().toISOString(),
		};
		fs.writeFileSync(ocrJsonPath, JSON.stringify({ ...doc, fullText, rawHits: hits.slice(0, 25) }, null, 2));

		return {
			status: 'ok',
			recordsFound: totalMatching,
			docs: [doc],
			edges,
			summary: {
				totalMatching,
				byState,
				topIssues,
				narrativesFound: narratives.length,
			},
		};
	} catch (e: unknown) {
		return {
			status: 'error',
			recordsFound: 0,
			docs: [],
			edges: [],
			summary: null,
			note: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * 2. GovInfo USCOURTS Official Federal Court Opinions API (downloads real court PDFs & OCRs them).
 */
async function fetchGovInfoCourtDocs(input: {
	profileId: string;
	profileSlug: string;
	sourceFirm: string;
	query: string;
	maxDocs: number;
	downloadPdfs: boolean;
}): Promise<{
	status: 'ok' | 'error';
	recordsFound: number;
	docsDownloaded: number;
	docsOcrd: number;
	docs: IngestedLegalDoc[];
	edges: FirmRelationshipEdge[];
	note?: string;
}> {
	const apiKey = String(process.env.GOVINFO_API_KEY || 'DEMO_KEY').trim();
	const searchQuery = `"${input.query}" collection:USCOURTS`;
	try {
		const res = await fetch(`https://api.govinfo.gov/search?api_key=${encodeURIComponent(apiKey)}`, {
			method: 'POST',
			headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				query: searchQuery,
				pageSize: Math.max(1, Math.min(20, input.maxDocs)),
				offsetMark: '*',
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			return {
				status: 'error',
				recordsFound: 0,
				docsDownloaded: 0,
				docsOcrd: 0,
				docs: [],
				edges: [],
				note: `GovInfo API HTTP ${res.status}`,
			};
		}
		const data = (await res.json()) as {
			count?: number;
			results?: Array<{
				title?: string;
				packageId?: string;
				granuleId?: string;
				governmentAuthor?: string[];
				dateIssued?: string;
				download?: { pdfLink?: string; txtLink?: string };
			}>;
		};
		const results = data.results || [];
		const docs: IngestedLegalDoc[] = [];
		const allEdges: FirmRelationshipEdge[] = [];
		let docsDownloaded = 0;
		let docsOcrd = 0;

		for (const r of results.slice(0, input.maxDocs)) {
			const pkgId = String(r.granuleId || r.packageId || '').trim();
			if (!pkgId) continue;
			const title = String(r.title || pkgId).trim();
			const court = (r.governmentAuthor || []).join('; ') || 'U.S. Federal Court (GovInfo USCOURTS)';
			const dateIssued = r.dateIssued ? normalizeIsoDate(r.dateIssued).date : null;
			const pdfLinkBase = r.download?.pdfLink || null;
			const docId = `govinfo-${safeFileSlug(pkgId)}`;
			const pdfPath = path.join(PDFS_DIR, `${docId}.pdf`);
			const ocrJsonPath = path.join(OCR_DIR, `${docId}.json`);
			const publicSourceUrl = `https://www.govinfo.gov/app/details/${encodeURIComponent(String(r.packageId || pkgId))}`;

			let fullText = '';
			let method: IngestedLegalDoc['extractionMethod'] = 'metadata_only';
			let ocrModel: string | null = null;
			let pagesOcr = 0;
			let savedPdfPath: string | null = null;

			if (input.downloadPdfs && pdfLinkBase) {
				const alreadyHavePdf = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500;
				if (!alreadyHavePdf) {
					const sep = pdfLinkBase.includes('?') ? '&' : '?';
					const pdfRes = await fetch(`${pdfLinkBase}${sep}api_key=${encodeURIComponent(apiKey)}`, {
						headers: { 'User-Agent': USER_AGENT },
						signal: AbortSignal.timeout(25_000),
					});
					if (pdfRes.ok) {
						const buf = Buffer.from(await pdfRes.arrayBuffer());
						if (buf.length > 500 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
							fs.writeFileSync(pdfPath, buf);
							docsDownloaded += 1;
						}
					}
					await sleep(250);
				}
				if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500) {
					savedPdfPath = pdfPath;
					const extracted = await extractAndOcrPdf(pdfPath);
					fullText = extracted.text;
					method = extracted.method;
					ocrModel = extracted.ocrModel;
					pagesOcr = extracted.pagesOcr;
					if (fullText.length > 0) docsOcrd += 1;
				}
			}

			const jurisdiction = inferJurisdiction(`${court} ${pkgId} ${fullText.slice(0, 1500)}`);
			const edges = extractEdgesFromCourtDocument({
				sourceFirm: input.sourceFirm,
				title,
				text: fullText,
				courtOrSource: court,
				caseOrRecordId: pkgId,
				jurisdiction,
			});
			allEdges.push(...edges);

			const doc: IngestedLegalDoc = {
				id: docId,
				source: 'govinfo',
				profileId: input.profileId,
				profileSlug: input.profileSlug,
				title,
				courtOrSource: court,
				caseOrRecordId: pkgId,
				dateIssued,
				jurisdiction,
				sourceUrl: publicSourceUrl,
				pdfUrl: pdfLinkBase,
				pdfPath: savedPdfPath,
				ocrJsonPath,
				extractionMethod: method,
				ocrModel,
				pagesOcr,
				textChars: fullText.length,
				textExcerpt: fullText.slice(0, 1200),
				edges,
				fetchedAt: new Date().toISOString(),
			};
			fs.writeFileSync(ocrJsonPath, JSON.stringify({ ...doc, fullText }, null, 2));
			docs.push(doc);
		}

		return {
			status: 'ok',
			recordsFound: Number(data.count || results.length),
			docsDownloaded,
			docsOcrd,
			docs,
			edges: allEdges,
		};
	} catch (e: unknown) {
		return {
			status: 'error',
			recordsFound: 0,
			docsDownloaded: 0,
			docsOcrd: 0,
			docs: [],
			edges: [],
			note: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * 3. OSCN Oklahoma State Courts Network (polite public docket lookup + linked PDF OCR).
 */
async function fetchOscnDockets(input: {
	profileId: string;
	profileSlug: string;
	sourceFirm: string;
	query: string;
	counties: string[];
	maxCases: number;
	downloadPdfs: boolean;
}): Promise<{
	status: 'ok' | 'error';
	recordsFound: number;
	docsDownloaded: number;
	docsOcrd: number;
	docs: IngestedLegalDoc[];
	edges: FirmRelationshipEdge[];
	note?: string;
}> {
	const docs: IngestedLegalDoc[] = [];
	const allEdges: FirmRelationshipEdge[] = [];
	const seenCaseUrls = new Set<string>();
	let docsDownloaded = 0;
	let docsOcrd = 0;
	let recordsFound = 0;

	const cleanLname = input.query.replace(/[,&]+/g, ' ').replace(/\s+/g, ' ').trim();
	try {
		for (const county of input.counties.slice(0, 3)) {
			const searchUrl = `https://www.oscn.net/dockets/Results.aspx?db=${encodeURIComponent(county)}&lname=${encodeURIComponent(cleanLname)}`;
			const res = await fetch(searchUrl, {
				headers: { 'User-Agent': USER_AGENT },
				signal: AbortSignal.timeout(12_000),
			});
			if (!res.ok) continue;
			const html = await res.text();
			if (/human verification|captcha|access denied/i.test(html)) {
				return {
					status: 'error',
					recordsFound,
					docsDownloaded,
					docsOcrd,
					docs,
					edges: allEdges,
					note: 'OSCN returned verification gate — stopped without bypass.',
				};
			}

			const links = [
				...new Set(
					[...html.matchAll(/href="([^"]*GetCaseInformation\.aspx[^"]*)"/gi)].map((m) =>
						m[1]!.replace(/&amp;/g, '&'),
					),
				),
			];
			recordsFound += links.length;

			for (const rel of links.slice(0, input.maxCases)) {
				const absUrl = rel.startsWith('http') ? rel : `https://www.oscn.net/dockets/${rel.replace(/^\/+/, '')}`;
				if (seenCaseUrls.has(absUrl)) continue;
				seenCaseUrls.add(absUrl);
				await sleep(450);

				const caseRes = await fetch(absUrl, {
					headers: { 'User-Agent': USER_AGENT },
					signal: AbortSignal.timeout(12_000),
				});
				if (!caseRes.ok) continue;
				const caseHtml = await caseRes.text();
				const numM = absUrl.match(/number=([^&]+)/i);
				const caseNumber = numM ? decodeURIComponent(numM[1]!) : safeFileSlug(absUrl);
				const plainDocket = caseHtml
					.replace(/<script[\s\S]*?<\/script>/gi, ' ')
					.replace(/<style[\s\S]*?<\/style>/gi, ' ')
					.replace(/<\/(tr|p|div|h[1-6]|li)>/gi, '\n')
					.replace(/<[^>]+>/g, ' ')
					.replace(/&nbsp;/g, ' ')
					.replace(/&amp;/g, '&')
					.replace(/[ \t]+/g, ' ')
					.replace(/\n{3,}/g, '\n\n')
					.trim();

				const captionM = plainDocket.match(/([A-Z0-9][^\n]{4,100}\s+v\.?\s+[^\n]{4,100})/i);
				const title = captionM ? captionM[1]!.trim() : `OSCN ${county} ${caseNumber}`;
				const filedM = plainDocket.match(/Filed:\s*(\d{2}\/\d{2}\/\d{4})/i);
				const dateIssued = filedM ? normalizeIsoDate(filedM[1]!).date : null;

				// Check for linked public PDF documents on the docket sheet (GetDocument.aspx)
				const docPdfMatches = [...caseHtml.matchAll(/href="([^"]*GetDocument\.aspx[^"]*)"/gi)].map((m) =>
					m[1]!.replace(/&amp;/g, '&'),
				);
				let savedPdfPath: string | null = null;
				let pdfUrl: string | null = null;
				let method: IngestedLegalDoc['extractionMethod'] = 'html';
				let ocrModel: string | null = null;
				let pagesOcr = 0;
				let fullText = plainDocket;

				const docId = `oscn-${safeFileSlug(county)}-${safeFileSlug(caseNumber)}`;
				const ocrJsonPath = path.join(OCR_DIR, `${docId}.json`);

				if (input.downloadPdfs && docPdfMatches.length > 0) {
					const firstDocRel = docPdfMatches[0]!;
					pdfUrl = firstDocRel.startsWith('http')
						? firstDocRel
						: `https://www.oscn.net/dockets/${firstDocRel.replace(/^\/+/, '')}`;
					const pdfPath = path.join(PDFS_DIR, `${docId}.pdf`);
					try {
						await sleep(450);
						const pdfRes = await fetch(pdfUrl, {
							headers: { 'User-Agent': USER_AGENT },
							signal: AbortSignal.timeout(20_000),
						});
						if (pdfRes.ok) {
							const buf = Buffer.from(await pdfRes.arrayBuffer());
							if (buf.length > 500 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
								fs.writeFileSync(pdfPath, buf);
								savedPdfPath = pdfPath;
								docsDownloaded += 1;
								const extracted = await extractAndOcrPdf(pdfPath);
								if (extracted.text) {
									fullText = `${plainDocket}\n\n=== ATTACHED DOCUMENT OCR ===\n${extracted.text}`;
									method = extracted.method;
									ocrModel = extracted.ocrModel;
									pagesOcr = extracted.pagesOcr;
									docsOcrd += 1;
								}
							}
						}
					} catch {
						/* non-fatal */
					}
				}

				const courtLabel = `OSCN — ${county.charAt(0).toUpperCase() + county.slice(1)} County District Court, OK`;
				const edges = extractEdgesFromCourtDocument({
					sourceFirm: input.sourceFirm,
					title,
					text: fullText,
					courtOrSource: courtLabel,
					caseOrRecordId: `${county}:${caseNumber}`,
					jurisdiction: 'OK',
				});
				allEdges.push(...edges);

				const doc: IngestedLegalDoc = {
					id: docId,
					source: 'oscn',
					profileId: input.profileId,
					profileSlug: input.profileSlug,
					title,
					courtOrSource: courtLabel,
					caseOrRecordId: `${county}:${caseNumber}`,
					dateIssued,
					jurisdiction: 'OK',
					sourceUrl: absUrl,
					pdfUrl,
					pdfPath: savedPdfPath,
					ocrJsonPath,
					extractionMethod: method,
					ocrModel,
					pagesOcr,
					textChars: fullText.length,
					textExcerpt: fullText.slice(0, 1200),
					edges,
					fetchedAt: new Date().toISOString(),
				};
				fs.writeFileSync(ocrJsonPath, JSON.stringify({ ...doc, fullText }, null, 2));
				docs.push(doc);
			}
			await sleep(400);
		}
		return {
			status: 'ok',
			recordsFound,
			docsDownloaded,
			docsOcrd,
			docs,
			edges: allEdges,
		};
	} catch (e: unknown) {
		return {
			status: 'error',
			recordsFound,
			docsDownloaded,
			docsOcrd,
			docs,
			edges: allEdges,
			note: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * 4. CourtListener / RECAP REST API v4 (official Token auth via COURTLISTENER_API_TOKEN).
 * Never attempts to bypass Human Verification / WAF gates when unauthenticated.
 */
async function fetchCourtListenerRecap(input: {
	profileId: string;
	profileSlug: string;
	sourceFirm: string;
	query: string;
	maxDocs: number;
	downloadPdfs: boolean;
}): Promise<{
	status: 'ok' | 'auth_required' | 'error';
	recordsFound: number;
	docsDownloaded: number;
	docsOcrd: number;
	docs: IngestedLegalDoc[];
	edges: FirmRelationshipEdge[];
	note?: string;
}> {
	const token = String(process.env.COURTLISTENER_API_TOKEN || '').trim();
	if (!token) {
		return {
			status: 'auth_required',
			recordsFound: 0,
			docsDownloaded: 0,
			docsOcrd: 0,
			docs: [],
			edges: [],
			note: 'Set COURTLISTENER_API_TOKEN in .env.local (free token from courtlistener.com/profile/api/) to query RECAP federal dockets & download RECAP PDFs.',
		};
	}

	const headers = {
		'User-Agent': USER_AGENT,
		Authorization: `Token ${token}`,
		Accept: 'application/json',
	};
	const searchUrl = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(`"${input.query}"`)}&type=r&order_by=dateFiled+desc`;
	try {
		const res = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(15_000) });
		if (res.status === 401 || res.status === 403 || res.status === 405) {
			return {
				status: 'auth_required',
				recordsFound: 0,
				docsDownloaded: 0,
				docsOcrd: 0,
				docs: [],
				edges: [],
				note: `CourtListener returned HTTP ${res.status} — verify COURTLISTENER_API_TOKEN.`,
			};
		}
		if (!res.ok) {
			return {
				status: 'error',
				recordsFound: 0,
				docsDownloaded: 0,
				docsOcrd: 0,
				docs: [],
				edges: [],
				note: `CourtListener HTTP ${res.status}`,
			};
		}
		const data = (await res.json()) as {
			count?: number;
			results?: Array<{
				caseName?: string;
				docketNumber?: string;
				court?: string;
				court_id?: string;
				dateFiled?: string;
				docket_absolute_url?: string;
				recap_documents?: Array<{
					id?: number;
					description?: string;
					filepath_local?: string;
					is_available?: boolean;
				}>;
			}>;
		};
		const results = data.results || [];
		const docs: IngestedLegalDoc[] = [];
		const allEdges: FirmRelationshipEdge[] = [];
		let docsDownloaded = 0;
		let docsOcrd = 0;

		for (const r of results.slice(0, input.maxDocs)) {
			const docketNo = String(r.docketNumber || '').trim() || safeFileSlug(r.caseName || 'docket');
			const title = String(r.caseName || docketNo).trim();
			const court = String(r.court || r.court_id || 'Federal Court (RECAP)');
			const dateIssued = r.dateFiled ? normalizeIsoDate(r.dateFiled).date : null;
			const sourceUrl = r.docket_absolute_url
				? `https://www.courtlistener.com${r.docket_absolute_url}`
				: 'https://www.courtlistener.com/';
			const availDoc = (r.recap_documents || []).find((d) => d.is_available && d.filepath_local);
			const pdfUrl = availDoc?.filepath_local
				? `https://storage.courtlistener.com/${availDoc.filepath_local.replace(/^\/+/, '')}`
				: null;

			const docId = `courtlistener-${safeFileSlug(`${r.court_id || 'fed'}-${docketNo}`)}`;
			const pdfPath = path.join(PDFS_DIR, `${docId}.pdf`);
			const ocrJsonPath = path.join(OCR_DIR, `${docId}.json`);

			let fullText = `${title}\nCourt: ${court}\nDocket: ${docketNo}\nFiled: ${dateIssued || 'Unknown'}\n${availDoc?.description || ''}`;
			let method: IngestedLegalDoc['extractionMethod'] = 'json';
			let ocrModel: string | null = null;
			let pagesOcr = 0;
			let savedPdfPath: string | null = null;

			if (input.downloadPdfs && pdfUrl) {
				const alreadyHavePdf = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500;
				if (!alreadyHavePdf) {
					const pdfRes = await fetch(pdfUrl, {
						headers: { 'User-Agent': USER_AGENT },
						signal: AbortSignal.timeout(25_000),
					});
					if (pdfRes.ok) {
						const buf = Buffer.from(await pdfRes.arrayBuffer());
						if (buf.length > 500 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
							fs.writeFileSync(pdfPath, buf);
							docsDownloaded += 1;
						}
					}
					await sleep(250);
				}
				if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500) {
					savedPdfPath = pdfPath;
					const extracted = await extractAndOcrPdf(pdfPath);
					if (extracted.text) {
						fullText = extracted.text;
						method = extracted.method;
						ocrModel = extracted.ocrModel;
						pagesOcr = extracted.pagesOcr;
						docsOcrd += 1;
					}
				}
			}

			const jurisdiction = inferJurisdiction(`${court} ${r.court_id || ''} ${fullText.slice(0, 1500)}`);
			const edges = extractEdgesFromCourtDocument({
				sourceFirm: input.sourceFirm,
				title,
				text: fullText,
				courtOrSource: court,
				caseOrRecordId: docketNo,
				jurisdiction,
			});
			allEdges.push(...edges);

			const doc: IngestedLegalDoc = {
				id: docId,
				source: 'courtlistener',
				profileId: input.profileId,
				profileSlug: input.profileSlug,
				title,
				courtOrSource: court,
				caseOrRecordId: docketNo,
				dateIssued,
				jurisdiction,
				sourceUrl,
				pdfUrl,
				pdfPath: savedPdfPath,
				ocrJsonPath,
				extractionMethod: method,
				ocrModel,
				pagesOcr,
				textChars: fullText.length,
				textExcerpt: fullText.slice(0, 1200),
				edges,
				fetchedAt: new Date().toISOString(),
			};
			fs.writeFileSync(ocrJsonPath, JSON.stringify({ ...doc, fullText }, null, 2));
			docs.push(doc);
		}

		return {
			status: 'ok',
			recordsFound: Number(data.count || results.length),
			docsDownloaded,
			docsOcrd,
			docs,
			edges: allEdges,
		};
	} catch (e: unknown) {
		return {
			status: 'error',
			recordsFound: 0,
			docsDownloaded: 0,
			docsOcrd: 0,
			docs: [],
			edges: [],
			note: e instanceof Error ? e.message : String(e),
		};
	}
}

function edgeTypeToProfileRelation(edgeType: RelationshipEdgeType): {
	relationType: ProfileRelationType;
	rolePrefix: string;
} {
	switch (edgeType) {
		case 'REPRESENTS_CREDITOR_OR_DEBT_BUYER':
			return { relationType: 'business_tie', rolePrefix: 'Represented creditor / debt buyer' };
		case 'CO_DEFENDANT_IN_LITIGATION':
			return { relationType: 'business_tie', rolePrefix: 'Co-defendant in litigation' };
		case 'CO_COUNSEL_IN_LITIGATION':
			return { relationType: 'business_tie', rolePrefix: 'Co-counsel in litigation' };
		case 'AMICUS_CURIAE_IN_LITIGATION':
			return { relationType: 'affiliated_with', rolePrefix: 'Amicus curiae in litigation' };
		case 'GARNISHMENT_COUNTERPARTY_EMPLOYER':
			return { relationType: 'business_tie', rolePrefix: 'Garnishment counterparty (employer/payroll)' };
		case 'GARNISHMENT_COUNTERPARTY_BANK':
			return { relationType: 'business_tie', rolePrefix: 'Garnishment counterparty (bank)' };
		default:
			return { relationType: 'affiliated_with', rolePrefix: 'Legal filing counterparty' };
	}
}

/**
 * Run the local-first Legal API + PDF/OCR ingestion workflow for a profile.
 */
export async function ingestLegalDocsForProfile(
	profileIdOrSlug: string,
	opts?: {
		query?: string;
		sources?: LegalDocSource[];
		states?: string[];
		oscnCounties?: string[];
		maxDocsPerSource?: number;
		downloadPdfs?: boolean;
		syncToProfile?: boolean;
		touchProfile?: boolean;
	},
): Promise<LegalDocsIngestionReport> {
	ensureDirs();
	const profile = getProfile(profileIdOrSlug);
	if (!profile) {
		throw new Error(`Profile not found: ${profileIdOrSlug}`);
	}

	const db = getProfilesDb();
	const profileAliases = (
		db
			.prepare(`SELECT alias FROM profile_aliases WHERE profile_id = ? AND alias_kind != 'slug'`)
			.all(profile.id) as Array<{ alias: string }>
	).map((r) => r.alias);

	const query =
		(opts?.query && opts.query.trim()) ||
		profile.name.replace(/,?\s*(?:P\.?C\.?|L\.?L\.?C\.?|Inc\.?|Corp\.?)$/i, '').trim();
	const enabledSources = new Set<LegalDocSource>(
		opts?.sources && opts.sources.length > 0
			? opts.sources
			: ['cfpb', 'govinfo', 'oscn', 'courtlistener'],
	);
	const states = opts?.states && opts.states.length > 0 ? opts.states : ['OK', 'TX'];
	const oscnCounties =
		opts?.oscnCounties && opts.oscnCounties.length > 0 ? opts.oscnCounties : ['oklahoma', 'tulsa', 'bryan'];
	const maxDocs = Math.max(1, Math.min(20, Number(opts?.maxDocsPerSource || 8)));
	const downloadPdfs = opts?.downloadPdfs !== false;
	const syncToProfile = opts?.syncToProfile !== false;

	const sourcesReport: LegalDocsIngestionReport['sources'] = {
		cfpb: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
		govinfo: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
		oscn: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
		courtlistener: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
	};

	const allDocs: IngestedLegalDoc[] = [];
	const allEdges: FirmRelationshipEdge[] = [];
	let cfpbSummary: LegalDocsIngestionReport['cfpbSummary'] = null;

	// 1. CFPB by company match (single request with all state & issue aggregations)
	if (enabledSources.has('cfpb')) {
		const r = await fetchCfpbForProfile({
			profileId: profile.id,
			profileSlug: profile.slug,
			sourceFirm: profile.name,
			query,
			aliases: profileAliases,
			states,
			maxRecords: 25,
		});
		sourcesReport.cfpb = {
			status: r.status,
			recordsFound: r.recordsFound,
			docsDownloaded: r.docs.length,
			docsOcrd: r.docs.length,
			note: r.note,
		};
		cfpbSummary = r.summary;
		allDocs.push(...r.docs);
		allEdges.push(...r.edges);
	}

	// 2. GovInfo USCOURTS (official federal court PDF opinions/orders)
	if (enabledSources.has('govinfo')) {
		const r = await fetchGovInfoCourtDocs({
			profileId: profile.id,
			profileSlug: profile.slug,
			sourceFirm: profile.name,
			query,
			maxDocs,
			downloadPdfs,
		});
		sourcesReport.govinfo = {
			status: r.status,
			recordsFound: r.recordsFound,
			docsDownloaded: r.docsDownloaded,
			docsOcrd: r.docsOcrd,
			note: r.note,
		};
		allDocs.push(...r.docs);
		allEdges.push(...r.edges);
	}

	// 3. OSCN Oklahoma district courts (polite cached HTML + linked PDF OCR)
	if (enabledSources.has('oscn')) {
		const oscnQuery = profile.name.replace(/,?\s*(?:P\.?C\.?|L\.?L\.?C\.?|Inc\.?|Corp\.?)$/i, '').trim() || query;
		const r = await fetchOscnDockets({
			profileId: profile.id,
			profileSlug: profile.slug,
			sourceFirm: profile.name,
			query: oscnQuery,
			counties: oscnCounties,
			maxCases: Math.min(5, maxDocs),
			downloadPdfs,
		});
		sourcesReport.oscn = {
			status: r.status,
			recordsFound: r.recordsFound,
			docsDownloaded: r.docsDownloaded,
			docsOcrd: r.docsOcrd,
			note: r.note,
		};
		allDocs.push(...r.docs);
		allEdges.push(...r.edges);
	}

	// 4. CourtListener / RECAP (official Token auth when configured)
	if (enabledSources.has('courtlistener')) {
		const r = await fetchCourtListenerRecap({
			profileId: profile.id,
			profileSlug: profile.slug,
			sourceFirm: profile.name,
			query,
			maxDocs,
			downloadPdfs,
		});
		sourcesReport.courtlistener = {
			status: r.status,
			recordsFound: r.recordsFound,
			docsDownloaded: r.docsDownloaded,
			docsOcrd: r.docsOcrd,
			note: r.note,
		};
		allDocs.push(...r.docs);
		allEdges.push(...r.edges);
	}

	// Sync extracted documents, timeline milestones, and typed counterparty edges into profiles.sqlite
	let sourceRecordsUpserted = 0;
	let timelineEntriesUpserted = 0;
	let linksUpserted = 0;

	if (syncToProfile) {
		for (const doc of allDocs) {
			const corpus = `legal-api-${doc.source}`;
			const srId = upsertSourceRecord({
				corpus,
				sourceRef: doc.caseOrRecordId,
				sourceUrl: doc.sourceUrl,
				title: doc.title,
				publishedDate: doc.dateIssued,
				excerpt: doc.textExcerpt.slice(0, 600),
				metadata: {
					pdfPath: doc.pdfPath,
					ocrJsonPath: doc.ocrJsonPath,
					extractionMethod: doc.extractionMethod,
					ocrModel: doc.ocrModel,
					textChars: doc.textChars,
					jurisdiction: doc.jurisdiction,
					courtOrSource: doc.courtOrSource,
				},
			});
			sourceRecordsUpserted += 1;

			if (doc.source !== 'cfpb' && doc.dateIssued) {
				upsertTimelineEntry({
					profileId: profile.id,
					eventDate: doc.dateIssued,
					title: `${doc.title} (${doc.caseOrRecordId})`.slice(0, 180),
					summary: `${doc.courtOrSource} — ${doc.extractionMethod} (${doc.textChars.toLocaleString()} chars). ${doc.textExcerpt.replace(/\s+/g, ' ').slice(0, 380)}`,
					angle: 'law_enforcement',
					entryKind: 'filing',
					sourceCorpus: corpus,
					sourceRecordId: srId,
					dedupeHint: `${corpus}:${doc.caseOrRecordId}`,
					confidence: 0.94,
					metadata: { sourceUrl: doc.sourceUrl, pdfPath: doc.pdfPath, ocrJsonPath: doc.ocrJsonPath },
				});
				timelineEntriesUpserted += 1;
			}
		}

		// Link extracted counterparty FirmRelationshipEdges (skipping CFPB state aggregate edges)
		const linkedEdgeKeys = new Set<string>();
		for (const edge of allEdges) {
			if (edge.edgeType === 'CFPB_COMPLAINT_LINKED_STATE') continue;
			const dedupeEdge = `${edge.targetEntity.toLowerCase()}|${edge.edgeType}`;
			if (linkedEdgeKeys.has(dedupeEdge)) continue;
			linkedEdgeKeys.add(dedupeEdge);

			const targetProfileType: ProfileType = 'firm';
			const existingHit = findExistingProfileDuplicate({
				name: edge.targetEntity,
				profileType: targetProfileType,
			});
			const target =
				existingHit?.profile ||
				upsertProfile({
					profileType: targetProfileType,
					name: edge.targetEntity,
					status: 'active',
					summary: `${edge.targetEntity} — counterparty documented in ${edge.courtOrSource} (${edge.caseOrRecordId || 'court record'}).`,
					sourceCorpus: 'legal-api-ocr',
				});
			if (target.id === profile.id) continue;

			const existingCurated = db
				.prepare(
					`SELECT id FROM profile_links
           WHERE ((from_profile_id = ? AND to_profile_id = ?) OR (from_profile_id = ? AND to_profile_id = ?))
             AND source_corpus != 'legal-api-ocr'
           LIMIT 1`,
				)
				.get(profile.id, target.id, target.id, profile.id) as { id?: string } | undefined;
			if (existingCurated?.id) continue;

			const { relationType, rolePrefix } = edgeTypeToProfileRelation(edge.edgeType);
			upsertProfileLink({
				fromProfileId: profile.id,
				toProfileId: target.id,
				relationType,
				roleLabel: edge.caseOrRecordId ? `${rolePrefix} (${edge.caseOrRecordId})` : rolePrefix,
				status: 'observed',
				confidence: 0.93,
				angle: 'law_enforcement',
				sourceCorpus: 'legal-api-ocr',
				evidenceNote: edge.evidenceSummary,
				dedupeHint: `${edge.edgeType}:${edge.caseOrRecordId || ''}`,
			});
			linksUpserted += 1;
		}

		if (
			opts?.touchProfile !== false &&
			(sourceRecordsUpserted > 0 || timelineEntriesUpserted > 0 || linksUpserted > 0)
		) {
			touchProfilesForUserAction([profile.id]);
		}
	}

	// Merge with previously cached manifest AND any on-disk OCR JSON files for this profile
	// so transient rate limits (e.g. GovInfo DEMO_KEY 429) never drop already-downloaded PDFs/OCR docs.
	const prevManifest = loadCachedLegalDocsManifest(profile.slug);
	const mergedSources = { ...sourcesReport };
	if (prevManifest?.sources) {
		for (const s of ['cfpb', 'govinfo', 'oscn', 'courtlistener'] as LegalDocSource[]) {
			if (mergedSources[s].status !== 'ok' && prevManifest.sources[s]?.status === 'ok') {
				mergedSources[s] = prevManifest.sources[s];
			}
		}
	}
	const docById = new Map<string, IngestedLegalDoc>();
	for (const d of prevManifest?.documents || []) {
		const freshOk = enabledSources.has(d.source) && sourcesReport[d.source].status === 'ok' && allDocs.some((x) => x.source === d.source);
		if (!freshOk) docById.set(d.id, d);
	}
	// Also recover any cached OCR JSON files on disk for this profile
	if (fs.existsSync(OCR_DIR)) {
		for (const fname of fs.readdirSync(OCR_DIR)) {
			if (!fname.endsWith('.json')) continue;
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(OCR_DIR, fname), 'utf8')) as IngestedLegalDoc & { fullText?: string };
				if (raw.profileSlug !== profile.slug && raw.profileId !== profile.id) continue;
				if (!raw.id || docById.has(raw.id)) continue;
				const { fullText: _omit, ...summaryDoc } = raw;
				void _omit;
				docById.set(summaryDoc.id, summaryDoc);
			} catch {
				/* ignore malformed cache file */
			}
		}
	}
	for (const d of allDocs) docById.set(d.id, d);
	const mergedDocs = [...docById.values()].sort((a, b) =>
		String(b.dateIssued || '').localeCompare(String(a.dateIssued || '')),
	);

	const edgeMap = new Map<string, FirmRelationshipEdge>();
	for (const d of mergedDocs) {
		for (const e of d.edges || []) {
			const k = `${normalizeText(e.targetEntity)}|${e.edgeType}|${e.caseOrRecordId || ''}`;
			edgeMap.set(k, e);
		}
	}
	for (const e of [...(prevManifest?.edges || []), ...allEdges]) {
		const k = `${normalizeText(e.targetEntity)}|${e.edgeType}|${e.caseOrRecordId || ''}`;
		edgeMap.set(k, e);
	}
	const mergedEdges = [...edgeMap.values()];

	const report: LegalDocsIngestionReport = {
		ok: true,
		profileId: profile.id,
		profileSlug: profile.slug,
		profileName: profile.name,
		query,
		sources: mergedSources,
		cfpbSummary: cfpbSummary || prevManifest?.cfpbSummary || null,
		documents: mergedDocs,
		edges: mergedEdges,
		profileSync: {
			sourceRecordsUpserted,
			timelineEntriesUpserted,
			linksUpserted,
		},
	};

	const manifestPath = path.join(MANIFEST_DIR, `${safeFileSlug(profile.slug)}.json`);
	fs.writeFileSync(manifestPath, JSON.stringify(report, null, 2));
	return report;
}

export function loadCachedLegalDocsManifest(profileSlugOrId: string): LegalDocsIngestionReport | null {
	const profile = getProfile(profileSlugOrId);
	const slug = profile?.slug || profileSlugOrId;
	const manifestPath = path.join(MANIFEST_DIR, `${safeFileSlug(slug)}.json`);
	if (!fs.existsSync(manifestPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as LegalDocsIngestionReport;
	} catch {
		return null;
	}
}

type CachedOcrEntry = {
	doc: IngestedLegalDoc;
	fullText: string;
	fullTextLow: string;
	edgeTargetNorms: Set<string>;
};

let ocrCacheDirSig = '';
let ocrCacheEntries: CachedOcrEntry[] = [];

function getAllCachedOcrEntries(): CachedOcrEntry[] {
	if (!fs.existsSync(OCR_DIR)) return [];
	const files = fs.readdirSync(OCR_DIR).filter((f) => f.endsWith('.json'));
	let maxMtime = 0;
	for (const f of files) {
		try {
			const mt = fs.statSync(path.join(OCR_DIR, f)).mtimeMs;
			if (mt > maxMtime) maxMtime = mt;
		} catch {
			/* ignore */
		}
	}
	const sig = `${files.length}:${Math.round(maxMtime)}`;
	if (sig === ocrCacheDirSig && ocrCacheEntries.length === files.length) {
		return ocrCacheEntries;
	}
	const next: CachedOcrEntry[] = [];
	for (const f of files) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(OCR_DIR, f), 'utf8')) as IngestedLegalDoc & {
				fullText?: string;
			};
			if (!raw.id) continue;
			const fullText = String(raw.fullText || raw.textExcerpt || '');
			const { fullText: _omit, ...doc } = raw;
			void _omit;
			const edgeTargetNorms = new Set<string>();
			for (const e of doc.edges || []) {
				const n = normalizeText(e.targetEntity);
				if (n) edgeTargetNorms.add(n);
				const s = stripLegalSuffixes(e.targetEntity);
				if (s && s.length >= 4) edgeTargetNorms.add(s);
			}
			next.push({
				doc,
				fullText: `${doc.title}\n${fullText}`,
				fullTextLow: `${doc.title}\n${fullText}`.toLowerCase(),
				edgeTargetNorms,
			});
		} catch {
			/* skip malformed cache */
		}
	}
	ocrCacheDirSig = sig;
	ocrCacheEntries = next;
	return next;
}

const GENERIC_CROSSMATCH_SKIP = new Set([
	'united states',
	'united states of america',
	'bank',
	'capital',
	'financial',
	'credit',
	'national',
	'american',
	'federal',
	'state',
	'general',
	'first',
	'oklahoma',
	'texas',
	'arkansas',
	'oklahoma city',
	'dallas',
	'houston',
	'austin',
	'company',
	'corporation',
	'group',
	'partners',
	'holdings',
	'services',
	'trust',
	'court',
	'district court',
	'supreme court',
]);

function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCrossMatchNeedles(profileId: string, name: string, profileType: ProfileType): {
	normKeys: Set<string>;
	phraseRegexes: Array<{ label: string; re: RegExp }>;
} {
	const db = getProfilesDb();
	const aliasRows = db
		.prepare(`SELECT alias FROM profile_aliases WHERE profile_id = ? AND alias_kind != 'slug'`)
		.all(profileId) as Array<{ alias: string }>;

	const normKeys = new Set<string>();
	const rawPhrases = new Set<string>();
	const addCandidate = (raw: string) => {
		const clean = String(raw || '')
			.replace(/\s*\([^)]*\)\s*/g, ' ')
			.replace(/[,;:\s]+$/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!clean) return;
		const norm = normalizeText(clean);
		if (norm.length >= 4 && !GENERIC_CROSSMATCH_SKIP.has(norm)) {
			normKeys.add(norm);
			if (profileType === 'person') {
				if (norm.split(' ').length >= 2 && norm.length >= 7) rawPhrases.add(clean);
			} else if (norm.length >= 5) {
				rawPhrases.add(clean);
			}
		}
		if (profileType !== 'person') {
			const stripped = stripLegalSuffixes(clean);
			if (
				stripped.length >= 5 &&
				!GENERIC_CROSSMATCH_SKIP.has(stripped) &&
				(stripped.includes(' ') || stripped.length >= 7)
			) {
				normKeys.add(stripped);
				rawPhrases.add(stripped);
			}
		}
	};

	addCandidate(name);
	for (const r of aliasRows) addCandidate(r.alias);

	const phraseRegexes: Array<{ label: string; re: RegExp }> = [];
	const seenLow = new Set<string>();
	for (const phrase of rawPhrases) {
		const low = phrase.toLowerCase();
		if (seenLow.has(low) || GENERIC_CROSSMATCH_SKIP.has(low)) continue;
		seenLow.add(low);
		const words = low.split(/[^a-z0-9]+/).filter(Boolean);
		if (words.length === 0) continue;
		if (profileType === 'person' && (words.length < 2 || words[words.length - 1]!.length < 4)) continue;
		if (profileType !== 'person' && words.length === 1 && words[0]!.length < 7) continue;
		const pat = words.map((w) => escapeRegexLiteral(w)).join('[\\s.,&\'’\\-/]+');
		try {
			phraseRegexes.push({
				label: phrase,
				re: new RegExp(`(?<![A-Za-z0-9])${pat}(?![A-Za-z0-9])`, 'i'),
			});
		} catch {
			/* ignore invalid regex */
		}
	}

	return { normKeys, phraseRegexes };
}

/**
 * Load a profile's own cached legal documents PLUS any other cached court filings / CFPB / OCR
 * documents across .data/legal-docs/ocr/ whose extracted edges or OCR text mention this profile.
 */
export function loadLegalDocsForProfileWithCrossMatches(
	profileSlugOrId: string,
): LegalDocsIngestionReport | null {
	const profile = getProfile(profileSlugOrId);
	if (!profile) return loadCachedLegalDocsManifest(profileSlugOrId);

	const own = loadCachedLegalDocsManifest(profile.slug || profile.id);
	const docById = new Map<string, IngestedLegalDoc>();
	for (const d of own?.documents || []) {
		docById.set(d.id, d);
	}

	const edgeMap = new Map<string, FirmRelationshipEdge>();
	for (const e of own?.edges || []) {
		const k = `${normalizeText(e.targetEntity)}|${e.edgeType}|${e.caseOrRecordId || ''}`;
		edgeMap.set(k, e);
	}

	const { normKeys, phraseRegexes } = buildCrossMatchNeedles(
		profile.id,
		profile.name,
		profile.profileType,
	);
	const allOcr = getAllCachedOcrEntries();

	for (const entry of allOcr) {
		if (docById.has(entry.doc.id)) continue;
		if (entry.doc.profileId === profile.id || entry.doc.profileSlug === profile.slug) {
			docById.set(entry.doc.id, entry.doc);
			for (const e of entry.doc.edges || []) {
				const k = `${normalizeText(e.targetEntity)}|${e.edgeType}|${e.caseOrRecordId || ''}`;
				edgeMap.set(k, e);
			}
			continue;
		}
		// Only cross-match court filings/dockets across profiles (CFPB summaries are per-company)
		if (entry.doc.source === 'cfpb') continue;

		// 1. Direct match on extracted litigation edges
		let matchedReason: string | null = null;
		for (const nk of normKeys) {
			if (entry.edgeTargetNorms.has(nk)) {
				matchedReason = `Matched in filing (${entry.doc.caseOrRecordId})`;
				break;
			}
		}

		// 2. Direct name match in OCR/document title or full text
		if (!matchedReason) {
			for (const { label, re } of phraseRegexes) {
				if (re.test(entry.fullText)) {
					matchedReason = `Name "${label}" matched in OCR text`;
					break;
				}
			}
		}

		if (matchedReason) {
			docById.set(entry.doc.id, {
				...entry.doc,
				matchedVia: matchedReason,
			});
			for (const e of entry.doc.edges || []) {
				const en = normalizeText(e.targetEntity);
				const es = stripLegalSuffixes(e.targetEntity);
				if (normKeys.has(en) || (es && normKeys.has(es))) {
					const k = `${en}|${e.edgeType}|${e.caseOrRecordId || ''}`;
					edgeMap.set(k, e);
				}
			}
		}
	}

	const mergedDocs = [...docById.values()].sort((a, b) =>
		String(b.dateIssued || '').localeCompare(String(a.dateIssued || '')),
	);
	if (mergedDocs.length === 0 && !own) return null;

	return {
		ok: true,
		profileId: profile.id,
		profileSlug: profile.slug,
		profileName: profile.name,
		query: own?.query || profile.name,
		sources: own?.sources || {
			cfpb: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
			govinfo: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
			oscn: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
			courtlistener: { status: 'skipped', recordsFound: 0, docsDownloaded: 0, docsOcrd: 0 },
		},
		cfpbSummary: own?.cfpbSummary || null,
		documents: mergedDocs,
		edges: [...edgeMap.values()],
		profileSync: own?.profileSync || {
			sourceRecordsUpserted: 0,
			timelineEntriesUpserted: 0,
			linksUpserted: 0,
		},
	};
}

export function readCachedLegalDocFullText(docId: string): {
	id: string;
	title: string;
	fullText: string;
	extractionMethod: string;
	pdfPath: string | null;
} | null {
	const safe = safeFileSlug(docId);
	const ocrPath = path.join(OCR_DIR, `${safe}.json`);
	if (!fs.existsSync(ocrPath)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(ocrPath, 'utf8')) as {
			id?: string;
			title?: string;
			fullText?: string;
			textExcerpt?: string;
			extractionMethod?: string;
			pdfPath?: string | null;
		};
	return {
		id: String(parsed.id || safe),
		title: String(parsed.title || safe),
		fullText: String(parsed.fullText || parsed.textExcerpt || ''),
		extractionMethod: String(parsed.extractionMethod || 'pdftotext'),
		pdfPath: parsed.pdfPath || null,
	};
} catch {
	return null;
}
}

/**
 * Re-scan cached non-CFPB court/docket OCR documents and materialize Connected Profiles
 * (`profile_links`) for every extracted counterparty, co-defendant, co-counsel, amicus curiae,
 * and strict existing-profile name match — attaching the exact description from the filing.
 */
export function syncOcrNameMatchesToProfileLinks(profileIdOrSlug?: string): {
	docsScanned: number;
	linksUpserted: number;
	profilesCreated: number;
} {
	const db = getProfilesDb();
	const filterProfile = profileIdOrSlug ? getProfile(profileIdOrSlug) : null;
	const entries = getAllCachedOcrEntries().filter((e) => {
		if (e.doc.source === 'cfpb') return false;
		if (filterProfile) {
			return e.doc.profileId === filterProfile.id || e.doc.profileSlug === filterProfile.slug;
		}
		return true;
	});

	let docsScanned = 0;
	let linksUpserted = 0;
	let profilesCreated = 0;
	const seenPair = new Set<string>();

	for (const entry of entries) {
		docsScanned += 1;
		const owner = getProfile(entry.doc.profileId) || getProfile(entry.doc.profileSlug);
		if (!owner) continue;

		const freshEdges = extractEdgesFromCourtDocument({
			sourceFirm: owner.name,
			title: entry.doc.title,
			text: entry.fullText,
			courtOrSource: entry.doc.courtOrSource,
			caseOrRecordId: entry.doc.caseOrRecordId,
			jurisdiction: entry.doc.jurisdiction,
		});

		for (const edge of freshEdges) {
			if (edge.edgeType === 'CFPB_COMPLAINT_LINKED_STATE') continue;
			const targetHit = findExistingProfileDuplicate({
				name: edge.targetEntity,
				profileType: 'firm',
			});
			let target = targetHit?.profile || null;
			if (!target) {
				target = upsertProfile({
					profileType: 'firm',
					name: edge.targetEntity,
					status: 'active',
					summary: `${edge.targetEntity} — documented in ${edge.courtOrSource} (${edge.caseOrRecordId || 'court record'}).`,
					sourceCorpus: 'legal-api-ocr',
				});
				profilesCreated += 1;
			}
			if (target.id === owner.id) continue;

			const pairKey = `${owner.id}|${target.id}|${edge.edgeType}`;
			if (seenPair.has(pairKey)) continue;
			seenPair.add(pairKey);

			// Skip creating a duplicate legal-api-ocr link if a curated link already connects this exact pair
			const existingCurated = db
				.prepare(
					`SELECT id FROM profile_links
           WHERE ((from_profile_id = ? AND to_profile_id = ?) OR (from_profile_id = ? AND to_profile_id = ?))
             AND source_corpus != 'legal-api-ocr'
           LIMIT 1`,
				)
				.get(owner.id, target.id, target.id, owner.id) as { id?: string } | undefined;
			if (existingCurated?.id) continue;

			const { relationType, rolePrefix } = edgeTypeToProfileRelation(edge.edgeType);
			upsertProfileLink({
				fromProfileId: owner.id,
				toProfileId: target.id,
				relationType,
				roleLabel: `${rolePrefix} (${entry.doc.caseOrRecordId})`,
				startDate: entry.doc.dateIssued || null,
				status: 'observed',
				confidence: 0.93,
				angle: 'law_enforcement',
				sourceCorpus: 'legal-api-ocr',
				evidenceNote: edge.evidenceSummary,
				dedupeHint: `${edge.edgeType}:${entry.doc.caseOrRecordId}`,
			});
			linksUpserted += 1;
		}
	}

	return { docsScanned, linksUpserted, profilesCreated };
}
