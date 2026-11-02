import { boundedLimit, HttpError, json, threadsAvailability, threadsConfigurationError,
  threadsEligibility, z, type ThreadsSettings, type Status } from '@uk-aq-media/core';
import { directPublishState } from './direct-publish-eligibility';

const SettingsBody = z.object({ manual_publishing_enabled: z.boolean(),
  cooldown_minutes: z.number().int().min(1).max(1440) }).strict();
const ReconcileBody = z.object({ threads_post_id: z.string().regex(/^[0-9]{1,100}$/),
  confirm_exact_publication: z.literal(true) }).strict();
const ConfirmNotPostedBody = z.object({ confirm_not_posted: z.literal(true),
  acknowledge_duplicate_risk: z.literal(true) }).strict();
const EmptyBody = z.object({}).strict();

function requestKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  return key;
}
async function readSettings(env: MediaAdminEnv): Promise<ThreadsSettings | null> {
  return env.MEDIA_DB.prepare('SELECT * FROM media_threads_settings WHERE id = 1').first<ThreadsSettings>();
}
async function presentSettings(env: MediaAdminEnv, replayed?: boolean): Promise<Response> {
  const s = await readSettings(env);
  const unavailable = threadsAvailability(env, s);
  const holds = await env.MEDIA_DB.prepare(`SELECT count(*) AS held_count FROM media_threads_publications
    WHERE status = 'unknown_remote_state'`).first<{ held_count: number }>();
  return json({ settings: s ? { ...s, manual_publishing_enabled: Boolean(s.manual_publishing_enabled),
    automatic_publishing_enabled: false, cooldown_minutes: s.cooldown_seconds / 60 } : null,
    expected_user_id: env.UK_AQ_MEDIA_THREADS_USER_ID || null,
    expected_username: env.UK_AQ_MEDIA_THREADS_USERNAME || null,
    manual_publishing_available: unavailable === null, unavailable_reason: unavailable,
    dispatch_held: Boolean(holds?.held_count), held_publication_count: holds?.held_count ?? 0,
    automatic_publishing_available: false,
    token_expires_at: env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT || null,
    token_expiry_status: !env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT ? 'unknown_rotation_required'
      : Date.parse(env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT) <= Date.now() ? 'expired'
        : Date.parse(env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT) - Date.now() < 7 * 86400000 ? 'expiring_soon' : 'operator_reported',
    constraints: { cooldown_minutes_min: 1, cooldown_minutes_max: 1440,
      text_max_bytes: 500, automatic_publishing_enabled: false },
    ...(replayed === undefined ? {} : { replayed }) });
}

export async function wakeThreads(env: MediaAdminEnv): Promise<void> {
  try { await env.MEDIA_THREADS_QUEUE.send({ type: 'threads_wakeup' }); }
  catch { console.error(JSON.stringify({ event: 'threads_wakeup_failed' })); }
}

export async function threadsArticleState(env: MediaAdminEnv, id: number, status: Status,
  article: { title: string; publisher: string; canonical_url: string }) {
  const db = env.MEDIA_DB;
  const [history, counts, eligibility] = await Promise.all([
    db.prepare(`SELECT id, publication_reason, status, attempt_count, container_poll_count,
      threads_user_id, threads_container_id, threads_post_id, threads_permalink_url,
      last_error_code, next_attempt_at, remote_request_started_at, unknown_at,
      reconciled_at, reconciliation_method, created_at, last_attempted_at, posted_at, updated_at
      FROM media_threads_publications WHERE article_id = ? ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT count(*) AS publication_count, count(*) FILTER (WHERE status = 'posted') AS post_count,
      count(*) FILTER (WHERE status IN ('queued', 'posting')) AS in_progress_count,
      count(*) FILTER (WHERE status = 'unknown_remote_state') AS unknown_count
      FROM media_threads_publications WHERE article_id = ?`).bind(id)
      .first<{ publication_count: number; post_count: number; in_progress_count: number; unknown_count: number }>(),
    threadsEligibility(db, env, [{ ...article, id }]),
  ]);
  const unavailable = eligibility.failures[0]?.error ?? null;
  return { ...counts, latest_status: history.results[0]?.status ?? null,
    publications: history.results,
    ...directPublishState('threads', status, { hasInProgress: Boolean(counts?.in_progress_count),
      hasUnknownRemoteState: Boolean(counts?.unknown_count), postCount: counts?.post_count ?? 0 }, unavailable),
    manual_post_available: ['pending', 'rejected', 'hidden'].includes(status) && !unavailable,
    manual_post_reason: status === 'pending' ? 'pending_approved' : status === 'rejected'
      ? 'rejected_repost' : status === 'hidden' ? 'unhidden_repost' : null,
    manual_post_unavailable_reason: unavailable };
}

export async function handleThreadsAdmin(request: Request, env: MediaAdminEnv, url: URL,
  readJson: (request: Request) => Promise<unknown>): Promise<Response | null> {
  if (!url.pathname.startsWith('/admin/threads/')) return null;
  const db = env.MEDIA_DB;
  if (url.pathname === '/admin/threads/settings') {
    if (request.method === 'GET') return presentSettings(env);
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    const key = requestKey(request);
    const parsed = SettingsBody.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'invalid_threads_settings');
    const body = JSON.stringify(parsed.data);
    const prior = await db.prepare('SELECT request_json FROM media_threads_settings_requests WHERE request_key = ?')
      .bind(key).first<{ request_json: string }>();
    if (prior && prior.request_json !== body) throw new HttpError(409, 'idempotency_key_conflict');
    if (prior) return presentSettings(env, true);
    if (parsed.data.manual_publishing_enabled) {
      const error = threadsConfigurationError(env);
      if (error) throw new HttpError(409, error);
      const s = await readSettings(env);
      if (!s?.last_identity_verified_at || s.last_identity_error_code ||
          s.last_identity_user_id !== env.UK_AQ_MEDIA_THREADS_USER_ID ||
          s.last_identity_username !== env.UK_AQ_MEDIA_THREADS_USERNAME) {
        throw new HttpError(409, 'threads_identity_not_verified');
      }
    }
    const now = new Date().toISOString();
    const enabled = Number(parsed.data.manual_publishing_enabled);
    await db.batch([
      db.prepare(`INSERT INTO media_threads_settings_requests (request_key, request_json, created_at)
        SELECT ?, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM media_threads_settings WHERE id = 1
          AND last_identity_verified_at IS NOT NULL AND last_identity_error_code IS NULL
          AND last_identity_user_id = ? AND last_identity_username = ?)
        ON CONFLICT(request_key) DO NOTHING`).bind(key, body, now, enabled,
          env.UK_AQ_MEDIA_THREADS_USER_ID, env.UK_AQ_MEDIA_THREADS_USERNAME),
      db.prepare(`UPDATE media_threads_settings SET manual_publishing_enabled = ?, cooldown_seconds = ?,
        updated_at = ? WHERE id = 1 AND changes() = 1 AND EXISTS (SELECT 1 FROM media_threads_settings_requests
          WHERE request_key = ? AND request_json = ?)`)
        .bind(enabled, parsed.data.cooldown_minutes * 60, now, key, body),
    ]);
    const receipt = await db.prepare('SELECT request_json FROM media_threads_settings_requests WHERE request_key = ?')
      .bind(key).first<{ request_json: string }>();
    if (!receipt || receipt.request_json !== body) throw new HttpError(409, 'idempotency_key_conflict');
    if (enabled) await wakeThreads(env);
    return presentSettings(env, false);
  }
  if (url.pathname === '/admin/threads/connection-check') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    await env.MEDIA_THREADS_QUEUE.send({ type: 'threads_identity_check' });
    return json({ accepted: true }, 202);
  }
  if (url.pathname === '/admin/threads/publications') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const allowed = new Set(['limit', 'before_id', 'article_id']);
    for (const [key] of url.searchParams) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, 'invalid_threads_query');
    }
    const filters: string[] = []; const binds: number[] = [];
    for (const key of ['before_id', 'article_id']) {
      const value = url.searchParams.get(key);
      if (value !== null) {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'invalid_threads_query');
        filters.push(key === 'article_id' ? 'article_id = ?' : 'id < ?'); binds.push(Number(value));
      }
    }
    const limit = boundedLimit(url, 25, 50);
    const rows = await db.prepare(`SELECT id, article_id, publication_reason, status, attempt_count,
      threads_user_id, threads_container_id, threads_post_id, threads_permalink_url,
      last_error_code, next_attempt_at, remote_request_started_at, unknown_at,
      reconciled_at, reconciliation_method, created_at, last_attempted_at, posted_at, updated_at
      FROM media_threads_publications ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ?`).bind(...binds, limit + 1).all();
    return json({ publications: rows.results.slice(0, limit),
      next_before_id: rows.results.length > limit ? rows.results[limit - 1]?.id : null });
  }
  const match = /^\/admin\/threads\/publications\/([1-9]\d*)\/(cancel|reconcile|confirm-not-posted)$/.exec(url.pathname);
  if (!match) return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_publication_id');
  const key = requestKey(request);
  const operation = match[2]!.replaceAll('-', '_');
  const parsed = (operation === 'reconcile' ? ReconcileBody : operation === 'cancel' ? EmptyBody : ConfirmNotPostedBody)
    .safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_threads_operation');
  const body = JSON.stringify(parsed.data);
  const now = new Date().toISOString();
  const state = operation === 'cancel' ? "status = 'queued' AND remote_request_started_at IS NULL"
    : operation === 'reconcile' ? "status IN ('unknown_remote_state', 'posted')"
      : "status = 'unknown_remote_state' AND threads_post_id IS NULL";
  const statements = [db.prepare(`INSERT INTO media_threads_operator_requests
    (request_key, publication_id, operation, request_json, created_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM media_threads_publications WHERE id = ? AND ${state})
    ON CONFLICT(request_key) DO NOTHING`).bind(key, id, operation, body, now, id)];
  if (operation !== 'reconcile') statements.push(db.prepare(`UPDATE media_threads_publications SET
    status = 'blocked', last_error_code = ?, next_attempt_at = NULL, updated_at = ?,
    reconciled_at = CASE WHEN ? = 'confirm_not_posted' THEN ? ELSE reconciled_at END,
    reconciliation_method = CASE WHEN ? = 'confirm_not_posted' THEN 'operator_confirmed_not_posted' ELSE reconciliation_method END
    WHERE id = ? AND ${state} AND EXISTS (SELECT 1 FROM media_threads_operator_requests WHERE request_key = ?
      AND publication_id = ? AND operation = ? AND request_json = ?)`)
    .bind(operation === 'cancel' ? 'operator_cancelled' : 'operator_confirmed_not_posted', now,
      operation, now, operation, id, key, id, operation, body));
  const result = await db.batch(statements);
  const receipt = await db.prepare(`SELECT publication_id, operation, request_json
    FROM media_threads_operator_requests WHERE request_key = ?`).bind(key)
    .first<{ publication_id: number; operation: string; request_json: string }>();
  if (!receipt) throw new HttpError(409, 'threads_operation_state_conflict');
  if (receipt.publication_id !== id || receipt.operation !== operation || receipt.request_json !== body) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }
  if (operation === 'reconcile') {
    try { await env.MEDIA_THREADS_QUEUE.send({ type: 'threads_reconcile', publication_id: id, request_key: key }); }
    catch { return json({ accepted: true, wakeup_pending: true, replayed: !result[0]?.meta.changes }, 202); }
  } else await wakeThreads(env);
  return json({ accepted: true, replayed: !result[0]?.meta.changes }, operation === 'reconcile' ? 202 : 200);
}
