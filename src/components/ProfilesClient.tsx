'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import AlignmentEvidenceList from '@/components/AlignmentEvidenceList';
import { FinraDisclosuresPanel } from '@/components/FinraDisclosuresPanel';
import { ProfileTimelineCareerView } from '@/components/ProfileTimelineCareerView';
import ThemeToggle from '@/components/ThemeToggle';
import type { ProfileFinraDisclosures } from '@/lib/research/finraDisclosuresShared';
import { detectFirmActiveFinraScope, detectFirmLiveSourceUrl } from '@/lib/research/profiles/liveListing';
import { normalizeIsoDate } from '@/lib/research/profiles/normalize';
import { formatTickerListing } from '@/lib/research/profiles/tickerListing';
import { summaryMarkdownToHtml } from '@/lib/research/profiles/summaryMarkdown';
import { formatResearchDriveTimelineEntry } from '@/lib/research/profiles/researchDriveDisplay';
import {
	formatRangeSpanDuration,
	formatTimelineSpanHeaderLabel,
	nestTimelineItemsIntoRangeSpans,
	parseSummaryDateBounds,
	parseTimelineEntryBounds,
	type RangeSpanChapter,
} from '@/lib/research/profiles/timelineRangeNest';
import {
	formatFamilyPeerRoleLabel,
	invertFamilyRoleForOutbound,
	type PersonGender,
} from '@/lib/research/profiles/personGender';
import type {
	AliasKind,
	AlignmentCandidate,
	AlignmentKind,
	AlignmentStatus,
	CautionTier,
	EnrichProfileReport,
	FirmOwnershipGroup,
	LocationRole,
	Profile,
	ProfileDetail,
	ProfileRelationType,
	ProfileStats,
	ProfileTimelineResult,
	ProfileType,
} from '@/lib/research/profiles/types';
import { LOCATION_ROLES } from '@/lib/research/profiles/types';

/** Typed date inputs: preferred MM-DD-YYYY plus compact MMDDYYYY (also accepts Month D, YYYY). */
const DATE_INPUT_PLACEHOLDER = 'MM-DD-YYYY or MMDDYYYY';
const DATE_INPUT_TITLE = 'Accepted: 11-26-2026, 11262026, or November 26, 2026';
const DISPLAY_MONTH_NAMES = [
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

const TYPE_META: Record<ProfileType, { label: string; plural: string; badge: string; group: 'actor' | 'narrative' }> = {
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
	region: {
		label: 'Region',
		plural: 'Regions',
		badge: 'bg-lime-500/15 text-lime-900 dark:text-lime-200 border-lime-500/35',
		group: 'actor',
	},
	historic_event: {
		label: 'Historic Event',
		plural: 'Historic Events',
		badge: 'bg-rose-500/15 text-rose-800 dark:text-rose-200 border-rose-500/30',
		group: 'narrative',
	},
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

function firmHasLiveSourceUrl(p: Pick<Profile, 'metadata' | 'hasLiveSourceUrl'>, identifiers?: Array<{ scheme: string; value: string }> | null): boolean {
	if (p.hasLiveSourceUrl === true) return true;
	return detectFirmLiveSourceUrl(p.metadata, identifiers);
}

/** True when FINRA BrokerCheck or SEC IA scope from the visualizer/API is ACTIVE. */
function firmHasActiveFinraScope(p: Pick<Profile, 'metadata' | 'hasActiveFinraScope'>): boolean {
	if (p.hasActiveFinraScope === true) return true;
	return detectFirmActiveFinraScope(p.metadata);
}

const ORG_TYPES_DEFAULT_CURRENT = new Set<ProfileType>(['education', 'nonprofit', 'medical_hospital', 'government']);

/** Closed / defunct clues beyond a hard endDate (enrich + FINRA mistypes + summary language). */
function orgHasClosedClues(p: Pick<Profile, 'status' | 'summary' | 'metadata'>): boolean {
	if (p.status === 'archived') return true;
	const meta = p.metadata || {};
	const statusBits = [meta.status, meta.orgStatus, meta.operatingStatus, meta.eoStatus, meta.freeOrgStatus, meta.finraFirmStatus]
		.map((v) =>
			String(v || '')
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean);
	for (const s of statusBits) {
		if (
			s === 'archived' ||
			s === 'inactive' ||
			s === 'terminated' ||
			s === 'cancelled' ||
			s === 'canceled' ||
			s === 'revoked' ||
			s === 'dissolved' ||
			s === 'closed' ||
			s === 'defunct' ||
			s.includes('terminat') ||
			s.includes('revok') ||
			s.includes('dissolv') ||
			s.includes('closed')
		) {
			return true;
		}
	}
	const blob = `${p.summary || ''} ${String(meta.notes || '')}`.toLowerCase();
	if (/\b(dissolved|defunct|ceased operations|no longer operat|permanently closed|revoked|shut down|went out of business)\b/.test(blob)) {
		return true;
	}
	return false;
}

/**
 * Soft green / electric-blue “current” tint:
 * - people: living (no endDate)
 * - firms: not ended, and either a confirmed startDate, live external listing URL,
 *   or ACTIVE FINRA BrokerCheck / SEC IA scope from the visualizer API
 * - education / nonprofit / hospital / government: green by default; gray when
 *   endDate or closed/archived/dissolved clues appear
 * - region / historic_event: always current — corridors and events have no
 *   operating status (left-rail stays blue active)
 */
function isCurrentPersonOrFirm(
	p: Pick<Profile, 'profileType' | 'status' | 'startDate' | 'endDate' | 'summary' | 'metadata' | 'hasLiveSourceUrl' | 'hasActiveFinraScope'>,
	identifiers?: Array<{ scheme: string; value: string }> | null,
): boolean {
	if (p.profileType === 'region' || p.profileType === 'historic_event') return true;
	if (profileHasEnded(p)) return false;
	if (p.profileType === 'person') return true;
	if (p.profileType === 'firm') {
		return profileHasStartDate(p) || firmHasLiveSourceUrl(p, identifiers) || firmHasActiveFinraScope(p);
	}
	if (ORG_TYPES_DEFAULT_CURRENT.has(p.profileType)) {
		return !orgHasClosedClues(p);
	}
	return false;
}

function firmTypeBadgeLabel(
	p: Pick<Profile, 'profileType' | 'status' | 'startDate' | 'endDate' | 'summary' | 'metadata' | 'hasLiveSourceUrl' | 'hasActiveFinraScope'>,
	_identifiers?: Array<{ scheme: string; value: string }> | null,
): string {
	if (p.profileType === 'firm') return 'Firm';
	return TYPE_META[p.profileType]?.label || 'Firm';
}

/** Mint for current/active firms; gray for ended / inactive firms. */
function firmTypeBadgeClass(
	p: Pick<Profile, 'profileType' | 'status' | 'startDate' | 'endDate' | 'summary' | 'metadata' | 'hasLiveSourceUrl' | 'hasActiveFinraScope'>,
	identifiers?: Array<{ scheme: string; value: string }> | null,
): string {
	if (p.profileType !== 'firm') {
		return isCurrentPersonOrFirm(p, identifiers) ? CURRENT_ACTOR_BADGE : TYPE_META[p.profileType]?.badge || '';
	}
	return isCurrentPersonOrFirm(p, identifiers) ? CURRENT_ACTOR_BADGE : INACTIVE_FIRM_BADGE;
}

/** Flat mint chip (light); dark mode uses soft electric-blue wash. */
const CURRENT_ACTOR_BADGE = 'bg-[#e7f6ef] text-[#3d6b55] border-[#b9d5cd] dark:bg-[lab(5_4.06_-17.11_/0.62)] dark:text-[#c5d4ff] dark:border-[lab(5_4.06_-17.11_/0.8)]';
/** Ended / inactive firm type chip (gray). */
const INACTIVE_FIRM_BADGE = 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/40';
/** Active (unselected) left-list row: soft dark electric blue. */
const CURRENT_ACTOR_ROW = 'bg-[#f3faf6] hover:bg-[#eaf6f0] dark:bg-[lab(5_4.06_-17.11_/0.62)] dark:hover:bg-[lab(5_4.06_-17.11_/0.75)]';
/** Selected current row only: brighter electric blue lab(32 45.99 -92.35 / 0.85). */
const CURRENT_ACTOR_ROW_ACTIVE = 'border-l-2 border-l-[#F97316] bg-[#e7f6ef] dark:bg-[lab(32_45.99_-92.35_/0.85)]';
/** Selected inactive/gray row: full orange fill (not just left edge). */
const INACTIVE_ROW_ACTIVE = 'border-l-2 border-l-[#F97316] bg-[#F97316]/35 text-[#fff7ed] dark:bg-[#F97316]/40 dark:text-[#fff7ed]';
/** Shared very dark electric blue (main panel + left-panel chrome). */
const CURRENT_ACTOR_PANEL_BG = 'bg-[#050a1c] text-[#e8eeff] dark:bg-[#040812] dark:text-[#e8eeff]';
/**
 * Current employment / connection card —
 * bg lab(17 -16.7 1.95); border rgb(18 161 158 / 47%).
 */
const EMP_CARD_CURRENT = 'rounded-md border border-[rgb(18_161_158_/0.47)] bg-[lab(6_-10.8_1.47)] px-2.5 py-2 text-xs text-emerald-50';
/** Previous / old employment or connection card — muted zinc for contrast. */
const EMP_CARD_PREVIOUS = 'rounded-md border border-zinc-500/40 bg-zinc-500/15 px-2.5 py-2 text-xs dark:bg-zinc-500/20';
const EMP_CHIP_CURRENT = 'shrink-0 rounded border border-[rgb(18_161_158_/0.47)] bg-[lab(17_-16.7_1.95)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-50';
const EMP_CHIP_PREVIOUS = 'shrink-0 rounded border border-zinc-500/35 bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold';
// lab(6 -10.8 1.47)
/** Inactive / ended profile main panel: same border as left column. */
const DETAIL_PANEL_OUTLINE = `border-[#1e3a8a]/50 dark:border-[#3b82f6]/35 ${CURRENT_ACTOR_PANEL_BG}`;
/** Current/active profile main panel: fluorescent orange top edge. */
const CURRENT_ACTOR_DETAIL_OUTLINE = `border-[#1e3a8a]/50 border-t-2 border-t-[#ff5f00] dark:border-[#3b82f6]/35 dark:border-t-[#ff6a00] ${CURRENT_ACTOR_PANEL_BG}`;
/** Left-list top controls (match count / Prev / Next). */
const LEFT_PANEL_TOP_CONTROLS = `border-b border-[#1e3a8a]/50 dark:border-[#3b82f6]/35 ${CURRENT_ACTOR_PANEL_BG}`;

const ALL_TYPES: ProfileType[] = [
	'historic_event',
	'region',
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
				countryCodes: Array.isArray(row.countryCodes) ? row.countryCodes.map(String).filter(Boolean) : [],
				alternateNames: Array.isArray(row.alternateNames) ? row.alternateNames.map(String).filter(Boolean) : [],
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

const EMPLOYER_CATEGORY_TYPES: ProfileType[] = ['firm', 'education', 'nonprofit', 'medical_hospital', 'government'];

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
	{ key: 'finraRegisteredSROs', label: 'Registered SROs' },
	{ key: 'finraExams', label: 'FINRA Exams' },
	{ key: 'finraRegisteredStates', label: 'Registered States' },
	// website omitted — shown as Website ↗ in Sources & Identifiers when present
];

const MILITARY_DETAIL_KEYS = new Set(['militaryBranch', 'militaryRank', 'yearsOfService', 'militaryUnit', 'militaryCommands', 'battlesWars']);

/** Fields that are always rendered full-width in the overview detail grid. */
const FULL_WIDTH_DETAIL_KEYS = new Set([
	'finraRegisteredStates',
	'finraExams',
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

const OCCUPATION_LINK_RELATIONS = new Set(['employed_by', 'affiliated_with', 'business_tie', 'owned_by', 'registered_at', 'alumni_or_faculty', 'funded_by']);

/** Relations offered in Connected Profiles “+ Add connection” (family stays in Family / Relatives). */
const CONNECTED_ADD_RELATIONS: ProfileRelationType[] = [
	'employed_by',
	'affiliated_with',
	'business_tie',
	'owned_by',
	'registered_at',
	'alumni_or_faculty',
	'funded_by',
	'participated_in',
	'authored_or_spoke',
	'part_of_subject',
	'mentioned_in',
	'regulator_of',
	'location_overlap',
];

type ConnSearchHit = {
	id: string;
	slug: string;
	name: string;
	profileType: ProfileType;
};

/**
 * Pick link endpoints for manual Connected Profiles adds.
 * employed_by / registered_at / alumni_or_faculty are always person → org.
 */
function resolveConnectedLinkEndpoints(
	subject: { id: string; profileType: ProfileType },
	peer: { id: string; profileType: ProfileType },
	relationType: ProfileRelationType,
): { fromProfileId: string; toProfileId: string } {
	const personToOrg =
		relationType === 'employed_by' ||
		relationType === 'registered_at' ||
		relationType === 'alumni_or_faculty';
	if (personToOrg) {
		if (subject.profileType === 'person' && peer.profileType !== 'person') {
			return { fromProfileId: subject.id, toProfileId: peer.id };
		}
		if (peer.profileType === 'person' && subject.profileType !== 'person') {
			return { fromProfileId: peer.id, toProfileId: subject.id };
		}
	}
	return { fromProfileId: subject.id, toProfileId: peer.id };
}

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
// okcr_instrument URLs are property filings — shown as ## Land Deeds content, never as ID chips.
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
	'us_passport',
	'driver_license',
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
	us_passport: 'Passport',
	driver_license: 'Driver license',
};

/** Hostname without leading www (e.g. bbc.co.uk). */
function hostnameFromUrl(raw: string): string | null {
	const text = String(raw || '').trim();
	if (!text) return null;
	try {
		const withProto = /^https?:\/\//i.test(text) ? text : `https://${text}`;
		const host = new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
		return host || null;
	} catch {
		const m = text.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
		return m ? m[1].replace(/^www\./i, '').toLowerCase() : null;
	}
}

/** Visible URL text for Contact / Sources bullets — truncate long article links. */
function truncateDisplayUrl(raw: string, maxLen = 56): string {
	const s = String(raw || '').trim();
	if (!s) return s;
	if (s.length <= maxLen) return s;
	return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

function sourceLabelFromUrl(raw: string): string | null {
	const host = hostnameFromUrl(raw);
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

/** Historic events ingested from news RSS — article URLs are citations, not org websites. */
function isNewsRssHistoricMetadata(meta: Record<string, unknown> | null | undefined): boolean {
	if (!meta || typeof meta !== 'object') return false;
	if (typeof meta.newsFeedId === 'string' && meta.newsFeedId.trim()) return true;
	const corpora = Array.isArray(meta.corpora) ? meta.corpora : [];
	return corpora.some((c) => /news[_-]?rss/i.test(String(c || '')));
}

function sourceLabelFromSchemeValue(scheme: string, value: string): string | null {
	const s = String(scheme || '').toLowerCase();
	const v = String(value || '').trim();
	// Only URL locators become Sources text (wikipedia, youtube, …).
	// wikidata / source_id / dossier_slug stay out of both Identifiers and Sources.
	if (s === 'url') return sourceLabelFromUrl(v);
	return null;
}

function collectProfileSourceLabels(identifiers: Array<{ scheme: string; value: string; sourceCorpus?: string | null }>): string[] {
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

/** Humanize corpus / feed slugs for historic-event source chips under the headline. */
function humanizeHistoricSourceLabel(raw: string): string {
	const cleaned = formatSourceCorpusLabel(raw);
	if (!cleaned) return '';
	const known: Record<string, string> = {
		'cdc-covid-timeline': 'CDC COVID timeline',
		'dod-covid-timeline': 'DoD COVID timeline',
		'authority-timelines': 'Authority timelines',
		'wikipedia-local': 'Local Wikipedia',
		wikipedia: 'Wikipedia',
		'news-rss': 'News RSS',
		news_rss: 'News RSS',
		usgs: 'USGS',
		enr: 'ENR',
		'ground-engineering': 'Ground Engineering',
		'construction-dive': 'Construction Dive',
		'construction-exec': 'Construction Executive',
		'texas-construction-law': 'Texas Construction Law',
		'federal-news-network': 'Federal News Network',
		'usgs-science-snippet': 'USGS Science Snippet',
	};
	const key = cleaned.toLowerCase().replace(/_/g, '-');
	if (known[key]) return known[key];
	const feedMatch = key.match(/^news-rss:(.+)$/);
	if (feedMatch) {
		const feedKey = feedMatch[1];
		if (known[feedKey]) return known[feedKey];
		return feedKey
			.split('-')
			.filter(Boolean)
			.map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
			.join(' ');
	}
	return cleaned
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => {
			if (/^(cdc|dod|usgs|enr|sec|finra|okcr|txdot|usace|fema)$/i.test(w)) return w.toUpperCase();
			if (/^(covid|rss|tbm)$/i.test(w)) return w.toUpperCase();
			return w.charAt(0).toUpperCase() + w.slice(1);
		})
		.join(' ');
}

type HistoricSourceOrigin = 'local' | 'external';
type HistoricSourceTag = { label: string; origin: HistoricSourceOrigin };

/** Local-only corpora / labels (orange). Everything else with web provenance is external (blue). */
const HISTORIC_LOCAL_SOURCE_RE =
	/^(?:local\s*wikipedia|wikipedia-local|entity-dossiers?|dallas-elite(?:-curated)?|dynasties?(?:-power-network)?(?:-curated)?|regional-history(?:-corpus)?|manual|curated|seed|dialog-curated|court-files|dialog(?:-curated)?)$/i;

const HISTORIC_EXTERNAL_CORPUS_RE =
	/^(?:news[_-]rss(?:[:].+)?|authority-timelines?|cdc-covid-timeline|dod-covid-timeline|usgs(?:-science-snippet)?|finra(?:-visualizer|-rosters)?|sec(?:-edgar)?|wikipedia)$/i;

function isHttpUrl(value: string | null | undefined): boolean {
	return /^https?:\/\//i.test(String(value || '').trim());
}

function isLocalhostUrl(value: string | null | undefined): boolean {
	const v = String(value || '').trim();
	if (!v) return false;
	try {
		const u = new URL(v);
		return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.local');
	} catch {
		return /localhost|127\.0\.0\.1/i.test(v);
	}
}

function classifyHistoricSourceOrigin(opts: {
	label: string;
	corpus?: string | null;
	fromNewsFeed?: boolean;
	fromUrlHost?: boolean;
	hasExternalWikipedia?: boolean;
	sourceUrl?: string | null;
}): HistoricSourceOrigin {
	const labelKey = opts.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const corpusKey = String(opts.corpus || '')
		.trim()
		.toLowerCase()
		.replace(/_/g, '-');

	// Live Wikipedia / Local Wikipedia validated against a public wikipedia.org URL → external (blue).
	if (labelKey === 'wikipedia' || labelKey === 'local wikipedia') {
		return opts.hasExternalWikipedia ? 'external' : 'local';
	}
	if (opts.fromNewsFeed) return 'external';
	if (opts.fromUrlHost) {
		return isLocalhostUrl(opts.sourceUrl) ? 'local' : 'external';
	}
	if (corpusKey && HISTORIC_EXTERNAL_CORPUS_RE.test(corpusKey)) return 'external';
	if (corpusKey.startsWith('news-rss:') || corpusKey.startsWith('news_rss:')) return 'external';
	if (HISTORIC_LOCAL_SOURCE_RE.test(labelKey) || (corpusKey && HISTORIC_LOCAL_SOURCE_RE.test(corpusKey))) {
		return 'local';
	}
	// Public article URL on the card → treat publisher/corpus tags as external.
	if (opts.sourceUrl && isHttpUrl(opts.sourceUrl) && !isLocalhostUrl(opts.sourceUrl)) return 'external';
	return 'local';
}

/**
 * Source chips under historic_event headlines: feed names, human corpora,
 * URL hosts, and Local Wikipedia when fact-checked. Hides cluster:* /
 * topic_consolidated / bare news_rss noise.
 * origin: local (orange) | external (blue, including local wiki validated via wikipedia.org).
 */
function collectHistoricEventSourceTags(opts: {
	metadata: Record<string, unknown> | null | undefined;
	identifiers: Array<{ scheme: string; value: string; sourceCorpus?: string | null }>;
	sourceCorpus?: string | null;
}): HistoricSourceTag[] {
	const meta = opts.metadata || {};
	const tags: HistoricSourceTag[] = [];
	const seen = new Set<string>();
	const sourceUrl = typeof meta.sourceUrl === 'string' ? meta.sourceUrl.trim() : '';
	const wikipediaUrl = typeof meta.wikipediaUrl === 'string' ? meta.wikipediaUrl.trim() : '';
	const hasExternalWikipedia =
		(wikipediaUrl && isHttpUrl(wikipediaUrl) && !isLocalhostUrl(wikipediaUrl) && /wikipedia\.org/i.test(wikipediaUrl)) ||
		opts.identifiers.some((id) => {
			if (String(id.scheme || '').toLowerCase() !== 'url') return false;
			const v = String(id.value || '').trim();
			return isHttpUrl(v) && !isLocalhostUrl(v) && /wikipedia\.org/i.test(v);
		});

	const push = (
		label: string | null | undefined,
		hint?: { corpus?: string | null; fromNewsFeed?: boolean; fromUrlHost?: boolean },
	) => {
		const t = String(label || '').trim();
		if (!t) return;
		const k = t.toLowerCase().replace(/[^a-z0-9]+/g, '');
		if (!k || seen.has(k)) return;
		// Drop host chips that are just a compressed form of an existing feed name
		// (e.g. "Constructionexec" after "Construction Executive").
		for (const prev of seen) {
			if (prev.includes(k) || k.includes(prev)) return;
		}
		seen.add(k);
		tags.push({
			label: t,
			origin: classifyHistoricSourceOrigin({
				label: t,
				corpus: hint?.corpus,
				fromNewsFeed: hint?.fromNewsFeed,
				fromUrlHost: hint?.fromUrlHost,
				hasExternalWikipedia,
				sourceUrl,
			}),
		});
	};

	const newsFeedName = typeof meta.newsFeedName === 'string' ? meta.newsFeedName.trim() : '';
	if (newsFeedName) push(newsFeedName, { fromNewsFeed: true, corpus: `news_rss:${meta.newsFeedId || 'feed'}` });

	const corpora = Array.isArray(meta.corpora) ? meta.corpora.map(String) : [];
	for (const c of corpora) {
		const raw = String(c || '').trim();
		if (!raw) continue;
		const low = raw.toLowerCase();
		if (low.startsWith('cluster:')) continue;
		if (low === 'topic_consolidated' || low === 'topic-consolidated') continue;
		if (low === 'news_rss' || low === 'news-rss') continue;
		if (newsFeedName && (low.startsWith('news_rss:') || low.startsWith('news-rss:'))) continue;
		push(humanizeHistoricSourceLabel(raw), { corpus: raw });
	}

	if (opts.sourceCorpus) {
		const sc = String(opts.sourceCorpus).trim();
		const low = sc.toLowerCase();
		if (sc && !low.startsWith('cluster:') && low !== 'topic_consolidated' && low !== 'news_rss') {
			if (!(newsFeedName && (low.startsWith('news_rss:') || low.startsWith('news-rss:')))) {
				push(humanizeHistoricSourceLabel(sc), { corpus: sc });
			}
		}
	}

	for (const id of opts.identifiers) {
		if (String(id.scheme || '').toLowerCase() !== 'url') continue;
		if (isHiddenEpsteinSourceIdentifier(id.scheme, id.value)) continue;
		const href = String(id.value || '').trim();
		const hostLabel = sourceLabelFromSchemeValue(id.scheme, href);
		if (!hostLabel) continue;
		push(humanizeHistoricSourceLabel(hostLabel), { fromUrlHost: true, corpus: id.sourceCorpus });
	}

	const wiki = meta.wikiFactCheck;
	if (Array.isArray(wiki) && wiki.length > 0) push('Local Wikipedia', { corpus: 'wikipedia-local' });
	else if (wikipediaUrl) push('Wikipedia', { corpus: 'wikipedia' });

	return tags;
}

const HISTORIC_SOURCE_TAG_LOCAL =
	'inline-flex max-w-full items-center rounded border border-[#F97316]/45 bg-[#F97316]/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[#9a3412] dark:text-orange-100';
const HISTORIC_SOURCE_TAG_EXTERNAL =
	'inline-flex max-w-full items-center rounded border border-sky-500/50 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-900 dark:text-sky-100';

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
function isRedundantConnectedEvidenceNote(note: string, roleClean: string | null): boolean {
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

/** Normalize FINRA/SEC scope tokens for badge display (ACTIVE / INACTIVE / …). */
function formatFinraScopeLabel(scope: unknown): string {
	const raw = String(scope || '').trim();
	if (!raw) return '';
	const compact = raw.replace(/[^a-z0-9]+/gi, '').toLowerCase();
	if (!compact) return '';
	if (compact === 'notinscope') return 'NOT IN SCOPE';
	if (compact === 'active') return 'ACTIVE';
	if (compact === 'inactive') return 'INACTIVE';
	if (compact === 'expanded') return 'EXPANDED';
	return raw.toUpperCase();
}

function scopeLooksInactive(scopeLabel: string): boolean {
	return /(inactive|terminated|revoked|suspended|notinscope|withdrawn|barred|expelled|denied|ceased|closed|cancelled|canceled|previouslyregistered|nolongerregistered|notregistered|historical)/i.test(
		scopeLabel.replace(/[^a-z0-9]+/gi, ''),
	);
}

type FinraCrdHeaderTag =
	| { kind: 'entity' | 'crd' | 'role'; label: string; title?: string; className: string }
	| { kind: 'scope'; label: string; inactive: boolean; className: string }
	| { kind: 'fact'; label: string; value: string; className: string };

/**
 * Visualizer-style header tags for firm/person CRDs: CRD + FINRA:/SEC: scopes
 * (standalone FINRA/SEC presence chips, purple FIRM entity chip, and firm B/IA
 * role chips omitted), INDIVIDUAL chip for person CRDs, plus District/Type/
 * State/Size facts for firms. Type badge above the name already says Firm.
 */
function buildFinraCrdHeaderTags(opts: { profileType: ProfileType; crd: string; metadata: Record<string, unknown> | null | undefined }): FinraCrdHeaderTag[] {
	const meta = opts.metadata || {};
	const bcScope = formatFinraScopeLabel(meta.finraBcScope);
	const iaScope = formatFinraScopeLabel(meta.finraIaScope);

	const tags: FinraCrdHeaderTag[] = [];
	// Purple FIRM chip omitted — redundant with the green/gray Firm type badge.
	if (opts.profileType !== 'firm') {
		tags.push({
			kind: 'entity',
			label: 'INDIVIDUAL',
			className: 'rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-900 dark:text-indigo-100',
		});
	}
	tags.push({
		kind: 'crd',
		label: `CRD ${opts.crd}`,
		className: 'rounded border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-800 dark:text-sky-200',
	});

	// Only emit FINRA:/SEC: chips from explicit scope tokens — never invent ACTIVE
	// when scope is missing or NOTINSCOPE (that false ACTIVE made historical firms
	// look registered while the type badge correctly stayed inactive/gray).
	if (bcScope) {
		const inactive = scopeLooksInactive(bcScope);
		tags.push({
			kind: 'scope',
			label: `FINRA: ${bcScope}`,
			inactive,
			className:
				inactive ?
					'rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-800 dark:text-rose-200'
				:	'rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200',
		});
	}

	// SEC chip only for real IA scopes (ACTIVE / INACTIVE / EXPANDED) — omit NOT IN SCOPE.
	if (iaScope && iaScope !== 'NOT IN SCOPE') {
		const inactive = scopeLooksInactive(iaScope);
		tags.push({
			kind: 'scope',
			label: `SEC: ${iaScope}`,
			inactive,
			className:
				inactive ?
					'rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-800 dark:text-rose-200'
				:	'rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200',
		});
	}

	if (opts.profileType === 'firm') {
		const facts: Array<{ label: string; value: string }> = [
			{ label: 'District', value: String(meta.finraDistrict || '').trim() },
			{ label: 'Type', value: String(meta.finraFirmType || '').trim() },
			{ label: 'State', value: String(meta.finraFormedState || '').trim() },
			{ label: 'Size', value: String(meta.finraFirmSize || '').trim() },
		].filter((f) => f.value !== '');
		for (const fact of facts) {
			tags.push({
				kind: 'fact',
				label: fact.label,
				value: fact.value,
				className: 'inline-flex items-baseline gap-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[10px]',
			});
		}
	}

	return tags;
}

function finraSecSourceLinks(opts: { profileType: ProfileType; crd: string; iaScope?: unknown }): Array<{ href: string; label: string; className: string }> {
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
function renderClickableOccupation(occupation: string, orgPeers: OccupationOrgPeer[], onJump: (id: string) => void): ReactNode {
	const text = String(occupation || '');
	if (!text) return null;
	if (!orgPeers.length) return text;

	const sorted = [...orgPeers].filter((p) => p.id && p.name && p.name.trim().length >= 3).sort((a, b) => b.name.length - a.name.length);

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
					type='button'
					onClick={() => onJump(sorted[0].id)}
					className='cursor-pointer border-0 bg-transparent p-0 text-left text-[11px] font-semibold text-[#F97316] underline'
					title={`Open ${sorted[0].name}`}>
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
				type='button'
				onClick={() => onJump(hit.id)}
				className='cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-[#F97316] underline'
				title={`Open ${hit.label}`}>
				{hit.label}
			</button>,
		);
		cursor = hit.end;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

type FamilyRelativePeer = {
	id: string;
	name: string;
	role: string | null;
	/** Peer profile life/operating span (for ASCII year suffixes). */
	startDate?: string | null;
	endDate?: string | null;
	/** Peer gender when known — peer-centric Family / Relatives labels. */
	gender?: 'female' | 'male' | null;
};

type FamilyTreeRow =
	| { kind: 'person'; prefix: string; peer: FamilyRelativePeer; gen: number | null }
	| { kind: 'label'; prefix: string; text: string };

/** First 4-digit year in a date string, or null. */
function treeYearOf(raw?: string | null): number | null {
	const m = String(raw || '')
		.trim()
		.match(/((?:1[6-9]|20)\d{2})/);
	return m ? Number(m[1]) : null;
}

/** Compact year span for ASCII trees: `1936–`, `2002–2011`, `1962`. */
function formatTreeYearSpan(startDate?: string | null, endDate?: string | null): string | null {
	const s = treeYearOf(startDate);
	const e = treeYearOf(endDate);
	if (s != null && e != null) return s === e ? String(s) : `${s}–${e}`;
	if (s != null) return `${s}–`;
	if (e != null) return String(e);
	return null;
}

function peerIsInactive(peer: { startDate?: string | null; endDate?: string | null }): boolean {
	return Boolean(peer.endDate && String(peer.endDate).trim());
}

/**
 * Sort key for hierarchy rows: most recent year first.
 * Active (no endDate) sort above ended; among actives later start wins;
 * among ended later end wins; undated last.
 */
function compareTreePeersByRecentYear(
	a: { name: string; startDate?: string | null; endDate?: string | null },
	b: { name: string; startDate?: string | null; endDate?: string | null },
): number {
	const aEnd = treeYearOf(a.endDate);
	const bEnd = treeYearOf(b.endDate);
	const aStart = treeYearOf(a.startDate);
	const bStart = treeYearOf(b.startDate);
	const aActive = aEnd == null;
	const bActive = bEnd == null;
	if (aActive !== bActive) return aActive ? -1 : 1;
	if (aActive && bActive) {
		if (aStart != null && bStart != null && aStart !== bStart) return bStart - aStart;
		if (aStart != null && bStart == null) return -1;
		if (aStart == null && bStart != null) return 1;
	} else {
		if (aEnd != null && bEnd != null && aEnd !== bEnd) return bEnd - aEnd;
		if (aStart != null && bStart != null && aStart !== bStart) return bStart - aStart;
	}
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

const FAMILY_ROLE_GEN_RE = /^(\d+)(?:st|nd|rd|th)\s+Generation\s*[·•\-–—]\s*(.+)$/i;

function parseFamilyRelativeRole(role: string | null | undefined): { generation: number | null; branch: string } {
	const raw = String(role || '').trim();
	if (!raw) return { generation: null, branch: '' };
	const m = raw.match(FAMILY_ROLE_GEN_RE);
	if (!m) return { generation: null, branch: raw };
	return { generation: Number(m[1]), branch: m[2].trim() };
}

/** Kinship bucket for ASCII grouping when dynasty generation labels are sparse. */
type FamilyKinshipGroup =
	| 'spouse'
	| 'parent'
	| 'child'
	| 'sibling'
	| 'grandparent'
	| 'great_grandparent'
	| 'grandchild'
	| 'uncle_aunt'
	| 'great_uncle_aunt'
	| 'nephew_niece'
	| 'cousin'
	| 'in_law'
	| 'generation'
	| 'other';

const FAMILY_KINSHIP_ORDER: FamilyKinshipGroup[] = [
	'spouse',
	'parent',
	'grandparent',
	'great_grandparent',
	'child',
	'grandchild',
	'sibling',
	'uncle_aunt',
	'great_uncle_aunt',
	'nephew_niece',
	'cousin',
	'in_law',
	'generation',
	'other',
];

const FAMILY_KINSHIP_LABEL: Record<FamilyKinshipGroup, string> = {
	spouse: 'Spouse',
	parent: 'Parents',
	grandparent: 'Grandparents',
	great_grandparent: 'Great-grandparents',
	child: 'Children',
	grandchild: 'Grandchildren',
	sibling: 'Siblings',
	uncle_aunt: 'Uncles / Aunts',
	great_uncle_aunt: 'Great-uncles / Aunts',
	nephew_niece: 'Nephews / Nieces',
	cousin: 'Cousins',
	in_law: 'In-laws',
	generation: 'Lineage / branch',
	other: 'Other relatives',
};

function roleMentionsPeer(role: string, peerName: string | null | undefined): boolean {
	const peer = String(peerName || '').trim();
	if (!peer) return false;
	const r = role.toLowerCase();
	const full = peer.toLowerCase();
	if (r.includes(full)) return true;
	// Match first+last when middle names differ (e.g. role has "Laura (Lynn) McGee", peer "Laura E. McGee").
	const parts = full.split(/\s+/).filter((p) => p.length > 1 && !/^[a-z]\.?$/i.test(p));
	if (parts.length >= 2) {
		const first = parts[0];
		const last = parts[parts.length - 1];
		if (r.includes(first) && r.includes(last)) return true;
	}
	return false;
}

/**
 * Classify peer into a kinship bucket for ASCII grouping.
 * Links usually name the peer's relation to the subject ("father of …", "Great-uncle of Timothy").
 * Subject-of-peer phrasing ("Son of Laura") is inverted.
 */
function classifyFamilyKinship(role: string | null | undefined, peerName?: string | null): FamilyKinshipGroup {
	const raw = String(role || '')
		.trim()
		.replace(/\s*\(user-confirmed\)\s*$/i, '')
		.trim();
	if (!raw) return 'other';
	if (FAMILY_ROLE_GEN_RE.test(raw)) return 'generation';
	const r = raw.toLowerCase();
	const aboutPeer = roleMentionsPeer(raw, peerName);

	if (/\bspouses?\b|\bwife\b|\bhusband\b|\bmarried\b/.test(r)) return 'spouse';

	// Peer-is-X-of-subject.
	if (/^(?:adoptive\s+|step\s+)?great[- ]?grand(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return 'great_grandparent';
	}
	if (/^(?:adoptive\s+|step\s+)?(?:maternal\s+|paternal\s+)?grand(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return 'grandparent';
	}
	if (/^(?:adoptive\s+|step\s+)?(?:birth\s+)?(?:father|mother|parent)s?\s+of\b/i.test(raw)) {
		return 'parent';
	}
	if (/^(?:great[- ]?)?(?:uncle|aunt)s?\s+of\b/i.test(raw)) {
		return /great/i.test(raw) ? 'great_uncle_aunt' : 'uncle_aunt';
	}

	// Subject-is-X-of-peer → invert (role mentions the peer, or classic "Son of …").
	if (
		aboutPeer ||
		/^(?:great[- ]?)?(?:son|daughter|child|nephew|niece|grandson|granddaughter|grandchild)\s+of\b/i.test(raw)
	) {
		if (/^(?:great[- ]?)?grand(?:son|daughter|child)\s+of\b/i.test(raw)) {
			return /great/i.test(raw) ? 'great_grandparent' : 'grandparent';
		}
		if (/^(?:son|daughter|child)\s+of\b/i.test(raw)) return 'parent';
		if (/^(?:great[- ]?)?(?:nephew|niece)\s+of\b/i.test(raw)) {
			return /great/i.test(raw) ? 'great_uncle_aunt' : 'uncle_aunt';
		}
		if (/^cousins?\s+of\b/i.test(raw)) return 'cousin';
	}

	if (/great[- ]?grand(?:father|mother|parent)/i.test(r)) return 'great_grandparent';
	if (/\bgrandparents?\b|\bgrandfather\b|\bgrandmother\b|\bgrandpa\b|\bgrandma\b/.test(r)) return 'grandparent';
	if (/\bparents?\b|\bfather\b|\bmother\b|\bdad\b|\bmom\b|\badoptive\s+(?:father|mother|parent)\b/.test(r)) {
		return 'parent';
	}
	if (/\bgrandchildren\b|\bgrandson\b|\bgranddaughter\b/.test(r)) return 'grandchild';
	if (/\b(sons?|daughters?|children|child)\b/.test(r)) return 'child';
	if (/\bsiblings?\b|\bbrothers?\b|\bsisters?\b/.test(r)) return 'sibling';
	if (/\bgreat[- ]?uncles?\b|\bgreat[- ]?aunts?\b/.test(r)) return 'great_uncle_aunt';
	if (/\buncles?\b|\baunts?\b/.test(r)) return 'uncle_aunt';
	if (/\bnephews?\b|\bnieces?\b/.test(r)) return 'nephew_niece';
	if (/\bcousins?\b/.test(r)) return 'cousin';
	if (/\bin[- ]laws?\b|\bfather[- ]in[- ]law\b|\bmother[- ]in[- ]law\b|\bson[- ]in[- ]law\b|\bdaughter[- ]in[- ]law\b/.test(r)) {
		return 'in_law';
	}
	return 'other';
}

function compareFamilyNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Always-on ASCII family tree. Dynasty gen·branch layout when enough labels exist; otherwise kinship groups. */
function buildFamilyRelativeTreeRows(peers: FamilyRelativePeer[]): FamilyTreeRow[] | null {
	if (peers.length === 0) return null;

	const parsed = peers.map((peer) => {
		const { generation, branch } = parseFamilyRelativeRole(peer.role);
		return { peer, generation, branch, kinship: classifyFamilyKinship(peer.role, peer.name) };
	});
	const withGen = parsed.filter((p) => p.generation != null);

	/** Flat/grouped ASCII when dynasty structure is thin (< 2 generation labels). */
	const buildKinshipAsciiRows = (): FamilyTreeRow[] => {
		const rows: FamilyTreeRow[] = [];
		const byName = (a: (typeof parsed)[number], b: (typeof parsed)[number]) =>
			compareFamilyNames(a.peer.name, b.peer.name);
		const groups = FAMILY_KINSHIP_ORDER.map((g) => ({
			g,
			items: parsed.filter((p) => p.kinship === g).sort(byName),
		})).filter((x) => x.items.length > 0);

		const multiGroup = groups.length > 1;
		groups.forEach((group, gi) => {
			const groupLast = gi === groups.length - 1;
			if (multiGroup) {
				rows.push({
					kind: 'label',
					prefix: groupLast ? '└── ' : '├── ',
					text: FAMILY_KINSHIP_LABEL[group.g],
				});
			}
			const rail = multiGroup ? (groupLast ? '    ' : '│   ') : '';
			group.items.forEach((item, ii) => {
				const last = ii === group.items.length - 1;
				rows.push({
					kind: 'person',
					prefix: `${rail}${last ? '└── ' : '├── '}`,
					peer: item.peer,
					gen: item.generation,
				});
			});
		});
		return rows;
	};

	if (withGen.length < 2) {
		return buildKinshipAsciiRows();
	}

	const byName = (a: (typeof parsed)[number], b: (typeof parsed)[number]) => compareFamilyNames(a.peer.name, b.peer.name);
	const gen1 = parsed.filter((p) => p.generation === 1).sort(byName);
	const gen2 = parsed.filter((p) => p.generation === 2).sort(byName);
	const gen3 = parsed.filter((p) => p.generation === 3).sort(byName);
	const deeper = parsed.filter((p) => (p.generation ?? 0) >= 4);

	const branchOrder: string[] = [];
	for (const g of gen3) {
		if (g.branch && !branchOrder.includes(g.branch)) branchOrder.push(g.branch);
	}
	for (const g of deeper) {
		if (g.branch && !branchOrder.includes(g.branch)) branchOrder.push(g.branch);
	}

	const rows: FamilyTreeRow[] = [];
	const pushPerson = (prefix: string, item: (typeof parsed)[number]) => {
		rows.push({ kind: 'person', prefix, peer: item.peer, gen: item.generation });
	};
	const pushLabel = (prefix: string, text: string) => {
		rows.push({ kind: 'label', prefix, text });
	};

	const branchBodies = (branch: string) => {
		const g4 = deeper.filter((p) => p.generation === 4 && p.branch === branch).sort(byName);
		const g5 = deeper.filter((p) => (p.generation ?? 0) >= 5 && p.branch === branch).sort(byName);
		return { g4, g5 };
	};

	const renderBranch = (branch: string, rail: string, isLastBranch: boolean) => {
		const head = gen3.find((p) => p.branch === branch) || null;
		const { g4, g5 } = branchBodies(branch);
		const branchTee = isLastBranch ? '└── ' : '├── ';
		const branchRail = `${rail}${isLastBranch ? '    ' : '│   '}`;

		if (head) {
			pushPerson(`${rail}${branchTee}`, head);
		} else {
			pushLabel(`${rail}${branchTee}`, branch || 'Other');
		}

		const hasG4 = g4.length > 0;
		const hasG5 = g5.length > 0;
		if (hasG4) {
			const g4Last = !hasG5;
			pushLabel(`${branchRail}${g4Last ? '└── ' : '├── '}`, 'Gen 4');
			const g4Rail = `${branchRail}${g4Last ? '    ' : '│   '}`;
			g4.forEach((p, i) => {
				const last = i === g4.length - 1;
				pushPerson(`${g4Rail}${last ? '└── ' : '├── '}`, p);
			});
		}
		if (hasG5) {
			pushLabel(`${branchRail}└── `, `Gen ${Math.min(...g5.map((p) => p.generation || 5))}`);
			const g5Rail = `${branchRail}    `;
			g5.forEach((p, i) => {
				const last = i === g5.length - 1;
				pushPerson(`${g5Rail}${last ? '└── ' : '├── '}`, p);
			});
		}
	};

	const renderBranchesUnder = (rail: string) => {
		if (branchOrder.length === 0) return;
		branchOrder.forEach((branch, i) => {
			renderBranch(branch, rail, i === branchOrder.length - 1);
		});
	};

	// Prefer Gen1 → Gen2 → branches when those links exist.
	// Tee marks are among siblings only; descendants nest under the last sibling’s rail.
	if (gen1.length > 0) {
		gen1.forEach((g1, gi) => {
			const g1Last = gi === gen1.length - 1;
			pushPerson(`${g1Last ? '└── ' : '├── '}`, g1);
			const g1Rail = g1Last ? '    ' : '│   ';
			if (!g1Last) return;
			if (gen2.length > 0) {
				gen2.forEach((g2, g2i) => {
					const g2Last = g2i === gen2.length - 1;
					pushPerson(`${g1Rail}${g2Last ? '└── ' : '├── '}`, g2);
					if (g2Last) renderBranchesUnder(`${g1Rail}${g2Last ? '    ' : '│   '}`);
				});
			} else {
				renderBranchesUnder(g1Rail);
			}
		});
	} else if (gen2.length > 0) {
		gen2.forEach((g2, g2i) => {
			const g2Last = g2i === gen2.length - 1;
			pushPerson(`${g2Last ? '└── ' : '├── '}`, g2);
			if (g2Last) renderBranchesUnder(g2Last ? '    ' : '│   ');
		});
	} else {
		renderBranchesUnder('');
	}

	// Orphans: generation labeled but unmatched branch, or no generation.
	const placed = new Set(
		rows.filter((r): r is Extract<FamilyTreeRow, { kind: 'person' }> => r.kind === 'person').map((r) => r.peer.id),
	);
	const orphans = parsed.filter((p) => !placed.has(p.peer.id)).sort(byName);
	if (orphans.length > 0) {
		const needHeader = rows.length > 0;
		if (needHeader) pushLabel('├── ', 'Other relatives');
		orphans.forEach((p, i) => {
			const last = i === orphans.length - 1;
			const rail = needHeader ? '│   ' : '';
			pushPerson(`${rail}${last ? '└── ' : '├── '}`, p);
		});
	}

	return rows.length > 0 ? rows : null;
}

function FamilyRelativesTree({
	peers,
	onJump,
	subject,
}: {
	peers: FamilyRelativePeer[];
	onJump: (id: string) => void;
	/** Optional subject root so life years (incl. ended/disabled) show above the tree. */
	subject?: { id: string; name: string; startDate?: string | null; endDate?: string | null } | null;
}): ReactNode {
	const rows = buildFamilyRelativeTreeRows(peers);
	if (!rows) {
		return (
			<div className='mt-1 flex flex-wrap gap-x-2 gap-y-1 leading-snug'>
				{peers.map((peer) => (
					<span
						key={peer.id}
						className='inline-flex flex-wrap items-baseline gap-1'>
						<button
							type='button'
							onClick={() => onJump(peer.id)}
							className='cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold text-[#F97316] underline'>
							{peer.name}
						</button>
						{peer.role ?
							<span className='text-[10px] opacity-70'>
								({formatFamilyPeerRoleLabel(peer.role, peer.name, peer.gender) || peer.role})
							</span>
						:	null}
					</span>
				))}
			</div>
		);
	}

	const subjectYears = subject ? formatTreeYearSpan(subject.startDate, subject.endDate) : null;
	const subjectInactive = subject ? peerIsInactive(subject) : false;

	return (
		<div className='mt-1 min-w-0 overflow-hidden rounded border border-rose-500/20 bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-snug'>
			{subject ?
				<div className={`mb-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 ${subjectInactive ? 'opacity-55' : ''}`}>
					<span
						className={
							subjectInactive ?
								'min-w-0 break-words font-semibold text-zinc-400'
							:	'min-w-0 break-words font-semibold text-rose-100/90'
						}>
						{subject.name}
					</span>
					{subjectYears ?
						<span className={`shrink-0 text-[10px] ${subjectInactive ? 'text-zinc-500' : 'text-rose-100/45'}`}>{subjectYears}</span>
					:	null}
				</div>
			:	null}
			{rows.map((row, i) => {
				if (row.kind === 'label') {
					return (
						<div
							key={`lbl-${i}`}
							className='flex min-w-0 text-rose-100/55'>
							<span className='shrink-0 whitespace-pre text-rose-200/40'>{row.prefix}</span>
							<span className='min-w-0 break-words'>{row.text}</span>
						</div>
					);
				}
				const kinshipRole = formatFamilyPeerRoleLabel(row.peer.role, row.peer.name, row.peer.gender);
				const shortRole =
					row.gen != null ?
						`Gen ${row.gen}${row.peer.role && row.gen <= 3 ? ` · ${parseFamilyRelativeRole(row.peer.role).branch}` : ''}`
					:	kinshipRole;
				const years = formatTreeYearSpan(row.peer.startDate, row.peer.endDate);
				const inactive = peerIsInactive(row.peer);
				return (
					<div
						key={row.peer.id}
						className={`flex min-w-0 items-start ${inactive ? 'opacity-55' : ''}`}>
						<span className='shrink-0 whitespace-pre text-rose-200/40'>{row.prefix}</span>
						<div className='min-w-0 flex-1 break-words'>
							<button
								type='button'
								onClick={() => onJump(row.peer.id)}
								className={
									inactive ?
										'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-zinc-400 underline decoration-zinc-500/60'
									:	'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-[#F97316] underline'
								}>
								{row.peer.name}
							</button>
							{years ?
								<span className={`text-[10px] ${inactive ? 'text-zinc-500' : 'text-rose-100/45'}`}>{`  ${years}`}</span>
							:	null}
							{shortRole ?
								<span className={`text-[10px] ${inactive ? 'text-zinc-500' : 'text-rose-100/50'}`}>{`  [${shortRole}]`}</span>
							:	null}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** ASCII ownership tree from expanded FirmOwnershipGroup (parent root + all subsidiaries). */
function FirmOwnershipTree({
	group,
	onJump,
}: {
	group: FirmOwnershipGroup;
	onJump: (id: string) => void;
}): ReactNode {
	const subsidiaries = [...group.subsidiaries].sort(compareTreePeersByRecentYear);
	if (!subsidiaries.length && group.root.id === group.currentProfileId) return null;

	const rootYears = formatTreeYearSpan(group.root.startDate, group.root.endDate);
	const rootInactive = peerIsInactive(group.root);
	const rootIsCurrent = group.root.id === group.currentProfileId;

	return (
		<div className='mt-1 min-w-0 overflow-hidden rounded border border-sky-500/20 bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-snug'>
			<div className={`mb-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 ${rootInactive ? 'opacity-55' : ''}`}>
				{rootIsCurrent ?
					<span
						className={
							rootInactive ?
								'min-w-0 break-words font-semibold text-zinc-400'
							:	'min-w-0 break-words font-semibold text-sky-100/90'
						}>
						{group.root.name}
					</span>
				:	<button
						type='button'
						onClick={() => onJump(group.root.id)}
						className={
							rootInactive ?
								'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-zinc-400 underline decoration-zinc-500/60'
							:	'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-[#F97316] underline'
						}>
						{group.root.name}
					</button>
				}
				{rootYears ?
					<span className={`shrink-0 text-[10px] ${rootInactive ? 'text-zinc-500' : 'text-sky-100/45'}`}>{rootYears}</span>
				:	null}
			</div>
			{subsidiaries.map((peer, ii) => {
				const last = ii === subsidiaries.length - 1;
				const prefix = last ? '└── ' : '├── ';
				const years = formatTreeYearSpan(peer.startDate, peer.endDate);
				const inactive = peerIsInactive(peer);
				const isCurrent = peer.id === group.currentProfileId;
				return (
					<div
						key={peer.id}
						className={`flex min-w-0 items-start ${inactive && !isCurrent ? 'opacity-55' : ''}`}>
						<span className='shrink-0 whitespace-pre text-sky-200/40'>{prefix}</span>
						<div className='min-w-0 flex-1 break-words'>
							{isCurrent ?
								<span
									className={
										inactive ?
											'min-w-0 break-words font-semibold text-zinc-300'
										:	'min-w-0 break-words font-semibold text-sky-100/90'
									}>
									{peer.name}
								</span>
							:	<button
									type='button'
									onClick={() => onJump(peer.id)}
									className={
										inactive ?
											'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-zinc-400 underline decoration-zinc-500/60'
										:	'cursor-pointer break-words border-0 bg-transparent p-0 text-left font-mono text-[11px] font-semibold text-[#F97316] underline'
									}>
									{peer.name}
								</button>
							}
							{years ?
								<span className={`text-[10px] ${inactive ? 'text-zinc-500' : 'text-sky-100/45'}`}>{`  ${years}`}</span>
							:	null}
							{peer.role ?
								<span className={`text-[10px] ${inactive ? 'text-zinc-500' : 'text-sky-100/50'}`}>{`  [${peer.role}]`}</span>
							:	null}
						</div>
					</div>
				);
			})}
		</div>
	);
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
		case 'ownershipHierarchy':
			return 'border-sky-500/35 bg-sky-500/10';
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
	'eu': 'European Union',
	'un': 'United Nations',
	'xk': 'Kosovo',
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

/** Compact display / input canonical form: MM-DD-YYYY (partial → MM-YYYY or YYYY). */
function formatDisplayDateShort(iso?: string | null): string {
	const raw = String(iso || '').trim();
	if (!raw) return '';
	const parsed = normalizeIsoDate(raw).date || raw;
	const ymd = parsed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (ymd) return `${ymd[2]}-${ymd[3]}-${ymd[1]}`;
	const us = parsed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
	if (us) {
		return `${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}-${us[3]}`;
	}
	const ym = parsed.match(/^(\d{4})-(\d{2})$/);
	if (ym) return `${ym[2]}-${ym[1]}`;
	const y = parsed.match(/^(\d{4})$/);
	if (y) return y[1];
	return raw;
}

/** Spacious display: November 26, 2026 / November 2026 / 2026. */
function formatDisplayDateLong(iso?: string | null): string {
	const raw = String(iso || '').trim();
	if (!raw) return '';
	const parsed = normalizeIsoDate(raw).date || raw;
	const ymd = parsed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (ymd) {
		const month = Number(ymd[2]);
		const day = Number(ymd[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return `${DISPLAY_MONTH_NAMES[month - 1]} ${day}, ${ymd[1]}`;
		}
	}
	const us = parsed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
	if (us) {
		const month = Number(us[1]);
		const day = Number(us[2]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return `${DISPLAY_MONTH_NAMES[month - 1]} ${day}, ${us[3]}`;
		}
	}
	const ym = parsed.match(/^(\d{4})-(\d{2})$/);
	if (ym) {
		const month = Number(ym[2]);
		if (month >= 1 && month <= 12) return `${DISPLAY_MONTH_NAMES[month - 1]} ${ym[1]}`;
	}
	const mmYyyy = parsed.match(/^(\d{2})-(\d{4})$/);
	if (mmYyyy) {
		const month = Number(mmYyyy[1]);
		if (month >= 1 && month <= 12) return `${DISPLAY_MONTH_NAMES[month - 1]} ${mmYyyy[2]}`;
	}
	const y = parsed.match(/^(\d{4})$/);
	if (y) return y[1];
	return formatDisplayDateShort(raw) || raw;
}

/** Default string helper: compact MM-DD-YYYY (inputs, titles, fallbacks). */
function formatDisplayDate(iso?: string | null): string {
	return formatDisplayDateShort(iso);
}

/** Normalize typed date input to MM-DD-YYYY when parseable (keeps MMDDYYYY / long names accepted). */
function formatDateDraftOnBlur(raw: string): string {
	const trimmed = String(raw || '').trim();
	if (!trimmed) return '';
	const iso = normalizeIsoDate(trimmed).date;
	if (!iso) return trimmed;
	return formatDisplayDateShort(iso) || trimmed;
}

function sameProfileDate(a?: string | null, b?: string | null): boolean {
	const na = normalizeIsoDate(String(a || '').trim()).date || String(a || '').trim() || null;
	const nb = normalizeIsoDate(String(b || '').trim()).date || String(b || '').trim() || null;
	return na === nb;
}

/** Responsive date: long form from `sm` up, compact MM-DD-YYYY on narrow viewports. */
function ProfileDate({ iso, className }: { iso?: string | null; className?: string }) {
	const short = formatDisplayDateShort(iso);
	const long = formatDisplayDateLong(iso);
	if (!short && !long) return null;
	if (!long || long === short) return <span className={className}>{short || long}</span>;
	return (
		<span className={className}>
			<span className='sm:hidden'>{short}</span>
			<span className='hidden sm:inline'>{long}</span>
		</span>
	);
}

const SUMMARY_MONTH_NAMES = DISPLAY_MONTH_NAMES;

/** Summary-section only: November 22, 2026 / June 2026 / 1995 – 1999 / October 2008 – present. */
function formatSummaryDatePart(part: string): string {
	const s = String(part || '').trim();
	if (!s) return '';
	if (/^present$/i.test(s)) return 'present';
	const long = formatDisplayDateLong(s);
	if (long && long !== s) return long;
	const seasonYear = s.match(/^(Spring|Summer|Fall|Autumn|Winter)\s+((?:1[6-9]|20)\d{2})$/i);
	if (seasonYear) return `${seasonYear[1]} ${seasonYear[2]}`;
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
		const yearRange = raw.match(/^((?:1[6-9]|20)\d{2})\s*-\s*((?:1[6-9]|20)\d{2}|present|Present)$/i);
		if (yearRange) {
			formatted = `${formatSummaryDatePart(yearRange[1])} – ${formatSummaryDatePart(yearRange[2])}`;
		} else {
			const mmYyyyRange = raw.match(/^(\d{2}-(?:1[6-9]|20)\d{2})\s*-\s*((?:1[6-9]|20)\d{2}|\d{2}-(?:1[6-9]|20)\d{2}|present|Present)$/i);
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
	return formatDisplayDateShort(iso);
}

function formatMonthYear(iso?: string | null): string {
	return formatDisplayDateShort(iso);
}

function buildDateSpanText(
	formatOne: (iso?: string | null) => string,
	startDate?: string | null,
	endDate?: string | null,
	isCurrent?: boolean | null,
	opts?: { employedSince?: boolean; isEducation?: boolean },
): string | null {
	const s = formatOne(startDate);
	const e = formatOne(endDate);
	if (s && e) return s === e ? s : `${s} → ${e}`;
	if (s) {
		if (opts?.employedSince) {
			return (
				isCurrent === true ? `Employed since ${s}`
				: isCurrent === false ? s
				: `${s} → Present`
			);
		}
		return isCurrent === false ? s : `${s} → Present`;
	}
	if (e) return opts?.isEducation ? `Grad. ${e}` : `Ended ${e}`;
	return null;
}

function formatEmploymentDateSpan(startDate?: string | null, endDate?: string | null, isCurrent?: boolean | null): string | null {
	return buildDateSpanText(formatDisplayDateShort, startDate, endDate, isCurrent, { employedSince: true });
}

function formatDateSpan(startDate?: string | null, endDate?: string | null, isCurrent?: boolean | null, isEducation?: boolean): string | null {
	return buildDateSpanText(formatDisplayDateShort, startDate, endDate, isCurrent, { isEducation });
}

/** Responsive span text for employment / education / connected-event chips. */
function ProfileDateSpanText({
	startDate,
	endDate,
	isCurrent,
	isEducation,
	employedSince,
	className,
}: {
	startDate?: string | null;
	endDate?: string | null;
	isCurrent?: boolean | null;
	isEducation?: boolean;
	employedSince?: boolean;
	className?: string;
}) {
	const short = buildDateSpanText(formatDisplayDateShort, startDate, endDate, isCurrent, { employedSince, isEducation });
	const long = buildDateSpanText(formatDisplayDateLong, startDate, endDate, isCurrent, { employedSince, isEducation });
	if (!short && !long) return null;
	if (!long || long === short) return <span className={className}>{short || long}</span>;
	return (
		<span className={className}>
			<span className='sm:hidden'>{short}</span>
			<span className='hidden sm:inline'>{long}</span>
		</span>
	);
}

const SUMMARY_YEAR_TOKEN =
	'(?:1[6-9]|20)\\d{2}(?:\\s*[–—-]\\s*(?:(?:1[6-9]|20)\\d{2}|present|Present))?|\\d{4}-\\d{2}-\\d{2}|\\d{2}-\\d{2}-\\d{4}|\\d{2}-\\d{4}(?:\\s*[–—-]\\s*(?:(?:1[6-9]|20)\\d{2}|\\d{2}-\\d{4}|present|Present))?|\\d{4}-\\d{2}(?:\\s*[–—-]\\s*(?:(?:1[6-9]|20)\\d{2}|\\d{4}-\\d{2}|present|Present))?';
const SUMMARY_YEAR_RE = new RegExp(`\\b(?:${SUMMARY_YEAR_TOKEN})\\b`, 'g');
const SUMMARY_YEAR_CONNECTOR_RE = /(?:In|From|During|By|Until|Since|After|Before)\s+$/i;
const SUMMARY_HEADING_RE = /^#{1,3}\s+(.+)$/;
const SUMMARY_BULLET_RE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;
// Prefer full dates (YYYY-MM-DD / MM-DD-YYYY) before bare years so
// "2025-06-09 — …" does not split into date=2025 + text="06-09 — …".
const SUMMARY_DATED_BULLET_RE =
	/^(?:\*\*)?((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:1[6-9]|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:1[6-9]|20)\d{2}|(?:Spring|Summer|Fall|Autumn|Winter)\s+(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}-\d{2}|\d{2}-\d{2}-(?:1[6-9]|20)\d{2}|(?:1[6-9]|20)\d{2}-\d{2}(?:-\d{2})?\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}-\d{2}(?:-\d{2})?|present|Present)|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?\s*[–—-]\s*(?:(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|present|Present)|(?:1[6-9]|20)\d{2}\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}|present|Present)|(?:1[6-9]|20)\d{2}-\d{2}|\d{2}-(?:1[6-9]|20)\d{2}|(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|(?:1[6-9]|20)\d{2}\+|(?:1[6-9]|20)\d{2})(?:\*\*)?\s*[—–:\-]\s*(.+)$/i;
const SUMMARY_TITLED_BULLET_RE = /^\*\*([^*]+)\*\*\s*[—–:\-]\s*(.+)$/;
const SUMMARY_URL_RE = /^(https?:\/\/\S+)$/i;

/** Pull trailing `Source(s): research-drive/…` off claim text (no trailing period). */
function splitTrailingResearchDriveCitation(text: string): { body: string; citation: string | null } {
	const raw = String(text || '').trim();
	if (!raw) return { body: '', citation: null };
	const m = raw.match(/^(.*?)\s+((?:_*)?(?:Sources?):\s*research-drive\/[^\n_]+?)(?:_*)\.?\s*$/is);
	if (!m || !m[1]?.trim()) return { body: raw, citation: null };
	const citation = m[2]
		.replace(/^_+|_+$/g, '')
		.replace(/\.\s*$/, '')
		.trim();
	return { body: m[1].trim(), citation: citation || null };
}

/** Style research-drive source citations italic + teal inside markdown HTML. */
function styleResearchDriveCitationsInHtml(html: string): string {
	return String(html || '').replace(
		/((?:Sources?):\s*research-drive\/[^<]+?)(\.?)/gi,
		(_m, cite: string, _dot: string) =>
			`<span class="italic text-teal-300/85">${cite.replace(/\.\s*$/, '').trim()}</span>`,
	);
}

function SummaryMarkdown({
	text,
	inline = false,
	className,
}: {
	text: string;
	inline?: boolean;
	className?: string;
}) {
	// Do not auto-bold year/date tokens inside summary prose — timeline rail date
	// chips already carry the date styling via summaryTimelineDateLabel.
	const html = styleResearchDriveCitationsInHtml(summaryMarkdownToHtml(String(text || ''), { inline }));
	if (!html) return null;
	if (inline) {
		return (
			<span
				className={className}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}
	return (
		<div
			className={className}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function TimelineEntryMarkdown({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const { body, citation } = splitTrailingResearchDriveCitation(text);
	return (
		<div className={className}>
			{body ?
				<SummaryMarkdown
					text={body}
					inline
					className='block text-[12px] leading-relaxed text-white/90'
				/>
			:	null}
			{citation ?
				<div className='mt-0.5 text-[11px] italic leading-snug text-teal-300/85'>{citation}</div>
			:	null}
		</div>
	);
}

/**
 * Drop pronunciation / phonetic guides from overview summaries.
 * Keeps birth/death parentheticals: "Name ( / tiːl /; born 1967)" → "Name (born 1967)".
 * http(s) URLs are masked first so path segments like /news/ or /content/ are not treated as phonetics.
 */
function stripPronunciationGuides(text: string): string {
	const src = String(text || '');
	const fences: string[] = [];
	// Preserve fenced ASCII / code blocks (family trees) before space collapsing.
	const withFencesMasked = src.replace(/```[\s\S]*?```/g, (block) => {
		const token = `__FENCE_PH${fences.length}__`;
		fences.push(block);
		return token;
	});
	const urls: string[] = [];
	const masked = withFencesMasked.replace(/https?:\/\/[^\s)]+/gi, (url) => {
		const token = `__URL_PH${urls.length}__`;
		urls.push(url);
		return token;
	});
	let out = masked
		// Labels only — do not drop the whole parenthetical (birth dates live there too).
		.replace(/\b(?:pronounced|pronunciation|IPA)\s*[:–—-]?\s*/gi, '')
		// Slash phonetics after space/paren only (keeps owner/design/utility path-style phrases).
		// Includes spaced letters: /tiːl/ or / t iː l /
		.replace(/(^|[\s(])\/\s*[^/\n.]{1,48}?\//g, '$1')
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
	for (let i = 0; i < urls.length; i++) {
		out = out.replace(`__URL_PH${i}__`, urls[i]);
	}
	for (let i = 0; i < fences.length; i++) {
		out = out.replace(`__FENCE_PH${i}__`, fences[i]);
	}
	return out;
}

const SUMMARY_LABEL_RE = /^(?:\*\*)?([^*:\n]{1,48})(?:\*\*)?\s*:\s*(.+)$/;
const SUMMARY_DISCLAIMER_RE = /(?:appearance in this curated|does not allege|does not imply|records public|disclaimer|appearing in .{0,40}does not)/i;

/** True when SUMMARY_LABEL_RE split a clock time ("Born 3" + "15 PM…") instead of a field label. */
function isClockTimeColonSplit(label: string, value: string): boolean {
	const lab = String(label || '')
		.replace(/\*\*/g, '')
		.trim();
	const val = String(value || '').trim();
	if (!lab || !val) return false;
	// Label ends with hour digits; value continues minutes (and optional seconds / AM|PM).
	if (!/\d{1,2}$/.test(lab)) return false;
	return /^\d{2}(?::\d{2})?(?:\s*(?:AM|PM|a\.m\.|p\.m\.))?\b/i.test(val);
}

type SummaryTimelineEntry = { date: string; text: string; sourceTag?: string | null };
type SummaryBulletEntry = { title?: string | null; text: string; href?: string | null };

type SummaryBlock =
	| { kind: 'grid'; rows: Array<{ label: string; value: string }> }
	| { kind: 'year'; year: string; text: string }
	| { kind: 'heading'; text: string; level?: number }
	| { kind: 'timeline'; entries: SummaryTimelineEntry[] }
	| { kind: 'bullets'; entries: SummaryBulletEntry[] }
	| { kind: 'prose'; text: string }
	| { kind: 'pre'; text: string }
	| { kind: 'disclaimer'; text: string }
	| { kind: 'citation'; text: string };

const OVERVIEW_PRIORITY_SECTION_RE =
	/^(timeline|chronolog|milestones?|key dates|history|linked region|dual-node|see also|related)\b/i;

function isOverviewTimelineHeading(text: string | null | undefined): boolean {
	return /^(timeline|chronolog|milestones?|key dates)\b/i.test(String(text || '').trim());
}

/** Pull ## Timeline (+ following body until next ##) up under the lead prose so dense dossiers stay scannable. */
function promoteOverviewTimeline(items: SummaryBlock[]): SummaryBlock[] {
	let start = -1;
	for (let i = 0; i < items.length; i++) {
		const b = items[i];
		if ((b.kind === 'heading' && isOverviewTimelineHeading(b.text)) || b.kind === 'timeline') {
			start = i;
			break;
		}
	}
	if (start <= 0) return items;

	let end = start + 1;
	while (end < items.length) {
		const b = items[end];
		if (b.kind === 'heading' && (b.level ?? 2) <= 2) break;
		if (
			b.kind === 'timeline' ||
			b.kind === 'prose' ||
			b.kind === 'bullets' ||
			b.kind === 'disclaimer' ||
			b.kind === 'grid' ||
			(b.kind === 'heading' && (b.level ?? 2) >= 3)
		) {
			end += 1;
			continue;
		}
		break;
	}

	let insertAt = 0;
	while (
		insertAt < items.length &&
		(items[insertAt].kind === 'prose' || items[insertAt].kind === 'disclaimer')
	) {
		insertAt += 1;
	}
	if (insertAt >= start) return items;

	const chunk = items.slice(start, end);
	const without = [...items.slice(0, start), ...items.slice(end)];
	return [...without.slice(0, insertAt), ...chunk, ...without.slice(insertAt)];
}

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
	// Only when the paren closes at/near end of the string — mid-sentence citations
	// like "(Construction Dive, 2026-11-24). Fact-checked…" stay inline prose.
	if (years.length === 0 && allYears.length === 1) {
		const y = allYears[0];
		const open = src.lastIndexOf('(', y.index);
		const close = src.indexOf(')', y.index);
		const afterClose = close >= 0 ? src.slice(close + 1).trim() : '';
		const trailingOk = afterClose === '' || /^[.;,!?]["'\u201c\u201d]?$/.test(afterClose);
		if (
			open >= 0 &&
			close > y.index &&
			trailingOk &&
			!src.slice(open + 1, y.index).includes(')')
		) {
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
	const trailing = src
		.slice(cursor)
		.trim()
		.replace(/^[,;:\-\u2013\u2014\s]+/, '')
		.trim();
	if (trailing) blocks.push({ kind: 'prose', text: trailing });
	if (!blocks.some((b) => b.kind === 'year')) return [{ kind: 'prose', text: src }];
	return blocks;
}

function normalizeSummaryMarkup(text: string): string {
	return (
		String(text || '')
			// Turn `* **1945** adopted…` into `* 1945: adopted…` so bold-year bullets without punctuation stay dated timeline entries.
			.replace(
				new RegExp(`^([\\t ]*(?:[-*•]|\\d+[.)])\\s+)\\*\\*(${SUMMARY_YEAR_TOKEN})\\*\\*\\s+(?![—–:\\-])`, 'gm'),
				'$1$2: ',
			)
			// Turn **1919**: / **1919–1920**: into plain year labels for sectioning.
			.replace(new RegExp(`\\*\\*(${SUMMARY_YEAR_TOKEN})\\*\\*\\s*:`, 'g'), '$1:')
			.replace(new RegExp(`\\*\\*(${SUMMARY_YEAR_TOKEN})\\*\\*`, 'g'), '$1')
			// Drop orphan ** left after year unwraps; keep **phrase** markers for bolding.
			.replace(/(^|\s)\*\*(?=\s|$)/gm, '$1')
			.replace(/(?<=\s)\*\*(\s|$)/gm, '$1')
			.trim()
	);
}

function splitSourceTag(text: string): { body: string; sourceTag: string | null } {
	const m = String(text || '').match(/^(.*?)(?:\s*\[([^\]]{1,64})\])\s*$/);
	if (!m) return { body: String(text || '').trim(), sourceTag: null };
	return { body: m[1].trim(), sourceTag: m[2].trim() || null };
}

function extractTrailingUrl(text: string): { body: string; href: string | null } {
	const m = String(text || '').match(/^(.*?)(?:\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+))\s*$/i);
	if (!m) return { body: String(text || '').trim(), href: null };
	return { body: (m[1] || '').trim().replace(/[—–\-\s]+$/g, '').trim(), href: m[2] || m[3] || null };
}

/** True when a timeline bold label is a real date (not a claim title like "SSA announces COLA"). */
function looksLikeSummaryDateLabel(raw: string | null | undefined): boolean {
	const s = String(raw || '')
		.replace(/\*\*/g, '')
		.trim();
	if (!s || /^undated$/i.test(s)) return false;
	if (/^(?:1[6-9]|20)\d{2}(?:-\d{2}(?:-\d{2})?)?$/.test(s)) return true;
	// Decade / open-ended labels used on region synthesis rails (2020s, 2011+, 1980s–2000s).
	if (/^(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s$/i.test(s)) return true;
	if (/^(?:1[6-9]|20)\d{2}\+$/.test(s)) return true;
	if (
		/^(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?\s*[–—-]\s*(?:(?:(?:Late|Early|Mid)(?:-|\s+))?(?:1[6-9]|20)\d{2}s?|present|Present)$/i.test(
			s,
		)
	) {
		return true;
	}
	if (/^\d{2}-\d{2}-(?:1[6-9]|20)\d{2}$/.test(s)) return true;
	if (/^(?:1[6-9]|20)\d{2}\s*[–—-]\s*(?:(?:1[6-9]|20)\d{2}|present)$/i.test(s)) return true;
	// Historical / BCE years used on region corridors (122 BCE, 1669, 1693).
	if (/^\d{3,4}(?:\s*(?:BCE|BC|CE|AD))?$/i.test(s)) return true;
	if (/^\d{3,4}\s*[–—-]\s*(?:\d{3,4}|present|Present)$/i.test(s)) return true;
	if (
		/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:1[6-9]|20)\d{2}$/i.test(
			s,
		)
	) {
		return true;
	}
	// Month + year without day (October 2023) — common on sparse project timelines.
	if (
		/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:1[6-9]|20)\d{2}$/i.test(
			s,
		)
	) {
		return true;
	}
	// Season + year (Spring 2025 / Fall 2026).
	if (/^(?:Spring|Summer|Fall|Autumn|Winter)\s+(?:1[6-9]|20)\d{2}$/i.test(s)) return true;
	// Geological epoch labels on region timelines (Miocene–Recent, Neogene–Present).
	if (
		/^(?:Early|Middle|Late|Lower|Upper)?\s*(?:Cambrian|Ordovician|Silurian|Devonian|Carboniferous|Permian|Triassic|Jurassic|Cretaceous|Paleogene|Neogene|Quaternary|Miocene|Pliocene|Pleistocene|Holocene|Precambrian|Mesoproterozoic|Paleoproterozoic)(?:\s*[–—-]\s*(?:Recent|Present|[A-Za-z]+))?$/i.test(
			s,
		)
	) {
		return true;
	}
	return false;
}

/** Prefer a date found in copy; otherwise use the source/publication date on the profile. */
function resolveSummaryTimelineDate(
	raw: string | null | undefined,
	sourceDate: string | null | undefined,
): string {
	if (looksLikeSummaryDateLabel(raw)) return String(raw).replace(/\*\*/g, '').trim();
	if (sourceDate && String(sourceDate).trim()) return String(sourceDate).trim();
	return 'Undated';
}

function parseSummaryBlocks(text: string, opts?: { sourceDate?: string | null }): SummaryBlock[] {
	const sourceDate = opts?.sourceDate ?? null;
	const cleaned = normalizeSummaryMarkup(stripPronunciationGuides(text));
	// Keep blank lines only as separators; preserve markdown headings / bullets.
	// Raw lines (not pre-trimmed) so fenced ASCII trees keep indentation.
	const rawLines = cleaned.split(/\n/);
	const blocks: SummaryBlock[] = [];
	let gridRows: Array<{ label: string; value: string }> = [];
	let timelineEntries: SummaryTimelineEntry[] = [];
	let bulletEntries: SummaryBulletEntry[] = [];
	let sectionKind: 'general' | 'timeline' | 'bullets' = 'general';

	const flushGrid = () => {
		if (gridRows.length === 0) return;
		blocks.push({ kind: 'grid', rows: gridRows });
		gridRows = [];
	};
	const flushTimeline = () => {
		if (timelineEntries.length === 0) return;
		blocks.push({ kind: 'timeline', entries: timelineEntries });
		timelineEntries = [];
	};
	const flushBullets = () => {
		if (bulletEntries.length === 0) return;
		blocks.push({ kind: 'bullets', entries: bulletEntries });
		bulletEntries = [];
	};
	const flushCollections = () => {
		flushGrid();
		flushTimeline();
		flushBullets();
	};

	for (let li = 0; li < rawLines.length; li++) {
		const trimmedOpen = rawLines[li].trim();
		if (/^```/.test(trimmedOpen)) {
			flushCollections();
			const fenceBody: string[] = [];
			li += 1;
			while (li < rawLines.length && !/^```/.test(rawLines[li].trim())) {
				fenceBody.push(rawLines[li]);
				li += 1;
			}
			blocks.push({ kind: 'pre', text: fenceBody.join('\n').replace(/^\n+|\n+$/g, '') });
			continue;
		}

		let line = trimmedOpen;
		if (!line || /^[-*_]{3,}$/.test(line)) continue;

		let trailingDisclaimer: string | null = null;
		const discIdx = line.search(SUMMARY_DISCLAIMER_RE);
		if (discIdx === 0) {
			flushCollections();
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
				flushCollections();
				blocks.push({ kind: 'disclaimer', text: trailingDisclaimer });
			}
			continue;
		}

		const heading = line.match(SUMMARY_HEADING_RE);
		if (heading) {
			flushCollections();
			const hashes = (line.match(/^#+/) || ['#'])[0];
			const level = Math.min(3, Math.max(1, hashes.length));
			const title = heading[1].replace(/^\*\*|\*\*$/g, '').trim();
			blocks.push({ kind: 'heading', text: title, level });
			const lower = title.toLowerCase();
			if (/timeline|chronolog|milestones?|key dates|history/.test(lower)) sectionKind = 'timeline';
			else if (/wikipedia|sources?|references?|further reading|cross-?check/.test(lower)) sectionKind = 'bullets';
			else sectionKind = 'general';
			continue;
		}

		const bullet = line.match(SUMMARY_BULLET_RE);
		if (bullet) {
			flushGrid();
			const body = bullet[1].trim();
			const dated = body.match(SUMMARY_DATED_BULLET_RE);
			if (dated || sectionKind === 'timeline') {
				flushBullets();
				if (dated) {
					const split = splitSourceTag(dated[2]);
					timelineEntries.push({
						date: resolveSummaryTimelineDate(dated[1], sourceDate),
						text: split.body,
						sourceTag: split.sourceTag,
					});
				} else {
					const titled = body.match(SUMMARY_TITLED_BULLET_RE);
					const split = splitSourceTag(titled ? titled[2] : body);
					const bold = titled ? titled[1].trim() : '';
					if (looksLikeSummaryDateLabel(bold)) {
						timelineEntries.push({
							date: resolveSummaryTimelineDate(bold, sourceDate),
							text: split.body,
							sourceTag: split.sourceTag,
						});
					} else {
						// Claim title without a date in copy → use source/publication date; keep title in text.
						const claim = bold ? `${bold}${split.body ? ` — ${split.body}` : ''}` : split.body;
						timelineEntries.push({
							date: resolveSummaryTimelineDate(null, sourceDate),
							text: claim,
							sourceTag: split.sourceTag,
						});
					}
				}
			} else if (SUMMARY_URL_RE.test(body)) {
				flushTimeline();
				bulletEntries.push({ text: body, href: body });
			} else {
				flushTimeline();
				const titled = body.match(SUMMARY_TITLED_BULLET_RE);
				if (titled) {
					const extracted = extractTrailingUrl(titled[2]);
					bulletEntries.push({
						title: titled[1].trim(),
						text: extracted.body || extracted.href || '',
						href: extracted.href,
					});
				} else {
					const extracted = extractTrailingUrl(body);
					// "- Website: https://…" left "Website:" as text and hid the URL — keep label + URL.
					const labelOnly = Boolean(extracted.href && /^[^:]{1,40}:\s*$/.test(extracted.body));
					if (labelOnly && extracted.href) {
						bulletEntries.push({
							title: extracted.body.replace(/:\s*$/, '').trim(),
							text: extracted.href,
							href: extracted.href,
						});
					} else {
						bulletEntries.push({ text: extracted.body, href: extracted.href });
					}
				}
			}
			if (trailingDisclaimer) {
				flushCollections();
				blocks.push({ kind: 'disclaimer', text: trailingDisclaimer });
			}
			continue;
		}

		const labeled = line.match(SUMMARY_LABEL_RE);
		if (labeled) {
			const label = labeled[1].replace(/^\*\*|\*\*$/g, '').trim();
			const value = labeled[2].trim().replace(/\.\s*$/, '');
			// Keep "Born 3:15 PM…" intact — colon is a clock time, not Key: Value.
			if (isClockTimeColonSplit(label, value)) {
				if (timelineEntries.length > 0) {
					const last = timelineEntries[timelineEntries.length - 1]!;
					const extra = line.trim();
					if (extra) last.text = last.text ? `${last.text}\n\n${extra}` : extra;
				} else {
					flushCollections();
					for (const part of sectionProseByYears(line)) blocks.push(part);
				}
			} else if (/^sources?$/i.test(label) && /^research-drive\//i.test(value)) {
				// Footer / aggregate research-drive citations — one italic teal line, not a Sources card.
				flushCollections();
				const prefix = /^sources$/i.test(label) ? 'Sources' : 'Source';
				blocks.push({ kind: 'citation', text: `${prefix}: ${value}` });
			} else {
				flushTimeline();
				flushBullets();
				// Year-as-label lines become year sections for scanning.
				if (new RegExp(`^(?:${SUMMARY_YEAR_TOKEN})$`).test(label.replace(/\*\*/g, ''))) {
					flushGrid();
					blocks.push({ kind: 'year', year: label.replace(/\*\*/g, ''), text: value });
				} else {
					gridRows.push({ label, value });
				}
			}
		} else if (timelineEntries.length > 0) {
			// Body paragraph under `* YYYY: Title` stays on that entry so adjacent
			// milestones share one rail (one year header, not N single-entry rails).
			const last = timelineEntries[timelineEntries.length - 1]!;
			const extra = line.trim();
			if (extra) last.text = last.text ? `${last.text}\n\n${extra}` : extra;
		} else {
			flushCollections();
			// Wikipedia prose: only sentence-starting years become date cards
			// (mid-sentence "(1998)" / "in 2002" stay inline). Explicit "YEAR: …" labels
			// are handled above.
			for (const part of sectionProseByYears(line)) blocks.push(part);
		}
		if (trailingDisclaimer) {
			flushCollections();
			blocks.push({ kind: 'disclaimer', text: trailingDisclaimer });
		}
	}
	flushCollections();
	return blocks;
}

function SummarySectionCard({ label, children, accent = false }: { label: string; children: ReactNode; accent?: boolean }) {
	return (
		<div className='space-y-0.5'>
			<div className={`text-[11px] font-semibold tracking-wide ${accent ? 'text-[#FDBA74]' : 'text-[#F97316]'}`}>{label}</div>
			<div className='text-[12px] leading-snug text-white'>{children}</div>
		</div>
	);
}

const SUMMARY_MONTH_INDEX: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

/** Newest date wins. Prefers day/month precision; closed ranges use the later end; open “–present” uses the start so recent dated events stay above long-running roles. */
function summaryYearSortKey(yearLabel: string): number {
	const raw = String(yearLabel || '').trim();
	if (/\bpresent\b/i.test(raw)) {
		const startOnly = raw.replace(/\s*[–—-]\s*present\b/i, '').trim();
		if (startOnly && startOnly !== raw) return summaryYearSortKey(startOnly);
		return 9999_12_31;
	}
	const iso = raw.match(/\b((?:1[6-9]|20)\d{2})-(\d{2})-(\d{2})\b/);
	if (iso) return Number(iso[1]) * 10_000 + Number(iso[2]) * 100 + Number(iso[3]);
	const us = raw.match(/\b(\d{2})-(\d{2})-((?:1[6-9]|20)\d{2})\b/);
	if (us) return Number(us[3]) * 10_000 + Number(us[1]) * 100 + Number(us[2]);
	const monDayYear = raw.match(
		/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:1[6-9]|20)\d{2})\b/i,
	);
	if (monDayYear) {
		const m = SUMMARY_MONTH_INDEX[monDayYear[1].toLowerCase().replace(/\.$/, '')] || 0;
		return Number(monDayYear[3]) * 10_000 + m * 100 + Number(monDayYear[2]);
	}
	const monYear = raw.match(
		/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+((?:1[6-9]|20)\d{2})\b/i,
	);
	if (monYear) {
		const m = SUMMARY_MONTH_INDEX[monYear[1].toLowerCase().replace(/\.$/, '')] || 0;
		return Number(monYear[2]) * 10_000 + m * 100;
	}
	const seasonYear = raw.match(/\b(Spring|Summer|Fall|Autumn|Winter)\s+((?:1[6-9]|20)\d{2})\b/i);
	if (seasonYear) {
		const m = /spring/i.test(seasonYear[1]) ? 3 : /summer/i.test(seasonYear[1]) ? 6 : /winter/i.test(seasonYear[1]) ? 12 : 9;
		return Number(seasonYear[2]) * 10_000 + m * 100;
	}
	const yyyyMm = raw.match(/\b((?:1[6-9]|20)\d{2})-(\d{2})\b/);
	if (yyyyMm) return Number(yyyyMm[1]) * 10_000 + Number(yyyyMm[2]) * 100;
	const mmYyyy = raw.match(/\b(\d{2})-((?:1[6-9]|20)\d{2})\b/);
	if (mmYyyy) return Number(mmYyyy[2]) * 10_000 + Number(mmYyyy[1]) * 100;
	// BCE / BC → negative sort key so modern years stay above ancient ones.
	const bce = raw.match(/^(\d{3,4})\s*(?:BCE|BC)\b/i);
	if (bce) return -Number(bce[1]) * 10_000;
	// Mid-1840s / Late 1990s — trailing "s" breaks \b after YYYY; optional Late/Early/Mid prefix.
	const decadeLabel = raw.match(/^(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d{2})s\b/i);
	if (decadeLabel) return Number(decadeLabel[1]) * 10_000;
	const anyYear = raw.match(/^(\d{3,4})\b/);
	if (anyYear) return Number(anyYear[1]) * 10_000;
	const nums = [...raw.matchAll(/\b((?:1[6-9]|20)\d{2})s?\b/g)].map((m) => Number(m[1]));
	if (nums.length) return Math.max(...nums) * 10_000;
	// Geological epoch headers: older than historical BCE so they sort below calendar years.
	if (/Holocene/i.test(raw)) return -10_000;
	if (/Pleistocene|Quaternary/i.test(raw)) return -2_000_000;
	if (/Pliocene|Neogene/i.test(raw)) return -5_000_000;
	if (/Miocene/i.test(raw)) return -23_000_000;
	if (/Oligocene|Eocene|Paleocene|Paleogene|Cretaceous|Jurassic|Triassic/i.test(raw)) return -50_000_000;
	if (/Permian|Carboniferous|Devonian|Silurian|Ordovician|Cambrian|Precambrian|Proterozoic/i.test(raw)) {
		return -100_000_000;
	}
	return 0;
}

/** Normalize overview timeline dates so "November 24, 2026" and "2026-11-24" share one group. */
function summaryTimelineDateKey(date: string | null | undefined): string {
	const raw = String(date || '').trim();
	if (!raw || raw === 'Undated') return 'Undated';
	const iso = raw.match(/\b((?:1[6-9]|20)\d{2}-\d{2}-\d{2})\b/);
	if (iso) return iso[1];
	const us = raw.match(/\b(\d{2})-(\d{2})-((?:1[6-9]|20)\d{2})\b/);
	if (us) return `${us[3]}-${us[1]}-${us[2]}`;
	const labeled = formatSummaryDateLabel(raw);
	return labeled || raw;
}

function summaryTimelineDateLabel(date: string | null | undefined): string {
	const raw = String(date || '').trim();
	if (!raw || raw === 'Undated') return 'Undated';
	return formatSummaryDateLabel(raw) || formatDisplayDate(raw) || raw;
}

/**
 * Date chip under a year section header: omit year-only labels (redundant with the
 * sticky year), and strip the trailing year from specific dates ("NOVEMBER 13, 2009"
 * → "NOVEMBER 13"). Ranges that span years keep their years.
 */
function summaryTimelineDateLabelInYear(
	date: string | null | undefined,
	yearBucket: string,
): string | null {
	const full = summaryTimelineDateLabel(date);
	if (!full || full === 'Undated') return full === 'Undated' ? 'Undated' : null;
	const year = String(yearBucket || '').trim();
	if (!year || year === 'Undated') return full;

	const fullNorm = full.replace(/\s+/g, ' ').trim();
	const yearUpper = year.toUpperCase();
	if (fullNorm === year || fullNorm === yearUpper) return null;
	if (/^\d{3,4}(?:\s*BCE)?$/i.test(fullNorm) && fullNorm.toUpperCase() === yearUpper) return null;

	// Keep multi-year ranges intact ("1995 – 1999", "OCTOBER 2008 – PRESENT").
	if (/[–—]/.test(fullNorm) || /\s–\s/.test(fullNorm)) return full;

	const yearNum = year.match(/^(\d{3,4})(?:\s*BCE)?$/i)?.[1];
	if (!yearNum) return full;

	// "NOVEMBER 13, 2009" / "NOVEMBER 13, 2009" (already uppercased)
	let stripped = fullNorm.replace(new RegExp(`,\\s*${yearNum}\\b`, 'i'), '').trim();
	// "NOVEMBER 2009" → "NOVEMBER"
	if (stripped === fullNorm) {
		stripped = fullNorm.replace(new RegExp(`\\s+${yearNum}\\s*$`, 'i'), '').trim();
	}
	// Compact "11-13-2009" / "11-2009" fallbacks
	if (stripped === fullNorm) {
		stripped = fullNorm
			.replace(new RegExp(`-${yearNum}$`), '')
			.replace(new RegExp(`/${yearNum}$`), '')
			.trim();
	}

	if (!stripped || /^\d{3,4}$/.test(stripped)) return null;
	return stripped;
}

function summaryTimelineYearBucket(date: string | null | undefined): string {
	const raw = String(date || '').trim();
	if (!raw || raw === 'Undated') return 'Undated';
	const bce = raw.match(/^(\d{3,4})\s*(?:BCE|BC)\b/i);
	if (bce) return `${bce[1]} BCE`;
	// Mid-1840s / Late 1990s / 2020s / 2011+ — Late/Early/Mid prefix + trailing "s"/"+".
	const decadeOrPlus = raw.match(/^(?:(?:Late|Early|Mid)(?:-|\s+))?((?:1[6-9]|20)\d{2})(?:s|\+)?/i);
	if (decadeOrPlus) return decadeOrPlus[1];
	const leading = raw.match(/^(\d{3,4})\b/);
	if (leading) return leading[1];
	const modern = raw.match(/\b((?:1[6-9]|20)\d{2})s?\b/);
	if (modern) return modern[1];
	// Geological epoch labels stay as their own year headers.
	if (
		/^(?:Early|Middle|Late|Lower|Upper)?\s*(?:Cambrian|Ordovician|Silurian|Devonian|Carboniferous|Permian|Triassic|Jurassic|Cretaceous|Paleogene|Neogene|Quaternary|Miocene|Pliocene|Pleistocene|Holocene|Precambrian|Mesoproterozoic|Paleoproterozoic)/i.test(
			raw,
		)
	) {
		return raw;
	}
	return 'Undated';
}

type OverviewEventLink = { id: string; slug: string; name: string };

function resolveOverviewEventLink(
	text: string,
	links: Record<string, OverviewEventLink> | null | undefined,
): OverviewEventLink | null {
	if (!links || !text) return null;
	const direct = links[text];
	if (direct) return direct;
	const trimmed = text.replace(/\s+/g, ' ').trim();
	if (links[trimmed]) return links[trimmed];
	// Fall back: any stored query that loosely shares a long prefix / EO id with this claim.
	const claim = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	for (const [query, hit] of Object.entries(links)) {
		const q = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
		if (!q || q.length < 8) continue;
		if (claim === q || claim.startsWith(q) || q.startsWith(claim)) return hit;
		let i = 0;
		const lim = Math.min(claim.length, q.length);
		while (i < lim && claim[i] === q[i]) i += 1;
		if (i >= 36) return hit;
		const eoA = claim.match(/\beo\s*(\d{4,5})\b/);
		const eoB = q.match(/\beo\s*(\d{4,5})\b/);
		if (eoA && eoB && eoA[1] === eoB[1]) return hit;
	}
	return null;
}

function SummaryTimelineRail({
	entries,
	eventLinks = null,
	onOpenProfile = null,
}: {
	entries: SummaryTimelineEntry[];
	eventLinks?: Record<string, OverviewEventLink> | null;
	onOpenProfile?: ((idOrSlug: string) => void) | null;
}) {
	const renderEntryBody = (entry: SummaryTimelineEntry, key: string) => {
		const link = onOpenProfile ? resolveOverviewEventLink(entry.text, eventLinks) : null;
		if (link && onOpenProfile) {
			const { body, citation } = splitTrailingResearchDriveCitation(entry.text);
			return (
				<div
					key={key}
					className='space-y-0.5'>
					<button
						type='button'
						onClick={() => onOpenProfile(link.slug || link.id)}
						title={`Open profile: ${link.name}`}
						className='block w-full text-left text-[12px] leading-relaxed text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-100'>
						<SummaryMarkdown
							text={body || entry.text}
							inline
							className='inline text-[12px] leading-relaxed'
						/>
					</button>
					{citation ?
						<div className='text-[11px] italic leading-snug text-teal-300/85'>{citation}</div>
					:	null}
				</div>
			);
		}
		return (
			<TimelineEntryMarkdown
				key={key}
				text={entry.text}
				className='block'
			/>
		);
	};

	const renderYearBucketList = (listEntries: SummaryTimelineEntry[], prefix = '') => {
		const byYear = new Map<string, SummaryTimelineEntry[]>();
		for (const entry of listEntries) {
			const y = summaryTimelineYearBucket(entry.date);
			const list = byYear.get(y) || [];
			list.push(entry);
			byYear.set(y, list);
		}
		const years = [...byYear.keys()].sort((a, b) => {
			if (a === 'Undated') return 1;
			if (b === 'Undated') return -1;
			return summaryYearSortKey(b) - summaryYearSortKey(a);
		});
		for (const y of years) {
			const list = byYear.get(y) || [];
			list.sort((a, b) => summaryYearSortKey(b.date) - summaryYearSortKey(a.date));
		}

		return (
			<div className='space-y-4'>
				{years.map((year) => {
					const yearEntries = byYear.get(year) || [];
					// Collapse same-date bullets: one date header, then stacked claims.
					const dateGroups: Array<{ key: string; label: string | null; entries: SummaryTimelineEntry[] }> = [];
					const dateIndex = new Map<string, number>();
					for (const entry of yearEntries) {
						const key = summaryTimelineDateKey(entry.date);
						const existing = dateIndex.get(key);
						if (existing != null) {
							dateGroups[existing].entries.push(entry);
							continue;
						}
						dateIndex.set(key, dateGroups.length);
						dateGroups.push({
							key,
							label: summaryTimelineDateLabelInYear(entry.date, year),
							entries: [entry],
						});
					}

					return (
						<section
							key={`${prefix}${year}`}
							className='space-y-2'>
							<div className='flex items-baseline gap-2 border-b border-white/15 px-0.5 py-1'>
								<h4 className='m-0 text-sm font-bold tracking-wide text-[#F97316]'>{year}</h4>
								<span className='text-[10px] opacity-60'>
									{yearEntries.length} {yearEntries.length === 1 ? 'entry' : 'entries'}
									{dateGroups.length !== yearEntries.length ? ` · ${dateGroups.length} dates` : ''}
								</span>
							</div>
							<div className='relative ml-1.5 space-y-0 border-l-2 border-white/20 pl-3.5'>
								{dateGroups.map((group) => {
									const sourceTags = [
										...new Set(group.entries.map((e) => e.sourceTag).filter(Boolean).map(String)),
									];
									return (
										<article
											key={`${prefix}${year}-${group.key}`}
											className='relative pb-3.5 last:pb-1'>
											<span
												aria-hidden
												className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-[#F97316] bg-[#0b1220]'
											/>
											{group.label || sourceTags.length > 0 ?
												<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]'>
													{group.label ?
														<span className='font-mono font-semibold opacity-90'>{group.label}</span>
													:	null}
													{sourceTags.map((tag) => (
														<span
															key={tag}
															className='rounded border border-white/20 px-1 py-0.5 text-[10px] opacity-70'>
															{tag}
														</span>
													))}
												</div>
											:	null}
											<div className={group.entries.length > 1 ? 'mt-1.5 space-y-2' : 'mt-1'}>
												{group.entries.map((entry, ei) => renderEntryBody(entry, `${group.key}-${ei}`))}
											</div>
										</article>
									);
								})}
							</div>
						</section>
					);
				})}
			</div>
		);
	};

	const renderSpanChapterCard = (
		chapter: RangeSpanChapter<SummaryTimelineEntry>,
		key: string,
		depth = 0,
	): ReactNode => {
		const spanLabel = summaryTimelineDateLabel(chapter.span.date);
		const duration = formatRangeSpanDuration(chapter.bounds);
		const innerItems: Array<
			| { kind: 'child'; sortKey: number; chapter: RangeSpanChapter<SummaryTimelineEntry> }
			| { kind: 'point'; sortKey: number; entry: SummaryTimelineEntry }
		> = [
			...chapter.children.map((child) => ({
				kind: 'child' as const,
				sortKey: child.sortKey,
				chapter: child,
			})),
			...chapter.nested.map((n) => ({
				kind: 'point' as const,
				sortKey: n.sortKey,
				entry: n.item,
			})),
		].sort((a, b) => {
			if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
			if (a.kind !== b.kind) return a.kind === 'child' ? -1 : 1;
			return 0;
		});

		type InnerNode =
			| { kind: 'child'; chapter: RangeSpanChapter<SummaryTimelineEntry> }
			| { kind: 'dateGroup'; dateKey: string; label: string; entries: SummaryTimelineEntry[] };
		const groupedInner: InnerNode[] = [];
		for (const item of innerItems) {
			if (item.kind === 'child') {
				groupedInner.push({ kind: 'child', chapter: item.chapter });
				continue;
			}
			const dateKey = summaryTimelineDateKey(item.entry.date);
			const prev = groupedInner[groupedInner.length - 1];
			if (prev && prev.kind === 'dateGroup' && prev.dateKey === dateKey) {
				prev.entries.push(item.entry);
			} else {
				groupedInner.push({
					kind: 'dateGroup',
					dateKey,
					label: summaryTimelineDateLabel(item.entry.date),
					entries: [item.entry],
				});
			}
		}

		return (
			<section
				key={key}
				className={
					depth > 0 ?
						'overflow-hidden rounded-lg border border-amber-300/30 bg-white/[0.03]'
					:	'overflow-hidden rounded-lg border border-[#F97316]/35 bg-[#F97316]/[0.06]'
				}>
				<header className='border-b border-white/10 px-3 py-2.5'>
					<div className='flex flex-wrap items-center justify-between gap-2'>
						<div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
							<h4 className='m-0 font-mono text-sm font-bold tracking-wide text-[#F97316]'>
								{spanLabel}
							</h4>
							{duration ?
								<span className='text-[10px] font-medium opacity-65'>{duration}</span>
							:	null}
							{chapter.span.sourceTag ?
								<span className='rounded border border-white/20 px-1 py-0.5 text-[10px] opacity-70'>
									{chapter.span.sourceTag}
								</span>
							:	null}
						</div>
						<span className='rounded border border-[#F97316]/35 bg-[#F97316]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#FDBA74]'>
							{chapter.totalNestedCount} {chapter.totalNestedCount === 1 ? 'milestone' : 'milestones'}
						</span>
					</div>
					<div className='mt-1.5'>{renderEntryBody(chapter.span, `${key}-hdr`)}</div>
				</header>
				<div className='relative ml-3.5 space-y-0 border-l-2 border-[#F97316]/45 py-2.5 pl-3.5 pr-3'>
					{groupedInner.map((node, ni) => {
						if (node.kind === 'child') {
							return (
								<div
									key={`${key}-child-${ni}`}
									className='pb-3 last:pb-1'>
									{renderSpanChapterCard(node.chapter, `${key}-c-${ni}`, depth + 1)}
								</div>
							);
						}
						const sourceTags = [
							...new Set(node.entries.map((e) => e.sourceTag).filter(Boolean).map(String)),
						];
						return (
							<article
								key={`${key}-pt-${node.dateKey}-${ni}`}
								className='relative pb-3 last:pb-1'>
								<span
									aria-hidden
									className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-[#F97316] bg-[#0b1220]'
								/>
								<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]'>
									<span className='font-mono font-semibold text-[#FDBA74]'>{node.label}</span>
									{sourceTags.map((tag) => (
										<span
											key={tag}
											className='rounded border border-white/20 px-1 py-0.5 text-[10px] opacity-70'>
											{tag}
										</span>
									))}
								</div>
								<div className={node.entries.length > 1 ? 'mt-1.5 space-y-2' : 'mt-1'}>
									{node.entries.map((entry, ei) =>
										renderEntryBody(entry, `${key}-pt-${ni}-${ei}`),
									)}
								</div>
							</article>
						);
					})}
				</div>
			</section>
		);
	};

	const { stream, hasActiveSpans } = nestTimelineItemsIntoRangeSpans(
		entries,
		(e) => parseSummaryDateBounds(e.date),
		(e) => summaryYearSortKey(e.date),
	);

	if (!hasActiveSpans) {
		return renderYearBucketList(entries);
	}

	const blocks: ReactNode[] = [];
	let pending: SummaryTimelineEntry[] = [];
	const flushPending = (key: string) => {
		if (!pending.length) return;
		blocks.push(
			<div key={key}>{renderYearBucketList(pending, `${key}-`)}</div>,
		);
		pending = [];
	};

	stream.forEach((item, idx) => {
		if (item.kind === 'point') {
			pending.push(item.item);
			return;
		}
		flushPending(`pts-before-${idx}`);
		blocks.push(renderSpanChapterCard(item.chapter, `span-${idx}`));
	});
	flushPending('pts-tail');

	return <div className='space-y-4'>{blocks}</div>;
}

function lookupOutlineProfileLink(
	raw: string | null | undefined,
	links: Record<string, OverviewEventLink> | null | undefined,
): OverviewEventLink | null {
	if (!links || !raw) return null;
	const trimmed = String(raw).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
	if (!trimmed) return null;
	if (links[trimmed]) return links[trimmed];
	const noParen = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
	if (noParen && links[noParen]) return links[noParen];
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const qNorm = norm(trimmed);
	const qNoParen = norm(noParen);
	for (const [key, hit] of Object.entries(links)) {
		const kNorm = norm(key);
		if (!kNorm || kNorm.length < 4) continue;
		if (kNorm === qNorm || (qNoParen && kNorm === qNoParen)) return hit;
		if (qNorm.length >= 10 && (kNorm.startsWith(qNorm) || qNorm.startsWith(kNorm))) return hit;
	}
	return null;
}

/** Timeline-style left rail for undated outline / index / catalog bullets. */
function SummaryOutlineRail({
	entries,
	profileLinks = null,
	onOpenProfile = null,
}: {
	entries: SummaryBulletEntry[];
	profileLinks?: Record<string, OverviewEventLink> | null;
	onOpenProfile?: ((idOrSlug: string) => void) | null;
}) {
	return (
		<div className='relative ml-1.5 space-y-0 border-l-2 border-white/20 pl-3.5'>
			{entries.map((entry, ei) => {
				const href = entry.href || null;
				const textIsUrl = Boolean(href && entry.text && /^https?:\/\//i.test(entry.text.trim()));
				const showUrlLink = Boolean(href && (!entry.title || textIsUrl || !entry.text.trim()));
				const label = entry.title || (textIsUrl ? null : null);
				const labelLink =
					label && onOpenProfile && profileLinks ? lookupOutlineProfileLink(label, profileLinks) : null;
				const fullTextLink =
					!showUrlLink && entry.text && onOpenProfile && profileLinks
						? lookupOutlineProfileLink(entry.text, profileLinks)
						: null;
				const dotSegments =
					!showUrlLink && !fullTextLink && entry.text && entry.text.includes('·') && onOpenProfile && profileLinks
						? entry.text.split(/\s*·\s*/).map((seg) => ({
								seg,
								hit: lookupOutlineProfileLink(seg, profileLinks),
							}))
						: null;
				const hasDotLink = Boolean(dotSegments?.some((s) => s.hit));

				return (
					<article
						key={`outline-${ei}`}
						className='relative pb-3 last:pb-1'>
						<span
							aria-hidden
							className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-[#F97316] bg-[#0b1220]'
						/>
						{label ?
							labelLink && onOpenProfile ?
								<button
									type='button'
									onClick={() => onOpenProfile(labelLink.slug || labelLink.id)}
									title={`Open profile: ${labelLink.name}`}
									className='cursor-pointer text-left text-[11px] font-semibold leading-snug text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-100'>
									{label}
								</button>
							:	<div className='text-[11px] font-semibold leading-snug text-[#FDBA74]'>{label}</div>
						:	null}
						{showUrlLink && href ?
							<a
								href={href}
								target='_blank'
								rel='noreferrer'
								title={href}
								className='mt-0.5 block break-all text-[11px] text-sky-300 underline'>
								{truncateDisplayUrl(textIsUrl ? entry.text : href)}
							</a>
						: fullTextLink && onOpenProfile ?
							<button
								type='button'
								onClick={() => onOpenProfile(fullTextLink.slug || fullTextLink.id)}
								title={`Open profile: ${fullTextLink.name}`}
								className={`${label ? 'mt-0.5 ' : ''}block cursor-pointer text-left text-[12px] leading-relaxed text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-100`}>
								<SummaryMarkdown
									text={entry.text}
									inline
									className='inline text-[12px] leading-relaxed'
								/>
							</button>
						: hasDotLink && dotSegments && onOpenProfile ?
							<div className={`${label ? 'mt-0.5 ' : ''}flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-relaxed text-white/90`}>
								{dotSegments.map((item, si) => (
									<span
										key={`seg-${si}`}
										className='inline-flex items-baseline gap-1.5'>
										{si > 0 ? <span className='opacity-45'>·</span> : null}
										{item.hit ?
											<button
												type='button'
												onClick={() => onOpenProfile(item.hit!.slug || item.hit!.id)}
												title={`Open profile: ${item.hit.name}`}
												className='cursor-pointer text-left text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-100'>
												{item.seg}
											</button>
										:	<span>{item.seg}</span>}
									</span>
								))}
							</div>
						: entry.text ?
							<div className={label ? 'mt-0.5' : undefined}>
								<SummaryMarkdown
									text={entry.text}
									inline
									className='block text-[12px] leading-relaxed text-white/90'
								/>
							</div>
						:	null}
					</article>
				);
			})}
		</div>
	);
}

/** Empty Local Wikipedia cross-check placeholder from news-rss-format-card / topic consolidate. */
function isEmptyLocalWikiPlaceholder(text: string | null | undefined): boolean {
	const t = String(text || '')
		.replace(/^[-*•]\s+/, '')
		.trim();
	if (!t) return true;
	return /no strong local[- ]wiki hits\b/i.test(t);
}

/** Internal formatter footer from news-rss-format-card / topic consolidate. */
function isNewsFormatBoilerplateFooter(text: string | null | undefined): boolean {
	const t = String(text || '').trim();
	if (!t) return false;
	return (
		/^(?:Single-card rewrite (?:via|from)|Pieced from \d+ news_rss|Consolidated from \d+ news_rss)\b/i.test(t) ||
		/overview mixes a short paragraph with Timeline-style dated entries\.?$/i.test(t)
	);
}

function isLocalWikipediaCrossCheckHeading(text: string | null | undefined): boolean {
	return /^local\s+wikipedia\s+cross-?check\b/i.test(String(text || '').trim());
}

/** Drop the Local Wikipedia heading + body when there are no real wiki hits to show. */
function stripEmptyLocalWikiCrossCheck(blocks: SummaryBlock[]): SummaryBlock[] {
	const out: SummaryBlock[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.kind === 'heading' && isLocalWikipediaCrossCheckHeading(b.text)) {
			const next = blocks[i + 1];
			if (!next) continue;
			if (next.kind === 'bullets') {
				const kept = next.entries.filter((e) => {
					if (isEmptyLocalWikiPlaceholder(e.text)) return false;
					if (e.title != null && e.title !== '' && isEmptyLocalWikiPlaceholder(e.title)) return false;
					return true;
				});
				if (kept.length === 0) {
					i += 1; // skip heading + empty bullets
					continue;
				}
				out.push(b);
				out.push({ kind: 'bullets', entries: kept });
				i += 1;
				continue;
			}
			if (next.kind === 'prose' && isEmptyLocalWikiPlaceholder(next.text)) {
				i += 1; // skip heading + placeholder prose
				continue;
			}
			if (next.kind === 'heading') {
				// Empty section (heading with nothing under it before the next heading).
				continue;
			}
		}
		if (b.kind === 'bullets') {
			const kept = b.entries.filter((e) => {
				if (isEmptyLocalWikiPlaceholder(e.text)) return false;
				if (e.title != null && e.title !== '' && isEmptyLocalWikiPlaceholder(e.title)) return false;
				return true;
			});
			if (kept.length === 0) continue;
			if (kept.length !== b.entries.length) {
				out.push({ kind: 'bullets', entries: kept });
				continue;
			}
		}
		if (b.kind === 'prose' && (isEmptyLocalWikiPlaceholder(b.text) || isNewsFormatBoilerplateFooter(b.text))) continue;
		out.push(b);
	}
	return out;
}

/**
 * When a historic_event summary has no ## Timeline yet, inject a basic rail from
 * startDate + title/first sentence so Overview always shows timeline formatting.
 */
function ensureHistoricEventTimelineBlocks(
	blocks: SummaryBlock[],
	opts: { sourceDate?: string | null; eventTitle?: string | null },
): SummaryBlock[] {
	if (blocks.some((b) => b.kind === 'timeline')) return blocks;
	const date = resolveSummaryTimelineDate(opts.sourceDate, opts.sourceDate);
	let claim = String(opts.eventTitle || '').trim();
	if (!claim) {
		const prose = blocks.find((b) => b.kind === 'prose');
		if (prose && prose.kind === 'prose') {
			claim = prose.text
				.replace(/\s+/g, ' ')
				.trim()
				.split(/(?<=[.!?])\s+/)[0]
				.slice(0, 320);
		}
	}
	if (!claim) claim = 'Event';
	const timelineBlock: SummaryBlock = {
		kind: 'timeline',
		entries: [{ date, text: claim, sourceTag: null }],
	};
	const heading: SummaryBlock = { kind: 'heading', text: 'Timeline' };
	const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
	const claimN = norm(claim);
	// Keep lead prose above the rail when it adds context beyond the Timeline claim.
	let cut = 0;
	while (cut < blocks.length && (blocks[cut].kind === 'prose' || blocks[cut].kind === 'disclaimer')) {
		cut += 1;
		if (cut >= 2) break;
	}
	if (cut === 0) {
		return [heading, timelineBlock, ...blocks];
	}
	const above = blocks.slice(0, cut).filter((b) => {
		if (b.kind !== 'prose') return true;
		const t = norm(b.text || '');
		return t.length > 0 && t !== claimN;
	});
	const below = blocks.slice(cut);
	if (above.length === 0) {
		return [heading, timelineBlock, ...below];
	}
	return [...above, heading, timelineBlock, ...below];
}

/** All profile summaries: prose paragraphs mixed with Timeline-tab rail styling for dated sections. */
function ProfileSummaryText({
	text,
	sourceDate = null,
	eventTitle = null,
	ensureEventTimeline = false,
	eventLinks = null,
	relatedProfileLinks = null,
	onOpenProfile = null,
}: {
	text: string;
	sourceDate?: string | null;
	eventTitle?: string | null;
	ensureEventTimeline?: boolean;
	eventLinks?: Record<string, OverviewEventLink> | null;
	relatedProfileLinks?: Record<string, OverviewEventLink> | null;
	onOpenProfile?: ((idOrSlug: string) => void) | null;
}) {
	const raw = String(text || '').trim();
	if (!raw) return null;
	let blocks = stripEmptyLocalWikiCrossCheck(
		parseSummaryBlocks(raw, { sourceDate }).filter((b) => {
			if (b.kind !== 'year') return true;
			const t = String(b.text || '')
				.replace(/^[—–\-\s.]+$/, '')
				.trim();
			return t.length > 0;
		}),
	);
	if (ensureEventTimeline) {
		blocks = ensureHistoricEventTimelineBlocks(blocks, { sourceDate, eventTitle });
	}

	// Keep document order for prose/grid/timeline; sort only contiguous year-card runs (newest first).
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
		// Merge adjacent timeline rails so shared year buckets (1840–1841 + Mid-1840s) collapse.
		if (b.kind === 'timeline') {
			const prev = renderItems[renderItems.length - 1];
			if (prev && prev.kind === 'timeline') {
				prev.entries.push(...b.entries);
				i += 1;
				continue;
			}
			renderItems.push({ kind: 'timeline', entries: [...b.entries] });
			i += 1;
			continue;
		}
		renderItems.push(b);
		i += 1;
	}
	const promoted = promoteOverviewTimeline(renderItems);

	// Split into lead + ## sections so dense dossiers can collapse catalog chapters.
	type OverviewSection = { heading: SummaryBlock & { kind: 'heading' }; body: SummaryBlock[] };
	const leadBlocks: SummaryBlock[] = [];
	const sections: OverviewSection[] = [];
	let current: OverviewSection | null = null;
	for (const block of promoted) {
		if (block.kind === 'heading' && (block.level ?? 2) <= 2) {
			current = { heading: block, body: [] };
			sections.push(current);
			continue;
		}
		if (current) current.body.push(block);
		else leadBlocks.push(block);
	}
	const h2Count = sections.length;
	const collapseCatalogs = h2Count >= 5;

	const renderBlock = (block: SummaryBlock, idx: string): ReactNode => {
					if (block.kind === 'heading') {
						const isSub = (block.level ?? 2) >= 3;
						return (
							<h3
								key={`h-${idx}`}
								className={
									isSub ?
										'm-0 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[#FDBA74]/80'
									:	'm-0 border-b border-white/10 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[#FDBA74]'
								}>
								{block.text}
							</h3>
						);
					}
					if (block.kind === 'timeline') {
						return (
							<SummaryTimelineRail
								key={`t-${idx}`}
								entries={block.entries}
								eventLinks={eventLinks}
								onOpenProfile={onOpenProfile}
							/>
						);
					}
					if (block.kind === 'bullets') {
						return (
							<div key={`b-${idx}`}>
								<SummaryOutlineRail
									entries={block.entries}
									profileLinks={relatedProfileLinks}
									onOpenProfile={onOpenProfile}
								/>
							</div>
						);
					}
					if (block.kind === 'year') {
						return (
							<SummarySectionCard
								key={`y-${idx}`}
								label={formatSummaryDateLabel(block.year)}
								accent>
								<SummaryMarkdown
									text={block.text}
									inline
								/>
							</SummarySectionCard>
						);
					}
					if (block.kind === 'citation') {
						return (
							<div
								key={`c-${idx}`}
								className='text-[11px] italic leading-snug text-teal-300/85'>
								{block.text.replace(/\.\s*$/, '')}
							</div>
						);
					}
					if (block.kind === 'grid') {
						// Labels duplicate Title / role chips — hide from overview summary UI.
						// research-drive Sources rows render as citation blocks instead.
						const rows = block.rows.filter((row) => {
							const lab = String(row.label || '').trim();
							const val = String(row.value || '').trim();
							if (/^labels$/i.test(lab)) return false;
							if (/^sources?$/i.test(lab) && /^research-drive\//i.test(val)) return false;
							return true;
						});
						if (rows.length === 0) return null;
						return (
							<div
								key={`g-${idx}`}
								className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
								{rows.map((row, ri) => {
									const isCrossRefLabel = /^(?:see(?:\s+also)?|related(?:\s+profiles?)?|linked(?:\s+profiles?)?)$/i.test(
										String(row.label || '').trim(),
									);
									const segments =
										isCrossRefLabel && onOpenProfile && relatedProfileLinks
											? String(row.value || '')
													.split(/\s*·\s*/)
													.map((seg) => seg.replace(/\.\s*$/, '').trim())
													.filter(Boolean)
													.map((seg) => ({
														seg,
														hit: lookupOutlineProfileLink(seg, relatedProfileLinks),
													}))
											: null;
									const hasSegmentLink = Boolean(segments?.some((s) => s.hit));
									return (
										<SummarySectionCard
											key={`r-${idx}-${ri}`}
											label={row.label}>
											{hasSegmentLink && segments && onOpenProfile ?
												<div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-snug'>
													{segments.map((item, si) => (
														<span
															key={`gseg-${si}`}
															className='inline-flex items-baseline gap-1.5'>
															{si > 0 ? <span className='opacity-45'>·</span> : null}
															{item.hit ?
																<button
																	type='button'
																	onClick={() => onOpenProfile(item.hit!.slug || item.hit!.id)}
																	title={`Open profile: ${item.hit.name}`}
																	className='cursor-pointer text-left text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-100'>
																	{item.seg}
																</button>
															:	<span>{item.seg}</span>}
														</span>
													))}
												</div>
											:	<SummaryMarkdown
													text={row.value}
													inline
												/>
											}
										</SummarySectionCard>
									);
								})}
							</div>
						);
					}
					if (block.kind === 'pre') {
						return (
							<pre
								key={`pre-${idx}`}
								className='m-0 whitespace-pre rounded border border-white/10 bg-black/35 p-2.5 font-mono text-[11px] leading-snug text-sky-100/95'>
								{block.text}
							</pre>
						);
					}
					if (block.kind === 'disclaimer') {
						// Curated network disclaimers stay in source metadata / stored text for integrity,
						// but are not shown in the overview (perspective flexibility).
						return null;
					}
					return (
						<SummaryMarkdown
							key={`p-${idx}`}
							text={block.text}
							className='summary-md-prose'
						/>
					);
	};

	return (
		<div className='mt-2 max-w-3xl rounded-lg border border-white/15 bg-[#0b1220] p-3 text-xs leading-relaxed text-white shadow-sm'>
			<div className='space-y-3'>
				{leadBlocks.map((block, idx) => renderBlock(block, `lead-${idx}`))}
				{sections.map((section, sIdx) => {
					const title = section.heading.text;
					const keepOpen =
						!collapseCatalogs ||
						OVERVIEW_PRIORITY_SECTION_RE.test(title) ||
						section.body.some((b) => b.kind === 'timeline');
					const bodyNodes = section.body.map((block, bIdx) => renderBlock(block, `s${sIdx}-${bIdx}`));
					if (keepOpen) {
						return (
							<div
								key={`sec-${sIdx}`}
								className='space-y-3'>
								{renderBlock(section.heading, `sh-${sIdx}`)}
								{bodyNodes}
							</div>
						);
					}
					return (
						<details
							key={`sec-${sIdx}`}
							className='rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5'>
							<summary className='cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wide text-[#FDBA74] marker:content-none [&::-webkit-details-marker]:hidden'>
								<span className='inline-flex items-center gap-1.5'>
									<span className='opacity-70'>▸</span>
									{title}
									<span className='font-normal normal-case tracking-normal opacity-50'>
										· expand
									</span>
								</span>
							</summary>
							<div className='mt-2 space-y-3 border-t border-white/10 pt-2'>{bodyNodes}</div>
						</details>
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
			className='inline-flex shrink-0 flex-wrap items-center gap-1 align-middle'
			title={codes.map(getFlagLabel).join(' · ')}>
			{codes.map((code) => {
				const label = getFlagLabel(code);
				return (
					// eslint-disable-next-line @next/next/no-img-element
					<img
						key={code}
						src={`/flags/4x3/${encodeURIComponent(code.toLowerCase())}.svg`}
						alt={label}
						title={label}
						loading='lazy'
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
	/** Committed list search term (applied only via Search button / Enter). */
	const [query, setQuery] = useState('');
	/** Draft text in the header search box — does not hit the API until submitted. */
	const [queryDraft, setQueryDraft] = useState('');
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
	const detailTopRef = useRef<HTMLDivElement | null>(null);
	const [timelineFocusTitle, setTimelineFocusTitle] = useState<string | null>(null);

	// Timeline state
	const [timeline, setTimeline] = useState<ProfileTimelineResult | null>(null);
	const [loadingTimeline, setLoadingTimeline] = useState(false);
	const [overviewEventLinks, setOverviewEventLinks] = useState<Record<string, OverviewEventLink> | null>(
		null,
	);
	const [overviewRelatedProfileLinks, setOverviewRelatedProfileLinks] = useState<Record<
		string,
		OverviewEventLink
	> | null>(null);
	const [finraDisclosures, setFinraDisclosures] = useState<ProfileFinraDisclosures | null>(null);
	const [loadingFinraDisclosures, setLoadingFinraDisclosures] = useState(false);
	const [finraDisclosuresError, setFinraDisclosuresError] = useState<string | null>(null);

	// Global alignments triage state
	const [globalAlignments, setGlobalAlignments] = useState<AlignmentCandidate[]>([]);
	const [globalAlignTotal, setGlobalAlignTotal] = useState(0);
	const [alignKindFilter, setAlignKindFilter] = useState<string>('');
	const [alignStatusFilter, setAlignStatusFilter] = useState<string>('proposed');
	const [alignOffset, setAlignOffset] = useState(0);
	const [loadingGlobalAlign, setLoadingGlobalAlign] = useState(false);
	const [bulkAlignBusy, setBulkAlignBusy] = useState(false);
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
	const [newEndDate, setNewEndDate] = useState('');
	const [newEmployer, setNewEmployer] = useState('');
	const [newEmployerCategory, setNewEmployerCategory] = useState<ProfileType>('firm');
	const [newEmployerRole, setNewEmployerRole] = useState('');
	const [creating, setCreating] = useState(false);
	const [profileEditing, setProfileEditing] = useState(false);
	const [typeDraft, setTypeDraft] = useState<ProfileType>('firm');
	const [savingCategory, setSavingCategory] = useState(false);
	const [lifeStartDraft, setLifeStartDraft] = useState('');
	const [lifeEndDraft, setLifeEndDraft] = useState('');
	const [nameDraft, setNameDraft] = useState('');
	const [altNamesDraft, setAltNamesDraft] = useState('');
	const [summaryDraft, setSummaryDraft] = useState('');
	const [savingCore, setSavingCore] = useState(false);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteConfirmName, setDeleteConfirmName] = useState('');
	const [deletingProfile, setDeletingProfile] = useState(false);
	const [aliasRowsDraft, setAliasRowsDraft] = useState<
		Array<{
			key: string;
			id: string | null;
			alias: string;
			aliasKind: AliasKind;
			deleted: boolean;
		}>
	>([]);
	const [locationRowsDraft, setLocationRowsDraft] = useState<
		Array<{
			key: string;
			id: string | null;
			raw: string;
			role: LocationRole;
			confirmed: boolean;
			deleted: boolean;
		}>
	>([]);
	const [pendingDeleteIdentIds, setPendingDeleteIdentIds] = useState<string[]>([]);
	const [pendingNewIdents, setPendingNewIdents] = useState<Array<{ key: string; scheme: string; value: string }>>([]);

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
	const [aliasKindDraft, setAliasKindDraft] = useState<AliasKind>('other_name');
	const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
	const [editAliasText, setEditAliasText] = useState('');
	const [editAliasKind, setEditAliasKind] = useState<AliasKind>('name');
	const [savingAlias, setSavingAlias] = useState(false);
	const [identSchemeDraft, setIdentSchemeDraft] = useState('ticker');
	const [identValueDraft, setIdentValueDraft] = useState('');
	const [savingIdent, setSavingIdent] = useState(false);
	const [locationDraft, setLocationDraft] = useState('');
	const [locationRoleDraft, setLocationRoleDraft] = useState<LocationRole>('residence');
	const [locationConfirmDraft, setLocationConfirmDraft] = useState(false);
	const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
	const [editLocationRaw, setEditLocationRaw] = useState('');
	const [editLocationRole, setEditLocationRole] = useState<LocationRole>('associated');
	const [editLocationConfirmed, setEditLocationConfirmed] = useState(false);
	const [savingLocation, setSavingLocation] = useState(false);
	const [savingAlignmentId, setSavingAlignmentId] = useState<string | null>(null);
	const [empOrgName, setEmpOrgName] = useState('');
	const [empOrgCategory, setEmpOrgCategory] = useState<ProfileType>('firm');
	const [empRole, setEmpRole] = useState('');
	const [empStart, setEmpStart] = useState('');
	const [empEnd, setEmpEnd] = useState('');
	const [empLocation, setEmpLocation] = useState('');
	const [savingEmp, setSavingEmp] = useState(false);
	const [connStatusFilter, setConnStatusFilter] = useState<'all' | 'current' | 'old'>('all');
	const [hydratingDates, setHydratingDates] = useState(false);
	/** Connected-profile drafts while Edit is open (relation/role/dates/note + pending remove). */
	const [connLinkDrafts, setConnLinkDrafts] = useState<
		Array<{
			id: string;
			relationType: ProfileRelationType;
			roleLabel: string;
			startDate: string;
			endDate: string;
			evidenceNote: string;
			deleted: boolean;
			origRelationType: ProfileRelationType;
			origRoleLabel: string;
			origStartDate: string;
			origEndDate: string;
			origEvidenceNote: string;
		}>
	>([]);
	const [connSearch, setConnSearch] = useState('');
	const [connHits, setConnHits] = useState<ConnSearchHit[]>([]);
	const [connPeer, setConnPeer] = useState<ConnSearchHit | null>(null);
	const [connRelation, setConnRelation] = useState<ProfileRelationType>('affiliated_with');
	const [connRole, setConnRole] = useState('');
	const [connStart, setConnStart] = useState('');
	const [connEnd, setConnEnd] = useState('');
	const [connNote, setConnNote] = useState('');
	const [savingConn, setSavingConn] = useState(false);
	const [connSearchOpen, setConnSearchOpen] = useState(false);

	const syncUrl = useCallback((next: { profile?: string | null; view?: 'profile' | 'alignments' }, mode: 'push' | 'replace' = 'push') => {
		if (typeof window === 'undefined') return;
		const nextHref =
			next.view === 'alignments' ? '/profiles/alignments'
			: next.profile ? slugToProfilePath(next.profile)
			: '/profiles';
		const curHref = `${window.location.pathname}${window.location.search}`;
		if (nextHref === curHref) return;
		if (mode === 'replace') window.history.replaceState(null, '', nextHref);
		else window.history.pushState(null, '', nextHref);
	}, []);

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

	const loadList = useCallback(async (opts?: { resetOffset?: boolean }) => {
		setLoadingList(true);
		setError(null);
		try {
			const shouldResetOffset =
				Boolean(opts?.resetOffset) &&
				typeFilter !== HISTORY_FILTER &&
				typeFilter !== 'historic_event';
			const effectiveOffset = shouldResetOffset ? 0 : offset;
			if (shouldResetOffset && offset !== 0) setOffset(0);
			if (typeFilter === HISTORY_FILTER) {
				const q = query.trim().toLowerCase();
				let entries = viewHistoryRef.current;
				if (q) {
					entries = entries
						.filter(
							(e) =>
								e.name.toLowerCase().includes(q) ||
								e.slug.toLowerCase().includes(q) ||
								(e.alternateNames || []).some((a) => a.toLowerCase().includes(q)) ||
								(e.primaryLocation || '').toLowerCase().includes(q),
						)
						.map((e) => {
							const name = e.name.toLowerCase();
							const slug = e.slug.toLowerCase();
							const aliases = (e.alternateNames || []).map((a) => a.toLowerCase());
							let rank = 8;
							if (name === q) rank = 0;
							else if (aliases.includes(q)) rank = 1;
							else if (name.startsWith(q)) rank = 2;
							else if (aliases.some((a) => a.startsWith(q))) rank = 3;
							else if (name.includes(q)) rank = 4;
							else if (aliases.some((a) => a.includes(q))) rank = 5;
							else if (slug.includes(q)) rank = 6;
							return { e, rank, len: name.length };
						})
						.sort((a, b) => a.rank - b.rank || a.len - b.len || a.e.name.localeCompare(b.e.name))
						.map((x) => x.e);
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
			params.set('offset', String(effectiveOffset));
			params.set('stats', '1');

			const res = await fetch(`/api/profiles?${params.toString()}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
			setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
			setTotalProfiles(Number(data.total || 0));
			if (data.stats) setStats(data.stats as ProfileStats);
			const pathProfile = typeof window !== 'undefined' ? parseProfilesPathname(window.location.pathname).profileSlug : null;
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
				if (!res.ok || !data?.ok) {
					// Soft-journalism / removed cards 404 — leave the dead URL.
					if (res.status === 404) {
						setDetail(null);
						setSelectedId(null);
						setError(null);
						skipNextPushRef.current = false;
						syncUrl({ profile: null, view: 'profile' }, 'replace');
						return;
					}
					throw new Error(data?.error || `Failed (${res.status})`);
				}
				const loaded = data as ProfileDetail;
				setDetail(loaded);
				setProfileEditing(false);
				setEditingLocationId(null);
				setEditingAliasId(null);
				setPendingDeleteIdentIds([]);
				setConnLinkDrafts([]);
				setPendingNewIdents([]);
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

	const loadTimeline = useCallback(async (id: string, opts?: { includeLinkedEvents?: boolean }) => {
		setLoadingTimeline(true);
		try {
			const params = new URLSearchParams();
			params.set('detectGaps', '0');
			params.set('limit', '200');
			if (opts?.includeLinkedEvents === false) params.set('includeLinkedEvents', '0');
			if (opts?.includeLinkedEvents === true) params.set('includeLinkedEvents', '1');
			const res = await fetch(`/api/profiles/${encodeURIComponent(id)}/timeline?${params.toString()}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Failed (${res.status})`);
			setTimeline(data as ProfileTimelineResult);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingTimeline(false);
		}
	}, []);

	// Reset Connected Profiles add/remove drafts when navigating to another card.
	useEffect(() => {
		setConnSearch('');
		setConnHits([]);
		setConnPeer(null);
		setConnRelation('affiliated_with');
		setConnRole('');
		setConnStart('');
		setConnEnd('');
		setConnNote('');
		setConnSearchOpen(false);
		setConnLinkDrafts([]);
	}, [selectedId]);

	// Typeahead for Connected Profiles “+ Add connection”.
	useEffect(() => {
		const q = connSearch.trim();
		if (connPeer && q === connPeer.name) {
			setConnHits([]);
			return;
		}
		if (q.length < 2) {
			setConnHits([]);
			return;
		}
		const subjectId = detail?.profile?.id;
		const handle = window.setTimeout(() => {
			void (async () => {
				try {
					const params = new URLSearchParams();
					params.set('q', q);
					params.set('limit', '12');
					const res = await fetch(`/api/profiles?${params.toString()}`, { cache: 'no-store' });
					const data = await res.json();
					if (!res.ok || !data?.ok) return;
					const hits: ConnSearchHit[] = (Array.isArray(data.profiles) ? data.profiles : [])
						.map((p: { id?: string; slug?: string; name?: string; profileType?: string }) => ({
							id: String(p.id || ''),
							slug: String(p.slug || ''),
							name: String(p.name || ''),
							profileType: (String(p.profileType || 'firm') in TYPE_META ?
								(p.profileType as ProfileType)
							:	'firm'),
						}))
						.filter((h: ConnSearchHit) => h.id && h.name && h.id !== subjectId);
					setConnHits(hits);
					setConnSearchOpen(true);
				} catch {
					/* ignore search errors */
				}
			})();
		}, 220);
		return () => window.clearTimeout(handle);
	}, [connSearch, connPeer, detail?.profile?.id]);

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

	/** Keep category-tab counts (People, Firms, …) live while backfills / imports run. */
	useEffect(() => {
		let cancelled = false;
		const refreshStats = async () => {
			if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
			try {
				const res = await fetch('/api/profiles?limit=1&stats=1', { cache: 'no-store' });
				const data = await res.json();
				if (!cancelled && res.ok && data?.ok && data.stats) {
					setStats(data.stats as ProfileStats);
				}
			} catch {
				/* non-fatal */
			}
		};
		const interval = window.setInterval(() => {
			void refreshStats();
		}, 15_000);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void refreshStats();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, []);

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
		const locFromDetail = detail.locations?.find((l) => l.role === 'hq' || l.role === 'residence')?.raw || detail.locations?.[0]?.raw || null;
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
					prev[0].name === merged.name && prev[0].primaryLocation === merged.primaryLocation && (prev[0].countryCodes || []).join() === (merged.countryCodes || []).join();
				return sameDisplay ? prev : next;
			}
			const next = [entry, ...prev.filter((e) => e.id !== entry.id && e.slug !== entry.slug)].slice(0, HISTORY_LIMIT);
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

	const detailFinraCrd =
		detail && (detail.profile.profileType === 'person' || detail.profile.profileType === 'firm') ?
			resolveProfileFinraCrd(detail.profile.profileType, detail.profile.metadata, detail.identifiers)
		:	null;

	// FINRA / SEC disclosures below summary when person|firm has a CRD.
	useEffect(() => {
		if (!detail?.profile?.id || mainView !== 'profile' || !detailFinraCrd) {
			setFinraDisclosures(null);
			setFinraDisclosuresError(null);
			setLoadingFinraDisclosures(false);
			return;
		}
		let cancelled = false;
		setLoadingFinraDisclosures(true);
		setFinraDisclosuresError(null);
		const profileKey = detail.profile.slug || detail.profile.id;
		void (async () => {
			try {
				const res = await fetch(`/api/profiles/${encodeURIComponent(profileKey)}/disclosures`, {
					cache: 'no-store',
				});
				const data = (await res.json()) as (ProfileFinraDisclosures | { ok: false; error?: string }) & {
					skip?: boolean;
					error?: string;
					timeline?: { added?: number; updated?: number; written?: number } | null;
				};
				if (cancelled) return;
				if (!res.ok || (data as { ok?: boolean }).ok === false) {
					setFinraDisclosures(null);
					setFinraDisclosuresError(data.error || `HTTP ${res.status}`);
					return;
				}
				if (data.skip) {
					setFinraDisclosures(null);
					return;
				}
				setFinraDisclosures(data as ProfileFinraDisclosures);
				const added = Number(data.timeline?.added || 0);
				const cleared = Number(
					(data.timeline as { clearedStubs?: number } | null | undefined)?.clearedStubs || 0,
				);
				if (added > 0 || cleared > 0) {
					// New disclosure rows (or stub cleanup) — refresh Timeline tab counts/entries.
					void loadDetail(profileKey);
					if (profileTab === 'timeline') void loadTimeline(profileKey);
				}
			} catch (err) {
				if (cancelled) return;
				setFinraDisclosures(null);
				setFinraDisclosuresError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoadingFinraDisclosures(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		detail?.profile?.id,
		detail?.profile?.slug,
		detailFinraCrd,
		mainView,
		loadDetail,
		loadTimeline,
		profileTab,
	]);

	// Browser tab: "Profile Name · Profiles" (or Alignments / Profiles browse).
	useEffect(() => {
		const prev = document.title;
		let next = 'Profiles';
		if (mainView === 'alignments') {
			next = 'Alignment Triage · Profiles';
		} else if (detail?.profile?.name?.trim()) {
			next = `${detail.profile.name.trim()} · Profiles`;
		}
		document.title = next;
		return () => {
			document.title = prev;
		};
	}, [mainView, detail?.profile?.name]);

	useEffect(() => {
		if (!selectedId || mainView !== 'profile' || profileTab !== 'timeline') return;
		const timer = setTimeout(() => {
			void loadTimeline(selectedId, {
				includeLinkedEvents: detail?.profile?.profileType === 'historic_event' ? false : undefined,
			});
		}, 0);
		return () => clearTimeout(timer);
	}, [selectedId, mainView, profileTab, loadTimeline, detail?.profile?.profileType]);

	// Auto-refresh profile detail & timeline while background auto-research pipeline is running.
	const autoResearchState = (detail?.profile?.metadata as { autoResearch?: { status?: string } } | undefined)?.autoResearch?.status;
	useEffect(() => {
		const pid = detail?.profile?.id;
		const ptype = detail?.profile?.profileType;
		if (!pid || autoResearchState !== 'running') return;
		let cancelled = false;
		let attempts = 0;
		const timer = setInterval(async () => {
			if (cancelled) return;
			attempts += 1;
			if (attempts > 30) {
				clearInterval(timer);
				return;
			}
			try {
				const res = await fetch(`/api/profiles/${encodeURIComponent(pid)}`, { cache: 'no-store' });
				const data = await res.json();
				if (cancelled || !res.ok || !data?.ok) return;
				const nextStatus = (data.profile?.metadata as { autoResearch?: { status?: string } } | undefined)?.autoResearch?.status;
				if (nextStatus && nextStatus !== 'running') {
					clearInterval(timer);
					setDetail(data as ProfileDetail);
					await loadTimeline(pid, {
						includeLinkedEvents: ptype === 'historic_event' ? false : undefined,
					});
					await loadList({ resetOffset: true });
				}
			} catch {
				/* ignore transient poll error */
			}
		}, 4000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [detail?.profile?.id, detail?.profile?.profileType, autoResearchState, loadTimeline, loadList]);

	// Resolve ## Related profiles / ## Linked ... / ## See also bullets into clickable in-app profile links.
	useEffect(() => {
		if (!detail?.profile?.id || mainView !== 'profile') {
			setOverviewRelatedProfileLinks(null);
			return;
		}
		const profileId = detail.profile.id;
		const summary = String(detail.profile.summary || '');
		const blocks = parseSummaryBlocks(summary, { sourceDate: detail.profile.startDate });

		// Pre-populate from already-loaded connected profiles (0ms instant hits).
		const initial: Record<string, OverviewEventLink> = {};
		for (const l of detail.links || []) {
			const isFrom = l.fromProfileId === profileId;
			const peerId = isFrom ? l.toProfileId : l.fromProfileId;
			const peerSlug = isFrom ? l.toSlug : l.fromSlug;
			const peerName = isFrom ? l.toName : l.fromName;
			if (!peerId || !peerName) continue;
			initial[peerName] = { id: peerId, slug: peerSlug || peerId, name: peerName };
		}

		// Collect bullet titles/items inside Related / Linked / See also sections (and any bullet segments).
		const queries: string[] = [];
		const pushQ = (s: string) => {
			const t = String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
			if (t.length >= 3 && !/^https?:\/\//i.test(t) && !queries.includes(t)) queries.push(t);
		};
		let inRelatedSection = false;
		for (const b of blocks) {
			if (b.kind === 'heading') {
				inRelatedSection = /^(?:related|linked|see also|connections?|peers?)\b/i.test(b.text.trim());
				continue;
			}
			if (b.kind === 'grid') {
				for (const row of b.rows) {
					if (!/^(?:see(?:\s+also)?|related(?:\s+profiles?)?|linked(?:\s+profiles?)?)$/i.test(String(row.label || '').trim())) {
						continue;
					}
					const cleanedVal = String(row.value || '').replace(/\.\s*$/, '').trim();
					if (cleanedVal.includes('·')) {
						for (const seg of cleanedVal.split(/\s*·\s*/)) pushQ(seg.replace(/\.\s*$/, ''));
					} else {
						pushQ(cleanedVal);
					}
				}
			}
			if (b.kind === 'bullets' && inRelatedSection) {
				for (const e of b.entries) {
					if (e.href) continue;
					if (e.title) pushQ(e.title);
					if (e.text) {
						pushQ(e.text);
						if (e.text.includes('·')) {
							for (const seg of e.text.split(/\s*·\s*/)) pushQ(seg);
						}
					}
				}
			}
		}

		if (Object.keys(initial).length) {
			setOverviewRelatedProfileLinks(initial);
		}
		if (queries.length === 0) {
			if (!Object.keys(initial).length) setOverviewRelatedProfileLinks(null);
			return;
		}

		let cancelled = false;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const res = await fetch('/api/profiles/resolve-historic-events', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							titles: queries.slice(0, 80),
							excludeProfileId: profileId,
							allTypes: true,
						}),
					});
					const data = await res.json();
					if (!cancelled && data?.ok && data.links && typeof data.links === 'object') {
						const merged = { ...initial, ...(data.links as Record<string, OverviewEventLink>) };
						setOverviewRelatedProfileLinks(Object.keys(merged).length ? merged : null);
					}
				} catch {
					/* best effort */
				}
			})();
		}, 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [detail?.profile?.id, detail?.profile?.summary, detail?.profile?.startDate, detail?.links, mainView]);

	// Historic events: resolve Overview Timeline claims → event profiles (same linking as Timeline tab).
	useEffect(() => {
		if (!detail?.profile?.id || mainView !== 'profile') return;
		if (detail.profile.profileType !== 'historic_event') {
			setOverviewEventLinks(null);
			return;
		}
		const profileId = detail.profile.id;
		const summary = String(detail.profile.summary || '');
		const claims: string[] = [];
		for (const m of summary.matchAll(/^-\s+\*\*[^*]+\*\*\s+[—–-]\s+(.+)$/gm)) {
			const claim = String(m[1] || '').trim();
			if (claim.length >= 8) claims.push(claim);
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void (async () => {
				const links: Record<string, OverviewEventLink> = {};
				try {
					// Prefetch own timeline so tab + overview share linkedProfile* resolution.
					const params = new URLSearchParams();
					params.set('detectGaps', '0');
					params.set('includeLinkedEvents', '0');
					params.set('limit', '200');
					const tlRes = await fetch(
						`/api/profiles/${encodeURIComponent(profileId)}/timeline?${params.toString()}`,
						{ cache: 'no-store' },
					);
					const tlData = await tlRes.json();
					if (tlData?.ok) {
						if (!cancelled) setTimeline(tlData as ProfileTimelineResult);
						for (const e of Array.isArray(tlData.entries) ? tlData.entries : []) {
							const slug = e.linkedProfileSlug || e.linkedProfileId;
							if (!slug) continue;
							const hit: OverviewEventLink = {
								id: String(e.linkedProfileId || slug),
								slug: String(e.linkedProfileSlug || slug),
								name: String(e.linkedProfileName || e.title || slug),
							};
							if (e.title) links[String(e.title)] = hit;
							if (e.summary) links[String(e.summary)] = hit;
						}
					}
					if (claims.length) {
						const res = await fetch('/api/profiles/resolve-historic-events', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ titles: claims.slice(0, 80), excludeProfileId: profileId }),
						});
						const data = await res.json();
						if (data?.ok && data.links && typeof data.links === 'object') {
							Object.assign(links, data.links as Record<string, OverviewEventLink>);
						}
					}
				} catch {
					/* keep whatever we have */
				}
				if (!cancelled) setOverviewEventLinks(Object.keys(links).length ? links : null);
			})();
		}, 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [detail?.profile?.id, detail?.profile?.profileType, detail?.profile?.summary, mainView]);

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
				mode === 'full' ?
					`Synced all corpora & recomputed alignments in ${(ms / 1000).toFixed(1)}s (${data.stats?.totalProfiles ?? 0} profiles, ${data.stats?.totalAlignments ?? 0} alignments).`
				:	`Recomputed alignments in ${ms}ms (${data.alignment?.totalUpserted ?? 0} candidates).`,
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
				newType === 'person' && newEmployer.trim() ?
					[
						{
							orgName: newEmployer.trim(),
							orgCategory: newEmployerCategory,
							role: newEmployerRole.trim() || null,
							location: newLocation.trim() || null,
						},
					]
				:	undefined;
			const res = await fetch('/api/profiles', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					profileType: newType,
					name: newName.trim(),
					summary: newSummary.trim(),
					startDate: newStartDate.trim()
						? normalizeIsoDate(newStartDate.trim()).date || newStartDate.trim()
						: null,
					endDate: newEndDate.trim()
						? normalizeIsoDate(newEndDate.trim()).date || newEndDate.trim()
						: null,
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
			setNewEndDate('');
			setNewEmployer('');
			setNewEmployerRole('');
			setSelectedId(String(data.profile.id));
			setMainView('profile');
			await loadList();
			const syncedCount = Number(data?.timelineSync?.upsertedOwn || 0);
			const autoQueued = Boolean(data?.autoResearch?.scheduled);
			setBanner(
				`${
					syncedCount > 0
						? `Created profile "${data.profile.name}" with ${syncedCount} timeline milestones.`
						: `Created profile "${data.profile.name}".`
				}${autoQueued ? ' Auto-validation, API/RSS check, web/PDF/data-layer crawl & entity discovery running in background…' : ''}`,
			);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreating(false);
		}
	}

	function collectAltNamesForEdit(d: ProfileDetail): string[] {
		const canonicalLow = d.profile.name.trim().toLowerCase().replace(/\s+/g, ' ');
		const seen = new Set<string>([canonicalLow]);
		const out: string[] = [];
		const push = (raw: string) => {
			const cleaned = raw
				.replace(/[\[\]]+/g, '')
				.replace(/\s+/g, ' ')
				.trim();
			const low = cleaned.toLowerCase();
			if (!low || seen.has(low)) return;
			seen.add(low);
			out.push(cleaned);
		};
		for (const a of d.aliases) {
			if (a.aliasKind === 'other_name') push(a.alias);
		}
		if (out.length === 0) {
			for (const a of d.aliases) {
				if (a.aliasKind !== 'former_name' && a.aliasKind !== 'name') continue;
				push(a.alias);
				if (out.length >= 4) break;
			}
		}
		return out;
	}

	function beginProfileEdit() {
		if (!detail) return;
		setTypeDraft(detail.profile.profileType);
		setNameDraft(detail.profile.name);
		setAltNamesDraft(collectAltNamesForEdit(detail).join(' · '));
		setSummaryDraft(detail.profile.summary || '');
		setLifeStartDraft(formatDateDraftOnBlur(detail.profile.startDate || ''));
		setLifeEndDraft(formatDateDraftOnBlur(detail.profile.endDate || ''));
		setAliasRowsDraft(
			detail.aliases
				// other_name is edited under the title (altNamesDraft → replaceOtherNames)
				.filter((a) => a.aliasKind !== 'slug' && a.aliasKind !== 'other_name')
				.map((a) => ({
					key: a.id,
					id: a.id,
					alias: a.alias,
					aliasKind: a.aliasKind === 'former_name' || a.aliasKind === 'acronym' ? a.aliasKind : ('name' as AliasKind),
					deleted: false,
				})),
		);
		setLocationRowsDraft(
			detail.locations.map((loc) => ({
				key: loc.id,
				id: loc.id,
				raw: loc.raw,
				role: loc.role,
				confirmed: Boolean(loc.confirmed),
				deleted: false,
			})),
		);
		setPendingDeleteIdentIds([]);
		setPendingNewIdents([]);
		setAliasDraft('');
		setIdentValueDraft('');
		setLocationDraft('');
		setLocationRoleDraft(
			detail.profile.profileType === 'person' ? 'residence'
			: detail.profile.profileType === 'historic_event' ? 'event_site'
			: 'hq',
		);
		setLocationConfirmDraft(true);
		setEditingAliasId(null);
		setEditingLocationId(null);
		setDeleteConfirmOpen(false);
		setDeleteConfirmName('');
		const empPeerIds = new Set(
			detail.profile.profileType === 'person' ?
				detail.employmentHistory.map((e) => e.orgProfileId).filter((x): x is string => Boolean(x))
			:	[],
		);
		setConnLinkDrafts(
			detail.links
				.filter((l) => {
					if (l.relationType === 'family_or_associate') return false;
					const peerId = l.fromProfileId === detail.profile.id ? l.toProfileId : l.fromProfileId;
					const peerType = (l.fromProfileId === detail.profile.id ? l.toType : l.fromType) || 'firm';
					if (peerType === 'historic_event') return false;
					if (empPeerIds.has(peerId)) return false;
					return true;
				})
				.map((l) => {
					const role = l.roleLabel || '';
					const start = formatDateDraftOnBlur(l.startDate || '');
					const end = formatDateDraftOnBlur(l.endDate || '');
					const note = scrubEvidenceNoteSourceTags(l.evidenceNote || '');
					return {
						id: l.id,
						relationType: l.relationType,
						roleLabel: role,
						startDate: start,
						endDate: end,
						evidenceNote: note,
						deleted: false,
						origRelationType: l.relationType,
						origRoleLabel: role,
						origStartDate: start,
						origEndDate: end,
						origEvidenceNote: note,
					};
				}),
		);
		setProfileEditing(true);
	}

	function cancelProfileEdit() {
		setProfileEditing(false);
		setEditingAliasId(null);
		setEditingLocationId(null);
		setPendingDeleteIdentIds([]);
		setConnLinkDrafts([]);
		setPendingNewIdents([]);
		setAliasDraft('');
		setIdentValueDraft('');
		setLocationDraft('');
		setDeleteConfirmOpen(false);
		setDeleteConfirmName('');
	}

	async function handleDeleteProfile() {
		if (!detail?.profile) return;
		const expected = detail.profile.name.trim();
		if (deleteConfirmName.trim().toLowerCase() !== expected.toLowerCase()) {
			setError(`Type the full profile name exactly to confirm delete: “${expected}”`);
			return;
		}
		const profileKey = detail.profile.slug || detail.profile.id;
		const deletedName = detail.profile.name;
		setDeletingProfile(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(profileKey)}`, { method: 'DELETE' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to delete profile');
			setProfileEditing(false);
			setDeleteConfirmOpen(false);
			setDeleteConfirmName('');
			setConnLinkDrafts([]);
			setDetail(null);
			setSelectedId(null);
			setTimeline(null);
			skipNextPushRef.current = true;
			syncUrl({ profile: null, view: 'profile' }, 'replace');
			await loadList();
			setBanner(`Deleted “${deletedName}”.`);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setDeletingProfile(false);
		}
	}

	async function patchProfile(profileKey: string, body: Record<string, unknown>): Promise<ProfileDetail> {
		const res = await fetch(`/api/profiles/${encodeURIComponent(profileKey)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await res.json();
		if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to save profile');
		return data as ProfileDetail;
	}

	async function handleQuickChangeProfileType(nextType: ProfileType) {
		if (!detail || !selectedId || nextType === detail.profile.profileType) return;
		const prevType = detail.profile.profileType;
		const prevSlug = detail.profile.slug || selectedId;
		const prevLabel = TYPE_META[prevType]?.label || prevType;
		const nextLabel = TYPE_META[nextType]?.label || nextType;
		setSavingCategory(true);
		setError(null);
		try {
			const latest = await patchProfile(prevSlug, {
				profileType: nextType,
				userTouch: true,
				skipAutoResearch: true,
			});
			const nextSlug = latest.profile.slug || latest.profile.id;
			setDetail(latest);
			setTypeDraft(latest.profile.profileType);
			setSelectedId(nextSlug);
			syncUrl({ profile: nextSlug, view: 'profile' }, 'replace');
			await refreshLeftListForProfile({
				profileKey: nextSlug,
				profileType: latest.profile.profileType,
				keepTab: true,
			});
			setBanner(
				`Moved “${latest.profile.name}” from ${prevLabel} to ${nextLabel}${
					nextSlug !== prevSlug ? ` — URL is now /profiles/${nextSlug.replace(':', '/')}` : ''
				}.`,
			);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingCategory(false);
		}
	}

	async function handleApplyProfileEdit() {
		if (!selectedId || !detail) return;
		if (!nameDraft.trim()) {
			setError('Name cannot be empty.');
			return;
		}
		setSavingCore(true);
		setError(null);
		const prevSlug = detail.profile.slug || selectedId;
		let profileKey = selectedId;
		try {
			let latest = detail;
			let timelineSync: {
				parsed?: number;
				upsertedOwn?: number;
				mirroredRelated?: number;
				reorder?: { changed?: boolean; method?: string; datedCount?: number };
			} | null = null;

			const nameChanged = nameDraft.trim() !== detail.profile.name;
			const typeChanged = typeDraft !== detail.profile.profileType;
			const summaryChanged = summaryDraft !== (detail.profile.summary || '');
			const startChanged = !sameProfileDate(lifeStartDraft, detail.profile.startDate);
			const endChanged = !sameProfileDate(lifeEndDraft, detail.profile.endDate);
			if (nameChanged || typeChanged || summaryChanged || startChanged || endChanged) {
				latest = await patchProfile(profileKey, {
					...(nameChanged ? { name: nameDraft.trim() } : {}),
					...(typeChanged ? { profileType: typeDraft } : {}),
					...(summaryChanged ? { summary: summaryDraft } : {}),
					...(startChanged || endChanged ?
						{
							startDate: lifeStartDraft.trim() ? normalizeIsoDate(lifeStartDraft.trim()).date || lifeStartDraft.trim() : null,
							endDate: lifeEndDraft.trim() ? normalizeIsoDate(lifeEndDraft.trim()).date || lifeEndDraft.trim() : null,
						}
					:	{}),
				});
				profileKey = latest.profile.slug || latest.profile.id;
				const syncFromPatch = (
					latest as ProfileDetail & {
						timelineSync?: {
							parsed?: number;
							upsertedOwn?: number;
							mirroredRelated?: number;
							reorder?: { changed?: boolean; method?: string; datedCount?: number };
						};
					}
				).timelineSync;
				if (syncFromPatch) timelineSync = syncFromPatch;
			}

			const sep = /[·•|]/.test(altNamesDraft) ? /[·•|]+/ : /[,;]+/;
			const nextOtherNames = altNamesDraft
				.split(sep)
				.map((s) => s.replace(/\s+/g, ' ').trim())
				.filter(Boolean);
			const prevOther = detail.aliases
				.filter((a) => a.aliasKind === 'other_name')
				.map((a) => a.alias.trim())
				.sort();
			const nextOtherSorted = [...nextOtherNames].sort();
			const otherChanged = prevOther.length !== nextOtherSorted.length || prevOther.some((v, i) => v !== nextOtherSorted[i]);
			if (otherChanged) {
				latest = await patchProfile(profileKey, { replaceOtherNames: nextOtherNames });
				profileKey = latest.profile.slug || latest.profile.id;
			}

			// Under-title altNamesDraft owns other_name via replaceOtherNames above.
			const originalAliases = new Map(detail.aliases.filter((a) => a.aliasKind !== 'slug' && a.aliasKind !== 'other_name').map((a) => [a.id, a]));
			for (const row of aliasRowsDraft) {
				if (row.aliasKind === 'other_name') continue;
				if (row.deleted && row.id) {
					latest = await patchProfile(profileKey, { deleteAlias: row.id });
					profileKey = latest.profile.slug || latest.profile.id;
					continue;
				}
				if (row.deleted || !row.alias.trim()) continue;
				if (!row.id) {
					latest = await patchProfile(profileKey, {
						addAlias: { alias: row.alias.trim(), aliasKind: row.aliasKind },
					});
					profileKey = latest.profile.slug || latest.profile.id;
					continue;
				}
				const orig = originalAliases.get(row.id);
				if (orig && (orig.alias !== row.alias.trim() || (orig.aliasKind || 'name') !== row.aliasKind)) {
					latest = await patchProfile(profileKey, {
						updateAlias: {
							id: row.id,
							alias: row.alias.trim(),
							aliasKind: row.aliasKind,
						},
					});
					profileKey = latest.profile.slug || latest.profile.id;
				}
			}

			const originalLocs = new Map(detail.locations.map((l) => [l.id, l]));
			for (const row of locationRowsDraft) {
				if ((row.deleted || !row.raw.trim()) && row.id) {
					latest = await patchProfile(profileKey, { deleteLocation: row.id });
					profileKey = latest.profile.slug || latest.profile.id;
					continue;
				}
				if (row.deleted || !row.raw.trim()) continue;
				if (!row.id) {
					latest = await patchProfile(profileKey, {
						addLocation: {
							raw: row.raw.trim(),
							role: row.role,
							confirmed: row.confirmed,
						},
					});
					profileKey = latest.profile.slug || latest.profile.id;
					continue;
				}
				const orig = originalLocs.get(row.id);
				if (orig && (orig.raw !== row.raw.trim() || orig.role !== row.role || Boolean(orig.confirmed) !== row.confirmed)) {
					latest = await patchProfile(profileKey, {
						updateLocation: {
							id: row.id,
							raw: row.raw.trim(),
							role: row.role,
							confirmed: row.confirmed,
						},
					});
					profileKey = latest.profile.slug || latest.profile.id;
				}
			}
			if (locationDraft.trim()) {
				latest = await patchProfile(profileKey, {
					addLocation: {
						raw: locationDraft.trim(),
						role: locationRoleDraft,
						confirmed: locationConfirmDraft,
					},
				});
				profileKey = latest.profile.slug || latest.profile.id;
				setLocationDraft('');
			}

			for (const identId of pendingDeleteIdentIds) {
				latest = await patchProfile(profileKey, { deleteIdentifier: identId });
				profileKey = latest.profile.slug || latest.profile.id;
			}
			for (const ident of pendingNewIdents) {
				if (!ident.value.trim()) continue;
				latest = await patchProfile(profileKey, {
					addIdentifier: { scheme: ident.scheme, value: ident.value.trim() },
				});
				profileKey = latest.profile.slug || latest.profile.id;
			}

			const subjectId = latest.profile.id;
			let linksMutated = false;
			for (const row of connLinkDrafts) {
				if (row.deleted) {
					const delRes = await fetch('/api/profiles/links', {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ linkId: row.id, profileId: subjectId }),
					});
					const delData = await delRes.json();
					if (!delRes.ok || !delData?.ok) {
						throw new Error(delData?.error || `Failed to remove connection ${row.id}`);
					}
					linksMutated = true;
					continue;
				}
				const nextStart = row.startDate.trim()
					? normalizeIsoDate(row.startDate.trim()).date || row.startDate.trim()
					: '';
				const nextEnd = row.endDate.trim()
					? normalizeIsoDate(row.endDate.trim()).date || row.endDate.trim()
					: '';
				const nextRole = row.roleLabel.trim();
				const nextNote = row.evidenceNote.trim();
				const changed =
					row.relationType !== row.origRelationType ||
					nextRole !== row.origRoleLabel.trim() ||
					nextStart !== (normalizeIsoDate(row.origStartDate.trim()).date || row.origStartDate.trim()) ||
					nextEnd !== (normalizeIsoDate(row.origEndDate.trim()).date || row.origEndDate.trim()) ||
					nextNote !== row.origEvidenceNote.trim();
				if (!changed) continue;
				const patchRes = await fetch('/api/profiles/links', {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						linkId: row.id,
						profileId: subjectId,
						relationType: row.relationType,
						roleLabel: nextRole || null,
						startDate: nextStart || null,
						endDate: nextEnd || null,
						evidenceNote: nextNote,
					}),
				});
				const patchData = await patchRes.json();
				if (!patchRes.ok || !patchData?.ok) {
					throw new Error(patchData?.error || `Failed to update connection ${row.id}`);
				}
				linksMutated = true;
			}
			if (linksMutated) {
				const reloadRes = await fetch(`/api/profiles/${encodeURIComponent(profileKey)}`, { cache: 'no-store' });
				const reloadData = await reloadRes.json();
				if (!reloadRes.ok || !reloadData?.ok) {
					throw new Error(reloadData?.error || 'Failed to reload after updating connections');
				}
				latest = reloadData as ProfileDetail;
				profileKey = latest.profile.slug || latest.profile.id;
			}

			// Ensure userTouchedAt is bumped even if only drafts matched with no field PATCH.
			latest = await patchProfile(profileKey, { userTouch: true });
			profileKey = latest.profile.slug || latest.profile.id;

			setDetail(latest);
			setProfileEditing(false);
			setPendingDeleteIdentIds([]);
			setConnLinkDrafts([]);
			setPendingNewIdents([]);
			if (summaryChanged) {
				await loadTimeline(profileKey, {
					includeLinkedEvents: latest.profile.profileType === 'historic_event' ? false : undefined,
				});
			}
			const nextSlug = latest.profile.slug;
			const autoResearchNote =
				' Background auto-validation, API/RSS check, web/PDF/data-layer crawl & entity discovery scheduled.';
			if (nextSlug && nextSlug !== prevSlug) {
				setSelectedId(nextSlug);
				syncUrl({ profile: nextSlug, view: 'profile' }, 'replace');
				setBanner(`Applied changes — URL is now /profiles/${nextSlug.replace(':', '/')}.${autoResearchNote}`);
			} else if (summaryChanged && timelineSync && Number(timelineSync.parsed || 0) > 0) {
				const mirrored = Number(timelineSync.mirroredRelated || 0);
				const reordered =
					timelineSync.reorder?.changed ?
						timelineSync.reorder.method === 'ollama' ?
							' · Overview Timeline reordered newest-first (Ollama)'
						:	' · Overview Timeline reordered newest-first'
					:	'';
				setBanner(
					`Applied profile edits. Timeline tab synced ${timelineSync.upsertedOwn || 0} overview milestones${
						mirrored > 0 ? ` · mirrored ${mirrored} onto linked events` : ''
					}${reordered}.${autoResearchNote}`,
				);
			} else if (summaryChanged && timelineSync?.reorder?.changed) {
				setBanner(
					`Applied profile edits. Overview Timeline reordered newest-first${
						timelineSync.reorder.method === 'ollama' ? ' (Ollama)' : ''
					}.${autoResearchNote}`,
				);
			} else {
				setBanner(`Applied profile edits.${autoResearchNote}`);
			}
			// Float edited profile to the top of the left cards (userTouchedAt sort).
			if (typeChanged) {
				await refreshLeftListForProfile({
					profileKey: latest.profile.slug || latest.profile.id,
					profileType: latest.profile.profileType,
					keepTab: true,
				});
			} else {
				setOffset(0);
				const listParams = new URLSearchParams();
				if (typeFilter === HISTORY_FILTER) listParams.set('type', 'historic_event');
				else if (typeFilter && typeFilter !== 'all') listParams.set('type', typeFilter);
				if (query.trim()) listParams.set('q', query.trim());
				if (countryCode) listParams.set('country', countryCode);
				listParams.set('limit', '60');
				listParams.set('offset', '0');
				listParams.set('stats', '1');
				const listRes = await fetch(`/api/profiles?${listParams.toString()}`, {
					cache: 'no-store',
				});
				const listData = await listRes.json();
				if (listRes.ok && listData?.ok) {
					setProfiles(Array.isArray(listData.profiles) ? listData.profiles : []);
					setTotalProfiles(Number(listData.total || 0));
					if (listData.stats) setStats(listData.stats as ProfileStats);
				} else {
					await loadList();
				}
			}
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingCore(false);
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
					eventDate: obsDate.trim()
						? normalizeIsoDate(obsDate.trim()).date || obsDate.trim()
						: null,
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
			await loadList({ resetOffset: true });
			setBanner('Added timeline observation.');
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingObs(false);
		}
	}

	async function handleAddAlias() {
		if (!selectedId || !aliasDraft.trim()) return;
		setSavingAlias(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					addAlias: { alias: aliasDraft.trim(), aliasKind: aliasKindDraft },
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			setAliasDraft('');
			setDetail(data as ProfileDetail);
			setBanner(
				aliasKindDraft === 'other_name' ? 'Added other name.'
				: aliasKindDraft === 'former_name' ? 'Added former name.'
				: 'Added alias.',
			);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingAlias(false);
		}
	}

	function beginEditAlias(a: ProfileDetail['aliases'][number]) {
		setEditingAliasId(a.id);
		setEditAliasText(a.alias);
		setEditAliasKind(a.aliasKind === 'other_name' || a.aliasKind === 'former_name' || a.aliasKind === 'acronym' ? a.aliasKind : 'name');
	}

	async function handleSaveAliasEdit() {
		if (!selectedId || !editingAliasId || !editAliasText.trim()) return;
		setSavingAlias(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					updateAlias: {
						id: editingAliasId,
						alias: editAliasText.trim(),
						aliasKind: editAliasKind,
					},
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to update name');
			setDetail(data as ProfileDetail);
			setEditingAliasId(null);
			setBanner('Updated other name / alias.');
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingAlias(false);
		}
	}

	async function handleDeleteAlias(aliasId: string, aliasLabel: string) {
		if (!selectedId) return;
		if (typeof window !== 'undefined' && !window.confirm(`Remove alias "${aliasLabel}"?`)) {
			return;
		}
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deleteAlias: aliasId }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to remove alias');
			if (editingAliasId === aliasId) setEditingAliasId(null);
			setDetail(data as ProfileDetail);
			setBanner(`Removed alias "${aliasLabel}".`);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleAddIdentifier() {
		if (!selectedId || !identValueDraft.trim()) return;
		setSavingIdent(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					addIdentifier: {
						scheme: identSchemeDraft,
						value: identValueDraft.trim(),
					},
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to add identifier');
			setIdentValueDraft('');
			setDetail(data as ProfileDetail);
			setBanner('Added identifier.');
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingIdent(false);
		}
	}

	async function handleDeleteIdentifier(identId: string, scheme: string, value: string) {
		if (!selectedId) return;
		const label = `${IDENTIFIER_SCHEME_LABELS[scheme] || scheme}: ${value}`;
		const warnCrd = scheme === 'finra_crd' ? '\n\nRemoving CRD will clear FINRA header chips until the profile is re-synced.' : '';
		if (typeof window !== 'undefined' && !window.confirm(`Remove identifier ${label}?${warnCrd}`)) {
			return;
		}
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deleteIdentifier: identId }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to remove identifier');
			setDetail(data as ProfileDetail);
			setBanner(`Removed ${label}.`);
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	async function handleAddLocation() {
		if (!selectedId || !locationDraft.trim()) return;
		setSavingLocation(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					addLocation: {
						raw: locationDraft.trim(),
						role: locationRoleDraft,
						confirmed: locationConfirmDraft,
					},
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed');
			setLocationDraft('');
			setLocationConfirmDraft(false);
			setDetail(data as ProfileDetail);
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingLocation(false);
		}
	}

	function beginEditLocation(loc: ProfileDetail['locations'][number]) {
		setEditingLocationId(loc.id);
		setEditLocationRaw(loc.raw);
		setEditLocationRole(loc.role);
		setEditLocationConfirmed(Boolean(loc.confirmed));
	}

	async function handleUpdateLocation(
		locId: string,
		patch: {
			raw?: string;
			role?: LocationRole;
			confirmed?: boolean;
		},
	) {
		if (!selectedId) return;
		setSavingLocation(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					updateLocation: { id: locId, ...patch },
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to update location');
			setEditingLocationId(null);
			setDetail(data as ProfileDetail);
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingLocation(false);
		}
	}

	async function handleSaveLocationEdit() {
		if (!editingLocationId || !editLocationRaw.trim()) return;
		await handleUpdateLocation(editingLocationId, {
			raw: editLocationRaw.trim(),
			role: editLocationRole,
			confirmed: editLocationConfirmed,
		});
	}

	async function handleDeleteLocation(locId: string) {
		if (!selectedId) return;
		if (typeof window !== 'undefined' && !window.confirm('Delete this location?')) return;
		setSavingLocation(true);
		setError(null);
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(selectedId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deleteLocation: locId }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to delete location');
			if (editingLocationId === locId) setEditingLocationId(null);
			setDetail(data as ProfileDetail);
			await loadList();
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingLocation(false);
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
					startDate: empStart.trim()
						? normalizeIsoDate(empStart.trim()).date || empStart.trim()
						: null,
					endDate: empEnd.trim()
						? normalizeIsoDate(empEnd.trim()).date || empEnd.trim()
						: null,
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
			await loadList({ resetOffset: true });
			setBanner('Added employment history record.');
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingEmp(false);
		}
	}

	async function handleAddConnection(e: React.FormEvent) {
		e.preventDefault();
		if (!detail?.profile?.id || !connPeer) {
			setError('Pick an existing profile from search results before adding a connection.');
			return;
		}
		if (connPeer.id === detail.profile.id) {
			setError('Cannot link a profile to itself.');
			return;
		}
		setSavingConn(true);
		setError(null);
		const peerName = connPeer.name;
		const relLabel = connRelation.replace(/_/g, ' ');
		try {
			const { fromProfileId, toProfileId } = resolveConnectedLinkEndpoints(
				{ id: detail.profile.id, profileType: detail.profile.profileType },
				{ id: connPeer.id, profileType: connPeer.profileType },
				connRelation,
			);
			const res = await fetch('/api/profiles/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fromProfileId,
					toProfileId,
					relationType: connRelation,
					roleLabel: connRole.trim() || null,
					startDate: connStart.trim()
						? normalizeIsoDate(connStart.trim()).date || connStart.trim()
						: null,
					endDate: connEnd.trim()
						? normalizeIsoDate(connEnd.trim()).date || connEnd.trim()
						: null,
					evidenceNote: connNote.trim() || '',
					sourceCorpus: 'manual-ui',
					status: 'verified',
					confidence: 0.95,
				}),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to add connection');
			setConnSearch('');
			setConnHits([]);
			setConnPeer(null);
			setConnRole('');
			setConnStart('');
			setConnEnd('');
			setConnNote('');
			setConnSearchOpen(false);
			await loadDetail(selectedId || detail.profile.slug || detail.profile.id);
			await loadList({ resetOffset: true });
			setBanner(`Linked ${peerName} (${relLabel}).`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingConn(false);
		}
	}

	async function refreshLeftListForProfile(opts: { profileKey: string; profileType?: string | null; keepTab?: boolean }) {
		const keepType = String(opts.profileType || '');
		const nextTypeFilter =
			keepType === 'historic_event' ? HISTORY_FILTER
			: keepType ? keepType
			: 'all';
		setPendingCategorySync(true);
		setQuery('');
		setQueryDraft('');
		setCountryCode('');
		setCountryQuery('');
		setCountryMenuOpen(false);
		setOffset(0);
		setTypeFilter(nextTypeFilter);
		setSelectedId(opts.profileKey);
		setMainView('profile');
		if (!opts.keepTab) setProfileTab('overview');
		const listParams = new URLSearchParams();
		if (nextTypeFilter === HISTORY_FILTER) listParams.set('type', 'historic_event');
		else if (nextTypeFilter && nextTypeFilter !== 'all') listParams.set('type', nextTypeFilter);
		listParams.set('limit', '60');
		listParams.set('offset', '0');
		listParams.set('stats', '1');
		const listRes = await fetch(`/api/profiles?${listParams.toString()}`, { cache: 'no-store' });
		const listData = await listRes.json();
		if (listRes.ok && listData?.ok) {
			setProfiles(Array.isArray(listData.profiles) ? listData.profiles : []);
			setTotalProfiles(Number(listData.total || 0));
			if (listData.stats) setStats(listData.stats as ProfileStats);
		}
		await loadDetail(opts.profileKey);
	}

	async function handleTriageAlignment(id: string, status: AlignmentStatus, opts?: { skipAutoMerge?: boolean; quiet?: boolean }) {
		setSavingAlignmentId(id);
		setError(null);
		const target = globalAlignments.find((a) => a.id === id) || detail?.alignments?.find((a) => a.id === id) || null;
		// Optimistic local update so Accept/Dismiss feels immediate on the profile tab.
		if (detail?.alignments?.some((a) => a.id === id)) {
			setDetail({
				...detail,
				alignments: detail.alignments.map((a) => (a.id === id ? { ...a, status } : a)),
			});
		}
		if (globalAlignments.some((a) => a.id === id)) {
			setGlobalAlignments((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
		}
		try {
			const res = await fetch('/api/profiles/alignments', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, status }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to update alignment');
			const al = (data.alignment || target) as AlignmentCandidate | null;
			// Accept auto-Merges only on shared major IDs (CRD/CIK/…).
			// same_entity_alias (name overlap) confirms only — Merge must be explicit so
			// similarly named banks/firms with different IDs stay separate.
			const shouldAutoMerge = !opts?.skipAutoMerge && status === 'confirmed' && al?.rightProfileId && al.alignmentKind === 'shared_identifier';
			if (shouldAutoMerge && al) {
				const mergeTarget = pickCanonicalMergeTarget(al);
				if (mergeTarget) {
					const mergeRes = await fetch('/api/profiles/merge', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							keepId: mergeTarget.keepId,
							mergeId: mergeTarget.mergeId,
						}),
					});
					const mergeData = await mergeRes.json();
					if (!mergeRes.ok || !mergeData?.ok) {
						throw new Error(mergeData?.error || 'Accepted, but auto-merge failed');
					}
					const kept = mergeData.kept as { id?: string; slug?: string; profileType?: string; name?: string } | undefined;
					const keepKey = String(kept?.slug || kept?.id || mergeTarget.keepId);
					if (!opts?.quiet) {
						setBanner(`Accepted & merged "${mergeTarget.mergeLabel}" into "${kept?.name || mergeTarget.keepLabel}".`);
						setLastEnrichReport(null);
						await refreshLeftListForProfile({
							profileKey: keepKey,
							profileType: kept?.profileType || al.leftType || null,
						});
						await loadGlobalAlignments();
					}
					return { ok: true as const, merged: true as const, keepKey };
				}
			}
			if (opts?.quiet) {
				return { ok: true as const, merged: false as const };
			}
			if (status === 'confirmed' && al?.leftProfileId) {
				const keepKey = String(al.leftSlug || al.leftProfileId);
				const keepType = al.leftType || null;
				setBanner(`Accepted alignment — ${al.leftName || keepKey} moved to top of list.`);
				await refreshLeftListForProfile({ profileKey: keepKey, profileType: keepType });
				await loadGlobalAlignments();
			} else {
				if (selectedId && mainView === 'profile') await loadDetail(selectedId);
				if (mainView === 'alignments') await loadGlobalAlignments();
			}
			return { ok: true as const, merged: false as const };
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
			if (!opts?.quiet) {
				if (selectedId && mainView === 'profile') await loadDetail(selectedId);
				if (mainView === 'alignments') await loadGlobalAlignments();
			}
			return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
		} finally {
			setSavingAlignmentId(null);
		}
	}

	/**
	 * Prefer firm: / person: canonical cards when merging shared-CRD or alias twins.
	 * Firm CRD merges must keep a firm profile (not education/gov mistypes).
	 * Person↔org finra_crd pairs are different CRD namespaces — block Merge.
	 */
	function pickCanonicalMergeTarget(al: AlignmentCandidate): {
		keepId: string;
		mergeId: string;
		keepLabel: string;
		mergeLabel: string;
	} | null {
		if (!al.rightProfileId) return null;
		const left = {
			id: al.leftProfileId,
			type: String(al.leftType || ''),
			slug: String(al.leftSlug || ''),
			name: String(al.leftName || al.leftSlug || al.leftProfileId),
		};
		const right = {
			id: al.rightProfileId,
			type: String(al.rightType || ''),
			slug: String(al.rightSlug || ''),
			name: String(al.rightName || al.rightSlug || al.rightProfileId),
		};
		const isFinraCrd = al.alignmentKind === 'shared_identifier' && /finra_crd/i.test(al.rationale || '');
		if (isFinraCrd) {
			const leftPerson = left.type === 'person';
			const rightPerson = right.type === 'person';
			if (leftPerson !== rightPerson) {
				setError(
					'Cannot merge: finra_crd is a shared numeric namespace for Firm CRDs and Individual CRDs. Merge only firm↔firm (same Firm CRD) or person↔person (same Individual CRD).',
				);
				return null;
			}
		}
		// Client hint only — server mergeProfiles re-picks keep by official IDs / longest name.
		const score = (p: { type: string; slug: string; name: string }) => {
			let s = 0;
			if (p.type === 'firm') s += 20;
			if (p.type === 'person') s += 15;
			if (p.slug.startsWith('firm:')) s += 10;
			if (p.slug.startsWith('person:')) s += 8;
			if (p.type === 'education' || p.type === 'government' || p.type === 'nonprofit' || p.type === 'medical_hospital') {
				s += 2;
			}
			// Prefer longer legal display names (server also enforces official-ID / longest).
			s += Math.min(12, Math.floor(String(p.name || '').trim().length / 8));
			const slugBody = p.slug.includes(':') ? p.slug.slice(p.slug.indexOf(':') + 1) : p.slug;
			s += Math.min(6, Math.floor(slugBody.length / 14));
			return s;
		};
		if (score(left) >= score(right)) {
			return {
				keepId: left.id,
				mergeId: right.id,
				keepLabel: left.name,
				mergeLabel: right.name,
			};
		}
		return {
			keepId: right.id,
			mergeId: left.id,
			keepLabel: right.name,
			mergeLabel: left.name,
		};
	}

	async function handleMergeProfiles(keepId: string, mergeId: string, keepLabel: string, mergeLabel: string, opts?: { skipConfirm?: boolean; quiet?: boolean }) {
		if (
			!opts?.skipConfirm &&
			typeof window !== 'undefined' &&
			!window.confirm(`Merge "${mergeLabel}" into "${keepLabel}"? All aliases, identifiers, locations, links, and timeline entries will be consolidated onto "${keepLabel}".`)
		) {
			return { ok: false as const, cancelled: true as const };
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
			const kept = data.kept as { id?: string; slug?: string; profileType?: string; name?: string } | undefined;
			const keepKey = String(kept?.slug || kept?.id || keepId);
			const keepType = String(kept?.profileType || '');
			const keepName = String(kept?.name || keepLabel);
			if (!opts?.quiet) {
				setBanner(`Merged "${mergeLabel}" into "${keepName}".`);
				setLastEnrichReport(null);
				await refreshLeftListForProfile({ profileKey: keepKey, profileType: keepType || null });
				await loadGlobalAlignments();
			}
			return { ok: true as const, keepKey, keepType, keepName };
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
			return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
		}
	}

	function isMergeableAlignment(al: AlignmentCandidate): boolean {
		return Boolean(al.rightProfileId && (al.alignmentKind === 'same_entity_alias' || al.alignmentKind === 'shared_identifier'));
	}

	async function handleBulkAlignments(action: 'accept' | 'merge' | 'dismiss') {
		const rows = globalAlignments;
		if (!rows.length) return;

		if (action === 'accept') {
			const targets = rows.filter((a) => a.status !== 'confirmed');
			if (!targets.length) {
				setBanner('Nothing to accept on this page — all rows are already accepted.');
				return;
			}
			if (
				typeof window !== 'undefined' &&
				!window.confirm(`Accept ${targets.length} alignment(s) on this page?\n\nConfirm only — does not merge profiles. Use Merge all for alias / shared-ID pairs.`)
			) {
				return;
			}
			setBulkAlignBusy(true);
			setError(null);
			let okCount = 0;
			let failCount = 0;
			try {
				for (const al of targets) {
					const res = await handleTriageAlignment(al.id, 'confirmed', {
						skipAutoMerge: true,
						quiet: true,
					});
					if (res?.ok) okCount += 1;
					else failCount += 1;
				}
				setBanner(`Accepted ${okCount} alignment(s) on this page (confirm only, no merge).${failCount ? ` ${failCount} failed.` : ''}`);
				await loadGlobalAlignments();
				await loadList();
			} finally {
				setBulkAlignBusy(false);
			}
			return;
		}

		if (action === 'dismiss') {
			const targets = rows.filter((a) => a.status !== 'dismissed');
			if (!targets.length) {
				setBanner('Nothing to dismiss on this page — all rows are already dismissed.');
				return;
			}
			if (typeof window !== 'undefined' && !window.confirm(`Dismiss ${targets.length} alignment(s) on this page?`)) {
				return;
			}
			setBulkAlignBusy(true);
			setError(null);
			let okCount = 0;
			let failCount = 0;
			try {
				for (const al of targets) {
					const res = await handleTriageAlignment(al.id, 'dismissed', { quiet: true });
					if (res?.ok) okCount += 1;
					else failCount += 1;
				}
				setBanner(`Dismissed ${okCount} alignment(s) on this page.${failCount ? ` ${failCount} failed.` : ''}`);
				await loadGlobalAlignments();
			} finally {
				setBulkAlignBusy(false);
			}
			return;
		}

		// merge
		const targets = rows.filter(isMergeableAlignment);
		if (!targets.length) {
			setBanner('No mergeable rows on this page — Merge all only applies to same-entity alias / shared-identifier pairs.');
			return;
		}
		if (
			typeof window !== 'undefined' &&
			!window.confirm(
				`Merge ${targets.length} same-entity pair(s) on this page?\n\nEach duplicate profile card will be deleted into its canonical twin. This cannot be undone from the UI.`,
			)
		) {
			return;
		}
		setBulkAlignBusy(true);
		setError(null);
		let okCount = 0;
		let failCount = 0;
		let lastKeep: { key: string; type: string | null } | null = null;
		try {
			for (const al of targets) {
				const mergeTarget = pickCanonicalMergeTarget(al);
				if (!mergeTarget) {
					failCount += 1;
					continue;
				}
				// Mark accepted first (no single-row auto-merge), then merge.
				await handleTriageAlignment(al.id, 'confirmed', { skipAutoMerge: true, quiet: true });
				const res = await handleMergeProfiles(mergeTarget.keepId, mergeTarget.mergeId, mergeTarget.keepLabel, mergeTarget.mergeLabel, { skipConfirm: true, quiet: true });
				if (res?.ok) {
					okCount += 1;
					lastKeep = { key: res.keepKey || mergeTarget.keepId, type: res.keepType || null };
				} else if (!res?.cancelled) {
					failCount += 1;
				}
			}
			setBanner(`Merged ${okCount} pair(s) on this page.${failCount ? ` ${failCount} failed.` : ''}`);
			setLastEnrichReport(null);
			if (lastKeep) {
				await refreshLeftListForProfile({
					profileKey: lastKeep.key,
					profileType: lastKeep.type,
				});
			} else {
				await loadGlobalAlignments();
				await loadList();
			}
		} finally {
			setBulkAlignBusy(false);
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
			await loadList({ resetOffset: true });
			if (profileTab === 'timeline') await loadTimeline(selectedId);
			const summaryMsg =
				report.validatedSources > 0 ?
					`Validated enrichment from ${report.validatedSources} source(s) (${report.fieldsUpdated.join(', ') || 'refreshed'}).`
				:	'No validated new fields merged.';
			const noteMsg = report.heldNameOnlyNotes > 0 ? ` ${report.heldNameOnlyNotes} name-only match(es) held as review notes (NOT merged).` : '';
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

	const jumpToProfile = useCallback(
		(
			id: string,
			opts?: {
				tab?: 'overview' | 'timeline' | 'alignments';
				focusTimelineTitle?: string | null;
				label?: string | null;
			},
		) => {
			setPendingCategorySync(true);
			setQuery('');
			setQueryDraft('');
			setCountryCode('');
			setCountryQuery('');
			setCountryMenuOpen(false);
			setOffset(0);
			setSelectedId(id);
			setLastEnrichReport(null);
			setMainView('profile');
			setProfileTab(opts?.tab || 'overview');
			setTimelineFocusTitle(opts?.focusTimelineTitle?.trim() || null);
			const destLabel = String(opts?.label || '').trim();
			const fromTitle = String(opts?.focusTimelineTitle || '').trim();
			if (destLabel || fromTitle) {
				setBanner(
					fromTitle ?
						`Opened ${destLabel || id} · jumped from “${fromTitle}”.`
					:	`Opened ${destLabel || id}.`,
				);
			}
			requestAnimationFrame(() => {
				window.scrollTo({ top: 0, behavior: 'smooth' });
				detailTopRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
			});
		},
		[],
	);

	// After a timeline-entry jump, scroll the matching destination entry into view.
	useEffect(() => {
		if (!timelineFocusTitle || profileTab !== 'timeline' || loadingTimeline || !timeline) return;
		const timer = window.setTimeout(() => {
			const el = document.querySelector('[data-timeline-focus="1"]');
			if (el instanceof HTMLElement) {
				el.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}
		}, 120);
		return () => window.clearTimeout(timer);
	}, [timelineFocusTitle, profileTab, loadingTimeline, timeline]);

	return (
		<div className={`min-h-dvh ${CURRENT_ACTOR_PANEL_BG}`}>
			<main className={`mx-auto flex min-h-dvh max-w-[1380px] flex-col px-4 py-5 ${CURRENT_ACTOR_PANEL_BG}`}>
				{/* Top Header */}
				<header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
					<div>
						<div className='flex items-center gap-2 text-xs opacity-75'>
							<Link
								href='/'
								className='rounded border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-2 py-0.5 font-semibold text-[#e8eeff] no-underline hover:bg-[lab(5_4.06_-17.11_/0.75)]'>
								← Research Chat
							</Link>
							<span>local SQLite · cross-source entity &amp; timeline alignment</span>
						</div>
						<h1 className='my-1.5 text-[24px] font-semibold tracking-tight'>Entity Profiles &amp; Cross-Source Alignment</h1>
						<p className='m-0 max-w-4xl text-xs leading-relaxed opacity-80'>
							Unified canonical profiles for <strong>People</strong>, <strong>Firms</strong>, <strong>Education</strong>, <strong>Non-Profits</strong>, <strong>Hospitals</strong>,{' '}
							<strong>Government</strong>, and <strong>Historic Events</strong> — combining all local corpora to fill timeline gaps, compare angles, and surface possible
							alignments.
						</p>
					</div>
					<div className='flex flex-wrap items-center gap-2'>
						<button
							type='button'
							onClick={() => {
								const nextView = mainView === 'alignments' ? 'profile' : 'alignments';
								setMainView(nextView);
								syncUrl({
									view: nextView,
									profile: nextView === 'profile' ? detail?.profile.slug || selectedId : null,
								});
							}}
							className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-semibold ${
								mainView === 'alignments' ? 'border-[#F97316] bg-[#F97316] text-white' : (
									'border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.75)]'
								)
							}`}>
							{mainView === 'alignments' ? 'Back to Profiles' : `Alignment Triage (${stats?.alignmentsByStatus?.proposed ?? 0})`}
						</button>
						<button
							type='button'
							onClick={() => setShowCreate((v) => !v)}
							className='cursor-pointer rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-2.5 py-1.5 text-xs font-semibold text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.75)]'>
							+ New Profile
						</button>
						<button
							type='button'
							disabled={syncing}
							onClick={() => void handleSync('full')}
							className='cursor-pointer rounded-md border-none bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50'>
							{syncing ? 'Syncing & Aligning…' : 'Sync & Align All Data'}
						</button>
						<form
							className='flex min-w-[14rem] max-w-md flex-1 items-center gap-1.5 sm:min-w-[18rem]'
							onSubmit={(e) => {
								e.preventDefault();
								const next = queryDraft.trim();
								setOffset(0);
								setQuery(next);
								setQueryDraft(next);
								if (mainView === 'alignments') {
									setMainView('profile');
									syncUrl({ view: 'profile', profile: detail?.profile.slug || selectedId });
								}
							}}>
							<input
								value={queryDraft}
								onChange={(e) => setQueryDraft(e.target.value)}
								placeholder='Search name, alias, CRD, ticker…'
								className='min-w-0 flex-1 rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-2.5 py-1.5 text-xs text-[#e8eeff] placeholder:text-[#e8eeff]/50'
								aria-label='Profile search'
							/>
							<button
								type='submit'
								className='cursor-pointer rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-2.5 py-1.5 text-xs font-semibold text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.75)]'>
								Search
							</button>
							{query || queryDraft ?
								<button
									type='button'
									aria-label='Clear search'
									onClick={() => {
										setQueryDraft('');
										setQuery('');
										setOffset(0);
									}}
									className='cursor-pointer rounded-md border border-[#3b82f6]/40 bg-transparent px-2 py-1.5 text-xs text-[#e8eeff] opacity-70 hover:opacity-100'>
									✕
								</button>
							:	null}
						</form>
						<div
							ref={countryBoxRef}
							className='relative min-w-[10rem] max-w-[14rem] shrink-0'>
							{countryCode ?
								<div className='flex items-center gap-1 rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-1.5 py-1.5 text-[#e8eeff]'>
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img
										src={`/flags/4x3/${encodeURIComponent(countryCode)}.svg`}
										alt={getFlagLabel(countryCode)}
										title={getFlagLabel(countryCode)}
										className='h-3.5 w-[18px] rounded-[2px] border border-black/15 object-cover dark:border-white/15'
									/>
									<span className='min-w-0 flex-1 truncate text-[11px]'>{countryOptions.find((o) => o.code === countryCode)?.name || getFlagLabel(countryCode)}</span>
									<button
										type='button'
										aria-label='Clear country filter'
										onClick={() => {
											setCountryCode('');
											setCountryQuery('');
											setOffset(0);
											setCountryMenuOpen(false);
										}}
										className='cursor-pointer rounded border-0 bg-transparent px-1 text-[11px] opacity-70 hover:opacity-100'>
										✕
									</button>
								</div>
							:	<input
									value={countryQuery}
									onChange={(e) => {
										setCountryQuery(e.target.value);
										setCountryMenuOpen(true);
									}}
									onFocus={() => setCountryMenuOpen(true)}
									placeholder='Flag / country…'
									aria-label='Filter by country'
									className='w-full rounded-md border border-[#3b82f6]/40 bg-[lab(5_4.06_-17.11_/0.55)] px-2.5 py-1.5 text-xs text-[#e8eeff] placeholder:text-[#e8eeff]/50'
									autoComplete='off'
								/>
							}
							{countryMenuOpen && !countryCode ?
								<ul
									className={`absolute right-0 z-30 mt-1 max-h-56 w-full min-w-[14rem] overflow-y-auto rounded-md border border-[#3b82f6]/40 py-1 shadow-lg ${CURRENT_ACTOR_PANEL_BG}`}>
									{(countryQuery.trim() ?
										countryOptions.filter((o) => {
											const q = countryQuery.trim().toLowerCase();
											return o.name.toLowerCase().includes(q) || o.code.includes(q) || getFlagLabel(o.code).toLowerCase().includes(q);
										})
									:	countryOptions
									)
										.slice(0, 40)
										.map((o) => (
											<li key={o.code}>
												<button
													type='button'
													onClick={() => {
														setCountryCode(o.code);
														setCountryQuery(o.name);
														setCountryMenuOpen(false);
														setOffset(0);
														if (mainView === 'alignments') {
															setMainView('profile');
															syncUrl({
																view: 'profile',
																profile: detail?.profile.slug || selectedId,
															});
														}
													}}
													className='flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-xs text-[#e8eeff] hover:bg-[lab(5_4.06_-17.11_/0.65)]'>
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img
														src={`/flags/4x3/${encodeURIComponent(o.code)}.svg`}
														alt=''
														className='h-3.5 w-[18px] rounded-[2px] border border-black/15 object-cover dark:border-white/15'
													/>
													<span className='min-w-0 flex-1 truncate'>{o.name}</span>
													<span className='shrink-0 text-[10px] uppercase opacity-50'>{o.code}</span>
												</button>
											</li>
										))}
									{(
										(countryQuery.trim() ?
											countryOptions.filter((o) => {
												const q = countryQuery.trim().toLowerCase();
												return o.name.toLowerCase().includes(q) || o.code.includes(q) || getFlagLabel(o.code).toLowerCase().includes(q);
											})
										:	countryOptions
										).length === 0
									) ?
										<li className='px-2.5 py-2 text-[11px] opacity-60'>No matches</li>
									:	null}
								</ul>
							:	null}
						</div>
						<ThemeToggle />
					</div>
				</header>

				{banner ?
					<div className='mb-3 flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs'>
						<span>{banner}</span>
						<button
							type='button'
							onClick={() => setBanner(null)}
							className='cursor-pointer border-0 bg-transparent text-xs font-semibold opacity-70'>
							✕
						</button>
					</div>
				:	null}

				{error ?
					<div className='mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200'>{error}</div>
				:	null}

				{/* Stats Bar / Quick Type Filters */}
				{stats ?
					<section className='mb-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-10'>
						<button
							type='button'
							onClick={() => {
								setTypeFilter('all');
								setOffset(0);
								setMainView('profile');
							}}
							className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
								typeFilter === 'all' && mainView === 'profile' ?
									'border-[#F97316] bg-[#F97316]/10'
								:	'border-[#1e3a8a]/45 bg-[lab(5_4.06_-17.11_/0.45)] hover:bg-[lab(5_4.06_-17.11_/0.65)] dark:border-[#3b82f6]/30'
							}`}>
							<div className='text-[11px] opacity-70'>All Profiles</div>
							<div className='text-base font-semibold'>{stats.totalProfiles.toLocaleString()}</div>
						</button>
						{ALL_TYPES.map((t) => {
							const isFiltered = typeFilter === t && mainView === 'profile';
							const isCurrentProfileType = typeFilter === 'all' && mainView === 'profile' && detail?.profile.profileType === t;
							return (
								<button
									key={t}
									type='button'
									onClick={() => {
										setTypeFilter(t);
										setOffset(0);
										setMainView('profile');
									}}
									className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
										isFiltered ? 'border-[#F97316] bg-[#F97316]/12 ring-1 ring-[#F97316]/40'
										: isCurrentProfileType ? 'border-[#F97316]/70 bg-[#F97316]/8'
										: 'border-[#1e3a8a]/45 bg-[lab(5_4.06_-17.11_/0.45)] hover:bg-[lab(5_4.06_-17.11_/0.65)] dark:border-[#3b82f6]/30'
									}`}>
									<div className='text-[11px] opacity-70'>{TYPE_META[t].plural}</div>
									<div className='text-base font-semibold'>{(stats.byType[t] || 0).toLocaleString()}</div>
								</button>
							);
						})}
						<button
							type='button'
							onClick={() => {
								setPendingCategorySync(false);
								setTypeFilter(HISTORY_FILTER);
								setOffset(0);
								setMainView('profile');
							}}
							title='Recently viewed profiles (stored in this browser, up to 100)'
							className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition ${
								typeFilter === HISTORY_FILTER && mainView === 'profile' ?
									'border-[#F97316] bg-[#F97316]/12 ring-1 ring-[#F97316]/40'
								:	'border-[#1e3a8a]/45 bg-[lab(5_4.06_-17.11_/0.45)] hover:bg-[lab(5_4.06_-17.11_/0.65)] dark:border-[#3b82f6]/30'
							}`}>
							<div className='text-[11px] opacity-70'>History</div>
							<div className='text-base font-semibold'>{viewHistory.length.toLocaleString()}</div>
						</button>
					</section>
				:	null}

				{/* Create Profile Drawer */}
				{showCreate ?
					<form
						onSubmit={(e) => void handleCreateProfile(e)}
						className={`mb-4 rounded-lg border border-[#1e3a8a]/50 p-3.5 dark:border-[#3b82f6]/35 ${CURRENT_ACTOR_PANEL_BG}`}>
						<div className='mb-2 flex items-center justify-between'>
							<h2 className='m-0 text-sm font-semibold'>Create Canonical Profile</h2>
							<button
								type='button'
								onClick={() => setShowCreate(false)}
								className='cursor-pointer border-0 bg-transparent text-xs opacity-70'>
								Cancel
							</button>
						</div>
						<div className='grid gap-2.5 sm:grid-cols-3'>
							<label className='flex flex-col gap-1 text-xs'>
								<span className='opacity-75'>Profile Type</span>
								<select
									value={newType}
									onChange={(e) => setNewType(e.target.value as ProfileType)}
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'>
									<optgroup label='Main Actor Profiles'>
										<option value='person'>Person</option>
										<option value='firm'>Firm / Company</option>
										<option value='education'>Education (University / School / District)</option>
										<option value='nonprofit'>Non-Profit / Foundation / Institute</option>
										<option value='medical_hospital'>Hospital / Health System</option>
										<option value='government'>Government (Domestic / Foreign / Intl)</option>
									</optgroup>
									<optgroup label='Events &amp; Timelines'>
										<option value='historic_event'>Historic Event / Topic</option>
										<option value='region'>Region (corridor / basin / tectonic zone)</option>
									</optgroup>
								</select>
							</label>
							<label className='flex flex-col gap-1 text-xs sm:col-span-2'>
								<span className='opacity-75'>Name *</span>
								<input
									required
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									placeholder='e.g. Rockefeller Foundation, University of Texas at Dallas, 2008 Financial Crisis'
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							<label className='flex flex-col gap-1 text-xs'>
								<span className='opacity-75'>Aliases (comma-separated)</span>
								<input
									value={newAliases}
									onChange={(e) => setNewAliases(e.target.value)}
									placeholder='e.g. UTD, UT Dallas'
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							<label className='flex flex-col gap-1 text-xs'>
								<span className='opacity-75'>Location (optional)</span>
								<input
									value={newLocation}
									onChange={(e) => setNewLocation(e.target.value)}
									placeholder='e.g. Dallas, TX'
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							<label className='flex flex-col gap-1 text-xs'>
								<span className='opacity-75'>
									{newType === 'person' ?
										'Birth date (optional)'
									: newType === 'firm' ||
										  newType === 'education' ||
										  newType === 'nonprofit' ||
										  newType === 'medical_hospital' ||
										  newType === 'government' ||
										  newType === 'region' ?
										'Founded / start (optional)'
									:	'Start date (optional)'}
								</span>
								<input
									value={newStartDate}
									onChange={(e) => setNewStartDate(e.target.value)}
									onBlur={() => setNewStartDate((v) => formatDateDraftOnBlur(v))}
									placeholder={DATE_INPUT_PLACEHOLDER}
									title={DATE_INPUT_TITLE}
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							<label className='flex flex-col gap-1 text-xs'>
								<span className='opacity-75'>
									{newType === 'person' ?
										'Death date (optional)'
									: newType === 'firm' ||
										  newType === 'education' ||
										  newType === 'nonprofit' ||
										  newType === 'medical_hospital' ||
										  newType === 'government' ||
										  newType === 'region' ?
										'Dissolved / end (optional)'
									:	'End date (optional)'}
								</span>
								<input
									value={newEndDate}
									onChange={(e) => setNewEndDate(e.target.value)}
									onBlur={() => setNewEndDate((v) => formatDateDraftOnBlur(v))}
									placeholder={DATE_INPUT_PLACEHOLDER}
									title={DATE_INPUT_TITLE}
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							<label className='flex flex-col gap-1 text-xs sm:col-span-3'>
								<span className='opacity-75'>Summary / Research Angle</span>
								<textarea
									rows={2}
									value={newSummary}
									onChange={(e) => setNewSummary(e.target.value)}
									placeholder='Brief description or key questions this profile tracks…'
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
								/>
							</label>
							{newType === 'person' ?
								<>
									<label className='flex flex-col gap-1 text-xs'>
										<span className='opacity-75'>Initial Employer / Organization (optional)</span>
										<input
											value={newEmployer}
											onChange={(e) => setNewEmployer(e.target.value)}
											placeholder='e.g. Rockefeller Financial LLC'
											className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
										/>
									</label>
									<label className='flex flex-col gap-1 text-xs'>
										<span className='opacity-75'>Employer Category</span>
										<select
											value={newEmployerCategory}
											onChange={(e) => setNewEmployerCategory(e.target.value as ProfileType)}
											className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'>
											{EMPLOYER_CATEGORY_TYPES.map((t) => (
												<option
													key={t}
													value={t}>
													{TYPE_META[t].label}
												</option>
											))}
										</select>
									</label>
									<label className='flex flex-col gap-1 text-xs'>
										<span className='opacity-75'>Role / Title (optional)</span>
										<input
											value={newEmployerRole}
											onChange={(e) => setNewEmployerRole(e.target.value)}
											placeholder='e.g. Managing Director, Professor'
											className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'
										/>
									</label>
								</>
							:	null}
						</div>
						<div className='mt-3 flex justify-end'>
							<button
								type='submit'
								disabled={creating}
								className='cursor-pointer rounded-md border-none bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50'>
								{creating ? 'Creating…' : 'Create Profile'}
							</button>
						</div>
					</form>
				:	null}

				{/* Main Content Area — flex-1 fills remaining viewport under the header/stats */}
				{mainView === 'alignments' ?
					<section className='min-h-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-4'>
						<div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
							<div>
								<h2 className='m-0 text-base font-semibold'>Cross-Source Alignment Leads ({globalAlignTotal})</h2>
								<p className='m-0 text-xs opacity-75'>
									Possible links, alias collisions, geo-temporal overlaps, multi-angle windows, and knowledge.sqlite / Research Drive matches. Click a source chip for merge
									insight, identifiers, and OCR when available. Confirm verified links or dismiss false positives.
								</p>
							</div>
							<div className='flex flex-wrap items-center gap-2'>
								<select
									value={alignKindFilter}
									onChange={(e) => {
										setAlignKindFilter(e.target.value);
										setAlignOffset(0);
									}}
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs'>
									{ALIGNMENT_KINDS.map((k) => (
										<option
											key={k.value || 'all'}
											value={k.value}>
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
									className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs'>
									<option value=''>All statuses</option>
									<option value='proposed'>Proposed</option>
									<option value='confirmed'>Confirmed</option>
									<option value='dismissed'>Dismissed</option>
								</select>
								<button
									type='button'
									disabled={syncing}
									onClick={() => void handleSync('align_only')}
									className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--app-surface-hover)]'>
									Re-run Alignment Pass
								</button>
							</div>
						</div>

						<div className='mb-3 flex flex-wrap items-center justify-between gap-2 text-xs'>
							<span className='opacity-80'>
								{globalAlignTotal > 0 ?
									`Showing ${Math.min(alignOffset + 1, globalAlignTotal)}–${Math.min(alignOffset + globalAlignments.length, globalAlignTotal)} of ${globalAlignTotal.toLocaleString()}${alignStatusFilter ? ` (${alignStatusFilter})` : ''}`
								:	`No rows for current filters${alignStatusFilter ? ` (${alignStatusFilter})` : ''}`}
							</span>
							<div className='flex flex-wrap items-center gap-1.5'>
								<span className='text-[10px] font-semibold uppercase opacity-60'>This page:</span>
								<button
									type='button'
									disabled={bulkAlignBusy || loadingGlobalAlign || globalAlignments.length === 0}
									onClick={() => void handleBulkAlignments('accept')}
									title='Confirm all visible rows without merging profiles'
									className='cursor-pointer rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 disabled:opacity-40 dark:text-emerald-200'>
									{bulkAlignBusy ? 'Working…' : `Accept all (${globalAlignments.filter((a) => a.status !== 'confirmed').length})`}
								</button>
								<button
									type='button'
									disabled={bulkAlignBusy || loadingGlobalAlign || globalAlignments.filter(isMergeableAlignment).length === 0}
									onClick={() => void handleBulkAlignments('merge')}
									title='Merge same-entity alias / shared-identifier pairs on this page'
									className='cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/15 px-2 py-0.5 text-[11px] font-semibold text-[#F97316] disabled:opacity-40'>
									{bulkAlignBusy ? 'Working…' : `Merge all (${globalAlignments.filter(isMergeableAlignment).length})`}
								</button>
								<button
									type='button'
									disabled={bulkAlignBusy || loadingGlobalAlign || globalAlignments.length === 0}
									onClick={() => void handleBulkAlignments('dismiss')}
									title='Dismiss all visible rows'
									className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] font-semibold opacity-80 hover:opacity-100 disabled:opacity-40'>
									{bulkAlignBusy ? 'Working…' : `Dismiss all (${globalAlignments.filter((a) => a.status !== 'dismissed').length})`}
								</button>
								<span className='mx-0.5 opacity-30'>|</span>
								<button
									type='button'
									disabled={alignOffset <= 0 || loadingGlobalAlign || bulkAlignBusy}
									onClick={() => setAlignOffset((o) => Math.max(0, o - ALIGN_PAGE_SIZE))}
									className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40'>
									Prev
								</button>
								<button
									type='button'
									disabled={alignOffset + ALIGN_PAGE_SIZE >= globalAlignTotal || loadingGlobalAlign || bulkAlignBusy || globalAlignTotal === 0}
									onClick={() => setAlignOffset((o) => o + ALIGN_PAGE_SIZE)}
									className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40'>
									Next
								</button>
							</div>
						</div>

						{loadingGlobalAlign ?
							<p className='text-xs opacity-70'>Loading alignments…</p>
						: globalAlignments.length === 0 ?
							<p className='text-xs opacity-70'>No alignment candidates match the current filters.</p>
						:	<div className='flex flex-col gap-2.5'>
								{globalAlignments.map((al) => (
									<div
										key={al.id}
										className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs'>
										<div className='flex flex-wrap items-center justify-between gap-2'>
											<div className='flex flex-wrap items-center gap-1.5'>
												<span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CAUTION_BADGE[al.cautionTier]}`}>
													{al.cautionTier.replace(/_/g, ' ')}
												</span>
												<span
													className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
														al.alignmentKind === 'possible_match_name_only' ?
															'border border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200'
														:	'bg-[var(--app-surface-hover)]'
													}`}>
													{al.alignmentKind === 'possible_match_name_only' ? 'Name-only match (NOT merged — needs validation)' : al.alignmentKind.replace(/_/g, ' ')}
												</span>
												<span className='text-[11px] opacity-70'>score {al.score.toFixed(2)}</span>
												<span
													className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
														al.status === 'confirmed' ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
														: al.status === 'dismissed' ? 'border border-rose-500/35 bg-rose-500/10 text-rose-800 dark:text-rose-200'
														: 'border border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200'
													}`}>
													{al.status === 'confirmed' ?
														'accepted'
													: al.status === 'dismissed' ?
														'dismissed'
													:	'needs review'}
												</span>
											</div>
											<div className='flex items-center gap-1.5'>
												{(al.alignmentKind === 'same_entity_alias' || al.alignmentKind === 'shared_identifier') && al.rightProfileId ?
													<button
														type='button'
														onClick={() => {
															const target = pickCanonicalMergeTarget(al);
															if (!target) return;
															void handleMergeProfiles(target.keepId, target.mergeId, target.keepLabel, target.mergeLabel);
														}}
														className='cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/15 px-2 py-0.5 text-[11px] font-semibold text-[#F97316]'>
														Merge
													</button>
												:	null}
												{al.status !== 'confirmed' ?
													<button
														type='button'
														disabled={savingAlignmentId === al.id}
														onClick={() => void handleTriageAlignment(al.id, 'confirmed')}
														className='cursor-pointer rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 disabled:opacity-50 dark:text-emerald-200'>
														{savingAlignmentId === al.id ? 'Saving…' : 'Accept'}
													</button>
												:	null}
												{al.status !== 'dismissed' ?
													<button
														type='button'
														disabled={savingAlignmentId === al.id}
														onClick={() => void handleTriageAlignment(al.id, 'dismissed')}
														className='cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-2 py-0.5 text-[11px] opacity-75 hover:opacity-100 disabled:opacity-50'>
														Dismiss
													</button>
												:	null}
											</div>
										</div>

										<div className='mt-1.5 flex flex-wrap items-center gap-1.5 font-semibold'>
											<button
												type='button'
												onClick={() => jumpToProfile(al.leftProfileId)}
												className='cursor-pointer border-0 bg-transparent p-0 text-left text-xs font-semibold text-[#F97316] underline'>
												{al.leftName || al.leftSlug}
											</button>
											{al.leftType ?
												<span className='text-[10px] opacity-60'>[{al.leftType}]</span>
											:	null}
											{al.rightProfileId ?
												<>
													<span className='opacity-50'>↔</span>
													<button
														type='button'
														onClick={() => jumpToProfile(al.rightProfileId!)}
														className='cursor-pointer border-0 bg-transparent p-0 text-left text-xs font-semibold text-[#F97316] underline'>
														{al.rightName || al.rightSlug}
													</button>
													{al.rightType ?
														<span className='text-[10px] opacity-60'>[{al.rightType}]</span>
													:	null}
												</>
											:	null}
										</div>

										<p className='my-1.5 leading-relaxed opacity-85'>{scrubEpsteinSourceLabels(al.rationale)}</p>

										{al.evidence.length > 0 ?
											<AlignmentEvidenceList
												evidence={al.evidence}
												initialLimit={6}
												compact
												alignmentKind={al.alignmentKind}
												rationale={al.rationale}
												leftProfileId={al.leftProfileId}
												rightProfileId={al.rightProfileId}
												leftName={al.leftName || al.leftSlug}
												rightName={al.rightName || al.rightSlug}
												onOpenProfile={jumpToProfile}
											/>
										:	null}
									</div>
								))}
							</div>
						}
					</section>
				:	<div className='grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[360px_1fr]'>
						{/* Left Sidebar: tracks detail column; lg:h-0 lg:min-h-full keeps list from inflating the row; scrolls inside */}
						<aside
							className={`flex min-h-0 min-w-0 flex-col self-stretch overflow-hidden rounded-lg border border-[#1e3a8a]/50 lg:h-0 lg:min-h-full dark:border-[#3b82f6]/35 ${CURRENT_ACTOR_PANEL_BG}`}>
							<div className={`flex shrink-0 items-center justify-between px-3 py-2 text-[11px] ${LEFT_PANEL_TOP_CONTROLS}`}>
								<span className='opacity-80'>
									{loadingList ?
										'Loading…'
									: query ?
										`${totalProfiles.toLocaleString()} matching “${query}”`
									:	`${totalProfiles.toLocaleString()} matching`}
								</span>
								<div className='flex gap-1.5'>
									<button
										type='button'
										disabled={offset === 0}
										onClick={() => setOffset((o) => Math.max(0, o - 60))}
										className='cursor-pointer rounded border border-[#3b82f6]/40 bg-transparent px-1.5 py-0.5 text-[10px] text-[#e8eeff] disabled:opacity-40'>
										Prev
									</button>
									<button
										type='button'
										disabled={offset + 60 >= totalProfiles}
										onClick={() => setOffset((o) => o + 60)}
										className='cursor-pointer rounded border border-[#3b82f6]/40 bg-transparent px-1.5 py-0.5 text-[10px] text-[#e8eeff] disabled:opacity-40'>
										Next
									</button>
								</div>
							</div>

							<div className='min-h-0 flex-1 divide-y divide-[#1e3a8a]/35 overflow-y-auto dark:divide-[#3b82f6]/20'>
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
									const alreadyInList = detail?.profile && profiles.some((p) => p.id === detail.profile.id);
									const pinnedDetailItem: Profile | null =
										detailMatchesFilter && !alreadyInList && detail ?
											{
												...detail.profile,
												aliasCount: detail.counts.aliases,
												linkCount: detail.counts.links,
												timelineCount: detail.counts.timelineEntries,
												alignmentCount: detail.counts.alignments,
												categoryTags: detail.categoryTags,
												corpora: Array.isArray(detail.profile.metadata?.corpora) ? (detail.profile.metadata.corpora as unknown[]).map(String) : [],
											}
										:	null;
									const visibleProfiles = pinnedDetailItem ? [pinnedDetailItem, ...profiles] : profiles;

									if (visibleProfiles.length === 0 && !loadingList) {
										return (
											<div className='p-4 text-xs opacity-70'>
												{typeFilter === HISTORY_FILTER ?
													<>No viewing history yet. Open any profile and it will show up here (kept in this browser, up to {HISTORY_LIMIT}).</>
												:	<>
														No profiles yet. Click <strong>Sync &amp; Align All Data</strong> above to populate from all local corpora.
													</>
												}
											</div>
										);
									}

									return visibleProfiles.map((p) => {
										const active = p.id === selectedId || p.slug === selectedId || (detail?.profile?.id != null && p.id === detail.profile.id);
										const tm = TYPE_META[p.profileType];
										const current = isCurrentPersonOrFirm(p);
										const rowTone =
											current ?
												active ? CURRENT_ACTOR_ROW_ACTIVE
												:	CURRENT_ACTOR_ROW
											: active ? INACTIVE_ROW_ACTIVE
											: 'bg-zinc-500/15 hover:bg-zinc-500/25 dark:bg-zinc-500/20 dark:hover:bg-zinc-500/30';
										const badgeTone =
											p.profileType === 'firm' ? firmTypeBadgeClass(p)
											: current ? CURRENT_ACTOR_BADGE
											: tm.badge;
										const typeLabel = p.profileType === 'firm' ? firmTypeBadgeLabel(p) : tm.label;
										return (
											<button
												key={p.id}
												ref={active ? selectedRowRef : undefined}
												type='button'
												onClick={() => {
													setSelectedId(p.slug || p.id);
													setLastEnrichReport(null);
													setTimelineFocusTitle(null);
												}}
												className={`w-full cursor-pointer border-0 border-b border-b-[#1e3a8a]/30 px-3 py-2.5 text-left transition last:border-b-0 dark:border-b-[#3b82f6]/15 ${rowTone}`}>
												{typeFilter === 'all' || typeFilter === 'actors' || typeFilter === HISTORY_FILTER ?
													<>
														<div className='flex items-center gap-2'>
															<span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badgeTone}`}>{typeLabel}</span>
														</div>
														<div className='mt-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold leading-snug'>
															<span>{p.name}</span>
															<CountryFlags
																codes={p.countryCodes}
																size='sm'
															/>
														</div>
													</>
												:	<div className='flex flex-wrap items-center gap-1.5 text-xs font-semibold leading-snug'>
														<span>{p.name}</span>
														<CountryFlags
															codes={p.countryCodes}
															size='sm'
														/>
													</div>
												}
												{(() => {
													const hasAlts = Boolean(p.alternateNames && p.alternateNames.length > 0);
													const hasCrd =
														(p.profileType === 'person' || p.profileType === 'firm') && Boolean(p.finraCrd);
													const loc = !hasAlts && p.primaryLocation ? p.primaryLocation : null;
													const hasEventDate =
														p.profileType === 'historic_event' && Boolean(p.startDate || p.endDate);
													const secondary = hasAlts ? p.alternateNames!.join(' · ') : loc;
													if (!hasCrd && !hasEventDate && !secondary) return null;
													const bits: Array<{ key: string; node: ReactNode }> = [];
													if (hasCrd) {
														bits.push({
															key: 'crd',
															node: (
																<span className='not-italic font-medium tabular-nums'>
																	CRD {p.finraCrd}
																</span>
															),
														});
													}
													if (hasEventDate) {
														bits.push({
															key: 'date',
															node: (
																<span className='not-italic font-medium tabular-nums'>
																	<ProfileDateSpanText startDate={p.startDate} endDate={p.endDate} isCurrent={false} />
																</span>
															),
														});
													}
													if (secondary) {
														bits.push({
															key: 'sec',
															node: hasAlts ? (
																<span className='italic'>{secondary}</span>
															) : (
																<span>{secondary}</span>
															),
														});
													}
													return (
														<div className='mt-0.5 truncate text-[10px] opacity-70'>
															{bits.map((b, i) => (
																<span key={b.key}>
																	{i > 0 ? <span className='opacity-50'> · </span> : null}
																	{b.node}
																</span>
															))}
														</div>
													);
												})()}
											</button>
										);
									});
								})()}
							</div>
						</aside>

						{/* Right Workspace: fills the flex-1 grid cell (min-h-full) so short dossiers still reach the viewport bottom */}
						<section
							className={`min-h-full min-w-0 rounded-lg border p-4 ${
								detail && isCurrentPersonOrFirm(detail.profile, detail.identifiers) ? CURRENT_ACTOR_DETAIL_OUTLINE : DETAIL_PANEL_OUTLINE
							}`}>
							{loadingDetail && !detail ?
								<p className='text-xs opacity-70'>Loading profile…</p>
							: !detail ?
								<p className='text-xs opacity-70'>Select a profile on the left to inspect its dossier, timeline gaps, and alignments.</p>
							:	<div ref={detailTopRef}>
									{/* Profile Header */}
									<div className='flex flex-wrap items-start justify-between gap-2 border-b border-[var(--app-border)] pb-3'>
										<div>
											<div className='flex flex-wrap items-center gap-1.5'>
												{(() => {
													const activeType = profileEditing ? typeDraft : detail.profile.profileType;
													const detailCurrent = isCurrentPersonOrFirm(
														{ ...detail.profile, profileType: activeType },
														detail.identifiers,
													);
													const typeBadgeClass =
														activeType === 'firm' ? firmTypeBadgeClass(detail.profile, detail.identifiers)
														: detailCurrent ? CURRENT_ACTOR_BADGE
														: TYPE_META[activeType].badge;
													return (
														<select
															aria-label='Profile category'
															title='Change profile category'
															value={activeType}
															disabled={savingCategory || savingCore}
															onChange={(e) => {
																const nextType = e.target.value as ProfileType;
																if (profileEditing) {
																	setTypeDraft(nextType);
																} else {
																	void handleQuickChangeProfileType(nextType);
																}
															}}
															className={`cursor-pointer rounded border px-2 py-0.5 text-[11px] font-semibold focus:outline-none focus:ring-1 focus:ring-[#F97316] disabled:cursor-wait disabled:opacity-60 ${typeBadgeClass}`}>
															{ALL_TYPES.map((t) => (
																<option
																	key={t}
																	value={t}
																	className='bg-[var(--app-surface)] text-[var(--app-text)]'>
																	{TYPE_META[t].label}
																</option>
															))}
														</select>
													);
												})()}
												<code className='rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px] opacity-75'>{detail.profile.slug}</code>
												{profileEditing ?
													<span className='flex flex-wrap items-center gap-1.5 text-[11px]'>
														<input
															value={lifeStartDraft}
															onChange={(e) => setLifeStartDraft(e.target.value)}
															onBlur={() => setLifeStartDraft((v) => formatDateDraftOnBlur(v))}
															placeholder={DATE_INPUT_PLACEHOLDER}
															title={DATE_INPUT_TITLE}
															className='w-[11.5rem] rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px]'
														/>
														<span className='opacity-50'>→</span>
														<input
															value={lifeEndDraft}
															onChange={(e) => setLifeEndDraft(e.target.value)}
															onBlur={() => setLifeEndDraft((v) => formatDateDraftOnBlur(v))}
															placeholder={DATE_INPUT_PLACEHOLDER}
															title={DATE_INPUT_TITLE}
															className='w-[11.5rem] rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px]'
														/>
													</span>
												:	<span className='inline-flex flex-wrap items-center gap-1.5 text-[11px] opacity-70'>
														{detail.profile.startDate || detail.profile.endDate ?
															<span className='inline-flex flex-wrap items-center gap-1'>
																{detail.profile.startDate ? <ProfileDate iso={detail.profile.startDate} /> : '—'}
																{detail.profile.endDate ?
																	<>
																		<span aria-hidden>→</span>
																		<ProfileDate iso={detail.profile.endDate} />
																	</>
																: detail.profile.profileType === 'person' ?
																	''
																:	''}
															</span>
														: detail.profile.profileType === 'firm' ?
															<span
																className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-100 ${firmTypeBadgeClass(detail.profile, detail.identifiers)}`}
																title={
																	isCurrentPersonOrFirm(detail.profile, detail.identifiers) ?
																		firmHasActiveFinraScope(detail.profile) ?
																			'Active firm — FINRA BrokerCheck / SEC IA ACTIVE (visualizer API); no start/end dates set'
																		:	'Active firm — listed on a live external source with no start/end dates set'
																	:	'Inactive / ended firm — no start/end dates set'
																}>
																Firm
															</span>
														:	<span className='italic opacity-60'>{detail.profile.profileType === 'person' ? 'No birth/death dates' : 'No start/end dates'}</span>}
													</span>
												}
											</div>
											{(() => {
												const isPerson = detail.profile.profileType === 'person';
												const meta = detail.profile.metadata || {};

												// Current employment / active organization affiliation(s) to display right of person's name
												const isFaculty = (r?: string | null) => /\b(?:professor|faculty|dean|chancellor|lecturer|instructor|researcher|provost|teacher)\b/i.test(r || '');
												const nonAlumniWork = isPerson ? detail.employmentHistory.filter((e) => !(e.orgCategory === 'education' && !isFaculty(e.role))) : [];
												const explicitCurrent = nonAlumniWork.filter((e) => e.isCurrent === true);
												const activeOrgs = explicitCurrent.length > 0 ? explicitCurrent.slice(0, 2) : nonAlumniWork.filter((e) => e.isCurrent !== false && !e.endDate).slice(0, 2);

												const fallbackTitle =
													isPerson && activeOrgs.length === 0 ?
														typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim()
														: Array.isArray(meta.officesHeld) && meta.officesHeld[0] ? String(meta.officesHeld[0]).trim()
														: null
													:	null;

												// Alternate names under the title — prefer explicit other_name
												// (editable); fall back to former/name for display only.
												const canonicalLow = detail.profile.name.trim().toLowerCase().replace(/\s+/g, ' ');
												const seenAlt = new Set<string>([canonicalLow]);
												const pushUnique = (raw: string, into: string[]) => {
													const cleaned = raw
														.replace(/[\[\]]+/g, '')
														.replace(/\s+/g, ' ')
														.trim();
													const low = cleaned.toLowerCase();
													if (!low || seenAlt.has(low)) return;
													seenAlt.add(low);
													into.push(cleaned);
												};
												const altNames: string[] = [];
												for (const a of detail.aliases) {
													if (a.aliasKind === 'other_name') pushUnique(a.alias, altNames);
												}
												if (altNames.length === 0) {
													for (const a of detail.aliases) {
														if (a.aliasKind !== 'former_name' && a.aliasKind !== 'name') {
															continue;
														}
														pushUnique(a.alias, altNames);
														if (altNames.length >= 4) break;
													}
												}

												const headerCrd = resolveProfileFinraCrd(detail.profile.profileType, meta, detail.identifiers);
												const crdHeaderTags =
													headerCrd && (detail.profile.profileType === 'person' || detail.profile.profileType === 'firm') ?
														buildFinraCrdHeaderTags({
															profileType: detail.profile.profileType,
															crd: headerCrd,
															metadata: meta,
														})
													:	[];
												const historicSourceTags =
													detail.profile.profileType === 'historic_event' ?
														collectHistoricEventSourceTags({
															metadata: meta,
															identifiers: detail.identifiers,
															sourceCorpus: typeof meta.sourceCorpus === 'string' ? meta.sourceCorpus : null,
														})
													:	[];

												return (
													<>
														{crdHeaderTags.length > 0 ?
															<div className='mb-1.5 mt-1 flex flex-wrap items-center gap-1.5'>
																{crdHeaderTags.map((tag, idx) =>
																	tag.kind === 'fact' ?
																		<span
																			key={`${tag.label}-${idx}`}
																			className={tag.className}>
																			<span className='font-semibold uppercase tracking-wide opacity-65'>{tag.label}</span>
																			<span className='font-semibold'>{tag.value}</span>
																		</span>
																	:	<span
																			key={`${tag.kind}-${tag.label}-${idx}`}
																			className={tag.className}
																			title={'title' in tag ? tag.title : undefined}>
																			{tag.label}
																		</span>,
																)}
															</div>
														:	null}
														<h2 className='mt-0.5 mb-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg font-semibold'>
															{profileEditing ?
																<span className='inline-flex flex-wrap items-center gap-1.5'>
																	<input
																		value={nameDraft}
																		onChange={(e) => setNameDraft(e.target.value)}
																		className='min-w-[14rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-base font-semibold'
																		autoFocus
																	/>
																	<CountryFlags
																		codes={detail.profile.countryCodes}
																		size='md'
																	/>
																</span>
															:	<span className='inline-flex flex-wrap items-center gap-2'>
																	<span className='inline-flex items-center gap-2'>
																		<span>{detail.profile.name}</span>
																		<CountryFlags
																			codes={detail.profile.countryCodes}
																			size='md'
																		/>
																	</span>
																	{activeOrgs.length > 0 ?
																		<span className='text-xs font-normal opacity-80'>
																			—{' '}
																			{activeOrgs.map((org, idx) => (
																				<span key={org.id}>
																					{idx > 0 ? ' · ' : ''}
																					{org.role ?
																						<span>{org.role}, </span>
																					:	null}
																					{org.orgProfileId ?
																						<button
																							type='button'
																							onClick={() => jumpToProfile(org.orgProfileId!)}
																							className='cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline'>
																							{org.orgName}
																						</button>
																					:	<span className='font-semibold'>{org.orgName}</span>}
																				</span>
																			))}
																		</span>
																	: fallbackTitle ?
																		<span className='text-xs font-normal opacity-80'>— {fallbackTitle}</span>
																	:	null}
																</span>
															}
														</h2>
														{historicSourceTags.length > 0 ?
															<div
																className='mb-1.5 flex flex-wrap items-center gap-1.5'
																aria-label='Content sources'>
																{historicSourceTags.map((tag) => (
																	<span
																		key={tag.label}
																		className={
																			tag.origin === 'external' ? HISTORIC_SOURCE_TAG_EXTERNAL : HISTORIC_SOURCE_TAG_LOCAL
																		}
																		title={
																			tag.origin === 'external' ?
																				`External source: ${tag.label}`
																			:	`Local source: ${tag.label}`
																		}>
																		{tag.label}
																	</span>
																))}
															</div>
														:	null}
														{profileEditing ?
															<div className='mb-1.5 flex flex-wrap items-center gap-1.5'>
																<input
																	value={altNamesDraft}
																	onChange={(e) => setAltNamesDraft(e.target.value)}
																	placeholder='Other names · separated by · or comma'
																	className='min-w-[16rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs italic'
																/>
															</div>
														:	<div className='mb-1.5 flex flex-wrap items-center gap-1.5 text-xs'>
																{altNames.length > 0 ?
																	<span className='italic opacity-75'>{altNames.join(' · ')}</span>
																:	<span className='italic opacity-50'>No other names</span>}
															</div>
														}
													</>
												);
											})()}
											{profileEditing ?
												(() => {
													const activeRows = locationRowsDraft.filter((r) => !r.deleted);
													const primaryText = detail.profile.primaryLocation || '';
													const origPrimaryLoc =
														primaryText ?
															detail.locations.find((l) => l.raw === primaryText) ||
															detail.locations.find((l) => primaryText.includes(l.raw) || l.raw.includes(primaryText))
														:	null;
													const primaryRow =
														(origPrimaryLoc ? activeRows.find((r) => r.id === origPrimaryLoc.id) : null) ||
														activeRows.find((r) => r.role === 'hq' || r.role === 'residence') ||
														activeRows[0] ||
														null;
													const defaultRole: LocationRole =
														typeDraft === 'person' ? 'residence'
														: typeDraft === 'historic_event' ? 'event_site'
														: 'hq';
													const ensureOrUpdatePrimary = (patch: Partial<{ raw: string; role: LocationRole; confirmed: boolean }>) => {
														if (primaryRow) {
															setLocationRowsDraft((rows) =>
																rows.map((r) => (r.key === primaryRow.key ? { ...r, ...patch } : r)),
															);
														} else {
															setLocationRowsDraft((rows) => [
																{
																	key: `new-${crypto.randomUUID()}`,
																	id: null,
																	raw: patch.raw ?? '',
																	role: patch.role ?? defaultRole,
																	confirmed: patch.confirmed ?? true,
																	deleted: false,
																},
																...rows,
															]);
														}
													};
													return (
														<div className='mb-1.5 flex flex-wrap items-center gap-1.5 text-xs'>
															<span
																aria-hidden
																className='opacity-75'>
																📍
															</span>
															<input
																aria-label='Primary location'
																value={primaryRow ? primaryRow.raw : ''}
																onChange={(e) => ensureOrUpdatePrimary({ raw: e.target.value })}
																placeholder='Location (e.g. City, ST or street address)…'
																className='min-w-[15rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs'
															/>
															<select
																aria-label='Location role'
																value={primaryRow ? primaryRow.role : defaultRole}
																onChange={(e) => ensureOrUpdatePrimary({ role: e.target.value as LocationRole })}
																className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px]'>
																{LOCATION_ROLES.map((r) => (
																	<option
																		key={r}
																		value={r}>
																		{r.replace(/_/g, ' ')}
																	</option>
																))}
															</select>
															<label className='flex items-center gap-1 text-[11px] opacity-85'>
																<input
																	type='checkbox'
																	checked={primaryRow ? primaryRow.confirmed : true}
																	onChange={(e) => ensureOrUpdatePrimary({ confirmed: e.target.checked })}
																/>
																Confirmed
															</label>
															{primaryRow ?
																<button
																	type='button'
																	title='Remove this location'
																	onClick={() =>
																		setLocationRowsDraft((rows) =>
																			rows.map((r) => (r.key === primaryRow.key ? { ...r, deleted: true } : r)),
																		)
																	}
																	className='cursor-pointer rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800 dark:text-rose-200'>
																	Remove
																</button>
															:	null}
															{activeRows.length > 1 ?
																<span className='text-[11px] opacity-65'>
																	(+{activeRows.length - 1} more below)
																</span>
															:	null}
														</div>
													);
												})()
											: detail.profile.primaryLocation ?
												(() => {
													const primary = detail.profile.primaryLocation;
													const match = detail.locations.find((l) => l.raw === primary) || detail.locations.find((l) => primary.includes(l.raw) || l.raw.includes(primary));
													const isConfirmedResidence = match?.role === 'residence' && Boolean(match.confirmed);
													const isConfirmedHq = match?.role === 'hq' && Boolean(match.confirmed);
													return (
														<div className='mb-1.5 flex flex-wrap items-center gap-1.5 text-xs opacity-80'>
															<span>
																📍 <strong>{primary}</strong>
																{detail.locations.length > 1 ? ` (+${detail.locations.length - 1} more location${detail.locations.length === 2 ? '' : 's'})` : ''}
															</span>
															{isConfirmedResidence ?
																<span
																	className='rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200'
																	title='Residence confirmed from strong evidence'>
																	Residence · confirmed
																</span>
															: isConfirmedHq ?
																<span className='rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200'>
																	HQ · confirmed
																</span>
															: match?.role && match.role !== 'associated' ?
																<span className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] uppercase opacity-70'>
																	{match.role.replace(/_/g, ' ')}
																</span>
															:	null}
														</div>
													);
												})()
											:	null}
											{(() => {
												const ar = (
													detail.profile.metadata as {
														autoResearch?: {
															status?: string;
															model?: string | null;
															stages?: {
																localValidation?: { rssEventsLinked?: number; duplicateAlignments?: number };
																internetCrawl?: { urlsCrawled?: number; pdfsExtracted?: number; dataLayersFound?: number; milestonesAdded?: number };
																entitiesDiscovered?: { matchedUpdated?: number; created?: number };
															};
															error?: string | null;
														};
													} | undefined
												)?.autoResearch;
												if (!ar?.status) return null;
												if (ar.status === 'running') {
													return (
														<div className='mt-1.5 flex items-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200'>
															<span className='inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400' />
															<span>
																Auto-research running{ar.model ? ` (${ar.model})` : ' (auto)'} — local validation · APIs/RSS · web/PDF/data-layer crawl · entity discovery…
															</span>
														</div>
													);
												}
												if (ar.status === 'completed' && ar.stages) {
													const ic = ar.stages.internetCrawl;
													const ed = ar.stages.entitiesDiscovered;
													const lv = ar.stages.localValidation;
													return (
														<div className='mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-200/90'>
															<span className='font-semibold'>Auto-research{ar.model ? ` (${ar.model})` : ''}:</span>
															<span>{ic?.urlsCrawled ?? 0} web/data crawled</span>
															{(ic?.pdfsExtracted ?? 0) > 0 ? <span>· {ic?.pdfsExtracted} PDFs</span> : null}
															{(ic?.dataLayersFound ?? 0) > 0 ? <span>· {ic?.dataLayersFound} data layers</span> : null}
															<span>· +{ic?.milestonesAdded ?? 0} milestones</span>
															<span>· {ed?.created ?? 0} new / {ed?.matchedUpdated ?? 0} updated entities</span>
															{(lv?.rssEventsLinked ?? 0) > 0 ? <span>· {lv?.rssEventsLinked} RSS events linked</span> : null}
														</div>
													);
												}
												return null;
											})()}
											{profileEditing ?
												<div className='mt-2'>
													<textarea
														value={summaryDraft}
														onChange={(e) => setSummaryDraft(e.target.value)}
														rows={10}
														placeholder='Profile summary / research notes…'
														className='w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs leading-relaxed'
													/>
												</div>
											:	<div className='mt-1'>
													{detail.profile.summary ?
														<ProfileSummaryText
															text={detail.profile.summary}
															sourceDate={detail.profile.startDate}
															eventTitle={detail.profile.name}
															ensureEventTimeline={detail.profile.profileType === 'historic_event'}
															eventLinks={
																detail.profile.profileType === 'historic_event' ? overviewEventLinks : null
															}
															relatedProfileLinks={overviewRelatedProfileLinks}
															onOpenProfile={jumpToProfile}
														/>
													:	<p className='m-0 text-xs italic opacity-60'>No summary yet.</p>}
												</div>
											}
										</div>
										<div className='flex flex-wrap items-center gap-2'>
											{profileEditing ?
												<>
													<button
														type='button'
														disabled={savingCore || deletingProfile || !nameDraft.trim()}
														onClick={() => void handleApplyProfileEdit()}
														className='cursor-pointer rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-200'>
														{savingCore ? 'Applying…' : 'Apply'}
													</button>
													<button
														type='button'
														disabled={savingCore || deletingProfile}
														onClick={cancelProfileEdit}
														className='cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50'>
														Cancel
													</button>
													<button
														type='button'
														disabled={savingCore || deletingProfile}
														onClick={() => {
															setDeleteConfirmOpen((open) => !open);
															setDeleteConfirmName('');
															setError(null);
														}}
														className='cursor-pointer rounded-md border border-rose-500/50 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-300'
														title='Permanently delete this profile and its linked rows'>
														Delete…
													</button>
												</>
											:	<button
													type='button'
													onClick={beginProfileEdit}
													className='cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--app-surface-hover)]'
													title='Edit name, other names, summary, dates, aliases, identifiers, locations, and connected profiles'>
													Edit
												</button>
											}
											<button
												type='button'
												disabled={enriching || profileEditing}
												onClick={() => void handleEnrichProfile()}
												title='Search local offline Wikipedia, BrokerCheck (if CRD), county deeds, and UCC filings. Only merges validated matches (identifier or name/initials + address, firm, military base, or institution); name-only matches are held as review notes.'
												className='cursor-pointer rounded-md border border-[#F97316]/50 bg-[#F97316]/15 px-2.5 py-1.5 text-xs font-semibold text-[#F97316] hover:bg-[#F97316]/25 disabled:opacity-50'>
												{enriching ? 'Researching…' : 'Research & Fill Details'}
											</button>
										</div>
										{profileEditing && deleteConfirmOpen ?
											<div className='mt-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs'>
												<p className='m-0 mb-1.5 font-semibold text-rose-800 dark:text-rose-200'>
													Delete “{detail.profile.name}”? This cannot be undone.
												</p>
												<p className='m-0 mb-2 opacity-80'>
													Removes the card and cascaded aliases, identifiers, locations, links, timeline rows, and
													alignments. Type the full name to confirm.
												</p>
												<div className='flex flex-wrap items-center gap-2'>
													<input
														value={deleteConfirmName}
														onChange={(e) => setDeleteConfirmName(e.target.value)}
														placeholder={detail.profile.name}
														autoComplete='off'
														disabled={deletingProfile}
														className='min-w-[14rem] flex-1 rounded border border-rose-500/40 bg-[var(--app-bg)] px-2 py-1.5 text-xs'
													/>
													<button
														type='button'
														disabled={
															deletingProfile ||
															deleteConfirmName.trim().toLowerCase() !== detail.profile.name.trim().toLowerCase()
														}
														onClick={() => void handleDeleteProfile()}
														className='cursor-pointer rounded-md border-none bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50'>
														{deletingProfile ? 'Deleting…' : 'Delete permanently'}
													</button>
													<button
														type='button'
														disabled={deletingProfile}
														onClick={() => {
															setDeleteConfirmOpen(false);
															setDeleteConfirmName('');
														}}
														className='cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50'>
														Keep
													</button>
												</div>
											</div>
										:	null}
									</div>
									{(detail.profile.profileType === 'person' || detail.profile.profileType === 'firm') &&
									resolveProfileFinraCrd(detail.profile.profileType, detail.profile.metadata, detail.identifiers) ?
										<FinraDisclosuresPanel
											data={finraDisclosures}
											loading={loadingFinraDisclosures}
											error={finraDisclosuresError}
										/>
									:	null}
									{lastEnrichReport && lastEnrichReport.profileId === detail.profile.id ?
										<div className='mt-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 text-xs'>
											<div className='flex flex-wrap items-center justify-between gap-2 font-semibold'>
												<span>
													Enrichment results ({lastEnrichReport.durationMs}ms): {lastEnrichReport.validatedSources} validated · {lastEnrichReport.heldNameOnlyNotes} name-only
													note(s) held back
												</span>
												<button
													type='button'
													onClick={() => setLastEnrichReport(null)}
													className='cursor-pointer border-0 bg-transparent text-[11px] opacity-65 hover:opacity-100'>
													Dismiss
												</button>
											</div>
											<div className='mt-1.5 space-y-1'>
												{lastEnrichReport.outcomes.map((o, idx) => (
													<div
														key={idx}
														className='flex flex-wrap items-center gap-1.5 text-[11px]'>
														<span className='rounded bg-[var(--app-surface)] px-1.5 py-0.5 font-mono text-[10px]'>{o.source}</span>
														<span
															className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
																o.status === 'merged' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
																: o.status === 'name_only_note' ? 'bg-amber-500/15 text-amber-900 dark:text-amber-200'
																: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300'
															}`}>
															{o.status === 'name_only_note' ? 'held: name-only note' : o.status}
														</span>
														{o.candidateTitle ?
															<span className='font-medium'>{o.candidateTitle}</span>
														:	null}
														{o.note ?
															<span className='opacity-75'>— {o.note}</span>
														:	null}
													</div>
												))}
											</div>
										</div>
									:	null}

									{/* Tabs — omit zero-count Timeline / Alignments */}
									<div className='mt-3 mb-4 flex flex-wrap gap-2 border-b border-[var(--app-border)] pb-2'>
										{(
											[
												{
													id: 'overview' as const,
													label: `Overview & Links (${detail.counts.links})`,
													show: true,
												},
												{
													id: 'timeline' as const,
													label: `Timeline (${detail.counts.timelineEntries})`,
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
													type='button'
													onClick={() => setProfileTab(t.id)}
													className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs font-semibold ${
														profileTab === t.id ? 'border-[#F97316] bg-[#F97316] text-white' : 'border-[var(--app-border)] bg-[var(--app-bg)] hover:bg-[var(--app-surface-hover)]'
													}`}>
													{t.label}
												</button>
											))}
									</div>

									{/* TAB 1: Overview & Links */}
									{profileTab === 'overview' ?
										<div className='space-y-4'>
											{(() => {
												const meta = detail.profile.metadata || {};
												const detailRows = ENRICHED_DETAIL_FIELDS.map(({ key, label }) => {
													// Net worth / unstructured family / political party hidden from UI.
													if (key === 'netWorth' || key === 'familyAndRelatives' || key === 'politicalParty') return null;
													const raw = meta[key];
													if (raw == null || raw === '') return null;
													const text = Array.isArray(raw) ? raw.map(String).filter(Boolean).join(' · ') : String(raw).trim();
													if (!text) return null;
													return { key, label, text };
												}).filter((x): x is { key: string; label: string; text: string } => x !== null);
												const militaryRows = detailRows.filter((r) => MILITARY_DETAIL_KEYS.has(r.key));
												const knownForRow = detailRows.find((r) => r.key === 'knownFor') || null;
												const notableWorksRow = detailRows.find((r) => r.key === 'notableWorks') || null;
												const titleRow = detailRows.find((r) => r.key === 'title') || null;
												const occupationRow = detailRows.find((r) => r.key === 'occupation') || null;
												const titleOccupationRow =
													titleRow || occupationRow ?
														{
															key: 'titleOccupation',
															title: titleRow?.text || null,
															occupation: occupationRow?.text || null,
														}
													:	null;
												const highlightParts = [knownForRow?.text, notableWorksRow?.text].filter(Boolean) as string[];
												const highlightRow =
													highlightParts.length > 0 ?
														{
															key: 'knownForNotableWorks',
															label:
																knownForRow && notableWorksRow ? 'Known For / Notable Works'
																: knownForRow ? 'Known For'
																: 'Notable Works',
															text: highlightParts.join(' · '),
														}
													:	null;
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
														const peerGender: PersonGender | null =
															l.peerGender === 'female' || l.peerGender === 'male' ? l.peerGender : null;
														const rawRole = l.roleLabel || null;
														// Outbound links name the subject's kinship to the peer ("father of …");
														// invert so the peer is labeled from the open profile's point of view.
														const role =
															outbound && rawRole ?
																invertFamilyRoleForOutbound(rawRole, peerGender) || rawRole
															:	rawRole;
														const peer: FamilyRelativePeer = {
															id: peerId,
															name: peerName,
															role,
															startDate: l.peerStartDate ?? null,
															endDate: l.peerEndDate ?? null,
															gender: peerGender,
														};
														return peer;
													})
													.filter((x): x is FamilyRelativePeer => x !== null)
													.filter((peer, i, arr) => arr.findIndex((p) => p.id === peer.id) === i);
												// Firm ownership ASCII: expanded group (parent root + all subsidiaries).
												const ownershipGroup =
													detail.profile.profileType === 'firm' ? detail.ownershipGroup : null;
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
													.filter((peer, i, arr) => arr.findIndex((p) => p.id === peer.id) === i);
												const generalRows = detailRows.filter(
													(r) => !MILITARY_DETAIL_KEYS.has(r.key) && r.key !== 'knownFor' && r.key !== 'notableWorks' && r.key !== 'title' && r.key !== 'occupation',
												);
												// identifyingKeywords / citizenship / netWorth / familyAndRelatives stay in metadata
												// FINRA/SEC/Wikipedia deep links live in the Sources & Identifiers card below.
												if (
													!generalRows.length &&
													!militaryRows.length &&
													!highlightRow &&
													!titleOccupationRow &&
													!familyPeers.length &&
													!ownershipGroup
												) {
													return null;
												}
												return (
													<div className='space-y-3'>
														{generalRows.length > 0 ||
														highlightRow ||
														titleOccupationRow ||
														familyPeers.length > 0 ||
														ownershipGroup ?
															(() => {
																const compactRows = generalRows.filter((r) => !isFullWidthDetailCard(r.key, r.text));
																const wideRows = generalRows.filter((r) => isFullWidthDetailCard(r.key, r.text));
																return (
																	<div className='grid min-w-0 gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-3'>
																		{titleOccupationRow ?
																			<div className={`col-span-full min-w-0 rounded border px-2.5 py-2 ${enrichedDetailCardClass('title')}`}>
																				{titleOccupationRow.title ?
																					<div>
																						<div className='text-[10px] font-semibold uppercase opacity-65'>Title</div>
																						<div className='mt-0.5 break-words leading-snug'>{titleOccupationRow.title}</div>
																					</div>
																				:	null}
																				{titleOccupationRow.occupation ?
																					<div className={titleOccupationRow.title ? 'mt-2' : undefined}>
																						<div className='text-[10px] font-semibold uppercase opacity-65'>Occupation</div>
																						<div className='mt-0.5 break-words leading-snug'>
																							{renderClickableOccupation(titleOccupationRow.occupation, occupationOrgPeers, jumpToProfile)}
																						</div>
																					</div>
																				:	null}
																			</div>
																		:	null}
																		{compactRows.map((row) => (
																			<div
																				key={row.key}
																				className={`min-w-0 overflow-hidden rounded border px-2.5 py-1.5 ${enrichedDetailCardClass(row.key)}`}>
																				<div className='text-[10px] font-semibold uppercase opacity-65'>{row.label}</div>
																				<div className='mt-0.5 break-words [overflow-wrap:anywhere] leading-snug'>{row.text}</div>
																			</div>
																		))}
																		{wideRows.map((row) => (
																			<div
																				key={row.key}
																				className={`col-span-full min-w-0 overflow-hidden rounded border px-2.5 py-2 ${enrichedDetailCardClass(row.key)}`}>
																				<div className='text-[10px] font-semibold uppercase opacity-65'>{row.label}</div>
																				<div className='mt-0.5 break-words [overflow-wrap:anywhere] leading-snug'>{row.text}</div>
																			</div>
																		))}
																		{familyPeers.length > 0 ?
																			<div className={`col-span-full min-w-0 overflow-hidden rounded border px-2.5 py-2 ${enrichedDetailCardClass('familyAndRelatives')}`}>
																				<div className='text-[10px] font-semibold uppercase opacity-65'>Family / Relatives</div>
																				<FamilyRelativesTree
																					peers={familyPeers}
																					onJump={jumpToProfile}
																					subject={{
																						id: detail.profile.id,
																						name: detail.profile.name,
																						startDate: detail.profile.startDate,
																						endDate: detail.profile.endDate,
																					}}
																				/>
																			</div>
																		:	null}
																		{ownershipGroup ?
																			<div className={`col-span-full min-w-0 overflow-hidden rounded border px-2.5 py-2 ${enrichedDetailCardClass('ownershipHierarchy')}`}>
																				<div className='text-[10px] font-semibold uppercase opacity-65'>Ownership / Group</div>
																				<FirmOwnershipTree
																					group={ownershipGroup}
																					onJump={jumpToProfile}
																				/>
																			</div>
																		:	null}
																		{highlightRow ?
																			<div
																				key={highlightRow.key}
																				className={`col-span-full rounded border px-2.5 py-2 ${enrichedDetailCardClass('knownFor')}`}>
																				<div className='text-[10px] font-semibold uppercase opacity-65'>{highlightRow.label}</div>
																				<div className='mt-0.5 break-words leading-snug'>{highlightRow.text}</div>
																			</div>
																		:	null}
																	</div>
																);
															})()
														:	null}

														{militaryRows.length > 0 ?
															<div className='rounded-lg border border-emerald-700/45 bg-gradient-to-br from-emerald-950/50 via-slate-900/40 to-emerald-900/30 p-4 shadow-sm'>
																<div className='mb-2.5 flex flex-wrap items-center gap-2'>
																	<span className='rounded bg-emerald-600/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-200'>Military Service</span>
																	<span className='text-[10px] opacity-60'>
																		{militaryRows.length} field{militaryRows.length === 1 ? '' : 's'}
																	</span>
																</div>
																<div className='grid gap-2.5 text-[12px] sm:grid-cols-2 lg:grid-cols-3'>
																	{militaryRows.map((row) => (
																		<div
																			key={row.key}
																			className={`rounded-md border px-3 py-2.5 ${
																				row.key === 'battlesWars' || row.key === 'militaryCommands' ? 'sm:col-span-2 lg:col-span-3' : ''
																			} border-emerald-600/35 bg-emerald-950/40`}>
																			<div className='text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80'>{row.label}</div>
																			<div className='mt-1 break-words leading-snug text-emerald-50'>{row.text}</div>
																		</div>
																	))}
																</div>
															</div>
														:	null}
													</div>
												);
											})()}
											{(() => {
												const meta = detail.profile.metadata || {};
												const finraCrd = resolveProfileFinraCrd(detail.profile.profileType, meta, detail.identifiers);
												const finraLinks =
													finraCrd && (detail.profile.profileType === 'person' || detail.profile.profileType === 'firm') ?
														finraSecSourceLinks({
															profileType: detail.profile.profileType,
															crd: finraCrd,
															iaScope: meta.finraIaScope,
														})
													:	[];
												const wikiUrl = typeof meta.wikipediaUrl === 'string' ? meta.wikipediaUrl.trim().toLowerCase() : '';
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
												const isNewsRssHistoric =
													detail.profile.profileType === 'historic_event' && isNewsRssHistoricMetadata(meta);
												const sourceLabels = collectProfileSourceLabels(detail.identifiers);
												// Drop URL chips already covered by the Wikipedia meta link.
												// News RSS article URLs stay as plain domain Sources text (not Website ↗ / bbc ↗).
												const urlIds = detail.identifiers.filter((idItem) => {
													if (String(idItem.scheme || '').toLowerCase() !== 'url') return false;
													if (isHiddenEpsteinSourceIdentifier(idItem.scheme, idItem.value)) {
														return false;
													}
													const href = String(idItem.value || '').trim();
													if (!href) return false;
													if (wikiNorm && normalizeHref(href) === wikiNorm) return false;
													if (isNewsRssHistoric) return false;
													return true;
												});
												const newsDomainLabels: string[] = [];
												if (isNewsRssHistoric) {
													const seenDomains = new Set<string>();
													const pushDomain = (raw: string | null | undefined) => {
														const host = hostnameFromUrl(String(raw || ''));
														if (!host || seenDomains.has(host)) return;
														seenDomains.add(host);
														newsDomainLabels.push(host);
													};
													if (typeof meta.sourceUrl === 'string') pushDomain(meta.sourceUrl);
													if (typeof meta.website === 'string') pushDomain(meta.website);
													if (typeof meta.companyUrl === 'string') pushDomain(meta.companyUrl);
													for (const idItem of detail.identifiers) {
														if (String(idItem.scheme || '').toLowerCase() !== 'url') continue;
														if (isHiddenEpsteinSourceIdentifier(idItem.scheme, idItem.value)) continue;
														pushDomain(idItem.value);
													}
												}
												const preferredWebsiteRaw =
													(typeof meta.website === 'string' && /^https?:\/\//i.test(meta.website) ? meta.website : null) ||
													(typeof meta.companyUrl === 'string' && /^https?:\/\//i.test(meta.companyUrl) ? meta.companyUrl : null);
												// News RSS citations are not org "Website ↗" links.
												const preferredWebsite = isNewsRssHistoric ? null : preferredWebsiteRaw;
												const hasRegistryLinks =
													finraLinks.length > 0 || typeof meta.finraVisualizerUrl === 'string' || typeof meta.wikipediaUrl === 'string' || Boolean(preferredWebsite);
												const showAliases = true;
												const hasSicMeta = (meta.sic != null && String(meta.sic).trim() !== '') || (typeof meta.sicDescription === 'string' && meta.sicDescription.trim() !== '');
												const showCombinedSources = true;
												const showLocations = true;
												const cardCount = 3;
												const gridCols = 'md:grid-cols-3';
												const editableIdentSchemes = [
													'ticker',
													'finra_crd',
													'sec_cik',
													'parent_sec_cik',
													'irs_ein',
													'cusip',
													'url',
													'orcid',
													'ror',
													'wikidata',
													'us_passport',
													'driver_license',
												] as const;
												return (
													<div className={`grid gap-3 ${gridCols}`}>
														{showAliases ?
															<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>
																	Aliases / other names (
																	{profileEditing ? aliasRowsDraft.filter((r) => !r.deleted).length : detail.aliases.filter((a) => a.aliasKind !== 'slug').length})
																</h3>
																<ul className='m-0 mb-2 list-none space-y-1.5 p-0'>
																	{profileEditing ?
																		aliasRowsDraft.filter((r) => !r.deleted).length === 0 ?
																			<li className='text-[11px] italic opacity-60'>No other names yet.</li>
																		:	aliasRowsDraft
																				.filter((r) => !r.deleted)
																				.slice(0, 32)
																				.map((row) => (
																					<li
																						key={row.key}
																						className='rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1.5 text-[11px]'>
																						<div className='flex flex-wrap items-center gap-1.5'>
																							<input
																								value={row.alias}
																								onChange={(e) => setAliasRowsDraft((rows) => rows.map((r) => (r.key === row.key ? { ...r, alias: e.target.value } : r)))}
																								className='min-w-[8rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px]'
																							/>
																							<select
																								value={row.aliasKind}
																								onChange={(e) =>
																									setAliasRowsDraft((rows) =>
																										rows.map((r) =>
																											r.key === row.key ?
																												{
																													...r,
																													aliasKind: e.target.value as AliasKind,
																												}
																											:	r,
																										),
																									)
																								}
																								className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px]'>
																								<option value='other_name'>Other name</option>
																								<option value='name'>Alias</option>
																								<option value='former_name'>Former name</option>
																								<option value='acronym'>Acronym</option>
																							</select>
																							<button
																								type='button'
																								onClick={() => setAliasRowsDraft((rows) => rows.map((r) => (r.key === row.key ? { ...r, deleted: true } : r)))}
																								className='cursor-pointer rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px]'
																								title={`Remove ${row.alias}`}>
																								×
																							</button>
																						</div>
																					</li>
																				))

																	: detail.aliases.filter((a) => a.aliasKind !== 'slug').length === 0 ?
																		<li className='text-[11px] italic opacity-60'>No other names yet.</li>
																	:	detail.aliases
																			.filter((a) => a.aliasKind !== 'slug')
																			.slice(0, 32)
																			.map((a) => {
																				const kindLabel =
																					a.aliasKind === 'other_name' ? 'other'
																					: a.aliasKind === 'former_name' ? 'former'
																					: a.aliasKind === 'acronym' ? 'acronym'
																					: 'alias';
																				return (
																					<li
																						key={a.id}
																						className='rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1.5 text-[11px]'>
																						<span>
																							{a.alias} <span className='text-[10px] opacity-55'>· {kindLabel}</span>
																						</span>
																					</li>
																				);
																			})
																	}
																</ul>
																{profileEditing ?
																	<div className='flex flex-wrap gap-1'>
																		<input
																			value={aliasDraft}
																			onChange={(e) => setAliasDraft(e.target.value)}
																			placeholder='Append other name…'
																			className='min-w-[8rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-[11px]'
																			onKeyDown={(e) => {
																				if (e.key === 'Enter') {
																					e.preventDefault();
																					if (!aliasDraft.trim()) return;
																					const next = aliasDraft.trim();
																					if (aliasKindDraft === 'other_name') {
																						setAltNamesDraft((cur) => (cur.trim() ? `${cur.trim()} · ${next}` : next));
																					} else {
																						const key = `new-${crypto.randomUUID()}`;
																						setAliasRowsDraft((rows) => [
																							...rows,
																							{
																								key,
																								id: null,
																								alias: next,
																								aliasKind: aliasKindDraft,
																								deleted: false,
																							},
																						]);
																					}
																					setAliasDraft('');
																				}
																			}}
																		/>
																		<select
																			value={aliasKindDraft}
																			onChange={(e) => setAliasKindDraft(e.target.value as AliasKind)}
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-[11px]'
																			title='Name type'>
																			<option value='other_name'>Other name</option>
																			<option value='name'>Alias</option>
																			<option value='former_name'>Former name</option>
																			<option value='acronym'>Acronym</option>
																		</select>
																		<button
																			type='button'
																			disabled={!aliasDraft.trim()}
																			onClick={() => {
																				if (!aliasDraft.trim()) return;
																				const next = aliasDraft.trim();
																				if (aliasKindDraft === 'other_name') {
																					setAltNamesDraft((cur) => (cur.trim() ? `${cur.trim()} · ${next}` : next));
																				} else {
																					const key = `new-${crypto.randomUUID()}`;
																					setAliasRowsDraft((rows) => [
																						...rows,
																						{
																							key,
																							id: null,
																							alias: next,
																							aliasKind: aliasKindDraft,
																							deleted: false,
																						},
																					]);
																				}
																				setAliasDraft('');
																			}}
																			className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold disabled:opacity-50'>
																			Add
																		</button>
																	</div>
																:	null}
															</div>
														:	null}

														{showCombinedSources ?
															<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>
																	Sources &amp; Identifiers
																	{publicIds.length > 0 ? ` (${publicIds.length})` : ''}
																</h3>
																{hasRegistryLinks || finraCrd ?
																	<div className='mb-2 flex flex-wrap items-center gap-2.5'>
																		{/* CRD + FINRA:/SEC: scope chips (and firm B·IA / District·Type·State·Size) live in the header above the name */}
																		{finraLinks.map((link) => (
																			<a
																				key={link.href}
																				href={link.href}
																				target='_blank'
																				rel='noreferrer'
																				className={link.className}>
																				{link.label}
																			</a>
																		))}
																		{typeof meta.finraVisualizerUrl === 'string' ?
																			<a
																				href={meta.finraVisualizerUrl}
																				target='_blank'
																				rel='noreferrer'
																				className='text-[11px] font-semibold text-[#F97316] underline'>
																				FINRA Visualizer ↗
																			</a>
																		:	null}
																		{typeof meta.wikipediaUrl === 'string' ?
																			<a
																				href={meta.wikipediaUrl}
																				target='_blank'
																				rel='noreferrer'
																				className='text-[11px] font-semibold text-[#F97316] underline'>
																				Wikipedia ↗
																			</a>
																		:	null}
																		{preferredWebsite ?
																			<a
																				href={preferredWebsite}
																				target='_blank'
																				rel='noreferrer'
																				className='text-[11px] font-semibold text-[#F97316] underline'
																				title={preferredWebsite}>
																				Website ↗
																			</a>
																		:	null}
																	</div>
																:	null}
																{(
																	publicIds.filter((idItem) => !pendingDeleteIdentIds.includes(idItem.id)).length > 0 ||
																	pendingNewIdents.length > 0 ||
																	meta.sic != null ||
																	meta.sicDescription != null
																) ?
																	<ul className='m-0 list-none space-y-1 p-0 text-[11px]'>
																		{publicIds
																			.filter((idItem) => !pendingDeleteIdentIds.includes(idItem.id))
																			.map((idItem) => {
																				const scheme = String(idItem.scheme || '').toLowerCase();
																				const label = IDENTIFIER_SCHEME_LABELS[scheme] || scheme.replace(/_/g, ' ');
																				let display = scrubEpsteinSourceLabels(idItem.value);
																				if (scheme === 'ticker') {
																					display = formatTickerListing(
																						display,
																						typeof meta.exchange === 'string' ? meta.exchange : null,
																					);
																				}
																				return (
																					<li
																						key={idItem.id}
																						className='flex flex-wrap items-center gap-1.5'>
																						<span>
																							<span className='opacity-70'>{label}:</span> <strong>{display}</strong>
																						</span>
																						{profileEditing ?
																							<button
																								type='button'
																								onClick={() => setPendingDeleteIdentIds((ids) => (ids.includes(idItem.id) ? ids : [...ids, idItem.id]))}
																								className='cursor-pointer rounded border border-[var(--app-border)] px-1 py-0 text-[10px] opacity-70 hover:opacity-100'
																								title={`Remove ${label}`}>
																								Remove
																							</button>
																						:	null}
																					</li>
																				);
																			})}
																		{pendingNewIdents.map((ident) => (
																			<li
																				key={ident.key}
																				className='flex flex-wrap items-center gap-1.5 opacity-80'>
																				<span>
																					<span className='opacity-70'>{IDENTIFIER_SCHEME_LABELS[ident.scheme] || ident.scheme}:</span> <strong>{ident.value}</strong>{' '}
																					<span className='text-[10px] italic opacity-60'>(pending)</span>
																				</span>
																				<button
																					type='button'
																					onClick={() => setPendingNewIdents((rows) => rows.filter((r) => r.key !== ident.key))}
																					className='cursor-pointer rounded border border-[var(--app-border)] px-1 py-0 text-[10px]'>
																					Remove
																				</button>
																			</li>
																		))}
																		{meta.sic != null && String(meta.sic).trim() ?
																			<li key='meta-sic'>
																				<span className='opacity-70'>SIC:</span>{' '}
																				<strong>
																					{String(meta.sic).trim()}
																					{typeof meta.sicDescription === 'string' && meta.sicDescription.trim() ? ` (${meta.sicDescription.trim()})` : ''}
																				</strong>
																			</li>
																		:	null}
																	</ul>
																:	<p className='m-0 mb-2 text-[11px] italic opacity-60'>No public identifiers yet.</p>}
																{profileEditing ?
																	<div className='mt-2 flex flex-wrap gap-1 border-t border-[var(--app-border)] pt-2'>
																		<select
																			value={identSchemeDraft}
																			onChange={(e) => setIdentSchemeDraft(e.target.value)}
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-[11px]'>
																			{editableIdentSchemes.map((s) => (
																				<option
																					key={s}
																					value={s}>
																					{IDENTIFIER_SCHEME_LABELS[s] || s}
																				</option>
																			))}
																		</select>
																		<input
																			value={identValueDraft}
																			onChange={(e) => setIdentValueDraft(e.target.value)}
																			placeholder='Value…'
																			className='min-w-[8rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-[11px]'
																		/>
																		<button
																			type='button'
																			disabled={!identValueDraft.trim()}
																			onClick={() => {
																				if (!identValueDraft.trim()) return;
																				setPendingNewIdents((rows) => [
																					...rows,
																					{
																						key: `new-${crypto.randomUUID()}`,
																						scheme: identSchemeDraft,
																						value: identValueDraft.trim(),
																					},
																				]);
																				setIdentValueDraft('');
																			}}
																			className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold disabled:opacity-50'>
																			Add
																		</button>
																	</div>
																:	null}
																{sourceLabels.length > 0 || urlIds.length > 0 || newsDomainLabels.length > 0 ?
																	(() => {
																		const coveredLabels = new Set<string>(urlIds.map((idItem) => sourceLabelFromUrl(String(idItem.value || ''))).filter(Boolean) as string[]);
																		// Meta Wikipedia / FINRA chips already cover these labels.
																		if (wikiNorm) coveredLabels.add('wikipedia');
																		if (typeof meta.finraVisualizerUrl === 'string') {
																			coveredLabels.add('finra');
																		}
																		if (finraLinks.length > 0) {
																			coveredLabels.add('finra');
																			coveredLabels.add('sec');
																		}
																		// Full domains already listed for news RSS (bbc.co.uk) cover short labels (bbc).
																		for (const domain of newsDomainLabels) {
																			coveredLabels.add(domain);
																			const short = sourceLabelFromUrl(`https://${domain}`);
																			if (short) coveredLabels.add(short);
																		}
																		const extraLabels = [
																			...newsDomainLabels,
																			...sourceLabels.filter((label) => !coveredLabels.has(label) && !newsDomainLabels.includes(label)),
																		];
																		return (
																			<div
																				className={`text-[11px] leading-relaxed ${
																					publicIds.length > 0 || hasRegistryLinks || finraCrd ? 'mt-2 border-t border-[var(--app-border)] pt-2' : ''
																				}`}>
																				{extraLabels.length > 0 ?
																					<p className='m-0'>
																						<span className='opacity-70'>Sources:</span> {extraLabels.join(', ')}
																					</p>
																				:	null}
																				{urlIds.length > 0 ?
																					<ul className={`m-0 list-none space-y-1 p-0 ${extraLabels.length > 0 ? 'mt-1.5' : ''}`}>
																						{urlIds
																							.filter((idItem) => !pendingDeleteIdentIds.includes(idItem.id))
																							.slice(0, 8)
																							.map((idItem, urlIdx) => {
																								const href = String(idItem.value || '').trim();
																								const preferredNorm = preferredWebsite ? normalizeHref(preferredWebsite) : '';
																								const isPrimary = (preferredNorm && normalizeHref(href) === preferredNorm) || (!preferredNorm && urlIdx === 0);
																								const label = isPrimary ? 'website' : sourceLabelFromUrl(href) || href.slice(0, 48);
																								const withProto = /^https?:\/\//i.test(href) ? href : `https://${href}`;
																								return (
																									<li
																										key={idItem.id}
																										className='flex flex-wrap items-center gap-1.5'>
																										<a
																											href={withProto}
																											target='_blank'
																											rel='noreferrer'
																											className='font-semibold text-[#F97316] underline'>
																											{label} ↗
																										</a>
																										{profileEditing ?
																											<button
																												type='button'
																												onClick={() => setPendingDeleteIdentIds((ids) => (ids.includes(idItem.id) ? ids : [...ids, idItem.id]))}
																												className='cursor-pointer rounded border border-[var(--app-border)] px-1 py-0 text-[10px] opacity-70 hover:opacity-100'>
																												Remove
																											</button>
																										:	null}
																									</li>
																								);
																							})}
																					</ul>
																				:	null}
																			</div>
																		);
																	})()
																:	null}
															</div>
														:	null}

														{showLocations ?
															<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>
																	Locations ({profileEditing ? locationRowsDraft.filter((r) => !r.deleted).length : detail.locations.length})
																</h3>
																{profileEditing ?
																	locationRowsDraft.filter((r) => !r.deleted).length === 0 ?
																		<p className='m-0 mb-2 text-[11px] italic opacity-60'>No locations yet.</p>
																	:	null
																: detail.locations.length === 0 ?
																	<p className='m-0 mb-2 text-[11px] italic opacity-60'>No locations yet.</p>
																:	null}
																<ul className='m-0 mb-2 list-none space-y-2 p-0 text-[11px]'>
																	{profileEditing ?
																		locationRowsDraft
																			.filter((r) => !r.deleted)
																			.slice(0, 20)
																			.map((row) => (
																				<li
																					key={row.key}
																					className='rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1.5'>
																					<div className='space-y-1.5'>
																						<input
																							value={row.raw}
																							onChange={(e) => setLocationRowsDraft((rows) => rows.map((r) => (r.key === row.key ? { ...r, raw: e.target.value } : r)))}
																							className='w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px]'
																							placeholder='Address…'
																						/>
																						<div className='flex flex-wrap items-center gap-1.5'>
																							<select
																								value={row.role}
																								onChange={(e) =>
																									setLocationRowsDraft((rows) =>
																										rows.map((r) =>
																											r.key === row.key ?
																												{
																													...r,
																													role: e.target.value as LocationRole,
																												}
																											:	r,
																										),
																									)
																								}
																								className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px]'>
																								{LOCATION_ROLES.map((r) => (
																									<option
																										key={r}
																										value={r}>
																										{r.replace(/_/g, ' ')}
																									</option>
																								))}
																							</select>
																							<label className='flex items-center gap-1 text-[10px]'>
																								<input
																									type='checkbox'
																									checked={row.confirmed}
																									onChange={(e) =>
																										setLocationRowsDraft((rows) =>
																											rows.map((r) =>
																												r.key === row.key ?
																													{
																														...r,
																														confirmed: e.target.checked,
																													}
																												:	r,
																											),
																										)
																									}
																								/>
																								Confirmed
																							</label>
																							<button
																								type='button'
																								onClick={() => setLocationRowsDraft((rows) => rows.map((r) => (r.key === row.key ? { ...r, deleted: true } : r)))}
																								className='cursor-pointer rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800 dark:text-rose-200'>
																								Delete
																							</button>
																						</div>
																					</div>
																				</li>
																			))
																	:	detail.locations.slice(0, 20).map((loc) => (
																			<li
																				key={loc.id}
																				className='rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1.5'>
																				<div>
																					📍 {loc.raw} <span className='text-[10px] opacity-60'>({loc.role.replace(/_/g, ' ')})</span>
																					{loc.confirmed ?
																						<span className='ml-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-800 dark:text-emerald-200'>
																							confirmed
																						</span>
																					: loc.role === 'residence' ?
																						<span
																							className='ml-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800 dark:text-amber-200'
																							title='Residence is not shown as primary until confirmed'>
																							unconfirmed
																						</span>
																					:	null}
																				</div>
																			</li>
																		))
																	}
																</ul>
																{profileEditing ?
																	<div className='flex flex-wrap gap-1'>
																		<input
																			value={locationDraft}
																			onChange={(e) => setLocationDraft(e.target.value)}
																			placeholder='Add location (e.g. 123 Main St, Dallas, TX)…'
																			className='min-w-[12rem] flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-[11px]'
																		/>
																		<select
																			value={locationRoleDraft}
																			onChange={(e) => setLocationRoleDraft(e.target.value as LocationRole)}
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-[11px]'>
																			{LOCATION_ROLES.map((r) => (
																				<option
																					key={r}
																					value={r}>
																					{r.replace(/_/g, ' ')}
																				</option>
																			))}
																		</select>
																		<label className='flex items-center gap-1 px-1 text-[10px]'>
																			<input
																				type='checkbox'
																				checked={locationConfirmDraft}
																				onChange={(e) => setLocationConfirmDraft(e.target.checked)}
																			/>
																			Confirmed
																		</label>
																		<button
																			type='button'
																			disabled={!locationDraft.trim()}
																			onClick={() => {
																				if (!locationDraft.trim()) return;
																				setLocationRowsDraft((rows) => [
																					...rows,
																					{
																						key: `new-${crypto.randomUUID()}`,
																						id: null,
																						raw: locationDraft.trim(),
																						role: locationRoleDraft,
																						confirmed: locationConfirmDraft,
																						deleted: false,
																					},
																				]);
																				setLocationDraft('');
																				setLocationConfirmDraft(false);
																			}}
																			className='cursor-pointer rounded border border-[var(--app-border)] bg-[var(--app-surface-hover)] px-2 py-1 text-[11px] font-semibold disabled:opacity-50'>
																			Add
																		</button>
																	</div>
																:	null}
															</div>
														:	null}
													</div>
												);
											})()}

											{/* Employment History & Education (Person profiles) */}
											{detail.profile.profileType === 'person' ?
												(() => {
													const isFacultyRole = (role?: string | null) =>
														/\b(?:professor|faculty|dean|chancellor|lecturer|instructor|researcher|provost|teacher)\b/i.test(role || '');
													const educationEntries = detail.employmentHistory.filter((e) => e.orgCategory === 'education' && !isFacultyRole(e.role));
													const workEntries = detail.employmentHistory.filter((e) => !(e.orgCategory === 'education' && !isFacultyRole(e.role)));

													const currentWork = workEntries.filter((e) => e.isCurrent === true);
													const previousWork = workEntries.filter((e) => e.isCurrent !== true);

													const renderWorkRow = (emp: (typeof workEntries)[number]) => {
														const hasSpan = Boolean(
															formatEmploymentDateSpan(emp.startDate, emp.endDate, emp.isCurrent),
														);
														const cleanRole = emp.role && !/^(?:current|previous)\s+registration$/i.test(emp.role.trim()) ? emp.role.trim() : null;
														const showFinraScope =
															emp.firmFinraScope && !/^active$/i.test(emp.firmFinraScope.trim()) ?
																emp.firmFinraScope.charAt(0).toUpperCase() + emp.firmFinraScope.slice(1).toLowerCase()
															:	null;
														const isCurrentEmp = emp.isCurrent === true;
														return (
															<div
																key={emp.id}
																className={isCurrentEmp ? EMP_CARD_CURRENT : EMP_CARD_PREVIOUS}>
																<div className='flex flex-wrap items-center justify-between gap-2'>
																	<div className='flex flex-wrap items-center gap-1.5'>
																		{hasSpan ?
																			<span className={isCurrentEmp ? EMP_CHIP_CURRENT : EMP_CHIP_PREVIOUS}>
																				<ProfileDateSpanText
																					startDate={emp.startDate}
																					endDate={emp.endDate}
																					isCurrent={emp.isCurrent}
																					employedSince
																				/>
																			</span>
																		:	null}
																		{emp.orgProfileId ?
																			<button
																				type='button'
																				onClick={() => jumpToProfile(emp.orgProfileId!)}
																				className='cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline'>
																				{emp.orgName}
																			</button>
																		:	<span className='font-semibold'>{emp.orgName}</span>}
																		<CountryFlags
																			codes={emp.orgCountryCodes}
																			size='sm'
																		/>
																		{emp.firmCrd ?
																			<span
																				className={
																					isCurrentEmp ?
																						'rounded border border-[rgb(18_161_158_/0.35)] bg-[lab(17_-16.7_1.95)] px-1.5 py-0.5 font-mono text-[10px] text-emerald-50 opacity-90'
																					:	'rounded bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[10px] opacity-85'
																				}>
																				CRD# <strong>{emp.firmCrd}</strong>
																			</span>
																		:	null}
																		{emp.secNumber ?
																			<span
																				className={
																					isCurrentEmp ?
																						'rounded border border-[rgb(18_161_158_/0.35)] bg-[lab(17_-16.7_1.95)] px-1.5 py-0.5 font-mono text-[10px] text-emerald-50 opacity-90'
																					:	'rounded bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[10px] opacity-85'
																				}>
																				SEC# <strong>{emp.secNumber}</strong>
																			</span>
																		:	null}
																		{!emp.firmCrd ?
																			<span className={`rounded border px-1.5 py-0.2 text-[10px] font-semibold ${TYPE_META[emp.orgCategory].badge}`}>
																				{TYPE_META[emp.orgCategory].label}
																			</span>
																		:	null}
																		{cleanRole ?
																			<span className='text-[11px] opacity-85'>— {cleanRole}</span>
																		:	null}
																	</div>
																	{emp.isCurrent === false ?
																		<div className='flex flex-wrap items-center gap-1.5 text-[10px]'>
																			<span className='rounded bg-zinc-500/20 px-1.5 py-0.5 font-semibold opacity-80'>Old</span>
																		</div>
																	:	null}
																</div>
																{emp.location || emp.iaOnly || showFinraScope ?
																	<div className='mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] opacity-75'>
																		{emp.location ?
																			<span>📍 {emp.location}</span>
																		:	null}
																		{emp.iaOnly ?
																			<span className='rounded bg-emerald-500/12 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300'>IA only</span>
																		:	null}
																		{showFinraScope ?
																			<span className='text-[10px] opacity-85'>Firm FINRA: {showFinraScope}</span>
																		:	null}
																	</div>
																:	null}
															</div>
														);
													};

													return (
														<>
															{/* Employment History — hidden when empty */}
															{workEntries.length > 0 ?
																<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																	<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>Employment History ({workEntries.length})</h3>
																	<div className='mb-3 space-y-3'>
																		{currentWork.length > 0 ?
																			<div>
																				<div className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300'>
																					Current Employment ({currentWork.length})
																				</div>
																				<div className='space-y-1.5'>{currentWork.map(renderWorkRow)}</div>
																			</div>
																		:	null}
																		{previousWork.length > 0 ?
																			<div>
																				<div className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-70'>Previous Employment ({previousWork.length})</div>
																				<div className='space-y-1.5'>{previousWork.map(renderWorkRow)}</div>
																			</div>
																		:	null}
																	</div>

																	<form
																		onSubmit={(e) => void handleAddEmployment(e)}
																		className='grid gap-2 border-t border-[var(--app-border)] pt-2.5 sm:grid-cols-6'>
																		<input
																			required
																			value={empOrgName}
																			onChange={(e) => setEmpOrgName(e.target.value)}
																			placeholder='Employer / School *'
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-2'
																		/>
																		<select
																			value={empOrgCategory}
																			onChange={(e) => setEmpOrgCategory(e.target.value as ProfileType)}
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'>
																			{EMPLOYER_CATEGORY_TYPES.map((t) => (
																				<option
																					key={t}
																					value={t}>
																					{TYPE_META[t].label}
																				</option>
																			))}
																		</select>
																		<input
																			value={empRole}
																			onChange={(e) => setEmpRole(e.target.value)}
																			placeholder='Role / Degree'
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
																		/>
																		<input
																			value={empLocation}
																			onChange={(e) => setEmpLocation(e.target.value)}
																			placeholder='Location'
																			className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
																		/>
																		<div className='flex gap-1'>
																			<input
																				value={empStart}
																				onChange={(e) => setEmpStart(e.target.value)}
																				onBlur={() => setEmpStart((v) => formatDateDraftOnBlur(v))}
																				placeholder={DATE_INPUT_PLACEHOLDER}
																				title={DATE_INPUT_TITLE}
																				className='w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs'
																			/>
																			<input
																				value={empEnd}
																				onChange={(e) => setEmpEnd(e.target.value)}
																				onBlur={() => setEmpEnd((v) => formatDateDraftOnBlur(v))}
																				placeholder={DATE_INPUT_PLACEHOLDER}
																				title={DATE_INPUT_TITLE}
																				className='w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs'
																			/>
																		</div>
																		<div className='flex justify-end sm:col-span-6'>
																			<button
																				type='submit'
																				disabled={savingEmp}
																				className='cursor-pointer rounded border-none bg-[#F97316] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50'>
																				{savingEmp ? 'Adding…' : '+ Add Entry'}
																			</button>
																		</div>
																	</form>
																</div>
															:	null}

															{/* Education — hidden when empty */}
															{educationEntries.length > 0 ?
																<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																	<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>Education ({educationEntries.length})</h3>
																	<div className='space-y-1.5'>
																		{educationEntries.map((edu) => {
																			const hasEduSpan = Boolean(
																				formatDateSpan(edu.startDate, edu.endDate, edu.isCurrent, true),
																			);
																			return (
																				<div
																					key={edu.id}
																					className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-xs'>
																					<div className='flex flex-wrap items-center gap-1.5'>
																						{hasEduSpan ?
																							<span className='shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold'>
																								<ProfileDateSpanText
																									startDate={edu.startDate}
																									endDate={edu.endDate}
																									isCurrent={edu.isCurrent}
																									isEducation
																								/>
																							</span>
																						:	null}
																						{edu.orgProfileId ?
																							<button
																								type='button'
																								onClick={() => jumpToProfile(edu.orgProfileId!)}
																								className='cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline'>
																								{edu.orgName}
																							</button>
																						:	<span className='font-semibold'>{edu.orgName}</span>}
																						<CountryFlags
																							codes={edu.orgCountryCodes}
																							size='sm'
																						/>
																						{edu.role ?
																							<span className='text-[11px] opacity-85'>— {edu.role}</span>
																						:	null}
																					</div>
																					<div className='flex flex-wrap items-center gap-2 text-[11px] opacity-75'>
																						{edu.location ?
																							<span>📍 {edu.location}</span>
																						:	null}
																					</div>
																				</div>
																			);
																		})}
																	</div>
																</div>
															:	null}
														</>
													);
												})()
											:	null}

											{/* Connected Historic Events (chronological cards) & Connected Profiles */}
											{(() => {
												const empPeerIds = new Set(
													detail.profile.profileType === 'person' ? detail.employmentHistory.map((e) => e.orgProfileId).filter((x): x is string => Boolean(x)) : [],
												);
												const getConnStatus = (l: ProfileDetail['links'][number]): 'current' | 'old' | null => {
													const role = (l.roleLabel || '').toLowerCase();
													const note = (l.evidenceNote || '').toLowerCase();
													if (/\bcurrent\b/.test(role) || note.includes('status=current')) return 'current';
													if (/\b(?:previous|former|past|old)\b/.test(role) || note.includes('status=previous') || Boolean(l.endDate)) {
														return 'old';
													}
													if ((l.relationType === 'employed_by' || l.relationType === 'registered_at') && l.startDate && !l.endDate) {
														return 'current';
													}
													return null;
												};
												const nonEmpLinks = detail.links.filter((l) => {
													const peerId = l.fromProfileId === detail.profile.id ? l.toProfileId : l.fromProfileId;
													return !empPeerIds.has(peerId);
												});

												const historicEventLinks = nonEmpLinks
													.filter((l) => {
														const peerType = (l.fromProfileId === detail.profile.id ? l.toType : l.fromType) || 'firm';
														return peerType === 'historic_event';
													})
													.sort((a, b) => {
														const da = a.startDate || a.peerStartDate || a.endDate || a.peerEndDate || '';
														const dbDate = b.startDate || b.peerStartDate || b.endDate || b.peerEndDate || '';
														if (da && !dbDate) return -1;
														if (!da && dbDate) return 1;
														// Newest historic events first on overview.
														if (da !== dbDate) return dbDate.localeCompare(da);
														const na = (a.fromProfileId === detail.profile.id ? a.toName : a.fromName) || '';
														const nb = (b.fromProfileId === detail.profile.id ? b.toName : b.fromName) || '';
														return na.localeCompare(nb);
													});

												const connectedLinks = nonEmpLinks
													.filter((l) => {
														if (l.relationType === 'family_or_associate') return false;
														const peerType = (l.fromProfileId === detail.profile.id ? l.toType : l.fromType) || 'firm';
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
															s === 'current' ? 0
															: s === 'old' ? 2
															: 1;
														const ra = rank(a.connStatus);
														const rb = rank(b.connStatus);
														if (ra !== rb) return ra - rb;
														const na = (a.link.fromProfileId === detail.profile.id ? a.link.toName : a.link.fromName) || '';
														const nb = (b.link.fromProfileId === detail.profile.id ? b.link.toName : b.link.fromName) || '';
														return na.localeCompare(nb);
													});

												const draftById = new Map(connLinkDrafts.map((d) => [d.id, d]));
												const pendingLinkDelete = new Set(connLinkDrafts.filter((d) => d.deleted).map((d) => d.id));
												const activeConnectedCount = connectedLinks.filter((x) => !pendingLinkDelete.has(x.link.id)).length;
												const currentCount = connectedLinks.filter(
													(x) => x.connStatus === 'current' && !pendingLinkDelete.has(x.link.id),
												).length;
												const oldCount = connectedLinks.filter(
													(x) => x.connStatus === 'old' && !pendingLinkDelete.has(x.link.id),
												).length;
												const undatedFinraCount =
													detail.profile.profileType === 'firm'
														? connectedLinks.filter(
																(x) =>
																	x.link.relationType === 'registered_at' &&
																	!x.link.startDate &&
																	!pendingLinkDelete.has(x.link.id),
															).length
														: 0;
												const filteredLinks =
													connStatusFilter === 'all' ? connectedLinks : connectedLinks.filter((x) => x.connStatus === connStatusFilter);

												return (
													<div className='space-y-4'>
														{historicEventLinks.length > 0 ?
															<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
																<h3 className='m-0 mb-2 text-xs font-semibold uppercase opacity-75'>Historic Events ({historicEventLinks.length})</h3>
																<div className='space-y-2'>
																	{historicEventLinks.map((l) => {
																		const isOut = l.fromProfileId === detail.profile.id;
																		const peerId = isOut ? l.toProfileId : l.fromProfileId;
																		const peerName = isOut ? l.toName : l.fromName;
																		const evStart = l.startDate || l.peerStartDate || null;
																		const evEnd = l.endDate || l.peerEndDate || null;
																		const hasDateSpan = Boolean(formatDateSpan(evStart, evEnd, false, false));
																		return (
																			<button
																				key={l.id}
																				type='button'
																				onClick={() => jumpToProfile(peerId)}
																				className='block w-full cursor-pointer rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2.5 text-left transition hover:border-[#F97316]/60 hover:bg-[var(--app-surface-hover)]'>
																				<div className='flex flex-wrap items-center gap-2'>
																					{hasDateSpan ?
																						<span className='shrink-0 rounded border border-amber-500/35 bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-200'>
																							<ProfileDateSpanText startDate={evStart} endDate={evEnd} isCurrent={false} />
																						</span>
																					:	null}
																					<span className='text-xs font-semibold text-[#F97316] underline'>{peerName}</span>
																					<CountryFlags
																						codes={l.peerCountryCodes}
																						size='sm'
																					/>
																					{l.peerPrimaryLocation ?
																						<span className='text-[11px] opacity-70'>📍 {l.peerPrimaryLocation}</span>
																					:	null}
																				</div>
																				{l.peerSummary ?
																					<p className='mt-1 mb-0 line-clamp-2 text-[11px] leading-relaxed opacity-80'>{l.peerSummary}</p>
																				:	null}
																			</button>
																		);
																	})}
																</div>
															</div>
														:	null}

														<div className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
															<div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
																<h3 className='m-0 text-xs font-semibold uppercase opacity-75'>
																	Connected Profiles (
																	{detail.counts.links > detail.links.length ?
																		`showing ${activeConnectedCount.toLocaleString()} of ${detail.counts.links.toLocaleString()}`
																	:	activeConnectedCount.toLocaleString()}
																	{profileEditing && pendingLinkDelete.size > 0 ?
																		` · ${pendingLinkDelete.size} pending remove`
																	:	''}
																	)
																</h3>
																<div className='flex flex-wrap items-center gap-1.5'>
																	{currentCount > 0 || oldCount > 0 ?
																		<div className='flex items-center gap-1'>
																			{(
																				[
																					{
																						id: 'all' as const,
																						label: `All (${activeConnectedCount.toLocaleString()})`,
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
																						type='button'
																						onClick={() => setConnStatusFilter(tab.id)}
																						className={`cursor-pointer rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
																							connStatusFilter === tab.id ?
																								'border-[#F97316] bg-[#F97316] text-white'
																							:	'border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-surface-hover)]'
																						}`}>
																						{tab.label}
																					</button>
																				))}
																		</div>
																	:	null}
																	{undatedFinraCount > 0 ?
																		<button
																			type='button'
																			disabled={hydratingDates}
																			onClick={() => void handleHydrateFirmDates()}
																			className='cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/12 px-2 py-0.5 text-[10px] font-semibold text-[#F97316] hover:bg-[#F97316]/20 disabled:opacity-50'
																			title='Fetch FINRA BrokerCheck & SEC IAPD employment start/end dates for connected people'>
																			{hydratingDates ? 'Fetching Hire Dates…' : `Fetch Hire Dates (${undatedFinraCount.toLocaleString()})`}
																		</button>
																	:	null}
																</div>
															</div>
															<p className='m-0 mb-2 text-[10px] leading-snug opacity-65'>
																Family members stay under Family / Relatives above. Link people, firms, schools, and events here with a typed
																relationship.
																{profileEditing ?
																	' Edit relation, role, dates, and note on each row — or Remove — then Apply.'
																:	''}
															</p>
															{filteredLinks.length === 0 ?
																<p className='text-xs opacity-70'>
																	{activeConnectedCount > 0 ?
																		`No ${connStatusFilter} connections recorded.`
																	: detail.profile.profileType === 'person' && detail.employmentHistory.length > 0 ?
																		'No extra connections yet — employment and schools are listed above. Add other links below.'
																	:	'No connected profiles yet. Search an existing profile below to link it.'}
																</p>
															:	<div className='mb-3 space-y-1.5'>
																	{filteredLinks.map(({ link: l, connStatus }) => {
																		const isOut = l.fromProfileId === detail.profile.id;
																		const peerId = isOut ? l.toProfileId : l.fromProfileId;
																		const peerName = isOut ? l.toName : l.fromName;
																		const peerType = (isOut ? l.toType : l.fromType) || 'firm';
																		const draft = draftById.get(l.id);
																		const markedRemove = Boolean(draft?.deleted);
																		const showRow = profileEditing || !markedRemove;
																		if (!showRow) return null;
																		const displayRelation = draft?.relationType || l.relationType;
																		const displayRole = draft ? draft.roleLabel : l.roleLabel || '';
																		const displayStart = draft ? draft.startDate : l.startDate || '';
																		const displayEnd = draft ? draft.endDate : l.endDate || '';
																		const displayNote = draft ? draft.evidenceNote : scrubEvidenceNoteSourceTags(l.evidenceNote);
																		const connIsCurrent =
																			connStatus === 'current' ? true
																			: connStatus === 'old' ? false
																			: null;
																		const spanStart =
																			draft ?
																				normalizeIsoDate(displayStart.trim()).date || displayStart.trim() || null
																			:	l.startDate;
																		const spanEnd =
																			draft ?
																				normalizeIsoDate(displayEnd.trim()).date || displayEnd.trim() || null
																			:	l.endDate;
																		const hasConnDateSpan = Boolean(
																			formatDateSpan(
																				spanStart,
																				spanEnd,
																				connIsCurrent,
																				peerType === 'education',
																			),
																		);
																		const roleClean =
																			displayRole && !/^(?:current|previous)\s+registration$/i.test(displayRole.trim()) ?
																				displayRole.trim()
																			:	null;
																		const showRelNote =
																			!profileEditing &&
																			Boolean(displayNote) &&
																			(!roleClean || displayNote.toLowerCase() !== roleClean.toLowerCase()) &&
																			!/^seed relatedslugs$/i.test(displayNote) &&
																			!/^role:/i.test(displayNote) &&
																			!isRedundantConnectedEvidenceNote(displayNote, roleClean);
																		const patchDraft = (
																			patch: Partial<{
																				relationType: ProfileRelationType;
																				roleLabel: string;
																				startDate: string;
																				endDate: string;
																				evidenceNote: string;
																				deleted: boolean;
																			}>,
																		) => {
																			setConnLinkDrafts((rows) =>
																				rows.map((r) => (r.id === l.id ? { ...r, ...patch } : r)),
																			);
																		};
																		return (
																			<div
																				key={l.id}
																				className={
																					`${
																						markedRemove ? 'opacity-50 '
																						: ''
																					}${
																						connStatus === 'current' ? EMP_CARD_CURRENT
																						: connStatus === 'old' ?
																							EMP_CARD_PREVIOUS
																						:	'rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-xs'
																					}`
																				}>
																				<div className='flex flex-wrap items-center justify-between gap-2'>
																					<div className={`flex min-w-0 flex-wrap items-center gap-1.5 ${markedRemove ? 'line-through' : ''}`}>
																						{!profileEditing && hasConnDateSpan ?
																							<span
																								className={
																									connStatus === 'current' ? EMP_CHIP_CURRENT
																									: connStatus === 'old' ?
																										EMP_CHIP_PREVIOUS
																									:	'shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold'
																								}>
																								<ProfileDateSpanText
																									startDate={spanStart}
																									endDate={spanEnd}
																									isCurrent={connIsCurrent}
																									isEducation={peerType === 'education'}
																								/>
																							</span>
																						:	null}
																						{!profileEditing && connStatus === 'old' ?
																							<span className='shrink-0 rounded bg-zinc-500/20 px-1.5 py-0.5 text-[10px] font-semibold opacity-80'>Old</span>
																						:	null}
																						{!profileEditing ?
																							<span className='text-[10px] opacity-60'>
																								{isOut ? '→' : '←'} {displayRelation.replace(/_/g, ' ')}
																							</span>
																						:	null}
																						<button
																							type='button'
																							onClick={() => jumpToProfile(peerId)}
																							className='cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline'>
																							{peerName}
																						</button>
																						<CountryFlags
																							codes={l.peerCountryCodes}
																							size='sm'
																						/>
																						<span className={`rounded border px-1.5 py-0.2 text-[10px] ${TYPE_META[peerType].badge}`}>{TYPE_META[peerType].label}</span>
																						{!profileEditing && roleClean ?
																							<span className='text-[11px] opacity-75'>({roleClean})</span>
																						:	null}
																						{l.peerPrimaryLocation ?
																							<span className='text-[11px] opacity-70'>📍 {l.peerPrimaryLocation}</span>
																						:	null}
																					</div>
																					{profileEditing ?
																						<button
																							type='button'
																							onClick={() => patchDraft({ deleted: !markedRemove })}
																							className='shrink-0 cursor-pointer rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] font-semibold opacity-80 hover:opacity-100'>
																							{markedRemove ? 'Undo' : 'Remove'}
																						</button>
																					:	null}
																				</div>
																				{profileEditing && draft && !markedRemove ?
																					<div className='mt-2 grid gap-1.5 sm:grid-cols-6'>
																						<select
																							value={draft.relationType}
																							onChange={(e) =>
																								patchDraft({ relationType: e.target.value as ProfileRelationType })
																							}
																							className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px] sm:col-span-2'>
																							{(
																								CONNECTED_ADD_RELATIONS.includes(draft.relationType) ?
																									CONNECTED_ADD_RELATIONS
																								:	([draft.relationType, ...CONNECTED_ADD_RELATIONS] as ProfileRelationType[])
																							).map((rel) => (
																								<option
																									key={rel}
																									value={rel}>
																									{rel.replace(/_/g, ' ')}
																								</option>
																							))}
																						</select>
																						<input
																							value={draft.roleLabel}
																							onChange={(e) => patchDraft({ roleLabel: e.target.value })}
																							placeholder='Role / title'
																							className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px] sm:col-span-2'
																						/>
																						<input
																							value={draft.startDate}
																							onChange={(e) => patchDraft({ startDate: e.target.value })}
																							onBlur={(e) =>
																								patchDraft({ startDate: formatDateDraftOnBlur(e.target.value) })
																							}
																							placeholder={DATE_INPUT_PLACEHOLDER}
																							title={DATE_INPUT_TITLE}
																							className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px]'
																						/>
																						<input
																							value={draft.endDate}
																							onChange={(e) => patchDraft({ endDate: e.target.value })}
																							onBlur={(e) =>
																								patchDraft({ endDate: formatDateDraftOnBlur(e.target.value) })
																							}
																							placeholder={DATE_INPUT_PLACEHOLDER}
																							title={DATE_INPUT_TITLE}
																							className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px]'
																						/>
																						<input
																							value={draft.evidenceNote}
																							onChange={(e) => patchDraft({ evidenceNote: e.target.value })}
																							placeholder='Note'
																							className='rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-[11px] sm:col-span-6'
																						/>
																					</div>
																				:	null}
																				{showRelNote ?
																					<p className='m-0 mt-1.5 text-[11px] leading-snug opacity-70'>{displayNote}</p>
																				:	null}
																			</div>
																		);
																	})}
																</div>}

															<form
																onSubmit={(e) => void handleAddConnection(e)}
																className='grid gap-2 border-t border-[var(--app-border)] pt-2.5 sm:grid-cols-6'>
																<div className='relative sm:col-span-2'>
																	<input
																		required
																		value={connPeer ? connPeer.name : connSearch}
																		onChange={(e) => {
																			setConnPeer(null);
																			setConnSearch(e.target.value);
																			setConnSearchOpen(true);
																		}}
																		onFocus={() => {
																			if (connHits.length > 0) setConnSearchOpen(true);
																		}}
																		placeholder='Search existing profile *'
																		className='w-full rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
																		autoComplete='off'
																	/>
																	{connSearchOpen && !connPeer && connHits.length > 0 ?
																		<ul className='absolute z-20 m-0 mt-0.5 max-h-48 w-full list-none overflow-auto rounded border border-[var(--app-border)] bg-[var(--app-surface)] p-0 shadow-lg'>
																			{connHits.map((hit) => (
																				<li key={hit.id}>
																					<button
																						type='button'
																						onClick={() => {
																							setConnPeer(hit);
																							setConnSearch(hit.name);
																							setConnHits([]);
																							setConnSearchOpen(false);
																							if (
																								hit.profileType === 'person' &&
																								(detail.profile.profileType === 'firm' ||
																									detail.profile.profileType === 'government' ||
																									detail.profile.profileType === 'nonprofit' ||
																									detail.profile.profileType === 'education' ||
																									detail.profile.profileType === 'medical_hospital')
																							) {
																								setConnRelation('employed_by');
																							}
																						}}
																						className='flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-left text-xs hover:bg-[var(--app-surface-hover)]'>
																						<span className='min-w-0 flex-1 truncate font-medium'>{hit.name}</span>
																						<span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] ${TYPE_META[hit.profileType].badge}`}>
																							{TYPE_META[hit.profileType].label}
																						</span>
																					</button>
																				</li>
																			))}
																		</ul>
																	:	null}
																	{connPeer ?
																		<p className='m-0 mt-0.5 text-[10px] opacity-70'>
																			Selected: {connPeer.name}{' '}
																			<span className={`rounded border px-1 py-0.5 ${TYPE_META[connPeer.profileType].badge}`}>
																				{TYPE_META[connPeer.profileType].label}
																			</span>{' '}
																			<button
																				type='button'
																				className='cursor-pointer border-0 bg-transparent p-0 text-[10px] text-[#F97316] underline'
																				onClick={() => {
																					setConnPeer(null);
																					setConnSearch('');
																				}}>
																				Clear
																			</button>
																		</p>
																	:	null}
																</div>
																<select
																	value={connRelation}
																	onChange={(e) => setConnRelation(e.target.value as ProfileRelationType)}
																	className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'>
																	{CONNECTED_ADD_RELATIONS.map((rel) => (
																		<option
																			key={rel}
																			value={rel}>
																			{rel.replace(/_/g, ' ')}
																		</option>
																	))}
																</select>
																<input
																	value={connRole}
																	onChange={(e) => setConnRole(e.target.value)}
																	placeholder='Role / title'
																	className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
																/>
																<div className='flex gap-1'>
																	<input
																		value={connStart}
																		onChange={(e) => setConnStart(e.target.value)}
																		onBlur={() => setConnStart((v) => formatDateDraftOnBlur(v))}
																		placeholder={DATE_INPUT_PLACEHOLDER}
																		title={DATE_INPUT_TITLE}
																		className='w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs'
																	/>
																	<input
																		value={connEnd}
																		onChange={(e) => setConnEnd(e.target.value)}
																		onBlur={() => setConnEnd((v) => formatDateDraftOnBlur(v))}
																		placeholder={DATE_INPUT_PLACEHOLDER}
																		title={DATE_INPUT_TITLE}
																		className='w-1/2 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-1 text-xs'
																	/>
																</div>
																<input
																	value={connNote}
																	onChange={(e) => setConnNote(e.target.value)}
																	placeholder='Note (optional)'
																	className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-5'
																/>
																<div className='flex justify-end sm:col-span-1'>
																	<button
																		type='submit'
																		disabled={savingConn || !connPeer}
																		className='cursor-pointer rounded border-none bg-[#F97316] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50'>
																		{savingConn ? 'Linking…' : '+ Add'}
																	</button>
																</div>
															</form>
														</div>
													</div>
												);
											})()}
										</div>
									:	null}

									{/* TAB 2: Timeline (year sections) */}
									{profileTab === 'timeline' ?
										<div className='space-y-4'>
											{loadingTimeline ?
												<p className='text-xs opacity-70'>Loading timeline…</p>
											: timeline ?
												<>
													{timeline.entries.length === 0 ?
														<p className='text-xs opacity-70'>No timeline entries yet. Add one below or link dated historic events to this profile.</p>
													:	(() => {
															const sourceDate = detail?.profile?.startDate || null;
															const profileName = String(detail?.profile?.name || '').trim();
															const normTitle = (s: string) =>
																s
																	.toLowerCase()
																	.replace(/[^a-z0-9]+/g, ' ')
																	.trim();
															const profileNorm = normTitle(profileName);
															const titleMatchesProfile = (title: string) => {
																if (!profileNorm) return false;
																const t = normTitle(title);
																if (!t) return false;
																return (
																	t === profileNorm ||
																	t.startsWith(profileNorm) ||
																	profileNorm.startsWith(t) ||
																	t.includes(profileNorm)
																);
															};
															// Highlight only when this card’s title appears among other, different rows.
															const matchCount = profileNorm
																? timeline.entries.filter((e) => titleMatchesProfile(e.title || '')).length
																: 0;
															const highlightCurrent =
																timeline.entries.length > 1 && matchCount > 0 && matchCount < timeline.entries.length;
															const isCurrentArticle = (title: string) =>
																Boolean(highlightCurrent && titleMatchesProfile(title));
															const renderPlainYearSections = (entryList: typeof timeline.entries, prefix = '') => {
															const byYear = new Map<string, typeof timeline.entries>();
															for (const entry of entryList) {
															const resolved = resolveSummaryTimelineDate(entry.eventDate, sourceDate);
															const y =
															resolved && /^\d{4}/.test(resolved) ? resolved.slice(0, 4)
															: resolved && /\b((?:1[6-9]|20)\d{2})\b/.test(resolved) ?
															(resolved.match(/\b((?:1[6-9]|20)\d{2})\b/) || [])[1]
															:	'Undated';
															const list = byYear.get(y) || [];
															list.push({ ...entry, eventDate: resolved === 'Undated' ? entry.eventDate : resolved });
															byYear.set(y, list);
															}
															const years = [...byYear.keys()].sort((a, b) => {
															if (a === 'Undated') return 1;
															if (b === 'Undated') return -1;
															return b.localeCompare(a);
															});
															return (
															<div className='space-y-5'>
															{years.map((year) => {
															const yearEntries = byYear.get(year) || [];
															const dateGroups: Array<{
															key: string;
															label: string | null;
															entries: typeof yearEntries;
															}> = [];
															const dateIndex = new Map<string, number>();
															for (const entry of yearEntries) {
															const spanBounds = parseTimelineEntryBounds(entry);
															const resolved = resolveSummaryTimelineDate(entry.eventDate, sourceDate);
															const key = spanBounds?.isRange
															? `range:${formatTimelineSpanHeaderLabel(entry)}`
															: summaryTimelineDateKey(resolved);
															const existing = dateIndex.get(key);
															if (existing != null) {
															dateGroups[existing].entries.push(entry);
															continue;
															}
															dateIndex.set(key, dateGroups.length);
															dateGroups.push({
															key,
															label: spanBounds?.isRange
															? formatTimelineSpanHeaderLabel(entry)
															: summaryTimelineDateLabelInYear(resolved, year),
															entries: [entry],
															});
															}
															return (
															<section
															key={`${prefix}${year}`}
															className='space-y-2'>
															<div className='sticky top-0 z-[1] -mx-0.5 flex items-baseline gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface)] px-0.5 py-1.5'>
															<h3 className='m-0 text-sm font-bold tracking-wide text-[#F97316]'>{year}</h3>
															<span className='text-[10px] opacity-60'>
															{yearEntries.length} {yearEntries.length === 1 ? 'entry' : 'entries'}
															{dateGroups.length !== yearEntries.length ? ` · ${dateGroups.length} dates` : ''}
															</span>
															</div>
															<div className='relative ml-1.5 space-y-0 border-l-2 border-[var(--app-border)] pl-3.5'>
															{dateGroups.map((group) => {
															const geos = group.entries
															.map((e) => e.geoLabel)
															.filter(Boolean)
															.filter((g, i, arr) => arr.indexOf(g) === i);
															const urls = group.entries
															.map((e) => e.sourceUrl)
															.filter(Boolean)
															.filter((u, i, arr) => arr.indexOf(u) === i);
															const showMeta = Boolean(group.label) || geos.length > 0 || urls.length > 0;
															return (
															<article
															key={`${prefix}${year}-${group.key}`}
															className='relative pb-3.5 last:pb-1'>
															<span
															aria-hidden
															className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-[#F97316] bg-[var(--app-surface)]'
															/>
															{showMeta ?
															<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]'>
															{group.label ?
															<span className='font-mono font-semibold opacity-90'>{group.label}</span>
															:	null}
															{geos.map((geo) => (
															<span
															key={String(geo)}
															className='opacity-65'>
															📍 {geo}
															</span>
															))}
															{urls.map((url) => (
															<a
															key={String(url)}
															href={String(url)}
															target='_blank'
															rel='noreferrer'
															className='text-sky-600 underline dark:text-sky-300'>
															Source ↗
															</a>
															))}
															</div>
															:	null}
															<div className={group.entries.length > 1 ? 'mt-1.5 space-y-2.5' : 'mt-0.5'}>
															{group.entries.map((entry) => renderPointCard(entry))}
															</div>
															</article>
															);
															})}
															</div>
															</section>
															);
															})}
															</div>
															);
															};

															const renderTimelineSpanCard = (
															chapter: RangeSpanChapter<(typeof timeline.entries)[number]>,
															key: string,
															depth = 0,
															): ReactNode => {
															const spanLabel = formatTimelineSpanHeaderLabel(chapter.span);
															const duration = formatRangeSpanDuration(chapter.bounds);
															const innerItems: Array<
															| { kind: 'child'; sortKey: number; chapter: RangeSpanChapter<(typeof timeline.entries)[number]> }
															| { kind: 'point'; sortKey: number; entry: (typeof timeline.entries)[number] }
															> = [
															...chapter.children.map((child) => ({
															kind: 'child' as const,
															sortKey: child.sortKey,
															chapter: child,
															})),
															...chapter.nested.map((n) => ({
															kind: 'point' as const,
															sortKey: n.sortKey,
															entry: n.item,
															})),
															].sort((a, b) => {
															if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
															if (a.kind !== b.kind) return a.kind === 'child' ? -1 : 1;
															return 0;
															});

															type InnerNode =
															| { kind: 'child'; chapter: RangeSpanChapter<(typeof timeline.entries)[number]> }
															| {
															kind: 'dateGroup';
															dateKey: string;
															label: string;
															entries: Array<(typeof timeline.entries)[number]>;
															};
															const groupedInner: InnerNode[] = [];
															for (const item of innerItems) {
															if (item.kind === 'child') {
															groupedInner.push({ kind: 'child', chapter: item.chapter });
															continue;
															}
															const resolved = resolveSummaryTimelineDate(item.entry.eventDate, sourceDate);
															const dateKey = summaryTimelineDateKey(resolved);
															const prev = groupedInner[groupedInner.length - 1];
															if (prev && prev.kind === 'dateGroup' && prev.dateKey === dateKey) {
															prev.entries.push(item.entry);
															} else {
															groupedInner.push({
															kind: 'dateGroup',
															dateKey,
															label: summaryTimelineDateLabel(resolved),
															entries: [item.entry],
															});
															}
															}

															return (
															<section
															key={key}
															className={
															depth > 0 ?
															'overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/[0.04]'
															:	'overflow-hidden rounded-lg border border-[#F97316]/35 bg-[#F97316]/[0.05]'
															}>
															<header className='border-b border-[var(--app-border)] px-3 py-2.5'>
															<div className='mb-1.5 flex flex-wrap items-center justify-between gap-2'>
															<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
															<span className='font-mono text-sm font-bold tracking-wide text-[#F97316]'>
															{spanLabel}
															</span>
															{duration ?
															<span className='text-[11px] font-medium opacity-65'>{duration}</span>
															:	null}
															{chapter.span.geoLabel ?
															<span className='text-[11px] opacity-65'>📍 {chapter.span.geoLabel}</span>
															:	null}
															{chapter.span.sourceUrl ?
															<a
															href={String(chapter.span.sourceUrl)}
															target='_blank'
															rel='noreferrer'
															className='text-[11px] text-sky-600 underline dark:text-sky-300'>
															Source ↗
															</a>
															:	null}
															</div>
															<span className='rounded border border-[#F97316]/35 bg-[#F97316]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#F97316] dark:text-[#FDBA74]'>
															{chapter.totalNestedCount}{' '}
															{chapter.totalNestedCount === 1 ? 'milestone' : 'milestones'}
															</span>
															</div>
															{renderPointCard(chapter.span)}
															</header>
															<div className='relative ml-3.5 space-y-0 border-l-2 border-[#F97316]/45 py-2.5 pl-3.5 pr-3'>
															{groupedInner.map((node, ni) => {
															if (node.kind === 'child') {
															return (
															<div
															key={`${key}-child-${ni}`}
															className='pb-3 last:pb-1'>
															{renderTimelineSpanCard(node.chapter, `${key}-c-${ni}`, depth + 1)}
															</div>
															);
															}
															const geos = node.entries
															.map((e) => e.geoLabel)
															.filter(Boolean)
															.filter((g, i, arr) => arr.indexOf(g) === i);
															const urls = node.entries
															.map((e) => e.sourceUrl)
															.filter(Boolean)
															.filter((u, i, arr) => arr.indexOf(u) === i);
															return (
															<article
															key={`${key}-pt-${node.dateKey}-${ni}`}
															className='relative pb-3.5 last:pb-1'>
															<span
															aria-hidden
															className='absolute -left-[1.03rem] top-1.5 h-2 w-2 rounded-full border-2 border-[#F97316] bg-[var(--app-surface)]'
															/>
															<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]'>
															<span className='font-mono font-semibold text-[#F97316] dark:text-[#FDBA74]'>
															{node.label}
															</span>
															{geos.map((geo) => (
															<span
															key={String(geo)}
															className='opacity-65'>
															📍 {geo}
															</span>
															))}
															{urls.map((url) => (
															<a
															key={String(url)}
															href={String(url)}
															target='_blank'
															rel='noreferrer'
															className='text-sky-600 underline dark:text-sky-300'>
															Source ↗
															</a>
															))}
															</div>
															<div className={node.entries.length > 1 ? 'mt-1.5 space-y-2.5' : 'mt-0.5'}>
															{node.entries.map((entry) => renderPointCard(entry))}
															</div>
															</article>
															);
															})}
															</div>
															</section>
															);
															};

															const renderYearSections = (entryList: typeof timeline.entries) => {
															const { stream, hasActiveSpans } = nestTimelineItemsIntoRangeSpans(
															entryList,
															(e) => parseTimelineEntryBounds(e),
															(e) => summaryYearSortKey(resolveSummaryTimelineDate(e.eventDate, sourceDate)),
															);
															if (!hasActiveSpans) {
															return renderPlainYearSections(entryList);
															}
															const nodes: ReactNode[] = [];
															let pending: typeof timeline.entries = [];
															const flushPending = (key: string) => {
															if (!pending.length) return;
															nodes.push(
															<div key={key}>{renderPlainYearSections(pending, `${key}-`)}</div>,
															);
															pending = [];
															};
															stream.forEach((item, idx) => {
															if (item.kind === 'point') {
															pending.push(item.item);
															return;
															}
															flushPending(`tl-pts-before-${idx}`);
															nodes.push(renderTimelineSpanCard(item.chapter, `tl-span-${idx}`));
															});
															flushPending('tl-pts-tail');
															return <div className='space-y-5'>{nodes}</div>;
															};

															const renderPointCard = (entry: (typeof timeline.entries)[number]) => {
															const display = formatResearchDriveTimelineEntry({
															title: entry.title,
															summary: entry.summary,
															sourceCorpus: entry.sourceCorpus,
															});
															const displayTitle = display.title || entry.title || '';
															const displaySummary = display.summary || '';
															const current = isCurrentArticle(displayTitle) || isCurrentArticle(entry.title || '');
															const jumpKey =
															entry.linkedProfileSlug ||
															entry.linkedProfileId ||
															(entry.originProfileId &&
															entry.originProfileId !== detail?.profile?.id &&
															(entry.originProfileSlug || entry.originProfileId)
															? entry.originProfileSlug || entry.originProfileId
															: null);
															const canJump =
															Boolean(jumpKey) &&
															jumpKey !== detail?.profile?.id &&
															jumpKey !== detail?.profile?.slug;
															const focusMatch =
															Boolean(timelineFocusTitle) &&
															(normTitle(displayTitle) === normTitle(timelineFocusTitle || '') ||
															normTitle(entry.title || '') === normTitle(timelineFocusTitle || ''));
															const titleClass = 'text-sm font-semibold leading-snug text-left';
															const isEmpSpan =
															entry.entryKind === 'employment' ||
															String(entry.metadata?.kind || '') === 'employment_span';
															return (
															<div
															key={entry.id}
															data-timeline-focus={focusMatch ? '1' : undefined}
															className={
															focusMatch ?
															'rounded-md border border-sky-500/70 bg-sky-500/15 px-2 py-1.5 ring-1 ring-sky-400/40'
															: current ?
															'rounded-md border border-[#F97316]/60 bg-[#F97316]/10 px-2 py-1.5 ring-1 ring-[#F97316]/35'
															: isEmpSpan ?
															'rounded-md border border-emerald-500/35 bg-emerald-500/8 px-2 py-1.5'
															:	undefined
															}>
															<div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
															{canJump && jumpKey ?
															<button
															type='button'
															onClick={() =>
															jumpToProfile(String(jumpKey), {
															tab: 'timeline',
															focusTimelineTitle: displayTitle,
															label:
															entry.linkedProfileName ||
															entry.originProfileSlug ||
															null,
															})
															}
															title={
															entry.linkedProfileName
															? `Open profile: ${entry.linkedProfileName}`
															: 'Open related event profile'
															}
															className={`${titleClass} text-sky-700 underline decoration-sky-700/40 underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:decoration-sky-300/40 dark:hover:text-sky-200`}>
															{displayTitle}
															</button>
															:	<div className={titleClass}>{displayTitle}</div>}
															{entry.entryKind === 'employment' ?
															<span className='rounded border border-emerald-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200'>
															Employment
															</span>
															: entry.entryKind === 'filing' ?
															<span className='rounded border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200'>
															Disclosure
															</span>
															: entry.entryKind === 'milestone' ?
															<span className='rounded border border-violet-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200'>
															Milestone
															</span>
															:	null}
															{display.isResearchDrive ?
															<span className='rounded border border-white/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-70'>
															Research Drive
															</span>
															:	null}
															{focusMatch ?
															<span className='rounded-full bg-sky-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white'>
															Jumped here
															</span>
															: current ?
															<span className='rounded-full bg-[#F97316] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white'>
															This event
															</span>
															:	null}
															</div>
															{displaySummary && displaySummary !== displayTitle ?
															<p className='m-0 mt-1 whitespace-pre-wrap text-xs leading-relaxed opacity-80'>
															{displaySummary.length > 900 ?
															`${displaySummary.slice(0, 900).trim()}…`
															:	displaySummary}
															</p>
															:	null}
															{isEmpSpan && entry.endDate ?
															<p className='m-0 mt-1 text-[11px] font-mono opacity-70'>
															Through {entry.endDate}
															</p>
															: isEmpSpan && entry.metadata?.isCurrent ?
															<p className='m-0 mt-1 text-[11px] font-mono opacity-70'>Through Present</p>
															:	null}
															</div>
															);
															};

															const useCareerChapters =
															detail?.profile?.profileType === 'person' &&
															timeline.entries.some(
															(e) =>
															e.entryKind === 'employment' ||
															String(e.metadata?.kind || '') === 'employment_span',
															);

															if (useCareerChapters) {
															return (
															<ProfileTimelineCareerView
															entries={timeline.entries}
															renderPointEntry={(entry) => renderPointCard(entry)}
															renderUnassignedYearSections={(list) => renderYearSections(list)}
															/>
															);
															}

															return renderYearSections(timeline.entries);
														})()
													}

													{/* Add Manual Timeline Observation */}
													<form
														onSubmit={(e) => void handleAddObservation(e)}
														className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3'>
														<h4 className='m-0 mb-2 text-xs font-semibold'>+ Add Timeline Observation</h4>
														<div className='grid gap-2 sm:grid-cols-3'>
															<input
																value={obsDate}
																onChange={(e) => setObsDate(e.target.value)}
																placeholder={DATE_INPUT_PLACEHOLDER}
																title={DATE_INPUT_TITLE}
																onBlur={(e) => {
																	const next = formatDateDraftOnBlur(e.target.value);
																	if (next !== e.target.value) setObsDate(next);
																}}
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
															/>
															<select
																value={obsAngle}
																onChange={(e) => setObsAngle(e.target.value)}
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'>
																<option value='general'>General</option>
																<option value='civilian_health'>Civilian Health</option>
																<option value='defense_dod'>Defense / DoD</option>
																<option value='law_enforcement'>Law Enforcement</option>
																<option value='regulatory_finra'>Regulatory / FINRA</option>
																<option value='land_records'>Land Records / Deeds</option>
																<option value='academic_research'>Academic Research</option>
																<option value='financial'>Financial</option>
																<option value='geophysical'>Geophysical</option>
																<option value='corporate'>Corporate</option>
																<option value='policy'>Policy</option>
															</select>
															<input
																value={obsGeo}
																onChange={(e) => setObsGeo(e.target.value)}
																placeholder='Location (e.g. Dallas, TX)'
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
															/>
															<input
																required
																value={obsTitle}
																onChange={(e) => setObsTitle(e.target.value)}
																placeholder='Observation title *'
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-2'
															/>
															<input
																value={obsUrl}
																onChange={(e) => setObsUrl(e.target.value)}
																placeholder='Source URL (optional)'
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs'
															/>
															<textarea
																rows={2}
																value={obsSummary}
																onChange={(e) => setObsSummary(e.target.value)}
																placeholder='Details / evidence / alternative angle notes…'
																className='rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1 text-xs sm:col-span-3'
															/>
														</div>
														<div className='mt-2 flex justify-end'>
															<button
																type='submit'
																disabled={savingObs}
																className='cursor-pointer rounded border-none bg-[#F97316] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50'>
																{savingObs ? 'Saving…' : 'Add to Timeline'}
															</button>
														</div>
													</form>
												</>
											:	null}
										</div>
									:	null}

									{/* TAB 3: Profile Alignments */}
									{profileTab === 'alignments' ?
										<div className='space-y-2.5'>
											{detail.alignments.length === 0 ?
												<p className='text-xs opacity-70'>
													No alignment candidates recorded for this profile yet. Try clicking <strong>Sync &amp; Align All Data</strong> to scan all corpora.
												</p>
											:	<>
													<p className='text-[11px] leading-relaxed opacity-70'>
														<strong>Accept</strong> marks a candidate as reviewed/valid; <strong>Dismiss</strong> rejects it. Name-only Research Drive hits stay as notes until you
														confirm addresses or other facts separately — Accept does not auto-merge document fields onto the dossier.
													</p>
													{detail.alignments.map((al) => {
														const peerId = al.leftProfileId === detail.profile.id ? al.rightProfileId : al.leftProfileId;
														const peerName = al.leftProfileId === detail.profile.id ? al.rightName : al.leftName;
														return (
															<div
																key={al.id}
																className='rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs'>
																<div className='flex flex-wrap items-center justify-between gap-2'>
																	<div className='flex flex-wrap items-center gap-1.5'>
																		<span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CAUTION_BADGE[al.cautionTier]}`}>
																			{al.cautionTier.replace(/_/g, ' ')}
																		</span>
																		<span
																			className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
																				al.alignmentKind === 'possible_match_name_only' ?
																					'border border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200'
																				:	'bg-[var(--app-surface-hover)]'
																			}`}>
																			{al.alignmentKind === 'possible_match_name_only' ? 'Name-only match' : al.alignmentKind.replace(/_/g, ' ')}
																		</span>
																		<span className='opacity-70'>score {al.score.toFixed(2)}</span>
																		<span
																			className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
																				al.status === 'confirmed' ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
																				: al.status === 'dismissed' ? 'border border-rose-500/35 bg-rose-500/10 text-rose-800 dark:text-rose-200'
																				: 'border border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200'
																			}`}>
																			{al.status === 'confirmed' ?
																				'accepted'
																			: al.status === 'dismissed' ?
																				'dismissed'
																			:	'needs review'}
																		</span>
																	</div>
																	<div className='flex gap-1.5'>
																		{(al.alignmentKind === 'same_entity_alias' || al.alignmentKind === 'shared_identifier') && peerId && peerName ?
																			<button
																				type='button'
																				onClick={() => void handleMergeProfiles(detail.profile.id, peerId, detail.profile.name, peerName)}
																				className='cursor-pointer rounded border border-[#F97316]/50 bg-[#F97316]/15 px-2 py-0.5 text-[11px] font-semibold text-[#F97316]'>
																				Merge into this
																			</button>
																		:	null}
																		{al.status !== 'confirmed' ?
																			<button
																				type='button'
																				disabled={savingAlignmentId === al.id}
																				onClick={() => void handleTriageAlignment(al.id, 'confirmed')}
																				className='cursor-pointer rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 disabled:opacity-50 dark:text-emerald-200'>
																				{savingAlignmentId === al.id ? 'Saving…' : 'Accept'}
																			</button>
																		:	null}
																		{al.status !== 'dismissed' ?
																			<button
																				type='button'
																				disabled={savingAlignmentId === al.id}
																				onClick={() => void handleTriageAlignment(al.id, 'dismissed')}
																				className='cursor-pointer rounded border border-[var(--app-border)] bg-transparent px-2 py-0.5 text-[11px] opacity-75 disabled:opacity-50'>
																				Dismiss
																			</button>
																		:	null}
																	</div>
																</div>

																{peerId && peerName ?
																	<div className='mt-1.5'>
																		<span className='opacity-70'>Aligned with: </span>
																		<button
																			type='button'
																			onClick={() => jumpToProfile(peerId)}
																			className='cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-[#F97316] underline'>
																			{peerName}
																		</button>
																	</div>
																:	null}

																<p className='my-1.5 leading-relaxed opacity-85'>{scrubEpsteinSourceLabels(al.rationale)}</p>

																{al.evidence.length > 0 ?
																	<AlignmentEvidenceList
																		evidence={al.evidence}
																		initialLimit={8}
																		alignmentKind={al.alignmentKind}
																		rationale={al.rationale}
																		leftProfileId={al.leftProfileId}
																		rightProfileId={al.rightProfileId}
																		leftName={al.leftName || al.leftSlug}
																		rightName={al.rightName || al.rightSlug}
																		onOpenProfile={jumpToProfile}
																	/>
																:	null}
															</div>
														);
													})}
												</>
											}
										</div>
									:	null}
								</div>
							}
						</section>
					</div>
				}
			</main>
		</div>
	);
}
