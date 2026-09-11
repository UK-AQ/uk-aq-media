ALTER TABLE media_articles ADD COLUMN ai_title_attempted_at TEXT;
ALTER TABLE media_articles ADD COLUMN ai_title_suggestion TEXT
  CHECK (ai_title_suggestion IS NULL OR (
    length(ai_title_suggestion) BETWEEN 1 AND 64
    AND instr(ai_title_suggestion, char(10)) = 0
    AND instr(ai_title_suggestion, char(13)) = 0
  ));
ALTER TABLE media_articles ADD COLUMN ai_title_suggestion_state TEXT
  CHECK (ai_title_suggestion_state IN ('pending', 'accepted', 'rejected')
    OR ai_title_suggestion_state IS NULL);
ALTER TABLE media_articles ADD COLUMN ai_title_model TEXT
  CHECK (ai_title_model IS NULL OR length(ai_title_model) BETWEEN 1 AND 200);
ALTER TABLE media_articles ADD COLUMN ai_title_prompt_version TEXT
  CHECK (ai_title_prompt_version IS NULL OR length(ai_title_prompt_version) BETWEEN 1 AND 200);
ALTER TABLE media_articles ADD COLUMN ai_title_generated_at TEXT;
ALTER TABLE media_articles ADD COLUMN ai_title_decided_at TEXT;

CREATE TABLE media_ai_daily_usage (
  usage_date TEXT PRIMARY KEY
    CHECK (length(usage_date) = 10
      AND usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  display_title_calls INTEGER NOT NULL DEFAULT 0
    CHECK (display_title_calls BETWEEN 0 AND 50),
  updated_at TEXT NOT NULL
);

-- Preserve later/operator policy choices: only advance the exact current AQN policy shape.
UPDATE media_sources
SET ai_content_policy = 'metadata_only',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'air-quality-news'
  AND canonical_domain = 'airqualitynews.com'
  AND source_type = 'publisher'
  AND enabled = 1
  AND publication_policy = 'auto_approve'
  AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND json(discovery_config_json) = json('{"url":"https://airqualitynews.com/feed/","max_items":20,"retain_excerpt":false}')
  AND content_fetch_policy = 'article_head_allowed'
  AND ai_content_policy = 'disabled'
  AND image_policy = 'remote_preview';

-- Preserve later/operator policy choices: only advance the exact Guardian state from 0005.
UPDATE media_sources
SET ai_content_policy = 'metadata_only',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'the-guardian'
  AND canonical_domain = 'theguardian.com'
  AND source_type = 'publisher'
  AND enabled = 1
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND json(discovery_config_json) = json('{"routes":[{"route_key":"gary-fuller","url":"https://www.theguardian.com/profile/gary-fuller/rss","max_items":10},{"route_key":"damian-carrington","url":"https://www.theguardian.com/profile/damiancarrington/rss","max_items":10},{"route_key":"fiona-harvey","url":"https://www.theguardian.com/profile/fiona-harvey/rss","max_items":10},{"route_key":"guardian-air-pollution","url":"https://www.theguardian.com/environment/air-pollution/rss","max_items":10},{"route_key":"guardian-environment","url":"https://www.theguardian.com/environment/rss","max_items":10},{"route_key":"guardian-pollution","url":"https://www.theguardian.com/environment/pollution/rss","max_items":10},{"route_key":"guardian-uk","url":"https://www.theguardian.com/uk/rss","max_items":10},{"route_key":"guardian-world","url":"https://www.theguardian.com/world/rss","max_items":10},{"route_key":"guardian-climate-crisis","url":"https://www.theguardian.com/environment/climate-crisis/rss","max_items":10},{"route_key":"guardian-science","url":"https://www.theguardian.com/science/rss","max_items":10},{"route_key":"guardian-technology","url":"https://www.theguardian.com/technology/rss","max_items":10}],"retain_excerpt":false}')
  AND content_fetch_policy = 'discovery_metadata_only'
  AND ai_content_policy = 'disabled'
  AND image_policy = 'remote_preview';
