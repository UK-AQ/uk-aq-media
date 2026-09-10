CREATE TABLE media_author_rules (
  author_key TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES media_sources(source_key),
  display_name TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  profile_rss_url TEXT,
  profile_rss_route_key TEXT,
  inclusion_policy TEXT NOT NULL CHECK (inclusion_policy IN ('normal', 'always_include')),
  publication_policy TEXT NOT NULL CHECK (publication_policy IN ('inherit_source', 'pending', 'auto_approve')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  byline_aliases_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(byline_aliases_json) AND json_type(byline_aliases_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_key, profile_rss_route_key)
);
CREATE INDEX media_author_rules_source_enabled
  ON media_author_rules(source_key, enabled, author_key);

INSERT INTO media_author_rules (author_key, source_key, display_name, profile_url,
  profile_rss_url, profile_rss_route_key, inclusion_policy, publication_policy,
  enabled, byline_aliases_json)
VALUES
  ('guardian:gary-fuller', 'the-guardian', 'Gary Fuller',
    'https://www.theguardian.com/profile/gary-fuller',
    'https://www.theguardian.com/profile/gary-fuller/rss', 'gary-fuller',
    'always_include', 'auto_approve', 1, '["Gary Fuller"]'),
  ('guardian:damian-carrington', 'the-guardian', 'Damian Carrington',
    'https://www.theguardian.com/profile/damiancarrington',
    'https://www.theguardian.com/profile/damiancarrington/rss', 'damian-carrington',
    'always_include', 'pending', 1,
    '["Damian Carrington","Damian Carrington Environment editor"]'),
  ('guardian:fiona-harvey', 'the-guardian', 'Fiona Harvey',
    'https://www.theguardian.com/profile/fiona-harvey',
    'https://www.theguardian.com/profile/fiona-harvey/rss', 'fiona-harvey',
    'always_include', 'pending', 1,
    '["Fiona Harvey","Fiona Harvey Environment editor"]');

-- Rebuild the parent and append-only event table together so the new approval method
-- is truthful without weakening existing foreign keys, generated columns or triggers.
CREATE TABLE media_articles_rebuild (
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
  topics_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(topics_json) AND json_type(topics_json) = 'array'),
  pollutants_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pollutants_json) AND json_type(pollutants_json) = 'array'),
  locations_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(locations_json) AND json_type(locations_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  review_level TEXT NOT NULL CHECK (review_level IN ('standard', 'enhanced')),
  approval_method TEXT
    CHECK (approval_method IN ('trusted_source_auto', 'trusted_author_auto', 'manual')),
  approval_author_rule_key TEXT REFERENCES media_author_rules(author_key),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  editor_note TEXT,
  og_image_url TEXT,
  image_policy TEXT NOT NULL
    CHECK (image_policy IN ('remote_preview', 'blocked', 'local_copy_permitted')),
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
  display_title TEXT,
  display_title_origin TEXT
    CHECK (display_title_origin IN ('publisher', 'human', 'ai') OR display_title_origin IS NULL),
  preview_metadata_checked_at TEXT,
  CHECK (status NOT IN ('approved', 'hidden') OR
    (approved_at IS NOT NULL AND approval_method IS NOT NULL)),
  CHECK ((approval_method IS NULL AND approval_author_rule_key IS NULL) OR
    (approval_method IN ('trusted_source_auto', 'manual') AND approval_author_rule_key IS NULL) OR
    (approval_method = 'trusted_author_auto' AND approval_author_rule_key IS NOT NULL)),
  CHECK ((summary IS NULL AND why_it_matters IS NULL) OR editorial_content_origin IS NOT NULL),
  CHECK (editorial_content_origin IS NOT 'ai' OR
    (ai_provider IS NOT NULL AND ai_model IS NOT NULL AND ai_version IS NOT NULL AND enriched_at IS NOT NULL))
);

INSERT INTO media_articles_rebuild (id, source_key, canonical_url, canonical_url_hash,
  original_url, title, publisher, author, published_at, discovered_at, last_seen_at,
  source_excerpt, summary, why_it_matters, editorial_content_origin, topics_json,
  pollutants_json, locations_json, status, review_level, approval_method,
  approval_author_rule_key, featured, editor_note, og_image_url, image_policy, ai_provider,
  ai_model, ai_version, enriched_at, approved_at, rejected_at, hidden_at, revision,
  mutation_key, created_at, updated_at, display_title, display_title_origin,
  preview_metadata_checked_at)
SELECT id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
  author, published_at, discovered_at, last_seen_at, source_excerpt, summary,
  why_it_matters, editorial_content_origin, topics_json, pollutants_json, locations_json,
  status, review_level, approval_method, NULL, featured, editor_note, og_image_url,
  image_policy, ai_provider, ai_model, ai_version, enriched_at, approved_at, rejected_at,
  hidden_at, revision, mutation_key, created_at, updated_at, display_title,
  display_title_origin, preview_metadata_checked_at
FROM media_articles;

CREATE TABLE media_article_events_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('discovered', 'auto_approved', 'approved', 'rejected', 'hidden', 'unhidden', 'edited')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('discovery', 'admin')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

INSERT INTO media_article_events_rebuild (id, article_id, event_key, event_type, actor_type,
  from_status, to_status, revision, created_at, metadata_json)
SELECT id, article_id, event_key, event_type, actor_type, from_status, to_status,
  revision, created_at, metadata_json
FROM media_article_events;

DROP TABLE media_article_events;
DROP TABLE media_articles;
ALTER TABLE media_articles_rebuild RENAME TO media_articles;

CREATE TABLE media_article_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('discovered', 'auto_approved', 'approved', 'rejected', 'hidden', 'unhidden', 'edited')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('discovery', 'admin')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);
INSERT INTO media_article_events (id, article_id, event_key, event_type, actor_type,
  from_status, to_status, revision, created_at, metadata_json)
SELECT id, article_id, event_key, event_type, actor_type, from_status, to_status,
  revision, created_at, metadata_json
FROM media_article_events_rebuild;
DROP TABLE media_article_events_rebuild;

CREATE INDEX media_articles_public_feed ON media_articles(status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_source_feed ON media_articles(source_key, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_updated ON media_articles(updated_at, id);
CREATE INDEX media_events_article ON media_article_events(article_id, id);
CREATE INDEX media_events_created ON media_article_events(created_at, id);

CREATE TRIGGER media_article_created AFTER INSERT ON media_articles BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, to_status, revision, created_at,
      metadata_json)
  VALUES (NEW.id, 'discovered:' || NEW.id,
    (CASE WHEN NEW.status = 'approved' THEN 'auto_approved' ELSE 'discovered' END),
    'discovery', NEW.status, NEW.revision, NEW.created_at,
    (CASE WHEN NEW.status = 'approved' THEN json_object(
      'approval_method', NEW.approval_method,
      'author_rule_key', NEW.approval_author_rule_key
    ) ELSE '{}' END));
END;
CREATE TRIGGER media_article_transition_guard BEFORE UPDATE OF status ON media_articles
WHEN OLD.status != NEW.status BEGIN
  SELECT (CASE WHEN NEW.mutation_key IS NULL OR NEW.revision != OLD.revision + 1
    THEN RAISE(ABORT, 'transition_requires_key_and_revision') END);
END;
CREATE TRIGGER media_article_transition AFTER UPDATE OF status ON media_articles
WHEN OLD.status != NEW.status BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
      created_at, metadata_json)
  VALUES (NEW.id, NEW.mutation_key,
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN 'auto_approved'
      WHEN NEW.status = 'approved' AND OLD.status = 'hidden' THEN 'unhidden'
      WHEN NEW.status = 'approved' THEN 'approved'
      WHEN NEW.status = 'rejected' THEN 'rejected'
      WHEN NEW.status = 'hidden' THEN 'hidden' ELSE 'edited' END),
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN 'discovery' ELSE 'admin' END),
    OLD.status, NEW.status, NEW.revision, NEW.updated_at,
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN json_object(
      'approval_method', NEW.approval_method,
      'author_rule_key', NEW.approval_author_rule_key
    ) ELSE '{}' END));
END;
CREATE TRIGGER media_events_no_update BEFORE UPDATE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;
CREATE TRIGGER media_events_no_delete BEFORE DELETE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;

ALTER TABLE media_discovery_runs ADD COLUMN discovery_route_key TEXT
  CHECK (discovery_route_key IS NULL OR length(discovery_route_key) BETWEEN 1 AND 100);
ALTER TABLE media_discovery_runs ADD COLUMN items_filtered INTEGER NOT NULL DEFAULT 0
  CHECK (items_filtered >= 0);
CREATE INDEX media_runs_source_route_recent
  ON media_discovery_runs(source_key, discovery_route_key, started_at DESC, id DESC);

CREATE TABLE media_article_discovery_evidence (
  article_id INTEGER NOT NULL REFERENCES media_articles(id),
  source_key TEXT NOT NULL REFERENCES media_sources(source_key),
  provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 100),
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 1 AND 100),
  matched_author_keys_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(matched_author_keys_json) AND json_type(matched_author_keys_json) = 'array'),
  always_include_applied INTEGER NOT NULL DEFAULT 0 CHECK (always_include_applied IN (0, 1)),
  author_auto_approval_applied INTEGER NOT NULL DEFAULT 0
    CHECK (author_auto_approval_applied IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  PRIMARY KEY (article_id, provider_key, route_key)
);
CREATE INDEX media_discovery_evidence_route_recent
  ON media_article_discovery_evidence(source_key, provider_key, route_key, last_seen_at DESC);

-- Preserve later operator choices: advance only the original disabled/deferred Guardian state.
UPDATE media_sources
SET enabled = 1,
    discovery_method = 'rss',
    discovery_config_json = '{"routes":[{"route_key":"gary-fuller","url":"https://www.theguardian.com/profile/gary-fuller/rss","max_items":10},{"route_key":"damian-carrington","url":"https://www.theguardian.com/profile/damiancarrington/rss","max_items":10},{"route_key":"fiona-harvey","url":"https://www.theguardian.com/profile/fiona-harvey/rss","max_items":10},{"route_key":"guardian-air-pollution","url":"https://www.theguardian.com/environment/air-pollution/rss","max_items":10},{"route_key":"guardian-environment","url":"https://www.theguardian.com/environment/rss","max_items":10},{"route_key":"guardian-pollution","url":"https://www.theguardian.com/environment/pollution/rss","max_items":10},{"route_key":"guardian-uk","url":"https://www.theguardian.com/uk/rss","max_items":10},{"route_key":"guardian-world","url":"https://www.theguardian.com/world/rss","max_items":10},{"route_key":"guardian-climate-crisis","url":"https://www.theguardian.com/environment/climate-crisis/rss","max_items":10},{"route_key":"guardian-science","url":"https://www.theguardian.com/science/rss","max_items":10},{"route_key":"guardian-technology","url":"https://www.theguardian.com/technology/rss","max_items":10}],"retain_excerpt":false}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'the-guardian'
  AND enabled = 0
  AND discovery_method = 'deferred'
  AND json(discovery_config_json) = json('{"retain_excerpt":false}');
