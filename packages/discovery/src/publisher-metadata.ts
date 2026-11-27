import { HttpError, loadSource, normaliseArticleAuthorForStorage,
  requirePublisherDomainAllowed, type DiscoveredArticle, type Source } from '@uk-aq-media/core';
import { fetchArticleHeadMetadata, normaliseMetadataText, publisherPublicationDate } from './article-head-metadata';
import type { PublisherArticleMetadataTarget } from './article-metadata-fetch';
import { configuredPublisherRssRouteKeys, discoverPublisherRss } from './publisher-rss';
import { ScanError } from './rss';
import { fetchFamiliesForCleanAirPublishedDate } from './families-for-clean-air-date';

type Publisher = Pick<Source, 'source_key' | 'canonical_domain' | 'name'>;

export function hostnamePublisherLabel(label: string): boolean {
  return /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(label.trim());
}

export function verifiedPublisherName(source: Publisher, nativeName?: string | null): string | null {
  const configured = normaliseMetadataText(source.name).slice(0, 200);
  const dynamic = /^(?:discovered-publisher-|manual-)/.test(source.source_key);
  if (configured && (!dynamic || !hostnamePublisherLabel(configured))) return configured;
  const native = nativeName && normaliseMetadataText(nativeName).slice(0, 200);
  return native && !hostnamePublisherLabel(native) ? native : null;
}

export function normalisePublisherHeadline(title: string, publisher: string | null,
  explicitHeadline?: string | null): string {
  const headline = normaliseMetadataText(title);
  if (!publisher || explicitHeadline === headline || !headline.endsWith(publisher)) return headline;
  const prefix = headline.slice(0, -publisher.length);
  const separator = /(?: +[-–—] +| *\| *|: +)$/.exec(prefix);
  if (!separator) return headline;
  const remaining = prefix.slice(0, separator.index).trimEnd();
  return remaining && !/[|:–—]$/.test(remaining) ? remaining : headline;
}

export function verifiedPublisherHeadline(title: string, publisher: string | null,
  explicitHeadline?: string | null): string {
  const headline = normaliseMetadataText(title);
  const explicit = explicitHeadline && normaliseMetadataText(explicitHeadline);
  if (!explicit) return headline;
  const normalised = normalisePublisherHeadline(headline, publisher, explicit);
  return explicit === headline || explicit === normalised ? normalised : headline;
}

export function permitsPublisherHtml(source: Pick<Source, 'source_key' | 'image_policy'>): boolean {
  return source.image_policy === 'remote_preview' &&
    !['the-guardian', 'openaq', 'global-action-plan'].includes(source.source_key);
}

export async function resolvePublisherHeadMetadata(article: string | PublisherArticleMetadataTarget,
  source: Publisher & Pick<Source, 'image_policy'>,
  requireAllowedUrl: (url: string) => Promise<void>,
  existing?: { title: string; author: string | null; published_at: string | null;
    image_url: string | null; display_title?: string | null; fresh?: boolean }) {
  const metadata = await fetchArticleHeadMetadata(article, source, requireAllowedUrl, {
    enabled: true, needAuthor: !existing?.author, needDate: !existing?.published_at,
    needImage: !existing?.image_url, needHeadline: !existing || Boolean(existing.fresh),
    expectedTitle: existing?.title,
  });
  const publisher = verifiedPublisherName(source, metadata.publisher);
  const explicitHeadline = metadata.explicitHeadline;
  const acquired = existing?.title || explicitHeadline || metadata.ogTitle ||
    metadata.twitterTitle || metadata.htmlTitle;
  const headline = acquired && verifiedPublisherHeadline(acquired, publisher, explicitHeadline);
  const compact = existing?.display_title ? null : [metadata.ogTitle, metadata.twitterTitle]
    .find(candidate => candidate && headline && candidate.length >= 5 &&
      candidate.length < headline.length && normalisePublisherHeadline(candidate, publisher) === candidate &&
      candidate.toLocaleLowerCase('en-GB') !== headline.toLocaleLowerCase('en-GB')) ?? null;
  const author = metadata.author?.slice(0, 500);
  const technicalByline = source.source_key === 'healthy-air-coalition' &&
    author?.toLowerCase() === 'hacadmin';
  return {
    publisher, title: headline, explicit_headline: explicitHeadline,
    compact_title: compact,
    author: technicalByline ? null : normaliseArticleAuthorForStorage(author, publisher ?? source.name),
    published_at: publisherPublicationDate(metadata.publishedAt),
    image_url: metadata.previewUrl, image_error: metadata.previewError,
    checked_at: metadata.checkedAt, partial_failure: metadata.partialFailure,
    recovered: metadata.recovered,
  };
}

export function publisherMetadataFailure(error: unknown): 'disallowed' | 'unavailable' | 'transient' {
  const code = error instanceof Error ? error.message : '';
  if (/(?:not_permitted|publisher_domain_blocked|_http_(?:401|403|451)\b)/.test(code)) return 'disallowed';
  if (/article_head_(?:timeout|fetch_failed|read_failed|missing_body|incomplete|http_(?:408|425|429|5\d\d))$/
    .test(code)) return 'transient';
  return code.startsWith('article_head_') || code === 'metadata_rss_article_not_found'
    ? 'unavailable' : 'transient';
}

export type PublisherMetadata = {
  publisher: string | null;
  title: string | null;
  compact_title: string | null;
  author: string | null;
  published_at: string | null;
  image_url: string | null;
  image_error: string | null;
  checked_at: string;
  explicit_headline?: string | null;
  partial_failure?: boolean;
};

export function publisherRssMetadata(canonicalUrl: string, publisher: string,
  articles: ReadonlyArray<Pick<DiscoveredArticle,
    'canonical_url' | 'title' | 'author' | 'published_at' | 'preview_url'>>,
  checkedAt: string): PublisherMetadata | null {
  const item = articles.find(article => article.canonical_url === canonicalUrl);
  if (!item) return null;
  return {
    publisher, title: normaliseMetadataText(item.title),
    explicit_headline: normaliseMetadataText(item.title), compact_title: null,
    author: normaliseArticleAuthorForStorage(item.author, publisher),
    published_at: publisherPublicationDate(item.published_at), image_url: item.preview_url,
    image_error: item.preview_url ? null : 'preview_image_metadata_missing',
    checked_at: checkedAt,
  };
}

export async function resolvePublisherMetadata(db: D1Database, articleId: number | null,
  article: PublisherArticleMetadataTarget, source: Publisher & Pick<Source, 'image_policy'>,
  existing?: Parameters<typeof resolvePublisherHeadMetadata>[3],
  observeAllowedUrl?: (url: string) => void): Promise<PublisherMetadata> {
  const { canonical_url: canonicalUrl } = article;
  const allow = async (url: string) => {
    await requirePublisherDomainAllowed(db, url);
    observeAllowedUrl?.(url);
  };
  const rss = async (routes: string[], key: string): Promise<PublisherMetadata | null> => {
    const configured = await loadSource(db, key);
    if (!configured?.enabled || configured.image_policy !== 'remote_preview' ||
        source.image_policy !== 'remote_preview') return null;
    const matches: PublisherMetadata[] = [];
    let failed = false;
    for (const route of routes) {
      try {
        const { articles } = await discoverPublisherRss(configured, route, async (input, init) => {
          await allow(String(input));
          return fetch(input, init);
        });
        const metadata = publisherRssMetadata(canonicalUrl, source.name, articles, new Date().toISOString());
        if (!metadata) continue;
        matches.push(metadata);
        if ((existing?.image_url || metadata.image_url) && (existing?.author || metadata.author) &&
            (existing?.published_at || metadata.published_at)) break;
      } catch (error) {
        if (error instanceof HttpError && error.message.startsWith('publisher_domain_blocked:')) throw error;
        failed = true;
      }
    }
    const first = matches[0];
    if (!first && failed) throw new ScanError('metadata_rss_unavailable');
    if (!first) return null;
    const image = matches.find(item => item.image_url)?.image_url ?? null;
    const agree = (field: 'author' | 'published_at') => {
      const values = [...new Set(matches.map(item => item[field]).filter(Boolean))];
      return values.length === 1 ? values[0] ?? null : null;
    };
    return { ...first, author: agree('author'), published_at: agree('published_at'),
      image_url: image, image_error: image ? null : first.image_error, partial_failure: failed };
  };

  await allow(canonicalUrl);
  if (source.source_key === 'openaq') {
    const result = await rss(['openaq-medium'], 'openaq');
    if (!result) throw new HttpError(409, 'metadata_rss_article_not_found');
    return result;
  }
  if (!permitsPublisherHtml(source)) throw new ScanError('article_head_not_permitted');
  try {
    const { recovered, ...metadata } = await resolvePublisherHeadMetadata(article, source, allow, existing);
    if (!recovered && source.source_key === 'families-for-clean-air' && !metadata.published_at &&
        !existing?.published_at && (existing?.title || metadata.title) &&
        !new URL(canonicalUrl).pathname.startsWith('/news/')) {
      // Legacy root permalinks have a separate verified publisher date route.
      // Current /news articles use that same narrow extractor on the first response.
      try {
        metadata.published_at = await fetchFamiliesForCleanAirPublishedDate({
          canonical_url: canonicalUrl, title: existing?.title || metadata.title!,
        }, source, allow);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        metadata.partial_failure = true;
      }
    }
    return metadata;
  } catch (error) {
    if (source.source_key !== 'sky-news' || !(error instanceof ScanError) ||
        error.code !== 'article_head_http_403') throw error;
    const configured = await loadSource(db, 'sky-news');
    if (!configured?.enabled) throw error;
    const routes = configuredPublisherRssRouteKeys(configured);
    const observed = articleId === null ? [] : (await db.prepare(`SELECT route_key
      FROM media_article_discovery_evidence WHERE article_id = ? AND source_key = 'sky-news'
        AND provider_key = 'publisher_rss' ORDER BY last_seen_at DESC LIMIT 4`)
      .bind(articleId).all<{ route_key: string }>()).results.map(row => row.route_key);
    const preferred = [...new Set(observed.filter(route => routes.includes(route)))];
    const result = await rss((preferred.length ? preferred : routes).slice(0, 4), 'sky-news');
    if (!result) throw error;
    return result;
  }
}
