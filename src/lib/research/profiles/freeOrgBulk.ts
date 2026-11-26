/**
 * Free bulk / official datasets for org founding date + status (+ address when present).
 *
 * - IRS EO BMF CSVs under `.data/irs/eo-bmf/eo_XX.csv` (nonprofit ruling + STATUS)
 * - College Scorecard API (api.data.gov) for U.S. colleges (address + operating)
 * - IPEDS HD2023.csv under `.data/ipeds/` for UNITID/EIN/ACT status fallback
 *
 * No paid APIs. Scorecard uses DATA_GOV_API_KEY or DEMO_KEY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
	isPlausibleStreetHq,
	looksLikeForeignEducationName,
	nameLooksLikeHit,
} from '@/lib/research/profiles/freeOrgShared';

const ROOT = process.cwd();
const BMF_DIR = path.join(ROOT, '.data/irs/eo-bmf');
const IPEDS_HD = path.join(ROOT, '.data/ipeds/HD2023.csv');

const SCORECARD_API =
	process.env.SCORECARD_API_BASE ||
	'https://api.data.gov/ed/collegescorecard/v1/schools';
const DATA_GOV_KEY = process.env.DATA_GOV_API_KEY || process.env.SCORECARD_API_KEY || 'DEMO_KEY';
const UA =
	process.env.FREE_ORG_ENRICH_UA ||
	'AI-Research-Tool/1.0 (local research; +http://localhost:3333)';

export type BulkOrgHit = {
	address?: {
		raw: string;
		city?: string | null;
		state?: string | null;
		country?: string | null;
		lat?: number | null;
		lon?: number | null;
		source: 'irs-eo-bmf' | 'college-scorecard' | 'ipeds-hd';
		sourceUrl?: string;
	};
	startDate?: string;
	endDate?: string | null;
	status?: 'active' | 'archived';
	ein?: string;
	source: 'irs-eo-bmf' | 'college-scorecard' | 'ipeds-hd';
	evidence: Array<{ field: string; source: string; value: string; url?: string }>;
};

type BmfRow = {
	ein: string;
	name: string;
	street: string;
	city: string;
	state: string;
	zip: string;
	ruling: string;
	status: string;
};

let bmfByEin: Map<string, BmfRow> | null = null;
let bmfByNormName: Map<string, BmfRow[]> | null = null;
let ipedsByNormName: Map<string, Record<string, string>> | null = null;

function normName(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(
			/\b(inc|llc|ltd|limited|corp|corporation|company|co|the|university|college|foundation|assoc|association|charities|charity)\b/g,
			' ',
		)
		.replace(/\s+/g, ' ')
		.trim();
}

/** IPEDS/Scorecard keys keep university|college|institute so Carleton U ≠ Carleton College. */
function normIpedsName(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|the|foundation|assoc|association)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function formatEin(digits: string): string | null {
	const d = String(digits || '').replace(/\D/g, '');
	if (d.length !== 9) return null;
	return `${d.slice(0, 2)}-${d.slice(2)}`;
}

function rulingToIso(ruling: string): string | null {
	const s = String(ruling || '').trim();
	if (/^\d{6}$/.test(s)) {
		const y = s.slice(0, 4);
		const m = s.slice(4, 6);
		if (m === '00') return y;
		return `${y}-${m}-01`;
	}
	if (/^\d{4}$/.test(s)) return s;
	return null;
}

/** EO STATUS 01 = unconditional exemption (active). Others often inactive/revoked variants. */
function bmfStatusToProfile(code: string): 'active' | 'archived' {
	return String(code || '').trim() === '01' ? 'active' : 'archived';
}

async function ensureBmfIndex(): Promise<void> {
	if (bmfByEin) return;
	bmfByEin = new Map();
	bmfByNormName = new Map();
	if (!fs.existsSync(BMF_DIR)) return;

	const files = fs.readdirSync(BMF_DIR).filter((f) => /^eo_[a-z]{2}\.csv$/i.test(f));
	for (const file of files) {
		const full = path.join(BMF_DIR, file);
		const rl = createInterface({
			input: createReadStream(full, { encoding: 'utf8' }),
			crlfDelay: Infinity,
		});
		let header: string[] | null = null;
		for await (const line of rl) {
			if (!header) {
				header = parseCsvLine(line);
				continue;
			}
			const cols = parseCsvLine(line);
			const row: Record<string, string> = {};
			header.forEach((h, i) => {
				row[h] = cols[i] || '';
			});
			const ein = String(row.EIN || '').replace(/\D/g, '');
			if (ein.length !== 9) continue;
			const rec: BmfRow = {
				ein,
				name: String(row.NAME || '').trim(),
				street: String(row.STREET || '').trim(),
				city: String(row.CITY || '').trim(),
				state: String(row.STATE || '').trim(),
				zip: String(row.ZIP || '').trim(),
				ruling: String(row.RULING || '').trim(),
				status: String(row.STATUS || '').trim(),
			};
			bmfByEin.set(ein, rec);
			const n = normName(rec.name);
			if (n.length >= 3) {
				const list = bmfByNormName.get(n) || [];
				list.push(rec);
				bmfByNormName.set(n, list);
			}
		}
	}
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQ = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQ) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') {
				inQ = false;
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQ = true;
		} else if (ch === ',') {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
}

async function ensureIpedsIndex(): Promise<void> {
	if (ipedsByNormName) return;
	ipedsByNormName = new Map();
	if (!fs.existsSync(IPEDS_HD)) return;
	const rl = createInterface({
		input: createReadStream(IPEDS_HD, { encoding: 'latin1' }),
		crlfDelay: Infinity,
	});
	let header: string[] | null = null;
	for await (const line of rl) {
		if (!header) {
			header = parseCsvLine(line).map((h) => h.replace(/^\uFEFF/, '').replace(/[^A-Za-z0-9_]/g, ''));
			continue;
		}
		const cols = parseCsvLine(line);
		const row: Record<string, string> = {};
		header.forEach((h, i) => {
			row[h] = (cols[i] || '').trim();
		});
		const name = row.INSTNM || '';
		const n = normIpedsName(name);
		if (n.length >= 3) ipedsByNormName.set(n, row);
		const alias = row.IALIAS || '';
		for (const a of alias.split('|')) {
			const an = normIpedsName(a);
			if (an.length >= 3 && !ipedsByNormName.has(an)) ipedsByNormName.set(an, row);
		}
	}
}

function bmfRowToHit(rec: BmfRow): BulkOrgHit {
	const evidence: BulkOrgHit['evidence'] = [];
	const hit: BulkOrgHit = { source: 'irs-eo-bmf', evidence };
	const ein = formatEin(rec.ein);
	if (ein) {
		hit.ein = ein;
		evidence.push({ field: 'ein', source: 'irs-eo-bmf', value: ein });
	}
	const start = rulingToIso(rec.ruling);
	if (start) {
		hit.startDate = start;
		evidence.push({ field: 'startDate', source: 'irs-eo-bmf', value: start });
	}
	hit.status = bmfStatusToProfile(rec.status);
	evidence.push({ field: 'status', source: 'irs-eo-bmf', value: `${hit.status}(${rec.status})` });

	const raw = [rec.street, rec.city && rec.state ? `${rec.city}, ${rec.state}` : rec.city || rec.state, rec.zip]
		.filter(Boolean)
		.join(', ');
	if (raw && isPlausibleStreetHq(raw)) {
		hit.address = {
			raw,
			city: rec.city || null,
			state: rec.state || null,
			country: 'US',
			source: 'irs-eo-bmf',
			sourceUrl: 'https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf',
		};
		evidence.push({ field: 'address', source: 'irs-eo-bmf', value: raw });
	}
	return hit;
}

export async function lookupIrsEoBmf(input: {
	name: string;
	ein?: string | null;
}): Promise<BulkOrgHit | null> {
	await ensureBmfIndex();
	if (!bmfByEin || !bmfByNormName) return null;

	const digits = String(input.ein || '').replace(/\D/g, '');
	if (digits.length === 9 && bmfByEin.has(digits)) {
		const byEin = bmfByEin.get(digits)!;
		// Stale/copied EINs must not import that filer's street and ruling date.
		if (nameLooksLikeHit(input.name, byEin.name)) return bmfRowToHit(byEin);
	}

	const n = normName(input.name);
	const exact = bmfByNormName.get(n);
	if (exact?.length) return bmfRowToHit(exact[0]);

	// fuzzy: require nameLooksLikeHit against BMF NAME
	for (const [key, rows] of bmfByNormName) {
		if (!key.includes(n.slice(0, Math.min(8, n.length))) && !n.includes(key.slice(0, Math.min(8, key.length)))) {
			continue;
		}
		for (const rec of rows) {
			if (nameLooksLikeHit(input.name, rec.name)) return bmfRowToHit(rec);
		}
	}
	return null;
}

export async function lookupCollegeScorecard(input: {
	name: string;
}): Promise<BulkOrgHit | null> {
	const q = String(input.name || '').trim().slice(0, 120);
	if (q.length < 3) return null;
	if (looksLikeForeignEducationName(q)) return null;
	const fields = [
		'id',
		'school.name',
		'school.city',
		'school.state',
		'school.zip',
		'school.address',
		'location.lat',
		'location.lon',
		'school.operating',
		'school.school_url',
	].join(',');
	const url =
		`${SCORECARD_API}?api_key=${encodeURIComponent(DATA_GOV_KEY)}` +
		`&school.name=${encodeURIComponent(q)}` +
		`&fields=${encodeURIComponent(fields)}` +
		`&per_page=5`;
	const res = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': UA },
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`scorecard HTTP ${res.status}`);
	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	const results = data.results || [];
	const hit = results.find((r) => nameLooksLikeHit(q, String(r['school.name'] || '')));
	if (!hit) return null;
	// Reject weak contains-only matches when token overlap is thin (e.g. Alexandria University → Alexandria LA).
	const qn = q.toLowerCase();
	const hn = String(hit['school.name'] || '').toLowerCase();
	if (qn !== hn && !hn.startsWith(qn) && !qn.startsWith(hn)) {
		const qt = qn.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !/(university|college|institute|school)/.test(t));
		const ht = new Set(hn.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
		const overlap = qt.filter((t) => ht.has(t)).length;
		if (qt.length >= 2 && overlap < 2) return null;
		if (qt.length === 1 && overlap < 1) return null;
	}

	const evidence: BulkOrgHit['evidence'] = [];
	const out: BulkOrgHit = { source: 'college-scorecard', evidence };
	const operating = Number(hit['school.operating']);
	if (operating === 1) {
		out.status = 'active';
		evidence.push({ field: 'status', source: 'college-scorecard', value: 'active' });
	} else if (operating === 0) {
		out.status = 'archived';
		evidence.push({ field: 'status', source: 'college-scorecard', value: 'archived' });
	}

	const street = String(hit['school.address'] || '').trim();
	const city = String(hit['school.city'] || '').trim();
	const state = String(hit['school.state'] || '').trim();
	const zip = String(hit['school.zip'] || '').trim();
	const raw = [street, city && state ? `${city}, ${state}` : city || state, zip]
		.filter(Boolean)
		.join(', ');
	if (raw && (isPlausibleStreetHq(raw) || (street && /\d/.test(street)))) {
		out.address = {
			raw,
			city: city || null,
			state: state || null,
			country: 'US',
			lat: Number(hit['location.lat']) || null,
			lon: Number(hit['location.lon']) || null,
			source: 'college-scorecard',
			sourceUrl: 'https://collegescorecard.ed.gov/data/',
		};
		evidence.push({ field: 'address', source: 'college-scorecard', value: raw });
	}
	return out;
}

export async function lookupIpedsHd(input: {
	name: string;
	ein?: string | null;
}): Promise<BulkOrgHit | null> {
	await ensureIpedsIndex();
	if (!ipedsByNormName) return null;
	// IPEDS HD is U.S.-only — skip clearly foreign institutions.
	if (looksLikeForeignEducationName(input.name)) return null;
	const n = normIpedsName(input.name);
	let row = ipedsByNormName.get(n) || null;
	if (!row) {
		for (const [key, rec] of ipedsByNormName) {
			const inst = rec.INSTNM || key;
			if (!nameLooksLikeHit(input.name, inst)) continue;
			const qt = n
				.split(' ')
				.filter((t) => t.length > 2 && !/(university|college|institute|school)/.test(t));
			const ht = new Set(
				normIpedsName(inst)
					.split(' ')
					.filter((t) => t.length > 2 && !/(university|college|institute|school)/.test(t)),
			);
			const overlap = qt.filter((t) => ht.has(t)).length;
			if (qt.length >= 2 && overlap < 2) continue;
			row = rec;
			break;
		}
	}
	if (!row) return null;

	const evidence: BulkOrgHit['evidence'] = [];
	const out: BulkOrgHit = { source: 'ipeds-hd', evidence };
	const ein = formatEin(row.EIN || '');
	if (ein) {
		out.ein = ein;
		evidence.push({ field: 'ein', source: 'ipeds-hd', value: ein });
	}
	const act = String(row.ACT || '').trim().toUpperCase();
	const cy = String(row.CYACTIVE || '').trim();
	if (act === 'A' || cy === '1') {
		out.status = 'active';
		evidence.push({ field: 'status', source: 'ipeds-hd', value: 'active' });
	} else if (act === 'D' || act === 'C' || cy === '0') {
		out.status = 'archived';
		evidence.push({ field: 'status', source: 'ipeds-hd', value: 'archived' });
		const closed = String(row.CLOSEDAT || '').trim();
		if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(closed)) {
			const [m, d, y] = closed.split('/');
			out.endDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
		} else if (/^\d{4}$/.test(String(row.DEATHYR || '').trim()) && Number(row.DEATHYR) > 1800) {
			out.endDate = String(row.DEATHYR).trim();
		}
	}

	const street = String(row.ADDR || '').trim();
	const city = String(row.CITY || '').trim();
	const state = String(row.STABBR || '').trim();
	const zip = String(row.ZIP || '').trim();
	const raw = [street, city && state ? `${city}, ${state}` : city || state, zip]
		.filter(Boolean)
		.join(', ');
	if (raw && isPlausibleStreetHq(raw)) {
		out.address = {
			raw,
			city: city || null,
			state: state || null,
			country: 'US',
			lat: Number(row.LATITUDE) || null,
			lon: Number(row.LONGITUD) || null,
			source: 'ipeds-hd',
			sourceUrl: 'https://nces.ed.gov/ipeds/',
		};
		evidence.push({ field: 'address', source: 'ipeds-hd', value: raw });
	}
	return out;
}

/** Download helper: fetch missing EO BMF state CSVs. */
export async function ensureEoBmfStates(states: string[] = ['ok', 'tx', 'tn', 'ny', 'md', 'dc']): Promise<string[]> {
	fs.mkdirSync(BMF_DIR, { recursive: true });
	const got: string[] = [];
	for (const st of states) {
		const code = st.toLowerCase();
		const dest = path.join(BMF_DIR, `eo_${code}.csv`);
		if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
			got.push(dest);
			continue;
		}
		const url = `https://www.irs.gov/pub/irs-soi/eo_${code}.csv`;
		const res = await fetch(url, {
			headers: { 'User-Agent': UA },
			signal: AbortSignal.timeout(180_000),
		});
		if (!res.ok) throw new Error(`EO BMF ${code} HTTP ${res.status}`);
		const text = await res.text();
		fs.writeFileSync(dest, text);
		got.push(dest);
		bmfByEin = null;
		bmfByNormName = null;
	}
	return got;
}
