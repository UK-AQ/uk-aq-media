-- Prospective safety hold for otherwise-automatic approvals. This migration does
-- not inspect or reclassify existing articles.
CREATE TABLE media_article_possible_duplicates (
  article_id INTEGER PRIMARY KEY REFERENCES media_articles(id),
  candidate_article_id INTEGER NOT NULL REFERENCES media_articles(id),
  reason_code TEXT NOT NULL CHECK (
    reason_code = 'same_source_exact_title_same_published_at'
  ),
  hold_created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('approved', 'rejected')),
  CHECK (article_id <> candidate_article_id),
  CHECK (
    (resolved_at IS NULL AND resolution IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);

CREATE INDEX media_articles_possible_duplicate_lookup
  ON media_articles(source_key, title, id)
  WHERE published_at IS NOT NULL;

-- Approval/rejection is the explicit operator resolution. Other edits and
-- rediscovery leave the hold active and preserve the evidence row.
CREATE TRIGGER media_possible_duplicate_hold_resolve
AFTER UPDATE OF status ON media_articles
WHEN OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
BEGIN
  UPDATE media_article_possible_duplicates
  SET resolved_at = NEW.updated_at, resolution = NEW.status
  WHERE article_id = NEW.id AND resolved_at IS NULL;
END;
