-- Bluesky is an approval-event outbox. Installation does not activate it and does
-- not scan historical events; the first activation endpoint sets the watermark.
CREATE TABLE media_bluesky_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (publishing_enabled IN (0, 1)),
  cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  default_message_template TEXT NOT NULL,
  activation_event_id INTEGER,
  last_successful_post_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO media_bluesky_settings
  (id, publishing_enabled, cooldown_seconds, default_message_template,
   activation_event_id, last_successful_post_at, updated_at)
VALUES (1, 0, 600,
  'From {publisher} {publisher_mention}

Live and historical UK air quality data:
https://ukaq.co.uk/',
  NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE media_bluesky_settings_requests (
  request_key TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE media_bluesky_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL UNIQUE,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('auto_approved', 'pending_approved', 'rejected_repost', 'unhidden_repost')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'posting', 'posted', 'failed', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  record_key TEXT,
  post_uri TEXT,
  post_cid TEXT,
  last_error_code TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  last_attempted_at TEXT,
  posted_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'posted') = (post_uri IS NOT NULL AND post_cid IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE UNIQUE INDEX media_bluesky_publications_approval_event
  ON media_bluesky_publications(approval_event_id) WHERE approval_event_id IS NOT NULL;
CREATE INDEX media_bluesky_publications_oldest_queued
  ON media_bluesky_publications(status, next_attempt_at, id);
CREATE INDEX media_bluesky_publications_article_history
  ON media_bluesky_publications(article_id, id DESC);

CREATE TABLE media_source_social_accounts (
  source_key TEXT NOT NULL REFERENCES media_sources(source_key),
  platform TEXT NOT NULL CHECK (platform = 'bluesky'),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 3 AND 253 AND handle NOT LIKE '@%'),
  account_did TEXT NOT NULL CHECK (account_did GLOB 'did:*' AND length(account_did) <= 2048),
  mention_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mention_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_key, platform)
);

-- At trigger time NEW is the durable approval event and the article row already
-- contains the image state from the same INSERT/UPDATE operation.
CREATE TRIGGER media_bluesky_automatic_outbox AFTER INSERT ON media_article_events
WHEN (NEW.event_type = 'auto_approved'
      OR (NEW.event_type = 'approved' AND NEW.from_status = 'pending'))
  AND EXISTS (
    SELECT 1 FROM media_bluesky_settings
    WHERE id = 1 AND activation_event_id IS NOT NULL AND NEW.id > activation_event_id
  )
  AND EXISTS (
    SELECT 1 FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = NEW.article_id AND a.og_image_url IS NOT NULL
      AND a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview'
  )
BEGIN
  INSERT OR IGNORE INTO media_bluesky_publications
    (article_id, approval_event_id, publication_key, publication_reason, status,
     created_at, updated_at)
  VALUES (NEW.article_id, NEW.id, 'approval-event:' || NEW.id,
    CASE WHEN NEW.event_type = 'auto_approved' THEN 'auto_approved'
         ELSE 'pending_approved' END,
    'queued', NEW.created_at, NEW.created_at);
END;
