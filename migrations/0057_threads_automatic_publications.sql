-- Stage 2 is inert until an authenticated operator explicitly enables it.
-- Preserve manual enablement, cooldown, verified identity and every audit row.
-- No event trigger is added to editorial transactions: the existing post-commit
-- social reconciler drains append-only events strictly after first activation.
CREATE TABLE media_threads_settings_0057 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manual_publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (manual_publishing_enabled IN (0, 1)),
  automatic_publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_publishing_enabled IN (0, 1)),
  activation_event_id INTEGER CHECK (activation_event_id >= 0),
  automatic_events_through_id INTEGER CHECK (automatic_events_through_id >= activation_event_id),
  automatic_intent_error_code TEXT,
  automatic_intent_error_event_id INTEGER,
  cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  last_identity_checked_at TEXT,
  last_identity_verified_at TEXT,
  last_identity_user_id TEXT,
  last_identity_username TEXT,
  last_identity_error_code TEXT,
  last_successful_post_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((activation_event_id IS NULL AND automatic_events_through_id IS NULL)
    OR (activation_event_id IS NOT NULL AND automatic_events_through_id IS NOT NULL
      AND automatic_events_through_id >= activation_event_id)),
  CHECK (automatic_publishing_enabled = 0 OR activation_event_id IS NOT NULL)
);
INSERT INTO media_threads_settings_0057 (id, manual_publishing_enabled, automatic_publishing_enabled, cooldown_seconds, last_identity_checked_at, last_identity_verified_at, last_identity_user_id, last_identity_username, last_identity_error_code, last_successful_post_at, updated_at)
SELECT id, manual_publishing_enabled, automatic_publishing_enabled, cooldown_seconds, last_identity_checked_at, last_identity_verified_at, last_identity_user_id, last_identity_username, last_identity_error_code, last_successful_post_at, updated_at FROM media_threads_settings;
DROP TABLE media_threads_settings;
ALTER TABLE media_threads_settings_0057 RENAME TO media_threads_settings;

-- Rebuild the dependent operator table too, avoiding dangling D1 foreign keys.
CREATE TABLE media_threads_operator_requests_saved_0057 AS
  SELECT * FROM media_threads_operator_requests;
DROP TABLE media_threads_operator_requests;
CREATE TABLE media_threads_sequence_0057 AS
  SELECT seq FROM sqlite_sequence WHERE name = 'media_threads_publications';
CREATE TABLE media_threads_publications_0057 (
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
  threads_user_id TEXT NOT NULL,
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
  CHECK (publication_reason <> 'auto_approved' OR (approval_event_id IS NOT NULL
    AND publication_key = 'approval-event:' || approval_event_id)),
  CHECK (status <> 'posted' OR (threads_post_id IS NOT NULL AND posted_at IS NOT NULL))
);
INSERT INTO media_threads_publications_0057 SELECT * FROM media_threads_publications;
DROP TABLE media_threads_publications;
ALTER TABLE media_threads_publications_0057 RENAME TO media_threads_publications;
CREATE INDEX media_threads_publications_oldest_queued ON media_threads_publications(status, next_attempt_at, id);
CREATE INDEX media_threads_publications_article_history ON media_threads_publications(article_id, id DESC);
-- Concurrent independent requests may not create overlapping work for an article.
CREATE UNIQUE INDEX media_threads_publications_active_article ON media_threads_publications(article_id)
  WHERE status IN ('queued', 'posting', 'unknown_remote_state');
CREATE UNIQUE INDEX media_threads_publications_automatic_event
  ON media_threads_publications(approval_event_id) WHERE publication_reason = 'auto_approved';
CREATE TABLE media_threads_operator_requests (
  request_key TEXT PRIMARY KEY, publication_id INTEGER NOT NULL REFERENCES media_threads_publications(id),
  operation TEXT NOT NULL CHECK (operation IN ('cancel', 'reconcile', 'confirm_not_posted')),
  request_json TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO media_threads_operator_requests SELECT * FROM media_threads_operator_requests_saved_0057;
DROP TABLE media_threads_operator_requests_saved_0057;
UPDATE sqlite_sequence SET seq = max(seq,
  coalesce((SELECT seq FROM media_threads_sequence_0057), seq))
WHERE name = 'media_threads_publications';
INSERT INTO sqlite_sequence(name, seq)
SELECT 'media_threads_publications', seq FROM media_threads_sequence_0057
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'media_threads_publications');
DROP TABLE media_threads_sequence_0057;
CREATE INDEX media_threads_automatic_events ON media_article_events(id)
  WHERE event_type = 'auto_approved';
