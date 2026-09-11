-- Bounded Media dashboard query paths and append-only source/rule mutation provenance.

CREATE INDEX media_articles_status_approved
  ON media_articles(status, coalesce(approved_at, '') DESC, id DESC);
CREATE INDEX media_articles_status_discovered
  ON media_articles(status, discovered_at DESC, id DESC);
CREATE INDEX media_articles_status_updated
  ON media_articles(status, updated_at DESC, id DESC);
CREATE INDEX media_articles_source_status_feed
  ON media_articles(source_key, status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_author_status_feed
  ON media_articles(author, status, feed_sort_at DESC, id DESC);
CREATE INDEX media_articles_ai_title_review
  ON media_articles(ai_title_suggestion_state, coalesce(ai_title_generated_at, '') DESC, id DESC);

CREATE TABLE media_configuration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('source', 'author_rule')),
  entity_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated')),
  actor_type TEXT NOT NULL CHECK (actor_type = 'admin'),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX media_configuration_events_entity
  ON media_configuration_events(entity_type, entity_key, id DESC);
CREATE TRIGGER media_configuration_events_no_update
BEFORE UPDATE ON media_configuration_events BEGIN
  SELECT RAISE(ABORT, 'configuration_events_are_append_only');
END;
CREATE TRIGGER media_configuration_events_no_delete
BEFORE DELETE ON media_configuration_events BEGIN
  SELECT RAISE(ABORT, 'configuration_events_are_append_only');
END;

-- Manual approved creation is an authenticated editorial event, not source auto-approval.
DROP TRIGGER media_article_created;
CREATE TRIGGER media_article_created AFTER INSERT ON media_articles BEGIN
  INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, to_status, revision, created_at,
      metadata_json)
  VALUES (
    NEW.id,
    coalesce(NEW.mutation_key, 'discovered:' || NEW.id),
    CASE
      WHEN NEW.status = 'approved' AND NEW.approval_method = 'manual' THEN 'approved'
      WHEN NEW.status = 'approved' THEN 'auto_approved'
      ELSE 'discovered'
    END,
    CASE
      WHEN NEW.status = 'approved' AND NEW.approval_method = 'manual' THEN 'admin'
      ELSE 'discovery'
    END,
    NEW.status,
    NEW.revision,
    NEW.created_at,
    CASE
      WHEN NEW.status = 'approved' THEN json_object(
        'approval_method', NEW.approval_method,
        'author_rule_key', NEW.approval_author_rule_key
      )
      ELSE '{}'
    END
  );
END;
