#!/usr/bin/env node
/**
 * Poll curated construction / military / geotech RSS feeds and create
 * historic_event profiles for new articles (deduped by source URL).
 * Fetches each article page and stores cleaned full text in summary
 * (ads/nav/related/junk stripped via Readability + heuristics).
 *
 *   pnpm news:rss              # one-shot
 *   pnpm news:rss:loop         # poll every NEWS_RSS_INTERVAL_MS (default 30m)
 *   NEWS_RSS_BACKFILL_FULL=1 pnpm news:rss   # refill summaries on existing news_rss events
 *   NEWS_RSS_MAX_PER_FEED=20 NEWS_RSS_DRY_RUN=1 pnpm news:rss
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { classifySoftJournalism } from './lib/news-rss-soft-journalism.mjs';
import { DEFAULT_FOCUS_TOPICS, itemMatchesFocusTopics } from './lib/news-rss-focus-topics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, '.data', 'news-feeds', 'construction-infra-feeds.json');
const STATE_PATH = path.join(ROOT, '.data', 'news-feeds', 'construction-infra-state.json');
const MONITOR_PATH = path.join(ROOT, '.data', 'monitors', 'news-rss-construction-infra.json');
const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const MAX_PER_FEED = Math.max(1, Number(process.env.NEWS_RSS_MAX_PER_FEED || 25));
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_DRY_RUN || ''));
const LOOP = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_LOOP || ''));
const BACKFILL_FULL = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_BACKFILL_FULL || ''));
const FETCH_ARTICLE = !/^(0|false|no)$/i.test(String(process.env.NEWS_RSS_FETCH_ARTICLE || '1'));
const SUMMARY_MAX = Math.max(8_000, Number(process.env.NEWS_RSS_SUMMARY_MAX || 120_000));
const ARTICLE_MIN_CHARS = Math.max(400, Number(process.env.NEWS_RSS_ARTICLE_MIN || 600));
const FETCH_TIMEOUT_MS = Math.max(5_000, Number(process.env.NEWS_RSS_FETCH_TIMEOUT_MS || 25_000));
const INTERVAL_MS = Math.max(
	60_000,
	Number(process.env.NEWS_RSS_INTERVAL_MS) || 30 * 60 * 1000,
);
const UA =
	process.env.NEWS_RSS_UA ||
	'Mozilla/5.0 (compatible; ai-research-tool-news-rss/1.0; +http://localhost:3333)';

const JUNK_LINE_RE =
	/^(advertisement|sponsored|subscribe(?:\s+to)?|sign\s*up|newsletter|share\s+this|related\s+(articles?|stories|posts)|you\s+may\s+also\s+like|recommended|cookie\s+policy|accept\s+cookies|follow\s+us|leave\s+a\s+comment|comments?\s*$|tags?\s*:|categories?\s*:|posted\s+in\s*:|click\s+here|read\s+more\s*$|continue\s+reading|trending|popular\s+stories|from\s+our\s+partners|promo(ted)?\s+content|this\s+article\s+was\s+updated)/i;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function loadJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function saveJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function decodeXml(s) {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.trim();
}

function stripHtml(s) {
	return decodeXml(s)
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function tagText(block, tag) {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const m = block.match(re);
	return m ? decodeXml(m[1]) : '';
}

function linkFromItem(block) {
	const linkTag = tagText(block, 'link');
	if (/^https?:\/\//i.test(linkTag)) return linkTag.trim();
	const atom = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
	if (atom?.[1]) return decodeXml(atom[1]).trim();
	const guid = tagText(block, 'guid');
	if (/^https?:\/\//i.test(guid)) return guid.trim();
	return '';
}

function parseRssItems(xml) {
	const items = [];
	const chunks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
	const entries = String(xml || '').match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
	for (const block of [...chunks, ...entries]) {
		const title = stripHtml(tagText(block, 'title')).slice(0, 240);
		const link = linkFromItem(block);
		const contentHtml =
			tagText(block, 'content:encoded') ||
			tagText(block, 'content') ||
			'';
		const descriptionHtml =
			tagText(block, 'description') || tagText(block, 'summary') || '';
		const description = stripHtml(descriptionHtml).slice(0, 2000);
		const rssBody = cleanArticleText(stripHtml(contentHtml || descriptionHtml));
		const pub =
			tagText(block, 'pubDate') ||
			tagText(block, 'published') ||
			tagText(block, 'updated') ||
			tagText(block, 'dc:date');
		if (!title || !link) continue;
		items.push({
			title,
			link,
			description,
			rssBody,
			contentHtml,
			pubDate: pub,
		});
	}
	return items;
}

function toIsoDate(raw) {
	const s = String(raw || '').trim();
	if (!s) return null;
	const d = new Date(s);
	if (!Number.isNaN(d.getTime())) {
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normalizeUrl(u) {
	try {
		const url = new URL(u);
		url.hash = '';
		for (const k of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
		}
		return url.toString().replace(/\/$/, '');
	} catch {
		return String(u || '').trim().replace(/\/$/, '');
	}
}

function slugify(title, link) {
	const base = String(title || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
	const hash = crypto.createHash('sha1').update(normalizeUrl(link)).digest('hex').slice(0, 8);
	return `historic_event:news-${base || 'item'}-${hash}`;
}

function existingUrlSet() {
	const out = new Set();
	if (!fs.existsSync(PROFILES_DB)) return out;
	try {
		const db = new DatabaseSync(PROFILES_DB, { readonly: true });
		const rows = db
			.prepare(
				`SELECT value FROM profile_identifiers
         WHERE lower(scheme) IN ('url','source_url','website')`,
			)
			.all();
		for (const r of rows) out.add(normalizeUrl(String(r.value || '')));
		db.close?.();
	} catch {
		/* best-effort */
	}
	return out;
}

function listNewsProfilesForBackfill() {
	if (!fs.existsSync(PROFILES_DB)) return [];
	const db = new DatabaseSync(PROFILES_DB, { readonly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, slug, name, summary, metadata_json
         FROM profiles
         WHERE metadata_json LIKE '%newsFeedId%'
            OR metadata_json LIKE '%"news_rss"%'
         ORDER BY created_at DESC`,
			)
			.all();
		return rows
			.map((r) => {
				let meta = {};
				try {
					meta = JSON.parse(r.metadata_json || '{}');
				} catch {
					meta = {};
				}
				return {
					id: r.id,
					slug: r.slug,
					name: r.name,
					summary: r.summary || '',
					metadata: meta,
					sourceUrl: meta.sourceUrl || null,
				};
			})
			.filter((r) => r.sourceUrl);
	} finally {
		db.close?.();
	}
}

async function fetchText(url, accept) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent': UA,
				Accept: accept,
			},
			redirect: 'follow',
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} (${text.slice(0, 120)})`);
		return { text, finalUrl: res.url || url };
	} finally {
		clearTimeout(t);
	}
}

async function fetchFeed(url) {
	const { text } = await fetchText(
		url,
		'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
	);
	return text;
}

function cleanArticleText(raw) {
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
		// Drop pure social/share chrome
		if (/^(facebook|twitter|x|linkedin|whatsapp|email|print)$/i.test(line)) continue;
		kept.push(line);
	}
	return kept
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function extractFromHtml(html, pageUrl) {
	const dom = new JSDOM(html, { url: pageUrl });
	const doc = dom.window.document;

	// Strip obvious junk before Readability
	for (const sel of [
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
		'.sponsored',
		'.newsletter',
		'.subscribe',
		'.social-share',
		'.share-buttons',
		'.related-posts',
		'.related-articles',
		'.recommended',
		'.comments',
		'#comments',
		'.cookie',
		'.cookie-banner',
		'.paywall',
		'.promo',
		'.wp-block-rank-math-toc-block',
	]) {
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

	// Fallback: article/main paragraphs
	const root =
		doc.querySelector('article') ||
		doc.querySelector('[itemprop="articleBody"]') ||
		doc.querySelector('.entry-content, .post-content, .article-body, .article__body, main') ||
		doc.body;
	if (!root) return { title: null, text: '', byline: null, siteName: null, method: 'empty' };
	const parts = [];
	for (const p of root.querySelectorAll('p, h2, h3, li, blockquote')) {
		if (p.closest('nav, footer, aside, form, .related, .share, .newsletter')) continue;
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

async function fetchArticleBody(url) {
	const { text: html, finalUrl } = await fetchText(
		url,
		'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	);
	if (/just a moment|cf-browser-verification|attention required|access denied/i.test(html.slice(0, 2000))) {
		throw new Error('blocked/challenge page');
	}
	const extracted = extractFromHtml(html, finalUrl);
	return { ...extracted, finalUrl, htmlChars: html.length };
}

async function resolveArticleText(item) {
	const candidates = [];
	if (item.rssBody && item.rssBody.length >= ARTICLE_MIN_CHARS) {
		candidates.push({ text: item.rssBody, method: 'rss-content', finalUrl: item.link });
	}

	if (FETCH_ARTICLE) {
		try {
			const page = await fetchArticleBody(item.link);
			if (page.text && page.text.length >= 200) {
				candidates.push(page);
			}
		} catch (err) {
			return {
				text: item.rssBody || item.description || '',
				method: 'rss-fallback',
				error: err instanceof Error ? err.message : String(err),
				finalUrl: item.link,
			};
		}
	}

	if (!candidates.length) {
		return {
			text: item.rssBody || item.description || '',
			method: 'rss-short',
			finalUrl: item.link,
		};
	}

	candidates.sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));
	const best = candidates[0];
	return {
		text: best.text,
		method: best.method,
		finalUrl: best.finalUrl || item.link,
		byline: best.byline || null,
		siteName: best.siteName || null,
	};
}

function buildSummary({ feed, item, article }) {
	const parts = [];
	if (article.text) parts.push(article.text.trim());
	else if (item.description) parts.push(item.description.trim());
	parts.push(`Source: ${feed.name}`);
	parts.push(item.link);
	return parts.filter(Boolean).join('\n\n').slice(0, SUMMARY_MAX);
}

function resolveKeywords(feed, catalog) {
	const catalogKeywords = Array.isArray(catalog?.keywordBoost) ? catalog.keywordBoost : [];
	const focusTopics = Array.isArray(catalog?.focusTopics) && catalog.focusTopics.length ? catalog.focusTopics : DEFAULT_FOCUS_TOPICS;
	if (Array.isArray(feed.includeKeywords) && feed.includeKeywords.length) {
		return { mode: 'include', keywords: feed.includeKeywords.map(String) };
	}
	if (feed.matchCatalogKeywords) {
		return { mode: 'include', keywords: catalogKeywords.map(String) };
	}
	if (feed.matchFocusTopics === true || (feed.matchFocusTopics !== false && catalog?.defaultMatchFocusTopics)) {
		return { mode: 'focus', keywords: focusTopics.map(String) };
	}
	return { mode: 'all', keywords: null };
}

function itemMatchesKeywords(item, keywords) {
	if (!keywords || !keywords.length) return true;
	const hay = `${item.title || ''} ${item.description || ''} ${item.rssBody || ''}`.toLowerCase();
	return keywords.some((k) => {
		const raw = String(k || '').trim();
		if (!raw) return false;
		const needle = raw.toLowerCase();
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (/\s/.test(needle) || needle.length >= 12) {
			return hay.includes(needle);
		}
		const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
		return re.test(hay);
	});
}

async function createEvent({ feed, item, article }) {
	const startDate = toIsoDate(item.pubDate);
	const summary = buildSummary({ feed, item, article });
	const corpora = ['news_rss', feed.bucket, feed.id].filter(Boolean);
	if (feed.region) corpora.push(`region:${feed.region}`);
	const body = {
		profileType: 'historic_event',
		name: item.title,
		slug: slugify(item.title, item.link),
		status: 'active',
		summary,
		startDate,
		endDate: null,
		sourceCorpus: `news_rss:${feed.id}`,
		metadata: {
			corpora,
			newsFeedId: feed.id,
			newsFeedName: feed.name,
			newsBucket: feed.bucket || null,
			newsRegion: feed.region || null,
			sourceUrl: item.link,
			articleMethod: article.method || null,
			articleChars: summary.length,
			articleFullTextAt: new Date().toISOString(),
			articleByline: article.byline || null,
			ingestedAt: new Date().toISOString(),
		},
		identifiers: [{ scheme: 'url', value: normalizeUrl(item.link) }],
		categoryTags: [],
	};
	if (DRY_RUN) return { dryRun: true, slug: body.slug, articleChars: summary.length };

	const res = await fetch(`${BASE_URL}/api/profiles`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `POST /api/profiles → HTTP ${res.status}`);
	}
	return data.profile || data;
}

async function patchEventFullText(profile, article, feedName) {
	const sourceUrl = profile.sourceUrl;
	const summary = [
		article.text?.trim() || profile.summary || '',
		`Source: ${feedName || profile.metadata?.newsFeedName || 'news'}`,
		sourceUrl,
	]
		.filter(Boolean)
		.join('\n\n')
		.slice(0, SUMMARY_MAX);

	const metadata = {
		...(profile.metadata || {}),
		articleMethod: article.method || null,
		articleChars: summary.length,
		articleFullTextAt: new Date().toISOString(),
		articleByline: article.byline || null,
		articleError: article.error || null,
	};

	if (DRY_RUN) {
		return { dryRun: true, id: profile.id, articleChars: summary.length, method: article.method };
	}

	const res = await fetch(`${BASE_URL}/api/profiles/${encodeURIComponent(profile.id)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ summary, metadata }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `PATCH /api/profiles/${profile.id} → HTTP ${res.status}`);
	}
	return data.profile || data;
}

async function backfillFullText() {
	const rows = listNewsProfilesForBackfill();
	const force = /^(1|true|yes)$/i.test(String(process.env.NEWS_RSS_BACKFILL_FORCE || ''));
	const limit = Math.max(1, Number(process.env.NEWS_RSS_BACKFILL_LIMIT || rows.length));
	const todo = rows
		.filter((r) => {
			if (force) return true;
			const chars = Number(r.metadata?.articleChars || 0);
			const hasFull = Boolean(r.metadata?.articleFullTextAt) && chars >= ARTICLE_MIN_CHARS;
			return !hasFull || (r.summary || '').length < ARTICLE_MIN_CHARS;
		})
		.slice(0, limit);

	console.log(
		`[news-rss] backfill full text candidates=${todo.length}/${rows.length} fetch=${FETCH_ARTICLE} dryRun=${DRY_RUN}`,
	);

	const summary = {
		startedAt: new Date().toISOString(),
		updated: 0,
		skipped: 0,
		errors: 0,
	};

	for (const profile of todo) {
		try {
			const article = await resolveArticleText({
				title: profile.name,
				link: profile.sourceUrl,
				description: profile.summary,
				rssBody: '',
				contentHtml: '',
			});
			if (!article.text || article.text.length < 200) {
				summary.skipped += 1;
				console.log(`[news-rss] ~ skip short ${profile.slug} method=${article.method} err=${article.error || ''}`);
				await sleep(120);
				continue;
			}
			const updated = await patchEventFullText(
				profile,
				article,
				profile.metadata?.newsFeedName,
			);
			summary.updated += 1;
			console.log(
				`[news-rss] ✎ ${profile.metadata?.newsFeedId || '?'}: ${String(profile.name).slice(0, 70)} (${article.method}, ${article.text.length}c)`,
			);
			await sleep(150);
			void updated;
		} catch (err) {
			summary.errors += 1;
			console.error(
				`[news-rss] ! backfill ${profile.slug}:`,
				err instanceof Error ? err.message : err,
			);
			await sleep(250);
		}
	}

	if (!DRY_RUN) {
		saveJson(MONITOR_PATH, {
			mode: 'backfill_full',
			...summary,
			finishedAt: new Date().toISOString(),
		});
	}
	console.log(
		`[news-rss] backfill done updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors}`,
	);
	return summary;
}

async function pollOnce() {
	const catalog = loadJson(CATALOG, null);
	if (!catalog?.feeds?.length) {
		console.error(`[news-rss] missing catalog ${CATALOG}`);
		process.exit(1);
	}
	const state = loadJson(STATE_PATH, { seenUrls: {}, feeds: {}, updatedAt: null });
	const known = existingUrlSet();
	for (const u of Object.keys(state.seenUrls || {})) known.add(normalizeUrl(u));

	const enabled = catalog.feeds.filter((f) => f.enabled && f.rss);
	console.log(
		`[news-rss] feeds=${enabled.length}/${catalog.feeds.length} maxPerFeed=${MAX_PER_FEED} fetchArticle=${FETCH_ARTICLE} dryRun=${DRY_RUN} focusDefault=${!!catalog.defaultMatchFocusTopics} base=${BASE_URL}`,
	);

	const summary = {
		startedAt: new Date().toISOString(),
		created: 0,
		skipped: 0,
		filtered: 0,
		errors: 0,
		feeds: {},
	};

	for (const feed of enabled) {
		const feedStat = {
			fetched: 0,
			created: 0,
			skipped: 0,
			filtered: 0,
			errors: 0,
			error: null,
		};
		const kw = resolveKeywords(feed, catalog);
		try {
			const xml = await fetchFeed(feed.rss);
			const items = parseRssItems(xml).slice(0, MAX_PER_FEED);
			feedStat.fetched = items.length;
			console.log(
				`[news-rss] ${feed.id}: items=${items.length} filter=${kw.mode}${kw.keywords ? `(${kw.keywords.length})` : ''}`,
			);
			for (const item of items) {
				const url = normalizeUrl(item.link);
				if (!url || known.has(url)) {
					feedStat.skipped += 1;
					summary.skipped += 1;
					continue;
				}
				const topicOk =
					kw.mode === 'all' ? true
					: kw.mode === 'focus' ? itemMatchesFocusTopics(item, kw.keywords)
					:	itemMatchesKeywords(item, kw.keywords);
				if (!topicOk) {
					feedStat.filtered += 1;
					summary.filtered += 1;
					continue;
				}
				const softPre = classifySoftJournalism({
					title: item.title,
					summary: `${item.description || ''}\n${item.rssBody || ''}`,
				});
				if (softPre.soft) {
					feedStat.filtered += 1;
					summary.filtered += 1;
					known.add(url);
					state.seenUrls[url] = {
						at: new Date().toISOString(),
						feedId: feed.id,
						title: item.title,
						skipped: 'soft_journalism',
						reasons: softPre.reasons,
					};
					console.log(
						`[news-rss] ~ soft skip ${feed.id}: ${String(item.title).slice(0, 70)} (${softPre.reasons.join(',')})`,
					);
					continue;
				}
				try {
					const article = await resolveArticleText(item);
					const softPost = classifySoftJournalism({
						title: item.title,
						summary: article.text || item.description || '',
					});
					if (softPost.soft) {
						feedStat.filtered += 1;
						summary.filtered += 1;
						known.add(url);
						state.seenUrls[url] = {
							at: new Date().toISOString(),
							feedId: feed.id,
							title: item.title,
							skipped: 'soft_journalism',
							reasons: softPost.reasons,
							articleChars: article.text?.length || 0,
						};
						console.log(
							`[news-rss] ~ soft skip after fetch ${feed.id}: ${String(item.title).slice(0, 70)} (${softPost.reasons.join(',')})`,
						);
						await sleep(80);
						continue;
					}
					const created = await createEvent({ feed, item, article });
					known.add(url);
					state.seenUrls[url] = {
						at: new Date().toISOString(),
						feedId: feed.id,
						title: item.title,
						slug: created?.slug || null,
						articleChars: article.text?.length || 0,
						articleMethod: article.method || null,
					};
					feedStat.created += 1;
					summary.created += 1;
					console.log(
						`[news-rss] + ${feed.id}: ${item.title.slice(0, 80)} (${article.method}, ${article.text?.length || 0}c)`,
					);
					await sleep(120);
				} catch (err) {
					feedStat.errors += 1;
					summary.errors += 1;
					console.error(`[news-rss] ! ${feed.id}:`, err instanceof Error ? err.message : err);
					await sleep(200);
				}
			}
			state.feeds[feed.id] = {
				lastOkAt: new Date().toISOString(),
				lastCount: items.length,
			};
		} catch (err) {
			feedStat.errors += 1;
			summary.errors += 1;
			feedStat.error = err instanceof Error ? err.message : String(err);
			console.error(`[news-rss] feed fail ${feed.id}:`, feedStat.error);
			state.feeds[feed.id] = {
				...(state.feeds[feed.id] || {}),
				lastErrorAt: new Date().toISOString(),
				lastError: feedStat.error,
			};
		}
		summary.feeds[feed.id] = feedStat;
		await sleep(250);
	}

	state.updatedAt = new Date().toISOString();
	const entries = Object.entries(state.seenUrls || {});
	if (entries.length > 20000) {
		entries.sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
		state.seenUrls = Object.fromEntries(entries.slice(0, 15000));
	}
	if (!DRY_RUN) {
		saveJson(STATE_PATH, state);
		saveJson(MONITOR_PATH, { ...summary, finishedAt: new Date().toISOString() });
	}
	console.log(
		`[news-rss] done created=${summary.created} skipped=${summary.skipped} filtered=${summary.filtered} errors=${summary.errors}`,
	);
	return summary;
}

async function main() {
	if (BACKFILL_FULL) {
		await backfillFullText();
		return;
	}
	if (!LOOP) {
		await pollOnce();
		return;
	}
	console.log(`[news-rss] loop every ${Math.round(INTERVAL_MS / 60000)}m`);
	for (;;) {
		try {
			await pollOnce();
		} catch (err) {
			console.error('[news-rss] poll error:', err instanceof Error ? err.message : err);
		}
		console.log(`[news-rss] sleeping ${Math.round(INTERVAL_MS / 60000)}m…`);
		await sleep(INTERVAL_MS);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
