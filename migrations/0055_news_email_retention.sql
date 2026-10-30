-- News-only retention state. Existing articles, editorial/social history remain intact.
ALTER TABLE media_news_approval_events ADD COLUMN email_dispatch_closed INTEGER NOT NULL DEFAULT 0
  CHECK (email_dispatch_closed IN (0,1));
ALTER TABLE media_news_email_outbox ADD COLUMN retention_finished_at TEXT;
ALTER TABLE media_news_email_deliveries ADD COLUMN retention_finished_at TEXT;
CREATE INDEX media_news_outbox_retention ON media_news_email_outbox(state,retention_finished_at,id);
CREATE INDEX media_news_open_retention ON media_news_email_outbox(created_at,id) WHERE state<>'completed';
CREATE INDEX media_news_delivery_outcome_retention ON media_news_email_deliveries(retention_finished_at,id);
CREATE INDEX media_news_delivery_digest_dependency ON media_news_email_deliveries(digest_run_id)
  WHERE digest_run_id IS NOT NULL;
CREATE INDEX media_news_delivery_unresolved_retention ON media_news_email_deliveries(created_at,id)
  WHERE state IN ('pending','sending','temporary_failure','unknown') OR retry_hold=1;
CREATE INDEX media_news_legacy_delivery_retention ON media_news_email_deliveries(id)
  WHERE retention_finished_at IS NULL AND state IN ('accepted','permanent_failure','cancelled') AND retry_hold=0;
CREATE INDEX media_news_outbox_approval ON media_news_email_outbox(approval_event_id,work_type,state);
CREATE INDEX media_news_digest_subscription ON media_news_digest_runs(subscription_id,window_start_utc,id);
CREATE TRIGGER media_news_outbox_finished AFTER UPDATE OF state ON media_news_email_outbox
BEGIN
  UPDATE media_news_email_outbox SET retention_finished_at=CASE WHEN NEW.state='completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=NEW.id;
  UPDATE media_news_approval_events SET email_dispatch_closed=1
    WHERE id=NEW.approval_event_id AND NEW.work_type='approval_dispatch' AND NEW.state='completed';
END;
CREATE TRIGGER media_news_delivery_finished AFTER UPDATE OF state,retry_hold,sent_at,failed_at,reconciled_at
ON media_news_email_deliveries
BEGIN
  UPDATE media_news_email_deliveries SET retention_finished_at=CASE
    WHEN NEW.state IN ('accepted','permanent_failure','cancelled') AND NEW.retry_hold=0
    THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=NEW.id;
END;
CREATE TABLE media_news_retention_status (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  phase TEXT NOT NULL DEFAULT 'history',
  cursors TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cursors)),
  lease_id TEXT, lease_until TEXT,
  requested_at TEXT, last_started_at TEXT, last_success_at TEXT, last_finished_at TEXT,
  state TEXT NOT NULL DEFAULT 'not_run', error_code TEXT,
  eligible INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0, initialised INTEGER NOT NULL DEFAULT 0, minimised INTEGER NOT NULL DEFAULT 0
);
INSERT INTO media_news_retention_status(singleton) VALUES(1);
CREATE TABLE media_news_retention_fences (
  subscription_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX media_news_fence_expiry ON media_news_retention_fences(expires_at,subscription_id);
CREATE TABLE media_news_retention_holds (
  kind TEXT NOT NULL CHECK(kind IN ('history','pending','tokens','tombstones','inactive')),
  record_id TEXT NOT NULL, subscription_id TEXT, reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, checked_at TEXT NOT NULL, review_after TEXT NOT NULL,
  PRIMARY KEY(kind,record_id)
);
CREATE INDEX media_news_hold_review ON media_news_retention_holds(review_after,kind,record_id);
-- At most one bounded selection per cleanup lease; removed in the same batch transaction.
CREATE TABLE media_news_retention_batch (
  lease_id TEXT NOT NULL, id TEXT NOT NULL, digest_run_id TEXT,
  PRIMARY KEY(lease_id,id)
);

DROP TRIGGER media_news_first_approval;
CREATE TRIGGER media_news_first_approval AFTER INSERT ON media_article_events
WHEN NEW.to_status = 'approved' AND (NEW.from_status IS NULL OR NEW.from_status != 'approved')
  AND NEW.event_type IN ('auto_approved','approved','unhidden')
  AND NEW.created_at > (SELECT activated_at FROM media_news_email_settings WHERE singleton = 1)
BEGIN
  INSERT INTO media_news_approval_events
    (id, article_id, approved_at, approval_method, approval_author_rule_key, created_at)
  SELECT NEW.id, a.id, NEW.created_at, a.approval_method, a.approval_author_rule_key, NEW.created_at
  FROM media_articles a WHERE a.id = NEW.article_id AND a.status = 'approved'
    -- julianday supports stored ISO timestamps (including milliseconds/offsets)
    -- and YYYY-MM-DD dates. NULL/unparsable dates cannot satisfy this comparison.
    AND julianday(a.published_at) >= julianday(NEW.created_at) - 7
  ON CONFLICT(article_id) DO NOTHING;
  INSERT INTO media_news_email_outbox (id, approval_event_id, work_type, payload, created_at)
  SELECT 'approval:' || id, id, 'approval_dispatch', json_object('event_id', id, 'after', ''), created_at
  FROM media_news_approval_events WHERE id = NEW.id AND email_dispatch_closed=0
  ON CONFLICT(id) DO NOTHING;
END;
