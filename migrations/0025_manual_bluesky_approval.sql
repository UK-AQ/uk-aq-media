-- Forward-only contract correction: only genuine automatic approvals create the
-- automatic Bluesky outbox. Existing publication/audit rows remain untouched.
DROP TRIGGER media_bluesky_automatic_outbox;

CREATE TRIGGER media_bluesky_automatic_outbox AFTER INSERT ON media_article_events
WHEN NEW.event_type = 'auto_approved'
  AND EXISTS (
    SELECT 1 FROM media_bluesky_settings
    WHERE id = 1 AND activation_event_id IS NOT NULL AND NEW.id > activation_event_id
  )
  AND EXISTS (
    SELECT 1 FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = NEW.article_id AND a.og_image_url IS NOT NULL
      AND a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview'
  )
BEGIN
  INSERT OR IGNORE INTO media_bluesky_publications
    (article_id, approval_event_id, publication_key, publication_reason, status,
     created_at, updated_at)
  VALUES (NEW.article_id, NEW.id, 'approval-event:' || NEW.id,
    'auto_approved', 'queued', NEW.created_at, NEW.created_at);
END;

-- One durable identity owns each bounded bulk approval request and its social
-- intent. Target IDs are canonicalised by the API before storage.
CREATE TABLE media_admin_bulk_status_requests (
  request_key TEXT PRIMARY KEY,
  article_ids_json TEXT NOT NULL CHECK (json_valid(article_ids_json)),
  post_to_bluesky INTEGER NOT NULL CHECK (post_to_bluesky IN (0, 1)),
  created_at TEXT NOT NULL
);
