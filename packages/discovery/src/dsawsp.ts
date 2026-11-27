import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import {
  extractArticleHeadMetadata, extractPublisherArticleMetadata, previewImageFromPublisherMetadata,
  publisherPublicationDate,
} from './article-head-metadata';
import { ScanError } from './rss';
import { fetchPublisherArticleMetadata } from './article-metadata-fetch';

export const DSAWSP_INDEX_ROUTE_KEY = 'dsawsp-news-extras';
export const DSAWSP_INDEX_URL = 'https://www.dsawsp.org/resources/blog';
export const DSAWSP_MAX_ITEMS = 20;
export const DSAWSP_MAX_INDEX_PAGES = 4;
const INDEX_MAX_BYTES = 512 * 1024;
const ARTICLE_MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function decode(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<',
    nbsp: ' ', quot: '"' };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? entity;
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : entity; }
    catch { return entity; }
  });
}

function text(value: string): string {
  return decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  return match ? decode(match[1] ?? match[2] ?? '') : null;
}

export function configuredDsawspIndex(source: Source): boolean {
  const route = source.discovery_config.routes?.[0];
  return source.source_key === 'dsawsp' && source.name === 'DSAWSP' &&
    source.canonical_domain === 'dsawsp.org' && source.source_type === 'publisher' &&
    source.enabled && source.review_level === 'standard' &&
    source.priority === 50 && source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'article_head_allowed' && source.ai_content_policy === 'disabled' &&
    source.image_policy === 'remote_preview' && source.discovery_config.routes?.length === 1 &&
    route?.route_key === DSAWSP_INDEX_ROUTE_KEY && route.url === DSAWSP_INDEX_URL &&
    route.max_items === DSAWSP_MAX_ITEMS && source.discovery_config.retain_excerpt === false;
}

export function extractDsawspIndexUrls(html: string, source: Source): string[] {
  return extractDsawspIndexArticles(html, source, DSAWSP_INDEX_URL).map(article => article.canonical_url);
}

type DsawspIndexArticle = Pick<DiscoveredArticle, 'canonical_url' | 'original_url'>;

function extractDsawspIndexArticles(html: string, source: Source, indexUrl: string): DsawspIndexArticle[] {
  const articles = new Map<string, DsawspIndexArticle>();
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const raw = attribute(match[1] ?? '', 'href');
    if (!raw) continue;
    try {
      const permitted = publisherHttpsUrl(new URL(raw, indexUrl).href, source);
      const identity = new URL(raw, DSAWSP_INDEX_URL);
      if (!permitted || !identity.pathname.startsWith('/blog/')) continue;
      const canonical = canonicalizeUrl(identity.href, source);
      if (!articles.has(canonical)) articles.set(canonical, { canonical_url: canonical, original_url: permitted });
    } catch { continue; }
    if (articles.size >= DSAWSP_MAX_ITEMS) break;
  }
  return [...articles.values()];
}

export function extractDsawspNextIndexUrl(html: string, currentUrl: string,
  source: Source): string | null {
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const classes = attribute(attrs, 'class')?.split(/\s+/) ?? [];
    if (!classes.includes('w-pagination-next')) continue;
    const raw = attribute(attrs, 'href');
    if (!raw) return null;
    let candidate: URL;
    let current: URL;
    try {
      candidate = new URL(raw, currentUrl);
      current = new URL(currentUrl);
    } catch { return null; }
    if (!publisherHttpsUrl(candidate.href, source) ||
        candidate.origin !== new URL(DSAWSP_INDEX_URL).origin ||
        candidate.pathname !== new URL(DSAWSP_INDEX_URL).pathname || candidate.hash ||
        candidate.searchParams.size !== 1) return null;
    const entry = [...candidate.searchParams.entries()][0];
    if (!entry) return null;
    const [key, value] = entry;
    const currentPage = [...current.searchParams.values()][0] ?? '1';
    if (!/^[a-z0-9]+_page$/.test(key ?? '') || !/^\d+$/.test(value ?? '') ||
        Number(value) !== Number(currentPage) + 1) return null;
    return candidate.href;
  }
  return null;
}

type DsawspPreviewSource = Pick<Source, 'source_key' | 'canonical_domain' | 'image_policy'>;

const DSAWSP_IMAGE_EXCLUDED_HINT = /(?:^|[\s_-])(avatar|brand|cookie|footer|header|icon|logo|menu|nav|related|share|sidebar|social|tracking|widget)(?:$|[\s_-])/i;

function dsawspImageCandidate(raw: string | null | undefined, articleUrl: string,
  source: DsawspPreviewSource): string | null {
  if (!raw) return null;
  try { return remotePreviewUrl(new URL(raw.trim(), articleUrl).href, source); }
  catch { return null; }
}

export function extractDsawspArticlePreviewImage(html: string, articleUrl: string,
  source: DsawspPreviewSource, includeStructured = true): string | null {
  if (source.source_key !== 'dsawsp' || source.image_policy !== 'remote_preview') return null;
  if (includeStructured) {
    const preview = previewImageFromPublisherMetadata(extractArticleHeadMetadata(html, articleUrl), articleUrl, source);
    if (preview) return preview;
  }

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const hint = [attribute(attrs, 'id'), attribute(attrs, 'class'), attribute(attrs, 'alt')]
      .filter(Boolean).join(' ');
    if (DSAWSP_IMAGE_EXCLUDED_HINT.test(hint)) continue;
    const width = Number(attribute(attrs, 'width'));
    const height = Number(attribute(attrs, 'height'));
    if ((width && width <= 2) || (height && height <= 2)) continue;
    const srcset = attribute(attrs, 'srcset')?.split(',').map(candidate =>
      candidate.trim().split(/\s+/, 1)[0]).filter(Boolean).reverse() ?? [];
    for (const raw of [attribute(attrs, 'src'), attribute(attrs, 'data-src'), ...srcset]) {
      const accepted = dsawspImageCandidate(raw, articleUrl, source);
      if (accepted) return accepted;
    }
  }
  return null;
}

function dsawspDate(value: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(text(value));
  if (!match) return null;
  const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'].indexOf(match[1]!.toLowerCase()) + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || year < 2000 || year > 2100 || day < 1 || day > 31) return null;
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${candidate}T00:00:00Z`);
  return checked.getUTCFullYear() === year && checked.getUTCMonth() + 1 === month &&
    checked.getUTCDate() === day ? candidate : null;
}

export function extractDsawspArticleMetadata(html: string, source: Source,
  articleUrl: string = DSAWSP_INDEX_URL, canonicalUrl?: string): {
  title: string | null; publishedAt: string | null; category: string | null;
  previewUrl: string | null;
} {
  const head = extractArticleHeadMetadata(html, articleUrl,
    canonicalUrl ? { canonicalUrl, source } : undefined);
  const title = head.explicitHeadline ?? head.ogTitle ?? head.twitterTitle ?? head.htmlTitle;
  const date = /<[^>]*\bclass\s*=\s*(?:"[^"]*\bblog-date\b[^"]*"|'[^']*\bblog-date\b[^']*')[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(html)?.[1];
  const category = /<a\b[^>]*\bclass\s*=\s*(?:"[^"]*\bcategory-link\b[^"]*"|'[^']*\bcategory-link\b[^']*')[^>]*>([\s\S]*?)<\/a\s*>/i.exec(html)?.[1];
  const previewUrl = previewImageFromPublisherMetadata(head, articleUrl, source);
  return { title, publishedAt: (date ? dsawspDate(date) : null) ?? publisherPublicationDate(head.publishedAt),
    category: category ? text(category).slice(0, 100) || null : null,
    previewUrl: previewUrl ?? extractDsawspArticlePreviewImage(html, articleUrl, source, false) };
}

export async function fetchDsawspArticlePreviewImage(articleUrl: string,
  source: DsawspPreviewSource, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (source.source_key !== 'dsawsp' || source.image_policy !== 'remote_preview') return null;
  const page = await fetchBoundedHtml(articleUrl, source, ARTICLE_MAX_BYTES,
    (html, url) => Boolean(extractDsawspArticlePreviewImage(html, url, source)), fetcher);
  return extractDsawspArticlePreviewImage(page.html, page.url, source);
}

async function fetchBoundedHtml(url: string,
  source: Pick<Source, 'source_key' | 'canonical_domain'>, maximumBytes: number,
  enough?: (html: string, url: string) => boolean, fetcher: typeof fetch = fetch):
  Promise<{ html: string; url: string }> {
  const permitted = publisherHttpsUrl(url, source);
  if (!permitted) throw new ScanError('dsawsp_url_not_permitted');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = permitted;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' } });
      } catch { throw new ScanError(controller.signal.aborted ? 'dsawsp_timeout' : 'dsawsp_fetch_failed'); }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) throw new ScanError('dsawsp_redirect_rejected');
      let destination: string | null = null;
      try { destination = publisherHttpsUrl(new URL(location, requestUrl).href, source); } catch { /* reject */ }
      if (!destination) throw new ScanError('dsawsp_redirect_rejected');
      requestUrl = destination;
      redirects++;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`dsawsp_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await response.body.cancel();
      throw new ScanError('dsawsp_not_html');
    }
    return { html: await readDsawspHtml(response, requestUrl, maximumBytes, enough), url: requestUrl };
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted ? 'dsawsp_timeout' : 'dsawsp_read_failed');
  } finally { clearTimeout(timeout); }
}

async function readDsawspHtml(response: Response, url: string, maximumBytes: number,
  enough?: (html: string, url: string) => boolean): Promise<string> {
  if (!response.body) throw new ScanError('dsawsp_missing_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let html = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return html + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new ScanError('dsawsp_html_too_large');
      html += decoder.decode(value, { stream: true });
      if (enough?.(html, url)) return html;
    }
  } finally { try { await reader.cancel('bounded DSAWSP metadata obtained'); } catch { /* best effort */ } }
}

export async function discoverDsawsp(source: Source, fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (!configuredDsawspIndex(source)) throw new ScanError('dsawsp_config_mismatch');
  const candidates = new Map<string, DsawspIndexArticle>();
  const fetchedPages = new Set<string>();
  let indexUrl: string | null = DSAWSP_INDEX_URL;
  for (let page = 0; indexUrl && page < DSAWSP_MAX_INDEX_PAGES &&
      candidates.size < DSAWSP_MAX_ITEMS; page++) {
    if (fetchedPages.has(indexUrl)) break;
    fetchedPages.add(indexUrl);
    const index = await fetchBoundedHtml(indexUrl, source, INDEX_MAX_BYTES,
      (html, url) => extractDsawspIndexArticles(html, source, url).length >= DSAWSP_MAX_ITEMS, fetcher);
    for (const article of extractDsawspIndexArticles(index.html, source, index.url)) {
      if (!candidates.has(article.canonical_url)) candidates.set(article.canonical_url, article);
      if (candidates.size >= DSAWSP_MAX_ITEMS) break;
    }
    indexUrl = extractDsawspNextIndexUrl(index.html, indexUrl, source);
  }
  const articles: DiscoveredArticle[] = [];
  let invalid = 0;
  for (const article of candidates.values()) {
    try {
      const canonical = article.canonical_url;
      const resolvedUrls: string[] = [];
      const { html, url } = await fetchPublisherArticleMetadata(article, source, async (response, url) => ({
        url,
        html: await readDsawspHtml(response, url, ARTICLE_MAX_BYTES, (html, url) => {
          const metadata = extractDsawspArticleMetadata(html, source, url, canonical);
          return Boolean(metadata.title && metadata.publishedAt && metadata.category && metadata.previewUrl);
        }),
      }), {
        maxRedirects: MAX_REDIRECTS,
        fetcher: (input, init) => {
          resolvedUrls.push(String(input));
          return fetcher(input, init);
        },
      });
      const metadata = extractDsawspArticleMetadata(html, source, url, canonical);
      if (!metadata.title) { invalid++; continue; }
      const shared = extractPublisherArticleMetadata(html, url, metadata.title, undefined,
        { canonicalUrl: canonical, source });
      articles.push({ ...article, canonical_url_hash: await canonicalUrlHash(canonical),
        publisher_resolved_urls: resolvedUrls, title: shared.explicitHeadline ?? metadata.title,
        explicit_publisher_headline: shared.explicitHeadline,
        author: shared.author, published_at: metadata.publishedAt ?? publisherPublicationDate(shared.publishedAt),
        categories: metadata.category ? [metadata.category] : [],
        title_context: null, preview_url: metadata.previewUrl, display_title: null,
        display_title_origin: null, preview_metadata_checked_at: new Date().toISOString() });
    } catch { invalid++; }
  }
  return { articles, items_seen: candidates.size, items_invalid: invalid };
}
