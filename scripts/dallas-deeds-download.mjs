#!/usr/bin/env node
/**
 * Download Dallas County TX recorded Property Records (RP) metadata since 2016
 * from dallas.tx.publicsearch.us (GovOS/Neumo/Kofile).
 *
 * Uses Playwright (Cloudflare) + in-page WebSocket:
 *   type: "@kofile/FETCH_DOCUMENTS/v4"
 *   query: { department:"RP", recordedDateRange:"YYYYMMDD,YYYYMMDD", limit:50, offset, searchType:"advancedSearch" }
 *
 * Writes:
 *   .data/dallas-deeds/records/YYYY/YYYY-MM-DD.jsonl
 *   .data/dallas-deeds/digests/YYYY-MM.md
 *   .data/dallas-deeds/state.json
 *   .data/dallas-deeds/OVERVIEW.md
 *
 * Usage:
 *   node scripts/dallas-deeds-download.mjs
 *   START=2016-01-01 END=2016-01-31 node scripts/dallas-deeds-download.mjs
 *   DEPARTMENTS=RP,FC node scripts/dallas-deeds-download.mjs
 *   HEADED=1 node scripts/dallas-deeds-download.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'dallas-deeds');
const RECORDS = path.join(OUT, 'records');
const DIGESTS = path.join(OUT, 'digests');
const STATE_PATH = path.join(OUT, 'state.json');

const BASE = 'https://dallas.tx.publicsearch.us';
const PAGE_SIZE = 50;
const START = String(process.env.START || '2016-01-01');
const END = String(process.env.END || todayISO());
const DEPARTMENTS = String(process.env.DEPARTMENTS || 'RP')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const HEADED = process.env.HEADED === '1';
const DAY_DELAY_MS = Number(process.env.DALLAS_DAY_DELAY_MS || 250);
const PAGE_DELAY_MS = Number(process.env.DALLAS_PAGE_DELAY_MS || 120);
const NAV_TIMEOUT_MS = Number(process.env.DALLAS_NAV_TIMEOUT_MS || 120_000);
const FETCH_TIMEOUT_MS = Number(process.env.DALLAS_FETCH_TIMEOUT_MS || 60_000);
const MAX_RETRIES = Number(process.env.DALLAS_MAX_RETRIES || 6);

function todayISO() {
	const d = new Date();
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs() {
	fs.mkdirSync(RECORDS, { recursive: true });
	fs.mkdirSync(DIGESTS, { recursive: true });
}

function loadState() {
	if (!fs.existsSync(STATE_PATH)) {
		return {
			start: START,
			end: END,
			departments: DEPARTMENTS,
			nextDate: START,
			completedDays: 0,
			savedDocs: 0,
			errors: [],
			updatedAt: null,
		};
	}
	return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function parseISO(iso) {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function formatISO(d) {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function toCompact(iso) {
	return iso.replaceAll('-', '');
}

function* eachDay(startISO, endISO) {
	let cur = parseISO(startISO);
	const end = parseISO(endISO);
	while (cur <= end) {
		yield formatISO(cur);
		cur = new Date(cur.getTime() + 86_400_000);
	}
}

function slimDoc(d) {
	const grantor = cleanNameList(d.grantor);
	const grantee = cleanNameList(d.grantee);
	const parties = Array.isArray(d.parties)
		? d.parties
				.filter((p) => p && p.name && !p.overflowMsg)
				.map((p) => ({
					type: p.type || null,
					name: p.name,
					partyTypeCode: p.partyTypeCode || null,
					isDirect: p.isDirect ?? null,
				}))
		: [];
	const legals = Array.isArray(d.legals)
		? d.legals
				.filter((l) => l && !l.overflowMsg)
				.map((l) => ({
					legalType: l.legalType || null,
					description: l.description || null,
					developmentName: l.developmentName || null,
					lot: l.lot || null,
					block: l.block || null,
					block2: l.block2 || null,
					township: l.township || null,
					lglBook: l.lglBook || null,
					lglPage: l.lglPage || null,
				}))
		: [];

	return {
		id: d.id ?? d.docId ?? null,
		docNumber: d.docNumber || d.documentNumber || d.instrumentNumber || null,
		docType: d.docType || null,
		docTypeCode: d.docTypeCode || null,
		docGroup: d.docGroup || null,
		recordedDate: d.recordedDate || null,
		recordedTime: d.recordedTime || null,
		instrumentDate: d.instrumentDate || null,
		grantor,
		grantee,
		parties,
		legals,
		legalDescription: cleanNameList(d.legalDescription),
		bookVolumePage: d.bookVolumePage || null,
		pageCount: d.pageCount ?? null,
		year: d.year ?? null,
		isSecured: d.isSecured ?? null,
		downloadLink: d.downloadLink || null,
		rsId: d.rsId || null,
	};
}

function cleanNameList(v) {
	if (!Array.isArray(v)) return [];
	return v.map((x) => String(x || '').trim()).filter(Boolean);
}

function dayFile(dept, iso) {
	const year = iso.slice(0, 4);
	const dir = path.join(RECORDS, dept, year);
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${iso}.jsonl`);
}

function dayDone(dept, iso) {
	// Presence means fetched (including legitimately empty days).
	return fs.existsSync(dayFile(dept, iso));
}

async function waitForSocket(page, timeoutMs = 60_000) {
	await page.waitForFunction(
		() =>
			Boolean(
				globalThis.__ort &&
					globalThis.socket &&
					typeof globalThis.socket.send === 'function' &&
					typeof globalThis.socket.onAPIMsg === 'function',
			),
		{ timeout: timeoutMs },
	);
}

async function ensureSession(page, { forceReload = false } = {}) {
	if (forceReload || !page.url().includes('dallas.tx.publicsearch.us')) {
		await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
	}
	// Cloudflare interstitial or slow WS boot
	for (let i = 0; i < 6; i++) {
		const challenge = await page.evaluate(() => {
			const t = (document.body?.innerText || '') + ' ' + (document.title || '');
			return /just a moment|security verification|cf-browser-verification|challenge-platform/i.test(t);
		});
		if (challenge) {
			console.warn(`[session] CF challenge detected attempt=${i + 1}, waiting…`);
			await page.waitForTimeout(8000 + i * 3000);
		}
		try {
			await waitForSocket(page, 45_000);
			break;
		} catch (err) {
			console.warn(`[session] socket wait failed attempt=${i + 1}: ${String(err).slice(0, 120)}`);
			await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
			await page.waitForTimeout(3000 * (i + 1));
			if (i === 5) throw err;
		}
	}
	await installFetchHelper(page);
	const ort = await page.evaluate(() => globalThis.__ort || null);
	if (!ort) throw new Error('No window.__ort after session ensure');
	return ort;
}

async function installFetchHelper(page) {
	await page.evaluate(() => {
		// Always (re)bind on the current document — SPA reloads clear prior hooks.
		globalThis.__dallasPending = new Map();
		const sock = globalThis.socket;
		if (!sock || typeof sock.onAPIMsg !== 'function' || typeof sock.send !== 'function') {
			throw new Error('socket API not ready');
		}
		sock.onAPIMsg((msg) => {
			if (!msg || !msg.correlationId) return;
			const pending = globalThis.__dallasPending.get(msg.correlationId);
			if (!pending) return;
			const type = String(msg.type || '');
			if (type === '@kofile/FETCH_DOCUMENTS_FULFILLED/v6') {
				pending.resolve(msg);
				globalThis.__dallasPending.delete(msg.correlationId);
			} else if (type.includes('REJECTED') || type.toLowerCase().includes('error-fetching')) {
				pending.reject(new Error(type + ' ' + JSON.stringify(msg.payload || {}).slice(0, 300)));
				globalThis.__dallasPending.delete(msg.correlationId);
			}
		});
		globalThis.__dallasFetchDocs = (query, timeoutMs) =>
			new Promise((resolve, reject) => {
				const correlationId = crypto.randomUUID();
				const workspaceID = 'dl-' + correlationId.slice(0, 10);
				const timer = setTimeout(() => {
					globalThis.__dallasPending.delete(correlationId);
					reject(new Error('fetch timeout'));
				}, timeoutMs);
				globalThis.__dallasPending.set(correlationId, {
					resolve: (msg) => {
						clearTimeout(timer);
						resolve(msg);
					},
					reject: (err) => {
						clearTimeout(timer);
						reject(err);
					},
				});
				if (!globalThis.__ort) {
					clearTimeout(timer);
					globalThis.__dallasPending.delete(correlationId);
					reject(new Error('missing __ort'));
					return;
				}
				globalThis.socket.send({
					type: '@kofile/FETCH_DOCUMENTS/v4',
					payload: { query, workspaceID },
					authToken: globalThis.__ort,
					correlationId,
					cid: correlationId,
					sync: true,
				});
			});
		globalThis.__dallasFetchInstalled = true;
	});
}

async function fetchPage(page, { department, dateCompact, offset }) {
	return page.evaluate(
		async ({ department, dateCompact, offset, limit, timeoutMs }) => {
			const msg = await globalThis.__dallasFetchDocs(
				{
					limit,
					offset,
					department,
					recordedDateRange: `${dateCompact},${dateCompact}`,
					searchType: 'advancedSearch',
				},
				timeoutMs,
			);
			const meta = msg.payload?.meta || {};
			const data = msg.payload?.data || {};
			const byOrder = data.byOrder || [];
			const byHash = data.byHash || {};
			const docs = byOrder.map((id) => byHash[String(id)] || byHash[id]).filter(Boolean);
			return {
				numRecords: meta.numRecords ?? 0,
				statistics: meta.statistics || null,
				docs,
			};
		},
		{
			department,
			dateCompact,
			offset,
			limit: PAGE_SIZE,
			timeoutMs: FETCH_TIMEOUT_MS,
		},
	);
}

async function downloadDay(page, state, dept, iso) {
	const outFile = dayFile(dept, iso);
	if (dayDone(dept, iso)) {
		const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).length;
		console.log(`[skip] ${dept} ${iso} already have ${lines} rows`);
		return { saved: lines, skipped: true };
	}

	const dateCompact = toCompact(iso);
	let offset = 0;
	let numRecords = null;
	let saved = 0;
	const tmp = outFile + '.partial';
	if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
	const ws = fs.createWriteStream(tmp, { flags: 'w' });
	const typeCounts = new Map();
	let statistics = null;
	let failed = false;

	try {
		while (true) {
			let attempt = 0;
			let pageResult;
			for (;;) {
				attempt += 1;
				try {
					pageResult = await fetchPage(page, { department: dept, dateCompact, offset });
					break;
				} catch (err) {
					console.warn(
						`[retry] ${dept} ${iso} offset=${offset} attempt=${attempt}: ${String(err).slice(0, 160)}`,
					);
					if (attempt >= MAX_RETRIES) throw err;
					await sleep(2000 * attempt);
					await ensureSession(page, { forceReload: true });
				}
			}

			if (numRecords == null) {
				numRecords = Number(pageResult.numRecords || 0);
				statistics = pageResult.statistics;
				console.log(`[day] ${dept} ${iso} numRecords=${numRecords}`);
			}

			const docs = pageResult.docs || [];
			if (docs.length === 0) break;

			for (const raw of docs) {
				const doc = slimDoc(raw);
				ws.write(JSON.stringify(doc) + '\n');
				saved += 1;
				const code = doc.docTypeCode || doc.docType || 'UNKNOWN';
				typeCounts.set(code, (typeCounts.get(code) || 0) + 1);
			}

			offset += docs.length;
			if (offset >= numRecords) break;
			if (docs.length < PAGE_SIZE) break;
			await sleep(PAGE_DELAY_MS);
		}
	} catch (err) {
		failed = true;
		throw err;
	} finally {
		await new Promise((resolve) => ws.end(resolve));
		if (failed && fs.existsSync(tmp)) {
			try {
				fs.unlinkSync(tmp);
			} catch {}
		}
	}

	fs.renameSync(tmp, outFile);
	upsertDayDigest(dept, iso, { saved, numRecords: numRecords ?? saved, typeCounts, statistics });
	state.savedDocs += saved;
	state.completedDays += 1;
	saveState(state);
	return { saved, skipped: false, numRecords };
}

function upsertDayDigest(dept, iso, { saved, numRecords, typeCounts, statistics }) {
	const month = iso.slice(0, 7);
	const digestPath = path.join(DIGESTS, `${dept}-${month}.md`);
	let existing = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8') : '';
	if (!existing) {
		existing = `# Dallas County ${dept} — ${month}\n\nSource: dallas.tx.publicsearch.us Property Records metadata.\n\n`;
	}

	const topTypes = [...typeCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([k, v]) => `${k}:${v}`)
		.join(', ');

	const line = `- ${iso}: saved=${saved}/${numRecords}${topTypes ? ` | ${topTypes}` : ''}`;
	const re = new RegExp(`^- ${iso}:.*$`, 'm');
	if (re.test(existing)) existing = existing.replace(re, line);
	else existing = existing.trimEnd() + '\n' + line + '\n';

	if (statistics?.docTypes && !existing.includes('## Server docTypes snapshot')) {
		const snap = statistics.docTypes
			.slice()
			.sort((a, b) => (b.hits || 0) - (a.hits || 0))
			.slice(0, 30)
			.map((t) => `- ${t.label}: ${t.hits}`)
			.join('\n');
		existing += `\n## Server docTypes snapshot (last day touched)\n${snap}\n`;
	}

	fs.writeFileSync(digestPath, existing);
}

function writeOverview(state) {
	const lines = [
		'# Dallas County recorded instruments (publicsearch)',
		'',
		`Source: ${BASE} (GovOS/Neumo/Kofile tenant 48113)`,
		`Departments: ${DEPARTMENTS.join(', ')}`,
		`Range: ${state.start} → ${state.end}`,
		`Next date: ${state.nextDate}`,
		`Completed days: ${state.completedDays}`,
		`Saved docs: ${state.savedDocs}`,
		`Updated: ${state.updatedAt || ''}`,
		'',
		'Metadata only (no PDFs). Fields: docNumber, docType, recorded/instrument dates, grantor/grantee, parties, legals, pageCount, downloadLink.',
		'',
		'Layout:',
		'- `records/<DEPT>/<YYYY>/<YYYY-MM-DD>.jsonl`',
		'- `digests/<DEPT>-<YYYY-MM>.md`',
		'- `state.json`',
		'',
	];
	fs.writeFileSync(path.join(OUT, 'OVERVIEW.md'), lines.join('\n'));
}

async function main() {
	ensureDirs();
	const state = loadState();
	// Preserve overall range; START/END only control this run's cursor.
	state.originalStart = state.originalStart || state.start || START;
	state.start = state.originalStart;
	if (process.env.END) state.end = END;
	else if (!state.end || parseISO(END) > parseISO(state.end)) state.end = END;
	state.departments = DEPARTMENTS;
	const runStart = process.env.START ? START : state.nextDate || state.start || START;
	state.nextDate = runStart;
	saveState(state);
	writeOverview(state);

	console.log(
		`Dallas deeds download: depts=${DEPARTMENTS.join(',')} ${runStart} → ${state.end} (PAGE_SIZE=${PAGE_SIZE})`,
	);

	const session = {
		browser: null,
		context: null,
		page: null,
	};

	async function openSession() {
		if (session.browser) {
			try {
				await session.browser.close();
			} catch {}
		}
		session.browser = await chromium.launch({ headless: !HEADED });
		session.context = await session.browser.newContext({
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
			viewport: { width: 1400, height: 900 },
		});
		session.page = await session.context.newPage();
		const ort = await ensureSession(session.page, { forceReload: true });
		console.log('session ok ort=', ort);
		return ort;
	}

	async function softRefresh() {
		try {
			await ensureSession(session.page, { forceReload: true });
			console.log('[session] soft refresh ok');
			return true;
		} catch (err) {
			console.warn(`[session] soft refresh failed: ${String(err).slice(0, 160)}`);
			return false;
		}
	}

	async function hardRefresh() {
		console.log('[session] hard refresh (new browser)');
		await sleep(5000);
		await openSession();
	}

	let daysSinceRefresh = 0;

	try {
		await openSession();

		for (const iso of eachDay(runStart, state.end)) {
			for (const dept of DEPARTMENTS) {
				try {
					const result = await downloadDay(session.page, state, dept, iso);
					if (!result.skipped) {
						console.log(`[ok] ${dept} ${iso} saved=${result.saved}`);
						daysSinceRefresh += 1;
					}
				} catch (err) {
					const msg = String(err).slice(0, 300);
					console.error(`[error] ${dept} ${iso}: ${msg}`);
					state.errors = (state.errors || []).slice(-50);
					state.errors.push({ at: new Date().toISOString(), dept, iso, error: msg });
					saveState(state);
					try {
						if (!(await softRefresh())) await hardRefresh();
						daysSinceRefresh = 0;
						const retry = await downloadDay(session.page, state, dept, iso);
						console.log(`[recovered] ${dept} ${iso} saved=${retry.saved}`);
					} catch (err2) {
						console.error(`[give-up] ${dept} ${iso}: ${String(err2).slice(0, 300)}`);
						try {
							await hardRefresh();
						} catch (err3) {
							console.error(`[session] hard refresh failed: ${String(err3).slice(0, 200)}`);
							await sleep(30_000);
							try {
								await hardRefresh();
							} catch (err4) {
								console.error(`[session] hard refresh retry failed: ${String(err4).slice(0, 200)}`);
							}
						}
					}
				}
				await sleep(DAY_DELAY_MS);
			}
			state.nextDate = formatISO(new Date(parseISO(iso).getTime() + 86_400_000));
			saveState(state);
			if (state.completedDays % 7 === 0) writeOverview(state);

			// Soft proactive refresh; never abort the run if it fails.
			if (daysSinceRefresh >= 20) {
				console.log('[session] proactive soft refresh');
				if (!(await softRefresh())) {
					try {
						await hardRefresh();
					} catch (err) {
						console.warn(`[session] proactive hard refresh failed, continuing: ${String(err).slice(0, 160)}`);
					}
				}
				daysSinceRefresh = 0;
			}
		}
		writeOverview(state);

		console.log(`DONE savedDocs=${state.savedDocs} completedDays=${state.completedDays}`);
	} finally {
		if (session.browser) {
			try {
				await session.browser.close();
			} catch {}
		}
	}
}

main().catch((err) => {
	console.error('FATAL', err);
	process.exit(1);
});
