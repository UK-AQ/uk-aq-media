-- Consolidate legacy manual source identities created for publishers that now
-- have explicit configured sources. Preserve article editorial state, image
-- policy and image selection; only source identity and its review policy move
-- to the authoritative configured publisher.

UPDATE media_articles
SET source_key = 'bbc-news',
    review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'manual-46d5710873dd'
  AND EXISTS (
    SELECT 1
    FROM media_sources
    WHERE source_key = 'bbc-news'
      AND canonical_domain = 'bbc.co.uk'
      AND retired_at IS NULL
  );

UPDATE media_articles
SET source_key = 'phys-org',
    review_level = 'standard',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'manual-a757862513a6'
  AND EXISTS (
    SELECT 1
    FROM media_sources
    WHERE source_key = 'phys-org'
      AND canonical_domain = 'phys.org'
      AND retired_at IS NULL
  );

-- Retain the obsolete definitions as historical rows, but remove them from
-- current source lookup and dashboard selectors. Do not retire either row if
-- any article could not be reassigned.
UPDATE media_sources
SET enabled = 0,
    retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'manual-46d5710873dd'
  AND canonical_domain = 'bbc.co.uk'
  AND NOT EXISTS (
    SELECT 1 FROM media_articles
    WHERE source_key = 'manual-46d5710873dd'
  );

UPDATE media_sources
SET enabled = 0,
    retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'manual-a757862513a6'
  AND canonical_domain = 'phys.org'
  AND NOT EXISTS (
    SELECT 1 FROM media_articles
    WHERE source_key = 'manual-a757862513a6'
  );
