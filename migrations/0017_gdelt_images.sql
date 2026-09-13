-- Repair GDELT-promoted article image policy left behind when migration 0016
-- advanced the corresponding dynamic publisher source to remote_preview.
-- Preserve existing image URLs and metadata; only the historical article policy is changed.
UPDATE media_articles
SET image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE image_policy = 'blocked'
  AND source_key LIKE 'discovered-publisher-%'
  AND EXISTS (
    SELECT 1
    FROM media_sources s
    WHERE s.source_key = media_articles.source_key
      AND s.retired_at IS NULL
      AND s.image_policy = 'remote_preview'
  )
  AND EXISTS (
    SELECT 1
    FROM media_article_discovery_evidence e
    WHERE e.article_id = media_articles.id
      AND e.provider_key = 'gdelt'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM media_article_discovery_evidence e
    WHERE e.article_id = media_articles.id
      AND e.provider_key = 'publisher_rss'
  );