-- Global GDELT Web NGrams candidate acquisition with UK-only Phase 1 promotion.

CREATE TABLE media_publisher_domain_scope (
  publisher_domain TEXT PRIMARY KEY,
  publisher_scope TEXT NOT NULL CHECK (publisher_scope IN ('uk', 'non_uk', 'unknown')),
  classification_reason TEXT NOT NULL CHECK (length(classification_reason) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(publisher_domain) BETWEEN 1 AND 253)
);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES
  ('airqualitynews.com', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bbc.co.uk', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('carbonbrief.org', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dailymail.co.uk', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('independent.co.uk', 'uk', 'configured_uk_publisher_alias', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('news.sky.com', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('telegraph.co.uk', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('the-independent.com', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('theguardian.com', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('thesun.co.uk', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('thetimes.com', 'uk', 'configured_uk_publisher', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE media_gdelt_state (
  scope TEXT PRIMARY KEY CHECK (scope = 'global_web_ngrams'),
  checkpoint_minute TEXT,
  updated_at TEXT NOT NULL,
  CHECK (checkpoint_minute IS NULL OR
    (length(checkpoint_minute) = 14 AND checkpoint_minute NOT GLOB '*[^0-9]*'))
);
INSERT INTO media_gdelt_state (scope, checkpoint_minute, updated_at)
VALUES ('global_web_ngrams', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE media_gdelt_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  checkpoint_before TEXT,
  checkpoint_after TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  completed_through TEXT,
  minutes_checked INTEGER NOT NULL DEFAULT 0 CHECK (minutes_checked >= 0),
  complete_pairs_processed INTEGER NOT NULL DEFAULT 0 CHECK (complete_pairs_processed >= 0),
  complete_pairs_replayed INTEGER NOT NULL DEFAULT 0 CHECK (complete_pairs_replayed >= 0),
  missing_minutes INTEGER NOT NULL DEFAULT 0 CHECK (missing_minutes >= 0),
  matches_seen INTEGER NOT NULL DEFAULT 0 CHECK (matches_seen >= 0),
  candidates_inserted INTEGER NOT NULL DEFAULT 0 CHECK (candidates_inserted >= 0),
  candidates_updated INTEGER NOT NULL DEFAULT 0 CHECK (candidates_updated >= 0),
  candidates_uk INTEGER NOT NULL DEFAULT 0 CHECK (candidates_uk >= 0),
  candidates_non_uk INTEGER NOT NULL DEFAULT 0 CHECK (candidates_non_uk >= 0),
  candidates_unknown INTEGER NOT NULL DEFAULT 0 CHECK (candidates_unknown >= 0),
  uk_promoted INTEGER NOT NULL DEFAULT 0 CHECK (uk_promoted >= 0),
  uk_relevance_filtered INTEGER NOT NULL DEFAULT 0 CHECK (uk_relevance_filtered >= 0),
  malformed_rows INTEGER NOT NULL DEFAULT 0 CHECK (malformed_rows >= 0),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  updated_at TEXT NOT NULL
);
CREATE INDEX media_gdelt_runs_recent ON media_gdelt_runs(started_at DESC, id DESC);

CREATE TABLE media_gdelt_files (
  file_stamp TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES media_gdelt_runs(id),
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
  expected_chunks INTEGER NOT NULL CHECK (expected_chunks BETWEEN 0 AND 100),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 0 AND 1000),
  ngram_rows INTEGER NOT NULL CHECK (ngram_rows >= 0),
  matches_seen INTEGER NOT NULL CHECK (matches_seen >= 0),
  malformed_toc_rows INTEGER NOT NULL CHECK (malformed_toc_rows >= 0),
  first_processed_at TEXT NOT NULL,
  last_processed_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX media_gdelt_files_run ON media_gdelt_files(run_id, status, file_stamp);

CREATE TABLE media_gdelt_file_chunks (
  file_stamp TEXT NOT NULL REFERENCES media_gdelt_files(file_stamp),
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 2),
  candidates_inserted INTEGER NOT NULL CHECK (candidates_inserted >= 0),
  candidates_updated INTEGER NOT NULL CHECK (candidates_updated >= 0),
  candidates_uk INTEGER NOT NULL CHECK (candidates_uk >= 0),
  candidates_non_uk INTEGER NOT NULL CHECK (candidates_non_uk >= 0),
  candidates_unknown INTEGER NOT NULL CHECK (candidates_unknown >= 0),
  uk_promoted INTEGER NOT NULL CHECK (uk_promoted >= 0),
  uk_relevance_filtered INTEGER NOT NULL CHECK (uk_relevance_filtered >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_stamp, chunk_index)
);

CREATE TABLE media_gdelt_candidates (
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
  promoted_article_id INTEGER REFERENCES media_articles(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX media_gdelt_candidates_scope_recent
  ON media_gdelt_candidates(publisher_scope, provider_observed_last_at DESC, id DESC);
CREATE INDEX media_gdelt_candidates_domain
  ON media_gdelt_candidates(publisher_domain, last_seen_at DESC, id DESC);
CREATE INDEX media_gdelt_candidates_promoted
  ON media_gdelt_candidates(promoted_article_id) WHERE promoted_article_id IS NOT NULL;

CREATE TABLE media_gdelt_candidate_families (
  candidate_id INTEGER NOT NULL REFERENCES media_gdelt_candidates(id),
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
CREATE INDEX media_gdelt_candidate_families_recent
  ON media_gdelt_candidate_families(family_key, last_seen_at DESC, candidate_id);
