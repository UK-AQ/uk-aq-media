-- Preview images are narrowly bounded presentation metadata, independent of broader
-- article content-fetch policy. Government/non-publisher blocks remain unchanged.
-- Advance inherited article policy without changing editorial state or existing images.
UPDATE media_articles
SET image_policy = 'remote_preview'
WHERE image_policy = 'blocked'
  AND source_key IN (
    SELECT source_key FROM media_sources
    WHERE source_type = 'publisher' AND image_policy = 'blocked'
  );

UPDATE media_sources
SET image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_type = 'publisher'
  AND image_policy = 'blocked';
