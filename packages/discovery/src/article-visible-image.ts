import {
  publisherHttpsUrl, remotePreviewUrl, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const EXCLUDED_TAGS = new Set(['aside', 'footer', 'header', 'nav']);
const EXCLUDED_HINT = /(?:^|[\s_-])(ad|ads|advert|advertisement|author|avatar|badge|brand|cookie|footer|header|headshot|icon|logo|menu|nav|profile|promo|recommend|related|share|sidebar|social|sponsor|sprite|tracking|widget)(?:$|[\s_-])/i;

type PreviewSource = Pick<Source, 'source_key' | 'canonical_domain' | 'image_policy'>;
type Element = { tag: string; semantic: boolean; excluded: boolean };

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/g)) {
    if (match[1]) result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function permitted(raw: string | null | undefined, articleUrl: string,
  source: PreviewSource): string | null {
  if (!raw) return null;
  try { return remotePreviewUrl(new URL(raw.trim(), articleUrl).href, source); }
  catch { return null; }
}

function structuredCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredCandidates);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
    .filter((candidate): candidate is string => typeof candidate === 'string');
  const article = types.some(type => /^(?:Article|BlogPosting|NewsArticle)$/i.test(type));
  const results: string[] = [];
  if (article) {
    for (const field of [record.image, record.thumbnailUrl]) {
      if (typeof field === 'string') results.push(field);
      else if (Array.isArray(field)) {
        for (const item of field) {
          if (typeof item === 'string') results.push(item);
          else if (item && typeof item === 'object') {
            const image = item as Record<string, unknown>;
            for (const key of ['url', 'contentUrl']) {
              if (typeof image[key] === 'string') results.push(image[key] as string);
            }
          }
        }
      } else if (field && typeof field === 'object') {
        const image = field as Record<string, unknown>;
        for (const key of ['url', 'contentUrl']) {
          if (typeof image[key] === 'string') results.push(image[key] as string);
        }
      }
    }
  }
  return results.concat(Object.values(record).flatMap(structuredCandidates));
}

function jsonLdImage(html: string, articleUrl: string, source: PreviewSource): string | null {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(match[1] ?? '');
    if (attrs.get('type')?.trim().toLowerCase() !== 'application/ld+json') continue;
    try {
      for (const candidate of structuredCandidates(JSON.parse(match[2] ?? ''))) {
        const accepted = permitted(candidate, articleUrl, source);
        if (accepted) return accepted;
      }
    } catch { /* Publisher structured data is optional and may be malformed. */ }
  }
  return null;
}

function srcsetCandidates(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(candidate => candidate.trim().split(/\s+/, 1)[0])
    .filter((candidate): candidate is string => Boolean(candidate)).reverse();
}

function imageCandidates(attrs: Map<string, string>, tag: string): string[] {
  const responsive = [
    ...srcsetCandidates(attrs.get('data-srcset')),
    ...srcsetCandidates(attrs.get('srcset')),
  ];
  if (tag === 'source') return responsive;
  return [
    ...responsive,
    attrs.get('data-lazy-src'),
    attrs.get('data-src'),
    attrs.get('data-original'),
    attrs.get('src'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function tinyImage(attrs: Map<string, string>): boolean {
  const width = Number(attrs.get('width'));
  const height = Number(attrs.get('height'));
  return Boolean((width && width <= 64) || (height && height <= 64));
}

function contentImage(html: string, articleUrl: string, source: PreviewSource,
  semanticOnly: boolean): string | null {
  const stack: Element[] = [];
  for (const match of html.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const token = match[0];
    const tag = match[1]!.toLowerCase();
    if (token.startsWith('</')) {
      const index = stack.map(element => element.tag).lastIndexOf(tag);
      if (index >= 0) stack.length = index;
      continue;
    }

    const attrs = attributes(token);
    const hint = [
      attrs.get('id'), attrs.get('class'), attrs.get('role'), attrs.get('alt'), attrs.get('title'),
    ].filter(Boolean).join(' ');
    const parentSemantic = stack.some(element => element.semantic);
    const parentExcluded = stack.some(element => element.excluded);
    const semantic = parentSemantic || tag === 'article' || tag === 'main' ||
      attrs.get('role')?.toLowerCase() === 'main';
    const excluded = parentExcluded || EXCLUDED_TAGS.has(tag) || EXCLUDED_HINT.test(hint) ||
      /^(?:banner|complementary|contentinfo|navigation)$/.test(attrs.get('role')?.toLowerCase() ?? '');

    if ((tag === 'img' || tag === 'source') && !excluded && !tinyImage(attrs) &&
        (!semanticOnly || semantic)) {
      for (const raw of imageCandidates(attrs, tag)) {
        const accepted = permitted(raw, articleUrl, source);
        if (accepted) return accepted;
      }
    }

    const selfClosing = /\/\s*>$/.test(token);
    if (!selfClosing && !['img', 'meta', 'link', 'br', 'hr', 'input', 'source'].includes(tag)) {
      stack.push({ tag, semantic, excluded });
    }
  }
  return null;
}

export function extractArticleVisiblePreviewImage(html: string, articleUrl: string,
  source: PreviewSource, allowPageFallback = true): string | null {
  if (source.image_policy !== 'remote_preview') return null;
  return jsonLdImage(html, articleUrl, source) ??
    contentImage(html, articleUrl, source, true) ??
    (allowPageFallback ? contentImage(html, articleUrl, source, false) : null);
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

export async function fetchArticleVisiblePreviewImage(articleUrl: string,
  source: PreviewSource, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (source.image_policy !== 'remote_preview') return null;
  const initial = publisherHttpsUrl(articleUrl, source);
  if (!initial) throw new ScanError('article_visible_image_url_not_permitted');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = initial;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/UK-AQ/uk-aq-media)',
          },
        });
      } catch {
        throw new ScanError(controller.signal.aborted
          ? 'article_visible_image_timeout' : 'article_visible_image_fetch_failed');
      }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await cancel(response);
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new ScanError('article_visible_image_redirect_rejected');
      }
      let destination: string | null = null;
      try { destination = publisherHttpsUrl(new URL(location, requestUrl).href, source); }
      catch { /* reject */ }
      if (!destination) throw new ScanError('article_visible_image_redirect_rejected');
      requestUrl = destination;
      redirects++;
    }

    if (!response.ok || !response.body) {
      await cancel(response);
      throw new ScanError(`article_visible_image_http_${response.status}`);
    }
    const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      await cancel(response);
      throw new ScanError('article_visible_image_not_html');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let html = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          html += decoder.decode();
          return extractArticleVisiblePreviewImage(html, articleUrl, source, true);
        }
        const remaining = MAX_BYTES - bytes;
        const exceedsLimit = value.byteLength > remaining;
        const bounded = exceedsLimit ? value.subarray(0, remaining) : value;
        bytes += bounded.byteLength;
        html += decoder.decode(bounded, { stream: true });

        // Early return only for structured or semantic article images. The looser page-level
        // fallback waits until the bounded document is complete so site chrome cannot win early.
        const strongCandidate = extractArticleVisiblePreviewImage(html, articleUrl, source, false);
        if (strongCandidate) return strongCandidate;
        if (exceedsLimit || bytes >= MAX_BYTES) {
          const fallback = extractArticleVisiblePreviewImage(html, articleUrl, source, true);
          if (fallback) return fallback;
          throw new ScanError('article_visible_image_html_too_large');
        }
      }
    } finally {
      try { await reader.cancel('Visible article image found or bounded read ended'); }
      catch { /* best effort */ }
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted
      ? 'article_visible_image_timeout' : 'article_visible_image_read_failed');
  } finally {
    clearTimeout(timeout);
  }
}
