-- Only a separately recorded source decision permits transient article-body access.
ALTER TABLE media_sources ADD COLUMN review_text_scan_basis TEXT
  CHECK (review_text_scan_basis IS NULL OR length(trim(review_text_scan_basis)) BETWEEN 1 AND 500);
ALTER TABLE media_sources ADD COLUMN review_text_scan_policy TEXT NOT NULL DEFAULT 'disabled'
  CHECK (review_text_scan_policy IN ('disabled','counts_only') AND
    (review_text_scan_policy = 'disabled' OR review_text_scan_basis IS NOT NULL));

-- Grants and revocations use the existing append-only source configuration history.
CREATE TRIGGER media_review_policy_initial BEFORE INSERT ON media_sources
WHEN NEW.review_text_scan_policy <> 'disabled' BEGIN
  SELECT RAISE(ABORT, 'create_source_before_review_text_grant');
END;
CREATE TRIGGER media_review_policy_changed AFTER UPDATE OF review_text_scan_policy, review_text_scan_basis ON media_sources
WHEN NEW.review_text_scan_policy <> OLD.review_text_scan_policy OR NEW.review_text_scan_basis IS NOT OLD.review_text_scan_basis BEGIN
  INSERT INTO media_configuration_events
    (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
  VALUES ('review-text-policy:' || lower(hex(randomblob(16))), 'source', NEW.source_key, 'updated', 'admin',
    json_object('review_text_scan_policy', OLD.review_text_scan_policy, 'basis', OLD.review_text_scan_basis),
    json_object('operation', 'review_text_scan_policy', 'review_text_scan_policy', NEW.review_text_scan_policy,
      'basis', NEW.review_text_scan_basis), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TABLE media_article_relevance_evidence (
  article_id INTEGER PRIMARY KEY REFERENCES media_articles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  classification TEXT CHECK (classification IN ('clear','ambiguous')),
  status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK (status IN ('not_checked','queued','verified','partial','not_permitted','unavailable')),
  air INTEGER, quality INTEGER, pollution INTEGER, health INTEGER, word_count INTEGER,
  method TEXT CHECK (method IN ('jsonld_article_body','rss_description')),
  checked_at TEXT,
  failure_code TEXT CHECK (failure_code IN ('source_policy','publisher_access','unsafe_url',
    'redirect_limit','not_html','size_limit','fetch_failed','timeout','no_article_body','attempt_limit')),
  -- A due row is the durable intent. The token fences delayed deliveries and stale completions.
  due_at INTEGER DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  token TEXT,
  CHECK ((status IN ('verified','partial') AND classification IS 'ambiguous'
    AND air IS NOT NULL AND quality IS NOT NULL AND pollution IS NOT NULL AND health IS NOT NULL
    AND min(air, quality, pollution, health) >= 0 AND word_count BETWEEN 1 AND 524288
    AND word_count IS NOT NULL AND checked_at IS NOT NULL
    AND ((status = 'verified' AND method IS 'jsonld_article_body') OR
         (status = 'partial' AND method IS 'rss_description')))
    OR (status NOT IN ('verified','partial') AND air IS NULL AND quality IS NULL
    AND pollution IS NULL AND health IS NULL AND word_count IS NULL AND method IS NULL))
) STRICT;
CREATE INDEX media_relevance_due ON media_article_relevance_evidence(due_at, article_id)
  WHERE due_at IS NOT NULL;

-- Every admission path, including GDELT and duplicate holds, commits the same tiny intent.
-- No scan, queue delivery, or existing-article backfill runs in this transaction.
CREATE TRIGGER media_relevance_admission AFTER INSERT ON media_articles
WHEN NEW.status = 'pending' BEGIN
  INSERT INTO media_article_relevance_evidence (article_id) VALUES (NEW.id);
END;
CREATE TRIGGER media_relevance_reclassify AFTER UPDATE OF source_key, title, canonical_url, status ON media_articles
WHEN NEW.status = 'pending' AND (OLD.status <> NEW.status OR OLD.source_key <> NEW.source_key
  OR OLD.title <> NEW.title OR OLD.canonical_url <> NEW.canonical_url) BEGIN
  DELETE FROM media_article_relevance_evidence WHERE article_id = NEW.id;
  INSERT INTO media_article_relevance_evidence (article_id) VALUES (NEW.id);
END;
CREATE TRIGGER media_relevance_cancel AFTER UPDATE OF status ON media_articles
WHEN OLD.status = 'pending' AND NEW.status <> 'pending' BEGIN
  UPDATE media_article_relevance_evidence SET due_at = NULL, token = NULL
    WHERE article_id = NEW.id AND due_at IS NOT NULL;
END;
