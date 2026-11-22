#!/usr/bin/env node
/**
 * Import Google Gemini / Bard Takeout (or chat JSON/MD) into .data/gemini-qa/
 * and knowledge project "Gemini Q&A".
 *
 * Accepts:
 *   - Google Takeout ZIP or extracted Takeout/Gemini (+ optional My Activity HTML)
 *   - Directory of per-chat JSON / Markdown
 *   - Single JSON conversation file
 *
 * Usage:
 *   node scripts/gemini-qa-import.mjs /path/to/takeout.zip
 *   node scripts/gemini-qa-import.mjs /path/to/Takeout/Gemini
 *   GEMINI_QA_SKIP_INGEST=1 node scripts/gemini-qa-import.mjs ./takeout.zip
 *
 * Note: Many Gemini Takeouts only ship empty gemini_gems_data.html /
 * gemini_scheduled_actions_data.html stubs. For chat history, also export
 * "My Activity → Gemini Apps" in Takeout, or paste/save chats as JSON/MD.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'gemini-qa');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const PROJECT_NAME = String(process.env.GEMINI_QA_PROJECT_NAME || 'Gemini Q&A').trim();
const SKIP_INGEST = process.env.GEMINI_QA_SKIP_INGEST === '1';
const MAX_CHARS = Number(process.env.GEMINI_QA_MAX_CHARS || 47_000);

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

function tryParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function pickMessages(obj) {
	const candidates = [
		obj?.messages,
		obj?.conversation?.messages,
		obj?.mapping && Object.values(obj.mapping).map((n) => n?.message).filter(Boolean),
		obj?.turns,
		obj?.items,
		obj?.chat?.messages,
		obj?.contents,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.length) return c;
	}
	return null;
}

function roleOf(m) {
	const r = String(m?.role || m?.author?.role || m?.sender || m?.from || m?.author || '').toLowerCase();
	if (['user', 'human', 'you', 'customer', 'prompt'].includes(r)) return 'user';
	if (['assistant', 'model', 'gemini', 'bard', 'bot', 'ai', 'response'].includes(r)) return 'assistant';
	if (m?.isUser) return 'user';
	return r || 'unknown';
}

function textOf(m) {
	if (typeof m === 'string') return m;
	const c = m?.content ?? m?.parts ?? m?.text ?? m?.message;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => {
				if (typeof p === 'string') return p;
				if (typeof p?.text === 'string') return p.text;
				if (Array.isArray(p?.text)) return p.text.join('');
				if (typeof p?.content === 'string') return p.content;
				return '';
			})
			.join('\n');
	}
	if (typeof c?.text === 'string') return c.text;
	return '';
}

function stripHtml(s) {
	return String(s || '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
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
		(turns.find((t) => t.role === 'user')?.text || 'Gemini chat').slice(0, 80);
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
		`Source: Gemini / Google · id=\`${conv.id}\``,
		conv.createdAt ? `Created: ${conv.createdAt}` : '',
		'',
		'## Transcript',
		'',
	].filter(Boolean);
	for (const t of conv.turns) {
		const label = t.role === 'user' ? 'You' : t.role === 'assistant' ? 'Gemini' : t.role;
		lines.push(`### ${label}`, '', t.text, '');
	}
	if (conv.turns.length < 2) {
		lines.push('_Sparse or unrecognized message shape — raw retained under raw/._', '');
	}
	return lines.join('\n');
}

function extractConversationsFromJson(data, sourceFile) {
	const out = [];
	if (!data) return out;
	const lists = [
		data.conversations,
		data.chats,
		data.data?.conversations,
		data.gemini_conversations,
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

/** Parse Google My Activity HTML for Gemini Apps Q&A-ish blocks. */
function extractFromActivityHtml(html, sourceFile) {
	const out = [];
	// Activity entries often look like: <div class="outer-cell"> ... <div class="content-cell">PROMPT ... RESPONSE
	const chunks = html.split(/<div class="outer-cell[^"]*"[^>]*>/i).slice(1);
	if (!chunks.length) {
		// Fallback: look for Prompted / Gemini said patterns
		const prompted = [...html.matchAll(/Prompted\s*([^<]{3,500})/gi)];
		if (prompted.length) {
			const turns = [];
			for (const m of prompted) {
				turns.push({ role: 'user', text: stripHtml(m[1]) });
			}
			if (turns.length) {
				out.push({
					id: sha1(sourceFile + 'activity'),
					title: `Gemini Activity (${path.basename(sourceFile)})`,
					sourceFile,
					createdAt: null,
					updatedAt: null,
					turns,
				});
			}
		}
		return out;
	}
	let i = 0;
	for (const chunk of chunks) {
		const text = stripHtml(chunk);
		if (text.length < 20) continue;
		i += 1;
		// Heuristic split: first line / "Prompted" as user
		let user = '';
		let assistant = '';
		const pm = text.match(/Prompted\s+([\s\S]+?)(?:Gemini|Bard|Responded|Response|$)/i);
		const am = text.match(/(?:Gemini|Bard)\s*(?:said|responded)?\s*([\s\S]+)/i);
		if (pm) user = pm[1].trim().slice(0, 8000);
		if (am) assistant = am[1].trim().slice(0, 20000);
		const turns = [];
		if (user) turns.push({ role: 'user', text: user });
		if (assistant) turns.push({ role: 'assistant', text: assistant });
		if (!turns.length) turns.push({ role: 'unknown', text: text.slice(0, 12000) });
		const title = (user || text).split('\n')[0].slice(0, 80) || `activity-${i}`;
		out.push({
			id: sha1(`${sourceFile}#${i}#${title}`),
			title,
			sourceFile: `${sourceFile}#${i}`,
			createdAt: null,
			updatedAt: null,
			turns,
		});
	}
	return out;
}

function isEmptyStubHtml(html) {
	const t = stripHtml(html).replace(/\s+/g, '');
	return !t || t === '' || /^<div><\/div>$/i.test(html.trim());
}

function loadFromTree(rootDir) {
	const files = walkFiles(rootDir).filter((f) => /\.(json|jsonl|md|txt|html|htm)$/i.test(f));
	const conversations = [];
	const stubs = [];
	for (const file of files) {
		const base = path.basename(file).toLowerCase();
		if (base.includes('node_modules')) continue;
		const text = fs.readFileSync(file, 'utf8');

		if (/\.html?$/i.test(file)) {
			if (isEmptyStubHtml(text) || /gemini_(gems|scheduled_actions)_data\.html$/i.test(base)) {
				if (isEmptyStubHtml(text)) {
					stubs.push(file);
					continue;
				}
			}
			conversations.push(...extractFromActivityHtml(text, file));
			continue;
		}
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
	return { conversations, stubs };
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

async function finalize(conversations, stubs = [], scanRoot = '') {
	const byId = new Map();
	for (const c of conversations) {
		if (!c?.id) continue;
		const prev = byId.get(c.id);
		if (!prev || (c.turns?.length || 0) > (prev.turns?.length || 0)) byId.set(c.id, c);
	}
	const list = [...byId.values()].filter((c) => (c.turns?.length || 0) > 0 || c.preformattedMarkdown);

	fs.writeFileSync(
		path.join(OUT, 'conversations', 'index.json'),
		JSON.stringify(
			list.map((c) => ({
				id: c.id,
				title: c.title,
				turns: c.turns?.length || 0,
				sourceFile: c.sourceFile,
			})),
			null,
			2,
		),
	);

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
		'# Gemini Q&A import',
		'',
		`Imported: ${new Date().toISOString()}`,
		`Scan root: ${scanRoot || '(n/a)'}`,
		`Conversations: ${list.length}`,
		`Empty Takeout stubs skipped: ${stubs.length}`,
		'',
		'## How to get real chat history',
		'',
		'1. Google Takeout → select **Gemini** *and* **My Activity** (Gemini Apps).',
		'2. Or save chats from gemini.google.com as Markdown/JSON into `.data/gemini-qa/raw/`.',
		'3. Re-run: `pnpm gemini-qa:import /path/to/takeout.zip`',
		'',
		'## Chats',
		'',
		...(list.length
			? list.map((c) => `- **${c.title}** (\`${c.id}\`) — ${c.turns?.length || 0} turns`)
			: ['_No conversations found in this export._']),
		'',
		stubs.length
			? `## Skipped stubs\n\n${stubs.map((s) => `- \`${s}\``).join('\n')}\n`
			: '',
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'digests', 'OVERVIEW.md'), overview);
	digestFiles.unshift({
		file: path.join(OUT, 'digests', 'OVERVIEW.md'),
		title: 'Gemini Q&A import',
		md: overview,
	});

	fs.writeFileSync(
		path.join(OUT, 'README.md'),
		[
			'# Gemini Q&A',
			'',
			'Local Gemini / Google Takeout import.',
			'',
			'- `raw/` — Takeout ZIP extract / copies',
			'- `conversations/` — normalized JSON + `index.json`',
			'- `digests/` — Markdown for RAG + `OVERVIEW.md`',
			'',
			'Import: `pnpm gemini-qa:import /path/to/takeout.zip`',
			'Search: agent tool `search_gemini_qa` (and knowledge project **Gemini Q&A** after ingest)',
			'',
		].join('\n'),
	);

	console.log(`[gemini-qa] conversations=${list.length} digests=${digestFiles.length} stubs_skipped=${stubs.length}`);

	if (SKIP_INGEST) {
		console.log('[gemini-qa] skip ingest (GEMINI_QA_SKIP_INGEST=1)');
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
		console.log(`[gemini-qa] ingested ${ok} docs into project "${PROJECT_NAME}" (${projectId})`);
	} catch (err) {
		console.warn(`[gemini-qa] local files written, but knowledge ingest failed: ${err.message}`);
		console.warn('Start the app (`pnpm dev`) and re-run, or set GEMINI_QA_SKIP_INGEST=1');
	}
}

async function main() {
	const input = process.argv[2] || path.join(OUT);
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
		const dest = path.join(OUT, 'raw', `export-${sha1(abs)}`);
		console.log(`[gemini-qa] unzip → ${dest}`);
		extractZip(abs, dest);
		scanRoot = dest;
	} else if (st.isFile() && /\.json$/i.test(abs)) {
		fs.copyFileSync(abs, path.join(OUT, 'raw', path.basename(abs)));
		const obj = tryParseJson(fs.readFileSync(abs, 'utf8'));
		const conversations = extractConversationsFromJson(obj, abs);
		return finalize(conversations, [], abs);
	} else if (st.isDirectory()) {
		// Prefer Takeout/Gemini if present under this tree
		const geminiDir = path.join(abs, 'Takeout', 'Gemini');
		const activityDir = path.join(abs, 'Takeout', 'My Activity');
		if (fs.existsSync(geminiDir) || fs.existsSync(activityDir)) {
			scanRoot = path.join(abs, 'Takeout');
		}
	}

	const { conversations, stubs } = loadFromTree(scanRoot);
	return finalize(conversations, stubs, scanRoot);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
