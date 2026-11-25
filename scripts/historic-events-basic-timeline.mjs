#!/usr/bin/env node
/**
 * Bulk-apply basic ## Timeline formatting to historic_event profiles that lack it.
 *
 *   node scripts/historic-events-basic-timeline.mjs [--limit=N] [--dry-run] [--news-only] [--force]
 *
 * Shape:
 *   {lead paragraph(s)}
 *
 *   ## Timeline
 *   - **YYYY-MM-DD** — {first sentence / title}
 *
 *   {remaining summary}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DB = path.join(ROOT, '.data', 'profiles', 'profiles.sqlite');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || /^(1|true|yes)$/i.test(String(process.env.HISTORIC_TL_DRY_RUN || ''));
const NEWS_ONLY = args.includes('--news-only');
const FORCE = args.includes('--force');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 0) : null;

function firstSentence(text, fallback = '') {
	const raw = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!raw) return String(fallback || '').trim().slice(0, 320);
	const sent = raw.split(/(?<=[.!?])\s+/)[0] || raw;
	return sent.slice(0, 320);
}

function hasTimeline(summary) {
	return /^##\s*Timeline\b/m.test(String(summary || '')) || /\n##\s*Timeline\b/.test(String(summary || ''));
}

function toBasicTimelineSummary(summary, { name, startDate }) {
	const cleaned = String(summary || '').trim();
	if (!FORCE && hasTimeline(cleaned)) return null;

	const dateLabel = String(startDate || '').trim() || 'Undated';
	const paras = cleaned ? cleaned.split(/\n\n+/).map((p) => p.trim()).filter(Boolean) : [];

	// Prefer a real prose lead over photo-caption + wire dump when possible.
	let leadIdx = 0;
	if (paras.length > 1 && /^(A |An |The )/.test(paras[0]) && /\(Photo by|\bPhoto:\b/i.test(paras[0]) && paras[1].length > 80) {
		leadIdx = 1;
	}
	const lead = paras[leadIdx] || `**${name}**`;
	const before = paras.slice(0, leadIdx);
	const after = paras.slice(leadIdx + 1);
	const claim = firstSentence(lead, name);
	const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
	// Skip lead above the rail when it is only the same one-liner as the Timeline claim.
	const leadRedundant =
		norm(lead) === norm(claim) ||
		norm(lead) === norm(`**${name}**`) ||
		norm(lead) === norm(name);

	const lines = [];
	if (before.length) lines.push(...before, '');
	if (!leadRedundant) lines.push(lead, '');
	lines.push('## Timeline', `- **${dateLabel}** — ${claim}`, '');
	if (after.length) lines.push(after.join('\n\n'), '');
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function listTargets() {
	const db = new DatabaseSync(PROFILES_DB, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, slug, name, start_date, summary, metadata_json
         FROM profiles
         WHERE profile_type = 'historic_event'
           AND status IN ('active', 'pinned')
         ORDER BY COALESCE(start_date, '') DESC, updated_at DESC`,
			)
			.all();
		const out = [];
		for (const r of rows) {
			let meta = {};
			try {
				meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
			} catch {
				meta = {};
			}
			const isNews =
				(typeof meta.newsFeedId === 'string' && meta.newsFeedId.trim()) ||
				String(r.slug || '').startsWith('historic_event:news-') ||
				(Array.isArray(meta.corpora) && meta.corpora.some((c) => /news[_-]?rss/i.test(String(c || ''))));
			if (NEWS_ONLY && !isNews) continue;
			if (!FORCE && hasTimeline(r.summary)) continue;
			out.push({
				id: r.id,
				slug: r.slug,
				name: r.name,
				startDate: r.start_date,
				summary: r.summary || '',
				metadata: meta,
				isNews: Boolean(isNews),
			});
			if (LIMIT && out.length >= LIMIT) break;
		}
		return out;
	} finally {
		db.close();
	}
}

async function patchProfile(id, body) {
	const res = await fetch(`${BASE_URL}/api/profiles/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `PATCH ${id} → HTTP ${res.status}`);
	}
	return data;
}

async function addTimeline(id, entry) {
	const res = await fetch(`${BASE_URL}/api/profiles/${encodeURIComponent(id)}/timeline`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(entry),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		throw new Error(data?.error || `POST timeline ${id} → HTTP ${res.status}`);
	}
	return data;
}

async function main() {
	const targets = listTargets();
	console.log(`[historic-tl] targets=${targets.length} dryRun=${DRY_RUN} newsOnly=${NEWS_ONLY} force=${FORCE}`);
	let ok = 0;
	let fail = 0;
	for (const p of targets) {
		const next = toBasicTimelineSummary(p.summary, { name: p.name, startDate: p.startDate });
		if (!next) {
			console.log(`[historic-tl] skip ${p.slug}`);
			continue;
		}
		const meta = {
			...p.metadata,
			overviewStyle: 'lead_plus_timeline_rail',
			formatMode: 'dated_expressive',
			formattedBy: p.metadata?.formattedBy || 'historic-events-basic-timeline',
			basicTimelineAt: new Date().toISOString(),
		};
		if (DRY_RUN) {
			console.log(`[historic-tl] dry ${p.slug} → ${next.length}c`);
			ok += 1;
			continue;
		}
		try {
			await patchProfile(p.id, { summary: next, metadata: meta, startDate: p.startDate || undefined, userTouch: false });
			if (p.startDate) {
				await addTimeline(p.id, {
					eventDate: p.startDate,
					title: p.name,
					summary: firstSentence(p.summary, p.name),
					angle: 'general',
					entryKind: 'observation',
					sourceCorpus: 'manual',
				});
			}
			ok += 1;
			if (ok % 25 === 0) console.log(`[historic-tl] progress ${ok}/${targets.length}`);
		} catch (err) {
			fail += 1;
			console.error(`[historic-tl] FAIL ${p.slug}:`, err instanceof Error ? err.message : err);
		}
	}
	console.log(`[historic-tl] done ok=${ok} fail=${fail}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
