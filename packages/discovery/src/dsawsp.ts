import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

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
    source.enabled && source.publication_policy === 'manual' && source.review_level === 'standard' &&
    source.priority === 50 && source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'article_head_allowed' && source.ai_content_policy === 'disabled' &&
    source.image_policy === 'remote_preview' && source.discovery_config.routes?.length === 1 &&
    route?.route_key === DSAWSP_INDEX_ROUTE_KEY && route.url === DSAWSP_INDEX_URL &&
    route.max_items === DSAWSP_MAX_ITEMS && source.discovery_config.retain_excerpt === false;
}

export function extractDsawspIndexUrls(html: string, source: Source): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const raw = attribute(match[1] ?? '', 'href');
    if (!raw) continue;
    let absolute: string;
    try { absolute = new URL(raw, DSAWSP_INDEX_URL).href; } catch { continue; }
    const permitted = publisherHttpsUrl(absolute, source);
    if (!permitted || !new URL(permitted).pathname.startsWith('/blog/')) continue;
    try { urls.add(canonicalizeUrl(permitted, source)); } catch { continue; }
    if (urls.size >= DSAWSP_MAX_ITEMS) break;
  }
  return [...urls];
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

function dsawspStructuredImageCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dsawspStructuredImageCandidates);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
    .filter((candidate): candidate is string => typeof candidate === 'string');
  const article = types.some(type => /^(?:Article|BlogPosting|NewsArticle)$/i.test(type));
  const results: string[] = [];
  if (article) {
    for (const field of [record.image, record.thumbnailUrl]) {
      if (typeof field === 'string') results.push(field);
      else if (Array.isArray(field)) {
        for (const item of field) {
          if (typeof item === 'string') results.push(item);
          else if (item && typeof item === 'object') {
            const image = item as Record<string, unknown>;
            for (const key of ['url', 'contentUrl']) {
              if (typeof image[key] === 'string') results.push(image[key] as string);
            }
          }
        }
      } else if (field && typeof field === 'object') {
        const image = field as Record<string, unknown>;
        for (const key of ['url', 'contentUrl']) {
          if (typeof image[key] === 'string') results.push(image[key] as string);
        }
      }
    }
  }
  return results.concat(Object.values(record).flatMap(dsawspStructuredImageCandidates));
}

export function extractDsawspArticlePreviewImage(html: string, articleUrl: string,
  source: DsawspPreviewSource): string | null {
  if (source.source_key !== 'dsawsp' || source.image_policy !== 'remote_preview') return null;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1] ?? '';
    if (attribute(attrs, 'type')?.trim().toLowerCase() !== 'application/ld+json') continue;
    try {
      for (const candidate of dsawspStructuredImageCandidates(JSON.parse(match[2] ?? ''))) {
        const accepted = dsawspImageCandidate(candidate, articleUrl, source);
        if (accepted) return accepted;
      }
    } catch { /* Optional publisher metadata may be malformed. */ }
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
  articleUrl: string = DSAWSP_INDEX_URL): {
  title: string | null; publishedAt: string | null; category: string | null;
  previewUrl: string | null;
} {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const key = attribute(attrs, 'property') ?? attribute(attrs, 'name');
    const value = attribute(attrs, 'content');
    if (key && value && !meta.has(key.toLowerCase())) meta.set(key.toLowerCase(), text(value));
  }
  const title = text(meta.get('og:title') ??
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '') || null;
  const date = /<[^>]*\bclass\s*=\s*(?:"[^"]*\bblog-date\b[^"]*"|'[^']*\bblog-date\b[^']*')[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(html)?.[1];
  const category = /<a\b[^>]*\bclass\s*=\s*(?:"[^"]*\bcategory-link\b[^"]*"|'[^']*\bcategory-link\b[^']*')[^>]*>([\s\S]*?)<\/a\s*>/i.exec(html)?.[1];
  const image = meta.get('og:image') ?? meta.get('twitter:image') ?? null;
  const previewUrl = image ? remotePreviewUrl(image, source) : null;
  return { title, publishedAt: date ? dsawspDate(date) : null,
    category: category ? text(category).slice(0, 100) || null : null,
    previewUrl: previewUrl ?? extractDsawspArticlePreviewImage(html, articleUrl, source) };
}

export async function fetchDsawspArticlePreviewImage(articleUrl: string,
  source: DsawspPreviewSource, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (source.source_key !== 'dsawsp' || source.image_policy !== 'remote_preview') return null;
  const html = await fetchBoundedHtml(articleUrl, source, ARTICLE_MAX_BYTES,
    value => Boolean(extractDsawspArticlePreviewImage(value, articleUrl, source)), fetcher);
  return extractDsawspArticlePreviewImage(html, articleUrl, source);
}

async function fetchBoundedHtml(url: string,
  source: Pick<Source, 'source_key' | 'canonical_domain'>, maximumBytes: number,
  enough?: (html: string) => boolean, fetcher: typeof fetch = fetch): Promise<string> {
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
        if (enough?.(html)) return html;
      }
    } finally { try { await reader.cancel('bounded DSAWSP metadata obtained'); } catch { /* best effort */ } }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted ? 'dsawsp_timeout' : 'dsawsp_read_failed');
  } finally { clearTimeout(timeout); }
}

export async function discoverDsawsp(source: Source, fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (!configuredDsawspIndex(source)) throw new ScanError('dsawsp_config_mismatch');
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  const fetchedPages = new Set<string>();
  let indexUrl: string | null = DSAWSP_INDEX_URL;
  for (let page = 0; indexUrl && page < DSAWSP_MAX_INDEX_PAGES &&
      urls.length < DSAWSP_MAX_ITEMS; page++) {
    if (fetchedPages.has(indexUrl)) break;
    fetchedPages.add(indexUrl);
    const currentUrl = indexUrl;
    const index = await fetchBoundedHtml(currentUrl, source, INDEX_MAX_BYTES,
      value => extractDsawspIndexUrls(value, source).length >= DSAWSP_MAX_ITEMS, fetcher);
    for (const articleUrl of extractDsawspIndexUrls(index, source)) {
      if (seenUrls.has(articleUrl)) continue;
      seenUrls.add(articleUrl);
      urls.push(articleUrl);
      if (urls.length >= DSAWSP_MAX_ITEMS) break;
    }
    indexUrl = extractDsawspNextIndexUrl(index, currentUrl, source);
  }
  const articles: DiscoveredArticle[] = [];
  let invalid = 0;
  for (const canonical of urls) {
    try {
      const html = await fetchBoundedHtml(canonical, source, ARTICLE_MAX_BYTES, value => {
        const metadata = extractDsawspArticleMetadata(value, source, canonical);
        return Boolean(metadata.title && metadata.publishedAt && metadata.category && metadata.previewUrl);
      }, fetcher);
      const metadata = extractDsawspArticleMetadata(html, source, canonical);
      if (!metadata.title) { invalid++; continue; }
      articles.push({ canonical_url: canonical, canonical_url_hash: await canonicalUrlHash(canonical),
        original_url: canonical, title: metadata.title, author: null,
        published_at: metadata.publishedAt, categories: metadata.category ? [metadata.category] : [],
        title_context: null, preview_url: metadata.previewUrl, display_title: null,
        display_title_origin: null, preview_metadata_checked_at: new Date().toISOString() });
    } catch { invalid++; }
  }
  return { articles, items_seen: urls.length, items_invalid: invalid };
}
