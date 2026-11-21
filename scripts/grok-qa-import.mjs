#!/usr/bin/env node
/**
 * Import Grok / xAI conversation export into .data/grok-qa/ and knowledge project "Grok Q&A".
 *
 * Accepts:
 *   - Official accounts.x.ai data ZIP (or extracted folder/JSON)
 *   - A directory of per-chat JSON/Markdown scraped from grok.com
 *
 * Usage:
 *   node scripts/grok-qa-import.mjs /path/to/export.zip
 *   node scripts/grok-qa-import.mjs /path/to/extracted-or-conversations-dir
 *   GROK_QA_SKIP_INGEST=1 node scripts/grok-qa-import.mjs ./export.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'grok-qa');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.GROK_QA_PROJECT_NAME || 'Grok Q&A').trim();
const SKIP_INGEST = process.env.GROK_QA_SKIP_INGEST === '1';
const MAX_CHARS = Number(process.env.GROK_QA_MAX_CHARS || 47_000);

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

function sha1(s) {
	return createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function walkFiles(dir, acc = []) {
	if (!fs.existsSync(dir)) return acc;
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p);
		if (st.isDirectory()) walkFiles(p, acc);
		else acc.push(p);
	}
	return acc;
}

function extractZip(zipPath, dest) {
	ensureDir(dest);
	const r = spawnSync('unzip', ['-o', zipPath, '-d', dest], { encoding: 'utf8' });
	if (r.status !== 0) {
		throw new Error(`unzip failed: ${r.stderr || r.stdout || r.status}`);
	}
	return dest;
}

function asArray(v) {
	if (!v) return [];
	return Array.isArray(v) ? v : [v];
}

function pickMessages(obj) {
	const candidates = [
		obj?.messages,
		obj?.conversation?.messages,
		obj?.mapping && Object.values(obj.mapping).map((n) => n?.message).filter(Boolean),
		obj?.turns,
		obj?.items,
		obj?.chat?.messages,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.length) return c;
	}
	return null;
}

function roleOf(m) {
	const r = String(m?.role || m?.author?.role || m?.sender || m?.from || '').toLowerCase();
	if (['user', 'human', 'you', 'customer'].includes(r)) return 'user';
	if (['assistant', 'grok', 'bot', 'model', 'ai'].includes(r)) return 'assistant';
	if (m?.author === 'user' || m?.isUser) return 'user';
	return r || 'unknown';
}

function textOf(m) {
	if (typeof m === 'string') return m;
	const c = m?.content;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => {
				if (typeof p === 'string') return p;
				if (typeof p?.text === 'string') return p.text;
				if (Array.isArray(p?.text)) return p.text.join('');
				return p?.content || '';
			})
			.join('\n');
	}
	if (typeof c?.text === 'string') return c.text;
	if (typeof m?.text === 'string') return m.text;
	if (typeof m?.message === 'string') return m.message;
	if (typeof m?.parts?.[0] === 'string') return m.parts.join('\n');
	return '';
}

function normalizeConversation(raw, fallbackTitle, sourceFile) {
	const messages = pickMessages(raw) || [];
	const turns = [];
	for (const m of messages) {
		const text = String(textOf(m) || '').trim();
		if (!text) continue;
		turns.push({
			role: roleOf(m),
			text,
			createdAt: m?.createdAt || m?.create_time || m?.timestamp || m?.created_at || null,
		});
	}

	// Some exports are flat Q/A arrays
	if (!turns.length && Array.isArray(raw?.qa)) {
		for (const pair of raw.qa) {
			if (pair?.q) turns.push({ role: 'user', text: String(pair.q) });
			if (pair?.a) turns.push({ role: 'assistant', text: String(pair.a) });
		}
	}

	const title =
		raw?.title ||
		raw?.conversation?.title ||
		raw?.name ||
		fallbackTitle ||
		(turns.find((t) => t.role === 'user')?.text || 'Grok chat').slice(0, 80);

	const id = String(raw?.id || raw?.conversation_id || raw?.conversationId || sha1(sourceFile + title));
	return {
		id,
		title: String(title).replace(/\s+/g, ' ').trim().slice(0, 160),
		sourceFile,
		createdAt: raw?.create_time || raw?.createdAt || raw?.created_at || null,
		updatedAt: raw?.update_time || raw?.updatedAt || null,
		turns,
	};
}

function conversationToMarkdown(conv) {
	const lines = [
		`# ${conv.title}`,
		'',
		`Source: Grok / xAI · id=\`${conv.id}\``,
		conv.createdAt ? `Created: ${conv.createdAt}` : '',
		'',
		'## Transcript',
		'',
	].filter(Boolean);
	for (const t of conv.turns) {
		const label = t.role === 'user' ? 'You' : t.role === 'assistant' ? 'Grok' : t.role;
		lines.push(`### ${label}`, '', t.text, '');
	}
	if (conv.turns.length < 2) {
		lines.push('_Sparse or unrecognized message shape — raw JSON retained under raw/. _', '');
	}
	return lines.join('\n');
}

function tryParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function extractConversationsFromJson(data, sourceFile) {
	const out = [];
	if (!data) return out;

	// Common shapes
	const lists = [
		data.conversations,
		data.chats,
		data.data?.conversations,
		data.grok_conversations,
		Array.isArray(data) ? data : null,
	].filter(Boolean);

	if (lists.length) {
		for (const list of lists) {
			for (const [i, item] of asArray(list).entries()) {
				if (!item || typeof item !== 'object') continue;
				out.push(normalizeConversation(item, `chat-${i + 1}`, sourceFile));
			}
		}
		return out;
	}

	if (pickMessages(data) || data.title || data.conversation) {
		out.push(normalizeConversation(data, path.basename(sourceFile, '.json'), sourceFile));
	}
	return out;
}

function loadFromTree(rootDir) {
	const files = walkFiles(rootDir).filter((f) => /\.(json|jsonl|md|txt)$/i.test(f));
	const conversations = [];
	for (const file of files) {
		const base = path.basename(file).toLowerCase();
		// skip huge asset manifests if any
		if (base.includes('node_modules')) continue;
		const text = fs.readFileSync(file, 'utf8');
		if (file.endsWith('.jsonl')) {
			for (const [i, line] of text.split('\n').entries()) {
				if (!line.trim()) continue;
				const obj = tryParseJson(line);
				if (!obj) continue;
				conversations.push(...extractConversationsFromJson(obj, `${file}#${i}`));
			}
			continue;
		}
		if (file.endsWith('.json')) {
			const obj = tryParseJson(text);
			if (!obj) continue;
			conversations.push(...extractConversationsFromJson(obj, file));
			continue;
		}
		// markdown/txt already transcript-like
		if (/\.(md|txt)$/i.test(file) && text.length > 40) {
			conversations.push({
				id: sha1(file),
				title: path.basename(file, path.extname(file)).slice(0, 120),
				sourceFile: file,
				createdAt: null,
				updatedAt: null,
				turns: [{ role: 'unknown', text }],
				preformattedMarkdown: text,
			});
		}
	}
	return conversations;
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

async function ensureProject() {
	const listed = await api('/api/knowledge/projects');
	const existing = (listed.projects || []).find(
		(p) => String(p.name || '').toLowerCase() === PROJECT_NAME.toLowerCase(),
	);
	if (existing) return existing;
	const created = await api('/api/knowledge/projects', { method: 'POST', body: { name: PROJECT_NAME } });
	return created.project || created;
}

async function main() {
	const input = process.argv[2];
	if (!input) {
		console.error('Usage: node scripts/grok-qa-import.mjs <export.zip|dir|json>');
		process.exit(1);
	}
	const abs = path.resolve(input);
	if (!fs.existsSync(abs)) {
		console.error(`Not found: ${abs}`);
		process.exit(1);
	}

	ensureDir(OUT);
	ensureDir(path.join(OUT, 'raw'));
	ensureDir(path.join(OUT, 'conversations'));
	ensureDir(path.join(OUT, 'digests'));

	let scanRoot = abs;
	const st = fs.statSync(abs);
	if (st.isFile() && /\.zip$/i.test(abs)) {
		const dest = path.join(OUT, 'raw', `export-${sha1(abs)}-${Date.now()}`);
		console.log(`[grok-qa] unzip → ${dest}`);
		extractZip(abs, dest);
		scanRoot = dest;
	} else if (st.isFile() && /\.json$/i.test(abs)) {
		fs.copyFileSync(abs, path.join(OUT, 'raw', path.basename(abs)));
		scanRoot = path.join(OUT, 'raw');
		// also keep original path readable via copy only; parse directly too
		const obj = tryParseJson(fs.readFileSync(abs, 'utf8'));
		const conversations = extractConversationsFromJson(obj, abs);
		return finalize(conversations);
	}

	const conversations = loadFromTree(scanRoot);
	return finalize(conversations);
}

async function finalize(conversations) {
	// Dedup by id
	const byId = new Map();
	for (const c of conversations) {
		if (!c?.id) continue;
		const prev = byId.get(c.id);
		if (!prev || (c.turns?.length || 0) > (prev.turns?.length || 0)) byId.set(c.id, c);
	}
	const list = [...byId.values()].filter((c) => (c.turns?.length || 0) > 0 || c.preformattedMarkdown);
	fs.writeFileSync(path.join(OUT, 'conversations', 'index.json'), JSON.stringify(
		list.map((c) => ({ id: c.id, title: c.title, turns: c.turns?.length || 0, sourceFile: c.sourceFile })),
		null,
		2,
	));

	const digestFiles = [];
	for (const c of list) {
		const md = c.preformattedMarkdown || conversationToMarkdown(c);
		const safe = c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || sha1(c.title);
		const file = path.join(OUT, 'digests', `${safe}.md`);
		fs.writeFileSync(file, md);
		fs.writeFileSync(path.join(OUT, 'conversations', `${safe}.json`), JSON.stringify(c, null, 2));
		digestFiles.push({ file, title: c.title, md });
	}

	const overview = [
		'# Grok Q&A import',
		'',
		`Imported: ${new Date().toISOString()}`,
		`Conversations: ${list.length}`,
		'',
		'## Chats',
		'',
		...list.map((c) => `- **${c.title}** (\`${c.id}\`) — ${c.turns?.length || 0} turns`),
		'',
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'digests', 'OVERVIEW.md'), overview);
	digestFiles.unshift({ file: path.join(OUT, 'digests', 'OVERVIEW.md'), title: 'Grok Q&A import', md: overview });

	console.log(`[grok-qa] conversations=${list.length} digests=${digestFiles.length}`);

	if (SKIP_INGEST) {
		console.log('[grok-qa] skip ingest (GROK_QA_SKIP_INGEST=1)');
		return;
	}

	try {
		const project = await ensureProject();
		const projectId = project.id || project.projectId;
		let ok = 0;
		for (const d of digestFiles) {
			let text = d.md;
			if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 40)}\n\n…[truncated]`;
			await api('/api/knowledge', {
				method: 'POST',
				body: {
					projectId,
					title: d.title.slice(0, 120),
					text,
					sourceType: 'note',
					uri: `file://${d.file}`,
				},
			});
			ok += 1;
		}
		console.log(`[grok-qa] ingested ${ok} docs into project "${PROJECT_NAME}" (${projectId})`);
	} catch (err) {
		console.warn(`[grok-qa] local files written, but knowledge ingest failed: ${err.message}`);
		console.warn('Start the app (`pnpm dev`) and re-run with the same path, or set GROK_QA_SKIP_INGEST=1');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
