import { spawnSync } from 'node:child_process';
import { htmlToPlainText, suggestNomenclatureFromImage, suggestTitleFromPaste } from '@/lib/research/ollamaVision';
import { ingestNote } from '@/lib/research/knowledge/ingest';
import { MAX_DOCUMENT_CHARS, type KnowledgeSourceType } from '@/lib/research/knowledge/types';

const TEXT_EXTS = new Set([
	'.txt',
	'.md',
	'.markdown',
	'.csv',
	'.tsv',
	'.json',
	'.html',
	'.htm',
	'.xml',
	'.log',
	'.yml',
	'.yaml',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

function extOf(name: string): string {
	const m = String(name || '')
		.toLowerCase()
		.match(/(\.[a-z0-9]+)$/);
	return m?.[1] || '';
}

function truncateText(text: string): string {
	const t = String(text || '');
	if (t.length <= MAX_DOCUMENT_CHARS) return t;
	return `${t.slice(0, MAX_DOCUMENT_CHARS - 80)}\n\n…[truncated for knowledge store limit]`;
}

function extractPdfText(buffer: Buffer): string {
	const result = spawnSync('pdftotext', ['-layout', '-nopgbrk', '-', '-'], {
		input: buffer,
		encoding: 'buffer',
		maxBuffer: 12 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const err = String(result.stderr || result.error || 'pdftotext failed');
		throw new Error(`PDF text extract failed: ${err.slice(0, 200)}`);
	}
	return Buffer.from(result.stdout || []).toString('utf8');
}

export type AttachmentIngestResult = {
	id: string;
	projectId: string;
	title: string;
	sourceType: KnowledgeSourceType;
	skipped?: boolean;
	suggestedTitle?: string;
	detectedUrl?: string | null;
	ocrModel?: string;
};

export async function ingestPastedContent(options: {
	projectId: string;
	text: string;
	title?: string;
	url?: string | null;
}): Promise<AttachmentIngestResult> {
	const raw = String(options.text || '');
	const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
	const text = truncateText(looksHtml ? htmlToPlainText(raw) : raw);
	const url = options.url != null ? String(options.url).trim() || null : null;
	const title =
		String(options.title || '').trim() || suggestTitleFromPaste(raw, url) || 'pasted note';
	const saved = await ingestNote({
		projectId: options.projectId,
		title,
		text,
		url,
		sourceType: 'note',
		metadata: { kind: 'paste', pastedAsHtml: looksHtml },
	});
	return {
		id: saved.id,
		projectId: saved.projectId,
		title: saved.title,
		sourceType: 'note',
		skipped: saved.skipped,
		suggestedTitle: title,
		detectedUrl: url,
	};
}

export async function ingestUploadedFile(options: {
	projectId: string;
	fileName: string;
	mimeType?: string;
	bytes: Buffer;
	title?: string;
}): Promise<AttachmentIngestResult> {
	const fileName = String(options.fileName || 'upload').slice(0, 180);
	const ext = extOf(fileName);
	const mime = String(options.mimeType || '').toLowerCase();
	const isImage =
		IMAGE_EXTS.has(ext) || mime.startsWith('image/');
	const isPdf = ext === '.pdf' || mime === 'application/pdf';
	const isText =
		TEXT_EXTS.has(ext) ||
		mime.startsWith('text/') ||
		mime === 'application/json' ||
		mime === 'application/xml';

	if (isImage) {
		const b64 = options.bytes.toString('base64');
		const vision = await suggestNomenclatureFromImage({ imageBase64: b64, fileName });
		const title =
			String(options.title || '').trim() ||
			vision.suggestedTitle ||
			fileName.replace(/\.[a-z0-9]+$/i, '') ||
			'screenshot';
		const bodyParts = [
			`## Screenshot / image attachment`,
			`- File: ${fileName}`,
			vision.detectedUrl ? `- Detected URL: ${vision.detectedUrl}` : null,
			vision.logoOrBrand ? `- Logo/brand: ${vision.logoOrBrand}` : null,
			vision.model ? `- OCR model: ${vision.model}` : null,
			'',
			'## Extracted text',
			vision.ocrText || '(no readable text detected)',
		].filter(Boolean);
		const text = truncateText(bodyParts.join('\n'));
		const saved = await ingestNote({
			projectId: options.projectId,
			title,
			text,
			url: vision.detectedUrl || null,
			sourceType: 'image',
			metadata: {
				kind: 'image',
				fileName,
				mimeType: mime || null,
				ocrModel: vision.model || null,
				logoOrBrand: vision.logoOrBrand || null,
				bytes: options.bytes.length,
				visionOk: vision.ok,
				visionError: vision.error || null,
			},
		});
		return {
			id: saved.id,
			projectId: saved.projectId,
			title: saved.title,
			sourceType: 'image',
			skipped: saved.skipped,
			suggestedTitle: title,
			detectedUrl: vision.detectedUrl || null,
			ocrModel: vision.model,
		};
	}

	let extracted = '';
	if (isPdf) {
		extracted = extractPdfText(options.bytes);
	} else if (isText) {
		extracted = options.bytes.toString('utf8');
		if (ext === '.html' || ext === '.htm' || /<\/?[a-z][\s\S]*>/i.test(extracted)) {
			extracted = htmlToPlainText(extracted);
		}
	} else {
		throw new Error(
			`Unsupported file type (${fileName || mime || 'unknown'}). Use text/markdown/csv/json/html/pdf or an image/screenshot.`,
		);
	}

	const text = truncateText(
		[`## Uploaded file: ${fileName}`, '', extracted.trim() || '(empty extract)'].join('\n'),
	);
	const title =
		String(options.title || '').trim() ||
		suggestTitleFromPaste(extracted, null) ||
		fileName.replace(/\.[a-z0-9]+$/i, '') ||
		'upload';
	const saved = await ingestNote({
		projectId: options.projectId,
		title,
		text,
		sourceType: 'file',
		metadata: {
			kind: 'file',
			fileName,
			mimeType: mime || null,
			bytes: options.bytes.length,
			ext,
		},
	});
	return {
		id: saved.id,
		projectId: saved.projectId,
		title: saved.title,
		sourceType: 'file',
		skipped: saved.skipped,
		suggestedTitle: title,
	};
}
