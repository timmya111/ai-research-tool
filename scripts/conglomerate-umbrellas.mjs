#!/usr/bin/env node
/**
 * Conglomerate finance umbrellas:
 * - Merge name-only / styling variants into one parent card (aliases).
 * - Keep distinct FINRA CRD (and other major-ID) registrants as separate
 *   profiles linked owned_by → umbrella.
 * - Write ## Group companies on the umbrella overview.
 *
 * Usage:
 *   node scripts/conglomerate-umbrellas.mjs
 *   node scripts/conglomerate-umbrellas.mjs --dry-run
 *   node scripts/conglomerate-umbrellas.mjs --only=wells,jpm
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, '.data/profiles/profiles.sqlite');
const dryRun = process.argv.includes('--dry-run');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg
	? new Set(
			onlyArg
				.split('=')[1]
				.split(',')
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
		)
	: null;

const pdb = new DatabaseSync(DB_PATH);

function sha256Key(parts) {
	return createHash('sha256').update(parts.map(String).join('|')).digest('hex');
}

function getBySlug(slug) {
	return pdb.prepare(`SELECT * FROM profiles WHERE slug = ?`).get(slug);
}

function getById(id) {
	return pdb.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id);
}

function majorIds(profileId) {
	return pdb
		.prepare(
			`SELECT scheme, value FROM profile_identifiers
       WHERE profile_id = ? AND lower(scheme) IN ('finra_crd','sec_cik','ticker','irs_ein','cusip','orcid','ror')`,
		)
		.all(profileId);
}

function hasFinraCrd(profileId) {
	return majorIds(profileId).some((i) => String(i.scheme).toLowerCase() === 'finra_crd');
}

function listFirmMatches(likePatterns) {
	const clauses = likePatterns.map(() => `(lower(name) LIKE ? OR lower(slug) LIKE ?)`).join(' OR ');
	const params = likePatterns.flatMap((p) => [p, p]);
	return pdb
		.prepare(
			`SELECT id, name, slug, summary FROM profiles
       WHERE profile_type = 'firm' AND (${clauses})
       ORDER BY name`,
		)
		.all(...params);
}

function addAlias(profileId, alias, aliasKind = 'other_name') {
	const norm = String(alias || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
	if (!norm) return false;
	const exists = pdb
		.prepare(
			`SELECT 1 AS ok FROM profile_aliases
       WHERE profile_id = ? AND normalized_alias = ? AND alias_kind = ?`,
		)
		.get(profileId, norm, aliasKind);
	if (exists) return false;
	if (dryRun) return true;
	try {
		pdb.prepare(
			`INSERT INTO profile_aliases(id, profile_id, alias, normalized_alias, alias_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		).run(randomUUID(), profileId, alias, norm, aliasKind, new Date().toISOString());
		return true;
	} catch {
		return false;
	}
}

function upsertOwnedBy(childId, parentId, roleLabel) {
	if (dryRun) return 'dry-run';
	const now = new Date().toISOString();
	const dedupe = sha256Key(['owned_by', childId, parentId]);
	const existing = pdb
		.prepare(
			`SELECT id FROM profile_links
       WHERE from_profile_id = ? AND to_profile_id = ? AND relation_type = 'owned_by'`,
		)
		.get(childId, parentId);
	if (existing?.id) {
		pdb.prepare(
			`UPDATE profile_links SET role_label = COALESCE(?, role_label), status = 'verified',
        confidence = MAX(confidence, 0.92), updated_at = ? WHERE id = ?`,
		).run(roleLabel, now, existing.id);
		return existing.id;
	}
	const id = randomUUID();
	pdb.prepare(
		`INSERT INTO profile_links(
       id, from_profile_id, to_profile_id, relation_type, role_label,
       start_date, end_date, status, confidence, angle, source_corpus,
       source_record_id, evidence_note, created_at, updated_at
     ) VALUES (?, ?, ?, 'owned_by', ?, NULL, NULL, 'verified', 0.92, 'corporate', 'conglomerate-umbrella', NULL, ?, ?, ?)`,
	).run(
		id,
		childId,
		parentId,
		roleLabel,
		`Conglomerate umbrella: subsidiary / operating unit of parent.`,
		now,
		now,
	);
	return id;
}

function mergeViaStore(keepId, mergeId) {
	// Dynamic import of compiled path is hard; call SQL-safe thin merge through child_process node + ts is unavailable.
	// Use HTTP merge API when server is up; else inline minimal merge using better approach:
	return null;
}

async function mergeProfilesHttp(keepId, mergeId) {
	const res = await fetch('http://127.0.0.1:3333/api/profiles/merge', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ keepId, mergeId }),
	});
	const data = await res.json().catch(() => ({}));
	return { status: res.status, data };
}

function upsertIdentifier(profileId, scheme, value) {
	if (!value) return false;
	const norm = String(value).toLowerCase().replace(/\s+/g, '');
	const exists = pdb
		.prepare(
			`SELECT 1 AS ok FROM profile_identifiers WHERE profile_id = ? AND scheme = ? AND normalized_value = ?`,
		)
		.get(profileId, scheme, norm);
	if (exists) return false;
	if (dryRun) return true;
	pdb.prepare(
		`INSERT OR IGNORE INTO profile_identifiers(id, profile_id, scheme, value, normalized_value, source_corpus)
     VALUES (?, ?, ?, ?, ?, 'conglomerate-umbrella')`,
	).run(randomUUID(), profileId, scheme, value, norm);
	return true;
}

function setNameSummary(profileId, { name, summary }) {
	if (dryRun) return;
	const now = new Date().toISOString();
	if (name != null && summary != null) {
		pdb.prepare(`UPDATE profiles SET name = ?, summary = ?, updated_at = ? WHERE id = ?`).run(
			name,
			summary,
			now,
			profileId,
		);
	} else if (name != null) {
		pdb.prepare(`UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, profileId);
	} else if (summary != null) {
		pdb.prepare(`UPDATE profiles SET summary = ?, updated_at = ? WHERE id = ?`).run(
			summary,
			now,
			profileId,
		);
	}
}

function replaceGroupCompaniesSection(summary, sectionMarkdown) {
	const prev = String(summary || '').trimEnd();
	const stripped = prev.replace(/\n*##\s+Group companies\b[\s\S]*?(?=\n##\s+|$)/i, '\n').trimEnd();
	return `${stripped}\n\n${sectionMarkdown.trim()}\n`.trim() + '\n';
}

function buildGroupSection(umbrellaName, children) {
	const lines = [
		'## Group companies',
		'',
		`Operating and registered units under the **${umbrellaName}** umbrella. Distinct FINRA CRD / major-ID registrants stay on their own cards and link here with \`owned_by\`; name-only styling variants are aliases on this profile.`,
		'',
	];
	const withCrd = children.filter((c) => c.crd);
	const without = children.filter((c) => !c.crd);
	if (withCrd.length) {
		lines.push('### Registered units (own CRD / card)', '');
		for (const c of withCrd.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`- **${c.name}** — CRD \`${c.crd}\` · \`${c.slug}\``);
		}
		lines.push('');
	}
	if (without.length) {
		lines.push('### Other related firm cards', '');
		for (const c of without.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`- **${c.name}** — \`${c.slug}\``);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Decide merge vs link:
 * - If child has finra_crd → always link owned_by (never merge into umbrella).
 * - If child has conflicting major IDs with umbrella → link.
 * - If child is name-only / empty IDs or only overlapping same values → merge candidate.
 */
function classifyMember(umbrella, member) {
	if (member.id === umbrella.id) return { action: 'self' };
	const childMajors = majorIds(member.id);
	const parentMajors = majorIds(umbrella.id);
	const childCrds = childMajors.filter((i) => i.scheme === 'finra_crd').map((i) => i.value);
	if (childCrds.length) {
		return { action: 'link', crd: childCrds.join(',') };
	}
	// Conflicting major IDs?
	for (const scheme of ['sec_cik', 'ticker', 'irs_ein', 'cusip']) {
		const cVals = new Set(
			childMajors.filter((i) => i.scheme === scheme).map((i) => String(i.value).replace(/\D/g, '').toLowerCase() || String(i.value).toLowerCase()),
		);
		const pVals = new Set(
			parentMajors.filter((i) => i.scheme === scheme).map((i) => String(i.value).replace(/\D/g, '').toLowerCase() || String(i.value).toLowerCase()),
		);
		if (cVals.size && pVals.size) {
			let overlap = false;
			for (const v of cVals) if (pVals.has(v)) overlap = true;
			if (!overlap) return { action: 'link', reason: `conflict:${scheme}` };
		}
	}
	// Holding / bank NA without CRD: link as operating unit (not merge) when name clearly subsidiary
	const n = String(member.name || '');
	if (
		/\b(bank,? n\.?a\.?|national association|clearing|securities|advisors?|brokerage|funds? management|insurance|lease|prime services|distribution|holdings? llc|private bank|asset management)\b/i.test(
			n,
		) &&
		!/^(wells fargo & company|j\.?p\.?\s*morgan chase & co\.?|jpmorgan chase & co\.?|morgan stanley|edward jones)$/i.test(
			n.trim(),
		)
	) {
		return { action: 'link', reason: 'operating-unit' };
	}
	// Pure styling / empty twin → merge
	if (childMajors.length === 0) return { action: 'merge' };
	// Same ticker/CIK as parent → merge
	return { action: 'merge' };
}

async function processFamily(spec) {
	if (only && !only.has(spec.key)) {
		console.log(`skip ${spec.key}`);
		return;
	}
	console.log(`\n=== ${spec.key}: ${spec.title} ===`);
	let umbrella = getBySlug(spec.umbrellaSlug);
	if (!umbrella) {
		console.error('missing umbrella', spec.umbrellaSlug);
		return;
	}

	// Seed official IDs onto umbrella when provided
	if (spec.seedIds && !dryRun) {
		for (const [scheme, value] of Object.entries(spec.seedIds)) {
			upsertIdentifier(umbrella.id, scheme, value);
		}
	}

	const members = [];
	const seen = new Set();
	for (const pat of spec.patterns) {
		for (const row of listFirmMatches([pat])) {
			if (seen.has(row.id)) continue;
			if (spec.excludeName && spec.excludeName(row.name, row.slug)) continue;
			seen.add(row.id);
			members.push(row);
		}
	}

	const toMerge = [];
	const toLink = [];
	for (const m of members) {
		const cls = classifyMember(umbrella, m);
		if (cls.action === 'self') continue;
		if (cls.action === 'merge') toMerge.push(m);
		else toLink.push({ ...m, crd: cls.crd || null, linkReason: cls.reason || null });
	}

	console.log(
		`members=${members.length} merge=${toMerge.length} link=${toLink.length} umbrella=${umbrella.slug}`,
	);

	// Preferred display name on umbrella
	if (spec.displayName && umbrella.name !== spec.displayName && !dryRun) {
		addAlias(umbrella.id, umbrella.name, 'former_name');
		setNameSummary(umbrella.id, { name: spec.displayName });
		umbrella = getById(umbrella.id);
	}

	for (const m of toMerge) {
		console.log(`  MERGE → ${m.slug} (${m.name})`);
		addAlias(umbrella.id, m.name, 'other_name');
		if (dryRun) continue;
		const res = await mergeProfilesHttp(umbrella.id, m.id);
		if (!res.data?.ok) {
			console.log('    merge failed', res.status, res.data?.error || res.data);
			// Fall back to link if merge blocked
			toLink.push({ ...m, crd: null, linkReason: `merge-failed:${res.data?.error || res.status}` });
		} else {
			console.log('    merged ok keep=', res.data?.profile?.slug || res.data?.keepSlug || umbrella.slug);
			// refresh umbrella id in case swap
			if (res.data?.profile?.id) umbrella = getById(res.data.profile.id) || umbrella;
			else if (res.data?.keepId) umbrella = getById(res.data.keepId) || umbrella;
		}
	}

	const linkedChildren = [];
	for (const m of toLink) {
		// skip if already merged away
		if (!getById(m.id)) continue;
		console.log(`  LINK owned_by ← ${m.slug} crd=${m.crd || '-'} (${m.linkReason || ''})`);
		upsertOwnedBy(m.id, umbrella.id, `${spec.title} group`);
		linkedChildren.push({
			name: m.name,
			slug: m.slug,
			crd: m.crd || null,
		});
		addAlias(umbrella.id, m.name, 'other_name');
	}

	// Optional predecessor cards (e.g. historic J.P. Morgan & Co.)
	if (Array.isArray(spec.predecessors)) {
		for (const predSlug of spec.predecessors) {
			const pred = getBySlug(predSlug);
			if (!pred || pred.id === umbrella.id) continue;
			console.log(`  LINK predecessor_of ← ${pred.slug}`);
			if (!dryRun) {
				const now = new Date().toISOString();
				const existing = pdb
					.prepare(
						`SELECT id FROM profile_links
             WHERE from_profile_id = ? AND to_profile_id = ? AND relation_type = 'predecessor_of'`,
					)
					.get(pred.id, umbrella.id);
				if (!existing) {
					pdb.prepare(
						`INSERT INTO profile_links(
               id, from_profile_id, to_profile_id, relation_type, role_label,
               start_date, end_date, status, confidence, angle, source_corpus,
               source_record_id, evidence_note, created_at, updated_at
             ) VALUES (?, ?, ?, 'predecessor_of', ?, NULL, NULL, 'verified', 0.9, 'corporate', 'conglomerate-umbrella', NULL, ?, ?, ?)`,
					).run(
						randomUUID(),
						pred.id,
						umbrella.id,
						'Historical predecessor',
						'Predecessor firm in conglomerate lineage',
						now,
						now,
					);
				}
				addAlias(umbrella.id, pred.name, 'former_name');
			}
			linkedChildren.push({ name: pred.name, slug: pred.slug, crd: null });
		}
	}

	// Group companies section
	const section = buildGroupSection(spec.displayName || umbrella.name, linkedChildren);
	const nextSummary = replaceGroupCompaniesSection(
		umbrella.summary || spec.summaryLead || '',
		section,
	);
	// Ensure lead exists
	let finalSummary = nextSummary;
	if (spec.summaryLead && !String(umbrella.summary || '').trim()) {
		finalSummary = `${spec.summaryLead.trim()}\n\n${section}`.trim() + '\n';
	} else if (spec.summaryLead && !/jpmorgan chase|wells fargo|morgan stanley|edward jones/i.test(String(umbrella.summary || '').slice(0, 200))) {
		// keep existing summary + group section already applied
	}
	setNameSummary(umbrella.id, { summary: finalSummary });
	console.log(`  umbrella now ${umbrella.slug} / ${getById(umbrella.id)?.name}`);
}

const FAMILIES = [
	{
		key: 'jpm',
		title: 'JPMorgan Chase',
		umbrellaSlug: 'firm:jpmorgan-chase',
		displayName: 'JPMorgan Chase & Co.',
		patterns: [
			'%jpmorgan%',
			'%jp%morgan%',
			'%j-p-morgan%',
			'%morgan%chase%',
			'%jp-morgan%',
		],
		excludeName: (name, slug) =>
			/\b(morgan stanley)\b/i.test(name) ||
			/\b(organically|morganite)\b/i.test(name) ||
			// Historical private bank predecessor — keep card, link predecessor_of separately
			slug === 'firm:j-p-morgan-co' ||
			/^j\.?\s*p\.?\s*morgan\s*&\s*co\.?$/i.test(String(name || '').trim()),
		summaryLead: `**JPMorgan Chase & Co.** is a major U.S. bank holding company (NYSE: **JPM**). The umbrella covers the Chase consumer bank franchise and J.P. Morgan wholesale / wealth / asset-management brands. Distinct FINRA-registered broker-dealers and advisers keep their own CRD cards and link here as group companies.`,
		predecessors: ['firm:j-p-morgan-co'],
	},
	{
		key: 'wells',
		title: 'Wells Fargo',
		umbrellaSlug: 'firm:wells-fargo-company',
		displayName: 'Wells Fargo & Company',
		patterns: ['%wells%fargo%', '%wells-fargo%'],
		seedIds: {
			ticker: 'WFC',
			sec_cik: '0000072971',
			irs_ein: '41-0449260',
		},
		summaryLead: `**Wells Fargo & Company** is a major U.S. bank holding company (NYSE: **WFC**). Operating banks, broker-dealers, advisers, and legacy Wachovia / A.G. Edwards channels sit under this umbrella. Distinct FINRA CRD registrants remain on their own cards with \`owned_by\` links.`,
	},
	{
		key: 'ms',
		title: 'Morgan Stanley',
		umbrellaSlug: 'firm:morgan-stanley',
		displayName: 'Morgan Stanley',
		patterns: ['%morgan%stanley%', '%morgan-stanley%'],
		excludeName: (name) => /\bjpmorgan|\bjp morgan|\bchase\b/i.test(name),
		summaryLead: `**Morgan Stanley** is a global investment bank and wealth manager (NYSE: **MS**). Broker-dealer and adviser subsidiaries with their own FINRA CRDs stay on separate cards under this umbrella.`,
	},
	{
		key: 'edwardjones',
		title: 'Edward Jones',
		umbrellaSlug: 'firm:edward-jones',
		displayName: 'Edward Jones',
		patterns: ['%edward jones%', '%edward-jones%'],
		// Do not pull A.G. Edwards / Benjamin F. Edwards (different firms / lineages)
		excludeName: (name, slug) =>
			/\ba\.?\s*g\.?\s*edwards\b/i.test(name) ||
			/\bbenjamin\b/i.test(name) ||
			/a-g-edwards|benjamin-f-edwards/i.test(slug || ''),
		summaryLead: `**Edward Jones** (CRD **250**) is a U.S. broker-dealer / adviser network headquartered in Missouri. Name styling variants fold into this umbrella; unrelated “Edwards” firms are out of scope.`,
	},
];

async function main() {
	for (const fam of FAMILIES) {
		await processFamily(fam);
	}
	console.log('\nDone', dryRun ? '(dry-run)' : '');
	try {
		pdb.close();
	} catch {
		/* ignore */
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
