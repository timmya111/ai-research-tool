#!/usr/bin/env node
/**
 * Ingest research-drive OCR digests into knowledge project "Research Drive".
 *
 * Usage:
 *   node scripts/research-drive-ingest-knowledge.mjs
 *   BASE_URL=http://127.0.0.1:3333 node scripts/research-drive-ingest-knowledge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIGESTS = path.join(ROOT, '.data', 'research-drive', 'ocr', 'digests');
const OVERVIEW = path.join(ROOT, '.data', 'research-drive', 'ocr', 'OVERVIEW.md');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.RD_PROJECT_NAME || 'Research Drive').trim();
const MAX_CHARS = Number(process.env.RD_MAX_CHARS || 47_000);
const SLEEP_MS = Number(process.env.RD_INGEST_SLEEP_MS || 40);

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
	if (fs.existsSync(OVERVIEW)) files.push(OVERVIEW);
	if (!fs.existsSync(DIGESTS)) return files;
	const walk = (dir) => {
		for (const name of fs.readdirSync(dir)) {
			const p = path.join(dir, name);
			const st = fs.statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith('.md')) files.push(p);
		}
	};
	walk(DIGESTS);
	return files.sort();
}

function truncate(text) {
	const t = String(text || '');
	if (t.length <= MAX_CHARS) return t;
	return `${t.slice(0, MAX_CHARS - 80)}\n\n…[truncated for knowledge store limit]`;
}

function titleFrom(file, text) {
	const first = String(text || '')
		.split('\n')
		.find((l) => l.startsWith('# '));
	if (first) return first.replace(/^#\s+/, '').trim().slice(0, 120);
	return path.basename(file, '.md').slice(0, 120);
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
	console.log(`[rd-ingest] project=${PROJECT_NAME} id=${projectId} files=${files.length}`);
	let ok = 0;
	for (const file of files) {
		const text = truncate(fs.readFileSync(file, 'utf8'));
		const title = titleFrom(file, text);
		await api('/api/knowledge', {
			method: 'POST',
			body: { projectId, title, text },
		});
		ok += 1;
		if (ok % 25 === 0) console.log(`[rd-ingest] ${ok}/${files.length}`);
		await sleep(SLEEP_MS);
	}
	console.log(`[rd-ingest] done ${ok}/${files.length}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
