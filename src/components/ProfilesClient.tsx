'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ThemeToggle from '@/components/ThemeToggle';
import type {
	AlignmentCandidate,
	AlignmentKind,
	AlignmentStatus,
	CautionTier,
	EnrichProfileReport,
	Profile,
	ProfileDetail,
	ProfileStats,
	ProfileTimelineResult,
	ProfileType,
} from '@/lib/research/profiles/types';

const TYPE_META: Record<
	ProfileType,
	{ label: string; plural: string; badge: string; group: 'actor' | 'narrative' }
> = {
	person: {
		label: 'Person',
		plural: 'People',
		badge: 'bg-sky-500/15 text-sky-800 dark:text-sky-200 border-sky-500/30',
		group: 'actor',
	},
	firm: {
		label: 'Firm',
		plural: 'Firms',
		badge: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/30',
		group: 'actor',
	},
	education: {
		label: 'Education',
		plural: 'Education',
		badge: 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-200 border-indigo-500/30',
		group: 'actor',
	},
	nonprofit: {
		label: 'Non-Profit',
		plural: 'Non-Profits',
		badge: 'bg-violet-500/15 text-violet-800 dark:text-violet-200 border-violet-500/30',
		group: 'actor',
	},
	medical_hospital: {
		label: 'Hospital',
		plural: 'Hospitals',
		badge: 'bg-teal-500/15 text-teal-800 dark:text-teal-200 border-teal-500/30',
		group: 'actor',
	},
	government: {
		label: 'Government',
		plural: 'Government',
		badge: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/35',
		group: 'actor',
	},
	historic_event: {
		label: 'Historic Event',
		plural: 'Historic Events',
		badge: 'bg-rose-500/15 text-rose-800 dark:text-rose-200 border-rose-500/30',
		group: 'narrative',
	},
};

const ANGLE_BADGE: Record<string, string> = {
	civilian_health: 'bg-teal-500/15 text-teal-800 dark:text-teal-200',
	defense_dod: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
	law_enforcement: 'bg-red-500/15 text-red-800 dark:text-red-200',
	regulatory_finra: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
	land_records: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-200',
	academic_research: 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-200',
	geophysical: 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-200',
	policy: 'bg-purple-500/15 text-purple-800 dark:text-purple-200',
	corporate: 'bg-sky-500/15 text-sky-800 dark:text-sky-200',
	general: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300',
};

const CAUTION_BADGE: Record<CautionTier, string> = {
	observation: 'bg-sky-500/15 text-sky-800 dark:text-sky-200 border-sky-500/30',
	closer_look: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/35',
	stronger_indicator: 'bg-rose-500/15 text-rose-800 dark:text-rose-200 border-rose-500/35',
};

/** Person/firm with an endDate = deceased / defunct; keep legacy card colors. */
function profileHasEnded(p: Pick<Profile, 'endDate'>): boolean {
	return Boolean(p.endDate && String(p.endDate).trim());
}

function profileHasStartDate(p: Pick<Profile, 'startDate'>): boolean {
	return Boolean(p.startDate && String(p.startDate).trim());
}

/**
 * Soft green “current” tint:
 * - people: living (no endDate)
 * - firms: inactive by default until a startDate is confirmed, and not ended
 */
function isCurrentPersonOrFirm(
	p: Pick<Profile, 'profileType' | 'startDate' | 'endDate'>,
): boolean {
	if (profileHasEnded(p)) return false;
	if (p.profileType === 'person') return true;
	if (p.profileType === 'firm') return profileHasStartDate(p);
	return false;
}

const CURRENT_ACTOR_BADGE =
	'bg-emerald-500/20 text-emerald-900 dark:text-emerald-100 border-emerald-500/45';
const CURRENT_ACTOR_ROW =
	'bg-emerald-500/10 hover:bg-emerald-500/18 dark:bg-emerald-500/12 dark:hover:bg-emerald-500/20';
/** Selected current actors keep the orange left rail (same as other selected rows) on the green tint. */
const CURRENT_ACTOR_ROW_ACTIVE =
	'border-l-2 border-l-[#F97316] bg-emerald-500/20 dark:bg-emerald-500/25';
const CURRENT_ACTOR_DETAIL_OUTLINE =
	'border-emerald-500/55 ring-1 ring-emerald-500/35 dark:border-emerald-400/50 dark:ring-emerald-400/30';

const ALL_TYPES: ProfileType[] = [
	'historic_event',
	'person',
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
];

const HISTORY_FILTER = 'history';
const HISTORY_STORAGE_KEY = 'profiles.viewHistory.v1';
const HISTORY_LIMIT = 10_000;

type ViewHistoryEntry = {
	id: string;
	slug: string;
	name: string;
	profileType: ProfileType;
	primaryLocation?: string | null;
	countryCodes?: string[];
	alternateNames?: string[];
	endDate?: string | null;
	viewedAt: string;
};

function readViewHistory(): ViewHistoryEntry[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const out: ViewHistoryEntry[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue;
			const row = item as Record<string, unknown>;
			const id = String(row.id || '').trim();
			const slug = String(row.slug || '').trim();
			const name = String(row.name || '').trim();
			const profileType = String(row.profileType || '') as ProfileType;
			if (!id || !slug || !name || !ALL_TYPES.includes(profileType)) continue;
			out.push({
				id,
				slug,
				name,
				profileType,
				primaryLocation: row.primaryLocation != null ? String(row.primaryLocation) : null,
				countryCodes: Array.isArray(row.countryCodes)
					? row.countryCodes.map(String).filter(Boolean)
					: [],
				alternateNames: Array.isArray(row.alternateNames)
					? row.alternateNames.map(String).filter(Boolean)
					: [],
				endDate: row.endDate != null ? String(row.endDate) : null,
				viewedAt: String(row.viewedAt || new Date().toISOString()),
			});
			if (out.length >= HISTORY_LIMIT) break;
		}
		return out;
	} catch {
		return [];
	}
}

function writeViewHistory(entries: ViewHistoryEntry[]) {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
	} catch {
		/* quota / private mode */
	}
}

function historyEntryToProfile(entry: ViewHistoryEntry): Profile {
	return {
		id: entry.id,
		slug: entry.slug,
		profileType: entry.profileType,
		name: entry.name,
		normalizedName: entry.name.toLowerCase(),
		status: 'active',
		summary: '',
		startDate: null,
		endDate: entry.endDate ?? null,
		metadata: {},
		createdAt: entry.viewedAt,
		updatedAt: entry.viewedAt,
		aliasCount: entry.alternateNames?.length || 0,
		linkCount: 0,
		timelineCount: 0,
		alignmentCount: 0,
		corpora: [],
		primaryLocation: entry.primaryLocation ?? null,
		categoryTags: [],
		countryCodes: entry.countryCodes || [],
		alternateNames: entry.alternateNames || [],
	};
}

const EMPLOYER_CATEGORY_TYPES: ProfileType[] = [
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
];

const ENRICHED_DETAIL_FIELDS: Array<{ key: string; label: string }> = [
	{ key: 'occupation', label: 'Occupation' },
	{ key: 'title', label: 'Title' },
	{ key: 'yearsActive', label: 'Years Active' },
	{ key: 'genres', label: 'Genres' },
	{ key: 'instruments', label: 'Instruments' },
	{ key: 'labels', label: 'Record Labels' },
	{ key: 'formerlyOf', label: 'Formerly Of' },
	{ key: 'knownFor', label: 'Known For' },
	{ key: 'notableWorks', label: 'Notable Works' },
	{ key: 'officesHeld', label: 'Offices Held' },
	// citizenship omitted from UI — country flags already show nationality
	// politicalParty omitted from UI
	{ key: 'educationSummary', label: 'Education' },
	{ key: 'awards', label: 'Awards / Honors' },
	{ key: 'netWorth', label: 'Net Worth' },
	{ key: 'familyAndRelatives', label: 'Family / Relatives' },
	{ key: 'militaryBranch', label: 'Military Branch' },
	{ key: 'militaryRank', label: 'Military Rank' },
	{ key: 'yearsOfService', label: 'Years of Service' },
	{ key: 'militaryUnit', label: 'Military Unit' },
	{ key: 'militaryCommands', label: 'Military Commands' },
	{ key: 'battlesWars', label: 'Battles / Wars' },
	{ key: 'companyType', label: 'Entity Type' },
	{ key: 'industry', label: 'Industry' },
	{ key: 'products', label: 'Products' },
	{ key: 'services', label: 'Services' },
	{ key: 'revenue', label: 'Revenue' },
	{ key: 'netIncome', label: 'Net Income' },
	{ key: 'assets', label: 'Assets' },
	{ key: 'employees', label: 'Employees' },
	{ key: 'areaServed', label: 'Area Served' },
	{ key: 'divisions', label: 'Divisions' },
	{ key: 'predecessor', label: 'Predecessor' },
	{ key: 'successor', label: 'Successor' },
	{ key: 'jurisdiction', label: 'Jurisdiction' },
	{ key: 'parentAgency', label: 'Parent Agency' },
	{ key: 'isin', label: 'ISIN' },
	{ key: 'eventDateText', label: 'Event Date' },
	{ key: 'eventLocation', label: 'Event Location' },
	{ key: 'eventResult', label: 'Outcome / Result' },
	{ key: 'belligerents', label: 'Participants / Belligerents' },
	{ key: 'commanders', label: 'Commanders / Leaders' },
	{ key: 'casualties', label: 'Casualties / Losses' },
	{ key: 'causes', label: 'Causes' },
	{ key: 'finraBcScope', label: 'FINRA BrokerCheck Scope' },
	{ key: 'finraIaScope', label: 'SEC IA Scope' },
	{ key: 'finraYearsExperience', label: 'Years of Experience' },
	{ key: 'finraFirmsAllTime', label: 'Firms (all time)' },
	{ key: 'finraStateLicenses', label: 'State Licenses' },
	{ key: 'finraPrimaryOffice', label: 'Primary Office' },
	{ key: 'finraRegCount', label: 'FINRA Registrations' },
	{ key: 'finraSroCount', label: 'SRO Registrations' },
	{ key: 'finraStateBrokerCount', label: 'State Broker Lic.' },
	{ key: 'finraStateIaCount', label: 'State (IA) Lic.' },
	{ key: 'finraFirmType', label: 'Firm Type' },
	{ key: 'finraFormedState', label: 'Formed State' },
	{ key: 'finraFirmSize', label: 'Firm Size' },
	{ key: 'finraFirmStatus', label: 'Firm Status' },
	{ key: 'finraDistrict', label: 'FINRA District' },
	{ key: 'finraApprovedDate', label: 'FINRA Approved' },
	{ key: 'finraPhone', label: 'Business Phone' },
	{ key: 'bdSecNumber', label: 'BD SEC#' },
	{ key: 'iaSecNumber', label: 'IA SEC#' },
	{ key: 'finraDaysInIndustrySince', label: 'In Industry Since' },
	{ key: 'finraDaysInIndustry', label: 'Days in Industry' },
	{ key: 'finraDisclosureCount', label: 'FINRA Disclosures' },
	{ key: 'finraExams', label: 'FINRA Exams' },
	{ key: 'finraRegisteredStates', label: 'Registered States' },
	{ key: 'finraRegisteredSROs', label: 'Registered SROs' },
	{ key: 'website', label: 'Website' },
];

const MILITARY_DETAIL_KEYS = new Set([
	'militaryBranch',
	'militaryRank',
	'yearsOfService',
	'militaryUnit',
	'militaryCommands',
	'battlesWars',
]);

/** Fields that are always rendered full-width in the overview detail grid. */
const FULL_WIDTH_DETAIL_KEYS = new Set([
	'finraRegisteredStates',
	'finraRegisteredSROs',
	'finraExams',
	'finraStateLicenses',
	'finraPrimaryOffice',
	'knownFor',
	'notableWorks',
	'products',
	'services',
	'areaServed',
	'divisions',
	'awards',
	'educationSummary',
	'officesHeld',
	'belligerents',
	'commanders',
	'casualties',
	'causes',
	'formerlyOf',
	'labels',
]);

/**
 * Full-width when the field is known-long, the value is a long list (many · separators),
 * or the text itself is long enough to look cramped in a 1/3 grid cell.
 */
function isFullWidthDetailCard(key: string, text: string): boolean {
	if (FULL_WIDTH_DETAIL_KEYS.has(key)) return true;
	const t = String(text || '');
	if (!t) return false;
	const listParts = t.split(/\s·\s/).filter(Boolean);
	if (listParts.length >= 4) return true;
	if (t.length >= 90) return true;
	return false;
}

const OCCUPATION_LINK_RELATIONS = new Set([
	'employed_by',
	'affiliated_with',
	'business_tie',
	'owned_by',
	'registered_at',
	'alumni_or_faculty',
	'funded_by',
]);

type OccupationOrgPeer = { id: string; name: string };

/**
 * Hide / rewrite "epstein" data-source labels in the Profiles UI.
 * Underlying IDs stay in the DB; display only.
 */
function isHiddenEpsteinSourceIdentifier(scheme: string, value: string): boolean {
	const s = String(scheme || '').toLowerCase();
	const v = String(value || '').toLowerCase();
	if (s === 'source_id' && v.includes('epstein')) return true;
	if (v.startsWith('epstein-dialog-') || v.startsWith('epstein-files')) return true;
	return false;
}

/** Public registry / market identifiers shown in External Identifiers. */
const PUBLIC_IDENTIFIER_SCHEMES = new Set([
	'finra_crd',
	'sec_cik',
	'parent_sec_cik',
	'ticker',
	'irs_ein',
	'cusip',
	'ror',
	'orcid',
	'usgs_event',
	'spc_om',
	'okcr_instrument',
]);

const IDENTIFIER_SCHEME_LABELS: Record<string, string> = {
	finra_crd: 'CRD',
	sec_cik: 'CIK',
	parent_sec_cik: 'Parent CIK',
	ticker: 'Ticker',
	irs_ein: 'EIN',
	cusip: 'CUSIP',
	ror: 'ROR',
	orcid: 'ORCID',
	usgs_event: 'USGS',
	spc_om: 'SPC',
	okcr_instrument: 'OKCR',
};

function sourceLabelFromUrl(raw: string): string | null {
	const text = String(raw || '').trim();
	if (!text) return null;
	let host = '';
	try {
		const withProto = /^https?:\/\//i.test(text) ? text : `https://${text}`;
		host = new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
	} catch {
		const m = text.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
		host = m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
	}
	if (!host) return null;
	if (host.includes('wikipedia.org')) return 'wikipedia';
	if (host.includes('wikidata.org')) return 'wikidata';
	if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
	if (host.includes('brokercheck.finra.org') || host.includes('finra.org')) return 'finra';
	if (host.includes('adviserinfo.sec.gov') || host.includes('sec.gov')) return 'sec';
	if (host.includes('linkedin.com')) return 'linkedin';
	if (host.includes('bloomberg.com')) return 'bloomberg';
	if (host.includes('reuters.com')) return 'reuters';
	if (host.includes('nytimes.com')) return 'nytimes';
	if (host.includes('wsj.com')) return 'wsj';
	if (host.includes('github.com')) return 'github';
	if (host.includes('twitter.com') || host === 'x.com') return 'x';
	const base = host.split('.').slice(0, -1).join('.') || host;
	const first = base.split('.')[0] || host;
	return first.replace(/[^a-z0-9-]+/gi, '') || null;
}

function sourceLabelFromSchemeValue(scheme: string, value: string): string | null {
	const s = String(scheme || '').toLowerCase();
	const v = String(value || '').trim();
	// Only URL locators become Sources text (wikipedia, youtube, …).
	// wikidata / source_id / dossier_slug stay out of both Identifiers and Sources.
	if (s === 'url') return sourceLabelFromUrl(v);
	return null;
}

function collectProfileSourceLabels(
	identifiers: Array<{ scheme: string; value: string; sourceCorpus?: string | null }>,
): string[] {
	const labels = new Set<string>();
	for (const id of identifiers) {
		if (isHiddenEpsteinSourceIdentifier(id.scheme, id.value)) continue;
		const fromScheme = sourceLabelFromSchemeValue(id.scheme, id.value);
		if (fromScheme) labels.add(fromScheme);
	}
	return [...labels].sort((a, b) => a.localeCompare(b));
}

function formatSourceCorpusLabel(corpus: string | null | undefined): string {
	const raw = String(corpus || '').trim();
	if (!raw) return '';
	let out = raw
		.replace(/\bepstein-dialog-curated\b/gi, 'dialog-curated')
		.replace(/\bepstein-dialog-/gi, 'dialog-')
		.replace(/\bepstein-files\b/gi, 'court-files')
		.replace(/\bepstein[_-]+/gi, '')
		.replace(/--+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
	if (!out) out = 'curated';
	return out;
}

function scrubEpsteinSourceLabels(text: string | null | undefined): string {
	return String(text || '')
		.replace(/\bepstein-dialog-curated\b/gi, 'dialog-curated')
		.replace(/\bepstein-dialog-[a-z0-9:_-]+\b/gi, (m) => m.replace(/^epstein-/i, ''))
		.replace(/\bepstein-files\b/gi, 'court-files')
		.replace(/\bepstein[_-]+dialog\b/gi, 'dialog')
		.replace(/\bsource_id:\s*epstein-[^\s,;)]+/gi, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/** Corpus / import source tags that should never appear in Connected Profiles notes. */
const EVIDENCE_SOURCE_TAG_RE =
	/^(?:dallas-elite(?:-curated)?|wikipedia(?:-local)?|finra(?:-visualizer|-rosters)?|dynasties?(?:-power-network)?(?:-curated)?|entity-dossiers?|regional-history(?:-corpus)?|manual|curated|seed|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/i;

/**
 * Strip trailing/inline source corpus tags from link evidence notes for display
 * (e.g. "; dallas-elite", "; wikipedia-local"). Only splits on `;` so addresses
 * like "BOSTON, MA" stay intact.
 */
function scrubEvidenceNoteSourceTags(note: string | null | undefined): string {
	let out = scrubEpsteinSourceLabels(note);
	if (!out) return '';
	out = out
		.split(';')
		.map((piece) => piece.trim())
		.filter((piece) => piece && !EVIDENCE_SOURCE_TAG_RE.test(piece))
		.join('; ')
		.replace(/\s{2,}/g, ' ')
		.trim();
	return out;
}

/** True when note is only "A → B (Role)" style and adds nothing beyond the row UI. */
function isRedundantConnectedEvidenceNote(
	note: string,
	roleClean: string | null,
): boolean {
	const n = note.trim();
	if (!n) return true;
	if (/^(?:status|crd#|bcScope|iaScope|branch)=/i.test(n) || /\bCRD#\b/i.test(n)) {
		return false;
	}
	const arrow = /^(.+?)\s*[→←]\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/u.exec(n);
	if (!arrow) return false;
	const parenRole = (arrow[3] || '').trim();
	// Bare "A → B" with no extra detail is redundant with the row chrome.
	if (!parenRole) return true;
	// "A → B (Role)" is redundant when that role is already shown beside the peer name.
	if (roleClean && parenRole.toLowerCase() === roleClean.toLowerCase()) return true;
	return false;
}

/** Resolve a FINRA CRD from metadata or identifiers (person or firm). */
function resolveProfileFinraCrd(
	profileType: ProfileType,
	metadata: Record<string, unknown> | null | undefined,
	identifiers: Array<{ scheme: string; value: string }> | null | undefined,
): string | null {
	const fromMeta = String(metadata?.finraCrd || '').trim();
	if (/^\d{1,10}$/.test(fromMeta)) return fromMeta;
	for (const id of identifiers || []) {
		if (String(id.scheme || '').toLowerCase() !== 'finra_crd') continue;
		const v = String(id.value || '').trim();
		if (/^\d{1,10}$/.test(v)) return v;
	}
	void profileType;
	return null;
}

/** True when SEC IAPD has a meaningful page (not NotInScope / unknown). */
function hasValidSecIaScope(iaScope: unknown): boolean {
	const s = String(iaScope || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z]/g, '');
	return s === 'active' || s === 'inactive' || s === 'expanded';
}

function finraSecSourceLinks(opts: {
	profileType: ProfileType;
	crd: string;
	iaScope?: unknown;
}): Array<{ href: string; label: string; className: string }> {
	const crd = encodeURIComponent(opts.crd);
	const sky = 'text-[11px] font-semibold text-sky-600 underline dark:text-sky-300';
	const emerald = 'text-[11px] font-semibold text-emerald-600 underline dark:text-emerald-300';
	const includeSec = hasValidSecIaScope(opts.iaScope);
	const links: Array<{ href: string; label: string; className: string }> = [];
	if (opts.profileType === 'firm') {
		links.push(
			{
				href: `https://brokercheck.finra.org/firm/summary/${crd}`,
				label: 'FINRA Summary ↗',
				className: sky,
			},
			{
				href: `https://files.brokercheck.finra.org/firm/firm_${crd}.pdf`,
				label: 'FINRA PDF ↗',
				className: sky,
			},
		);
		if (includeSec) {
			links.push({
				href: `https://adviserinfo.sec.gov/firm/summary/${crd}`,
				label: 'SEC AdvisorInfo ↗',
				className: emerald,
			});
		}
		return links;
	}
	// person (and any other actor type that carries an individual CRD)
	links.push(
		{
			href: `https://brokercheck.finra.org/individual/summary/${crd}`,
			label: 'FINRA Summary ↗',
			className: sky,
		},
		{
			href: `https://files.brokercheck.finra.org/individual/individual_${crd}.pdf`,
			label: 'FINRA PDF ↗',
			className: sky,
		},
	);
	if (includeSec) {
		links.push({
			href: `https://adviserinfo.sec.gov/individual/summary/${crd}`,
			label: 'SEC AdvisorInfo ↗',
			className: emerald,
		});
	}
	return links;
}

/** Match linked org names inside occupation text (longest name first). */
function renderClickableOccupation(
	occupation: string,
	orgPeers: OccupationOrgPeer[],
	onJump: (id: string) => void,
): ReactNode {
	const text = String(occupation || '');
	if (!text) return null;
	if (!orgPeers.length) return text;

	const sorted = [...orgPeers]
		.filter((p) => p.id && p.name && p.name.trim().length >= 3)
		.sort((a, b) => b.name.length - a.name.length);

	type Hit = { start: number; end: number; id: string; label: string };
	const hits: Hit[] = [];
	const lower = text.toLowerCase();
	for (const peer of sorted) {
		const needle = peer.name.toLowerCase();
		let from = 0;
		while (from < lower.length) {
			const idx = lower.indexOf(needle, from);
			if (idx < 0) break;
			const end = idx + peer.name.length;
			const overlaps = hits.some((h) => idx < h.end && end > h.start);
			if (!overlaps) hits.push({ start: idx, end, id: peer.id, label: text.slice(idx, end) });
			from = idx + needle.length;
		}
	}

	if (!hits.length) {
		// No substring match — if a single clear employer peer exists, link the whole string
		if (sorted.length === 1) {
			return (
				<button
					type="button"
					onClick={() => onJump(sorted[0].id)}
					className="cursor-pointer border-0 bg-transparent p-0 text-left text-[11px] font-semibold text-[#F97316] underline"
					title={`Open ${sorted[0].name}`}
				>
					{text}
				</button>
			);
		}
		return text;
	}

	hits.sort((a, b) => a.start - b.start);
	const parts: ReactNode[] = [];
	let cursor = 0;
	hits.forEach((hit, i) => {
		if (hit.start > cursor) parts.push(text.slice(cursor, hit.start));
		parts.push(
			<button
				key={`${hit.id}-${hit.start}-${i}`}
				type="button"
				onClick={() => onJump(hit.id)}
				className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-[#F97316] underline"
				title={`Open ${hit.label}`}
			>
				{hit.label}
			</button>,
		);
		cursor = hit.end;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

/** Color accents for Captured Entity Details cards (by field key). */
function enrichedDetailCardClass(key: string): string {
	if (MILITARY_DETAIL_KEYS.has(key)) {
		return 'border-emerald-700/40 bg-emerald-950/30';
	}
	switch (key) {
		case 'occupation':
		case 'title':
		case 'yearsActive':
		case 'officesHeld':
			return 'border-orange-500/35 bg-orange-500/10';
		case 'knownFor':
		case 'notableWorks':
		case 'genres':
		case 'instruments':
		case 'labels':
		case 'formerlyOf':
			return 'border-violet-500/35 bg-violet-500/10';
		case 'educationSummary':
		case 'awards':
			return 'border-sky-500/35 bg-sky-500/10';
		case 'netWorth':
		case 'revenue':
		case 'netIncome':
		case 'assets':
		case 'employees':
			return 'border-amber-500/35 bg-amber-500/10';
		case 'familyAndRelatives':
			return 'border-rose-500/35 bg-rose-500/10';
		case 'companyType':
		case 'industry':
		case 'products':
		case 'services':
		case 'areaServed':
		case 'divisions':
		case 'predecessor':
		case 'successor':
		case 'jurisdiction':
		case 'parentAgency':
		case 'isin':
			return 'border-slate-500/35 bg-slate-500/10';
		default:
			return 'border-[var(--app-border)] bg-[var(--app-surface)]';
	}
}

const SPECIAL_FLAG_LABELS: Record<string, string> = {
	eu: 'European Union',
	un: 'United Nations',
	xk: 'Kosovo',
	'gb-eng': 'England',
	'gb-sct': 'Scotland',
	'gb-wls': 'Wales',
	'gb-nir': 'Northern Ireland',
};

function getFlagLabel(code: string): string {
	const c = String(code || '').toLowerCase();
	if (SPECIAL_FLAG_LABELS[c]) return SPECIAL_FLAG_LABELS[c];
	try {
		if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function' && /^[a-z]{2}$/.test(c)) {
			const dn = new Intl.DisplayNames(['en'], { type: 'region' });
			return dn.of(c.toUpperCase()) || c.toUpperCase();
		}
	} catch {
		/* ignore */
	}
	return c.toUpperCase();
}

/** Display dates as mo-day-year (MM-DD-YYYY). Partial ISO stays MM-YYYY or YYYY. */
function formatDisplayDate(iso?: string | null): string {
	const raw = String(iso || '').trim();
	if (!raw) return '';
	const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (ymd) return `${ymd[2]}-${ymd[3]}-${ymd[1]}`;
	const ym = raw.match(/^(\d{4})-(\d{2})$/);
	if (ym) return `${ym[2]}-${ym[1]}`;
	const y = raw.match(/^(\d{4})$/);
	if (y) return y[1];
	return raw;
}

const SUMMARY_MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
] as const;

/** Summary-section only: November 22, 2026 / June 2026 / 1995 – 1999 / October 2008 – present. */
function formatSummaryDatePart(part: string): string {
	const s = String(part || '').trim();
	if (!s) return '';
	if (/^present$/i.test(s)) return 'present';
	const iso = s.match(/^((?:18|19|20)\d{2})-(\d{2})-(\d{2})$/);
	if (iso) {
		const month = Number(iso[2]);
		const day = Number(iso[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return `${SUMMARY_MONTH_NAMES[month - 1]} ${day}, ${iso[1]}`;
		}
	}
	const us = s.match(/^(\d{2})-(\d{2})-((?:18|19|20)\d{2})$/);
	if (us) {
		const month = Number(us[1]);
		const day = Number(us[2]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return `${SUMMARY_MONTH_NAMES[month - 1]} ${day}, ${us[3]}`;
		}
	}
	const yyyyMm = s.match(/^((?:18|19|20)\d{2})-(\d{2})$/);
	if (yyyyMm) {
		const month = Number(yyyyMm[2]);
		if (month >= 1 && month <= 12) return `${SUMMARY_MONTH_NAMES[month - 1]} ${yyyyMm[1]}`;
	}
	const mmYyyy = s.match(/^(\d{2})-((?:18|19|20)\d{2})$/);
	if (mmYyyy) {
		const month = Number(mmYyyy[1]);
		if (month >= 1 && month <= 12) return `${SUMMARY_MONTH_NAMES[month - 1]} ${mmYyyy[2]}`;
	}
	if (/^(?:18|19|20)\d{2}$/.test(s)) return s;
	return s;
}

function formatSummaryDateLabel(label: string): string {
	const raw = String(label || '').trim();
	if (!raw) return '';
	let formatted = '';
	// En/em dash ranges (preferred in curated summaries).
	const enRange = raw.match(/^(.+?)\s*[–—]\s*(.+)$/);
	if (enRange) {
		formatted = `${formatSummaryDatePart(enRange[1])} – ${formatSummaryDatePart(enRange[2])}`;
	} else {
		// Hyphen year–year / year–present only (avoid splitting MM-DD-YYYY).
		const yearRange = raw.match(/^((?:18|19|20)\d{2})\s*-\s*((?:18|19|20)\d{2}|present|Present)$/i);
		if (yearRange) {
			formatted = `${formatSummaryDatePart(yearRange[1])} – ${formatSummaryDatePart(yearRange[2])}`;
		} else {
			const mmYyyyRange = raw.match(
				/^(\d{2}-(?:18|19|20)\d{2})\s*-\s*((?:18|19|20)\d{2}|\d{2}-(?:18|19|20)\d{2}|present|Present)$/i,
			);
			if (mmYyyyRange) {
				formatted = `${formatSummaryDatePart(mmYyyyRange[1])} – ${formatSummaryDatePart(mmYyyyRange[2])}`;
			} else {
				formatted = formatSummaryDatePart(raw);
			}
		}
	}
	// Summary dates render in capital case (AUGUST 14, 2026).
	return formatted.toUpperCase();
}

function formatExactDate(iso?: string | null): string {
	return formatDisplayDate(iso);
}

function formatMonthYear(iso?: string | null): string {
	return formatDisplayDate(iso);
}

function formatEmploymentDateSpan(
	startDate?: string | null,
	endDate?: string | null,
	isCurrent?: boolean | null,
): string | null {
	const s = formatExactDate(startDate);
	const e = formatExactDate(endDate);
	if (s && e) return s === e ? s : `${s} → ${e}`;
	if (s) return isCurrent === true ? `Employed since ${s}` : isCurrent === false ? s : `${s} → Present`;
	if (e) return `Ended ${e}`;
	return null;
}

function formatDateSpan(
	startDate?: string | null,
	endDate?: string | null,
	isCurrent?: boolean | null,
	isEducation?: boolean,
): string | null {
	const s = formatDisplayDate(startDate);
	const e = formatDisplayDate(endDate);
	if (s && e) return s === e ? s : `${s} → ${e}`;
	if (s) return isCurrent === false ? s : `${s} → Present`;
	if (e) return isEducation ? `Grad. ${e}` : `Ended ${e}`;
	return null;
}

const SUMMARY_YEAR_TOKEN =
	'(?:18|19|20)\\d{2}(?:\\s*[–—-]\\s*(?:(?:18|19|20)\\d{2}|present|Present))?|\\d{4}-\\d{2}-\\d{2}|\\d{2}-\\d{2}-\\d{4}|\\d{2}-\\d{4}(?:\\s*[–—-]\\s*(?:(?:18|19|20)\\d{2}|\\d{2}-\\d{4}|present|Present))?|\\d{4}-\\d{2}(?:\\s*[–—-]\\s*(?:(?:18|19|20)\\d{2}|\\d{4}-\\d{2}|present|Present))?';
const SUMMARY_YEAR_RE = new RegExp(`\\b(?:${SUMMARY_YEAR_TOKEN})\\b`, 'g');
const SUMMARY_YEAR_CONNECTOR_RE = /(?:In|From|During|By|Until|Since|After|Before)\s+$/i;

function renderSummaryInline(text: string, emphasizeClass = 'font-bold text-white'): ReactNode[] {
	const nodes: ReactNode[] = [];
	let last = 0;
	let key = 0;
	const src = String(text || '');
	const tokenRe = new RegExp(`(\\*\\*([^*]+)\\*\\*)|(\\b(?:${SUMMARY_YEAR_TOKEN})\\b)`, 'g');
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(src))) {
		if (m.index > last) nodes.push(src.slice(last, m.index));
		const content = m[2] != null ? m[2] : m[3];
		const display =
			m[2] != null && !new RegExp(`^(?:${SUMMARY_YEAR_TOKEN})$`).test(String(content || '').trim())
				? content
				: formatSummaryDateLabel(String(content || ''));
		nodes.push(
			<strong key={`s-${key++}`} className={emphasizeClass}>
				{display}
			</strong>,
		);
		last = m.index + m[0].length;
	}
	if (last < src.length) nodes.push(src.slice(last));
	return nodes;
}

/**
 * Drop pronunciation / phonetic guides from overview summaries.
 * Keeps birth/death parentheticals: "Name ( / tiːl /; born 1967)" → "Name (born 1967)".
 * Slash pairs with `.` inside are left alone so URLs are not mangled.
 */
function stripPronunciationGuides(text: string): string {
	return String(text || '')
		// Labels only — do not drop the whole parenthetical (birth dates live there too).
		.replace(/\b(?:pronounced|pronunciation|IPA)\s*[:–—-]?\s*/gi, '')
		// Slash phonetics, including spaced letters: /tiːl/ or / t iː l /
		.replace(/\s*\/\s*[^/\n.]{1,48}?\//g, '')
		.replace(/\(\s*listen\s*\)/gi, ' ')
		// After removing phonetics inside a paren: "( ; born …)" → "(born …)"
		.replace(/\(\s*[;,:]\s*/g, '(')
		.replace(/\(\s+/g, '(')
		.replace(/\(\s*\)/g, ' ')
		// Collapse horizontal runs only — keep newlines for labeled / year sections.
		.replace(/[^\S\n]{2,}/g, ' ')
		.replace(/[^\S\n]+([,.;:])/g, '$1')
		.replace(/[^\S\n]+\n/g, '\n')
		.trim();
}

const SUMMARY_LABEL_RE = /^(?:\*\*)?([^*:\n]{1,48})(?:\*\*)?\s*:\s*(.+)$/;
const SUMMARY_DISCLAIMER_RE =
	/(?:appearance in this curated|does not allege|does not imply|records public|disclaimer|appearing in .{0,40}does not)/i;

type SummaryBlock =
	| { kind: 'grid'; rows: Array<{ label: string; value: string }> }
	| { kind: 'year'; year: string; text: string }
	| { kind: 'prose'; text: string }
	| { kind: 'disclaimer'; text: string };

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yearSectionStart(src: string, yearIndex: number): number {
	const before = src.slice(Math.max(0, yearIndex - 16), yearIndex);
	const connector = before.match(SUMMARY_YEAR_CONNECTOR_RE);
	return connector ? yearIndex - connector[0].length : yearIndex;
}

/**
 * True when a year opens a real section (sentence start / labeled milestone),
 * false for mid-sentence citations like "PayPal (1998)" or "sale … in 2002".
 */
function isYearSectionAnchor(src: string, yearIndex: number): boolean {
	const beforeWindow = src.slice(Math.max(0, yearIndex - 20), yearIndex);
	const connector = beforeWindow.match(SUMMARY_YEAR_CONNECTOR_RE);
	const effectiveStart = connector ? yearIndex - connector[0].length : yearIndex;
	const before = src.slice(0, effectiveStart);
	const openParens = (before.match(/\(/g) || []).length;
	const closeParens = (before.match(/\)/g) || []).length;
	// Years inside parentheticals are citations, not section headers.
	if (openParens > closeParens) return false;
	if (effectiveStart === 0) return true;
	// Must begin a sentence (or line), optionally after In/From/During…
	if (/(?:^|[\n.!?])["'\u201c\u201d\s]*$/.test(before)) return true;
	return false;
}

/** Split prose into lead + year cards only at sentence-starting year anchors. */
function sectionProseByYears(text: string): SummaryBlock[] {
	const src = String(text || '').trim();
	if (!src) return [];

	const allYears: Array<{ index: number; year: string }> = [];
	SUMMARY_YEAR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SUMMARY_YEAR_RE.exec(src))) {
		if (allYears.some((y) => Math.abs(y.index - m!.index) < 2)) continue;
		allYears.push({ index: m.index, year: m[0] });
	}
	if (allYears.length === 0) return [{ kind: 'prose', text: src }];

	const years = allYears.filter((y) => isYearSectionAnchor(src, y.index));

	// Single trailing parenthetical range with no sentence anchors:
	// e.g. "Secretary of State (Reagan administration, 1982–1989)."
	if (years.length === 0 && allYears.length === 1) {
		const y = allYears[0];
		const open = src.lastIndexOf('(', y.index);
		const close = src.indexOf(')', y.index);
		if (open >= 0 && close > y.index && !src.slice(open + 1, y.index).includes(')')) {
			const lead = src
				.slice(0, open)
				.trim()
				.replace(/[,;:\-\u2013\u2014\s]+$/g, '')
				.trim();
			let paren = src.slice(open + 1, close).trim();
			paren = paren
				.replace(new RegExp(`(?:,\\s*)?${escapeRegExp(y.year)}`), '')
				.replace(/^[,;\s]+|[,;\s]+$/g, '')
				.trim();
			const body = [lead, paren].filter(Boolean).join(' — ') || lead || paren || '—';
			return [{ kind: 'year', year: y.year, text: body }];
		}
	}

	if (years.length === 0) return [{ kind: 'prose', text: src }];

	const sentenceEndAfter = (from: number): number => {
		const slice = src.slice(from);
		const sm = slice.match(/[.!?](?:["'\u201c\u201d])?(?:\s|$)/);
		if (!sm || sm.index == null) return src.length;
		return from + sm.index + 1;
	};

	const blocks: SummaryBlock[] = [];
	let cursor = 0;
	for (let i = 0; i < years.length; i++) {
		const cur = years[i];
		let start = yearSectionStart(src, cur.index);
		if (start < cursor) start = cur.index;
		const lead = src
			.slice(cursor, start)
			.trim()
			.replace(/[,;:\-\u2013\u2014\s]+$/g, '')
			.trim();
		if (lead) blocks.push({ kind: 'prose', text: lead });

		let end = sentenceEndAfter(Math.max(cur.index, start));
		if (i + 1 < years.length) {
			const nextStart = yearSectionStart(src, years[i + 1].index);
			if (nextStart < end) end = nextStart;
		}
		if (end <= start) end = Math.min(src.length, cur.index + cur.year.length);

		let body = src.slice(start, end).trim();
		body = body.replace(/^(?:In|From|During|By|Until|Since|After|Before)\s+/i, '');
		body = body.replace(new RegExp(`^${escapeRegExp(cur.year)}\\s*[–—:,.;\\-]*\\s*`), '');
		body = body.replace(/^[,:;.\-\u2013\u2014\s]+/, '').trim();
		body = body.replace(/^\)+[,.;]?$/, '').trim();
		if (body && !/^[—–\-\s.]+$/.test(body)) {
			blocks.push({ kind: 'year', year: cur.year, text: body });
		}
		cursor = Math.max(cursor, end);
	}
	const trailing = src.slice(cursor).trim().replace(/^[,;:\-\u2013\u2014\s]+/, '').trim();
	if (trailing) blocks.push({ kind: 'prose', text: trailing });
	if (!blocks.some((b) => b.kind === 'year')) return [{ kind: 'prose', text: src }];
	return blocks;
}

function normalizeSummaryMarkup(text: string): string {
	return String(text || '')
		// Turn **1919**: / **1919–1920**: into plain year labels for sectioning.
		.replace(new RegExp(`\\*\\*(${SUMMARY_YEAR_TOKEN})\\*\\*\\s*:`, 'g'), '$1:')
		.replace(new RegExp(`\\*\\*(${SUMMARY_YEAR_TOKEN})\\*\\*`, 'g'), '$1')
		// Drop orphan ** left after year unwraps; keep **phrase** markers for bolding.
		.replace(/(^|\s)\*\*(?=\s|$)/gm, '$1')
		.replace(/(?<=\s)\*\*(\s|$)/gm, '$1')
		.trim();
}

function parseSummaryBlocks(text: string): SummaryBlock[] {
	const cleaned = normalizeSummaryMarkup(stripPronunciationGuides(text));
	const lines = cleaned
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	const blocks: SummaryBlock[] = [];
	let gridRows: Array<{ label: string; value: string }> = [];

	const flushGrid = () => {
		if (gridRows.length === 0) return;
		blocks.push({ kind: 'grid', rows: gridRows });
		gridRows = [];
	};

	for (const rawLine of lines) {
		let line = rawLine;
		let trailingDisclaimer: string | null = null;
		const discIdx = line.search(SUMMARY_DISCLAIMER_RE);
		if (discIdx === 0) {
			flushGrid();
			blocks.push({ kind: 'disclaimer', text: line.replace(/^\*\*|\*\*$/g, '').trim() });
			continue;
		}
		if (discIdx > 0) {
			trailingDisclaimer = line.slice(discIdx).trim();
			line = line
				.slice(0, discIdx)
				.trim()
				.replace(/[,;.\-\u2013\u2014\s]+$/g, '')
				.trim();
		}
		if (!line) {
			if (trailingDisclaimer) {
				flushGrid();
				blocks.push({ kind: 'disclaimer', text: trailingDisclaimer });
			}
			continue;
		}
		const labeled = line.match(SUMMARY_LABEL_RE);
		if (labeled) {
			const label = labeled[1].replace(/^\*\*|\*\*$/g, '').trim();
			const value = labeled[2].trim();
			// Year-as-label lines become year sections for scanning.
			if (new RegExp(`^(?:${SUMMARY_YEAR_TOKEN})$`).test(label.replace(/\*\*/g, ''))) {
				flushGrid();
				blocks.push({ kind: 'year', year: label.replace(/\*\*/g, ''), text: value });
			} else {
				gridRows.push({ label, value });
			}
		} else {
			flushGrid();
			// Wikipedia prose: only sentence-starting years become date cards
			// (mid-sentence "(1998)" / "in 2002" stay inline). Explicit "YEAR: …" labels
			// are handled above.
			for (const part of sectionProseByYears(line)) blocks.push(part);
		}
		if (trailingDisclaimer) {
			flushGrid();
			blocks.push({ kind: 'disclaimer', text: trailingDisclaimer });
		}
	}
	flushGrid();
	return blocks;
}

function SummarySectionCard({
	label,
	children,
	accent = false,
}: {
	label: string;
	children: ReactNode;
	accent?: boolean;
}) {
	return (
		<div className="space-y-0.5">
			<div
				className={`text-[11px] font-semibold tracking-wide ${
					accent ? 'text-[#FDBA74]' : 'text-[#F97316]'
				}`}
			>
				{label}
			</div>
			<div className="text-[12px] leading-snug text-white">{children}</div>
		</div>
	);
}

/** Newest date wins. Prefers day/month precision; closed ranges use the later end; open “–present” uses the start so recent dated events stay above long-running roles. */
function summaryYearSortKey(yearLabel: string): number {
	const raw = String(yearLabel || '').trim();
	if (/\bpresent\b/i.test(raw)) {
		const startOnly = raw.replace(/\s*[–—-]\s*present\b/i, '').trim();
		if (startOnly && startOnly !== raw) return summaryYearSortKey(startOnly);
		return 9999_12_31;
	}
	const iso = raw.match(/\b((?:18|19|20)\d{2})-(\d{2})-(\d{2})\b/);
	if (iso) return Number(iso[1]) * 10_000 + Number(iso[2]) * 100 + Number(iso[3]);
	const us = raw.match(/\b(\d{2})-(\d{2})-((?:18|19|20)\d{2})\b/);
	if (us) return Number(us[3]) * 10_000 + Number(us[1]) * 100 + Number(us[2]);
	const yyyyMm = raw.match(/\b((?:18|19|20)\d{2})-(\d{2})\b/);
	if (yyyyMm) return Number(yyyyMm[1]) * 10_000 + Number(yyyyMm[2]) * 100 + 99;
	const mmYyyy = raw.match(/\b(\d{2})-((?:18|19|20)\d{2})\b/);
	if (mmYyyy) return Number(mmYyyy[2]) * 10_000 + Number(mmYyyy[1]) * 100 + 99;
	const nums = [...raw.matchAll(/\b((?:18|19|20)\d{2})\b/g)].map((m) => Number(m[1]));
	if (nums.length === 0) return 0;
	return Math.max(...nums) * 10_000;
}

/** All profile summaries: white text, year sections (newest first within runs), labeled grid, bold dates. */
function ProfileSummaryText({ text }: { text: string }) {
	const raw = String(text || '').trim();
	if (!raw) return null;
	const blocks = parseSummaryBlocks(raw).filter((b) => {
		if (b.kind !== 'year') return true;
		const t = String(b.text || '')
			.replace(/^[—–\-\s.]+$/, '')
			.trim();
		return t.length > 0;
	});

	// Keep document order for prose/grid; sort only contiguous year-card runs (newest first).
	const renderItems: SummaryBlock[] = [];
	for (let i = 0; i < blocks.length; ) {
		const b = blocks[i];
		if (b.kind === 'year') {
			const run: Array<{ kind: 'year'; year: string; text: string }> = [];
			while (i < blocks.length && blocks[i].kind === 'year') {
				run.push(blocks[i] as { kind: 'year'; year: string; text: string });
				i += 1;
			}
			run.sort((a, b2) => summaryYearSortKey(b2.year) - summaryYearSortKey(a.year));
			renderItems.push(...run);
			continue;
		}
		renderItems.push(b);
		i += 1;
	}

	return (
		<div className="mt-2 max-w-3xl rounded-lg border border-white/15 bg-[#0b1220] p-3 text-xs leading-relaxed text-white shadow-sm">
			<div className="space-y-2.5">
				{renderItems.map((block, idx) => {
					if (block.kind === 'year') {
						return (
							<SummarySectionCard
								key={`y-${idx}`}
								label={formatSummaryDateLabel(block.year)}
								accent
							>
								{renderSummaryInline(block.text, 'font-bold text-white')}
							</SummarySectionCard>
						);
					}
					if (block.kind === 'grid') {
						// Labels duplicate Title / role chips — hide from overview summary UI.
						const rows = block.rows.filter((row) => !/^labels$/i.test(String(row.label || '').trim()));
						if (rows.length === 0) return null;
						return (
							<div key={`g-${idx}`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{rows.map((row, ri) => (
									<SummarySectionCard key={`r-${idx}-${ri}`} label={row.label}>
										{renderSummaryInline(row.value, 'font-bold text-white')}
									</SummarySectionCard>
								))}
							</div>
						);
					}
					if (block.kind === 'disclaimer') {
						// Curated network disclaimers stay in source metadata / stored text for integrity,
						// but are not shown in the overview (perspective flexibility).
						return null;
					}
					return (
						<p key={`p-${idx}`} className="m-0 text-[12px] text-white">
							{renderSummaryInline(block.text, 'font-bold text-white')}
						</p>
					);
				})}
			</div>
		</div>
	);
}

function CountryFlags({ codes, size = 'sm' }: { codes?: string[]; size?: 'sm' | 'md' }) {
	if (!codes || codes.length === 0) return null;
	const dims = size === 'md' ? 'h-4 w-[21px]' : 'h-3 w-4';
	return (
		<span
			className="inline-flex shrink-0 flex-wrap items-center gap-1 align-middle"
			title={codes.map(getFlagLabel).join(' · ')}
		>
			{codes.map((code) => {
				const label = getFlagLabel(code);
				return (
					// eslint-disable-next-line @next/next/no-img-element
					<img
						key={code}
						src={`/flags/4x3/${encodeURIComponent(code.toLowerCase())}.svg`}
						alt={label}
						title={label}
						loading="lazy"
						className={`${dims} inline-block rounded-[2px] border border-black/15 object-cover shadow-xs dark:border-white/15`}
					/>
				);
			})}
		</span>
	);
}

const ALIGNMENT_KINDS: Array<{ value: AlignmentKind | ''; label: string }> = [
	{ value: '', label: 'All kinds' },
	{ value: 'possible_match_name_only', label: 'Name-only match (needs validation)' },
	{ value: 'cross_source_mention', label: 'Cross-source mention' },
	{ value: 'county_filing_match', label: 'County filing match' },
	{ value: 'knowledge_store_match', label: 'Knowledge store match' },
	{ value: 'angle_comparison', label: 'Multi-angle overlap' },
	{ value: 'same_entity_alias', label: 'Alias / name overlap' },
	{ value: 'co_occurrence_time_geo', label: 'Geo-temporal overlap' },
	{ value: 'building_colocation', label: 'Same-building co-location' },
	{ value: 'block_colocation', label: 'Same-block co-location' },
	{ value: 'city_colocation', label: 'Same-city co-location' },
	{ value: 'shared_affiliation', label: 'Shared affiliation' },
	{ value: 'shared_identifier', label: 'Shared ID (CRD/CIK)' },
];

function slugToProfilePath(slug?: string | null): string {
	const raw = String(slug || '').trim();
	if (!raw) return '/profiles';
	const colonIdx = raw.indexOf(':');
	if (colonIdx > 0) {
		const typePart = raw.slice(0, colonIdx);
		const namePart = raw.slice(colonIdx + 1);
		return `/profiles/${encodeURIComponent(typePart)}/${encodeURIComponent(namePart)}`;
	}
	return `/profiles/${encodeURIComponent(raw)}`;
}

function parseProfilesPathname(pathname: string): {
	view: 'profile' | 'alignments';
	profileSlug: string | null;
} {
	const clean = String(pathname || '').replace(/^\/+|\/+$/g, '');
	const segments = clean.split('/').filter(Boolean);
	if (segments[0] !== 'profiles' || segments.length <= 1) {
		return { view: 'profile', profileSlug: null };
	}
	const rest = segments.slice(1).map((s) => decodeURIComponent(s));
	if (rest[0] === 'alignments') {
		return { view: 'alignments', profileSlug: null };
	}
	if (rest.length >= 2) {
		return { view: 'profile', profileSlug: `${rest[0]}:${rest.slice(1).join('-')}` };
	}
	return { view: 'profile', profileSlug: rest[0] || null };
}

export default function ProfilesClient({
	initialProfileSlug,
	initialView,
}: {
	initialProfileSlug?: string;
	initialView?: 'profile' | 'alignments';
} = {}) {
	const [stats, setStats] = useState<ProfileStats | null>(null);
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [totalProfiles, setTotalProfiles] = useState(0);
	const [loadingList, setLoadingList] = useState(false);
	const [viewHistory, setViewHistory] = useState<ViewHistoryEntry[]>([]);
	const viewHistoryRef = useRef<ViewHistoryEntry[]>([]);

	// Filters
	const [query, setQuery] = useState('');
	const [typeFilter, setTypeFilter] = useState<string>('all');
	const [countryCode, setCountryCode] = useState<string>('');
	const [countryQuery, setCountryQuery] = useState('');
	const [countryMenuOpen, setCountryMenuOpen] = useState(false);
	const [countryOptions, setCountryOptions] = useState<Array<{ code: string; name: string }>>([]);
	const countryBoxRef = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState(0);

	// Workspace mode & URL/scroll sync
	const [mainView, setMainView] = useState<'profile' | 'alignments'>(initialView || 'profile');
	const [selectedId, setSelectedId] = useState<string | null>(initialProfileSlug || null);
	const [detail, setDetail] = useState<ProfileDetail | null>(null);
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [profileTab, setProfileTab] = useState<'overview' | 'timeline' | 'alignments'>('overview');
	const [pendingCategorySync, setPendingCategorySync] = useState(Boolean(initialProfileSlug));
	const skipNextPushRef = useRef(Boolean(initialProfileSlug));
	const urlInitializedRef = useRef(false);
	const selectedRowRef = useRef<HTMLButtonElement | null>(null);

	// Timeline state
	const [timeline, setTimeline] = useState<ProfileTimelineResult | null>(null);
	const [loadingTimeline, setLoadingTimeline] = useState(false);
	const [timelineAngle, setTimelineAngle] = useState('');
	const [minGapDays, setMinGapDays] = useState(30);

	// Global alignments triage state
	const [globalAlignments, setGlobalAlignments] = useState<AlignmentCandidate[]>([]);
	const [globalAlignTotal, setGlobalAlignTotal] = useState(0);
	const [alignKindFilter, setAlignKindFilter] = useState<string>('');
	const [alignStatusFilter, setAlignStatusFilter] = useState<string>('proposed');
	const [alignOffset, setAlignOffset] = useState(0);
	const [loadingGlobalAlign, setLoadingGlobalAlign] = useState(false);
	const ALIGN_PAGE_SIZE = 80;

	// Sync, Enrich & Create states
	const [syncing, setSyncing] = useState(false);
	const [enriching, setEnriching] = useState(false);
	const [lastEnrichReport, setLastEnrichReport] = useState<EnrichProfileReport | null>(null);
	const [banner, setBanner] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [newType, setNewType] = useState<ProfileType>('historic_event');
	const [newName, setNewName] = useState('');
	const [newSummary, setNewSummary] = useState('');
	const [newAliases, setNewAliases] = useState('');
	const [newLocation, setNewLocation] = useState('');
	const [newStartDate, setNewStartDate] = useState('');
	const [newEmployer, setNewEmployer] = useState('');
	const [newEmployerCategory, setNewEmployerCategory] = useState<ProfileType>('firm');
	const [newEmployerRole, setNewEmployerRole] = useState('');
	const [creating, setCreating] = useState(false);

	// Manual timeline observation form
	const [obsDate, setObsDate] = useState('');
	const [obsTitle, setObsTitle] = useState('');
	const [obsSummary, setObsSummary] = useState('');
	const [obsAngle, setObsAngle] = useState('general');
	const [obsGeo, setObsGeo] = useState('');
	const [obsUrl, setObsUrl] = useState('');
	const [savingObs, setSavingObs] = useState(false);

	// Manual alias, location, and employment forms
	const [aliasDraft, setAliasDraft] = useState('');
	const [locationDraft, setLocationDraft] = useState('');
	const [empOrgName, setEmpOrgName] = useState('');
	const [empOrgCategory, setEmpOrgCategory] = useState<ProfileType>('firm');
	const [empRole, setEmpRole] = useState('');
	const [empStart, setEmpStart] = useState('');
	const [empEnd, setEmpEnd] = useState('');
	const [empLocation, setEmpLocation] = useState('');
	const [savingEmp, setSavingEmp] = useState(false);
	const [connStatusFilter, setConnStatusFilter] = useState<'all' | 'current' | 'old'>('all');
	const [hydratingDates, setHydratingDates] = useState(false);

	const syncUrl = useCallback(
		(next: { profile?: string | null; view?: 'profile' | 'alignments' }, mode: 'push' | 'replace' = 'push') => {
			if (typeof window === 'undefined') return;
			const nextHref =
				next.view === 'alignments'
					? '/profiles/alignments'
					: next.profile
						? slugToProfilePath(next.profile)
						: '/profiles';
			const curHref = `${window.location.pathname}${window.location.search}`;
			if (nextHref === curHref) return;
			if (mode === 'replace') window.history.replaceState(null, '', nextHref);
			else window.history.pushState(null, '', nextHref);
		},
		[],
	);

	// Initialize from path (/profiles/<type>/<slug> or /profiles/alignments) & support browser Back/Forward
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const applyFromLocation = () => {
			const parsed = parseProfilesPathname(window.location.pathname);
			skipNextPushRef.current = true;
			if (parsed.view === 'alignments') {
				setMainView('alignments');
			} else {
				setMainView('profile');
				if (parsed.profileSlug) {
					setPendingCategorySync(true);
					setSelectedId(parsed.profileSlug);
				}
			}
		};
		if (!urlInitializedRef.current) {
			urlInitializedRef.current = true;
			applyFromLocation();
		}
		const onPop = () => applyFromLocation();
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);

	const loadList = useCallback(async () => {
		setLoadingList(true);
		setError(null);
		try {
			if (typeFilter === HISTORY_FILTER) {
				const q = query.trim().toLowerCase();
				let entries = viewHistoryRef.current;
				if (q) {
					entries = entries.filter(
						(e) =>
							e.name.toLowerCase().includes(q) ||
							e.slug.toLowerCase().includes(q) ||
							(e.alternateNames || []).some((a) => a.toLowerCase().includes(q)) ||
							(e.primaryLocation || '').toLowerCase().includes(q),
					);
				}
				if (countryCode) {
					const cc = countryCode.toLowerCase();
					entries = entries.filter((e) => (e.countryCodes || []).some((c) => c.toLowerCase() === cc));
				}
				const page = entries.slice(offset, offset + 60).map(historyEntryToProfile);
				setProfiles(page);
				setTotalProfiles(entries.length);
				// Keep global stats fresh without changing the history list source
				try {
					const statsRes = await fetch('/api/profiles?limit=1&stats=1', { cache: 'no-store' });
					const statsData = await statsRes.json();
					if (statsRes.ok && statsData?.ok && statsData.stats) {
						setStats(statsData.stats as ProfileStats);
					}
				} catch {
					/* non-fatal */
				}
				return;
			}

			const params = new URLSearchParams();
			if (query.trim()) params.set('q', query.trim());
			if (typeFilter && typeFilter !== 'all') params.set('type', typeFilter);
			if (countryCode) params.set('country', countryCode);
			params.set('limit', '60');
			params.set('offset', String(offset));
			params.set('stats', '1');

			const res = await fetch(`/api/profiles?${params.toString()}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
			setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
			setTotalProfiles(Number(data.total || 0));
			if (data.stats) setStats(data.stats as ProfileStats);
			const pathProfile =
				typeof window !== 'undefined' ? parseProfilesPathname(window.location.pathname).profileSlug : null;
			if (!selectedId && !pathProfile && Array.isArray(data.profiles) && data.profiles.length > 0) {
				skipNextPushRef.current = true;
				setSelectedId(String(data.profiles[0].slug || data.profiles[0].id));
			}
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingList(false);
		}
	}, [query, typeFilter, countryCode, offset, selectedId]);

	const loadDetail = useCallback(
		async (id: string) => {
			setLoadingDetail(true);
			try {
				const res = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { cache: 'no-store' });
				const data = await res.json();
				if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
				const loaded = data as ProfileDetail;
				setDetail(loaded);
				// Keep URL canonicalized to the readable slug (e.g. /profiles?profile=person:alex-karp)
				const mode = skipNextPushRef.current ? 'replace' : 'push';
				skipNextPushRef.current = false;
				syncUrl({ profile: loaded.profile.slug, view: 'profile' }, mode);
			} catch (e: unknown) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoadingDetail(false);
			}
		},
		[syncUrl],
	);

	const loadTimeline = useCallback(
		async (id: string) => {
			setLoadingTimeline(true);
			try {
				const params = new URLSearchParams();
				if (timelineAngle) params.set('angle', timelineAngle);
				params.set('minGapDays', String(minGapDays));
				params.set('limit', '120');
				const res = await fetch(
					`/api/profiles/${encodeURIComponent(id)}/timeline?${params.toString()}`,
					{ cache: 'no-store' },
				);
				const data = await res.json();
				if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
				setTimeline(data as ProfileTimelineResult);
			} catch (e: unknown) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoadingTimeline(false);
			}
		},
		[timelineAngle, minGapDays],
	);

	const loadGlobalAlignments = useCallback(async () => {
		setLoadingGlobalAlign(true);
		try {
			const params = new URLSearchParams();
			if (alignKindFilter) params.set('kind', alignKindFilter);
			if (alignStatusFilter) params.set('status', alignStatusFilter);
			params.set('limit', String(ALIGN_PAGE_SIZE));
			params.set('offset', String(alignOffset));
			const res = await fetch(`/api/profiles/alignments?${params.toString()}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
			setGlobalAlignments(Array.isArray(data.alignments) ? data.alignments : []);
			setGlobalAlignTotal(Number(data.total || 0));
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingGlobalAlign(false);
		}
	}, [alignKindFilter, alignStatusFilter, alignOffset]);

	useEffect(() => {
		const initial = readViewHistory();
		viewHistoryRef.current = initial;
		setViewHistory(initial);
	}, []);

	useEffect(() => {
		viewHistoryRef.current = viewHistory;
	}, [viewHistory]);

	useEffect(() => {
		const timer = setTimeout(() => {
			void loadList();
		}, 120);
		return () => clearTimeout(timer);
	}, [loadList]);

	// When history entries change while History tab is active, refresh the left list.
	useEffect(() => {
		if (typeFilter !== HISTORY_FILTER) return;
		const timer = setTimeout(() => {
			void loadList();
		}, 60);
		return () => clearTimeout(timer);
	}, [viewHistory, typeFilter, loadList]);

	// Persist viewed profiles into History (newest first, max HISTORY_LIMIT).
	useEffect(() => {
		if (!detail?.profile?.id || mainView !== 'profile') return;
		const p = detail.profile;
		const locFromDetail =
			detail.locations?.find((l) => l.role === 'hq' || l.role === 'residence')?.raw ||
			detail.locations?.[0]?.raw ||
			null;
		const entry: ViewHistoryEntry = {
			id: p.id,
			slug: p.slug,
			name: p.name,
			profileType: p.profileType,
			primaryLocation: p.primaryLocation || locFromDetail,
			countryCodes: p.countryCodes || [],
			alternateNames: p.alternateNames || [],
			endDate: p.endDate ?? null,
			viewedAt: new Date().toISOString(),
		};
		setViewHistory((prev) => {
			const alreadyTop = prev[0]?.id === entry.id || prev[0]?.slug === entry.slug;
			if (alreadyTop) {
				const merged: ViewHistoryEntry = { ...prev[0], ...entry };
				const next = [merged, ...prev.slice(1)];
				writeViewHistory(next);
				viewHistoryRef.current = next;
				const sameDisplay =
					prev[0].name === merged.name &&
					prev[0].primaryLocation === merged.primaryLocation &&
					(prev[0].countryCodes || []).join() === (merged.countryCodes || []).join();
				return sameDisplay ? prev : next;
			}
			const next = [entry, ...prev.filter((e) => e.id !== entry.id && e.slug !== entry.slug)].slice(
				0,
				HISTORY_LIMIT,
			);
			writeViewHistory(next);
			return next;
		});
	}, [detail, mainView]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch('/flags/country.json', { cache: 'force-cache' });
				if (!res.ok) return;
				const rows = (await res.json()) as Array<{ code?: string; name?: string }>;
				if (cancelled || !Array.isArray(rows)) return;
				const opts = rows
					.map((r) => ({
						code: String(r.code || '')
							.trim()
							.toLowerCase(),
						name: String(r.name || '').trim(),
					}))
					.filter((r) => r.code && r.name)
					.sort((a, b) => a.name.localeCompare(b.name));
				// Ensure specials exist even if JSON omits them
				for (const extra of [
					{ code: 'un', name: 'United Nations' },
					{ code: 'eu', name: 'European Union' },
				]) {
					if (!opts.some((o) => o.code === extra.code)) opts.push(extra);
				}
				opts.sort((a, b) => a.name.localeCompare(b.name));
				setCountryOptions(opts);
			} catch {
				/* ignore */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const onDocMouseDown = (ev: MouseEvent) => {
			if (!countryBoxRef.current) return;
			if (!countryBoxRef.current.contains(ev.target as Node)) setCountryMenuOpen(false);
		};
		document.addEventListener('mousedown', onDocMouseDown);
		return () => document.removeEventListener('mousedown', onDocMouseDown);
	}, []);

	useEffect(() => {
		if (!selectedId || mainView !== 'profile') return;
		const timer = setTimeout(() => {
			setConnStatusFilter('all');
			void loadDetail(selectedId);
		}, 0);
		return () => clearTimeout(timer);
	}, [selectedId, mainView, loadDetail]);

	useEffect(() => {
		if (!selectedId || mainView !== 'profile' || profileTab !== 'timeline') return;
		const timer = setTimeout(() => {
			void loadTimeline(selectedId);
		}, 0);
		return () => clearTimeout(timer);
	}, [selectedId, mainView, profileTab, loadTimeline]);

	useEffect(() => {
		if (mainView !== 'alignments') return;
		const timer = setTimeout(() => {
			void loadGlobalAlignments();
		}, 0);
		return () => clearTimeout(timer);
	}, [mainView, loadGlobalAlignments]);

	async function handleSync(mode: 'full' | 'align_only') {
		setSyncing(true);
		setError(null);
		setBanner(null);
		try {
			const res = await fetch('/api/profiles/sync', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode, includeKnowledgeCrossMatch: true }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Sync failed (${res.status})`);
			if (data.stats) setStats(data.stats as ProfileStats);
			const ms = data.report?.durationMs ?? data.alignment?.durationMs ?? 0;
			setBanner(
				mode === 'full'
					? `Synced all corpora & recomputed alignments in ${(ms / 1000).toFixed(1)}s (${data.stats?.totalProfiles ?? 0} profiles, ${data.stats?.totalAlignments ?? 0} alignments).`
					: `Recomputed alignments in ${ms}ms (${data.alignment?.totalUpserted ?? 0} candidates).`,
			);
			await loadList();
			if (selectedId) await loadDetail(selectedId);
			if (mainView === 'alignments') await loadGlobalAlignments();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSyncing(false);
		}
	}

	async function handleHydrateFirmDates() {
		if (!detail) return;
		setHydratingDates(true);
		setError(null);
		setBanner(null);
		const firmId = detail.profile.id;
		let totalPeopleWithDates = 0;
		let totalPeopleChecked = 0;
		let totalLinksUpdated = 0;
		let remaining = 0;
		let rateLimited = false;
		try {
			// Loop batches until undated FINRA links are gone or FINRA rate-limits us.
			for (let round = 0; round < 40; round += 1) {
				const res = await fetch(`/api/profiles/${encodeURIComponent(firmId)}/finra-dates`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ maxPeople: 200, concurrency: 4 }),
				});
				const data = await res.json();
				if (!res.ok || !data?.ok) throw new Error(data?.error || `Date lookup failed (${res.status})`);
				if (data.detail) setDetail(data.detail);
				const r = data.result;
				totalPeopleWithDates += Number(r?.peopleWithDates || 0);
				totalPeopleChecked += Number(r?.peopleChecked || 0);
				totalLinksUpdated += Number(r?.linksUpdated || 0);
				remaining = Number(r?.remainingUndated || 0);
				rateLimited = Boolean(r?.rateLimited);
				setBanner(
					`Fetched employment dates… ${totalPeopleWithDates}/${totalPeopleChecked} people (${totalLinksUpdated} links)${remaining > 0 ? `, ${remaining} remaining` : ''}${rateLimited ? ' — paused on FINRA rate limit' : ''}.`,
				);
				if (remaining <= 0 || Number(r?.peopleChecked || 0) === 0) break;
				if (rateLimited) break;
			}
			if (!detail || detail.profile.id !== firmId) await loadDetail(firmId);
			setBanner(
				`Fetched employment dates for ${totalPeopleWithDates}/${totalPeopleChecked} connected people (${totalLinksUpdated} links updated${remaining > 0 ? `, ${remaining} remaining` : ''}${rateLimited ? ' — paused on FINRA rate limit, retry in ~1 min' : ''}).`,
			);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setHydratingDates(false);
		}
	}

	async function handleCreateProfile(e: React.FormEvent) {
		e.preventDefault();
		if (!newName.trim()) return;
		setCreating(true);
		setError(null);
		try {
			const aliases = newAliases
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const locations = newLocation.trim() ? [{ raw: newLocation.trim() }] : [];
			const employmentHistory =
				newType === 'person' && newEmployer.trim()
					? [
							{
								orgName: newEmployer.trim(),
								orgCategory: newEmployerCategory,
								role: newEmployerRole.trim() || null,
								location: newLocation.trim() || null,
							},
						]
					: undefined;
			const res = await fetch('/api/profiles', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					profileType: newType,
					name: newName.trim(),
					summary: newSummary.trim(),
					startDate: newStartDate.trim() || null,
					aliases,
					locations,
					employmentHistory,
					status: 'pinned',
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Create failed (${res.status})`);
			setShowCreate(false);
			setNewName('');
			setNewSummary('');
			setNewAliases('');
			setNewLocation('');
			setNewStartDate('');
			setNewEmployer('');
			setNewEmployerRole('');
			setSelectedId(String(data.profile.id));
			setMainView('profile');
			await loadList();
			setBanner(`Created profile "${data.profile.name}".`);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreating(false);
		}
	}

	async function handleAddObservation(e: React.FormEvent) {
		e.preventDefault();
		if (!selectedId || !obsTitle.trim()) return;
		setSavingObs(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}/timeline`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					eventDate: obsDate.trim() || null,
					title: obsTitle.trim(),
					summary: obsSummary.trim(),
					angle: obsAngle,
					geoLabel: obsGeo.trim() || null,
					sourceUrl: obsUrl.trim() || null,
					sourceCorpus: 'manual',
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
			setObsDate('');
			setObsTitle('');
			setObsSummary('');
			setObsGeo('');
			setObsUrl('');
			await loadTimeline(selectedId);
			await loadDetail(selectedId);
			setBanner('Added timeline observation.');
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingObs(false);
		}
	}

	async function handleAddAlias() {
		if (!selectedId || !aliasDraft.trim()) return;
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ addAlias: aliasDraft.trim() }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			setAliasDraft('');
			setDetail(data as ProfileDetail);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleAddLocation() {
		if (!selectedId || !locationDraft.trim()) return;
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ addLocation: { raw: locationDraft.trim(), role: 'residence' } }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			setLocationDraft('');
			setDetail(data as ProfileDetail);
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleAddEmployment(e: React.FormEvent) {
		e.preventDefault();
		if (!selectedId || !empOrgName.trim()) return;
		setSavingEmp(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}/employment`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					orgName: empOrgName.trim(),
					orgCategory: empOrgCategory,
					role: empRole.trim() || null,
					startDate: empStart.trim() || null,
					endDate: empEnd.trim() || null,
					location: empLocation.trim() || null,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			setEmpOrgName('');
			setEmpRole('');
			setEmpStart('');
			setEmpEnd('');
			setEmpLocation('');
			if (data.detail) setDetail(data.detail as ProfileDetail);
			await loadList();
			setBanner('Added employment history record.');
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingEmp(false);
		}
	}

	async function handleTriageAlignment(id: string, status: AlignmentStatus) {
		try {
			const res = await fetch('/api/profiles/alignments', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, status }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			if (selectedId && mainView === 'profile') await loadDetail(selectedId);
			if (mainView === 'alignments') await loadGlobalAlignments();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleMergeProfiles(keepId: string, mergeId: string, keepLabel: string, mergeLabel: string) {
		if (
			typeof window !== 'undefined' &&
			!window.confirm(
				`Merge "${mergeLabel}" into "${keepLabel}"? All aliases, identifiers, locations, links, and timeline entries will be consolidated onto "${keepLabel}".`,
			)
		) {
			return;
		}
		setError(null);
		try {
			const res = await fetch('/api/profiles/merge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ keepId, mergeId }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Merge failed');
			setBanner(`Merged "${mergeLabel}" into "${keepLabel}".`);
			if (selectedId === mergeId) setSelectedId(keepId);
			await loadList();
			if (mainView === 'profile') await loadDetail(keepId);
			if (mainView === 'alignments') await loadGlobalAlignments();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleEnrichProfile() {
		if (!selectedId) return;
		setEnriching(true);
		setError(null);
		setBanner(null);
		setLastEnrichReport(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}/enrich`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					includeWikipedia: true,
					includeBrokercheck: true,
					includeKnowledge: true,
					includeBryanUcc: true,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Research enrichment failed');
			const report = data.report as EnrichProfileReport;
			setLastEnrichReport(report);
			if (data.detail) setDetail(data.detail as ProfileDetail);
			await loadList();
			if (profileTab === 'timeline') await loadTimeline(selectedId);
			const summaryMsg =
				report.validatedSources > 0
					? `Validated enrichment from ${report.validatedSources} source(s) (${report.fieldsUpdated.join(', ') || 'refreshed'}).`
					: 'No validated new fields merged.';
			const noteMsg =
				report.heldNameOnlyNotes > 0
					? ` ${report.heldNameOnlyNotes} name-only match(es) held as review notes (NOT merged).`
					: '';
			setBanner(`${summaryMsg}${noteMsg}`);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setEnriching(false);
		}
	}

	useEffect(() => {
		if (!pendingCategorySync || !detail?.profile) return;
		if (detail.profile.id !== selectedId && detail.profile.slug !== selectedId) return;
		const timer = setTimeout(() => {
			setTypeFilter(detail.profile.profileType);
			setOffset(0);
			setPendingCategorySync(false);
		}, 0);
		return () => clearTimeout(timer);
	}, [pendingCategorySync, detail, selectedId]);

	// Drop Timeline / Alignments tabs when their counts are zero.
	useEffect(() => {
		if (!detail) return;
		if (profileTab === 'timeline' && detail.counts.timelineEntries <= 0) {
			setProfileTab('overview');
		} else if (profileTab === 'alignments' && detail.counts.alignments <= 0) {
			setProfileTab('overview');
		}
	}, [detail, profileTab]);

	useEffect(() => {
		if (!detail?.profile?.id || mainView !== 'profile') return;
		const timer = setTimeout(() => {
			selectedRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}, 60);
		return () => clearTimeout(timer);
	}, [detail?.profile?.id, profiles, mainView]);

	const jumpToProfile = useCallback((id: string) => {
		setPendingCategorySync(true);
		setQuery('');
		setCountryCode('');
		setCountryQuery('');
		setCountryMenuOpen(false);
		setOffset(0);
		setSelectedId(id);
		setLastEnrichReport(null);
		setMainView('profile');
		setProfileTab('overview');
	}, []);

	return (
		<main className="mx-auto flex min-h-dvh max-w-[1380px] flex-col px-4 py-5 text-[var(--app-fg)]">
			{/* Top Header */}
			<header className="mb-4 flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2 text-xs opacity-75">
						<Link
							href="/"
							className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 font-semibold no-underline hover:bg-[var(--app-surface-hover)]"
						>
							← Research Chat
						</Link>
						<span>local SQLite · cross-source entity &amp; timeline alignment</span>
					</div>
					<h1 className="my-1.5 text-[24px] font-semibold tracking-tight">
						Entity Profiles &amp; Cross-Source Alignment
					</h1>
					<p className="m-0 max-w-4xl text-xs leading-relaxed opacity-80">
						Unified canonical profiles for <strong>People</strong>, <strong>Firms</strong>,{' '}
						<strong>Education</strong>, <strong>Non-Profits</strong>, <strong>Hospitals</strong>,{' '}
						<strong>Government</strong>, and <strong>Historic Events</strong> — combining all local
						corpora to fill timeline gaps, compare angles, and surface possible alignments.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => {
							const nextView = mainView === 'alignments' ? 'profile' : 'alignments';
							setMainView(nextView);
							syncUrl({
								view: nextView,
								profile: nextView === 'profile' ? detail?.profile.slug || selectedId : null,
							});
						}}
						className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-semibold ${
							mainView === 'alignments'
								? 'border-[#F97316] bg-[#F97316] text-white'
								: 'border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-surface-hover)]'
						}`}
					>
						{mainView === 'alignments'
							? 'Back to Profiles'
							: `Alignment Triage (${stats?.alignmentsByStatus?.proposed ?? 0})`}
					</button>
					<button
						type="button"
						onClick={() => setShowCreate((v) => !v)}
						className="cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--app-surface-hover)]"
					>
						+ New Profile
					</button>
					<button
						type="button"
						disabled={syncing}
						onClick={() => void handleSync('full')}
						className="cursor-pointer rounded-md border-none bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
					>
						{syncing ? 'Syncing & Aligning…' : 'Sync & Align All Data'}
					</button>
					<ThemeToggle />
				</div>
			</header>

			{banner ? (
				<div className="mb-3 flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
					<span>{banner}</span>
					<button
						type="button"
						onClick={() => setBanner(null)}
						className="cursor-pointer border-0 bg-transparent text-xs font-semibold opacity-70"
					>
						✕
					</button>
				</div>
			) : null}

			{error ? (
				<div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">
					{error}
				</div>
			) : null}

			{/* Stats Bar / Quick Type Filters */}
			{stats ? (
				<section className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-10">
					<button
						type="button"
						onClick={() => {
							setTypeFilter('all');
							setOffset(0);
							setMainView('profile');
						}}
						className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
							typeFilter === 'all' && mainView === 'profile'
								? 'border-[#F97316] bg-[#F97316]/10'
								: 'border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-surface-hover)]'
						}`}
					>
						<div className="text-[11px] opacity-70">All Profiles</div>
						<div className="text-base font-semibold">{stats.totalProfiles.toLocaleString()}</div>
					</button>
					{ALL_TYPES.map((t) => {
						const isFiltered = typeFilter === t && mainView === 'profile';
						const isCurrentProfileType =
							typeFilter === 'all' && mainView === 'profile' && detail?.profile.profileType === t;
						return (
							<button
								key={t}
								type="button"
								onClick={() => {
									setTypeFilter(t);
									setOffset(0);
									setMainView('profile');
								}}
								className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
									isFiltered
										? 'border-[#F97316] bg-[#F97316]/12 ring-1 ring-[#F97316]/40'
										: isCurrentProfileType
											? 'border-[#F97316]/70 bg-[#F97316]/8'
											: 'border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-surface-hover)]'
								}`}
							>
								<div className="text-[11px] opacity-70">{TYPE_META[t].plural}</div>
								<div className="text-base font-semibold">{(stats.byType[t] || 0).toLocaleString()}</div>
							</button>
						);
					})}
					<button
						type="button"
						onClick={() => {
							setPendingCategorySync(false);
							setTypeFilter(HISTORY_FILTER);
							setOffset(0);
							setMainView('profile');
						}}
						title="Recently viewed profiles (stored in this browser, up to 100)"
						className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
							typeFilter === HISTORY_FILTER && mainView === 'profile'
								? 'border-[#F97316] bg-[#F97316]/12 ring-1 ring-[#F97316]/40'
								: 'border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-surface-hover)]'
						}`}
					>
						<div className="text-[11px] opacity-70">History</div>
						<div className="text-base font-semibold">{viewHistory.length.toLocaleString()}</div>
					</button>
				</section>
			) : null}

			{/* Create Profile Drawer */}
			{showCreate ? (
				<form
					onSubmit={(e) => void handleCreateProfile(e)}
					className="mb-4 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-3.5"
				>
					<div className="mb-2 flex items-center justify-between">
						<h2 className="m-0 text-sm font-semibold">Create Canonical Profile</h2>
						<button
							type="button"
							onClick={() => setShowCreate(false)}
							className="cursor-pointer border-0 bg-transparent text-xs opacity-70"
						>
							Cancel
						</button>
					</div>
					<div className="grid gap-2.5 sm:grid-cols-3">
						<label className="flex flex-col gap-1 text-xs">
							<span className="opacity-75">Profile Type</span>
							<select
								value={newType}
								onChange={(e) => setNewType(e.target.value as ProfileType)}
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							>
								<optgroup label="Main Actor Profiles">
									<option value="person">Person</option>
									<option value="firm">Firm / Company</option>
									<option value="education">Education (University / School / District)</option>
									<option value="nonprofit">Non-Profit / Foundation / Institute</option>
									<option value="medical_hospital">Hospital / Health System</option>
									<option value="government">Government (Domestic / Foreign / Intl)</option>
								</optgroup>
								<optgroup label="Events &amp; Timelines">
									<option value="historic_event">Historic Event / Topic</option>
								</optgroup>
							</select>
						</label>
						<label className="flex flex-col gap-1 text-xs sm:col-span-2">
							<span className="opacity-75">Name *</span>
							<input
								required
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="e.g. Rockefeller Foundation, University of Texas at Dallas, 2008 Financial Crisis"
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs">
							<span className="opacity-75">Aliases (comma-separated)</span>
							<input
								value={newAliases}
								onChange={(e) => setNewAliases(e.target.value)}
								placeholder="e.g. UTD, UT Dallas"
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs">
							<span className="opacity-75">Location (optional)</span>
							<input
								value={newLocation}
								onChange={(e) => setNewLocation(e.target.value)}
								placeholder="e.g. Dallas, TX"
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs">
							<span className="opacity-75">Start Date (optional)</span>
							<input
								value={newStartDate}
								onChange={(e) => setNewStartDate(e.target.value)}
								placeholder="YYYY-MM-DD or YYYY"
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs sm:col-span-3">
							<span className="opacity-75">Summary / Research Angle</span>
							<textarea
								rows={2}
								value={newSummary}
								onChange={(e) => setNewSummary(e.target.value)}
								placeholder="Brief description or key questions this profile tracks…"
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
							/>
						</label>
						{newType === 'person' ? (
							<>
								<label className="flex flex-col gap-1 text-xs">
									<span className="opacity-75">Initial Employer / Organization (optional)</span>
									<input
										value={newEmployer}
										onChange={(e) => setNewEmployer(e.target.value)}
										placeholder="e.g. Rockefeller Financial LLC"
										className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									<span className="opacity-75">Employer Category</span>
									<select
										value={newEmployerCategory}
										onChange={(e) => setNewEmployerCategory(e.target.value as ProfileType)}
										className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
									>
										{EMPLOYER_CATEGORY_TYPES.map((t) => (
											<option key={t} value={t}>
												{TYPE_META[t].label}
											</option>
										))}
									</select>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									<span className="opacity-75">Role / Title (optional)</span>
									<input
										value={newEmployerRole}
										onChange={(e) => setNewEmployerRole(e.target.value)}
										placeholder="e.g. Managing Director, Professor"
										className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs"
									/>
								</label>
							</>
						) : null}
					</div>
					<div className="mt-3 flex justify-end">
						<button
							type="submit"
							disabled={creating}
							className="cursor-pointer rounded-md border-none bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
						>
							{creating ? 'Creating…' : 'Create Profile'}
						</button>
					</div>
				</form>
			) : null}

			{/* Main Content Area — flex-1 fills remaining viewport under the header/stats */}
			{mainView === 'alignments' ? (
				<section className="min-h-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
					<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
						<div>
							<h2 className="m-0 text-base font-semibold">
								Cross-Source Alignment Leads ({globalAlignTotal})
							</h2>
							<p className="m-0 text-xs opacity-75">
								Possible links, alias collisions, geo-temporal overlaps, multi-angle windows, and
								knowledge.sqlite county-filing matches. Confirm verified links or dismiss false positives.
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<select
								value={alignKindFilter}
								onChange={(e) => {
									setAlignKindFilter(e.target.value);
									setAlignOffset(0);
								}}
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
							>
								{ALIGNMENT_KINDS.map((k) => (
									<option key={k.value || 'all'} value={k.value}>
										{k.label}
									</option>
								))}
							</select>
							<select
								value={alignStatusFilter}
								onChange={(e) => {
									setAlignStatusFilter(e.target.value);
									setAlignOffset(0);
								}}
								className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
							>
								<option value="">All statuses</option>
								<option value="proposed">Proposed</option>
								<option value="confirmed">Confirmed</option>
								<option value="dismissed">Dismissed</option>
							</select>
							<button
								type="button"
								disabled={syncing}
								onClick={() => void handleSync('align_only')}
								className="cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--app-surface-hover)]"
							>
								Re-run Alignment Pass
							</button>
						</div>
					</div>

					{globalAlignTotal > 0 ? (
						<div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs opacity-80">
							<span>
								Showing {Math.min(alignOffset + 1, globalAlignTotal)}–
								{Math.min(alignOffset + globalAlignments.length, globalAlignTotal)} of{' '}
								{globalAlignTotal.toLocaleString()}
								{alignStatusFilter ? ` (${alignStatusFilter})` : ''}
							</span>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									disabled={alignOffset <= 0 || loadingGlobalAlign}
									onClick={() => setAlignOffset((o) => Math.max(0, o - ALIGN_PAGE_SIZE))}
									className="cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40"
								>
									Prev
								</button>
								<button
									type="button"
									disabled={
										alignOffset + ALIGN_PAGE_SIZE >= globalAlignTotal || loadingGlobalAlign
									}
									onClick={() => setAlignOffset((o) => o + ALIGN_PAGE_SIZE)}
									className="cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40"
								>
									Next
								</button>
							</div>
						</div>
					) : null}

					{loadingGlobalAlign ? (
						<p className="text-xs opacity-70">Loading alignments…</p>
					) : globalAlignments.length === 0 ? (
						<p className="text-xs opacity-70">No alignment candidates match the current filters.</p>
					) : (
						<div className="flex flex-col gap-2.5">
							{globalAlignments.map((al) => (
								<div
									key={al.id}
									className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<div className="flex flex-wrap items-center gap-1.5">
											<span
												className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CAUTION_BADGE[al.cautionTier]}`}
											>
												{al.cautionTier.replace(/_/g, ' ')}
											</span>
											<span
												className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
													al.alignmentKind === 'possible_match_name_only'
														? 'border border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200'
														: 'bg-[var(--app-surface-hover)]'
												}`}
											>
												{al.alignmentKind === 'possible_match_name_only'
													? 'Name-only match (NOT merged — needs validation)'
													: al.alignmentKind.replace(/_/g, ' ')}
											</span>
											<span className="text-[11px] opacity-70">score {al.score.toFixed(2)}</span>
											<span className="text-[11px] opacity-60">· {al.status}</span>
										</div>
										<div className="flex items-center gap-1.5">
											{(al.alignmentKind === 'same_entity_alias' ||
												al.alignmentKind === 'shared_identifier') &&
											al.rightProfileId ? (
												<button
													type="button"
													onClick={() =>
														void handleMergeProfiles(
															al.leftProfileId,
															al.rightProfileId!,
															al.leftName || al.leftSlug || al.leftProfileId,
															al.rightName || al.rightSlug || al.rightProfileId!,
														)
													}
													className="cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/15 px-2 py-0.5 text-[11px] font-semibold text-[#F97316]"
												>
													Merge
												</button>
											) : null}
											{al.status !== 'confirmed' ? (
												<button
													type="button"
													onClick={() => void handleTriageAlignment(al.id, 'confirmed')}
													className="cursor-pointer rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200"
												>
													Confirm
												</button>
											) : null}
											{al.status !== 'dismissed' ? (
												<button
													type="button"
													onClick={() => void handleTriageAlignment(al.id, 'dismissed')}
													className="cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-2 py-0.5 text-[11px] opacity-75 hover:opacity-100"
												>
													Dismiss
												</button>
											) : null}
										</div>
									</div>

									<div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-semibold">
										<button
											type="button"
											onClick={() => jumpToProfile(al.leftProfileId)}
											className="cursor-pointer border-0 bg-transparent p-0 text-left text-xs font-semibold text-[#F97316] underline"
										>
											{al.leftName || al.leftSlug}
										</button>
										{al.leftType ? (
											<span className="text-[10px] opacity-60">[{al.leftType}]</span>
										) : null}
										{al.rightProfileId ? (
											<>
												<span className="opacity-50">↔</span>
												<button
													type="button"
													onClick={() => jumpToProfile(al.rightProfileId!)}
													className="cursor-pointer border-0 bg-transparent p-0 text-left text-xs font-semibold text-[#F97316] underline"
												>
													{al.rightName || al.rightSlug}
												</button>
												{al.rightType ? (
													<span className="text-[10px] opacity-60">[{al.rightType}]</span>
												) : null}
											</>
										) : null}
									</div>

									<p className="my-1.5 leading-relaxed opacity-85">
										{scrubEpsteinSourceLabels(al.rationale)}
									</p>

									{al.evidence.length > 0 ? (
										<div className="flex flex-wrap gap-1.5">
											{al.evidence.slice(0, 5).map((ev, idx) => (
												<span
													key={idx}
													className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 text-[10px] opacity-85"
												>
													<strong>{formatSourceCorpusLabel(ev.corpus)}</strong>:{' '}
													{scrubEpsteinSourceLabels(ev.label)}
													{ev.date ? ` (${ev.date})` : ''}
												</span>
											))}
										</div>
									) : null}
								</div>
							))}
						</div>
					)}
				</section>
			) : (
				<div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[360px_1fr]">
					{/* Left Sidebar: tracks detail column; lg:h-0 lg:min-h-full keeps list from inflating the row; scrolls inside */}
					<aside className="flex min-h-0 min-w-0 flex-col self-stretch overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] lg:h-0 lg:min-h-full">
						<div className="shrink-0 space-y-2 border-b border-[var(--app-border)] p-3">
							<div className="flex items-start gap-2">
								<input
									value={query}
									onChange={(e) => {
										setQuery(e.target.value);
										setOffset(0);
									}}
									placeholder="Search name, alias, CRD, ticker, topic…"
									className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs"
								/>
								<div ref={countryBoxRef} className="relative w-[42%] min-w-[7.5rem] shrink-0">
									{countryCode ? (
										<div className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1">
											{/* eslint-disable-next-line @next/next/no-img-element */}
											<img
												src={`/flags/4x3/${encodeURIComponent(countryCode)}.svg`}
												alt={getFlagLabel(countryCode)}
												title={getFlagLabel(countryCode)}
												className="h-3.5 w-[18px] rounded-[2px] border border-black/15 object-cover dark:border-white/15"
											/>
											<span className="min-w-0 flex-1 truncate text-[11px]">
												{countryOptions.find((o) => o.code === countryCode)?.name ||
													getFlagLabel(countryCode)}
											</span>
											<button
												type="button"
												aria-label="Clear country filter"
												onClick={() => {
													setCountryCode('');
													setCountryQuery('');
													setOffset(0);
													setCountryMenuOpen(false);
												}}
												className="cursor-pointer rounded border-0 bg-transparent px-1 text-[11px] opacity-70 hover:opacity-100"
											>
												✕
											</button>
										</div>
									) : (
										<input
											value={countryQuery}
											onChange={(e) => {
												setCountryQuery(e.target.value);
												setCountryMenuOpen(true);
											}}
											onFocus={() => setCountryMenuOpen(true)}
											placeholder="Flag / country…"
											className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs"
											autoComplete="off"
										/>
									)}
									{countryMenuOpen && !countryCode ? (
										<ul className="absolute right-0 z-30 mt-1 max-h-56 w-[16rem] overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] py-1 shadow-lg">
											{(countryQuery.trim()
												? countryOptions.filter((o) => {
														const q = countryQuery.trim().toLowerCase();
														return (
															o.name.toLowerCase().includes(q) ||
															o.code.includes(q) ||
															getFlagLabel(o.code).toLowerCase().includes(q)
														);
													})
												: countryOptions
											)
												.slice(0, 40)
												.map((o) => (
													<li key={o.code}>
														<button
															type="button"
															onClick={() => {
																setCountryCode(o.code);
																setCountryQuery(o.name);
																setCountryMenuOpen(false);
																setOffset(0);
															}}
															className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-xs hover:bg-[var(--app-surface-hover)]"
														>
															{/* eslint-disable-next-line @next/next/no-img-element */}
															<img
																src={`/flags/4x3/${encodeURIComponent(o.code)}.svg`}
																alt=""
																className="h-3.5 w-[18px] rounded-[2px] border border-black/15 object-cover dark:border-white/15"
															/>
															<span className="min-w-0 flex-1 truncate">{o.name}</span>
															<span className="shrink-0 text-[10px] uppercase opacity-50">
																{o.code}
															</span>
														</button>
													</li>
												))}
											{(countryQuery.trim()
												? countryOptions.filter((o) => {
														const q = countryQuery.trim().toLowerCase();
														return (
															o.name.toLowerCase().includes(q) ||
															o.code.includes(q) ||
															getFlagLabel(o.code).toLowerCase().includes(q)
														);
													})
												: countryOptions
											).length === 0 ? (
												<li className="px-2.5 py-2 text-[11px] opacity-60">No matches</li>
											) : null}
										</ul>
									) : null}
								</div>
							</div>
							<div className="flex items-center justify-between text-[11px] opacity-70">
								<span>
									{loadingList ? 'Searching…' : `${totalProfiles.toLocaleString()} matching`}
								</span>
								<div className="flex gap-1.5">
									<button
										type="button"
										disabled={offset === 0}
										onClick={() => setOffset((o) => Math.max(0, o - 60))}
										className="cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-[10px] disabled:opacity-40"
									>
										Prev
									</button>
									<button
										type="button"
										disabled={offset + 60 >= totalProfiles}
										onClick={() => setOffset((o) => o + 60)}
										className="cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-[10px] disabled:opacity-40"
									>
										Next
									</button>
								</div>
							</div>
						</div>

						<div className="min-h-0 flex-1 divide-y divide-[var(--app-border)] overflow-y-auto">
							{(() => {
								// Ensure the currently selected entity is always visible & selectable in the left column
								const detailMatchesFilter =
									detail?.profile &&
									(detail.profile.id === selectedId || detail.profile.slug === selectedId) &&
									(typeFilter === 'all' ||
										typeFilter === HISTORY_FILTER ||
										typeFilter === detail.profile.profileType ||
										(typeFilter === 'actors' && detail.profile.profileType !== 'historic_event') ||
										(typeFilter === 'narratives' && detail.profile.profileType === 'historic_event'));
								const alreadyInList =
									detail?.profile && profiles.some((p) => p.id === detail.profile.id);
								const pinnedDetailItem: Profile | null =
									detailMatchesFilter && !alreadyInList && detail
										? {
												...detail.profile,
												aliasCount: detail.counts.aliases,
												linkCount: detail.counts.links,
												timelineCount: detail.counts.timelineEntries,
												alignmentCount: detail.counts.alignments,
												categoryTags: detail.categoryTags,
												corpora: Array.isArray(detail.profile.metadata?.corpora)
													? (detail.profile.metadata.corpora as unknown[]).map(String)
													: [],
											}
										: null;
								const visibleProfiles = pinnedDetailItem ? [pinnedDetailItem, ...profiles] : profiles;

								if (visibleProfiles.length === 0 && !loadingList) {
									return (
										<div className="p-4 text-xs opacity-70">
											{typeFilter === HISTORY_FILTER ? (
												<>
													No viewing history yet. Open any profile and it will show up here (kept in this
													browser, up to {HISTORY_LIMIT}).
												</>
											) : (
												<>
													No profiles yet. Click <strong>Sync &amp; Align All Data</strong> above to
													populate from all local corpora.
												</>
											)}
										</div>
									);
								}

								return visibleProfiles.map((p) => {
									const active =
										p.id === selectedId ||
										p.slug === selectedId ||
										(detail?.profile?.id != null && p.id === detail.profile.id);
									const tm = TYPE_META[p.profileType];
									const current = isCurrentPersonOrFirm(p);
									const rowTone = current
										? active
											? CURRENT_ACTOR_ROW_ACTIVE
											: CURRENT_ACTOR_ROW
										: active
											? 'border-l-2 border-l-[#F97316] bg-[#F97316]/14'
											: 'bg-transparent hover:bg-[var(--app-surface-hover)]';
									const badgeTone = current ? CURRENT_ACTOR_BADGE : tm.badge;
									return (
										<button
											key={p.id}
											ref={active ? selectedRowRef : undefined}
											type="button"
											onClick={() => {
												setSelectedId(p.slug || p.id);
												setLastEnrichReport(null);
											}}
											className={`w-full cursor-pointer border-0 border-b border-b-[var(--app-border)] px-3 py-2.5 text-left transition last:border-b-0 ${rowTone}`}
										>
											{typeFilter === 'all' ||
											typeFilter === 'actors' ||
											typeFilter === HISTORY_FILTER ? (
												<>
													<div className="flex items-center gap-2">
														<span
															className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badgeTone}`}
														>
															{tm.label}
														</span>
													</div>
													<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold leading-snug">
														<span>{p.name}</span>
														<CountryFlags codes={p.countryCodes} size="sm" />
													</div>
												</>
											) : (
												<div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold leading-snug">
													<span>{p.name}</span>
													<CountryFlags codes={p.countryCodes} size="sm" />
												</div>
											)}
											{p.profileType === 'person' && p.alternateNames && p.alternateNames.length > 0 ? (
												<div className="mt-0.5 truncate text-[10px] italic opacity-70">
													{p.alternateNames.join(' · ')}
												</div>
											) : null}
										</button>
									);
								});
							})()}
						</div>
					</aside>

					{/* Right Workspace: fills the flex-1 grid cell (min-h-full) so short dossiers still reach the viewport bottom */}
					<section
						className={`min-h-full min-w-0 rounded-lg border bg-[var(--app-surface)] p-4 ${
							detail && isCurrentPersonOrFirm(detail.profile)
								? CURRENT_ACTOR_DETAIL_OUTLINE
								: 'border-[var(--app-border)]'
						}`}
					>
						{loadingDetail && !detail ? (
							<p className="text-xs opacity-70">Loading profile…</p>
						) : !detail ? (
							<p className="text-xs opacity-70">Select a profile on the left to inspect its dossier, timeline gaps, and alignments.</p>
						) : (
							<div>
								{/* Profile Header */}
								<div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--app-border)] pb-3">
									<div>
										<div className="flex flex-wrap items-center gap-1.5">
											<span
												className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${TYPE_META[detail.profile.profileType].badge}`}
											>
												{TYPE_META[detail.profile.profileType].label}
											</span>
											<code className="rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px] opacity-75">
												{detail.profile.slug}
											</code>
											{detail.profile.startDate ? (
												<span className="text-[11px] opacity-70">
													{formatDisplayDate(detail.profile.startDate)}
													{detail.profile.endDate
														? ` → ${formatDisplayDate(detail.profile.endDate)}`
														: ''}
												</span>
											) : null}
										</div>
										{(() => {
											const isPerson = detail.profile.profileType === 'person';
											const meta = detail.profile.metadata || {};

											// Current employment / active organization affiliation(s) to display right of person's name
											const isFaculty = (r?: string | null) =>
												/\b(?:professor|faculty|dean|chancellor|lecturer|instructor|researcher|provost|teacher)\b/i.test(
													r || '',
												);
											const nonAlumniWork = isPerson
												? detail.employmentHistory.filter(
														(e) => !(e.orgCategory === 'education' && !isFaculty(e.role)),
													)
												: [];
											const explicitCurrent = nonAlumniWork.filter((e) => e.isCurrent === true);
											const activeOrgs =
												explicitCurrent.length > 0
													? explicitCurrent.slice(0, 2)
													: nonAlumniWork.filter((e) => e.isCurrent !== false && !e.endDate).slice(0, 2);

											const fallbackTitle =
												isPerson && activeOrgs.length === 0
													? typeof meta.title === 'string' && meta.title.trim()
														? meta.title.trim()
														: Array.isArray(meta.officesHeld) && meta.officesHeld[0]
															? String(meta.officesHeld[0]).trim()
															: null
													: null;

											// Alternate / full name variation(s) underneath the name
											const canonicalLow = detail.profile.name.trim().toLowerCase().replace(/\s+/g, ' ');
											const seenAlt = new Set<string>([canonicalLow]);
											const altNames = detail.aliases
												.filter((a) => a.aliasKind === 'name' || a.aliasKind === 'former_name')
												.map((a) => a.alias.replace(/[\[\]]+/g, '').replace(/\s+/g, ' ').trim())
												.filter((raw) => {
													const low = raw.toLowerCase().replace(/\s+/g, ' ');
													if (!low || seenAlt.has(low)) return false;
													seenAlt.add(low);
													return true;
												})
												.sort((a, b) => b.length - a.length)
												.slice(0, 2);

											return (
												<>
													<h2 className="mt-1.5 mb-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg font-semibold">
														<span className="inline-flex items-center gap-2">
															<span>{detail.profile.name}</span>
															<CountryFlags codes={detail.profile.countryCodes} size="md" />
														</span>
														{activeOrgs.length > 0 ? (
															<span className="text-xs font-normal opacity-80">
																—{' '}
																{activeOrgs.map((org, idx) => (
																	<span key={org.id}>
																		{idx > 0 ? ' · ' : ''}
																		{org.role ? <span>{org.role}, </span> : null}
																		{org.orgProfileId ? (
																			<button
																				type="button"
																				onClick={() => jumpToProfile(org.orgProfileId!)}
																				className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline"
																			>
																				{org.orgName}
																			</button>
																		) : (
																			<span className="font-semibold">{org.orgName}</span>
																		)}
																	</span>
																))}
															</span>
														) : fallbackTitle ? (
															<span className="text-xs font-normal opacity-80">— {fallbackTitle}</span>
														) : null}
													</h2>
													{altNames.length > 0 ? (
														<div className="mb-1.5 text-xs italic opacity-75">
															{altNames.join(' · ')}
														</div>
													) : (
														<div className="mb-1" />
													)}
												</>
											);
										})()}
										{detail.profile.primaryLocation ? (
											<div className="mb-1.5 text-xs opacity-80">
												📍 <strong>{detail.profile.primaryLocation}</strong>
												{detail.locations.length > 1
													? ` (+${detail.locations.length - 1} more location${detail.locations.length === 2 ? '' : 's'})`
													: ''}
											</div>
										) : null}
										{detail.profile.summary ? <ProfileSummaryText text={detail.profile.summary} /> : null}
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<button
											type="button"
											disabled={enriching}
											onClick={() => void handleEnrichProfile()}
											title="Search local offline Wikipedia, BrokerCheck (if CRD), county deeds, and UCC filings. Only merges validated matches (identifier or name/initials + address, firm, military base, or institution); name-only matches are held as review notes."
											className="cursor-pointer rounded-md border border-[#F97316]/50 bg-[#F97316]/15 px-2.5 py-1.5 text-xs font-semibold text-[#F97316] hover:bg-[#F97316]/25 disabled:opacity-50"
										>
											{enriching ? 'Researching…' : 'Research & Fill Details'}
										</button>
									</div>
								</div>
								{lastEnrichReport && lastEnrichReport.profileId === detail.profile.id ? (
									<div className="mt-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 text-xs">
										<div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
											<span>
												Enrichment results ({lastEnrichReport.durationMs}ms):{' '}
												{lastEnrichReport.validatedSources} validated ·{' '}
												{lastEnrichReport.heldNameOnlyNotes} name-only note(s) held back
											</span>
											<button
												type="button"
												onClick={() => setLastEnrichReport(null)}
												className="cursor-pointer border-0 bg-transparent text-[11px] opacity-65 hover:opacity-100"
											>
												Dismiss
											</button>
										</div>
										<div className="mt-1.5 space-y-1">
											{lastEnrichReport.outcomes.map((o, idx) => (
												<div key={idx} className="flex flex-wrap items-center gap-1.5 text-[11px]">
													<span className="rounded bg-[var(--app-surface)] px-1.5 py-0.5 font-mono text-[10px]">
														{o.source}
													</span>
													<span
														className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
															o.status === 'merged'
																? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
																: o.status === 'name_only_note'
																	? 'bg-amber-500/15 text-amber-900 dark:text-amber-200'
																	: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300'
														}`}
													>
														{o.status === 'name_only_note' ? 'held: name-only note' : o.status}
													</span>
													{o.candidateTitle ? <span className="font-medium">{o.candidateTitle}</span> : null}
													{o.note ? <span className="opacity-75">— {o.note}</span> : null}
												</div>
											))}
										</div>
									</div>
								) : null}

								{/* Tabs — omit zero-count Timeline / Alignments */}
								<div className="mt-3 mb-4 flex flex-wrap gap-2 border-b border-[var(--app-border)] pb-2">
									{(
										[
											{
												id: 'overview' as const,
												label: `Overview & Links (${detail.counts.links})`,
												show: true,
											},
											{
												id: 'timeline' as const,
												label: `Timeline & Gap Analysis (${detail.counts.timelineEntries})`,
												show: detail.counts.timelineEntries > 0,
											},
											{
												id: 'alignments' as const,
												label: `Possible Alignments (${detail.counts.alignments})`,
												show: detail.counts.alignments > 0,
											},
										] as const
									)
										.filter((t) => t.show)
										.map((t) => (
											<button
												key={t.id}
												type="button"
												onClick={() => setProfileTab(t.id)}
												className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs font-semibold ${
													profileTab === t.id
														? 'border-[#F97316] bg-[#F97316] text-white'
														: 'border-[var(--app-border)] bg-[var(--app-bg)] hover:bg-[var(--app-surface-hover)]'
												}`}
											>
												{t.label}
											</button>
										))}
								</div>

								{/* TAB 1: Overview & Links */}
								{profileTab === 'overview' ? (
									<div className="space-y-4">
										{(() => {
											const meta = detail.profile.metadata || {};
											const detailRows = ENRICHED_DETAIL_FIELDS.map(({ key, label }) => {
												// Net worth / unstructured family / political party hidden from UI.
												if (
													key === 'netWorth' ||
													key === 'familyAndRelatives' ||
													key === 'politicalParty'
												)
													return null;
												const raw = meta[key];
												if (raw == null || raw === '') return null;
												const text = Array.isArray(raw)
													? raw.map(String).filter(Boolean).join(' · ')
													: String(raw).trim();
												if (!text) return null;
												return { key, label, text };
											}).filter((x): x is { key: string; label: string; text: string } => x !== null);
											const militaryRows = detailRows.filter((r) => MILITARY_DETAIL_KEYS.has(r.key));
											const knownForRow = detailRows.find((r) => r.key === 'knownFor') || null;
											const notableWorksRow = detailRows.find((r) => r.key === 'notableWorks') || null;
											const titleRow = detailRows.find((r) => r.key === 'title') || null;
											const occupationRow = detailRows.find((r) => r.key === 'occupation') || null;
											const titleOccupationRow =
												titleRow || occupationRow
													? {
															key: 'titleOccupation',
															title: titleRow?.text || null,
															occupation: occupationRow?.text || null,
														}
													: null;
											const highlightParts = [knownForRow?.text, notableWorksRow?.text].filter(Boolean) as string[];
											const highlightRow =
												highlightParts.length > 0
													? {
															key: 'knownForNotableWorks',
															label:
																knownForRow && notableWorksRow
																	? 'Known For / Notable Works'
																	: knownForRow
																		? 'Known For'
																		: 'Notable Works',
															text: highlightParts.join(' · '),
														}
													: null;
											// Family only when linked profiles exist (clickable names) — never bare Wikipedia prose.
											const familyPeers = detail.links
												.map((l) => {
													const outbound = l.fromProfileId === detail.profile.id;
													const peerId = outbound ? l.toProfileId : l.fromProfileId;
													const peerName = outbound ? l.toName : l.fromName;
													const peerType = outbound ? l.toType : l.fromType;
													if (l.relationType !== 'family_or_associate') return null;
													if (peerType && peerType !== 'person') return null;
													if (!peerId || !peerName) return null;
													return {
														id: peerId,
														name: peerName,
														role: l.roleLabel || null,
													};
												})
												.filter(
													(x): x is { id: string; name: string; role: string | null } => x !== null,
												)
												.filter(
													(peer, i, arr) => arr.findIndex((p) => p.id === peer.id) === i,
												);
											const occupationOrgPeers = detail.links
												.map((l) => {
													if (!OCCUPATION_LINK_RELATIONS.has(l.relationType)) return null;
													const outbound = l.fromProfileId === detail.profile.id;
													const peerId = outbound ? l.toProfileId : l.fromProfileId;
													const peerName = outbound ? l.toName : l.fromName;
													const peerType = outbound ? l.toType : l.fromType;
													if (!peerId || !peerName) return null;
													if (
														peerType &&
														peerType !== 'firm' &&
														peerType !== 'nonprofit' &&
														peerType !== 'education' &&
														peerType !== 'medical_hospital' &&
														peerType !== 'government'
													) {
														return null;
													}
													return { id: peerId, name: peerName };
												})
												.filter((x): x is OccupationOrgPeer => x !== null)
												.filter(
													(peer, i, arr) => arr.findIndex((p) => p.id === peer.id) === i,
												);
											const generalRows = detailRows.filter(
												(r) =>
													!MILITARY_DETAIL_KEYS.has(r.key) &&
													r.key !== 'knownFor' &&
													r.key !== 'notableWorks' &&
													r.key !== 'title' &&
													r.key !== 'occupation',
											);
											// identifyingKeywords / citizenship / netWorth / familyAndRelatives stay in metadata
											// FINRA/SEC/Wikipedia deep links live in the Sources & Identifiers card below.
											if (
												!generalRows.length &&
												!militaryRows.length &&
												!highlightRow &&
												!titleOccupationRow &&
												!familyPeers.length
											) {
												return null;
											}
											return (
												<div className="space-y-3">
													{generalRows.length > 0 ||
													highlightRow ||
													titleOccupationRow ||
													familyPeers.length > 0 ? (
														(() => {
															const compactRows = generalRows.filter(
																(r) => !isFullWidthDetailCard(r.key, r.text),
															);
															const wideRows = generalRows.filter((r) =>
																isFullWidthDetailCard(r.key, r.text),
															);
															return (
																<div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
																	{titleOccupationRow ? (
																		<div
																			className={`col-span-full rounded border px-2.5 py-2 ${enrichedDetailCardClass('title')}`}
																		>
																			{titleOccupationRow.title ? (
																				<div>
																					<div className="text-[10px] font-semibold uppercase opacity-65">
																						Title
																					</div>
																					<div className="mt-0.5 break-words leading-snug">
																						{titleOccupationRow.title}
																					</div>
																				</div>
																			) : null}
																			{titleOccupationRow.occupation ? (
																				<div className={titleOccupationRow.title ? 'mt-2' : undefined}>
																					<div className="text-[10px] font-semibold uppercase opacity-65">
																						Occupation
																					</div>
																					<div className="mt-0.5 break-words leading-snug">
																						{renderClickableOccupation(
																							titleOccupationRow.occupation,
																							occupationOrgPeers,
																							jumpToProfile,
																						)}
																					</div>
																				</div>
																			) : null}
																		</div>
																	) : null}
																	{compactRows.map((row) => (
																		<div
																			key={row.key}
																			className={`rounded border px-2.5 py-1.5 ${enrichedDetailCardClass(row.key)}`}
																		>
																			<div className="text-[10px] font-semibold uppercase opacity-65">
																				{row.label}
																			</div>
																			<div className="mt-0.5 break-words leading-snug">{row.text}</div>
																		</div>
																	))}
																	{wideRows.map((row) => (
																		<div
																			key={row.key}
																			className={`col-span-full rounded border px-2.5 py-2 ${enrichedDetailCardClass(row.key)}`}
																		>
																			<div className="text-[10px] font-semibold uppercase opacity-65">
																				{row.label}
																			</div>
																			<div className="mt-0.5 break-words leading-snug">{row.text}</div>
																		</div>
																	))}
																	{familyPeers.length > 0 ? (
																		<div
																			className={`col-span-full rounded border px-2.5 py-2 ${enrichedDetailCardClass('familyAndRelatives')}`}
																		>
																			<div className="text-[10px] font-semibold uppercase opacity-65">
																				Family / Relatives
																			</div>
																			<div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 leading-snug">
																				{familyPeers.map((peer) => (
																					<span
																						key={peer.id}
																						className="inline-flex flex-wrap items-baseline gap-1"
																					>
																						<button
																							type="button"
																							onClick={() => jumpToProfile(peer.id)}
																							className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-[#F97316] underline"
																						>
																							{peer.name}
																						</button>
																						{peer.role ? (
																							<span className="text-[10px] opacity-70">({peer.role})</span>
																						) : null}
																					</span>
																				))}
																			</div>
																		</div>
																	) : null}
																	{highlightRow ? (
																		<div
																			key={highlightRow.key}
																			className={`col-span-full rounded border px-2.5 py-2 ${enrichedDetailCardClass('knownFor')}`}
																		>
																			<div className="text-[10px] font-semibold uppercase opacity-65">
																				{highlightRow.label}
																			</div>
																			<div className="mt-0.5 break-words leading-snug">
																				{highlightRow.text}
																			</div>
																		</div>
																	) : null}
																</div>
															);
														})()
													) : null}

													{militaryRows.length > 0 ? (
														<div className="rounded-lg border border-emerald-700/45 bg-gradient-to-br from-emerald-950/50 via-slate-900/40 to-emerald-900/30 p-4 shadow-sm">
															<div className="mb-2.5 flex flex-wrap items-center gap-2">
																<span className="rounded bg-emerald-600/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-200">
																	Military Service
																</span>
																<span className="text-[10px] opacity-60">
																	{militaryRows.length} field{militaryRows.length === 1 ? '' : 's'}
																</span>
															</div>
															<div className="grid gap-2.5 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
																{militaryRows.map((row) => (
																	<div
																		key={row.key}
																		className={`rounded-md border px-3 py-2.5 ${
																			row.key === 'battlesWars' || row.key === 'militaryCommands'
																				? 'sm:col-span-2 lg:col-span-3'
																				: ''
																		} border-emerald-600/35 bg-emerald-950/40`}
																	>
																		<div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
																			{row.label}
																		</div>
																		<div className="mt-1 break-words leading-snug text-emerald-50">
																			{row.text}
																		</div>
																	</div>
																))}
															</div>
														</div>
													) : null}
												</div>
											);
										})()}
										{(() => {
											const meta = detail.profile.metadata || {};
											const finraCrd = resolveProfileFinraCrd(
												detail.profile.profileType,
												meta,
												detail.identifiers,
											);
											const finraLinks =
												finraCrd &&
												(detail.profile.profileType === 'person' ||
													detail.profile.profileType === 'firm')
													? finraSecSourceLinks({
															profileType: detail.profile.profileType,
															crd: finraCrd,
															iaScope: meta.finraIaScope,
														})
													: [];
											const wikiUrl =
												typeof meta.wikipediaUrl === 'string'
													? meta.wikipediaUrl.trim().toLowerCase()
													: '';
											const normalizeHref = (raw: string) => {
												const t = String(raw || '').trim();
												if (!t) return '';
												const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
												try {
													const u = new URL(withProto);
													u.hash = '';
													return u.toString().replace(/\/$/, '').toLowerCase();
												} catch {
													return t.toLowerCase();
												}
											};
											const wikiNorm = wikiUrl ? normalizeHref(wikiUrl) : '';
											// Drop finra_crd list rows when the Firm/Individual CRD badge already shows it.
											const publicIds = detail.identifiers.filter((idItem) => {
												const scheme = String(idItem.scheme || '').toLowerCase();
												if (!PUBLIC_IDENTIFIER_SCHEMES.has(scheme)) return false;
												if (isHiddenEpsteinSourceIdentifier(idItem.scheme, idItem.value)) {
													return false;
												}
												if (finraCrd && scheme === 'finra_crd') {
													const v = String(idItem.value || '').trim();
													if (v === finraCrd) return false;
												}
												return true;
											});
											const sourceLabels = collectProfileSourceLabels(detail.identifiers);
											// Drop URL chips already covered by the Wikipedia meta link.
											const urlIds = detail.identifiers.filter((idItem) => {
												if (String(idItem.scheme || '').toLowerCase() !== 'url') return false;
												if (isHiddenEpsteinSourceIdentifier(idItem.scheme, idItem.value)) {
													return false;
												}
												const href = String(idItem.value || '').trim();
												if (!href) return false;
												if (wikiNorm && normalizeHref(href) === wikiNorm) return false;
												return true;
											});
											const hasRegistryLinks =
												finraLinks.length > 0 ||
												typeof meta.finraVisualizerUrl === 'string' ||
												typeof meta.wikipediaUrl === 'string';
											const showAliases = detail.aliases.length > 0;
											const hasSicMeta =
												(meta.sic != null && String(meta.sic).trim() !== '') ||
												(typeof meta.sicDescription === 'string' &&
													meta.sicDescription.trim() !== '');
											const showCombinedSources =
												publicIds.length > 0 ||
												sourceLabels.length > 0 ||
												urlIds.length > 0 ||
												hasRegistryLinks ||
												Boolean(finraCrd) ||
												hasSicMeta;
											const showLocations = detail.locations.length > 0;
											if (!showAliases && !showCombinedSources && !showLocations) return null;
											const cardCount =
												Number(showAliases) + Number(showCombinedSources) + Number(showLocations);
											const gridCols =
												cardCount >= 3
													? 'md:grid-cols-3'
													: cardCount === 2
														? 'md:grid-cols-2'
														: 'md:grid-cols-1';
											return (
												<div className={`grid gap-3 ${gridCols}`}>
													{showAliases ? (
														<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
															<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																Aliases ({detail.aliases.length})
															</h3>
															<div className="mb-2 flex flex-wrap gap-1">
																{detail.aliases.slice(0, 16).map((a) => (
																	<span
																		key={a.id}
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-0.5 text-[11px]"
																	>
																		{a.alias}
																	</span>
																))}
															</div>
															<div className="flex gap-1">
																<input
																	value={aliasDraft}
																	onChange={(e) => setAliasDraft(e.target.value)}
																	placeholder="Add alias…"
																	className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-[11px]"
																/>
																<button
																	type="button"
																	onClick={() => void handleAddAlias()}
																	className="cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold"
																>
																	Add
																</button>
															</div>
														</div>
													) : null}

													{showCombinedSources ? (
														<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
															<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																Sources &amp; Identifiers
																{publicIds.length > 0 ? ` (${publicIds.length})` : ''}
															</h3>
															{hasRegistryLinks || finraCrd ? (
																<div className="mb-2 flex flex-wrap items-center gap-2.5">
																	{finraCrd ? (
																		<span className="rounded border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-800 dark:text-sky-200">
																			{detail.profile.profileType === 'firm'
																				? 'Firm CRD'
																				: 'Individual CRD'}{' '}
																			{finraCrd}
																		</span>
																	) : null}
																	{finraLinks.map((link) => (
																		<a
																			key={link.href}
																			href={link.href}
																			target="_blank"
																			rel="noreferrer"
																			className={link.className}
																		>
																			{link.label}
																		</a>
																	))}
																	{typeof meta.finraVisualizerUrl === 'string' ? (
																		<a
																			href={meta.finraVisualizerUrl}
																			target="_blank"
																			rel="noreferrer"
																			className="text-[11px] font-semibold text-[#F97316] underline"
																		>
																			FINRA Visualizer ↗
																		</a>
																	) : null}
																	{typeof meta.wikipediaUrl === 'string' ? (
																		<a
																			href={meta.wikipediaUrl}
																			target="_blank"
																			rel="noreferrer"
																			className="text-[11px] font-semibold text-[#F97316] underline"
																		>
																			Wikipedia ↗
																		</a>
																	) : null}
																</div>
															) : null}
															{publicIds.length > 0 ||
															meta.sic != null ||
															meta.sicDescription != null ? (
																<ul className="m-0 list-none space-y-1 p-0 text-[11px]">
																	{publicIds.map((idItem) => {
																		const scheme = String(idItem.scheme || '').toLowerCase();
																		const label =
																			IDENTIFIER_SCHEME_LABELS[scheme] ||
																			scheme.replace(/_/g, ' ');
																		let display = scrubEpsteinSourceLabels(idItem.value);
																		if (
																			scheme === 'ticker' &&
																			typeof meta.exchange === 'string' &&
																			meta.exchange.trim()
																		) {
																			display = `${display} (${meta.exchange.trim()})`;
																		}
																		return (
																			<li key={idItem.id}>
																				<span className="opacity-70">{label}:</span>{' '}
																				<strong>{display}</strong>
																			</li>
																		);
																	})}
																	{meta.sic != null && String(meta.sic).trim() ? (
																		<li key="meta-sic">
																			<span className="opacity-70">SIC:</span>{' '}
																			<strong>
																				{String(meta.sic).trim()}
																				{typeof meta.sicDescription === 'string' &&
																				meta.sicDescription.trim()
																					? ` (${meta.sicDescription.trim()})`
																					: ''}
																			</strong>
																		</li>
																	) : null}
																</ul>
															) : null}
															{sourceLabels.length > 0 || urlIds.length > 0 ? (
																(() => {
																	const coveredLabels = new Set<string>(
																		urlIds
																			.map((idItem) =>
																				sourceLabelFromUrl(String(idItem.value || '')),
																			)
																			.filter(Boolean) as string[],
																	);
																	// Meta Wikipedia / FINRA chips already cover these labels.
																	if (wikiNorm) coveredLabels.add('wikipedia');
																	if (typeof meta.finraVisualizerUrl === 'string') {
																		coveredLabels.add('finra');
																	}
																	if (finraLinks.length > 0) {
																		coveredLabels.add('finra');
																		coveredLabels.add('sec');
																	}
																	const extraLabels = sourceLabels.filter(
																		(label) => !coveredLabels.has(label),
																	);
																	return (
																		<div
																			className={`text-[11px] leading-relaxed ${
																				publicIds.length > 0 ||
																				hasRegistryLinks ||
																				finraCrd
																					? 'mt-2 border-t border-[var(--app-border)] pt-2'
																					: ''
																			}`}
																		>
																			{extraLabels.length > 0 ? (
																				<p className="m-0">
																					<span className="opacity-70">Sources:</span>{' '}
																					{extraLabels.join(', ')}
																				</p>
																			) : null}
																			{urlIds.length > 0 ? (
																				<ul
																					className={`m-0 list-none space-y-1 p-0 ${
																						extraLabels.length > 0 ? 'mt-1.5' : ''
																					}`}
																				>
																					{urlIds.slice(0, 8).map((idItem) => {
																						const href = String(idItem.value || '').trim();
																						const label =
																							sourceLabelFromUrl(href) ||
																							href.slice(0, 48);
																						const withProto = /^https?:\/\//i.test(href)
																							? href
																							: `https://${href}`;
																						return (
																							<li key={idItem.id}>
																								<a
																									href={withProto}
																									target="_blank"
																									rel="noreferrer"
																									className="font-semibold text-[#F97316] underline"
																								>
																									{label} ↗
																								</a>
																							</li>
																						);
																					})}
																				</ul>
																			) : null}
																		</div>
																	);
																})()
															) : null}
														</div>
													) : null}

													{showLocations ? (
														<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
															<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																Locations ({detail.locations.length})
															</h3>
															<ul className="m-0 mb-2 list-none space-y-1 p-0 text-[11px]">
																{detail.locations.slice(0, 12).map((loc) => (
																	<li key={loc.id}>
																		<span>📍 {loc.raw}</span>{' '}
																		<span className="text-[10px] opacity-60">({loc.role})</span>
																	</li>
																))}
															</ul>
															<div className="flex gap-1">
																<input
																	value={locationDraft}
																	onChange={(e) => setLocationDraft(e.target.value)}
																	placeholder="Add location (e.g. Dallas, TX)…"
																	className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-[11px]"
																/>
																<button
																	type="button"
																	onClick={() => void handleAddLocation()}
																	className="cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold"
																>
																	Add
																</button>
															</div>
														</div>
													) : null}
												</div>
											);
										})()}

										{/* Employment History & Education (Person profiles) */}
										{detail.profile.profileType === 'person'
											? (() => {
													const isFacultyRole = (role?: string | null) =>
														/\b(?:professor|faculty|dean|chancellor|lecturer|instructor|researcher|provost|teacher)\b/i.test(
															role || '',
														);
													const educationEntries = detail.employmentHistory.filter(
														(e) => e.orgCategory === 'education' && !isFacultyRole(e.role),
													);
													const workEntries = detail.employmentHistory.filter(
														(e) => !(e.orgCategory === 'education' && !isFacultyRole(e.role)),
													);

													const currentWork = workEntries.filter((e) => e.isCurrent === true);
													const previousWork = workEntries.filter((e) => e.isCurrent !== true);

													const renderWorkRow = (emp: (typeof workEntries)[number]) => {
														const span = formatEmploymentDateSpan(emp.startDate, emp.endDate, emp.isCurrent);
														const cleanRole =
															emp.role &&
															!/^(?:current|previous)\s+registration$/i.test(emp.role.trim())
																? emp.role.trim()
																: null;
														const showFinraScope =
															emp.firmFinraScope && !/^active$/i.test(emp.firmFinraScope.trim())
																? emp.firmFinraScope.charAt(0).toUpperCase() +
																	emp.firmFinraScope.slice(1).toLowerCase()
																: null;
														return (
															<div
																key={emp.id}
																className="rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-xs"
															>
																<div className="flex flex-wrap items-center justify-between gap-2">
																	<div className="flex flex-wrap items-center gap-1.5">
																		{span ? (
																			<span className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
																				{span}
																			</span>
																		) : null}
																		{emp.orgProfileId ? (
																			<button
																				type="button"
																				onClick={() => jumpToProfile(emp.orgProfileId!)}
																				className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline"
																			>
																				{emp.orgName}
																			</button>
																		) : (
																			<span className="font-semibold">{emp.orgName}</span>
																		)}
																		<CountryFlags codes={emp.orgCountryCodes} size="sm" />
																		{emp.firmCrd ? (
																			<span className="rounded bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] opacity-85">
																				CRD# <strong>{emp.firmCrd}</strong>
																			</span>
																		) : null}
																		{emp.secNumber ? (
																			<span className="rounded bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] opacity-85">
																				SEC# <strong>{emp.secNumber}</strong>
																			</span>
																		) : null}
																		{!emp.firmCrd ? (
																			<span
																				className={`rounded border px-1.5 py-0.2 text-[10px] font-semibold ${TYPE_META[emp.orgCategory].badge}`}
																			>
																				{TYPE_META[emp.orgCategory].label}
																			</span>
																		) : null}
																		{cleanRole ? (
																			<span className="text-[11px] opacity-85">— {cleanRole}</span>
																		) : null}
																	</div>
																	<div className="flex flex-wrap items-center gap-1.5 text-[10px]">
																		{emp.isCurrent === true ? (
																			<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-800 dark:text-emerald-200">
																				Current
																			</span>
																		) : emp.isCurrent === false ? (
																			<span className="rounded bg-zinc-500/15 px-1.5 py-0.5 font-semibold opacity-75">
																				Old
																			</span>
																		) : null}

																	</div>
																</div>
																{emp.location || emp.iaOnly || showFinraScope ? (
																	<div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] opacity-75">
																		{emp.location ? <span>📍 {emp.location}</span> : null}
																		{emp.iaOnly ? (
																			<span className="rounded bg-emerald-500/12 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
																				IA only
																			</span>
																		) : null}
																		{showFinraScope ? (
																			<span className="text-[10px] opacity-85">
																				Firm FINRA: {showFinraScope}
																			</span>
																		) : null}
																	</div>
																) : null}
															</div>
														);
													};

													return (
														<>
															{/* Employment History — hidden when empty */}
															{workEntries.length > 0 ? (
															<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
																<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																	Employment History ({workEntries.length})
																</h3>
																<div className="mb-3 space-y-3">
																	{currentWork.length > 0 ? (
																		<div>
																			<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
																				Current Employment ({currentWork.length})
																			</div>
																			<div className="space-y-1.5">{currentWork.map(renderWorkRow)}</div>
																		</div>
																	) : null}
																	{previousWork.length > 0 ? (
																		<div>
																			<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-70">
																				Previous Employment ({previousWork.length})
																			</div>
																			<div className="max-h-[460px] space-y-1.5 overflow-y-auto pr-1">
																				{previousWork.map(renderWorkRow)}
																			</div>
																		</div>
																	) : null}
																</div>

																<form
																	onSubmit={(e) => void handleAddEmployment(e)}
																	className="grid gap-2 border-t border-[var(--app-border)] pt-2.5 sm:grid-cols-6"
																>
																	<input
																		required
																		value={empOrgName}
																		onChange={(e) => setEmpOrgName(e.target.value)}
																		placeholder="Employer / School *"
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-2"
																	/>
																	<select
																		value={empOrgCategory}
																		onChange={(e) => setEmpOrgCategory(e.target.value as ProfileType)}
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
																	>
																		{EMPLOYER_CATEGORY_TYPES.map((t) => (
																			<option key={t} value={t}>
																				{TYPE_META[t].label}
																			</option>
																		))}
																	</select>
																	<input
																		value={empRole}
																		onChange={(e) => setEmpRole(e.target.value)}
																		placeholder="Role / Degree"
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
																	/>
																	<input
																		value={empLocation}
																		onChange={(e) => setEmpLocation(e.target.value)}
																		placeholder="Location"
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
																	/>
																	<div className="flex gap-1">
																		<input
																			value={empStart}
																			onChange={(e) => setEmpStart(e.target.value)}
																			placeholder="From"
																			className="w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs"
																		/>
																		<input
																			value={empEnd}
																			onChange={(e) => setEmpEnd(e.target.value)}
																			placeholder="To"
																			className="w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs"
																		/>
																	</div>
																	<div className="flex justify-end sm:col-span-6">
																		<button
																			type="submit"
																			disabled={savingEmp}
																			className="cursor-pointer rounded border-none bg-[#F97316] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
																		>
																			{savingEmp ? 'Adding…' : '+ Add Entry'}
																		</button>
																	</div>
																</form>
															</div>
															) : null}

															{/* Education — hidden when empty */}
															{educationEntries.length > 0 ? (
															<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
																<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																	Education ({educationEntries.length})
																</h3>
																<div className="space-y-1.5">
																	{educationEntries.map((edu) => {
																		const span = formatDateSpan(
																			edu.startDate,
																			edu.endDate,
																			edu.isCurrent,
																			true,
																		);
																		return (
																			<div
																				key={edu.id}
																				className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-xs"
																			>
																				<div className="flex flex-wrap items-center gap-1.5">
																					{span ? (
																						<span className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
																							{span}
																						</span>
																					) : null}
																					{edu.orgProfileId ? (
																						<button
																							type="button"
																							onClick={() => jumpToProfile(edu.orgProfileId!)}
																							className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline"
																						>
																							{edu.orgName}
																						</button>
																					) : (
																						<span className="font-semibold">{edu.orgName}</span>
																					)}
																					<CountryFlags codes={edu.orgCountryCodes} size="sm" />
																					{edu.role ? (
																						<span className="text-[11px] opacity-85">— {edu.role}</span>
																					) : null}
																				</div>
																				<div className="flex flex-wrap items-center gap-2 text-[11px] opacity-75">
																					{edu.location ? <span>📍 {edu.location}</span> : null}
																				</div>
																			</div>
																		);
																	})}
																</div>
															</div>
															) : null}
														</>
													);
												})()
											: null}

										{/* Connected Historic Events (chronological cards) & Connected Profiles */}
										{(() => {
											const empPeerIds = new Set(
												detail.profile.profileType === 'person'
													? detail.employmentHistory
															.map((e) => e.orgProfileId)
															.filter((x): x is string => Boolean(x))
													: [],
											);
											const getConnStatus = (
												l: ProfileDetail['links'][number],
											): 'current' | 'old' | null => {
												const role = (l.roleLabel || '').toLowerCase();
												const note = (l.evidenceNote || '').toLowerCase();
												if (/\bcurrent\b/.test(role) || note.includes('status=current')) return 'current';
												if (
													/\b(?:previous|former|past|old)\b/.test(role) ||
													note.includes('status=previous') ||
													Boolean(l.endDate)
												) {
													return 'old';
												}
												if (
													(l.relationType === 'employed_by' || l.relationType === 'registered_at') &&
													l.startDate &&
													!l.endDate
												) {
													return 'current';
												}
												return null;
											};
											const nonEmpLinks = detail.links.filter((l) => {
												const peerId =
													l.fromProfileId === detail.profile.id ? l.toProfileId : l.fromProfileId;
												return !empPeerIds.has(peerId);
											});

											const historicEventLinks = nonEmpLinks
												.filter((l) => {
													const peerType =
														(l.fromProfileId === detail.profile.id ? l.toType : l.fromType) || 'firm';
													return peerType === 'historic_event';
												})
												.sort((a, b) => {
													const da = a.startDate || a.peerStartDate || a.endDate || a.peerEndDate || '';
													const dbDate = b.startDate || b.peerStartDate || b.endDate || b.peerEndDate || '';
													if (da && !dbDate) return -1;
													if (!da && dbDate) return 1;
													// Newest historic events first on overview.
													if (da !== dbDate) return dbDate.localeCompare(da);
													const na =
														(a.fromProfileId === detail.profile.id ? a.toName : a.fromName) || '';
													const nb =
														(b.fromProfileId === detail.profile.id ? b.toName : b.fromName) || '';
													return na.localeCompare(nb);
												});

											const connectedLinks = nonEmpLinks
												.filter((l) => {
													const peerType =
														(l.fromProfileId === detail.profile.id ? l.toType : l.fromType) || 'firm';
													return peerType !== 'historic_event';
												})
												.map((l) => ({ link: l, connStatus: getConnStatus(l) }))
												.sort((a, b) => {
													const da = a.link.startDate || a.link.endDate || '';
													const dbDate = b.link.startDate || b.link.endDate || '';
													if (da && !dbDate) return -1;
													if (!da && dbDate) return 1;
													if (da !== dbDate) return dbDate.localeCompare(da);
													const rank = (s: 'current' | 'old' | null) =>
														s === 'current' ? 0 : s === 'old' ? 2 : 1;
													const ra = rank(a.connStatus);
													const rb = rank(b.connStatus);
													if (ra !== rb) return ra - rb;
													const na =
														(a.link.fromProfileId === detail.profile.id
															? a.link.toName
															: a.link.fromName) || '';
													const nb =
														(b.link.fromProfileId === detail.profile.id
															? b.link.toName
															: b.link.fromName) || '';
													return na.localeCompare(nb);
												});

											const currentCount = connectedLinks.filter((x) => x.connStatus === 'current').length;
											const oldCount = connectedLinks.filter((x) => x.connStatus === 'old').length;
											const undatedFinraCount =
												detail.profile.profileType === 'firm'
													? connectedLinks.filter(
															(x) => x.link.relationType === 'registered_at' && !x.link.startDate,
														).length
													: 0;
											const filteredLinks =
												connStatusFilter === 'all'
													? connectedLinks
													: connectedLinks.filter((x) => x.connStatus === connStatusFilter);

											if (
												historicEventLinks.length === 0 &&
												connectedLinks.length === 0
											) {
												return null;
											}

											return (
												<div className="space-y-4">
													{historicEventLinks.length > 0 ? (
														<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
															<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																Historic Events ({historicEventLinks.length})
															</h3>
															<div className="space-y-2">
																{historicEventLinks.map((l) => {
																	const isOut = l.fromProfileId === detail.profile.id;
																	const peerId = isOut ? l.toProfileId : l.fromProfileId;
																	const peerName = isOut ? l.toName : l.fromName;
																	const evStart = l.startDate || l.peerStartDate || null;
																	const evEnd = l.endDate || l.peerEndDate || null;
																	const dateSpan = formatDateSpan(evStart, evEnd, false, false);
																	return (
																		<button
																			key={l.id}
																			type="button"
																			onClick={() => jumpToProfile(peerId)}
																			className="block w-full cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2.5 text-left transition hover:border-[#F97316]/60 hover:bg-[var(--app-surface-hover)]"
																		>
																			<div className="flex flex-wrap items-center gap-2">
																				{dateSpan ? (
																					<span className="shrink-0 rounded border border-amber-500/35 bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-200">
																						{dateSpan}
																					</span>
																				) : null}
																				<span className="text-xs font-semibold text-[#F97316] underline">
																					{peerName}
																				</span>
																				<CountryFlags codes={l.peerCountryCodes} size="sm" />
																				{l.peerPrimaryLocation ? (
																					<span className="text-[11px] opacity-70">
																						📍 {l.peerPrimaryLocation}
																					</span>
																				) : null}
																			</div>
																			{l.peerSummary ? (
																				<p className="mt-1 mb-0 line-clamp-2 text-[11px] leading-relaxed opacity-80">
																					{l.peerSummary}
																				</p>
																			) : null}
																		</button>
																	);
																})}
															</div>
														</div>
													) : null}

													{connectedLinks.length > 0 ? (
													<div>
													<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
														<h3 className="m-0 text-xs font-semibold uppercase opacity-75">
															Connected Profiles (
															{detail.counts.links > detail.links.length
																? `showing ${connectedLinks.length.toLocaleString()} of ${detail.counts.links.toLocaleString()}`
																: connectedLinks.length.toLocaleString()}
															)
														</h3>
														<div className="flex flex-wrap items-center gap-1.5">
															{currentCount > 0 || oldCount > 0 ? (
																<div className="flex items-center gap-1">
																	{(
																		[
																			{
																				id: 'all' as const,
																				label: `All (${connectedLinks.length.toLocaleString()})`,
																				show: true,
																			},
																			{
																				id: 'current' as const,
																				label: `Current (${currentCount.toLocaleString()})`,
																				show: currentCount > 0,
																			},
																			{
																				id: 'old' as const,
																				label: `Old (${oldCount.toLocaleString()})`,
																				show: oldCount > 0,
																			},
																		] as const
																	)
																		.filter((tab) => tab.show)
																		.map((tab) => (
																		<button
																			key={tab.id}
																			type="button"
																			onClick={() => setConnStatusFilter(tab.id)}
																			className={`cursor-pointer rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
																				connStatusFilter === tab.id
																					? 'border-[#F97316] bg-[#F97316] text-white'
																					: 'border-[var(--app-border)] bg-[var(--app-bg)] hover:bg-[var(--app-surface-hover)]'
																			}`}
																		>
																			{tab.label}
																		</button>
																	))}
																</div>
															) : null}
															{undatedFinraCount > 0 ? (
																<button
																	type="button"
																	disabled={hydratingDates}
																	onClick={() => void handleHydrateFirmDates()}
																	className="cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/12 px-2 py-0.5 text-[10px] font-semibold text-[#F97316] hover:bg-[#F97316]/20 disabled:opacity-50"
																	title="Fetch FINRA BrokerCheck & SEC IAPD employment start/end dates for connected people"
																>
																	{hydratingDates
																		? 'Fetching Hire Dates…'
																		: `Fetch Hire Dates (${undatedFinraCount.toLocaleString()})`}
																</button>
															) : null}
														</div>
													</div>
													{filteredLinks.length === 0 ? (
														<p className="text-xs opacity-70">
															{connectedLinks.length > 0
																? `No ${connStatusFilter} connections recorded.`
																: detail.profile.profileType === 'person' &&
																	  detail.employmentHistory.length > 0
																	? 'All connected organizations and schools are listed in Employment History & Education above.'
																	: 'No typed links recorded yet.'}
														</p>
													) : (
														<div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
															{filteredLinks.map(({ link: l, connStatus }) => {
																const isOut = l.fromProfileId === detail.profile.id;
																const peerId = isOut ? l.toProfileId : l.fromProfileId;
																const peerName = isOut ? l.toName : l.fromName;
																const peerType = (isOut ? l.toType : l.fromType) || 'firm';
																const dateSpan = formatDateSpan(
																	l.startDate,
																	l.endDate,
																	connStatus === 'current' ? true : connStatus === 'old' ? false : null,
																	peerType === 'education',
																);
																const roleClean =
																	l.roleLabel &&
																	!/^(?:current|previous)\s+registration$/i.test(l.roleLabel.trim())
																		? l.roleLabel.trim()
																		: null;
																const relNote = scrubEvidenceNoteSourceTags(l.evidenceNote);
																const showRelNote =
																	Boolean(relNote) &&
																	(!roleClean ||
																		relNote.toLowerCase() !== roleClean.toLowerCase()) &&
																	!/^seed relatedslugs$/i.test(relNote) &&
																	!/^role:/i.test(relNote) &&
																	!isRedundantConnectedEvidenceNote(relNote, roleClean);
																return (
																	<div
																		key={l.id}
																		className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs"
																	>
																		<div className="flex flex-wrap items-center justify-between gap-2">
																			<div className="flex flex-wrap items-center gap-1.5">
																				{dateSpan ? (
																					<span className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
																						{dateSpan}
																					</span>
																				) : null}
																				{connStatus === 'current' ? (
																					<span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200">
																						Current
																					</span>
																				) : connStatus === 'old' ? (
																					<span className="shrink-0 rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-semibold opacity-75">
																						Old
																					</span>
																				) : null}
																				<span className="text-[10px] opacity-60">
																					{isOut ? '→' : '←'} {l.relationType.replace(/_/g, ' ')}
																				</span>
																				<button
																					type="button"
																					onClick={() => jumpToProfile(peerId)}
																					className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline"
																				>
																					{peerName}
																				</button>
																				<CountryFlags codes={l.peerCountryCodes} size="sm" />
																				<span
																					className={`rounded border px-1.5 py-0.2 text-[10px] ${TYPE_META[peerType].badge}`}
																				>
																					{TYPE_META[peerType].label}
																				</span>
																				{roleClean ? (
																					<span className="text-[11px] opacity-75">({roleClean})</span>
																				) : null}
																				{l.peerPrimaryLocation ? (
																					<span className="text-[11px] opacity-70">
																						📍 {l.peerPrimaryLocation}
																					</span>
																				) : null}
																			</div>
																		</div>
																		{showRelNote ? (
																			<p className="m-0 mt-1.5 text-[11px] leading-snug opacity-70">
																				{relNote}
																			</p>
																		) : null}
																	</div>
																);
															})}
														</div>
													)}
													</div>
													) : null}
												</div>
											);
										})()}
									</div>
								) : null}

								{/* TAB 2: Timeline & Gap Analysis */}
								{profileTab === 'timeline' ? (
									<div className="space-y-4">
										{/* Controls & Angle Filters */}
										<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 text-xs">
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="font-semibold opacity-75">Angles:</span>
												<button
													type="button"
													onClick={() => setTimelineAngle('')}
													className={`cursor-pointer rounded border px-2 py-0.5 text-[11px] ${
														!timelineAngle
															? 'border-[#F97316] bg-[#F97316] text-white'
															: 'border-[var(--app-border)] bg-[var(--app-surface)]'
													}`}
												>
													All ({timeline?.totalEntries ?? 0})
												</button>
												{(timeline?.angleBreakdown || []).map((ab) => (
													<button
														key={ab.angle}
														type="button"
														onClick={() =>
															setTimelineAngle(timelineAngle === ab.angle ? '' : ab.angle)
														}
														className={`cursor-pointer rounded border px-2 py-0.5 text-[11px] ${
															timelineAngle === ab.angle
																? 'border-[#F97316] bg-[#F97316] text-white'
																: 'border-[var(--app-border)] bg-[var(--app-surface)]'
														}`}
													>
														{ab.angle.replace(/_/g, ' ')} ({ab.count})
													</button>
												))}
											</div>
											<label className="flex items-center gap-1.5 text-[11px]">
												<span className="opacity-75">Gap threshold (days):</span>
												<input
													type="number"
													min={7}
													max={730}
													value={minGapDays}
													onChange={(e) => setMinGapDays(Number(e.target.value) || 30)}
													className="w-16 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-0.5 text-xs"
												/>
											</label>
										</div>

										{loadingTimeline ? (
											<p className="text-xs opacity-70">Building multi-source timeline &amp; scanning gaps…</p>
										) : timeline ? (
											<>
												{/* Detected Timeline Gaps + Cross-Source Fill Leads */}
												{timeline.gaps.length > 0 ? (
													<div className="space-y-2">
														<h3 className="m-0 text-xs font-semibold uppercase opacity-80">
															Detected Timeline Gaps &amp; Cross-Source Fill Leads ({timeline.gaps.length})
														</h3>
														{timeline.gaps.map((g, idx) => (
															<details
																key={`${g.fromDate}-${g.toDate}-${idx}`}
																open={g.fillLeads.length > 0 && idx < 2}
																className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
															>
																<summary className="cursor-pointer font-semibold">
																	{g.gapDays}-day gap: {g.fromDate} → {g.toDate} ·{' '}
																	{g.fillLeads.length > 0
																		? `${g.fillLeads.length} cross-source lead(s) found`
																		: 'No automated leads found in other corpora'}
																</summary>
																<div className="mt-2 text-[11px] opacity-80">
																	<div>
																		<strong>
																			Before ({formatSourceCorpusLabel(g.beforeCorpus)}):
																		</strong>{' '}
																		{g.beforeEntryTitle}
																	</div>
																	<div>
																		<strong>
																			After ({formatSourceCorpusLabel(g.afterCorpus)}):
																		</strong>{' '}
																		{g.afterEntryTitle}
																	</div>
																</div>
																{g.fillLeads.length > 0 ? (
																	<div className="mt-2 space-y-1.5 border-t border-amber-500/25 pt-2">
																		{g.fillLeads.map((lead, lIdx) => (
																			<div
																				key={lIdx}
																				className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] p-2 text-[11px]"
																			>
																				<div className="flex flex-wrap items-center gap-1.5">
																					<span className="font-semibold">
																						{lead.date || 'undated'}
																					</span>
																					<span
																						className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ANGLE_BADGE[lead.angle] || ANGLE_BADGE.general}`}
																					>
																						{lead.angle}
																					</span>
																					<span className="opacity-70">
																						{formatSourceCorpusLabel(lead.corpus)}
																					</span>
																					{lead.geoLabel ? (
																						<span className="opacity-65">· {lead.geoLabel}</span>
																					) : null}
																				</div>
																				<div className="mt-0.5 font-semibold">{lead.title}</div>
																				<div className="mt-0.5 opacity-80">
																					{scrubEpsteinSourceLabels(lead.reason)}
																				</div>
																				{lead.snippet ? (
																					<div className="mt-0.5 opacity-75">
																						{scrubEpsteinSourceLabels(lead.snippet)}
																					</div>
																				) : null}
																			</div>
																		))}
																	</div>
																) : null}
															</details>
														))}
													</div>
												) : null}

												{/* Chronological Entries (multi-angle months marked inline) */}
												<div>
													<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
														Timeline Entries ({timeline.entries.length} of {timeline.totalEntries}
														{timeline.overlappingWindows.length > 0
															? ` · ${timeline.overlappingWindows.length} multi-angle months`
															: ''}
														)
													</h3>
													{timeline.entries.length === 0 ? (
														<p className="text-xs opacity-70">
															No timeline entries yet. Add one below or link dated historic events to this
															profile.
														</p>
													) : (
														<div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
															{timeline.entries.map((entry) => {
																const entryMonth =
																	entry.eventDate && entry.eventDate.length >= 7
																		? entry.eventDate.slice(0, 7)
																		: '';
																const overlap = entryMonth
																	? timeline.overlappingWindows.find((w) => w.month === entryMonth)
																	: undefined;
																return (
																	<div
																		key={entry.id}
																		className={`rounded-md border bg-[var(--app-bg)] p-2.5 text-xs ${
																			overlap
																				? 'border-sky-500/45 bg-sky-500/5'
																				: 'border-[var(--app-border)]'
																		}`}
																	>
																		<div className="flex flex-wrap items-center justify-between gap-2">
																			<div className="flex flex-wrap items-center gap-1.5">
																				<span className="font-mono font-semibold text-[#F97316]">
																					{entry.eventDate
																						? formatDisplayDate(entry.eventDate)
																						: 'Undated'}
																				</span>
																				<span
																					className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ANGLE_BADGE[entry.angle] || ANGLE_BADGE.general}`}
																				>
																					{entry.angle.replace(/_/g, ' ')}
																				</span>
																				{overlap ? (
																					<span
																						className="rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:text-sky-200"
																						title={`${overlap.month}: ${overlap.count} entries across ${overlap.angles.join(' + ')}${overlap.corpora.length ? ` · ${overlap.corpora.map(formatSourceCorpusLabel).join(', ')}` : ''}`}
																					>
																						multi-angle ·{' '}
																						{overlap.angles
																							.map((a) => a.replace(/_/g, ' '))
																							.join(' + ')}{' '}
																						({overlap.count})
																					</span>
																				) : null}
																				{entry.geoLabel ? (
																					<span className="text-[10px] opacity-70">
																						📍 {entry.geoLabel}
																					</span>
																				) : null}
																			</div>
																			{entry.sourceUrl ? (
																				<a
																					href={entry.sourceUrl}
																					target="_blank"
																					rel="noreferrer"
																					className="text-[10px] text-sky-600 underline dark:text-sky-300"
																				>
																					Source ↗
																				</a>
																			) : null}
																		</div>
																		<div className="mt-1 font-semibold leading-snug">{entry.title}</div>
																		{entry.summary && entry.summary !== entry.title ? (
																			<p className="m-0 mt-1 leading-relaxed opacity-80">
																				{entry.summary}
																			</p>
																		) : null}
																	</div>
																);
															})}
														</div>
													)}
												</div>

												{/* Add Manual Timeline Observation */}
												<form
													onSubmit={(e) => void handleAddObservation(e)}
													className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
												>
													<h4 className="m-0 mb-2 text-xs font-semibold">
														+ Add Timeline Observation / Other Angle
													</h4>
													<div className="grid gap-2 sm:grid-cols-3">
														<input
															value={obsDate}
															onChange={(e) => setObsDate(e.target.value)}
															placeholder="Date (YYYY-MM-DD)"
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
														/>
														<select
															value={obsAngle}
															onChange={(e) => setObsAngle(e.target.value)}
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
														>
															<option value="general">General</option>
															<option value="civilian_health">Civilian Health</option>
															<option value="defense_dod">Defense / DoD</option>
															<option value="law_enforcement">Law Enforcement</option>
															<option value="regulatory_finra">Regulatory / FINRA</option>
															<option value="land_records">Land Records / Deeds</option>
															<option value="academic_research">Academic Research</option>
															<option value="financial">Financial</option>
															<option value="geophysical">Geophysical</option>
															<option value="corporate">Corporate</option>
															<option value="policy">Policy</option>
														</select>
														<input
															value={obsGeo}
															onChange={(e) => setObsGeo(e.target.value)}
															placeholder="Location (e.g. Dallas, TX)"
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
														/>
														<input
															required
															value={obsTitle}
															onChange={(e) => setObsTitle(e.target.value)}
															placeholder="Observation title *"
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-2"
														/>
														<input
															value={obsUrl}
															onChange={(e) => setObsUrl(e.target.value)}
															placeholder="Source URL (optional)"
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs"
														/>
														<textarea
															rows={2}
															value={obsSummary}
															onChange={(e) => setObsSummary(e.target.value)}
															placeholder="Details / evidence / alternative angle notes…"
															className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-3"
														/>
													</div>
													<div className="mt-2 flex justify-end">
														<button
															type="submit"
															disabled={savingObs}
															className="cursor-pointer rounded border-none bg-[#F97316] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
														>
															{savingObs ? 'Saving…' : 'Add to Timeline'}
														</button>
													</div>
												</form>
											</>
										) : null}
									</div>
								) : null}

								{/* TAB 3: Profile Alignments */}
								{profileTab === 'alignments' ? (
									<div className="space-y-2.5">
										{detail.alignments.length === 0 ? (
											<p className="text-xs opacity-70">
												No alignment candidates recorded for this profile yet. Try clicking{' '}
												<strong>Sync &amp; Align All Data</strong> to scan all corpora.
											</p>
										) : (
											detail.alignments.map((al) => {
												const peerId =
													al.leftProfileId === detail.profile.id
														? al.rightProfileId
														: al.leftProfileId;
												const peerName =
													al.leftProfileId === detail.profile.id ? al.rightName : al.leftName;
												return (
													<div
														key={al.id}
														className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs"
													>
														<div className="flex flex-wrap items-center justify-between gap-2">
															<div className="flex flex-wrap items-center gap-1.5">
																<span
																	className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CAUTION_BADGE[al.cautionTier]}`}
																>
																	{al.cautionTier.replace(/_/g, ' ')}
																</span>
																<span className="rounded bg-[var(--app-surface-hover)] px-1.5 py-0.5 text-[10px] font-semibold">
																	{al.alignmentKind.replace(/_/g, ' ')}
																</span>
																<span className="opacity-70">score {al.score.toFixed(2)}</span>
																<span className="opacity-60">· {al.status}</span>
															</div>
															<div className="flex gap-1.5">
																{(al.alignmentKind === 'same_entity_alias' ||
																	al.alignmentKind === 'shared_identifier') &&
																peerId &&
																peerName ? (
																	<button
																		type="button"
																		onClick={() =>
																			void handleMergeProfiles(
																				detail.profile.id,
																				peerId,
																				detail.profile.name,
																				peerName,
																			)
																		}
																		className="cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/15 px-2 py-0.5 text-[11px] font-semibold text-[#F97316]"
																	>
																		Merge into this
																	</button>
																) : null}
																{al.status !== 'confirmed' ? (
																	<button
																		type="button"
																		onClick={() => void handleTriageAlignment(al.id, 'confirmed')}
																		className="cursor-pointer rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200"
																	>
																		Confirm
																	</button>
																) : null}
																{al.status !== 'dismissed' ? (
																	<button
																		type="button"
																		onClick={() => void handleTriageAlignment(al.id, 'dismissed')}
																		className="cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-2 py-0.5 text-[11px] opacity-75"
																	>
																		Dismiss
																	</button>
																) : null}
															</div>
														</div>

														{peerId && peerName ? (
															<div className="mt-1.5">
																<span className="opacity-70">Aligned with: </span>
																<button
																	type="button"
																	onClick={() => jumpToProfile(peerId)}
																	className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline"
																>
																	{peerName}
																</button>
															</div>
														) : null}

														<p className="my-1.5 leading-relaxed opacity-85">
															{scrubEpsteinSourceLabels(al.rationale)}
														</p>

														{al.evidence.length > 0 ? (
															<div className="flex flex-wrap gap-1.5">
																{al.evidence.map((ev, idx) => (
																	<span
																		key={idx}
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 text-[10px]"
																	>
																		<strong>{formatSourceCorpusLabel(ev.corpus)}</strong>:{' '}
																		{scrubEpsteinSourceLabels(ev.label)}
																		{ev.date ? ` (${ev.date})` : ''}
																	</span>
																))}
															</div>
														) : null}
													</div>
												);
											})
										)}
									</div>
								) : null}
							</div>
						)}
					</section>
				</div>
			)}
		</main>
	);
}
