#!/usr/bin/env node
/**
 * Download Oklahoma & Texas tornado data since 2016 from:
 *  - NOAA SPC severe weather database (actual tornado tracks)
 *  - NCEI Storm Events Database (tornado event narratives)
 *
 * Writes JSON + monthly/yearly digests under .data/tornadoes/ for knowledge ingest.
 *
 * Usage:
 *   node scripts/tornado-spc-ncei-download.mjs
 *   START_YEAR=2016 node scripts/tornado-spc-ncei-download.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'tornadoes');
const USER_AGENT = 'ai-research-tool/1.0 (local research; SPC+NCEI tornado mirror)';

const START_YEAR = Number(process.env.START_YEAR || 2016);
const END_YEAR = Number(process.env.END_YEAR || new Date().getUTCFullYear());
const SLEEP_MS = Number(process.env.TORNADO_SLEEP_MS || 300);

const SPC_ACTUAL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_actual_tornadoes.csv';
const SPC_ALL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const NCEI_INDEX = 'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/';

const STATE_MAP = {
	OK: 'oklahoma',
	TX: 'texas',
	OKLAHOMA: 'oklahoma',
	TEXAS: 'texas',
};

const STATE_LABEL = { oklahoma: 'Oklahoma', texas: 'Texas' };

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

async function fetchBuffer(url) {
	const res = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
		cache: 'no-store',
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 180)}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url) {
	return (await fetchBuffer(url)).toString('utf8');
}

/** Minimal CSV parser that handles quoted fields. */
function parseCsv(text) {
	const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
	if (!lines.length) return [];
	const header = splitCsvLine(lines[0]);
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const cols = splitCsvLine(line);
		const row = {};
		for (let c = 0; c < header.length; c++) row[header[c]] = cols[c] ?? '';
		rows.push(row);
	}
	return rows;
}

function splitCsvLine(line) {
	const out = [];
	let cur = '';
	let inQ = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQ) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i += 1;
				} else inQ = false;
			} else cur += ch;
		} else if (ch === '"') inQ = true;
		else if (ch === ',') {
			out.push(cur);
			cur = '';
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

function efLabel(mag) {
	const n = Number(mag);
	if (!Number.isFinite(n) || n < 0) return 'EFU';
	return `EF${Math.trunc(n)}`;
}

function normalizeSpc(row) {
	const st = String(row.st || '').toUpperCase();
	const stateKey = STATE_MAP[st];
	if (!stateKey) return null;
	const yr = Number(row.yr);
	if (!Number.isFinite(yr) || yr < START_YEAR || yr > END_YEAR) return null;
	const date = String(row.date || '').slice(0, 10);
	const time = String(row.time || '').slice(0, 8);
	const mag = Number(row.mag);
	return {
		source: 'spc',
		id: `spc-${row.om}-${date}`,
		om: row.om,
		state: stateKey,
		st,
		year: yr,
		month: Number(row.mo) || Number(date.slice(5, 7)) || null,
		day: Number(row.dy) || null,
		date,
		time,
		tz: row.tz || null,
		mag: Number.isFinite(mag) ? mag : null,
		ef: efLabel(mag),
		injuries: Number(row.inj) || 0,
		fatalities: Number(row.fat) || 0,
		loss: row.loss != null && row.loss !== '' ? Number(row.loss) : null,
		slat: row.slat !== '' ? Number(row.slat) : null,
		slon: row.slon !== '' ? Number(row.slon) : null,
		elat: row.elat !== '' ? Number(row.elat) : null,
		elon: row.elon !== '' ? Number(row.elon) : null,
		lenMiles: row.len !== '' ? Number(row.len) : null,
		widYards: row.wid !== '' ? Number(row.wid) : null,
		fips: [row.f1, row.f2, row.f3, row.f4].filter((x) => x && x !== '0'),
	};
}

function normalizeNcei(row) {
	const stateKey = STATE_MAP[String(row.STATE || '').toUpperCase()];
	if (!stateKey) return null;
	if (String(row.EVENT_TYPE || '') !== 'Tornado') return null;
	const year = Number(row.YEAR);
	if (!Number.isFinite(year) || year < START_YEAR || year > END_YEAR) return null;
	const begin = String(row.BEGIN_DATE_TIME || '');
	const scale = String(row.TOR_F_SCALE || '').trim() || 'EFU';
	const magMatch = scale.match(/EF\s*([0-5])/i);
	const mag = magMatch ? Number(magMatch[1]) : scale.toUpperCase() === 'EFU' ? -9 : null;
	return {
		source: 'ncei',
		id: `ncei-${row.EVENT_ID}`,
		eventId: row.EVENT_ID,
		episodeId: row.EPISODE_ID,
		state: stateKey,
		year,
		monthName: row.MONTH_NAME || '',
		beginDateTime: begin,
		endDateTime: row.END_DATE_TIME || '',
		county: row.CZ_NAME || '',
		wfo: row.WFO || '',
		ef: scale.replace(/\s+/g, ''),
		mag,
		injuries: Number(row.INJURIES_DIRECT || 0) + Number(row.INJURIES_INDIRECT || 0),
		fatalities: Number(row.DEATHS_DIRECT || 0) + Number(row.DEATHS_INDIRECT || 0),
		damageProperty: row.DAMAGE_PROPERTY || '',
		damageCrops: row.DAMAGE_CROPS || '',
		lenMiles: row.TOR_LENGTH !== '' ? Number(row.TOR_LENGTH) : null,
		widYards: row.TOR_WIDTH !== '' ? Number(row.TOR_WIDTH) : null,
		beginLat: row.BEGIN_LAT !== '' ? Number(row.BEGIN_LAT) : null,
		beginLon: row.BEGIN_LON !== '' ? Number(row.BEGIN_LON) : null,
		endLat: row.END_LAT !== '' ? Number(row.END_LAT) : null,
		endLon: row.END_LON !== '' ? Number(row.END_LON) : null,
		eventNarrative: String(row.EVENT_NARRATIVE || '').trim(),
		episodeNarrative: String(row.EPISODE_NARRATIVE || '').trim(),
	};
}

function monthKeyFromSpc(e) {
	if (e.date && e.date.length >= 7) return e.date.slice(0, 7);
	if (e.year && e.month) return `${e.year}-${String(e.month).padStart(2, '0')}`;
	return null;
}

function monthKeyFromNcei(e) {
	const months = {
		January: '01',
		February: '02',
		March: '03',
		April: '04',
		May: '05',
		June: '06',
		July: '07',
		August: '08',
		September: '09',
		October: '10',
		November: '11',
		December: '12',
	};
	const m = months[e.monthName];
	if (e.year && m) return `${e.year}-${m}`;
	const d = String(e.beginDateTime || '');
	// 27-APR-24 22:21:00
	const mm = d.match(/-([A-Z]{3})-(\d{2})\b/i);
	if (mm) {
		const map = {
			JAN: '01',
			FEB: '02',
			MAR: '03',
			APR: '04',
			MAY: '05',
			JUN: '06',
			JUL: '07',
			AUG: '08',
			SEP: '09',
			OCT: '10',
			NOV: '11',
			DEC: '12',
		};
		const mon = map[mm[1].toUpperCase()];
		const yy = Number(mm[2]);
		const year = yy >= 70 ? 1900 + yy : 2000 + yy;
		if (mon) return `${year}-${mon}`;
	}
	return e.year ? `${e.year}-01` : null;
}

function formatSpcLine(e) {
	const start =
		e.slat != null && e.slon != null ? `${e.slat.toFixed(3)},${e.slon.toFixed(3)}` : 'n/a';
	const path =
		e.lenMiles != null || e.widYards != null
			? ` path=${e.lenMiles ?? '?'}mi × ${e.widYards ?? '?'}yd`
			: '';
	const harm =
		e.fatalities || e.injuries ? ` fat=${e.fatalities} inj=${e.injuries}` : '';
	return `${e.date} ${e.time} ${STATE_LABEL[e.state]} ${e.ef} start=${start}${path}${harm} om=${e.om}`;
}

function formatNceiLine(e) {
	const coords =
		e.beginLat != null && e.beginLon != null
			? ` ${e.beginLat.toFixed(3)},${e.beginLon.toFixed(3)}`
			: '';
	const harm =
		e.fatalities || e.injuries ? ` fat=${e.fatalities} inj=${e.injuries}` : '';
	const narr = (e.eventNarrative || '').replace(/\s+/g, ' ').trim().slice(0, 280);
	return `${e.beginDateTime} ${STATE_LABEL[e.state]} ${e.county} ${e.ef}${coords}${harm} id=${e.eventId}${narr ? ` — ${narr}` : ''}`;
}

function writeMonthlySpcDigests(stateKey, events) {
	const digestsDir = path.join(OUT, stateKey, 'digests');
	ensureDir(digestsDir);
	const byMonth = new Map();
	for (const e of events) {
		const mk = monthKeyFromSpc(e);
		if (!mk) continue;
		if (!byMonth.has(mk)) byMonth.set(mk, []);
		byMonth.get(mk).push(e);
	}
	const written = [];
	for (const [mk, list] of [...byMonth.entries()].sort()) {
		list.sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
		const efCounts = {};
		for (const e of list) efCounts[e.ef] = (efCounts[e.ef] || 0) + 1;
		const fats = list.reduce((s, e) => s + (e.fatalities || 0), 0);
		const injs = list.reduce((s, e) => s + (e.injuries || 0), 0);
		const text = [
			`# SPC tornadoes — ${STATE_LABEL[stateKey]} — ${mk}`,
			'',
			`- Source: NOAA Storm Prediction Center severe weather database (actual tracks)`,
			`- Count: ${list.length}`,
			`- Fatalities: ${fats}`,
			`- Injuries: ${injs}`,
			`- EF breakdown: ${Object.entries(efCounts)
				.sort()
				.map(([k, v]) => `${k}=${v}`)
				.join(', ')}`,
			'',
			'## Events',
			'',
			...list.map(formatSpcLine),
			'',
		].join('\n');
		const file = path.join(digestsDir, `spc-${mk}.md`);
		fs.writeFileSync(file, text, 'utf8');
		written.push({ month: mk, count: list.length, file });
	}
	return written;
}

function writeYearSummarySpc(stateKey, year, events) {
	const digestsDir = path.join(OUT, stateKey, 'digests');
	ensureDir(digestsDir);
	const efCounts = {};
	let fats = 0;
	let injs = 0;
	for (const e of events) {
		efCounts[e.ef] = (efCounts[e.ef] || 0) + 1;
		fats += e.fatalities || 0;
		injs += e.injuries || 0;
	}
	const byMonth = new Map();
	for (const e of events) {
		const mk = monthKeyFromSpc(e);
		if (!mk) continue;
		byMonth.set(mk, (byMonth.get(mk) || 0) + 1);
	}
	const strongest = [...events]
		.filter((e) => e.mag != null && e.mag >= 0)
		.sort((a, b) => b.mag - a.mag || b.fatalities - a.fatalities)
		.slice(0, 15);
	const text = [
		`# SPC yearly tornado summary — ${STATE_LABEL[stateKey]} ${year}`,
		'',
		`- Source: NOAA SPC actual tornado tracks`,
		`- Count: ${events.length}`,
		`- Fatalities: ${fats}`,
		`- Injuries: ${injs}`,
		`- EF breakdown: ${Object.entries(efCounts)
			.sort()
			.map(([k, v]) => `${k}=${v}`)
			.join(', ') || 'n/a'}`,
		'',
		'## Monthly counts',
		'',
		[...byMonth.entries()]
			.sort()
			.map(([mk, c]) => `- ${mk}: ${c}`)
			.join('\n') || '(none)',
		'',
		'## Strongest / notable',
		'',
		...strongest.map(formatSpcLine),
		'',
	].join('\n');
	const file = path.join(digestsDir, `spc-${year}-summary.md`);
	fs.writeFileSync(file, text, 'utf8');
	return { file, count: events.length, fats, injs, efCounts };
}

function writeMonthlyNceiDigests(stateKey, events) {
	const digestsDir = path.join(OUT, stateKey, 'digests');
	ensureDir(digestsDir);
	const byMonth = new Map();
	for (const e of events) {
		const mk = monthKeyFromNcei(e);
		if (!mk) continue;
		if (!byMonth.has(mk)) byMonth.set(mk, []);
		byMonth.get(mk).push(e);
	}
	const written = [];
	for (const [mk, list] of [...byMonth.entries()].sort()) {
		list.sort((a, b) => String(a.beginDateTime).localeCompare(String(b.beginDateTime)));
		// Keep document under knowledge limit: truncate long months
		let lines = list.map(formatNceiLine);
		let body = lines.join('\n');
		if (body.length > 40_000) {
			lines = list.map((e) => {
				const short = {
					...e,
					eventNarrative: (e.eventNarrative || '').slice(0, 120),
				};
				return formatNceiLine(short);
			});
			body = lines.join('\n');
		}
		const fats = list.reduce((s, e) => s + (e.fatalities || 0), 0);
		const text = [
			`# NCEI Storm Events tornadoes — ${STATE_LABEL[stateKey]} — ${mk}`,
			'',
			`- Source: NOAA NCEI Storm Events Database (EVENT_TYPE=Tornado)`,
			`- Count: ${list.length}`,
			`- Fatalities (direct+indirect): ${fats}`,
			`- Note: NCEI rows are often county/segment reports; counts may exceed SPC actual-track totals.`,
			'',
			'## Events + narratives',
			'',
			body,
			'',
		].join('\n');
		const file = path.join(digestsDir, `ncei-${mk}.md`);
		fs.writeFileSync(file, text, 'utf8');
		written.push({ month: mk, count: list.length, file });
	}
	return written;
}

function writeNotable(spcEvents) {
	const notableDir = path.join(OUT, 'notable');
	ensureDir(notableDir);
	const notable = spcEvents
		.filter((e) => (e.mag != null && e.mag >= 2) || (e.fatalities || 0) > 0)
		.sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
	const byYear = new Map();
	for (const e of notable) {
		const y = String(e.year);
		if (!byYear.has(y)) byYear.set(y, []);
		byYear.get(y).push(e);
	}
	const files = [];
	for (const [year, list] of [...byYear.entries()].sort()) {
		const text = [
			`# Notable tornadoes EF2+ or fatal — Oklahoma & Texas — ${year}`,
			'',
			`- Source: NOAA SPC actual tracks`,
			`- Count: ${list.length}`,
			'',
			...list.map((e) => `## ${e.date} ${STATE_LABEL[e.state]} ${e.ef}\n\n${formatSpcLine(e)}\n`),
		].join('\n');
		const file = path.join(notableDir, `${year}-EF2plus-or-fatal.md`);
		fs.writeFileSync(file, text, 'utf8');
		files.push({ year, count: list.length, file });
	}
	fs.writeFileSync(path.join(notableDir, 'notable.json'), JSON.stringify(notable, null, 2));
	return { count: notable.length, files };
}

async function resolveNceiDetailUrls() {
	const html = await fetchText(NCEI_INDEX);
	const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
	const byYear = new Map();
	for (const href of hrefs) {
		const m = href.match(/StormEvents_details-ftp_v1\.0_d(\d{4})_c\d+\.csv\.gz/);
		if (!m) continue;
		const year = Number(m[1]);
		if (year < START_YEAR || year > END_YEAR) continue;
		const url = href.startsWith('http') ? href : new URL(href, NCEI_INDEX).href;
		// Prefer lexicographically latest creation stamp if multiple
		const prev = byYear.get(year);
		if (!prev || url > prev) byYear.set(year, url);
	}
	return byYear;
}

async function main() {
	ensureDir(OUT);
	ensureDir(path.join(OUT, 'spc'));
	ensureDir(path.join(OUT, 'ncei'));
	ensureDir(path.join(OUT, 'oklahoma'));
	ensureDir(path.join(OUT, 'texas'));

	const started = new Date().toISOString();
	console.log('Downloading SPC actual tornadoes…');
	const spcActualText = await fetchText(SPC_ACTUAL);
	fs.writeFileSync(path.join(OUT, 'spc', '1950-2025_actual_tornadoes.csv'), spcActualText);
	await sleep(SLEEP_MS);
	console.log('Downloading SPC all tornadoes (segments)…');
	try {
		const spcAllText = await fetchText(SPC_ALL);
		fs.writeFileSync(path.join(OUT, 'spc', '1950-2025_all_tornadoes.csv'), spcAllText);
	} catch (err) {
		console.warn('SPC all_tornadoes skipped:', err instanceof Error ? err.message : err);
	}

	const spcRows = parseCsv(spcActualText);
	const spcEvents = [];
	for (const row of spcRows) {
		const n = normalizeSpc(row);
		if (n) spcEvents.push(n);
	}
	console.log(`SPC OK/TX ${START_YEAR}–${END_YEAR}: ${spcEvents.length} actual tracks`);

	const nceiByYear = await resolveNceiDetailUrls();
	console.log(`NCEI detail years found: ${[...nceiByYear.keys()].sort().join(', ')}`);
	const nceiEvents = [];
	for (const year of [...nceiByYear.keys()].sort()) {
		const url = nceiByYear.get(year);
		process.stdout.write(`NCEI ${year}… `);
		const gz = await fetchBuffer(url);
		const rawName = path.basename(new URL(url).pathname);
		fs.writeFileSync(path.join(OUT, 'ncei', rawName), gz);
		const csvBuf = await gunzip(gz);
		const rows = parseCsv(csvBuf.toString('utf8'));
		let kept = 0;
		const yearEvents = [];
		for (const row of rows) {
			const n = normalizeNcei(row);
			if (!n) continue;
			kept += 1;
			yearEvents.push(n);
			nceiEvents.push(n);
		}
		fs.writeFileSync(
			path.join(OUT, 'ncei', `tornadoes-OK-TX-${year}.json`),
			JSON.stringify(
				{
					year,
					source: url,
					count: yearEvents.length,
					downloadedAt: new Date().toISOString(),
					events: yearEvents,
				},
				null,
				2,
			),
		);
		console.log(`${kept} OK/TX tornado rows`);
		await sleep(SLEEP_MS);
	}

	const summary = {
		started,
		startYear: START_YEAR,
		endYear: END_YEAR,
		spcSource: SPC_ACTUAL,
		nceiIndex: NCEI_INDEX,
		totals: {
			spcOklahoma: 0,
			spcTexas: 0,
			nceiOklahoma: 0,
			nceiTexas: 0,
			notable: 0,
		},
		regions: {},
	};

	const allSpc = [];
	for (const stateKey of ['oklahoma', 'texas']) {
		const stateSpc = spcEvents.filter((e) => e.state === stateKey);
		const stateNcei = nceiEvents.filter((e) => e.state === stateKey);
		allSpc.push(...stateSpc);
		summary.totals[stateKey === 'oklahoma' ? 'spcOklahoma' : 'spcTexas'] = stateSpc.length;
		summary.totals[stateKey === 'oklahoma' ? 'nceiOklahoma' : 'nceiTexas'] = stateNcei.length;

		ensureDir(path.join(OUT, stateKey, 'digests'));
		fs.writeFileSync(
			path.join(OUT, stateKey, 'spc-events.json'),
			JSON.stringify(
				{
					state: stateKey,
					source: 'spc-actual',
					count: stateSpc.length,
					events: stateSpc,
				},
				null,
				2,
			),
		);
		fs.writeFileSync(
			path.join(OUT, stateKey, 'ncei-events.json'),
			JSON.stringify(
				{
					state: stateKey,
					source: 'ncei-storm-events',
					count: stateNcei.length,
					events: stateNcei,
				},
				null,
				2,
			),
		);

		const monthsSpc = writeMonthlySpcDigests(stateKey, stateSpc);
		const monthsNcei = writeMonthlyNceiDigests(stateKey, stateNcei);
		const years = {};
		for (let y = START_YEAR; y <= END_YEAR; y++) {
			const ye = stateSpc.filter((e) => e.year === y);
			if (ye.length) years[y] = writeYearSummarySpc(stateKey, y, ye);
		}
		summary.regions[stateKey] = {
			spc: stateSpc.length,
			ncei: stateNcei.length,
			spcMonthlyDigests: monthsSpc.length,
			nceiMonthlyDigests: monthsNcei.length,
			years: Object.fromEntries(
				Object.entries(years).map(([y, v]) => [y, { count: v.count, fats: v.fats, injs: v.injs }]),
			),
		};
	}

	const notable = writeNotable(allSpc);
	summary.totals.notable = notable.count;
	summary.finished = new Date().toISOString();

	const overview = [
		`# Oklahoma & Texas tornadoes (SPC + NCEI)`,
		'',
		`- Downloaded: ${summary.finished}`,
		`- Window: ${START_YEAR} → ${END_YEAR}`,
		`- SPC actual tracks — Oklahoma: ${summary.totals.spcOklahoma}, Texas: ${summary.totals.spcTexas}`,
		`- NCEI Storm Events tornado rows — Oklahoma: ${summary.totals.nceiOklahoma}, Texas: ${summary.totals.nceiTexas}`,
		`- Notable (SPC EF2+ or fatal): ${summary.totals.notable}`,
		'',
		'## Sources',
		'',
		`- SPC: ${SPC_ACTUAL}`,
		`- NCEI: ${NCEI_INDEX}`,
		'',
		'## Notes',
		'',
		'- SPC **actual** file = one row per tornado track (preferred for counts).',
		'- NCEI rows are often county/segment reports with narratives; counts can exceed SPC.',
		'- EFU / mag=-9 means unrated / unknown damage rating.',
		'',
		'## Paths',
		'',
		'- `.data/tornadoes/spc/` raw SPC CSV',
		'- `.data/tornadoes/ncei/` yearly gz + filtered JSON',
		'- `.data/tornadoes/{oklahoma,texas}/digests/spc-YYYY-MM.md`',
		'- `.data/tornadoes/{oklahoma,texas}/digests/ncei-YYYY-MM.md`',
		'- `.data/tornadoes/notable/`',
		'',
		'Courtesy: NOAA / NWS Storm Prediction Center and NCEI. Public domain.',
		'',
	].join('\n');

	fs.writeFileSync(path.join(OUT, 'README.md'), overview, 'utf8');
	fs.writeFileSync(path.join(OUT, 'OVERVIEW.md'), overview, 'utf8');
	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

	console.log('\nDone.');
	console.log(JSON.stringify(summary.totals, null, 2));
	console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
