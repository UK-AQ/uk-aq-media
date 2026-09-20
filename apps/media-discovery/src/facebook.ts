import {
  FACEBOOK_PAGE_ID, FACEBOOK_PAGE_NAME, renderFacebookPost,
} from '@uk-aq-media/core';

export const FACEBOOK_GRAPH_API_VERSION = 'v26.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}`;
const MAX_GRAPH_RESPONSE_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 500;
const MAX_NAME_LENGTH = 500;
const MAX_PERMALINK_LENGTH = 2048;
const MAX_ERROR_CODE_LENGTH = 100;
export const FACEBOOK_STALE_CLAIM_MS = 10 * 60 * 1000;
export const FACEBOOK_MAX_QUEUE_DELAY_SECONDS = 43_200;

export type FacebookFailureKind = 'definite_pre_dispatch' | 'known_safe_retry' | 'blocked' |
  'unknown_remote_state' | 'local_state_conflict';

export class FacebookProviderError extends Error {
  readonly code: string;

  constructor(code: string, readonly kind: FacebookFailureKind) {
    const boundedCode = boundCode(code);
    super(boundedCode);
    this.code = boundedCode;
    this.name = 'FacebookProviderError';
  }
}

export type FacebookFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type FacebookSettings = { publishing_enabled: number; page_id: string; page_name: string;
  graph_api_version: string | null; default_message_template: string; cooldown_seconds: number;
  last_identity_checked_at: string | null; last_identity_verified_at: string | null;
  last_identity_observed_name: string | null; last_identity_name_drift: number;
  last_identity_error_code: string | null; last_successful_post_at: string | null };
export type FacebookPublication = { id: number; article_id: number; publication_key: string;
  publication_reason: string; status: string; attempt_count: number; facebook_post_id: string | null;
  facebook_permalink_url: string | null; next_attempt_at: string | null;
  remote_request_started_at: string | null; last_attempted_at: string | null; created_at: string };
export type FacebookArticle = { title: string; publisher: string; canonical_url: string };

function boundCode(code: string): string {
  const value = typeof code === 'string' ? code.trim() : '';
  return value && value.length <= MAX_ERROR_CODE_LENGTH ? value : 'facebook_provider_error';
}

function boundedString(value: unknown, maximum: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new FacebookProviderError(code, 'blocked');
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_GRAPH_RESPONSE_BYTES) {
    throw new Error('facebook_response_too_large');
  }
  if (!response.body) throw new Error('facebook_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_GRAPH_RESPONSE_BYTES) throw new Error('facebook_response_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already complete */ }
    reader.releaseLock();
  }
  if (!length) throw new Error('facebook_response_invalid');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    throw new Error('facebook_response_invalid');
  }
}

function metaError(body: unknown): FacebookProviderError {
  const error = body && typeof body === 'object' && 'error' in body
    ? (body as { error?: unknown }).error : null;
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code : null;
  const message = error && typeof error === 'object' && 'message' in error
    ? (error as { message?: unknown }).message : null;
  // Retry safety requires a complete, bounded Meta error rather than an HTTP
  // status or an unvalidated/truncated response that merely contains a number.
  const complete = typeof message === 'string' && !!message.trim() && message.length <= 1000;
  if (code === 80001 && complete) {
    return new FacebookProviderError('facebook_error_80001', 'known_safe_retry');
  }
  if (code === 100 || code === 190 || code === 200) {
    return new FacebookProviderError(`facebook_error_${code}`, 'blocked');
  }
  return new FacebookProviderError('facebook_provider_rejected', 'blocked');
}

async function request(fetchImpl: FacebookFetch, path: string, token: string,
  safeFailureKind: 'definite_pre_dispatch' | 'known_safe_retry',
  init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    response = await fetchImpl(`${GRAPH_API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new FacebookProviderError('facebook_transport_failure', safeFailureKind);
  }
  let body: unknown;
  try { body = await boundedJson(response); }
  catch (error) {
    throw new FacebookProviderError(error instanceof Error ? error.message : 'facebook_response_invalid',
      safeFailureKind);
  }
  if (!response.ok) throw metaError(body);
  return { response, body };
}

export async function validateFacebookIdentity(token: string, fetchImpl: FacebookFetch = fetch): Promise<{
  id: string; name: string | null; nameDrift: boolean;
}> {
  const { body } = await request(fetchImpl, '/me?fields=id%2Cname', token, 'definite_pre_dispatch');
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const id = boundedString(record.id, MAX_ID_LENGTH, 'facebook_identity_invalid');
  if (id !== FACEBOOK_PAGE_ID) {
    throw new FacebookProviderError('facebook_identity_mismatch', 'blocked');
  }
  const name = record.name === undefined ? null
    : boundedString(record.name, MAX_NAME_LENGTH, 'facebook_identity_invalid');
  return { id, name, nameDrift: name !== null && name !== FACEBOOK_PAGE_NAME };
}

function validPostId(value: unknown, errorKind: FacebookFailureKind): string {
  try { return boundedString(value, MAX_ID_LENGTH, 'facebook_post_id_invalid'); }
  catch { throw new FacebookProviderError('facebook_post_id_invalid', errorKind); }
}

export async function createFacebookPost(input: { token: string; title: string; publisher: string;
  canonical_url: string; template: string; markRemoteRequestStarted: () => Promise<void> },
  fetchImpl: FacebookFetch = fetch): Promise<{ facebookPostId: string; permalinkUrl: null }> {
  let rendered: ReturnType<typeof renderFacebookPost>;
  try { rendered = renderFacebookPost(input); }
  catch (error) {
    throw new FacebookProviderError(error instanceof Error ? error.message : 'facebook_post_invalid',
      'definite_pre_dispatch');
  }
  try { await input.markRemoteRequestStarted(); }
  catch { throw new FacebookProviderError('facebook_dispatch_marker_failed', 'local_state_conflict'); }

  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH_API_BASE}/${FACEBOOK_PAGE_ID}/feed`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ message: rendered.message, link: rendered.link }).toString(),
    });
  } catch {
    throw new FacebookProviderError('facebook_transport_failure', 'unknown_remote_state');
  }
  let body: unknown;
  try { body = await boundedJson(response); }
  catch (error) {
    throw new FacebookProviderError(error instanceof Error ? error.message : 'facebook_response_invalid',
      'unknown_remote_state');
  }
  if (!response.ok) throw metaError(body);
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return { facebookPostId: validPostId(record.id, 'unknown_remote_state'), permalinkUrl: null };
}

function validatedPermalink(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value || value.length > MAX_PERMALINK_LENGTH) {
    throw new FacebookProviderError('facebook_readback_invalid', 'blocked');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'facebook.com' &&
        !url.hostname.endsWith('.facebook.com'))) throw new Error();
  } catch { throw new FacebookProviderError('facebook_readback_invalid', 'blocked'); }
  return value;
}

export async function readFacebookPost(postId: string, token: string,
  fetchImpl: FacebookFetch = fetch): Promise<{ facebookPostId: string; permalinkUrl: string | null }> {
  const expected = validPostId(postId, 'definite_pre_dispatch');
  const fields = encodeURIComponent('id,permalink_url');
  const { body } = await request(fetchImpl, `/${encodeURIComponent(expected)}?fields=${fields}`,
    token, 'known_safe_retry');
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const actual = validPostId(record.id, 'blocked');
  if (actual !== expected) throw new FacebookProviderError('facebook_post_id_mismatch', 'blocked');
  return { facebookPostId: actual, permalinkUrl: validatedPermalink(record.permalink_url) };
}

export async function loadFacebookSettings(db: D1Database): Promise<FacebookSettings | null> {
  return db.prepare('SELECT * FROM media_facebook_settings WHERE id = 1').first<FacebookSettings>();
}

export async function loadFacebookPublication(db: D1Database, id: number): Promise<FacebookPublication | null> {
  return db.prepare('SELECT * FROM media_facebook_publications WHERE id = ?').bind(id)
    .first<FacebookPublication>();
}

export async function loadFacebookArticle(db: D1Database, id: number): Promise<FacebookArticle | null> {
  return db.prepare('SELECT title, publisher, canonical_url FROM media_articles WHERE id = ?').bind(id)
    .first<FacebookArticle>();
}

export async function claimFacebookPublication(db: D1Database, now: string): Promise<FacebookPublication | null> {
  const candidate = await db.prepare(`SELECT * FROM media_facebook_publications
    WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id LIMIT 1`).bind(now).first<FacebookPublication>();
  if (!candidate) return null;
  const result = await db.prepare(`UPDATE media_facebook_publications SET status = 'posting',
    next_attempt_at = NULL, remote_request_started_at = NULL, last_attempted_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM media_facebook_publications WHERE status = 'posting')`)
    .bind(now, now, candidate.id, now).run();
  return result.meta.changes ? { ...candidate, status: 'posting', next_attempt_at: null,
    remote_request_started_at: null, last_attempted_at: now } : null;
}

export async function markFacebookRemoteRequestStarted(db: D1Database, id: number,
  now: string): Promise<void> {
  const result = await db.prepare(`UPDATE media_facebook_publications
    SET remote_request_started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'posting' AND remote_request_started_at IS NULL`)
    .bind(now, now, id).run();
  if (!result.meta.changes) throw new FacebookProviderError('facebook_dispatch_marker_failed', 'local_state_conflict');
}

export async function markFacebookPosted(db: D1Database, id: number, postId: string,
  permalink: string | null, postedAt: string): Promise<void> {
  const [publication] = await db.batch([
    db.prepare(`UPDATE media_facebook_publications SET status = 'posted', facebook_post_id = ?,
      facebook_permalink_url = ?, posted_at = ?, attempt_count = attempt_count + 1,
      last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'posting' AND remote_request_started_at IS NOT NULL`)
      .bind(postId, permalink, postedAt, postedAt, id),
    db.prepare(`UPDATE media_facebook_settings SET last_successful_post_at = CASE
        WHEN last_successful_post_at IS NULL OR last_successful_post_at < ? THEN ?
        ELSE last_successful_post_at END, updated_at = ? WHERE id = 1 AND EXISTS (
        SELECT 1 FROM media_facebook_publications WHERE id = ? AND status = 'posted'
          AND facebook_post_id = ? AND posted_at = ?)`)
      .bind(postedAt, postedAt, postedAt, id, postId, postedAt),
  ]);
  if (!publication?.meta.changes) throw new FacebookProviderError('facebook_post_state_conflict', 'local_state_conflict');
}

async function markFacebookOutcome(db: D1Database, id: number, status: 'queued' | 'blocked' |
  'failed' | 'unknown_remote_state', code: string, now: string, nextAttemptAt: string | null): Promise<void> {
  const result = await db.prepare(`UPDATE media_facebook_publications SET status = ?,
    attempt_count = attempt_count + 1, last_error_code = ?, next_attempt_at = ?,
    unknown_at = CASE WHEN ? = 'unknown_remote_state' THEN COALESCE(unknown_at, ?) ELSE unknown_at END,
    updated_at = ? WHERE id = ? AND status = 'posting'`)
    .bind(status, boundCode(code), nextAttemptAt, status, now, now, id).run();
  if (!result.meta.changes) throw new FacebookProviderError('facebook_post_state_conflict', 'local_state_conflict');
}

export const scheduleFacebookKnownSafeRetry = (db: D1Database, id: number, code: string,
  now: string, nextAttemptAt: string) => markFacebookOutcome(db, id, 'queued', code, now, nextAttemptAt);
export const markFacebookBlocked = (db: D1Database, id: number, code: string, now: string) =>
  markFacebookOutcome(db, id, 'blocked', code, now, null);
export const markFacebookFailed = (db: D1Database, id: number, code: string, now: string) =>
  markFacebookOutcome(db, id, 'failed', code, now, null);
export const markFacebookUnknownRemoteState = (db: D1Database, id: number, code: string, now: string) =>
  markFacebookOutcome(db, id, 'unknown_remote_state', code, now, null);

export function facebookRetryAt(attemptCount: number, cooldownSeconds: number, nowMs: number): string {
  const boundedAttempt = Math.max(0, Math.min(20, Math.trunc(attemptCount)));
  const boundedCooldown = Math.max(60, Math.min(86_400, Math.trunc(cooldownSeconds)));
  const delay = Math.min(FACEBOOK_MAX_QUEUE_DELAY_SECONDS, boundedCooldown * 2 ** boundedAttempt);
  return new Date(nowMs + delay * 1000).toISOString();
}

export function classifyStaleFacebookPosting(remoteRequestStartedAt: string | null):
  'queued' | 'unknown_remote_state' {
  return remoteRequestStartedAt === null ? 'queued' : 'unknown_remote_state';
}

export async function classifyStaleFacebookPublications(db: D1Database, now: string,
  staleBefore: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE media_facebook_publications SET status = 'queued',
      last_error_code = 'facebook_stale_pre_dispatch', next_attempt_at = NULL, updated_at = ?
      WHERE status = 'posting' AND remote_request_started_at IS NULL
        AND (last_attempted_at IS NULL OR last_attempted_at <= ?)`).bind(now, staleBefore),
    db.prepare(`UPDATE media_facebook_publications SET status = 'unknown_remote_state',
      last_error_code = 'facebook_stale_after_dispatch', unknown_at = COALESCE(unknown_at, ?), updated_at = ?
      WHERE status = 'posting' AND remote_request_started_at IS NOT NULL
        AND (last_attempted_at IS NULL OR last_attempted_at <= ?)`).bind(now, now, staleBefore),
  ]);
}

export async function reconcileFacebookExactPost(db: D1Database, publication: FacebookPublication,
  token: string, now: string, fetchImpl: FacebookFetch = fetch): Promise<void> {
  if (!publication.facebook_post_id) {
    throw new FacebookProviderError('facebook_exact_post_id_required', 'local_state_conflict');
  }
  const read = await readFacebookPost(publication.facebook_post_id, token, fetchImpl);
  const result = await db.prepare(`UPDATE media_facebook_publications
    SET facebook_permalink_url = COALESCE(facebook_permalink_url, ?),
      reconciled_at = COALESCE(reconciled_at, ?),
      reconciliation_method = COALESCE(reconciliation_method, 'exact_post_id'), updated_at = ?
    WHERE id = ? AND facebook_post_id = ?`)
    .bind(read.permalinkUrl, now, now, publication.id, read.facebookPostId).run();
  if (!result.meta.changes) throw new FacebookProviderError('facebook_post_state_conflict', 'local_state_conflict');
}

const FACEBOOK_MAX_ATTEMPTS = 5;

type FacebookQueueMessage = { type: 'facebook_wakeup'; publication_id?: number } |
  { type: 'facebook_identity_check' };

function parseFacebookMessage(value: unknown): FacebookQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === 'facebook_identity_check' && keys.length === 1) return { type: record.type };
  if (record.type !== 'facebook_wakeup' || keys.some(key => key !== 'type' && key !== 'publication_id')) return null;
  if (record.publication_id === undefined) return { type: record.type };
  return Number.isSafeInteger(record.publication_id) && Number(record.publication_id) > 0
    ? { type: record.type, publication_id: Number(record.publication_id) } : null;
}

async function recordIdentitySuccess(db: D1Database, identity: { name: string | null;
  nameDrift: boolean }, now: string): Promise<void> {
  await db.prepare(`UPDATE media_facebook_settings SET last_identity_checked_at = ?,
    last_identity_verified_at = ?, last_identity_observed_name = ?,
    last_identity_name_drift = ?, last_identity_error_code = NULL, updated_at = ? WHERE id = 1`)
    .bind(now, now, identity.name, Number(identity.nameDrift), now).run();
}

async function recordIdentityFailure(db: D1Database, code: string, now: string): Promise<void> {
  await db.prepare(`UPDATE media_facebook_settings SET last_identity_checked_at = ?,
    last_identity_error_code = ?, updated_at = ? WHERE id = 1`)
    .bind(now, boundCode(code), now).run();
}

async function checkIdentity(env: MediaDiscoveryEnv): Promise<void> {
  const now = new Date().toISOString();
  try {
    const identity = await validateFacebookIdentity(env.UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN);
    await recordIdentitySuccess(env.MEDIA_DB, identity, now);
  } catch (error) {
    const code = error instanceof FacebookProviderError ? error.code : 'facebook_identity_check_failed';
    await recordIdentityFailure(env.MEDIA_DB, code, now);
    throw error;
  }
}

async function validateAndRecordIdentity(env: MediaDiscoveryEnv): Promise<void> {
  const now = new Date().toISOString();
  try {
    const identity = await validateFacebookIdentity(env.UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN);
    await recordIdentitySuccess(env.MEDIA_DB, identity, now);
  } catch (error) {
    await recordIdentityFailure(env.MEDIA_DB,
      error instanceof FacebookProviderError ? error.code : 'facebook_identity_check_failed', now);
    throw error;
  }
}

function validSettings(settings: FacebookSettings | null): settings is FacebookSettings {
  return !!settings && settings.page_id === FACEBOOK_PAGE_ID &&
    settings.graph_api_version === FACEBOOK_GRAPH_API_VERSION &&
    Number.isInteger(settings.cooldown_seconds) && settings.cooldown_seconds >= 60 &&
    settings.cooldown_seconds <= 86_400;
}

async function nextFacebookWakeDelay(db: D1Database, settings: FacebookSettings,
  nowMs: number): Promise<number | null> {
  const row = await db.prepare(`SELECT MIN(due_at) AS due_at FROM (
    SELECT COALESCE(next_attempt_at, created_at) AS due_at FROM media_facebook_publications
      WHERE status = 'queued'
    UNION ALL
    SELECT datetime(COALESCE(last_attempted_at, created_at), '+10 minutes') AS due_at
      FROM media_facebook_publications WHERE status = 'posting'
  )`).first<{ due_at: string | null }>();
  if (!row?.due_at) return null;
  let dueMs = Date.parse(row.due_at.endsWith('Z') ? row.due_at : `${row.due_at.replace(' ', 'T')}Z`);
  if (!Number.isFinite(dueMs)) dueMs = nowMs;
  if (settings.last_successful_post_at) {
    dueMs = Math.max(dueMs, Date.parse(settings.last_successful_post_at) + settings.cooldown_seconds * 1000);
  }
  return Math.max(0, Math.min(FACEBOOK_MAX_QUEUE_DELAY_SECONDS, Math.ceil((dueMs - nowMs) / 1000)));
}

async function scheduleNextFacebookWake(env: MediaDiscoveryEnv,
  settings: FacebookSettings): Promise<void> {
  const delaySeconds = await nextFacebookWakeDelay(env.MEDIA_DB, settings, Date.now());
  if (delaySeconds !== null) {
    await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }, { delaySeconds });
  }
}

export async function reconcileFacebookQueue(env: MediaDiscoveryEnv): Promise<void> {
  const settings = await loadFacebookSettings(env.MEDIA_DB);
  if (!validSettings(settings) || !settings.publishing_enabled) return;
  await scheduleNextFacebookWake(env, settings);
}

async function publishOne(env: MediaDiscoveryEnv): Promise<void> {
  const settings = await loadFacebookSettings(env.MEDIA_DB);
  if (!validSettings(settings) || !settings.publishing_enabled) return;
  const now = new Date();
  const nowIso = now.toISOString();
  await classifyStaleFacebookPublications(env.MEDIA_DB, nowIso,
    new Date(now.getTime() - FACEBOOK_STALE_CLAIM_MS).toISOString());
  if (settings.last_successful_post_at &&
      Date.parse(settings.last_successful_post_at) + settings.cooldown_seconds * 1000 > now.getTime()) {
    await scheduleNextFacebookWake(env, settings);
    return;
  }
  const publication = await claimFacebookPublication(env.MEDIA_DB, nowIso);
  if (!publication) return;
  try {
    const article = await loadFacebookArticle(env.MEDIA_DB, publication.article_id);
    if (!article) throw new FacebookProviderError('facebook_article_missing', 'blocked');
    await validateAndRecordIdentity(env);
    const created = await createFacebookPost({ token: env.UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN,
      ...article, template: settings.default_message_template,
      markRemoteRequestStarted: () => markFacebookRemoteRequestStarted(env.MEDIA_DB,
        publication.id, new Date().toISOString()) });
    const postedAt = new Date().toISOString();
    await markFacebookPosted(env.MEDIA_DB, publication.id, created.facebookPostId, null, postedAt);
    try {
      const posted = await loadFacebookPublication(env.MEDIA_DB, publication.id);
      if (posted) await reconcileFacebookExactPost(env.MEDIA_DB, posted,
        env.UK_AQ_MEDIA_FACEBOOK_PAGE_TOKEN, new Date().toISOString());
    } catch {
      console.warn(JSON.stringify({ event: 'facebook_readback_failed', publication_id: publication.id }));
    }
  } catch (error) {
    const provider = error instanceof FacebookProviderError ? error
      : new FacebookProviderError('facebook_publication_failed', 'blocked');
    const failureAt = new Date().toISOString();
    if (provider.kind === 'known_safe_retry' || provider.kind === 'definite_pre_dispatch') {
      if (publication.attempt_count + 1 >= FACEBOOK_MAX_ATTEMPTS) {
        await markFacebookFailed(env.MEDIA_DB, publication.id, provider.code, failureAt);
      } else {
        await scheduleFacebookKnownSafeRetry(env.MEDIA_DB, publication.id, provider.code, failureAt,
          facebookRetryAt(publication.attempt_count, settings.cooldown_seconds, Date.now()));
      }
    } else if (provider.kind === 'unknown_remote_state') {
      await markFacebookUnknownRemoteState(env.MEDIA_DB, publication.id, provider.code, failureAt);
    } else if (provider.kind === 'blocked') {
      await markFacebookBlocked(env.MEDIA_DB, publication.id, provider.code, failureAt);
    }
    console.error(JSON.stringify({ event: 'facebook_publication_failed',
      publication_id: publication.id, error_code: provider.code }));
  }
  const latest = await loadFacebookSettings(env.MEDIA_DB);
  if (validSettings(latest) && latest.publishing_enabled) await scheduleNextFacebookWake(env, latest);
}

export async function consumeFacebook(message: Message<unknown>, env: MediaDiscoveryEnv): Promise<void> {
  const parsed = parseFacebookMessage(message.body);
  if (!parsed) {
    console.error(JSON.stringify({ event: 'unsupported_facebook_message', message_id: message.id }));
    message.ack();
    return;
  }
  if (parsed.type === 'facebook_identity_check') {
    try { await checkIdentity(env); }
    catch { /* Durable bounded connection state is the result; Queue retry is unnecessary. */ }
    message.ack();
    return;
  }
  await publishOne(env);
  message.ack();
}
