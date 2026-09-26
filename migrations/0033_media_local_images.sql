CREATE TABLE media_article_local_images (
  article_id INTEGER PRIMARY KEY REFERENCES media_articles(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  source_image_url TEXT NOT NULL,
  source_image_url_hash TEXT NOT NULL CHECK (length(source_image_url_hash) = 64),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  acquisition_method TEXT NOT NULL CHECK (acquisition_method IN ('publisher_fetch', 'admin_upload')),
  stored_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX media_article_local_images_source_identity
  ON media_article_local_images(source_image_url_hash, article_id);
CREATE INDEX media_article_local_images_content
  ON media_article_local_images(content_sha256, article_id);

-- Bounded request receipts prevent a replayed upload/removal key from being
-- applied to a later image state. They contain metadata only, never image bytes.
CREATE TABLE media_article_local_image_operations (
  request_key TEXT PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES media_articles(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'remove')),
  article_revision INTEGER NOT NULL CHECK (article_revision >= 0),
  source_image_url_hash TEXT,
  content_sha256 TEXT,
  created_at TEXT NOT NULL,
  CHECK ((operation = 'upload') =
    (source_image_url_hash IS NOT NULL AND content_sha256 IS NOT NULL))
);
CREATE INDEX media_article_local_image_operations_article
  ON media_article_local_image_operations(article_id, created_at DESC);

-- Automatic approval may queue a local-copy article with a current publisher
-- image identity. The consumer obtains/captures the permitted bytes before it
-- posts; remote_preview eligibility is unchanged.
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
      AND ((a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview')
        OR (a.image_policy = 'local_copy_permitted'
          AND s.image_policy = 'local_copy_permitted'))
  )
BEGIN
  INSERT OR IGNORE INTO media_bluesky_publications
    (article_id, approval_event_id, publication_key, publication_reason, status,
     created_at, updated_at)
  VALUES (NEW.article_id, NEW.id, 'approval-event:' || NEW.id,
    'auto_approved', 'queued', NEW.created_at, NEW.created_at);
END;
