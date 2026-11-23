#!/usr/bin/env node
/**
 * One-shot import of chat-pasted firm founding/merger notes (CapRock → Rockefeller Group).
 * Uses the same upsertProfileTool path as the research chat agent.
 *
 * Usage: node scripts/import-chat-firm-dates-batch.mjs [--dry-run]
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
			for (const c of [
				path.join(ROOT, 'src', `${rel}.ts`),
				path.join(ROOT, 'src', rel, 'index.ts'),
			]) {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return { url: pathToFileURL(c).href, shortCircuit: true };
				}
			}
		}
		return nextResolve(specifier, context);
	},
});

const { upsertProfileTool } = await import('../src/lib/research/profileAlignmentTools.ts');
const dryRun = process.argv.includes('--dry-run');
const CORPUS = 'chat-firm-dates-batch-2026-11-23';

/** @type {import('../src/lib/research/profileAlignmentTools.ts').UpsertProfileToolArgs[]} */
const batch = [
	{
		profileType: 'firm',
		name: 'CapRock Partners',
		slug: 'firm:caprock-partners',
		startDate: '2009',
		endDate: '',
		status: 'pinned',
		summary:
			'Privately held industrial real-estate private equity firm founded in 2009 in Newport Beach, CA. Active with no end date. Independent founding; no major predecessor merger.',
		locations: [{ raw: 'Newport Beach, CA', role: 'hq' }],
		metadata: { industry: 'private_equity', sector: 'real_estate', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Take-Two Interactive',
		slug: 'firm:take-two-interactive',
		startDate: '1993-09-30',
		endDate: '',
		status: 'pinned',
		summary:
			'Take-Two Interactive Software, Inc. founded September 30, 1993. Parent of Rockstar Games. Active public company.',
		aliases: ['Take-Two Interactive Software, Inc.', 'Take-Two'],
		metadata: { industry: 'video_games', sector: 'entertainment', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'BMG Interactive',
		slug: 'firm:bmg-interactive',
		startDate: null,
		endDate: '1998-03',
		status: 'pinned',
		summary:
			'BMG Interactive assets were acquired by Take-Two in March 1998 and used to form the Rockstar Games label. Predecessor to Rockstar Games.',
		aliases: [{ alias: 'BMG Interactive', kind: 'name' }],
		links: [
			{
				peerSlug: 'firm:take-two-interactive',
				peerName: 'Take-Two Interactive',
				relationType: 'business_tie',
				roleLabel: 'Assets acquired by Take-Two (Mar 1998) → Rockstar Games label',
				startDate: '1998-03',
				endDate: '1998-03',
				createPeerIfMissing: false,
			},
		],
		metadata: { activeStatus: 'acquired', sector: 'entertainment' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rockstar Games',
		slug: 'firm:rockstar-games',
		startDate: '1998-12',
		endDate: '',
		status: 'pinned',
		summary:
			'Rockstar Games formed December 1998 in New York as a Take-Two Interactive label using assets acquired from BMG Interactive (March 1998). Active subsidiary. Multiple studios later acquired and rebranded under the Rockstar name (e.g., DMA Design → Rockstar North).',
		locations: [{ raw: 'New York, NY', role: 'hq' }],
		aliases: ['Rockstar'],
		links: [
			{
				peerSlug: 'firm:take-two-interactive',
				peerName: 'Take-Two Interactive',
				relationType: 'owned_by',
				roleLabel: 'Subsidiary of Take-Two Interactive',
				startDate: '1998-12',
			},
			{
				peerName: 'BMG Interactive',
				peerSlug: 'firm:bmg-interactive',
				relationType: 'business_tie',
				roleLabel: 'Formed using BMG Interactive assets acquired by Take-Two (Mar 1998)',
				startDate: '1998-03',
			},
			{
				peerName: 'DMA Design',
				peerSlug: 'firm:dma-design',
				relationType: 'business_tie',
				roleLabel: 'DMA Design acquired/rebranded as Rockstar North',
				note: 'Studio lineage under the Rockstar name',
			},
		],
		metadata: { industry: 'video_games', sector: 'entertainment', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Luckenbach Texas, Inc.',
		slug: 'firm:luckenbach-texas-inc',
		startDate: '1973-06-19',
		endDate: '',
		status: 'pinned',
		summary:
			'Operating corporation for Luckenbach, Texas incorporated June 19, 1973. Town settled mid-1800s; commercial operations under current operators began around 1971 when Hondo Crouch (with Guich Koock and Kathy Morgan) purchased the town/site from the Engel family. Active; Crouch family interests have continued to run it. Not a merger.',
		aliases: [
			'Luckenbach Texas',
			'Luckenbach, Texas',
			{ alias: 'Luckenbach', kind: 'name' },
		],
		locations: [{ raw: 'Luckenbach, TX', role: 'hq' }],
		metadata: { industry: 'hospitality', sector: 'music_venue', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rockwell Collins',
		slug: 'firm:rockwell-collins',
		startDate: '1933',
		endDate: '2018-11',
		status: 'pinned',
		summary:
			'Collins Radio Company founded 1933 (Arthur Collins, Cedar Rapids, IA). Merged into Rockwell International 1971–1973; spun off 2001 as independent Rockwell Collins, Inc. Independent public company ended November 2018 when acquired by United Technologies and merged with UTC Aerospace Systems to form Collins Aerospace (now a division of RTX Corporation).',
		aliases: [
			{ alias: 'Collins Radio Company', kind: 'former_name' },
			{ alias: 'Rockwell Collins, Inc.', kind: 'former_name' },
		],
		locations: [{ raw: 'Cedar Rapids, IA', role: 'hq' }],
		links: [
			{
				peerSlug: 'firm:collins-aerospace',
				peerName: 'Collins Aerospace',
				relationType: 'business_tie',
				roleLabel: 'Acquired by UTC Nov 2018 and merged into Collins Aerospace',
				startDate: '2018-11',
				endDate: '2018-11',
			},
			{
				peerSlug: 'firm:united-technologies-corporation-utc',
				peerName: 'United Technologies Corporation (UTC)',
				relationType: 'business_tie',
				roleLabel: 'Acquired by UTC (Nov 2018)',
				startDate: '2018-11',
			},
		],
		metadata: { industry: 'avionics', sector: 'aerospace_defense', activeStatus: 'merged' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Collins Aerospace',
		slug: 'firm:collins-aerospace',
		startDate: '2018',
		endDate: '',
		status: 'pinned',
		summary:
			'Collins Aerospace formed November 2018 when UTC acquired Rockwell Collins and merged it with UTC Aerospace Systems. Continues as a major operating unit of RTX Corporation (UTC merged with Raytheon in 2020; later renamed RTX). Active division — no full corporate end date.',
		aliases: ['Collins Aerospace (RTX)'],
		links: [
			{
				peerSlug: 'firm:rtx-corporation',
				peerName: 'RTX Corporation',
				relationType: 'owned_by',
				roleLabel: 'Operating unit of RTX Corporation',
				startDate: '2020',
			},
			{
				peerSlug: 'firm:rockwell-collins',
				peerName: 'Rockwell Collins',
				relationType: 'business_tie',
				roleLabel: 'Successor to Rockwell Collins (UTC acquisition Nov 2018)',
				startDate: '2018-11',
			},
			{
				peerName: 'UTC Aerospace Systems',
				peerSlug: 'firm:utc-aerospace-systems',
				relationType: 'business_tie',
				roleLabel: 'Merged with Rockwell Collins to form Collins Aerospace (2018)',
				startDate: '2018-11',
			},
		],
		metadata: {
			industry: 'avionics',
			sector: 'aerospace_defense',
			activeStatus: 'active',
			parent_sec_cik_note: 'Non-filing subsidiary of RTX; use parent_sec_cik on identifiers when set',
		},
		identifiers: [{ scheme: 'parent_sec_cik', value: '0000101829' }],
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Anthropic, PBC',
		slug: 'firm:anthropic-pbc',
		startDate: '2021-01-26',
		endDate: '',
		status: 'pinned',
		summary:
			'Anthropic, PBC incorporated January 26, 2021 as a Delaware public benefit corporation. Independent founding by former OpenAI employees (including Dario and Daniela Amodei). Active; recently filed for IPO. No predecessor merger.',
		aliases: ['Anthropic', 'Anthropic PBC'],
		locations: [{ raw: 'San Francisco, CA', role: 'associated' }],
		metadata: { industry: 'artificial_intelligence', sector: 'technology', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Tyson Foods, Inc.',
		slug: 'firm:tyson-foods-inc',
		startDate: '1935',
		endDate: '',
		status: 'pinned',
		summary:
			'John W. Tyson began a chicken hauling business in Springdale, AR in 1935. Incorporated 1947 as Tyson Feed and Hatchery, Inc.; went public 1963 as Tyson’s Foods, Inc.; renamed Tyson Foods, Inc. in 1971/1972. Active independent public company controlled by the Tyson family. Major acquisition: IBP (beef/pork) in 2001.',
		aliases: [
			'Tyson Foods',
			{ alias: 'Tyson Feed and Hatchery, Inc.', kind: 'former_name' },
			{ alias: "Tyson's Foods, Inc.", kind: 'former_name' },
		],
		locations: [{ raw: 'Springdale, AR', role: 'hq' }],
		links: [
			{
				peerName: 'IBP',
				peerSlug: 'firm:ibp',
				relationType: 'business_tie',
				roleLabel: 'Acquired IBP (beef/pork) in 2001',
				startDate: '2001',
			},
		],
		metadata: { industry: 'food_processing', sector: 'consumer_staples', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rockfish Capital',
		slug: 'firm:rockfish-capital',
		startDate: '2024-12-10',
		endDate: '',
		status: 'pinned',
		summary:
			'Rockfish Capital Partners LLC Texas LLC filing December 10, 2024. European roots; first U.S. acquisition announced 2025. Active. Independent founding; no major predecessor company identified in public records.',
		aliases: ['Rockfish Capital Partners LLC', 'Rockfish Capital Partners'],
		locations: [{ raw: 'Texas, US', role: 'associated' }],
		metadata: { industry: 'private_equity', sector: 'finance', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Clutch City Cluckers',
		slug: 'firm:clutch-city-cluckers',
		startDate: '2021-02',
		endDate: '',
		status: 'pinned',
		summary:
			'Houston food truck founded February 2021 by Ahmad Kilane; expanding with multiple locations. Active. Independent founding; described as a sister brand of Juicy Joint. No major merger.',
		aliases: ['Cluckers', 'Clutch City Cluckers'],
		locations: [{ raw: 'Houston, TX', role: 'hq' }],
		links: [
			{
				peerName: 'Juicy Joint',
				peerSlug: 'firm:juicy-joint',
				relationType: 'affiliated_with',
				roleLabel: 'Sister brand of Juicy Joint',
			},
		],
		metadata: { industry: 'restaurants', sector: 'food_service', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
	{
		profileType: 'firm',
		name: 'Rockefeller Group',
		slug: 'firm:rockefeller-group',
		startDate: '1928-12-06',
		endDate: '',
		status: 'pinned',
		summary:
			'Incorporated December 6, 1928 as Metropolitan Square Corporation by John D. Rockefeller Jr. for Rockefeller Center development; evolved into the Rockefeller Group (Rockefeller Group International, Inc. and related). Active U.S. real-estate development and management subsidiary of Mitsubishi Estate. 1989–1990s: Mitsubishi Estate acquired majority (later full) ownership.',
		aliases: [
			'Rockefeller Group International, Inc.',
			{ alias: 'Metropolitan Square Corporation', kind: 'former_name' },
		],
		locations: [{ raw: 'New York, NY', role: 'hq' }],
		links: [
			{
				peerName: 'Mitsubishi Estate',
				peerSlug: 'firm:mitsubishi-estate',
				relationType: 'owned_by',
				roleLabel: 'Subsidiary of Mitsubishi Estate (majority/full ownership from 1989–1990s)',
				startDate: '1989',
			},
		],
		metadata: { industry: 'real_estate', sector: 'real_estate', activeStatus: 'active' },
		sourceCorpus: CORPUS,
	},
];

const results = [];
for (const item of batch) {
	const res = await upsertProfileTool({ ...item, dryRun });
	results.push(res.result);
	const label = res.result?.slug || item.name;
	console.log(
		`${res.ok ? 'OK' : 'ERR'} ${res.result?.action || ''} ${label} start=${res.result?.startDate ?? '—'} end=${res.result?.endDate ?? '—'}`,
	);
	if (!res.ok) console.log(' ', res.result);
}

console.log(
	JSON.stringify(
		{
			ok: results.every((r) => r?.ok),
			dryRun,
			count: results.length,
			slugs: results.map((r) => r.slug).filter(Boolean),
		},
		null,
		2,
	),
);
