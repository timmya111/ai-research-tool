export const ACTOR_PROFILE_TYPES = [
	'person',
	'firm',
	'education',
	'nonprofit',
	'medical_hospital',
	'government',
	/** Geographic / geophysical corridors (electrotelluric, tectonic, basin descriptions). Prefer region names over city lists. */
	'region',
] as const;

export const NARRATIVE_PROFILE_TYPES = [
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
	/** Shorter / alternate display form kept when merge prefers a longer or ID-tied name. */
	| 'other_name'
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
	/** Parent filer's CIK for non-filing subsidiaries (does NOT trigger same-entity shared_identifier merges). */
	| 'parent_sec_cik'
	/** Listing key is symbol + country + market. NYSE:BA is not LSE:BA. */
	| 'ticker'
	| 'irs_ein'
	| 'tx_sos_file'
	| 'tx_taxpayer'
	| 'ok_sos_file'
	/** CUSIP security identifier (entity / security matching). */
	| 'cusip'
	| 'ror'
	| 'orcid'
	| 'wikidata'
	| 'usgs_event'
	| 'spc_om'
	| 'dossier_slug'
	| 'okcr_instrument'
	| 'source_id'
	| 'url'
	/** U.S. passport book number (e.g. A04768849). */
	| 'us_passport'
	/** State driver license / ID number (store digits/letters only; note state in summary). */
	| 'driver_license'

export type LocationRole =
	| 'hq'
	| 'residence'
	| 'birthplace'
	| 'branch'
	| 'event_site'
	| 'jurisdiction'
	| 'corridor'
	| 'associated';

export const LOCATION_ROLES: LocationRole[] = [
	'hq',
	'residence',
	'birthplace',
	'branch',
	'event_site',
	'jurisdiction',
	'corridor',
	'associated',
];

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
	/** Subsidiary → parent ownership (keep both firm nodes; do not merge). */
	| 'owned_by'
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
	| 'city_colocation'
	| 'block_colocation'
	| 'building_colocation'
	| 'shared_affiliation'
	| 'county_filing_match'
	/** Local knowledge hits that are not OKCountyRecords filings (e.g. Research Drive / WEF lists). */
	| 'knowledge_store_match'
	| 'angle_comparison'
	| 'possible_match_name_only';

export type NameMatchKind = 'exact_name' | 'fuzzy_name' | 'initials_or_partial' | 'none';

export type CorroborationKind =
	| 'shared_identifier'
	| 'address_or_geo'
	| 'employer_or_firm'
	| 'military_base_or_unit'
	| 'education_or_institution'
	| 'description_keyword_match'
	| 'summary_or_topic_context'
	/** 1-hop graph peer (historic_event / distinctive org) found in candidate text */
	| 'graph_neighbor';

export type CorroborationHit = {
	kind: CorroborationKind;
	value: string;
	detail: string;
};

export type IdentityDecision = 'validated_merge' | 'name_only_note' | 'reject';

export type IdentityEvaluation = {
	decision: IdentityDecision;
	nameMatch: NameMatchKind;
	nameSimilarity: number;
	matchedQueryName: string | null;
	matchedCandidateName: string | null;
	corroborations: CorroborationHit[];
	dateConflict: boolean;
	dateConflictReason: string | null;
	score: number;
	rationale: string;
	missingValidationHint: string | null;
};

export type EnrichSourceOutcome = {
	source:
		| 'wikipedia_local'
		| 'brokercheck'
		| 'knowledge_sqlite'
		| 'free_org_enrich'
		| 'date_resolver'
		| 'legal_docs_ocr'
		| 'internet_crawl'
		| 'entity_discovery'
		| 'bryan_ucc';
	status: 'merged' | 'name_only_note' | 'skipped' | 'not_found' | 'error';
	candidateTitle?: string;
	candidateUrl?: string | null;
	evaluation?: IdentityEvaluation;
	fieldsUpdated: string[];
	countsAdded: {
		aliases: number;
		identifiers: number;
		locations: number;
		employments: number;
		links: number;
		timelineEntries: number;
		notes: number;
	};
	note?: string;
};

export type EnrichProfileReport = {
	profileId: string;
	profileSlug: string;
	profileName: string;
	profileType: ProfileType;
	validatedSources: number;
	heldNameOnlyNotes: number;
	fieldsUpdated: string[];
	totalsAdded: {
		aliases: number;
		identifiers: number;
		locations: number;
		employments: number;
		links: number;
		timelineEntries: number;
		notes: number;
	};
	outcomes: EnrichSourceOutcome[];
	durationMs: number;
};

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
	/** Main category labels of connected organizations/events (used as tags, esp. on person profiles) */
	categoryTags?: ProfileType[];
	/** Primary location label for quick display */
	primaryLocation?: string | null;
	/** Clearly associated ISO/flag-icons lowercase country codes (multiple if multinational) */
	countryCodes?: string[];
	/** Distinct alternate / full name variations (excluding the primary canonical name) */
	alternateNames?: string[];
	/** FINRA CRD# when present (person or firm); for left-list display */
	finraCrd?: string | null;
	/**
	 * Firm is linked to an external live listing URL (e.g. MineralAnswers producer page,
	 * BrokerCheck). Used for green “Firm” treatment when start/end dates are missing.
	 */
	hasLiveSourceUrl?: boolean;
	/**
	 * Firm has finraBcScope or finraIaScope === ACTIVE from the visualizer/API.
	 * Also used for green “Firm” treatment when start/end dates are missing.
	 */
	hasActiveFinraScope?: boolean;
};

export type PersonEmploymentEntry = {
	id: string;
	orgProfileId: string | null;
	orgSlug: string | null;
	orgName: string;
	orgCategory: ProfileType;
	orgCountryCodes?: string[];
	firmCrd?: string | null;
	secNumber?: string | null;
	iaOnly?: boolean;
	firmFinraScope?: string | null;
	role: string | null;
	relationType: ProfileRelationType;
	startDate: string | null;
	endDate: string | null;
	isCurrent: boolean | null;
	location: string | null;
	sourceCorpus: string;
	evidenceNote: string;
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
	/** User- or evidence-confirmed; required before a residence is trusted in the header. */
	confirmed: boolean;
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
	originProfileSlug?: string;
	/**
	 * Resolved in-app profile for title navigation (another historic_event matched by
	 * origin ownership, exact title, or source URL). Omit when it is the viewing card.
	 */
	linkedProfileId?: string;
	linkedProfileSlug?: string;
	linkedProfileName?: string;
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
	/** Resolved country flags for the connected peer profile */
	peerCountryCodes?: string[];
	/** Peer profile dates, summary & primary location (used for chronological Historic Event cards) */
	peerStartDate?: string | null;
	peerEndDate?: string | null;
	peerSummary?: string | null;
	peerPrimaryLocation?: string | null;
	/** Peer person gender when known (`female` / `male`) — Family / Relatives kinship labels */
	peerGender?: 'female' | 'male' | null;
	/** Peer FINRA / SEC registry fields (for CRD-prioritized Connected Profiles grouping) */
	peerFinraCrd?: string | null;
	peerFinraBcScope?: string | null;
	peerFinraIaScope?: string | null;
	peerSecCik?: string | null;
	/** Merged source corpora when multiple duplicate links to the same peer were collapsed */
	sources?: string[];
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

/** One node in the firm Ownership / Group ASCII tree (holding parent or subsidiary). */
export type FirmOwnershipGroupNode = {
	id: string;
	name: string;
	role: string | null;
	startDate: string | null;
	endDate: string | null;
};

/**
 * Expanded ownership group for firm detail.
 * When the current firm is a subsidiary, `root` is the holding parent and
 * `subsidiaries` includes every sibling under that parent (including current).
 * When the current firm is the parent, `root` is self and `subsidiaries` are its children.
 */
export type FirmOwnershipGroup = {
	currentProfileId: string;
	root: FirmOwnershipGroupNode;
	subsidiaries: FirmOwnershipGroupNode[];
};

export type ProfileDetail = {
	profile: Profile;
	aliases: ProfileAlias[];
	identifiers: ProfileIdentifier[];
	locations: ProfileLocation[];
	links: ProfileLink[];
	alignments: AlignmentCandidate[];
	recentTimeline: TimelineEntry[];
	/** Structured employment / affiliation history (populated for person profiles) */
	employmentHistory: PersonEmploymentEntry[];
	/** Main category labels derived from linked orgs/events + manual tags */
	categoryTags: ProfileType[];
	/** Firm Ownership / Group tree (parent + all subsidiaries); null when no owned_by links */
	ownershipGroup: FirmOwnershipGroup | null;
	counts: {
		aliases: number;
		identifiers: number;
		locations: number;
		links: number;
		timelineEntries: number;
		alignments: number;
		employmentHistory: number;
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

export const PROFILES_SCHEMA_VERSION = '2';
