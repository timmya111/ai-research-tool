import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runAlignmentPass, type AlignmentPassReport } from '@/lib/research/profiles/align';
import { withProfilesTransaction } from '@/lib/research/profiles/db';
import {
	classifyOrgType,
	makeProfileSlug,
	normalizeGeoKey,
	normalizeIsoDate,
	parseAddressParts,
	stripLegalSuffixes,
} from '@/lib/research/profiles/normalize';
import { getDataRootDir } from '@/lib/research/profiles/paths';
import {
	addAlias,
	addIdentifier,
	addLocation,
	mergeProfiles,
	upsertProfile,
	upsertProfileLink,
	upsertSourceRecord,
	upsertTimelineEntry,
} from '@/lib/research/profiles/store';
import type { ProfileType, TimelineAngle } from '@/lib/research/profiles/types';

export type BackfillCorpusStats = {
	corpus: string;
	profiles: number;
	links: number;
	timelineEntries: number;
	skipped?: string;
};

export type BackfillReport = {
	corpora: BackfillCorpusStats[];
	alignment: AlignmentPassReport | null;
	durationMs: number;
};

function readJsonSafe<T>(filePath: string): T | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
	} catch {
		return null;
	}
}

function readJsonlSafe<T>(filePath: string): T[] {
	if (!fs.existsSync(filePath)) return [];
	const out: T[] = [];
	const lines = fs.readFileSync(filePath, 'utf8').split('\n');
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as T);
		} catch {
			/* skip malformed line */
		}
	}
	return out;
}

function mapDossierKind(kind: string, name: string): ProfileType {
	const k = String(kind || '').toLowerCase();
	if (k === 'person') return 'person';
	if (k === 'family_hub' || k === 'family') return 'nonprofit';
	if (k === 'place' || k === 'location' || k === 'event') return 'historic_event';
	if (k === 'org' || k === 'company' || k === 'firm') return classifyOrgType(name);
	return classifyOrgType(name, k);
}

/** 1. .data/entity-dossiers */
function backfillEntityDossiers(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const dir = path.join(dataRoot, 'entity-dossiers');
	const dossiersDir = path.join(dir, 'dossiers');
	if (!fs.existsSync(dossiersDir)) {
		return { corpus: 'entity-dossiers', profiles: 0, links: 0, timelineEntries: 0, skipped: 'not found' };
	}

	let profiles = 0;
	let links = 0;
	const slugToProfileId = new Map<string, string>();
	const files = fs.readdirSync(dossiersDir).filter((f) => f.endsWith('.json'));

	for (const file of files) {
		const d = readJsonSafe<Record<string, unknown>>(path.join(dossiersDir, file));
		if (!d || !d.displayName) continue;
		const oldSlug = String(d.slug || file.replace(/\.json$/, ''));
		const displayName = String(d.displayName).trim();
		const profileType = mapDossierKind(String(d.kind || ''), displayName);

		const srId = upsertSourceRecord(
			{
				corpus: 'entity-dossiers',
				sourceRef: `file:.data/entity-dossiers/dossiers/${file}`,
				title: displayName,
				excerpt: String(d.summary || '').slice(0, 600),
				metadata: { oldSlug, kind: d.kind },
			},
			tx,
		);

		const prof = upsertProfile(
			{
				profileType,
				name: displayName,
				status: d.status === 'pinned' ? 'pinned' : 'active',
				summary: String(d.summary || ''),
				metadata: {
					dossierSlug: oldSlug,
					dossierKind: d.kind,
					links: Array.isArray(d.links) ? d.links : [],
				},
				sourceCorpus: 'entity-dossiers',
			},
			tx,
		);
		profiles += 1;
		slugToProfileId.set(oldSlug, prof.id);

		addIdentifier(
			{ profileId: prof.id, scheme: 'dossier_slug', value: oldSlug, sourceCorpus: 'entity-dossiers' },
			tx,
		);

		if (Array.isArray(d.aliases)) {
			for (const al of d.aliases) {
				addAlias({ profileId: prof.id, alias: String(al), sourceCorpus: 'entity-dossiers' }, tx);
			}
		}

		if (Array.isArray(d.geos)) {
			for (const g of d.geos as Array<Record<string, unknown>>) {
				const raw = String(
					g.label || [g.city, g.county, g.state, g.country].filter(Boolean).join(', ') || '',
				).trim();
				if (!raw) continue;
				addLocation(
					{
						profileId: prof.id,
						raw,
						city: g.city ? String(g.city) : null,
						county: g.county ? String(g.county) : null,
						state: g.state ? String(g.state) : null,
						country: g.country ? String(g.country) : null,
						role: 'associated',
						sourceCorpus: 'entity-dossiers',
					},
					tx,
				);
			}
		}

		if (Array.isArray(d.businesses)) {
			for (const b of d.businesses as Array<Record<string, unknown>>) {
				const bizName = String(b.name || '').trim();
				if (!bizName) continue;
				const bizType = classifyOrgType(bizName);
				const bizProf = upsertProfile(
					{
						profileType: bizType,
						name: bizName,
						metadata: {
							ticker: b.ticker || undefined,
							cik: b.cik || undefined,
						},
						sourceCorpus: 'entity-dossiers',
					},
					tx,
				);
				profiles += 1;
				if (b.ticker) {
					addIdentifier(
						{ profileId: bizProf.id, scheme: 'ticker', value: String(b.ticker), sourceCorpus: 'entity-dossiers' },
						tx,
					);
					addAlias(
						{ profileId: bizProf.id, alias: String(b.ticker), aliasKind: 'ticker', sourceCorpus: 'entity-dossiers' },
						tx,
					);
				}
				if (b.cik) {
					addIdentifier(
						{ profileId: bizProf.id, scheme: 'sec_cik', value: String(b.cik), sourceCorpus: 'entity-dossiers' },
						tx,
					);
				}
				upsertProfileLink(
					{
						fromProfileId: prof.id,
						toProfileId: bizProf.id,
						relationType: profileType === 'person' ? 'employed_by' : 'business_tie',
						roleLabel: b.role ? String(b.role) : null,
						angle: 'corporate',
						sourceCorpus: 'entity-dossiers',
						sourceRecordId: srId,
						evidenceNote: b.role ? `Role: ${String(b.role)}` : 'Listed in entity dossier businesses',
					},
					tx,
				);
				links += 1;
			}
		}
	}

	// Edges
	const edges = readJsonlSafe<Record<string, unknown>>(path.join(dir, 'edges.jsonl'));
	for (const e of edges) {
		const fromId = slugToProfileId.get(String(e.from || ''));
		const toId = slugToProfileId.get(String(e.to || ''));
		if (!fromId || !toId || fromId === toId) continue;
		const kind = String(e.kind || '');
		const rel =
			kind === 'family_member'
				? 'family_or_associate'
				: kind === 'person_org'
					? 'affiliated_with'
					: 'business_tie';
		const evArr = Array.isArray(e.evidence) ? (e.evidence as Array<Record<string, unknown>>) : [];
		const note = evArr.map((x) => String(x.note || x.url || '')).filter(Boolean).join('; ');
		upsertProfileLink(
			{
				fromProfileId: fromId,
				toProfileId: toId,
				relationType: rel,
				angle: 'corporate',
				sourceCorpus: 'entity-dossiers',
				evidenceNote: note || `Entity dossier edge (${kind})`,
			},
			tx,
		);
		links += 1;
	}

	return { corpus: 'entity-dossiers', profiles, links, timelineEntries: 0 };
}

/** 2. .data/finra-rosters */
function backfillFinraRosters(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const dir = path.join(dataRoot, 'finra-rosters');
	if (!fs.existsSync(dir)) {
		return { corpus: 'finra-rosters', profiles: 0, links: 0, timelineEntries: 0, skipped: 'not found' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
	const subject = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'FINRA & SEC Registered Firms & Brokers',
			status: 'pinned',
			summary: 'Broker-dealer firm rosters, individual CRD registrations, and employment/branch histories.',
			sourceCorpus: 'finra-rosters',
		},
		tx,
	);
	profiles += 1;

	for (const file of files) {
		const roster = readJsonSafe<Record<string, unknown>>(path.join(dir, file));
		if (!roster || !roster.firmName) continue;

		const firmId = String(roster.firmId || '').trim();
		const firmName = String(roster.firmName).trim();
		const genDate = normalizeIsoDate(String(roster.generatedAt || '')).date;

		const srId = upsertSourceRecord(
			{
				corpus: 'finra-rosters',
				sourceRef: `file:.data/finra-rosters/${file}`,
				sourceUrl: roster.source ? String(roster.source) : null,
				title: `${firmName} (CRD# ${firmId}) Roster`,
				publishedDate: genDate,
				excerpt: `Total=${roster.total ?? ''}, Current=${roster.currentCount ?? ''}, Previous=${roster.previousCount ?? ''}`,
			},
			tx,
		);

		const firm = upsertProfile(
			{
				profileType: 'firm',
				name: firmName,
				status: 'pinned',
				summary: `FINRA/SEC registered firm (CRD# ${firmId}). Total connected individuals: ${roster.total ?? '?'} (current: ${roster.currentCount ?? '?'}, previous: ${roster.previousCount ?? '?'}).`,
				metadata: {
					finraCrd: firmId,
					currentCount: roster.currentCount,
					previousCount: roster.previousCount,
					totalConnected: roster.total,
				},
				sourceCorpus: 'finra-rosters',
			},
			tx,
		);
		profiles += 1;

		if (firmId) {
			addIdentifier({ profileId: firm.id, scheme: 'finra_crd', value: firmId, sourceCorpus: 'finra-rosters' }, tx);
			addAlias({ profileId: firm.id, alias: `CRD ${firmId}`, aliasKind: 'crd', sourceCorpus: 'finra-rosters' }, tx);
		}

		upsertProfileLink(
			{
				fromProfileId: firm.id,
				toProfileId: subject.id,
				relationType: 'part_of_subject',
				angle: 'regulatory_finra',
				sourceCorpus: 'finra-rosters',
				sourceRecordId: srId,
				evidenceNote: `FINRA firm roster snapshot (${roster.total ?? 0} individuals)`,
			},
			tx,
		);
		links += 1;

		if (genDate) {
			upsertTimelineEntry(
				{
					profileId: firm.id,
					eventDate: genDate,
					title: `FINRA roster snapshot: ${firmName} (${roster.currentCount ?? 0} current, ${roster.previousCount ?? 0} previous)`,
					summary: `Captured ${roster.total ?? 0} registered broker/adviser connections for CRD# ${firmId}.`,
					angle: 'regulatory_finra',
					entryKind: 'filing',
					sourceCorpus: 'finra-rosters',
					sourceRecordId: srId,
					dedupeHint: `finra-roster:${firmId}:${genDate}`,
				},
				tx,
			);
			timelineEntries += 1;
		}

		const people = Array.isArray(roster.people) ? (roster.people as Array<Record<string, unknown>>) : [];
		for (const p of people) {
			const name = String(p.name || '').trim();
			const crd = String(p.crd || '').trim();
			if (!name) continue;

			const person = upsertProfile(
				{
					profileType: 'person',
					name,
					status: 'active',
					summary: `FINRA/SEC registered individual${crd ? ` (CRD# ${crd})` : ''}; ${String(p.relationship || 'connected')} at ${firmName}.`,
					metadata: {
						finraCrd: crd || undefined,
						bcScope: p.bcScope || undefined,
						iaScope: p.iaScope || undefined,
					},
					sourceCorpus: 'finra-rosters',
				},
				tx,
			);
			profiles += 1;

			if (crd) {
				addIdentifier({ profileId: person.id, scheme: 'finra_crd', value: crd, sourceCorpus: 'finra-rosters' }, tx);
				addAlias({ profileId: person.id, alias: crd, aliasKind: 'crd', sourceCorpus: 'finra-rosters' }, tx);
			}

			if (p.address) {
				const addr = String(p.address).trim();
				const parts = parseAddressParts(addr);
				addLocation(
					{
						profileId: person.id,
						raw: addr,
						city: parts.city,
						county: parts.county,
						state: parts.state,
						country: parts.country,
						role: 'branch',
						sourceCorpus: 'finra-rosters',
					},
					tx,
				);
			}

			upsertProfileLink(
				{
					fromProfileId: person.id,
					toProfileId: firm.id,
					relationType: 'registered_at',
					roleLabel: String(p.relationship || (p.isCurrent ? 'Current registration' : 'Previous registration')),
					angle: 'regulatory_finra',
					sourceCorpus: 'finra-rosters',
					sourceRecordId: srId,
					evidenceNote: `bcScope=${String(p.bcScope || '')}, iaScope=${String(p.iaScope || '')}${p.address ? `, branch=${String(p.address)}` : ''}`,
				},
				tx,
			);
			links += 1;
		}
	}

	return { corpus: 'finra-rosters', profiles, links, timelineEntries };
}

const AGENCY_NAMES: Record<string, string> = {
	ICE: 'U.S. Immigration and Customs Enforcement (ICE)',
	DHS: 'U.S. Department of Homeland Security (DHS)',
	DEA: 'Drug Enforcement Administration (DEA)',
	CBP: 'U.S. Customs and Border Protection (CBP)',
	FBI: 'Federal Bureau of Investigation (FBI)',
	ATF: 'Bureau of Alcohol, Tobacco, Firearms and Explosives (ATF)',
	USSS: 'United States Secret Service (USSS)',
	DOJ: 'U.S. Department of Justice (DOJ)',
	DOD: 'U.S. Department of Defense (DoD)',
	NGB: 'National Guard Bureau (NGB)',
	WH: 'The White House',
};

/** 3. .data/authority-timelines */
function backfillAuthorityTimelines(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const file = path.join(dataRoot, 'authority-timelines', 'events', 'events.jsonl');
	const events = readJsonlSafe<Record<string, unknown>>(file);
	if (!events.length) {
		return { corpus: 'authority-timelines', profiles: 0, links: 0, timelineEntries: 0, skipped: 'no events' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const subject = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'Authority Initiatives & OK–TX Corridor Operations',
			status: 'pinned',
			summary:
				'Federal agency press releases, signed executive directives, joint operations, and promo campaigns (ICE, DHS, DEA, White House) with geographic tagging across the OK–TX corridor.',
			sourceCorpus: 'authority-timelines',
		},
		tx,
	);
	profiles += 1;

	const agencyCache = new Map<string, string>();
	const getOrCreateAgency = (code: string): string => {
		const key = code.toUpperCase().trim();
		if (agencyCache.has(key)) return agencyCache.get(key)!;
		const fullName = AGENCY_NAMES[key] || key;
		const p = upsertProfile(
			{
				profileType: key === 'OTHER' ? 'foreign' : 'government',
				name: fullName,
				status: 'active',
				sourceCorpus: 'authority-timelines',
			},
			tx,
		);
		addAlias({ profileId: p.id, alias: key, aliasKind: 'acronym', sourceCorpus: 'authority-timelines' }, tx);
		agencyCache.set(key, p.id);
		profiles += 1;
		return p.id;
	};

	for (const ev of events) {
		const evId = String(ev.id || '');
		const title = String(ev.title || '').trim();
		if (!evId || !title) continue;
		const evDate = normalizeIsoDate(String(ev.date || '')).date;
		const summary = String(ev.summary || '').trim();
		const matType = String(ev.materialType || 'other');
		const angle: TimelineAngle = matType === 'signed_directive' ? 'policy' : 'law_enforcement';

		const srId = upsertSourceRecord(
			{
				corpus: 'authority-timelines',
				sourceRef: `file:.data/authority-timelines/events/events.jsonl#${evId}`,
				sourceUrl: ev.url ? String(ev.url) : null,
				title,
				publishedDate: evDate,
				excerpt: summary.slice(0, 600),
				metadata: { agency: ev.agency, materialType: matType, audience: ev.audience },
			},
			tx,
		);

		const geos = Array.isArray(ev.geos) ? (ev.geos as Array<Record<string, unknown>>) : [];
		const firstGeo = geos[0];
		const firstGeoKey = firstGeo
			? normalizeGeoKey({
					raw: String(firstGeo.raw || ''),
					city: firstGeo.city ? String(firstGeo.city) : null,
					county: firstGeo.county ? String(firstGeo.county) : null,
					state: firstGeo.state ? String(firstGeo.state) : null,
					country: firstGeo.country ? String(firstGeo.country) : null,
				})
			: null;
		const firstGeoLabel = firstGeo
			? String(firstGeo.raw || [firstGeo.city, firstGeo.county, firstGeo.state].filter(Boolean).join(', '))
			: null;

		// Attach directly to the Subject Matter timeline
		upsertTimelineEntry(
			{
				profileId: subject.id,
				eventDate: evDate,
				title: `[${String(ev.agency || 'AUTH')}] ${title}`,
				summary: summary || `${matType} (${String(ev.audience || 'unknown')})`,
				angle,
				entryKind: matType === 'signed_directive' ? 'directive' : 'event',
				geoKey: firstGeoKey,
				geoLabel: firstGeoLabel,
				sourceCorpus: 'authority-timelines',
				sourceRecordId: srId,
				dedupeHint: `auth:${evId}`,
			},
			tx,
		);
		timelineEntries += 1;

		// Create a historic_event profile for signed directives or corridor-tagged operations
		const isCorridor = geos.some((g) => Boolean(g.corridor));
		let eventProfId: string | null = null;
		if (matType === 'signed_directive' || matType === 'joint_operation' || isCorridor) {
			const ep = upsertProfile(
				{
					profileType: 'historic_event',
					name: title.slice(0, 160),
					slug: `auth-${evId}`,
					startDate: evDate,
					summary,
					metadata: { agency: ev.agency, materialType: matType, audience: ev.audience, isCorridor },
					sourceCorpus: 'authority-timelines',
				},
				tx,
			);
			eventProfId = ep.id;
			profiles += 1;

			upsertProfileLink(
				{
					fromProfileId: ep.id,
					toProfileId: subject.id,
					relationType: 'part_of_subject',
					angle,
					sourceCorpus: 'authority-timelines',
					sourceRecordId: srId,
					evidenceNote: `${String(ev.agency || '')} ${matType}`,
				},
				tx,
			);
			links += 1;

			for (const g of geos) {
				addLocation(
					{
						profileId: ep.id,
						raw: String(g.raw || ''),
						city: g.city ? String(g.city) : null,
						county: g.county ? String(g.county) : null,
						state: g.state ? String(g.state) : null,
						country: g.country ? String(g.country) : null,
						role: g.corridor ? 'corridor' : 'event_site',
						sourceCorpus: 'authority-timelines',
					},
					tx,
				);
			}
		}

		// Link agency(ies)
		const agencyCodes = new Set<string>();
		if (ev.agency) agencyCodes.add(String(ev.agency));
		if (Array.isArray(ev.agencies)) {
			for (const a of ev.agencies) agencyCodes.add(String(a));
		}
		for (const code of agencyCodes) {
			const agId = getOrCreateAgency(code);
			upsertProfileLink(
				{
					fromProfileId: agId,
					toProfileId: eventProfId || subject.id,
					relationType: 'participated_in',
					roleLabel: matType,
					startDate: evDate,
					angle,
					sourceCorpus: 'authority-timelines',
					sourceRecordId: srId,
					evidenceNote: title.slice(0, 180),
				},
				tx,
			);
			links += 1;

			// Also record on the agency's own timeline
			upsertTimelineEntry(
				{
					profileId: agId,
					eventDate: evDate,
					title,
					summary: summary || `${matType} (${String(ev.audience || 'unknown')})`,
					angle,
					entryKind: matType === 'signed_directive' ? 'directive' : 'event',
					geoKey: firstGeoKey,
					geoLabel: firstGeoLabel,
					sourceCorpus: 'authority-timelines',
					sourceRecordId: srId,
					dedupeHint: `auth-ag:${code}:${evId}`,
				},
				tx,
			);
			timelineEntries += 1;
		}
	}

	return { corpus: 'authority-timelines', profiles, links, timelineEntries };
}

/** 4 & 5. .data/cdc-covid-timeline & .data/dod-covid-timeline (converging onto ONE shared subject_matter!) */
function backfillCovidTimeline(
	dataRoot: string,
	corpusDirName: 'cdc-covid-timeline' | 'dod-covid-timeline',
	angle: TimelineAngle,
	tx: DatabaseSync,
): BackfillCorpusStats {
	const dir = path.join(dataRoot, corpusDirName);
	const eventsFile = path.join(dir, 'events', 'events.jsonl');
	const entitiesFile = path.join(dir, 'entities', 'entities.json');
	const events = readJsonlSafe<Record<string, unknown>>(eventsFile);
	if (!events.length) {
		return { corpus: corpusDirName, profiles: 0, links: 0, timelineEntries: 0, skipped: 'no events' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	// Shared canonical subject_matter so CDC (civilian_health) and DoD (defense_dod) automatically converge!
	const covidSubject = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'COVID-19 Pandemic Response & Timelines',
			slug: 'covid-19-pandemic-response',
			status: 'pinned',
			startDate: '2019-12-12',
			summary:
				'Multi-angle historical chronology of the COVID-19 pandemic combining civilian public-health records (CDC Museum timeline) and defense/military response records (DoD / War.gov timeline) to compare perspectives and identify timeline gaps.',
			sourceCorpus: corpusDirName,
		},
		tx,
	);
	profiles += 1;

	const eventById = new Map<string, { date: string | null; title: string; summary: string; srId: string }>();

	for (const ev of events) {
		const evId = String(ev.id || '');
		const text = String(ev.text || '').trim();
		if (!evId || !text) continue;
		const evDate = normalizeIsoDate(String(ev.date || '')).date;
		const title = text.split(/(?<=[.!?])\s+/)[0].slice(0, 180) || text.slice(0, 180);
		const url =
			(Array.isArray(ev.source_urls) && ev.source_urls[0] ? String(ev.source_urls[0]) : null) ||
			(ev.url ? String(ev.url) : null);

		const srId = upsertSourceRecord(
			{
				corpus: corpusDirName,
				sourceRef: `file:.data/${corpusDirName}/events/events.jsonl#${evId}`,
				sourceUrl: url,
				title,
				publishedDate: evDate,
				excerpt: text.slice(0, 700),
				metadata: { section: ev.section, category: ev.category, dateLabel: ev.date_label },
			},
			tx,
		);

		eventById.set(evId, { date: evDate, title, summary: text, srId });

		upsertTimelineEntry(
			{
				profileId: covidSubject.id,
				eventDate: evDate,
				title,
				summary: text,
				angle,
				entryKind: 'milestone',
				sourceCorpus: corpusDirName,
				sourceRecordId: srId,
				metadata: { eventId: evId, category: ev.category || ev.section || null },
				dedupeHint: `${corpusDirName}:${evId}`,
			},
			tx,
		);
		timelineEntries += 1;
	}

	// Entities extracted from CDC/DoD timelines (people, pharma companies, universities, nonprofits, agencies)
	const entities = readJsonSafe<Array<Record<string, unknown>>>(entitiesFile) || [];
	for (const ent of entities) {
		const rawType = String(ent.type || '').toLowerCase();
		const name = String(ent.name || '').trim();
		if (!name || name.length < 2) continue;

		let profileType: ProfileType | null = null;
		if (rawType === 'person') {
			// Skip composite "... Administration" buckets and route government office titles to government
			if (/\badministration\b/i.test(name)) continue;
			if (/^(?:potus|vpotus|flotus|scotus)$/i.test(name) || /\b(?:under secretary|deputy secretary|assistant secretary|secretary of|surgeon general|attorney general|inspector general|joint chiefs)\b/i.test(name)) {
				profileType = 'government';
			} else {
				profileType = 'person';
			}
		} else if (rawType === 'company') profileType = classifyOrgType(name, 'firm');
		else if (rawType === 'org') profileType = classifyOrgType(name);
		else if (rawType === 'disease' || rawType === 'vaccine' || rawType === 'treatment' || rawType === 'variant') {
			// Skip granular biomedical sub-tags as separate profiles unless major; keep actors & subjects clean
			continue;
		} else {
			continue;
		}

		const prof = upsertProfile(
			{
				profileType,
				name,
				status: 'active',
				sourceCorpus: corpusDirName,
			},
			tx,
		);
		profiles += 1;

		const evIds = Array.isArray(ent.event_ids) ? ent.event_ids.map(String) : [];
		upsertProfileLink(
			{
				fromProfileId: prof.id,
				toProfileId: covidSubject.id,
				relationType: 'mentioned_in',
				roleLabel: `${evIds.length} ${corpusDirName === 'cdc-covid-timeline' ? 'CDC' : 'DoD'} event(s)`,
				angle,
				sourceCorpus: corpusDirName,
				evidenceNote: `Referenced in ${evIds.length} dated events in ${corpusDirName}`,
			},
			tx,
		);
		links += 1;

		// Attach up to 15 dated mentions onto the actor's own timeline
		for (const evId of evIds.slice(0, 15)) {
			const ev = eventById.get(evId);
			if (!ev) continue;
			upsertTimelineEntry(
				{
					profileId: prof.id,
					eventDate: ev.date,
					title: ev.title,
					summary: ev.summary,
					angle,
					entryKind: 'event',
					sourceCorpus: corpusDirName,
					sourceRecordId: ev.srId,
					dedupeHint: `${corpusDirName}:${prof.slug}:${evId}`,
				},
				tx,
			);
			timelineEntries += 1;
		}
	}

	return { corpus: corpusDirName, profiles, links, timelineEntries };
}

/** 6 & 7. Conference speaker corpora (physics-congress & pqw-itmo) */
function backfillSpeakerConference(
	dataRoot: string,
	corpusName: 'physics-congress' | 'pqw-itmo',
	subjectTitle: string,
	eventDate: string,
	eventLocation: { raw: string; city: string; country: string },
	tx: DatabaseSync,
): BackfillCorpusStats {
	const file = path.join(dataRoot, corpusName, 'speakers.json');
	const data = readJsonSafe<Record<string, unknown>>(file);
	const speakers = Array.isArray(data?.speakers)
		? (data.speakers as Array<Record<string, unknown>>)
		: [];
	if (!speakers.length) {
		return { corpus: corpusName, profiles: 0, links: 0, timelineEntries: 0, skipped: 'no speakers' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const subject = upsertProfile(
		{
			profileType: 'historic_event',
			name: subjectTitle,
			status: 'active',
			startDate: eventDate,
			summary: `Academic & scientific conference speakers, university/institute affiliations, and proceedings from ${corpusName}.`,
			sourceCorpus: corpusName,
		},
		tx,
	);
	profiles += 1;

	const geoKey = addLocation(
		{
			profileId: subject.id,
			raw: eventLocation.raw,
			city: eventLocation.city,
			country: eventLocation.country,
			role: 'event_site',
			sourceCorpus: corpusName,
		},
		tx,
	);

	for (const sp of speakers) {
		const name = String(sp.name || '').trim();
		if (!name) continue;
		const affRaw = String(sp.affiliation || '').trim();
		const country = sp.country ? String(sp.country).trim() : null;
		const bio = sp.bio ? String(sp.bio).trim() : '';
		const role = sp.role ? String(sp.role).trim() : 'speaker';

		const srId = upsertSourceRecord(
			{
				corpus: corpusName,
				sourceRef: `file:.data/${corpusName}/speakers.json#${name}`,
				sourceUrl: data?.source ? String(data.source) : null,
				title: `${name} — ${subjectTitle}`,
				publishedDate: eventDate,
				excerpt: bio || affRaw,
			},
			tx,
		);

		const person = upsertProfile(
			{
				profileType: 'person',
				name,
				summary: bio || (affRaw ? `Speaker affiliated with ${affRaw}.` : ''),
				metadata: { role, country: country || undefined },
				sourceCorpus: corpusName,
			},
			tx,
		);
		profiles += 1;

		if (country) {
			addLocation(
				{ profileId: person.id, raw: country, country, role: 'associated', sourceCorpus: corpusName },
				tx,
			);
		}

		upsertProfileLink(
			{
				fromProfileId: person.id,
				toProfileId: subject.id,
				relationType: 'authored_or_spoke',
				roleLabel: role,
				startDate: eventDate,
				angle: 'academic_research',
				sourceCorpus: corpusName,
				sourceRecordId: srId,
				evidenceNote: affRaw ? `Affiliation: ${affRaw}` : subjectTitle,
			},
			tx,
		);
		links += 1;

		upsertTimelineEntry(
			{
				profileId: person.id,
				eventDate,
				title: `Speaker at ${subjectTitle}${affRaw ? ` (${affRaw})` : ''}`,
				summary: bio || `${role} at ${subjectTitle}`,
				angle: 'academic_research',
				entryKind: 'speech',
				geoKey,
				geoLabel: eventLocation.raw,
				sourceCorpus: corpusName,
				sourceRecordId: srId,
				dedupeHint: `${corpusName}:sp:${name}`,
			},
			tx,
		);
		timelineEntries += 1;

		// Split multi-affiliations separated by "/" or ";"
		if (affRaw) {
			const affParts = affRaw
				.split(/[;/]+/)
				.map((s) => s.trim())
				.filter((s) => s.length >= 3);
			for (const orgName of affParts) {
				const orgType = classifyOrgType(orgName);
				const org = upsertProfile(
					{
						profileType: orgType,
						name: orgName,
						sourceCorpus: corpusName,
					},
					tx,
				);
				profiles += 1;

				if (country) {
					addLocation(
						{ profileId: org.id, raw: country, country, role: 'associated', sourceCorpus: corpusName },
						tx,
					);
				}

				upsertProfileLink(
					{
						fromProfileId: person.id,
						toProfileId: org.id,
						relationType: orgType === 'education' ? 'alumni_or_faculty' : 'affiliated_with',
						roleLabel: role,
						angle: 'academic_research',
						sourceCorpus: corpusName,
						sourceRecordId: srId,
						evidenceNote: `Listed speaker affiliation in ${corpusName}`,
					},
					tx,
				);
				links += 1;
			}
		}
	}

	return { corpus: corpusName, profiles, links, timelineEntries };
}

/** 8. .data/wef-amnc (World Economic Forum Annual Meeting of the New Champions 2014-2017) */
function backfillWefAmnc(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const file = path.join(dataRoot, 'wef-amnc', 'extracted', 'all_participants.json');
	const rows = readJsonSafe<Array<Record<string, unknown>>>(file);
	if (!rows?.length) {
		return { corpus: 'wef-amnc', profiles: 0, links: 0, timelineEntries: 0, skipped: 'not found' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const wefNonprofit = upsertProfile(
		{
			profileType: 'nonprofit',
			name: 'World Economic Forum (WEF)',
			status: 'pinned',
			summary: 'International non-governmental organization hosting Davos and the Annual Meeting of the New Champions (AMNC).',
			sourceCorpus: 'wef-amnc',
		},
		tx,
	);
	addAlias({ profileId: wefNonprofit.id, alias: 'WEF', aliasKind: 'acronym', sourceCorpus: 'wef-amnc' }, tx);
	profiles += 1;

	const wefSubject = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'WEF Annual Meeting of the New Champions (AMNC)',
			status: 'pinned',
			startDate: '2014',
			endDate: '2017',
			summary:
				'Participant rosters across WEF AMNC editions (2014–2017) spanning corporate executives, universities, foundations, and government agencies.',
			sourceCorpus: 'wef-amnc',
		},
		tx,
	);
	profiles += 1;

	upsertProfileLink(
		{
			fromProfileId: wefNonprofit.id,
			toProfileId: wefSubject.id,
			relationType: 'participated_in',
			roleLabel: 'Organizer',
			angle: 'policy',
			sourceCorpus: 'wef-amnc',
			evidenceNote: 'Host organization for AMNC',
		},
		tx,
	);
	links += 1;

	// Create one historic_event per edition year
	const editionMap = new Map<string, string>();
	const orgCache = new Map<string, { id: string; type: ProfileType }>();

	for (const r of rows) {
		const year = String(r.year || '').trim();
		const edition = String(r.edition || `AMNC${year.slice(-2)}`).trim();
		const name = String(r.name || '').trim();
		const orgName = String(r.organization || '').trim();
		const title = String(r.title || '').trim();
		const country = String(r.country || '').trim();
		if (!name || !year) continue;

		let editionId = editionMap.get(edition);
		if (!editionId) {
			const evProf = upsertProfile(
				{
					profileType: 'historic_event',
					name: `WEF ${edition} (${year})`,
					slug: `wef-${edition.toLowerCase()}`,
					startDate: year,
					summary: `World Economic Forum Annual Meeting of the New Champions — ${edition} (${year}).`,
					sourceCorpus: 'wef-amnc',
				},
				tx,
			);
			editionId = evProf.id;
			editionMap.set(edition, editionId);
			profiles += 1;

			upsertProfileLink(
				{
					fromProfileId: editionId,
					toProfileId: wefSubject.id,
					relationType: 'part_of_subject',
					startDate: year,
					angle: 'policy',
					sourceCorpus: 'wef-amnc',
					evidenceNote: String(r.source_pdf || edition),
				},
				tx,
			);
			links += 1;

			upsertTimelineEntry(
				{
					profileId: wefSubject.id,
					eventDate: year,
					datePrecision: 'year',
					title: `WEF ${edition} Annual Meeting of the New Champions`,
					summary: `Source PDF: ${String(r.source_pdf || '')}`,
					angle: 'policy',
					entryKind: 'event',
					sourceCorpus: 'wef-amnc',
					dedupeHint: `wef-edition:${edition}`,
				},
				tx,
			);
			timelineEntries += 1;
		}

		const person = upsertProfile(
			{
				profileType: 'person',
				name,
				summary: [title, orgName, country].filter(Boolean).join(' — '),
				sourceCorpus: 'wef-amnc',
			},
			tx,
		);
		profiles += 1;

		if (country) {
			addLocation(
				{ profileId: person.id, raw: country, country, role: 'associated', sourceCorpus: 'wef-amnc' },
				tx,
			);
		}

		upsertProfileLink(
			{
				fromProfileId: person.id,
				toProfileId: editionId,
				relationType: 'participated_in',
				roleLabel: title || 'Participant',
				startDate: year,
				angle: 'policy',
				sourceCorpus: 'wef-amnc',
				evidenceNote: `${edition} (${String(r.source_pdf || '')})`,
			},
			tx,
		);
		links += 1;

		if (orgName && orgName.length >= 2) {
			const cacheKey = orgName.toLowerCase();
			let orgEntry = orgCache.get(cacheKey);
			if (!orgEntry) {
				const orgType = classifyOrgType(orgName);
				const orgProf = upsertProfile(
					{
						profileType: orgType,
						name: orgName,
						sourceCorpus: 'wef-amnc',
					},
					tx,
				);
				if (country) {
					addLocation(
						{ profileId: orgProf.id, raw: country, country, role: 'associated', sourceCorpus: 'wef-amnc' },
						tx,
					);
				}
				orgEntry = { id: orgProf.id, type: orgType };
				orgCache.set(cacheKey, orgEntry);
				profiles += 1;
			}

			upsertProfileLink(
				{
					fromProfileId: person.id,
					toProfileId: orgEntry.id,
					relationType: orgEntry.type === 'education' ? 'alumni_or_faculty' : 'employed_by',
					roleLabel: title || null,
					startDate: year,
					angle: 'corporate',
					sourceCorpus: 'wef-amnc',
					evidenceNote: `Listed in WEF ${edition}`,
				},
				tx,
			);
			links += 1;
		}
	}

	return { corpus: 'wef-amnc', profiles, links, timelineEntries };
}

/** 9. META25, Digital Earth ISDE, TWDB Trinity Aquifer */
function backfillDomainCorpora(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	// META 2025
	const metaCat = readJsonSafe<Record<string, unknown>>(path.join(dataRoot, 'meta25', 'catalog.json'));
	if (metaCat) {
		const metaSub = upsertProfile(
			{
				profileType: 'historic_event',
				name: 'META 2025 — Metamaterials, Photonic Crystals & Plasmonics',
				startDate: '2025',
				summary: '15th International Conference on Metamaterials, Photonic Crystals and Plasmonics (Malaga, Spain).',
				sourceCorpus: 'meta25',
			},
			tx,
		);
		addLocation(
			{ profileId: metaSub.id, raw: 'Malaga, Spain', city: 'Malaga', country: 'Spain', role: 'event_site', sourceCorpus: 'meta25' },
			tx,
		);
		profiles += 1;

		const pages = (metaCat.pages || {}) as Record<string, Record<string, unknown>>;
		let count = 0;
		for (const [url, info] of Object.entries(pages)) {
			if (!info?.ok || !info.title) continue;
			const srId = upsertSourceRecord(
				{
					corpus: 'meta25',
					sourceRef: `url:${url}`,
					sourceUrl: url,
					title: String(info.title),
					publishedDate: '2025',
				},
				tx,
			);
			if (count < 15) {
				upsertTimelineEntry(
					{
						profileId: metaSub.id,
						eventDate: '2025',
						datePrecision: 'year',
						title: String(info.title),
						summary: `Captured META 2025 page (${info.textChars ?? 0} chars)`,
						angle: 'academic_research',
						entryKind: 'publication',
						geoKey: 'spain:city:malaga',
						geoLabel: 'Malaga, Spain',
						sourceCorpus: 'meta25',
						sourceRecordId: srId,
						dedupeHint: `meta25:${url}`,
					},
					tx,
				);
				timelineEntries += 1;
				count += 1;
			}
		}
	}

	// Digital Earth ISDE
	const deCat = readJsonSafe<Record<string, unknown>>(path.join(dataRoot, 'digitalearth-isde', 'catalog.json'));
	if (deCat) {
		const isdeOrg = upsertProfile(
			{
				profileType: 'nonprofit',
				name: 'International Society for Digital Earth (ISDE)',
				status: 'active',
				summary: 'International scientific society promoting Digital Earth, Big Earth Data, and geospatial research.',
				sourceCorpus: 'digitalearth-isde',
			},
			tx,
		);
		addAlias({ profileId: isdeOrg.id, alias: 'ISDE', aliasKind: 'acronym', sourceCorpus: 'digitalearth-isde' }, tx);
		const deSub = upsertProfile(
			{
				profileType: 'historic_event',
				name: 'Digital Earth & Big Earth Data (ISDE)',
				summary: 'ISDE lectures, symposiums, geospatial data layers, and research publications.',
				sourceCorpus: 'digitalearth-isde',
			},
			tx,
		);
		upsertProfileLink(
			{
				fromProfileId: isdeOrg.id,
				toProfileId: deSub.id,
				relationType: 'participated_in',
				roleLabel: 'Scientific Society',
				angle: 'academic_research',
				sourceCorpus: 'digitalearth-isde',
			},
			tx,
		);
		profiles += 2;
		links += 1;
	}

	// TWDB Trinity Aquifer
	const twdbCat = readJsonSafe<Record<string, unknown>>(
		path.join(dataRoot, 'twdb-trinity-aquifer', 'catalog.json'),
	);
	if (twdbCat && Array.isArray(twdbCat.documents)) {
		const twdbAgency = upsertProfile(
			{
				profileType: 'government',
				name: 'Texas Water Development Board (TWDB)',
				status: 'active',
				summary: 'Texas state water planning, groundwater availability modeling (GAM), and aquifer science agency.',
				sourceCorpus: 'twdb-trinity-aquifer',
			},
			tx,
		);
		addAlias({ profileId: twdbAgency.id, alias: 'TWDB', aliasKind: 'acronym', sourceCorpus: 'twdb-trinity-aquifer' }, tx);
		addLocation(
			{ profileId: twdbAgency.id, raw: 'Texas, US', state: 'TX', country: 'US', role: 'jurisdiction', sourceCorpus: 'twdb-trinity-aquifer' },
			tx,
		);

		const trinitySub = upsertProfile(
			{
				profileType: 'historic_event',
				name: 'Texas Trinity & Antlers Aquifer Groundwater',
				status: 'pinned',
				summary: 'TWDB groundwater availability models (GAMs), water-level reports, management plans, and USGS Antlers Aquifer studies.',
				sourceCorpus: 'twdb-trinity-aquifer',
			},
			tx,
		);
		addLocation(
			{ profileId: trinitySub.id, raw: 'Texas, US', state: 'TX', country: 'US', role: 'jurisdiction', sourceCorpus: 'twdb-trinity-aquifer' },
			tx,
		);

		upsertProfileLink(
			{
				fromProfileId: twdbAgency.id,
				toProfileId: trinitySub.id,
				relationType: 'regulator_of',
				roleLabel: 'Groundwater authority',
				angle: 'geophysical',
				sourceCorpus: 'twdb-trinity-aquifer',
			},
			tx,
		);
		profiles += 2;
		links += 1;

		for (const doc of (twdbCat.documents as Array<Record<string, unknown>>).slice(0, 80)) {
			if (!doc?.ok) continue;
			const facets = (doc.facets || {}) as Record<string, unknown>;
			const years = Array.isArray(facets.years) ? facets.years.map(String) : [];
			const pubYear = years[0] || null;
			const title = String(facets.title || doc.url || doc.id);
			const srId = upsertSourceRecord(
				{
					corpus: 'twdb-trinity-aquifer',
					sourceRef: `file:.data/twdb-trinity-aquifer/catalog.json#${String(doc.id)}`,
					sourceUrl: doc.url ? String(doc.url) : null,
					title,
					publishedDate: pubYear,
					metadata: facets,
				},
				tx,
			);
			upsertTimelineEntry(
				{
					profileId: trinitySub.id,
					eventDate: pubYear,
					datePrecision: pubYear ? 'year' : 'unknown',
					title,
					summary: `TWDB ${String(facets.docType || 'report')} — topics: ${Array.isArray(facets.topics) ? facets.topics.join(', ') : ''}`,
					angle: 'geophysical',
					entryKind: 'publication',
					geoKey: 'us:tx',
					geoLabel: 'Texas',
					sourceCorpus: 'twdb-trinity-aquifer',
					sourceRecordId: srId,
					dedupeHint: `twdb:${String(doc.id)}`,
				},
				tx,
			);
			timelineEntries += 1;
		}
	}

	return { corpus: 'domain-corpora', profiles, links, timelineEntries };
}

/** 10. Notable OK/TX Seismic & Tornado Historic Events */
function backfillGeophysicalEvents(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	// Seismic notable M>=4
	const seismicNotable = path.join(dataRoot, 'seismic', 'notable');
	if (fs.existsSync(seismicNotable)) {
		const usgs = upsertProfile(
			{
				profileType: 'government',
				name: 'U.S. Geological Survey (USGS)',
				status: 'active',
				sourceCorpus: 'seismic',
			},
			tx,
		);
		addAlias({ profileId: usgs.id, alias: 'USGS', aliasKind: 'acronym', sourceCorpus: 'seismic' }, tx);

		const seismicSub = upsertProfile(
			{
				profileType: 'historic_event',
				name: 'Oklahoma & Texas Seismic Activity (USGS M≥4 Notable)',
				status: 'pinned',
				startDate: '2016-01-01',
				summary: 'Notable M≥4.0 earthquakes across Oklahoma and Texas from USGS ComCat (2016–present) for geophysical & regional timeline alignment.',
				sourceCorpus: 'seismic',
			},
			tx,
		);
		upsertProfileLink(
			{
				fromProfileId: usgs.id,
				toProfileId: seismicSub.id,
				relationType: 'participated_in',
				roleLabel: 'Monitoring agency',
				angle: 'geophysical',
				sourceCorpus: 'seismic',
			},
			tx,
		);
		profiles += 2;
		links += 1;

		const jsonFiles = fs.readdirSync(seismicNotable).filter((f) => f.endsWith('.json'));
		for (const f of jsonFiles) {
			const events = readJsonSafe<Array<Record<string, unknown>>>(path.join(seismicNotable, f)) || [];
			for (const ev of events) {
				const id = String(ev.id || '');
				const evDate = normalizeIsoDate(String(ev.time || '')).date;
				const place = String(ev.place || 'OK/TX');
				const mag = Number(ev.mag || 0);
				const st = String(ev.state || '').toLowerCase() === 'texas' ? 'TX' : 'OK';
				if (!id || !evDate) continue;

				const geoKey = normalizeGeoKey({ raw: place, state: st, country: 'US' });
				const title = `M${mag.toFixed(1)} Earthquake — ${place}`;
				const srId = upsertSourceRecord(
					{
						corpus: 'seismic',
						sourceRef: `file:.data/seismic/notable/${f}#${id}`,
						sourceUrl: ev.url ? String(ev.url) : null,
						title,
						publishedDate: evDate,
						excerpt: `Magnitude ${mag} (${String(ev.magType || '')}), felt=${String(ev.felt ?? 0)}, place=${place}`,
					},
					tx,
				);

				upsertTimelineEntry(
					{
						profileId: seismicSub.id,
						eventDate: evDate,
						title,
						summary: `USGS ComCat event ${id}: M${mag} at ${place}${ev.felt ? ` (${String(ev.felt)} felt reports)` : ''}.`,
						angle: 'geophysical',
						entryKind: 'event',
						geoKey,
						geoLabel: place,
						sourceCorpus: 'seismic',
						sourceRecordId: srId,
						dedupeHint: `usgs:${id}`,
					},
					tx,
				);
				timelineEntries += 1;

				if (mag >= 4.5) {
					const ep = upsertProfile(
						{
							profileType: 'historic_event',
							name: `${title} (${evDate})`,
							slug: `usgs-${id}`,
							startDate: evDate,
							summary: `Notable M${mag.toFixed(1)} earthquake near ${place} (${evDate}).`,
							metadata: { mag, place, state: st, felt: ev.felt },
							sourceCorpus: 'seismic',
						},
						tx,
					);
					addIdentifier({ profileId: ep.id, scheme: 'usgs_event', value: id, sourceCorpus: 'seismic' }, tx);
					addLocation({ profileId: ep.id, raw: place, state: st, country: 'US', role: 'event_site', sourceCorpus: 'seismic' }, tx);
					upsertProfileLink(
						{
							fromProfileId: ep.id,
							toProfileId: seismicSub.id,
							relationType: 'part_of_subject',
							startDate: evDate,
							angle: 'geophysical',
							sourceCorpus: 'seismic',
							sourceRecordId: srId,
						},
						tx,
					);
					profiles += 1;
					links += 1;
				}
			}
		}
	}

	// Tornadoes notable EF2+ or fatal
	const tornNotable = path.join(dataRoot, 'tornadoes', 'notable');
	if (fs.existsSync(tornNotable)) {
		const noaa = upsertProfile(
			{
				profileType: 'government',
				name: 'National Oceanic and Atmospheric Administration (NOAA / SPC)',
				status: 'active',
				sourceCorpus: 'tornadoes',
			},
			tx,
		);
		addAlias({ profileId: noaa.id, alias: 'NOAA', aliasKind: 'acronym', sourceCorpus: 'tornadoes' }, tx);
		addAlias({ profileId: noaa.id, alias: 'SPC', aliasKind: 'acronym', sourceCorpus: 'tornadoes' }, tx);

		const tornSub = upsertProfile(
			{
				profileType: 'historic_event',
				name: 'Oklahoma & Texas Notable Tornadoes (EF2+ / Fatal)',
				status: 'pinned',
				startDate: '2016-01-01',
				summary: 'NOAA SPC & NCEI notable tornadoes (EF2+ or fatal) across Oklahoma and Texas since 2016.',
				sourceCorpus: 'tornadoes',
			},
			tx,
		);
		upsertProfileLink(
			{
				fromProfileId: noaa.id,
				toProfileId: tornSub.id,
				relationType: 'participated_in',
				roleLabel: 'Weather tracking agency',
				angle: 'geophysical',
				sourceCorpus: 'tornadoes',
			},
			tx,
		);
		profiles += 2;
		links += 1;

		const jsonFiles = fs.readdirSync(tornNotable).filter((f) => f.endsWith('.json'));
		for (const f of jsonFiles) {
			const events = readJsonSafe<Array<Record<string, unknown>>>(path.join(tornNotable, f)) || [];
			for (const ev of events) {
				const id = String(ev.id || '');
				const evDate = normalizeIsoDate(String(ev.date || '')).date;
				const ef = String(ev.ef || `EF${ev.mag ?? '?'}`);
				const st = String(ev.st || (String(ev.state || '').toLowerCase() === 'texas' ? 'TX' : 'OK'));
				if (!id || !evDate) continue;

				const geoKey = normalizeGeoKey({ raw: st, state: st, country: 'US' });
				const title = `${ef} Tornado in ${st} (${evDate})`;
				const summary = `${ef} tornado (${ev.lenMiles ?? '?'} mi track), injuries=${ev.injuries ?? 0}, fatalities=${ev.fatalities ?? 0}${ev.loss ? `, loss=$${ev.loss}` : ''}.`;
				const srId = upsertSourceRecord(
					{
						corpus: 'tornadoes',
						sourceRef: `file:.data/tornadoes/notable/${f}#${id}`,
						title,
						publishedDate: evDate,
						excerpt: summary,
					},
					tx,
				);

				upsertTimelineEntry(
					{
						profileId: tornSub.id,
						eventDate: evDate,
						title,
						summary,
						angle: 'geophysical',
						entryKind: 'event',
						geoKey,
						geoLabel: st,
						sourceCorpus: 'tornadoes',
						sourceRecordId: srId,
						dedupeHint: `spc:${id}`,
					},
					tx,
				);
				timelineEntries += 1;

				if (Number(ev.mag || 0) >= 3 || Number(ev.fatalities || 0) > 0) {
					const omTag = ev.om ? `, #${String(ev.om)}` : '';
					const ep = upsertProfile(
						{
							profileType: 'historic_event',
							name: `${ef} Tornado — ${st} (${evDate}${omTag})`,
							slug: `tornado-${id}`,
							startDate: evDate,
							summary,
							metadata: { ef, state: st, injuries: ev.injuries, fatalities: ev.fatalities, lenMiles: ev.lenMiles },
							sourceCorpus: 'tornadoes',
						},
						tx,
					);
					addIdentifier({ profileId: ep.id, scheme: 'spc_om', value: id, sourceCorpus: 'tornadoes' }, tx);
					addLocation({ profileId: ep.id, raw: `${st}, US`, state: st, country: 'US', role: 'event_site', sourceCorpus: 'tornadoes' }, tx);
					upsertProfileLink(
						{
							fromProfileId: ep.id,
							toProfileId: tornSub.id,
							relationType: 'part_of_subject',
							startDate: evDate,
							angle: 'geophysical',
							sourceCorpus: 'tornadoes',
							sourceRecordId: srId,
						},
						tx,
					);
					profiles += 1;
					links += 1;
				}
			}
		}
	}

	return { corpus: 'seismic+tornadoes', profiles, links, timelineEntries };
}

/** 11. Imperial War Museums — Timeline of Conflict Since 1914 */
function backfillIwmConflictTimeline(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const file = path.join(dataRoot, 'iwm-conflict-timeline', 'events', 'events.jsonl');
	const events = readJsonlSafe<Record<string, unknown>>(file);
	if (!events.length) {
		return { corpus: 'iwm-conflict-timeline', profiles: 0, links: 0, timelineEntries: 0, skipped: 'no events' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const iwmOrg = upsertProfile(
		{
			profileType: 'nonprofit',
			name: 'Imperial War Museums (IWM)',
			status: 'pinned',
			startDate: '1917-03-05',
			summary:
				'British national museum institution founded on 5 March 1917 during the First World War to record and preserve conflict history from 1914 to the present.',
			sourceCorpus: 'iwm-conflict-timeline',
		},
		tx,
	);
	addAlias({ profileId: iwmOrg.id, alias: 'IWM', aliasKind: 'acronym', sourceCorpus: 'iwm-conflict-timeline' }, tx);
	addLocation(
		{
			profileId: iwmOrg.id,
			raw: 'London, United Kingdom',
			city: 'London',
			country: 'United Kingdom',
			role: 'hq',
			sourceCorpus: 'iwm-conflict-timeline',
		},
		tx,
	);
	profiles += 1;

	const iwmSubject = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'Timeline of Conflict Since 1914 (IWM)',
			slug: 'iwm-timeline-of-conflict-since-1914',
			status: 'pinned',
			startDate: '1899',
			summary:
				'Imperial War Museums chronology of 36 major conflicts (1899 Boer War through modern conflicts in Syria, Ukraine, Yemen, and ISIS) plus 26 linked IWM historical overviews.',
			sourceCorpus: 'iwm-conflict-timeline',
		},
		tx,
	);
	profiles += 1;

	upsertProfileLink(
		{
			fromProfileId: iwmOrg.id,
			toProfileId: iwmSubject.id,
			relationType: 'authored_or_spoke',
			roleLabel: 'Curator / Publisher',
			angle: 'policy',
			sourceCorpus: 'iwm-conflict-timeline',
			evidenceNote: 'https://www.iwm.org.uk/history/first-world-war/timeline-of-conflict-since-1914',
		},
		tx,
	);
	links += 1;

	for (const ev of events) {
		const evId = String(ev.id || '');
		const title = String(ev.title || '').trim();
		if (!evId || !title) continue;
		const startDate = ev.date ? String(ev.date) : null;
		const endDate = ev.end_date ? String(ev.end_date) : null;
		const dateLabel = String(ev.date_label || startDate || '');
		const summary = String(ev.summary || '').trim();
		const articleUrl = ev.article_url ? String(ev.article_url) : String(ev.source_url || '');
		const regions = Array.isArray(ev.regions) ? ev.regions.map(String) : [];

		const srId = upsertSourceRecord(
			{
				corpus: 'iwm-conflict-timeline',
				sourceRef: `file:.data/iwm-conflict-timeline/events/events.jsonl#${evId}`,
				sourceUrl: articleUrl || null,
				title: `${title} (${dateLabel})`,
				publishedDate: startDate,
				excerpt: summary.slice(0, 700),
				metadata: { kind: ev.kind, ongoing: ev.ongoing, regions },
			},
			tx,
		);

		const ep = upsertProfile(
			{
				profileType: 'historic_event',
				name: title,
				startDate,
				endDate,
				status: ev.kind === 'conflict' ? 'pinned' : 'active',
				summary,
				metadata: {
					iwmId: evId,
					dateLabel,
					ongoing: Boolean(ev.ongoing),
					regions,
					articleUrl: articleUrl || undefined,
					articleSlug: ev.article_slug || undefined,
				},
				sourceCorpus: 'iwm-conflict-timeline',
			},
			tx,
		);
		profiles += 1;

		let firstGeoKey: string | null = null;
		let firstGeoLabel: string | null = null;
		for (const reg of regions) {
			const gk = addLocation(
				{
					profileId: ep.id,
					raw: reg,
					country: reg === 'United Kingdom' ? 'United Kingdom' : null,
					role: 'event_site',
					sourceCorpus: 'iwm-conflict-timeline',
				},
				tx,
			);
			if (!firstGeoKey) {
				firstGeoKey = gk;
				firstGeoLabel = reg;
			}
		}

		upsertProfileLink(
			{
				fromProfileId: ep.id,
				toProfileId: iwmSubject.id,
				relationType: 'part_of_subject',
				roleLabel: String(ev.kind || 'conflict'),
				startDate,
				endDate,
				angle: 'policy',
				sourceCorpus: 'iwm-conflict-timeline',
				sourceRecordId: srId,
				evidenceNote: `IWM Timeline (${dateLabel})`,
			},
			tx,
		);
		links += 1;

		// Add onto both the Subject Matter timeline and the Historic Event's own timeline
		upsertTimelineEntry(
			{
				profileId: iwmSubject.id,
				eventDate: startDate,
				datePrecision: 'year',
				endDate,
				title: `${title} (${dateLabel})`,
				summary,
				angle: 'policy',
				entryKind: 'milestone',
				geoKey: firstGeoKey,
				geoLabel: firstGeoLabel,
				sourceCorpus: 'iwm-conflict-timeline',
				sourceRecordId: srId,
				dedupeHint: `iwm-sub:${evId}`,
			},
			tx,
		);
		upsertTimelineEntry(
			{
				profileId: ep.id,
				eventDate: startDate,
				datePrecision: 'year',
				endDate,
				title: `${title} (${dateLabel})`,
				summary,
				angle: 'policy',
				entryKind: 'milestone',
				geoKey: firstGeoKey,
				geoLabel: firstGeoLabel,
				sourceCorpus: 'iwm-conflict-timeline',
				sourceRecordId: srId,
				dedupeHint: `iwm-ev:${evId}`,
			},
			tx,
		);
		timelineEntries += 2;
	}

	return { corpus: 'iwm-conflict-timeline', profiles, links, timelineEntries };
}

/** 12. Regional History Corpus (NY/Boston finance, labor/unions, conflicts + DFW military-tech companies) */
function backfillRegionalHistory(dataRoot: string, tx: DatabaseSync): BackfillCorpusStats {
	const file = path.join(dataRoot, 'regional-history-corpus', 'profiles', 'seed-profiles.json');
	const items = readJsonSafe<Array<Record<string, unknown>>>(file);
	if (!items?.length) {
		return { corpus: 'regional-history-corpus', profiles: 0, links: 0, timelineEntries: 0, skipped: 'not found' };
	}

	let profiles = 0;
	let links = 0;
	let timelineEntries = 0;

	const TRACK_ANCHORS: Record<string, { slug: string; name: string; startDate: string; summary: string; geo: string }> = {
		ny_boston_finance: {
			slug: 'ny-boston-financial-history',
			name: 'New York & Boston Financial History',
			startDate: '1784',
			geo: 'New York, NY',
			summary:
				'Financial history of New York and Boston: Buttonwood Agreement, NYSE, Bank of New York, Federal Reserve Banks of NY & Boston, State Street, Fidelity, J.P. Morgan, Goldman Sachs, Brown Brothers Harriman, Boston Associates, and major panics/crashes (1837, 1873, 1907, 1929, 2008).',
		},
		ny_boston_labor_unions: {
			slug: 'ny-boston-labor-union-history',
			name: 'New York & Boston Labor & Union History',
			startDate: '1823',
			geo: 'Boston, MA',
			summary:
				'Labor movements, strikes, and unions across New York and Boston: Lowell Mill Girls, Great Railroad Strike of 1877, 1909 Shirtwaist Strike, Triangle Shirtwaist Fire, 1912 Lawrence Bread and Roses Strike, 1919 Boston Police Strike, 1966 NYC Transit Strike, ILGWU, ILA, IWW, AFL, Knights of Labor.',
		},
		ny_boston_conflicts: {
			slug: 'ny-boston-regional-conflicts',
			name: 'New York & Boston Regional Conflicts',
			startDate: '1675',
			geo: 'Boston, MA',
			summary:
				'Regional armed conflicts, rebellions, riots, and attacks across New York and Massachusetts: King Philip’s War, Boston Massacre & Tea Party, Lexington & Concord, Siege of Boston, Bunker Hill, NY/NJ Campaign, Shays’ Rebellion, Astor Place Riot, 1863 NYC Draft Riots, 1920 Wall Street Bombing, Sacco & Vanzetti, 9/11.',
		},
		dfw_military_tech: {
			slug: 'dfw-military-defense-tech-corridor',
			name: 'Dallas–Fort Worth Military & Defense Tech Corridor',
			startDate: '1917',
			geo: 'Fort Worth, TX',
			summary:
				'Defense, aerospace, and industrial technology companies anchored in Dallas–Fort Worth and North Texas/Southern Oklahoma: Bell Textron / Bell Helicopter, Halliburton / KBR, Rockwell Collins / Collins Aerospace, Emerson Electric, Lockheed Martin Aeronautics (Air Force Plant 4), Texas Instruments, Vought / LTV, L3Harris / E-Systems, RTX, and General Dynamics.',
		},
	};

	const anchorIds = new Map<string, string>();
	for (const [trackKey, def] of Object.entries(TRACK_ANCHORS)) {
		const ap = upsertProfile(
			{
				profileType: 'historic_event',
				name: def.name,
				slug: def.slug,
				status: 'pinned',
				startDate: def.startDate,
				summary: def.summary,
				sourceCorpus: 'regional-history-corpus',
			},
			tx,
		);
		const parts = parseAddressParts(def.geo);
		addLocation(
			{
				profileId: ap.id,
				raw: def.geo,
				city: parts.city,
				state: parts.state,
				country: parts.country || 'US',
				role: 'event_site',
				sourceCorpus: 'regional-history-corpus',
			},
			tx,
		);
		anchorIds.set(trackKey, ap.id);
		profiles += 1;
	}

	const nameToProfileId = new Map<string, string>();

	for (const it of items) {
		const name = String(it.name || '').trim();
		const track = String(it.track || '');
		const pType = String(it.profileType || 'historic_event') as ProfileType;
		const geo = String(it.geo || '').trim();
		const angle = (it.angle ? String(it.angle) : 'general') as TimelineAngle;
		const url = it.url ? String(it.url) : null;
		const summary = String(it.summary || '').trim();
		if (!name) continue;

		const srId = upsertSourceRecord(
			{
				corpus: 'regional-history-corpus',
				sourceRef: `file:.data/regional-history-corpus/articles/${String(it.slug || '')}.md`,
				sourceUrl: url,
				title: name,
				publishedDate: it.startDate ? String(it.startDate) : null,
				excerpt: summary.slice(0, 700),
				metadata: { track, cik: it.cik || null, ticker: it.ticker || null },
			},
			tx,
		);

		const prof = upsertProfile(
			{
				profileType: pType,
				name,
				status: 'pinned',
				startDate: it.startDate ? String(it.startDate) : null,
				endDate: it.endDate ? String(it.endDate) : null,
				summary,
				metadata: {
					track,
					cik: it.cik || undefined,
					ticker: it.ticker || undefined,
					sicDescription: it.sicDescription || undefined,
					wikibaseItem: it.wikibaseItem || undefined,
					articleSlug: it.slug || undefined,
				},
				sourceCorpus: 'regional-history-corpus',
			},
			tx,
		);
		nameToProfileId.set(name.toLowerCase(), prof.id);
		profiles += 1;

		if (Array.isArray(it.aliases)) {
			for (const al of it.aliases) {
				addAlias({ profileId: prof.id, alias: String(al), sourceCorpus: 'regional-history-corpus' }, tx);
			}
		}
		if (it.cik) {
			addIdentifier({ profileId: prof.id, scheme: 'sec_cik', value: String(it.cik), sourceCorpus: 'regional-history-corpus' }, tx);
		}
		if (it.ticker) {
			addIdentifier({ profileId: prof.id, scheme: 'ticker', value: String(it.ticker), sourceCorpus: 'regional-history-corpus' }, tx);
			addAlias({ profileId: prof.id, alias: String(it.ticker), aliasKind: 'ticker', sourceCorpus: 'regional-history-corpus' }, tx);
		}
		if (it.wikibaseItem) {
			addIdentifier({ profileId: prof.id, scheme: 'wikidata', value: String(it.wikibaseItem), sourceCorpus: 'regional-history-corpus' }, tx);
		}

		let primaryGeoKey: string | null = null;
		if (geo) {
			const parts = parseAddressParts(geo);
			primaryGeoKey = addLocation(
				{
					profileId: prof.id,
					raw: geo,
					city: parts.city,
					county: parts.county,
					state: parts.state,
					country: parts.country || 'US',
					role: pType === 'firm' ? 'hq' : pType === 'person' ? 'residence' : 'event_site',
					sourceCorpus: 'regional-history-corpus',
				},
				tx,
			);
		}
		if (it.secHq && String(it.secHq).trim() && String(it.secHq).trim().toLowerCase() !== geo.toLowerCase()) {
			const hqStr = String(it.secHq).trim();
			const parts = parseAddressParts(hqStr);
			addLocation(
				{
					profileId: prof.id,
					raw: hqStr,
					city: parts.city,
					state: parts.state,
					country: parts.country || 'US',
					role: 'hq',
					sourceCorpus: 'regional-history-corpus',
				},
				tx,
			);
		}

		const anchorId =
			track === 'dfw_military_tech' && /tubacex/i.test(name) ? undefined : anchorIds.get(track);
		if (anchorId && anchorId !== prof.id) {
			upsertProfileLink(
				{
					fromProfileId: prof.id,
					toProfileId: anchorId,
					relationType: pType === 'historic_event' ? 'part_of_subject' : 'participated_in',
					roleLabel: track.replace(/_/g, ' '),
					startDate: it.startDate ? String(it.startDate) : null,
					endDate: it.endDate ? String(it.endDate) : null,
					angle,
					sourceCorpus: 'regional-history-corpus',
					sourceRecordId: srId,
					evidenceNote: summary.slice(0, 220),
				},
				tx,
			);
			links += 1;
		}

		const milestones = Array.isArray(it.milestones)
			? (it.milestones as Array<{ date?: string; text?: string }>)
			: [];
		for (let mIdx = 0; mIdx < milestones.length; mIdx++) {
			const m = milestones[mIdx];
			if (!m?.date || !m?.text) continue;
			upsertTimelineEntry(
				{
					profileId: prof.id,
					eventDate: m.date,
					title: `${name}: ${m.text.slice(0, 140)}`,
					summary: m.text,
					angle,
					entryKind: pType === 'historic_event' ? 'milestone' : 'event',
					geoKey: primaryGeoKey,
					geoLabel: geo || null,
					sourceCorpus: 'regional-history-corpus',
					sourceRecordId: srId,
					dedupeHint: `reg:${String(it.slug)}:${mIdx}`,
				},
				tx,
			);
			timelineEntries += 1;

			if (anchorId && mIdx < 3) {
				upsertTimelineEntry(
					{
						profileId: anchorId,
						eventDate: m.date,
						title: `[${name}] ${m.text.slice(0, 140)}`,
						summary: m.text,
						angle,
						entryKind: 'milestone',
						geoKey: primaryGeoKey,
						geoLabel: geo || null,
						sourceCorpus: 'regional-history-corpus',
						sourceRecordId: srId,
						dedupeHint: `reg-anc:${track}:${String(it.slug)}:${mIdx}`,
					},
					tx,
				);
				timelineEntries += 1;
			}
		}
	}

	// Second pass: link founders/people to their employer profiles
	for (const it of items) {
		if (!it.employer || !it.name) continue;
		const personId = nameToProfileId.get(String(it.name).toLowerCase());
		const empId = nameToProfileId.get(String(it.employer).toLowerCase());
		if (!personId || !empId) continue;
		upsertProfileLink(
			{
				fromProfileId: personId,
				toProfileId: empId,
				relationType: 'employed_by',
				roleLabel: it.role ? String(it.role) : 'Founder / Executive',
				startDate: it.startDate ? String(it.startDate) : null,
				endDate: it.endDate ? String(it.endDate) : null,
				angle: 'corporate',
				sourceCorpus: 'regional-history-corpus',
				evidenceNote: `${String(it.role || 'Founder')} of ${String(it.employer)}`,
			},
			tx,
		);
		links += 1;
	}

	return { corpus: 'regional-history-corpus', profiles, links, timelineEntries };
}

/** 13. Regional County Land Filings Subject Matter anchor (connects to knowledge.sqlite) */
function backfillCountySubjectAnchor(tx: DatabaseSync): BackfillCorpusStats {
	const sub = upsertProfile(
		{
			profileType: 'historic_event',
			name: 'Oklahoma & Dallas County Land Records & Deeds (OKCR)',
			status: 'pinned',
			startDate: '2016-01-01',
			summary:
				'Real estate deeds, mortgages (MTG), warranty deeds (WD), releases, and UCC filings indexed in knowledge.sqlite across Bryan, Cherokee, Adair, Sequoyah, and Dallas counties.',
			sourceCorpus: 'knowledge-sqlite',
		},
		tx,
	);
	const counties = [
		{ county: 'Bryan', state: 'OK', raw: 'Bryan County, OK' },
		{ county: 'Cherokee', state: 'OK', raw: 'Cherokee County, OK' },
		{ county: 'Adair', state: 'OK', raw: 'Adair County, OK' },
		{ county: 'Sequoyah', state: 'OK', raw: 'Sequoyah County, OK' },
		{ county: 'Dallas', state: 'TX', raw: 'Dallas County, TX' },
	];
	for (const c of counties) {
		addLocation(
			{
				profileId: sub.id,
				raw: c.raw,
				county: c.county,
				state: c.state,
				country: 'US',
				role: 'jurisdiction',
				sourceCorpus: 'knowledge-sqlite',
			},
			tx,
		);
	}
	return { corpus: 'county-land-records-anchor', profiles: 1, links: 0, timelineEntries: 0 };
}

export type RunBackfillOptions = {
	runAlignment?: boolean;
	includeKnowledgeCrossMatch?: boolean;
};

/**
 * Upgrade/migrate legacy org profile types in-place (`university` → `education`,
 * `medical_mental_hospital` → `medical_hospital`, `state_gov`/`federal_gov`/`agency` → `government`/`foreign`),
 * preserving profile IDs, links, and timeline entries.
 */
function reclassifyExistingOrgProfiles(tx: DatabaseSync): BackfillCorpusStats {
	const rows = tx
		.prepare(
			`SELECT id, slug, name, profile_type FROM profiles
       WHERE profile_type IN ('firm', 'nonprofit', 'agency', 'foreign', 'university', 'education', 'medical_hospital', 'medical_mental_hospital', 'state_gov', 'federal_gov', 'government', 'subject_matter')`,
		)
		.all() as Array<{ id: string; slug: string; name: string; profile_type: string }>;

	const now = new Date().toISOString();
	let updated = 0;

	const DELETED_TYPES = new Set([
		'university',
		'medical_mental_hospital',
		'state_gov',
		'federal_gov',
		'agency',
		'subject_matter',
	]);

	for (const r of rows) {
		let nextType: string = classifyOrgType(r.name);
		// Explicit mapping for retired categories
		if (r.profile_type === 'subject_matter') nextType = 'historic_event';
		else if (r.profile_type === 'university') nextType = 'education';
		else if (r.profile_type === 'medical_mental_hospital') nextType = 'medical_hospital';
		else if (r.profile_type === 'state_gov' || r.profile_type === 'federal_gov') nextType = 'government';

		const isRetired = DELETED_TYPES.has(r.profile_type);
		if (nextType === r.profile_type) continue;
		const targetRefined =
			isRetired ||
			nextType === 'medical_hospital' ||
			nextType === 'education' ||
			nextType === 'government' ||
			nextType === 'foreign';
		if (!targetRefined) continue;

		// Preserve custom slug suffix when migrating subject_matter:foo -> historic_event:foo
		const nextSlug =
			r.profile_type === 'subject_matter' && r.slug.startsWith('subject_matter:')
				? `historic_event:${r.slug.slice('subject_matter:'.length)}`
				: makeProfileSlug(nextType as ProfileType, r.name);
		const conflict = tx
			.prepare('SELECT id FROM profiles WHERE slug = ? AND id != ?')
			.get(nextSlug, r.id) as { id?: string } | undefined;
		if (conflict?.id) {
			if (isRetired) {
				tx.prepare('DELETE FROM profiles WHERE id = ?').run(r.id);
				updated += 1;
			}
			continue;
		}

		tx.prepare('UPDATE profiles SET profile_type = ?, slug = ?, updated_at = ? WHERE id = ?').run(
			nextType,
			nextSlug,
			now,
			r.id,
		);
		updated += 1;
	}

	return { corpus: 'reclassify-orgs', profiles: updated, links: 0, timelineEntries: 0 };
}

/**
 * Auto-merge high-confidence duplicate profiles:
 *   1. Exact same `normalized_name` split across `firm` and a more specific org type
 *      (e.g. `Central Bank of Bahrain (CBB)` in both `firm` and `foreign`).
 *   2. Exact legal-suffix duplicates within the same org type
 *      (e.g. `Palantir Technologies` and `Palantir Technologies Inc.`).
 */
function deduplicateProfiles(tx: DatabaseSync): BackfillCorpusStats {
	let mergedCount = 0;

	const TYPE_SPECIFICITY: Record<string, number> = {
		government: 6,
		foreign: 5,
		medical_hospital: 5,
		education: 5,
		nonprofit: 4,
		firm: 1,
	};

	// Pass 1: exact same normalized_name across different org types
	const crossDupes = tx
		.prepare(
			`SELECT normalized_name
       FROM profiles
       WHERE profile_type IN ('firm', 'nonprofit', 'education', 'medical_hospital', 'government', 'foreign')
       GROUP BY normalized_name
       HAVING COUNT(*) > 1`,
		)
		.all() as Array<{ normalized_name: string }>;

	for (const d of crossDupes) {
		const group = tx
			.prepare(
				`SELECT id, name, profile_type, status,
                (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = profiles.id OR pl.to_profile_id = profiles.id) AS lc
         FROM profiles
         WHERE normalized_name = ?
           AND profile_type IN ('firm', 'nonprofit', 'education', 'medical_hospital', 'government', 'foreign')`,
			)
			.all(d.normalized_name) as Array<{
			id: string;
			name: string;
			profile_type: string;
			status: string;
			lc: number;
		}>;
		if (group.length < 2) continue;

		group.sort((a, b) => {
			const specDiff = (TYPE_SPECIFICITY[b.profile_type] || 0) - (TYPE_SPECIFICITY[a.profile_type] || 0);
			if (specDiff !== 0) return specDiff;
			if (a.status !== b.status) return a.status === 'pinned' ? -1 : b.status === 'pinned' ? 1 : 0;
			return Number(b.lc || 0) - Number(a.lc || 0);
		});

		const keep = group[0];
		for (const dup of group.slice(1)) {
			const res = mergeProfiles(keep.id, dup.id, tx);
			if (res) mergedCount += 1;
		}
	}

	// Pass 2: strict legal-suffix duplicates within the same org type (e.g. "Foo" vs "Foo Inc.")
	const orgRows = tx
		.prepare(
			`SELECT id, name, normalized_name, profile_type, status,
              (SELECT COUNT(*) FROM profile_links pl WHERE pl.from_profile_id = profiles.id OR pl.to_profile_id = profiles.id) AS lc
       FROM profiles
       WHERE profile_type IN ('firm', 'nonprofit', 'education', 'medical_hospital', 'government', 'foreign')`,
		)
		.all() as Array<{
		id: string;
		name: string;
		normalized_name: string;
		profile_type: string;
		status: string;
		lc: number;
	}>;

	const SUFFIX_TAIL_RE =
		/\s+(?:inc|incorporated|llc|l l c|lp|l p|llp|corp|corporation|co|company|ltd|limited|plc|gmbh|s a)$/i;

	const byBase = new Map<string, typeof orgRows>();
	for (const r of orgRows) {
		const base = r.normalized_name.replace(SUFFIX_TAIL_RE, '').trim();
		const stripped = stripLegalSuffixes(r.normalized_name);
		if (base.length < 7 || stripped.length < 5) continue;
		const key = `${r.profile_type}|${base}`;
		const list = byBase.get(key) || [];
		list.push(r);
		byBase.set(key, list);
	}

	for (const group of byBase.values()) {
		if (group.length < 2) continue;
		// Sort: pinned first, then cleaner shorter name, then highest link count
		group.sort((a, b) => {
			if (a.status !== b.status) return a.status === 'pinned' ? -1 : b.status === 'pinned' ? 1 : 0;
			if (a.normalized_name.length !== b.normalized_name.length) {
				return a.normalized_name.length - b.normalized_name.length;
			}
			return Number(b.lc || 0) - Number(a.lc || 0);
		});
		const keep = group[0];
		for (const dup of group.slice(1)) {
			// Verify dup is strictly keep + legal suffix (or same base with different suffix)
			const baseKeep = keep.normalized_name.replace(SUFFIX_TAIL_RE, '').trim();
			const baseDup = dup.normalized_name.replace(SUFFIX_TAIL_RE, '').trim();
			if (baseKeep !== baseDup) continue;
			const res = mergeProfiles(keep.id, dup.id, tx);
			if (res) mergedCount += 1;
		}
	}

	return { corpus: 'deduplicate-profiles', profiles: mergedCount, links: 0, timelineEntries: 0 };
}

/**
 * Run idempotent backfill across all structured `.data/*` corpora and optionally
 * execute the cross-source alignment pass.
 */
export function runProfilesBackfill(opts: RunBackfillOptions = {}): BackfillReport {
	const t0 = Date.now();
	const dataRoot = getDataRootDir();
	const stats: BackfillCorpusStats[] = [];

	const runStep = (fn: (tx: DatabaseSync) => BackfillCorpusStats) => {
		const res = withProfilesTransaction(fn);
		stats.push(res);
	};

	runStep((tx) => reclassifyExistingOrgProfiles(tx));
	runStep((tx) => backfillEntityDossiers(dataRoot, tx));
	runStep((tx) => backfillFinraRosters(dataRoot, tx));
	runStep((tx) => backfillAuthorityTimelines(dataRoot, tx));
	runStep((tx) => backfillCovidTimeline(dataRoot, 'cdc-covid-timeline', 'civilian_health', tx));
	runStep((tx) => backfillCovidTimeline(dataRoot, 'dod-covid-timeline', 'defense_dod', tx));
	runStep((tx) =>
		backfillSpeakerConference(
			dataRoot,
			'physics-congress',
			'Physics Congress 2026 (Astana / Nazarbayev University)',
			'2026',
			{ raw: 'Astana, Kazakhstan', city: 'Astana', country: 'Kazakhstan' },
			tx,
		),
	);
	runStep((tx) =>
		backfillSpeakerConference(
			dataRoot,
			'pqw-itmo',
			'Petersburg Quantum Weeks 2026 (ITMO)',
			'2026',
			{ raw: 'Saint Petersburg, Russia', city: 'Saint Petersburg', country: 'Russia' },
			tx,
		),
	);
	runStep((tx) => backfillWefAmnc(dataRoot, tx));
	runStep((tx) => backfillDomainCorpora(dataRoot, tx));
	runStep((tx) => backfillGeophysicalEvents(dataRoot, tx));
	runStep((tx) => backfillIwmConflictTimeline(dataRoot, tx));
	runStep((tx) => backfillRegionalHistory(dataRoot, tx));
	runStep((tx) => backfillCountySubjectAnchor(tx));
	runStep((tx) => deduplicateProfiles(tx));

	const alignment =
		opts.runAlignment !== false
			? runAlignmentPass({ includeKnowledgeCrossMatch: opts.includeKnowledgeCrossMatch !== false })
			: null;

	return {
		corpora: stats,
		alignment,
		durationMs: Date.now() - t0,
	};
}
