-- Forward-only cut-over: replace the event trigger without scanning prior events
-- or changing any existing publication row. Existing status CHECKs support waiting.
CREATE VIEW media_bluesky_thumbnail_eligible_articles AS
SELECT a.id AS article_id
FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
WHERE a.og_image_url IS NOT NULL AND (
  (a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview')
  OR (a.image_policy = 'local_copy_permitted' AND s.image_policy = 'local_copy_permitted')
);

DROP TRIGGER media_bluesky_automatic_outbox;
CREATE TRIGGER media_bluesky_automatic_outbox AFTER INSERT ON media_article_events
WHEN NEW.event_type = 'auto_approved'
  AND EXISTS (
    SELECT 1 FROM media_bluesky_settings
    WHERE id = 1 AND activation_event_id IS NOT NULL AND NEW.id > activation_event_id
  )
BEGIN
  INSERT OR IGNORE INTO media_bluesky_publications
    (article_id, approval_event_id, publication_key, publication_reason, status,
     last_error_code, next_attempt_at, created_at, updated_at)
  SELECT NEW.article_id, NEW.id, 'approval-event:' || NEW.id, 'auto_approved',
    CASE WHEN ready.article_id IS NOT NULL THEN 'queued' ELSE 'blocked' END,
    CASE WHEN ready.article_id IS NOT NULL THEN NULL ELSE 'thumbnail_pending' END,
    NULL, NEW.created_at, NEW.created_at
  FROM (SELECT NEW.article_id AS article_id) event
  LEFT JOIN media_bluesky_thumbnail_eligible_articles ready ON ready.article_id = event.article_id;
END;

-- Transactional defence for every manual creation path, including status-change
-- requests racing an automatic approval. Posted rows still permit deliberate reposts.
CREATE TRIGGER media_bluesky_manual_intent_guard BEFORE INSERT ON media_bluesky_publications
WHEN NEW.publication_reason <> 'auto_approved' AND EXISTS (
  SELECT 1 FROM media_bluesky_publications p
  WHERE p.article_id = NEW.article_id AND p.publication_reason = 'auto_approved'
    AND (p.status IN ('queued', 'posting')
      OR (p.status = 'blocked' AND p.last_error_code = 'thumbnail_pending'))
)
BEGIN
  SELECT RAISE(ABORT, 'bluesky_publication_in_progress');
END;
