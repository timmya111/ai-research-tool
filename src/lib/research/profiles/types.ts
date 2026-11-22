export const ACTOR_PROFILE_TYPES = [
	'person',
	'firm',
	'university',
	'nonprofit',
	'agency',
] as const;

export const NARRATIVE_PROFILE_TYPES = [
	'subject_matter',
	'historic_event',
] as const;

export const PROFILE_TYPES = [
	...ACTOR_PROFILE_TYPES,
	...NARRATIVE_PROFILE_TYPES,
] as const;

export type ActorProfileType = (typeof ACTOR_PROFILE_TYPES)[number];
export type NarrativeProfileType = (typeof NARRATIVE_PROFILE_TYPES)[number];
export type ProfileType = (typeof PROFILE_TYPES)[number];

export type ProfileStatus = 'pinned' | 'active' | 'candidate' | 'archived';

export type AliasKind =
	| 'name'
	| 'acronym'
	| 'former_name'
	| 'crd'
	| 'cik'
	| 'ticker'
	| 'ein'
	| 'domain'
	| 'handle'
	| 'slug';

export type IdentifierScheme =
	| 'finra_crd'
	| 'sec_cik'
	| 'ticker'
	| 'irs_ein'
	| 'ror'
	| 'orcid'
	| 'wikidata'
	| 'usgs_event'
	| 'spc_om'
	| 'dossier_slug'
	| 'okcr_instrument'
	| 'source_id'
	| 'url';

export type LocationRole =
	| 'hq'
	| 'residence'
	| 'branch'
	| 'event_site'
	| 'jurisdiction'
	| 'corridor'
	| 'associated';

export type DatePrecision = 'day' | 'month' | 'year' | 'range' | 'unknown';

export type TimelineAngle =
	| 'civilian_health'
	| 'defense_dod'
	| 'regulatory_finra'
	| 'law_enforcement'
	| 'land_records'
	| 'academic_research'
	| 'financial'
	| 'geophysical'
	| 'corporate'
	| 'policy'
	| 'community_qa'
	| 'general';

export type TimelineEntryKind =
	| 'event'
	| 'milestone'
	| 'filing'
	| 'directive'
	| 'publication'
	| 'employment'
	| 'funding'
	| 'speech'
	| 'anomaly'
	| 'observation';

export type ProfileRelationType =
	| 'affiliated_with'
	| 'employed_by'
	| 'registered_at'
	| 'alumni_or_faculty'
	| 'funded_by'
	| 'participated_in'
	| 'authored_or_spoke'
	| 'part_of_subject'
	| 'mentioned_in'
	| 'regulator_of'
	| 'family_or_associate'
	| 'business_tie'
	| 'location_overlap'
	| 'temporal_overlap'
	| 'possible_alignment';

export type LinkStatus = 'verified' | 'observed' | 'hypothesis' | 'rejected';

export type AlignmentKind =
	| 'same_entity_alias'
	| 'shared_identifier'
	| 'cross_source_mention'
	| 'timeline_gap_bridge'
	| 'co_occurrence_time_geo'
	| 'shared_affiliation'
	| 'county_filing_match'
	| 'angle_comparison';

export type CautionTier = 'observation' | 'closer_look' | 'stronger_indicator';

export type AlignmentStatus = 'proposed' | 'confirmed' | 'dismissed';

export type Profile = {
	id: string;
	slug: string;
	profileType: ProfileType;
	name: string;
	normalizedName: string;
	status: ProfileStatus;
	summary: string;
	startDate: string | null;
	endDate: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	/** Optional computed counts when returned from list/search endpoints */
	aliasCount?: number;
	linkCount?: number;
	timelineCount?: number;
	alignmentCount?: number;
	corpora?: string[];
};

export type ProfileAlias = {
	id: string;
	profileId: string;
	alias: string;
	normalizedAlias: string;
	aliasKind: AliasKind;
	confidence: number;
	sourceCorpus: string | null;
};

export type ProfileIdentifier = {
	id: string;
	profileId: string;
	scheme: IdentifierScheme;
	value: string;
	normalizedValue: string;
	sourceCorpus: string | null;
};

export type ProfileLocation = {
	id: string;
	profileId: string;
	raw: string;
	city: string | null;
	county: string | null;
	state: string | null;
	country: string | null;
	geoKey: string;
	lat: number | null;
	lon: number | null;
	role: LocationRole;
	sourceCorpus: string | null;
};

export type SourceRecord = {
	id: string;
	corpus: string;
	sourceRef: string;
	sourceUrl: string | null;
	title: string;
	publishedDate: string | null;
	excerpt: string;
	metadata: Record<string, unknown>;
	createdAt: string;
};

export type TimelineEntry = {
	id: string;
	dedupeKey: string;
	profileId: string;
	eventDate: string | null;
	datePrecision: DatePrecision;
	endDate: string | null;
	title: string;
	summary: string;
	angle: TimelineAngle;
	entryKind: TimelineEntryKind;
	geoKey: string | null;
	geoLabel: string | null;
	confidence: number;
	sourceCorpus: string;
	sourceRecordId: string | null;
	sourceUrl?: string | null;
	sourceRef?: string | null;
	/** If merged from a linked child/related profile, identify which profile owns it */
	originProfileId?: string;
	originProfileName?: string;
	originProfileType?: ProfileType;
	metadata: Record<string, unknown>;
	createdAt: string;
};

export type ProfileLink = {
	id: string;
	dedupeKey: string;
	fromProfileId: string;
	toProfileId: string;
	relationType: ProfileRelationType;
	roleLabel: string | null;
	startDate: string | null;
	endDate: string | null;
	status: LinkStatus;
	confidence: number;
	angle: TimelineAngle;
	sourceCorpus: string;
	sourceRecordId: string | null;
	evidenceNote: string;
	createdAt: string;
	updatedAt: string;
	/** Joined peer info for convenient display */
	fromName?: string;
	fromSlug?: string;
	fromType?: ProfileType;
	toName?: string;
	toSlug?: string;
	toType?: ProfileType;
};

export type AlignmentEvidenceItem = {
	corpus: string;
	label: string;
	date?: string | null;
	url?: string | null;
	sourceRef?: string | null;
	snippet?: string | null;
	geoKey?: string | null;
};

export type AlignmentCandidate = {
	id: string;
	dedupeKey: string;
	alignmentKind: AlignmentKind;
	leftProfileId: string;
	rightProfileId: string | null;
	score: number;
	cautionTier: CautionTier;
	status: AlignmentStatus;
	rationale: string;
	evidence: AlignmentEvidenceItem[];
	createdAt: string;
	updatedAt: string;
	/** Joined profile metadata */
	leftName?: string;
	leftSlug?: string;
	leftType?: ProfileType;
	rightName?: string | null;
	rightSlug?: string | null;
	rightType?: ProfileType | null;
};

export type GapFillLead = {
	source: 'profiles' | 'knowledge_sqlite';
	corpus: string;
	date: string | null;
	title: string;
	angle: string;
	snippet: string;
	reason: string;
	profileId?: string | null;
	profileSlug?: string | null;
	profileName?: string | null;
	sourceRef?: string | null;
	url?: string | null;
	geoLabel?: string | null;
};

export type TimelineGap = {
	fromDate: string;
	toDate: string;
	gapDays: number;
	beforeEntryTitle: string;
	afterEntryTitle: string;
	beforeCorpus: string;
	afterCorpus: string;
	fillLeads: GapFillLead[];
};

export type ProfileTimelineResult = {
	profile: Profile;
	entries: TimelineEntry[];
	totalEntries: number;
	dateRange: { min: string | null; max: string | null };
	angleBreakdown: Array<{ angle: string; count: number; corpora: string[] }>;
	corpusBreakdown: Array<{ corpus: string; count: number; angles: string[] }>;
	gaps: TimelineGap[];
	overlappingWindows: Array<{
		month: string;
		angles: string[];
		corpora: string[];
		count: number;
	}>;
};

export type ProfileDetail = {
	profile: Profile;
	aliases: ProfileAlias[];
	identifiers: ProfileIdentifier[];
	locations: ProfileLocation[];
	links: ProfileLink[];
	alignments: AlignmentCandidate[];
	recentTimeline: TimelineEntry[];
	counts: {
		aliases: number;
		identifiers: number;
		locations: number;
		links: number;
		timelineEntries: number;
		alignments: number;
	};
};

export type ProfileStats = {
	totalProfiles: number;
	byType: Record<ProfileType, number>;
	totalAliases: number;
	totalIdentifiers: number;
	totalLocations: number;
	totalSourceRecords: number;
	totalTimelineEntries: number;
	totalLinks: number;
	totalAlignments: number;
	alignmentsByStatus: Record<AlignmentStatus, number>;
	alignmentsByKind: Record<string, number>;
	corpora: Array<{ corpus: string; records: number }>;
	path: string;
};

export const PROFILES_SCHEMA_VERSION = '1';
