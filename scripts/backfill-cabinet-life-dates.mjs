#!/usr/bin/env node
/**
 * Backfill birth/death (life) dates for U.S. presidential cabinet people.
 * Source: local Kiwix Wikipedia ZIM via kiwix-serve.
 * Also rewrites .data/us-presidential-cabinets/entities.json birthDate/deathDate
 * and clears term dates from person startDate/endDate fields in the seed.
 *
 * Usage: node scripts/backfill-cabinet-life-dates.mjs [--dry-run] [--limit N]
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
				if (fs.existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
});

const { updateProfileFields, getProfile } = await import(
	pathToFileURL(path.join(ROOT, 'src/lib/research/profiles/store.ts')).href
);
const { getProfilesDb } = await import(
	pathToFileURL(path.join(ROOT, 'src/lib/research/profiles/db.ts')).href
);

const KIWIX = (process.env.KIWIX_SERVE_ORIGIN || 'http://127.0.0.1:8765').replace(/\/$/, '');
const SEED_PATH = path.join(ROOT, '.data/us-presidential-cabinets/entities.json');
const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : null;

const MONTHS = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
};

function pad(n) {
	return String(n).padStart(2, '0');
}

function isoFromParts(y, m, d) {
	const yi = Number(y);
	const mi = Number(m);
	const di = Number(d);
	if (!yi || yi < 1700 || yi > 2100 || !mi || mi < 1 || mi > 12 || !di || di < 1 || di > 31) {
		return null;
	}
	return `${yi}-${pad(mi)}-${pad(di)}`;
}

function parseMonthDayYear(str) {
	const m = String(str || '').match(
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (!m) return null;
	return isoFromParts(m[3], MONTHS[m[1].toLowerCase()], m[2]);
}

/** Well-known living people — never accept a Wikipedia body false-positive death. */
const FORCE_LIVING_SLUGS = new Set([
	'person:barack-obama',
	'person:joe-biden',
	'person:donald-trump',
	'person:bill-clinton',
	'person:george-w-bush',
	'person:hillary-clinton',
	'person:kamala-harris',
	'person:jd-vance',
	'person:mike-pence',
	'person:al-gore',
	'person:dan-quayle',
	'person:janet-yellen',
	'person:lawrence-summers',
]);

function extractLifeDates(html) {
	const text = String(html || '')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	// Infobox + lead only — later article body has other people\'s death dates.
	const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 18_000);

	let birth = null;
	let death = null;

	const bornParenIso = plain.match(/\bBorn\b[^()]{0,80}\(\s*(\d{4}-\d{2}-\d{2})\s*\)/i);
	if (bornParenIso) birth = bornParenIso[1];
	if (!birth) {
		const bornPhrase = plain.match(/\(born\s+([^)]{6,40})\)/i);
		if (bornPhrase) birth = parseMonthDayYear(bornPhrase[1]);
	}
	if (!birth) {
		const bornLine = plain.match(
			/\bBorn\b[^.]{0,80}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
		);
		if (bornLine) birth = parseMonthDayYear(bornLine[0].replace(/^Born\b/i, ''));
	}

	const diedParenIso = plain.match(/\bDied\b[^()]{0,80}\(\s*(\d{4}-\d{2}-\d{2})\s*\)/i);
	if (diedParenIso) death = diedParenIso[1];
	if (!death) {
		const diedPhrase = plain.match(/\(died\s+([^)]{6,40})\)/i);
		if (diedPhrase) death = parseMonthDayYear(diedPhrase[1]);
	}
	if (!death) {
		const diedLine = plain.match(
			/\bDied\b[^.]{0,80}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
		);
		if (diedLine) death = parseMonthDayYear(diedLine[0].replace(/^Died\b/i, ''));
	}

	// Sanity: death after birth
	if (birth && death && death < birth) death = null;
	return { birth, death };
}

function wikiTitleCandidates(name, aliases = [], slugHint = null) {
	const out = [];
	const push = (t) => {
		const s = String(t || '').trim();
		if (!s) return;
		if (!out.includes(s)) out.push(s);
	};
	if (slugHint) {
		push(
			String(slugHint)
				.split('-')
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' '),
		);
	}
	push(name);
	for (const a of aliases) push(a);
	// Drop generational suffixes noise for path tries already covered by aliases
	return out;
}

async function fetchWikiHtml(title) {
	const pathTitle = title.replace(/ /g, '_');
	const urls = [
		`${KIWIX}/content/wikipedia_en_all_maxi/A/${encodeURIComponent(pathTitle).replace(/%2F/gi, '/')}`,
		`${KIWIX}/content/wikipedia_en_all_maxi/${encodeURIComponent(pathTitle).replace(/%2F/gi, '/')}`,
	];
	for (const url of urls) {
		try {
			// curl avoids undici stream-cancel crashes on large ZIM HTML responses
			const { spawnSync } = await import('node:child_process');
			const r = spawnSync(
				'curl',
				['-sL', '--max-time', '30', '--range', '0-399999', url],
				{ encoding: 'utf8', maxBuffer: 600_000 },
			);
			if (r.status !== 0 && r.status !== null) continue;
			const html = String(r.stdout || '');
			if (!html || (/content not found/i.test(html) && html.length < 5000)) continue;
			const pageTitle = (html.match(/<title>([^<]+)/i) || [])[1] || '';
			if (/not found|open webui/i.test(pageTitle) && html.length < 20_000) continue;
			return { html, url, pageTitle };
		} catch {
			/* try next */
		}
	}
	return null;
}

function looksLikeOfficeTermDate(iso, cabinetRoles = []) {
	if (!iso) return false;
	const roles = Array.isArray(cabinetRoles) ? cabinetRoles : [];
	for (const r of roles) {
		if (r?.startDate === iso || r?.endDate === iso) return true;
	}
	// Common inauguration / cabinet seating day
	if (/^\d{4}-01-2[01]$/.test(iso) || /^\d{4}-01-2[23]$/.test(iso)) return true;
	return false;
}

function looksLikeBirthDate(iso, cabinetRoles = []) {
	if (!iso || looksLikeOfficeTermDate(iso, cabinetRoles)) return false;
	const y = Number(String(iso).slice(0, 4));
	return y >= 1850 && y <= 2012;
}

const db = getProfilesDb();
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const seedPeople = Array.isArray(seed.people) ? seed.people : [];

const dbPeople = db
	.prepare(
		`SELECT id, slug, name, start_date, end_date, metadata_json
     FROM profiles
     WHERE profile_type = 'person'
       AND metadata_json LIKE '%us-presidential-cabinets%'
     ORDER BY name`,
	)
	.all();

const bySlug = new Map(seedPeople.map((p) => [p.slugHint || null, p]));
const byName = new Map(seedPeople.map((p) => [String(p.name).toLowerCase(), p]));

let targets = dbPeople.map((row) => {
	let meta = {};
	try {
		meta = JSON.parse(row.metadata_json || '{}');
	} catch {
		meta = {};
	}
	const slugHint = String(row.slug || '').replace(/^person:/, '');
	const seedP = bySlug.get(slugHint) || byName.get(String(row.name).toLowerCase()) || null;
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		startDate: row.start_date,
		endDate: row.end_date,
		cabinetRoles: meta.cabinetRoles || seedP?.cabinetRoles || [],
		aliases: seedP?.aliases || [],
		slugHint: seedP?.slugHint || slugHint,
		seedP,
	};
});

if (LIMIT != null && Number.isFinite(LIMIT)) targets = targets.slice(0, LIMIT);

console.log(`Cabinet people to backfill: ${targets.length} (kiwix=${KIWIX}, dry=${DRY})`);

const results = [];
let idx = 0;

async function worker() {
	while (idx < targets.length) {
		const i = idx++;
		const t = targets[i];
		const titles = wikiTitleCandidates(t.name, t.aliases, t.slugHint);
		let hit = null;
		let birth = null;
		let death = null;
		for (const title of titles) {
			hit = await fetchWikiHtml(title);
			if (!hit) continue;
			const dates = extractLifeDates(hit.html);
			if (dates.birth || dates.death) {
				birth = dates.birth;
				death = dates.death;
				break;
			}
		}

		// Prefer Wikipedia; keep an existing plausible birth if wiki miss.
		let nextStart = birth || null;
		if (!nextStart && looksLikeBirthDate(t.startDate, t.cabinetRoles)) nextStart = t.startDate;
		if (!nextStart && looksLikeOfficeTermDate(t.startDate, t.cabinetRoles)) nextStart = null;

		let nextEnd = death || null;
		if (FORCE_LIVING_SLUGS.has(t.slug)) {
			nextEnd = null;
		} else if (hit && birth && !death) {
			// Lead/infobox had birth but no death → living (do not keep prior false death)
			nextEnd = null;
		} else if (!death) {
			if (looksLikeOfficeTermDate(t.endDate, t.cabinetRoles)) nextEnd = null;
			else if (t.endDate && !looksLikeOfficeTermDate(t.endDate, t.cabinetRoles)) {
				const y = Number(String(t.endDate).slice(0, 4));
				if (y >= 1900 && y <= 2030 && (!nextStart || t.endDate >= nextStart)) nextEnd = t.endDate;
			}
		}

		const changed =
			(nextStart || null) !== (t.startDate || null) || (nextEnd || null) !== (t.endDate || null);

		results.push({
			name: t.name,
			slug: t.slug,
			birth: nextStart,
			death: nextEnd,
			wiki: hit?.pageTitle || null,
			changed,
			prev: { start: t.startDate, end: t.endDate },
		});

		if (!DRY && changed) {
			try {
				updateProfileFields(t.id, {
					startDate: nextStart,
					endDate: nextEnd,
					metadata: {
						birthDate: nextStart || undefined,
						deathDate: nextEnd || undefined,
						deceased: Boolean(nextEnd),
						lifeDatesSource: birth || death ? 'wikipedia-zim' : 'cleared-office-term',
					},
				});
			} catch (err) {
				console.warn('update failed', t.name, err);
			}
		}

		if ((i + 1) % 25 === 0 || i === targets.length - 1) {
			console.log(`… ${i + 1}/${targets.length} (last: ${t.name} birth=${nextStart || '—'})`);
		}
	}
}

// Serial: Kiwix + curl range reads are happier one-at-a-time.
await worker();

// Patch seed JSON (backup first)
if (!DRY) {
	const backup = `${SEED_PATH}.bak-life-dates`;
	if (!fs.existsSync(backup)) fs.copyFileSync(SEED_PATH, backup);
	for (const p of seedPeople) {
		const r = results.find(
			(x) =>
				x.slug === `person:${p.slugHint}` ||
				x.name.toLowerCase() === String(p.name).toLowerCase(),
		);
		if (r?.birth) p.birthDate = r.birth;
		if (r?.death) {
			p.deathDate = r.death;
			p.deceased = true;
		} else if (r) {
			delete p.deceased;
			delete p.deathDate;
		}
		// Remove term dates from person life fields; terms remain on cabinetRoles
		delete p.startDate;
		delete p.endDate;
	}
	fs.writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`);
	console.log(`Wrote ${SEED_PATH} (backup ${backup})`);
}

const withBirth = results.filter((r) => r.birth).length;
const withDeath = results.filter((r) => r.death).length;
const missingBirth = results.filter((r) => !r.birth).map((r) => r.name);

console.log(
	JSON.stringify(
		{
			total: results.length,
			withBirth,
			withDeath,
			missingBirthCount: missingBirth.length,
			missingBirthSample: missingBirth.slice(0, 30),
			obama: results.find((r) => /obama/i.test(r.name)),
			dry: DRY,
		},
		null,
		2,
	),
);
