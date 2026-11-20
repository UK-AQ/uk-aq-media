import { canonicalizeUrl, findPublisherDomainBlock, normaliseBlockDomain, publisherHttpsUrl,
  type PublisherDomainIdentity } from '@uk-aq-media/core';
import { decodeHTML } from 'entities';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

type ScanFailure = 'publisher_access' | 'unsafe_url' | 'redirect_limit' | 'not_html' |
  'size_limit' | 'fetch_failed' | 'timeout' | 'no_article_body' | 'source_policy';

export class ReviewScanError extends Error {
  constructor(readonly code: ScanFailure) { super(code); }
}

export function countReviewWords(text: string) {
  const counts = { air: 0, quality: 0, pollution: 0, health: 0, word_count: 0 };
  for (const [token] of text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu)) {
    counts.word_count++;
    const word = token.toLowerCase();
    if (word === 'air' || word === 'quality' || word === 'pollution' || word === 'health') {
      counts[word]++;
    }
  }
  return counts;
}

// Accept only a short descriptive RSS field, either plain text or a leading plain
// paragraph. Discard rich markup, promotional link lists and full-content fields.
export function reviewDescription(raw: string | null): string | null {
  if (!raw || raw.length > 8192) return null;
  const paragraph = /^\s*<p(?:\s[^>]*)?>([^<>]+)<\/p\s*>/i.exec(raw)?.[1];
  const text = decodeHTML(paragraph ?? raw).trim();
  return text.length <= 2000 && !/[<>]/.test(text) && /\p{L}/u.test(text) ? text : null;
}

type Article = PublisherDomainIdentity & { canonical_url: string; title: string };
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];

function sameArticle(identity: unknown, article: Article): boolean {
  const url = typeof identity === 'object' && identity !== null && '@id' in identity
    ? identity['@id'] : identity;
  if (typeof url !== 'string' || !publisherHttpsUrl(url, article)) return false;
  try { return canonicalizeUrl(url, article) === article.canonical_url; }
  catch { return false; }
}

function structuredBody(html: string, article: Article): string {
  // Only publisher-declared articleBody in attributable JSON-LD is verified in v1.
  // Walking the parsed document avoids script lookalikes in templates, comments or page text.
  const nodes: DefaultTreeAdapterTypes.ChildNode[] = [...parse(html).childNodes];
  const bodies = new Set<string>();
  while (nodes.length) {
    const node = nodes.pop()!;
    if (!('tagName' in node)) continue;
    if (node.tagName !== 'script') {
      for (const child of node.childNodes) nodes.push(child);
      continue;
    }
    if (!node.attrs.some(a => a.name === 'type' && a.value.trim().toLowerCase() === 'application/ld+json')) continue;
    const raw = node.childNodes.map(child => 'value' in child ? child.value : '').join('');
    let parsed: unknown;
    let restricted = false;
    try {
      parsed = JSON.parse(raw, (key, value: unknown) => {
        if (key === 'isAccessibleForFree' && String(value).toLowerCase() !== 'true') restricted = true;
        return value;
      });
    } catch { continue; }
    if (restricted) throw new ReviewScanError('publisher_access');
    for (const root of Array.isArray(parsed) ? parsed : [parsed]) {
      const records = Array.isArray(root?.['@graph']) ? [root, ...root['@graph']] : [root];
      for (const record of records) {
        if (!record || typeof record.articleBody !== 'string') continue;
        const types = [record['@type']].flat();
        if (!types.some(t => typeof t === 'string' &&
            /^(?:https?:\/\/schema\.org\/)?(?:Article|NewsArticle|ReportageNewsArticle|AnalysisNewsArticle|ScholarlyArticle)$/i.test(t))) continue;
        // An explicit article URL wins over the enclosing WebPage. Related
        // stories can declare the same parent page and a different article URL.
        const identity = record.url ?? record.mainEntityOfPage ?? record['@id'];
        if (!sameArticle(identity, article)) continue;
        let body = decodeHTML(record.articleBody).trim();
        if (/<\/?[a-z][^>]*>/i.test(body) || /(?:…|\.{3})\s*$/.test(body)) continue;
        if (/\b(?:subscribe|sign in|log in) to (?:continue reading|read (?:more|the (?:full|rest)))\b/i.test(body)) {
          throw new ReviewScanError('publisher_access');
        }
        for (const headline of [record.headline, article.title]) {
          if (typeof headline === 'string' && headline && body.startsWith(headline) &&
              (!body[headline.length] || /\s/u.test(body[headline.length]!))) body = body.slice(headline.length).trim();
        }
        if (/\p{L}/u.test(body)) bodies.add(body);
      }
    }
  }
  if (bodies.size !== 1) throw new ReviewScanError('no_article_body');
  return [...bodies][0]!;
}

async function readHtml(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ReviewScanError('size_limit');
  if (!response.body) throw new ReviewScanError('no_article_body');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const reader = response.body.getReader();
  let size = 0;
  let html = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return html + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BYTES) throw new ReviewScanError('size_limit');
      html += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export async function fetchReviewCounts(db: D1Database, article: Article, stillPermitted: () => Promise<boolean>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    try {
      normaliseBlockDomain(article.canonical_domain);
      if (canonicalizeUrl(article.canonical_url, article) !== article.canonical_url) {
        throw new ReviewScanError('unsafe_url');
      }
    } catch { throw new ReviewScanError('unsafe_url'); }
    let url = article.canonical_url;
    for (let hop = 0; hop <= 2; hop++) {
      if (!publisherHttpsUrl(url, article)) throw new ReviewScanError('unsafe_url');
      let host: string;
      try { host = normaliseBlockDomain(new URL(url).hostname); }
      catch { throw new ReviewScanError('unsafe_url'); }
      if (await findPublisherDomainBlock(db, host)) throw new ReviewScanError('publisher_access');
      if (!await stillPermitted()) throw new ReviewScanError('source_policy');
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': 'UK-AQ-Media/0.1' } });
      try {
        if (REDIRECTS.includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || hop === 2) throw new ReviewScanError('redirect_limit');
          url = new URL(location, url).href;
          continue;
        }
        if ([401, 402, 403, 429, 451].includes(response.status)) throw new ReviewScanError('publisher_access');
        if (response.status !== 200) throw new ReviewScanError('fetch_failed');
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') {
          throw new ReviewScanError('not_html');
        }
        return countReviewWords(structuredBody(await readHtml(response), article));
      } finally { await response.body?.cancel().catch(() => {}); }
    }
    throw new ReviewScanError('redirect_limit');
  } catch (error) {
    if (error instanceof ReviewScanError) throw error;
    throw new ReviewScanError(controller.signal.aborted ? 'timeout' : 'fetch_failed');
  } finally { clearTimeout(timeout); }
}
