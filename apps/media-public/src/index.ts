import { boundedLimit, fetchRemotePreviewImage, guardianRemotePreviewUrl, homepageLatestSixSnapshot, homepageLatestSixState, HttpError, httpFailure, json, meaningfulSearchTerms, MAX_SEARCH_QUERY_CHARACTERS, reconcileHomepageLatestSix, remotePreviewUrl, sourcePresentationPlaceholderPath,
  type PublicArticle } from '@uk-aq-media/core';
import { imageCacheVersion, versionedArticleImageUrl } from './image-cache-version';

type PreviewSelection = {
  id: number;
  source_key: string;
  og_image_url: string | null;
  article_image_policy: string;
  source_image_policy: string;
  local_image_source_url?: string | null;
  local_image_content_sha256?: string | null;
};
type FeedRow = PublicArticle & PreviewSelection & { feed_sort_at: string; topics_json: string;
  pollutants_json: string; locations_json: string };
type ImageRow = {
  source_key: string;
  og_image_url: string | null;
  canonical_domain: string;
  article_image_policy: string;
  source_image_policy: string;
  local_image_object_key: string | null;
  local_image_source_url: string | null;
  local_image_content_sha256: string | null;
  local_image_content_type: string | null;
  local_image_byte_size: number | null;
};
const SEARCH_FIELDS = ['title', 'publication', 'author', 'content'] as const;
type SearchField = typeof SEARCH_FIELDS[number];

const IMAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
const HOMEPAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;

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

function currentLocalImageVersion(article: Pick<PreviewSelection, 'og_image_url' |
  'article_image_policy' | 'source_image_policy' | 'local_image_source_url' |
  'local_image_content_sha256'>): string | null {
  return article.article_image_policy === 'local_copy_permitted' &&
    article.source_image_policy === 'local_copy_permitted' &&
    article.og_image_url !== null && article.local_image_source_url === article.og_image_url &&
    article.local_image_content_sha256
    ? article.local_image_content_sha256.slice(0, 32) : null;
}

export async function publicPreviewImageUrl(origin: string,
  article: PreviewSelection): Promise<string | null> {
  const publisherImageUrl = permittedStoredImageUrl(article);
  if (publisherImageUrl) {
    return versionedArticleImageUrl(origin, article.id, publisherImageUrl);
  }
  const localVersion = currentLocalImageVersion(article);
  if (localVersion) {
    const url = new URL(`/article-images/${article.id}`, origin);
    url.searchParams.set('v', localVersion);
    return url.href;
  }
  const placeholderPath = sourcePresentationPlaceholderPath(article);
  return placeholderPath ? new URL(placeholderPath, origin).href : null;
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

function searchRequest(url: URL): { terms: string[]; fields: SearchField[] } {
  for (const key of url.searchParams.keys()) {
    if (!['q', 'fields', 'limit', 'before'].includes(key)) throw new HttpError(400, 'invalid_search_query');
  }
  if (url.searchParams.getAll('q').length !== 1) throw new HttpError(400, 'invalid_search_query');
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (!query || [...query].length > MAX_SEARCH_QUERY_CHARACTERS) {
    throw new HttpError(400, 'invalid_search_query');
  }
  const rawFields = url.searchParams.get('fields');
  if (url.searchParams.getAll('fields').length > 1) throw new HttpError(400, 'invalid_search_fields');
  const fields = rawFields === null ? [...SEARCH_FIELDS] : rawFields.split(',') as SearchField[];
  if (!fields.length || fields.some(field => !SEARCH_FIELDS.includes(field)) ||
      new Set(fields).size !== fields.length || fields.some(field => field.trim() !== field)) {
    throw new HttpError(400, 'invalid_search_fields');
  }
  return { terms: meaningfulSearchTerms(query), fields };
}

async function publicArticles(origin: string, rows: FeedRow[]): Promise<unknown[]> {
  return Promise.all(rows.map(async ({ feed_sort_at: _sort, topics_json,
    pollutants_json, locations_json, featured, article_image_policy,
    source_image_policy, local_image_source_url, local_image_content_sha256,
    ...article }) => ({ ...article,
    preview_image_url: await publicPreviewImageUrl(origin, {
      ...article, article_image_policy, source_image_policy,
      local_image_source_url, local_image_content_sha256,
    }),
    featured: featured === 1,
    topics: JSON.parse(topics_json), pollutants: JSON.parse(pollutants_json),
    locations: JSON.parse(locations_json) })));
}

async function articleSearch(url: URL, env: MediaPublicEnv): Promise<Response> {
  const { terms, fields } = searchRequest(url);
  const limit = boundedLimit(url);
  const before = decodeArticleCursor(url.searchParams.get('before'));
  if (terms.length === 0) return json({ articles: [], next_before: null }, 200, 'no-store');
  const selected = new Set(fields);
  const clauses = [
    selected.has('title') ? "instr(lower(a.title), term.value) > 0 OR instr(lower(coalesce(a.display_title, '')), term.value) > 0" : '',
    selected.has('publication') ? 'instr(lower(a.publisher), term.value) > 0' : '',
    selected.has('author') ? "instr(lower(coalesce(a.author, '')), term.value) > 0" : '',
    selected.has('content') ? `s.search_index_policy = 'feed_body_text' AND EXISTS (
      SELECT 1 FROM media_article_search_terms st WHERE st.article_id = a.id
        AND st.source_key = a.source_key AND st.term = term.value)` : '',
  ].filter(Boolean).join(' OR ');
  const statement = env.MEDIA_DB.prepare(`SELECT a.id, a.source_key, a.canonical_url,
    a.title, a.display_title, a.display_title_origin, a.publisher, a.author,
    a.published_at, a.discovered_at, a.feed_sort_at,
    a.summary, a.why_it_matters, a.editorial_content_origin, a.featured,
    a.topics_json, a.pollutants_json, a.locations_json, a.og_image_url,
    a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
    li.source_image_url AS local_image_source_url,
    li.content_sha256 AS local_image_content_sha256
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    LEFT JOIN media_article_local_images li ON li.article_id = a.id
    WHERE a.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM json_each(?) term WHERE NOT (${clauses}))
      ${before ? 'AND (a.feed_sort_at, a.id) < (?, ?)' : ''}
    ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT ?`);
  const bindings = [JSON.stringify(terms), ...(before ?? []), limit + 1];
  const { results } = await statement.bind(...bindings).all<FeedRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return json({ articles: await publicArticles(url.origin, page),
    next_before: results.length > limit && last
      ? btoa(JSON.stringify([last.feed_sort_at, last.id])) : null }, 200, 'no-store');
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
      a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
      li.source_image_url AS local_image_source_url,
      li.content_sha256 AS local_image_content_sha256
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    LEFT JOIN media_article_local_images li ON li.article_id = a.id
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
    preview_image_url: permittedStoredImageUrl(article) ??
      (currentLocalImageVersion(article) ? `local:${article.local_image_content_sha256}` : null),
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
    s.canonical_domain, li.object_key AS local_image_object_key,
    li.source_image_url AS local_image_source_url,
    li.content_sha256 AS local_image_content_sha256,
    li.content_type AS local_image_content_type, li.byte_size AS local_image_byte_size
    FROM media_articles a
    JOIN media_sources s ON s.source_key = a.source_key
    LEFT JOIN media_article_local_images li ON li.article_id = a.id
    WHERE a.id = ? AND a.status = 'approved'`).bind(id).first<ImageRow>();
  if (!row) throw new HttpError(404, 'image_not_found');
  const requestUrl = new URL(request.url);
  const localVersion = currentLocalImageVersion(row);
  if (localVersion) {
    if (!row.local_image_object_key || !row.local_image_content_type) {
      throw new HttpError(404, 'image_not_found');
    }
    const canonicalImageUrl = new URL(`/article-images/${id}`, requestUrl.origin);
    canonicalImageUrl.searchParams.set('v', localVersion);
    const suppliedVersion = requestUrl.searchParams.get('v');
    if (suppliedVersion !== localVersion) {
      return new Response(null, { status: 302, headers: {
        'Cache-Control': 'no-store', Location: canonicalImageUrl.href,
      } });
    }
    const object = await env.MEDIA_IMAGES.get(row.local_image_object_key);
    if (!object) throw new HttpError(404, 'image_not_found');
    return new Response(object.body, { status: 200, headers: {
      'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL_SECONDS}, immutable`,
      'Content-Type': row.local_image_content_type,
      'Content-Length': String(row.local_image_byte_size ?? object.size),
      'X-Content-Type-Options': 'nosniff',
    } });
  }
  if (row.article_image_policy !== 'remote_preview' ||
      row.source_image_policy !== 'remote_preview') throw new HttpError(404, 'image_not_found');
  const publisherUrl = row.source_key === 'the-guardian'
    ? guardianRemotePreviewUrl(row.og_image_url)
    : remotePreviewUrl(row.og_image_url, row);
  if (!publisherUrl || !row.og_image_url) throw new HttpError(404, 'image_not_found');

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
      if (url.pathname === '/articles/search') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await articleSearch(url, env);
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
        a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
        li.source_image_url AS local_image_source_url,
        li.content_sha256 AS local_image_content_sha256
        FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
        LEFT JOIN media_article_local_images li ON li.article_id = a.id
        WHERE a.status = 'approved'
        ${before ? 'AND (a.feed_sort_at, a.id) < (?, ?)' : ''}
        ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT ?`);
      const { results } = await (before ? statement.bind(...before, limit + 1) :
        statement.bind(limit + 1)).all<FeedRow>();
      const page = results.slice(0, limit);
      const last = page.at(-1);
      const articles = await publicArticles(url.origin, page);
      return json({ articles, next_before: results.length > limit && last ?
        btoa(JSON.stringify([last.feed_sort_at, last.id])) : null }, 200,
      'public, max-age=300, s-maxage=300, must-revalidate');
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaPublicEnv>;
