import { allTopicsPredicate, boundedLimit, HttpError, json, selectedTopicSlugs } from '@uk-aq-media/core';

type PaperRow = {
  id: number;
  canonical_title: string;
  abstract: string | null;
  authors_json: string;
  subjects_json: string;
  countries_json: string;
  canonical_paper_url: string | null;
  open_access_url: string | null;
  first_published_at: string | null;
  sort_at: string;
  topics_json: string;
  publications_json: string;
};

const PAPERS_SELECT = `
  SELECT p.id, p.canonical_title, p.abstract, p.authors_json, p.subjects_json,
    p.countries_json, p.canonical_paper_url, p.open_access_url, p.first_published_at,
    coalesce(p.first_published_at, p.created_at) AS sort_at,
    (SELECT coalesce(json_group_array(json_object('id', t.id, 'slug', t.slug, 'name', t.name)), '[]')
      FROM research_paper_topics pt JOIN topics t ON t.id = pt.topic_id AND t.is_active = 1
      WHERE pt.paper_id = p.id) AS topics_json,
    (SELECT coalesce(json_group_array(json_object(
      'id', v.id, 'version_type', v.version_type, 'doi', v.doi_normalized,
      'publication_url', v.publication_url, 'venue', v.venue, 'publisher', v.publisher,
      'first_online_date', v.first_online_date, 'issue_date', v.issue_date)), '[]')
      FROM research_paper_publications v WHERE v.paper_id = p.id) AS publications_json
    FROM research_papers p`;

function publicPaper(row: PaperRow): Record<string, unknown> {
  const { authors_json, subjects_json, countries_json, publications_json, topics_json,
    sort_at: _sort, ...paper } = row;
  return { ...paper, authors: JSON.parse(authors_json) as unknown,
    subjects: JSON.parse(subjects_json) as unknown,
    countries: JSON.parse(countries_json) as unknown,
    topics: JSON.parse(topics_json) as unknown,
    publications: JSON.parse(publications_json) as unknown };
}

function cursor(raw: string | null): [string, number] | null {
  if (raw === null) return null;
  try {
    if (raw.length > 220) throw new Error();
    const parsed: unknown = JSON.parse(atob(raw));
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/u.test(parsed[0]) ||
      !Number.isSafeInteger(parsed[1]) || parsed[1] < 1) throw new Error();
    return [parsed[0], parsed[1] as number];
  } catch { throw new HttpError(400, 'invalid_before_cursor'); }
}

async function papers(requestUrl: URL, db: D1Database): Promise<Response> {
  for (const param of requestUrl.searchParams.keys()) {
    if (!['limit', 'before', 'topic'].includes(param)) throw new HttpError(400, 'invalid_research_query');
  }
  const topics = selectedTopicSlugs(requestUrl);
  const before = cursor(requestUrl.searchParams.get('before'));
  const limit = boundedLimit(requestUrl);
  const whereTopics = topics.length ? ` AND ${allTopicsPredicate('p','research_paper_topics')}` : '';
  const { results } = await db.prepare(`${PAPERS_SELECT}
    WHERE p.editorial_status = 'approved'
      ${whereTopics}
      ${before ? 'AND (coalesce(p.first_published_at, p.created_at), p.id) < (?, ?)' : ''}
    ORDER BY coalesce(p.first_published_at, p.created_at) DESC, p.id DESC LIMIT ?`)
    .bind(...(topics.length ? [JSON.stringify(topics)] : []), ...(before ?? []), limit + 1)
    .all<PaperRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return json({ papers: page.map(publicPaper), next_before: results.length > limit && last ?
    btoa(JSON.stringify([last.sort_at, last.id])) : null }, 200,
    'public, max-age=300, s-maxage=300, must-revalidate');
}

async function paperDetail(db: D1Database, id: number): Promise<Response> {
  const row = await db.prepare(`${PAPERS_SELECT}
    WHERE p.id = ? AND p.editorial_status = 'approved'`).bind(id).first<PaperRow>();
  if (!row) return json({ error: 'not_found' }, 404);
  const news = await db.prepare(`SELECT a.id, a.title, a.display_title,
    a.canonical_url, a.publisher, a.published_at, link.relationship
    FROM media_article_research_papers link
      JOIN media_articles a ON a.id = link.article_id AND a.status = 'approved'
    WHERE link.paper_id = ? ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT 100`)
    .bind(id).all();
  return json({ paper: publicPaper(row), related_news: news.results }, 200,
    'public, max-age=300, s-maxage=300, must-revalidate');
}

async function articleResearch(db: D1Database, articleId: number): Promise<Response> {
  const article = await db.prepare(`SELECT id FROM media_articles
    WHERE id = ? AND status = 'approved'`).bind(articleId).first();
  if (!article) return json({ error: 'not_found' }, 404);
  const { results } = await db.prepare(`${PAPERS_SELECT}
    JOIN media_article_research_papers link ON link.paper_id = p.id
    WHERE link.article_id = ? AND p.editorial_status = 'approved'
    ORDER BY coalesce(p.first_published_at, p.created_at) DESC, p.id DESC LIMIT 100`)
    .bind(articleId).all<PaperRow>();
  return json({ papers: results.map(publicPaper) }, 200,
    'public, max-age=300, s-maxage=300, must-revalidate');
}

async function topics(db: D1Database): Promise<Response> {
  const { results } = await db.prepare(`SELECT t.id, t.slug, t.name, t.description,
    t.parent_topic_id, t.display_order,
    (SELECT count(*) FROM media_article_topics at
      JOIN media_articles a ON a.id = at.article_id AND a.status = 'approved'
      WHERE at.topic_id = t.id) AS news_count,
    (SELECT count(*) FROM research_paper_topics pt
      JOIN research_papers p ON p.id = pt.paper_id AND p.editorial_status = 'approved'
      WHERE pt.topic_id = t.id) AS research_count
    FROM topics t WHERE t.is_active = 1
    ORDER BY t.display_order, t.name`).all();
  return json({ topics: results }, 200,
    'public, max-age=300, s-maxage=300, must-revalidate');
}

export async function handleResearchPublic(request: Request, url: URL,
  db: D1Database): Promise<Response | null> {
  if (url.pathname === '/topics') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.searchParams.size > 0) throw new HttpError(400, 'invalid_topic_query');
    return topics(db);
  }
  if (url.pathname === '/research/papers') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return papers(url, db);
  }
  const match = /^\/research\/papers\/([1-9]\d*)$/u.exec(url.pathname);
  if (match) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.searchParams.size > 0) throw new HttpError(400, 'invalid_research_query');
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_paper_id');
    return paperDetail(db, id);
  }
  const articleMatch = /^\/articles\/([1-9]\d*)\/research$/u.exec(url.pathname);
  if (articleMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.searchParams.size > 0) throw new HttpError(400, 'invalid_research_query');
    const id = Number(articleMatch[1]);
    if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
    return articleResearch(db, id);
  }
  return null;
}
