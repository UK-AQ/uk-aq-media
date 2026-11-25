-- Register Families for Clean Air's WordPress news feed for bounded discovery.
-- First-party feed only; candidate articles remain Pending for manual editorial review.
-- Verify feed connectivity and actual candidate extraction through a real TEST operation.
INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy,
   review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
   ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('families-for-clean-air', 'Families for Clean Air', 'familiesforcleanair.org', 'publisher',
   1, 'manual', 'standard', 50, 'rss',
   '{"routes":[{"route_key":"families-for-clean-air-feed","url":"https://www.familiesforcleanair.org/feed/","max_items":20}],"retain_excerpt":false}',
   'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only', NULL)
ON CONFLICT(source_key) DO NOTHING;

-- Preserve any existing editorial statuses and canonical URLs when consolidating
-- earlier operator-created publisher identities for this exact domain.
UPDATE media_articles
SET source_key = 'families-for-clean-air', review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('familiesforcleanair.org', 'www.familiesforcleanair.org')
    AND source_key != 'families-for-clean-air'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND (canonical_url LIKE 'https://familiesforcleanair.org/%'
  OR canonical_url LIKE 'https://www.familiesforcleanair.org/%');

UPDATE media_article_discovery_evidence
SET source_key = 'families-for-clean-air'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('familiesforcleanair.org', 'www.familiesforcleanair.org')
    AND source_key != 'families-for-clean-air'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_discovery_evidence.article_id
    AND a.source_key = 'families-for-clean-air'
);

UPDATE media_article_search_terms
SET source_key = 'families-for-clean-air'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE canonical_domain IN ('familiesforcleanair.org', 'www.familiesforcleanair.org')
    AND source_key != 'families-for-clean-air'
    AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
)
AND EXISTS (
  SELECT 1 FROM media_articles a
  WHERE a.id = media_article_search_terms.article_id
    AND a.source_key = 'families-for-clean-air'
);

-- Retire superseded generated sources only once no dependent rows remain.
UPDATE media_sources
SET enabled = 0,
    retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_domain IN ('familiesforcleanair.org', 'www.familiesforcleanair.org')
  AND source_key != 'families-for-clean-air'
  AND (source_key LIKE 'manual-%' OR source_key LIKE 'discovered-publisher-%')
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_search_terms st
    WHERE st.source_key = media_sources.source_key);

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('familiesforcleanair.org', 'non_uk', 'configured_non_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO NOTHING;
