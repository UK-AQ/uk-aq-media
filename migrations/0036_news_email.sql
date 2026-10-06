-- Forward-only News email capability. Dormant until an operator sets activated_at.
-- No article, social-publication or existing editorial-event mutation.
CREATE TABLE media_news_email_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  activated_at TEXT
);
INSERT INTO media_news_email_settings VALUES (1, NULL);
CREATE TABLE media_news_approval_events (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL UNIQUE REFERENCES media_articles(id),
  approved_at TEXT NOT NULL,
  approval_method TEXT NOT NULL,
  approval_author_rule_key TEXT,
  event_kind TEXT NOT NULL DEFAULT 'first_approval' CHECK (event_kind = 'first_approval'),
  email_eligible INTEGER NOT NULL DEFAULT 1 CHECK (email_eligible = 1),
  created_at TEXT NOT NULL
);
CREATE INDEX media_news_approval_window ON media_news_approval_events(approved_at, id);
CREATE TABLE media_news_email_outbox (
  id TEXT PRIMARY KEY,
  approval_event_id INTEGER REFERENCES media_news_approval_events(id),
  work_type TEXT NOT NULL CHECK (work_type IN
    ('confirmation_email','approval_dispatch','immediate_delivery','daily_digest','daily_scan','confirmation_scan')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','queued','completed')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  queued_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX media_news_outbox_recovery ON media_news_email_outbox(state, queued_at);
CREATE TABLE media_news_digest_runs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  scheduled_for_utc TEXT NOT NULL,
  window_start_utc TEXT NOT NULL,
  window_end_utc TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  item_count INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  UNIQUE(subscription_id, scheduled_for_utc)
);
CREATE TABLE media_news_email_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  approval_event_id INTEGER REFERENCES media_news_approval_events(id),
  digest_run_id TEXT REFERENCES media_news_digest_runs(id),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('immediate','daily','confirmation')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','sending','accepted','temporary_failure','permanent_failure','unknown','cancelled')),
  message_id TEXT NOT NULL UNIQUE,
  -- Selection changes only on an explicit safe operator retry; last attempt is retained.
  selected_transport TEXT NOT NULL DEFAULT 'cloudflare_xoauth2'
    CHECK (selected_transport IN ('cloudflare_xoauth2','pro_app_password')),
  attempt_transport TEXT CHECK (attempt_transport IN ('cloudflare_xoauth2','pro_app_password')),
  submission_started INTEGER NOT NULL DEFAULT 0 CHECK (submission_started IN (0,1)),
  retry_hold INTEGER NOT NULL DEFAULT 0 CHECK (retry_hold IN (0,1)),
  reconciled_at TEXT,
  reconciliation_evidence TEXT CHECK (reconciliation_evidence IN
    ('workspace_mail_log','recipient_confirmation','provider_result','pro_receipt')),
  reconciliation_reference TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  sent_at TEXT,
  failed_at TEXT,
  last_error TEXT,
  UNIQUE(subscription_id, approval_event_id, delivery_mode)
);
-- Ephemeral abuse evidence only: HMAC keys, never raw client IPs.
CREATE TABLE media_news_rate_events (
  id TEXT PRIMARY KEY, rate_key TEXT NOT NULL, occurred_at INTEGER NOT NULL
);
CREATE INDEX media_news_rate_window ON media_news_rate_events(rate_key, occurred_at);
-- All existing insert, single, bulk, unhide and author transitions already append here.
-- A single decision point covers genuine transitions, never metadata edits or backfill.
CREATE TRIGGER media_news_first_approval AFTER INSERT ON media_article_events
WHEN NEW.to_status = 'approved' AND (NEW.from_status IS NULL OR NEW.from_status != 'approved')
  AND NEW.event_type IN ('auto_approved','approved','unhidden')
  AND NEW.created_at > (SELECT activated_at FROM media_news_email_settings WHERE singleton = 1)
BEGIN
  INSERT INTO media_news_approval_events
    (id, article_id, approved_at, approval_method, approval_author_rule_key, created_at)
  SELECT NEW.id, a.id, NEW.created_at, a.approval_method, a.approval_author_rule_key, NEW.created_at
  FROM media_articles a WHERE a.id = NEW.article_id AND a.status = 'approved'
  ON CONFLICT(article_id) DO NOTHING;
  INSERT INTO media_news_email_outbox (id, approval_event_id, work_type, payload, created_at)
  SELECT 'approval:' || id, id, 'approval_dispatch', json_object('event_id', id, 'after', ''), created_at
  FROM media_news_approval_events WHERE id = NEW.id
  ON CONFLICT(id) DO NOTHING;
END;
