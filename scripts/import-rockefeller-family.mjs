#!/usr/bin/env node
/**
 * Import the expanded Rockefeller family genealogy (1st–5th generations across all 6 branches)
 * into .data/profiles/profiles.sqlite with typed family links, then run strict identity-validated
 * enrichment (local offline Wikipedia + knowledge.sqlite + Bryan UCC) on every member.
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const rel = specifier.slice(2);
			const candidates = [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
				path.join(ROOT, 'src', `${rel}.tsx`),
				path.join(ROOT, 'src', rel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { withProfilesTransaction } = await import('../src/lib/research/profiles/db.ts');
const {
	upsertProfile,
	addAlias,
	upsertProfileLink,
	upsertSourceRecord,
	upsertTimelineEntry,
} = await import('../src/lib/research/profiles/store.ts');
const { enrichProfile } = await import('../src/lib/research/profiles/enrich.ts');

const CORPUS = 'rockefeller-genealogy';

const FAMILY_TREE = [
	// 1st & 2nd Gen anchors
	{
		slug: 'person:john-d-rockefeller',
		name: 'John D. Rockefeller',
		aliases: ['John Davison Rockefeller', 'John D. Rockefeller Sr.'],
		startDate: '1839',
		endDate: '1937',
		generation: '1st Generation',
		branch: 'Founder',
		parentSlug: null,
		summary: 'American industrialist, Standard Oil co-founder, philanthropist, and patriarch of the Rockefeller family (1st Generation).',
	},
	{
		slug: 'person:john-d-rockefeller-jr',
		name: 'John D. Rockefeller Jr.',
		aliases: ['John Davison Rockefeller Jr.'],
		startDate: '1874',
		endDate: '1960',
		generation: '2nd Generation',
		branch: 'Patriarch (2nd Gen)',
		parentSlug: 'person:john-d-rockefeller',
		summary: 'American financier and philanthropist, only son of John D. Rockefeller and father of the six 3rd-generation Rockefeller branches.',
	},

	// =========================================================================
	// 1. John D. Rockefeller III Branch
	// =========================================================================
	{
		slug: 'person:john-d-rockefeller-iii',
		name: 'John D. Rockefeller III',
		aliases: ['John Davison Rockefeller III', 'John D. Rockefeller 3rd'],
		startDate: '1906',
		endDate: '1978',
		generation: '3rd Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American philanthropist and eldest son of John D. Rockefeller Jr.; head of the John D. Rockefeller III branch of the Rockefeller family.',
	},
	{
		slug: 'person:sandra-ferry-rockefeller',
		name: 'Sandra Ferry Rockefeller',
		aliases: ['Sandra Rockefeller'],
		startDate: '1935',
		endDate: null,
		generation: '4th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:john-d-rockefeller-iii',
	},
	{
		slug: 'person:eliza-davison-messinger',
		name: 'Eliza Davison Messinger',
		aliases: [],
		startDate: '1990',
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:sandra-ferry-rockefeller',
	},
	{
		slug: 'person:jay-rockefeller',
		name: 'John D. "Jay" Rockefeller IV',
		aliases: ['Jay Rockefeller', 'John D. Rockefeller IV', 'John Davison Rockefeller IV'],
		startDate: '1937',
		endDate: null,
		generation: '4th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:john-d-rockefeller-iii',
		summary: 'American politician, former Governor and U.S. Senator from West Virginia; 4th-generation member of the John D. Rockefeller III branch.',
	},
	{
		slug: 'person:john-rockefeller-v',
		name: 'John D. Rockefeller V',
		aliases: ['John Davison Rockefeller V'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:jay-rockefeller',
	},
	{
		slug: 'person:valerie-blanchette-rockefeller',
		name: 'Valerie Blanchette Rockefeller',
		aliases: ['Valerie Rockefeller', 'Valerie Rockefeller Wayne'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:jay-rockefeller',
	},
	{
		slug: 'person:charles-percy-rockefeller',
		name: 'Charles Percy Rockefeller',
		aliases: ['Charles Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:jay-rockefeller',
	},
	{
		slug: 'person:justin-aldrich-rockefeller',
		name: 'Justin Aldrich Rockefeller',
		aliases: ['Justin Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:jay-rockefeller',
	},
	{
		slug: 'person:hope-aldrich-rockefeller',
		name: 'Hope Aldrich Rockefeller',
		aliases: ['Hope Aldrich', 'Hope Rockefeller Spencer'],
		startDate: '1938',
		endDate: null,
		generation: '4th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:john-d-rockefeller-iii',
	},
	{
		slug: 'person:david-hooker-spencer',
		name: 'David Hooker Spencer',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:hope-aldrich-rockefeller',
	},
	{
		slug: 'person:benjamin-murray-spencer',
		name: 'Benjamin Murray Spencer',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:hope-aldrich-rockefeller',
	},
	{
		slug: 'person:theodore-spencer',
		name: 'Theodore Spencer',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:hope-aldrich-rockefeller',
	},
	{
		slug: 'person:alida-ferry-rockefeller-messinger',
		name: 'Alida Ferry Rockefeller Messinger',
		aliases: ['Alida Messinger', 'Alida Rockefeller Messinger'],
		startDate: '1949',
		endDate: null,
		generation: '4th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:john-d-rockefeller-iii',
	},
	{
		slug: 'person:eric-john-dayton',
		name: 'Eric John Dayton',
		aliases: ['Eric Dayton'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:alida-ferry-rockefeller-messinger',
	},
	{
		slug: 'person:andrew-rockefeller-dayton',
		name: 'Andrew Rockefeller Dayton',
		aliases: ['Andrew Dayton'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'John D. Rockefeller III Branch',
		parentSlug: 'person:alida-ferry-rockefeller-messinger',
	},

	// =========================================================================
	// 2. Nelson Aldrich Rockefeller Branch
	// =========================================================================
	{
		slug: 'person:nelson-aldrich-rockefeller',
		name: 'Nelson Aldrich Rockefeller',
		aliases: ['Nelson Rockefeller'],
		startDate: '1908',
		endDate: '1979',
		generation: '3rd Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American businessman, philanthropist, Governor of New York, and 41st Vice President of the United States; head of the Nelson Aldrich Rockefeller branch.',
	},
	{
		slug: 'person:rodman-clark-rockefeller',
		name: 'Rodman Clark Rockefeller',
		aliases: ['Rodman Rockefeller'],
		startDate: '1932',
		endDate: '2000',
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:meile-louise-rockefeller',
		name: 'Meile Louise Rockefeller',
		aliases: ['Meile Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:rodman-clark-rockefeller',
	},
	{
		slug: 'person:peter-clark-rockefeller',
		name: 'Peter Clark Rockefeller',
		aliases: ['Peter Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:rodman-clark-rockefeller',
	},
	{
		slug: 'person:stuart-alexander-rockefeller',
		name: 'Stuart Alexander Rockefeller',
		aliases: ['Stuart Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:rodman-clark-rockefeller',
	},
	{
		slug: 'person:michael-sorum-rockefeller',
		name: 'Michael Sorum Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:rodman-clark-rockefeller',
	},
	{
		slug: 'person:ann-clark-rockefeller-roberts',
		name: 'Ann Clark Rockefeller Roberts',
		aliases: ['Ann Rockefeller Roberts', 'Ann Clark Rockefeller'],
		startDate: '1934',
		endDate: '2016',
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:clare-marie-pierson',
		name: 'Clare Marie Pierson',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:ann-clark-rockefeller-roberts',
	},
	{
		slug: 'person:joseph-anthony-pierson',
		name: 'Joseph Anthony Pierson',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:ann-clark-rockefeller-roberts',
	},
	{
		slug: 'person:mary-louise-pierson',
		name: 'Mary Louise Pierson',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:ann-clark-rockefeller-roberts',
	},
	{
		slug: 'person:rachel-ann-gumina',
		name: 'Rachel Ann Gumina',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:ann-clark-rockefeller-roberts',
	},
	{
		slug: 'person:steven-clark-rockefeller',
		name: 'Steven Clark Rockefeller',
		aliases: ['Steven Rockefeller', 'Steven C. Rockefeller'],
		startDate: '1936',
		endDate: null,
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:steven-clark-rockefeller-jr',
		name: 'Steven Clark Rockefeller Jr.',
		aliases: ['Steven Rockefeller Jr.'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:steven-clark-rockefeller',
	},
	{
		slug: 'person:ingrid-rasmussen-rockefeller',
		name: 'Ingrid Rasmussen Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:steven-clark-rockefeller',
	},
	{
		slug: 'person:jennifer-rasmussen-rockefeller',
		name: 'Jennifer Rasmussen Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:steven-clark-rockefeller',
	},
	{
		slug: 'person:michael-clark-rockefeller',
		name: 'Michael Clark Rockefeller',
		aliases: ['Michael Rockefeller'],
		startDate: '1938',
		endDate: '1961',
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:mary-clark-rockefeller',
		name: 'Mary Clark Rockefeller',
		aliases: ['Mary Rockefeller', 'Mary Rockefeller Morgan'],
		startDate: '1938',
		endDate: null,
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:laura-selene-rockefeller',
		name: 'Laura Selene Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:mary-clark-rockefeller',
	},
	{
		slug: 'person:nelson-aldrich-rockefeller-jr',
		name: 'Nelson Aldrich Rockefeller Jr.',
		aliases: ['Nelson Rockefeller Jr.'],
		startDate: '1964',
		endDate: null,
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},
	{
		slug: 'person:mark-fitler-rockefeller',
		name: 'Mark Fitler Rockefeller',
		aliases: ['Mark Rockefeller'],
		startDate: '1967',
		endDate: null,
		generation: '4th Generation',
		branch: 'Nelson Aldrich Rockefeller Branch',
		parentSlug: 'person:nelson-aldrich-rockefeller',
	},

	// =========================================================================
	// 3. Laurance Spelman Rockefeller Branch
	// =========================================================================
	{
		slug: 'person:laurance-spelman-rockefeller',
		name: 'Laurance Spelman Rockefeller',
		aliases: ['Laurance Rockefeller'],
		startDate: '1910',
		endDate: '2004',
		generation: '3rd Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American businessman, financier, venture capitalist, philanthropist, and conservationist; head of the Laurance Spelman Rockefeller branch.',
	},
	{
		slug: 'person:laura-spelman-rockefeller-chasin',
		name: 'Laura Spelman Rockefeller Chasin',
		aliases: ['Laura Rockefeller Chasin', 'Laura Chasin'],
		startDate: '1936',
		endDate: '2015',
		generation: '4th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-spelman-rockefeller',
	},
	{
		slug: 'person:peter-rockefeller-case',
		name: 'Peter Rockefeller Case',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laura-spelman-rockefeller-chasin',
	},
	{
		slug: 'person:matthew-owen-case',
		name: 'Matthew Owen Case',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laura-spelman-rockefeller-chasin',
	},
	{
		slug: 'person:jessica-case',
		name: 'Jessica Case',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laura-spelman-rockefeller-chasin',
	},
	{
		slug: 'person:marion-french-rockefeller',
		name: 'Marion French Rockefeller',
		aliases: ['Marion Rockefeller Weber'],
		startDate: '1938',
		endDate: null,
		generation: '4th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-spelman-rockefeller',
	},
	{
		slug: 'person:rachel-french-weber',
		name: 'Rachel French Weber',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:marion-french-rockefeller',
	},
	{
		slug: 'person:elizabeth-parmly-weber',
		name: 'Elizabeth Parmly Weber',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:marion-french-rockefeller',
	},
	{
		slug: 'person:lucy-rockefeller-waletzky',
		name: 'Dr. Lucy Rockefeller Waletzky',
		aliases: ['Lucy Rockefeller Waletzky', 'Lucy Waletzky'],
		startDate: '1941',
		endDate: null,
		generation: '4th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-spelman-rockefeller',
	},
	{
		slug: 'person:jacob-peter-waletzky',
		name: 'Jacob Peter Waletzky',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:lucy-rockefeller-waletzky',
	},
	{
		slug: 'person:naomi-french-waletzky',
		name: 'Naomi French Waletzky',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:lucy-rockefeller-waletzky',
	},
	{
		slug: 'person:laurance-rockefeller-jr',
		name: 'Laurance Rockefeller Jr.',
		aliases: ['Larry Rockefeller', 'Laurance Spelman Rockefeller Jr.'],
		startDate: '1944',
		endDate: null,
		generation: '4th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-spelman-rockefeller',
	},
	{
		slug: 'person:wyatt-gordon-rockefeller',
		name: 'Wyatt Gordon Rockefeller',
		aliases: ['Wyatt Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-rockefeller-jr',
	},
	{
		slug: 'person:ryan-laurance-rockefeller',
		name: 'Ryan Laurance Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Laurance Spelman Rockefeller Branch',
		parentSlug: 'person:laurance-rockefeller-jr',
	},

	// =========================================================================
	// 4. Winthrop Rockefeller Branch
	// =========================================================================
	{
		slug: 'person:winthrop-rockefeller',
		name: 'Winthrop Rockefeller',
		aliases: [],
		startDate: '1912-05-01',
		endDate: '1973-02-22',
		generation: '3rd Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American politician, philanthropist, and Governor of Arkansas (1967–1971); head of the Winthrop Rockefeller branch.',
	},
	{
		slug: 'person:winthrop-paul-rockefeller',
		name: 'Winthrop Paul Rockefeller',
		aliases: ['Win Paul Rockefeller', 'Win Rockefeller'],
		startDate: '1948',
		endDate: '2006',
		generation: '4th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-rockefeller',
		summary: 'American politician and businessman, Lieutenant Governor of Arkansas; 4th-generation son of Winthrop Rockefeller.',
	},
	{
		slug: 'person:andrea-davidson-rockefeller',
		name: 'Andrea Davidson Rockefeller',
		aliases: [],
		startDate: '1972',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:katherine-cluett-sage-rockefeller',
		name: 'Katherine Cluett Sage Rockefeller',
		aliases: [],
		startDate: '1974',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:winthrop-paul-rockefeller-jr',
		name: 'Winthrop Paul Rockefeller Jr.',
		aliases: [],
		startDate: '1976',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:william-gordon-rockefeller',
		name: 'William Gordon Rockefeller',
		aliases: [],
		startDate: '1986',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:colin-kendrick-rockefeller',
		name: 'Colin Kendrick Rockefeller',
		aliases: [],
		startDate: '1990',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:john-alexander-camp-rockefeller',
		name: 'John Alexander Camp Rockefeller',
		aliases: [],
		startDate: '1992',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:louis-henry-rockefeller',
		name: 'Louis Henry Rockefeller',
		aliases: [],
		startDate: '1996',
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
	},
	{
		slug: 'person:grace-rockefeller',
		name: 'Grace Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Winthrop Rockefeller Branch',
		parentSlug: 'person:winthrop-paul-rockefeller',
		note: 'Adopted daughter of Winthrop Paul Rockefeller.',
	},

	// =========================================================================
	// 5. Abigail "Abby" Rockefeller Branch
	// =========================================================================
	{
		slug: 'person:abby-rockefeller-mauze',
		name: 'Abby Rockefeller Mauzé',
		aliases: ['Abigail "Abby" Rockefeller', 'Abigail Rockefeller Mauzé', 'Abby Rockefeller'],
		startDate: '1903',
		endDate: '1976',
		generation: '3rd Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American philanthropist and eldest child (only daughter) of John D. Rockefeller Jr.; head of the Abigail "Abby" Rockefeller branch.',
	},
	{
		slug: 'person:abigail-mitzi-rockefeller-milton',
		name: 'Abigail "Mitzi" Rockefeller Milton',
		aliases: ['Abby O\'Neill', 'Abby Milton O\'Neill', 'Mitzi Rockefeller Milton'],
		startDate: '1928',
		endDate: '2017',
		generation: '4th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abby-rockefeller-mauze',
	},
	{
		slug: 'person:george-dorr-oneill-jr',
		name: "George Dorr O'Neill Jr.",
		aliases: ["George O'Neill Jr."],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:abby-oneill',
		name: "Abby O'Neill",
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:david-milton-oneill',
		name: "David Milton O'Neill",
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:catherine-mauze-oneill',
		name: "Catherine Mauzé O'Neill",
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:wendy-harrison-oneill',
		name: "Wendy Harrison O'Neill",
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:peter-meriwether-oneill',
		name: "Peter Meriwether O'Neill",
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:laura-knickerbacker-simpson',
		name: 'Laura Knickerbacker Simpson',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:abby-rockefeller-simpson',
		name: 'Abby Rockefeller Simpson',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abigail-mitzi-rockefeller-milton',
	},
	{
		slug: 'person:marilyn-ellen-milton',
		name: 'Marilyn Ellen Milton',
		aliases: ['Marilyn Milton Simpson'],
		startDate: '1931',
		endDate: '1980',
		generation: '4th Generation',
		branch: 'Abigail "Abby" Rockefeller Branch',
		parentSlug: 'person:abby-rockefeller-mauze',
	},

	// =========================================================================
	// 6. David Rockefeller Branch
	// =========================================================================
	{
		slug: 'person:david-rockefeller',
		name: 'David Rockefeller',
		aliases: ['David Rockefeller Sr.'],
		startDate: '1915',
		endDate: '2017',
		generation: '3rd Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:john-d-rockefeller-jr',
		summary: 'American banker, Chase Manhattan chairman/CEO, philanthropist, and youngest son of John D. Rockefeller Jr.; head of the David Rockefeller branch.',
	},
	{
		slug: 'person:david-rockefeller-jr',
		name: 'David Rockefeller Jr.',
		aliases: [],
		startDate: '1941',
		endDate: null,
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:ariana-newell-rockefeller',
		name: 'Ariana Newell Rockefeller',
		aliases: ['Ariana Rockefeller'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller-jr',
	},
	{
		slug: 'person:camilla-rockefeller',
		name: 'Camilla Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller-jr',
	},
	{
		slug: 'person:abigail-rockefeller',
		name: 'Abigail Rockefeller',
		aliases: ['Abby Rockefeller (b. 1943)'],
		startDate: '1943',
		endDate: null,
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:christopher-rockefeller-lindstrom',
		name: 'Christopher Rockefeller Lindstrom',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:abigail-rockefeller',
	},
	{
		slug: 'person:neva-goodwin-rockefeller',
		name: 'Neva Goodwin Rockefeller',
		aliases: ['Neva Goodwin', 'Neva Rockefeller Goodwin'],
		startDate: '1944',
		endDate: null,
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:david-walter-kaiser',
		name: 'David Walter Kaiser',
		aliases: ['David Kaiser'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:neva-goodwin-rockefeller',
	},
	{
		slug: 'person:miranda-margaret-kaiser',
		name: 'Miranda Margaret Kaiser',
		aliases: ['Miranda Kaiser'],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:neva-goodwin-rockefeller',
	},
	{
		slug: 'person:margaret-peggy-dulany-rockefeller',
		name: 'Margaret "Peggy" Dulany Rockefeller',
		aliases: ['Peggy Dulany', 'Margaret Dulany'],
		startDate: '1947',
		endDate: null,
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:michael-dulany-quattrone',
		name: 'Michael Dulany Quattrone',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:margaret-peggy-dulany-rockefeller',
	},
	{
		slug: 'person:richard-gilder-rockefeller',
		name: 'Richard Gilder Rockefeller',
		aliases: ['Richard Rockefeller'],
		startDate: '1949',
		endDate: '2014',
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:clayton-anderson-rockefeller',
		name: 'Clayton Anderson Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:richard-gilder-rockefeller',
	},
	{
		slug: 'person:rebecca-anderson-rockefeller',
		name: 'Rebecca Anderson Rockefeller',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:richard-gilder-rockefeller',
	},
	{
		slug: 'person:eileen-rockefeller-growald',
		name: 'Eileen Rockefeller Growald',
		aliases: ['Eileen Rockefeller'],
		startDate: '1951',
		endDate: null,
		generation: '4th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:david-rockefeller',
	},
	{
		slug: 'person:adam-rockefeller-growald',
		name: 'Adam Rockefeller Growald',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:eileen-rockefeller-growald',
	},
	{
		slug: 'person:daniel-speier-growald',
		name: 'Daniel Speier Growald',
		aliases: [],
		startDate: null,
		endDate: null,
		generation: '5th Generation',
		branch: 'David Rockefeller Branch',
		parentSlug: 'person:eileen-rockefeller-growald',
	},
];

const slugToId = new Map();
const nameBySlug = new Map(FAMILY_TREE.map((m) => [m.slug, m.name]));

withProfilesTransaction((tx) => {
	const srId = upsertSourceRecord(
		{
			corpus: CORPUS,
			sourceRef: 'rockefeller-family-branches-gen1-to-gen5',
			title: 'Rockefeller Family Lineage (1st–5th Generations Across All 6 Branches)',
			excerpt:
				'Expanded Rockefeller family list covering John D. Rockefeller, John D. Rockefeller Jr., all six 3rd-generation branches, 4th-generation cousins, and 5th-generation great-grandchildren.',
		},
		tx,
	);

	const familyHub = upsertProfile(
		{
			profileType: 'nonprofit',
			slug: 'nonprofit:rockefeller-family',
			name: 'Rockefeller family',
			status: 'pinned',
			summary:
				'American industrial, political, financial, and philanthropic family founded by John D. Rockefeller (Standard Oil), spanning six major 3rd-generation branches (John D. III, Nelson, Laurance, Winthrop, Abby, and David) through the 4th and 5th generations.',
			sourceCorpus: CORPUS,
			metadata: {
				manualCountryCodes: ['us'],
			},
		},
		tx,
	);

	// 1. Upsert all family member profiles
	for (const m of FAMILY_TREE) {
		const parentName = m.parentSlug ? nameBySlug.get(m.parentSlug) : null;
		const defaultSummary = [
			`American member of the Rockefeller family (${m.generation}, ${m.branch})`,
			parentName ? `and child of ${parentName}` : '',
			m.note ? `— ${m.note}` : '.',
		]
			.filter(Boolean)
			.join(' ')
			.replace(/\s+\./g, '.');

		const prof = upsertProfile(
			{
				profileType: 'person',
				slug: m.slug,
				name: m.name,
				status: m.generation === '1st Generation' || m.generation === '2nd Generation' || m.generation === '3rd Generation' ? 'pinned' : 'active',
				summary: m.summary || defaultSummary,
				startDate: m.startDate,
				endDate: m.endDate,
				sourceCorpus: CORPUS,
				metadata: {
					familyBranch: m.branch,
					familyGeneration: m.generation,
					categoryTags: ['nonprofit'],
				},
			},
			tx,
		);
		slugToId.set(m.slug, prof.id);

		for (const al of m.aliases || []) {
			addAlias(
				{
					profileId: prof.id,
					alias: al,
					aliasKind: 'name',
					confidence: 0.95,
					sourceCorpus: CORPUS,
				},
				tx,
			);
		}

		// Link member -> Rockefeller family hub
		upsertProfileLink(
			{
				fromProfileId: prof.id,
				toProfileId: familyHub.id,
				relationType: 'family_or_associate',
				roleLabel: `${m.generation} · ${m.branch}`,
				status: 'verified',
				confidence: 1.0,
				angle: 'general',
				sourceCorpus: CORPUS,
				sourceRecordId: srId,
				evidenceNote: `${m.name} (${m.generation}, ${m.branch})`,
			},
			tx,
		);

		if (m.startDate) {
			upsertTimelineEntry(
				{
					profileId: prof.id,
					eventDate: m.startDate,
					title: `Born: ${m.name}`,
					summary: `${m.generation}, ${m.branch}`,
					angle: 'general',
					entryKind: 'milestone',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `rfam:born:${m.slug}`,
				},
				tx,
			);
		}
		if (m.endDate) {
			upsertTimelineEntry(
				{
					profileId: prof.id,
					eventDate: m.endDate,
					title: `Died: ${m.name}`,
					summary: `${m.generation}, ${m.branch}`,
					angle: 'general',
					entryKind: 'milestone',
					sourceCorpus: CORPUS,
					sourceRecordId: srId,
					dedupeHint: `rfam:died:${m.slug}`,
				},
				tx,
			);
		}
	}

	// 2. Link parent-child relationships
	for (const m of FAMILY_TREE) {
		if (!m.parentSlug) continue;
		const childId = slugToId.get(m.slug);
		const parentId = slugToId.get(m.parentSlug);
		if (!childId || !parentId) continue;
		upsertProfileLink(
			{
				fromProfileId: childId,
				toProfileId: parentId,
				relationType: 'family_or_associate',
				roleLabel: m.note?.includes('Adopted') ? 'Adopted child' : 'Child',
				status: 'verified',
				confidence: 1.0,
				angle: 'general',
				sourceCorpus: CORPUS,
				sourceRecordId: srId,
				evidenceNote: `${m.generation} (${m.branch}): child of ${nameBySlug.get(m.parentSlug)}`,
			},
			tx,
		);
	}
});

console.log(`[rockefeller:import] Imported ${FAMILY_TREE.length} Rockefeller family profiles & links. Starting strict identity-validated enrichment...`);

let validatedCount = 0;
let heldNotesCount = 0;
const enrichedSummaries = [];

// Enrich Rockefeller family hub + every member
const targets = ['nonprofit:rockefeller-family', ...FAMILY_TREE.map((m) => m.slug)];
for (const slug of targets) {
	const rep = await enrichProfile(slug, {
		includeWikipedia: true,
		includeBrokercheck: false,
		includeKnowledge: true,
		includeBryanUcc: true,
	});
	if (!rep) continue;
	if (rep.validatedSources > 0) {
		validatedCount += 1;
		enrichedSummaries.push({
			slug: rep.profileSlug,
			name: rep.profileName,
			validatedSources: rep.validatedSources,
			heldNotes: rep.heldNameOnlyNotes,
			fields: rep.fieldsUpdated,
		});
	}
	heldNotesCount += rep.heldNameOnlyNotes;
}

console.log(
	'[rockefeller:enrich]',
	JSON.stringify(
		{
			totalMembersImported: FAMILY_TREE.length,
			totalEnrichmentTargets: targets.length,
			validatedEnrichments: validatedCount,
			nameOnlyNotesHeld: heldNotesCount,
			enrichedProfiles: enrichedSummaries,
		},
		null,
		2,
	),
);
