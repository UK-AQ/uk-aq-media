import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

export const CAWS_INDEX_ROUTE_KEY = 'communities-against-woodsmoke-blog-index';
export const CAWS_INDEX_URL = 'https://www.communitiesagainstwoodsmoke.com/blog/';
export const CAWS_MAX_ITEMS = 20;
const INDEX_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LISTING_START = 'Check out the latest blog articles below';
const LISTING_END = 'Other groups campaigning against woodsmoke pollution';

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

function publisherDate(value: string): string | null {
  const match = /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/.exec(text(value));
  if (!match) return null;
  const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'].indexOf(match[2]!.toLowerCase()) + 1;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!month || year < 2000 || year > 2100 || day < 1 || day > 31) return null;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${date}T00:00:00Z`);
  return checked.getUTCFullYear() === year && checked.getUTCMonth() + 1 === month &&
    checked.getUTCDate() === day ? date : null;
}

export function configuredCawsIndex(source: Source): boolean {
  const route = source.discovery_config.routes?.[0];
  return source.source_key === 'communities-against-woodsmoke' &&
    source.name === 'Communities Against Woodsmoke' &&
    source.canonical_domain === 'communitiesagainstwoodsmoke.com' &&
    source.source_type === 'publisher' && source.enabled &&
    source.publication_policy === 'manual' && source.review_level === 'standard' &&
    source.priority === 50 && source.discovery_method === 'sitemap' &&
    source.content_fetch_policy === 'discovery_metadata_only' &&
    source.ai_content_policy === 'metadata_only' && source.image_policy === 'remote_preview' &&
    source.discovery_config.routes?.length === 1 && route?.route_key === CAWS_INDEX_ROUTE_KEY &&
    route.url === CAWS_INDEX_URL && route.max_items === CAWS_MAX_ITEMS &&
    source.discovery_config.retain_excerpt === false;
}

export type CawsIndexCandidate = { canonical_url: string; title: string; published_at: string };

export function extractCawsIndexCandidates(html: string, source: Source): CawsIndexCandidate[] {
  const start = html.toLocaleLowerCase('en-GB').indexOf(LISTING_START.toLowerCase());
  if (start < 0) throw new ScanError('caws_listing_start_missing');
  const end = html.toLocaleLowerCase('en-GB').indexOf(LISTING_END.toLowerCase(), start +
    LISTING_START.length);
  if (end < 0) throw new ScanError('caws_listing_end_missing');
  const region = html.slice(start + LISTING_START.length, end);
  const links = [...region.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  const candidates: CawsIndexCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < links.length && candidates.length < CAWS_MAX_ITEMS; index++) {
    const match = links[index]!;
    const raw = attribute(match[1] ?? '', 'href');
    const title = text(match[2] ?? '');
    if (!raw || !title) continue;
    let canonical: string;
    try {
      const permitted = publisherHttpsUrl(new URL(raw, CAWS_INDEX_URL).href, source);
      if (!permitted || new URL(permitted).pathname === '/blog/') continue;
      canonical = canonicalizeUrl(permitted, source);
    } catch { continue; }
    if (seen.has(canonical)) continue;
    const afterLink = (match.index ?? 0) + match[0].length;
    const beforeNextLink = links[index + 1]?.index ?? region.length;
    const publishedAt = publisherDate(region.slice(afterLink, beforeNextLink));
    if (!publishedAt) continue;
    seen.add(canonical);
    candidates.push({ canonical_url: canonical, title, published_at: publishedAt });
  }
  if (candidates.length === 0) throw new ScanError('caws_no_valid_index_candidates');
  return candidates;
}

async function fetchIndex(source: Source, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = CAWS_INDEX_URL;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' } });
      } catch { throw new ScanError(controller.signal.aborted ? 'caws_timeout' : 'caws_fetch_failed'); }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) throw new ScanError('caws_redirect_rejected');
      let destination: string | null = null;
      try { destination = publisherHttpsUrl(new URL(location, requestUrl).href, source); }
      catch { /* reject */ }
      if (!destination) throw new ScanError('caws_redirect_rejected');
      requestUrl = destination;
      redirects++;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ScanError(`caws_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await response.body.cancel();
      throw new ScanError('caws_not_html');
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
        if (bytes > INDEX_MAX_BYTES) throw new ScanError('caws_html_too_large');
        html += decoder.decode(value, { stream: true });
      }
    } finally { try { await reader.cancel('bounded CAWS index obtained'); } catch { /* best effort */ } }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted ? 'caws_timeout' : 'caws_read_failed');
  } finally { clearTimeout(timeout); }
}

export async function discoverCaws(source: Source, fetcher: typeof fetch = fetch): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (!configuredCawsIndex(source)) throw new ScanError('caws_config_mismatch');
  const candidates = extractCawsIndexCandidates(await fetchIndex(source, fetcher), source);
  const articles = await Promise.all(candidates.map(async candidate => ({
    canonical_url: candidate.canonical_url,
    canonical_url_hash: await canonicalUrlHash(candidate.canonical_url),
    original_url: candidate.canonical_url,
    title: candidate.title,
    author: null,
    published_at: candidate.published_at,
    categories: [],
    title_context: null,
    preview_url: null,
    display_title: null,
    display_title_origin: null,
    preview_metadata_checked_at: null,
  })));
  return { articles, items_seen: candidates.length, items_invalid: 0 };
}
