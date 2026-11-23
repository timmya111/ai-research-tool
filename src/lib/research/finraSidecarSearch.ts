import { finraApiUrl, getFinraAppOrigin } from '@/lib/research/finraApp';

export type FinraSidecarRegistry = 'finra' | 'sec' | 'both';
export type FinraSidecarEntity = 'individual' | 'firm' | 'both';

export type FinraSidecarEmployment = {
	firmId?: string;
	firmName?: string;
	begin?: string;
	end?: string;
	iaOnly?: string;
	firmBCScope?: string;
	firmIAScope?: string;
	bdSECNumber?: string;
	iaSECNumber?: string;
	city?: string;
	state?: string;
	branch?: string;
	source: 'current' | 'currentIA' | 'previous' | 'previousIA';
};

export type FinraSidecarHit = {
	registry: 'finra' | 'sec';
	entity: 'individual' | 'firm';
	crd: string;
	name: string;
	otherNames?: string[];
	scope?: string;
	bcScope?: string;
	iaScope?: string;
	disclosureFlag?: string;
	employments?: FinraSidecarEmployment[];
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

function mapSidecarEmployment(
	row: unknown,
	source: FinraSidecarEmployment['source'],
): FinraSidecarEmployment | null {
	const er = asRecord(row);
	if (!er) return null;
	const firmId = pickString(er.firmId, er.firm_id);
	const firmName = pickString(er.firmName, er.firm_name);
	if (!firmId && !firmName) return null;

	let city = pickString(er.city) || undefined;
	let state = pickString(er.state) || undefined;
	let branch: string | undefined;
	const branches = er.branchOfficeLocations;
	if (Array.isArray(branches) && branches.length) {
		const b0 = asRecord(branches[0]) || {};
		city = city || pickString(b0.city) || undefined;
		state = state || pickString(b0.state) || undefined;
		const parts = [b0.street1, b0.street2, b0.city, b0.state, b0.zipCode]
			.map((x) => String(x ?? '').trim())
			.filter(Boolean);
		if (parts.length) branch = parts.join(', ');
	}

	return {
		firmId: firmId || undefined,
		firmName: firmName || undefined,
		begin: pickString(er.registrationBeginDate, er.beginDate, er.startDate) || undefined,
		end: pickString(er.registrationEndDate, er.endDate) || undefined,
		iaOnly: pickString(er.iaOnly) || undefined,
		firmBCScope: pickString(er.firmBCScope) || undefined,
		firmIAScope: pickString(er.firmIAScope) || undefined,
		bdSECNumber: pickString(er.bdSECNumber) || undefined,
		iaSECNumber: pickString(er.iaSECNumber) || undefined,
		city,
		state,
		branch,
		source,
	};
}

function collectEmployments(...groups: Array<{ rows: unknown; source: FinraSidecarEmployment['source'] }>): FinraSidecarEmployment[] {
	const out: FinraSidecarEmployment[] = [];
	const seen = new Set<string>();
	for (const group of groups) {
		if (!Array.isArray(group.rows)) continue;
		for (const row of group.rows) {
			const mapped = mapSidecarEmployment(row, group.source);
			if (!mapped) continue;
			const key = `${mapped.firmId || ''}|${mapped.firmName || ''}|${mapped.begin || ''}|${mapped.source}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(mapped);
		}
	}
	return out;
}

function compactIndividual(row: Record<string, unknown>, registry: 'finra' | 'sec'): FinraSidecarHit | null {
	const basic = asRecord(row.basicInformation) || row;
	const crd = pickString(
		basic.individualId,
		basic.ind_crd,
		basic.ind_source_id,
		basic.crd,
		row.ind_source_id,
		row.ind_crd,
		row._id,
	);
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

	// Prod search + merged/individual put employments on the hit root (siblings of basicInformation),
	// not as ind_current_employments inside basicInformation.
	const employments = collectEmployments(
		{ rows: row.currentEmployments ?? basic.currentEmployments ?? basic.ind_current_employments, source: 'current' },
		{ rows: row.currentIAEmployments ?? basic.currentIAEmployments ?? basic.ind_ia_current_employments, source: 'currentIA' },
		{ rows: row.previousEmployments ?? basic.previousEmployments, source: 'previous' },
		{ rows: row.previousIAEmployments ?? basic.previousIAEmployments, source: 'previousIA' },
	);

	const connectionCount = Number(
		basic.ind_connection_count ?? row.ind_connection_count ?? row.knownConnectionCount,
	);
	const bcScope = pickString(basic.bcScope, basic.ind_bc_scope) || undefined;
	const iaScope = pickString(basic.iaScope, basic.ind_ia_scope) || undefined;
	return {
		registry,
		entity: 'individual',
		crd,
		name,
		otherNames,
		scope: bcScope || iaScope || pickString(basic.bc_scope) || undefined,
		bcScope,
		iaScope,
		disclosureFlag:
			pickString(row.disclosureFlag, basic.disclosureFlag, row.iaDisclosureFlag, basic.iaDisclosureFlag) ||
			undefined,
		employments: employments.length ? employments : undefined,
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
		row.firm_source_id,
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
	const bcScope = pickString(basic.bcScope, basic.firmBCScope, basic.firm_bc_scope, basic.bc_scope) || undefined;
	const iaScope = pickString(basic.iaScope, basic.firmIAScope, basic.firm_ia_scope) || undefined;
	return {
		registry,
		entity: 'firm',
		crd,
		name,
		otherNames,
		scope: bcScope || iaScope || undefined,
		bcScope,
		iaScope,
		disclosureFlag:
			pickString(row.disclosureFlag, basic.disclosureFlag, row.iaDisclosureFlag, basic.iaDisclosureFlag) ||
			undefined,
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

async function fetchJson(
	url: string,
	timeoutMs = 45_000,
): Promise<{ ok: boolean; status: number; payload: unknown; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			cache: 'no-store',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return { ok: false, status: res.status, payload: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
		}
		return { ok: true, status: res.status, payload: await res.json() };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 0, payload: null, error: message };
	} finally {
		clearTimeout(timer);
	}
}

function normalizeCrdQuery(query: string): string | null {
	const digits = String(query || '')
		.trim()
		.replace(/^CRD[#:\s]*/i, '')
		.replace(/[^\d]/g, '');
	return /^\d{4,10}$/.test(digits) ? digits : null;
}

function formatCrdDisplay(hit: Pick<FinraSidecarHit, 'name' | 'entity' | 'crd'>): string {
	const kind = hit.entity === 'firm' ? 'Firm CRD#' : 'Individual CRD#';
	return `${hit.name} :: ${kind} ${hit.crd}`;
}

/**
 * Full employment detail for a person CRD from the visualizer merged individual API
 * (same payload as /api/finra/merged/individual/{crd}).
 */
async function fetchMergedIndividualHit(
	crd: string,
	registry: 'finra' | 'sec' = 'finra',
): Promise<{ ok: boolean; hit: FinraSidecarHit | null; url: string; error?: string }> {
	const url = finraApiUrl(`/api/finra/merged/individual/${crd}`);
	const res = await fetchJson(url);
	if (!res.ok) {
		return { ok: false, hit: null, url, error: res.error };
	}
	const root = asRecord(res.payload) || {};
	if (root.found === false) {
		return { ok: false, hit: null, url, error: 'merged individual not found' };
	}
	// Prefer merged (BC+IA combined) over finraNode alone — matches the site API the UI uses.
	const node =
		asRecord(root.merged) ||
		asRecord(root.finraNode) ||
		(root.basicInformation || root.currentEmployments ? root : null);
	if (!node) {
		return { ok: false, hit: null, url, error: 'merged individual payload missing' };
	}
	const hit = compactIndividual(node, registry);
	return { ok: Boolean(hit), hit, url };
}

/**
 * Firm dossier for a firm CRD from the visualizer merged firm API
 * (same payload as /api/finra/merged/firm/{crd} / dashboard/firm/{crd}).
 * Firm and individual CRD namespaces overlap numerically — never treat a firm
 * hit as a person (or the reverse) without checking this endpoint.
 */
async function fetchMergedFirmHit(
	crd: string,
	registry: 'finra' | 'sec' = 'finra',
): Promise<{ ok: boolean; hit: FinraSidecarHit | null; url: string; error?: string }> {
	const url = finraApiUrl(`/api/finra/merged/firm/${crd}`);
	const res = await fetchJson(url);
	if (!res.ok) {
		return { ok: false, hit: null, url, error: res.error };
	}
	const root = asRecord(res.payload) || {};
	if (root.found === false) {
		return { ok: false, hit: null, url, error: 'merged firm not found' };
	}
	const node =
		asRecord(root.merged) ||
		asRecord(root.finraNode) ||
		(root.basicInformation ? root : null);
	if (!node) {
		return { ok: false, hit: null, url, error: 'merged firm payload missing' };
	}
	const hit = compactFirm(node, registry);
	if (!hit) return { ok: false, hit: null, url, error: 'merged firm compact failed' };
	const basic = asRecord(node.basicInformation) || node;
	hit.bcScope = hit.bcScope || pickString(basic.bcScope, basic.firmBCScope) || undefined;
	hit.iaScope = hit.iaScope || pickString(basic.iaScope, basic.firmIAScope) || undefined;
	hit.scope = hit.scope || hit.bcScope || hit.iaScope;
	hit.disclosureFlag =
		hit.disclosureFlag ||
		pickString(node.disclosureFlag, node.iaDisclosureFlag, basic.disclosureFlag, basic.iaDisclosureFlag) ||
		undefined;
	return { ok: true, hit, url };
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
	try {
		const res = await fetchJson(url);
		if (!res.ok) {
			return {
				ok: false,
				hits: [],
				error: res.error || `HTTP ${res.status}`,
				url,
			};
		}
		const payload = res.payload;
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
	const crdQuery = normalizeCrdQuery(query);

	const hits: FinraSidecarHit[] = [];
	const seen = new Set<string>();
	const errors: string[] = [];
	const sources: Array<Record<string, unknown>> = [];

	// Numeric CRD → probe firm and individual merged APIs separately.
	// The same digits can be a Firm CRD (dashboard/firm/{crd}) or an Individual CRD
	// (dashboard/individual/{crd}); never assume one without checking.
	if (crdQuery) {
		const mergedCalls: Array<Promise<{
			kind: 'merged-individual' | 'merged-firm';
			res: { ok: boolean; hit: FinraSidecarHit | null; url: string; error?: string };
		}>> = [];
		if (entity === 'both' || entity === 'individual') {
			mergedCalls.push(
				fetchMergedIndividualHit(crdQuery, 'finra').then((res) => ({
					kind: 'merged-individual' as const,
					res,
				})),
			);
		}
		if (entity === 'both' || entity === 'firm') {
			mergedCalls.push(
				fetchMergedFirmHit(crdQuery, 'finra').then((res) => ({
					kind: 'merged-firm' as const,
					res,
				})),
			);
		}
		const mergedSettled = await Promise.all(mergedCalls);
		for (const part of mergedSettled) {
			sources.push({
				url: part.res.url,
				ok: part.res.ok,
				total: part.res.hit ? 1 : 0,
				error: part.res.error,
				returned: part.res.hit ? 1 : 0,
				kind: part.kind,
				entity: part.kind === 'merged-firm' ? 'firm' : 'individual',
				crd: crdQuery,
			});
			if (part.res.ok && part.res.hit) {
				const key = `${part.res.hit.registry}:${part.res.hit.entity}:${part.res.hit.crd}`;
				if (!seen.has(key)) {
					seen.add(key);
					hits.push(part.res.hit);
				}
			} else if (part.res.error && part.res.error !== 'merged individual not found' && part.res.error !== 'merged firm not found') {
				errors.push(part.res.error);
			}
		}
	}

	const registries: Array<'finra' | 'sec'> =
		registry === 'both' ? ['finra', 'sec'] : [registry];
	// When merged firm/individual already resolved this exact CRD, skip redundant
	// digit text-search for that entity (loose digit queries return unrelated hits).
	const mergedResolvedIndividual = Boolean(
		crdQuery && hits.some((h) => h.entity === 'individual' && h.crd === crdQuery),
	);
	const mergedResolvedFirm = Boolean(
		crdQuery && hits.some((h) => h.entity === 'firm' && h.crd === crdQuery),
	);
	const entities: Array<'individual' | 'firm'> = (
		entity === 'both' ? (['individual', 'firm'] as const) : ([entity] as const)
	).filter(
		(ent) =>
			!(mergedResolvedIndividual && ent === 'individual') &&
			!(mergedResolvedFirm && ent === 'firm'),
	) as Array<'individual' | 'firm'>;

	const perCallLimit = Math.max(3, Math.ceil(limit / Math.max(1, entities.length || 1)));
	const calls =
		entities.length === 0
			? []
			: registries.flatMap((reg) =>
					entities.map((ent) => queryOne({ registry: reg, entity: ent, query, limit: perCallLimit })),
				);
	const settled = await Promise.all(calls);

	for (const part of settled) {
		sources.push({
			url: part.url,
			ok: part.ok,
			total: part.total,
			generatedAt: part.generatedAt,
			error: part.error,
			returned: part.hits.length,
			kind: 'search-index',
		});
		if (!part.ok && part.error) errors.push(part.error);
		for (const hit of part.hits) {
			const key = `${hit.registry}:${hit.entity}:${hit.crd}`;
			if (seen.has(key)) {
				// Prefer richer employment already loaded from merged/individual.
				const existing = hits.find((h) => `${h.registry}:${h.entity}:${h.crd}` === key);
				if (
					existing &&
					(!existing.employments || existing.employments.length === 0) &&
					hit.employments &&
					hit.employments.length > 0
				) {
					existing.employments = hit.employments;
					existing.otherNames = existing.otherNames?.length ? existing.otherNames : hit.otherNames;
					existing.bcScope = existing.bcScope || hit.bcScope;
					existing.iaScope = existing.iaScope || hit.iaScope;
					existing.scope = existing.scope || hit.scope;
				}
				continue;
			}
			seen.add(key);
			hits.push(hit);
		}
	}

	// For name searches that returned person CRDs with empty/thin employments, fill from merged API (cap 3).
	const toEnrich = hits
		.filter(
			(h) =>
				h.entity === 'individual' &&
				(!h.employments || h.employments.length === 0) &&
				/^\d{4,10}$/.test(h.crd) &&
				h.crd !== crdQuery,
		)
		.slice(0, 3);
	await Promise.all(
		toEnrich.map(async (h) => {
			const merged = await fetchMergedIndividualHit(h.crd, h.registry);
			sources.push({
				url: merged.url,
				ok: merged.ok,
				error: merged.error,
				returned: merged.hit?.employments?.length || 0,
				kind: 'merged-individual-enrich',
				crd: h.crd,
			});
			if (merged.hit?.employments?.length) {
				h.employments = merged.hit.employments;
				h.otherNames = h.otherNames?.length ? h.otherNames : merged.hit.otherNames;
				h.bcScope = h.bcScope || merged.hit.bcScope;
				h.iaScope = h.iaScope || merged.hit.iaScope;
				h.scope = h.scope || merged.hit.scope;
				h.disclosureFlag = h.disclosureFlag || merged.hit.disclosureFlag;
				if (merged.hit.name && merged.hit.name !== `Individual ${h.crd}`) {
					h.name = merged.hit.name;
				}
			}
		}),
	);

	hits.sort((a, b) => {
		if (crdQuery) {
			const aExact = a.crd === crdQuery ? 1 : 0;
			const bExact = b.crd === crdQuery ? 1 : 0;
			if (bExact !== aExact) return bExact - aExact;
		}
		// Prefer labeling firm vs individual clearly when both match the same digits
		if (crdQuery && a.crd === crdQuery && b.crd === crdQuery && a.entity !== b.entity) {
			return a.entity === 'firm' ? -1 : 1;
		}
		const aEmp = a.employments?.length ?? 0;
		const bEmp = b.employments?.length ?? 0;
		if (bEmp !== aEmp) return bEmp - aEmp;
		const ac = a.connectionCount ?? -1;
		const bc = b.connectionCount ?? -1;
		if (bc !== ac) return bc - ac;
		return a.name.localeCompare(b.name);
	});

	const trimmed = hits.slice(0, limit);
	const anyOk = settled.some((s) => s.ok) || trimmed.length > 0;
	const resolvedKinds = [
		...new Set(trimmed.filter((h) => !crdQuery || h.crd === crdQuery).map((h) => h.entity)),
	];

	return {
		ok: anyOk,
		result: {
			ok: anyOk,
			query,
			registry,
			entity,
			origin: getFinraAppOrigin(),
			source:
				'prod search-index sidecar via /api/finra/search (+ sec-search); numeric CRDs resolved via /api/finra/merged/firm/{crd} and /api/finra/merged/individual/{crd} separately',
			note:
				'Firm CRDs and Individual CRDs are distinct namespaces that share the same numeric format. Hits are labeled entity=firm|individual. Firm detail matches dashboard/firm/{crd}; individual employment detail matches merged/individual (current + IA + previous, dates, branches).',
			crdEntityResolved: crdQuery
				? {
						crd: crdQuery,
						firm: resolvedKinds.includes('firm'),
						individual: resolvedKinds.includes('individual'),
					}
				: undefined,
			returned: trimmed.length,
			hits: trimmed.map((h) => ({
				registry: h.registry,
				entity: h.entity,
				crd: h.crd,
				crdKind: h.entity === 'firm' ? 'firm' : 'individual',
				name: h.name,
				display: formatCrdDisplay(h),
				dashboardPath:
					h.entity === 'firm'
						? `/dashboard/firm/${h.crd}`
						: `/dashboard/individual/${h.crd}`,
				otherNames: h.otherNames,
				scope: h.scope,
				bcScope: h.bcScope,
				iaScope: h.iaScope,
				disclosureFlag: h.disclosureFlag,
				employmentCount: h.employments?.length || 0,
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
