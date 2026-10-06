-- Serialize confirmation reconciliation before updating the shared subscriber authority.
-- Nullable means no operator decision has yet been claimed for the current attempt.
ALTER TABLE media_news_email_deliveries ADD COLUMN reconciliation_target TEXT
  CHECK (reconciliation_target IN ('accepted','temporary_failure','permanent_failure'));
