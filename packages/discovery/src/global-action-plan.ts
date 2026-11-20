import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { decodeHtmlEntities, normaliseMetadataText } from './article-head-metadata';
import { ScanError } from './rss';

export const GLOBAL_ACTION_PLAN_SOURCE_KEY = 'global-action-plan';
export const GLOBAL_ACTION_PLAN_INDEX_ROUTE_KEY = 'global-action-plan-news';
const INDEX_URL = 'https://www.globalactionplan.org.uk/latest/news';
const PUBLISHER_DOMAIN = 'globalactionplan.org.uk';
const NEWS_PATH = '/latest/news';
const MAX_ITEMS = 20;
const INDEX_MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const AIR_QUALITY_TAGS = new Set([
  'clean air', 'clean air day', 'clean air night', 'domestic burning', 'breathe london',
]);

export function configuredGlobalActionPlanIndex(source: Source): boolean {
  const routes = source.discovery_config.routes;
  const route = routes?.[0];
  return source.source_key === GLOBAL_ACTION_PLAN_SOURCE_KEY &&
    source.canonical_domain === PUBLISHER_DOMAIN && source.source_type === 'publisher' &&
    source.enabled && source.publication_policy === 'manual' &&
    source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'discovery_metadata_only' &&
    source.ai_content_policy === 'disabled' && source.search_index_policy === 'metadata_only' &&
    source.discovery_config.retain_excerpt === false && routes?.length === 1 &&
    route?.route_key === GLOBAL_ACTION_PLAN_INDEX_ROUTE_KEY &&
    route.url === INDEX_URL && route.max_items === MAX_ITEMS;
}

export function hasGlobalActionPlanAirQualityTag(categories: string[]): boolean {
  return categories.some(tag => AIR_QUALITY_TAGS.has(
    tag.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
  ));
}

function resolveUrl(raw: string | null, base: string): string | null {
  if (!raw?.trim() || raw.length > 2048) return null;
  try { return new URL(raw, base).href; }
  catch { return null; }
}

function publisherUrl(raw: string | null, base: string, source: Source): URL | null {
  const permitted = publisherHttpsUrl(resolveUrl(raw, base), source);
  if (permitted === null) return null;
  const url = new URL(permitted);
  return url.hostname === PUBLISHER_DOMAIN || url.hostname === `www.${PUBLISHER_DOMAIN}`
    ? url : null;
}

function publicationDate(raw: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})$/.exec(normaliseMetadataText(raw));
  if (!match) return null;
  const day = match[1]!;
  const month = match[2]!;
  const year = match[3]!;
  const date = `${year.length === 2 ? '20' + year : year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const checked = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(checked.getTime()) && checked.toISOString().startsWith(date) ? date : null;
}

type Card = {
  links: Map<string, string>;
  title: string;
  date: string;
  tags: Set<string>;
  preview: string | null;
};
type Candidate = Omit<DiscoveredArticle, 'canonical_url_hash'>;
const CARD = 'article.news_listing_each';
const IMAGE = `${CARD} .news_listing_each_image`;
const ARTICLE_PATH = /^\/latest\/news\/[a-z0-9-]+\/?$/;

async function readCards(response: Response, baseUrl: string, source: Source): Promise<{
  candidates: Candidate[]; items_seen: number; items_invalid: number;
}> {
  const candidates: Candidate[] = [];
  let seen = 0;
  let invalid = 0;
  let card: Card | null = null;
  let tagText = '';
  const rewriter = new HTMLRewriter()
    .on(CARD, {
      element(element) {
        if (seen >= MAX_ITEMS || card) return;
        const current: Card = { links: new Map(), title: '', date: '', tags: new Set(), preview: null };
        card = current;
        element.onEndTag(() => {
          card = null;
          seen++;
          const title = normaliseMetadataText(current.title);
          const date = publicationDate(current.date);
          const link = current.links.entries().next().value;
          if (!title || !date || current.links.size !== 1 || !link) {
            invalid++;
            return;
          }
          candidates.push({
            canonical_url: link[0], original_url: link[1], title, published_at: date,
            categories: [...current.tags],
            author: null, title_context: null, preview_url: current.preview,
            display_title: null, display_title_origin: null, preview_metadata_checked_at: null,
          });
        });
      },
    })
    .on(`${CARD} a[href]`, {
      element(element) {
        if (!card) return;
        const href = element.getAttribute('href');
        const url = publisherUrl(href === null ? null : decodeHtmlEntities(href), baseUrl, source);
        if (!url || !ARTICLE_PATH.test(url.pathname)) return;
        const canonical = canonicalizeUrl(url.href, source);
        if (!new URL(canonical).search && !card.links.has(canonical)) {
          card.links.set(canonical, url.href);
        }
      },
    })
    .on(`${CARD} .news_listing_each_title`, {
      text(chunk) { if (card) card.title += chunk.text; },
    })
    .on(`${CARD} .news_listing_each_date`, {
      text(chunk) { if (card) card.date += chunk.text; },
    })
    .on(`${CARD} .news_listing_each_tags a`, {
      element(element) {
        if (!card) return;
        const tags = card.tags;
        tagText = '';
        element.onEndTag(() => {
          const tag = normaliseMetadataText(tagText);
          if (tag) tags.add(tag);
        });
      },
      text(chunk) { if (card) tagText += chunk.text; },
    })
    .on(`${IMAGE}, ${IMAGE} img`, {
      element(element) {
        if (!card || card.preview || source.image_policy !== 'remote_preview') return;
        const style = decodeHtmlEntities(element.getAttribute('style') ?? '');
        const background = /(?:^|;)\s*background(?:-image)?\s*:\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/i.exec(style);
        for (const raw of [
          decodeHtmlEntities(element.getAttribute('data-src') ?? ''),
          decodeHtmlEntities(element.getAttribute('src') ?? ''),
          background?.[1] ?? background?.[2] ?? background?.[3] ?? null,
        ]) {
          const preview = remotePreviewUrl(resolveUrl(raw, baseUrl), source);
          if (preview) {
            card.preview = preview;
            break;
          }
        }
      },
    });

  const reader = response.body!.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (seen >= MAX_ITEMS || bytes >= INDEX_MAX_BYTES) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const prefix = value.subarray(0, INDEX_MAX_BYTES - bytes);
      bytes += prefix.byteLength;
      controller.enqueue(prefix);
    },
  }, { highWaterMark: 0 });
  try {
    // Drive the parser with backpressure. After the twentieth closing tag the
    // next pull closes this stream without reading another upstream chunk.
    const html = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    await rewriter.transform(html).body!.pipeTo(new WritableStream());
    if (seen < MAX_ITEMS && bytes >= INDEX_MAX_BYTES) {
      throw new ScanError('global_action_plan_html_too_large');
    }
    if (!candidates.length) throw new ScanError('global_action_plan_no_valid_index_candidates');
    return { candidates, items_seen: seen, items_invalid: invalid };
  } finally {
    try { await reader.cancel(); } catch { /* The upstream body may already be closed. */ }
    reader.releaseLock();
  }
}

export async function discoverGlobalActionPlan(source: Source, fetcher: typeof fetch = fetch):
Promise<{ articles: DiscoveredArticle[]; items_seen: number; items_invalid: number }> {
  if (!configuredGlobalActionPlanIndex(source)) {
    throw new ScanError('global_action_plan_config_mismatch');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let requestUrl = INDEX_URL;
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      try {
        response = await fetcher(requestUrl, {
          redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html' },
        });
      } catch (error) {
        if (error instanceof ScanError) throw error;
        throw new ScanError(controller.signal.aborted
          ? 'global_action_plan_timeout' : 'global_action_plan_fetch_failed');
      }
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel();
      const next = publisherUrl(response.headers.get('Location'), requestUrl, source);
      if (redirects >= MAX_REDIRECTS || !next || next.search || next.hash ||
          (next.pathname !== NEWS_PATH && next.pathname !== `${NEWS_PATH}/`)) {
        throw new ScanError('global_action_plan_redirect_rejected');
      }
      requestUrl = next.href;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`global_action_plan_http_${response.status}`);
    }
    if (response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html') {
      await response.body.cancel();
      throw new ScanError('global_action_plan_not_html');
    }
    const { candidates, ...counts } = await readCards(response, requestUrl, source);
    const articles = await Promise.all(candidates.map(async candidate => ({
      ...candidate, canonical_url_hash: await canonicalUrlHash(candidate.canonical_url),
    })));
    return { articles, ...counts };
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted
      ? 'global_action_plan_timeout' : 'global_action_plan_read_failed');
  } finally {
    clearTimeout(timeout);
  }
}
