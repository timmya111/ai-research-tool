import type { DatabaseSync } from 'node:sqlite';
import { detectProfileCountryCodes } from '@/lib/research/profiles/countries';
import { getProfilesDb } from '@/lib/research/profiles/db';
import {
	classifyLinkProximityCue,
	extractAddressProximityKeys,
	extractSuiteFloorToken,
} from '@/lib/research/profiles/edgeWeights';
import {
	isTooGenericLocation,
	normalizeLocationRecord,
	normalizeText,
} from '@/lib/research/profiles/normalize';
import type { ProfileType } from '@/lib/research/profiles/types';

export type NearbyMode = 'same_building' | 'nearby';

export type NearbyProximityKind =
	| 'same_building'
	| 'linked_nearby'
	| 'same_street'
	| 'same_zip'
	| 'nearby_coords'
	| 'same_city';

export type NearbyProfileItem = {
	profileId: string;
	slug: string;
	name: string;
	profileType: ProfileType;
	countryCodes: string[];
	address: string;
	matchedSourceAddress: string;
	proximity: NearbyProximityKind;
	proximityLabel: string;
	suiteToken: string | null;
	distanceMiles: number | null;
	alreadyConnected: boolean;
	linkId?: string | null;
	linkRoleLabel?: string | null;
};

export type ProfileNearbyResult = {
	mode: NearbyMode;
	sourceLocations: string[];
	counts: {
		sameBuilding: number;
		nearby: number;
	};
	sameBuildingItems: NearbyProfileItem[];
	nearbyItems: NearbyProfileItem[];
	items: NearbyProfileItem[];
};

const PO_BOX_RE = /\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b/i;
const ZIP5_RE = /\b(\d{5})(?:-\d{4})?\b/;

const DIR_MAP: Record<string, string> = {
	north: 'n',
	south: 's',
	east: 'e',
	west: 'w',
	northeast: 'ne',
	northwest: 'nw',
	southeast: 'se',
	southwest: 'sw',
	'n w': 'nw',
	'n e': 'ne',
	's w': 'sw',
	's e': 'se',
};

const EXTRA_STREET_SUFFIX_MAP: Record<string, string> = {
	ext: 'extension',
	ex: 'extension',
	expy: 'expressway',
	exp: 'expressway',
	expwy: 'expressway',
	fwy: 'freeway',
	tpke: 'turnpike',
	pike: 'pike',
	st: 'street',
	ave: 'avenue',
	blvd: 'boulevard',
	rd: 'road',
	dr: 'drive',
	ln: 'lane',
	pl: 'place',
	plz: 'plaza',
	ct: 'court',
	cir: 'circle',
	pkwy: 'parkway',
	ter: 'terrace',
	sq: 'square',
	hwy: 'highway',
};

const GENERIC_STREET_CORE_WORDS = new Set([
	'n',
	's',
	'e',
	'w',
	'ne',
	'nw',
	'se',
	'sw',
	'street',
	'avenue',
	'boulevard',
	'road',
	'drive',
	'lane',
	'place',
	'plaza',
	'court',
	'circle',
	'parkway',
	'terrace',
	'square',
	'highway',
	'way',
	'expressway',
	'extension',
	'freeway',
	'suite',
	'floor',
	'unit',
	'box',
	'po',
]);

type ParsedLocFingerprint = {
	raw: string;
	city: string | null;
	state: string | null;
	country: string | null;
	geoKey: string;
	lat: number | null;
	lon: number | null;
	zip: string | null;
	isPoBox: boolean;
	houseNumber: string | null;
	streetCanon: string | null;
	streetCoreTokens: string[];
	buildingName: string | null;
	suiteToken: string | null;
	buildingFingerprint: string | null;
};

function canonicalizeStreet(rawStreet: string | null): {
	streetCanon: string | null;
	coreTokens: string[];
} {
	if (!rawStreet) return { streetCanon: null, coreTokens: [] };
	let s = rawStreet
		.toLowerCase()
		.replace(/\bn\.\s*w\.?\b/g, 'nw')
		.replace(/\bn\.\s*e\.?\b/g, 'ne')
		.replace(/\bs\.\s*w\.?\b/g, 'sw')
		.replace(/\bs\.\s*e\.?\b/g, 'se')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!s) return { streetCanon: null, coreTokens: [] };
	const tokens = s.split(' ').map((tok) => {
		if (DIR_MAP[tok]) return DIR_MAP[tok]!;
		if (EXTRA_STREET_SUFFIX_MAP[tok]) return EXTRA_STREET_SUFFIX_MAP[tok]!;
		return tok;
	});
	// Deduplicate adjacent repeated suffix (e.g. "extension extension")
	const deduped: string[] = [];
	for (const t of tokens) {
		if (deduped[deduped.length - 1] !== t) deduped.push(t);
	}
	const streetCanon = deduped.join(' ').trim();
	const coreTokens = deduped.filter(
		(t) => t.length >= 4 && !/^\d+$/.test(t) && !GENERIC_STREET_CORE_WORDS.has(t),
	);
	return { streetCanon: streetCanon || null, coreTokens };
}

function parseLocationFingerprint(row: {
	raw: string;
	city: string | null;
	state: string | null;
	country: string | null;
	geo_key: string;
	lat: number | null;
	lon: number | null;
}): ParsedLocFingerprint {
	const raw = String(row.raw || '').trim();
	const isPoBox = PO_BOX_RE.test(raw);
	const norm = normalizeLocationRecord({
		raw,
		city: row.city,
		state: row.state,
		country: row.country,
	});
	const city = norm.city ? norm.city.trim() : row.city ? String(row.city).trim() : null;
	const state = norm.state ? norm.state.trim().toUpperCase() : row.state ? String(row.state).trim().toUpperCase() : null;
	const country = norm.country ? norm.country.trim() : row.country ? String(row.country).trim() : null;
	const zipM = raw.match(ZIP5_RE);
	const zip = zipM ? zipM[1]! : null;
	const keys = extractAddressProximityKeys(raw, row.geo_key);
	const suiteToken = extractSuiteFloorToken(raw);

	// Also handle street formats edgeWeights didn't strip city from (e.g. "6621 N. Meridian Avenue, Oklahoma City, OK 73116")
	const firstSegment = raw.split(',')[0]?.trim() || raw;
	const segKeys = firstSegment !== raw ? extractAddressProximityKeys(firstSegment, row.geo_key) : keys;
	const houseNumber = isPoBox ? null : segKeys.houseNumber || keys.houseNumber;
	const rawStreet = isPoBox ? null : segKeys.street || keys.street;
	const { streetCanon, coreTokens } = canonicalizeStreet(rawStreet);
	const buildingName = isPoBox ? null : keys.buildingName || segKeys.buildingName;

	const localeKey =
		city && state
			? `${normalizeText(city)}|${state.toLowerCase()}`
			: zip
				? `zip:${zip}`
				: row.geo_key || '';

	let buildingFingerprint: string | null = null;
	if (!isPoBox) {
		if (houseNumber && streetCanon && localeKey) {
			buildingFingerprint = `addr:${houseNumber.toLowerCase()}|${streetCanon}|${localeKey}`;
		} else if (buildingName && localeKey) {
			buildingFingerprint = `bldg:${normalizeText(buildingName)}|${localeKey}`;
		}
	}

	return {
		raw,
		city,
		state,
		country,
		geoKey: String(row.geo_key || ''),
		lat: typeof row.lat === 'number' && Number.isFinite(row.lat) ? row.lat : null,
		lon: typeof row.lon === 'number' && Number.isFinite(row.lon) ? row.lon : null,
		zip,
		isPoBox,
		houseNumber: houseNumber ? houseNumber.toLowerCase() : null,
		streetCanon,
		streetCoreTokens: coreTokens,
		buildingName,
		suiteToken,
		buildingFingerprint,
	};
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 3958.8;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sameLocale(a: ParsedLocFingerprint, b: ParsedLocFingerprint): boolean {
	if (a.city && b.city && a.state && b.state) {
		return (
			a.city.toLowerCase() === b.city.toLowerCase() &&
			a.state.toUpperCase() === b.state.toUpperCase()
		);
	}
	if (a.zip && b.zip && a.zip === b.zip) return true;
	if (a.geoKey && b.geoKey && a.geoKey === b.geoKey && !/^country:/i.test(a.geoKey)) return true;
	return false;
}

function formatStreetLabel(streetCanon: string): string {
	return streetCanon
		.split(' ')
		.map((w) =>
			/^(?:n|s|e|w|ne|nw|se|sw)$/.test(w)
				? w.toUpperCase()
				: w.charAt(0).toUpperCase() + w.slice(1),
		)
		.join(' ');
}

function formatSuiteLabel(suiteToken: string | null): string | null {
	if (!suiteToken) return null;
	const [kind, val] = suiteToken.split(':');
	if (!kind || !val) return null;
	return `${kind.charAt(0).toUpperCase() + kind.slice(1)} ${val.toUpperCase()}`;
}

export function findNearbyProfilesForProfile(
	profileId: string,
	opts?: {
		mode?: NearbyMode;
		limit?: number;
	},
	dbOverride?: DatabaseSync,
): ProfileNearbyResult {
	const db = dbOverride ?? getProfilesDb();
	const mode: NearbyMode = opts?.mode === 'same_building' ? 'same_building' : 'nearby';
	const limit = Math.max(5, Math.min(200, Number(opts?.limit || 120)));

	const srcRows = db
		.prepare(
			`SELECT raw, city, state, country, geo_key, lat, lon
       FROM profile_locations
       WHERE profile_id = ?`,
		)
		.all(profileId) as Array<{
		raw: string;
		city: string | null;
		state: string | null;
		country: string | null;
		geo_key: string;
		lat: number | null;
		lon: number | null;
	}>;

	const srcParsed = srcRows
		.map(parseLocationFingerprint)
		.filter((l) => !isTooGenericLocation(l));

	const connectedIds = new Set<string>();
	const linkedPeerInfo = new Map<
		string,
		{
			linkId: string;
			relationType: string;
			roleLabel: string | null;
			evidenceNote: string | null;
			proximityCue: 'same_building' | 'nearby' | null;
			peer: {
				id: string;
				slug: string;
				name: string;
				profileType: ProfileType;
				status: string;
				summary: string | null;
				metadataJson: string | null;
			};
		}
	>();
	for (const r of db
		.prepare(
			`SELECT pl.id AS link_id, pl.from_profile_id, pl.to_profile_id, pl.relation_type, pl.role_label, pl.evidence_note,
              p.id AS peer_id, p.slug AS peer_slug, p.name AS peer_name, p.profile_type AS peer_type,
              p.status AS peer_status, p.summary AS peer_summary, p.metadata_json AS peer_meta
       FROM profile_links pl
       JOIN profiles p ON p.id = CASE WHEN pl.from_profile_id = ? THEN pl.to_profile_id ELSE pl.from_profile_id END
       WHERE (pl.from_profile_id = ? OR pl.to_profile_id = ?)
         AND p.status NOT IN ('archived', 'merged')
         AND p.profile_type != 'historic_event'`,
		)
		.all(profileId, profileId, profileId) as Array<{
		link_id: string;
		from_profile_id: string;
		to_profile_id: string;
		relation_type: string;
		role_label: string | null;
		evidence_note: string | null;
		peer_id: string;
		peer_slug: string;
		peer_name: string;
		peer_type: ProfileType;
		peer_status: string;
		peer_summary: string | null;
		peer_meta: string | null;
	}>) {
		const pid = String(r.peer_id);
		connectedIds.add(pid);
		const cue = classifyLinkProximityCue({
			relationType: r.relation_type,
			roleLabel: r.role_label,
			evidenceNote: r.evidence_note,
		});
		const prev = linkedPeerInfo.get(pid);
		if (!prev || (cue === 'same_building' && prev.proximityCue !== 'same_building') || (cue && !prev.proximityCue)) {
			linkedPeerInfo.set(pid, {
				linkId: String(r.link_id),
				relationType: String(r.relation_type || ''),
				roleLabel: r.role_label ? String(r.role_label) : null,
				evidenceNote: r.evidence_note ? String(r.evidence_note) : null,
				proximityCue: cue,
				peer: {
					id: pid,
					slug: String(r.peer_slug),
					name: String(r.peer_name),
					profileType: r.peer_type,
					status: String(r.peer_status),
					summary: r.peer_summary ? String(r.peer_summary) : null,
					metadataJson: r.peer_meta ? String(r.peer_meta) : null,
				},
			});
		}
	}

	const hasExplicitProximityLinks = [...linkedPeerInfo.values()].some((v) => v.proximityCue !== null);
	if (srcParsed.length === 0 && !hasExplicitProximityLinks) {
		return {
			mode,
			sourceLocations: [],
			counts: { sameBuilding: 0, nearby: 0 },
			sameBuildingItems: [],
			nearbyItems: [],
			items: [],
		};
	}

	// Build a fast SQL candidate query covering same city/state, same geo_key, same ZIP, and nearby coords.
	const whereClauses: string[] = [];
	const params: Array<string | number> = [profileId];

	const seenGeoKeys = new Set<string>();
	const seenCityState = new Set<string>();
	const seenZips = new Set<string>();

	for (const s of srcParsed) {
		if (s.geoKey && !/^country:/i.test(s.geoKey) && !seenGeoKeys.has(s.geoKey)) {
			seenGeoKeys.add(s.geoKey);
			whereClauses.push('pl.geo_key = ?');
			params.push(s.geoKey);
		}
		if (s.city && s.state) {
			const csKey = `${s.city.toLowerCase()}|${s.state.toUpperCase()}`;
			if (!seenCityState.has(csKey)) {
				seenCityState.add(csKey);
				whereClauses.push('(lower(pl.city) = ? AND upper(pl.state) = ?)');
				params.push(s.city.toLowerCase(), s.state.toUpperCase());
			}
		}
		if (s.zip && !seenZips.has(s.zip)) {
			seenZips.add(s.zip);
			whereClauses.push('pl.raw LIKE ?');
			params.push(`%${s.zip}%`);
		}
		if (s.lat != null && s.lon != null) {
			// ~6 miles bounding box
			whereClauses.push('(pl.lat BETWEEN ? AND ? AND pl.lon BETWEEN ? AND ?)');
			params.push(s.lat - 0.09, s.lat + 0.09, s.lon - 0.11, s.lon + 0.11);
		}
	}

	const candidateRows =
		whereClauses.length > 0
			? (db
					.prepare(
						`SELECT p.id, p.slug, p.name, p.profile_type, p.status, p.summary, p.metadata_json,
              pl.raw, pl.city, pl.state, pl.country, pl.geo_key, pl.lat, pl.lon, pl.role
       FROM profile_locations pl
       JOIN profiles p ON p.id = pl.profile_id
       WHERE p.id != ?
         AND p.status NOT IN ('archived', 'merged')
         AND p.profile_type != 'historic_event'
         AND (${whereClauses.join(' OR ')})
       LIMIT 1800`,
					)
					.all(...params) as Array<{
					id: string;
					slug: string;
					name: string;
					profile_type: ProfileType;
					status: string;
					summary: string | null;
					metadata_json: string | null;
					raw: string;
					city: string | null;
					state: string | null;
					country: string | null;
					geo_key: string;
					lat: number | null;
					lon: number | null;
					role: string | null;
				}>)
			: [];

	// Also pick up any explicit non-dismissed building_colocation alignment peers
	const buildingAlignedPeerIds = new Set<string>();
	for (const r of db
		.prepare(
			`SELECT left_profile_id, right_profile_id
       FROM alignment_candidates
       WHERE (left_profile_id = ? OR right_profile_id = ?)
         AND alignment_kind = 'building_colocation'
         AND status != 'dismissed'`,
		)
		.all(profileId, profileId) as Array<{ left_profile_id: string; right_profile_id: string | null }>) {
		if (r.left_profile_id && r.left_profile_id !== profileId) buildingAlignedPeerIds.add(String(r.left_profile_id));
		if (r.right_profile_id && r.right_profile_id !== profileId) buildingAlignedPeerIds.add(String(r.right_profile_id));
	}

	type ScoredMatch = {
		item: NearbyProfileItem;
		/** Lower = physically closer (miles or block-estimated distance). */
		distanceRank: number;
		subRank: number;
	};

	const bestSameBuilding = new Map<string, ScoredMatch>();
	const bestNearby = new Map<string, ScoredMatch>();

	const recordMatch = (map: Map<string, ScoredMatch>, match: ScoredMatch) => {
		const prev = map.get(match.item.profileId);
		if (
			!prev ||
			match.distanceRank < prev.distanceRank - 0.001 ||
			(Math.abs(match.distanceRank - prev.distanceRank) <= 0.001 && match.subRank > prev.subRank)
		) {
			map.set(match.item.profileId, match);
		}
	};

	const parseNum = (h: string | null): number | null => {
		if (!h) return null;
		const m = h.match(/^(\d+)/);
		return m ? Number(m[1]) : null;
	};

	const evalLocationPair = (
		row: {
			id: string;
			slug: string;
			name: string;
			profile_type: ProfileType;
			status: string;
			summary: string | null;
			metadata_json: string | null;
			raw: string;
			city: string | null;
			state: string | null;
			country: string | null;
			geo_key: string;
			lat: number | null;
			lon: number | null;
		},
		peerLoc: ParsedLocFingerprint,
	) => {
		const peerRawLow = peerLoc.raw.toLowerCase();
		const hasStreetAddress =
			/\d/.test(peerLoc.raw.replace(/\b\d{5}(?:-\d{4})?\b/g, '')) && !peerLoc.isPoBox;
		const isPinned = row.status === 'pinned';
		const linkInfo = linkedPeerInfo.get(row.id);

		for (const src of srcParsed) {
			const localeMatches = sameLocale(src, peerLoc);
			const distMiles =
				src.lat != null && src.lon != null && peerLoc.lat != null && peerLoc.lon != null
					? Number(haversineMiles(src.lat, src.lon, peerLoc.lat, peerLoc.lon).toFixed(2))
					: null;

			// 1. SAME BUILDING COMPLEX check
			const exactBldgFp =
				Boolean(src.buildingFingerprint && peerLoc.buildingFingerprint) &&
				src.buildingFingerprint === peerLoc.buildingFingerprint;
			const exactHouseAndCore =
				!src.isPoBox &&
				!peerLoc.isPoBox &&
				localeMatches &&
				Boolean(src.houseNumber && peerLoc.houseNumber && src.houseNumber === peerLoc.houseNumber) &&
				src.streetCoreTokens.length > 0 &&
				src.streetCoreTokens.some((tok) => peerLoc.streetCoreTokens.includes(tok));
			const veryCloseCoords = distMiles != null && distMiles <= 0.12;
			const alignedBuilding = buildingAlignedPeerIds.has(row.id) && localeMatches && hasStreetAddress;

			const makeItem = (
				proximity: NearbyProximityKind,
				proximityLabel: string,
			): NearbyProfileItem => {
				let meta: Record<string, unknown> = {};
				try {
					meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
				} catch {
					meta = {};
				}
				const countryCodes = detectProfileCountryCodes({
					name: row.name,
					profileType: row.profile_type,
					summary: row.summary || '',
					locations: [
						{
							raw: peerLoc.raw,
							city: peerLoc.city,
							state: peerLoc.state,
							country: peerLoc.country,
						},
					],
					identifiers: [],
					metadata: meta,
				});
				return {
					profileId: row.id,
					slug: row.slug,
					name: row.name,
					profileType: row.profile_type,
					countryCodes,
					address: peerLoc.raw,
					matchedSourceAddress: src.raw,
					proximity,
					proximityLabel,
					suiteToken: peerLoc.suiteToken,
					distanceMiles: distMiles,
					alreadyConnected: connectedIds.has(row.id),
					linkId: linkInfo?.linkId || null,
					linkRoleLabel: linkInfo?.roleLabel || null,
				};
			};

			if (exactBldgFp || exactHouseAndCore || veryCloseCoords || alignedBuilding) {
				const sameSuite =
					Boolean(src.suiteToken && peerLoc.suiteToken) && src.suiteToken === peerLoc.suiteToken;
				const suitePretty = formatSuiteLabel(peerLoc.suiteToken);
				const label = sameSuite && suitePretty
					? `Same suite · ${suitePretty}`
					: suitePretty
						? `Same building · ${suitePretty}`
						: distMiles != null && veryCloseCoords
							? `Same complex (${distMiles < 0.05 ? '<0.1' : distMiles} mi)`
							: 'Same building';
				const distRank = sameSuite
					? 0.0
					: distMiles != null
						? distMiles
						: exactBldgFp
							? 0.02
							: exactHouseAndCore
								? 0.03
								: 0.05;
				recordMatch(bestSameBuilding, {
					item: makeItem('same_building', label),
					distanceRank: distRank,
					subRank: (isPinned ? 20 : 0) + (connectedIds.has(row.id) ? 10 : 0) + (row.summary?.length || 0) / 1000,
				});
				continue;
			}

			// 2. NEARBY check — ranked strictly by closest distance first
			if (distMiles != null && distMiles <= 5.0) {
				const label = `${distMiles < 0.1 ? '<0.1' : distMiles.toFixed(1)} mi away`;
				recordMatch(bestNearby, {
					item: makeItem('nearby_coords', label),
					distanceRank: distMiles,
					subRank: (isPinned ? 20 : 0) + (hasStreetAddress ? 10 : 0),
				});
				continue;
			}

			// Same street or corridor mention in the same city/state (e.g. "6525 N. Meridian" vs "6621 N. Meridian")
			const exactStreetMatch =
				!src.isPoBox &&
				!peerLoc.isPoBox &&
				localeMatches &&
				Boolean(src.streetCanon && peerLoc.streetCanon && src.streetCanon === peerLoc.streetCanon);
			const coreStreetTokenMatch =
				!src.isPoBox &&
				localeMatches &&
				src.streetCoreTokens.length > 0 &&
				src.streetCoreTokens.some(
					(tok) =>
						peerLoc.streetCoreTokens.includes(tok) ||
						new RegExp(`\\b${tok}\\b`, 'i').test(peerRawLow),
				);
			const mentionsSourceHouseOnCorridor =
				!src.isPoBox &&
				localeMatches &&
				Boolean(src.houseNumber) &&
				src.streetCoreTokens.some((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(peerRawLow)) &&
				new RegExp(`\\b${src.houseNumber}\\b`).test(peerRawLow);

			if (exactStreetMatch || coreStreetTokenMatch || mentionsSourceHouseOnCorridor) {
				const streetLabel = src.streetCanon
					? formatStreetLabel(src.streetCanon)
					: src.streetCoreTokens[0] || 'same street';
				const srcNum = parseNum(src.houseNumber);
				// Also extract a street number sitting directly before a matching street token in free-text locations (e.g. "Lake Park Tower, 6525 N. Meridian")
				let peerNum = parseNum(peerLoc.houseNumber);
				if (peerNum == null && src.streetCoreTokens.length > 0) {
					for (const tok of src.streetCoreTokens) {
						const m = peerRawLow.match(new RegExp(`\\b(\\d{2,6})\\s+(?:[nsewb.]{1,4}\\s+)?${tok}\\b`, 'i'));
						if (m) {
							peerNum = Number(m[1]);
							break;
						}
					}
				}
				const blockDelta = srcNum != null && peerNum != null ? Math.abs(srcNum - peerNum) : null;
				// ~1000 street numbers ≈ 1 mile; ~100 numbers ≈ 1 block (~0.1 mi)
				const estMiles = mentionsSourceHouseOnCorridor
					? 0.14
					: blockDelta != null
						? Math.max(0.08, Math.min(4.5, Number((blockDelta / 1000).toFixed(2))))
						: src.zip && peerLoc.zip === src.zip
							? 0.55
							: exactStreetMatch
								? 1.1
								: 1.35;
				const label = mentionsSourceHouseOnCorridor
					? `Same corridor · near ${src.houseNumber} ${streetLabel}`
					: blockDelta != null && blockDelta <= 250
						? `Same block · ${streetLabel}`
						: `Same street · ${streetLabel}`;
				recordMatch(bestNearby, {
					item: makeItem('same_street', label),
					distanceRank: estMiles,
					subRank: (isPinned ? 20 : 0) + (connectedIds.has(row.id) ? 12 : 0) + (hasStreetAddress ? 10 : 0),
				});
				continue;
			}

			// Same 5-digit ZIP code in same state
			if (src.zip && peerLoc.zip && src.zip === peerLoc.zip && (!src.state || !peerLoc.state || src.state === peerLoc.state)) {
				const estMiles = linkInfo?.proximityCue === 'nearby' ? 0.7 : hasStreetAddress ? 1.05 : 1.55;
				recordMatch(bestNearby, {
					item: makeItem('same_zip', `Same ZIP · ${src.zip}`),
					distanceRank: estMiles,
					subRank: (isPinned ? 20 : 0) + (connectedIds.has(row.id) ? 12 : 0) + (peerLoc.isPoBox ? -15 : 0),
				});
				continue;
			}

			// Nearby ZIP code in the same city & state (e.g. 73116 <-> 73118, 73112, 73132)
			if (localeMatches && src.zip && peerLoc.zip && hasStreetAddress) {
				const zipDiff = Math.abs(Number(src.zip) - Number(peerLoc.zip));
				if (Number.isFinite(zipDiff) && zipDiff > 0 && zipDiff <= 20) {
					const estMiles = Number((1.75 + zipDiff * 0.08).toFixed(2));
					recordMatch(bestNearby, {
						item: makeItem('same_zip', `Nearby · ZIP ${peerLoc.zip}`),
						distanceRank: estMiles,
						subRank: (isPinned ? 20 : 0) + (connectedIds.has(row.id) ? 12 : 0) + (row.summary?.length || 0) / 1000,
					});
					continue;
				}
			}

			// Same city fallback (lower priority than street/ZIP/coords)
			if (localeMatches && src.city) {
				const cityLabel = src.state ? `${src.city}, ${src.state}` : src.city;
				recordMatch(bestNearby, {
					item: makeItem('same_city', `Same city · ${cityLabel}`),
					distanceRank: hasStreetAddress ? 4.5 : 6.0,
					subRank: (isPinned ? 20 : 0) + (row.summary?.length || 0) / 1000,
				});
			}
		}
	};

	for (const row of candidateRows) {
		const peerLoc = parseLocationFingerprint(row);
		if (isTooGenericLocation(peerLoc)) continue;
		evalLocationPair(row, peerLoc);
	}

	// Include explicit proximity links from profile_links (e.g. corridor / near / same-building links),
	// evaluating their actual addresses first so closer corridor addresses (like 6525 N. Meridian or same-ZIP 73116)
	// sort ahead of farther corridor addresses (like 73118 / 73112 / 73132).
	const srcZipsNum = srcParsed
		.map((s) => (s.zip ? Number(s.zip) : null))
		.filter((n): n is number => n != null && Number.isFinite(n));

	for (const [peerId, info] of linkedPeerInfo.entries()) {
		if (!info.proximityCue) continue;
		const peerLocRows = db
			.prepare(
				`SELECT raw, city, state, country, geo_key, lat, lon FROM profile_locations
         WHERE profile_id = ?
         ORDER BY confirmed DESC, CASE role WHEN 'hq' THEN 0 WHEN 'residence' THEN 1 ELSE 2 END, length(raw) DESC
         LIMIT 4`,
			)
			.all(peerId) as Array<{
			raw: string;
			city: string | null;
			state: string | null;
			country: string | null;
			geo_key: string;
			lat: number | null;
			lon: number | null;
		}>;

		// Run full address proximity check on all locations of this linked peer (catches candidate-status peers like Lake Park Tower at 6525 N. Meridian!)
		for (const plRow of peerLocRows) {
			const parsed = parseLocationFingerprint(plRow);
			if (isTooGenericLocation(parsed)) continue;
			evalLocationPair(
				{
					id: peerId,
					slug: info.peer.slug,
					name: info.peer.name,
					profile_type: info.peer.profileType,
					status: info.peer.status,
					summary: info.peer.summary,
					metadata_json: info.peer.metadataJson,
					...plRow,
				},
				parsed,
			);
		}

		const topLoc = peerLocRows[0] || null;
		let meta: Record<string, unknown> = {};
		try {
			meta = info.peer.metadataJson ? (JSON.parse(info.peer.metadataJson) as Record<string, unknown>) : {};
		} catch {
			meta = {};
		}
		const countryCodes = detectProfileCountryCodes({
			name: info.peer.name,
			profileType: info.peer.profileType,
			summary: info.peer.summary || '',
			locations: topLoc ? [topLoc] : [],
			identifiers: [],
			metadata: meta,
		});

		// Estimate corridor distance via ZIP proximity when not already scored closer by exact street/coords
		const peerZipM = String(topLoc?.raw || '').match(ZIP5_RE);
		const peerZipNum = peerZipM ? Number(peerZipM[1]) : null;
		let zipEstMiles = 2.4;
		if (peerZipNum != null && srcZipsNum.length > 0) {
			const minDiff = Math.min(...srcZipsNum.map((z) => Math.abs(z - peerZipNum)));
			zipEstMiles = minDiff === 0 ? 0.7 : Math.min(3.8, Number((1.7 + minDiff * 0.06).toFixed(2)));
		}

		const item: NearbyProfileItem = {
			profileId: peerId,
			slug: info.peer.slug,
			name: info.peer.name,
			profileType: info.peer.profileType,
			countryCodes,
			address: topLoc?.raw || '',
			matchedSourceAddress: srcParsed[0]?.raw || '',
			proximity: info.proximityCue === 'same_building' ? 'same_building' : 'linked_nearby',
			proximityLabel: info.proximityCue === 'same_building' ? 'Same building' : 'Nearby',
			suiteToken: topLoc?.raw ? extractSuiteFloorToken(topLoc.raw) : null,
			distanceMiles: null,
			alreadyConnected: true,
			linkId: info.linkId,
			linkRoleLabel: info.roleLabel,
		};
		if (info.proximityCue === 'same_building') {
			recordMatch(bestSameBuilding, {
				item,
				distanceRank: 0.04,
				subRank: (info.peer.status === 'pinned' ? 20 : 0) + 15,
			});
		} else if (!bestSameBuilding.has(peerId)) {
			recordMatch(bestNearby, {
				item,
				distanceRank: zipEstMiles,
				subRank: (info.peer.status === 'pinned' ? 20 : 0) + (topLoc?.raw ? 12 : 0),
			});
		}
	}

	// Remove exact same-building profiles from the Nearby list so the two sections stay distinct
	for (const pid of bestSameBuilding.keys()) {
		bestNearby.delete(pid);
	}

	const sortClosestFirst = (a: ScoredMatch, b: ScoredMatch) =>
		a.distanceRank - b.distanceRank ||
		b.subRank - a.subRank ||
		a.item.name.localeCompare(b.item.name);

	const sameBuildingSorted = [...bestSameBuilding.values()].sort(sortClosestFirst);

	// For Nearby: prefer tight proximity matches (coords, same street, same ZIP, linked nearby);
	// only fill with broad same-city entries if tight nearby matches are sparse (< 12).
	const nearbyAll = [...bestNearby.values()];
	const tightNearby = nearbyAll.filter((m) => m.distanceRank < 4.0);
	const cityOnly = nearbyAll.filter((m) => m.distanceRank >= 4.0);
	const nearbyPool =
		tightNearby.length >= 12
			? tightNearby
			: [...tightNearby, ...cityOnly.sort(sortClosestFirst).slice(0, Math.max(0, 20 - tightNearby.length))];

	const nearbySorted = nearbyPool.sort(sortClosestFirst);

	const sameBuildingItems = sameBuildingSorted.slice(0, limit).map((m) => m.item);
	const nearbyItems = nearbySorted.slice(0, limit).map((m) => m.item);
	const activeItems = mode === 'same_building' ? sameBuildingItems : nearbyItems;
	return {
		mode,
		sourceLocations: srcParsed.map((s) => s.raw),
		counts: {
			sameBuilding: sameBuildingSorted.length,
			nearby: nearbySorted.length,
		},
		sameBuildingItems,
		nearbyItems,
		items: activeItems,
	};
}
