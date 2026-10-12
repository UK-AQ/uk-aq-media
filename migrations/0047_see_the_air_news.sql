-- Add See The Air as a manually reviewed specialist air-quality publisher.
-- Its broad first-party RSS feed remains subject to deterministic AQ relevance plus the
-- checked-in See The Air editorial exclusions for obvious product/commercial/promotional posts.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('see-the-air', 'See The Air', 'seetheair.org', 'publisher',
   1, 'manual', 'standard', 50, 'rss',
   '{"routes":[{"route_key":"see-the-air-feed","url":"https://seetheair.org/feed/","max_items":20}],"retain_excerpt":false}',
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

-- Converge prior manual/dynamic identities for the exact publisher domain. This includes the
-- already-approved 12/10/2026 article without changing article status, revision or title/image
-- editorial decisions.
UPDATE media_articles
SET source_key = 'see-the-air', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('seetheair.org', 'www.seetheair.org')
    AND source_key != 'see-the-air'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (SELECT 1 FROM media_sources WHERE source_key = 'see-the-air'
  AND canonical_domain = 'seetheair.org' AND retired_at IS NULL)
AND (canonical_url LIKE 'https://seetheair.org/%'
  OR canonical_url LIKE 'https://www.seetheair.org/%');

UPDATE media_article_discovery_evidence
SET source_key = 'see-the-air'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('seetheair.org', 'www.seetheair.org')
    AND source_key != 'see-the-air'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'see-the-air'
    AND (a.canonical_url LIKE 'https://seetheair.org/%'
      OR a.canonical_url LIKE 'https://www.seetheair.org/%')
);

UPDATE media_sources
SET enabled = 0, retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('seetheair.org', 'www.seetheair.org')
  AND source_key != 'see-the-air'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('seetheair.org', 'non_uk', 'configured_non_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
