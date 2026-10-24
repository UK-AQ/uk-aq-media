-- Nullable additions retain historical run evidence. No separate cooldown datastore:
-- a failed run's one existing finish UPDATE also records its publisher cooldown.
ALTER TABLE media_discovery_runs ADD COLUMN feed_diagnostics TEXT
  CHECK (feed_diagnostics IS NULL OR
    (length(feed_diagnostics) <= 1024 AND json_valid(feed_diagnostics)
      AND json_type(feed_diagnostics) = 'object'));
ALTER TABLE media_discovery_runs ADD COLUMN retry_not_before TEXT
  CHECK (retry_not_before IS NULL OR length(retry_not_before) = 24);
CREATE INDEX media_runs_source_retry
  ON media_discovery_runs(source_key, retry_not_before DESC)
  WHERE retry_not_before IS NOT NULL;
