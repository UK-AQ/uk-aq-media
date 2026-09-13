CREATE TABLE media_public_feed_state (
  scope TEXT PRIMARY KEY CHECK (scope = 'homepage_latest_6'),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'array'),
  updated_at TEXT NOT NULL
);

WITH latest_six AS (
  SELECT a.id, a.canonical_url, a.title, a.display_title, a.publisher, a.published_at, a.feed_sort_at,
    CASE WHEN a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview'
      THEN a.og_image_url ELSE NULL END AS preview_image_url
  FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
  WHERE a.status = 'approved'
  ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT 6
)
INSERT INTO media_public_feed_state (scope, generation, snapshot_json, updated_at)
SELECT 'homepage_latest_6', 1, coalesce(json_group_array(json_object(
  'id', id,
  'canonical_url', canonical_url,
  'title', title,
  'display_title', display_title,
  'publisher', publisher,
  'published_at', published_at,
  'preview_image_url', preview_image_url
)), '[]'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT * FROM latest_six ORDER BY feed_sort_at DESC, id DESC);
