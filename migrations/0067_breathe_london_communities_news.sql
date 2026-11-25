-- Register the Breathe London Communities News RSS source.
-- An existing dedicated key is advanced only from the disabled manual placeholder.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy)
VALUES
  ('breathe-london-communities', 'Breathe London Communities', 'breathelondon-communities.org', 'publisher',
   1, 'manual', 'standard', 50, 'rss',
   '{"routes":[{"route_key":"breathe-london-communities-news","url":"https://www.breathelondon-communities.org/news?format=rss","max_items":20}],"retain_excerpt":false}',
   'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only')
ON CONFLICT(source_key) DO UPDATE SET
  name = excluded.name,
  canonical_domain = excluded.canonical_domain,
  enabled = excluded.enabled,
  review_level = excluded.review_level,
  priority = excluded.priority,
  discovery_method = excluded.discovery_method,
  discovery_config_json = excluded.discovery_config_json,
  content_fetch_policy = excluded.content_fetch_policy,
  ai_content_policy = excluded.ai_content_policy,
  image_policy = excluded.image_policy,
  search_index_policy = excluded.search_index_policy,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE media_sources.canonical_domain IN ('breathelondon-communities.org', 'www.breathelondon-communities.org')
  AND media_sources.source_type = 'publisher'
  AND media_sources.enabled = 0
  AND media_sources.publication_policy = 'manual'
  AND media_sources.discovery_method = 'deferred'
  AND json(media_sources.discovery_config_json) = json('{"retain_excerpt":false}')
  AND media_sources.content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed')
  AND media_sources.ai_content_policy = 'disabled'
  AND media_sources.search_index_policy = 'metadata_only'
  AND media_sources.review_text_scan_policy = 'disabled'
  AND media_sources.retired_at IS NULL;

-- Historical article/source relationships move only from conservative legacy
-- identities for this publisher, including operator-created keys. Canonical identities
-- and editorial data stay in place.
WITH legacy_sources AS (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('breathelondon-communities.org', 'www.breathelondon-communities.org')
    AND source_key <> 'breathe-london-communities'
    AND source_type = 'publisher' AND enabled = 0
    AND publication_policy = 'manual' AND discovery_method = 'deferred'
    AND json(discovery_config_json) = json('{"retain_excerpt":false}')
    AND content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed')
    AND ai_content_policy = 'disabled' AND search_index_policy = 'metadata_only'
    AND review_text_scan_policy = 'disabled'
    AND NOT EXISTS (SELECT 1 FROM media_author_rules ar WHERE ar.source_key = media_sources.source_key)
    AND NOT EXISTS (SELECT 1 FROM media_source_social_accounts sa
      WHERE sa.source_key = media_sources.source_key)
)
UPDATE media_articles
SET source_key = 'breathe-london-communities',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (SELECT source_key FROM legacy_sources)
  AND (canonical_url LIKE 'https://breathelondon-communities.org/%'
    OR canonical_url LIKE 'https://www.breathelondon-communities.org/%')
  AND EXISTS (
    SELECT 1 FROM media_sources
    WHERE source_key = 'breathe-london-communities' AND canonical_domain = 'breathelondon-communities.org'
      AND source_type = 'publisher' AND discovery_method = 'rss'
      AND publication_policy = 'manual' AND retired_at IS NULL
  );

UPDATE media_article_discovery_evidence
SET source_key = 'breathe-london-communities'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('breathelondon-communities.org', 'www.breathelondon-communities.org')
    AND source_key <> 'breathe-london-communities'
    AND source_type = 'publisher' AND enabled = 0
    AND publication_policy = 'manual' AND discovery_method = 'deferred'
    AND json(discovery_config_json) = json('{"retain_excerpt":false}')
    AND content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed')
    AND ai_content_policy = 'disabled' AND search_index_policy = 'metadata_only'
    AND review_text_scan_policy = 'disabled'
)
AND EXISTS (
  SELECT 1 FROM media_articles
  WHERE id = media_article_discovery_evidence.article_id AND source_key = 'breathe-london-communities'
    AND (canonical_url LIKE 'https://breathelondon-communities.org/%'
      OR canonical_url LIKE 'https://www.breathelondon-communities.org/%')
);

UPDATE media_article_search_terms
SET source_key = 'breathe-london-communities'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('breathelondon-communities.org', 'www.breathelondon-communities.org')
    AND source_key <> 'breathe-london-communities'
    AND source_type = 'publisher' AND enabled = 0
    AND publication_policy = 'manual' AND discovery_method = 'deferred'
    AND json(discovery_config_json) = json('{"retain_excerpt":false}')
    AND content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed')
    AND ai_content_policy = 'disabled' AND search_index_policy = 'metadata_only'
    AND review_text_scan_policy = 'disabled'
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_search_terms.article_id AND a.source_key = 'breathe-london-communities'
);

-- Recheck missing permitted previews on the next scan; preserve image policies.
UPDATE media_articles SET preview_metadata_checked_at = NULL
WHERE source_key = 'breathe-london-communities' AND status = 'pending'
  AND image_policy = 'remote_preview' AND og_image_url IS NULL;

-- Keep the historical source rows for run history and configuration events.
-- Leave sources with current article, evidence, search, author or social references alone.
UPDATE media_sources
SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('breathelondon-communities.org', 'www.breathelondon-communities.org')
  AND source_key <> 'breathe-london-communities'
  AND source_type = 'publisher' AND enabled = 0
  AND publication_policy = 'manual' AND discovery_method = 'deferred'
  AND json(discovery_config_json) = json('{"retain_excerpt":false}')
  AND content_fetch_policy IN ('discovery_metadata_only', 'article_head_allowed')
  AND ai_content_policy = 'disabled' AND search_index_policy = 'metadata_only'
  AND review_text_scan_policy = 'disabled' AND retired_at IS NULL
  AND EXISTS (
    SELECT 1 FROM media_sources
    WHERE source_key = 'breathe-london-communities' AND canonical_domain = 'breathelondon-communities.org'
      AND source_type = 'publisher' AND discovery_method = 'rss'
      AND publication_policy = 'manual' AND retired_at IS NULL
  )
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_author_rules ar WHERE ar.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_source_social_accounts sa
    WHERE sa.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('breathelondon-communities.org', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO NOTHING;
