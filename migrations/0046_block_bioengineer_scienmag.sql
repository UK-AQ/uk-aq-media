-- Reverse the temporary research-news publisher integration from 0043.
-- Existing article/editorial history is preserved. These publishers are no longer admitted
-- to the News pipeline and their configured source rows are retired.
UPDATE media_sources
SET enabled = 0,
    retired_at = coalesce(retired_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key IN ('research-news-bioengineer', 'research-news-scienmag');

-- Record the explicit policy decisions without adding these domains to the original
-- 20-domain cleanup cohort created by migration 0041.
INSERT OR IGNORE INTO media_source_domain_block_events
  (event_key, domain, actor_type, request_json, before_json, after_json, created_at)
SELECT 'publisher-quality-block:bioengineer.org', 'bioengineer.org', 'initialisation',
  json_object('domain', 'bioengineer.org', 'blocked', json('true'),
    'reason', 'publisher_quality_exclusion'),
  (SELECT json_object('domain', domain, 'blocked',
      json(CASE blocked WHEN 1 THEN 'true' ELSE 'false' END), 'reason', reason,
      'created_at', created_at, 'updated_at', updated_at)
   FROM media_source_domain_blocks WHERE domain = 'bioengineer.org'),
  json_object('domain', 'bioengineer.org', 'blocked', json('true'),
    'reason', 'publisher_quality_exclusion',
    'created_at', coalesce((SELECT created_at FROM media_source_domain_blocks
      WHERE domain = 'bioengineer.org'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

INSERT OR IGNORE INTO media_source_domain_block_events
  (event_key, domain, actor_type, request_json, before_json, after_json, created_at)
SELECT 'publisher-quality-block:scienmag.com', 'scienmag.com', 'initialisation',
  json_object('domain', 'scienmag.com', 'blocked', json('true'),
    'reason', 'publisher_quality_exclusion'),
  (SELECT json_object('domain', domain, 'blocked',
      json(CASE blocked WHEN 1 THEN 'true' ELSE 'false' END), 'reason', reason,
      'created_at', created_at, 'updated_at', updated_at)
   FROM media_source_domain_blocks WHERE domain = 'scienmag.com'),
  json_object('domain', 'scienmag.com', 'blocked', json('true'),
    'reason', 'publisher_quality_exclusion',
    'created_at', coalesce((SELECT created_at FROM media_source_domain_blocks
      WHERE domain = 'scienmag.com'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

INSERT INTO media_source_domain_blocks
  (domain, blocked, reason, created_at, updated_at)
VALUES
  ('bioengineer.org', 1, 'publisher_quality_exclusion',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('scienmag.com', 1, 'publisher_quality_exclusion',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(domain) DO UPDATE SET
  blocked = 1,
  reason = excluded.reason,
  updated_at = excluded.updated_at;
