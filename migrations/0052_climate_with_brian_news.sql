-- Register Climate Thoughts with Brian for bounded WordPress RSS discovery.
-- Broader environmental coverage uses the shared deterministic AQ relevance filter;
-- relevant candidates remain Pending for manual editorial approval.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('climate-with-brian', 'Climate Thoughts with Brian', 'climatewithbrian.com', 'publisher',
   1, 'manual', 'standard', 50, 'rss',
   '{"routes":[{"route_key":"climate-with-brian-feed","url":"https://climatewithbrian.com/feed/","max_items":20}],"retain_excerpt":false}',
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

-- Reassociate existing manually discovered articles without changing their
-- canonical identities, editorial approval decisions, titles or images.
UPDATE media_articles
SET source_key = 'climate-with-brian', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('climatewithbrian.com', 'www.climatewithbrian.com')
    AND source_key != 'climate-with-brian'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND (canonical_url LIKE 'https://climatewithbrian.com/%'
  OR canonical_url LIKE 'https://www.climatewithbrian.com/%');

UPDATE media_article_discovery_evidence
SET source_key = 'climate-with-brian'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('climatewithbrian.com', 'www.climatewithbrian.com')
    AND source_key != 'climate-with-brian'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'climate-with-brian'
);

UPDATE media_article_search_terms
SET source_key = 'climate-with-brian'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('climatewithbrian.com', 'www.climatewithbrian.com')
    AND source_key != 'climate-with-brian'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_search_terms.article_id
    AND a.source_key = 'climate-with-brian'
);

-- Retire superseded auto-created source identities only when unreferenced.
UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('climatewithbrian.com', 'www.climatewithbrian.com')
  AND source_key != 'climate-with-brian'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('climatewithbrian.com', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
