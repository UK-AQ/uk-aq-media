import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

export const NCAS_TAG_ROUTES = [
  {
    route_key: 'ncas-air-pollution',
    tag: 'air-pollution',
    label: 'Air Pollution',
    url: 'https://ncas.ac.uk/news-events/?category_name=&tag=air-pollution',
    max_items: 20,
  },
  {
    route_key: 'ncas-digital-atmosphere',
    tag: 'digital-atmosphere',
    label: 'Digital Atmosphere',
    url: 'https://ncas.ac.uk/news-events/?category_name=&tag=digital-atmosphere',
    max_items: 20,
  },
  {
    route_key: 'ncas-air-pollutants',
    tag: 'air-pollutants',
    label: 'Air Pollutants',
    url: 'https://ncas.ac.uk/news-events/?category_name=&tag=air-pollutants',
    max_items: 20,
  },
] as const;

export type NcasRouteKey = typeof NCAS_TAG_ROUTES[number]['route_key'];

const INDEX_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const EXCLUDED_ROOT_SLUGS = new Set([
  'about', 'contact', 'events', 'learn', 'news-events', 'our-science', 'privacy-policy',
  'science', 'terms-and-conditions',
]);

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

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${candidate}T00:00:00Z`);
  return checked.getUTCFullYear() === year && checked.getUTCMonth() + 1 === month &&
    checked.getUTCDate() === day ? candidate : null;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

type DateOccurrence = { index: number; value: string };

function dateOccurrences(html: string): DateOccurrence[] {
  const found: DateOccurrence[] = [];
  const monthFirst = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/gi;
  for (const match of html.matchAll(monthFirst)) {
    const month = MONTH_NAMES.indexOf(match[1]!.toLowerCase()) + 1;
    const value = isoDate(Number(match[3]), month, Number(match[2]));
    if (value && match.index !== undefined) found.push({ index: match.index, value });
  }
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;
  for (const match of html.matchAll(dayFirst)) {
    const month = MONTH_NAMES.indexOf(match[2]!.toLowerCase()) + 1;
    const value = isoDate(Number(match[3]), month, Number(match[1]));
    if (value && match.index !== undefined) found.push({ index: match.index, value });
  }
  return found.sort((left, right) => left.index - right.index);
}

function dateIndexBefore(dates: DateOccurrence[], index: number): number {
  let result = -1;
  for (let cursor = 0; cursor < dates.length; cursor++) {
    if (dates[cursor]!.index > index) break;
    result = cursor;
  }
  return result;
}

function routeFor(routeKey: NcasRouteKey) {
  return NCAS_TAG_ROUTES.find(route => route.route_key === routeKey)!;
}

function exactConfiguredSource(source: Source): boolean {
  const routes = source.discovery_config.routes;
  return source.source_key === 'ncas' && source.name === 'NCAS' &&
    source.canonical_domain === 'ncas.ac.uk' && source.source_type === 'publisher' &&
    source.enabled && source.publication_policy === 'manual' && source.review_level === 'standard' &&
    source.priority === 50 && source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'article_head_allowed' && source.ai_content_policy === 'disabled' &&
    source.image_policy === 'remote_preview' && source.search_index_policy === 'metadata_only' &&
    source.discovery_config.retain_excerpt === false && routes?.length === NCAS_TAG_ROUTES.length &&
    NCAS_TAG_ROUTES.every((expected, index) => {
      const configured = routes[index];
      return configured?.route_key === expected.route_key && configured.url === expected.url &&
        configured.max_items === expected.max_items;
    });
}

export function configuredNcasRouteKeys(source: Source): NcasRouteKey[] {
  return exactConfiguredSource(source) ? NCAS_TAG_ROUTES.map(route => route.route_key) : [];
}

function permittedRouteUrl(raw: string, source: Source,
  route: typeof NCAS_TAG_ROUTES[number]): string | null {
  const permitted = publisherHttpsUrl(raw, source);
  if (!permitted) return null;
  const url = new URL(permitted);
  if (url.pathname !== '/news-events/' || url.hash ||
      url.searchParams.getAll('tag').length !== 1 ||
      url.searchParams.get('tag') !== route.tag ||
      url.searchParams.getAll('category_name').some(value => value !== '') ||
      [...url.searchParams.keys()].some(key => key !== 'tag' && key !== 'category_name')) return null;
  return url.href;
}

function blockAllowedTags(block: string): string[] {
  return NCAS_TAG_ROUTES.filter(route =>
    block.includes(`tag=${route.tag}`) || block.includes(`/tag/${route.tag}`))
    .map(route => route.label);
}

export type NcasIndexCandidate = {
  canonical_url: string;
  title: string;
  published_at: string;
  categories: string[];
};

export function extractNcasIndexCandidates(html: string, source: Source,
  routeKey: NcasRouteKey): NcasIndexCandidate[] {
  if (!configuredNcasRouteKeys(source).includes(routeKey)) throw new ScanError('ncas_config_mismatch');
  const route = routeFor(routeKey);
  const dates = dateOccurrences(html);
  const candidates: NcasIndexCandidate[] = [];
  const seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  for (const anchor of anchors) {
    if (candidates.length >= route.max_items || anchor.index === undefined) break;
    const raw = attribute(anchor[1] ?? '', 'href');
    const title = text(anchor[2] ?? '');
    if (!raw || title.length < 8 || title.length > 500 ||
        /^(?:read|find|learn|view|see)\s+(?:more|all)\b/i.test(title)) continue;

    let canonical: string;
    try {
      const permitted = publisherHttpsUrl(new URL(raw, route.url).href, source);
      if (!permitted) continue;
      const articleUrl = new URL(permitted);
      const segments = articleUrl.pathname.split('/').filter(Boolean);
      if (segments.length !== 1 || EXCLUDED_ROOT_SLUGS.has(segments[0]!.toLowerCase())) continue;
      canonical = canonicalizeUrl(permitted, source);
    } catch { continue; }
    if (seen.has(canonical)) continue;

    const currentDateIndex = dateIndexBefore(dates, anchor.index);
    if (currentDateIndex < 0) continue;
    const date = dates[currentDateIndex]!;
    if (anchor.index - date.index > 2_500) continue;
    const nextDate = dates[currentDateIndex + 1];
    const blockEnd = nextDate?.index ?? Math.min(html.length, anchor.index + 4_000);
    if (blockEnd <= anchor.index || blockEnd - date.index > 8_000) continue;
    const block = html.slice(date.index, blockEnd);
    const categories = blockAllowedTags(block);
    if (!categories.includes(route.label)) continue;

    seen.add(canonical);
    candidates.push({ canonical_url: canonical, title, published_at: date.value, categories });
  }
  if (candidates.length === 0) throw new ScanError('ncas_no_valid_index_candidates');
  return candidates;
}

async function fetchIndex(source: Source, routeKey: NcasRouteKey,
  fetcher: typeof fetch): Promise<string> {
  const route = routeFor(routeKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = route.url;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/UK-AQ/uk-aq-media)' } });
      } catch { throw new ScanError(controller.signal.aborted ? 'ncas_timeout' : 'ncas_fetch_failed'); }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) throw new ScanError('ncas_redirect_rejected');
      let destination: string | null = null;
      try { destination = permittedRouteUrl(new URL(location, requestUrl).href, source, route); }
      catch { /* reject */ }
      if (!destination) throw new ScanError('ncas_redirect_rejected');
      requestUrl = destination;
      redirects++;
    }
    if (!permittedRouteUrl(requestUrl, source, route)) {
      await response.body?.cancel();
      throw new ScanError('ncas_route_scope_lost');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`ncas_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await response.body.cancel();
      throw new ScanError('ncas_not_html');
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
        if (bytes > INDEX_MAX_BYTES) throw new ScanError('ncas_html_too_large');
        html += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel('bounded NCAS tag index obtained'); } catch { /* best effort */ }
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted ? 'ncas_timeout' : 'ncas_read_failed');
  } finally { clearTimeout(timeout); }
}

export async function discoverNcas(source: Source, routeKey: NcasRouteKey,
  fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (!configuredNcasRouteKeys(source).includes(routeKey)) throw new ScanError('ncas_config_mismatch');
  const candidates = extractNcasIndexCandidates(await fetchIndex(source, routeKey, fetcher),
    source, routeKey);
  const articles = await Promise.all(candidates.map(async candidate => ({
    canonical_url: candidate.canonical_url,
    canonical_url_hash: await canonicalUrlHash(candidate.canonical_url),
    original_url: candidate.canonical_url,
    title: candidate.title,
    author: null,
    published_at: candidate.published_at,
    categories: candidate.categories,
    title_context: null,
    preview_url: null,
    display_title: null,
    display_title_origin: null,
    preview_metadata_checked_at: null,
  })));
  return { articles, items_seen: candidates.length, items_invalid: 0 };
}
