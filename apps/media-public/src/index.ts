import { boundedLimit, HttpError, httpFailure, json, remotePreviewUrl,
  type PublicArticle } from '@uk-aq-media/core';

type FeedRow = PublicArticle & { feed_sort_at: string; topics_json: string;
  pollutants_json: string; locations_json: string };
type ImageRow = {
  og_image_url: string | null;
  canonical_domain: string;
  article_image_policy: string;
  source_image_policy: string;
};

const IMAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;

function cursor(raw: string | null): [string, number] | null {
  if (!raw) return null;
  try {
    if (raw.length > 200) throw new Error();
    const value: unknown = JSON.parse(atob(raw));
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[0]) ||
        typeof value[1] !== 'number' || !Number.isSafeInteger(value[1]) || value[1] < 1) throw new Error();
    return [value[0], value[1]];
  } catch { throw new HttpError(400, 'invalid_before_cursor'); }
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
  const row = await env.MEDIA_DB.prepare(`SELECT a.og_image_url,
    a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
    s.canonical_domain FROM media_articles a
    JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ? AND a.status = 'approved'`).bind(id).first<ImageRow>();
  if (!row || row.article_image_policy !== 'remote_preview' ||
      row.source_image_policy !== 'remote_preview') throw new HttpError(404, 'image_not_found');
  const publisherUrl = remotePreviewUrl(row.og_image_url, row.canonical_domain);
  if (!publisherUrl) throw new HttpError(404, 'image_not_found');

  const requestUrl = new URL(request.url);
  requestUrl.search = '';
  const cacheKey = new Request(requestUrl.href, { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    console.warn(JSON.stringify({ event: 'article_image_cache_read_failed', article_id: id }));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let upstream: Response;
    try {
      upstream = await fetch(publisherUrl, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'image/*',
          'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
        },
      });
    } catch {
      throw new HttpError(controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? 'image_upstream_timeout' : 'image_upstream_failed');
    }
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
      if (url.pathname !== '/articles') return json({ error: 'not_found' }, 404);
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      const before = cursor(url.searchParams.get('before'));
      const statement = env.MEDIA_DB.prepare(`SELECT a.id, a.source_key, a.canonical_url,
        a.title, a.display_title, a.display_title_origin, a.publisher, a.author,
        a.published_at, a.discovered_at, a.feed_sort_at,
        a.summary, a.why_it_matters, a.editorial_content_origin, a.featured,
        a.topics_json, a.pollutants_json, a.locations_json,
        CASE WHEN a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview'
          THEN a.og_image_url ELSE NULL END AS og_image_url
        FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
        WHERE a.status = 'approved'
        ${before ? 'AND (a.feed_sort_at, a.id) < (?, ?)' : ''}
        ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT ?`);
      const { results } = await (before ? statement.bind(...before, limit + 1) :
        statement.bind(limit + 1)).all<FeedRow>();
      const page = results.slice(0, limit);
      const last = page.at(-1);
      const articles = page.map(({ feed_sort_at: _sort, topics_json, pollutants_json,
        locations_json, featured, ...article }) => ({ ...article,
        preview_image_url: article.og_image_url
          ? new URL(`/article-images/${article.id}`, url.origin).href : null,
        featured: featured === 1,
        topics: JSON.parse(topics_json), pollutants: JSON.parse(pollutants_json),
        locations: JSON.parse(locations_json) }));
      return json({ articles, next_before: results.length > limit && last ?
        btoa(JSON.stringify([last.feed_sort_at, last.id])) : null }, 200,
      'public, max-age=300, s-maxage=300, must-revalidate');
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaPublicEnv>;
