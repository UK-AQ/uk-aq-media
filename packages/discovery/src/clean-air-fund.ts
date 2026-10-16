import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

// Clean Air Fund publishes news and blogs together on its own first-party index.
// It has no verified RSS endpoint. Only news-item links on this bounded index are eligible.
export const CLEAN_AIR_FUND_INDEX_ROUTE_KEY = 'clean-air-fund-news';
export const CLEAN_AIR_FUND_INDEX_URL = 'https://www.cleanairfund.org/news/';
export const CLEAN_AIR_FUND_MAX_ITEMS = 20;
const INDEX_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function decode(value: string): string {
  const entities: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? entity;
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : entity; }
    catch { return entity; }
  });
}

function plainText(value: string): string {
  return decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attribute(value: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(value);
  return match ? decode(match[1] ?? match[2] ?? '') : null;
}

function publicationDate(value: string): { date: string; category: 'News' | 'Blog' } | null {
  const match = /\b(News|Blog)\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i.exec(value);
  if (!match) return null;
  const year = Number(match[4]);
  const month = MONTHS.indexOf(match[3]!.toLowerCase()) + 1;
  const day = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || day < 1 || day > 31) return null;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${date}T00:00:00Z`);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month ||
      checked.getUTCDate() !== day) return null;
  return { date, category: match[1]!.toLowerCase() === 'blog' ? 'Blog' : 'News' };
}

export function configuredCleanAirFundIndex(source: Source): boolean {
  const route = source.discovery_config.routes?.[0];
  return source.source_key === 'clean-air-fund' && source.name === 'Clean Air Fund' &&
    source.canonical_domain === 'cleanairfund.org' && source.source_type === 'publisher' &&
    source.enabled && source.publication_policy === 'manual' &&
    source.review_level === 'standard' && source.priority === 50 &&
    source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'discovery_metadata_only' &&
    source.ai_content_policy === 'disabled' &&
    source.image_policy === 'remote_preview' && source.search_index_policy === 'metadata_only' &&
    source.discovery_config.retain_excerpt === false &&
    source.discovery_config.routes?.length === 1 &&
    route?.route_key === CLEAN_AIR_FUND_INDEX_ROUTE_KEY &&
    route.url === CLEAN_AIR_FUND_INDEX_URL && route.max_items === CLEAN_AIR_FUND_MAX_ITEMS;
}

export type CleanAirFundIndexCandidate = {
  canonical_url: string; title: string; published_at: string; categories: string[];
};

// Publisher cards may separate their linked image, heading and date into sibling
// elements. Walk only the bounded HTML already fetched and find the smallest
// enclosing element holding one article identity, a heading and a date.
type IndexElement = {
  tag: string; start: number; end: number; opening: string; parent: number | null;
};
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);
const MAX_CARD_HTML_BYTES = 12 * 1024;

function indexElements(html: string): IndexElement[] {
  const nodes: IndexElement[] = [];
  const stack: number[] = [];
  const tags = /<(\/?)([a-z][a-z0-9:-]*)\b[^>]*>/gi;
  for (const token of html.matchAll(tags)) {
    const tag = token[2]!.toLowerCase();
    if (token[1] === '/') {
      let match = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (nodes[stack[i]!]!.tag === tag) { match = i; break; }
      }
      if (match < 0) continue;
      for (let i = stack.length - 1; i >= match; i--) {
        nodes[stack[i]!]!.end = i === match ? token.index + token[0].length : token.index;
      }
      stack.length = match;
    } else if (!VOID_HTML_TAGS.has(tag) && !token[0].endsWith('/>')) {
      nodes.push({ tag, start: token.index, end: html.length,
        opening: token[0], parent: stack.at(-1) ?? null });
      stack.push(nodes.length - 1);
    }
  }
  return nodes;
}

function cardTitle(fragment: string, anchorOpening: string): string | null {
  // Heading elements are the first choice. Some publisher card variants use
  // a classed text element rather than a semantic heading.
  const headings = [...fragment.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .map(match => plainText(match[2] ?? ''));
  for (const heading of headings) {
    if (heading.length >= 8 && heading.length <= 300) return heading;
  }
  for (const element of fragment.matchAll(
    /<(p|span|div)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
  )) {
    const classes = attribute(element[2] ?? '', 'class') ?? '';
    if (!/(?:title|heading)/i.test(classes)) continue;
    const title = plainText(element[3] ?? '');
    if (title.length >= 8 && title.length <= 300) return title;
  }
  const label = attribute(anchorOpening, 'aria-label');
  return label && label.length >= 8 && label.length <= 300 ? label : null;
}

function candidateFromCard(fragment: string, anchorOpening: string,
  canonical: string, source: Source): CleanAirFundIndexCandidate | null {
  // Never use dates or titles from a listing section that contains a different
  // news-item URL. Repeated links to the same article are harmless.
  for (const anchor of fragment.matchAll(/<a\b([^>]*)>/gi)) {
    const raw = attribute(anchor[1] ?? '', 'href');
    if (!raw) continue;
    let link: string | null = null;
    try {
      const permitted = publisherHttpsUrl(new URL(raw, CLEAN_AIR_FUND_INDEX_URL).href, source);
      if (permitted) {
        const url = new URL(permitted);
        if (/^\/news-item\/[a-z0-9-]+\/$/i.test(url.pathname) && !url.search && !url.hash) {
          link = canonicalizeUrl(permitted, source);
        }
      }
    } catch { /* The existing publisher and canonicalisation boundaries reject this link. */ }
    if (link !== null && link !== canonical) return null;
  }
  const dated = publicationDate(plainText(fragment));
  const title = cardTitle(fragment, anchorOpening);
  if (!dated || !title) return null;
  return { canonical_url: canonical, title, published_at: dated.date,
    categories: [dated.category] };
}

export function extractCleanAirFundIndexCandidates(html: string,
  source: Source): CleanAirFundIndexCandidate[] {
  if (!configuredCleanAirFundIndex(source)) throw new ScanError('clean_air_fund_config_mismatch');
  // Script and style contents are not publisher cards. Preserve offsets while
  // masking them to keep the element scan confined to real markup.
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    value => ' '.repeat(value.length));
  const elements = indexElements(markup);
  const candidates: CleanAirFundIndexCandidate[] = [];
  const seen = new Set<string>();
  for (let anchorIndex = 0; anchorIndex < elements.length; anchorIndex++) {
    if (candidates.length >= CLEAN_AIR_FUND_MAX_ITEMS) break;
    const anchor = elements[anchorIndex]!;
    if (anchor.tag !== 'a') continue;
    const href = attribute(anchor.opening, 'href');
    if (!href) continue;
    let canonical: string;
    try {
      const permitted = publisherHttpsUrl(new URL(href, CLEAN_AIR_FUND_INDEX_URL).href, source);
      if (!permitted) continue;
      const url = new URL(permitted);
      if (!/^\/news-item\/[a-z0-9-]+\/$/i.test(url.pathname) || url.search || url.hash) continue;
      canonical = canonicalizeUrl(permitted, source);
    } catch { continue; }
    if (seen.has(canonical)) continue;
    for (let index: number | null = anchorIndex; index !== null;
      index = elements[index]!.parent) {
      const element = elements[index]!;
      if (element.end - element.start > MAX_CARD_HTML_BYTES) break;
      const candidate = candidateFromCard(markup.slice(element.start, element.end),
        anchor.opening, canonical, source);
      if (!candidate) continue;
      seen.add(canonical);
      candidates.push(candidate);
      break;
    }
  }
  if (candidates.length === 0) throw new ScanError('clean_air_fund_no_valid_index_candidates');
  return candidates;
}

function permittedIndexUrl(raw: string, source: Source): string | null {
  const allowed = publisherHttpsUrl(raw, source);
  if (!allowed) return null;
  const url = new URL(allowed);
  return url.pathname === '/news/' && !url.search && !url.hash ? url.href : null;
}

async function fetchIndex(source: Source, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = CLEAN_AIR_FUND_INDEX_URL;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/UK-AQ/uk-aq-media)' } });
      } catch {
        throw new ScanError(controller.signal.aborted
          ? 'clean_air_fund_timeout' : 'clean_air_fund_fetch_failed');
      }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new ScanError('clean_air_fund_redirect_rejected');
      }
      let next: string | null = null;
      try { next = permittedIndexUrl(new URL(location, requestUrl).href, source); }
      catch { /* reject */ }
      if (!next) throw new ScanError('clean_air_fund_redirect_rejected');
      requestUrl = next;
      redirects++;
    }
    if (!permittedIndexUrl(requestUrl, source)) {
      await response.body?.cancel();
      throw new ScanError('clean_air_fund_route_scope_lost');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`clean_air_fund_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await response.body.cancel();
      throw new ScanError('clean_air_fund_not_html');
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
        if (bytes > INDEX_MAX_BYTES) throw new ScanError('clean_air_fund_html_too_large');
        html += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel('bounded Clean Air Fund index obtained'); }
      catch { /* best effort */ }
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted
      ? 'clean_air_fund_timeout' : 'clean_air_fund_read_failed');
  } finally { clearTimeout(timeout); }
}

export async function discoverCleanAirFund(source: Source,
  fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  const candidates = extractCleanAirFundIndexCandidates(await fetchIndex(source, fetcher), source);
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
