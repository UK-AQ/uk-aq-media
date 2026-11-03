import { renderThreadsPost, THREADS_API_VERSION, threadsConfigurationError, threadsAutomaticConfigurationError,
  type ThreadsConfig, type ThreadsSettings } from '@uk-aq-media/core';
import { reconcileThreadsAutomaticEvents } from './threads-automatic';

const BASE = `https://graph.threads.net/${THREADS_API_VERSION}`;
const STALE_MS = 10 * 60 * 1000;
const MAX_DELAY = 43_200;
// Use the stored reason at scheduling, claim and BOTH remote mutation boundaries.
// Disabled automatic work must never sit in front of enabled manual work.
const REASON_ENABLED_SQL = `(s.capture_only_enabled = 0 AND media_threads_publications.capture_only = 0 AND
  ((media_threads_publications.publication_reason = 'auto_approved'
    AND s.automatic_publishing_enabled = 1
    AND media_threads_publications.approval_event_id > s.activation_event_id)
  OR (media_threads_publications.publication_reason IN
    ('pending_approved', 'rejected_repost', 'unhidden_repost', 'manual_post', 'manual_repost')
    AND s.manual_publishing_enabled = 1)))`;
function reasonEnabledSql(env: MediaDiscoveryEnv): string {
  return threadsAutomaticConfigurationError(env)
    ? REASON_ENABLED_SQL.replace('s.automatic_publishing_enabled = 1', '0 = 1') : REASON_ENABLED_SQL;
}
type FailureKind = 'safe_retry' | 'blocked' | 'unknown_remote_state' | 'local_conflict' | 'paused';
export class ThreadsProviderError extends Error {
  constructor(readonly code: string, readonly kind: FailureKind) { super(code); }
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Publication = { id: number; article_id: number; attempt_count: number;
  publication_reason: string; capture_only: number;
  container_poll_count: number; claim_key: string; threads_user_id: string | null;
  threads_container_id: string | null; threads_post_id: string | null;
  remote_request_started_at: string | null; container_created_at: string | null; status: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function remoteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{1,100}$/.test(value)) {
    throw new ThreadsProviderError('threads_response_id_invalid', 'blocked');
  }
  return value;
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > 16384 || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) throw new Error();
      chunks.push(value);
    }
  } finally { try { await reader.cancel(); } catch { /* closed */ } reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
}

async function request(token: string, path: string, body?: URLSearchParams,
  publishing = false, fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  const failure: FailureKind = publishing ? 'unknown_remote_state' : 'safe_retry';
  let response: Response;
  let parsed: Record<string, unknown>;
  try {
    response = await fetchImpl(BASE + path, {
      method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}) },
      ...(body ? { body: body.toString() } : {}),
    });
    parsed = await boundedJson(response);
  } catch { throw new ThreadsProviderError('threads_transport_or_response_failure', failure); }
  if (!response.ok || parsed.error) {
    const error = record(parsed.error);
    const code = error.code;
    const complete = typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 1000;
    if (complete && [100, 190, 200, 10].includes(Number(code))) {
      throw new ThreadsProviderError(`threads_error_${Number(code)}`, 'blocked');
    }
    // No generic HTTP status or Meta transient flag proves publish retry safety.
    throw new ThreadsProviderError('threads_provider_rejected', failure);
  }
  return parsed;
}

function tokenFor(env: MediaDiscoveryEnv): string {
  const error = threadsConfigurationError(env);
  if (error) throw new ThreadsProviderError(error, 'blocked');
  if (!env.UK_AQ_MEDIA_THREADS_TOKEN?.trim()) throw new ThreadsProviderError('threads_token_missing', 'blocked');
  return env.UK_AQ_MEDIA_THREADS_TOKEN;
}

export async function validateThreadsIdentity(token: string, config: ThreadsConfig,
  fetchImpl: Fetch = fetch): Promise<{ id: string; username: string }> {
  const body = await request(token, '/me?fields=id%2Cusername', undefined, false, fetchImpl);
  const id = remoteId(body.id);
  if (id !== config.UK_AQ_MEDIA_THREADS_USER_ID || body.username !== config.UK_AQ_MEDIA_THREADS_USERNAME) {
    throw new ThreadsProviderError('threads_identity_mismatch', 'blocked');
  }
  return { id, username: config.UK_AQ_MEDIA_THREADS_USERNAME };
}

async function identityCheck(env: MediaDiscoveryEnv): Promise<void> {
  const now = new Date().toISOString();
  try {
    const identity = await remoteRequest(env, () => validateThreadsIdentity(tokenFor(env), env));
    await env.MEDIA_DB.prepare(`UPDATE media_threads_settings SET last_identity_checked_at = ?,
      last_identity_verified_at = ?, last_identity_user_id = ?, last_identity_username = ?,
      last_identity_error_code = NULL, updated_at = ? WHERE id = 1`)
      .bind(now, now, identity.id, identity.username, now).run();
  } catch (error) {
    if (error instanceof ThreadsProviderError && error.kind === 'paused') throw error;
    await env.MEDIA_DB.prepare(`UPDATE media_threads_settings SET last_identity_checked_at = ?,
      last_identity_error_code = ?, updated_at = ? WHERE id = 1`)
      .bind(now, error instanceof ThreadsProviderError ? error.code : 'threads_identity_check_failed', now).run();
    throw error;
  }
}

export async function createThreadsContainer(token: string, userId: string,
  article: { title: string; publisher: string; canonical_url: string }, fetchImpl: Fetch = fetch): Promise<string> {
  const rendered = renderThreadsPost(article);
  const body = await request(token, `/${remoteId(userId)}/threads`,
    new URLSearchParams({ media_type: 'TEXT', text: rendered.text,
      link_attachment: rendered.link_attachment, auto_publish_text: 'false' }), false, fetchImpl);
  return remoteId(body.id);
}

export async function publishThreadsContainer(token: string, userId: string, containerId: string,
  fetchImpl: Fetch = fetch): Promise<string> {
  const body = await request(token, `/${remoteId(userId)}/threads_publish`,
    new URLSearchParams({ creation_id: remoteId(containerId) }), true, fetchImpl);
  try { return remoteId(body.id); }
  catch { throw new ThreadsProviderError('threads_publish_id_missing', 'unknown_remote_state'); }
}

async function requirePublishingQuota(token: string, userId: string): Promise<void> {
  const body = await request(token, `/${remoteId(userId)}/threads_publishing_limit?fields=quota_usage%2Cconfig`);
  const data = Array.isArray(body.data) && body.data.length === 1 ? record(body.data[0]) : {};
  const config = record(data.config);
  if (!Number.isSafeInteger(data.quota_usage) || Number(data.quota_usage) < 0 ||
      !Number.isSafeInteger(config.quota_total) || Number(config.quota_total) < 1 ||
      !Number.isSafeInteger(config.quota_duration) || Number(config.quota_duration) < 1) {
    throw new ThreadsProviderError('threads_quota_response_invalid', 'blocked');
  }
  if (Number(data.quota_usage) >= Number(config.quota_total)) {
    throw new ThreadsProviderError('threads_publishing_quota_exhausted', 'safe_retry');
  }
}

export async function readThreadsPost(token: string, postId: string, username: string,
  fetchImpl: Fetch = fetch): Promise<{ id: string; permalink: string | null }> {
  const body = await request(token, `/${remoteId(postId)}?fields=id%2Cusername%2Cpermalink`, undefined, false, fetchImpl);
  if (remoteId(body.id) !== postId || body.username !== username) {
    throw new ThreadsProviderError('threads_post_identity_mismatch', 'blocked');
  }
  let permalink: string | null = null;
  if (body.permalink !== undefined && body.permalink !== null) {
    if (typeof body.permalink !== 'string' || body.permalink.length > 2048) {
      throw new ThreadsProviderError('threads_permalink_invalid', 'blocked');
    }
    let url: URL;
    try { url = new URL(body.permalink); } catch { throw new ThreadsProviderError('threads_permalink_invalid', 'blocked'); }
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(url.hostname)) {
      throw new ThreadsProviderError('threads_permalink_invalid', 'blocked');
    }
    permalink = body.permalink;
  }
  return { id: postId, permalink };
}

async function settings(db: D1Database): Promise<ThreadsSettings | null> {
  return db.prepare('SELECT * FROM media_threads_settings WHERE id = 1').first<ThreadsSettings>();
}

// All runtime provider reads AND writes enter this lease. Capture activation is
// atomically refused while it is active, including identity/read-back requests
// that do not own a publication claim. A crashed request expires conservatively
// after 90s, beyond the provider's existing 15s timeout; no write is retried here.
async function remoteRequest<T>(env: MediaDiscoveryEnv, operation: () => Promise<T>): Promise<T> {
  const now = new Date().toISOString();
  const key = crypto.randomUUID();
  const acquired = await env.MEDIA_DB.prepare(`UPDATE media_threads_settings SET
    remote_request_key = ?, remote_request_lease_until = ? WHERE id = 1
      AND capture_only_enabled = 0
      AND (remote_request_key IS NULL OR julianday(remote_request_lease_until) <= julianday(?))`)
    .bind(key, new Date(Date.now() + 90000).toISOString(), now).run();
  if (!acquired.meta.changes) {
    const s = await settings(env.MEDIA_DB);
    throw new ThreadsProviderError(s?.capture_only_enabled ? 'threads_capture_only' : 'threads_remote_request_in_progress', 'paused');
  }
  try { return await operation(); }
  finally {
    // Never mask a confirmed provider result or change unknown-write semantics.
    try {
      await env.MEDIA_DB.prepare(`UPDATE media_threads_settings SET remote_request_key = NULL,
        remote_request_lease_until = NULL WHERE id = 1 AND remote_request_key = ?`).bind(key).run();
    } catch { console.error(JSON.stringify({ event: 'threads_remote_lease_release_failed' })); }
  }
}
async function schedule(env: MediaDiscoveryEnv): Promise<void> {
  const s = await settings(env.MEDIA_DB);
  if (!s || s.capture_only_enabled || !(s.manual_publishing_enabled || s.automatic_publishing_enabled) ||
      threadsConfigurationError(env) || !env.UK_AQ_MEDIA_THREADS_TOKEN) return;
  // Unknown writes hold this platform until an operator reconciles them.
  if (await env.MEDIA_DB.prepare(`SELECT id FROM media_threads_publications
    WHERE status = 'unknown_remote_state' LIMIT 1`).first()) return;
  const posting = await env.MEDIA_DB.prepare(`SELECT min(last_attempted_at) AS at
    FROM media_threads_publications WHERE status = 'posting'`).first<{ at: string | null }>();
  const queued = await env.MEDIA_DB.prepare(`SELECT min(coalesce(next_attempt_at, created_at)) AS at
    FROM media_threads_publications WHERE status = 'queued' AND EXISTS (
      SELECT 1 FROM media_threads_settings s WHERE s.id = 1 AND ${reasonEnabledSql(env)})`)
    .first<{ at: string | null }>();
  if (!posting?.at && !queued?.at) return;
  const due = posting?.at ? Date.parse(posting.at) + STALE_MS
    : Math.max(Date.parse(queued!.at!), s.last_successful_post_at
      ? Date.parse(s.last_successful_post_at) + s.cooldown_seconds * 1000 : 0);
  await env.MEDIA_THREADS_QUEUE.send({ type: 'threads_wakeup' },
    { delaySeconds: Math.max(1, Math.min(MAX_DELAY, Math.ceil((due - Date.now()) / 1000))) });
}
async function recoverAutomaticIntents(env: MediaDiscoveryEnv): Promise<void> {
  if (await reconcileThreadsAutomaticEvents(env.MEDIA_DB)) {
    // Continue a bounded live-event drain even while remote dispatch is disabled.
    await env.MEDIA_THREADS_QUEUE.send({ type: 'threads_wakeup' }, { delaySeconds: 1 });
  }
}
export async function reconcileThreadsQueue(env: MediaDiscoveryEnv): Promise<void> {
  await recoverAutomaticIntents(env);
  await schedule(env);
}

async function finishClaim(env: MediaDiscoveryEnv, p: Publication, status: string,
  code: string | null, next: string | null = null, increment = 0): Promise<void> {
  const now = new Date().toISOString();
  await env.MEDIA_DB.prepare(`UPDATE media_threads_publications SET status = ?, last_error_code = ?,
    next_attempt_at = ?, attempt_count = min(5, attempt_count + ?), claim_key = NULL,
    unknown_at = CASE WHEN ? = 'unknown_remote_state' THEN coalesce(unknown_at, ?) ELSE unknown_at END,
    updated_at = ? WHERE id = ? AND status = 'posting' AND claim_key = ?`)
    .bind(status, code, next, increment, status, now, now, p.id, p.claim_key).run();
}

async function assertDispatch(env: MediaDiscoveryEnv, p: Publication, publishing: boolean): Promise<void> {
  // Recheck the kill switch, account and editorial state at each mutation boundary.
  tokenFor(env);
  if (p.publication_reason === 'auto_approved') {
    const error = threadsAutomaticConfigurationError(env);
    if (error) throw new ThreadsProviderError(error, 'paused');
  }
  const now = new Date().toISOString();
  const result = await env.MEDIA_DB.prepare(`UPDATE media_threads_publications
    SET threads_user_id = ?, remote_request_started_at = CASE WHEN ? = 1 THEN ? ELSE remote_request_started_at END,
      updated_at = ? WHERE id = ? AND status = 'posting' AND claim_key = ?
      AND remote_request_started_at IS NULL AND (threads_user_id IS NULL OR threads_user_id = ?)
      AND last_attempted_at > ?
      AND EXISTS (SELECT 1 FROM media_articles WHERE id = article_id AND status = 'approved')
      AND NOT EXISTS (SELECT 1 FROM media_threads_publications WHERE status = 'unknown_remote_state')
      AND EXISTS (SELECT 1 FROM media_threads_settings s WHERE s.id = 1 AND ${reasonEnabledSql(env)}
        AND last_identity_verified_at IS NOT NULL AND last_identity_error_code IS NULL
        AND last_identity_user_id = ? AND last_identity_username = ?
        AND (last_successful_post_at IS NULL OR julianday(?) >= julianday(last_successful_post_at) + cooldown_seconds / 86400.0))`)
    .bind(env.UK_AQ_MEDIA_THREADS_USER_ID, Number(publishing), now, now, p.id, p.claim_key,
      env.UK_AQ_MEDIA_THREADS_USER_ID, new Date(Date.now() - STALE_MS).toISOString(),
      env.UK_AQ_MEDIA_THREADS_USER_ID, env.UK_AQ_MEDIA_THREADS_USERNAME, now).run();
  if (!result.meta.changes) {
    const latest = await settings(env.MEDIA_DB);
    if (latest?.capture_only_enabled) throw new ThreadsProviderError('threads_capture_only', 'paused');
    const automatic = p.publication_reason === 'auto_approved';
    if (!(automatic ? latest?.automatic_publishing_enabled : latest?.manual_publishing_enabled)) {
      throw new ThreadsProviderError(automatic ? 'threads_automatic_publishing_disabled' : 'threads_manual_publishing_disabled', 'paused');
    }
    if (latest?.last_successful_post_at && Date.parse(latest.last_successful_post_at) + latest.cooldown_seconds * 1000 > Date.now()) {
      throw new ThreadsProviderError('threads_cooldown_active', 'paused');
    }
    throw new ThreadsProviderError('threads_dispatch_guard_failed', 'local_conflict');
  }
}

async function publishOne(env: MediaDiscoveryEnv): Promise<void> {
  const db = env.MEDIA_DB;
  if ((await settings(db))?.capture_only_enabled) return;
  const now = new Date().toISOString();
  // Never requeue a possibly dispatched publish. Persisted confirmed IDs survive this hold.
  await db.prepare(`UPDATE media_threads_publications SET
    status = CASE WHEN remote_request_started_at IS NULL THEN 'queued' ELSE 'unknown_remote_state' END,
    last_error_code = CASE WHEN remote_request_started_at IS NULL THEN 'threads_stale_pre_publish' ELSE 'threads_stale_after_publish' END,
    unknown_at = CASE WHEN remote_request_started_at IS NOT NULL THEN coalesce(unknown_at, ?) ELSE unknown_at END,
    claim_key = NULL, updated_at = ? WHERE status = 'posting' AND last_attempted_at <= ?`)
    .bind(now, now, new Date(Date.now() - STALE_MS).toISOString()).run();
  const s = await settings(db);
  if (!s || !(s.manual_publishing_enabled || s.automatic_publishing_enabled)) return;
  try { tokenFor(env); } catch { try { await identityCheck(env); } catch { /* bounded D1 result */ } return; }
  if (s.last_successful_post_at && Date.parse(s.last_successful_post_at) + s.cooldown_seconds * 1000 > Date.now()) {
    await schedule(env); return;
  }
  const claim = crypto.randomUUID();
  const p = await db.prepare(`UPDATE media_threads_publications SET status = 'posting', claim_key = ?,
    last_attempted_at = ?, updated_at = ?, next_attempt_at = NULL
    WHERE id = (SELECT id FROM media_threads_publications WHERE status = 'queued'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND EXISTS (SELECT 1 FROM media_threads_settings s WHERE s.id = 1 AND ${reasonEnabledSql(env)})
      ORDER BY id LIMIT 1)
      AND status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM media_threads_publications WHERE status IN ('posting', 'unknown_remote_state'))
      AND EXISTS (SELECT 1 FROM media_threads_settings s WHERE s.id = 1 AND ${reasonEnabledSql(env)}
        AND (last_successful_post_at IS NULL OR julianday(?) >= julianday(last_successful_post_at) + cooldown_seconds / 86400.0))
    RETURNING *`).bind(claim, now, now, now, now).first<Publication>();
  if (!p) { await schedule(env); return; }
  try {
    const article = await db.prepare('SELECT title, publisher, canonical_url, status FROM media_articles WHERE id = ?')
      .bind(p.article_id).first<{ title: string; publisher: string; canonical_url: string; status: string }>();
    if (!article || article.status !== 'approved') throw new ThreadsProviderError('threads_article_not_approved', 'blocked');
    if (p.threads_user_id && p.threads_user_id !== env.UK_AQ_MEDIA_THREADS_USER_ID) {
      throw new ThreadsProviderError('threads_container_account_changed', 'blocked');
    }
    await identityCheck(env);
    const token = tokenFor(env);
    await remoteRequest(env, () => requirePublishingQuota(token, env.UK_AQ_MEDIA_THREADS_USER_ID));
    if (!p.threads_container_id) {
      const containerId = await remoteRequest(env, async () => {
        await assertDispatch(env, p, false);
        return createThreadsContainer(token, env.UK_AQ_MEDIA_THREADS_USER_ID, article);
      });
      const createdAt = new Date().toISOString();
      const persisted = await db.prepare(`UPDATE media_threads_publications SET threads_container_id = ?,
        container_created_at = ?, updated_at = ? WHERE id = ? AND status = 'posting' AND claim_key = ?`)
        .bind(containerId, createdAt, createdAt, p.id, p.claim_key).run();
      if (!persisted.meta.changes) throw new ThreadsProviderError('threads_container_persist_conflict', 'local_conflict');
      await finishClaim(env, p, 'queued', null, new Date(Date.now() + 60000).toISOString());
      await schedule(env); return;
    }
    if (!p.container_created_at || Date.now() - Date.parse(p.container_created_at) >= 24 * 60 * 60 * 1000) {
      throw new ThreadsProviderError('threads_container_expired', 'blocked');
    }
    const container = await remoteRequest(env, () => request(token, `/${remoteId(p.threads_container_id)}?fields=id%2Cstatus`));
    if (remoteId(container.id) !== p.threads_container_id) throw new ThreadsProviderError('threads_container_id_mismatch', 'blocked');
    if (container.status === 'IN_PROGRESS') {
      if (p.container_poll_count >= 4) throw new ThreadsProviderError('threads_container_processing_exhausted', 'blocked');
      await db.prepare(`UPDATE media_threads_publications SET container_poll_count = container_poll_count + 1
        WHERE id = ? AND status = 'posting' AND claim_key = ?`).bind(p.id, p.claim_key).run();
      await finishClaim(env, p, 'queued', 'threads_container_processing', new Date(Date.now() + 60000).toISOString());
      await schedule(env); return;
    }
    if (container.status === 'PUBLISHED') throw new ThreadsProviderError('threads_container_already_published', 'unknown_remote_state');
    if (container.status !== 'FINISHED') throw new ThreadsProviderError('threads_container_not_publishable', 'blocked');
    const postId = await remoteRequest(env, async () => {
      await assertDispatch(env, p, true);
      return publishThreadsContainer(token, env.UK_AQ_MEDIA_THREADS_USER_ID, p.threads_container_id!);
    });
    // Persist confirmation before optional read-back; no failure below can retry a publish.
    const postedAt = new Date().toISOString();
    const confirmed = await db.prepare(`UPDATE media_threads_publications SET threads_post_id = ?, updated_at = ?
      WHERE id = ? AND status = 'posting' AND claim_key = ? AND remote_request_started_at IS NOT NULL`)
      .bind(postId, postedAt, p.id, p.claim_key).run();
    if (!confirmed.meta.changes) throw new ThreadsProviderError('threads_confirmed_id_persist_conflict', 'local_conflict');
    const [posted] = await db.batch([
      db.prepare(`UPDATE media_threads_publications SET threads_post_id = ?, status = 'posted',
        posted_at = ?, updated_at = ?, claim_key = NULL, last_error_code = NULL,
        attempt_count = min(5, attempt_count + 1) WHERE id = ? AND status = 'posting' AND claim_key = ?`)
        .bind(postId, postedAt, postedAt, p.id, p.claim_key),
      db.prepare(`UPDATE media_threads_settings SET last_successful_post_at = ?, updated_at = ? WHERE id = 1
        AND EXISTS (SELECT 1 FROM media_threads_publications WHERE id = ? AND status = 'posted' AND threads_post_id = ?)`)
        .bind(postedAt, postedAt, p.id, postId),
    ]);
    if (!posted?.meta.changes) throw new ThreadsProviderError('threads_confirmed_post_persist_conflict', 'local_conflict');
    try {
      const read = await remoteRequest(env, () => readThreadsPost(token, postId, env.UK_AQ_MEDIA_THREADS_USERNAME));
      await db.prepare(`UPDATE media_threads_publications SET threads_permalink_url = ?, updated_at = ?
        WHERE id = ? AND threads_post_id = ? AND status = 'posted'`).bind(read.permalink, postedAt, p.id, postId).run();
    } catch { /* Confirmed posted ID remains successful; permalink is optional. */ }
  } catch (error) {
    const failure = error instanceof ThreadsProviderError ? error
      : new ThreadsProviderError('threads_local_failure', 'local_conflict');
    // The durable marker overrides exception classification, except explicit provider rejection.
    const current = await db.prepare('SELECT remote_request_started_at FROM media_threads_publications WHERE id = ?')
      .bind(p.id).first<{ remote_request_started_at: string | null }>();
    if (failure.kind === 'unknown_remote_state' || current?.remote_request_started_at && failure.kind !== 'blocked') {
      await finishClaim(env, p, 'unknown_remote_state', failure.code, null, 1);
    } else if (failure.kind === 'paused') {
      await finishClaim(env, p, 'queued', failure.code);
    } else if (failure.kind === 'safe_retry' && p.attempt_count < 4) {
      const delay = Math.min(MAX_DELAY, s.cooldown_seconds * 2 ** p.attempt_count);
      await finishClaim(env, p, 'queued', failure.code, new Date(Date.now() + delay * 1000).toISOString(), 1);
    } else {
      await finishClaim(env, p, failure.kind === 'safe_retry' ? 'failed' : 'blocked', failure.code, null, 1);
    }
    console.error(JSON.stringify({ event: 'threads_publication_held_or_failed', publication_id: p.id, error_code: failure.code }));
  }
  await schedule(env);
}

async function reconcileExact(env: MediaDiscoveryEnv, id: number, key: string): Promise<void> {
  const db = env.MEDIA_DB;
  if ((await settings(db))?.capture_only_enabled) return;
  const intent = await db.prepare(`SELECT request_json FROM media_threads_operator_requests
    WHERE request_key = ? AND publication_id = ? AND operation = 'reconcile'`).bind(key, id).first<{ request_json: string }>();
  if (!intent) return;
  const p = await db.prepare('SELECT * FROM media_threads_publications WHERE id = ?').bind(id).first<Publication>();
  if (!p || p.capture_only || !['unknown_remote_state', 'posted'].includes(p.status)) return;
  try {
    await identityCheck(env);
    if (p.threads_user_id !== env.UK_AQ_MEDIA_THREADS_USER_ID) throw new ThreadsProviderError('threads_reconcile_account_mismatch', 'blocked');
    const proposed = JSON.parse(intent.request_json) as { threads_post_id: string };
    if (p.threads_post_id && p.threads_post_id !== proposed.threads_post_id) throw new ThreadsProviderError('threads_reconcile_id_conflict', 'blocked');
    const read = await remoteRequest(env, () => readThreadsPost(tokenFor(env), proposed.threads_post_id, env.UK_AQ_MEDIA_THREADS_USERNAME));
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE media_threads_publications SET status = 'posted', threads_post_id = ?,
        threads_permalink_url = ?, posted_at = coalesce(posted_at, ?), reconciled_at = ?,
        reconciliation_method = 'operator_exact_post_id', last_error_code = NULL, updated_at = ?
        WHERE id = ? AND status IN ('unknown_remote_state', 'posted') AND (threads_post_id IS NULL OR threads_post_id = ?)`)
        .bind(read.id, read.permalink, now, now, now, id, read.id),
      db.prepare(`UPDATE media_threads_settings SET last_successful_post_at = ?, updated_at = ? WHERE id = 1
        AND EXISTS (SELECT 1 FROM media_threads_publications WHERE id = ? AND status = 'posted')`).bind(now, now, id),
    ]);
  } catch (error) {
    const code = error instanceof ThreadsProviderError ? error.code : 'threads_reconciliation_failed';
    await db.prepare(`UPDATE media_threads_publications SET last_error_code = ?, updated_at = ?
      WHERE id = ?`).bind(code, new Date().toISOString(), id).run();
  }
  await schedule(env);
}

export async function consumeThreads(message: Message<unknown>, env: MediaDiscoveryEnv): Promise<void> {
  const body = record(message.body);
  const keys = Object.keys(body);
  if ((await settings(env.MEDIA_DB))?.capture_only_enabled) {
    if (body.type === 'threads_wakeup' && keys.length === 1) await recoverAutomaticIntents(env);
    // Old identity, reconciliation and publish wake-ups cannot poll Meta in capture.
    message.ack(); return;
  }
  if (body.type === 'threads_identity_check' && keys.length === 1) {
    try { await identityCheck(env); } catch { /* durable bounded connection status */ }
  } else if (body.type === 'threads_wakeup' && keys.length === 1) {
    await recoverAutomaticIntents(env);
    await publishOne(env);
  } else if (body.type === 'threads_reconcile' && keys.length === 3 &&
      keys.every(key => ['type', 'publication_id', 'request_key'].includes(key)) &&
      Number.isSafeInteger(body.publication_id) && Number(body.publication_id) > 0 &&
      typeof body.request_key === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(body.request_key)) {
    await reconcileExact(env, Number(body.publication_id), body.request_key);
  } else console.error(JSON.stringify({ event: 'unsupported_threads_message' }));
  message.ack();
}
