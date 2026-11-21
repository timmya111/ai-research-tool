import { createBryanFilingChart, createLogo } from '@/lib/research/charts';
import { inspectCanvasSnapshot, type CanvasSnapshot } from '@/lib/research/canvasSnapshot';
import { lookupBrokercheckIndividual } from '@/lib/research/brokercheckLookup';
import { lookupFirmConnections } from '@/lib/research/firmConnectionsLookup';
import { searchFinraSidecar } from '@/lib/research/finraSidecarSearch';
import { ensureDefaultProject, listProjects } from '@/lib/research/knowledge/projects';
import { retrieve } from '@/lib/research/knowledge/retrieve';
import type { KnowledgeSourceType } from '@/lib/research/knowledge/types';

export type ResearchToolName =
	| 'fetch_url'
	| 'current_time'
	| 'inspect_canvas_graph'
	| 'search_finra_sidecar'
	| 'lookup_brokercheck'
	| 'lookup_firm_connections'
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
						description: 'Optional filter: chat | fetch | note | file | image | any (default any)',
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
			name: 'search_finra_sidecar',
			description:
				'Search the production FINRA/SEC visualizer flat-file search index (gzip sidecars via /api/finra/search and /api/finra/sec-search). Use for CRD / person / firm name lookup across the full shipped corpus — not only nodes on the current canvas. Returns identity + current employers only (often empty when Inactive). For full employment / registration history use lookup_brokercheck. Prefer this for FINRA identity; use inspect_canvas_graph only for what is on-screen.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Person/firm name or numeric CRD to look up',
					},
					registry: {
						type: 'string',
						description: 'finra | sec | both (default both)',
					},
					entity: {
						type: 'string',
						description: 'individual | firm | both (default both)',
					},
					limit: {
						type: 'number',
						description: 'Max hits to return (default 8, max 25)',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lookup_brokercheck',
			description:
				'Fetch full BrokerCheck individual detail by numeric CRD: previous + current employment history, exams, disclosure flags, and scopes. Also pulls AdviserInfo when available. Use whenever the user asks for employment history, registration history, firms worked at, exams, or BrokerCheck detail for a CRD. Does NOT require the node-graph checkbox or a canvas snapshot.',
			parameters: {
				type: 'object',
				properties: {
					crd: {
						type: 'string',
						description: 'Numeric CRD, e.g. 1085996',
					},
					includeAdviserInfo: {
						type: 'boolean',
						description: 'Also fetch AdviserInfo SEC IA detail (default true)',
					},
				},
				required: ['crd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lookup_firm_connections',
			description:
				'List all broker/person CRDs connected to a firm from the live FINRA SEC visualizer API (/api/finra/firm/{id}/connections). Use for firm roster / connections / “who works at” / “all CRD connections for firm X” questions. Does NOT require opening the live graph or checking “Question about node graph”. Returns totals plus a page of Name :: CRD# rows; full roster is also saved under .data/finra-rosters/.',
			parameters: {
				type: 'object',
				properties: {
					firmCrd: {
						type: 'string',
						description: 'Numeric firm CRD, e.g. 291361',
					},
					bucket: {
						type: 'string',
						description: 'current | previous | all (default all)',
					},
					limit: {
						type: 'number',
						description: 'Max people to return inline (default 50, max 500)',
					},
					offset: {
						type: 'number',
						description: 'Skip this many matched rows for pagination (default 0)',
					},
					query: {
						type: 'string',
						description: 'Optional name/CRD/address substring filter',
					},
					saveFull: {
						type: 'boolean',
						description: 'Write full roster JSON+Markdown under .data/finra-rosters/ (default true)',
					},
				},
				required: ['firmCrd'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'inspect_canvas_graph',
			description:
				"Inspect the user's FINRA canvas graph snapshot (nodes/links from the live graph window or pasted JSON). Use for questions about what is on the graph right now. Actions: summary, list_people, list_firms, selection_log, neighbors, dual_on_canvas, search. For full CRD corpus search use search_finra_sidecar instead.",
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
						description: 'Max characters of body to return (default 8000, max 48000)',
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
	'earthquake.usgs.gov',
	'www.earthquake.usgs.gov',
	'spc.noaa.gov',
	'www.spc.noaa.gov',
	'ncei.noaa.gov',
	'www.ncei.noaa.gov',
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
	// Default 8k keeps tool rounds inside typical laptop GPU contexts (was 24k).
	const maxChars = Math.max(1000, Math.min(48_000, Number(maxCharsRaw) || 8_000));
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

	const queryHint = String(args.query || args.q || '').toLowerCase();
	const tornado = projects.find((p) => /tornado/i.test(p.name));
	if (
		tornado &&
		/\b(tornado|tornadoes|tornadic|ef[0-5]|efu|spc|ncei|storm events)\b/i.test(queryHint)
	) {
		return tornado.id;
	}
	const seismic = projects.find((p) => /seismic/i.test(p.name));
	if (
		seismic &&
		/\b(seismic|earthquake|earthquakes|comcat|usgs|magnitude|quake)\b/i.test(queryHint)
	) {
		return seismic.id;
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
		['chat', 'fetch', 'note', 'file', 'image', 'any'].includes(sourceTypeRaw)
			? sourceTypeRaw
			: 'any'
	) as KnowledgeSourceType | 'any';

	try {
		const hits = await retrieve(query, {
			projectId,
			limit: args.limit as number | undefined,
			sourceType,
		});
		const snippetMax = (() => {
			const n = Number(process.env.RESEARCH_SEARCH_SNIPPET_CHARS || 400);
			if (!Number.isFinite(n)) return 400;
			return Math.max(120, Math.min(800, Math.floor(n)));
		})();
		const payloadMax = (() => {
			const n = Number(process.env.RESEARCH_TOOL_RESULT_MAX_CHARS || 8000);
			if (!Number.isFinite(n)) return 8000;
			return Math.max(1500, Math.min(48_000, Math.floor(n)));
		})();

		const compactSnippet = (text: string) => {
			const one = String(text || '').trim();
			if (one.length <= snippetMax) return one;
			return `${one.slice(0, snippetMax - 1)}…`;
		};

		let mapped = hits.map((h) => ({
			title: h.title,
			sourceType: h.sourceType,
			url: h.url,
			snippet: compactSnippet(h.snippet),
			score: Number(h.score?.toFixed?.(4) ?? h.score),
			documentId: h.documentId,
			chunkId: h.chunkId,
		}));

		let truncatedHits = false;
		while (mapped.length > 1 && JSON.stringify(mapped).length > payloadMax - 400) {
			mapped = mapped.slice(0, -1);
			truncatedHits = true;
		}
		if (mapped.length === 1 && JSON.stringify(mapped).length > payloadMax - 400) {
			mapped = [
				{
					...mapped[0]!,
					snippet: compactSnippet(mapped[0]!.snippet.slice(0, Math.max(120, snippetMax / 2))),
				},
			];
			truncatedHits = true;
		}

		return {
			ok: true,
			result: {
				ok: true,
				query,
				projectId,
				returned: mapped.length,
				hits: mapped,
				hint:
					hits.length === 0
						? 'No local knowledge hits. Save notes or enable persist flags (later PRs), or ask without relying on prior memory.'
						: truncatedHits
							? `Truncated to ${mapped.length} of ${hits.length} hits for model context; narrow the query for more detail.`
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

	if (tool === 'search_finra_sidecar') {
		return searchFinraSidecar(args);
	}

	if (tool === 'lookup_brokercheck') {
		return lookupBrokercheckIndividual({
			crd: args.crd != null ? String(args.crd) : undefined,
			includeAdviserInfo:
				args.includeAdviserInfo === undefined ? undefined : Boolean(args.includeAdviserInfo),
		});
	}

	if (tool === 'lookup_firm_connections') {
		return lookupFirmConnections({
			firmCrd: args.firmCrd != null ? String(args.firmCrd) : undefined,
			bucket: args.bucket != null ? String(args.bucket) : undefined,
			limit: args.limit as number | undefined,
			offset: args.offset as number | undefined,
			query: args.query != null ? String(args.query) : undefined,
			saveFull: args.saveFull === undefined ? undefined : Boolean(args.saveFull),
		});
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
