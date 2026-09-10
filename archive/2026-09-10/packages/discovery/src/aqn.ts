import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl, remotePreviewUrl, z,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';

export const AQN_FEED = 'https://airqualitynews.com/feed/';
const MAX_FEED_BYTES = 1024 * 1024;
const MAX_HEAD_BYTES = 256 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function text(value: unknown, maximum: number): string | null {
  const raw = typeof value === 'string' ? value : record(value)['#text'];
  return typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').trim().slice(0, maximum) || null : null;
}

export class ScanError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const hexadecimal = key[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try { return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity; }
    catch { return entity; }
  });
}

function normaliseMetadataText(value: string): string {
  return decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function metaAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const expression = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(expression)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined) attributes.set(name, value);
  }
  return attributes;
}

function extractHeadMetadata(htmlHead: string): {
  ogImage: string | null;
  twitterImage: string | null;
  ogTitle: string | null;
  twitterTitle: string | null;
} {
  const metadata = new Map<string, string>();
  for (const tag of htmlHead.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = metaAttributes(tag);
    const name = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (name && content && !metadata.has(name)) metadata.set(name, content);
  }
  const title = (name: string): string | null => {
    const value = metadata.get(name);
    return value ? normaliseMetadataText(value) || null : null;
  };
  return {
    ogImage: metadata.get('og:image') ?? null,
    twitterImage: metadata.get('twitter:image') ?? null,
    ogTitle: title('og:title'),
    twitterTitle: title('twitter:title'),
  };
}

function compactPublisherTitle(originalTitle: string,
  candidates: Array<string | null>): string | null {
  const original = normaliseMetadataText(originalTitle);
  const comparableOriginal = original.toLocaleLowerCase('en-GB');
  for (const candidateValue of candidates) {
    if (!candidateValue) continue;
    const candidate = normaliseMetadataText(candidateValue);
    if (candidate.length < 5 || candidate.length >= original.length ||
        candidate.toLocaleLowerCase('en-GB') === comparableOriginal) continue;
    return candidate;
  }
  return null;
}

async function readHtmlHead(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new ScanError('article_head_missing_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let html = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new ScanError('article_head_incomplete');
      bytes += value.byteLength;
      if (bytes > MAX_HEAD_BYTES) throw new ScanError('article_head_too_large');
      html += decoder.decode(value, { stream: true });
      const closingHead = /<\/head\s*>/i.exec(html);
      if (closingHead) return html.slice(0, closingHead.index + closingHead[0].length);
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    if (signal.aborted) throw new ScanError('article_head_timeout');
    throw new ScanError('article_head_read_failed');
  } finally {
    try { await reader.cancel('HTML head obtained or rejected'); } catch { /* best effort */ }
  }
}

export async function discoverAqnPreviewMetadata(article: DiscoveredArticle,
  source: Source): Promise<Pick<DiscoveredArticle, 'preview_url' | 'display_title' |
    'display_title_origin' | 'preview_metadata_checked_at'>> {
  if (source.source_key !== 'air-quality-news' ||
      source.content_fetch_policy !== 'article_head_allowed') {
    throw new ScanError('article_head_not_permitted');
  }
  const articleUrl = publisherHttpsUrl(article.canonical_url, source.canonical_domain);
  if (!articleUrl) throw new ScanError('invalid_article_head_url');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(articleUrl, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
        },
      });
    } catch {
      throw new ScanError(controller.signal.aborted ? 'article_head_timeout' : 'article_head_fetch_failed');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ScanError('article_head_redirect');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ScanError(`article_head_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await response.body?.cancel();
      throw new ScanError('article_head_not_html');
    }
    const metadata = extractHeadMetadata(await readHtmlHead(response, controller.signal));
    const preview = [metadata.ogImage, metadata.twitterImage]
      .map(value => remotePreviewUrl(value, source.canonical_domain)).find(Boolean) ?? null;
    const displayTitle = compactPublisherTitle(article.title,
      [metadata.ogTitle, metadata.twitterTitle]);
    return {
      preview_url: preview,
      display_title: displayTitle,
      display_title_origin: displayTitle ? 'publisher' : null,
      preview_metadata_checked_at: new Date().toISOString(),
    };
  } finally { clearTimeout(timeout); }
}

type FeedFetchPhase = 'fetch_request' | 'feed_stream_read';

function logUnexpectedFeedError(phase: FeedFetchPhase, error: unknown): void {
  const errorName = error instanceof Error && error.name ? error.name : 'NonErrorThrown';
  const errorMessage = error instanceof Error
    ? error.message
    : `Unexpected thrown value of type ${typeof error}`;
  console.error(JSON.stringify({
    event: 'aqn_feed_fetch_error',
    phase,
    error_name: errorName.slice(0, 100),
    error_message: errorMessage.slice(0, 500),
  }));
}

async function readFeed(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = await fetch(AQN_FEED, {
        redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ScanError('feed_timeout');
      logUnexpectedFeedError('fetch_request', error);
      throw new ScanError('feed_fetch_failed');
    }

    try {
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ScanError(`feed_http_${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      let bytes = 0;
      let xml = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_FEED_BYTES) throw new ScanError('feed_too_large');
          xml += decoder.decode(value, { stream: true });
        }
        return xml + decoder.decode();
      } finally { await reader.cancel(); }
    } catch (error) {
      if (error instanceof ScanError) throw error;
      if (controller.signal.aborted) throw new ScanError('feed_timeout');
      logUnexpectedFeedError('feed_stream_read', error);
      throw new ScanError('feed_fetch_failed');
    }
  } finally { clearTimeout(timeout); }
}

export async function discoverAqn(source: Source): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (source.source_key !== 'air-quality-news' || source.discovery_method !== 'rss' ||
      source.discovery_config.url !== AQN_FEED || source.canonical_domain !== 'airqualitynews.com') {
    throw new ScanError('aqn_config_mismatch');
  }
  // This adapter entry point fetches only the configured feed. The source-scan
  // persistence layer separately requests missing, policy-permitted head metadata.
  return parseAqnFeed(await readFeed(), source);
}

export async function parseAqnFeed(xml: string, source: Source): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (new TextEncoder().encode(xml).byteLength > MAX_FEED_BYTES ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new ScanError('invalid_rss');
  }
  const parser = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    htmlEntities: true, maxNestedTags: 32,
    isArray: name => ['item', 'category', 'media:content', 'media:thumbnail', 'enclosure'].includes(name),
    updateTag: name => ['description', 'content:encoded'].includes(name) ? false : name,
  });
  let parsed: unknown;
  try { parsed = parser.parse(xml); } catch { throw new ScanError('invalid_rss'); }
  const channel = record(record(parsed).rss).channel;
  if (!channel || typeof channel !== 'object') throw new ScanError('missing_rss_channel');
  const items = list(record(channel).item).slice(0, source.discovery_config.max_items ?? 20);
  const articles: DiscoveredArticle[] = [];
  let invalid = 0;
  for (const value of items) {
    const item = record(value);
    const title = text(item.title, 1000);
    const guid = record(item.guid);
    const rawUrl = text(item.link, 2048) ??
      (guid['@_isPermaLink'] !== 'false' ? text(item.guid, 2048) : null);
    if (!title || !rawUrl || !z.url().safeParse(rawUrl).success) { invalid++; continue; }
    let canonical: string;
    try { canonical = canonicalizeUrl(rawUrl, source.canonical_domain); }
    catch { invalid++; continue; }
    const date = text(item.pubDate, 100);
    const dateMs = date ? Date.parse(date) : NaN;
    const previews = [
      ...list(item['media:thumbnail']),
      ...list(item['media:content']).filter(v => {
        const metadata = record(v);
        return metadata['@_medium'] === 'image' || String(metadata['@_type']).startsWith('image/');
      }),
      ...list(item.enclosure).filter(v => String(record(v)['@_type']).startsWith('image/')),
    ];
    const preview = source.image_policy === 'remote_preview' ? previews
      .map(v => remotePreviewUrl(record(v)['@_url'], source.canonical_domain)).find(Boolean) ?? null : null;
    articles.push({ canonical_url: canonical, canonical_url_hash: await canonicalUrlHash(canonical),
      original_url: rawUrl, title, author: text(item['dc:creator'], 300),
      published_at: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
      categories: list(item.category).map(v => text(v, 100)).filter((v): v is string => v !== null).slice(0, 20),
      preview_url: preview, display_title: null, display_title_origin: null,
      preview_metadata_checked_at: null });
  }
  return { articles, items_seen: items.length, items_invalid: invalid };
}
