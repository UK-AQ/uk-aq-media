-- Forward-only durable singleton for Bluesky wake-up Queue traffic.
-- D1 owns the one pending/processing slot across admin, scheduled discovery
-- and GDELT. Cloudflare Queue messages carry no publication identity.
CREATE TABLE IF NOT EXISTS media_bluesky_wakeup_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('idle', 'scheduled', 'processing')),
  due_at TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'idle' AND due_at IS NULL AND lease_expires_at IS NULL)
    OR (state != 'idle' AND due_at IS NOT NULL AND lease_expires_at IS NOT NULL))
);
INSERT INTO media_bluesky_wakeup_schedule
  (id, generation, state, due_at, lease_expires_at, updated_at)
VALUES (1, 0, 'idle', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(id) DO NOTHING;
