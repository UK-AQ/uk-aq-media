-- Replace the discontinued Families for Clean Air RSS route (redirects to HTTP 404)
-- with a bounded first-party HTML index. Preserve the existing publisher, article
-- identities, editorial decisions, run history and manual publication policy.
-- Only advance the exact previously configured RSS source; do not override
-- operator changes or unrelated publishers.
UPDATE media_sources
SET discovery_method = 'sitemap',
    discovery_config_json = '{"routes":[{"route_key":"families-for-clean-air-news-index","url":"https://www.familiesforcleanair.org/news/","max_items":20}],"retain_excerpt":false}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'families-for-clean-air'
  AND canonical_domain = 'familiesforcleanair.org'
  AND source_type = 'publisher' AND enabled = 1
  AND publication_policy = 'manual' AND review_level = 'standard'
  AND discovery_method = 'rss'
  AND json_valid(discovery_config_json)
  AND json(discovery_config_json) = json('{"routes":[{"route_key":"families-for-clean-air-feed","url":"https://www.familiesforcleanair.org/feed/","max_items":20}],"retain_excerpt":false}')
  AND content_fetch_policy = 'discovery_metadata_only'
  AND ai_content_policy = 'disabled' AND image_policy = 'remote_preview'
  AND search_index_policy = 'metadata_only' AND retired_at IS NULL;
