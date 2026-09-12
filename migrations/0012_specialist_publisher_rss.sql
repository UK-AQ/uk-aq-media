-- Add three specialist publishers through the existing bounded generic RSS path.
-- All remain manual/standard; only Air Quality News retains source-wide auto-approval.
INSERT INTO media_sources (source_key, name, canonical_domain, source_type, enabled,
  publication_policy, review_level, priority, discovery_method, discovery_config_json,
  content_fetch_policy, ai_content_policy, image_policy)
VALUES ('carbon-brief', 'Carbon Brief', 'carbonbrief.org', 'publisher', 1,
  'manual', 'standard', 50, 'rss',
  '{"routes":[{"route_key":"carbon-brief-feed","url":"https://www.carbonbrief.org/feed/","max_items":20}],"retain_excerpt":false}',
  'discovery_metadata_only', 'metadata_only', 'remote_preview')
ON CONFLICT(source_key) DO NOTHING;

INSERT INTO media_sources (source_key, name, canonical_domain, source_type, enabled,
  publication_policy, review_level, priority, discovery_method, discovery_config_json,
  content_fetch_policy, ai_content_policy, image_policy)
VALUES ('openaq', 'OpenAQ', 'openaq.medium.com', 'publisher', 1,
  'manual', 'standard', 50, 'rss',
  '{"routes":[{"route_key":"openaq-medium","url":"https://openaq.medium.com/feed","max_items":20}],"retain_excerpt":false}',
  'discovery_metadata_only', 'metadata_only', 'remote_preview')
ON CONFLICT(source_key) DO NOTHING;

INSERT INTO media_sources (source_key, name, canonical_domain, source_type, enabled,
  publication_policy, review_level, priority, discovery_method, discovery_config_json,
  content_fetch_policy, ai_content_policy, image_policy)
VALUES ('phys-org', 'Phys.org', 'phys.org', 'publisher', 1,
  'manual', 'standard', 50, 'rss',
  '{"routes":[{"route_key":"phys-org-environment","url":"https://phys.org/rss-feed/earth-news/environment/","max_items":20}],"retain_excerpt":false}',
  'discovery_metadata_only', 'disabled', 'remote_preview')
ON CONFLICT(source_key) DO NOTHING;
