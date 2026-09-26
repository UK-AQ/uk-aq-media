import {
  BLUESKY_HANDLE, BLUESKY_THUMBNAIL_BYTES, deterministicTid, fetchRemotePreviewImage,
  isBlueskyWakeup, remotePreviewUrl, renderBlueskyPost, type BlueskyWakeup, type Source,
} from '@uk-aq-media/core';
import { fetchArticleHeadMetadata, type ArticleHeadMetadata } from '@uk-aq-media/discovery';

type Settings = { publishing_enabled: number; activation_event_id: number | null;
  cooldown_seconds: number; default_message_template: string; last_successful_post_at: string | null };
type Publication = { id: number; article_id: number; publication_key: string; status: string;
  attempt_count: number; record_key: string | null; created_at: string };
type Article = { canonical_url: string; title: string;
  publisher: string; og_image_url: string | null; image_policy: string; source_key: string;
  canonical_domain: string; source_image_policy: Source['image_policy']; social_handle: string | null;
  social_did: string | null };

const XRPC = 'https://bsky.social/xrpc/';
const MAX_ATTEMPTS = 5;
const XRPC_TIMEOUT_MS = 15_000;
const MAX_QUEUE_DELAY_SECONDS = 43_200;
const MAX_XRPC_JSON_BYTES = 256 * 1024;
const STALE_CLAIM_MS = 10 * 60 * 1000;

export class PublicationError extends Error {
  constructor(readonly code: string, readonly transient = false) { super(code); }
}

export function thumbnailFetchDiagnostic(
  failure: 'timeout' | 'failed' | 'redirect' | null,
  httpStatus: number | null,
): { code: string; transient: boolean } | null {
  if (failure === 'redirect') return { code: 'thumbnail_redirect_rejected', transient: false };
  if (failure === 'timeout') return { code: 'thumbnail_timeout', transient: true };
  if (failure === 'failed') return { code: 'thumbnail_network_failed', transient: true };
  if (httpStatus !== null) return { code: `thumbnail_http_${httpStatus}`, transient: true };
  return null;
}

export function externalCardText(articleTitle: string,
  metadata?: ArticleHeadMetadata): { title: string; description: string } {
  return {
    title: metadata?.ogTitle ?? metadata?.twitterTitle ?? metadata?.htmlTitle ?? articleTitle,
    description: metadata?.ogDescription ?? metadata?.twitterDescription ??
      metadata?.htmlDescription ?? '',
  };
}

async function loadExternalCardText(article: Article): Promise<{
  title: string; description: string;
}> {
  try {
    const metadata = await fetchArticleHeadMetadata(article.canonical_url, {
      source_key: article.source_key,
      canonical_domain: article.canonical_domain,
      image_policy: article.source_image_policy,
    });
    return externalCardText(article.title, metadata);
  } catch {
    return externalCardText(article.title);
  }
}

type XrpcResult = { status: number; ok: boolean; body: unknown };

export function isTransientXrpcStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_XRPC_JSON_BYTES) throw new Error('xrpc_response_too_large');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_XRPC_JSON_BYTES) throw new Error('xrpc_response_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* body already completed or aborted */ }
    reader.releaseLock();
  }
  if (!length) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

async function boundedBytes(response: Response, limit: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new PublicationError('thumbnail_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* body already completed or aborted */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function xrpc(path: string, init: RequestInit,
  timeoutMs = XRPC_TIMEOUT_MS): Promise<XrpcResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${XRPC}${path}`, { ...init, signal: controller.signal });
    return { status: response.status, ok: response.ok, body: await boundedJson(response) };
  }
  catch { throw new PublicationError('bluesky_api_transient', true); }
  finally { clearTimeout(timeout); }
}

export async function authenticate(password: string): Promise<{ accessJwt: string; did: string }> {
  const response = await xrpc('com.atproto.server.createSession', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_HANDLE, password }) });
  if (!response.ok) {
    const transient = isTransientXrpcStatus(response.status);
    throw new PublicationError(transient ? 'bluesky_api_transient' : 'bluesky_auth_failed', transient);
  }
  const body = response.body as { accessJwt?: unknown; did?: unknown; handle?: unknown } | null;
  if (!body || typeof body.accessJwt !== 'string' || typeof body.did !== 'string' ||
      typeof body.handle !== 'string') throw new PublicationError('bluesky_auth_failed');
  if (body.handle.toLowerCase() !== BLUESKY_HANDLE) {
    throw new PublicationError('bluesky_identity_mismatch');
  }
  return { accessJwt: body.accessJwt, did: body.did };
}

async function loadThumbnail(article: Article): Promise<{ bytes: ArrayBuffer; type: string }> {
  if (!article.og_image_url || article.image_policy !== 'remote_preview' ||
      article.source_image_policy !== 'remote_preview' ||
      !remotePreviewUrl(article.og_image_url, article)) throw new PublicationError('thumbnail_missing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const fetched = await fetchRemotePreviewImage(article.og_image_url, article, controller.signal);
    const diagnostic = thumbnailFetchDiagnostic(fetched.failure,
      fetched.response && !fetched.response.ok ? fetched.response.status : null);
    if (diagnostic) {
      await fetched.response?.body?.cancel();
      throw new PublicationError(diagnostic.code, diagnostic.transient);
    }
    if (!fetched.response) throw new PublicationError('thumbnail_network_failed', true);
    const type = fetched.response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
      await fetched.response.body?.cancel();
      throw new PublicationError('thumbnail_invalid');
    }
    const declared = Number(fetched.response.headers.get('content-length') ?? 0);
    if (declared > BLUESKY_THUMBNAIL_BYTES) {
      await fetched.response.body?.cancel();
      throw new PublicationError('thumbnail_too_large');
    }
    const bytes = await boundedBytes(fetched.response, BLUESKY_THUMBNAIL_BYTES);
    if (!bytes.byteLength || bytes.byteLength > BLUESKY_THUMBNAIL_BYTES) {
      throw new PublicationError(bytes.byteLength ? 'thumbnail_too_large' : 'thumbnail_invalid');
    }
    return { bytes, type };
  } catch (error) {
    if (controller.signal.aborted) throw new PublicationError('thumbnail_timeout', true);
    if (error instanceof PublicationError) throw error;
    throw new PublicationError('thumbnail_network_failed', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadBlob(auth: { accessJwt: string }, thumbnail: { bytes: ArrayBuffer; type: string }) {
  const response = await xrpc('com.atproto.repo.uploadBlob', { method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessJwt}`, 'Content-Type': thumbnail.type },
    body: thumbnail.bytes });
  if (!response.ok) {
    const transient = isTransientXrpcStatus(response.status);
    throw new PublicationError(transient ? 'bluesky_api_transient' : 'bluesky_post_rejected', transient);
  }
  const body = response.body as { blob?: unknown } | null;
  if (!body?.blob) throw new PublicationError('bluesky_post_rejected');
  return body.blob;
}

async function createOrReadPost(auth: { accessJwt: string; did: string }, rkey: string,
  record: Record<string, unknown>): Promise<{ uri: string; cid: string; createdAt: string }> {
  const expectedUri = `at://${auth.did}/app.bsky.feed.post/${rkey}`;
  const reference = (body: unknown): { uri: string; cid: string } => {
    const value = body as { uri?: unknown; cid?: unknown } | null;
    if (!value || value.uri !== expectedUri || typeof value.cid !== 'string' ||
        !value.cid || value.cid.length > 200) {
      // A successful write with an unusable response must retry the same rkey so
      // the existing-record reconciliation path can close the crash window.
      throw new PublicationError('bluesky_api_transient', true);
    }
    return { uri: value.uri, cid: value.cid };
  };
  const response = await xrpc('com.atproto.repo.createRecord', { method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: auth.did, collection: 'app.bsky.feed.post', rkey, record }) });
  if (response.ok) {
    const createdAt = record.createdAt;
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      throw new PublicationError('publication_state_conflict');
    }
    return { ...reference(response.body), createdAt: new Date(createdAt).toISOString() };
  }
  if (isTransientXrpcStatus(response.status)) {
    throw new PublicationError('bluesky_api_transient', true);
  }
  // A retry after the remote write/D1 crash window receives an existing-record
  // conflict. Read that exact deterministic record before declaring success.
  if (response.status === 400 || response.status === 409) {
    const query = new URLSearchParams({ repo: auth.did, collection: 'app.bsky.feed.post', rkey });
    const existing = await xrpc(`com.atproto.repo.getRecord?${query}`, {
      headers: { Authorization: `Bearer ${auth.accessJwt}` },
    });
    if (existing.ok) {
      const body = existing.body as { value?: unknown } | null;
      const value = body?.value as { createdAt?: unknown } | null;
      if (!value || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
        throw new PublicationError('bluesky_api_transient', true);
      }
      return { ...reference(existing.body), createdAt: new Date(value.createdAt).toISOString() };
    }
    if (isTransientXrpcStatus(existing.status)) {
      throw new PublicationError('bluesky_api_transient', true);
    }
    if (existing.status === 404) throw new PublicationError('publication_state_conflict');
    throw new PublicationError('bluesky_post_rejected');
  }
  throw new PublicationError('bluesky_post_rejected');
}

async function fail(db: D1Database, publication: Publication, error: PublicationError): Promise<void> {
  const retry = error.transient && publication.attempt_count + 1 < MAX_ATTEMPTS;
  const delaySeconds = Math.min(900, 30 * 2 ** publication.attempt_count);
  const nextAttemptAt = retry ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;
  await db.prepare(`UPDATE media_bluesky_publications SET status = ?, attempt_count = attempt_count + 1,
    last_error_code = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'posting'`)
    .bind(retry ? 'queued' : error.transient ? 'failed' : 'blocked', error.code,
      nextAttemptAt, new Date().toISOString(), publication.id).run();
}

export async function reconcileBlueskyQueue(env: MediaDiscoveryEnv): Promise<void> {
  const queued = await env.MEDIA_DB.prepare(
    "SELECT id FROM media_bluesky_publications WHERE status IN ('queued', 'posting') LIMIT 1").first();
  if (queued) await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' } satisfies BlueskyWakeup);
}

export async function scheduleNextBacklogWake(env: MediaDiscoveryEnv,
  settings: Settings): Promise<boolean> {
  const [nextQueued, nextPosting] = await Promise.all([
    env.MEDIA_DB.prepare(`SELECT next_attempt_at FROM media_bluesky_publications
      WHERE status = 'queued'
      ORDER BY CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END, next_attempt_at, id LIMIT 1`)
      .first<{ next_attempt_at: string | null }>(),
    env.MEDIA_DB.prepare(`SELECT last_attempted_at FROM media_bluesky_publications
      WHERE status = 'posting'
      ORDER BY CASE WHEN last_attempted_at IS NULL THEN 0 ELSE 1 END,
        last_attempted_at, id LIMIT 1`).first<{ last_attempted_at: string | null }>(),
  ]);
  if (!nextQueued && !nextPosting) return false;
  const now = Date.now();
  const queuedAt = nextQueued ? nextQueued.next_attempt_at
    ? Date.parse(nextQueued.next_attempt_at) : now : Number.POSITIVE_INFINITY;
  const parsedPostingAt = nextPosting?.last_attempted_at
    ? Date.parse(nextPosting.last_attempted_at) + STALE_CLAIM_MS : now;
  const postingAt = Number.isFinite(parsedPostingAt) ? parsedPostingAt : now;
  // A live claim is a global barrier. Queued eligibility cannot outrank the
  // earliest claim-recovery threshold in the remote-success/D1-crash window.
  const workAt = nextPosting ? postingAt : queuedAt;
  const cooldownAt = settings.last_successful_post_at
    ? Date.parse(settings.last_successful_post_at) + settings.cooldown_seconds * 1000 : now;
  const delaySeconds = Math.max(0, Math.ceil((Math.max(workAt, cooldownAt) - now) / 1000));
  await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' } satisfies BlueskyWakeup,
    delaySeconds ? { delaySeconds: Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS) } : undefined);
  return true;
}

export async function consumeBluesky(message: Message<unknown>, env: MediaDiscoveryEnv): Promise<void> {
  if (!isBlueskyWakeup(message.body)) { message.ack(); return; }
  const settings = await env.MEDIA_DB.prepare('SELECT * FROM media_bluesky_settings WHERE id = 1')
    .first<Settings>();
  if (!settings || settings.activation_event_id === null || !settings.publishing_enabled) {
    message.ack(); return;
  }
  const now = Date.now();
  if (settings.last_successful_post_at) {
    const remaining = Math.ceil((Date.parse(settings.last_successful_post_at) +
      settings.cooldown_seconds * 1000 - now) / 1000);
    if (remaining > 0) {
      await scheduleNextBacklogWake(env, settings);
      message.ack(); return;
    }
  }
  // Recover claims older than ten minutes. Any claim still posting is a global
  // barrier: do not let later queued work bypass its remote reconciliation.
  await env.MEDIA_DB.prepare(`UPDATE media_bluesky_publications SET status = 'queued',
    last_error_code = 'publication_state_conflict', next_attempt_at = NULL, updated_at = ?
    WHERE status = 'posting' AND (last_attempted_at IS NULL OR last_attempted_at <= ?)`)
    .bind(new Date(now).toISOString(),
      new Date(now - STALE_CLAIM_MS).toISOString()).run();
  const livePosting = await env.MEDIA_DB.prepare(`SELECT id FROM media_bluesky_publications
    WHERE status = 'posting' ORDER BY last_attempted_at, id LIMIT 1`).first();
  if (livePosting) {
    await scheduleNextBacklogWake(env, settings);
    message.ack(); return;
  }
  const publication = await env.MEDIA_DB.prepare(`SELECT id, article_id, publication_key, status,
    attempt_count, record_key, created_at FROM media_bluesky_publications
    WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id LIMIT 1`).bind(new Date(now).toISOString()).first<Publication>();
  if (!publication) {
    await scheduleNextBacklogWake(env, settings);
    message.ack(); return;
  }
  const recordKey = publication.record_key ?? deterministicTid(publication.created_at, publication.id);
  const claimed = await env.MEDIA_DB.prepare(`UPDATE media_bluesky_publications
    SET status = 'posting', record_key = ?, next_attempt_at = NULL,
      last_attempted_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM media_bluesky_publications WHERE status = 'posting')`)
    .bind(recordKey, new Date(now).toISOString(),
      new Date(now).toISOString(), publication.id).run();
  if (!claimed.meta.changes) {
    await scheduleNextBacklogWake(env, settings);
    message.ack(); return;
  }
  let wakeSettings = settings;
  try {
    const article = await env.MEDIA_DB.prepare(`SELECT a.canonical_url, a.title,
      a.publisher, a.og_image_url, a.image_policy, a.source_key, s.canonical_domain,
      s.image_policy AS source_image_policy, social.handle AS social_handle,
      social.account_did AS social_did FROM media_articles a
      JOIN media_sources s ON s.source_key = a.source_key
      LEFT JOIN media_source_social_accounts social ON social.source_key = a.source_key
        AND social.platform = 'bluesky' AND social.mention_enabled = 1
      WHERE a.id = ?`).bind(publication.article_id).first<Article>();
    if (!article) throw new PublicationError('publication_state_conflict');
    const thumbnail = await loadThumbnail(article);
    const cardText = await loadExternalCardText(article);
    const auth = await authenticate(env.UK_AQ_MEDIA_BLUESKY_APP_PSWD);
    const blob = await uploadBlob(auth, thumbnail);
    const rendered = renderBlueskyPost({ title: article.title,
      publisher: article.publisher, template: settings.default_message_template,
      publisherMention: article.social_handle && article.social_did
        ? { handle: article.social_handle, did: article.social_did } : null });
    const recordCreatedAt = new Date().toISOString();
    const result = await createOrReadPost(auth, recordKey, {
      $type: 'app.bsky.feed.post', text: rendered.text, facets: rendered.facets,
      langs: ['en-GB'], createdAt: recordCreatedAt,
      embed: { $type: 'app.bsky.embed.external', external: {
        uri: article.canonical_url, title: cardText.title,
        description: cardText.description, thumb: blob,
      } },
    });
    const postedAt = result.createdAt;
    const reconciledAt = new Date().toISOString();
    const [publicationUpdate] = await env.MEDIA_DB.batch([
      env.MEDIA_DB.prepare(`UPDATE media_bluesky_publications SET status = 'posted',
        attempt_count = attempt_count + 1, post_uri = ?, post_cid = ?, last_error_code = NULL,
        next_attempt_at = NULL, posted_at = ?, updated_at = ?
        WHERE id = ? AND status = 'posting'`)
        .bind(result.uri, result.cid, postedAt, reconciledAt, publication.id),
      env.MEDIA_DB.prepare(`UPDATE media_bluesky_settings SET last_successful_post_at = CASE
          WHEN last_successful_post_at IS NULL OR last_successful_post_at < ? THEN ?
          ELSE last_successful_post_at END,
        updated_at = ? WHERE id = 1 AND EXISTS (
          SELECT 1 FROM media_bluesky_publications
          WHERE id = ? AND status = 'posted' AND posted_at = ?
        )`).bind(postedAt, postedAt, reconciledAt, publication.id, postedAt),
    ]);
    if (!publicationUpdate?.meta.changes) throw new PublicationError('publication_state_conflict');
    const priorSuccessful = settings.last_successful_post_at
      && Date.parse(settings.last_successful_post_at) > Date.parse(postedAt)
      ? settings.last_successful_post_at : postedAt;
    wakeSettings = { ...settings, last_successful_post_at: priorSuccessful };
  } catch (caught) {
    const error = caught instanceof PublicationError ? caught
      : new PublicationError(caught instanceof Error && /^(post_text_too_long|message_template_)/.test(caught.message)
        ? 'post_text_too_long' : 'bluesky_api_transient', true);
    await fail(env.MEDIA_DB, publication, error);
    console.error(JSON.stringify({ event: 'bluesky_publication_failed', publication_id: publication.id,
      error_code: error.code }));
  }
  try {
    await scheduleNextBacklogWake(env, wakeSettings);
    message.ack();
  } catch {
    console.error(JSON.stringify({ event: 'bluesky_wakeup_failed', publication_id: publication.id }));
    message.retry({ delaySeconds: 30 });
  }
}
