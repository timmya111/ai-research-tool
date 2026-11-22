'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
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

const HIDDEN_SOURCE_TAGS = new Set(['wikipedia-local', 'finra-visualizer']);

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
		label: 'Medical Hospital',
		plural: 'Medical Hospitals',
		badge: 'bg-teal-500/15 text-teal-800 dark:text-teal-200 border-teal-500/30',
		group: 'actor',
	},
	government: {
		label: 'Government',
		plural: 'Government',
		badge: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/35',
		group: 'actor',
	},
	foreign: {
		label: 'Foreign',
		plural: 'Foreign',
		badge: 'bg-slate-500/15 text-slate-800 dark:text-slate-200 border-slate-500/30',
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

const ALL_TYPES: ProfileType[] = [
	'historic_event',
	'person',
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	'foreign',
];

const CATEGORY_TAG_TYPES: ProfileType[] = [
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	'foreign',
	'historic_event',
];

const EMPLOYER_CATEGORY_TYPES: ProfileType[] = [
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	'foreign',
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
	{ key: 'citizenship', label: 'Citizenship / Nationality' },
	{ key: 'politicalParty', label: 'Political Party' },
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

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatMonthYear(iso?: string | null): string {
	const raw = String(iso || '').trim();
	if (!raw) return '';
	const ym = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
	if (ym) {
		const mIdx = Number(ym[2]) - 1;
		if (mIdx >= 0 && mIdx < 12) return `${SHORT_MONTHS[mIdx]} ${ym[1]}`;
	}
	const y = raw.match(/^(\d{4})$/);
	if (y) return y[1];
	return raw;
}

function formatExactDate(iso?: string | null): string {
	const raw = String(iso || '').trim();
	if (!raw) return '';
	const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (ymd) return `${Number(ymd[2])}/${Number(ymd[3])}/${ymd[1]}`;
	return formatMonthYear(raw);
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
	const s = formatMonthYear(startDate);
	const e = formatMonthYear(endDate);
	if (s && e) return s === e ? s : `${s} → ${e}`;
	if (s) return isCurrent === false ? s : `${s} → Present`;
	if (e) return isEducation ? `Grad. ${e}` : `Ended ${e}`;
	return null;
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
	{ value: 'county_filing_match', label: 'County / Knowledge match' },
	{ value: 'angle_comparison', label: 'Multi-angle overlap' },
	{ value: 'same_entity_alias', label: 'Alias / name overlap' },
	{ value: 'co_occurrence_time_geo', label: 'Geo-temporal overlap' },
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

	// Filters
	const [query, setQuery] = useState('');
	const [typeFilter, setTypeFilter] = useState<string>('all');
	const [tagFilter, setTagFilter] = useState<string>('');
	const [corpusFilter, setCorpusFilter] = useState<string>('');
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
	const [loadingGlobalAlign, setLoadingGlobalAlign] = useState(false);

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
			const params = new URLSearchParams();
			if (query.trim()) params.set('q', query.trim());
			if (typeFilter && typeFilter !== 'all') params.set('type', typeFilter);
			if (tagFilter) params.set('tag', tagFilter);
			if (corpusFilter) params.set('corpus', corpusFilter);
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
	}, [query, typeFilter, tagFilter, corpusFilter, offset, selectedId]);

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
			params.set('limit', '80');
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
	}, [alignKindFilter, alignStatusFilter]);

	useEffect(() => {
		const timer = setTimeout(() => {
			void loadList();
		}, 120);
		return () => clearTimeout(timer);
	}, [loadList]);

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
		try {
			const res = await fetch(`/api/profiles/${encodeURIComponent(detail.profile.id)}/finra-dates`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ maxPeople: 150, concurrency: 4 }),
			});
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `Date lookup failed (${res.status})`);
			if (data.detail) setDetail(data.detail);
			else await loadDetail(detail.profile.id);
			const r = data.result;
			setBanner(
				`Fetched employment dates for ${r.peopleWithDates}/${r.peopleChecked} connected people (${r.linksUpdated} links updated${r.remainingUndated > 0 ? `, ${r.remainingUndated} remaining` : ''}${r.rateLimited ? ' — paused on FINRA rate limit, retry in ~1 min' : ''}).`,
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
		setTagFilter('');
		setCorpusFilter('');
		setOffset(0);
		setSelectedId(id);
		setLastEnrichReport(null);
		setMainView('profile');
		setProfileTab('overview');
	}, []);

	return (
		<main className="mx-auto max-w-[1380px] px-4 py-5 text-[var(--app-fg)]">
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
						<strong>Education</strong>, <strong>Non-Profits</strong>, <strong>Medical Hospitals</strong>,{' '}
						<strong>Government</strong>, <strong>Foreign</strong>, and <strong>Historic Events</strong> —
						combining all local corpora to fill timeline gaps, compare angles, and surface possible
						alignments.
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
							: `Alignment Triage (${stats?.totalAlignments ?? 0})`}
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
				<section className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
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
									<option value="medical_hospital">Medical Hospital / Health System</option>
									<option value="government">Government (Federal / State / Local)</option>
									<option value="foreign">Foreign (Ministries / Embassies / Intl)</option>
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

			{/* Main Content Area */}
			{mainView === 'alignments' ? (
				<section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
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
								onChange={(e) => setAlignKindFilter(e.target.value)}
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
								onChange={(e) => setAlignStatusFilter(e.target.value)}
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

									<p className="my-1.5 leading-relaxed opacity-85">{al.rationale}</p>

									{al.evidence.length > 0 ? (
										<div className="flex flex-wrap gap-1.5">
											{al.evidence.slice(0, 5).map((ev, idx) => (
												<span
													key={idx}
													className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 text-[10px] opacity-85"
												>
													<strong>{ev.corpus}</strong>: {ev.label}
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
				<div className="grid gap-4 lg:grid-cols-[360px_1fr]">
					{/* Left Sidebar: Search & Profile List */}
					<aside className="flex min-w-0 flex-col rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]">
						<div className="space-y-2 border-b border-[var(--app-border)] p-3">
							<input
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setOffset(0);
								}}
								placeholder="Search name, alias, CRD, ticker, topic…"
								className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs"
							/>
							<select
								value={typeFilter}
								onChange={(e) => {
									setTypeFilter(e.target.value);
									setOffset(0);
								}}
								className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
							>
								<option value="all">All types</option>
								<option value="actors">All Actors (People/Orgs)</option>
								<option value="narratives">Historic Events</option>
								{ALL_TYPES.map((t) => (
									<option key={t} value={t}>
										{TYPE_META[t].plural}
									</option>
								))}
							</select>
							<select
								value={corpusFilter}
								onChange={(e) => {
									setCorpusFilter(e.target.value);
									setOffset(0);
								}}
								className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
							>
								<option value="">All corpora</option>
								{(stats?.corpora || []).map((c) => (
									<option key={c.corpus} value={c.corpus}>
										{c.corpus}
									</option>
								))}
							</select>
							<select
								value={tagFilter}
								onChange={(e) => {
									setTagFilter(e.target.value);
									setOffset(0);
								}}
								className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
							>
								<option value="">All category tags</option>
								{CATEGORY_TAG_TYPES.map((t) => (
									<option key={t} value={t}>
										Tag: {TYPE_META[t].label}
									</option>
								))}
							</select>
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

						<div className="max-h-[72vh] divide-y divide-[var(--app-border)] overflow-y-auto">
							{(() => {
								// Ensure the currently selected entity is always visible & selectable in the left column
								const detailMatchesFilter =
									detail?.profile &&
									(detail.profile.id === selectedId || detail.profile.slug === selectedId) &&
									(typeFilter === 'all' ||
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
											No profiles yet. Click <strong>Sync &amp; Align All Data</strong> above to populate
											from all local corpora.
										</div>
									);
								}

								return visibleProfiles.map((p) => {
									const active =
										p.id === selectedId ||
										p.slug === selectedId ||
										(detail?.profile?.id != null && p.id === detail.profile.id);
									const tm = TYPE_META[p.profileType];
									return (
										<button
											key={p.id}
											ref={active ? selectedRowRef : undefined}
											type="button"
											onClick={() => {
												setSelectedId(p.slug || p.id);
												setLastEnrichReport(null);
											}}
											className={`w-full cursor-pointer border-0 border-b border-b-[var(--app-border)] px-3 py-2.5 text-left transition last:border-b-0 ${
												active
													? 'border-l-2 border-l-[#F97316] bg-[#F97316]/14'
													: 'bg-transparent hover:bg-[var(--app-surface-hover)]'
											}`}
										>
											{typeFilter === 'all' || typeFilter === 'actors' ? (
												<>
													<div className="flex items-center gap-2">
														<span
															className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tm.badge}`}
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
											{p.primaryLocation ? (
												<div className="mt-0.5 text-[10px] opacity-75">📍 {p.primaryLocation}</div>
											) : null}
										</button>
									);
								});
							})()}
						</div>
					</aside>

					{/* Right Workspace: Selected Profile Detail */}
					<section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
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
													{detail.profile.startDate}
													{detail.profile.endDate ? ` → ${detail.profile.endDate}` : ''}
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
										{detail.profile.summary ? (
											<p className="m-0 max-w-3xl text-xs leading-relaxed opacity-85">
												{detail.profile.summary}
											</p>
										) : null}
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

								{/* Tabs */}
								<div className="mt-3 mb-4 flex flex-wrap gap-2 border-b border-[var(--app-border)] pb-2">
									{(
										[
											{
												id: 'overview',
												label: `Overview & Links (${detail.counts.links})`,
											},
											{
												id: 'timeline',
												label: `Timeline & Gap Analysis (${detail.counts.timelineEntries})`,
											},
											{
												id: 'alignments',
												label: `Possible Alignments (${detail.counts.alignments})`,
											},
										] as const
									).map((t) => (
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
												const raw = meta[key];
												if (raw == null || raw === '') return null;
												const text = Array.isArray(raw)
													? raw.map(String).filter(Boolean).join(' · ')
													: String(raw).trim();
												if (!text) return null;
												return { key, label, text };
											}).filter((x): x is { key: string; label: string; text: string } => x !== null);
											const keywords = Array.isArray(meta.identifyingKeywords)
												? (meta.identifyingKeywords as unknown[]).map(String).filter(Boolean)
												: [];
											if (!detailRows.length && !keywords.length) return null;
											return (
												<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
													<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
														<h3 className="m-0 text-xs font-semibold uppercase opacity-75">
															Captured Entity Details ({detailRows.length})
														</h3>
														<div className="flex flex-wrap items-center gap-2.5">
															{detail.profile.profileType === 'person' && meta.finraCrd ? (
																<>
																	<a
																		href={`https://brokercheck.finra.org/individual/summary/${encodeURIComponent(String(meta.finraCrd))}`}
																		target="_blank"
																		rel="noreferrer"
																		className="text-[11px] font-semibold text-sky-600 underline dark:text-sky-300"
																	>
																		FINRA Summary ↗
																	</a>
																	<a
																		href={`https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(String(meta.finraCrd))}.pdf`}
																		target="_blank"
																		rel="noreferrer"
																		className="text-[11px] font-semibold text-sky-600 underline dark:text-sky-300"
																	>
																		FINRA PDF ↗
																	</a>
																	<a
																		href={`https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(String(meta.finraCrd))}`}
																		target="_blank"
																		rel="noreferrer"
																		className="text-[11px] font-semibold text-emerald-600 underline dark:text-emerald-300"
																	>
																		SEC AdvisorInfo ↗
																	</a>
																</>
															) : null}
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
													</div>
													{detailRows.length > 0 ? (
														<div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
															{detailRows.map((row) => (
																<div
																	key={row.key}
																	className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-1.5"
																>
																	<div className="text-[10px] font-semibold uppercase opacity-65">
																		{row.label}
																	</div>
																	<div className="mt-0.5 break-words leading-snug">{row.text}</div>
																</div>
															))}
														</div>
													) : null}
													{keywords.length > 0 ? (
														<div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
															<span className="font-semibold uppercase opacity-65">
																Identifying keywords:
															</span>
															{keywords.slice(0, 14).map((kw) => (
																<span
																	key={kw}
																	className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-1.5 py-0.5 opacity-80"
																>
																	{kw}
																</span>
															))}
														</div>
													) : null}
												</div>
											);
										})()}
										<div className="grid gap-3 md:grid-cols-3">
											{/* Aliases */}
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

											{/* Identifiers */}
											<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
												<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
													External Identifiers ({detail.identifiers.length})
												</h3>
												{detail.identifiers.length === 0 ? (
													<p className="m-0 text-[11px] opacity-65">None recorded yet.</p>
												) : (
													<ul className="m-0 list-none space-y-1 p-0 text-[11px]">
														{detail.identifiers.map((idItem) => (
															<li key={idItem.id}>
																<span className="opacity-70">{idItem.scheme}:</span>{' '}
																<strong>{idItem.value}</strong>
															</li>
														))}
													</ul>
												)}
											</div>

											{/* Locations */}
											<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
												<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
													Locations ({detail.locations.length})
												</h3>
												{detail.locations.length === 0 ? (
													<p className="m-0 mb-2 text-[11px] opacity-65">No locations tagged yet.</p>
												) : (
													<ul className="m-0 mb-2 list-none space-y-1 p-0 text-[11px]">
														{detail.locations.slice(0, 12).map((loc) => (
															<li key={loc.id}>
																<span>📍 {loc.raw}</span>{' '}
																<span className="text-[10px] opacity-60">({loc.role})</span>
															</li>
														))}
													</ul>
												)}
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
										</div>

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
																		{emp.sourceCorpus && !HIDDEN_SOURCE_TAGS.has(emp.sourceCorpus) ? (
																			<span className="rounded bg-[var(--app-bg)] px-1.5 py-0.5 opacity-75">
																				{emp.sourceCorpus}
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
															{/* Employment History */}
															<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
																<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																	Employment History ({workEntries.length})
																</h3>
																{workEntries.length === 0 ? (
																	<p className="m-0 mb-3 text-xs opacity-70">
																		No employment history recorded yet. Add one below.
																	</p>
																) : (
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
																)}

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

															{/* Education */}
															<div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
																<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
																	Education ({educationEntries.length})
																</h3>
																{educationEntries.length === 0 ? (
																	<p className="m-0 text-xs opacity-70">
																		No education records yet. Select <strong>Education</strong> in the form
																		above to add a school.
																	</p>
																) : (
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
																						{edu.sourceCorpus && !HIDDEN_SOURCE_TAGS.has(edu.sourceCorpus) ? (
																							<span className="rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px]">
																								{edu.sourceCorpus}
																							</span>
																						) : null}
																					</div>
																				</div>
																			);
																		})}
																	</div>
																)}
															</div>
														</>
													);
												})()
											: null}

										{/* Connected Profiles (deduplicated & excluding orgs already shown in Employment History for people) */}
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
											const connectedLinks = detail.links
												.filter((l) => {
													const peerId =
														l.fromProfileId === detail.profile.id ? l.toProfileId : l.fromProfileId;
													return !empPeerIds.has(peerId);
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

											return (
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
																			{ id: 'all', label: `All (${connectedLinks.length.toLocaleString()})` },
																			{ id: 'current', label: `Current (${currentCount.toLocaleString()})` },
																			{ id: 'old', label: `Old (${oldCount.toLocaleString()})` },
																		] as const
																	).map((tab) => (
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
																const visibleSources = (
																	l.sources && l.sources.length > 0 ? l.sources : [l.sourceCorpus]
																).filter((s) => s && !HIDDEN_SOURCE_TAGS.has(s));
																const sourceLabel = visibleSources.join(', ');
																const roleClean =
																	l.roleLabel &&
																	!/^(?:current|previous)\s+registration$/i.test(l.roleLabel.trim())
																		? l.roleLabel.trim()
																		: null;
																return (
																	<div
																		key={l.id}
																		className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs"
																	>
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
																		</div>
																		{sourceLabel ? (
																			<div className="flex items-center gap-1.5 text-[10px] opacity-75">
																				<span>{sourceLabel}</span>
																			</div>
																		) : null}
																	</div>
																);
															})}
														</div>
													)}
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
												{/* Multi-Angle Overlapping Months */}
												{timeline.overlappingWindows.length > 0 ? (
													<div className="rounded-lg border border-sky-500/35 bg-sky-500/10 p-3 text-xs">
														<div className="mb-1.5 font-semibold">
															Multi-Angle Convergence Windows ({timeline.overlappingWindows.length} months
															where ≥2 angles/sources overlap)
														</div>
														<div className="flex flex-wrap gap-1.5">
															{timeline.overlappingWindows.slice(0, 14).map((w) => (
																<span
																	key={w.month}
																	className="rounded border border-sky-500/30 bg-[var(--app-surface)] px-2 py-0.5 text-[11px]"
																>
																	<strong>{w.month}</strong>: {w.angles.join(' + ')} ({w.count})
																</span>
															))}
														</div>
													</div>
												) : null}

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
																		<strong>Before ({g.beforeCorpus}):</strong> {g.beforeEntryTitle}
																	</div>
																	<div>
																		<strong>After ({g.afterCorpus}):</strong> {g.afterEntryTitle}
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
																					<span className="opacity-70">{lead.corpus}</span>
																					{lead.geoLabel ? (
																						<span className="opacity-65">· {lead.geoLabel}</span>
																					) : null}
																				</div>
																				<div className="mt-0.5 font-semibold">{lead.title}</div>
																				<div className="mt-0.5 opacity-80">{lead.reason}</div>
																				{lead.snippet ? (
																					<div className="mt-0.5 opacity-75">{lead.snippet}</div>
																				) : null}
																			</div>
																		))}
																	</div>
																) : null}
															</details>
														))}
													</div>
												) : null}

												{/* Chronological Entries */}
												<div>
													<h3 className="m-0 mb-2 text-xs font-semibold uppercase opacity-75">
														Timeline Entries ({timeline.entries.length} of {timeline.totalEntries})
													</h3>
													{timeline.entries.length === 0 ? (
														<p className="text-xs opacity-70">
															No timeline entries yet. Add one below or link dated historic events to this
															profile.
														</p>
													) : (
														<div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
															{timeline.entries.map((entry) => (
																<div
																	key={entry.id}
																	className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 text-xs"
																>
																	<div className="flex flex-wrap items-center justify-between gap-2">
																		<div className="flex flex-wrap items-center gap-1.5">
																			<span className="font-mono font-semibold text-[#F97316]">
																				{entry.eventDate || 'Undated'}
																			</span>
																			<span
																				className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ANGLE_BADGE[entry.angle] || ANGLE_BADGE.general}`}
																			>
																				{entry.angle.replace(/_/g, ' ')}
																			</span>
																			{entry.sourceCorpus && !HIDDEN_SOURCE_TAGS.has(entry.sourceCorpus) ? (
																				<span className="rounded bg-[var(--app-surface-hover)] px-1.5 py-0.5 text-[10px]">
																					{entry.sourceCorpus}
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
															))}
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

														<p className="my-1.5 leading-relaxed opacity-85">{al.rationale}</p>

														{al.evidence.length > 0 ? (
															<div className="flex flex-wrap gap-1.5">
																{al.evidence.map((ev, idx) => (
																	<span
																		key={idx}
																		className="rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-0.5 text-[10px]"
																	>
																		<strong>{ev.corpus}</strong>: {ev.label}
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
