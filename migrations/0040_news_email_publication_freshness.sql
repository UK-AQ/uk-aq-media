-- Forward-only email eligibility correction; retain all existing email history.
-- Publication time is a freshness gate, never the approval-event cursor.
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
  FROM media_news_approval_events WHERE id = NEW.id
  ON CONFLICT(id) DO NOTHING;
END;
