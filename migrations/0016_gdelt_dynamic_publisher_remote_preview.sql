-- Permit only bounded presentation metadata and validated remote preview images for
-- conservative GDELT-discovered publishers. All other source policies remain unchanged.
UPDATE media_sources
SET image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key LIKE 'discovered-publisher-%'
  AND image_policy = 'blocked';
