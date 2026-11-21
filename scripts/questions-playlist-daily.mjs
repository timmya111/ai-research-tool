#!/usr/bin/env node
/**
 * Daily check for new videos on the curated "questions" playlist
 * (PLo7mtD5End19Dekfsy90VWbuym5OSZeAU / @tvv-r8e).
 *
 * - Lists playlist via yt-dlp
 * - Diffs against seen IDs (.data/monitors/questions-playlist-seen.json)
 * - Auto-scrubs only new IDs into .data/concealment-scrubs/playlist-PLo7mt/
 * - Rebuilds full INDEX.md
 *
 * Usage:
 *   QUESTIONS_PLAYLIST_ONCE=1 pnpm questions:monitor
 *   pnpm questions:monitor          # loop every QUESTIONS_PLAYLIST_INTERVAL_MS (default 24h)
 *   QUESTIONS_PLAYLIST_SEED_ONLY=1  # seed seen from current index, no fetch
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const YTDLP = path.join(ROOT, '.venv-monitors/bin/yt-dlp');
const PLAYLIST =
	process.env.QUESTIONS_PLAYLIST_URL ||
	'https://www.youtube.com/playlist?list=PLo7mtD5End19Dekfsy90VWbuym5OSZeAU';
const OUT = path.join(ROOT, '.data/concealment-scrubs/playlist-PLo7mt');
const STATE_DIR = process.env.QUESTIONS_MONITOR_STATE_DIR || path.join(ROOT, '.data', 'monitors');
const SEEN_PATH = path.join(STATE_DIR, 'questions-playlist-seen.json');
const LOG_DIR = path.join(OUT, 'daily');
const ONCE = process.env.QUESTIONS_PLAYLIST_ONCE === '1';
const SEED_ONLY = process.env.QUESTIONS_PLAYLIST_SEED_ONLY === '1';
const INTERVAL_MS = Math.max(
	60_000,
	Number(process.env.QUESTIONS_PLAYLIST_INTERVAL_MS) || 24 * 60 * 60 * 1000,
);

function log(...args) {
	console.log(new Date().toISOString(), '[questions-playlist]', ...args);
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => {
			out += d;
			process.stdout.write(d);
		});
		child.stderr.on('data', (d) => {
			err += d;
			process.stderr.write(d);
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve({ out, err });
			else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
		});
	});
}

function loadSeen() {
	try {
		const raw = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
		return {
			ids: new Set(Array.isArray(raw?.ids) ? raw.ids.map(String) : []),
			meta: raw || {},
		};
	} catch {
		return { ids: new Set(), meta: {} };
	}
}

function saveSeen(ids, extra = {}) {
	ensureDir(STATE_DIR);
	const list = [...ids];
	fs.writeFileSync(
		SEEN_PATH,
		JSON.stringify(
			{
				updatedAt: new Date().toISOString(),
				playlist: PLAYLIST,
				count: list.length,
				ids: list,
				...extra,
			},
			null,
			2,
		),
	);
}

async function listPlaylist() {
	const { out } = await new Promise((resolve, reject) => {
		const child = spawn(
			YTDLP,
			[
				'--flat-playlist',
				'--print',
				'%(playlist_index)s|||%(id)s|||%(title)s|||%(duration)s',
				PLAYLIST,
			],
			{ cwd: ROOT, env: process.env },
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => {
			stdout += d;
		});
		child.stderr.on('data', (d) => {
			stderr += d;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve({ out: stdout, err: stderr });
			else reject(new Error(`yt-dlp list failed (${code}): ${stderr.slice(-400)}`));
		});
	});

	const rows = [];
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		const parts = line.split('|||');
		if (parts.length < 4) continue;
		const [idx, id, title, dur] = parts;
		rows.push({
			i: Number(idx) || 0,
			id,
			title,
			dur: Number(dur) || 0,
		});
	}
	rows.sort((a, b) => a.i - b.i);
	return rows;
}

function seedFromExisting(seen) {
	const indexPath = path.join(OUT, 'playlist-index.json');
	if (fs.existsSync(indexPath)) {
		const rows = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
		for (const r of rows) if (r?.id) seen.add(String(r.id));
	}
	const rawDir = path.join(OUT, 'raw');
	if (fs.existsSync(rawDir)) {
		for (const name of fs.readdirSync(rawDir)) {
			if (fs.statSync(path.join(rawDir, name)).isDirectory()) seen.add(name);
		}
	}
}

async function pollOnce() {
	ensureDir(OUT);
	ensureDir(LOG_DIR);
	if (!fs.existsSync(YTDLP)) {
		throw new Error(`yt-dlp missing at ${YTDLP} — run bryan:monitor:setup or install yt-dlp in .venv-monitors`);
	}

	const { ids: seen } = loadSeen();
	const firstRun = seen.size === 0;
	if (firstRun) {
		log('first run — seeding seen from existing playlist-PLo7mt index/raw');
		seedFromExisting(seen);
	}

	log(`listing ${PLAYLIST}`);
	const rows = await listPlaylist();
	ensureDir(OUT);
	fs.writeFileSync(path.join(OUT, 'playlist-index.json'), JSON.stringify(rows, null, 2));

	const newRows = rows.filter((r) => r.id && !seen.has(r.id));
	const day = new Date().toISOString().slice(0, 10);
	const report = {
		checkedAt: new Date().toISOString(),
		playlist: PLAYLIST,
		total: rows.length,
		seenBefore: seen.size,
		newCount: newRows.length,
		newVideos: newRows.map((r) => ({ id: r.id, i: r.i, title: r.title, dur: r.dur })),
	};

	if (SEED_ONLY) {
		for (const r of rows) seen.add(r.id);
		saveSeen(seen, { lastCheck: report });
		log(`seed-only: marked ${rows.length} ids seen`);
		fs.writeFileSync(path.join(LOG_DIR, `${day}-seed.json`), JSON.stringify(report, null, 2));
		return report;
	}

	if (!newRows.length) {
		saveSeen(seen, { lastCheck: report });
		fs.writeFileSync(path.join(LOG_DIR, `${day}-none.json`), JSON.stringify(report, null, 2));
		log(`no new videos (playlist=${rows.length} seen=${seen.size})`);
		return report;
	}

	log(`NEW ${newRows.length}: ${newRows.map((r) => `${r.id} (${r.title.slice(0, 40)})`).join('; ')}`);
	fs.writeFileSync(path.join(LOG_DIR, `${day}-new.json`), JSON.stringify(report, null, 2));

	const onlyIds = newRows.map((r) => r.id).join(',');
	await run('node', ['scripts/playlist-concealment-scrub.mjs'], {
		PLAYLIST_URL: PLAYLIST,
		OUT_DIR: OUT,
		ONLY_IDS: onlyIds,
		REBUILD_FULL_INDEX: '1',
		CONCURRENCY: '1',
		FETCH_DELAY_MS: '3000',
		SUB_RETRIES: '3',
		RATE_COOLDOWN_MS: '60000',
	});

	for (const r of newRows) seen.add(r.id);
	// also mark any other playlist ids as seen so removals/reorders don't re-trigger
	for (const r of rows) seen.add(r.id);
	saveSeen(seen, {
		lastCheck: { ...report, scrubbed: true },
		lastNewIds: newRows.map((r) => r.id),
	});
	log(`scrubbed ${newRows.length} new videos; seen=${seen.size}`);
	return report;
}

async function main() {
	if (ONCE || SEED_ONLY) {
		await pollOnce();
		return;
	}
	log(`starting daily loop intervalMs=${INTERVAL_MS}`);
	for (;;) {
		try {
			await pollOnce();
		} catch (err) {
			console.error(new Date().toISOString(), '[questions-playlist] ERROR', err);
		}
		await sleep(INTERVAL_MS);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
