PRAGMA foreign_keys = ON;

CREATE TABLE media_sources (
  source_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('publisher', 'government')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  publication_policy TEXT NOT NULL CHECK (publication_policy IN ('manual', 'auto_approve')),
  review_level TEXT NOT NULL CHECK (review_level IN ('standard', 'enhanced')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  discovery_method TEXT NOT NULL CHECK (discovery_method IN ('rss', 'sitemap', 'deferred')),
  discovery_config_json TEXT NOT NULL CHECK (json_valid(discovery_config_json)),
  content_fetch_policy TEXT NOT NULL CHECK (content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed', 'article_body_allowed')),
  ai_content_policy TEXT NOT NULL CHECK (ai_content_policy IN ('disabled', 'metadata_only', 'article_body_allowed')),
  image_policy TEXT NOT NULL CHECK (image_policy IN ('remote_preview', 'blocked', 'local_copy_permitted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE media_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL REFERENCES media_sources(source_key),
  canonical_url TEXT NOT NULL UNIQUE,
  canonical_url_hash TEXT NOT NULL UNIQUE CHECK (length(canonical_url_hash) = 64),
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  feed_sort_at TEXT GENERATED ALWAYS AS (coalesce(published_at, discovered_at)) STORED,
  source_excerpt TEXT,
  summary TEXT,
  why_it_matters TEXT,
  editorial_content_origin TEXT CHECK (editorial_content_origin IN ('human', 'ai')),
  topics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(topics_json) AND json_type(topics_json) = 'array'),
  pollutants_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pollutants_json) AND json_type(pollutants_json) = 'array'),
  locations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locations_json) AND json_type(locations_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  review_level TEXT NOT NULL CHECK (review_level IN ('standard', 'enhanced')),
  approval_method TEXT CHECK (approval_method IN ('trusted_source_auto', 'manual')),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  editor_note TEXT,
  og_image_url TEXT,
  image_policy TEXT NOT NULL CHECK (image_policy IN ('remote_preview', 'blocked', 'local_copy_permitted')),
  ai_provider TEXT,
  ai_model TEXT,
  ai_version TEXT,
  enriched_at TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  hidden_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status NOT IN ('approved', 'hidden') OR (approved_at IS NOT NULL AND approval_method IS NOT NULL)),
  CHECK ((summary IS NULL AND why_it_matters IS NULL) OR editorial_content_origin IS NOT NULL),
  CHECK (editorial_content_origin IS NOT 'ai' OR
    (ai_provider IS NOT NULL AND ai_model IS NOT NULL AND ai_version IS NOT NULL AND enriched_at IS NOT NULL))
);
CREATE INDEX media_articles_public_feed ON media_articles(status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_source_feed ON media_articles(source_key, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_updated ON media_articles(updated_at, id);

CREATE TABLE media_discovery_runs (
  id TEXT PRIMARY KEY,
  source_key TEXT REFERENCES media_sources(source_key),
  queue_message_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_inserted INTEGER NOT NULL DEFAULT 0,
  items_updated INTEGER NOT NULL DEFAULT 0,
  items_invalid INTEGER NOT NULL DEFAULT 0,
  error_code TEXT CHECK (length(error_code) <= 100),
  updated_at TEXT NOT NULL
);
CREATE INDEX media_runs_recent ON media_discovery_runs(started_at DESC, id DESC);
CREATE INDEX media_runs_source_recent ON media_discovery_runs(source_key, started_at DESC, id DESC);
CREATE INDEX media_runs_updated ON media_discovery_runs(updated_at, id);

CREATE TABLE media_article_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('discovered', 'auto_approved', 'approved', 'rejected', 'hidden', 'unhidden', 'edited')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('discovery', 'admin')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);
CREATE INDEX media_events_article ON media_article_events(article_id, id);
CREATE INDEX media_events_created ON media_article_events(created_at, id);
CREATE INDEX media_sources_updated ON media_sources(updated_at, source_key);

-- The insert/transition and its event are one SQLite statement/transaction.
CREATE TRIGGER media_article_created AFTER INSERT ON media_articles BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, to_status, revision, created_at)
  VALUES (NEW.id, 'discovered:' || NEW.id,
    CASE WHEN NEW.status = 'approved' THEN 'auto_approved' ELSE 'discovered' END,
    'discovery', NEW.status, NEW.revision, NEW.created_at);
END;
CREATE TRIGGER media_article_transition_guard BEFORE UPDATE OF status ON media_articles
WHEN OLD.status != NEW.status BEGIN
  SELECT CASE WHEN NEW.mutation_key IS NULL OR NEW.revision != OLD.revision + 1
    THEN RAISE(ABORT, 'transition_requires_key_and_revision') END;
END;
CREATE TRIGGER media_article_transition AFTER UPDATE OF status ON media_articles
WHEN OLD.status != NEW.status BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, from_status, to_status, revision, created_at)
  VALUES (NEW.id, NEW.mutation_key,
    CASE WHEN NEW.status = 'approved' AND OLD.status = 'hidden' THEN 'unhidden'
      WHEN NEW.status = 'approved' THEN 'approved'
      WHEN NEW.status = 'rejected' THEN 'rejected'
      WHEN NEW.status = 'hidden' THEN 'hidden' ELSE 'edited' END,
    'admin', OLD.status, NEW.status, NEW.revision, NEW.updated_at);
END;
CREATE TRIGGER media_events_no_update BEFORE UPDATE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;
CREATE TRIGGER media_events_no_delete BEFORE DELETE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;
