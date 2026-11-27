import { syncAllProfileConnections } from '@/lib/research/profiles/syncAllProfileConnections';

const dryRun = process.argv.includes('--dry-run');
const start = Date.now();
const report = syncAllProfileConnections({ dryRun });
const elapsedSec = ((Date.now() - start) / 1000).toFixed(2);

console.log(
	JSON.stringify(
		{
			dryRun,
			elapsedSec,
			orgPhrasesIndexed: report.orgPhrasesIndexed,
			profilesScanned: report.profilesScanned,
			overviewMatchesFound: report.overviewMatchesFound,
			overviewLinksWritten: report.overviewLinksWritten,
			overviewSkippedExisting: report.overviewSkippedExisting,
			ocrExtraMatchesWritten: report.ocrExtraMatchesWritten,
			ocrPipelineReport: report.ocrPipelineReport,
			landDeedReport: report.landDeedReport,
		},
		null,
		2,
	),
);

console.log('\n=== SAMPLE OVERVIEW LINKS (30) ===');
for (const s of report.sampleLinks) {
	console.log(`- ${s.from} -> ${s.to} [${s.relationType}] (${s.roleLabel})`);
	console.log(`  Note: ${s.evidenceNote}`);
}
