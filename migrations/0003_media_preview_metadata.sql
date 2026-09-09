ALTER TABLE media_articles ADD COLUMN display_title TEXT;
ALTER TABLE media_articles ADD COLUMN display_title_origin TEXT
  CHECK (display_title_origin IN ('publisher', 'human', 'ai') OR display_title_origin IS NULL);
ALTER TABLE media_articles ADD COLUMN preview_metadata_checked_at TEXT;

-- Preserve later/manual policy choices: only advance the original AQN policy state.
UPDATE media_sources
SET content_fetch_policy = 'article_head_allowed',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'air-quality-news'
  AND content_fetch_policy = 'discovery_metadata_only';
