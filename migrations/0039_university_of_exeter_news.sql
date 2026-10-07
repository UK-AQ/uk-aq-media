-- Add University of Exeter News as a first-party manual publisher source.
-- The broad first-party RSS feed is bounded by the generic deterministic AQ relevance filter.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('university-of-exeter', 'University of Exeter News', 'news.exeter.ac.uk', 'publisher',
   1, 'manual', 'standard', 50, 'rss',
   '{"routes":[{"route_key":"university-of-exeter-news","url":"https://news.exeter.ac.uk/feed/","max_items":20}],"retain_excerpt":false}',
   'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only', NULL)
ON CONFLICT(source_key) DO UPDATE SET
  name = excluded.name,
  canonical_domain = excluded.canonical_domain,
  source_type = excluded.source_type,
  enabled = excluded.enabled,
  publication_policy = excluded.publication_policy,
  review_level = excluded.review_level,
  priority = excluded.priority,
  discovery_method = excluded.discovery_method,
  discovery_config_json = excluded.discovery_config_json,
  content_fetch_policy = excluded.content_fetch_policy,
  ai_content_policy = excluded.ai_content_policy,
  image_policy = excluded.image_policy,
  search_index_policy = excluded.search_index_policy,
  retired_at = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Converge earlier manually added/discovered identities for the exact Exeter News domain
-- without altering approval state, approval provenance, title decisions or selected images.
UPDATE media_articles
SET source_key = 'university-of-exeter', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('news.exeter.ac.uk', 'www.news.exeter.ac.uk')
    AND source_key != 'university-of-exeter'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (SELECT 1 FROM media_sources WHERE source_key = 'university-of-exeter'
  AND canonical_domain = 'news.exeter.ac.uk' AND retired_at IS NULL)
AND (canonical_url LIKE 'https://news.exeter.ac.uk/%'
  OR canonical_url LIKE 'https://www.news.exeter.ac.uk/%');

UPDATE media_article_discovery_evidence
SET source_key = 'university-of-exeter'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('news.exeter.ac.uk', 'www.news.exeter.ac.uk')
    AND source_key != 'university-of-exeter'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'university-of-exeter'
    AND (a.canonical_url LIKE 'https://news.exeter.ac.uk/%'
      OR a.canonical_url LIKE 'https://www.news.exeter.ac.uk/%')
);

UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('news.exeter.ac.uk', 'www.news.exeter.ac.uk')
  AND source_key != 'university-of-exeter'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('news.exeter.ac.uk', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
