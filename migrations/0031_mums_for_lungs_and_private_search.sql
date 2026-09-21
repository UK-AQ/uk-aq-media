-- Search permission is independent of discovery, fetch, AI and image permissions.
-- Existing and dynamically discovered sources default to metadata-only indexing.
ALTER TABLE media_sources ADD COLUMN search_index_policy TEXT NOT NULL DEFAULT 'metadata_only'
  CHECK (search_index_policy IN ('metadata_only', 'feed_body_text'));

-- Derived, unordered, deduplicated terms only. No feed HTML, prose, snippets or term order.
CREATE TABLE media_article_search_terms (
  article_id INTEGER NOT NULL REFERENCES media_articles(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL REFERENCES media_sources(source_key),
  term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 256),
  PRIMARY KEY (article_id, term)
) WITHOUT ROWID;
CREATE INDEX media_article_search_terms_lookup
  ON media_article_search_terms(term, article_id);
CREATE INDEX media_article_search_terms_source
  ON media_article_search_terms(source_key, article_id);

INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy)
VALUES
  ('mums-for-lungs', 'Mums for Lungs', 'mumsforlungs.org', 'publisher', 1, 'manual',
   'standard', 50, 'rss',
   '{"routes":[{"route_key":"mums-for-lungs-news","url":"https://www.mumsforlungs.org/news?format=rss","max_items":20}],"retain_excerpt":false}',
   'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only')
ON CONFLICT(source_key) DO NOTHING;

-- Consolidate only dynamic/manual identities for the exact publisher domain. Article IDs and
-- all editorial/article state remain in place; evidence retains its observations under the
-- configured identity. Historical source rows are retained, retired only after all dependants move.
UPDATE media_articles
SET source_key = 'mums-for-lungs', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('mumsforlungs.org', 'www.mumsforlungs.org')
    AND source_key != 'mums-for-lungs'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (SELECT 1 FROM media_sources WHERE source_key = 'mums-for-lungs'
  AND canonical_domain = 'mumsforlungs.org' AND retired_at IS NULL);

UPDATE media_article_discovery_evidence
SET source_key = 'mums-for-lungs'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('mumsforlungs.org', 'www.mumsforlungs.org')
    AND source_key != 'mums-for-lungs'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
);

UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('mumsforlungs.org', 'www.mumsforlungs.org')
  AND source_key != 'mums-for-lungs'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key);
