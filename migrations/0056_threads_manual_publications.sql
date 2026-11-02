-- Manual-only installation. No approval-event trigger, scan or backfill.
ALTER TABLE media_admin_status_requests ADD COLUMN post_to_threads INTEGER NOT NULL DEFAULT 0 CHECK (post_to_threads IN (0, 1));
ALTER TABLE media_admin_bulk_status_requests ADD COLUMN post_to_threads INTEGER NOT NULL DEFAULT 0 CHECK (post_to_threads IN (0, 1));

-- Rebuild only the direct request identity CHECK to permit Threads-only intent.
CREATE TABLE media_admin_publish_requests_0056 (
  request_key TEXT PRIMARY KEY,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('single', 'bulk')),
  article_ids_json TEXT NOT NULL CHECK (json_valid(article_ids_json) AND json_type(article_ids_json) = 'array'),
  post_to_bluesky INTEGER NOT NULL CHECK (post_to_bluesky IN (0, 1)),
  post_to_facebook INTEGER NOT NULL CHECK (post_to_facebook IN (0, 1)),
  post_to_threads INTEGER NOT NULL DEFAULT 0 CHECK (post_to_threads IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (post_to_bluesky = 1 OR post_to_facebook = 1 OR post_to_threads = 1)
);
INSERT INTO media_admin_publish_requests_0056
  (request_key, request_kind, article_ids_json, post_to_bluesky, post_to_facebook, created_at)
SELECT request_key, request_kind, article_ids_json, post_to_bluesky, post_to_facebook, created_at
FROM media_admin_publish_requests;
DROP TABLE media_admin_publish_requests;
ALTER TABLE media_admin_publish_requests_0056 RENAME TO media_admin_publish_requests;

CREATE TABLE media_threads_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manual_publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (manual_publishing_enabled IN (0, 1)),
  automatic_publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_publishing_enabled = 0),
  cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  last_identity_checked_at TEXT,
  last_identity_verified_at TEXT,
  last_identity_user_id TEXT,
  last_identity_username TEXT,
  last_identity_error_code TEXT,
  last_successful_post_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO media_threads_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE media_threads_settings_requests (
  request_key TEXT PRIMARY KEY, request_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE media_threads_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL UNIQUE,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('pending_approved', 'rejected_repost', 'unhidden_repost', 'manual_post', 'manual_repost')),
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
  CHECK (status <> 'posted' OR (threads_post_id IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE INDEX media_threads_publications_oldest_queued ON media_threads_publications(status, next_attempt_at, id);
CREATE INDEX media_threads_publications_article_history ON media_threads_publications(article_id, id DESC);
-- Concurrent independent requests may not create overlapping work for an article.
CREATE UNIQUE INDEX media_threads_publications_active_article ON media_threads_publications(article_id)
  WHERE status IN ('queued', 'posting', 'unknown_remote_state');
CREATE TABLE media_threads_operator_requests (
  request_key TEXT PRIMARY KEY, publication_id INTEGER NOT NULL REFERENCES media_threads_publications(id),
  operation TEXT NOT NULL CHECK (operation IN ('cancel', 'reconcile', 'confirm_not_posted')),
  request_json TEXT NOT NULL, created_at TEXT NOT NULL
);
