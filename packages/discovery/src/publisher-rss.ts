import {
  canonicalizeUrl, canonicalUrlHash, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import {
  MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES, parseRssItems, readRssFeed, ScanError,
} from './rss';

// Bioengineer.org and Scienmag are intentionally absent from this allow-list; migration 0046
// retires their former sources and blocks both publisher domains from News admission.
export const PUBLISHER_RSS_ROUTES = [
  { source_key: 'bbc-news', route_key: 'bbc-news-top',
    url: 'https://feeds.bbci.co.uk/news/rss.xml', canonical_domain: 'bbc.co.uk', max_items: 20 },
  { source_key: 'bbc-news', route_key: 'bbc-news-science-environment',
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    canonical_domain: 'bbc.co.uk', max_items: 20 },
  { source_key: 'bbc-news', route_key: 'bbc-news-uk',
    url: 'https://feeds.bbci.co.uk/news/uk/rss.xml', canonical_domain: 'bbc.co.uk', max_items: 20 },
  { source_key: 'bbc-news', route_key: 'bbc-news-health',
    url: 'https://feeds.bbci.co.uk/news/health/rss.xml', canonical_domain: 'bbc.co.uk', max_items: 20 },
  { source_key: 'sky-news', route_key: 'sky-news-home',
    url: 'https://feeds.skynews.com/feeds/rss/home.xml', canonical_domain: 'news.sky.com', max_items: 10 },
  { source_key: 'sky-news', route_key: 'sky-news-uk',
    url: 'https://feeds.skynews.com/feeds/rss/uk.xml', canonical_domain: 'news.sky.com', max_items: 10 },
  { source_key: 'sky-news', route_key: 'sky-news-world',
    url: 'https://feeds.skynews.com/feeds/rss/world.xml', canonical_domain: 'news.sky.com', max_items: 10 },
  { source_key: 'sky-news', route_key: 'sky-news-technology',
    url: 'https://feeds.skynews.com/feeds/rss/technology.xml', canonical_domain: 'news.sky.com', max_items: 10 },
  { source_key: 'the-independent', route_key: 'independent-home',
    url: 'https://www.the-independent.com/rss', canonical_domain: 'the-independent.com', max_items: 20 },
  { source_key: 'the-independent', route_key: 'independent-uk',
    url: 'https://www.the-independent.com/news/uk/rss',
    canonical_domain: 'the-independent.com', max_items: 20 },
  { source_key: 'the-independent', route_key: 'independent-climate',
    url: 'https://www.the-independent.com/climate-change/rss',
    canonical_domain: 'the-independent.com', max_items: 10 },
  { source_key: 'the-independent', route_key: 'independent-science',
    url: 'https://www.the-independent.com/news/science/rss',
    canonical_domain: 'the-independent.com', max_items: 10 },
  { source_key: 'the-independent', route_key: 'independent-health',
    url: 'https://www.the-independent.com/life-style/health-and-families/rss',
    canonical_domain: 'the-independent.com', max_items: 10 },
  { source_key: 'carbon-brief', route_key: 'carbon-brief-feed',
    url: 'https://www.carbonbrief.org/feed/', canonical_domain: 'carbonbrief.org', max_items: 20,
    allowed_manual_redirect_url: 'https://www.carbonbrief.org/feed' },
  { source_key: 'openaq', route_key: 'openaq-medium',
    url: 'https://openaq.medium.com/feed', canonical_domain: 'openaq.medium.com', max_items: 20,
    content_encoded_preview_scan_bytes: MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES },
  { source_key: 'phys-org', route_key: 'phys-org-environment',
    url: 'https://phys.org/rss-feed/earth-news/environment/', canonical_domain: 'phys.org',
    max_items: 20 },
  { source_key: 'university-of-exeter', route_key: 'university-of-exeter-news',
    url: 'https://news.exeter.ac.uk/feed/', canonical_domain: 'news.exeter.ac.uk',
    max_items: 20 },
  { source_key: 'impact-on-urban-health', route_key: 'impact-on-urban-health-feed',
    url: 'https://urbanhealth.org.uk/feed', canonical_domain: 'urbanhealth.org.uk',
    max_items: 20 },
  { source_key: 'see-the-air', route_key: 'see-the-air-feed',
    url: 'https://seetheair.org/feed/', canonical_domain: 'seetheair.org', max_items: 20,
    content_encoded_preview_scan_bytes: MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES },
  { source_key: 'climate-with-brian', route_key: 'climate-with-brian-feed',
    url: 'https://climatewithbrian.com/feed/', canonical_domain: 'climatewithbrian.com',
    max_items: 20 },
  { source_key: 'healthy-air-coalition', route_key: 'healthy-air-coalition-feed',
    url: 'https://www.healthyair.org.uk/feed/', canonical_domain: 'healthyair.org.uk',
    max_items: 20 },
  { source_key: 'mums-for-lungs', route_key: 'mums-for-lungs-news',
    url: 'https://www.mumsforlungs.org/news?format=rss', canonical_domain: 'mumsforlungs.org',
    max_items: 20 },
] as const;

export type PublisherRssSourceKey = typeof PUBLISHER_RSS_ROUTES[number]['source_key'];

function normaliseEditorialText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-GB')
    .replace(/[\u2010-\u2015]+/g, '-').replace(/\s+/g, ' ').trim();
}

export function publisherRssArticleAllowed(sourceKey: string,
  article: Pick<DiscoveredArticle, 'title' | 'categories'>): boolean {
  if (sourceKey !== 'see-the-air') return true;
  const title = normaliseEditorialText(article.title);
  const categories = article.categories.map(normaliseEditorialText);

  // See The Air mixes original AQ analysis with product/commercial and promotional posts.
  // Reject only obvious non-News forms here; ambiguous posts remain manual-review candidates.
  if (/^(?:review|comparison)\b(?:\s*[:\-])?/.test(title)) return false;
  if (/\byear in review\b|\b(?:buying|shopping|gift) guide\b|\bmarket matrix\b|\bwebinar\b/
      .test(title)) return false;
  if (categories.some(category => /^(?:comparison|reviews?)$/.test(category))) return false;
  return true;
}

const PUBLISHER_RSS_AUTHOR_POLICIES = new Map<string, 'none'>([
  ['healthy-air-coalition', 'none'], // WordPress technical author `hacadmin`.
  ['mums-for-lungs', 'none'],
]);

function expectedRoute(sourceKey: string, routeKey: string) {
  return PUBLISHER_RSS_ROUTES.find(route => route.source_key === sourceKey &&
    route.route_key === routeKey) ?? null;
}

function expectedAiContentPolicy(sourceKey: string): Source['ai_content_policy'] {
  return sourceKey === 'carbon-brief' || sourceKey === 'openaq'
    ? 'metadata_only' : 'disabled';
}

function configuredRoute(source: Source, routeKey: string): {
  route_key: string;
  url: string;
  max_items: number;
} {
  const expected = expectedRoute(source.source_key, routeKey);
  const route = source.discovery_config.routes?.find(candidate => candidate.route_key === routeKey);
  if (!expected || !route || source.source_type !== 'publisher' || !source.enabled ||
      source.canonical_domain !== expected.canonical_domain || source.discovery_method !== 'rss' ||
      // Mums for Lungs is the sole auto-approved generic RSS source; every other
      // configured publisher still requires the contracted manual review policy.
      source.publication_policy !== (source.source_key === 'mums-for-lungs'
        ? 'auto_approve' : 'manual') || source.review_level !== 'standard' ||
      source.content_fetch_policy !== 'discovery_metadata_only' ||
      source.ai_content_policy !== expectedAiContentPolicy(source.source_key) ||
      source.image_policy !== 'remote_preview' ||
      !['metadata_only', 'feed_body_text'].includes(source.search_index_policy) ||
      route.url !== expected.url || route.max_items !== expected.max_items) {
    throw new ScanError('publisher_rss_config_mismatch');
  }
  return route;
}

export function configuredPublisherRssRouteKeys(source: Source): string[] {
  const expected = PUBLISHER_RSS_ROUTES.filter(route => route.source_key === source.source_key);
  if (expected.length === 0 || source.discovery_config.routes?.length !== expected.length) return [];
  try { return expected.map(route => configuredRoute(source, route.route_key).route_key); }
  catch { return []; }
}

export async function discoverPublisherRss(source: Source, routeKey: string, fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  const route = configuredRoute(source, routeKey);
  const expected = expectedRoute(source.source_key, routeKey)!;
  const allowedRedirect = 'allowed_manual_redirect_url' in expected
    ? expected.allowed_manual_redirect_url : undefined;
  return parsePublisherRssFeed(await readRssFeed(route.url, 'publisher_rss', allowedRedirect, fetcher),
    source, routeKey);
}

export async function parsePublisherRssFeed(xml: string, source: Source, routeKey: string): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  const route = configuredRoute(source, routeKey);
  const expected = expectedRoute(source.source_key, routeKey)!;
  const contentEncodedPreviewScanBytes = 'content_encoded_preview_scan_bytes' in expected
    ? expected.content_encoded_preview_scan_bytes : null;
  const parsed = parseRssItems(xml, route.max_items, {
    ...(contentEncodedPreviewScanBytes === null ? {} : { content_encoded_preview: {
      max_scan_bytes: contentEncodedPreviewScanBytes,
      validate_url: candidate => remotePreviewUrl(candidate, source),
    } }), retain_content_encoded: source.search_index_policy === 'feed_body_text',
  });
  const articles: DiscoveredArticle[] = [];
  let invalid = parsed.items_invalid;
  for (const item of parsed.items) {
    let canonical: string;
    try { canonical = canonicalizeUrl(item.raw_url, source); }
    catch { invalid++; continue; }
    const preview = source.image_policy === 'remote_preview' ? [
      ...item.preview_candidates.map(candidate => remotePreviewUrl(candidate.url, source)),
      item.content_encoded_preview_url,
    ].find(Boolean) ?? null : null;
    articles.push({ canonical_url: canonical, canonical_url_hash: await canonicalUrlHash(canonical),
      original_url: item.raw_url, title: item.title,
      author: PUBLISHER_RSS_AUTHOR_POLICIES.get(source.source_key) === 'none' ? null : item.author,
      published_at: item.published_at, categories: item.categories, title_context: null,
      preview_url: preview, display_title: null, display_title_origin: null,
      preview_metadata_checked_at: null, feed_body_html: item.content_encoded_html });
  }
  return { articles, items_seen: parsed.items_seen, items_invalid: invalid };
}
