import {
  BLUESKY_HANDLE, BLUESKY_THUMBNAIL_BYTES, deterministicTid, fetchRemotePreviewImage,
  isBlueskyWakeup, remotePreviewUrl, renderBlueskyPost, type BlueskyWakeup,
} from '@uk-aq-media/core';

type Settings = { publishing_enabled: number; activation_event_id: number | null;
  cooldown_seconds: number; default_message_template: string; last_successful_post_at: string | null };
type Publication = { id: number; article_id: number; publication_key: string; status: string;
  attempt_count: number; record_key: string | null; created_at: string };
type Article = { canonical_url: string; title: string; display_title: string | null;
  publisher: string; og_image_url: string | null; image_policy: string; source_key: string;
  canonical_domain: string; source_image_policy: string; social_handle: string | null;
  social_did: string | null };

const XRPC = 'https://bsky.social/xrpc/';
const MAX_ATTEMPTS = 5;
const XRPC_TIMEOUT_MS = 15_000;
const MAX_QUEUE_DELAY_SECONDS = 43_200;

class PublicationError extends Error {
  constructor(readonly code: string, readonly transient = false) { super(code); }
}

async function xrpc(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), XRPC_TIMEOUT_MS);
  try { return await fetch(`${XRPC}${path}`, { ...init, signal: controller.signal }); }
  catch { throw new PublicationError('bluesky_api_transient', true); }
  finally { clearTimeout(timeout); }
}

async function authenticate(password: string): Promise<{ accessJwt: string; did: string }> {
  const response = await xrpc('com.atproto.server.createSession', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_HANDLE, password }) });
  if (!response.ok) throw new PublicationError(response.status >= 500
    ? 'bluesky_api_transient' : 'bluesky_auth_failed', response.status >= 500);
  const body = await response.json() as { accessJwt?: unknown; did?: unknown; handle?: unknown };
  if (typeof body.accessJwt !== 'string' || typeof body.did !== 'string' ||
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
  const fetched = await fetchRemotePreviewImage(article.og_image_url, article, controller.signal);
  clearTimeout(timeout);
  if (!fetched.response || fetched.failure || !fetched.response.ok) {
    await fetched.response?.body?.cancel();
    throw new PublicationError('thumbnail_fetch_failed', fetched.failure !== 'redirect');
  }
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
  const bytes = await fetched.response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > BLUESKY_THUMBNAIL_BYTES) {
    throw new PublicationError(bytes.byteLength ? 'thumbnail_too_large' : 'thumbnail_invalid');
  }
  return { bytes, type };
}

async function uploadBlob(auth: { accessJwt: string }, thumbnail: { bytes: ArrayBuffer; type: string }) {
  const response = await xrpc('com.atproto.repo.uploadBlob', { method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessJwt}`, 'Content-Type': thumbnail.type },
    body: thumbnail.bytes });
  if (!response.ok) throw new PublicationError(response.status >= 500 || response.status === 429
    ? 'bluesky_api_transient' : 'bluesky_post_rejected', response.status >= 500 || response.status === 429);
  const body = await response.json() as { blob?: unknown };
  if (!body.blob) throw new PublicationError('bluesky_post_rejected');
  return body.blob;
}

async function createOrReadPost(auth: { accessJwt: string; did: string }, rkey: string,
  record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
  const response = await xrpc('com.atproto.repo.createRecord', { method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: auth.did, collection: 'app.bsky.feed.post', rkey, record }) });
  if (response.ok) return response.json() as Promise<{ uri: string; cid: string }>;
  if (response.status >= 500 || response.status === 429) {
    throw new PublicationError('bluesky_api_transient', true);
  }
  // A retry after the remote write/D1 crash window receives an existing-record
  // conflict. Read that exact deterministic record before declaring success.
  if (response.status === 400 || response.status === 409) {
    const query = new URLSearchParams({ repo: auth.did, collection: 'app.bsky.feed.post', rkey });
    const existing = await xrpc(`com.atproto.repo.getRecord?${query}`, {
      headers: { Authorization: `Bearer ${auth.accessJwt}` },
    });
    if (existing.ok) return existing.json() as Promise<{ uri: string; cid: string }>;
    if (existing.status === 429 || existing.status >= 500) {
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

async function scheduleNextBacklogWake(env: MediaDiscoveryEnv, settings: Settings): Promise<boolean> {
  const next = await env.MEDIA_DB.prepare(`SELECT next_attempt_at
    FROM media_bluesky_publications WHERE status = 'queued'
    ORDER BY CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END, next_attempt_at, id LIMIT 1`)
    .first<{ next_attempt_at: string | null }>();
  if (!next) return false;
  const now = Date.now();
  const retryAt = next.next_attempt_at ? Date.parse(next.next_attempt_at) : now;
  const cooldownAt = settings.last_successful_post_at
    ? Date.parse(settings.last_successful_post_at) + settings.cooldown_seconds * 1000 : now;
  const delaySeconds = Math.max(0, Math.ceil((Math.max(retryAt, cooldownAt) - now) / 1000));
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
  // Recover claims older than ten minutes, then atomically claim the oldest row.
  await env.MEDIA_DB.prepare(`UPDATE media_bluesky_publications SET status = 'queued',
    last_error_code = 'publication_state_conflict', next_attempt_at = NULL, updated_at = ?
    WHERE status = 'posting' AND last_attempted_at < ?`).bind(new Date(now).toISOString(),
      new Date(now - 600_000).toISOString()).run();
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
    WHERE id = ? AND status = 'queued'`).bind(recordKey, new Date(now).toISOString(),
      new Date(now).toISOString(), publication.id).run();
  if (!claimed.meta.changes) { message.retry({ delaySeconds: 5 }); return; }
  try {
    const article = await env.MEDIA_DB.prepare(`SELECT a.canonical_url, a.title, a.display_title,
      a.publisher, a.og_image_url, a.image_policy, a.source_key, s.canonical_domain,
      s.image_policy AS source_image_policy, social.handle AS social_handle,
      social.account_did AS social_did FROM media_articles a
      JOIN media_sources s ON s.source_key = a.source_key
      LEFT JOIN media_source_social_accounts social ON social.source_key = a.source_key
        AND social.platform = 'bluesky' AND social.mention_enabled = 1
      WHERE a.id = ?`).bind(publication.article_id).first<Article>();
    if (!article) throw new PublicationError('publication_state_conflict');
    const thumbnail = await loadThumbnail(article);
    const auth = await authenticate(env.UK_AQ_MEDIA_BLUESKY_APP_PSWD);
    const blob = await uploadBlob(auth, thumbnail);
    const rendered = renderBlueskyPost({ title: article.display_title ?? article.title,
      publisher: article.publisher, template: settings.default_message_template,
      publisherMention: article.social_handle && article.social_did
        ? { handle: article.social_handle, did: article.social_did } : null });
    const result = await createOrReadPost(auth, recordKey, {
      $type: 'app.bsky.feed.post', text: rendered.text, facets: rendered.facets,
      createdAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.external', external: {
        uri: article.canonical_url, title: article.display_title ?? article.title,
        description: `From ${article.publisher}`, thumb: blob,
      } },
    });
    const postedAt = new Date().toISOString();
    await env.MEDIA_DB.batch([
      env.MEDIA_DB.prepare(`UPDATE media_bluesky_publications SET status = 'posted',
        attempt_count = attempt_count + 1, post_uri = ?, post_cid = ?, last_error_code = NULL,
        next_attempt_at = NULL, posted_at = ?, updated_at = ?
        WHERE id = ? AND status = 'posting'`)
        .bind(result.uri, result.cid, postedAt, postedAt, publication.id),
      env.MEDIA_DB.prepare(`UPDATE media_bluesky_settings SET last_successful_post_at = ?,
        updated_at = ? WHERE id = 1`).bind(postedAt, postedAt),
    ]);
    await scheduleNextBacklogWake(env, { ...settings, last_successful_post_at: postedAt });
    message.ack();
  } catch (caught) {
    const error = caught instanceof PublicationError ? caught
      : new PublicationError(caught instanceof Error && /^(post_text_too_long|message_template_)/.test(caught.message)
        ? 'post_text_too_long' : 'bluesky_api_transient', true);
    await fail(env.MEDIA_DB, publication, error);
    console.error(JSON.stringify({ event: 'bluesky_publication_failed', publication_id: publication.id,
      error_code: error.code }));
    await scheduleNextBacklogWake(env, settings);
    message.ack();
  }
}
