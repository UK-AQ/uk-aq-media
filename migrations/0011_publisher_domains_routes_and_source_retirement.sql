-- Retired sources remain available to FK-referenced historical articles/runs but are no
-- longer part of the current source catalogue. NULL means current.
ALTER TABLE media_sources ADD COLUMN retired_at TEXT;
CREATE INDEX media_sources_current_catalogue
  ON media_sources(name, source_key) WHERE retired_at IS NULL;

-- Defra / UK-AIR is not an active Media source. Keep the smallest safe historical source
-- definition so existing FK references and article detail joins remain readable.
UPDATE media_sources
SET enabled = 0,
    discovery_method = 'deferred',
    discovery_config_json = '{"retain_excerpt":false}',
    content_fetch_policy = 'discovery_metadata_only',
    ai_content_policy = 'disabled',
    image_policy = 'blocked',
    retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'defra-uk-air'
  AND canonical_domain = 'uk-air.defra.gov.uk'
  AND source_type = 'government';

-- A genuinely unreferenced placeholder needs no historical parent row. Referenced rows
-- fail this explicit test and remain retired for article/run/evidence detail joins.
DELETE FROM media_sources
WHERE source_key = 'defra-uk-air'
  AND retired_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM media_articles WHERE source_key = 'defra-uk-air'
  )
  AND NOT EXISTS (
    SELECT 1 FROM media_discovery_runs WHERE source_key = 'defra-uk-air'
  )
  AND NOT EXISTS (
    SELECT 1 FROM media_author_rules WHERE source_key = 'defra-uk-air'
  )
  AND NOT EXISTS (
    SELECT 1 FROM media_article_discovery_evidence WHERE source_key = 'defra-uk-air'
  );

-- Expand each reviewed publisher through separate bounded RSS route work units while
-- preserving its manual publication policy and all existing article/editorial state.
UPDATE media_sources
SET discovery_config_json = '{"routes":[{"route_key":"bbc-news-top","url":"https://feeds.bbci.co.uk/news/rss.xml","max_items":20},{"route_key":"bbc-news-science-environment","url":"https://feeds.bbci.co.uk/news/science_and_environment/rss.xml","max_items":20},{"route_key":"bbc-news-uk","url":"https://feeds.bbci.co.uk/news/uk/rss.xml","max_items":20},{"route_key":"bbc-news-health","url":"https://feeds.bbci.co.uk/news/health/rss.xml","max_items":20}],"retain_excerpt":false}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'bbc-news'
  AND canonical_domain = 'bbc.co.uk'
  AND source_type = 'publisher'
  AND enabled = 1
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND retired_at IS NULL;

UPDATE media_sources
SET discovery_config_json = '{"routes":[{"route_key":"sky-news-home","url":"https://feeds.skynews.com/feeds/rss/home.xml","max_items":10},{"route_key":"sky-news-uk","url":"https://feeds.skynews.com/feeds/rss/uk.xml","max_items":10},{"route_key":"sky-news-world","url":"https://feeds.skynews.com/feeds/rss/world.xml","max_items":10},{"route_key":"sky-news-technology","url":"https://feeds.skynews.com/feeds/rss/technology.xml","max_items":10}],"retain_excerpt":false}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'sky-news'
  AND canonical_domain = 'news.sky.com'
  AND source_type = 'publisher'
  AND enabled = 1
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND retired_at IS NULL;

UPDATE media_sources
SET discovery_config_json = '{"routes":[{"route_key":"independent-home","url":"https://www.the-independent.com/rss","max_items":20},{"route_key":"independent-uk","url":"https://www.the-independent.com/news/uk/rss","max_items":20},{"route_key":"independent-climate","url":"https://www.the-independent.com/climate-change/rss","max_items":10},{"route_key":"independent-science","url":"https://www.the-independent.com/news/science/rss","max_items":10},{"route_key":"independent-health","url":"https://www.the-independent.com/life-style/health-and-families/rss","max_items":10}],"retain_excerpt":false}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'the-independent'
  AND canonical_domain = 'the-independent.com'
  AND source_type = 'publisher'
  AND enabled = 1
  AND publication_policy = 'manual'
  AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND retired_at IS NULL;
