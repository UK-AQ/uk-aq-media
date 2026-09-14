-- Establish DSAWSP as an explicit manual publisher source. The existing discovery_method
-- vocabulary calls bounded publisher-native indexes "sitemap"; evidence records the more
-- precise publisher_web_index provider identity.
INSERT INTO media_sources (source_key, name, canonical_domain, source_type, enabled,
  publication_policy, review_level, priority, discovery_method, discovery_config_json,
  content_fetch_policy, ai_content_policy, image_policy, retired_at)
VALUES ('dsawsp', 'Doctors and Scientists Against Wood Smoke Pollution', 'dsawsp.org',
  'publisher', 1, 'manual', 'standard', 50, 'sitemap',
  '{"routes":[{"route_key":"dsawsp-news-extras","url":"https://www.dsawsp.org/resources/blog","max_items":20}],"retain_excerpt":false}',
  'article_head_allowed', 'disabled', 'remote_preview', NULL)
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

-- Promote articles and evidence from any dynamic/manual publisher identity for this exact
-- canonical domain. Article/editorial columns are untouched, so reviewed states survive.
UPDATE media_articles
SET source_key = 'dsawsp', publisher =
  CASE WHEN publisher = '' THEN 'Doctors and Scientists Against Wood Smoke Pollution'
    ELSE publisher END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE source_key != 'dsawsp' AND lower(replace(canonical_domain, 'www.', '')) = 'dsawsp.org'
);

UPDATE media_article_discovery_evidence
SET source_key = 'dsawsp'
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE source_key != 'dsawsp' AND lower(replace(canonical_domain, 'www.', '')) = 'dsawsp.org'
);

UPDATE media_discovery_runs
SET source_key = 'dsawsp', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE source_key != 'dsawsp' AND lower(replace(canonical_domain, 'www.', '')) = 'dsawsp.org'
);

UPDATE media_author_rules
SET source_key = 'dsawsp', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN (
  SELECT source_key FROM media_sources
  WHERE source_key != 'dsawsp' AND lower(replace(canonical_domain, 'www.', '')) = 'dsawsp.org'
);

DELETE FROM media_sources
WHERE source_key != 'dsawsp' AND lower(replace(canonical_domain, 'www.', '')) = 'dsawsp.org'
  AND NOT EXISTS (SELECT 1 FROM media_articles a WHERE a.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_article_discovery_evidence e
    WHERE e.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_discovery_runs r
    WHERE r.source_key = media_sources.source_key)
  AND NOT EXISTS (SELECT 1 FROM media_author_rules ar
    WHERE ar.source_key = media_sources.source_key);
