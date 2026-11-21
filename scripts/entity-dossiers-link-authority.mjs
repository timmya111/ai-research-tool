#!/usr/bin/env node
/**
 * Cross-link entity aliases into authority-timelines events.jsonl → edges.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENT = path.join(ROOT, '.data', 'entity-dossiers');
const AUTH_EVENTS = path.join(ROOT, '.data', 'authority-timelines', 'events', 'events.jsonl');

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function loadEntities() {
	const out = [];
	const dir = path.join(ENT, 'dossiers');
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
	}
	return out;
}

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
	if (!fs.existsSync(AUTH_EVENTS)) {
		console.error('No authority events yet — run pnpm authority:download first');
		process.exit(1);
	}
	const events = readJsonl(AUTH_EVENTS);
	const entities = loadEntities();
	const edgePath = path.join(ENT, 'edges.jsonl');
	const byId = new Map(readJsonl(edgePath).map((e) => [e.id, e]));
	let added = 0;

	for (const ent of entities) {
		const aliases = [...new Set([ent.displayName, ...(ent.aliases || [])])]
			.map((a) => String(a || '').trim())
			.filter((a) => a.length >= 4);
		// skip ultra-generic single tokens already handled as buckets
		for (const event of events) {
			const hay = `${event.title}\n${event.summary || ''}`;
			for (const alias of aliases) {
				const re = new RegExp(`\\b${escapeRe(alias)}\\b`, 'i');
				if (!re.test(hay)) continue;
				const id = `authlink:${ent.slug}:${event.id}:${alias.toLowerCase()}`;
				if (byId.has(id)) continue;
				byId.set(id, {
					id,
					from: ent.slug,
					to: event.id,
					kind: 'entity_authority_event',
					weight: 1,
					evidence: [{ url: event.url, eventId: event.id, note: `alias hit: ${alias}` }],
				});
				added += 1;
			}
		}
		// geo overlap for place entities
		for (const g of ent.geos || []) {
			for (const event of events) {
				const hit = (event.geos || []).some(
					(eg) =>
						(g.county && eg.county && g.county.toLowerCase() === String(eg.county).toLowerCase() && g.state === eg.state) ||
						(g.city && eg.city && g.city.toLowerCase() === String(eg.city).toLowerCase() && g.state === eg.state),
				);
				if (!hit) continue;
				const id = `geolink:${ent.slug}:${event.id}`;
				if (byId.has(id)) continue;
				byId.set(id, {
					id,
					from: ent.slug,
					to: event.id,
					kind: 'org_place',
					weight: 0.5,
					evidence: [{ url: event.url, eventId: event.id, note: 'geo overlap with entity.geos' }],
				});
				added += 1;
			}
		}
	}

	fs.writeFileSync(edgePath, [...byId.values()].map((e) => JSON.stringify(e)).join('\n') + '\n');
	console.log(`[entities:link] events=${events.length} entities=${entities.length} edges=${byId.size} newly_added=${added}`);
}

main();
