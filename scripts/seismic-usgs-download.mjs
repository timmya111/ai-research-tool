#!/usr/bin/env node
/**
 * Download USGS ComCat earthquakes (M≥2.5) for Oklahoma and Texas since 2016.
 * Writes JSON catalogs + monthly digests under .data/seismic/ for knowledge ingest.
 *
 * Usage:
 *   node scripts/seismic-usgs-download.mjs
 *   MIN_MAG=2.5 START_YEAR=2016 node scripts/seismic-usgs-download.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'seismic');
const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const USER_AGENT = 'ai-research-tool/1.0 (local research; USGS ComCat mirror)';

const MIN_MAG = Number(process.env.MIN_MAG || 2.5);
const START_YEAR = Number(process.env.START_YEAR || 2016);
const END_YEAR = Number(process.env.END_YEAR || new Date().getUTCFullYear());
const SLEEP_MS = Number(process.env.SEISMIC_SLEEP_MS || 400);

/** Rough state bounding boxes (then place-string filtered). */
const REGIONS = {
	oklahoma: {
		label: 'Oklahoma',
		minlatitude: 33.55,
		maxlatitude: 37.15,
		minlongitude: -103.15,
		maxlongitude: -94.25,
		placeRe: /\bOklahoma\b|\bOK\b(?!\w)|Oklahoma-Kansas|Arkansas-Oklahoma|Oklahoma-Texas/i,
	},
	texas: {
		label: 'Texas',
		minlatitude: 25.75,
		maxlatitude: 36.55,
		minlongitude: -106.75,
		maxlongitude: -93.35,
		placeRe: /\bTexas\b|\bTX\b(?!\w)|Texas Panhandle|Oklahoma-Texas|New Mexico-Texas/i,
	},
};

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

function isoDay(d) {
	return d.toISOString().slice(0, 10);
}

function formatEventTime(ms) {
	if (ms == null || !Number.isFinite(Number(ms))) return '';
	return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeFeature(f, stateKey) {
	const p = f?.properties || {};
	const g = f?.geometry?.coordinates || [];
	const lon = Number(g[0]);
	const lat = Number(g[1]);
	const depth = g[2] != null ? Number(g[2]) : null;
	return {
		id: String(f.id || p.code || ''),
		state: stateKey,
		mag: p.mag != null ? Number(p.mag) : null,
		magType: p.magType || null,
		place: p.place || '',
		time: formatEventTime(p.time),
		timeMs: p.time != null ? Number(p.time) : null,
		updated: formatEventTime(p.updated),
		url: p.url || null,
		detail: p.detail || null,
		felt: p.felt ?? null,
		cdi: p.cdi ?? null,
		mmi: p.mmi ?? null,
		alert: p.alert || null,
		status: p.status || null,
		tsunami: p.tsunami ?? null,
		sig: p.sig ?? null,
		net: p.net || null,
		type: p.type || null,
		latitude: Number.isFinite(lat) ? lat : null,
		longitude: Number.isFinite(lon) ? lon : null,
		depthKm: Number.isFinite(depth) ? depth : null,
	};
}

function matchesState(place, region) {
	return region.placeRe.test(String(place || ''));
}

async function fetchYear(regionKey, year) {
	const region = REGIONS[regionKey];
	const start = `${year}-01-01`;
	const end = year === END_YEAR ? isoDay(new Date()) : `${year + 1}-01-01`;
	const params = new URLSearchParams({
		format: 'geojson',
		starttime: start,
		endtime: end,
		minmagnitude: String(MIN_MAG),
		minlatitude: String(region.minlatitude),
		maxlatitude: String(region.maxlatitude),
		minlongitude: String(region.minlongitude),
		maxlongitude: String(region.maxlongitude),
		orderby: 'time-asc',
		limit: '20000',
	});
	const url = `${USGS}?${params}`;
	const res = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
		cache: 'no-store',
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`USGS ${regionKey} ${year} HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	const data = await res.json();
	const features = Array.isArray(data.features) ? data.features : [];
	const events = [];
	let dropped = 0;
	for (const f of features) {
		const place = f?.properties?.place || '';
		if (!matchesState(place, region)) {
			dropped += 1;
			continue;
		}
		events.push(normalizeFeature(f, regionKey));
	}
	return { events, rawCount: features.length, dropped, metadata: data.metadata || null };
}

function monthKey(timeIso) {
	return String(timeIso || '').slice(0, 7); // YYYY-MM
}

function formatDigestLine(e) {
	const mag = e.mag != null ? `M${Number(e.mag).toFixed(1)}` : 'M?';
	const depth = e.depthKm != null ? ` depth=${Number(e.depthKm).toFixed(1)}km` : '';
	const coords =
		e.latitude != null && e.longitude != null
			? ` ${Number(e.latitude).toFixed(3)},${Number(e.longitude).toFixed(3)}`
			: '';
	const url = e.url ? ` ${e.url}` : '';
	return `${e.time} ${mag} ${e.place}${depth}${coords} id=${e.id}${url}`;
}

function writeMonthlyDigests(stateKey, label, events) {
	const digestsDir = path.join(OUT, stateKey, 'digests');
	ensureDir(digestsDir);
	const byMonth = new Map();
	for (const e of events) {
		const mk = monthKey(e.time);
		if (!mk) continue;
		if (!byMonth.has(mk)) byMonth.set(mk, []);
		byMonth.get(mk).push(e);
	}

	const written = [];
	for (const [mk, list] of [...byMonth.entries()].sort()) {
		list.sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));
		const mags = list.map((e) => e.mag).filter((m) => m != null);
		const maxMag = mags.length ? Math.max(...mags) : null;
		const meanMag = mags.length ? mags.reduce((s, m) => s + m, 0) / mags.length : null;
		const lines = [
			`# USGS ComCat — ${label} — ${mk}`,
			'',
			`- Source: USGS Earthquake Hazards Program / ComCat FDSN event service`,
			`- Region: ${label} (bbox query + place-name filter)`,
			`- Min magnitude: ${MIN_MAG}`,
			`- Event count: ${list.length}`,
			`- Max magnitude: ${maxMag != null ? maxMag.toFixed(1) : 'n/a'}`,
			`- Mean magnitude: ${meanMag != null ? meanMag.toFixed(2) : 'n/a'}`,
			`- Catalog mirror path: .data/seismic/${stateKey}/`,
			'',
			'## Events (time-asc)',
			'',
			...list.map(formatDigestLine),
			'',
		];
		const file = path.join(digestsDir, `${mk}.md`);
		fs.writeFileSync(file, lines.join('\n'), 'utf8');
		written.push({ month: mk, count: list.length, file, maxMag });
	}
	return written;
}

function writeYearSummary(stateKey, label, year, events) {
	const digestsDir = path.join(OUT, stateKey, 'digests');
	ensureDir(digestsDir);
	const mags = events.map((e) => e.mag).filter((m) => m != null);
	const maxMag = mags.length ? Math.max(...mags) : null;
	const ge35 = mags.filter((m) => m >= 3.5).length;
	const ge40 = mags.filter((m) => m >= 4.0).length;
	const ge50 = mags.filter((m) => m >= 5.0).length;
	const top = [...events]
		.filter((e) => e.mag != null)
		.sort((a, b) => b.mag - a.mag)
		.slice(0, 15);

	const byMonth = new Map();
	for (const e of events) {
		const mk = monthKey(e.time);
		byMonth.set(mk, (byMonth.get(mk) || 0) + 1);
	}
	const monthRows = [...byMonth.entries()]
		.sort()
		.map(([mk, c]) => `- ${mk}: ${c}`)
		.join('\n');

	const text = [
		`# USGS ComCat yearly summary — ${label} ${year}`,
		'',
		`- Source: USGS ComCat (earthquake.usgs.gov FDSN)`,
		`- Min magnitude: ${MIN_MAG}`,
		`- Events (place-filtered ${label}): ${events.length}`,
		`- Max magnitude: ${maxMag != null ? maxMag.toFixed(1) : 'n/a'}`,
		`- Count M≥3.5: ${ge35}`,
		`- Count M≥4.0: ${ge40}`,
		`- Count M≥5.0: ${ge50}`,
		'',
		'## Monthly counts',
		'',
		monthRows || '(none)',
		'',
		'## Strongest events',
		'',
		...top.map(formatDigestLine),
		'',
	].join('\n');

	const file = path.join(digestsDir, `${year}-summary.md`);
	fs.writeFileSync(file, text, 'utf8');
	return { file, count: events.length, maxMag, ge35, ge40, ge50 };
}

function writeNotable(allEvents) {
	const notableDir = path.join(OUT, 'notable');
	ensureDir(notableDir);
	const notable = allEvents
		.filter((e) => e.mag != null && e.mag >= 4.0)
		.sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));

	const byYear = new Map();
	for (const e of notable) {
		const y = String(e.time || '').slice(0, 4);
		if (!byYear.has(y)) byYear.set(y, []);
		byYear.get(y).push(e);
	}

	const files = [];
	for (const [year, list] of [...byYear.entries()].sort()) {
		const text = [
			`# Notable earthquakes M≥4.0 — Oklahoma & Texas — ${year}`,
			'',
			`- Source: USGS ComCat`,
			`- Count: ${list.length}`,
			'',
			...list.map((e) => {
				const state = e.state === 'oklahoma' ? 'Oklahoma' : e.state === 'texas' ? 'Texas' : e.state;
				return `## ${e.time} ${state} M${Number(e.mag).toFixed(1)}\n\n${formatDigestLine(e)}\n`;
			}),
		].join('\n');
		const file = path.join(notableDir, `${year}-M4plus.md`);
		fs.writeFileSync(file, text, 'utf8');
		files.push({ year, count: list.length, file });
	}

	fs.writeFileSync(
		path.join(notableDir, 'all-M4plus.json'),
		JSON.stringify(notable, null, 2),
		'utf8',
	);
	return { count: notable.length, files };
}

async function main() {
	ensureDir(OUT);
	const started = new Date().toISOString();
	const summary = {
		started,
		minMagnitude: MIN_MAG,
		startYear: START_YEAR,
		endYear: END_YEAR,
		source: USGS,
		regions: {},
		totals: { oklahoma: 0, texas: 0, notableM4: 0 },
	};

	const allEvents = [];

	for (const stateKey of Object.keys(REGIONS)) {
		const label = REGIONS[stateKey].label;
		const stateDir = path.join(OUT, stateKey);
		ensureDir(stateDir);
		ensureDir(path.join(stateDir, 'digests'));
		const stateEvents = [];
		const years = [];

		for (let year = START_YEAR; year <= END_YEAR; year++) {
			process.stdout.write(`fetch ${stateKey} ${year}… `);
			const { events, rawCount, dropped } = await fetchYear(stateKey, year);
			const yearPath = path.join(stateDir, `events-${year}.json`);
			fs.writeFileSync(
				yearPath,
				JSON.stringify(
					{
						state: stateKey,
						label,
						year,
						minMagnitude: MIN_MAG,
						rawBboxCount: rawCount,
						droppedOtherStates: dropped,
						count: events.length,
						downloadedAt: new Date().toISOString(),
						events,
					},
					null,
					2,
				),
				'utf8',
			);
			const yearSummary = writeYearSummary(stateKey, label, year, events);
			years.push({
				year,
				count: events.length,
				rawBboxCount: rawCount,
				dropped,
				maxMag: yearSummary.maxMag,
				ge40: yearSummary.ge40,
			});
			stateEvents.push(...events);
			console.log(`${events.length} kept (bbox ${rawCount}, dropped ${dropped})`);
			await sleep(SLEEP_MS);
		}

		const months = writeMonthlyDigests(stateKey, label, stateEvents);
		fs.writeFileSync(
			path.join(stateDir, 'all-events.json'),
			JSON.stringify(
				{
					state: stateKey,
					label,
					minMagnitude: MIN_MAG,
					startYear: START_YEAR,
					endYear: END_YEAR,
					count: stateEvents.length,
					downloadedAt: new Date().toISOString(),
					events: stateEvents,
				},
				null,
				2,
			),
			'utf8',
		);

		summary.regions[stateKey] = {
			label,
			count: stateEvents.length,
			years,
			monthlyDigests: months.length,
		};
		summary.totals[stateKey] = stateEvents.length;
		allEvents.push(...stateEvents);
	}

	const notable = writeNotable(allEvents);
	summary.totals.notableM4 = notable.count;
	summary.notableFiles = notable.files;
	summary.finished = new Date().toISOString();

	const overview = [
		`# Oklahoma & Texas seismic catalog (USGS ComCat)`,
		'',
		`- Downloaded: ${summary.finished}`,
		`- Source: ${USGS}`,
		`- Window: ${START_YEAR}-01-01 → ${isoDay(new Date())}`,
		`- Min magnitude: ${MIN_MAG}`,
		`- Oklahoma events: ${summary.totals.oklahoma}`,
		`- Texas events: ${summary.totals.texas}`,
		`- Notable M≥4.0: ${summary.totals.notableM4}`,
		'',
		'## How this was built',
		'',
		'1. Query USGS FDSN Event API by state bounding box and minmagnitude.',
		'2. Keep events whose `place` string matches Oklahoma or Texas (drops KS/AR/NM border spill).',
		'3. Store per-year JSON plus monthly markdown digests for knowledge-store ingest.',
		'',
		'## Paths',
		'',
		'- `.data/seismic/oklahoma/events-YYYY.json`',
		'- `.data/seismic/texas/events-YYYY.json`',
		'- `.data/seismic/{oklahoma,texas}/digests/YYYY-MM.md`',
		'- `.data/seismic/{oklahoma,texas}/digests/YYYY-summary.md`',
		'- `.data/seismic/notable/YYYY-M4plus.md`',
		'',
		'Courtesy: U.S. Geological Survey. Public domain.',
		'',
	].join('\n');

	fs.writeFileSync(path.join(OUT, 'README.md'), overview, 'utf8');
	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
	fs.writeFileSync(path.join(OUT, 'OVERVIEW.md'), overview, 'utf8');

	console.log('\nDone.');
	console.log(JSON.stringify(summary.totals, null, 2));
	console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
