-- An inspected cleanup scope is server-issued and cannot be edited or removed.
-- This migration creates receipts only; it performs no article transitions.
CREATE TABLE IF NOT EXISTS media_source_domain_cleanup_previews (
  preview_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  through_id INTEGER NOT NULL CHECK (through_id >= 0),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  all_initial_domains_blocked INTEGER NOT NULL CHECK (all_initial_domains_blocked IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS media_source_domain_cleanup_previews_no_update
BEFORE UPDATE ON media_source_domain_cleanup_previews BEGIN
  SELECT RAISE(ABORT, 'cleanup_previews_are_immutable');
END;
CREATE TRIGGER IF NOT EXISTS media_source_domain_cleanup_previews_no_delete
BEFORE DELETE ON media_source_domain_cleanup_previews BEGIN
  SELECT RAISE(ABORT, 'cleanup_previews_are_immutable');
END;
