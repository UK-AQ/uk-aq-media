-- Additive derived metadata and operator review only. No historical population,
-- article status changes, publication events or automatic suppression.
ALTER TABLE media_public_feed_state ADD COLUMN syndication_dirty INTEGER NOT NULL DEFAULT 0
  CHECK (syndication_dirty IN (0, 1));
CREATE TABLE media_syndication_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_key TEXT NOT NULL UNIQUE CHECK (length(title_key) = 64),
  normalised_title TEXT NOT NULL CHECK (length(normalised_title) BETWEEN 30 AND 1000),
  representative_article_id INTEGER REFERENCES media_articles(id),
  epoch INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE media_syndication_metadata (
  article_id INTEGER PRIMARY KEY REFERENCES media_articles(id),
  group_id INTEGER NOT NULL REFERENCES media_syndication_groups(id),
  publisher_domain TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  revision INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1)),
  indexed_at TEXT NOT NULL
);
CREATE INDEX media_syndication_group_members
  ON media_syndication_metadata(group_id, valid, article_id);
CREATE INDEX media_syndication_group_domains
  ON media_syndication_metadata(group_id, valid, publisher_domain, article_id);
CREATE TABLE media_syndication_reviews (
  group_id INTEGER NOT NULL REFERENCES media_syndication_groups(id),
  epoch INTEGER NOT NULL,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  representative_article_id INTEGER NOT NULL REFERENCES media_articles(id),
  member_metadata_revision INTEGER NOT NULL,
  representative_metadata_revision INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN
    ('candidate', 'confirmed_syndicated', 'not_duplicate', 'insufficient_evidence')),
  suppress INTEGER NOT NULL DEFAULT 0 CHECK (suppress IN (0, 1)),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('metadata_only', 'manual_publisher_url_review')),
  rationale TEXT NOT NULL CHECK (length(rationale) BETWEEN 1 AND 500),
  decision_key TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  CHECK (article_id <> representative_article_id),
  CHECK (suppress = 0 OR (classification = 'confirmed_syndicated'
    AND evidence_type = 'manual_publisher_url_review')),
  PRIMARY KEY(group_id, epoch, article_id)
);
CREATE INDEX media_syndication_article_visibility
  ON media_syndication_reviews(article_id, suppress, group_id, epoch);
CREATE TABLE media_syndication_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  group_id INTEGER NOT NULL REFERENCES media_syndication_groups(id),
  revision INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type = 'authenticated_admin'),
  action TEXT NOT NULL CHECK (action IN ('review', 'reset')),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL,
  UNIQUE(group_id, revision)
);
CREATE INDEX media_syndication_group_history ON media_syndication_events(group_id, id);
-- Preserve append-only evidence, including reversals and replaced preferences.
CREATE TRIGGER media_syndication_events_no_update BEFORE UPDATE ON media_syndication_events
BEGIN SELECT RAISE(ABORT, 'syndication_history_is_immutable'); END;
CREATE TRIGGER media_syndication_events_no_delete BEFORE DELETE ON media_syndication_events
BEGIN SELECT RAISE(ABORT, 'syndication_history_is_immutable'); END;
-- Metadata edits invalidate prior evidence immediately, even before rediscovery.
-- Revision never resets, so reverting a headline cannot reactivate an old decision.
CREATE TRIGGER media_syndication_metadata_changed AFTER UPDATE OF title, canonical_url,
  canonical_url_hash, published_at ON media_articles
WHEN OLD.title IS NOT NEW.title OR OLD.canonical_url IS NOT NEW.canonical_url
  OR OLD.canonical_url_hash IS NOT NEW.canonical_url_hash OR OLD.published_at IS NOT NEW.published_at
BEGIN
  UPDATE media_public_feed_state SET syndication_dirty = 1
    WHERE scope = 'homepage_latest_6' AND EXISTS (
      SELECT 1 FROM media_syndication_metadata WHERE article_id = NEW.id);
  UPDATE media_syndication_metadata SET valid = 0, revision = revision + 1 WHERE article_id = NEW.id;
END;
