-- Recheck previously inspected FFCA articles now that the publisher's Webflow
-- article CDN is supported. The sentinel prevents older discovery code consuming
-- the recheck between migration and Worker deployment.
UPDATE media_articles
SET preview_metadata_checked_at = '1970-01-01T00:00:00.000Z'
WHERE source_key = 'families-for-clean-air'
  AND image_policy = 'remote_preview'
  AND og_image_url IS NULL
  AND preview_metadata_checked_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM media_sources s
    WHERE s.source_key = media_articles.source_key
      AND s.canonical_domain = 'familiesforcleanair.org'
      AND s.image_policy = 'remote_preview');

-- Correct only legacy domain-only display labels. Preserve article identity,
-- editorial history, approvals, manually chosen titles and image policy.
UPDATE media_articles
SET publisher = 'Families for Clean Air',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'families-for-clean-air'
  AND lower(trim(publisher)) IN ('familiesforcleanair.org', 'www.familiesforcleanair.org')
  AND EXISTS (SELECT 1 FROM media_sources s
    WHERE s.source_key = media_articles.source_key
      AND s.canonical_domain = 'familiesforcleanair.org');
