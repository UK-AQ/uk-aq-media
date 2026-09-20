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
  last_identity_verified_at: string | null; last_successful_post_at: string | null };
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
