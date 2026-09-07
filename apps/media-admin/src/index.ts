import { ArticleStatus, bearerMatches, boundedLimit, HttpError, httpFailure, json,
  type Status } from '@uk-aq-media/core';

type Action = 'approve' | 'reject' | 'hide' | 'unhide';
const transitions: Record<Action, { from: Status[]; to: Status; event: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', event: 'approved' },
  reject: { from: ['pending', 'approved'], to: 'rejected', event: 'rejected' },
  hide: { from: ['approved'], to: 'hidden', event: 'hidden' },
  unhide: { from: ['hidden'], to: 'approved', event: 'unhidden' },
};

async function mutate(request: Request, db: D1Database, id: number, action: Action): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const eventKey = `admin:${key}`;
  const transition = transitions[action];
  const now = new Date().toISOString();
  const placeholders = transition.from.map(() => '?').join(', ');
  // One UPDATE plus its trigger is atomic, including the unique idempotency event key.
  const changed = await db.prepare(`UPDATE media_articles SET status = ?, mutation_key = ?,
    revision = revision + 1, updated_at = ?,
    approval_method = CASE WHEN ? = 'approve' THEN 'manual' ELSE approval_method END,
    approved_at = CASE WHEN ? = 'approve' THEN ? ELSE approved_at END,
    rejected_at = CASE WHEN ? = 'reject' THEN ? ELSE rejected_at END,
    hidden_at = CASE WHEN ? = 'hide' THEN ? WHEN ? = 'unhide' THEN NULL ELSE hidden_at END
    WHERE id = ? AND status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ?)
    RETURNING id, status, revision`).bind(transition.to, eventKey, now,
      action, action, now, action, now, action, now, action, id, ...transition.from, eventKey)
    .first<{ id: number; status: Status; revision: number }>();
  if (changed) return json({ article: changed, replayed: false });
  const event = await db.prepare(`SELECT article_id, event_type, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey)
    .first<{ article_id: number; event_type: string; to_status: Status; revision: number }>();
  if (event) {
    if (event.article_id !== id || event.event_type !== transition.event) throw new HttpError(409, 'idempotency_key_conflict');
    // Return the original mutation receipt; it need not be the article's current state.
    return json({ article: { id, status: event.to_status, revision: event.revision }, replayed: true });
  }
  const exists = await db.prepare('SELECT id FROM media_articles WHERE id = ?').bind(id).first();
  throw new HttpError(exists ? 409 : 404, exists ? 'invalid_state_transition' : 'article_not_found');
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      // MEDIA_SYNC_TOKEN is reserved for future read-only sync routes; never accepted here.
      if (!await bearerMatches(request, env.MEDIA_ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const url = new URL(request.url);
      const match = /^\/admin\/articles\/([1-9]\d*)\/(approve|reject|hide|unhide)$/.exec(url.pathname);
      if (match) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await mutate(request, env.MEDIA_DB, id, match[2] as Action);
      }
      if (!['/admin/articles', '/admin/sources', '/admin/runs'].includes(url.pathname)) {
        return json({ error: 'not_found' }, 404);
      }
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      if (url.pathname === '/admin/articles') {
        const status = url.searchParams.get('status');
        if (status !== null && !ArticleStatus.safeParse(status).success) throw new HttpError(400, 'invalid_status');
        const statement = env.MEDIA_DB.prepare(`SELECT * FROM media_articles
          ${status ? 'WHERE status = ?' : ''} ORDER BY ${status ? 'feed_sort_at DESC' : 'updated_at DESC'}, id DESC LIMIT ?`);
        const { results } = await (status ? statement.bind(status, limit) : statement.bind(limit)).all();
        return json({ articles: results });
      }
      if (url.pathname === '/admin/sources') {
        const { results } = await env.MEDIA_DB.prepare('SELECT * FROM media_sources ORDER BY source_key LIMIT ?').bind(limit).all();
        return json({ sources: results });
      }
      const { results } = await env.MEDIA_DB.prepare(
        'SELECT * FROM media_discovery_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      ).bind(limit).all();
      return json({ runs: results });
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaAdminEnv>;
