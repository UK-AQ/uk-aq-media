-- Publisher admission decisions are independent of saved source/editorial policies.
CREATE TABLE IF NOT EXISTS media_source_domain_blocks (
  domain TEXT PRIMARY KEY CHECK (domain = lower(domain) AND domain NOT GLOB 'www.*'),
  blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_source_domain_blocks_active
  ON media_source_domain_blocks(domain) WHERE blocked = 1;

-- Same append-only configuration event model, with domain-specific request receipts.
-- Existing source/author configuration events and their constraints remain intact.
CREATE TABLE IF NOT EXISTS media_source_domain_block_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'initialisation')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_source_domain_block_events_domain
  ON media_source_domain_block_events(domain, id DESC);
CREATE INDEX IF NOT EXISTS media_source_domain_block_events_initial
  ON media_source_domain_block_events(domain)
  WHERE actor_type = 'initialisation' AND event_key = 'initial-domain-block:' || domain;
CREATE TRIGGER IF NOT EXISTS media_source_domain_block_events_no_update
BEFORE UPDATE ON media_source_domain_block_events BEGIN
  SELECT RAISE(ABORT, 'domain_block_events_are_append_only');
END;
CREATE TRIGGER IF NOT EXISTS media_source_domain_block_events_no_delete
BEFORE DELETE ON media_source_domain_block_events BEGIN
  SELECT RAISE(ABORT, 'domain_block_events_are_append_only');
END;

-- Keep explicit false decisions. Reapplication must never re-block an operator unblock.
INSERT OR IGNORE INTO media_source_domain_blocks
  (domain, blocked, reason, created_at, updated_at) VALUES
  ('southwalesargus.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shootinguk.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sloughobserver.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bournemouthecho.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bracknellnews.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('newburytoday.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dorsetecho.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('readingchronicle.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('derbytelegraph.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('hulldailymail.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('grimsbytelegraph.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('getsurrey.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('gazettelive.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('plymouthherald.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('cambridge-news.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('leicestermercury.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dailypost.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('somersetlive.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('stokesentinel.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('belfastlive.co.uk', 1, 'initial_publisher_domain_blocklist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO media_source_domain_block_events
  (event_key, domain, actor_type, request_json, before_json, after_json, created_at)
SELECT 'initial-domain-block:' || domain, domain, 'initialisation',
  json_object('domain', domain, 'blocked', json('true'), 'reason', 'initial_publisher_domain_blocklist'),
  NULL, json_object('domain', domain, 'blocked', json(CASE blocked WHEN 1 THEN 'true' ELSE 'false' END),
    'reason', reason, 'created_at', created_at, 'updated_at', updated_at), created_at
FROM media_source_domain_blocks WHERE domain IN (
  'southwalesargus.co.uk',
  'shootinguk.co.uk',
  'sloughobserver.co.uk',
  'bournemouthecho.co.uk',
  'bracknellnews.co.uk',
  'newburytoday.co.uk',
  'dorsetecho.co.uk',
  'readingchronicle.co.uk',
  'derbytelegraph.co.uk',
  'hulldailymail.co.uk',
  'grimsbytelegraph.co.uk',
  'getsurrey.co.uk',
  'gazettelive.co.uk',
  'plymouthherald.co.uk',
  'cambridge-news.co.uk',
  'leicestermercury.co.uk',
  'dailypost.co.uk',
  'somersetlive.co.uk',
  'stokesentinel.co.uk',
  'belfastlive.co.uk');

CREATE TABLE IF NOT EXISTS media_source_domain_cleanup_requests (
  request_key TEXT PRIMARY KEY,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  selected_ids_json TEXT NOT NULL CHECK (json_valid(selected_ids_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL
);

-- Reason metadata is emitted by the existing authoritative transition trigger.
-- No historical article transitions occur during migration.
DROP TRIGGER media_article_transition;
CREATE TRIGGER media_article_transition AFTER UPDATE OF status ON media_articles
WHEN OLD.status != NEW.status BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
      created_at, metadata_json)
  VALUES (NEW.id, NEW.mutation_key,
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN 'auto_approved'
      WHEN NEW.status = 'approved' AND OLD.status = 'hidden' THEN 'unhidden'
      WHEN NEW.status = 'approved' THEN 'approved'
      WHEN NEW.status = 'rejected' THEN 'rejected'
      WHEN NEW.status = 'hidden' THEN 'hidden' ELSE 'edited' END),
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN 'discovery' ELSE 'admin' END),
    OLD.status, NEW.status, NEW.revision, NEW.updated_at,
    (CASE WHEN NEW.mutation_key GLOB 'author-auto:*' THEN json_object(
      'approval_method', NEW.approval_method,
      'author_rule_key', NEW.approval_author_rule_key
    ) WHEN NEW.mutation_key GLOB 'blocked-source-initial-cleanup:*' THEN json_object(
      'reason', 'blocked_source_initial_cleanup'
    ) ELSE '{}' END));
END;

-- Chunk-local operational evidence commits with the existing GDELT replay receipt.
-- No candidate/checkpoint/retry policy is changed.
CREATE TABLE IF NOT EXISTS media_gdelt_domain_block_skips (
  file_stamp TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  blocked_skipped INTEGER NOT NULL CHECK (blocked_skipped >= 0),
  PRIMARY KEY (file_stamp, chunk_index)
);
