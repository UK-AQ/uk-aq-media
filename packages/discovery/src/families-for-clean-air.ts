import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { decodeHtmlEntities, normaliseMetadataText } from './article-head-metadata';
import { mediaDeterministicRelevanceFilter } from './relevance';
import { ScanError } from './rss';

export const FAMILIES_FOR_CLEAN_AIR_SOURCE_KEY = 'families-for-clean-air';
export const FAMILIES_FOR_CLEAN_AIR_INDEX_ROUTE_KEY = 'families-for-clean-air-news-index';
export const FAMILIES_FOR_CLEAN_AIR_INDEX_URL = 'https://www.familiesforcleanair.org/news/';
export const FAMILIES_FOR_CLEAN_AIR_MAX_ITEMS = 20;
const DOMAIN = 'familiesforcleanair.org';
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RESERVED_PAGES = new Set([
  '/', '/news', '/about', '/contact', '/donate', '/resources', '/health',
  '/environment', '/myths-facts', '/myths-and-facts', '/take-action',
  '/health-hazards', '/particle-pollution', '/wood-smoke-comparison-chart',
  '/environmental-impact', '/toxics', '/dioxin', '/climate-change',
  '/why-epa-certified-stoves-are-not-the-answer', '/children',
  '/heart-attack-and-stroke', '/versus-tobacco-smoke',
]);
type Candidate = Pick<DiscoveredArticle, 'canonical_url' | 'original_url' | 'title' | 'preview_url'>;

export function configuredFamiliesForCleanAirIndex(source: Source): boolean {
  const routes = source.discovery_config.routes;
  const route = routes?.[0];
  return source.source_key === FAMILIES_FOR_CLEAN_AIR_SOURCE_KEY &&
    source.canonical_domain === DOMAIN && source.source_type === 'publisher' &&
    source.enabled && source.publication_policy === 'manual' &&
    source.review_level === 'standard' && source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'discovery_metadata_only' &&
    source.ai_content_policy === 'disabled' && source.image_policy === 'remote_preview' &&
    source.search_index_policy === 'metadata_only' &&
    source.discovery_config.retain_excerpt === false && routes?.length === 1 &&
    route?.route_key === FAMILIES_FOR_CLEAN_AIR_INDEX_ROUTE_KEY &&
    route.url === FAMILIES_FOR_CLEAN_AIR_INDEX_URL &&
    route.max_items === FAMILIES_FOR_CLEAN_AIR_MAX_ITEMS;
}

function permittedUrl(raw: string | null, base: string, source: Source): URL | null {
  if (!raw?.trim() || raw.length > 2048) return null;
  let resolved: string;
  try { resolved = new URL(decodeHtmlEntities(raw), base).href; }
  catch { return null; }
  const allowed = publisherHttpsUrl(resolved, source);
  if (!allowed) return null;
  const url = new URL(allowed);
  if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return null;
  return url;
}

function articleUrl(raw: string | null, base: string, source: Source): URL | null {
  if (!raw?.trim() || raw.length > 2048) return null;
  // Older publisher links can still use http:// even though the current site
  // serves HTTPS. Upgrade the exact publisher host before applying the HTTPS guard.
  let resolved: URL;
  try { resolved = new URL(decodeHtmlEntities(raw), base); } catch { return null; }
  if (resolved.protocol === 'http:') resolved.protocol = 'https:';
  const url = permittedUrl(resolved.href, base, source);
  if (!url || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/$/, '').toLowerCase();
  // Current articles use /news/<slug>; older publisher URLs use /<slug>.
  // Accept only these bounded patterns, not navigation or nested resource paths.
  const currentNewsArticle = /^\/news\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
  const legacyArticle = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) && !RESERVED_PAGES.has(path);
  if (!currentNewsArticle && !legacyArticle) return null;
  return url;
}

async function extractIndex(response: Response, base: string, source: Source): Promise<{
  candidates: Candidate[]; items_seen: number; items_invalid: number;
}> {
  const candidates = new Map<string, Candidate>();
  let seen = 0;
  let invalid = 0;
  let anchorsSeen = 0;
  let articleUrlsSeen = 0;
  let active: { url: URL; title: string } | null = null;
  // Do not assume the publisher's headline link is nested inside h2/h3:
  // the page also presents recent articles in a sidebar. Inspect anchors,
  // but admit only the two known article URL shapes with AQ-relevant titles.
  const rewriter = new HTMLRewriter().on('a[href]', {
    element(element) {
      anchorsSeen++;
      if (seen >= FAMILIES_FOR_CLEAN_AIR_MAX_ITEMS || active) return;
      const url = articleUrl(element.getAttribute('href'), base, source);
      if (!url) return;
      articleUrlsSeen++;
      const item = { url, title: '' };
      active = item;
      element.onEndTag(() => {
        active = null;
        const canonical = canonicalizeUrl(item.url.href, source);
        // Duplicate links, including sidebar links, do not consume the limit.
        if (candidates.has(canonical)) return;
        const title = normaliseMetadataText(item.title);
        if (!title) {
          invalid++;
          return;
        }
        if (!mediaDeterministicRelevanceFilter.evaluate({
          title, canonical_url: canonical, categories: [],
        }).relevant) return;
        seen++;
        const candidate: Candidate = { canonical_url: canonical,
          original_url: item.url.href, title, preview_url: null };
        candidates.set(canonical, candidate);
      });
    },
    text(chunk) {
      if (active && active.title.length < 1000) active.title += chunk.text;
    },
  });
  // Images are resolved from the individual article's metadata after discovery.
  // Do not guess which headline an adjacent Webflow or legacy index image belongs to.
  const reader = response.body!.getReader();
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (seen >= FAMILIES_FOR_CLEAN_AIR_MAX_ITEMS || bytes >= MAX_HTML_BYTES) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const chunk = value.subarray(0, MAX_HTML_BYTES - bytes);
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  try {
    const html = new Response(stream, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    await rewriter.transform(html).body!.pipeTo(new WritableStream());
    if (seen < FAMILIES_FOR_CLEAN_AIR_MAX_ITEMS && bytes >= MAX_HTML_BYTES) {
      throw new ScanError('families_for_clean_air_html_too_large');
    }
    if (!candidates.size) {
      // Failure categories distinguish an unexpected/challenge HTML page,
      // missing valid publisher links, and headlines excluded by the AQ filter.
      throw new ScanError(anchorsSeen === 0 ? 'families_for_clean_air_no_html_links'
        : articleUrlsSeen === 0 ? 'families_for_clean_air_no_article_links'
        : 'families_for_clean_air_no_valid_index_candidates');
    }
    return { candidates: [...candidates.values()], items_seen: seen, items_invalid: invalid };
  } finally {
    try { await reader.cancel(); } catch { /* Best-effort cancellation after bounded read. */ }
    reader.releaseLock();
  }
}

export async function discoverFamiliesForCleanAir(source: Source, fetcher: typeof fetch = fetch):
Promise<{ articles: DiscoveredArticle[]; items_seen: number; items_invalid: number }> {
  if (!configuredFamiliesForCleanAirIndex(source)) {
    throw new ScanError('families_for_clean_air_config_mismatch');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let requestUrl = FAMILIES_FOR_CLEAN_AIR_INDEX_URL;
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      try {
        response = await fetcher(requestUrl, {
          redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html' },
        });
      } catch {
        throw new ScanError(controller.signal.aborted
          ? 'families_for_clean_air_timeout' : 'families_for_clean_air_fetch_failed');
      }
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel();
      const next = permittedUrl(response.headers.get('Location'), requestUrl, source);
      if (!next || redirects >= MAX_REDIRECTS || next.search || next.hash ||
          !['/news', '/news/'].includes(next.pathname)) {
        throw new ScanError('families_for_clean_air_redirect_rejected');
      }
      requestUrl = next.href;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`families_for_clean_air_http_${response.status}`);
    }
    const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      await response.body.cancel();
      throw new ScanError('families_for_clean_air_not_html');
    }
    const { candidates, ...counts } = await extractIndex(response, requestUrl, source);
    const articles = await Promise.all(candidates.map(async item => ({
      canonical_url: item.canonical_url,
      canonical_url_hash: await canonicalUrlHash(item.canonical_url),
      original_url: item.original_url,
      title: item.title,
      // The listing has no reliable published dates; never infer one from discovery time.
      published_at: null,
      author: null, categories: [],
      title_context: null, review_excerpt: null, preview_url: item.preview_url,
      display_title: null, display_title_origin: null,
      preview_metadata_checked_at: null,
    })));
    return { articles, ...counts };
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted
      ? 'families_for_clean_air_timeout' : 'families_for_clean_air_read_failed');
  } finally {
    clearTimeout(timeout);
  }
}
