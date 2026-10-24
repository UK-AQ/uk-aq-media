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

// An application bound, below the Queues delay limit; never persist arbitrary header text.
export const MAX_FEED_RETRY_SECONDS = 12 * 60 * 60;
export interface FeedRetryAfter {
  value: string | null;
  state: 'missing' | 'invalid' | 'expired' | 'valid' | 'capped';
  delay_seconds: number | null;
}
export interface FeedFailureDiagnostics {
  http_status: number | null;
  request_duration_ms: number;
  failure_stage: 'fetch_request' | 'http_response' | 'feed_stream_read';
  failure_kind: 'http' | 'timeout' | 'network' | 'validation';
  retry_after: FeedRetryAfter;
  cf_ray: string | null;
}
export interface ScanRetry {
  delaySeconds: number;
  notBefore: string;
  reason: 'retry_after' | 'backoff';
}
export interface ScanErrorDetails {
  feed?: FeedFailureDiagnostics;
  retry?: ScanRetry;
  run_id?: string;
}
export class ScanError extends Error {
  constructor(public readonly code: string, public readonly details: ScanErrorDetails = {}) {
    super(code);
  }
}

export function feedRetryAfter(value: string | null, now = Date.now()): FeedRetryAfter {
  if (value === null) return { value: null, state: 'missing', delay_seconds: null };
  if (value.length > 64) return { value: null, state: 'invalid', delay_seconds: null };
  const raw = value.trim();
  // Date.parse alone also accepts negative numbers and other non-HTTP dates.
  // Accept the three HTTP-date wire formats, as well as integer delta-seconds.
  const day = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const httpDate = new RegExp(`^(?:${day}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT|` +
    `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ` +
    `\\d{2}:\\d{2}:\\d{2} GMT|${day} ${month} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4})$`);
  const parsedDateMs = httpDate.test(raw) ? Date.parse(raw) : NaN;
  // Date.parse can normalise impossible dates (for example, 31 February).
  const dateMs = Number.isFinite(parsedDateMs) &&
    new Date(parsedDateMs).getUTCDate() === Number(/\d+/.exec(raw)?.[0]) ? parsedDateMs : NaN;
  if (Number.isFinite(dateMs) && dateMs <= now) {
    return { value: raw, state: 'expired', delay_seconds: null };
  }
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((dateMs - now) / 1000);
  if (!Number.isFinite(seconds)) return { value: null, state: 'invalid', delay_seconds: null };
  return { value: raw, state: seconds > MAX_FEED_RETRY_SECONDS ? 'capped' : 'valid',
    delay_seconds: Math.min(seconds, MAX_FEED_RETRY_SECONDS) };
}

export async function readRssFeed(url: string, adapterKey: string,
  allowedManualRedirectUrl?: string, fetcher: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  let phase: FeedFailureDiagnostics['failure_stage'] = 'fetch_request';
  let status: number | null = null;
  let retryAfter = feedRetryAfter(null);
  let cfRay: string | null = null;
  const cancelBody = async (response: Response): Promise<void> => {
    try { await response.body?.cancel(); } catch { /* Preserve the original HTTP failure. */ }
  };
  const request = async (requestUrl: string): Promise<Response> => {
    phase = 'fetch_request';
    status = null; cfRay = null; retryAfter = feedRetryAfter(null);
    const response = await fetcher(requestUrl, {
      redirect: 'manual', signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
      },
    });
    phase = 'http_response';
    status = response.status;
    retryAfter = feedRetryAfter(response.headers.get('Retry-After'));
    const ray = response.headers.get('CF-Ray');
    cfRay = ray && /^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i.test(ray) ? ray : null;
    return response;
  };
  try {
    let response = await request(url);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await cancelBody(response);
      let resolvedLocation: string | null = null;
      try { resolvedLocation = location ? new URL(location, url).href : null; } catch { /* reject */ }
      if (!allowedManualRedirectUrl || resolvedLocation !== allowedManualRedirectUrl) {
        throw new ScanError('feed_redirect_rejected');
      }
      response = await request(allowedManualRedirectUrl);
      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        throw new ScanError('feed_redirect_chain_rejected');
      }
    }
    if (!response.ok || !response.body) {
      await cancelBody(response);
      throw new ScanError(`feed_http_${response.status}`);
    }
    phase = 'feed_stream_read';
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
    } finally {
      try { await reader.cancel(); } catch { /* Preserve the original stream failure. */ }
    }
  } catch (error) {
    const code = error instanceof ScanError ? error.code
      : controller.signal.aborted ? 'feed_timeout' : 'feed_fetch_failed';
    const feed: FeedFailureDiagnostics = {
      http_status: status, request_duration_ms: Math.max(0, Date.now() - started),
      failure_stage: phase,
      failure_kind: code === 'feed_timeout' ? 'timeout' : code === 'feed_fetch_failed'
        ? 'network' : code.startsWith('feed_http_') ? 'http' : 'validation',
      retry_after: retryAfter, cf_ray: cfRay,
    };
    // No exception messages, request URLs, bodies or unrestricted HTTP headers.
    console.error(JSON.stringify({ event: `${adapterKey}_feed_fetch_error`, ...feed }));
    throw new ScanError(code, { ...(error instanceof ScanError ? error.details : {}), feed });
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
