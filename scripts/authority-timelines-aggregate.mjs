#!/usr/bin/env node
/**
 * Rebuild promo timelines, geo-focus ranks, and digests from events.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { OUT, ensureDir, readJsonl } from './lib/authority-timelines.mjs';

const WEIGHT = {
	promo_campaign: 5,
	signed_directive: 5,
	recruitment: 4,
	joint_operation: 4,
	fact_sheet: 3,
	international_outreach: 3,
	press_release: 1,
	other: 1,
};

function geoKey(g) {
	if (g.city && g.state) return `${g.city}, ${g.state}`;
	if (g.county && g.state) return `${g.county} County, ${g.state}`;
	if (g.county) return `${g.county} County`;
	if (g.state) return g.state;
	return g.raw || 'unknown';
}

function main() {
	const eventsPath = path.join(OUT, 'events', 'events.jsonl');
	const events = readJsonl(eventsPath);
	if (!events.length) {
		console.error('No events — run authority:download first');
		process.exit(1);
	}

	// Promo / initiative timelines
	const byInit = new Map();
	for (const e of events) {
		const slug = e.initiative || (e.signals?.isPromo ? `promo:${e.agency}` : null);
		if (!slug && e.materialType !== 'signed_directive') continue;
		const key = slug || `eo:${e.id}`;
		if (!byInit.has(key)) {
			byInit.set(key, {
				initiative: key,
				label: e.initiativeLabel || e.title,
				agencies: new Set(),
				domestic: 0,
				international: 0,
				both: 0,
				unknown: 0,
				first: e.date,
				last: e.date,
				events: [],
				geos: new Map(),
			});
		}
		const row = byInit.get(key);
		row.agencies.add(e.agency);
		row[e.audience] = (row[e.audience] || 0) + 1;
		if (e.date < row.first) row.first = e.date;
		if (e.date > row.last) row.last = e.date;
		row.events.push({ id: e.id, date: e.date, title: e.title, url: e.url, audience: e.audience });
		for (const g of e.geos || []) {
			const k = geoKey(g);
			row.geos.set(k, (row.geos.get(k) || 0) + 1);
		}
	}

	const promoTimelines = [...byInit.values()]
		.map((r) => ({
			initiative: r.initiative,
			label: r.label,
			agencies: [...r.agencies],
			audienceCounts: {
				domestic: r.domestic,
				international: r.international,
				both: r.both,
				unknown: r.unknown,
			},
			first: r.first,
			last: r.last,
			eventCount: r.events.length,
			topGeos: [...r.geos.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, count]) => ({ name, count })),
			sampleEvents: r.events.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8),
		}))
		.sort((a, b) => b.eventCount - a.eventCount);

	// Geo focus
	const geoScores = new Map();
	for (const e of events) {
		const w = WEIGHT[e.materialType] || 1;
		const audienceBoost = e.audience === 'domestic' || e.audience === 'both' ? 1.2 : 1;
		for (const g of e.geos || []) {
			const key = geoKey(g);
			if (!geoScores.has(key)) {
				geoScores.set(key, {
					name: key,
					city: g.city,
					county: g.county,
					state: g.state,
					corridor: !!g.corridor,
					score: 0,
					mentions: 0,
					promoMentions: 0,
					agencies: new Set(),
				});
			}
			const row = geoScores.get(key);
			row.score += w * audienceBoost;
			row.mentions += 1;
			if (e.signals?.isPromo || e.materialType === 'promo_campaign') row.promoMentions += 1;
			row.agencies.add(e.agency);
			row.corridor = row.corridor || !!g.corridor;
		}
	}

	const geoFocus = [...geoScores.values()]
		.map((r) => ({
			...r,
			agencies: [...r.agencies],
			score: Math.round(r.score * 10) / 10,
		}))
		.sort((a, b) => b.score - a.score);

	const corridorFocus = geoFocus.filter((g) => g.corridor || g.state === 'OK' || g.state === 'TX');

	ensureDir(path.join(OUT, 'aggregates'));
	fs.writeFileSync(path.join(OUT, 'aggregates', 'promo-timelines.json'), JSON.stringify(promoTimelines, null, 2));
	fs.writeFileSync(path.join(OUT, 'aggregates', 'geo-focus.json'), JSON.stringify(geoFocus.slice(0, 200), null, 2));
	fs.writeFileSync(path.join(OUT, 'aggregates', 'ok-tx-corridor.json'), JSON.stringify(corridorFocus.slice(0, 100), null, 2));

	// Digests
	ensureDir(path.join(OUT, 'digests'));
	const byMonth = new Map();
	for (const e of events) {
		const m = String(e.date || '').slice(0, 7);
		if (!m) continue;
		if (!byMonth.has(m)) byMonth.set(m, []);
		byMonth.get(m).push(e);
	}

	const overview = [
		'# Authority initiatives timeline — overview',
		'',
		`Generated: ${new Date().toISOString()}`,
		`Events: ${events.length}`,
		`Initiatives/promo groups: ${promoTimelines.length}`,
		`Geos scored: ${geoFocus.length}`,
		`OK–TX corridor geos: ${corridorFocus.length}`,
		'',
		'## Top promo / initiative groups',
		'',
		...promoTimelines.slice(0, 15).map(
			(p) =>
				`- **${p.label}** (\`${p.initiative}\`) — ${p.eventCount} events, ${p.first} → ${p.last}; domestic=${p.audienceCounts.domestic} intl=${p.audienceCounts.international}`,
		),
		'',
		'## Heavy-focus places (national top 25)',
		'',
		...geoFocus.slice(0, 25).map((g) => `- **${g.name}** score=${g.score} mentions=${g.mentions} promo=${g.promoMentions} agencies=${g.agencies.join(',')}`),
		'',
		'## OK–TX corridor focus',
		'',
		...(corridorFocus.length
			? corridorFocus.slice(0, 25).map((g) => `- **${g.name}** score=${g.score} mentions=${g.mentions}`)
			: ['- _(no corridor geos extracted yet — expand fetch window / body text)_']),
		'',
		'## Agency counts',
		'',
	];
	const agencyCount = {};
	for (const e of events) agencyCount[e.agency] = (agencyCount[e.agency] || 0) + 1;
	for (const [a, n] of Object.entries(agencyCount).sort((x, y) => y[1] - x[1])) {
		overview.push(`- ${a}: ${n}`);
	}
	fs.writeFileSync(path.join(OUT, 'digests', 'OVERVIEW.md'), overview.join('\n') + '\n');

	for (const [month, rows] of [...byMonth.entries()].sort()) {
		const lines = [
			`# Authority timeline ${month}`,
			'',
			`Events: ${rows.length}`,
			'',
			'## Items',
			'',
		];
		for (const e of rows.sort((a, b) => b.date.localeCompare(a.date))) {
			lines.push(
				`- **${e.date}** [${e.agency}/${e.materialType}/${e.audience}] [${e.title}](${e.url})` +
					((e.geos || []).length ? ` — geos: ${e.geos.map(geoKey).join('; ')}` : ''),
			);
		}
		fs.writeFileSync(path.join(OUT, 'digests', `${month}.md`), lines.join('\n') + '\n');
	}

	// Top geo digests
	ensureDir(path.join(OUT, 'digests', 'geo'));
	for (const g of geoFocus.slice(0, 20)) {
		const slug = g.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
		const related = events.filter((e) => (e.geos || []).some((x) => geoKey(x) === g.name)).slice(0, 40);
		const lines = [
			`# Geo focus: ${g.name}`,
			'',
			`Score: ${g.score} · Mentions: ${g.mentions} · Promo mentions: ${g.promoMentions}`,
			`Agencies: ${g.agencies.join(', ')}`,
			`Corridor: ${g.corridor ? 'yes' : 'no'}`,
			'',
			'## Recent materials',
			'',
			...related.map((e) => `- ${e.date} [${e.agency}] [${e.title}](${e.url})`),
			'',
		];
		fs.writeFileSync(path.join(OUT, 'digests', 'geo', `${slug}.md`), lines.join('\n'));
	}

	console.log(
		`[aggregate] promo=${promoTimelines.length} geo=${geoFocus.length} corridor=${corridorFocus.length} months=${byMonth.size}`,
	);
}

main();
