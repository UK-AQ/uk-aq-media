import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  canonicalizeUrl, canonicalUrlHash, remotePreviewUrl, z,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';

export const AQN_FEED = 'https://airqualitynews.com/feed/';
const MAX_FEED_BYTES = 1024 * 1024;
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
        redirect: 'error', signal: controller.signal,
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
  // Only the configured feed is fetched. Article head/body policies grant no extra activity here.
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
      preview_url: preview });
  }
  return { articles, items_seen: items.length, items_invalid: invalid };
}
