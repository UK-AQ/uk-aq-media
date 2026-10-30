-- Read-only dashboard access paths. Retain the existing delivery/outbox authority.
-- Created-at ranges avoid scanning historical records for bounded recent reads.
CREATE INDEX media_news_delivery_created ON media_news_email_deliveries(created_at, id);
CREATE INDEX media_news_delivery_subscription_created
  ON media_news_email_deliveries(subscription_id, created_at, id);
CREATE INDEX media_news_outbox_created ON media_news_email_outbox(created_at, id);
CREATE INDEX media_news_outbox_subscription_created
  ON media_news_email_outbox(json_extract(payload,'$.subscription_id'), created_at, id);
