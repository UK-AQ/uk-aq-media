import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const MAX_FEED_BYTES = 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function text(value: unknown, maximum: number): string | null {
  const raw = typeof value === 'string' ? value : record(value)['#text'];
  return typeof raw === 'string'
    ? raw.replace(/<[^>]*>/g, '').trim().slice(0, maximum) || null
    : null;
}

export class ScanError extends Error {
  constructor(public readonly code: string) { super(code); }
}

type FeedFetchPhase = 'fetch_request' | 'feed_stream_read';

function logUnexpectedFeedError(adapterKey: string, phase: FeedFetchPhase, error: unknown): void {
  const errorName = error instanceof Error && error.name ? error.name : 'NonErrorThrown';
  const errorMessage = error instanceof Error
    ? error.message
    : `Unexpected thrown value of type ${typeof error}`;
  console.error(JSON.stringify({
    event: `${adapterKey}_feed_fetch_error`,
    phase,
    error_name: errorName.slice(0, 100),
    error_message: errorMessage.slice(0, 500),
  }));
}

export async function readRssFeed(url: string, adapterKey: string,
  allowedManualRedirectUrl?: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  const request = (requestUrl: string): Promise<Response> => fetch(requestUrl, {
    redirect: 'manual', signal: controller.signal,
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
    },
  });
  try {
    let response: Response;
    try {
      response = await request(url);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        let resolvedLocation: string | null = null;
        try { resolvedLocation = location ? new URL(location, url).href : null; } catch { /* reject */ }
        if (!allowedManualRedirectUrl || resolvedLocation !== allowedManualRedirectUrl) {
          throw new ScanError('feed_redirect_rejected');
        }
        response = await request(allowedManualRedirectUrl);
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new ScanError('feed_redirect_chain_rejected');
        }
      }
    } catch (error) {
      if (error instanceof ScanError) throw error;
      if (controller.signal.aborted) throw new ScanError('feed_timeout');
      logUnexpectedFeedError(adapterKey, 'fetch_request', error);
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
      logUnexpectedFeedError(adapterKey, 'feed_stream_read', error);
      throw new ScanError('feed_fetch_failed');
    }
  } finally { clearTimeout(timeout); }
}

export interface ParsedRssItem {
  title: string;
  raw_url: string;
  author: string | null;
  published_at: string | null;
  categories: string[];
  preview_candidates: unknown[];
}

export function parseRssItems(xml: string, maxItems: number): {
  items: ParsedRssItem[];
  items_seen: number;
  items_invalid: number;
} {
  if (new TextEncoder().encode(xml).byteLength > MAX_FEED_BYTES ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new ScanError('invalid_rss');
  }
  const parser = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    htmlEntities: true, maxNestedTags: 32,
    isArray: name => ['item', 'category', 'dc:creator', 'media:content',
      'media:thumbnail', 'enclosure'].includes(name),
    updateTag: name => ['description', 'content:encoded'].includes(name) ? false : name,
  });
  let parsed: unknown;
  try { parsed = parser.parse(xml); } catch { throw new ScanError('invalid_rss'); }
  const channel = record(record(parsed).rss).channel;
  if (!channel || typeof channel !== 'object') throw new ScanError('missing_rss_channel');
  const rawItems = list(record(channel).item).slice(0, maxItems);
  const items: ParsedRssItem[] = [];
  let invalid = 0;
  for (const value of rawItems) {
    const item = record(value);
    const title = text(item.title, 1000);
    const guid = record(item.guid);
    const rawUrl = text(item.link, 2048) ??
      (guid['@_isPermaLink'] !== 'false' ? text(item.guid, 2048) : null);
    if (!title || !rawUrl) { invalid++; continue; }
    const date = text(item.pubDate, 100) ?? text(item['dc:date'], 100);
    const dateMs = date ? Date.parse(date) : NaN;
    const creators = list(item['dc:creator'])
      .map(value => text(value, 300)).filter((value): value is string => value !== null);
    items.push({
      title,
      raw_url: rawUrl,
      author: creators.length ? creators.join(' and ').slice(0, 300) : null,
      published_at: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
      categories: list(item.category).map(value => text(value, 100))
        .filter((category): category is string => category !== null).slice(0, 20),
      preview_candidates: [
        ...list(item['media:thumbnail']),
        ...list(item['media:content']).filter(value => {
          const metadata = record(value);
          return metadata['@_medium'] === 'image' || String(metadata['@_type']).startsWith('image/');
        }),
        ...list(item.enclosure).filter(value =>
          String(record(value)['@_type']).startsWith('image/')),
      ],
    });
  }
  return { items, items_seen: rawItems.length, items_invalid: invalid };
}

export function rssAttribute(value: unknown, name: string): unknown {
  return record(value)[`@_${name}`];
}
