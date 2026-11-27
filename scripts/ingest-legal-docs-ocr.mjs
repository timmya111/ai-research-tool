#!/usr/bin/env node
/**
 * Fetch real legal records & PDF court filings from CFPB, GovInfo USCOURTS, OSCN,
 * and CourtListener/RECAP (when COURTLISTENER_API_TOKEN is set), extract/OCR PDFs
 * into .data/legal-docs/, and sync typed FirmRelationshipEdges & timeline entries
 * into profiles.sqlite.
 *
 * Usage:
 *   node scripts/ingest-legal-docs-ocr.mjs --profile=firm:love-beal-nixon-p-c --states=OK,TX --max-docs=8
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

const { ingestLegalDocsForProfile } = await import('@/lib/research/legalDocsPipeline');

const argv = process.argv.slice(2);
const argVal = (prefix) => {
	const hit = argv.find((a) => a.startsWith(prefix));
	return hit ? hit.slice(prefix.length).trim() : '';
};

const profileKey = argVal('--profile=') || 'firm:love-beal-nixon-p-c';
const query = argVal('--query=') || undefined;
const statesRaw = argVal('--states=');
const states = statesRaw ? statesRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : ['OK', 'TX'];
const sourcesRaw = argVal('--sources=');
const sources = sourcesRaw ? sourcesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
const maxDocsPerSource = Number(argVal('--max-docs=') || 8);
const noSync = argv.includes('--no-sync');

const report = await ingestLegalDocsForProfile(profileKey, {
	query,
	states,
	sources,
	maxDocsPerSource,
	downloadPdfs: true,
	syncToProfile: !noSync,
});

console.log(
	JSON.stringify(
		{
			ok: report.ok,
			profile: `${report.profileName} (${report.profileSlug})`,
			query: report.query,
			sources: report.sources,
			cfpbSummary: report.cfpbSummary,
			docsCount: report.documents.length,
			documents: report.documents.map((d) => ({
				id: d.id,
				source: d.source,
				title: d.title,
				date: d.dateIssued,
				court: d.courtOrSource,
				method: d.extractionMethod,
				textChars: d.textChars,
				pdfPath: d.pdfPath,
				edges: d.edges.length,
			})),
			edges: report.edges,
			profileSync: report.profileSync,
		},
		null,
		2,
	),
);
