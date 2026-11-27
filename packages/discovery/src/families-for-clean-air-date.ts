import {
  publisherHttpsUrl, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { extractArticleHeadMetadata, normaliseMetadataText } from './article-head-metadata';
import { ScanError } from './rss';

const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WRITTEN_DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i;
const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function calendarDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 2008 || month < 1 || month > 12 ||
      day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getTime() > Date.now()) return null;
  return date.toISOString().slice(0, 10);
}

function normalisedTitle(value: string): string {
  return normaliseMetadataText(value.replace(/<[^>]+>/g, ' '))
    .toLocaleLowerCase('en-GB').replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function structuredDate(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(raw)) return null;
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  return calendarDate(year!, month!, day!);
}

// Only publisher dates, never article body references or discovery timestamps.
export function extractFamiliesForCleanAirPublishedDate(html: string,
  expectedTitle: string): string | null {
  const head = html.split(/<\/head\s*>/i, 1)[0] ?? '';
  const headMetadata = extractArticleHeadMetadata(head);
  const metadataTitle = headMetadata.ogTitle ?? headMetadata.htmlTitle ?? '';
  const expected = normalisedTitle(expectedTitle);
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]{1,700}?)<\/h1\s*>/gi)];
  const matched = headings.find(match => normalisedTitle(match[1] ?? '') === expected);
  if (!matched && normalisedTitle(metadataTitle) !== expected) return null;
  const fromHead = structuredDate(headMetadata.publishedAt);
  if (fromHead) return fromHead;
  if (!matched) return null;

  // The redesigned publisher's article pages print "November 7, 2025"
  // immediately after the headline. Reject dates deeper in the article body.
  const afterHeading = html.slice((matched.index ?? 0) + matched[0].length,
    (matched.index ?? 0) + matched[0].length + 1200);
  const nearby = normaliseMetadataText(afterHeading.replace(/<[^>]*>/g, ' ')).slice(0, 180);
  const written = WRITTEN_DATE.exec(nearby);
  if (!written) return null;
  const month = MONTHS.indexOf(written[1]!.toLowerCase()) + 1;
  return calendarDate(Number(written[3]), month, Number(written[2]));
}

export async function fetchFamiliesForCleanAirPublishedDate(
  article: Pick<DiscoveredArticle, 'canonical_url' | 'title'>,
  source: Pick<Source, 'source_key' | 'canonical_domain'>, requireAllowedUrl?: (url: string) => Promise<void>,
  fetcher: typeof fetch = fetch): Promise<string | null> {
  if (source.source_key !== 'families-for-clean-air' ||
      source.canonical_domain !== 'familiesforcleanair.org') {
    throw new ScanError('families_for_clean_air_date_source_mismatch');
  }
  const path = new URL(article.canonical_url).pathname.replace(/\/$/, '');
  const slug = path.split('/').pop() ?? '';
  if (!ARTICLE_SLUG.test(slug) || !(/^\/news\/[^/]+$/.test(path) ||
      /^\/[^/]+$/.test(path))) return null;
  const currentArticleUrl = 'https://www.familiesforcleanair.org/news/' + slug;
  if (!publisherHttpsUrl(currentArticleUrl, source)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let requestUrl = currentArticleUrl;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 2; redirects++) {
      if (requireAllowedUrl) await requireAllowedUrl(requestUrl);
      response = await fetcher(requestUrl, { redirect: 'manual',
        signal: controller.signal, headers: { Accept: 'text/html' } });
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get('Location');
      try { await response.body?.cancel(); } catch { /* Preserve redirect status. */ }
      if (!location || redirects === 2) return null;
      const next = new URL(location, requestUrl);
      const permitted = publisherHttpsUrl(next.href, source);
      if (!permitted || next.search || next.hash ||
          next.pathname.replace(/\/$/, '') !== '/news/' + slug) return null;
      requestUrl = permitted;
    }
    if (!response?.ok || !response.body ||
        !['text/html', 'application/xhtml+xml'].includes(
          response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '')) {
      try { await response?.body?.cancel(); } catch { /* Optional metadata unavailable. */ }
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let html = '';
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          html += decoder.decode();
          return extractFamiliesForCleanAirPublishedDate(html, article.title);
        }
        const remaining = MAX_HTML_BYTES - bytes;
        const portion = value.subarray(0, remaining);
        bytes += portion.byteLength;
        html += decoder.decode(portion, { stream: true });
        const found = extractFamiliesForCleanAirPublishedDate(html, article.title);
        if (found) return found;
        if (bytes >= MAX_HTML_BYTES) return null;
      }
    } finally {
      try { await reader.cancel('Bounded publisher date lookup complete'); } catch { /* Best effort. */ }
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(controller.signal.aborted
      ? 'families_for_clean_air_date_timeout' : 'families_for_clean_air_date_fetch_failed');
  } finally {
    clearTimeout(timeout);
  }
}
