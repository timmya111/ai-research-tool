import { NextResponse } from 'next/server';
import { rejectUnlessLocalKnowledge } from '@/lib/research/knowledge/guard';
import {
	ingestLegalDocsForProfile,
	syncOcrNameMatchesToProfileLinks,
} from '@/lib/research/legalDocsPipeline';
import {
	runAutoProfileResearchPipeline,
	type AutoResearchStatus,
} from '@/lib/research/profiles/autoResearchPipeline';
import { resolveEntityStartEndDates } from '@/lib/research/profiles/dateResolver';
import { enrichProfile } from '@/lib/research/profiles/enrich';
import {
	addIdentifier,
	getProfileDetail,
	touchProfilesForUserAction,
	updateProfileFields,
} from '@/lib/research/profiles/store';
import type { EnrichSourceOutcome } from '@/lib/research/profiles/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

function emptyOutcomeCounts(): EnrichSourceOutcome['countsAdded'] {
	return {
		aliases: 0,
		identifiers: 0,
		locations: 0,
		employments: 0,
		links: 0,
		timelineEntries: 0,
		notes: 0,
	};
}

export async function POST(request: Request, context: Ctx) {
	const blocked = rejectUnlessLocalKnowledge(request);
	if (blocked) return blocked;

	const { id } = await context.params;
	const key = decodeURIComponent(String(id || '').trim());
	if (!key) {
		return NextResponse.json({ ok: false, error: 'Profile id or slug is required' }, { status: 400 });
	}

	try {
		const t0 = Date.now();
		let body: Record<string, unknown> = {};
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			/* optional body */
		}

		// Stage 1: Local validated enrichment (BrokerCheck, local Wikipedia ZIM, Free Org APIs, County Deeds/Knowledge) — NO bryan_ucc
		const report = await enrichProfile(key, {
			includeWikipedia: body.includeWikipedia !== false,
			includeBrokercheck: body.includeBrokercheck !== false,
			includeKnowledge: body.includeKnowledge !== false,
			includeBryanUcc: false,
			includeFreeOrgEnrich: body.includeFreeOrgEnrich !== false,
		});
		if (!report) {
			return NextResponse.json({ ok: false, error: 'Profile not found' }, { status: 404 });
		}

		const profileId = report.profileId;
		const fieldsSet = new Set<string>(report.fieldsUpdated);

		// Stage 2: Start & End Date Resolution (local Kiwix Wikipedia ZIM + Wikidata + prose)
		try {
			const cur = getProfileDetail(profileId);
			if (cur && (!cur.profile.startDate || !cur.profile.endDate)) {
				const dateHit = await resolveEntityStartEndDates({
					name: cur.profile.name,
					profileType: cur.profile.profileType,
					summary: cur.profile.summary,
					existingQid: cur.identifiers.find((i) => i.scheme === 'wikidata')?.value || null,
					existingWikiUrl:
						cur.identifiers.find((i) => i.scheme === 'url' && /wikipedia\.org/i.test(i.value))?.value || null,
					allowWebLookup: cur.profile.profileType !== 'region',
				});
				const addStart = !cur.profile.startDate && dateHit.startDate ? dateHit.startDate : null;
				const addEnd = !cur.profile.endDate && dateHit.endDate ? dateHit.endDate : null;
				const dateFields: string[] = [];
				if (addStart || addEnd) {
					updateProfileFields(profileId, {
						...(addStart ? { startDate: addStart } : {}),
						...(addEnd ? { endDate: addEnd } : {}),
					});
					if (addStart) dateFields.push('start_date');
					if (addEnd) dateFields.push('end_date');
					for (const f of dateFields) fieldsSet.add(f);
				}
				if (dateHit.qid) {
					addIdentifier({ profileId, scheme: 'wikidata', value: dateHit.qid, sourceCorpus: 'date-resolver' });
				}
				if (dateHit.wikiUrl) {
					addIdentifier({ profileId, scheme: 'url', value: dateHit.wikiUrl, sourceCorpus: 'date-resolver' });
				}
				report.outcomes.push({
					source: 'date_resolver',
					status: dateFields.length > 0 ? 'merged' : 'not_found',
					candidateTitle: dateHit.wikiTitle || cur.profile.name,
					candidateUrl: dateHit.wikiUrl || null,
					fieldsUpdated: dateFields,
					countsAdded: emptyOutcomeCounts(),
					note:
						dateFields.length > 0
							? `Resolved ${[addStart ? `start=${addStart}` : '', addEnd ? `end=${addEnd}` : ''].filter(Boolean).join(', ')} (${dateHit.source || 'verified'})`
							: 'No additional start/end dates needed or found.',
				});
				if (dateFields.length > 0) report.validatedSources += 1;
			}
		} catch (e: unknown) {
			report.outcomes.push({
				source: 'date_resolver',
				status: 'error',
				fieldsUpdated: [],
				countsAdded: emptyOutcomeCounts(),
				note: e instanceof Error ? e.message : String(e),
			});
		}

		// Stage 3–5: Full Auto-Research Pipeline (DB/RSS cross-checks, external APIs, web/PDF/data-layer crawl,
		// Ollama "auto" milestone & overview upgrade, and strong-validated entity discovery with start/end date gate)
		let autoResearch: AutoResearchStatus | null = null;
		if (body.includeFullFlow !== false) {
			try {
				autoResearch = await runAutoProfileResearchPipeline(profileId, {
					trigger: 'manual',
					force: true,
					skipLocalEnrich: true,
				});
				if (!autoResearch) {
					report.outcomes.push({
						source: 'internet_crawl',
						status: 'skipped',
						fieldsUpdated: [],
						countsAdded: emptyOutcomeCounts(),
						note: 'Auto-research pipeline is already running for this profile.',
					});
				} else {
				const ic = autoResearch.stages.internetCrawl;
				const ed = autoResearch.stages.entitiesDiscovered;
				const lv = autoResearch.stages.localValidation;

				const crawlFields: string[] = [];
				if (ic.milestonesAdded > 0) crawlFields.push('timeline');
				if (autoResearch.stages.summaryUpgraded) crawlFields.push('summary');
				if (lv.rssEventsLinked > 0) crawlFields.push('links');
				for (const f of crawlFields) fieldsSet.add(f);

				report.outcomes.push({
					source: 'internet_crawl',
					status:
						autoResearch.status === 'failed'
							? 'error'
							: crawlFields.length > 0 || ic.urlsCrawled > 0
								? 'merged'
								: 'not_found',
					fieldsUpdated: crawlFields,
					countsAdded: {
						...emptyOutcomeCounts(),
						timelineEntries: ic.milestonesAdded,
						links: lv.rssEventsLinked,
					},
					note:
						autoResearch.status === 'failed'
							? autoResearch.error || 'Auto-research pipeline failed'
							: `${ic.urlsCrawled} web/data crawled · ${ic.pdfsExtracted} PDFs · ${ic.dataLayersFound} data layers · +${ic.milestonesAdded} milestones${autoResearch.stages.summaryUpgraded ? ' · summary upgraded' : ''}${lv.rssEventsLinked > 0 ? ` · ${lv.rssEventsLinked} RSS events linked` : ''}`,
				});
				if (crawlFields.length > 0) {
					report.validatedSources += 1;
					report.totalsAdded.timelineEntries += ic.milestonesAdded;
					report.totalsAdded.links += lv.rssEventsLinked;
				}

				const entFields = ed.created > 0 || ed.matchedUpdated > 0 ? ['links'] : [];
				for (const f of entFields) fieldsSet.add(f);
				report.outcomes.push({
					source: 'entity_discovery',
					status: entFields.length > 0 ? 'merged' : 'not_found',
					fieldsUpdated: entFields,
					countsAdded: {
						...emptyOutcomeCounts(),
						links: ed.created + ed.matchedUpdated,
					},
					note: `${ed.extracted} extracted · ${ed.matchedUpdated} matched/updated · ${ed.created} created${ed.skippedMissingDates ? ` · ${ed.skippedMissingDates} held (missing dates)` : ''}${ed.skippedAmbiguous > 0 ? ` · ${ed.skippedAmbiguous} ambiguous skipped` : ''}`,
				});
				if (entFields.length > 0) {
					report.validatedSources += 1;
					report.totalsAdded.links += ed.created + ed.matchedUpdated;
				}
				}
			} catch (e: unknown) {
				report.outcomes.push({
					source: 'internet_crawl',
					status: 'error',
					fieldsUpdated: [],
					countsAdded: emptyOutcomeCounts(),
					note: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Stage 6: Court Filings, CFPB & OCR Documents + Counterparty Link Sync
		if (body.includeLegalDocs !== false && report.profileType !== 'historic_event' && report.profileType !== 'region') {
			try {
				const legal = await ingestLegalDocsForProfile(profileId, {
					sources: ['cfpb', 'govinfo', 'oscn'],
					maxDocsPerSource: 4,
					downloadPdfs: true,
					syncToProfile: true,
					touchProfile: false,
				});
				const ocrLinks = syncOcrNameMatchesToProfileLinks(profileId);
				const docCount = legal.documents.length;
				const linksAdded = legal.profileSync.linksUpserted + ocrLinks.linksUpserted;
				const tlAdded = legal.profileSync.timelineEntriesUpserted;
				const legalFields: string[] = [];
				if (linksAdded > 0) legalFields.push('links');
				if (tlAdded > 0) legalFields.push('timeline');
				for (const f of legalFields) fieldsSet.add(f);

				report.outcomes.push({
					source: 'legal_docs_ocr',
					status: docCount > 0 || linksAdded > 0 ? 'merged' : 'not_found',
					fieldsUpdated: legalFields,
					countsAdded: {
						...emptyOutcomeCounts(),
						links: linksAdded,
						timelineEntries: tlAdded,
					},
					note:
						docCount > 0
							? `${docCount} court/CFPB doc(s) cached${legal.cfpbSummary ? ` (${legal.cfpbSummary.totalMatching.toLocaleString()} CFPB complaints)` : ''} · ${linksAdded} counterparty link(s) synced`
							: 'No CFPB, GovInfo USCOURTS, or OSCN filings found.',
				});
				if (docCount > 0 || linksAdded > 0) {
					report.validatedSources += 1;
					report.totalsAdded.links += linksAdded;
					report.totalsAdded.timelineEntries += tlAdded;
				}
			} catch (e: unknown) {
				report.outcomes.push({
					source: 'legal_docs_ocr',
					status: 'error',
					fieldsUpdated: [],
					countsAdded: emptyOutcomeCounts(),
					note: e instanceof Error ? e.message : String(e),
				});
			}
		}

		report.fieldsUpdated = [...fieldsSet];
		report.durationMs = Date.now() - t0;

		touchProfilesForUserAction([profileId]);
		const detail = getProfileDetail(profileId);
		return NextResponse.json(
			{ ok: true, report, autoResearch, detail },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: message }, { status: 500 });
	}
}
