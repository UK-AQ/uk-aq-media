-- Independent non-remote acceptance mode. No settings are enabled and no events
-- or publications are copied into capture merely by applying this migration.
ALTER TABLE media_threads_settings ADD COLUMN capture_only_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (capture_only_enabled IN (0, 1));
ALTER TABLE media_threads_settings ADD COLUMN capture_activation_event_id INTEGER CHECK (capture_activation_event_id >= 0);
ALTER TABLE media_threads_settings ADD COLUMN capture_events_through_id INTEGER
  CHECK (capture_events_through_id >= capture_activation_event_id);
ALTER TABLE media_threads_settings ADD COLUMN remote_request_key TEXT;
ALTER TABLE media_threads_settings ADD COLUMN remote_request_lease_until TEXT;

-- Persist mode intervals at the settings transaction's exact event boundary.
-- This journal is never attached to editorial/approval transactions. Closed
-- intervals can recover a missed wake-up without capturing disabled-period events.
CREATE TABLE media_threads_capture_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  after_event_id INTEGER NOT NULL CHECK (after_event_id >= 0),
  through_event_id INTEGER CHECK (through_event_id >= after_event_id),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX media_threads_capture_one_open_period
  ON media_threads_capture_periods((1)) WHERE through_event_id IS NULL;
CREATE TRIGGER media_threads_capture_open AFTER UPDATE OF capture_only_enabled ON media_threads_settings
WHEN OLD.capture_only_enabled = 0 AND NEW.capture_only_enabled = 1
BEGIN
  INSERT INTO media_threads_capture_periods(after_event_id, opened_at)
  VALUES ((SELECT coalesce(max(id), 0) FROM media_article_events), NEW.updated_at);
END;
CREATE TRIGGER media_threads_capture_close AFTER UPDATE OF capture_only_enabled ON media_threads_settings
WHEN OLD.capture_only_enabled = 1 AND NEW.capture_only_enabled = 0
BEGIN
  UPDATE media_threads_capture_periods SET
    through_event_id = (SELECT coalesce(max(id), 0) FROM media_article_events), closed_at = NEW.updated_at
  WHERE through_event_id IS NULL;
END;

-- A captured intent has no remote account identity. Existing remote/manual rows
-- keep every original value; only explicitly captured rows may have a NULL ID.
CREATE TABLE media_threads_operator_requests_saved_0058 AS SELECT * FROM media_threads_operator_requests;
DROP TABLE media_threads_operator_requests;
CREATE TABLE media_threads_sequence_0058 AS
  SELECT seq FROM sqlite_sequence WHERE name = 'media_threads_publications';
CREATE TABLE media_threads_publications_0058 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL UNIQUE,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('auto_approved', 'pending_approved', 'rejected_repost', 'unhidden_repost', 'manual_post', 'manual_repost')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'posting', 'posted', 'failed', 'blocked', 'unknown_remote_state')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  container_poll_count INTEGER NOT NULL DEFAULT 0 CHECK (container_poll_count BETWEEN 0 AND 5),
  claim_key TEXT,
  threads_user_id TEXT,
  threads_container_id TEXT,
  threads_post_id TEXT,
  threads_permalink_url TEXT,
  container_created_at TEXT,
  remote_request_started_at TEXT,
  unknown_at TEXT,
  reconciled_at TEXT,
  reconciliation_method TEXT,
  last_error_code TEXT,
  next_attempt_at TEXT,
  last_attempted_at TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  capture_only INTEGER NOT NULL DEFAULT 0 CHECK (capture_only IN (0, 1)),
  CHECK (capture_only = 1 OR threads_user_id IS NOT NULL),
  CHECK (capture_only = 0 OR (publication_reason = 'auto_approved' AND status = 'blocked'
    AND threads_user_id IS NULL AND claim_key IS NULL AND attempt_count = 0 AND container_poll_count = 0
    AND threads_container_id IS NULL AND threads_post_id IS NULL AND threads_permalink_url IS NULL
    AND container_created_at IS NULL AND remote_request_started_at IS NULL AND posted_at IS NULL)),
  CHECK (publication_reason <> 'auto_approved' OR (approval_event_id IS NOT NULL
    AND publication_key = 'approval-event:' || approval_event_id)),
  CHECK (status <> 'posted' OR (threads_post_id IS NOT NULL AND posted_at IS NOT NULL))
);
INSERT INTO media_threads_publications_0058 (id, article_id, approval_event_id, publication_key, publication_reason, status, attempt_count, container_poll_count, claim_key, threads_user_id, threads_container_id, threads_post_id, threads_permalink_url, container_created_at, remote_request_started_at, unknown_at, reconciled_at, reconciliation_method, last_error_code, next_attempt_at, last_attempted_at, posted_at, created_at, updated_at)
SELECT id, article_id, approval_event_id, publication_key, publication_reason, status, attempt_count, container_poll_count, claim_key, threads_user_id, threads_container_id, threads_post_id, threads_permalink_url, container_created_at, remote_request_started_at, unknown_at, reconciled_at, reconciliation_method, last_error_code, next_attempt_at, last_attempted_at, posted_at, created_at, updated_at FROM media_threads_publications;
DROP TABLE media_threads_publications;
ALTER TABLE media_threads_publications_0058 RENAME TO media_threads_publications;
CREATE INDEX media_threads_publications_oldest_queued ON media_threads_publications(status, next_attempt_at, id);
CREATE INDEX media_threads_publications_article_history ON media_threads_publications(article_id, id DESC);
-- Concurrent independent requests may not create overlapping work for an article.
CREATE UNIQUE INDEX media_threads_publications_active_article ON media_threads_publications(article_id)
  WHERE status IN ('queued', 'posting', 'unknown_remote_state');
CREATE UNIQUE INDEX media_threads_publications_automatic_event
  ON media_threads_publications(approval_event_id) WHERE publication_reason = 'auto_approved';
-- Capture provenance cannot later be converted into a remote publication.
CREATE TRIGGER media_threads_capture_origin_immutable BEFORE UPDATE OF capture_only ON media_threads_publications
WHEN OLD.capture_only <> NEW.capture_only
BEGIN
  SELECT RAISE(ABORT, 'threads_capture_origin_immutable');
END;
CREATE TABLE media_threads_operator_requests (
  request_key TEXT PRIMARY KEY, publication_id INTEGER NOT NULL REFERENCES media_threads_publications(id),
  operation TEXT NOT NULL CHECK (operation IN ('cancel', 'reconcile', 'confirm_not_posted')),
  request_json TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO media_threads_operator_requests SELECT * FROM media_threads_operator_requests_saved_0058;
DROP TABLE media_threads_operator_requests_saved_0058;
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM media_threads_sequence_0058), seq))
WHERE name = 'media_threads_publications';
INSERT INTO sqlite_sequence(name, seq)
SELECT 'media_threads_publications', seq FROM media_threads_sequence_0058
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'media_threads_publications');
DROP TABLE media_threads_sequence_0058;
