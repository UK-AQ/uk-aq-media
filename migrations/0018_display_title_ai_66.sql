-- SQLite/D1 cannot alter a column CHECK constraint in place. Rebuild from the
-- current post-0017 media_articles definition so later columns, provenance and
-- editorial state remain intact while widening only the AI suggestion ceiling.

CREATE TABLE media_articles_rebuild_ai_title_66 (
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
  ai_title_attempted_at TEXT,
  ai_title_suggestion TEXT
    CHECK (ai_title_suggestion IS NULL OR (
      length(ai_title_suggestion) BETWEEN 1 AND 66
      AND instr(ai_title_suggestion, char(10)) = 0
      AND instr(ai_title_suggestion, char(13)) = 0
    )),
  ai_title_suggestion_state TEXT
    CHECK (ai_title_suggestion_state IN ('pending', 'accepted', 'rejected')
      OR ai_title_suggestion_state IS NULL),
  ai_title_model TEXT
    CHECK (ai_title_model IS NULL OR length(ai_title_model) BETWEEN 1 AND 200),
  ai_title_prompt_version TEXT
    CHECK (ai_title_prompt_version IS NULL OR length(ai_title_prompt_version) BETWEEN 1 AND 200),
  ai_title_generated_at TEXT,
  ai_title_decided_at TEXT,
  CHECK (status NOT IN ('approved', 'hidden') OR
    (approved_at IS NOT NULL AND approval_method IS NOT NULL)),
  CHECK ((approval_method IS NULL AND approval_author_rule_key IS NULL) OR
    (approval_method IN ('trusted_source_auto', 'manual') AND approval_author_rule_key IS NULL) OR
    (approval_method = 'trusted_author_auto' AND approval_author_rule_key IS NOT NULL)),
  CHECK ((summary IS NULL AND why_it_matters IS NULL) OR editorial_content_origin IS NOT NULL),
  CHECK (editorial_content_origin IS NOT 'ai' OR
    (ai_provider IS NOT NULL AND ai_model IS NOT NULL AND ai_version IS NOT NULL AND enriched_at IS NOT NULL))
);

INSERT INTO media_articles_rebuild_ai_title_66 (
  id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
  author, published_at, discovered_at, last_seen_at, source_excerpt, summary,
  why_it_matters, editorial_content_origin, topics_json, pollutants_json, locations_json,
  status, review_level, approval_method, approval_author_rule_key, featured, editor_note,
  og_image_url, image_policy, ai_provider, ai_model, ai_version, enriched_at, approved_at,
  rejected_at, hidden_at, revision, mutation_key, created_at, updated_at, display_title,
  display_title_origin, preview_metadata_checked_at, ai_title_attempted_at,
  ai_title_suggestion, ai_title_suggestion_state, ai_title_model, ai_title_prompt_version,
  ai_title_generated_at, ai_title_decided_at
)
SELECT
  id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
  author, published_at, discovered_at, last_seen_at, source_excerpt, summary,
  why_it_matters, editorial_content_origin, topics_json, pollutants_json, locations_json,
  status, review_level, approval_method, approval_author_rule_key, featured, editor_note,
  og_image_url, image_policy, ai_provider, ai_model, ai_version, enriched_at, approved_at,
  rejected_at, hidden_at, revision, mutation_key, created_at, updated_at, display_title,
  display_title_origin, preview_metadata_checked_at, ai_title_attempted_at,
  ai_title_suggestion, ai_title_suggestion_state, ai_title_model, ai_title_prompt_version,
  ai_title_generated_at, ai_title_decided_at
FROM media_articles;

-- Later migrations added foreign-key dependents. Rebuild them against the replacement
-- parent before removing their current forms, preserving all evidence and promotions.
CREATE TABLE media_article_events_rebuild_ai_title_66 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES media_articles_rebuild_ai_title_66(id),
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

INSERT INTO media_article_events_rebuild_ai_title_66 (
  id, article_id, event_key, event_type, actor_type, from_status, to_status, revision,
  created_at, metadata_json
)
SELECT id, article_id, event_key, event_type, actor_type, from_status, to_status, revision,
  created_at, metadata_json
FROM media_article_events;

CREATE TABLE media_article_discovery_evidence_rebuild_ai_title_66 (
  article_id INTEGER NOT NULL REFERENCES media_articles_rebuild_ai_title_66(id),
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

INSERT INTO media_article_discovery_evidence_rebuild_ai_title_66 (
  article_id, source_key, provider_key, route_key, matched_author_keys_json,
  always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
  observation_count
)
SELECT article_id, source_key, provider_key, route_key, matched_author_keys_json,
  always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
  observation_count
FROM media_article_discovery_evidence;

CREATE TABLE media_gdelt_candidates_rebuild_ai_title_66 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_url TEXT NOT NULL UNIQUE,
  canonical_url_hash TEXT NOT NULL UNIQUE CHECK (length(canonical_url_hash) = 64),
  provider_key TEXT NOT NULL DEFAULT 'gdelt' CHECK (provider_key = 'gdelt'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  language TEXT NOT NULL CHECK (language = 'English'),
  publisher_host TEXT NOT NULL CHECK (length(publisher_host) BETWEEN 1 AND 253),
  publisher_domain TEXT NOT NULL CHECK (length(publisher_domain) BETWEEN 1 AND 253),
  publisher_scope TEXT NOT NULL CHECK (publisher_scope IN ('uk', 'non_uk', 'unknown')),
  provider_observed_first_at TEXT NOT NULL,
  provider_observed_last_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_file_stamp TEXT NOT NULL,
  last_file_stamp TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  promoted_article_id INTEGER REFERENCES media_articles_rebuild_ai_title_66(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO media_gdelt_candidates_rebuild_ai_title_66 (
  id, canonical_url, canonical_url_hash, provider_key, title, language, publisher_host,
  publisher_domain, publisher_scope, provider_observed_first_at, provider_observed_last_at,
  first_seen_at, last_seen_at, first_file_stamp, last_file_stamp, observation_count,
  promoted_article_id, created_at, updated_at
)
SELECT id, canonical_url, canonical_url_hash, provider_key, title, language, publisher_host,
  publisher_domain, publisher_scope, provider_observed_first_at, provider_observed_last_at,
  first_seen_at, last_seen_at, first_file_stamp, last_file_stamp, observation_count,
  promoted_article_id, created_at, updated_at
FROM media_gdelt_candidates;

CREATE TABLE media_gdelt_candidate_families_rebuild_ai_title_66 (
  candidate_id INTEGER NOT NULL REFERENCES media_gdelt_candidates_rebuild_ai_title_66(id),
  family_key TEXT NOT NULL CHECK (family_key IN (
    'gdelt-wood-burning', 'gdelt-wildfire', 'gdelt-air-pollution', 'gdelt-air-quality')),
  matched_phrases_json TEXT NOT NULL
    CHECK (json_valid(matched_phrases_json) AND json_type(matched_phrases_json) = 'array'),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_file_stamp TEXT NOT NULL,
  last_file_stamp TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  PRIMARY KEY (candidate_id, family_key)
);

INSERT INTO media_gdelt_candidate_families_rebuild_ai_title_66 (
  candidate_id, family_key, matched_phrases_json, first_seen_at, last_seen_at,
  first_file_stamp, last_file_stamp, observation_count
)
SELECT candidate_id, family_key, matched_phrases_json, first_seen_at, last_seen_at,
  first_file_stamp, last_file_stamp, observation_count
FROM media_gdelt_candidate_families;

DROP TABLE media_gdelt_candidate_families;
DROP TABLE media_article_events;
DROP TABLE media_article_discovery_evidence;
DROP TABLE media_gdelt_candidates;
DROP TABLE media_articles;
ALTER TABLE media_articles_rebuild_ai_title_66 RENAME TO media_articles;
ALTER TABLE media_article_events_rebuild_ai_title_66 RENAME TO media_article_events;
ALTER TABLE media_article_discovery_evidence_rebuild_ai_title_66
  RENAME TO media_article_discovery_evidence;
ALTER TABLE media_gdelt_candidates_rebuild_ai_title_66 RENAME TO media_gdelt_candidates;
ALTER TABLE media_gdelt_candidate_families_rebuild_ai_title_66
  RENAME TO media_gdelt_candidate_families;

CREATE INDEX media_articles_public_feed ON media_articles(status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_source_feed ON media_articles(source_key, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_updated ON media_articles(updated_at, id);
CREATE INDEX media_articles_status_approved
  ON media_articles(status, coalesce(approved_at, '') DESC, id DESC);
CREATE INDEX media_articles_status_discovered
  ON media_articles(status, discovered_at DESC, id DESC);
CREATE INDEX media_articles_status_updated
  ON media_articles(status, updated_at DESC, id DESC);
CREATE INDEX media_articles_source_status_feed
  ON media_articles(source_key, status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_author_status_feed
  ON media_articles(author, status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_ai_title_review
  ON media_articles(ai_title_suggestion_state, coalesce(ai_title_generated_at, '') DESC, id DESC);
CREATE INDEX media_events_article ON media_article_events(article_id, id);
CREATE INDEX media_events_created ON media_article_events(created_at, id);
CREATE INDEX media_discovery_evidence_route_recent
  ON media_article_discovery_evidence(source_key, provider_key, route_key, last_seen_at DESC);
CREATE INDEX media_gdelt_candidates_scope_recent
  ON media_gdelt_candidates(publisher_scope, provider_observed_last_at DESC, id DESC);
CREATE INDEX media_gdelt_candidates_domain
  ON media_gdelt_candidates(publisher_domain, last_seen_at DESC, id DESC);
CREATE INDEX media_gdelt_candidates_promoted
  ON media_gdelt_candidates(promoted_article_id) WHERE promoted_article_id IS NOT NULL;
CREATE INDEX media_gdelt_candidate_families_recent
  ON media_gdelt_candidate_families(family_key, last_seen_at DESC, candidate_id);

CREATE TRIGGER media_events_no_update BEFORE UPDATE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;

CREATE TRIGGER media_events_no_delete BEFORE DELETE ON media_article_events BEGIN
  SELECT RAISE(ABORT, 'article_events_are_append_only');
END;

CREATE TRIGGER media_article_created AFTER INSERT ON media_articles BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, to_status, revision, created_at,
      metadata_json)
  VALUES (
    NEW.id,
    coalesce(NEW.mutation_key, 'discovered:' || NEW.id),
    CASE
      WHEN NEW.status = 'approved' AND NEW.approval_method = 'manual' THEN 'approved'
      WHEN NEW.status = 'approved' THEN 'auto_approved'
      ELSE 'discovered'
    END,
    CASE
      WHEN NEW.status = 'approved' AND NEW.approval_method = 'manual' THEN 'admin'
      ELSE 'discovery'
    END,
    NEW.status,
    NEW.revision,
    NEW.created_at,
    CASE
      WHEN NEW.status = 'approved' THEN json_object(
        'approval_method', NEW.approval_method,
        'author_rule_key', NEW.approval_author_rule_key
      )
      ELSE '{}'
    END
  );
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
