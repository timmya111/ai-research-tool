#!/usr/bin/env node
/**
 * Batch scrub a YouTube playlist or prebuilt channel index for
 * timeline / naming / hiding / finance patterns.
 *
 * Usage:
 *   node scripts/playlist-concealment-scrub.mjs
 *   PLAYLIST_URL=... OUT_DIR=... CONCURRENCY=3 node scripts/playlist-concealment-scrub.mjs
 *   INDEX_FILE=channel-index.json OUT_DIR=... META_ONLY=1 node scripts/playlist-concealment-scrub.mjs
 *   RAW_CACHE=other/raw ...  # reuse already-fetched vid.info.json / .vtt by id
 *
 * Requires: .venv-monitors/bin/yt-dlp
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const YTDLP = path.join(ROOT, '.venv-monitors/bin/yt-dlp');
const PLAYLIST =
	process.env.PLAYLIST_URL ||
	'https://www.youtube.com/playlist?list=PLo7mtD5End19Dekfsy90VWbuym5OSZeAU';
const INDEX_FILE = process.env.INDEX_FILE || '';
const OUT = process.env.OUT_DIR || path.join(ROOT, '.data/concealment-scrubs/playlist-PLo7mt');
const RAW_CACHE = process.env.RAW_CACHE || '';
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === '1';
const META_ONLY = process.env.META_ONLY === '1';
const CAPTIONS_ONLY = process.env.CAPTIONS_ONLY === '1';
/** Comma-separated video IDs — fetch/card only these; still write full playlist-index when listed from URL. */
const ONLY_IDS = new Set(
	String(process.env.ONLY_IDS || '')
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean),
);
/** If set with ONLY_IDS, rebuild INDEX.md from full playlist-index.json + all cards on disk. */
const REBUILD_FULL_INDEX = process.env.REBUILD_FULL_INDEX === '1' || ONLY_IDS.size > 0;
const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS || 2500);
const SUB_RETRIES = Number(process.env.SUB_RETRIES || 3);
const RATE_COOLDOWN_MS = Number(process.env.RATE_COOLDOWN_MS || 60000);
/** After this many consecutive caption 429s, skip further sub downloads this run. */
const MAX_CONSECUTIVE_RATE_LIMITS = Number(process.env.MAX_CONSECUTIVE_RATE_LIMITS || 8);
/** Optional Netscape cookies file, or browser name for --cookies-from-browser (e.g. chrome). */
const COOKIES_FILE = String(process.env.YTDLP_COOKIES || process.env.COOKIES_FILE || '').trim();
const COOKIES_FROM_BROWSER = String(process.env.YTDLP_COOKIES_FROM_BROWSER || process.env.COOKIES_FROM_BROWSER || '').trim();
const YTDLP_REMOTE_COMPONENTS = String(process.env.YTDLP_REMOTE_COMPONENTS || 'ejs:github').trim();
let consecutiveRateLimits = 0;
let skipRemainingSubs = false;

function ytdlpAuthArgs() {
	const args = ['--js-runtimes', 'node'];
	if (YTDLP_REMOTE_COMPONENTS) args.push('--remote-components', YTDLP_REMOTE_COMPONENTS);
	if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
	else if (COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', COOKIES_FROM_BROWSER);
	return args;
}

const DEEP_DONE = new Set(['UOMfZy98wxs', 'Q5VQ5ZfZ9aY', 'DtEVtNJ1kmQ', 'RST9ld1aPnU']);

const PATTERNS = {
	timeline: /\b(?:(?:1[6-9]|20)\d{2}|BC|A\.?D\.?|Operation\s+[A-Z][A-Za-z0-9 -]+|MK[- ]?Ultra|CIA|KGB|Mossad|SDI|Star Wars|Highjump|Deep Freeze|Falklands|Cold War|WWII|World War)\b/gi,
	naming: /\b(?:Freemason\w*|Illuminati|Lodge|Order|Temple|Church|Institute|Project\s+[A-Z][A-Za-z0-9 -]+|codename|alias|DBA|shell|front|cover\s+story|Malvinas|Falklands)\b/gi,
	hiding: /\b(?:secret|hidden|classified|redacted|cover(?:[- ]?up)?|conceal\w*|tunnel|underground|basement|suicide|disappear\w*|missing|sealed|blocked|disinfo|decoy|laundry|scrap\s+metal|benign|official\s+story|conspiracy|black\s+site|compartment)\w*\b/gi,
	finance: /\b(?:\$[\d,]+(?:\.\d+)?|oil|bank(?:ing)?|money\s+launder\w*|offshore|shell\s+compan\w*|hedge\s+fund|real\s+estate|mortgage|deed|lottery|fraud|whistleblow\w*|contract(?:or)?|budget|billion|million|Epstein|Lansky|Mafia|cartel)\b/gi,
};

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('close', (code) => {
			if (code === 0) resolve({ out, err });
			else reject(new Error(`${cmd} ${args.join(' ')} → ${code}\n${err.slice(-800)}`));
		});
	});
}

async function listPlaylist() {
	if (INDEX_FILE) {
		const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
		const rows = (Array.isArray(raw) ? raw : raw.entries || raw.videos || []).map((r, n) => ({
			i: Number(r.i) || n + 1,
			id: r.id,
			title: r.title || r.id,
			dur: Number(r.dur) || 0,
			tab: r.tab || '',
		}));
		rows.sort((a, b) => a.i - b.i);
		return rows;
	}
	const { out } = await run(YTDLP, [
		'--flat-playlist',
		'--print',
		'%(playlist_index)s|||%(id)s|||%(title)s|||%(duration)s',
		...ytdlpAuthArgs(),
		PLAYLIST,
	]);
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

function seedFromCache(id) {
	if (!RAW_CACHE) return;
	const src = path.join(RAW_CACHE, id);
	const dest = path.join(OUT, 'raw', id);
	if (!fs.existsSync(src)) return;
	ensureDir(dest);
	for (const f of fs.readdirSync(src)) {
		const s = path.join(src, f);
		const d = path.join(dest, f);
		if (fs.existsSync(d)) continue;
		if (!fs.statSync(s).isFile()) continue;
		try {
			fs.copyFileSync(s, d);
		} catch {
			/* ignore */
		}
	}
}

function hasVtt(dir) {
	return fs.readdirSync(dir).some((f) => f.endsWith('.vtt'));
}

async function fetchVideo(id) {
	seedFromCache(id);
	const dir = path.join(OUT, 'raw', id);
	ensureDir(dir);
	const infoPath = path.join(dir, 'vid.info.json');
	if (fs.existsSync(infoPath) && hasVtt(dir)) {
		return { id, dir, skipped: true, hasSubs: true, rateLimited: false };
	}
	if (CAPTIONS_ONLY && !fs.existsSync(infoPath)) {
		return { id, dir, skipped: true, hasSubs: false, rateLimited: false, noInfo: true };
	}
	if (CAPTIONS_ONLY && hasVtt(dir)) {
		return { id, dir, skipped: true, hasSubs: true, rateLimited: false };
	}

	let rateLimited = false;

	// Pass 1: metadata only (reliable under rate limits)
	if (!CAPTIONS_ONLY && !fs.existsSync(infoPath)) {
		await run(
			YTDLP,
			[
				'--skip-download',
				'--write-info-json',
				'--no-write-subs',
				...ytdlpAuthArgs(),
				'-o',
				'vid',
				`https://www.youtube.com/watch?v=${id}`,
			],
			{ cwd: dir },
		);
	}

	// Pass 2: captions with retries (429 soft-fail / early bail)
	if (!META_ONLY && !hasVtt(dir) && !skipRemainingSubs) {
		for (let attempt = 1; attempt <= SUB_RETRIES; attempt++) {
			try {
				await run(
					YTDLP,
					[
						'--skip-download',
						'--write-auto-sub',
						'--write-sub',
						'--sub-langs',
						'en.*,en',
						...ytdlpAuthArgs(),
						'-o',
						'vid',
						`https://www.youtube.com/watch?v=${id}`,
					],
					{ cwd: dir },
				);
				consecutiveRateLimits = 0;
				break;
			} catch (err) {
				const msg = String(err);
				const rate = /429|Too Many Requests/i.test(msg);
				const bot = /not a bot|Sign in to confirm/i.test(msg);
				console.warn(`[subs] ${id} attempt=${attempt} ${rate ? 'RATE_LIMIT' : bot ? 'BOT' : 'ERR'}: ${msg.slice(0, 120)}`);
				if (rate || bot) {
					rateLimited = true;
					consecutiveRateLimits += 1;
					// Burning retries against a hot 429 rarely helps — cool down and move on.
					await sleep(Math.min(RATE_COOLDOWN_MS * consecutiveRateLimits, 180000));
					if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
						skipRemainingSubs = true;
						console.warn(
							`[subs] aborting further caption fetches after ${consecutiveRateLimits} consecutive 429s/bot blocks`,
						);
					}
					break;
				}
				if (attempt >= SUB_RETRIES) break;
				await sleep(3000 * attempt);
			}
		}
	} else if (skipRemainingSubs && !hasVtt(dir)) {
		rateLimited = true;
	}

	return {
		id,
		dir,
		skipped: false,
		hasSubs: hasVtt(dir),
		hasInfo: fs.existsSync(infoPath),
		rateLimited,
	};
}

function mergeVtt(vttText) {
	const lines = String(vttText || '').split(/\r?\n/);
	const cues = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (line.includes('-->')) {
			const start = line.split('-->')[0].trim().split('.')[0];
			i += 1;
			const texts = [];
			while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
				const t = lines[i].replace(/<[^>]+>/g, '').trim();
				if (t) texts.push(t);
				i += 1;
			}
			const text = texts.join(' ');
			if (!text) continue;
			if (cues.length && cues[cues.length - 1][1].includes(text) === false && text.includes(cues[cues.length - 1][1])) {
				cues[cues.length - 1] = [cues[cues.length - 1][0], text];
			} else if (cues.length && cues[cues.length - 1][1] === text) {
				/* skip dup */
			} else if (cues.length && text.includes(cues[cues.length - 1][1])) {
				cues[cues.length - 1] = [cues[cues.length - 1][0], text];
			} else {
				cues.push([start, text]);
			}
		} else i += 1;
	}
	return cues;
}

function topHits(text, re, limit = 25) {
	const counts = new Map();
	for (const m of String(text).matchAll(re)) {
		const k = m[0].replace(/\s+/g, ' ').trim();
		if (k.length < 3) continue;
		counts.set(k, (counts.get(k) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([k, n]) => ({ term: k, n }));
}

function yearsFrom(text) {
	const counts = new Map();
	for (const m of String(text).matchAll(/\b((?:16|17|18|19|20)\d{2})\b/g)) {
		const y = Number(m[1]);
		if (y < 1600 || y > 2026) continue;
		counts.set(y, (counts.get(y) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([y, n]) => ({ year: y, n }));
}

function loadVideoBundle(id) {
	const dir = path.join(OUT, 'raw', id);
	const infoPath = path.join(dir, 'vid.info.json');
	if (!fs.existsSync(infoPath)) return null;
	const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
	const vttFile =
		['vid.en.vtt', 'vid.en-orig.vtt'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) ||
		fs.readdirSync(dir).find((f) => f.endsWith('.vtt') && fs.existsSync(path.join(dir, f)));
	let cues = [];
	if (vttFile) {
		const full = vttFile.startsWith(dir) ? vttFile : path.join(dir, vttFile);
		cues = mergeVtt(fs.readFileSync(full, 'utf8'));
	}
	const transcript = cues.map(([s, t]) => `[${s}] ${t}`).join('\n');
	const blob = [info.title, info.description, ...(info.chapters || []).map((c) => c.title), transcript]
		.filter(Boolean)
		.join('\n');
	return { info, cues, transcript, blob, dir };
}

function scrubCard(row, bundle) {
	const info = bundle?.info || {};
	const blob = bundle?.blob || `${row.title}`;
	const chapters = (info.chapters || []).map((c) => {
		const t = Math.floor(c.start_time || 0);
		const h = Math.floor(t / 3600);
		const m = Math.floor((t % 3600) / 60);
		const s = t % 60;
		return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}  ${c.title}`;
	});
	const hits = {
		timeline: topHits(blob, PATTERNS.timeline, 30),
		naming: topHits(blob, PATTERNS.naming, 30),
		hiding: topHits(blob, PATTERNS.hiding, 30),
		finance: topHits(blob, PATTERNS.finance, 30),
	};
	const years = yearsFrom(blob);
	const score =
		hits.timeline.length +
		hits.naming.length +
		hits.hiding.length * 1.2 +
		hits.finance.length * 1.1 +
		(bundle?.cues?.length ? Math.min(20, Math.log10(bundle.cues.length + 1) * 8) : 0);

	const deep = DEEP_DONE.has(row.id);
	const md = [
		`# Scrub P${String(row.i).padStart(3, '0')} — ${info.title || row.title}`,
		'',
		`**Source:** https://www.youtube.com/watch?v=${row.id}`,
		`**Playlist index:** ${row.i}`,
		`**Channel:** ${info.channel || info.uploader || '?'}`,
		`**Upload:** ${info.upload_date || '?'}`,
		`**Duration:** ${info.duration_string || row.dur + 's'}`,
		`**Views:** ${info.view_count ?? '?'}`,
		`**Mode:** ${deep ? 'DEEP (see SCRUB-01..05 crosswalk)' : 'AUTO pattern card'}`,
		`**Signal score:** ${score.toFixed(1)}`,
		'',
		'## Description (trimmed)',
		'',
		String(info.description || '').slice(0, 1800) || '_none_',
		'',
		'## Chapters',
		'',
		chapters.length ? chapters.map((c) => `- ${c}`).join('\n') : '_none_',
		'',
		'## Timeline years (caption/meta frequency)',
		'',
		years.length ? years.map((y) => `- ${y.year}: ${y.n}`).join('\n') : '_none_',
		'',
		'## Pattern hits',
		'',
		'### Timeline / ops',
		hits.timeline.map((h) => `- ${h.term} (${h.n})`).join('\n') || '_none_',
		'',
		'### Naming / shells',
		hits.naming.map((h) => `- ${h.term} (${h.n})`).join('\n') || '_none_',
		'',
		'### Hiding / concealment',
		hits.hiding.map((h) => `- ${h.term} (${h.n})`).join('\n') || '_none_',
		'',
		'### Finance / intent',
		hits.finance.map((h) => `- ${h.term} (${h.n})`).join('\n') || '_none_',
		'',
		'## Notes',
		'',
		deep
			? `- Already deep-scrubbed in concealment thread (Athens/Marconi/Falklands/Occult).`
			: `- Auto-extracted; elevate to DEEP if signal score high or user flags.`,
		`- Captions cues: ${bundle?.cues?.length ?? 0}`,
		'',
	].join('\n');

	return {
		id: row.id,
		i: row.i,
		title: info.title || row.title,
		channel: info.channel || info.uploader || null,
		upload_date: info.upload_date || null,
		duration: info.duration || row.dur,
		score,
		deep,
		years,
		hits,
		hasCaptions: Boolean(bundle?.cues?.length),
		md,
	};
}

async function mapPool(items, concurrency, fn) {
	const ret = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			ret[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return ret;
}

async function main() {
	ensureDir(OUT);
	ensureDir(path.join(OUT, 'raw'));
	ensureDir(path.join(OUT, 'cards'));

	const sourceLabel = INDEX_FILE || PLAYLIST;
	console.log(`[playlist] listing ${sourceLabel}`);
	const allRows = await listPlaylist();
	fs.writeFileSync(path.join(OUT, 'playlist-index.json'), JSON.stringify(allRows, null, 2));
	console.log(`[playlist] ${allRows.length} videos, ~${(allRows.reduce((a, r) => a + r.dur, 0) / 3600).toFixed(1)} h`);

	const rows =
		ONLY_IDS.size > 0 ? allRows.filter((r) => ONLY_IDS.has(r.id)) : allRows;
	if (ONLY_IDS.size > 0) {
		console.log(`[playlist] ONLY_IDS filter → ${rows.length}/${allRows.length}`);
	}

	if (!SKIP_DOWNLOAD) {
		let done = 0;
		let fail = 0;
		await mapPool(rows, CONCURRENCY, async (row) => {
			try {
				const r = await fetchVideo(row.id);
				done += 1;
				if (done % 5 === 0 || !r.skipped) {
					console.log(
						`[fetch] ${done}/${rows.length} ${row.id} ${r.skipped ? 'cached' : 'downloaded'} subs=${r.hasSubs ? 'y' : 'n'} — ${row.title.slice(0, 55)}`,
					);
				}
				const delay = r.rateLimited ? Math.max(FETCH_DELAY_MS, RATE_COOLDOWN_MS) : FETCH_DELAY_MS;
				await sleep(delay);
			} catch (err) {
				fail += 1;
				console.warn(`[fetch-fail] ${row.id}: ${String(err).slice(0, 200)}`);
				fs.appendFileSync(
					path.join(OUT, 'fetch-errors.log'),
					`${new Date().toISOString()} ${row.id} ${String(err).slice(0, 300)}\n`,
				);
				await sleep(Math.max(FETCH_DELAY_MS, 8000));
			}
		});
		console.log(`[fetch] complete done=${done} fail=${fail} mode=${META_ONLY ? 'meta' : CAPTIONS_ONLY ? 'captions' : 'full'}`);
	}

	// Write/refresh cards for the work set
	for (const row of rows) {
		const bundle = loadVideoBundle(row.id);
		const card = scrubCard(row, bundle);
		const cardPath = path.join(OUT, 'cards', `P${String(row.i).padStart(3, '0')}-${row.id}.md`);
		fs.writeFileSync(cardPath, card.md);
		if (bundle?.transcript) {
			fs.writeFileSync(path.join(OUT, 'raw', row.id, 'transcript.txt'), bundle.transcript);
		}
	}

	const indexRows = REBUILD_FULL_INDEX ? allRows : rows;
	const cards = [];
	for (const row of indexRows) {
		const bundle = loadVideoBundle(row.id);
		const card = scrubCard(row, bundle);
		cards.push(card);
		const cardPath = path.join(OUT, 'cards', `P${String(row.i).padStart(3, '0')}-${row.id}.md`);
		fs.writeFileSync(cardPath, card.md);
	}

	cards.sort((a, b) => b.score - a.score);
	fs.writeFileSync(path.join(OUT, 'cards-rank.json'), JSON.stringify(cards, null, 2));

	const indexMd = [
		'# Playlist concealment scrub — master index',
		'',
		`**Source:** ${sourceLabel}`,
		`**Videos:** ${indexRows.length}`,
		`**Generated:** ${new Date().toISOString()}`,
		`**Deep already done:** ${[...DEEP_DONE].join(', ')}`,
		'',
		'## Method',
		'',
		'- AUTO cards: title/description/chapters + English captions keyword extraction',
		'- Axes: timeline/ops · naming/shells · hiding · finance/intent',
		'- Elevate high-score AUTO cards to DEEP on request',
		'',
		'## Top signal (auto score)',
		'',
		'| Score | # | Title | Captions |',
		'|---:|---:|---|---|',
		...cards.slice(0, 40).map(
			(c) =>
				`| ${c.score.toFixed(1)} | ${c.i} | [${c.title.replace(/\|/g, '/')}](cards/P${String(c.i).padStart(3, '0')}-${c.id}.md) | ${c.hasCaptions ? 'yes' : 'no'} |`,
		),
		'',
		'## Full playlist order',
		'',
		'| # | ID | Dur(s) | Score | Title |',
		'|---:|---|---:|---:|---|',
		...indexRows.map((r) => {
			const c = cards.find((x) => x.id === r.id);
			return `| ${r.i} | ${r.id} | ${r.dur} | ${(c?.score || 0).toFixed(1)} | ${r.title.replace(/\|/g, '/')} |`;
		}),
		'',
	].join('\n');
	fs.writeFileSync(path.join(OUT, 'INDEX.md'), indexMd);
	console.log(`[scrub] wrote ${cards.length} cards → ${OUT}`);
}

main().catch((err) => {
	console.error('FATAL', err);
	process.exit(1);
});
