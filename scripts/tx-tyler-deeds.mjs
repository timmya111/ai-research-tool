#!/usr/bin/env node
/**
 * Sequential Tyler self-service index download for counties whose clerks
 * publish a free official-record search (disclaimer, no login).
 *
 * Metadata only. Document images stay on the clerk's paid cart.
 * Birth, death, and marriage modules are not in this queue.
 *
 *   node scripts/tx-tyler-deeds.mjs
 *   TX_FROM=Burnet node scripts/tx-tyler-deeds.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = process.env.TX_QUEUE
	? path.resolve(process.env.TX_QUEUE)
	: path.join(__dirname, 'tx-tyler-counties.json');
const DOWNLOADER = path.join(__dirname, 'tx-tyler-deeds-download.mjs');

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
		console.log(`COUNTY BEGIN ${county.label} host=${county.host} search=${county.searchId} out=${county.out}`);
		const child = spawn(process.execPath, [DOWNLOADER], {
			cwd: ROOT,
			stdio: 'inherit',
			env: {
				...process.env,
				TYLER_HOST: county.host,
				TYLER_SEARCH: county.searchId,
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
console.log('orchestrator finished tyler county queue');
