import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataRootDir } from '@/lib/research/profiles/paths';

export type PersistedChatTurn = {
	role: 'user' | 'assistant';
	content: string;
	/** Assistant turns: paired user question for per-turn Save */
	question?: string;
	toolTrace?: unknown[];
	chartUrls?: string[];
	saved?: boolean;
};

export type ChatSession = {
	id: string;
	createdAt: string;
	updatedAt: string;
	turns: PersistedChatTurn[];
};

function sessionsDir(): string {
	const dir = path.join(getDataRootDir(), 'chat-sessions');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function currentPath(): string {
	return path.join(sessionsDir(), 'current.json');
}

function archiveDir(): string {
	const dir = path.join(sessionsDir(), 'archive');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function emptySession(): ChatSession {
	const now = new Date().toISOString();
	return { id: randomUUID(), createdAt: now, updatedAt: now, turns: [] };
}

function normalizeTurn(raw: unknown): PersistedChatTurn | null {
	if (!raw || typeof raw !== 'object') return null;
	const t = raw as Record<string, unknown>;
	const role = t.role === 'user' || t.role === 'assistant' ? t.role : null;
	if (!role) return null;
	const content = String(t.content ?? '');
	const turn: PersistedChatTurn = { role, content };
	if (t.question != null) turn.question = String(t.question);
	if (Array.isArray(t.toolTrace)) turn.toolTrace = t.toolTrace;
	if (Array.isArray(t.chartUrls)) {
		turn.chartUrls = t.chartUrls.map((u) => String(u || '')).filter(Boolean);
	}
	if (typeof t.saved === 'boolean') turn.saved = t.saved;
	return turn;
}

function normalizeSession(raw: unknown): ChatSession | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Record<string, unknown>;
	const id = String(s.id || '').trim() || randomUUID();
	const createdAt = String(s.createdAt || '').trim() || new Date().toISOString();
	const updatedAt = String(s.updatedAt || '').trim() || createdAt;
	const turns = Array.isArray(s.turns)
		? s.turns.map(normalizeTurn).filter((t): t is PersistedChatTurn => Boolean(t))
		: [];
	return { id, createdAt, updatedAt, turns };
}

export function readCurrentChatSession(): ChatSession {
	const file = currentPath();
	if (!fs.existsSync(file)) {
		const session = emptySession();
		writeCurrentChatSession(session);
		return session;
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		const session = normalizeSession(parsed);
		if (session) return session;
	} catch (error) {
		console.error('[chat-session] failed to read current.json', error);
	}
	const session = emptySession();
	writeCurrentChatSession(session);
	return session;
}

export function writeCurrentChatSession(
	input: { turns: PersistedChatTurn[]; id?: string; createdAt?: string },
): ChatSession {
	const existing = (() => {
		try {
			const file = currentPath();
			if (!fs.existsSync(file)) return null;
			return normalizeSession(JSON.parse(fs.readFileSync(file, 'utf8')));
		} catch {
			return null;
		}
	})();

	const now = new Date().toISOString();
	const turns = Array.isArray(input.turns)
		? input.turns.map(normalizeTurn).filter((t): t is PersistedChatTurn => Boolean(t))
		: [];
	const session: ChatSession = {
		id: String(input.id || existing?.id || randomUUID()).trim() || randomUUID(),
		createdAt: String(input.createdAt || existing?.createdAt || now).trim() || now,
		updatedAt: now,
		turns,
	};

	const file = currentPath();
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
	fs.renameSync(tmp, file);
	return session;
}

/**
 * Archive the current session (if it has turns) and start a fresh empty one.
 */
export function startNewChatSession(): { previous: ChatSession | null; session: ChatSession } {
	const current = readCurrentChatSession();
	let previous: ChatSession | null = null;
	if (current.turns.length > 0) {
		previous = current;
		const stamp = current.createdAt.replace(/[:.]/g, '-');
		const dest = path.join(archiveDir(), `${stamp}_${current.id}.json`);
		fs.writeFileSync(dest, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
	}
	const session = emptySession();
	writeCurrentChatSession(session);
	return { previous, session };
}
