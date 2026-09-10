-- Advance only the exact Guardian state established by immutable migration 0004.
-- Existing Guardian article image policies are source-derived in the current model;
-- advance those inherited blocks without touching status, revision, events or image URLs.
UPDATE media_articles
SET image_policy = 'remote_preview'
WHERE source_key = 'the-guardian'
  AND image_policy = 'blocked'
  AND og_image_url IS NULL
  AND EXISTS (
    SELECT 1 FROM media_sources
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
      AND image_policy = 'blocked'
  );

UPDATE media_sources
SET image_policy = 'remote_preview',
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
  AND image_policy = 'blocked';
