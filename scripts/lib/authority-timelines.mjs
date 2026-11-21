/**
 * Shared helpers for authority timeline download / aggregate.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const OUT = path.join(ROOT, '.data', 'authority-timelines');

export const USER_AGENT =
	process.env.AUTHORITY_UA ||
	'ai-research-tool/1.0 (local research mirror; +https://localhost)';

export function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export function sha1(s) {
	return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

export function eventId({ agency, date, url, title }) {
	return sha1([agency, date, url, title].join('|'));
}

export function loadGazetteer() {
	const p = path.join(OUT, 'gazetteer', 'ok-tx-corridor.json');
	return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const PROMO_RE =
	/\b(worst of the worst|making america safe again|fact sheet|recruitment|manpower|campaign|sanctuary insanity|talking points|microsite)\b/i;
const RECRUIT_RE = /\b(recruit|hiring|manpower increase|join (ice|dea|cbp)|12,?000 officers)\b/i;
const SANCTUARY_RE = /\bsanctuary\b/i;
const INTL_RE =
	/\b(remov(?:e|ed|es|al) to|deported to|extradit|foreign partner|overseas|embassy|to (mexico|canada|guatemala|honduras|el salvador|colombia|china|india|vietnam|brazil|venezuela))\b/i;
const DOMESTIC_RE =
	/\b(american (families|communities|people)|sanctuary|title\s*32|national guard|domestic|city of|county)\b/i;
const OP_RE =
	/\b(operation\s+[A-Z][A-Za-z0-9'’\- ]{2,40}|midway blitz|highway sentinel|angel'?s honor|patriot 2\.0|buckeye)\b/i;

const EO_TOPIC_RE =
	/\b(immigrat|border|homeland|narcotic|fentanyl|drug|cartel|enforcement|deport|guard|defense|military|alien|asylum|visa|customs|ice\b|dea\b|cbp\b)\b/i;

export function classifyMaterial(title, summary = '', hint) {
	if (hint) return hint;
	const t = `${title}\n${summary}`;
	if (/\bexecutive order\b/i.test(t) || /\bproclamation\b/i.test(t)) return 'signed_directive';
	if (RECRUIT_RE.test(t)) return 'recruitment';
	if (OP_RE.test(t)) return 'joint_operation';
	if (PROMO_RE.test(t) && !/\barrrests?\b/i.test(title)) return 'promo_campaign';
	if (PROMO_RE.test(t)) return 'promo_campaign';
	if (INTL_RE.test(t) && /\b(remov|deport|extradit)/i.test(t)) return 'press_release';
	return 'press_release';
}

export function classifyAudience(title, summary = '') {
	const t = `${title}\n${summary}`;
	const intl = INTL_RE.test(t);
	const dom = DOMESTIC_RE.test(t) || /\b[A-Z][a-z]+,\s*[A-Z]{2}\b/.test(t);
	if (intl && dom) return 'both';
	if (intl) return 'international';
	if (dom) return 'domestic';
	return 'unknown';
}

export function extractInitiative(title, summary = '') {
	const t = `${title}\n${summary}`;
	const op = t.match(OP_RE);
	if (op) {
		const label = op[0].replace(/\s+/g, ' ').trim();
		return {
			initiative: label
				.toLowerCase()
				.replace(/^operation\s+/i, 'op-')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, ''),
			initiativeLabel: label,
		};
	}
	if (/worst of the worst/i.test(t)) {
		return { initiative: 'worst-of-the-worst', initiativeLabel: 'Worst of the Worst' };
	}
	if (/making america safe again/i.test(t)) {
		return { initiative: 'making-america-safe-again', initiativeLabel: 'Making America Safe Again' };
	}
	if (/sanctuary insanity/i.test(t)) {
		return { initiative: 'sanctuary-insanity', initiativeLabel: 'Sanctuary Insanity' };
	}
	return {};
}

export function extractGeos(text, gazetteer) {
	const found = [];
	const seen = new Set();
	const places = [...(gazetteer.places || [])].sort((a, b) => b.raw.length - a.raw.length);
	const hay = String(text || '');

	for (const place of places) {
		const re = new RegExp(`\\b${escapeRe(place.raw)}\\b`, 'i');
		if (!re.test(hay)) continue;
		const key = [place.city, place.county, place.state, place.raw].filter(Boolean).join('|').toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({
			raw: place.raw,
			city: place.city,
			county: place.county,
			state: place.state,
			country: place.country || 'US',
			corridor: !!place.corridor,
		});
	}

	// Generic "City, ST" patterns
	for (const m of hay.matchAll(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(OK|TX|AZ|CA|NM|NY|FL|IL|GA|OH|PA|WA|CO|NV)\b/g)) {
		const city = m[1];
		const state = m[2];
		const key = `${city}|${state}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const corridor = state === 'OK' || state === 'TX';
		found.push({ raw: `${city}, ${state}`, city, state, country: 'US', corridor });
	}

	const COUNTY_STOP = new Set(
		'politicians sanctuary officials leaders residents families american federal local state'.split(' '),
	);
	for (const m of hay.matchAll(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+County\b/g)) {
		const county = m[1];
		const parts = county.split(/\s+/);
		if (parts.some((p) => COUNTY_STOP.has(p.toLowerCase()))) continue;
		if (parts.length > 2) continue;
		const key = `county|${county}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ raw: `${county} County`, county, country: 'US' });
	}

	return found;
}

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSignals(title, summary, materialType, geos) {
	const t = `${title}\n${summary}`;
	return {
		isPromo: materialType === 'promo_campaign' || materialType === 'recruitment' || PROMO_RE.test(t),
		isSignedDirective: materialType === 'signed_directive',
		namesCities: (geos || []).some((g) => g.city || g.county),
		sanctuaryFraming: SANCTUARY_RE.test(t),
		recruitment: RECRUIT_RE.test(t) || materialType === 'recruitment',
	};
}

export function eoRelevant(title, abstract = '') {
	return EO_TOPIC_RE.test(`${title}\n${abstract}`);
}

export function normalizeEvent( partial, gazetteer) {
	const title = String(partial.title || '').trim();
	const summary = String(partial.summary || '').trim();
	const textForGeo = `${title}\n${summary}`;
	const materialType = classifyMaterial(title, summary, partial.materialType);
	const audience =
		partial.audience ||
		(materialType === 'international_outreach' ? 'international' : classifyAudience(title, summary));
	const init = extractInitiative(title, summary);
	const geos = partial.geos?.length ? partial.geos : extractGeos(textForGeo, gazetteer);
	const date = String(partial.date || '').slice(0, 10);
	const agency = partial.agency;
	const url = partial.url;
	const id = partial.id || eventId({ agency, date, url, title });
	return {
		id,
		agency,
		agencies: partial.agencies,
		date,
		dateKind: partial.dateKind || 'published',
		title,
		summary: summary || undefined,
		url,
		source: partial.source,
		materialType,
		audience,
		initiative: partial.initiative || init.initiative,
		initiativeLabel: partial.initiativeLabel || init.initiativeLabel,
		geos,
		topics: partial.topics || [],
		signals: buildSignals(title, summary, materialType, geos),
		rawPath: partial.rawPath,
		fetchedAt: partial.fetchedAt || new Date().toISOString(),
	};
}

export function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

export function writeJsonl(file, rows) {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function upsertEvents(file, incoming) {
	const byId = new Map();
	for (const e of readJsonl(file)) byId.set(e.id, e);
	let added = 0;
	let updated = 0;
	for (const e of incoming) {
		if (byId.has(e.id)) updated += 1;
		else added += 1;
		byId.set(e.id, e);
	}
	const all = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
	writeJsonl(file, all);
	return { total: all.length, added, updated };
}

export async function fetchText(url, { headers = {}, timeoutMs = 60000 } = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
			redirect: 'follow',
		});
		const text = await res.text();
		return { ok: res.ok, status: res.status, text, url: res.url };
	} finally {
		clearTimeout(t);
	}
}
