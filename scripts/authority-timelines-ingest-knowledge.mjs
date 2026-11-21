#!/usr/bin/env node
/**
 * Ingest authority timeline digests into knowledge project "Authority Initiatives".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.data', 'authority-timelines');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.AUTHORITY_PROJECT_NAME || 'Authority Initiatives').trim();
const MAX_CHARS = Number(process.env.AUTHORITY_MAX_CHARS || 47_000);

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
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `${method} ${pathname} → HTTP ${res.status}`);
	}
	return data;
}

function listDigests() {
	const files = [];
	const overview = path.join(DIR, 'digests', 'OVERVIEW.md');
	if (fs.existsSync(overview)) files.push(overview);
	const digests = path.join(DIR, 'digests');
	if (fs.existsSync(digests)) {
		for (const name of fs.readdirSync(digests).sort()) {
			if (name.endsWith('.md')) files.push(path.join(digests, name));
		}
		const geo = path.join(digests, 'geo');
		if (fs.existsSync(geo)) {
			for (const name of fs.readdirSync(geo).sort()) {
				if (name.endsWith('.md')) files.push(path.join(geo, name));
			}
		}
	}
	return [...new Set(files)];
}

function truncate(text) {
	const t = String(text || '');
	if (t.length <= MAX_CHARS) return t;
	return `${t.slice(0, MAX_CHARS - 80)}\n\n…[truncated for knowledge store limit]`;
}

async function ensureProject() {
	const listed = await api('/api/knowledge/projects');
	const existing = (listed.projects || []).find(
		(p) => String(p.name || '').toLowerCase() === PROJECT_NAME.toLowerCase(),
	);
	if (existing) return existing;
	const created = await api('/api/knowledge/projects', {
		method: 'POST',
		body: { name: PROJECT_NAME },
	});
	return created.project || created;
}

async function main() {
	const project = await ensureProject();
	const projectId = project.id || project.projectId;
	const files = listDigests();
	console.log(`[ingest] project=${PROJECT_NAME} id=${projectId} files=${files.length}`);
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
			body: {
				projectId,
				title,
				text,
				sourceType: 'note',
				uri: `file://${file}`,
			},
		});
		ok += 1;
		await sleep(50);
	}
	console.log(`[ingest] done ${ok}/${files.length}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
