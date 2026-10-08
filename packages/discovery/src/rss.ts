import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const MAX_FEED_BYTES = 1024 * 1024;
export const MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES = 64 * 1024;
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
  allowedManualRedirectUrl?: string, fetcher: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  const request = (requestUrl: string): Promise<Response> => fetcher(requestUrl, {
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
  title_context: string | null;
  preview_candidates: RssPreviewCandidate[];
  content_encoded_preview_url: string | null;
  content_encoded_html: string | null;
}

export type RssPreviewCandidateKind = 'media:thumbnail' | 'media:content' | 'enclosure';

export interface RssPreviewCandidate {
  kind: RssPreviewCandidateKind;
  url: unknown;
  width: unknown;
  height: unknown;
  rss_order: number;
}

type TitleContextMode = 'aqn_leading_600' | 'guardian_first_paragraph';

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

function normaliseDescriptionText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function unicodeSlice(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('');
}

function rawDescription(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : record(value)['#text'];
  return typeof raw === 'string' ? raw : null;
}

function aqnTitleContext(description: string): string | null {
  const normalised = normaliseDescriptionText(description);
  if (!normalised) return null;
  if ([...normalised].length <= 600) return normalised;
  const bounded = unicodeSlice(normalised, 600);
  let sentenceEnd = 0;
  for (const match of bounded.matchAll(/[.!?](?=\s|$)/gu)) sentenceEnd = (match.index ?? 0) + 1;
  if (sentenceEnd > 0) return bounded.slice(0, sentenceEnd).trim();
  const lastSpace = bounded.lastIndexOf(' ');
  return (lastSpace > 0 ? bounded.slice(0, lastSpace) : bounded).trim() || null;
}

function guardianTitleContext(description: string): string | null {
  const paragraph = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p\s*>/i.exec(description)?.[1];
  if (!paragraph) return null;
  const normalised = normaliseDescriptionText(paragraph);
  return normalised ? unicodeSlice(normalised, 1000) : null;
}

function titleContext(value: unknown, mode: TitleContextMode | undefined): string | null {
  if (!mode) return null;
  const description = rawDescription(value);
  if (!description) return null;
  return mode === 'guardian_first_paragraph'
    ? guardianTitleContext(description) : aqnTitleContext(description);
}

function isImageMediaContent(value: unknown, allowUntypedImageUrl: boolean): boolean {
  const metadata = record(value);
  if (metadata['@_medium'] === 'image' || String(metadata['@_type']).startsWith('image/')) {
    return true;
  }
  if (!allowUntypedImageUrl || typeof metadata['@_url'] !== 'string') return false;
  try {
    return /\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(metadata['@_url']).pathname);
  } catch { return false; }
}

function previewCandidate(kind: RssPreviewCandidateKind, value: unknown,
  rssOrder: number): RssPreviewCandidate {
  const metadata = record(value);
  return {
    kind,
    url: metadata['@_url'],
    width: metadata['@_width'],
    height: metadata['@_height'],
    rss_order: rssOrder,
  };
}

type ContentEncodedPreviewOptions = {
  max_scan_bytes: number;
  validate_url: (raw: unknown) => string | null;
};

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2
      : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function htmlAttribute(tag: string, name: 'height' | 'src' | 'width'): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i')
    .exec(tag);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function explicitOneByOneImage(tag: string): boolean {
  const dimension = (name: 'height' | 'width'): number | null => {
    const raw = htmlAttribute(tag, name)?.trim();
    if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  return dimension('width') === 1 && dimension('height') === 1;
}

function contentEncodedPreviewUrl(value: unknown,
  options: ContentEncodedPreviewOptions | undefined): string | null {
  if (!options) return null;
  const html = rawDescription(value);
  if (!html) return null;
  const boundedHtml = utf8Prefix(html, options.max_scan_bytes);
  for (const match of boundedHtml.matchAll(/<img\b[^>]{0,4096}>/gi)) {
    const tag = match[0];
    if (explicitOneByOneImage(tag)) continue;
    const validated = options.validate_url(htmlAttribute(tag, 'src'));
    if (validated) return validated;
  }
  return null;
}

export function parseRssItems(xml: string, maxItems: number,
  options: {
    allow_untyped_image_media_content?: boolean;
    title_context?: TitleContextMode;
    content_encoded_preview?: ContentEncodedPreviewOptions;
    retain_content_encoded?: boolean;
  } = {}): {
  items: ParsedRssItem[];
  items_seen: number;
  items_invalid: number;
} {
  if (new TextEncoder().encode(xml).byteLength > MAX_FEED_BYTES ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new ScanError('invalid_rss');
  }
  const contentEncodedPreview = options.content_encoded_preview;
  if (contentEncodedPreview && (!Number.isSafeInteger(contentEncodedPreview.max_scan_bytes) ||
      contentEncodedPreview.max_scan_bytes < 1 ||
      contentEncodedPreview.max_scan_bytes > MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES)) {
    throw new ScanError('invalid_content_encoded_preview_scan_limit');
  }
  const parser = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    htmlEntities: true, maxNestedTags: 32,
    isArray: name => ['item', 'category', 'dc:creator', 'media:content',
      'media:thumbnail', 'enclosure'].includes(name),
    updateTag: name => (name === 'content:encoded' && !contentEncodedPreview &&
      !options.retain_content_encoded) ||
      (name === 'description' && !options.title_context) ? false : name,
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
    const rawPreviewCandidates: Array<readonly [RssPreviewCandidateKind, unknown]> = [
      ...list(item['media:thumbnail'])
        .map(value => ['media:thumbnail', value] as const),
      ...list(item['media:content'])
        .filter(value => isImageMediaContent(value,
          options.allow_untyped_image_media_content === true))
        .map(value => ['media:content', value] as const),
      ...list(item.enclosure)
        .filter(value => String(record(value)['@_type']).startsWith('image/'))
        .map(value => ['enclosure', value] as const),
    ];
    items.push({
      title,
      raw_url: rawUrl,
      author: creators.length ? creators.join(' and ').slice(0, 300) : null,
      published_at: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
      categories: list(item.category).map(value => text(value, 100))
        .filter((category): category is string => category !== null).slice(0, 20),
      title_context: titleContext(item.description, options.title_context),
      preview_candidates: rawPreviewCandidates.map(([kind, candidate], rssOrder) =>
        previewCandidate(kind, candidate, rssOrder)),
      content_encoded_preview_url: contentEncodedPreviewUrl(
        item['content:encoded'], contentEncodedPreview),
      content_encoded_html: options.retain_content_encoded
        ? rawDescription(item['content:encoded']) : null,
    });
  }
  return { items, items_seen: rawItems.length, items_invalid: invalid };
}

export function rssAttribute(value: unknown, name: string): unknown {
  return record(value)[`@_${name}`];
}
