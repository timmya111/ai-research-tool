'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AlignmentEvidenceItem, AlignmentKind } from '@/lib/research/profiles/types';

const FINRA_VISUALIZER_DASHBOARD =
	'https://finra-sec-data-visualizer-canvas.vercel.app/dashboard';

function formatSourceCorpusLabel(corpus: string | null | undefined): string {
	const c = String(corpus || '').trim();
	if (!c) return 'source';
	// Local ingest tag — show as FINRA API (not a visual/canvas source).
	// Identity comes from the visualizer merged/firm|individual API + dashboard:
	// https://finra-sec-data-visualizer-canvas.vercel.app/dashboard?disable_analytics=1
	if (
		c === 'finra-visualizer' ||
		c === 'finra-api' ||
		c === 'finra-brokercheck' ||
		c === 'finra-rosters'
	) {
		return 'FINRA API';
	}
	if (c.startsWith('knowledge:')) return c.slice('knowledge:'.length) || c;
	return c;
}

/** Normalize corpus for match-weight chips (maps finra-* → FINRA API). Empty → "". */
function corpusMatchKey(corpus: string | null | undefined): string {
	const raw = String(corpus || '').trim();
	if (!raw) return '';
	return normKey(formatSourceCorpusLabel(raw));
}

function finraDashboardUrl(crd: string, kind: 'firm' | 'individual' = 'firm'): string {
	const id = String(crd || '').replace(/\D/g, '');
	if (!id) return `${FINRA_VISUALIZER_DASHBOARD}?disable_analytics=1`;
	return `${FINRA_VISUALIZER_DASHBOARD}/${kind}/${id}?disable_analytics=1`;
}

function scrubLabels(text: string | null | undefined): string {
	return String(text || '')
		.replace(/\bepstein\b/gi, 'source')
		.trim();
}

function knowledgeDocId(sourceRef: string | null | undefined): string | null {
	const m = String(sourceRef || '').match(/^knowledge:doc:([0-9a-f-]{36})$/i);
	return m ? m[1] : null;
}

function extractResearchDrivePath(text: string | null | undefined): string | null {
	const s = String(text || '');
	const m =
		s.match(/\*\*Source path:\*\*\s*`([^`]+)`/i) ||
		s.match(/Source path:\s*`([^`]+)`/i) ||
		s.match(/Source path:\s*([^\n]+)/i);
	if (!m) return null;
	const p = m[1].trim().replace(/^`|`$/g, '');
	if (!p || p.includes('..') || pathLooksAbsolute(p)) return null;
	return p;
}

function pathLooksAbsolute(p: string): boolean {
	return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

function evidenceKey(ev: AlignmentEvidenceItem, idx: number): string {
	return ev.sourceRef || ev.url || `${ev.corpus}:${ev.label}:${idx}`;
}

function mergeInsightForKind(
	kind: AlignmentKind | string | null | undefined,
	ev: AlignmentEvidenceItem,
	ctx: {
		leftName?: string | null;
		rightName?: string | null;
		hasRight: boolean;
	},
): { title: string; bullets: string[] } {
	const corpus = formatSourceCorpusLabel(ev.corpus);
	const left = scrubLabels(ctx.leftName) || 'left profile';
	const right = scrubLabels(ctx.rightName) || 'right profile';
	const k = String(kind || '');

	if (k === 'cross_source_mention') {
		return {
			title: 'Merge insight — cross-source presence',
			bullets: [
				`This card is one profile (${left}) seen in corpus “${corpus}”.`,
				'Cross-source mention is not a two-profile merge. Accept means the corpora describe the same entity on this card; Dismiss means a common-name collision across unrelated sources.',
				'Open the profile and check Sources & Identifiers, aliases, CRD/CIK, and employment before Accept.',
				`Chip label: ${scrubLabels(ev.label) || 'corpus presence'}.`,
			],
		};
	}
	if (k === 'same_entity_alias' || k === 'shared_identifier') {
		const label = scrubLabels(ev.label) || 'overlap signal';
		const isFinraCrd =
			k === 'shared_identifier' && /finra_crd/i.test(`${label} ${ev.corpus || ''}`);
		return {
			title:
				k === 'shared_identifier'
					? 'Merge insight — shared identifier'
					: 'Merge insight — alias / name overlap',
			bullets: [
				ctx.hasRight
					? `Candidate merge: ${left} ↔ ${right}.`
					: `Alias/id signal on ${left}.`,
				`Evidence corpus “${corpus}”: ${label}.`,
				isFinraCrd
					? 'Matching finra_crd is mergeable only when both sides are the same CRD kind: Firm CRD↔Firm CRD (keep firm: profile) or Individual CRD↔Individual CRD (people). Firm and individual CRDs share a numeric namespace — never merge person↔org on the same number. Confirm via visualizer dashboard/merged/firm vs merged/individual.'
					: 'Before Merge: compare CRD/CIK/tickers, birth/start dates, locations, and employment. Name-only alias hits are often false positives.',
				isFinraCrd
					? 'Same-kind matching Firm CRD → Merge into firm:. Same Individual CRD → Merge people. Otherwise Dismiss.'
					: 'Use Merge only when you are sure they are the same entity; otherwise Dismiss.',
			],
		};
	}
	if (k === 'shared_affiliation') {
		return {
			title: 'Merge insight — shared affiliation',
			bullets: [
				ctx.hasRight
					? `${left} and ${right} share an organization hub (corpus “${corpus}”).`
					: `Shared-affiliation signal in “${corpus}”.`,
				'Usually not a person↔person merge. Accept if the co-affiliation is real and useful; Dismiss alumni/faculty noise or unrelated coworkers.',
				`Chip: ${scrubLabels(ev.label) || 'shared hub'}.`,
			],
		};
	}
	if (k === 'building_colocation' || k === 'block_colocation' || k === 'city_colocation') {
		return {
			title: 'Merge insight — co-location',
			bullets: [
				ctx.hasRight
					? `${left} and ${right} share a ${k.replace(/_/g, ' ')} signal in “${corpus}”.`
					: `Co-location signal in “${corpus}”.`,
				'Co-location supports a link or closer look, not automatic merge. Confirm addresses and dates; large buildings and cities create many false positives.',
				ev.geoKey ? `Geo key: ${ev.geoKey}.` : `Chip: ${scrubLabels(ev.label) || 'location overlap'}.`,
			],
		};
	}
	if (k === 'possible_match_name_only') {
		return {
			title: 'Merge insight — name-only match (needs validation)',
			bullets: [
				ctx.hasRight
					? `Name-only candidate: ${left} ↔ ${right}. Not auto-merged.`
					: `Name-only signal on ${left}.`,
				`Corpus “${corpus}”: ${scrubLabels(ev.label) || 'name match'}.`,
				'Require a second identifier (CRD, employer, DOB, middle name) before Accept/Merge. Prefer Dismiss when names are common.',
			],
		};
	}
	if (k === 'knowledge_store_match' || k === 'county_filing_match') {
		return {
			title: 'Merge insight — document / filing match',
			bullets: [
				`Source corpus “${corpus}”: ${scrubLabels(ev.label) || 'document match'}.`,
				'Expand for OCR/snippet when available. Confirm the document refers to this profile before Accept.',
			],
		};
	}
	return {
		title: 'Merge insight',
		bullets: [
			`Corpus “${corpus}”: ${scrubLabels(ev.label) || 'evidence chip'}.`,
			ctx.hasRight
				? `Related profiles: ${left} ↔ ${right}. Use Accept/Dismiss (and Merge when shown) after checking identifiers and dates.`
				: `Profile: ${left}. Use Accept if this source corroborates the card; Dismiss false positives.`,
		],
	};
}

type LoadedDoc = {
	id: string;
	title: string;
	rawText: string;
	url: string | null;
	sourcePath: string | null;
};

type ProfilePeek = {
	id: string;
	name: string;
	slug: string;
	aliases: string[];
	identifiers: Array<{ scheme: string; value: string }>;
	locations: string[];
	corpora: string[];
};

type MatchSets = {
	idKeys: Set<string>;
	aliasKeys: Set<string>;
	locationKeys: Set<string>;
	corpusKeys: Set<string>;
	nameMatch: boolean;
	/** Weighted score for quick triage (identifiers count most). */
	score: number;
	breakdown: Array<{ label: string; count: number; weight: number; className: string }>;
};

function normKey(s: string): string {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function idKey(scheme: string, value: string): string {
	return `${normKey(scheme)}=${normKey(value)}`;
}

function locationOverlapKeys(a: string, b: string): boolean {
	const na = normKey(a);
	const nb = normKey(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.length >= 6 && nb.includes(na)) return true;
	if (nb.length >= 6 && na.includes(nb)) return true;
	const ta = new Set(na.split(' ').filter((t) => t.length > 2));
	const tb = nb.split(' ').filter((t) => t.length > 2);
	let shared = 0;
	for (const t of tb) if (ta.has(t)) shared += 1;
	return shared >= 2;
}

function computeMatchSets(left?: ProfilePeek | null, right?: ProfilePeek | null): MatchSets | null {
	if (!left || !right) return null;
	const idKeys = new Set<string>();
	const leftIds = new Map(left.identifiers.map((i) => [idKey(i.scheme, i.value), i]));
	for (const i of right.identifiers) {
		const k = idKey(i.scheme, i.value);
		if (leftIds.has(k)) idKeys.add(k);
	}

	const aliasKeys = new Set<string>();
	const leftAliases = new Set(left.aliases.map(normKey).filter(Boolean));
	const leftName = normKey(left.name);
	if (leftName) leftAliases.add(leftName);
	for (const a of right.aliases) {
		const k = normKey(a);
		if (k && leftAliases.has(k)) aliasKeys.add(k);
	}
	const rightName = normKey(right.name);
	if (rightName && leftAliases.has(rightName)) aliasKeys.add(rightName);
	const nameMatch = Boolean(leftName && rightName && leftName === rightName);

	const locationKeys = new Set<string>();
	for (const la of left.locations) {
		for (const lb of right.locations) {
			if (locationOverlapKeys(la, lb)) {
				locationKeys.add(normKey(la));
				locationKeys.add(normKey(lb));
			}
		}
	}

	const corpusKeys = new Set<string>();
	const leftCorp = new Set(left.corpora.map(corpusMatchKey).filter(Boolean));
	for (const c of right.corpora) {
		const k = corpusMatchKey(c);
		if (k && leftCorp.has(k)) corpusKeys.add(k);
	}

	const breakdown = [
		{
			label: 'IDs',
			count: idKeys.size,
			weight: idKeys.size * 3,
			className:
				'rounded border border-emerald-500/45 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-900 dark:text-emerald-100',
		},
		{
			label: 'Name',
			count: nameMatch ? 1 : 0,
			weight: nameMatch ? 3 : 0,
			className:
				'rounded border border-sky-500/45 bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-900 dark:text-sky-100',
		},
		{
			label: 'Aliases',
			count: aliasKeys.size,
			weight: aliasKeys.size * 2,
			className:
				'rounded border border-violet-500/45 bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-bold text-violet-900 dark:text-violet-100',
		},
		{
			label: 'Locations',
			count: Math.ceil(locationKeys.size / 2) || (locationKeys.size ? 1 : 0),
			weight: (Math.ceil(locationKeys.size / 2) || (locationKeys.size ? 1 : 0)) * 1,
			className:
				'rounded border border-amber-500/45 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-950 dark:text-amber-100',
		},
		{
			label: 'Corpora',
			count: corpusKeys.size,
			weight: corpusKeys.size * 1,
			className:
				'rounded border border-teal-500/45 bg-teal-500/20 px-1.5 py-0.5 text-[10px] font-bold text-teal-900 dark:text-teal-100',
		},
	];
	const score = breakdown.reduce((s, b) => s + b.weight, 0);
	return { idKeys, aliasKeys, locationKeys, corpusKeys, nameMatch, score, breakdown };
}

const CHIP_MATCH =
	'inline-flex max-w-full items-center rounded border border-emerald-500/50 bg-emerald-500/25 px-1 py-0.5 text-[10px] font-semibold text-emerald-950 dark:text-emerald-50';
const CHIP_DIM = 'inline-flex max-w-full items-center rounded px-1 py-0.5 text-[10px] opacity-70';
const CHIP_EVIDENCE_HIT =
	'inline-flex items-center rounded border border-[#F97316]/55 bg-[#F97316]/20 px-1 py-0.5 text-[10px] font-semibold text-[#9a3412] dark:text-orange-100';

type Props = {
	evidence: AlignmentEvidenceItem[];
	/** Max chips to show before "show all" */
	initialLimit?: number;
	compact?: boolean;
	/** Alignment context for merge-decision copy when chips lack OCR/snippets */
	alignmentKind?: AlignmentKind | string | null;
	rationale?: string | null;
	leftProfileId?: string | null;
	rightProfileId?: string | null;
	leftName?: string | null;
	rightName?: string | null;
	onOpenProfile?: (idOrSlug: string) => void;
};

export default function AlignmentEvidenceList({
	evidence,
	initialLimit = 8,
	compact = false,
	alignmentKind = null,
	rationale = null,
	leftProfileId = null,
	rightProfileId = null,
	leftName = null,
	rightName = null,
	onOpenProfile,
}: Props) {
	const items = useMemo(() => {
		const seen = new Set<string>();
		const out: AlignmentEvidenceItem[] = [];
		for (const ev of evidence || []) {
			const k = ev.sourceRef || `${ev.corpus}|${ev.label}|${ev.snippet || ''}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(ev);
		}
		return out;
	}, [evidence]);

	const [showAll, setShowAll] = useState(false);
	/** Multiple chips stay open together so left/right (or multi-corpus) evidence can be compared. */
	const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
	const [loadingKey, setLoadingKey] = useState<string | null>(null);
	const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
	const [docsByKey, setDocsByKey] = useState<Record<string, LoadedDoc>>({});
	const [peekById, setPeekById] = useState<Record<string, ProfilePeek>>({});
	const [peekLoading, setPeekLoading] = useState(false);

	const visible = showAll ? items : items.slice(0, initialLimit);
	const allVisibleKeys = useMemo(
		() => visible.map((ev, idx) => evidenceKey(ev, idx)),
		[visible],
	);

	const loadDoc = useCallback(async (key: string, docId: string) => {
		if (docsByKey[key]) return;
		setLoadingKey(key);
		setErrorByKey((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
		try {
			const res = await fetch(`/api/knowledge/${encodeURIComponent(docId)}`, { cache: 'no-store' });
			const data = await res.json();
			if (!res.ok || !data?.ok) throw new Error(data?.error || `load failed (${res.status})`);
			const rawText = String(data.document?.rawText || '');
			const sourcePath =
				extractResearchDrivePath(rawText) ||
				(typeof data.document?.metadata?.sourcePath === 'string'
					? String(data.document.metadata.sourcePath)
					: null);
			setDocsByKey((prev) => ({
				...prev,
				[key]: {
					id: docId,
					title: String(data.document?.title || docId),
					rawText,
					url: data.document?.url != null ? String(data.document.url) : null,
					sourcePath,
				},
			}));
		} catch (e: unknown) {
			setErrorByKey((prev) => ({
				...prev,
				[key]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setLoadingKey(null);
		}
	}, [docsByKey]);

	const loadProfilePeek = useCallback(
		async (id: string) => {
			if (!id || peekById[id]) return;
			setPeekLoading(true);
			try {
				const res = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { cache: 'no-store' });
				const data = await res.json();
				if (!res.ok || !data?.ok || !data.profile) return;
				const meta = (data.profile.metadata || {}) as Record<string, unknown>;
				const corpora = Array.isArray(meta.corpora) ? meta.corpora.map(String) : [];
				const aliases = Array.isArray(data.aliases)
					? data.aliases
							.map((a: { alias?: string }) => String(a.alias || '').trim())
							.filter(Boolean)
							.slice(0, 8)
					: [];
				const identifiers = Array.isArray(data.identifiers)
					? data.identifiers
							.map((i: { scheme?: string; value?: string }) => ({
								scheme: String(i.scheme || ''),
								value: String(i.value || ''),
							}))
							.filter((i: { scheme: string; value: string }) => i.scheme && i.value)
							.slice(0, 8)
					: [];
				const locations = Array.isArray(data.locations)
					? data.locations
							.map((l: { raw?: string }) => String(l.raw || '').trim())
							.filter(Boolean)
							.slice(0, 4)
					: [];
				setPeekById((prev) => ({
					...prev,
					[id]: {
						id: String(data.profile.id),
						name: String(data.profile.name || ''),
						slug: String(data.profile.slug || ''),
						aliases,
						identifiers,
						locations,
						corpora,
					},
				}));
			} catch {
				/* non-fatal */
			} finally {
				setPeekLoading(false);
			}
		},
		[peekById],
	);

	const ensurePeeksAndDocs = useCallback(
		(keys: string[]) => {
			if (leftProfileId) void loadProfilePeek(leftProfileId);
			if (rightProfileId) void loadProfilePeek(rightProfileId);
			for (const key of keys) {
				const idx = allVisibleKeys.indexOf(key);
				const ev = idx >= 0 ? visible[idx] : null;
				if (!ev) continue;
				const docId = knowledgeDocId(ev.sourceRef);
				if (docId) void loadDoc(key, docId);
			}
		},
		[
			allVisibleKeys,
			leftProfileId,
			loadDoc,
			loadProfilePeek,
			rightProfileId,
			visible,
		],
	);

	/** One click opens every visible chip for side-by-side compare; click again closes all. */
	const toggle = useCallback(
		(_ev: AlignmentEvidenceItem, _idx: number) => {
			const anyOpen = allVisibleKeys.some((k) => openKeys.has(k));
			if (anyOpen) {
				setOpenKeys(new Set());
				return;
			}
			const next = new Set(allVisibleKeys);
			setOpenKeys(next);
			ensurePeeksAndDocs([...next]);
		},
		[allVisibleKeys, ensurePeeksAndDocs, openKeys],
	);

	if (!items.length) return null;

	const leftPeek = leftProfileId ? peekById[leftProfileId] : undefined;
	const rightPeek = rightProfileId ? peekById[rightProfileId] : undefined;
	const matches = computeMatchSets(leftPeek, rightPeek);
	const evidenceCorpusKeys = new Set(
		items.map((ev) => corpusMatchKey(ev.corpus)).filter(Boolean),
	);
	const anyOpen = allVisibleKeys.some((k) => openKeys.has(k));

	const renderPeek = (
		peek: ProfilePeek | undefined,
		label: string,
		opts?: { evidenceCorpus?: string | null },
	) => {
		if (!peek) return null;
		const evidenceCorpusNorm = corpusMatchKey(opts?.evidenceCorpus || '');
		const nameIsMatch = Boolean(matches?.nameMatch && normKey(peek.name));
		return (
			<div
				className={`rounded border p-2 ${
					matches && matches.score > 0
						? 'border-emerald-500/35 bg-emerald-500/5'
						: 'border-[var(--app-border)] bg-[var(--app-bg)]'
				}`}
			>
				<div className="mb-1 flex flex-wrap items-center gap-2">
					<span className="text-[10px] font-semibold uppercase opacity-60">{label}</span>
					{onOpenProfile ? (
						<button
							type="button"
							onClick={() => onOpenProfile(peek.slug || peek.id)}
							className={`cursor-pointer border-0 bg-transparent p-0 text-[11px] font-semibold underline ${
								nameIsMatch ? 'rounded bg-sky-500/25 px-1 text-sky-950 dark:text-sky-100' : 'text-[#F97316]'
							}`}
							title={nameIsMatch ? 'Exact name match with peer' : undefined}
						>
							{peek.name || peek.slug}
						</button>
					) : (
						<strong
							className={`text-[11px] ${nameIsMatch ? 'rounded bg-sky-500/25 px-1' : ''}`}
						>
							{peek.name || peek.slug}
						</strong>
					)}
					{nameIsMatch ? (
						<span className="rounded border border-sky-500/45 bg-sky-500/20 px-1 text-[9px] font-bold uppercase text-sky-900 dark:text-sky-100">
							name match
						</span>
					) : null}
				</div>
				{peek.identifiers.length > 0 ? (
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
						<span className="opacity-60">IDs:</span>
						{(() => {
							const seen = new Set<string>();
							const unique: typeof peek.identifiers = [];
							for (const i of peek.identifiers) {
								const k = idKey(i.scheme, i.value);
								if (!k || seen.has(k)) continue;
								seen.add(k);
								unique.push(i);
							}
							return unique.map((i, idx) => {
								const k = idKey(i.scheme, i.value);
								const hit = matches?.idKeys.has(k);
								const isFinraCrd = i.scheme === 'finra_crd';
								const kind =
									peek.slug?.startsWith('person:') || peek.slug?.startsWith('individual:')
										? 'individual'
										: 'firm';
								const chipClass = hit ? CHIP_MATCH : CHIP_DIM;
								if (isFinraCrd) {
									return (
										<a
											key={`id-${k}-${idx}`}
											href={finraDashboardUrl(i.value, kind)}
											target="_blank"
											rel="noreferrer"
											className={`${chipClass} text-inherit no-underline hover:underline`}
											title={
												hit
													? 'Matching FINRA CRD — open visualizer API dashboard'
													: 'Open FINRA visualizer dashboard (API-backed)'
											}
										>
											{i.scheme}={i.value}
											{hit ? ' ✓' : ''} ↗
										</a>
									);
								}
								return (
									<span
										key={`id-${k}-${idx}`}
										className={chipClass}
										title={hit ? 'Matching identifier on both profiles (high weight)' : undefined}
									>
										{i.scheme}={i.value}
										{hit ? ' ✓' : ''}
									</span>
								);
							});
						})()}
					</div>
				) : (
					<div className="text-[10px] opacity-50">No public identifiers on file</div>
				)}
				{peek.aliases.length > 0 ? (
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
						<span className="opacity-60">Aliases:</span>
						{(() => {
							const seen = new Set<string>();
							const unique: Array<{ display: string; k: string }> = [];
							for (const a of peek.aliases) {
								const k = normKey(a);
								if (!k || seen.has(k)) continue;
								seen.add(k);
								unique.push({ display: a, k });
							}
							return unique.map(({ display, k }, idx) => {
								const hit = matches?.aliasKeys.has(k);
								return (
									<span
										key={`alias-${k}-${idx}`}
										className={hit ? CHIP_MATCH : CHIP_DIM}
										title={hit ? 'Matching alias on both profiles' : undefined}
									>
										{display}
										{hit ? ' ✓' : ''}
									</span>
								);
							});
						})()}
					</div>
				) : null}
				{peek.locations.length > 0 ? (
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
						<span className="opacity-60">Locations:</span>
						{(() => {
							const seen = new Set<string>();
							const unique: Array<{ display: string; k: string }> = [];
							for (const loc of peek.locations) {
								const k = normKey(loc);
								if (!k || seen.has(k)) continue;
								seen.add(k);
								unique.push({ display: loc, k });
							}
							return unique.map(({ display, k }, idx) => {
								const hit = matches?.locationKeys.has(k);
								return (
									<span
										key={`loc-${k}-${idx}`}
										className={hit ? CHIP_MATCH : CHIP_DIM}
										title={hit ? 'Overlapping location with peer' : undefined}
									>
										{display}
										{hit ? ' ✓' : ''}
									</span>
								);
							});
						})()}
					</div>
				) : null}
				{peek.corpora.length > 0 ? (
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
						<span className="opacity-60">Corpora:</span>
						{(() => {
							const seen = new Set<string>();
							const unique: string[] = [];
							for (const c of peek.corpora.slice(0, 12)) {
								const k = corpusMatchKey(c) || normKey(c);
								if (!k || seen.has(k)) continue;
								seen.add(k);
								unique.push(c);
							}
							return unique.map((c, idx) => {
								const label = formatSourceCorpusLabel(c);
								const k = corpusMatchKey(c);
								const peerHit = Boolean(k && matches?.corpusKeys.has(k));
								const evidenceHit = Boolean(
									k &&
										(evidenceCorpusNorm
											? k === evidenceCorpusNorm
											: evidenceCorpusKeys.has(k)),
								);
								const className = peerHit
									? CHIP_MATCH
									: evidenceHit
										? CHIP_EVIDENCE_HIT
										: CHIP_DIM;
								return (
									<span
										key={`corpus-${k || label}-${idx}`}
										className={className}
										title={
											peerHit
												? 'Shared corpus on both profiles (FINRA identity via API/dashboard)'
												: evidenceHit
													? 'Evidence corpus on this profile (cross-source presence)'
													: undefined
										}
									>
										{label}
										{peerHit ? ' ✓' : evidenceHit ? ' ★' : ''}
									</span>
								);
							});
						})()}
						{peek.corpora.length > 12 ? <span className="opacity-50">…</span> : null}
					</div>
				) : null}
			</div>
		);
	};

	const renderWeightBar = () => {
		if (!matches) {
			// Single-profile: show how many evidence corpora hit the profile peek
			const peek = leftPeek || rightPeek;
			if (!peek || !anyOpen) return null;
			const hitCorpora = peek.corpora.filter((c) =>
				evidenceCorpusKeys.has(corpusMatchKey(c)),
			);
			const idCount = peek.identifiers.length;
			return (
				<div className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5">
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
						Weighting assist (this profile)
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="rounded border border-teal-500/45 bg-teal-500/20 px-1.5 py-0.5 text-[10px] font-bold text-teal-900 dark:text-teal-100">
							Evidence corpora on profile {hitCorpora.length}/{items.length}
						</span>
						<span className="rounded border border-emerald-500/45 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-900 dark:text-emerald-100">
							IDs on file {idCount}
						</span>
						<span className="text-[10px] opacity-65">
							★ = chip corpus present on profile · higher ID count strengthens Accept
						</span>
					</div>
				</div>
			);
		}
		if (!anyOpen) return null;
		const tone =
			matches.score >= 6
				? 'border-emerald-500/50 bg-emerald-500/10'
				: matches.score >= 3
					? 'border-amber-500/45 bg-amber-500/10'
					: 'border-rose-500/40 bg-rose-500/10';
		return (
			<div className={`rounded border px-2 py-1.5 ${tone}`}>
				<div className="mb-1 flex flex-wrap items-center gap-2">
					<span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
						Match weight {matches.score}
					</span>
					<span className="text-[10px] opacity-65">
						Highlighted ✓ chips match on both sides · IDs×3 · name×3 · aliases×2 ·
						locations×1 · corpora×1
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					{matches.breakdown.map((b) => (
						<span
							key={b.label}
							className={b.count > 0 ? b.className : 'rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] opacity-45'}
						>
							{b.label} {b.count}
							{b.count > 0 ? ` (+${b.weight})` : ''}
						</span>
					))}
				</div>
			</div>
		);
	};

	return (
		<div className={compact ? 'mt-1.5 space-y-1.5' : 'mt-2 space-y-2'}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="text-[10px] font-semibold uppercase tracking-wide opacity-60">
					Source evidence — one click opens all for compare
				</div>
				{visible.length > 1 ? (
					<button
						type="button"
						onClick={() => {
							const anyOpen = allVisibleKeys.some((k) => openKeys.has(k));
							if (anyOpen) {
								setOpenKeys(new Set());
								return;
							}
							const next = new Set(allVisibleKeys);
							setOpenKeys(next);
							ensurePeeksAndDocs([...next]);
						}}
						className="cursor-pointer border-0 bg-transparent p-0 text-[10px] font-semibold text-[#F97316] underline"
					>
						{allVisibleKeys.some((k) => openKeys.has(k))
							? 'Close all'
							: `Open all ${visible.length}`}
					</button>
				) : null}
			</div>
			{anyOpen ? renderWeightBar() : null}
			{anyOpen ? (
				<div className="space-y-1.5">
					{peekLoading && !leftPeek ? (
						<p className="m-0 text-[10px] opacity-70">Loading profile identifiers…</p>
					) : null}
					<div className={`grid gap-2 ${rightProfileId ? 'sm:grid-cols-2' : ''}`}>
						{renderPeek(leftPeek, rightProfileId ? 'Left' : 'Profile')}
						{rightProfileId ? renderPeek(rightPeek, 'Right') : null}
					</div>
					<p className="m-0 text-[10px] opacity-60">
						✓ green = match on both profiles (raises weight) · ★ orange = this evidence
						corpus is on the profile
					</p>
				</div>
			) : null}
			<div className="flex flex-col gap-1.5">
				{visible.map((ev, idx) => {
					const key = evidenceKey(ev, idx);
					const open = openKeys.has(key);
					const doc = docsByKey[key];
					const docId = knowledgeDocId(ev.sourceRef);
					const snippet = scrubLabels(ev.snippet);
					const err = errorByKey[key];
					const imagePath = doc?.sourcePath || extractResearchDrivePath(snippet);
					const imageUrl = imagePath
						? `/api/research-drive/file?path=${encodeURIComponent(imagePath)}`
						: null;
					const hasRich = Boolean(snippet || docId || ev.url);
					const insight = mergeInsightForKind(alignmentKind, ev, {
						leftName,
						rightName,
						hasRight: Boolean(rightProfileId),
					});
					const corpusLabel = formatSourceCorpusLabel(ev.corpus);
					const corpusNorm = corpusMatchKey(ev.corpus);
					const corpusOnLeft = leftPeek?.corpora.some(
						(c) => corpusMatchKey(c) === corpusNorm,
					);
					const corpusOnRight = rightPeek?.corpora.some(
						(c) => corpusMatchKey(c) === corpusNorm,
					);
					const corpusPeerShared = matches?.corpusKeys.has(corpusNorm);
					const corpusHighlighted = Boolean(
						corpusPeerShared || corpusOnLeft || corpusOnRight,
					);

					return (
						<div
							key={key}
							className={`overflow-hidden rounded-md border bg-[var(--app-bg)] ${
								open && corpusHighlighted
									? 'border-[#F97316]/55'
									: 'border-[var(--app-border)]'
							}`}
						>
							<button
								type="button"
								onClick={() => toggle(ev, idx)}
								aria-expanded={open}
								className="flex w-full cursor-pointer items-start gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-[11px] hover:bg-[var(--app-surface)]"
							>
								<span className="mt-0.5 shrink-0 text-[10px] opacity-50">
									{open ? '▼' : '▶'}
								</span>
								<span className="min-w-0 flex-1">
									<strong
										className={
											corpusHighlighted
												? 'rounded bg-[#F97316]/20 px-1 text-[#9a3412] dark:text-orange-100'
												: 'text-[#F97316]'
										}
									>
										{corpusLabel}
									</strong>
									<span className="opacity-80">
										:{' '}
										{scrubLabels(ev.label)}
										{ev.date ? ` (${ev.date})` : ''}
										{corpusPeerShared || corpusOnLeft || corpusOnRight ? ' ' : ''}
									</span>
									{corpusPeerShared ? (
										<span className="ml-1.5 inline-block rounded border border-emerald-500/45 bg-emerald-500/20 px-1 py-0.5 text-[9px] font-bold text-emerald-900 dark:text-emerald-100">
											shared corpus ✓
										</span>
									) : corpusOnLeft || corpusOnRight ? (
										<span className="ml-1.5 inline-block rounded border border-[#F97316]/45 bg-[#F97316]/15 px-1 py-0.5 text-[9px] font-bold text-[#9a3412] dark:text-orange-100">
											on profile ★
										</span>
									) : null}
									{docId ? (
										<span className="ml-1.5 inline-block rounded bg-sky-500/10 px-1 py-0.5 text-[9px] text-sky-800 dark:text-sky-200">
											knowledge doc
										</span>
									) : null}
									{ev.url ? (
										<span className="ml-1.5 inline-block rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] text-emerald-800 dark:text-emerald-200">
											has URL
										</span>
									) : null}
									{!hasRich ? (
										<span className="ml-1.5 inline-block rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-900 dark:text-amber-200">
											merge insight
										</span>
									) : null}
									{!open && snippet ? (
										<span className="mt-0.5 block line-clamp-2 opacity-65">{snippet}</span>
									) : null}
								</span>
							</button>

							{open ? (
								<div className="space-y-2 border-t border-[var(--app-border)] bg-[var(--app-surface)] px-2.5 py-2 text-[11px]">
									<div>
										<div className="mb-0.5 text-[10px] font-semibold text-[#F97316]">
											{insight.title}
										</div>
										<ul className="m-0 list-disc space-y-0.5 pl-4 text-[10px] leading-relaxed opacity-90">
											{insight.bullets.map((b) => (
												<li key={b}>{b}</li>
											))}
										</ul>
										{rationale ? (
											<p className="mt-1.5 mb-0 text-[10px] leading-relaxed opacity-75">
												Alignment rationale: {scrubLabels(rationale)}
											</p>
										) : null}
									</div>

									{ev.url ? (
										<p className="m-0">
											<a
												href={ev.url}
												target="_blank"
												rel="noreferrer"
												className="text-[#F97316] underline"
											>
												Open linked URL
											</a>
										</p>
									) : null}

									{snippet && !doc ? (
										<div>
											<div className="mb-0.5 text-[10px] font-semibold opacity-60">
												Match snippet
											</div>
											<pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[10px] leading-relaxed opacity-90">
												{snippet}
											</pre>
										</div>
									) : null}

									{loadingKey === key ? (
										<p className="m-0 text-[10px] opacity-70">Loading full document…</p>
									) : null}
									{err ? (
										<p className="m-0 text-[10px] text-red-600 dark:text-red-400">{err}</p>
									) : null}

									{doc ? (
										<div className="space-y-2">
											<div className="flex flex-wrap items-center gap-2 text-[10px] opacity-70">
												<span>Full OCR / text: {doc.title}</span>
												{doc.sourcePath ? <span>· file `{doc.sourcePath}`</span> : null}
												{doc.url ? (
													<a
														href={doc.url}
														target="_blank"
														rel="noreferrer"
														className="text-[#F97316] underline"
													>
														source URL
													</a>
												) : null}
											</div>
											{imageUrl ? (
												<div>
													<div className="mb-1 text-[10px] font-semibold opacity-60">
														Original file preview
													</div>
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img
														src={imageUrl}
														alt={doc.sourcePath || doc.title}
														className="max-h-[420px] w-auto max-w-full rounded border border-[var(--app-border)] object-contain bg-black/5"
													/>
												</div>
											) : null}
											<pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[10px] leading-relaxed">
												{doc.rawText || '(empty document)'}
											</pre>
										</div>
									) : null}

									{ev.sourceRef && !docId ? (
										<p className="m-0 text-[10px] opacity-60">Ref: {ev.sourceRef}</p>
									) : null}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			{items.length > initialLimit ? (
				<button
					type="button"
					onClick={() => {
						setShowAll((v) => {
							const next = !v;
							// If panels are already open, keep compare mode across the full set.
							if (next && openKeys.size > 0) {
								const fullKeys = items.map((ev, idx) => evidenceKey(ev, idx));
								setOpenKeys(new Set(fullKeys));
								// Defer peeks/docs until visible updates; toggle path also loads them.
								queueMicrotask(() => ensurePeeksAndDocs(fullKeys));
							}
							return next;
						});
					}}
					className="cursor-pointer border-0 bg-transparent p-0 text-[10px] text-[#F97316] underline"
				>
					{showAll ? 'Show fewer sources' : `Show all ${items.length} sources`}
				</button>
			) : null}
		</div>
	);
}
