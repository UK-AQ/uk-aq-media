import { renderThreadsPost, type ThreadsSettings } from '@uk-aq-media/core';

const EVENT_BATCH = 25;
// These are the provenance fields emitted by the existing article INSERT/status
// triggers in the atomic discovery transaction. Manual approval never matches.
const THREADS_AUTO_EVENT_SQL = `e.event_type = 'auto_approved'
  AND e.actor_type = 'discovery' AND e.to_status = 'approved'
  AND (e.from_status IS NULL OR e.from_status = 'pending')
  AND json_extract(e.metadata_json, '$.approval_method') IN ('trusted_source_auto', 'trusted_author_auto')`;

type Event = { id: number; article_id: number; title: string; publisher: string; canonical_url: string };
const CAPTURE_PERIOD_SQL = `EXISTS (SELECT 1 FROM media_threads_capture_periods period
  WHERE e.id > period.after_event_id
    AND (period.through_event_id IS NULL OR e.id <= period.through_event_id))`;

// The append-only event plus the committed activation/cursor is the recoverable
// decision journal. Never attach a Threads insert to an approval transaction:
// even a Threads schema/write failure must leave discovery and other outboxes valid.
async function drainEvents(db: D1Database, s: ThreadsSettings, capture: boolean): Promise<boolean> {
  let eventId: number | null = null;
  const marker = capture ? 'capture_activation_event_id' : 'activation_event_id';
  const checkpointField = capture ? 'capture_events_through_id' : 'automatic_events_through_id';
  const errorCode = capture ? 'threads_capture_intent_failed' : 'threads_automatic_intent_failed';
  const periodFilter = `${capture ? '' : 'NOT '}${CAPTURE_PERIOD_SQL}`;
  try {
    const activation = s[marker];
    if (activation === null) return false;
    let cursor = s[checkpointField];
    if (cursor === null || cursor < activation || (!capture && !s.last_identity_user_id)) {
      throw new Error('invalid_cursor');
    }
    const events = await db.prepare(`SELECT e.id, e.article_id, a.title, a.publisher, a.canonical_url
      FROM media_article_events e JOIN media_articles a ON a.id = e.article_id
      WHERE e.id > ? AND e.event_type = 'auto_approved' AND ${periodFilter} ORDER BY e.id LIMIT ?`)
      .bind(cursor, EVENT_BATCH).all<Event>();
    for (const e of events.results) {
      eventId = e.id;
      let contentError: string | null = null;
      try { renderThreadsPost(e); }
      catch { contentError = 'threads_automatic_content_invalid'; }
      const now = new Date().toISOString();
      const [, checkpoint] = await db.batch([
        db.prepare(`INSERT INTO media_threads_publications
          (article_id, approval_event_id, publication_key, publication_reason, status,
           threads_user_id, last_error_code, created_at, updated_at, capture_only)
          SELECT e.article_id, e.id, 'approval-event:' || e.id, 'auto_approved',
            CASE WHEN ? = 1 OR ? IS NOT NULL OR EXISTS (SELECT 1 FROM media_threads_publications p
              WHERE p.article_id = e.article_id AND p.status IN ('queued', 'posting', 'unknown_remote_state'))
              THEN 'blocked' ELSE 'queued' END, ${capture ? 'NULL' : 's.last_identity_user_id'},
            CASE WHEN ? IS NOT NULL THEN ? WHEN ? = 1 THEN 'threads_capture_only'
              WHEN EXISTS (SELECT 1 FROM media_threads_publications p
              WHERE p.article_id = e.article_id AND p.status IN ('queued', 'posting', 'unknown_remote_state'))
              THEN 'threads_publication_in_progress' ELSE NULL END, e.created_at, ?, ?
          FROM media_article_events e JOIN media_articles a ON a.id = e.article_id
          JOIN media_threads_settings s ON s.id = 1
          WHERE e.id = ? AND e.id > s.${marker} AND s.${checkpointField} = ?
            AND ${THREADS_AUTO_EVENT_SQL} AND a.status = 'approved' AND ${periodFilter}
          ON CONFLICT(publication_key) DO NOTHING`)
          .bind(Number(capture), contentError, contentError, contentError, Number(capture), now, Number(capture), e.id, cursor),
        db.prepare(`UPDATE media_threads_settings SET ${checkpointField} = ?,
          automatic_intent_error_event_id = CASE WHEN automatic_intent_error_code = ? THEN NULL ELSE automatic_intent_error_event_id END,
          automatic_intent_error_code = CASE WHEN automatic_intent_error_code = ? THEN NULL ELSE automatic_intent_error_code END
          WHERE id = 1 AND ${checkpointField} = ? AND ${marker} < ?`)
          .bind(e.id, errorCode, errorCode, cursor, e.id),
      ]);
      // A competing reconciler already advanced; it owns the continuation.
      if (!checkpoint?.meta.changes) return false;
      cursor = e.id;
    }
    return events.results.length === EVENT_BATCH;
  } catch {
    // Retain the cursor: the next existing scheduler/post-commit recovery retries
    // this exact event, never a historical approval scan or a new request identity.
    try {
      await db.prepare(`UPDATE media_threads_settings SET automatic_intent_error_code = ?,
        automatic_intent_error_event_id = ? WHERE id = 1`).bind(errorCode, eventId).run();
    } catch { /* A schema/storage outage may also prevent recording diagnostics. */ }
    console.error(JSON.stringify({ event: errorCode, approval_event_id: eventId }));
    return false;
  }
}

export async function reconcileThreadsAutomaticEvents(db: D1Database): Promise<boolean> {
  const s = await db.prepare('SELECT * FROM media_threads_settings WHERE id = 1').first<ThreadsSettings>();
  if (!s) return false;
  // Capture takes precedence, including recoverable events from a closed period.
  // Remote intent explicitly excludes every capture period, even during races.
  const moreCaptured = await drainEvents(db, s, true);
  const moreRemote = await drainEvents(db, s, false);
  return moreCaptured || moreRemote;
}
