import { boundedLimit, HttpError, httpFailure, json, type PublicArticle } from '@uk-aq-media/core';

type FeedRow = PublicArticle & { feed_sort_at: string; topics_json: string;
  pollutants_json: string; locations_json: string };
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

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/articles') return json({ error: 'not_found' }, 404);
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      const before = cursor(url.searchParams.get('before'));
      const statement = env.MEDIA_DB.prepare(`SELECT a.id, a.source_key, a.canonical_url,
        a.title, a.publisher, a.author, a.published_at, a.discovered_at, a.feed_sort_at,
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
        locations_json, featured, ...article }) => ({ ...article, featured: featured === 1,
        topics: JSON.parse(topics_json), pollutants: JSON.parse(pollutants_json),
        locations: JSON.parse(locations_json) }));
      return json({ articles, next_before: results.length > limit && last ?
        btoa(JSON.stringify([last.feed_sort_at, last.id])) : null }, 200,
      'public, max-age=300, s-maxage=300, must-revalidate');
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaPublicEnv>;
