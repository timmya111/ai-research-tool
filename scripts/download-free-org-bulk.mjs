#!/usr/bin/env node
/**
 * Download free bulk datasets used by org enrich:
 *  - IRS EO BMF state CSVs → .data/irs/eo-bmf/
 *  - IPEDS HD2023.csv → .data/ipeds/ (college directory / ACT status)
 *
 * College Scorecard bulk zip CDN may be blocked; API uses DATA_GOV_API_KEY/DEMO_KEY at runtime.
 *
 *   node scripts/download-free-org-bulk.mjs
 *   node scripts/download-free-org-bulk.mjs --states ok,tx,tn,ny,ca,dc
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { ensureEoBmfStates } = await import('../src/lib/research/profiles/freeOrgBulk.ts');

const argv = process.argv.slice(2);
function arg(flag, fallback) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	return argv[i + 1];
}

const states = String(arg('--states', 'ok,tx,tn,ny,md,dc,ca,fl'))
	.split(',')
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

const bmf = await ensureEoBmfStates(states);
console.log(JSON.stringify({ eoBmfFiles: bmf.map((p) => path.relative(ROOT, p)) }, null, 2));

const ipedsDir = path.join(ROOT, '.data/ipeds');
fs.mkdirSync(ipedsDir, { recursive: true });
const hd = path.join(ipedsDir, 'HD2023.csv');
if (!fs.existsSync(hd) || fs.statSync(hd).size < 1000) {
	const zip = path.join(ipedsDir, 'HD2023.zip');
	console.log('downloading IPEDS HD2023…');
	await execFileAsync(
		'curl',
		['-fsSL', '-A', 'AI-Research-Tool/1.0', '-o', zip, 'https://nces.ed.gov/ipeds/datacenter/data/HD2023.zip'],
		{ maxBuffer: 32 * 1024 * 1024 },
	);
	await execFileAsync('unzip', ['-o', zip, '-d', ipedsDir]);
}
console.log(JSON.stringify({ ipedsHd: path.relative(ROOT, hd), bytes: fs.statSync(hd).size }));
console.log(JSON.stringify({ done: true }));
