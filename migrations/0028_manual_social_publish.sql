-- Extend only the publication reasons. Preserve the complete existing rows,
-- indexes, automatic Bluesky outbox, and AUTOINCREMENT high-water marks.
CREATE TABLE media_publication_sequences_0028 AS
  SELECT name, seq FROM sqlite_sequence
  WHERE name IN ('media_bluesky_publications', 'media_facebook_publications');

DROP TRIGGER media_bluesky_automatic_outbox;

CREATE TABLE media_bluesky_publications_0028 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL UNIQUE,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('auto_approved', 'pending_approved', 'rejected_repost', 'unhidden_repost',
     'manual_post', 'manual_repost')),
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

INSERT INTO media_bluesky_publications_0028
  (id, article_id, approval_event_id, publication_key, publication_reason, status,
   attempt_count, record_key, post_uri, post_cid, last_error_code, next_attempt_at,
   created_at, last_attempted_at, posted_at, updated_at)
SELECT id, article_id, approval_event_id, publication_key, publication_reason, status,
  attempt_count, record_key, post_uri, post_cid, last_error_code, next_attempt_at,
  created_at, last_attempted_at, posted_at, updated_at
FROM media_bluesky_publications;

DROP TABLE media_bluesky_publications;
ALTER TABLE media_bluesky_publications_0028 RENAME TO media_bluesky_publications;

CREATE UNIQUE INDEX media_bluesky_publications_approval_event
  ON media_bluesky_publications(approval_event_id) WHERE approval_event_id IS NOT NULL;
CREATE INDEX media_bluesky_publications_oldest_queued
  ON media_bluesky_publications(status, next_attempt_at, id);
CREATE INDEX media_bluesky_publications_article_history
  ON media_bluesky_publications(article_id, id DESC);

CREATE TRIGGER media_bluesky_automatic_outbox AFTER INSERT ON media_article_events
WHEN NEW.event_type = 'auto_approved'
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
    'auto_approved', 'queued', NEW.created_at, NEW.created_at);
END;

CREATE TABLE media_facebook_publications_0028 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('pending_approved', 'rejected_repost', 'unhidden_repost',
     'manual_post', 'manual_repost')),
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

INSERT INTO media_facebook_publications_0028
  (id, article_id, approval_event_id, publication_key, publication_reason, status,
   attempt_count, facebook_post_id, facebook_permalink_url, last_error_code,
   next_attempt_at, remote_request_started_at, unknown_at, reconciled_at,
   reconciliation_method, created_at, last_attempted_at, posted_at, updated_at)
SELECT id, article_id, approval_event_id, publication_key, publication_reason, status,
  attempt_count, facebook_post_id, facebook_permalink_url, last_error_code,
  next_attempt_at, remote_request_started_at, unknown_at, reconciled_at,
  reconciliation_method, created_at, last_attempted_at, posted_at, updated_at
FROM media_facebook_publications;

DROP TABLE media_facebook_publications;
ALTER TABLE media_facebook_publications_0028 RENAME TO media_facebook_publications;

CREATE UNIQUE INDEX media_facebook_publications_publication_key
  ON media_facebook_publications(publication_key);
CREATE INDEX media_facebook_publications_oldest_queued
  ON media_facebook_publications(status, next_attempt_at, id);
CREATE INDEX media_facebook_publications_article_history
  ON media_facebook_publications(article_id, id DESC);

UPDATE sqlite_sequence SET seq = max(seq,
  coalesce((SELECT old.seq FROM media_publication_sequences_0028 old
    WHERE old.name = sqlite_sequence.name), seq))
WHERE name IN ('media_bluesky_publications', 'media_facebook_publications');
INSERT INTO sqlite_sequence(name, seq)
SELECT old.name, old.seq FROM media_publication_sequences_0028 old
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence current WHERE current.name = old.name);
DROP TABLE media_publication_sequences_0028;

-- The request key identifies the complete direct intent across both endpoints.
CREATE TABLE media_admin_publish_requests (
  request_key TEXT PRIMARY KEY,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('single', 'bulk')),
  article_ids_json TEXT NOT NULL CHECK (json_valid(article_ids_json)
    AND json_type(article_ids_json) = 'array'),
  post_to_bluesky INTEGER NOT NULL CHECK (post_to_bluesky IN (0, 1)),
  post_to_facebook INTEGER NOT NULL CHECK (post_to_facebook IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (post_to_bluesky = 1 OR post_to_facebook = 1)
);
