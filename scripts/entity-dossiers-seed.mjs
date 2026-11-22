#!/usr/bin/env node
/**
 * Write pinned entity dossiers + empty alias buckets from seed/entities.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.data', 'entity-dossiers');
const SEED = path.join(OUT, 'seed', 'entities.json');

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

function main() {
	const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
	ensureDir(path.join(OUT, 'dossiers'));
	ensureDir(path.join(OUT, 'buckets'));
	const now = new Date().toISOString();
	const edges = [];

	for (const e of seed.pinned) {
		const dossier = {
			slug: e.slug,
			kind: e.kind,
			displayName: e.displayName,
			aliases: e.aliases || [],
			status: e.status || 'pinned',
			summary: e.summary || '',
			bios: [],
			businesses: e.businesses || [],
			geos: e.geos || [],
			links: e.links || [],
			relatedSlugs: e.relatedSlugs || [],
			sources: [{ url: `seed:entities.json#${e.slug}`, fetchedAt: now, note: 'seed' }],
			updatedAt: now,
		};
		fs.writeFileSync(path.join(OUT, 'dossiers', `${e.slug}.json`), JSON.stringify(dossier, null, 2));
		for (const rel of e.relatedSlugs || []) {
			const peer = seed.pinned.find((p) => p.slug === rel);
			const personToPerson = e.kind === 'person' && (!peer || peer.kind === 'person');
			const familyish =
				e.kind === 'family_hub' ||
				rel.includes('family') ||
				personToPerson ||
				e.relatedEdgeKind === 'family_member';
			const edge = {
				id: `seed:${e.slug}:${rel}`,
				from: e.slug,
				to: rel,
				kind: familyish ? 'family_member' : 'business_tie',
				evidence: [{ note: e.relatedEvidenceNote || 'seed relatedSlugs' }],
			};
			if (e.relatedRoleLabel) edge.roleLabel = e.relatedRoleLabel;
			if (e.relatedStartDate) edge.startDate = e.relatedStartDate;
			if (e.relatedEndDate) edge.endDate = e.relatedEndDate;
			edges.push(edge);
		}
		for (const b of e.businesses || []) {
			if (!b.name) continue;
			edges.push({
				id: `seed:${e.slug}:biz:${b.name}`,
				from: e.slug,
				to: b.name,
				kind: 'person_org',
				evidence: [{ note: `role=${b.role || ''}` }],
			});
		}
	}

	for (const b of seed.aliasBuckets) {
		const bucket = {
			slug: b.slug,
			kind: 'alias_bucket',
			token: b.token,
			displayName: `${b.token} (candidates)`,
			status: 'candidate',
			excludeSlugs: b.excludeSlugs || [],
			orgCandidates: b.orgCandidates || [],
			candidates: [],
			sources: [{ url: 'seed:entities.json', fetchedAt: now }],
			updatedAt: now,
		};
		fs.writeFileSync(path.join(OUT, 'buckets', `${b.slug}.json`), JSON.stringify(bucket, null, 2));
	}

	const edgePath = path.join(OUT, 'edges.jsonl');
	const existing = fs.existsSync(edgePath)
		? fs
				.readFileSync(edgePath, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
	const byId = new Map(existing.map((e) => [e.id, e]));
	for (const e of edges) {
		const prev = byId.get(e.id);
		// Keep curated notes/dates when regenerating from relatedSlugs stubs
		if (prev && Array.isArray(prev.evidence) && prev.evidence.some((x) => x?.note && x.note !== 'seed relatedSlugs')) {
			byId.set(e.id, {
				...e,
				...prev,
				kind: e.kind === 'family_member' || prev.kind === 'family_member' ? 'family_member' : e.kind || prev.kind,
				roleLabel: prev.roleLabel || e.roleLabel,
				startDate: prev.startDate || e.startDate,
				endDate: prev.endDate || e.endDate,
				evidence: prev.evidence?.length ? prev.evidence : e.evidence,
			});
		} else {
			byId.set(e.id, e);
		}
	}
	fs.writeFileSync(edgePath, [...byId.values()].map((e) => JSON.stringify(e)).join('\n') + '\n');

	console.log(
		`[entities:seed] dossiers=${seed.pinned.length} buckets=${seed.aliasBuckets.length} edges=${byId.size}`,
	);
}

main();
