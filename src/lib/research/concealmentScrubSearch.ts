/**
 * Search local YouTube concealment-scrub archive under `.data/concealment-scrubs/`.
 * Cards, deep SCRUB-*.md notes, channel INDEX, MindUnveiled OCR digests.
 * Narration leads only — not verified facts.
 */
import fs from 'fs';
import path from 'path';

export type ConcealmentScrubSearchArgs = {
	query?: string;
	channel?: string;
	videoId?: string;
	timelinesOnly?: boolean;
	includeOcr?: boolean;
	limit?: number;
	maxCharsPerHit?: number;
};

type ScrubDoc = {
	path: string;
	kind: 'deep_scrub' | 'card' | 'ocr_digest' | 'index';
	channel: string;
	videoId: string;
	title: string;
	url: string;
	text: string;
	timelineSection: string;
};

const ROOT = () => path.join(process.cwd(), '.data', 'concealment-scrubs');

function clampLimit(n: unknown, fallback = 6): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(1, Math.min(20, Math.floor(v)));
}

function clampChars(n: unknown, fallback = 4500): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(800, Math.min(12_000, Math.floor(v)));
}

function tokenize(q: string): string[] {
	return String(q || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2 && !['the', 'and', 'for', 'from', 'that', 'this', 'with', 'video', 'videos', 'youtube'].includes(t));
}

function extractMeta(md: string): { title: string; url: string; videoId: string } {
	const title =
		(md.match(/^#\s+(.+)$/m) || [])[1]?.replace(/^Scrub\s+\S+\s+[—–-]\s*/i, '').trim() ||
		(md.match(/\*\*Title:\*\*\s*(.+)$/m) || [])[1]?.trim() ||
		'';
	const url =
		(md.match(/\*\*Source:\*\*\s*(\S+)/m) || [])[1]?.trim() ||
		(md.match(/\*\*Video:\*\*\s*(\S+)/m) || [])[1]?.trim() ||
		(md.match(/https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]{6,})/) || [])[0] ||
		'';
	let videoId = '';
	const fromUrl = url.match(/(?:youtu\.be\/|v=)([\w-]{6,})/);
	if (fromUrl) videoId = fromUrl[1];
	if (!videoId) {
		const fromPath = md.match(/\b([A-Za-z0-9_-]{11})\b/);
		videoId = fromPath?.[1] || '';
	}
	return { title, url, videoId };
}

function extractTimelineSection(md: string): string {
	const patterns = [
		/^##\s+Timeline anchors\b[\s\S]*?(?=^##\s|\Z)/im,
		/^##\s+Timeline\b[\s\S]*?(?=^##\s|\Z)/im,
		/^##\s+Timeline years[^\n]*\n[\s\S]*?(?=^##\s|\Z)/im,
		/^##\s+Period \/ year candidates[\s\S]*?(?=^##\s|\Z)/im,
		/^##\s+Chapters\b[\s\S]*?(?=^##\s|\Z)/im,
	];
	for (const re of patterns) {
		const m = md.match(re);
		if (m && m[0].trim().length > 40) return m[0].trim();
	}
	// Fallback: bullet years frequency block under AUTO cards
	const years = md.match(/##\s+Timeline years[\s\S]{0,2500}/i);
	if (years) return years[0].trim();
	return '';
}

function videoIdFromFilename(name: string): string {
	// P004-DtEVtNJ1kmQ.md / SCRUB-03-Q5VQ5ZfZ9aY.md / digest folders
	const m = name.match(/(?:^|-)([A-Za-z0-9_-]{11})(?:\.|$)/);
	return m?.[1] || '';
}

function channelFromPath(filePath: string): string {
	const parts = filePath.split(path.sep);
	const i = parts.findIndex((p) => p.startsWith('channel-') || p.startsWith('playlist-'));
	if (i >= 0) return parts[i].replace(/^channel-/, '').replace(/^playlist-/, '');
	if (/SCRUB-\d+/i.test(path.basename(filePath))) return 'deep-scrubs';
	return 'concealment-scrubs';
}

function walkMarkdownFiles(dir: string, out: string[], depth = 0): void {
	if (depth > 6 || !fs.existsSync(dir)) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (['raw', 'media', 'frames', 'node_modules'].includes(ent.name)) continue;
			walkMarkdownFiles(full, out, depth + 1);
		} else if (ent.isFile() && ent.name.endsWith('.md')) {
			out.push(full);
		}
	}
}

function loadDocs(includeOcr: boolean): ScrubDoc[] {
	const root = ROOT();
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	walkMarkdownFiles(root, files);
	const docs: ScrubDoc[] = [];
	for (const file of files) {
		const base = path.basename(file);
		const rel = path.relative(root, file);
		if (!includeOcr && rel.includes(`${path.sep}ocr${path.sep}`)) continue;
		let kind: ScrubDoc['kind'] = 'card';
		if (/^SCRUB-\d+/i.test(base)) kind = 'deep_scrub';
		else if (base === 'INDEX.md' || base === 'README.md') kind = 'index';
		else if (rel.includes(`${path.sep}ocr${path.sep}`) && base === 'digest.md') kind = 'ocr_digest';
		else if (!rel.includes(`${path.sep}cards${path.sep}`) && kind === 'card' && !/^P\d+/i.test(base)) {
			// skip misc markdown outside cards/deep unless OCR digest
			if (kind !== 'ocr_digest' && kind !== 'deep_scrub' && kind !== 'index') continue;
		}
		if (kind === 'index') continue; // searchable separately if needed; skip noise for Q&A
		let text = '';
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		if (text.length < 80) continue;
		const meta = extractMeta(text);
		const fromName = videoIdFromFilename(base) || videoIdFromFilename(path.basename(path.dirname(file)));
		const videoId = meta.videoId || fromName;
		const timelineSection = extractTimelineSection(text);
		docs.push({
			path: file,
			kind,
			channel: channelFromPath(file),
			videoId,
			title: meta.title || base.replace(/\.md$/i, ''),
			url: meta.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''),
			text,
			timelineSection,
		});
	}
	return docs;
}

function scoreDoc(doc: ScrubDoc, tokens: string[], timelinesOnly: boolean): number {
	const hay = `${doc.title}\n${doc.channel}\n${doc.videoId}\n${doc.timelineSection}\n${doc.text}`.toLowerCase();
	let score = 0;
	if (timelinesOnly && !doc.timelineSection) {
		// still allow deep scrubs / OCR period sections via weaker text year density
		const yearHits = (doc.text.match(/\b(19|20)\d{2}\b/g) || []).length;
		if (yearHits < 3) return 0;
		score += Math.min(3, yearHits / 5);
	}
	if (doc.timelineSection) score += 2;
	if (doc.kind === 'deep_scrub') score += 3;
	if (doc.kind === 'ocr_digest') score += 0.5;
	if (!tokens.length) return score || 1;
	for (const t of tokens) {
		if (doc.videoId.toLowerCase() === t) score += 8;
		if (doc.title.toLowerCase().includes(t)) score += 2;
		if (doc.channel.toLowerCase().includes(t)) score += 1;
		if (doc.timelineSection.toLowerCase().includes(t)) score += 2;
		if (hay.includes(t)) score += 1;
	}
	return score;
}

function slimHit(doc: ScrubDoc, maxChars: number, timelinesOnly: boolean): Record<string, unknown> {
	let body = timelinesOnly && doc.timelineSection ? doc.timelineSection : doc.text;
	if (timelinesOnly && !doc.timelineSection) {
		// extract year-ish lines
		const lines = doc.text.split('\n').filter((l) => /\b(19|20)\d{2}\b/.test(l));
		body = lines.slice(0, 40).join('\n') || doc.text.slice(0, maxChars);
	}
	if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n…[truncated]`;
	return {
		kind: doc.kind,
		channel: doc.channel,
		videoId: doc.videoId || null,
		title: doc.title,
		url: doc.url || null,
		path: path.relative(process.cwd(), doc.path),
		hasTimelineSection: Boolean(doc.timelineSection),
		excerpt: body,
	};
}

export async function searchConcealmentScrubs(args: ConcealmentScrubSearchArgs): Promise<{
	ok: boolean;
	result: Record<string, unknown>;
}> {
	const query = String(args.query || '').trim();
	const channel = String(args.channel || '')
		.trim()
		.toLowerCase();
	const videoId = String(args.videoId || '')
		.trim()
		.replace(/^https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)/i, '')
		.slice(0, 11);
	const timelinesOnly = Boolean(args.timelinesOnly);
	const includeOcr = Boolean(args.includeOcr);
	const limit = clampLimit(args.limit, 6);
	const maxChars = clampChars(args.maxCharsPerHit, 4500);
	const tokens = tokenize(query || videoId || channel);

	const root = ROOT();
	if (!fs.existsSync(root)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `No concealment-scrubs archive at ${root}`,
			},
		};
	}

	const docs = loadDocs(includeOcr);
	if (!docs.length) {
		return { ok: false, result: { ok: false, error: 'Scrub archive has no markdown cards yet.' } };
	}

	if (videoId) {
		const matches = docs.filter((d) => d.videoId === videoId);
		if (!matches.length) {
			return {
				ok: false,
				result: {
					ok: false,
					error: `No scrub card/OCR for videoId=${videoId}`,
					hint: 'Try query by title keywords, or list channels ControlAltHistory / MindUnveiled / …',
					totalDocs: docs.length,
				},
			};
		}
		// Prefer deep scrub over AUTO card
		matches.sort((a, b) => {
			const rank = (k: ScrubDoc['kind']) => (k === 'deep_scrub' ? 0 : k === 'card' ? 1 : 2);
			return rank(a.kind) - rank(b.kind);
		});
		return {
			ok: true,
			result: {
				ok: true,
				mode: 'videoId',
				totalDocs: docs.length,
				returned: Math.min(matches.length, limit),
				hits: matches.slice(0, limit).map((d) => slimHit(d, maxChars, timelinesOnly)),
				note: 'Local YouTube scrub archive. Claims are narration/OCR leads, not verified facts.',
			},
		};
	}

	let filtered = docs;
	if (channel) {
		filtered = filtered.filter(
			(d) =>
				d.channel.toLowerCase().includes(channel) ||
				channel.includes(d.channel.toLowerCase().slice(0, 12)),
		);
	}

	const ranked = filtered
		.map((d) => ({ d, score: scoreDoc(d, tokens, timelinesOnly) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || (a.d.kind === 'deep_scrub' ? -1 : 1))
		.slice(0, limit);

	// If query empty and timelinesOnly, return top deep scrubs with timeline sections
	if (!ranked.length && timelinesOnly) {
		const deep = docs
			.filter((d) => d.timelineSection)
			.sort((a, b) => (a.kind === 'deep_scrub' ? -1 : 1) - (b.kind === 'deep_scrub' ? -1 : 1))
			.slice(0, limit);
		return {
			ok: true,
			result: {
				ok: true,
				mode: 'timeline_browse',
				totalDocs: docs.length,
				returned: deep.length,
				hits: deep.map((d) => slimHit(d, maxChars, true)),
				channels: [...new Set(docs.map((d) => d.channel))].sort(),
				note: 'Local YouTube scrub archive. Claims are narration/OCR leads, not verified facts.',
			},
		};
	}

	return {
		ok: true,
		result: {
			ok: true,
			mode: 'search',
			query: query || null,
			filters: { channel: channel || null, timelinesOnly, includeOcr },
			totalDocs: docs.length,
			matched: ranked.length,
			returned: ranked.length,
			hits: ranked.map(({ d, score }) => ({ ...slimHit(d, maxChars, timelinesOnly), score })),
			channels: [...new Set(docs.map((d) => d.channel))].sort(),
			note: 'Local YouTube scrub archive under .data/concealment-scrubs. Prefer deep SCRUB-NN cards for full timeline tables. Narration leads ≠ verified facts.',
		},
	};
}
