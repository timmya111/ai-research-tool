/**
 * Shared full-article HTML scrape for news RSS ingest + format-card.
 * Strips ads/nav/related chrome, then Readability (DOM fallback).
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const DEFAULT_UA =
	process.env.NEWS_RSS_UA ||
	'Mozilla/5.0 (compatible; ai-research-tool-news-rss/1.0; +http://localhost:3333)';

const JUNK_LINE_RE =
	/^(advertisement|sponsored|subscribe(?:\s+to)?|sign\s*up|newsletter|share\s+this|related\s+(articles?|stories|posts)|you\s+may\s+also\s+like|recommended|cookie\s+policy|accept\s+cookies|follow\s+us|leave\s+a\s+comment|comments?\s*$|tags?\s*:|categories?\s*:|posted\s+in\s*:|click\s+here|read\s+more\s*$|continue\s+reading|trending|popular\s+stories|from\s+our\s+partners|promo(ted)?\s+content|this\s+article\s+was\s+updated|watch\s+this|listen\s+to|download\s+the\s+app|get\s+(?:our|the)\s+app)/i;

const STRIP_SELECTORS = [
	'script',
	'style',
	'noscript',
	'iframe',
	'svg',
	'nav',
	'footer',
	'aside',
	'form',
	'[role="navigation"]',
	'[role="complementary"]',
	'.advertisement',
	'.ad',
	'.ads',
	'.ad-slot',
	'.ad-unit',
	'.adhesion',
	'.sponsored',
	'.newsletter',
	'.subscribe',
	'.social-share',
	'.share-buttons',
	'.share',
	'.related-posts',
	'.related-articles',
	'.related',
	'.recommended',
	'.comments',
	'#comments',
	'.cookie',
	'.cookie-banner',
	'.paywall',
	'.promo',
	'.wp-block-rank-math-toc-block',
	'.taboola',
	'.outbrain',
	'[class*="ad-"]',
	'[id*="google_ads"]',
	'[data-ad]',
	'[aria-label*="advertisement" i]',
];

export function cleanArticleText(raw) {
	const lines = String(raw || '')
		.replace(/\r/g, '')
		.replace(/\u00a0/g, ' ')
		.split('\n')
		.map((l) => l.replace(/[ \t]+/g, ' ').trim());
	const kept = [];
	for (const line of lines) {
		if (!line) {
			if (kept.length && kept[kept.length - 1] !== '') kept.push('');
			continue;
		}
		if (JUNK_LINE_RE.test(line)) continue;
		if (line.length < 3 && !/[.!?)]$/.test(line)) continue;
		if (/^(facebook|twitter|x|linkedin|whatsapp|email|print)$/i.test(line)) continue;
		// Photo credit / caption stubs often left by local TV CMS.
		if (/^\(.*?(?:Courtesy|KXAN|KHOU|KVUE|photo|AP|Getty).*?\)$/i.test(line) && line.length < 90) continue;
		kept.push(line);
	}
	return kept
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function extractFromHtml(html, pageUrl) {
	const dom = new JSDOM(html, { url: pageUrl });
	const doc = dom.window.document;

	for (const sel of STRIP_SELECTORS) {
		for (const el of [...doc.querySelectorAll(sel)]) {
			try {
				el.remove();
			} catch {
				/* ignore */
			}
		}
	}

	const parsed = new Readability(doc).parse();
	if (parsed?.textContent) {
		return {
			title: parsed.title || null,
			text: cleanArticleText(parsed.textContent),
			byline: parsed.byline || null,
			siteName: parsed.siteName || null,
			method: 'readability',
		};
	}

	const root =
		doc.querySelector('article') ||
		doc.querySelector('[itemprop="articleBody"]') ||
		doc.querySelector('.entry-content, .post-content, .article-body, .article__body, .story-body, main') ||
		doc.body;
	if (!root) return { title: null, text: '', byline: null, siteName: null, method: 'empty' };
	const parts = [];
	for (const p of root.querySelectorAll('p, h2, h3, li, blockquote')) {
		if (p.closest('nav, footer, aside, form, .related, .share, .newsletter, .comments')) continue;
		const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
		if (t.length >= 40 || /^h[23]$/i.test(p.tagName)) parts.push(t);
	}
	return {
		title: doc.querySelector('h1')?.textContent?.trim() || null,
		text: cleanArticleText(parts.join('\n\n')),
		byline: null,
		siteName: null,
		method: 'dom-fallback',
	};
}

async function fetchHtmlDirect(url, { timeoutMs, ua }) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent': ua,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
			redirect: 'follow',
			signal: ctrl.signal,
		});
		const html = await res.text();
		return { ok: res.ok, status: res.status, html, finalUrl: res.url || url };
	} finally {
		clearTimeout(t);
	}
}

async function fetchHtmlViaFlareSolverr(url, { timeoutMs }) {
	const base = String(process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');
	const maxTimeout = Math.max(20_000, Math.min(timeoutMs, 60_000));
	const res = await fetch(`${base}/v1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			cmd: 'request.get',
			url,
			maxTimeout,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.status !== 'ok') {
		throw new Error(`FlareSolverr ${data.message || res.status}`);
	}
	const html = data.solution?.response || '';
	const finalUrl = data.solution?.url || url;
	if (!html) throw new Error('FlareSolverr empty response');
	return { html, finalUrl };
}

function looksBlocked(html, status) {
	if (status === 403 || status === 503) return true;
	const head = String(html || '').slice(0, 2500);
	return /just a moment|cf-browser-verification|attention required|access denied|enable javascript and cookies/i.test(
		head,
	);
}

export async function fetchArticleBody(
	url,
	{
		timeoutMs = Math.max(5_000, Number(process.env.NEWS_RSS_FETCH_TIMEOUT_MS || 25_000)),
		ua = DEFAULT_UA,
		useFlareSolverr = !/^(0|false|no)$/i.test(String(process.env.NEWS_RSS_FLARESOLVERR || '1')),
	} = {},
) {
	let html = '';
	let finalUrl = url;
	let methodPrefix = '';

	const direct = await fetchHtmlDirect(url, { timeoutMs, ua });
	if (direct.ok && !looksBlocked(direct.html, direct.status)) {
		html = direct.html;
		finalUrl = direct.finalUrl;
	} else if (useFlareSolverr) {
		const via = await fetchHtmlViaFlareSolverr(url, { timeoutMs });
		html = via.html;
		finalUrl = via.finalUrl;
		methodPrefix = 'flaresolverr+';
		if (looksBlocked(html, 200)) throw new Error('blocked/challenge page');
	} else if (!direct.ok) {
		throw new Error(`HTTP ${direct.status} (${direct.html.slice(0, 120)})`);
	} else {
		throw new Error('blocked/challenge page');
	}

	const extracted = extractFromHtml(html, finalUrl);
	return {
		...extracted,
		method: `${methodPrefix}${extracted.method}`,
		finalUrl,
		htmlChars: html.length,
	};
}
