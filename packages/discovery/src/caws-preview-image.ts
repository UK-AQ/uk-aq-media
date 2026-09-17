import { publisherHttpsUrl, remotePreviewUrl, type Source } from '@uk-aq-media/core';
import { ScanError } from './rss';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CAWS_SOURCE_KEY = 'communities-against-woodsmoke';
const EXCLUDED_TAGS = new Set(['aside', 'footer', 'header', 'nav']);
const EXCLUDED_HINT = /(?:^|[\s_-])(brand|cookie|footer|header|logo|menu|nav|related|recommend|share|sidebar|social|tracking|widget)(?:$|[\s_-])/i;

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    if (match[1]) result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function permitted(raw: string | null | undefined, articleUrl: string, source: Source): string | null {
  if (!raw) return null;
  try { return remotePreviewUrl(new URL(raw.trim(), articleUrl).href, source); }
  catch { return null; }
}

function structuredCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredCandidates);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  const article = types.some(type => typeof type === 'string' &&
    /^(?:Article|BlogPosting|NewsArticle)$/i.test(type));
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

function jsonLdImage(html: string, articleUrl: string, source: Source): string | null {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(match[1] ?? '');
    if (attrs.get('type')?.toLowerCase() !== 'application/ld+json') continue;
    try {
      for (const candidate of structuredCandidates(JSON.parse(match[2] ?? ''))) {
        const accepted = permitted(candidate, articleUrl, source);
        if (accepted) return accepted;
      }
    } catch { /* malformed publisher metadata is optional */ }
  }
  return null;
}

type Element = { tag: string; semantic: boolean; excluded: boolean };

function articleContentImage(html: string, articleUrl: string, source: Source): string | null {
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
    const hint = `${attrs.get('id') ?? ''} ${attrs.get('class') ?? ''} ${attrs.get('role') ?? ''}`;
    const parentSemantic = stack.some(element => element.semantic);
    const parentExcluded = stack.some(element => element.excluded);
    const semantic = parentSemantic || tag === 'article' || tag === 'main' ||
      attrs.get('role')?.toLowerCase() === 'main';
    const excluded = parentExcluded || EXCLUDED_TAGS.has(tag) || EXCLUDED_HINT.test(hint) ||
      /^(?:banner|complementary|contentinfo|navigation)$/.test(attrs.get('role')?.toLowerCase() ?? '');
    if (tag === 'img' && semantic && !excluded) {
      const width = Number(attrs.get('width'));
      const height = Number(attrs.get('height'));
      if ((!width || width > 2) && (!height || height > 2)) {
        const srcset = attrs.get('srcset')?.split(',')[0]?.trim().split(/\s+/, 1)[0];
        for (const raw of [attrs.get('src'), attrs.get('data-src'), srcset]) {
          const accepted = permitted(raw, articleUrl, source);
          if (accepted) return accepted;
        }
      }
    }
    if (!/\/$/.test(token.slice(0, -1)) && !['img', 'meta', 'link', 'br', 'hr', 'input', 'source'].includes(tag)) {
      stack.push({ tag, semantic, excluded });
    }
  }
  return null;
}

export function extractCawsArticlePreviewImage(html: string, articleUrl: string,
  source: Source): string | null {
  if (source.source_key !== CAWS_SOURCE_KEY || source.image_policy !== 'remote_preview') return null;
  return jsonLdImage(html, articleUrl, source) ?? articleContentImage(html, articleUrl, source);
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

export async function fetchCawsArticlePreviewImage(articleUrl: string, source: Source,
  fetcher: typeof fetch = fetch): Promise<string | null> {
  if (source.source_key !== CAWS_SOURCE_KEY || source.image_policy !== 'remote_preview') return null;
  const initial = publisherHttpsUrl(articleUrl, source);
  if (!initial) throw new ScanError('caws_preview_url_not_permitted');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = initial;
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await fetcher(requestUrl, { method: 'GET', redirect: 'manual',
          signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' } });
      } catch { throw new ScanError(controller.signal.aborted ? 'caws_preview_timeout' : 'caws_preview_fetch_failed'); }
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location')?.trim();
      await cancel(response);
      if (!location || redirects >= MAX_REDIRECTS) throw new ScanError('caws_preview_redirect_rejected');
      let destination: string | null = null;
      try { destination = publisherHttpsUrl(new URL(location, requestUrl).href, source); }
      catch { /* reject */ }
      if (!destination) throw new ScanError('caws_preview_redirect_rejected');
      requestUrl = destination;
      redirects++;
    }
    if (!response.ok || !response.body) { await cancel(response); throw new ScanError(`caws_preview_http_${response.status}`); }
    const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      await cancel(response); throw new ScanError('caws_preview_not_html');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let html = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return extractCawsArticlePreviewImage(html + decoder.decode(), articleUrl, source);
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new ScanError('caws_preview_html_too_large');
        html += decoder.decode(value, { stream: true });
        const image = extractCawsArticlePreviewImage(html, articleUrl, source);
        if (image) return image;
      }
    } finally { try { await reader.cancel('CAWS preview found or bounded read ended'); } catch { /* best effort */ } }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted ? 'caws_preview_timeout' : 'caws_preview_read_failed');
  } finally { clearTimeout(timeout); }
}
