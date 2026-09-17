import {
  guardianRemotePreviewUrl, publisherHttpsUrl, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';
import { fetchCawsArticlePreviewImage } from './caws-preview-image';

const MAX_HEAD_BYTES = 256 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const MAX_HEAD_REDIRECTS = 3;
const HEAD_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

export type ArticleHeadMetadata = {
  ogImage: string | null;
  twitterImage: string | null;
  ogTitle: string | null;
  twitterTitle: string | null;
  htmlTitle: string | null;
  ogDescription: string | null;
  twitterDescription: string | null;
  htmlDescription: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
};

export function extractArticleHeadMetadata(htmlHead: string): ArticleHeadMetadata {
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
    htmlTitle: normaliseMetadataText(
      /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(htmlHead)?.[1] ?? '') || null,
    ogDescription: title('og:description'),
    twitterDescription: title('twitter:description'),
    htmlDescription: title('description'),
    publisher: title('og:site_name'),
    author: title('author') ?? title('article:author'),
    publishedAt: title('article:published_time'),
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

function hasSufficientEarlyMetadata(htmlHead: string): boolean {
  const metadata = extractArticleHeadMetadata(htmlHead);
  const publishedAt = metadata.publishedAt ? Date.parse(metadata.publishedAt) : Number.NaN;
  return Boolean(
    (metadata.ogImage || metadata.twitterImage) &&
    Number.isFinite(publishedAt) &&
    (metadata.ogTitle || metadata.twitterTitle || metadata.htmlTitle),
  );
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
      const remaining = MAX_HEAD_BYTES - bytes;
      const exceedsLimit = value.byteLength > remaining;
      const boundedValue = exceedsLimit ? value.subarray(0, remaining) : value;
      bytes += boundedValue.byteLength;
      html += decoder.decode(boundedValue, { stream: true });
      const closingHead = /<\/head\s*>/i.exec(html);
      const body = /<body\b/i.exec(html);
      if (closingHead && (!body || closingHead.index < body.index)) {
        return html.slice(0, closingHead.index + closingHead[0].length);
      }
      const headOnly = body ? html.slice(0, body.index) : html;
      if (hasSufficientEarlyMetadata(headOnly)) return headOnly;
      if (body) throw new ScanError('article_head_incomplete');
      if (exceedsLimit || bytes >= MAX_HEAD_BYTES) throw new ScanError('article_head_too_large');
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    if (signal.aborted) throw new ScanError('article_head_timeout');
    throw new ScanError('article_head_read_failed');
  } finally {
    try { await reader.cancel('HTML head obtained or rejected'); } catch { /* best effort */ }
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

export async function fetchArticleHeadMetadata(canonicalUrl: string,
  source: Pick<Source, 'source_key' | 'canonical_domain' | 'image_policy'>):
  Promise<ArticleHeadMetadata & { previewUrl: string | null; previewError: string | null;
    checkedAt: string }> {
  if (source.image_policy !== 'remote_preview') {
    throw new ScanError('article_head_not_permitted');
  }
  const articleUrl = publisherHttpsUrl(canonicalUrl, source);
  if (!articleUrl) throw new ScanError('invalid_article_head_url');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    let requestUrl = articleUrl;
    let redirectCount = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetch(requestUrl, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
          },
        });
      } catch {
        throw new ScanError(controller.signal.aborted
          ? 'article_head_timeout' : 'article_head_fetch_failed');
      }
      if (!HEAD_REDIRECT_STATUSES.has(response.status)) break;

      await cancelResponseBody(response);
      if (redirectCount >= MAX_HEAD_REDIRECTS) {
        throw new ScanError('article_head_redirect_limit');
      }
      const location = response.headers.get('Location')?.trim();
      if (!location) throw new ScanError('article_head_redirect_missing_location');
      let destination: URL;
      try { destination = new URL(location, requestUrl); }
      catch { throw new ScanError('article_head_redirect_malformed_location'); }
      const permittedUrl = publisherHttpsUrl(destination.href, source);
      if (!permittedUrl) throw new ScanError('article_head_redirect_not_permitted');
      requestUrl = permittedUrl;
      redirectCount += 1;
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw new ScanError('article_head_redirect_unsupported');
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new ScanError(`article_head_http_${response.status}`);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      await cancelResponseBody(response);
      throw new ScanError('article_head_not_html');
    }
    const metadata = extractArticleHeadMetadata(await readHtmlHead(response, controller.signal));
    const candidates = [metadata.ogImage, metadata.twitterImage].filter(
      (value): value is string => Boolean(value));
    const preview = candidates
      .map(value => source.source_key === 'the-guardian'
        ? guardianRemotePreviewUrl(value)
        : remotePreviewUrl(value, source)).find(Boolean) ?? null;
    let previewError: string | null = null;
    if (!preview && candidates.length > 0) {
      try { previewError = `invalid_preview_image_host:${new URL(candidates[0]!).hostname}`; }
      catch { previewError = 'invalid_preview_image_url'; }
    } else if (!preview) previewError = 'preview_image_metadata_missing';
    return { ...metadata, previewUrl: preview, previewError,
      checkedAt: new Date().toISOString() };
  } finally { clearTimeout(timeout); }
}

export async function discoverArticleHeadPreviewMetadata(article: DiscoveredArticle,
  source: Source): Promise<Pick<DiscoveredArticle, 'preview_url' | 'display_title' |
    'display_title_origin' | 'preview_metadata_checked_at'>> {
  const metadata = await fetchArticleHeadMetadata(article.canonical_url, source);
  const displayTitle = compactPublisherTitle(article.title,
    [metadata.ogTitle, metadata.twitterTitle]);
  let previewUrl = metadata.previewUrl;
  if (!previewUrl && source.source_key === 'communities-against-woodsmoke' &&
      source.image_policy === 'remote_preview') {
    try { previewUrl = await fetchCawsArticlePreviewImage(article.canonical_url, source); }
    catch { /* Optional CAWS presentation enrichment must not invalidate discovery. */ }
  }
  return {
    preview_url: previewUrl,
    display_title: displayTitle,
    display_title_origin: displayTitle ? 'publisher' : null,
    preview_metadata_checked_at: metadata.checkedAt,
  };
}
