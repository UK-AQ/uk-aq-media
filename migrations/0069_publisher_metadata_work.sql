-- A bounded queue outbox and last outcome for observed articles. No historical backfill.
CREATE TABLE media_article_metadata_work (
  article_id INTEGER PRIMARY KEY REFERENCES media_articles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'complete', 'partial', 'unavailable', 'disallowed', 'transient')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at TEXT,
  lease_token TEXT,
  normalise_new_title INTEGER NOT NULL DEFAULT 0 CHECK (normalise_new_title IN (0, 1)),
  reconcile_pending INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_pending IN (0, 1)),
  checked_at TEXT
);

CREATE INDEX media_article_metadata_work_due
  ON media_article_metadata_work(next_at, article_id) WHERE next_at IS NOT NULL;
