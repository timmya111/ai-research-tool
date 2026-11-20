#!/usr/bin/env node
/**
 * Ingest .data/tornadoes digests into knowledge project "OK TX Tornadoes".
 *
 * Usage:
 *   node scripts/tornado-ingest-knowledge.mjs
 *   BASE_URL=http://127.0.0.1:3333 node scripts/tornado-ingest-knowledge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TORNADO_DIR = path.join(ROOT, '.data', 'tornadoes');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.TORNADO_PROJECT_NAME || 'OK TX Tornadoes').trim();
const MAX_CHARS = Number(process.env.TORNADO_MAX_CHARS || 47_000);
const SLEEP_MS = Number(process.env.TORNADO_INGEST_SLEEP_MS || 50);

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
	const overview = path.join(TORNADO_DIR, 'OVERVIEW.md');
	if (fs.existsSync(overview)) files.push(overview);

	for (const state of ['oklahoma', 'texas']) {
		const digests = path.join(TORNADO_DIR, state, 'digests');
		if (!fs.existsSync(digests)) continue;
		for (const name of fs.readdirSync(digests).sort()) {
			if (!name.endsWith('.md')) continue;
			files.push(path.join(digests, name));
		}
	}

	const notable = path.join(TORNADO_DIR, 'notable');
	if (fs.existsSync(notable)) {
		for (const name of fs.readdirSync(notable).sort()) {
			if (!name.endsWith('.md')) continue;
			files.push(path.join(notable, name));
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
	return { id: created.id, name: created.name };
}

async function main() {
	if (!fs.existsSync(TORNADO_DIR)) {
		throw new Error(`Missing ${TORNADO_DIR} — run node scripts/tornado-spc-ncei-download.mjs first`);
	}

	const project = await ensureProject();
	console.log(`project ${project.name} (${project.id})`);

	const files = listDigestFiles();
	if (!files.length) throw new Error('No digest markdown files found under .data/tornadoes');

	let saved = 0;
	let errors = 0;

	for (const file of files) {
		const raw = fs.readFileSync(file, 'utf8');
		const text = truncate(raw);
		const title = titleFromFile(file, raw);
		const rel = path.relative(ROOT, file);
		try {
			const result = await api('/api/knowledge', {
				method: 'POST',
				body: {
					projectId: project.id,
					title,
					text: `${text}\n\nLocal mirror: ${rel}`,
				},
			});
			saved += 1;
			console.log(`ok ${title.slice(0, 70)} → ${String(result.id || '').slice(0, 8)}`);
		} catch (err) {
			errors += 1;
			console.error(`fail ${rel}: ${err instanceof Error ? err.message : String(err)}`);
		}
		await sleep(SLEEP_MS);
	}

	console.log(JSON.stringify({ projectId: project.id, files: files.length, saved, errors }, null, 2));
	if (errors) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
