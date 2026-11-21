#!/usr/bin/env node
/**
 * Build digests from dossiers + ingest into knowledge project "Entity Dossiers".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'entity-dossiers');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.ENTITY_PROJECT_NAME || 'Entity Dossiers').trim();
const MAX_CHARS = 47_000;

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

async function api(pathname, { method = 'GET', body } = {}) {
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) throw new Error(data?.error || `${method} ${pathname} → ${res.status}`);
	return data;
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
			(b) => `- ${b.name}${b.role ? ` (${b.role})` : ''}${b.ticker ? ` [${b.ticker}]` : ''}${b.cik ? ` CIK=${b.cik}` : ''}`,
		),
		'',
		'## Geos',
		...(d.geos || []).map((g) => `- ${[g.city, g.county, g.state, g.label].filter(Boolean).join(' · ')}`),
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

async function main() {
	ensureDir(path.join(OUT, 'digests'));
	const files = [];
	for (const name of fs.readdirSync(path.join(OUT, 'dossiers'))) {
		if (!name.endsWith('.json')) continue;
		const d = JSON.parse(fs.readFileSync(path.join(OUT, 'dossiers', name), 'utf8'));
		const md = dossierToMd(d);
		const out = path.join(OUT, 'digests', `${d.slug}.md`);
		fs.writeFileSync(out, md);
		files.push(out);
	}

	const listed = await api('/api/knowledge/projects');
	let project = (listed.projects || []).find((p) => String(p.name).toLowerCase() === PROJECT_NAME.toLowerCase());
	if (!project) {
		const created = await api('/api/knowledge/projects', { method: 'POST', body: { name: PROJECT_NAME } });
		project = created.project || created;
	}
	const projectId = project.id || project.projectId;
	let ok = 0;
	for (const file of files) {
		let text = fs.readFileSync(file, 'utf8');
		if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 40) + '\n\n…[truncated]';
		const title = text.split('\n').find((l) => l.startsWith('# '))?.replace(/^#\s+/, '') || path.basename(file);
		await api('/api/knowledge', {
			method: 'POST',
			body: { projectId, title, text, sourceType: 'note', uri: `file://${file}` },
		});
		ok += 1;
	}
	console.log(`[entities:ingest] digests=${files.length} ingested=${ok} project=${PROJECT_NAME}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
