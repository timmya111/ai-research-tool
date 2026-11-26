#!/usr/bin/env node
/**
 * Sequential publicsearch deed-metadata download for Dallas County, the
 * adjacent counties that use the same Kofile site, and no others.
 *
 * Ellis, Kaufman, and Rockwall are adjacent but use Tyler / county portals.
 * La Salle County uses Kofile QuickLink (index books through 1952) and has
 * no publicsearch tenant. Those are not in this queue.
 *
 *   node scripts/tx-publicsearch-deeds.mjs
 *   TX_FROM=Collin node scripts/tx-publicsearch-deeds.mjs
 *   TX_QUEUE=scripts/tx-publicsearch-counties-more.json node scripts/tx-publicsearch-deeds.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = process.env.TX_QUEUE
	? path.resolve(process.env.TX_QUEUE)
	: path.join(__dirname, 'tx-publicsearch-counties.json');
const DOWNLOADER = path.join(__dirname, 'dallas-deeds-download.mjs');

const from = String(process.env.TX_FROM || '').trim().toLowerCase();
const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
const startAt = from
	? queue.findIndex((c) => String(c.label).toLowerCase().startsWith(from) || String(c.out).toLowerCase().startsWith(from))
	: 0;
if (startAt < 0) {
	console.error(`TX_FROM=${process.env.TX_FROM} did not match the queue`);
	process.exit(1);
}

function runCounty(county) {
	return new Promise((resolve) => {
		console.log(`COUNTY BEGIN ${county.label} host=${county.host} out=${county.out}`);
		const child = spawn(process.execPath, [DOWNLOADER], {
			cwd: ROOT,
			stdio: 'inherit',
			env: {
				...process.env,
				PUBLICSEARCH_HOST: county.host,
				DEEDS_OUT: county.out,
				COUNTY_LABEL: county.label,
			},
		});
		child.on('exit', (code, signal) => {
			console.log(`COUNTY END ${county.label} code=${code ?? ''} signal=${signal ?? ''}`);
			resolve(code ?? 1);
		});
	});
}

let failed = 0;
for (const county of queue.slice(startAt)) {
	const code = await runCounty(county);
	if (code !== 0) {
		failed += 1;
		console.error(`COUNTY FAILED ${county.label} exit=${code} — stopping the queue`);
		break;
	}
	console.log(`COUNTY COMPLETE ${county.label}`);
}

if (failed) process.exit(1);
console.log('orchestrator finished publicsearch county queue');
