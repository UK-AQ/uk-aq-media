-- Add secondary research-news reporting to the *News* editorial pipeline only.
-- Primary journal papers belong to the separate Research-page discovery mechanism.
-- These sources are metadata-only and require manual review; nothing is auto-published.
-- Do not rewrite existing article statuses or manually created publisher identities.

INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy, review_level, priority, discovery_method, discovery_config_json, content_fetch_policy, ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('research-news-bioengineer', 'Bioengineer.org', 'bioengineer.org', 'publisher', 1, 'manual', 'standard', 50, 'rss', '{"routes":[{"route_key":"bioengineer-latest","url":"https://bioengineer.org/feed/","max_items":20},{"route_key":"bioengineer-air-pollution","url":"https://bioengineer.org/?s=air+pollution&feed=rss2","max_items":20},{"route_key":"bioengineer-wood-smoke","url":"https://bioengineer.org/?s=wood+smoke&feed=rss2","max_items":20},{"route_key":"bioengineer-particulate-matter","url":"https://bioengineer.org/?s=particulate+matter&feed=rss2","max_items":20},{"route_key":"bioengineer-source-apportionment","url":"https://bioengineer.org/?s=source+apportionment&feed=rss2","max_items":20}],"retain_excerpt":false}', 'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only', NULL)
ON CONFLICT(source_key) DO NOTHING;

INSERT INTO media_sources
  (source_key, name, canonical_domain, source_type, enabled, publication_policy, review_level, priority, discovery_method, discovery_config_json, content_fetch_policy, ai_content_policy, image_policy, search_index_policy, retired_at)
VALUES
  ('research-news-scienmag', 'Scienmag', 'scienmag.com', 'publisher', 1, 'manual', 'standard', 50, 'rss', '{"routes":[{"route_key":"scienmag-latest","url":"https://scienmag.com/feed/","max_items":20},{"route_key":"scienmag-air-pollution","url":"https://scienmag.com/?s=air+pollution&feed=rss2","max_items":20},{"route_key":"scienmag-wood-smoke","url":"https://scienmag.com/?s=wood+smoke&feed=rss2","max_items":20},{"route_key":"scienmag-particulate-matter","url":"https://scienmag.com/?s=particulate+matter&feed=rss2","max_items":20},{"route_key":"scienmag-source-apportionment","url":"https://scienmag.com/?s=source+apportionment&feed=rss2","max_items":20}],"retain_excerpt":false}', 'discovery_metadata_only', 'disabled', 'remote_preview', 'metadata_only', NULL)
ON CONFLICT(source_key) DO NOTHING;
