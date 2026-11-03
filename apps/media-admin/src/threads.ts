import { boundedLimit, HttpError, json, threadsAvailability, threadsEnablementError,
  threadsEligibility, z, type ThreadsSettings, type Status } from '@uk-aq-media/core';
import { directPublishState } from './direct-publish-eligibility';

// Keep Stage 1 property order: stored JSON for old idempotency receipts is unchanged.
const SettingsBody = z.object({ manual_publishing_enabled: z.boolean().optional(),
  cooldown_minutes: z.number().int().min(1).max(1440).optional(),
  automatic_publishing_enabled: z.boolean().optional(),
  acknowledge_future_auto_approvals: z.literal(true).optional(),
  capture_only_enabled: z.boolean().optional(),
  acknowledge_capture_only: z.literal(true).optional() }).strict()
  .refine(v => v.manual_publishing_enabled !== undefined || v.cooldown_minutes !== undefined ||
    v.automatic_publishing_enabled !== undefined || v.capture_only_enabled !== undefined)
  .refine(v => v.automatic_publishing_enabled !== true || v.acknowledge_future_auto_approvals === true)
  .refine(v => v.acknowledge_future_auto_approvals === undefined || v.automatic_publishing_enabled === true)
  .refine(v => v.capture_only_enabled !== true || v.acknowledge_capture_only === true)
  .refine(v => v.acknowledge_capture_only === undefined || v.capture_only_enabled === true);
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
function remoteLeaseActive(s: ThreadsSettings | null): boolean {
  return Boolean(s?.remote_request_key && (!s.remote_request_lease_until ||
    !Number.isFinite(Date.parse(s.remote_request_lease_until)) || Date.parse(s.remote_request_lease_until) > Date.now()));
}
async function presentSettings(env: MediaAdminEnv, replayed?: boolean): Promise<Response> {
  const s = await readSettings(env);
  const unavailable = threadsAvailability(env, s);
  const automaticUnavailable = threadsAvailability(env, s, true);
  const enablementError = threadsEnablementError(env, s, true);
  const holds = await env.MEDIA_DB.prepare(`SELECT
    count(*) FILTER (WHERE status = 'unknown_remote_state') AS held_count,
    count(*) FILTER (WHERE status = 'queued' AND publication_reason = 'auto_approved') AS automatic_queued_count,
    count(*) FILTER (WHERE status = 'queued' AND publication_reason <> 'auto_approved') AS manual_queued_count,
    count(*) FILTER (WHERE status IN ('blocked', 'failed') AND publication_reason = 'auto_approved' AND capture_only = 0) AS automatic_blocked_count,
    count(*) FILTER (WHERE capture_only = 1) AS capture_only_count,
    count(*) FILTER (WHERE status = 'posting') AS posting_count
    FROM media_threads_publications`).first<{ held_count: number; automatic_queued_count: number;
      manual_queued_count: number; automatic_blocked_count: number; capture_only_count: number; posting_count: number }>();
  const pending = s?.activation_event_id === null || !s ? null : await env.MEDIA_DB.prepare(`SELECT count(*) AS count
    FROM media_article_events e WHERE e.event_type = 'auto_approved' AND e.id > ?
      AND NOT EXISTS (SELECT 1 FROM media_threads_capture_periods period WHERE e.id > period.after_event_id
        AND (period.through_event_id IS NULL OR e.id <= period.through_event_id))`)
    .bind(s.automatic_events_through_id ?? s.activation_event_id).first<{ count: number }>();
  const capturedPending = !s || s.capture_activation_event_id === null ? null : await env.MEDIA_DB.prepare(`SELECT count(*) AS count
    FROM media_article_events e WHERE e.event_type = 'auto_approved' AND e.id > ?
      AND EXISTS (SELECT 1 FROM media_threads_capture_periods period WHERE e.id > period.after_event_id
        AND (period.through_event_id IS NULL OR e.id <= period.through_event_id))`)
    .bind(s.capture_events_through_id ?? s.capture_activation_event_id).first<{ count: number }>();
  const captureBusy = Boolean(holds?.posting_count) || remoteLeaseActive(s);
  return json({ settings: s ? { ...s, manual_publishing_enabled: Boolean(s.manual_publishing_enabled),
    automatic_publishing_enabled: Boolean(s.automatic_publishing_enabled),
    capture_only_enabled: Boolean(s.capture_only_enabled), remote_request_key: undefined,
    cooldown_minutes: s.cooldown_seconds / 60 } : null,
    expected_user_id: env.UK_AQ_MEDIA_THREADS_USER_ID || null,
    expected_username: env.UK_AQ_MEDIA_THREADS_USERNAME || null,
    manual_publishing_available: unavailable === null, unavailable_reason: unavailable,
    dispatch_held: Boolean(s?.capture_only_enabled || holds?.held_count), held_publication_count: holds?.held_count ?? 0,
    dispatch_hold_reason: s?.capture_only_enabled ? 'threads_capture_only' : holds?.held_count ? 'unknown_remote_state' : null,
    capture_only_enablement_available: Boolean(s) && !captureBusy,
    capture_only_unavailable_reason: !s ? 'threads_settings_missing' : captureBusy ? 'threads_capture_activation_busy' : null,
    capture_only_intent_count: holds?.capture_only_count ?? 0,
    capture_only_events_pending_count: capturedPending?.count ?? 0,
    remote_requests_blocked: Boolean(s?.capture_only_enabled),
    automatic_intent_held: Boolean(s?.automatic_intent_error_code),
    automatic_publishing_available: automaticUnavailable === null,
    automatic_unavailable_reason: automaticUnavailable,
    automatic_enablement_available: enablementError === null,
    automatic_enablement_unavailable_reason: enablementError,
    automatic_queued_count: holds?.automatic_queued_count ?? 0,
    automatic_paused_count: s?.automatic_publishing_enabled ? 0 : holds?.automatic_queued_count ?? 0,
    manual_queued_count: holds?.manual_queued_count ?? 0,
    automatic_blocked_count: holds?.automatic_blocked_count ?? 0,
    automatic_events_pending_count: pending?.count ?? 0,
    token_expires_at: env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT || null,
    token_expiry_status: !env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT ? 'unknown_rotation_required'
      : Date.parse(env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT) <= Date.now() ? 'expired'
        : Date.parse(env.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT) - Date.now() < 7 * 86400000 ? 'expiring_soon' : 'operator_reported',
    constraints: { cooldown_minutes_min: 1, cooldown_minutes_max: 1440,
      text_max_bytes: 500, automatic_enablement_requires_acknowledgement: true,
      capture_only_requires_acknowledgement: true },
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
    db.prepare(`SELECT id, approval_event_id, publication_key, publication_reason, capture_only, status, attempt_count, container_poll_count,
      threads_user_id, threads_container_id, threads_post_id, threads_permalink_url,
      last_error_code, next_attempt_at, remote_request_started_at, unknown_at,
      reconciled_at, reconciliation_method, created_at, last_attempted_at, posted_at, updated_at
      FROM media_threads_publications WHERE article_id = ? ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT count(*) AS publication_count, count(*) FILTER (WHERE status = 'posted') AS post_count,
      count(*) FILTER (WHERE status IN ('queued', 'posting')) AS in_progress_count,
      count(*) FILTER (WHERE status = 'unknown_remote_state') AS unknown_count,
      count(*) FILTER (WHERE capture_only = 1) AS capture_only_count
      FROM media_threads_publications WHERE article_id = ?`).bind(id)
      .first<{ publication_count: number; post_count: number; in_progress_count: number; unknown_count: number; capture_only_count: number }>(),
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
    const s = await readSettings(env);
    if (!s) throw new HttpError(409, 'threads_settings_missing');
    const enabling = parsed.data.manual_publishing_enabled === true || parsed.data.automatic_publishing_enabled === true;
    if (enabling) {
      const error = threadsEnablementError(env, s, parsed.data.automatic_publishing_enabled === true);
      if (error) throw new HttpError(409, error);
    }
    if (parsed.data.capture_only_enabled === true && (remoteLeaseActive(s) ||
        await db.prepare("SELECT id FROM media_threads_publications WHERE status = 'posting' LIMIT 1").first())) {
      throw new HttpError(409, 'threads_capture_activation_busy');
    }
    const now = new Date().toISOString();
    const manual = parsed.data.manual_publishing_enabled === undefined ? null : Number(parsed.data.manual_publishing_enabled);
    const automatic = parsed.data.automatic_publishing_enabled === undefined ? null : Number(parsed.data.automatic_publishing_enabled);
    const capture = parsed.data.capture_only_enabled === undefined ? null : Number(parsed.data.capture_only_enabled);
    const result = await db.batch([
      db.prepare(`INSERT INTO media_threads_settings_requests (request_key, request_json, created_at)
        SELECT ?, ?, ? WHERE (? = 0 OR EXISTS (SELECT 1 FROM media_threads_settings WHERE id = 1
          AND last_identity_verified_at IS NOT NULL AND last_identity_error_code IS NULL
          AND last_identity_user_id = ? AND last_identity_username = ?))
        AND (? = 0 OR (NOT EXISTS (SELECT 1 FROM media_threads_publications WHERE status = 'posting')
          AND EXISTS (SELECT 1 FROM media_threads_settings WHERE id = 1 AND
            (remote_request_key IS NULL OR julianday(remote_request_lease_until) <= julianday(?)))))
        ON CONFLICT(request_key) DO NOTHING`).bind(key, body, now, Number(enabling),
          env.UK_AQ_MEDIA_THREADS_USER_ID, env.UK_AQ_MEDIA_THREADS_USERNAME, Number(capture === 1), now),
      db.prepare(`UPDATE media_threads_settings SET manual_publishing_enabled = coalesce(?, manual_publishing_enabled),
        automatic_publishing_enabled = coalesce(?, automatic_publishing_enabled),
        activation_event_id = CASE WHEN ? = 1 AND activation_event_id IS NULL
          THEN (SELECT coalesce(max(id), 0) FROM media_article_events) ELSE activation_event_id END,
        automatic_events_through_id = CASE WHEN ? = 1 AND activation_event_id IS NULL
          THEN (SELECT coalesce(max(id), 0) FROM media_article_events) ELSE automatic_events_through_id END,
        capture_only_enabled = coalesce(?, capture_only_enabled),
        capture_activation_event_id = CASE WHEN ? = 1 AND capture_activation_event_id IS NULL
          THEN (SELECT coalesce(max(id), 0) FROM media_article_events) ELSE capture_activation_event_id END,
        capture_events_through_id = CASE WHEN ? = 1 AND capture_activation_event_id IS NULL
          THEN (SELECT coalesce(max(id), 0) FROM media_article_events) ELSE capture_events_through_id END,
        cooldown_seconds = coalesce(?, cooldown_seconds),
        updated_at = ? WHERE id = 1 AND changes() = 1 AND EXISTS (SELECT 1 FROM media_threads_settings_requests
          WHERE request_key = ? AND request_json = ?)`)
        .bind(manual, automatic, automatic, automatic, capture, capture, capture,
          parsed.data.cooldown_minutes === undefined ? null : parsed.data.cooldown_minutes * 60, now, key, body),
    ]);
    const receipt = await db.prepare('SELECT request_json FROM media_threads_settings_requests WHERE request_key = ?')
      .bind(key).first<{ request_json: string }>();
    if (!receipt) throw new HttpError(409, capture === 1 ? 'threads_capture_activation_busy' : 'threads_identity_not_verified');
    if (receipt.request_json !== body) throw new HttpError(409, 'idempotency_key_conflict');
    await wakeThreads(env);
    return presentSettings(env, !result[0]?.meta.changes);
  }
  if (url.pathname === '/admin/threads/connection-check') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if ((await readSettings(env))?.capture_only_enabled) throw new HttpError(409, 'threads_capture_only');
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
    const rows = await db.prepare(`SELECT id, article_id, approval_event_id, publication_key, publication_reason, capture_only, status, attempt_count,
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
  if (operation === 'reconcile' && (await readSettings(env))?.capture_only_enabled) throw new HttpError(409, 'threads_capture_only');
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
