#!/usr/bin/env node
/**
 * Write markdown digests from dossiers/, buckets/, edges.jsonl for knowledge ingest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENT = path.join(ROOT, '.data', 'entity-dossiers');
const DIGESTS = path.join(ENT, 'digests');

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function loadJsonDir(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith('.json')) continue;
		out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
	}
	return out;
}

function dossierToMd(d) {
	const lines = [
		`# ${d.displayName}`,
		'',
		`Slug: \`${d.slug}\` · Kind: ${d.kind} · Status: ${d.status}`,
		'',
		d.summary || '',
		'',
		'## Aliases',
		...(d.aliases || []).map((a) => `- ${a}`),
		'',
		'## Businesses',
		...(d.businesses || []).map(
			(b) =>
				`- ${b.name}${b.role ? ` (${b.role})` : ''}${b.ticker ? ` [${b.ticker}]` : ''}${b.cik ? ` CIK=${b.cik}` : ''}`,
		),
		'',
		'## Geos',
		...(d.geos || []).map((g) => `- ${[g.city, g.county, g.state, g.label].filter(Boolean).join(' · ')}`),
		'',
		'## Related',
		...(d.relatedSlugs || []).map((s) => `- \`${s}\``),
		'',
		'## Links',
		...(d.links || []).map((l) => `- [${l.label}](${l.url})`),
		'',
		'## Sources',
		...(d.sources || []).map((s) => `- ${s.url} (${s.fetchedAt})${s.note ? ` — ${s.note}` : ''}`),
		'',
	];
	return lines.join('\n');
}

function bucketToMd(b) {
	const lines = [
		`# ${b.displayName}`,
		'',
		`Slug: \`${b.slug}\` · Kind: alias_bucket · Token: ${b.token || ''} · Status: ${b.status}`,
		'',
		'## Exclude (already pinned)',
		...(b.excludeSlugs || []).map((s) => `- \`${s}\``),
		'',
		'## Org candidates',
		...(b.orgCandidates || []).map((c) => `- ${typeof c === 'string' ? c : JSON.stringify(c)}`),
		'',
		'## Person candidates',
		...(b.candidates || []).map((c) => `- ${typeof c === 'string' ? c : JSON.stringify(c)}`),
		'',
		'## Sources',
		...(b.sources || []).map((s) => `- ${s.url} (${s.fetchedAt})${s.note ? ` — ${s.note}` : ''}`),
		'',
	];
	return lines.join('\n');
}

function edgesToMd(edges) {
	const byKind = new Map();
	for (const e of edges) {
		byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
	}
	const lines = [
		'# Entity dossier edges',
		'',
		`Total edges: ${edges.length}`,
		'',
		'## By kind',
		...[...byKind.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `- **${k}**: ${n}`),
		'',
		'## Edges',
		...edges.map((e) => {
			const note = e.evidence?.[0]?.note || e.evidence?.[0]?.url || '';
			return `- \`${e.from}\` → \`${e.to}\` (${e.kind})${note ? ` — ${note}` : ''}`;
		}),
		'',
	];
	return lines.join('\n');
}

function main() {
	ensureDir(DIGESTS);
	const dossiers = loadJsonDir(path.join(ENT, 'dossiers'));
	const buckets = loadJsonDir(path.join(ENT, 'buckets'));
	const edges = readJsonl(path.join(ENT, 'edges.jsonl'));
	const now = new Date().toISOString();
	let written = 0;

	for (const d of dossiers) {
		fs.writeFileSync(path.join(DIGESTS, `${d.slug}.md`), dossierToMd(d));
		written += 1;
	}
	for (const b of buckets) {
		fs.writeFileSync(path.join(DIGESTS, `${b.slug}.md`), bucketToMd(b));
		written += 1;
	}
	fs.writeFileSync(path.join(DIGESTS, 'edges.md'), edgesToMd(edges));
	written += 1;

	const kindCounts = {};
	for (const d of dossiers) kindCounts[d.kind] = (kindCounts[d.kind] || 0) + 1;
	const edgeKinds = {};
	for (const e of edges) edgeKinds[e.kind] = (edgeKinds[e.kind] || 0) + 1;

	const overview = [
		'# Entity Dossiers — overview',
		'',
		`Generated: ${now}`,
		`Pinned dossiers: ${dossiers.length}`,
		`Alias buckets: ${buckets.length}`,
		`Edges: ${edges.length}`,
		'',
		'## Dossier kinds',
		...Object.entries(kindCounts)
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `- **${k}**: ${n}`),
		'',
		'## Edge kinds',
		...Object.entries(edgeKinds)
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `- **${k}**: ${n}`),
		'',
		'## Pinned entities',
		...dossiers.map((d) => `- **${d.displayName}** (\`${d.slug}\`) — ${d.kind}`),
		'',
		'## Alias buckets',
		...buckets.map(
			(b) =>
				`- **${b.displayName}** (\`${b.slug}\`) — token \`${b.token || ''}\`; candidates=${(b.candidates || []).length}`,
		),
		'',
		'## Digest files',
		'- `OVERVIEW.md` (this file)',
		'- `edges.md` — full edge list with evidence notes',
		'- `{slug}.md` — one per dossier and bucket',
		'',
	].join('\n');
	fs.writeFileSync(path.join(DIGESTS, 'OVERVIEW.md'), overview);
	written += 1;

	console.log(
		`[entities:digest] dossiers=${dossiers.length} buckets=${buckets.length} edges=${edges.length} files=${written}`,
	);
}

main();
