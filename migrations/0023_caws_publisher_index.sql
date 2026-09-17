-- Add the bounded Communities Against Woodsmoke Blog publisher-index source. The
-- existing discovery vocabulary calls publisher-native indexes "sitemap"; this
-- adapter fetches only the configured /blog/ page and records publisher_web_index evidence.
INSERT INTO media_sources (source_key, name, canonical_domain, source_type, enabled,
  publication_policy, review_level, priority, discovery_method, discovery_config_json,
  content_fetch_policy, ai_content_policy, image_policy, retired_at)
VALUES ('communities-against-woodsmoke', 'Communities Against Woodsmoke',
  'communitiesagainstwoodsmoke.com', 'publisher', 1, 'manual', 'standard', 50, 'sitemap',
  '{"routes":[{"route_key":"communities-against-woodsmoke-blog-index","url":"https://www.communitiesagainstwoodsmoke.com/blog/","max_items":20}],"retain_excerpt":false}',
  'discovery_metadata_only', 'metadata_only', 'remote_preview', NULL)
ON CONFLICT(source_key) DO UPDATE SET
  name = excluded.name,
  canonical_domain = excluded.canonical_domain,
  source_type = excluded.source_type,
  enabled = excluded.enabled,
  publication_policy = excluded.publication_policy,
  review_level = excluded.review_level,
  priority = excluded.priority,
  discovery_method = excluded.discovery_method,
  discovery_config_json = excluded.discovery_config_json,
  content_fetch_policy = excluded.content_fetch_policy,
  ai_content_policy = excluded.ai_content_policy,
  image_policy = excluded.image_policy,
  retired_at = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
VALUES ('communitiesagainstwoodsmoke.com', 'uk', 'configured_uk_publisher',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(publisher_domain) DO UPDATE SET
  publisher_scope = excluded.publisher_scope,
  classification_reason = excluded.classification_reason,
  updated_at = excluded.updated_at;
