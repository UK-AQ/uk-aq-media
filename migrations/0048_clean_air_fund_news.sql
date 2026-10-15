-- Enable the first-party Clean Air Fund news index, with manual editorial approval.
-- The listing includes both News and Blog entries. Do not touch publication decisions.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('clean-air-fund', 'Clean Air Fund', 'cleanairfund.org', 'publisher',
   1, 'manual', 'standard', 50, 'sitemap',
   '{"routes":[{"route_key":"clean-air-fund-news","url":"https://www.cleanairfund.org/news/","max_items":20}],"retain_excerpt":false}',
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

-- Preserve existing canonical article URLs, hashes, IDs, approvals and editorial state.
-- The two existing approved articles are currently owned by manual-ce07e198b9f9.
UPDATE media_articles
SET source_key = 'clean-air-fund', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('cleanairfund.org', 'www.cleanairfund.org')
    AND source_key != 'clean-air-fund'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND (canonical_url LIKE 'https://cleanairfund.org/%'
  OR canonical_url LIKE 'https://www.cleanairfund.org/%');

UPDATE media_article_discovery_evidence
SET source_key = 'clean-air-fund'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('cleanairfund.org', 'www.cleanairfund.org')
    AND source_key != 'clean-air-fund'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'clean-air-fund'
);

UPDATE media_article_search_terms
SET source_key = 'clean-air-fund'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('cleanairfund.org', 'www.cleanairfund.org')
    AND source_key != 'clean-air-fund'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_search_terms.article_id AND a.source_key = 'clean-air-fund'
);

UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('cleanairfund.org', 'www.cleanairfund.org')
  AND source_key != 'clean-air-fund'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('cleanairfund.org', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
