#!/usr/bin/env node
/**
 * Ingest Dallas County deed digests (+ overview) into knowledge project
 * "Dallas County Deeds".
 *
 * Usage:
 *   node scripts/dallas-deeds-ingest-knowledge.mjs
 *   BASE_URL=http://127.0.0.1:3333 node scripts/dallas-deeds-ingest-knowledge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data', 'dallas-deeds');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.DALLAS_PROJECT_NAME || 'Dallas County Deeds').trim();
const MAX_CHARS = Number(process.env.DALLAS_MAX_CHARS || 47_000);
const SLEEP_MS = Number(process.env.DALLAS_INGEST_SLEEP_MS || 50);

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

function listDigestFiles() {
	const files = [];
	const overview = path.join(DATA_DIR, 'OVERVIEW.md');
	if (fs.existsSync(overview)) files.push(overview);
	const digests = path.join(DATA_DIR, 'digests');
	if (fs.existsSync(digests)) {
		for (const name of fs.readdirSync(digests).sort()) {
			if (!name.endsWith('.md')) continue;
			files.push(path.join(digests, name));
		}
	}
	return files;
}

function titleFromFile(file, text) {
	const first = String(text || '')
		.split('\n')
		.find((l) => l.startsWith('# '));
	if (first) return first.replace(/^#\s+/, '').trim().slice(0, 120);
	return path.basename(file, '.md').slice(0, 120);
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
	if (!fs.existsSync(DATA_DIR)) {
		throw new Error(`Missing ${DATA_DIR} — run pnpm dallas:download first`);
	}
	const files = listDigestFiles();
	if (!files.length) throw new Error('No digest/overview markdown files to ingest');

	const project = await ensureProject();
	const projectId = project.id || project.projectId;
	if (!projectId) throw new Error('No project id');
	console.log(`Ingesting ${files.length} files → project ${PROJECT_NAME} (${projectId})`);

	let ok = 0;
	for (const file of files) {
		const text = truncate(fs.readFileSync(file, 'utf8'));
		const title = titleFromFile(file, text);
		await api('/api/knowledge', {
			method: 'POST',
			body: {
				projectId,
				title,
				text,
				sourceType: 'note',
				metadata: {
					kind: 'dallas-deeds-digest',
					path: path.relative(ROOT, file),
				},
			},
		});
		ok += 1;
		console.log(`[ok] ${path.relative(DATA_DIR, file)}`);
		await sleep(SLEEP_MS);
	}
	console.log(`DONE ingested=${ok}`);
}

main().catch((err) => {
	console.error('FATAL', err);
	process.exit(1);
});
