-- Add NCAS as a bounded manual publisher source. Discovery is deliberately limited to
-- three exact first-party News & Events tag routes. No unfiltered NCAS index is configured.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('ncas', 'NCAS', 'ncas.ac.uk', 'publisher', 1, 'manual', 'standard', 50, 'sitemap',
   '{"routes":[{"route_key":"ncas-air-pollution","url":"https://ncas.ac.uk/news-events/?category_name=&tag=air-pollution","max_items":20},{"route_key":"ncas-digital-atmosphere","url":"https://ncas.ac.uk/news-events/?category_name=&tag=digital-atmosphere","max_items":20},{"route_key":"ncas-air-pollutants","url":"https://ncas.ac.uk/news-events/?category_name=&tag=air-pollutants","max_items":20}],"retain_excerpt":false}',
   'article_head_allowed', 'disabled', 'remote_preview', 'metadata_only', NULL)
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

-- Converge earlier manually added/discovered NCAS identities without altering approval state,
-- approval provenance, title decisions, selected images or other editorial article fields.
UPDATE media_articles
SET source_key = 'ncas', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('ncas.ac.uk', 'www.ncas.ac.uk')
    AND source_key != 'ncas'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (SELECT 1 FROM media_sources WHERE source_key = 'ncas'
  AND canonical_domain = 'ncas.ac.uk' AND retired_at IS NULL)
AND (canonical_url LIKE 'https://ncas.ac.uk/%'
  OR canonical_url LIKE 'https://www.ncas.ac.uk/%');

UPDATE media_article_discovery_evidence
SET source_key = 'ncas'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('ncas.ac.uk', 'www.ncas.ac.uk')
    AND source_key != 'ncas'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'ncas'
    AND (a.canonical_url LIKE 'https://ncas.ac.uk/%'
      OR a.canonical_url LIKE 'https://www.ncas.ac.uk/%')
);

UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('ncas.ac.uk', 'www.ncas.ac.uk')
  AND source_key != 'ncas'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('ncas.ac.uk', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
