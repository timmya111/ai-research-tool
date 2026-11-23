/**
 * Browse ranking for person profiles in the left-column list.
 * Lower score = higher in the list. Tech/business household names first,
 * then other familiar public figures, then curated corpora, FINRA-only last.
 *
 * Used only for `profileType === 'person'` with no text query.
 */

/** Household tech + business icons (exact order within the top band). */
export const PERSON_FAME_TECH_BUSINESS: readonly string[] = [
	'person:elon-musk',
	'person:bill-gates',
	'person:sam-altman',
	'person:peter-thiel',
	'person:alex-karp',
	'person:joe-lonsdale',
	'person:travis-kalanick',
	'person:eric-schmidt',
	'person:jerry-yang',
	'person:jack-ma',
	'person:mukesh-ambani',
	'person:carlos-slim',
	'person:richard-branson',
	'person:abigail-johnson',
	'person:lloyd-blankfein',
	'person:david-m-solomon',
	'person:henry-kravis',
	'person:j-pierpont-morgan',
	'person:john-d-rockefeller',
	'person:john-d-rockefeller-jr',
	'person:david-rockefeller',
	'person:andrew-carnegie',
	'person:klaus-schwab',
	'person:lawrence-summers',
	'person:janet-yellen',
];

/** Familiar political / Dallas / other public names (after tech/business). */
export const PERSON_FAME_FAMILIAR: readonly string[] = [
	'person:donald-trump',
	'person:joe-biden',
	'person:barack-obama',
	'person:bill-clinton',
	'person:george-w-bush',
	'person:george-h-w-bush',
	'person:jd-vance',
	'person:kamala-harris',
	'person:hillary-clinton',
	'person:ronald-reagan',
	'person:jimmy-carter',
	'person:h-ross-perot',
	'person:harlan-crow',
	'person:trammell-crow',
	'person:h-l-hunt',
	'person:sid-bass',
	'person:edward-bass',
	'person:robert-bass',
	'person:lee-bass',
	'person:tom-hicks',
	'person:stanley-marcus-neiman',
	'person:ebby-halliday',
	'person:andy-beal',
	'person:erle-p-halliburton',
	'person:lawrence-dale-bell',
	'person:larry-silverstein',
	'person:jeffrey-epstein',
	'person:ghislaine-maxwell',
	'person:ehud-barak',
];

const TECH_OFFSET = 0;
const FAMILIAR_OFFSET = 40;
/** Corpus / residual bands (must stay above FINRA band). */
export const PERSON_FAME_BAND = {
	dossier: 100,
	wikipedia: 200,
	curatedLocal: 300,
	wef: 400,
	other: 500,
	finraOnly: 900,
} as const;

function sqlStringList(slugs: readonly string[]): string {
	return slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
}

/**
 * SQL expression (integer) for person browse fame. Alias table as `p`.
 * Safe: slug lists are curated constants, not user input.
 */
export function personFameRankSql(alias = 'p'): string {
	const techCases = PERSON_FAME_TECH_BUSINESS.map(
		(slug, i) => `WHEN ${alias}.slug = '${slug.replace(/'/g, "''")}' THEN ${TECH_OFFSET + i}`,
	).join('\n      ');
	const familiarCases = PERSON_FAME_FAMILIAR.map(
		(slug, i) => `WHEN ${alias}.slug = '${slug.replace(/'/g, "''")}' THEN ${FAMILIAR_OFFSET + i}`,
	).join('\n      ');

	return `CASE
      ${techCases}
      ${familiarCases}
      WHEN ${alias}.metadata_json LIKE '%"dossierSlug"%'
        OR ${alias}.metadata_json LIKE '%entity-dossiers%' THEN ${PERSON_FAME_BAND.dossier}
      WHEN ${alias}.metadata_json LIKE '%wikipedia-local%' THEN ${PERSON_FAME_BAND.wikipedia}
      WHEN ${alias}.metadata_json LIKE '%dallas-elite%'
        OR ${alias}.metadata_json LIKE '%us-presidential%'
        OR ${alias}.metadata_json LIKE '%dynasties-power%'
        OR ${alias}.metadata_json LIKE '%rockefeller-geneal%'
        OR ${alias}.metadata_json LIKE '%lippe-biesterfeld%'
        OR ${alias}.metadata_json LIKE '%antarctic-geomagnet%'
        OR ${alias}.metadata_json LIKE '%epstein%' THEN ${PERSON_FAME_BAND.curatedLocal}
      WHEN ${alias}.metadata_json LIKE '%wef-amnc%' THEN ${PERSON_FAME_BAND.wef}
      WHEN (
        ${alias}.metadata_json LIKE '%finra-visualizer%'
        OR ${alias}.metadata_json LIKE '%finra-rosters%'
      ) AND ${alias}.metadata_json NOT LIKE '%wikipedia-local%'
        AND ${alias}.metadata_json NOT LIKE '%wef-amnc%'
        AND ${alias}.metadata_json NOT LIKE '%dallas-elite%'
        AND ${alias}.metadata_json NOT LIKE '%entity-dossiers%'
        AND ${alias}.metadata_json NOT LIKE '%"dossierSlug"%'
        AND ${alias}.metadata_json NOT LIKE '%us-presidential%'
        THEN ${PERSON_FAME_BAND.finraOnly}
      ELSE ${PERSON_FAME_BAND.other}
    END`;
}

/** Exported for tests / diagnostics. */
export function personFameSlugSet(): Set<string> {
	return new Set([...PERSON_FAME_TECH_BUSINESS, ...PERSON_FAME_FAMILIAR]);
}

export function personFameSqlListDebug(): string {
	return sqlStringList([...PERSON_FAME_TECH_BUSINESS, ...PERSON_FAME_FAMILIAR]);
}
