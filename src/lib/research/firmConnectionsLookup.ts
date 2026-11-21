/**
 * Firm ↔ broker CRD roster from the live FINRA SEC visualizer API
 * (`GET /api/finra/firm/{id}/connections`). No canvas / node-graph required.
 */
import fs from 'fs';
import path from 'path';
import { finraApiUrl, getFinraAppOrigin } from '@/lib/research/finraApp';
import { searchFinraSidecar } from '@/lib/research/finraSidecarSearch';

export type FirmConnectionPerson = {
	crd: string;
	name: string;
	display: string;
	isCurrent: boolean;
	relationship?: string;
	bcScope?: string;
	iaScope?: string;
	address?: string;
};

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

function normalizeCrd(raw: unknown): string {
	return String(raw ?? '')
		.trim()
		.replace(/^CRD[#:\s]*/i, '')
		.replace(/[^\d]/g, '');
}

function clampLimit(n: unknown, fallback = 80): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(500, Math.floor(v)));
}

function mapPerson(row: unknown, isCurrentFallback: boolean): FirmConnectionPerson | null {
	const er = asRecord(row);
	if (!er) return null;
	const crd = pickString(er.individualId, er.ind_crd, er.crd, er.id);
	if (!crd) return null;
	const name = pickString(er.name, er.ind_name, er.fullName) || `Individual ${crd}`;
	const isCurrent =
		typeof er.isCurrent === 'boolean'
			? er.isCurrent
			: /current/i.test(pickString(er.relationship)) || isCurrentFallback;
	return {
		crd,
		name,
		display: `${name} :: CRD# ${crd}`,
		isCurrent,
		relationship: pickString(er.relationship) || undefined,
		bcScope: pickString(er.bcScope, er.ind_bc_scope) || undefined,
		iaScope: pickString(er.iaScope, er.ind_ia_scope) || undefined,
		address: pickString(er.address) || undefined,
	};
}

function rosterDir(): string {
	return path.join(process.cwd(), '.data', 'finra-rosters');
}

function writeFullRoster(firmId: string, firmName: string | undefined, people: FirmConnectionPerson[]) {
	const dir = rosterDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const filePath = path.join(dir, `firm-${firmId}-connections.json`);
	const payload = {
		firmId,
		firmName: firmName || null,
		generatedAt: new Date().toISOString(),
		source: finraApiUrl(`/api/finra/firm/${firmId}/connections`),
		total: people.length,
		currentCount: people.filter((p) => p.isCurrent).length,
		previousCount: people.filter((p) => !p.isCurrent).length,
		people: people.map((p) => ({
			crd: p.crd,
			name: p.name,
			display: p.display,
			isCurrent: p.isCurrent,
			relationship: p.relationship,
			bcScope: p.bcScope,
			iaScope: p.iaScope,
			address: p.address,
		})),
	};
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
	const mdPath = path.join(dir, `firm-${firmId}-connections.md`);
	const lines = [
		`# Firm CRD ${firmId}${firmName ? ` — ${firmName}` : ''} connections`,
		``,
		`Source: ${payload.source}`,
		`Generated: ${payload.generatedAt}`,
		`Totals: ${payload.currentCount} current · ${payload.previousCount} previous · ${payload.total} combined`,
		``,
		`## Current`,
		...people.filter((p) => p.isCurrent).map((p) => `- ${p.display}${p.bcScope ? ` (${p.bcScope})` : ''}`),
		``,
		`## Previous`,
		...people.filter((p) => !p.isCurrent).map((p) => `- ${p.display}${p.bcScope ? ` (${p.bcScope})` : ''}`),
		``,
	];
	fs.writeFileSync(mdPath, lines.join('\n'));
	return { jsonPath: filePath, mdPath };
}

async function resolveFirmName(firmId: string): Promise<string | undefined> {
	try {
		const searched = await searchFinraSidecar({
			query: firmId,
			registry: 'both',
			entity: 'firm',
			limit: 5,
		});
		const hits = Array.isArray(searched.result?.hits) ? (searched.result.hits as Array<Record<string, unknown>>) : [];
		const exact = hits.find((h) => String(h.crd || '') === firmId && h.entity === 'firm');
		const name = pickString(exact?.name, hits[0]?.name);
		return name || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Look up all broker CRD connections for a firm from the live visualizer API.
 */
export async function lookupFirmConnections(args: {
	firmCrd?: string;
	bucket?: string;
	limit?: number;
	offset?: number;
	query?: string;
	saveFull?: boolean;
}): Promise<{ ok: boolean; result: Record<string, unknown> }> {
	const firmId = normalizeCrd(args.firmCrd);
	if (!/^\d{4,10}$/.test(firmId)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'firmCrd must be a numeric firm CRD (4–10 digits)',
			},
		};
	}

	const bucketRaw = String(args.bucket || 'all').trim().toLowerCase();
	const bucket = bucketRaw === 'current' || bucketRaw === 'previous' ? bucketRaw : 'all';
	const limit = clampLimit(args.limit, 50);
	const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
	const query = String(args.query || '')
		.trim()
		.toLowerCase();
	const saveFull = args.saveFull !== false;

	const url = finraApiUrl(`/api/finra/firm/${firmId}/connections?bucket=${bucket}&light=1`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 90_000);
	let payload: unknown = null;
	try {
		const res = await fetch(url, {
			method: 'GET',
			cache: 'no-store',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});
		const text = await res.text();
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			return {
				ok: false,
				result: { ok: false, firmId, error: `non-JSON from connections API`, status: res.status, url },
			};
		}
		if (!res.ok) {
			return {
				ok: false,
				result: {
					ok: false,
					firmId,
					error: `HTTP ${res.status}`,
					status: res.status,
					url,
				},
			};
		}
	} catch (error: unknown) {
		return {
			ok: false,
			result: {
				ok: false,
				firmId,
				error: error instanceof Error ? error.message : String(error),
				url,
			},
		};
	} finally {
		clearTimeout(timer);
	}

	const root = asRecord(payload) || {};
	const currentRaw = Array.isArray(root.currentConnections) ? root.currentConnections : [];
	const previousRaw = Array.isArray(root.previousConnections) ? root.previousConnections : [];
	const people: FirmConnectionPerson[] = [];
	const seen = new Set<string>();
	for (const row of currentRaw) {
		const p = mapPerson(row, true);
		if (!p || seen.has(p.crd)) continue;
		seen.add(p.crd);
		people.push({ ...p, isCurrent: true });
	}
	for (const row of previousRaw) {
		const p = mapPerson(row, false);
		if (!p || seen.has(p.crd)) continue;
		seen.add(p.crd);
		people.push({ ...p, isCurrent: false });
	}

	let filtered = people;
	if (bucket === 'current') filtered = people.filter((p) => p.isCurrent);
	if (bucket === 'previous') filtered = people.filter((p) => !p.isCurrent);
	if (query) {
		filtered = filtered.filter(
			(p) =>
				p.name.toLowerCase().includes(query) ||
				p.crd.includes(query) ||
				(p.address || '').toLowerCase().includes(query),
		);
	}

	filtered.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	const firmName = await resolveFirmName(firmId);
	let saved: { jsonPath: string; mdPath: string } | null = null;
	if (saveFull && people.length) {
		try {
			saved = writeFullRoster(firmId, firmName, people);
		} catch (error: unknown) {
			saved = null;
			console.error('[firmConnectionsLookup] save failed', error);
		}
	}

	const page = filtered.slice(offset, offset + limit);
	const truncated = offset + page.length < filtered.length;

	return {
		ok: true,
		result: {
			ok: true,
			firmId,
			firmName: firmName || null,
			display: firmName ? `${firmName} :: CRD# ${firmId}` : `Firm :: CRD# ${firmId}`,
			origin: getFinraAppOrigin(),
			source: url,
			note: 'Roster from live visualizer /api/finra/firm/{id}/connections. Node-graph checkbox is not required.',
			found: root.found !== false,
			bucket,
			totals: {
				current: people.filter((p) => p.isCurrent).length,
				previous: people.filter((p) => !p.isCurrent).length,
				combined: people.length,
				matched: filtered.length,
			},
			offset,
			limit,
			returned: page.length,
			truncated,
			nextOffset: truncated ? offset + page.length : null,
			people: page.map((p) => ({
				crd: p.crd,
				name: p.name,
				display: p.display,
				isCurrent: p.isCurrent,
				relationship: p.relationship,
				bcScope: p.bcScope,
				iaScope: p.iaScope,
				address: p.address,
			})),
			fullRosterJson: saved?.jsonPath || null,
			fullRosterMarkdown: saved?.mdPath || null,
			hint: truncated
				? `Inline list truncated at ${page.length} of ${filtered.length} matched. Call again with offset=${offset + page.length} (and same query/bucket), or open fullRosterMarkdown / fullRosterJson for the complete list.`
				: people.length > page.length && !query
					? 'Full roster also written to fullRosterMarkdown / fullRosterJson.'
					: undefined,
		},
	};
}
