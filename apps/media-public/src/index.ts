import { boundedLimit, fetchRemotePreviewImage, guardianRemotePreviewUrl, homepageLatestSixSnapshot, homepageLatestSixState, HttpError, httpFailure, json, reconcileHomepageLatestSix, remotePreviewUrl,
  type PublicArticle } from '@uk-aq-media/core';
import { imageCacheVersion, versionedArticleImageUrl } from './image-cache-version';

type PreviewSelection = {
  id: number;
  source_key: string;
  og_image_url: string | null;
  article_image_policy: string;
  source_image_policy: string;
};
type FeedRow = PublicArticle & PreviewSelection & { feed_sort_at: string; topics_json: string;
  pollutants_json: string; locations_json: string };
type ImageRow = {
  source_key: string;
  og_image_url: string | null;
  canonical_domain: string;
  article_image_policy: string;
  source_image_policy: string;
};

const IMAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
const HOMEPAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const CAWS_SOURCE_KEY = 'communities-against-woodsmoke';
const CAWS_DEFAULT_IMAGE_PATH = '/source-images/communities-against-woodsmoke-default.png';

type HomepageRow = {
  id: number;
  canonical_url: string;
  title: string;
  display_title: string | null;
  publisher: string;
  published_at: string | null;
} & PreviewSelection;

function permittedStoredImageUrl(article: PreviewSelection): string | null {
  return article.article_image_policy === 'remote_preview' &&
    article.source_image_policy === 'remote_preview' ? article.og_image_url : null;
}

export async function publicPreviewImageUrl(origin: string,
  article: PreviewSelection): Promise<string | null> {
  const publisherImageUrl = permittedStoredImageUrl(article);
  if (publisherImageUrl) {
    return versionedArticleImageUrl(origin, article.id, publisherImageUrl);
  }
  if (article.source_key === CAWS_SOURCE_KEY &&
      article.article_image_policy === 'remote_preview' &&
      article.source_image_policy === 'remote_preview') {
    return new URL(CAWS_DEFAULT_IMAGE_PATH, origin).href;
  }
  return null;
}

export function decodeArticleCursor(raw: string | null): [string, number] | null {
  if (!raw) return null;
  try {
    if (raw.length > 200) throw new Error();
    const value: unknown = JSON.parse(atob(raw));
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== 'string' ||
        !(/^\d{4}-\d{2}-\d{2}$/.test(value[0]) ||
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[0])) ||
        typeof value[1] !== 'number' || !Number.isSafeInteger(value[1]) || value[1] < 1) throw new Error();
    return [value[0], value[1]];
  } catch { throw new HttpError(400, 'invalid_before_cursor'); }
}

function homepageGeneration(url: URL): number {
  if (url.searchParams.size !== 1) throw new HttpError(400, 'invalid_homepage_generation');
  const raw = url.searchParams.get('generation');
  if (!raw || !/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'invalid_homepage_generation');
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new HttpError(400, 'invalid_homepage_generation');
  }
  return generation;
}

function staleHomepageGeneration(generation: number): Response {
  return json({ error: 'stale_homepage_generation', generation }, 409, 'no-store');
}

async function homepageRows(db: D1Database): Promise<HomepageRow[]> {
  const { results } = await db.prepare(`SELECT a.id, a.canonical_url, a.title, a.display_title,
      a.publisher, a.published_at, a.source_key, a.og_image_url,
      a.image_policy AS article_image_policy, s.image_policy AS source_image_policy
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.status = 'approved'
    ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT 6`).all<HomepageRow>();
  return results;
}

async function homepageFeedResponse(origin: string, rows: HomepageRow[]): Promise<Response> {
  const articles = await Promise.all(rows.map(async article => ({
    id: article.id,
    canonical_url: article.canonical_url,
    title: article.title,
    display_title: article.display_title,
    publisher: article.publisher,
    published_at: article.published_at,
    preview_image_url: await publicPreviewImageUrl(origin, article),
  })));
  return json({ articles }, 200,
    `public, max-age=${HOMEPAGE_CACHE_TTL_SECONDS}, s-maxage=${HOMEPAGE_CACHE_TTL_SECONDS}, immutable`);
}

function homepageSnapshot(rows: HomepageRow[]): string {
  return homepageLatestSixSnapshot(rows.map(article => ({
    id: article.id,
    canonical_url: article.canonical_url,
    title: article.title,
    display_title: article.display_title,
    publisher: article.publisher,
    published_at: article.published_at,
    // Reconciliation tracks publisher-image state, not a deterministic presentation fallback.
    preview_image_url: permittedStoredImageUrl(article),
  })));
}

async function homepageVersion(env: MediaPublicEnv): Promise<Response> {
  const state = await homepageLatestSixState(env.MEDIA_DB);
  return json({ generation: state.generation }, 200, 'no-store');
}

async function homepageFeed(request: Request, env: MediaPublicEnv,
  context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const requestedGeneration = homepageGeneration(url);
  const cacheKey = new Request(new URL(`/articles/homepage?generation=${requestedGeneration}`, url.origin),
    { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    console.warn(JSON.stringify({ event: 'homepage_latest_six_cache_read_failed' }));
  }

  const initialState = await homepageLatestSixState(env.MEDIA_DB);
  if (initialState.generation !== requestedGeneration) {
    return staleHomepageGeneration(initialState.generation);
  }
  const rows = await homepageRows(env.MEDIA_DB);
  // Do not cache a feed built across a concurrent reconciliation boundary.
  const confirmedState = await homepageLatestSixState(env.MEDIA_DB);
  if (confirmedState.generation !== requestedGeneration) {
    return staleHomepageGeneration(confirmedState.generation);
  }
  if (confirmedState.snapshot_json !== homepageSnapshot(rows)) {
    // A writer may have committed its article mutation just before its follow-up reconciliation.
    // Repair that short state gap rather than caching changed rows under the old generation.
    const reconciledState = await reconcileHomepageLatestSix(env.MEDIA_DB);
    return staleHomepageGeneration(reconciledState.generation);
  }
  const response = await homepageFeedResponse(url.origin, rows);
  context.waitUntil((async () => {
    try { await caches.default.put(cacheKey, response.clone()); }
    catch { console.warn(JSON.stringify({ event: 'homepage_latest_six_cache_write_failed' })); }
  })());
  return response;
}

async function boundedImageBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new HttpError(502, 'image_upstream_missing_body');
  const length = response.headers.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    throw new HttpError(413, 'image_too_large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel('image read complete or rejected'); } catch { /* best effort */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: {
    'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL_SECONDS}`,
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
  } });
}

async function articleImage(request: Request, env: MediaPublicEnv,
  context: ExecutionContext, id: number): Promise<Response> {
  const row = await env.MEDIA_DB.prepare(`SELECT a.source_key, a.og_image_url,
    a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
    s.canonical_domain FROM media_articles a
    JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ? AND a.status = 'approved'`).bind(id).first<ImageRow>();
  if (!row || row.article_image_policy !== 'remote_preview' ||
      row.source_image_policy !== 'remote_preview') throw new HttpError(404, 'image_not_found');
  const publisherUrl = row.source_key === 'the-guardian'
    ? guardianRemotePreviewUrl(row.og_image_url)
    : remotePreviewUrl(row.og_image_url, row);
  if (!publisherUrl || !row.og_image_url) throw new HttpError(404, 'image_not_found');

  const requestUrl = new URL(request.url);
  const expectedVersion = await imageCacheVersion(row.og_image_url);
  const suppliedVersion = requestUrl.searchParams.get('v');
  const canonicalImageUrl = await versionedArticleImageUrl(requestUrl.origin, id,
    row.og_image_url);
  if (suppliedVersion !== null && suppliedVersion !== expectedVersion) {
    return new Response(null, { status: 302, headers: {
      'Cache-Control': 'no-store',
      Location: canonicalImageUrl,
    } });
  }
  const cacheKey = new Request(canonicalImageUrl, { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    console.warn(JSON.stringify({ event: 'article_image_cache_read_failed', article_id: id }));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const imageFetch = await fetchRemotePreviewImage(publisherUrl, row, controller.signal);
    if (!imageFetch.response) {
      throw new HttpError(imageFetch.failure === 'timeout' ? 504 : 502,
        imageFetch.failure === 'timeout' ? 'image_upstream_timeout'
          : imageFetch.failure === 'redirect' ? 'image_upstream_redirect' : 'image_upstream_failed');
    }
    const upstream = imageFetch.response;
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      throw new HttpError(502, 'image_upstream_redirect');
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new HttpError(502, 'image_upstream_failed');
    }
    const contentType = upstream.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!contentType?.startsWith('image/')) {
      await upstream.body?.cancel();
      throw new HttpError(415, 'invalid_image_content_type');
    }
    let bytes: Uint8Array;
    try {
      bytes = await boundedImageBytes(upstream);
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(504, 'image_upstream_timeout');
      throw error;
    }
    const response = imageResponse(bytes, contentType);
    context.waitUntil((async () => {
      try { await caches.default.put(cacheKey, response.clone()); }
      catch {
        console.warn(JSON.stringify({ event: 'article_image_cache_write_failed', article_id: id }));
      }
    })());
    return response;
  } finally { clearTimeout(timeout); }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    try {
      const url = new URL(request.url);
      const imageMatch = /^\/article-images\/([1-9]\d*)$/.exec(url.pathname);
      if (imageMatch) {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(imageMatch[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await articleImage(request, env, context, id);
      }
      if (url.pathname === '/articles/homepage/version') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        if (url.searchParams.size !== 0) throw new HttpError(400, 'invalid_homepage_version_query');
        return await homepageVersion(env);
      }
      if (url.pathname === '/articles/homepage') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await homepageFeed(request, env, context);
      }
      if (url.pathname !== '/articles') return json({ error: 'not_found' }, 404);
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      const before = decodeArticleCursor(url.searchParams.get('before'));
      const statement = env.MEDIA_DB.prepare(`SELECT a.id, a.source_key, a.canonical_url,
        a.title, a.display_title, a.display_title_origin, a.publisher, a.author,
        a.published_at, a.discovered_at, a.feed_sort_at,
        a.summary, a.why_it_matters, a.editorial_content_origin, a.featured,
        a.topics_json, a.pollutants_json, a.locations_json, a.og_image_url,
        a.image_policy AS article_image_policy, s.image_policy AS source_image_policy
        FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
        WHERE a.status = 'approved'
        ${before ? 'AND (a.feed_sort_at, a.id) < (?, ?)' : ''}
        ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT ?`);
      const { results } = await (before ? statement.bind(...before, limit + 1) :
        statement.bind(limit + 1)).all<FeedRow>();
      const page = results.slice(0, limit);
      const last = page.at(-1);
      const articles = await Promise.all(page.map(async ({ feed_sort_at: _sort, topics_json,
        pollutants_json, locations_json, featured, article_image_policy,
        source_image_policy, ...article }) => ({ ...article,
        preview_image_url: await publicPreviewImageUrl(url.origin, {
          ...article, article_image_policy, source_image_policy,
        }),
        featured: featured === 1,
        topics: JSON.parse(topics_json), pollutants: JSON.parse(pollutants_json),
        locations: JSON.parse(locations_json) })));
      return json({ articles, next_before: results.length > limit && last ?
        btoa(JSON.stringify([last.feed_sort_at, last.id])) : null }, 200,
      'public, max-age=300, s-maxage=300, must-revalidate');
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaPublicEnv>;
