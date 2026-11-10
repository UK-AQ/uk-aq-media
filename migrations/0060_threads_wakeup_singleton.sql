-- One outstanding discovery-scheduled Threads publication wake at a time.
-- Operator and automatic-intent continuation messages remain independent.
CREATE TABLE media_threads_wakeup_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  due_at TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((due_at IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO media_threads_wakeup_schedule
  (id, generation, due_at, lease_expires_at, updated_at)
VALUES (1, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
