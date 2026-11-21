#!/usr/bin/env node
/**
 * Ingest digests/ into knowledge project "Entity Dossiers".
 * Run `pnpm entities:digest` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'entity-dossiers');
const DIGESTS = path.join(OUT, 'digests');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.ENTITY_PROJECT_NAME || 'Entity Dossiers').trim();
const MAX_CHARS = 47_000;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
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

function listDigests() {
	const files = [];
	if (!fs.existsSync(DIGESTS)) return files;
	const overview = path.join(DIGESTS, 'OVERVIEW.md');
	if (fs.existsSync(overview)) files.push(overview);
	const edges = path.join(DIGESTS, 'edges.md');
	if (fs.existsSync(edges)) files.push(edges);
	for (const name of fs.readdirSync(DIGESTS).sort()) {
		if (!name.endsWith('.md')) continue;
		if (name === 'OVERVIEW.md' || name === 'edges.md') continue;
		files.push(path.join(DIGESTS, name));
	}
	return files;
}

function truncate(text) {
	const t = String(text || '');
	if (t.length <= MAX_CHARS) return t;
	return `${t.slice(0, MAX_CHARS - 40)}\n\n…[truncated]`;
}

async function main() {
	const files = listDigests();
	if (!files.length) {
		console.error('No digests — run pnpm entities:digest first');
		process.exit(1);
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
		const text = truncate(fs.readFileSync(file, 'utf8'));
		const title =
			text
				.split('\n')
				.find((l) => l.startsWith('# '))
				?.replace(/^#\s+/, '')
				.slice(0, 120) || path.basename(file);
		await api('/api/knowledge', {
			method: 'POST',
			body: { projectId, title, text, sourceType: 'note', uri: `file://${file}` },
		});
		ok += 1;
		await sleep(50);
	}
	console.log(`[entities:ingest] digests=${files.length} ingested=${ok} project=${PROJECT_NAME} id=${projectId}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
