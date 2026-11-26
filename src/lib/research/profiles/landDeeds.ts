/**
 * Build Cargill-style ## Land Deeds overview markdown from OKCR / knowledge.sqlite
 * filings linked via profile_identifiers.scheme = okcr_instrument.
 *
 * Format matches curated firm cards (county subsections + dated grantor→grantee bullets).
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getProfilesDb } from '@/lib/research/profiles/db';
import { getKnowledgeSqlitePath } from '@/lib/research/profiles/paths';
import { updateProfileFields } from '@/lib/research/profiles/store';

export type LandDeedFiling = {
	url: string;
	title: string;
	county: string;
	instrument: string;
	type: string;
	recorded: string | null;
	/** ISO-ish YYYY-MM-DD when parseable */
	recordedIso: string | null;
	grantor: string;
	grantee: string;
	legal: string;
	/** grantor | grantee | both | unknown — relative to subject name */
	subjectRole: 'grantor' | 'grantee' | 'both' | 'unknown';
};

export type LandDeedsBundle = {
	profileId: string;
	profileName: string;
	filings: LandDeedFiling[];
	markdown: string;
	countyCounts: Array<{ county: string; count: number }>;
};

const FIELD_RE = (label: string) =>
	new RegExp(`^-\\s*${label}\\s*:\\s*(.+)$`, 'im');

function field(raw: string, label: string): string {
	const m = raw.match(FIELD_RE(label));
	return m ? String(m[1] || '').trim() : '';
}

/** Parse US recorded dates like 03/05/2024 → 2024-03-05. */
export function parseRecordedToIso(raw: string | null | undefined): string | null {
	const s = String(raw || '').trim();
	if (!s || /^unknown$/i.test(s)) return null;
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (us) {
		const mm = us[1].padStart(2, '0');
		const dd = us[2].padStart(2, '0');
		return `${us[3]}-${mm}-${dd}`;
	}
	return null;
}

function truncateLegal(legal: string, max = 72): string {
	const t = String(legal || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t || /^unknown$/i.test(t)) return '';
	if (t.length <= max) return t;
	return `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

function nameTokens(name: string): string[] {
	return String(name || '')
		.toUpperCase()
		.replace(/[^A-Z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !/^(THE|AND|INC|LLC|NA|BANK|CORP|COMPANY|INCORPORATED)$/.test(t));
}

function partyMentionsSubject(party: string, subjectName: string): boolean {
	const p = String(party || '').toUpperCase();
	const tokens = nameTokens(subjectName);
	if (tokens.length === 0) return false;
	// Require a distinctive multi-token hit (e.g. WELLS + FARGO) or full normalized contains.
	const distinctive = tokens.filter((t) => t.length >= 4);
	const need = distinctive.slice(0, 2);
	if (need.length >= 2) return need.every((t) => p.includes(t));
	return distinctive.some((t) => p.includes(t));
}

export function parseOkcrFilingRaw(
	rawText: string,
	opts: { url?: string; title?: string; subjectName?: string } = {},
): LandDeedFiling | null {
	const raw = String(rawText || '');
	if (!raw.trim()) return null;
	const county = field(raw, 'County') || 'Unknown County';
	const instrument =
		field(raw, 'Instrument') ||
		String(opts.title || '').match(/\b(I-?\d{4}-\d+)\b/i)?.[1] ||
		'';
	const type = field(raw, 'Type') || String(opts.title || '').split(/\s+I-/i)[0]?.trim() || 'Filing';
	const recorded = field(raw, 'Recorded') || null;
	const grantor = field(raw, 'Grantor') || field(raw, 'Grantors') || '—';
	const grantee = field(raw, 'Grantee') || field(raw, 'Grantees') || '—';
	const legal = field(raw, 'Legal');
	const url =
		field(raw, 'Detail URL') ||
		String(opts.url || '').trim() ||
		'';
	const subject = String(opts.subjectName || '');
	let subjectRole: LandDeedFiling['subjectRole'] = 'unknown';
	if (subject) {
		const asGrantor = partyMentionsSubject(grantor, subject);
		const asGrantee = partyMentionsSubject(grantee, subject);
		if (asGrantor && asGrantee) subjectRole = 'both';
		else if (asGrantor) subjectRole = 'grantor';
		else if (asGrantee) subjectRole = 'grantee';
	}
	return {
		url,
		title: String(opts.title || `${type} ${instrument}`).trim(),
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

function roleLabel(role: LandDeedFiling['subjectRole'], subjectShort: string): string {
	if (role === 'grantor') return `*(${subjectShort} grantor)*`;
	if (role === 'grantee') return `*(${subjectShort} grantee)*`;
	if (role === 'both') return `*(${subjectShort} both sides)*`;
	return '';
}

function subjectShortName(name: string): string {
	const parts = String(name || '')
		.replace(/,?\s*(N\.?A\.?|INC\.?|INCORPORATED|LLC|L\.L\.C\.|CORP\.?|COMPANY)\s*$/i, '')
		.trim()
		.split(/\s+/);
	if (parts.length <= 2) return parts.join(' ') || 'Subject';
	return parts.slice(0, 2).join(' ');
}

/** Cargill-style bullet line. */
export function formatLandDeedBullet(f: LandDeedFiling, subjectName: string): string {
	const short = subjectShortName(subjectName);
	const date = f.recordedIso || f.recorded || 'undated';
	const inst = f.instrument ? ` (\`${f.instrument}\`)` : '';
	const role = roleLabel(f.subjectRole, short);
	const legal = truncateLegal(f.legal);
	const legalBit = legal ? ` · _${legal}_` : '';
	return `- **${date}** — ${f.type}${inst} ${role}: ${f.grantor} → ${f.grantee}${legalBit}`.replace(
		/\s+/g,
		' ',
	).replace(/\s+:/g, ':').trim();
}

export function formatLandDeedsMarkdown(
	profileName: string,
	filings: LandDeedFiling[],
	opts?: { maxPerCounty?: number; maxTotal?: number },
): string {
	const maxPerCounty = Math.max(1, opts?.maxPerCounty ?? 80);
	const maxTotal = Math.max(1, opts?.maxTotal ?? 400);
	const byCounty = new Map<string, LandDeedFiling[]>();
	for (const f of filings) {
		const list = byCounty.get(f.county) || [];
		list.push(f);
		byCounty.set(f.county, list);
	}
	for (const [, list] of byCounty) {
		list.sort((a, b) => String(b.recordedIso || '').localeCompare(String(a.recordedIso || '')));
	}
	const counties = [...byCounty.keys()].sort((a, b) => a.localeCompare(b));
	const total = filings.length;
	const countyN = counties.length;
	const lines: string[] = [
		'## Land Deeds',
		'',
		`Oklahoma county recorder filings where **${profileName}** appears as grantor or grantee (${total} instrument${total === 1 ? '' : 's'} across ${countyN} count${countyN === 1 ? 'y' : 'ies'}, via OKCountyRecords). Raw instrument URLs removed from Sources & Identifiers; content summarized here.`,
		'',
	];
	let emitted = 0;
	for (const county of counties) {
		if (emitted >= maxTotal) break;
		const all = byCounty.get(county) || [];
		const slice = all.slice(0, Math.min(maxPerCounty, maxTotal - emitted));
		lines.push(`### ${county} (${all.length})`);
		lines.push('');
		for (const f of slice) {
			lines.push(formatLandDeedBullet(f, profileName));
			emitted += 1;
		}
		if (all.length > slice.length) {
			lines.push(`- _…and ${all.length - slice.length} more in ${county}_`);
		}
		lines.push('');
	}
	return lines.join('\n').trim() + '\n';
}

function openKnowledgeDb(): DatabaseSync | null {
	const p = getKnowledgeSqlitePath();
	if (!p || !fs.existsSync(p)) return null;
	try {
		return new DatabaseSync(p, { readOnly: true });
	} catch {
		return null;
	}
}

/** Load OKCR filings for a profile from okcr_instrument identifier URLs. */
export function loadLandDeedsForProfile(
	profileId: string,
	dbOverride?: DatabaseSync,
): LandDeedsBundle | null {
	const db = dbOverride ?? getProfilesDb();
	const prof = db
		.prepare(`SELECT id, name FROM profiles WHERE id = ?`)
		.get(profileId) as { id?: string; name?: string } | undefined;
	if (!prof?.id) return null;
	const profileName = String(prof.name || '');
	const urls = (
		db
			.prepare(
				`SELECT value FROM profile_identifiers
         WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument'`,
			)
			.all(profileId) as Array<{ value: string }>
	)
		.map((r) => String(r.value || '').trim())
		.filter(Boolean);
	if (urls.length === 0) {
		return {
			profileId,
			profileName,
			filings: [],
			markdown: '',
			countyCounts: [],
		};
	}

	const kdb = openKnowledgeDb();
	const filings: LandDeedFiling[] = [];
	if (kdb) {
		const byUrl = new Map<string, { title: string; url: string; raw_text: string }>();
		// Batch IN lookups (avoid N+1 + slow raw_text LIKE).
		const chunkSize = 80;
		for (let i = 0; i < urls.length; i += chunkSize) {
			const chunk = urls.slice(i, i + chunkSize);
			const ph = chunk.map(() => '?').join(',');
			const rows = kdb
				.prepare(
					`SELECT title, url, raw_text FROM documents WHERE url IN (${ph})`,
				)
				.all(...chunk) as Array<{ title?: string; url?: string; raw_text?: string }>;
			for (const row of rows) {
				const u = String(row.url || '').trim();
				if (!u || !row.raw_text) continue;
				byUrl.set(u, {
					title: String(row.title || ''),
					url: u,
					raw_text: String(row.raw_text),
				});
			}
		}
		for (const url of urls) {
			const row = byUrl.get(url);
			if (!row?.raw_text) continue;
			const parsed = parseOkcrFilingRaw(row.raw_text, {
				url: row.url || url,
				title: row.title,
				subjectName: profileName,
			});
			if (parsed) filings.push(parsed);
		}
		try {
			kdb.close();
		} catch {
			/* ignore */
		}
	}

	const countyMap = new Map<string, number>();
	for (const f of filings) {
		countyMap.set(f.county, (countyMap.get(f.county) || 0) + 1);
	}
	const countyCounts = [...countyMap.entries()]
		.map(([county, count]) => ({ county, count }))
		.sort((a, b) => b.count - a.count || a.county.localeCompare(b.county));

	const markdown = filings.length
		? formatLandDeedsMarkdown(profileName, filings)
		: '';

	return { profileId, profileName, filings, markdown, countyCounts };
}

/**
 * Merge ## Land Deeds into profile summary and delete okcr_instrument identifier rows.
 * Returns counts written.
 */
export function applyLandDeedsToProfile(
	profileId: string,
	opts?: { dryRun?: boolean; maxPerCounty?: number; maxTotal?: number },
): {
	ok: boolean;
	filings: number;
	identifiersRemoved: number;
	markdownChars: number;
	dryRun: boolean;
} {
	const db = getProfilesDb();
	const bundle = loadLandDeedsForProfile(profileId, db);
	if (!bundle || bundle.filings.length === 0) {
		return { ok: false, filings: 0, identifiersRemoved: 0, markdownChars: 0, dryRun: Boolean(opts?.dryRun) };
	}
	const markdown = formatLandDeedsMarkdown(bundle.profileName, bundle.filings, {
		maxPerCounty: opts?.maxPerCounty,
		maxTotal: opts?.maxTotal,
	});
	const row = db
		.prepare(`SELECT summary FROM profiles WHERE id = ?`)
		.get(profileId) as { summary?: string } | undefined;
	const prev = String(row?.summary || '');
	// Replace existing ## Land Deeds section if present; else append.
	const stripped = prev.replace(/\n*##\s+Land Deeds\b[\s\S]*?(?=\n##\s+|$)/i, '\n').trimEnd();
	const nextSummary = `${stripped}\n\n${markdown}`.trim() + '\n';
	const idCount = (
		db
			.prepare(
				`SELECT COUNT(*) AS c FROM profile_identifiers
         WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument'`,
			)
			.get(profileId) as { c?: number }
	)?.c;

	if (opts?.dryRun) {
		return {
			ok: true,
			filings: bundle.filings.length,
			identifiersRemoved: Number(idCount || 0),
			markdownChars: markdown.length,
			dryRun: true,
		};
	}

	updateProfileFields(profileId, { summary: nextSummary });
	const del = db
		.prepare(
			`DELETE FROM profile_identifiers
       WHERE profile_id = ? AND lower(scheme) = 'okcr_instrument'`,
		)
		.run(profileId);

	return {
		ok: true,
		filings: bundle.filings.length,
		identifiersRemoved: Number(del.changes || 0),
		markdownChars: markdown.length,
		dryRun: false,
	};
}

/** True when summary already has a ## Land Deeds heading. */
export function summaryHasLandDeeds(summary: string | null | undefined): boolean {
	return /^##\s+Land Deeds\b/im.test(String(summary || ''));
}
