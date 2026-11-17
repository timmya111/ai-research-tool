/**
 * Smoke: aggregate Bryan filings, write SVG under .data/charts, print imageUrl.
 * No @/ aliases — mirrors src/lib/research/charts for plain Node.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DB = path.join(ROOT, '.data', 'knowledge', 'knowledge.sqlite');
const CHARTS = path.join(ROOT, '.data', 'charts');
const PROJECT = '199d9620-7323-4b87-beaf-a523690cda7e';

function parseRecorded(raw) {
	const m = raw.match(/- Recorded:\s*(.+)/i);
	if (!m) return null;
	const d = new Date(m[1].replace(/\s+at\s+.*/i, '').trim());
	return Number.isNaN(d.getTime()) ? null : d;
}

function parseType(raw, title) {
	const m = raw.match(/- Type:\s*(.+)/i);
	if (m && m[1].trim()) return m[1].trim();
	const t = String(title || '').match(/^(.+?)\s+I-\d+/i);
	return t ? t[1].trim() : 'UNKNOWN';
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderSvg(title, subtitle, buckets) {
	const width = 900;
	const height = 420;
	const padL = 56;
	const padR = 24;
	const padT = 64;
	const padB = 72;
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const maxVal = Math.max(1, ...buckets.map((b) => b.count));
	const n = Math.max(1, buckets.length);
	const gap = Math.min(12, plotW / n / 4);
	const barW = Math.max(4, (plotW - gap * (n + 1)) / n);
	const bars = buckets
		.map((b, i) => {
			const h = (b.count / maxVal) * plotH;
			const x = padL + gap + i * (barW + gap);
			const y = padT + plotH - h;
			return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, h)}" rx="3" fill="#F97316"/><text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="#334155">${b.count}</text><text x="${x + barW / 2}" y="${padT + plotH + 18}" text-anchor="middle" font-size="11" fill="#475569">${escapeXml(b.label)}</text>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${padL}" y="28" font-size="18" font-weight="600" fill="#0f172a">${escapeXml(title)}</text>
  <text x="${padL}" y="48" font-size="12" fill="#64748b">${escapeXml(subtitle)}</text>
  ${bars}
</svg>`;
}

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db
	.prepare(
		`SELECT title, raw_text FROM documents WHERE project_id = ? AND raw_text LIKE '%Bryan County real-time filing%'`,
	)
	.all(PROJECT);

const byMonth = new Map();
for (const row of rows) {
	const d = parseRecorded(row.raw_text);
	if (!d) continue;
	const key = d.toISOString().slice(0, 7);
	byMonth.set(key, (byMonth.get(key) || 0) + 1);
}
const buckets = [...byMonth.entries()]
	.sort((a, b) => (a[0] < b[0] ? -1 : 1))
	.map(([key, count]) => ({ label: key, count }));

fs.mkdirSync(CHARTS, { recursive: true, mode: 0o700 });
const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const file = path.join(CHARTS, `${id}.svg`);
const title = 'Bryan County filings by month';
const subtitle = `${rows.length} filing notes scanned · smoke`;
fs.writeFileSync(file, renderSvg(title, subtitle, buckets), 'utf8');

console.log(
	JSON.stringify(
		{
			ok: true,
			chartId: id,
			imageUrl: `/api/charts/${id}`,
			file,
			buckets,
			scanned: rows.length,
		},
		null,
		2,
	),
);
