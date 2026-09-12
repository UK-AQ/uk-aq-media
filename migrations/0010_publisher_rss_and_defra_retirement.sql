-- Enable the three reviewed publisher RSS sources only from their original deferred state.
-- Each source stays manual: new articles therefore enter Pending through source policy.
UPDATE media_sources
SET enabled = 1,
    discovery_method = 'rss',
    discovery_config_json = '{"routes":[{"route_key":"bbc-news-top","url":"https://feeds.bbci.co.uk/news/rss.xml","max_items":10}],"retain_excerpt":false}',
    image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'bbc-news'
  AND canonical_domain = 'bbc.co.uk'
  AND source_type = 'publisher'
  AND enabled = 0
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'deferred'
  AND json(discovery_config_json) = json('{"retain_excerpt":false}');

UPDATE media_sources
SET enabled = 1,
    discovery_method = 'rss',
    discovery_config_json = '{"routes":[{"route_key":"sky-news-home","url":"https://feeds.skynews.com/feeds/rss/home.xml","max_items":10}],"retain_excerpt":false}',
    image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'sky-news'
  AND canonical_domain = 'news.sky.com'
  AND source_type = 'publisher'
  AND enabled = 0
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'deferred'
  AND json(discovery_config_json) = json('{"retain_excerpt":false}');

-- The publisher now emits its canonical RSS links at the-independent.com. This is a
-- source-specific domain migration, not a generic hostname-validation relaxation.
UPDATE media_sources
SET canonical_domain = 'the-independent.com',
    enabled = 1,
    discovery_method = 'rss',
    discovery_config_json = '{"routes":[{"route_key":"independent-home","url":"https://www.the-independent.com/rss","max_items":10}],"retain_excerpt":false}',
    image_policy = 'remote_preview',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'the-independent'
  AND canonical_domain = 'independent.co.uk'
  AND source_type = 'publisher'
  AND enabled = 0
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'deferred'
  AND json(discovery_config_json) = json('{"retain_excerpt":false}');

-- Preserve rows and any FK-referenced article/run history. The fresh source catalogue no
-- longer contains Defra; upgraded D1 state retains only this non-discoverable historical row.
UPDATE media_sources
SET enabled = 0,
    discovery_method = 'deferred',
    discovery_config_json = '{"retain_excerpt":false}',
    image_policy = 'blocked',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'defra-uk-air'
  AND canonical_domain = 'uk-air.defra.gov.uk'
  AND source_type = 'government';
