import { getKnowledgeDb } from '@/lib/research/knowledge/db';

export type ChartPeriod = 'day' | 'week' | 'month';
export type ChartKind = 'volume' | 'by_type';

export type AggregateOptions = {
	projectId: string;
	period?: ChartPeriod;
	kind?: ChartKind;
	from?: string | null;
	to?: string | null;
	docType?: string | null;
	/** Max buckets for volume charts (default 36). */
	limitBuckets?: number;
	/** Max type bars for by_type charts (default 15). */
	limitTypes?: number;
};

export type AggregateBucket = {
	label: string;
	key: string;
	count: number;
};

export type AggregateResult = {
	kind: ChartKind;
	period: ChartPeriod;
	from: string | null;
	to: string | null;
	docType: string | null;
	totalMatched: number;
	totalInProject: number;
	buckets: AggregateBucket[];
	title: string;
	subtitle: string;
};

type FilingRow = {
	raw_text: string;
	metadata_json: string;
	title: string;
};

function parseRecordedDate(raw: string): Date | null {
	const recM = raw.match(/- Recorded:\s*(.+)/i);
	if (!recM) return null;
	const cleaned = recM[1].replace(/\s+at\s+.*/i, '').trim();
	if (!cleaned || /^unknown$/i.test(cleaned)) return null;
	const d = new Date(cleaned);
	if (Number.isNaN(d.getTime())) return null;
	return d;
}

function parseDocType(raw: string, title: string, metadataJson: string): string {
	try {
		const meta = JSON.parse(metadataJson || '{}') as { docType?: string };
		if (meta.docType && String(meta.docType).trim()) return String(meta.docType).trim();
	} catch {
		/* ignore */
	}
	const typeM = raw.match(/- Type:\s*(.+)/i);
	if (typeM && typeM[1].trim() && !/^unknown$/i.test(typeM[1].trim())) {
		return typeM[1].trim();
	}
	const titleM = String(title || '').match(/^(.+?)\s+I-\d+/i);
	if (titleM) return titleM[1].trim();
	return 'UNKNOWN';
}

function toDayKey(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function toMonthKey(d: Date): string {
	return d.toISOString().slice(0, 7);
}

/** ISO week key YYYY-Www (UTC Monday-based). */
function toWeekKey(d: Date): string {
	const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const day = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function periodKey(d: Date, period: ChartPeriod): string {
	if (period === 'day') return toDayKey(d);
	if (period === 'week') return toWeekKey(d);
	return toMonthKey(d);
}

function formatPeriodLabel(key: string, period: ChartPeriod): string {
	if (period === 'month') {
		const [y, m] = key.split('-');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const mi = Number(m) - 1;
		if (y && mi >= 0 && mi < 12) return `${months[mi]} ${y}`;
	}
	if (period === 'week') return key.replace('-W', ' W');
	return key;
}

function parseBound(raw: string | null | undefined, endOfDay: boolean): Date | null {
	const s = String(raw || '').trim();
	if (!s) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		return new Date(endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`);
	}
	if (/^\d{4}-\d{2}$/.test(s)) {
		const [y, m] = s.split('-').map(Number);
		if (endOfDay) return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
		return new Date(Date.UTC(y, m - 1, 1));
	}
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

function loadFilingRows(projectId: string): { rows: FilingRow[]; totalInProject: number } {
	const db = getKnowledgeDb();
	const totalRow = db
		.prepare('SELECT COUNT(*) AS c FROM documents WHERE project_id = ?')
		.get(projectId) as { c?: number } | undefined;
	const totalInProject = Number(totalRow?.c || 0);

	const rows = db
		.prepare(
			`SELECT title, raw_text, metadata_json
       FROM documents
       WHERE project_id = ?
         AND (
           raw_text LIKE '%Bryan County real-time filing%'
           OR metadata_json LIKE '%"kind":"bryan-filing"%'
         )`,
		)
		.all(projectId) as FilingRow[];

	return { rows, totalInProject };
}

/**
 * Aggregate Bryan County filings from the knowledge store by recorded date / type.
 */
export function aggregateBryanFilings(options: AggregateOptions): AggregateResult {
	const period: ChartPeriod =
		options.period === 'day' || options.period === 'week' || options.period === 'month'
			? options.period
			: 'month';
	const kind: ChartKind = options.kind === 'by_type' ? 'by_type' : 'volume';
	const fromDate = parseBound(options.from, false);
	const toDate = parseBound(options.to, true);
	const docTypeFilter = String(options.docType || '')
		.trim()
		.toUpperCase();
	const limitBuckets = Math.max(1, Math.min(60, Number(options.limitBuckets) || 36));
	const limitTypes = Math.max(1, Math.min(30, Number(options.limitTypes) || 15));

	const { rows, totalInProject } = loadFilingRows(options.projectId);
	const counts = new Map<string, number>();
	let totalMatched = 0;

	for (const row of rows) {
		const raw = String(row.raw_text || '');
		const docType = parseDocType(raw, row.title, row.metadata_json);
		if (docTypeFilter && docType.toUpperCase() !== docTypeFilter) continue;

		const recorded = parseRecordedDate(raw);
		if (!recorded) continue;
		if (fromDate && recorded < fromDate) continue;
		if (toDate && recorded > toDate) continue;

		totalMatched += 1;
		const key = kind === 'by_type' ? docType : periodKey(recorded, period);
		counts.set(key, (counts.get(key) || 0) + 1);
	}

	let buckets: AggregateBucket[];
	if (kind === 'by_type') {
		buckets = [...counts.entries()]
			.map(([key, count]) => ({ key, label: key, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limitTypes);
	} else {
		buckets = [...counts.entries()]
			.map(([key, count]) => ({ key, label: formatPeriodLabel(key, period), count }))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		if (buckets.length > limitBuckets) {
			buckets = buckets.slice(buckets.length - limitBuckets);
		}
	}

	const rangeLabel =
		fromDate || toDate
			? `${fromDate ? fromDate.toISOString().slice(0, 10) : '…'} → ${toDate ? toDate.toISOString().slice(0, 10) : '…'}`
			: 'all recorded dates in store';
	const typeLabel = docTypeFilter ? `type ${docTypeFilter}` : 'all types';

	const title =
		kind === 'by_type'
			? `Bryan County filings by type`
			: `Bryan County filings by ${period}`;
	const subtitle = `${totalMatched.toLocaleString()} filings · ${typeLabel} · ${rangeLabel}`;

	return {
		kind,
		period,
		from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
		to: toDate ? toDate.toISOString().slice(0, 10) : null,
		docType: docTypeFilter || null,
		totalMatched,
		totalInProject,
		buckets,
		title,
		subtitle,
	};
}
