import { finraApiUrl, getFinraAppOrigin } from '@/lib/research/finraApp';

export type FinraSidecarRegistry = 'finra' | 'sec' | 'both';
export type FinraSidecarEntity = 'individual' | 'firm' | 'both';

export type FinraSidecarHit = {
	registry: 'finra' | 'sec';
	entity: 'individual' | 'firm';
	crd: string;
	name: string;
	otherNames?: string[];
	scope?: string;
	disclosureFlag?: string;
	employments?: Array<{ firmId?: string; firmName?: string }>;
	connectionCount?: number;
	raw?: Record<string, unknown>;
};

function clampLimit(n: unknown, fallback = 8): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(25, Math.floor(v)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickString(...vals: unknown[]): string {
	for (const v of vals) {
		const s = String(v ?? '').trim();
		if (s) return s;
	}
	return '';
}

function compactIndividual(row: Record<string, unknown>, registry: 'finra' | 'sec'): FinraSidecarHit | null {
	const basic = asRecord(row.basicInformation) || row;
	const crd = pickString(basic.ind_crd, basic.ind_source_id, basic.crd, row.ind_crd, row._id);
	if (!crd) return null;
	const first = pickString(basic.ind_firstname, basic.firstName);
	const middle = pickString(basic.ind_middlename, basic.middleName);
	const last = pickString(basic.ind_lastname, basic.lastName);
	const name =
		pickString(basic.ind_name, basic.name) ||
		[first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() ||
		`Individual ${crd}`;
	const other = (basic.ind_other_names || basic.otherNames || row.otherNames) as unknown;
	const otherNames = Array.isArray(other)
		? other.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
		: undefined;
	const employmentsRaw =
		(basic.ind_current_employments as unknown) ||
		(basic.ind_ia_current_employments as unknown) ||
		(row.ind_current_employments as unknown);
	const employments = Array.isArray(employmentsRaw)
		? employmentsRaw
				.slice(0, 5)
				.map((e) => {
					const er = asRecord(e) || {};
					return {
						firmId: pickString(er.firmId, er.firm_id) || undefined,
						firmName: pickString(er.firmName, er.firm_name) || undefined,
					};
				})
				.filter((e) => e.firmId || e.firmName)
		: undefined;
	const connectionCount = Number(
		basic.ind_connection_count ?? row.ind_connection_count ?? row.knownConnectionCount,
	);
	return {
		registry,
		entity: 'individual',
		crd,
		name,
		otherNames,
		scope: pickString(basic.ind_bc_scope, basic.ind_ia_scope, basic.bc_scope) || undefined,
		disclosureFlag: pickString(basic.disclosureFlag, basic.iaDisclosureFlag) || undefined,
		employments,
		connectionCount: Number.isFinite(connectionCount) ? connectionCount : undefined,
	};
}

function compactFirm(row: Record<string, unknown>, registry: 'finra' | 'sec'): FinraSidecarHit | null {
	const basic = asRecord(row.basicInformation) || row;
	const crd = pickString(
		basic.firm_id,
		basic.firmId,
		basic.firm_source_id,
		row.firm_id,
		row.firmId,
		row._id,
	);
	if (!crd) return null;
	const name =
		pickString(basic.firm_name, basic.firmName, basic.iaFirmName, row.firm_name, row.firmName) ||
		`Firm ${crd}`;
	const other = (basic.firm_other_names || basic.otherNames || row.otherNames) as unknown;
	const otherNames = Array.isArray(other)
		? other.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
		: undefined;
	const connectionCount = Number(
		basic.firm_connection_count ?? row.firm_connection_count ?? row.knownConnectionCount,
	);
	return {
		registry,
		entity: 'firm',
		crd,
		name,
		otherNames,
		scope: pickString(basic.firm_bc_scope, basic.bc_scope, basic.firm_ia_scope) || undefined,
		disclosureFlag: pickString(basic.disclosureFlag, basic.iaDisclosureFlag) || undefined,
		connectionCount: Number.isFinite(connectionCount) ? connectionCount : undefined,
	};
}

function extractResults(payload: unknown): Record<string, unknown>[] {
	const root = asRecord(payload);
	if (!root) return [];
	const results = root.results;
	if (Array.isArray(results)) {
		return results.map((r) => asRecord(r)).filter(Boolean) as Record<string, unknown>[];
	}
	const hits = asRecord(root.hits);
	const hitList = hits?.hits;
	if (Array.isArray(hitList)) {
		return hitList
			.map((h) => {
				const hr = asRecord(h);
				return asRecord(hr?._source) || hr;
			})
			.filter(Boolean) as Record<string, unknown>[];
	}
	const docs = asRecord(root.response)?.docs;
	if (Array.isArray(docs)) {
		return docs.map((r) => asRecord(r)).filter(Boolean) as Record<string, unknown>[];
	}
	return [];
}

async function queryOne(options: {
	registry: 'finra' | 'sec';
	entity: 'individual' | 'firm';
	query: string;
	limit: number;
}): Promise<{ ok: boolean; total?: number; generatedAt?: string; hits: FinraSidecarHit[]; error?: string; url: string }> {
	const path =
		options.registry === 'sec'
			? `/api/finra/sec-search?query=${encodeURIComponent(options.query)}&type=${options.entity}&nrows=${options.limit}`
			: `/api/finra/search?query=${encodeURIComponent(options.query)}&type=${options.entity}&nrows=${options.limit}`;
	const url = finraApiUrl(path);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	try {
		const res = await fetch(url, {
			method: 'GET',
			cache: 'no-store',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return {
				ok: false,
				hits: [],
				error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
				url,
			};
		}
		const payload = await res.json();
		const root = asRecord(payload) || {};
		const rows = extractResults(payload);
		const hits = rows
			.map((row) =>
				options.entity === 'firm'
					? compactFirm(row, options.registry)
					: compactIndividual(row, options.registry),
			)
			.filter(Boolean) as FinraSidecarHit[];
		return {
			ok: true,
			total: Number(root.total ?? hits.length) || hits.length,
			generatedAt: pickString(root.generatedAt) || undefined,
			hits,
			url,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, hits: [], error: message, url };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Read-only search against the prod FINRA/SEC visualizer search API,
 * which serves the gzip flat-file sidecars (`public/search-indexes/*`).
 * This is the full shipped CRD name index — not the on-screen canvas graph.
 */
export async function searchFinraSidecar(args: {
	query?: string;
	registry?: string;
	entity?: string;
	limit?: number;
}): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const query = String(args.query || '').trim();
	if (query.length < 2) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'query must be at least 2 characters (name or CRD)',
			},
		};
	}

	const registryRaw = String(args.registry || 'both').trim().toLowerCase();
	const entityRaw = String(args.entity || 'both').trim().toLowerCase();
	const registry: FinraSidecarRegistry =
		registryRaw === 'finra' || registryRaw === 'sec' ? registryRaw : 'both';
	const entity: FinraSidecarEntity =
		entityRaw === 'individual' || entityRaw === 'firm' || entityRaw === 'person'
			? entityRaw === 'person'
				? 'individual'
				: entityRaw
			: 'both';
	const limit = clampLimit(args.limit, 8);

	const registries: Array<'finra' | 'sec'> =
		registry === 'both' ? ['finra', 'sec'] : [registry];
	const entities: Array<'individual' | 'firm'> =
		entity === 'both' ? ['individual', 'firm'] : [entity];

	const perCallLimit = Math.max(3, Math.ceil(limit / Math.max(1, entities.length)));
	const calls = registries.flatMap((reg) =>
		entities.map((ent) => queryOne({ registry: reg, entity: ent, query, limit: perCallLimit })),
	);
	const settled = await Promise.all(calls);

	const hits: FinraSidecarHit[] = [];
	const seen = new Set<string>();
	const errors: string[] = [];
	const sources: Array<Record<string, unknown>> = [];

	for (const part of settled) {
		sources.push({
			url: part.url,
			ok: part.ok,
			total: part.total,
			generatedAt: part.generatedAt,
			error: part.error,
			returned: part.hits.length,
		});
		if (!part.ok && part.error) errors.push(part.error);
		for (const hit of part.hits) {
			const key = `${hit.registry}:${hit.entity}:${hit.crd}`;
			if (seen.has(key)) continue;
			seen.add(key);
			hits.push(hit);
		}
	}

	hits.sort((a, b) => {
		const ac = a.connectionCount ?? -1;
		const bc = b.connectionCount ?? -1;
		if (bc !== ac) return bc - ac;
		return a.name.localeCompare(b.name);
	});

	const trimmed = hits.slice(0, limit);
	const anyOk = settled.some((s) => s.ok);

	return {
		ok: anyOk,
		result: {
			ok: anyOk,
			query,
			registry,
			entity,
			origin: getFinraAppOrigin(),
			source: 'prod search-index sidecar via /api/finra/search (+ sec-search)',
			note:
				'This searches the full shipped FINRA/SEC CRD flat-file index on the visualizer host — not only nodes currently on the canvas.',
			returned: trimmed.length,
			hits: trimmed.map((h) => ({
				registry: h.registry,
				entity: h.entity,
				crd: h.crd,
				name: h.name,
				display: `${h.name} :: CRD# ${h.crd}`,
				otherNames: h.otherNames,
				scope: h.scope,
				disclosureFlag: h.disclosureFlag,
				employments: h.employments,
				connectionCount: h.connectionCount,
			})),
			sources,
			errors: errors.length ? errors.slice(0, 4) : undefined,
			hint: anyOk
				? undefined
				: 'Prod search failed. Check FINRA app origin / network, or use inspect_canvas_graph for on-screen nodes only.',
		},
	};
}
