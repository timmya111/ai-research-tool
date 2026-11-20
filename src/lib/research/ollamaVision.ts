import { getOllamaBaseUrl } from '@/lib/research/ollama';

const DEFAULT_OCR_MODELS = [
	'glm-ocr:latest',
	'granite3.2-vision:latest',
	'qwen3-vl:8b',
	'qwen3-vl:latest',
	'bonsai-2:latest',
] as const;

export function getOcrModelCandidates(): string[] {
	const preferred = String(process.env.RESEARCH_OCR_MODEL || '')
		.trim()
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return [...preferred, ...DEFAULT_OCR_MODELS];
}

async function listLocalModels(baseUrl: string): Promise<string[]> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { cache: 'no-store' });
		if (!res.ok) return [];
		const data = (await res.json()) as { models?: Array<{ name?: string }> };
		return (data.models || []).map((m) => String(m.name || '')).filter(Boolean);
	} catch {
		return [];
	}
}

function pickInstalled(candidates: string[], installed: string[]): string | null {
	const set = new Set(installed);
	for (const c of candidates) {
		if (set.has(c)) return c;
		const base = c.split(':')[0];
		const hit = installed.find((m) => m === c || m.startsWith(`${base}:`));
		if (hit) return hit;
	}
	return null;
}

export type VisionNomenclature = {
	ok: boolean;
	model?: string;
	suggestedTitle?: string;
	detectedUrl?: string | null;
	logoOrBrand?: string | null;
	ocrText?: string;
	error?: string;
};

/**
 * Ask a local vision/OCR model to propose a document title from a screenshot/image,
 * preferring visible URL host, logo/brand, then main on-page heading/text.
 */
export async function suggestNomenclatureFromImage(options: {
	imageBase64: string;
	fileName?: string;
}): Promise<VisionNomenclature> {
	const imageBase64 = String(options.imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9+.+-]+;base64,/, '');
	if (!imageBase64) {
		return { ok: false, error: 'image required' };
	}

	const baseUrl = getOllamaBaseUrl();
	const installed = await listLocalModels(baseUrl);
	const model = pickInstalled(getOcrModelCandidates(), installed);
	if (!model) {
		return {
			ok: false,
			error: 'No OCR/vision model installed (try glm-ocr, granite3.2-vision, or qwen3-vl:8b)',
		};
	}

	const prompt = `You are naming a saved screenshot/document for a local research library.
Inspect the image for: (1) any visible URL/domain in the address bar or page, (2) logo or brand name, (3) main headline or distinctive on-page text.
Reply with ONLY compact JSON (no markdown):
{"title":"short library title <=80 chars","url":"https://... or empty","logo":"brand or empty","text":"key readable text up to 600 chars"}
Prefer title like "example.com — Article headline" when a URL/domain is visible. If nothing readable, use {"title":"screenshot","url":"","logo":"","text":""}.`;

	try {
		const res = await fetch(`${baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				stream: false,
				messages: [
					{
						role: 'user',
						content: prompt,
						images: [imageBase64],
					},
				],
				options: { num_predict: 400 },
			}),
			cache: 'no-store',
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return { ok: false, model, error: `ollama vision HTTP ${res.status}: ${text.slice(0, 200)}` };
		}
		const data = (await res.json()) as {
			message?: { content?: string; thinking?: string };
		};
		const content = String(data.message?.content || data.message?.thinking || '').trim();
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		let parsed: Record<string, unknown> | null = null;
		if (jsonMatch) {
			try {
				parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			} catch {
				parsed = null;
			}
		}

		const fallbackName = String(options.fileName || '')
			.replace(/\.[a-z0-9]+$/i, '')
			.replace(/[_-]+/g, ' ')
			.trim();

		if (!parsed) {
			const title = (content.split('\n')[0] || fallbackName || 'screenshot').slice(0, 80);
			return {
				ok: true,
				model,
				suggestedTitle: title,
				detectedUrl: null,
				logoOrBrand: null,
				ocrText: content.slice(0, 4000),
			};
		}

		const suggestedTitle =
			String(parsed.title || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 80) ||
			fallbackName ||
			'screenshot';
		const detectedUrl = String(parsed.url || '').trim() || null;
		const logoOrBrand = String(parsed.logo || '').trim() || null;
		const ocrText = String(parsed.text || content || '').trim().slice(0, 8000);

		return {
			ok: true,
			model,
			suggestedTitle,
			detectedUrl,
			logoOrBrand,
			ocrText,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, model, error: message };
	}
}

/** Suggest a title from pasted web text / HTML-ish content. */
export function suggestTitleFromPaste(text: string, url?: string | null): string {
	const raw = String(text || '');
	const fromUrl = (() => {
		try {
			if (!url) return '';
			const u = new URL(url);
			return u.hostname.replace(/^www\./, '');
		} catch {
			return '';
		}
	})();

	const heading =
		raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
		raw.match(/^#\s+(.+)$/m)?.[1] ||
		raw.match(/^(.*\S.*)$/m)?.[1] ||
		'';
	const cleaned = String(heading)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);

	if (fromUrl && cleaned) return `${fromUrl} — ${cleaned}`.slice(0, 100);
	if (cleaned) return cleaned;
	if (fromUrl) return fromUrl;
	return 'pasted note';
}

/** Strip tags for HTML paste while keeping readable text. */
export function htmlToPlainText(input: string): string {
	return String(input || '')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}
