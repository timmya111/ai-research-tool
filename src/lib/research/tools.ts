import { createBryanFilingChart, createLogo } from '@/lib/research/charts';
import { inspectCanvasSnapshot, type CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { ensureDefaultProject, listProjects } from '@/lib/research/knowledge/projects';
import { retrieve } from '@/lib/research/knowledge/retrieve';
import type { KnowledgeSourceType } from '@/lib/research/knowledge/types';

export type ResearchToolName =
	| 'fetch_url'
	| 'current_time'
	| 'inspect_canvas_graph'
	| 'search_knowledge'
	| 'chart_filings'
	| 'make_logo';

export type ResearchToolContext = {
	canvasSnapshot?: CanvasSnapshot | null;
	projectId?: string | null;
};

export const RESEARCH_TOOL_DEFINITIONS = [
	{
		type: 'function' as const,
		function: {
			name: 'chart_filings',
			description:
				'Build a shareable chart image of Bryan County OKCountyRecords filings from the local knowledge store (counts over time or by document type). Default format is PNG for easy online sharing. Use format=jpeg for JPG, or format=svg only when the user wants a vector/logo-style export. Returns an imageUrl to embed as markdown ![title](url).',
			parameters: {
				type: 'object',
				properties: {
					kind: {
						type: 'string',
						description: 'volume (default: counts over time) | by_type (document type breakdown)',
					},
					period: {
						type: 'string',
						description: 'For volume charts: day | week | month (default month)',
					},
					from: {
						type: 'string',
						description: 'Optional start date YYYY-MM-DD or YYYY-MM',
					},
					to: {
						type: 'string',
						description: 'Optional end date YYYY-MM-DD or YYYY-MM',
					},
					docType: {
						type: 'string',
						description: 'Optional instrument filter, e.g. MTG, WD, REL MTG, UCC',
					},
					format: {
						type: 'string',
						description: 'png (default, shareable) | jpeg | svg (vector; prefer make_logo for logos)',
					},
					projectId: {
						type: 'string',
						description:
							'Optional UUID or project name. Prefer omitting this so the active request project is used.',
					},
				},
				required: [],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'make_logo',
			description:
				'Create a simple wordmark/logo image. Default format is SVG (vector) for logos. Pass format=png or jpeg when the user wants a raster logo to share online. Returns an imageUrl to embed as markdown.',
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Primary logo text / wordmark' },
					subtitle: { type: 'string', description: 'Optional secondary line' },
					format: {
						type: 'string',
						description: 'svg (default for logos) | png | jpeg',
					},
				},
				required: ['text'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_knowledge',
			description:
				'Search the local knowledge store for the active project (saved chats with tool digests, fetched pages, notes). Use for prior Q&A, CRDs, URLs, or notes. Local disk only.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Natural language or keyword query' },
					limit: { type: 'number', description: 'Max hits (default 5, max 12)' },
					sourceType: {
						type: 'string',
						description: 'Optional filter: chat | fetch | note | any (default any)',
					},
					projectId: {
						type: 'string',
						description: 'Optional; defaults to the active project from the request context',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'inspect_canvas_graph',
			description:
				"Inspect the user's FINRA canvas graph snapshot (nodes/links from the live graph window or pasted JSON). Use for questions about what is on the graph right now. Actions: summary, list_people, list_firms, selection_log, neighbors, dual_on_canvas, search.",
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						description:
							'summary | list_people | list_firms | selection_log | neighbors | dual_on_canvas | search',
					},
					query: { type: 'string', description: 'Optional name/CRD filter for list/search actions' },
					nodeId: { type: 'string', description: 'Node id for neighbors, e.g. person:5417517 or firm:2525' },
					limit: { type: 'number', description: 'Max rows to return (default 40)' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'fetch_url',
			description:
				'GET an API endpoint or page URL the user provided for research. Returns truncated JSON or readable text. Allowlisted / safe hosts only (includes the live FINRA SEC visualizer, BrokerCheck, AdviserInfo). Read-only.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
					maxChars: {
						type: 'number',
						description: 'Max characters of body to return (default 24000, max 48000)',
					},
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'current_time',
			description: 'Return the current date and time in ISO and local string forms (server timezone).',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
];

const FETCH_URL_DEFAULT_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	'::1',
	'en.wikipedia.org',
	'www.wikipedia.org',
	'raw.githubusercontent.com',
	'github.com',
	'api.github.com',
	'docs.x.ai',
	'arxiv.org',
	'export.arxiv.org',
	'finra-sec-data-visualizer-canvas.vercel.app',
	'brokercheck.finra.org',
	'api.brokercheck.finra.org',
	'files.brokercheck.finra.org',
	'adviserinfo.sec.gov',
	'api.adviserinfo.sec.gov',
	'okcountyrecords.com',
	'www.okcountyrecords.com',
]);
const FETCH_URL_MAX_BYTES = 512_000;
const FETCH_URL_TIMEOUT_MS = 15_000;

function fetchUrlAllowedHosts(): Set<string> {
	const hosts = new Set(FETCH_URL_DEFAULT_HOSTS);
	const extra = String(process.env.RESEARCH_FETCH_HOSTS || process.env.LOCAL_AI_FETCH_HOSTS || '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	for (const h of extra) hosts.add(h);
	return hosts;
}

function openFetchEnabled(): boolean {
	return process.env.RESEARCH_OPEN_FETCH === '1' || process.env.ALLOW_OPEN_FETCH === '1';
}

function normalizeFetchHost(hostname: string): string {
	return String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
}

function isPrivateOrLocalHostname(hostname: string): boolean {
	const host = normalizeFetchHost(hostname);
	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
	if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
	if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
	if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;
	return false;
}

function isFetchUrlAllowed(url: URL): { ok: true } | { ok: false; error: string } {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'only http(s) URLs are allowed' };
	}
	if (url.username || url.password) {
		return { ok: false, error: 'URLs with credentials are not allowed' };
	}
	const host = normalizeFetchHost(url.hostname);
	const allowlist = fetchUrlAllowedHosts();
	if (allowlist.has(host) || allowlist.has(url.hostname.toLowerCase())) {
		return { ok: true };
	}
	if (openFetchEnabled()) {
		if (isPrivateOrLocalHostname(host) && !allowlist.has(host)) {
			return {
				ok: false,
				error: `private/local host blocked even with open fetch: ${url.hostname}. Add it to RESEARCH_FETCH_HOSTS.`,
			};
		}
		return { ok: true };
	}
	return {
		ok: false,
		error: `host not allowlisted: ${url.hostname}. Add hosts via RESEARCH_FETCH_HOSTS, or set RESEARCH_OPEN_FETCH=1 for public https.`,
	};
}

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

async function fetchUrlForResearch(
	rawUrl: unknown,
	maxCharsRaw: unknown,
): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const maxChars = Math.max(1000, Math.min(48_000, Number(maxCharsRaw) || 24_000));
	let parsed: URL;
	try {
		parsed = new URL(String(rawUrl || '').trim());
	} catch {
		return { ok: false, result: { error: 'invalid URL' } };
	}
	const allowed = isFetchUrlAllowed(parsed);
	if (allowed.ok === false) {
		return { ok: false, result: { error: allowed.error, url: parsed.href } };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
	try {
		const res = await fetch(parsed.href, {
			method: 'GET',
			redirect: 'follow',
			cache: 'no-store',
			signal: controller.signal,
			headers: {
				Accept: 'application/json, text/plain, text/html;q=0.9, */*;q=0.8',
				'User-Agent': 'ai-research-tool-fetch/1.0',
			},
		});
		const finalUrl = new URL(res.url);
		const finalAllowed = isFetchUrlAllowed(finalUrl);
		if (!finalAllowed.ok) {
			return {
				ok: false,
				result: {
					error: `redirect landed on disallowed host: ${finalUrl.hostname}`,
					requestedUrl: parsed.href,
					finalUrl: finalUrl.href,
				},
			};
		}

		const contentType = String(res.headers.get('content-type') || '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		const buf = Buffer.from(await res.arrayBuffer());
		const byteTruncated = buf.length > FETCH_URL_MAX_BYTES;
		const slice = byteTruncated ? buf.subarray(0, FETCH_URL_MAX_BYTES) : buf;
		const rawText = slice.toString('utf8');

		let kind: 'json' | 'text' | 'html' = 'text';
		let body: unknown = rawText;
		const looksJson = contentType.includes('json') || /^\s*[{[]/.test(rawText);
		if (looksJson) {
			try {
				body = JSON.parse(rawText);
				kind = 'json';
			} catch {
				kind = 'text';
				body = rawText;
			}
		} else if (contentType.includes('html') || /^\s*</.test(rawText)) {
			kind = 'html';
			body = htmlToReadableText(rawText);
		}

		const serialized = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
		const { text, truncated } = truncateChars(serialized, maxChars);
		let returnedBody: unknown = text;
		if (kind === 'json') {
			try {
				returnedBody = JSON.parse(text);
			} catch {
				returnedBody = text;
			}
		}

		return {
			ok: res.ok,
			result: {
				ok: res.ok,
				status: res.status,
				contentType: contentType || null,
				kind,
				requestedUrl: parsed.href,
				finalUrl: finalUrl.href,
				byteLength: buf.length,
				truncated: truncated || byteTruncated,
				body: returnedBody,
				hint:
					truncated || byteTruncated
						? 'Body truncated for model context; ask for a narrower URL or field if needed.'
						: undefined,
			},
		};
	} catch (e: unknown) {
		const err = e as { name?: string; message?: string };
		const message =
			err?.name === 'AbortError' ? `timeout after ${FETCH_URL_TIMEOUT_MS}ms` : err?.message || String(e);
		return { ok: false, result: { error: message, url: parsed.href } };
	} finally {
		clearTimeout(timer);
	}
}

function resolveProjectId(args: Record<string, unknown>, context: ResearchToolContext): string {
	const candidates = [
		String(args.projectId || '').trim(),
		String(context.projectId || '').trim(),
	].filter(Boolean);

	const projects = listProjects();
	for (const raw of candidates) {
		const byId = projects.find((p) => p.id === raw);
		if (byId) return byId.id;
		const byName = projects.find((p) => p.name.toLowerCase() === raw.toLowerCase());
		if (byName) return byName.id;
		// Tolerate "BryanCounty" / "bryan_county" style labels from the model
		const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
		const byCompact = projects.find((p) => p.name.toLowerCase().replace(/[\s_-]+/g, '') === compact);
		if (byCompact) return byCompact.id;
	}

	const bryan = projects.find((p) => p.name.toLowerCase() === 'bryan county');
	if (bryan) return bryan.id;
	return ensureDefaultProject().id;
}

async function runSearchKnowledge(
	args: Record<string, unknown>,
	context: ResearchToolContext,
): Promise<{ ok: boolean; result: unknown }> {
	const query = String(args.query || '').trim();
	if (!query) {
		return { ok: false, result: { error: 'query required' } };
	}

	let projectId: string;
	try {
		projectId = resolveProjectId(args, context);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { error: `projectId required (${message})` } };
	}

	const sourceTypeRaw = String(args.sourceType || 'any').trim().toLowerCase();
	const sourceType = (
		['chat', 'fetch', 'note', 'any'].includes(sourceTypeRaw) ? sourceTypeRaw : 'any'
	) as KnowledgeSourceType | 'any';

	try {
		const hits = await retrieve(query, {
			projectId,
			limit: args.limit as number | undefined,
			sourceType,
		});
		return {
			ok: true,
			result: {
				ok: true,
				query,
				projectId,
				returned: hits.length,
				hits: hits.map((h) => ({
					title: h.title,
					sourceType: h.sourceType,
					url: h.url,
					snippet: h.snippet,
					score: h.score,
					documentId: h.documentId,
					chunkId: h.chunkId,
				})),
				hint:
					hits.length === 0
						? 'No local knowledge hits. Save notes or enable persist flags (later PRs), or ask without relying on prior memory.'
						: undefined,
			},
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message, query, projectId } };
	}
}

async function runChartFilings(
	args: Record<string, unknown>,
	context: ResearchToolContext,
): Promise<{ ok: boolean; result: unknown }> {
	try {
		const projectId = resolveProjectId(args, context);
		const chart = await createBryanFilingChart({
			projectId,
			period: args.period as string | undefined,
			kind: args.kind as string | undefined,
			from: args.from != null ? String(args.from) : null,
			to: args.to != null ? String(args.to) : null,
			docType: args.docType != null ? String(args.docType) : null,
			limitBuckets: args.limitBuckets as number | undefined,
			limitTypes: args.limitTypes as number | undefined,
			format: args.format as string | undefined,
		});
		return { ok: true, result: chart };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

async function runMakeLogo(args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }> {
	try {
		const logo = await createLogo({
			text: String(args.text || ''),
			subtitle: args.subtitle != null ? String(args.subtitle) : null,
			format: args.format as string | undefined,
		});
		return { ok: true, result: logo };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, result: { ok: false, error: message } };
	}
}

export async function runResearchTool(
	name: string,
	args: Record<string, unknown>,
	context: ResearchToolContext = {},
): Promise<{ ok: boolean; result: unknown }> {
	const tool = String(name || '').trim() as ResearchToolName;

	if (tool === 'search_knowledge') {
		return runSearchKnowledge(args, context);
	}

	if (tool === 'chart_filings') {
		return runChartFilings(args, context);
	}

	if (tool === 'make_logo') {
		return runMakeLogo(args);
	}

	if (tool === 'inspect_canvas_graph') {
		const inspected = inspectCanvasSnapshot(context.canvasSnapshot, args);
		return { ok: inspected.ok, result: inspected.result };
	}

	if (tool === 'current_time') {
		const now = new Date();
		return {
			ok: true,
			result: {
				iso: now.toISOString(),
				local: now.toString(),
				timezoneOffsetMinutes: now.getTimezoneOffset(),
				unixMs: now.getTime(),
			},
		};
	}

	if (tool === 'fetch_url') {
		const fetched = await fetchUrlForResearch(args.url, args.maxChars);
		return { ok: fetched.ok, result: fetched.result };
	}

	return { ok: false, result: { error: `unknown tool: ${name}` } };
}
