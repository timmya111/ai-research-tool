#!/usr/bin/env node
/**
 * Orchestrate OKCountyRecords historical backfills for remaining Oklahoma
 * counties on OKCR (west / south-central / panhandle) after the east-of-I-35
 * queue finishes. Year-by-year from 2016 → today.
 *
 * County list: scripts/okcr-rest-ok-counties.json
 * Child: scripts/okcr-county-backfill.mjs
 *
 * Usage:
 *   node scripts/okcr-rest-ok-backfill.mjs
 *   OKCR_FROM_YEAR=2018 node scripts/okcr-rest-ok-backfill.mjs
 *   OKCR_SITES=carter,love node scripts/okcr-rest-ok-backfill.mjs
 *   OKCR_FROM_SITE=comanche node scripts/okcr-rest-ok-backfill.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(ROOT, 'scripts', 'okcr-county-backfill.mjs');
const LIST_PATH = path.join(ROOT, 'scripts', 'okcr-rest-ok-counties.json');

const FROM_YEAR = Math.max(2016, Number(process.env.OKCR_FROM_YEAR || process.env.BRYAN_BACKFILL_FROM_YEAR) || 2016);
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));
const FROM_SITE = String(process.env.OKCR_FROM_SITE || '')
	.trim()
	.toLowerCase();
const ONLY_SITES = String(process.env.OKCR_SITES || '')
	.split(',')
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function loadCounties() {
	const raw = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
	let list = (raw.counties || []).filter((c) => c && c.site && !c.skip);
	if (ONLY_SITES.length) {
		const want = new Set(ONLY_SITES);
		list = list.filter((c) => want.has(String(c.site).toLowerCase()));
	}
	if (FROM_SITE) {
		const i = list.findIndex((c) => String(c.site).toLowerCase() === FROM_SITE);
		if (i >= 0) list = list.slice(i);
		else log(`warn: OKCR_FROM_SITE=${FROM_SITE} not in queue — using full list`);
	}
	return list;
}

function yearRanges() {
	const out = [];
	for (let y = FROM_YEAR; y < THIS_YEAR; y++) {
		out.push({ start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) });
	}
	out.push({ start: `${THIS_YEAR}-01-01`, end: TODAY, label: `${THIS_YEAR}-to-date` });
	return out;
}

function runRange(county, { start, end, label }) {
	return new Promise((resolve, reject) => {
		const site = String(county.site).toLowerCase();
		const projectName = county.name || `${site} County`;
		log(`=== BEGIN ${site} ${label} ${start}→${end} project=${projectName} ===`);
		const child = spawn(process.execPath, [CHILD], {
			cwd: ROOT,
			env: {
				...process.env,
				OKCR_SITE: site,
				OKCR_PROJECT_NAME: projectName,
				OKCR_COUNTY_LABEL: projectName,
				OKCR_BACKFILL_START: start,
				OKCR_BACKFILL_END: end,
			},
			stdio: 'inherit',
		});
		child.on('exit', (code, signal) => {
			if (code === 0) {
				log(`=== DONE ${site} ${label} ===`);
				resolve();
			} else {
				reject(new Error(`backfill ${site} ${label} exited code=${code} signal=${signal}`));
			}
		});
	});
}

async function main() {
	const counties = loadCounties();
	const ranges = yearRanges();
	if (!counties.length) {
		throw new Error('no counties selected — check OKCR_SITES / list file');
	}
	log(
		`orchestrator rest-of-OK counties=${counties.map((c) => c.site).join(',')} years=${ranges.map((r) => r.label).join(',')} today=${TODAY}`,
	);
	for (const county of counties) {
		for (const range of ranges) {
			await runRange(county, range);
		}
		log(`=== COUNTY COMPLETE ${county.site} ===`);
		try {
			const { spawn } = await import('node:child_process');
			const projectHint = String(county.name || county.label || county.site || '').trim();
			const args = [
				path.join(ROOT, 'scripts', 'associate-deeds-to-profiles.mjs'),
				...(projectHint ? ['--project', projectHint] : []),
				'--limit',
				'8000',
			];
			const child = spawn(process.execPath, args, {
				cwd: ROOT,
				env: process.env,
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let out = '';
			let err = '';
			child.stdout?.on('data', (b) => {
				out += String(b);
			});
			child.stderr?.on('data', (b) => {
				err += String(b);
			});
			child.on('close', (code) => {
				if (out.trim()) log(`[deed-associate] ${out.trim().slice(0, 500)}`);
				if (code !== 0) {
					log(
						`[deed-associate] non-zero exit ${code}: ${err.trim().slice(0, 300) || '(no stderr)'}`,
					);
				}
			});
			child.unref();
			log(`[deed-associate] launched pid=${child.pid} project=${projectHint || '*'}`);
		} catch (e) {
			log(`[deed-associate] skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	log('orchestrator finished all counties and ranges');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
