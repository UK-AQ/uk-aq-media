import { HttpError } from './http';

export const TOPIC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Case-insensitive identity; the original DOI/publisher URL remains on the publication. */
export function normaliseDoi(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  let doi = value.trim();
  if (/^https?:\/\//i.test(doi)) {
    let url: URL;
    try { url = new URL(doi); }
    catch { throw new HttpError(400, 'invalid_doi'); }
    if (!['doi.org', 'dx.doi.org'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port) throw new HttpError(400, 'invalid_doi');
    doi = url.pathname.replace(/^\//, '');
  } else {
    doi = doi.replace(/^doi:\s*/i, '');
  }
  try { doi = decodeURIComponent(doi); }
  catch { throw new HttpError(400, 'invalid_doi'); }
  doi = doi.trim().toLowerCase();
  if (doi.length > 255 || !/^10\.\d{4,9}\/\S+$/u.test(doi)) {
    throw new HttpError(400, 'invalid_doi');
  }
  return doi;
}

/** Repeated ?topic= slugs use AND semantics, shared by News and Research. */
export function selectedTopicSlugs(url: URL): string[] {
  const values = url.searchParams.getAll('topic');
  if (values.length > 10 || values.some(value => !TOPIC_SLUG_RE.test(value) ||
    value.length > 100 || value !== value.toLowerCase()) ||
    new Set(values).size !== values.length) throw new HttpError(400, 'invalid_topic_filter');
  return values;
}

/** Only static, server-owned identifiers may be supplied for SQL interpolation. */
export function allTopicsPredicate(entity: 'a' | 'p',
  relation: 'media_article_topics' | 'research_paper_topics'): string {
  const key = entity === 'a' ? 'article_id' : 'paper_id';
  return `NOT EXISTS (SELECT 1 FROM json_each(?) requested
    WHERE NOT EXISTS (SELECT 1 FROM ${relation} link
      JOIN topics topic ON topic.id = link.topic_id AND topic.is_active = 1
      WHERE link.${key} = ${entity}.id AND
        (topic.slug = requested.value OR EXISTS (
          SELECT 1 FROM topic_slug_aliases alias
          WHERE alias.topic_id = topic.id AND alias.slug = requested.value))))`;
}
