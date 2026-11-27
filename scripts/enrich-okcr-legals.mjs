#!/usr/bin/env node
/**
 * Enrich truncated OKCR Legal fields ("N more…") from detail pages via FlareSolverr,
 * then rebuild the profile ## Land Deeds summary.
 *
 * Usage:
 *   PROFILE_SLUG=firm:bok-financial-corporation node scripts/enrich-okcr-legals.mjs
 *   PROFILE_SLUG=firm:cargill-inc node scripts/enrich-okcr-legals.mjs
 *
 * Requires FlareSolverr on :8191. Uses timeline_entries.metadata.knowledgeDocumentId
 * to find filings when okcr_instrument identifier rows were already removed.
 */
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';

const ROOT = '/home/lenny/Dev/webDev/ai-research-tool';
const FLARE = (process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, '');
const PROFILE_SLUG = process.env.PROFILE_SLUG || 'firm:bok-financial-corporation';
const PDB = path.join(ROOT, '.data/profiles/profiles.sqlite');
const KDB = path.join(ROOT, '.data/knowledge/knowledge.sqlite');

function normalizeText(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseLegalsFromDetailHtml(html) {
	const doc = new JSDOM(html).window.document;
	const root = doc.getElementById('detail-legals') || doc.getElementById('detail');
	if (!root) return [];
	return Array.from(root.querySelectorAll('ul li'))
		.map((li) => {
			const fromTextNodes = normalizeText(
				Array.from(li.childNodes)
					.filter((n) => n.nodeType === 3)
					.map((n) => n.textContent)
					.join(''),
			);
			if (fromTextNodes) return fromTextNodes;
			// Fallback: strip nested Search controls from full li text.
			return normalizeText(li.textContent).replace(/\bSearch\b/gi, '').trim();
		})
		.filter(Boolean);
}

async function flareGet(url) {
	const res = await fetch(`${FLARE}/v1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
	});
	const data = await res.json();
	if (data.status !== 'ok') throw new Error(data.message || 'flaresolverr failed');
	return data.solution?.response || '';
}

function fieldReplaceLegal(raw, newLegal) {
	const re = /^-(\s*)Legal\s*:\s*.+$/im;
	if (re.test(raw)) return raw.replace(re, `- Legal: ${newLegal}`);
	return raw;
}

function parseFiling(rawText, { url, title, subjectName }) {
	const field = (label) => {
		const m = String(rawText || '').match(new RegExp(`^-\\s*${label}\\s*:\\s*(.+)$`, 'im'));
		return m ? String(m[1] || '').trim() : '';
	};
	const county = field('County') || 'Unknown County';
	const instrument =
		field('Instrument') ||
		String(title || '').match(/\b(I-?\d{4}-\d+)\b/i)?.[1] ||
		'';
	const type = field('Type') || String(title || '').split(/\s+I-/i)[0]?.trim() || 'Filing';
	const recorded = field('Recorded') || null;
	const grantor = field('Grantor') || field('Grantors') || '—';
	const grantee = field('Grantee') || field('Grantees') || '—';
	const legal = field('Legal');
	const iso = (() => {
		const s = String(recorded || '').trim();
		const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
		if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
		const isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
		return isoM ? `${isoM[1]}-${isoM[2]}-${isoM[3]}` : null;
	})();
	return {
		url: field('Detail URL') || url || '',
		county,
		instrument,
		type,
		recorded: recorded && !/^unknown$/i.test(recorded) ? recorded : null,
		recordedIso: iso,
		grantor,
		grantee,
		legal,
	};
}

function formatBullet(f) {
	const date = f.recordedIso || f.recorded || 'undated';
	const inst = f.instrument ? ` (\`${f.instrument}\`)` : '';
	const legal = String(f.legal || '').replace(/\s+/g, ' ').trim();
	const legalBit = legal && !/^unknown$/i.test(legal) ? ` · _${legal}_` : '';
	return `- **${date}** — ${f.type}${inst}: ${f.grantor} → ${f.grantee}${legalBit}`
		.replace(/\s+/g, ' ')
		.replace(/\s+:/g, ':')
		.trim();
}

function formatMarkdown(profileName, filings) {
	const byCounty = new Map();
	for (const f of filings) {
		const list = byCounty.get(f.county) || [];
		list.push(f);
		byCounty.set(f.county, list);
	}
	for (const list of byCounty.values()) {
		list.sort((a, b) => String(b.recordedIso || '').localeCompare(String(a.recordedIso || '')));
	}
	const counties = [...byCounty.keys()].sort((a, b) => a.localeCompare(b));
	const lines = [
		'## Land Deeds',
		'',
		`Oklahoma county recorder filings where **${profileName}** appears as grantor or grantee (${filings.length} instrument${filings.length === 1 ? '' : 's'} across ${counties.length} count${counties.length === 1 ? 'y' : 'ies'}, via OKCountyRecords). Raw instrument URLs removed from Sources & Identifiers; content summarized here.`,
		'',
	];
	for (const county of counties) {
		const all = byCounty.get(county) || [];
		lines.push(`### ${county} (${all.length})`, '');
		for (const f of all) lines.push(formatBullet(f));
		lines.push('');
	}
	return lines.join('\n').trim() + '\n';
}

async function main() {
	const health = await fetch(`${FLARE}/health`).then((r) => r.json()).catch(() => null);
	if (!health || health.status !== 'ok') throw new Error(`FlareSolverr down at ${FLARE}`);

	const pdb = new DatabaseSync(PDB);
	const kdb = new DatabaseSync(KDB);
	const prof = pdb.prepare(`SELECT id, slug, name, summary FROM profiles WHERE slug = ?`).get(PROFILE_SLUG);
	if (!prof) throw new Error(`profile not found: ${PROFILE_SLUG}`);
	const rows = pdb
		.prepare(`SELECT metadata_json FROM timeline_entries WHERE profile_id = ?`)
		.all(prof.id);
	const docIds = [];
	for (const r of rows) {
		try {
			const m = JSON.parse(r.metadata_json || '{}');
			if (m.knowledgeDocumentId) docIds.push(m.knowledgeDocumentId);
		} catch {}
	}
	const unique = [...new Set(docIds)];
	console.log(JSON.stringify({ profile: PROFILE_SLUG, docs: unique.length }));

	let enriched = 0;
	const filings = [];
	for (const kid of unique) {
		const doc = kdb.prepare(`SELECT id, title, url, raw_text FROM documents WHERE id = ?`).get(kid);
		if (!doc?.raw_text) {
			console.log('skip missing', kid);
			continue;
		}
		let raw = doc.raw_text;
		const m = raw.match(/^- Legal\s*:\s*(.+)$/im);
		const legal = m ? m[1].trim() : '';
		const truncated = /\d+\s*more…/.test(legal) || /\d+\s*more\.\.\./.test(legal);
		if (truncated && doc.url) {
			process.stdout.write(`enrich ${doc.title} … `);
			try {
				const html = await flareGet(doc.url);
				const legals = parseLegalsFromDetailHtml(html);
				if (legals.length) {
					const full = legals.join(' ');
					raw = fieldReplaceLegal(raw, full);
					kdb.prepare(
						`UPDATE documents SET raw_text = ?, updated_at = datetime('now') WHERE id = ?`,
					).run(raw, kid);
					enriched += 1;
					console.log(`ok tracts=${legals.length} chars=${full.length}`);
				} else {
					console.log('no legals on detail');
				}
			} catch (e) {
				console.log('FAIL', e.message || e);
			}
			await new Promise((r) => setTimeout(r, 800));
		}
		const parsed = parseFiling(raw, { url: doc.url, title: doc.title, subjectName: prof.name });
		if (parsed) filings.push(parsed);
	}

	const markdown = formatMarkdown(prof.name, filings);
	const prev = String(prof.summary || '');
	const stripped = prev.replace(/\n*##\s+Land Deeds\b[\s\S]*?(?=\n##\s+|$)/i, '\n').trimEnd();
	// BOK summary was land-deeds-only; keep that shape if nothing else remains.
	const nextSummary = (stripped ? `${stripped}\n\n${markdown}` : markdown).trim() + '\n';
	pdb.prepare(`UPDATE profiles SET summary = ?, updated_at = datetime('now') WHERE id = ?`).run(
		nextSummary,
		prof.id,
	);
	const stillTrunc = (nextSummary.match(/\d+\s*more…/g) || []).length;
	console.log(
		JSON.stringify({
			enriched,
			filings: filings.length,
			summaryChars: nextSummary.length,
			stillTruncatedMarkers: stillTrunc,
		}),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
