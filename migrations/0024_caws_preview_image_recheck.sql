-- Give only previously checked, image-less CAWS remote-preview articles one opportunity
-- to use the newly authorised bounded article-content image fallback. The sentinel keeps
-- old discovery Workers from consuming the opportunity after migrations run but before the
-- new Worker is deployed. New discovery replaces it with the real completion timestamp.
UPDATE media_articles
SET preview_metadata_checked_at = '1970-01-01T00:00:00.000Z'
WHERE source_key = 'communities-against-woodsmoke'
  AND image_policy = 'remote_preview'
  AND og_image_url IS NULL
  AND preview_metadata_checked_at IS NOT NULL;
