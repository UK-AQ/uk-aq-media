import {
  canonicalizeUrl, canonicalUrlHash, remotePreviewUrl, SourceSchema,
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
  { source_key: 'breathe-london-communities', route_key: 'breathe-london-communities-news',
    url: 'https://www.breathelondon-communities.org/news?format=rss', canonical_domain: 'breathelondon-communities.org', max_items: 20 },
  { source_key: 'mums-for-lungs', route_key: 'mums-for-lungs-news',
    url: 'https://www.mumsforlungs.org/news?format=rss', canonical_domain: 'mumsforlungs.org',
    max_items: 20 },
] as const;

export type PublisherRssSourceKey = typeof PUBLISHER_RSS_ROUTES[number]['source_key'];
type PublisherRssRoute = typeof PUBLISHER_RSS_ROUTES[number];

export type PublisherRssConfigurationDiagnostic = {
  code: 'unsupported_source' | 'source_disabled' | 'source_type' | 'canonical_domain' |
    'discovery_method' | 'unsupported_publication_policy' | 'review_level' |
    'content_fetch_policy' | 'ai_content_policy' | 'image_policy' | 'search_index_policy' |
    'route_count' | 'missing_route_key' | 'unexpected_route_key' | 'duplicate_route_key' |
    'feed_url' | 'max_items' | 'invalid_source_schema' | 'invalid_discovery_config_json';
  route_key?: PublisherRssRoute['route_key'];
};

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

function expectedAiContentPolicy(sourceKey: string): Source['ai_content_policy'] {
  return sourceKey === 'carbon-brief' || sourceKey === 'openaq'
    ? 'metadata_only' : 'disabled';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function validatePublisherRssConfiguration(source: { source_key: string; [key: string]: unknown }): {
  routes: PublisherRssRoute[];
  diagnostics: PublisherRssConfigurationDiagnostic[];
} {
  const expected = PUBLISHER_RSS_ROUTES.filter(route => route.source_key === source.source_key);
  const [firstRoute] = expected;
  if (!firstRoute) return { routes: [], diagnostics: [{ code: 'unsupported_source' }] };

  const checks: [PublisherRssConfigurationDiagnostic['code'], boolean][] = [
    ['source_disabled', source.enabled === true],
    ['source_type', source.source_type === 'publisher'],
    ['canonical_domain', source.canonical_domain === firstRoute.canonical_domain],
    ['discovery_method', source.discovery_method === 'rss'],
    ['unsupported_publication_policy', source.publication_policy === 'manual' ||
      source.publication_policy === 'auto_approve'],
    ['review_level', source.review_level === 'standard'],
    ['content_fetch_policy', source.content_fetch_policy === 'discovery_metadata_only'],
    ['ai_content_policy', source.ai_content_policy === expectedAiContentPolicy(source.source_key)],
    ['image_policy', source.image_policy === 'remote_preview'],
    ['search_index_policy', source.search_index_policy === 'metadata_only' ||
      source.search_index_policy === 'feed_body_text'],
  ];
  const diagnostics: PublisherRssConfigurationDiagnostic[] = checks
    .filter(([, matches]) => !matches).map(([code]) => ({ code }));
  const rawRoutes = asRecord(source.discovery_config)?.routes;
  const routes: unknown[] = Array.isArray(rawRoutes) ? rawRoutes : [];
  if (routes.length !== expected.length) diagnostics.push({ code: 'route_count' });
  // Inspect at most one more entry than the allowlist permits. Oversized lists
  // already fail on route count and may have missing keys beyond this sample.
  const configured = routes.slice(0, expected.length + 1).map(asRecord);
  if (configured.some(route => !expected.some(allowed => allowed.route_key === route?.route_key))) {
    diagnostics.push({ code: 'unexpected_route_key' });
  }
  for (const { route_key, url, max_items } of expected) {
    const matching = configured.filter(route => route?.route_key === route_key);
    if (!matching.length) {
      if (configured.length === routes.length) diagnostics.push({ code: 'missing_route_key', route_key });
      continue;
    }
    if (matching.length > 1) diagnostics.push({ code: 'duplicate_route_key', route_key });
    if (matching.some(route => route?.url !== url)) diagnostics.push({ code: 'feed_url', route_key });
    if (matching.some(route => route?.max_items !== max_items)) diagnostics.push({ code: 'max_items', route_key });
  }
  if (!SourceSchema.safeParse(source).success) diagnostics.push({ code: 'invalid_source_schema' });
  return { routes: diagnostics.length ? [] : expected, diagnostics };
}

function configuredRoute(source: Source, routeKey: string): PublisherRssRoute {
  const route = validatePublisherRssConfiguration(source).routes.find(route => route.route_key === routeKey);
  if (!route) throw new ScanError('publisher_rss_config_mismatch');
  return route;
}

export function configuredPublisherRssRouteKeys(source: Source): string[] {
  return validatePublisherRssConfiguration(source).routes.map(route => route.route_key);
}

export async function discoverPublisherRss(source: Source, routeKey: string, fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  const route = configuredRoute(source, routeKey);
  const allowedRedirect = 'allowed_manual_redirect_url' in route
    ? route.allowed_manual_redirect_url : undefined;
  return parseConfiguredPublisherRssFeed(
    await readRssFeed(route.url, 'publisher_rss', allowedRedirect, fetcher), source, route);
}

export async function parsePublisherRssFeed(xml: string, source: Source, routeKey: string): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  return parseConfiguredPublisherRssFeed(xml, source, configuredRoute(source, routeKey));
}

async function parseConfiguredPublisherRssFeed(xml: string, source: Source, route: PublisherRssRoute) {
  const contentEncodedPreviewScanBytes = 'content_encoded_preview_scan_bytes' in route
    ? route.content_encoded_preview_scan_bytes : null;
  const parsed = parseRssItems(xml, route.max_items, {
    review_description: true,
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
      review_excerpt: item.review_excerpt,
      preview_url: preview, display_title: null, display_title_origin: null,
      preview_metadata_checked_at: null, feed_body_html: item.content_encoded_html });
  }
  return { articles, items_seen: parsed.items_seen, items_invalid: invalid };
}
