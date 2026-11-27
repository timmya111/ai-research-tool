#!/usr/bin/env node
/**
 * Convert okcr_instrument URL identifiers into Cargill-style ## Land Deeds
 * overview markdown, then delete the URL rows.
 *
 * Usage:
 *   node scripts/apply-land-deeds.mjs firm:wells-fargo-bank-n-a
 *   node scripts/apply-land-deeds.mjs --all --max-filings=500
 *   node scripts/apply-land-deeds.mjs firm:wells-fargo-bank-n-a --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const PROFILES = path.join(ROOT, '.data/profiles/profiles.sqlite');
const KNOWLEDGE = path.join(ROOT, '.data/knowledge/knowledge.sqlite');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const maxFilingsArg = args.find((a) => a.startsWith('--max-filings='));
const maxFilings = maxFilingsArg ? Number(maxFilingsArg.split('=')[1]) : 500;
const targets = args.filter((a) => !a.startsWith('--'));

function field(raw, label) {
	const m = String(raw || '').match(new RegExp(`^-\\s*${label}\\s*:\\s*(.+)$`, 'im'));
	return m ? String(m[1] || '').trim() : '';
}

function parseRecordedToIso(raw) {
	const s = String(raw || '').trim();
	if (!s || /^unknown$/i.test(s)) return null;
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
	return null;
}

function nameTokens(name) {
	return String(name || '')
		.toUpperCase()
		.replace(/[^A-Z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !/^(THE|AND|INC|LLC|NA|BANK|CORP|COMPANY|INCORPORATED)$/.test(t));
}

function partyMentionsSubject(party, subjectName) {
	const p = String(party || '').toUpperCase();
	const tokens = nameTokens(subjectName).filter((t) => t.length >= 4);
	const need = tokens.slice(0, 2);
	if (need.length >= 2) return need.every((t) => p.includes(t));
	return tokens.some((t) => p.includes(t));
}

function subjectShortName(name) {
	const parts = String(name || '')
		.replace(/,?\s*(N\.?A\.?|INC\.?|INCORPORATED|LLC|L\.L\.C\.|CORP\.?|COMPANY)\s*$/i, '')
		.trim()
		.split(/\s+/);
	if (parts.length <= 2) return parts.join(' ') || 'Subject';
	return parts.slice(0, 2).join(' ');
}

function truncateLegal(legal, max = 12_000) {
	const t = String(legal || '').replace(/\s+/g, ' ').trim();
	if (!t || /^unknown$/i.test(t)) return '';
	if (t.length <= max) return t;
	return `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

function parseFiling(rawText, { url, title, subjectName }) {
	const raw = String(rawText || '');
	if (!raw.trim()) return null;
	const county = field(raw, 'County') || 'Unknown County';
	const instrument =
		field(raw, 'Instrument') ||
		String(title || '').match(/\b(I-?\d{4}-\d+)\b/i)?.[1] ||
		'';
	const type = field(raw, 'Type') || String(title || '').split(/\s+I-/i)[0]?.trim() || 'Filing';
	const recorded = field(raw, 'Recorded') || null;
	const grantor = field(raw, 'Grantor') || field(raw, 'Grantors') || '—';
	const grantee = field(raw, 'Grantee') || field(raw, 'Grantees') || '—';
	const legal = field(raw, 'Legal');
	let subjectRole = 'unknown';
	const asGrantor = partyMentionsSubject(grantor, subjectName);
	const asGrantee = partyMentionsSubject(grantee, subjectName);
	if (asGrantor && asGrantee) subjectRole = 'both';
	else if (asGrantor) subjectRole = 'grantor';
	else if (asGrantee) subjectRole = 'grantee';
	return {
		url: field(raw, 'Detail URL') || url || '',
		county,
		instrument,
		type,
		recorded: recorded && !/^unknown$/i.test(recorded) ? recorded : null,
		recordedIso: parseRecordedToIso(recorded),
		grantor,
		grantee,
		legal,
		subjectRole,
	};
}

function formatBullet(f, subjectName) {
	const short = subjectShortName(subjectName);
	const date = f.recordedIso || f.recorded || 'undated';
	const inst = f.instrument ? ` (\`${f.instrument}\`)` : '';
	const role =
		f.subjectRole === 'grantor'
			? `*(${short} grantor)*`
			: f.subjectRole === 'grantee'
				? `*(${short} grantee)*`
				: f.subjectRole === 'both'
					? `*(${short} both sides)*`
					: '';
	const legal = truncateLegal(f.legal);
	const legalBit = legal ? ` · _${legal}_` : '';
	return `- **${date}** — ${f.type}${inst} ${role}: ${f.grantor} → ${f.grantee}${legalBit}`
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
		for (const f of all) lines.push(formatBullet(f, profileName));
		lines.push('');
	}
	return lines.join('\n').trim() + '\n';
}

function resolveProfile(pdb, key) {
	const k = String(key || '').trim();
	if (!k) return null;
	return (
		pdb.prepare(`SELECT id, slug, name, summary FROM profiles WHERE id = ? OR slug = ?`).get(k, k) ||
		pdb.prepare(`SELECT id, slug, name, summary FROM profiles WHERE slug = ?`).get(`firm:${k}`) ||
		null
	);
}

function applyOne(pdb, kdb, profile, limit) {
	const urls = pdb
		.prepare(
			`SELECT value FROM profile_identifiers WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument'`,
		)
		.all(profile.id)
		.map((r) => String(r.value || '').trim())
		.filter(Boolean);
	if (!urls.length) return { skipped: true, reason: 'no okcr_instrument' };

	const byUrl = new Map();
	const chunkSize = 80;
	for (let i = 0; i < urls.length; i += chunkSize) {
		const chunk = urls.slice(i, i + chunkSize);
		const ph = chunk.map(() => '?').join(',');
		const rows = kdb.prepare(`SELECT title, url, raw_text FROM documents WHERE url IN (${ph})`).all(...chunk);
		for (const row of rows) {
			const u = String(row.url || '').trim();
			if (u && row.raw_text) byUrl.set(u, row);
		}
	}

	const filings = [];
	for (const url of urls) {
		if (filings.length >= limit) break;
		const row = byUrl.get(url);
		if (!row) continue;
		const parsed = parseFiling(row.raw_text, {
			url,
			title: row.title,
			subjectName: profile.name,
		});
		if (parsed) filings.push(parsed);
	}
	if (!filings.length) return { skipped: true, reason: 'no knowledge matches', urls: urls.length };

	const markdown = formatMarkdown(profile.name, filings);
	const stripped = String(profile.summary || '')
		.replace(/\n*##\s+Land Deeds\b[\s\S]*?(?=\n##\s+|$)/i, '\n')
		.trimEnd();
	const nextSummary = `${stripped}\n\n${markdown}`.trim() + '\n';

	if (!dryRun) {
		const now = new Date().toISOString();
		pdb.prepare(`UPDATE profiles SET summary = ?, updated_at = ? WHERE id = ?`).run(
			nextSummary,
			now,
			profile.id,
		);
		// Only delete URLs we actually documented (keep remainder if capped).
		const documented = new Set(filings.map((f) => f.url).filter(Boolean));
		let removed = 0;
		if (documented.size === urls.length || limit >= urls.length) {
			const del = pdb
				.prepare(
					`DELETE FROM profile_identifiers WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument'`,
				)
				.run(profile.id);
			removed = del.changes;
		} else {
			const delOne = pdb.prepare(
				`DELETE FROM profile_identifiers
         WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument' AND value = ?`,
			);
			for (const u of documented) {
				removed += delOne.run(profile.id, u).changes;
			}
		}
		return {
			ok: true,
			filings: filings.length,
			identifiersRemoved: removed,
			markdownChars: markdown.length,
			counties: [...new Set(filings.map((f) => f.county))].length,
		};
	}
	return {
		ok: true,
		dryRun: true,
		filings: filings.length,
		identifiersRemoved: urls.length,
		markdownChars: markdown.length,
		preview: markdown.slice(0, 600),
	};
}

if (!fs.existsSync(PROFILES) || !fs.existsSync(KNOWLEDGE)) {
	console.error('Missing profiles or knowledge sqlite');
	process.exit(1);
}

const pdb = new DatabaseSync(PROFILES);
const kdb = new DatabaseSync(KNOWLEDGE, { readOnly: true });

let profiles = [];
if (all) {
	profiles = pdb
		.prepare(
			`SELECT p.id, p.slug, p.name, p.summary, COUNT(*) AS c
       FROM profile_identifiers i
       JOIN profiles p ON p.id = i.profile_id
       WHERE lower(i.scheme) = 'okcr_instrument'
       GROUP BY p.id
       HAVING c <= ?
       ORDER BY c DESC`,
		)
		.all(maxFilings);
} else if (targets.length) {
	for (const t of targets) {
		const p = resolveProfile(pdb, t);
		if (!p) {
			console.error('not found', t);
			continue;
		}
		profiles.push(p);
	}
} else {
	console.error('Pass a profile slug/id or --all');
	process.exit(1);
}

console.log(`Applying Land Deeds to ${profiles.length} profile(s)${dryRun ? ' (dry-run)' : ''}…`);
for (const p of profiles) {
	const r = applyOne(pdb, kdb, p, maxFilings);
	console.log(p.slug || p.id, r);
}

try {
	kdb.close();
} catch {
	/* ignore */
}
try {
	pdb.close();
} catch {
	/* ignore */
}
