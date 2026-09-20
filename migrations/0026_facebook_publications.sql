-- Facebook V1 is manual-only. Installation leaves publishing disabled, creates
-- no publication rows, and has no approval-event trigger or activation watermark.
ALTER TABLE media_admin_status_requests ADD COLUMN post_to_facebook INTEGER NOT NULL DEFAULT 0
  CHECK (post_to_facebook IN (0, 1));

ALTER TABLE media_admin_bulk_status_requests ADD COLUMN post_to_facebook INTEGER NOT NULL DEFAULT 0
  CHECK (post_to_facebook IN (0, 1));

CREATE TABLE media_facebook_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (publishing_enabled IN (0, 1)),
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  graph_api_version TEXT,
  default_message_template TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  last_identity_verified_at TEXT,
  last_successful_post_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO media_facebook_settings
  (id, publishing_enabled, page_id, page_name, graph_api_version,
   default_message_template, cooldown_seconds, last_identity_verified_at,
   last_successful_post_at, updated_at)
VALUES (1, 0, '1336337862891538', 'UK AQ - ukaq.co.uk', NULL,
  'From {publisher}

Live and historical UK air quality data:
https://ukaq.co.uk/',
  600, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE media_facebook_settings_requests (
  request_key TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE media_facebook_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('pending_approved', 'rejected_repost', 'unhidden_repost')),
  status TEXT NOT NULL CHECK (status IN
    ('queued', 'posting', 'posted', 'failed', 'blocked', 'unknown_remote_state')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  facebook_post_id TEXT,
  facebook_permalink_url TEXT,
  last_error_code TEXT,
  next_attempt_at TEXT,
  remote_request_started_at TEXT,
  unknown_at TEXT,
  reconciled_at TEXT,
  reconciliation_method TEXT,
  created_at TEXT NOT NULL,
  last_attempted_at TEXT,
  posted_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'posted' OR (facebook_post_id IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE UNIQUE INDEX media_facebook_publications_publication_key
  ON media_facebook_publications(publication_key);
CREATE INDEX media_facebook_publications_oldest_queued
  ON media_facebook_publications(status, next_attempt_at, id);
CREATE INDEX media_facebook_publications_article_history
  ON media_facebook_publications(article_id, id DESC);
