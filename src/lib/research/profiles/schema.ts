import type { DatabaseSync } from 'node:sqlite';
import { PROFILES_SCHEMA_VERSION } from '@/lib/research/profiles/types';

export const PROFILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  profile_type TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_aliases (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'name',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_corpus TEXT,
  UNIQUE (profile_id, normalized_alias, alias_kind)
);

CREATE TABLE IF NOT EXISTS profile_identifiers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  source_corpus TEXT,
  UNIQUE (scheme, normalized_value, profile_id)
);

CREATE TABLE IF NOT EXISTS profile_locations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  city TEXT,
  county TEXT,
  state TEXT,
  country TEXT,
  geo_key TEXT NOT NULL,
  lat REAL,
  lon REAL,
  role TEXT NOT NULL DEFAULT 'associated',
  source_corpus TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (profile_id, geo_key, role)
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  corpus TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_url TEXT,
  title TEXT NOT NULL,
  published_date TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (corpus, source_ref)
);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_date TEXT,
  date_precision TEXT NOT NULL DEFAULT 'day',
  end_date TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  angle TEXT NOT NULL DEFAULT 'general',
  entry_kind TEXT NOT NULL DEFAULT 'event',
  geo_key TEXT,
  geo_label TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_corpus TEXT NOT NULL,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_links (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  from_profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  role_label TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'observed',
  confidence REAL NOT NULL DEFAULT 0.8,
  angle TEXT NOT NULL DEFAULT 'general',
  source_corpus TEXT NOT NULL,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
  evidence_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alignment_candidates (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  alignment_kind TEXT NOT NULL,
  left_profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  right_profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  score REAL NOT NULL DEFAULT 0.5,
  caution_tier TEXT NOT NULL DEFAULT 'observation',
  status TEXT NOT NULL DEFAULT 'proposed',
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_type ON profiles(profile_type);
CREATE INDEX IF NOT EXISTS idx_profiles_norm_name ON profiles(normalized_name);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_aliases_norm ON profile_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS idx_aliases_profile ON profile_aliases(profile_id);
CREATE INDEX IF NOT EXISTS idx_ident_scheme_val ON profile_identifiers(scheme, normalized_value);
CREATE INDEX IF NOT EXISTS idx_ident_profile ON profile_identifiers(profile_id);
CREATE INDEX IF NOT EXISTS idx_loc_geo ON profile_locations(geo_key);
CREATE INDEX IF NOT EXISTS idx_loc_profile ON profile_locations(profile_id);
CREATE INDEX IF NOT EXISTS idx_sources_corpus ON source_records(corpus);
CREATE INDEX IF NOT EXISTS idx_timeline_profile_date ON timeline_entries(profile_id, event_date);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(event_date);
CREATE INDEX IF NOT EXISTS idx_timeline_geo ON timeline_entries(geo_key);
CREATE INDEX IF NOT EXISTS idx_timeline_corpus ON timeline_entries(source_corpus);
CREATE INDEX IF NOT EXISTS idx_timeline_angle ON timeline_entries(angle);
CREATE INDEX IF NOT EXISTS idx_links_from ON profile_links(from_profile_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON profile_links(to_profile_id);
CREATE INDEX IF NOT EXISTS idx_links_rel ON profile_links(relation_type);
CREATE INDEX IF NOT EXISTS idx_align_left ON alignment_candidates(left_profile_id);
CREATE INDEX IF NOT EXISTS idx_align_right ON alignment_candidates(right_profile_id);
CREATE INDEX IF NOT EXISTS idx_align_status_score ON alignment_candidates(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_align_kind ON alignment_candidates(alignment_kind);
`;

const PROFILES_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS profiles_fts USING fts5(
  name,
  summary,
  slug,
  content='profiles',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS profiles_ai AFTER INSERT ON profiles BEGIN
  INSERT INTO profiles_fts(rowid, name, summary, slug) VALUES (new.rowid, new.name, new.summary, new.slug);
END;

CREATE TRIGGER IF NOT EXISTS profiles_ad AFTER DELETE ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, name, summary, slug) VALUES ('delete', old.rowid, old.name, old.summary, old.slug);
END;

CREATE TRIGGER IF NOT EXISTS profiles_au AFTER UPDATE OF name, summary, slug ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, name, summary, slug) VALUES ('delete', old.rowid, old.name, old.summary, old.slug);
  INSERT INTO profiles_fts(rowid, name, summary, slug) VALUES (new.rowid, new.name, new.summary, new.slug);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS timeline_entries_fts USING fts5(
  title,
  summary,
  angle,
  geo_label,
  content='timeline_entries',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS timeline_entries_ai AFTER INSERT ON timeline_entries BEGIN
  INSERT INTO timeline_entries_fts(rowid, title, summary, angle, geo_label)
  VALUES (new.rowid, new.title, new.summary, new.angle, COALESCE(new.geo_label, ''));
END;

CREATE TRIGGER IF NOT EXISTS timeline_entries_ad AFTER DELETE ON timeline_entries BEGIN
  INSERT INTO timeline_entries_fts(timeline_entries_fts, rowid, title, summary, angle, geo_label)
  VALUES ('delete', old.rowid, old.title, old.summary, old.angle, COALESCE(old.geo_label, ''));
END;

CREATE TRIGGER IF NOT EXISTS timeline_entries_au AFTER UPDATE OF title, summary, angle, geo_label ON timeline_entries BEGIN
  INSERT INTO timeline_entries_fts(timeline_entries_fts, rowid, title, summary, angle, geo_label)
  VALUES ('delete', old.rowid, old.title, old.summary, old.angle, COALESCE(old.geo_label, ''));
  INSERT INTO timeline_entries_fts(rowid, title, summary, angle, geo_label)
  VALUES (new.rowid, new.title, new.summary, new.angle, COALESCE(new.geo_label, ''));
END;
`;

export function migrateProfilesDb(db: DatabaseSync): void {
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(PROFILES_SCHEMA_SQL);
	try {
		db.exec(PROFILES_FTS_SQL);
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		if (!/already exists/i.test(msg)) throw error;
	}

	const locCols = db.prepare(`PRAGMA table_info(profile_locations)`).all() as Array<{ name?: string }>;
	const locColNames = new Set(locCols.map((c) => String(c.name || '')));
	if (!locColNames.has('confirmed')) {
		db.exec(`ALTER TABLE profile_locations ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0`);
	}

	const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version') as
		| { value?: string }
		| undefined;
	db.prepare(
		`INSERT INTO schema_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run('version', PROFILES_SCHEMA_VERSION);
	void row;
}
