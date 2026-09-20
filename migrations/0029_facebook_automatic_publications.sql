-- Activate the Facebook approval-event outbox without scanning historical events.
-- Existing enabled installations start strictly after the migration watermark;
-- disabled installations capture their watermark on their first later enable.
ALTER TABLE media_facebook_settings ADD COLUMN activation_event_id INTEGER;

UPDATE media_facebook_settings
SET activation_event_id = (SELECT coalesce(max(id), 0) FROM media_article_events)
WHERE id = 1 AND publishing_enabled = 1;

-- SQLite cannot alter the publication_reason CHECK in place. Preserve every
-- Facebook row and its AUTOINCREMENT high-water mark while rebuilding only this table.
CREATE TABLE media_facebook_publication_sequence_0029 AS
  SELECT seq FROM sqlite_sequence WHERE name = 'media_facebook_publications';

CREATE TABLE media_facebook_publications_0029 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  approval_event_id INTEGER REFERENCES media_article_events(id),
  publication_key TEXT NOT NULL,
  publication_reason TEXT NOT NULL CHECK (publication_reason IN
    ('auto_approved', 'pending_approved', 'rejected_repost', 'unhidden_repost',
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

INSERT INTO media_facebook_publications_0029
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
ALTER TABLE media_facebook_publications_0029 RENAME TO media_facebook_publications;

CREATE UNIQUE INDEX media_facebook_publications_publication_key
  ON media_facebook_publications(publication_key);
CREATE INDEX media_facebook_publications_oldest_queued
  ON media_facebook_publications(status, next_attempt_at, id);
CREATE INDEX media_facebook_publications_article_history
  ON media_facebook_publications(article_id, id DESC);

UPDATE sqlite_sequence SET seq = max(seq,
  coalesce((SELECT seq FROM media_facebook_publication_sequence_0029), seq))
WHERE name = 'media_facebook_publications';
INSERT INTO sqlite_sequence(name, seq)
SELECT 'media_facebook_publications', seq FROM media_facebook_publication_sequence_0029
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_sequence WHERE name = 'media_facebook_publications'
);
DROP TABLE media_facebook_publication_sequence_0029;

CREATE TRIGGER media_facebook_automatic_outbox AFTER INSERT ON media_article_events
WHEN NEW.event_type = 'auto_approved'
  AND EXISTS (
    SELECT 1 FROM media_facebook_settings
    WHERE id = 1 AND activation_event_id IS NOT NULL AND NEW.id > activation_event_id
  )
BEGIN
  INSERT OR IGNORE INTO media_facebook_publications
    (article_id, approval_event_id, publication_key, publication_reason, status,
     created_at, updated_at)
  VALUES (NEW.article_id, NEW.id, 'approval-event:' || NEW.id,
    'auto_approved', 'queued', NEW.created_at, NEW.created_at);
END;
