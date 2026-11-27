import {
  canonicalizeUrl, guardianRemotePreviewUrl, normaliseArticleAuthorForStorage, publisherHttpsUrl, remotePreviewUrl,
  type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { extractArticleVisiblePreviewImage, fetchArticleVisiblePreviewImage } from './article-visible-image';
import { extractDsawspArticlePreviewImage, fetchDsawspArticlePreviewImage } from './dsawsp';
import { extractFamiliesForCleanAirPublishedDate } from './families-for-clean-air-date';
import { fetchPublisherArticleMetadata, type PublisherArticleMetadataTarget } from './article-metadata-fetch';
import { publisherPublicationDate } from './publisher-publication-date';
export { publisherPublicationDate } from './publisher-publication-date';

const MAX_HEAD_BYTES = 256 * 1024;
type ArticleIdentity = { canonicalUrl: string; source: Pick<Source, 'source_key' | 'canonical_domain'> };

const HTML_METADATA_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', apos: "'", bull: '•', cent: '¢', copy: '©', deg: '°', euro: '€',
  gt: '>', hellip: '…', laquo: '«', ldquo: '“', lsquo: '‘', lt: '<', mdash: '—',
  middot: '·', nbsp: ' ', ndash: '–', pound: '£', quot: '"', raquo: '»',
  rdquo: '”', reg: '®', rsquo: '’', trade: '™', yen: '¥',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, key: string) => {
    if (key[0] !== '#') return HTML_METADATA_ENTITIES[key.toLowerCase()] ?? entity;
    const hexadecimal = key[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    try {
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    } catch {
      return entity;
    }
  });
}

export function normaliseMetadataText(value: string): string {
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

function jsonLdRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonLdArticleType(value: unknown): boolean {
  const types = (Array.isArray(value) ? value : [value])
    .filter((candidate): candidate is string => typeof candidate === 'string');
  return types.some(type => type.toLowerCase().endsWith('article'));
}

function jsonLdAuthor(value: unknown): string | null {
  const names = (Array.isArray(value) ? value : [value]).flatMap(candidate => {
    if (typeof candidate === 'string') return [candidate];
    const record = jsonLdRecord(candidate);
    return typeof record?.name === 'string' ? [record.name] : [];
  }).map(normaliseMetadataText).filter(Boolean);
  if (!names.length) return null;
  return normaliseMetadataText([...new Set(names)].join(' and ')) || null;
}

type NativeMetadata = {
  explicitHeadline?: string | null;
  verifiedHeadline?: string | null;
  publisher?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  publishedAtConflict?: boolean;
  structuredImages?: string[];
};

function text(value: unknown): string | null {
  return typeof value === 'string' ? normaliseMetadataText(value) || null : null;
}

function uniqueValue(values: (string | null | undefined)[]): string | null {
  const distinct = [...new Set(values.filter(Boolean))];
  return distinct.length === 1 ? distinct[0] ?? null : null;
}

function publicationEvidence(values: (string | null | undefined)[]): NativeMetadata {
  const dates = new Map<string, string>();
  for (const value of values) {
    const date = publisherPublicationDate(value ?? null);
    if (date && value && !dates.has(date)) dates.set(date, value);
  }
  const [first, ...others] = dates.keys();
  // Calendar-only and timed values can agree on the day while retaining their
  // original precision. Two distinct timestamps or days are conflicting evidence.
  const compatible = (candidate: string) => first?.slice(0, 10) === candidate.slice(0, 10);
  const oneInstant = [...dates.keys()].filter(date => date.length > 10).length <= 1;
  return oneInstant && others.every(compatible) ? { publishedAt: first ? dates.get(first)! : null }
    : { publishedAtConflict: true };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function recordUrl(value: unknown): unknown {
  const record = jsonLdRecord(value);
  return record ? record['@id'] ?? record.url : value;
}

function sameArticle(value: unknown, requestUrl?: string, identity?: ArticleIdentity): boolean {
  if (!requestUrl || typeof value !== 'string' || value.startsWith('#')) return false;
  try {
    const expected = new URL(requestUrl);
    const actual = new URL(value, expected);
    if (identity) return canonicalizeUrl(actual.href, identity.source) === identity.canonicalUrl;
    const domain = expected.hostname;
    return canonicalizeUrl(actual.href, domain) === canonicalizeUrl(expected.href, domain);
  } catch { return false; }
}

function structuredArticleMetadata(htmlHead: string, requestUrl: string | undefined,
  pageTitle: string | null, identity?: ArticleIdentity): NativeMetadata {
  const matched: Record<string, unknown>[] = [];
  const anonymous: Record<string, unknown>[] = [];
  for (const match of htmlHead.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = metaAttributes(match[1] ?? '');
    if (attributes.get('type')?.trim().toLowerCase() !== 'application/ld+json') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(match[2] ?? ''); } catch { continue; }

    for (const root of asArray(parsed)) {
      const record = jsonLdRecord(root);
      if (!record) continue;
      for (const node of [record, jsonLdRecord(record.mainEntity), ...asArray(record['@graph']).map(jsonLdRecord)]) {
        if (!node || !jsonLdArticleType(node['@type']) &&
          !asArray(node['@type']).some(type => typeof type === 'string' && /(?:^|[/#])BlogPosting$/i.test(type))) continue;
        const urls = [node.url, node.mainEntityOfPage, node['@id']].map(recordUrl)
          .filter(value => typeof value === 'string' && !value.startsWith('#'));
        if (urls.length > 0 && urls.every(value => sameArticle(value, requestUrl, identity))) matched.push(node);
        if (!urls.length && pageTitle && text(node.headline) === pageTitle) anonymous.push(node);
      }
    }
  }
  const records = matched.length ? matched : anonymous.length === 1 ? anonymous : [];
  const publishers = records.map(record => {
    const publisher = jsonLdRecord(record.publisher);
    if (publisher?.url && requestUrl) {
      try {
        const page = new URL(requestUrl);
        const site = new URL(String(publisher.url), page);
        if (!publisherHttpsUrl(site.href, page.hostname)) return null;
      } catch { return null; }
    }
    return text(publisher?.name);
  });
  return {
    explicitHeadline: uniqueValue(records.map(record => text(record.headline))),
    verifiedHeadline: uniqueValue(matched.map(record => text(record.headline))),
    publisher: uniqueValue(publishers),
    author: uniqueValue(records.map(record => jsonLdAuthor(record.author))),
    ...publicationEvidence(records.map(record => text(record.datePublished))),
    structuredImages: [...new Set(records.flatMap(record =>
      [...asArray(record.image), ...asArray(record.thumbnailUrl)].flatMap(value => {
        if (typeof value === 'string') return [value];
        const image = jsonLdRecord(value);
        return [image?.url, image?.contentUrl].filter((url): url is string => typeof url === 'string');
      })))],
  };
}

type MarkedElement = DefaultTreeAdapterTypes.Element;
const metadataExcluded = /(?:^|[\s_-])(?:related|recommend(?:ed|ations)?|sidebar|promo|teaser|breadcrumb|site-nav)(?:$|[\s_-])/i;

function markedArticleMetadata(document: DefaultTreeAdapterTypes.Document, url: string,
  expectedTitles: string[], headings: MarkedElement[], identity?: ArticleIdentity): NativeMetadata {
  const articleType = /(?:^|[/#])(?:[a-z]*Article|BlogPosting)(?:\s|$)/i;
  const scopes: Array<{ matchesUrl: boolean; containsArticle: boolean; fields: Record<'explicitHeadline' | 'author' | 'publishedAt', string[]>;
    images: string[] }> = [];
  type Scope = typeof scopes[number];
  const stack = document.childNodes.map(node => ({ node, scope: null as Scope | null }));
  while (stack.length) {
    const entry = stack.pop()!;
    const { node } = entry;
    if (!('tagName' in node)) continue;
    const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
    const tag = node.tagName;
    if (['aside', 'footer', 'nav', 'template', 'script', 'style'].includes(tag) ||
        attrs.has('hidden') || attrs.get('aria-hidden') === 'true' ||
        metadataExcluded.test([attrs.get('class'), attrs.get('id')].join(' '))) continue;
    if (tag === 'h1') headings.push(node);

    let scope = entry.scope;
    if (articleType.test(attrs.get('itemtype') ?? '') || tag === 'article') {
      // Some pages mark the same article with both an outer microdata container
      // and an inner article element, so recognise the first explicit scope.
      const itemId = attrs.get('itemid');
      if (itemId && !sameArticle(itemId, url, identity)) continue;
      if (!scope) {
        scope = { matchesUrl: Boolean(itemId), containsArticle: tag === 'article',
          fields: { explicitHeadline: [], author: [], publishedAt: [] }, images: [] };
        scopes.push(scope);
      } else if (tag === 'article') {
        if (scope.containsArticle) continue;
        scope.containsArticle = true;
      }
    }
    const properties = (attrs.get('itemprop') ?? '').toLowerCase().split(/\s+/);
    if (scope) {
      const save = (field: keyof Scope['fields'], raw: unknown): void => {
        const value = text(raw);
        if (value) scope.fields[field].push(value);
      };
      if (tag === 'h1' || properties.includes('headline')) {
        save('explicitHeadline', attrs.get('content') ?? markedText(node));
      }
      const byline = /(?:^|\s)(?:byline|article-byline)(?:\s|$)/i.test(attrs.get('class') ?? '');
      if (properties.includes('author') || attrs.get('rel')?.split(/\s+/).includes('author') || byline) {
        const name = markedText(node, properties.includes('author') && attrs.has('itemtype'));
        save('author', attrs.get('content') ?? name.replace(/^by\s+/i, ''));
      }
      if (properties.includes('datepublished') || tag === 'time' &&
          /(?:^|\s)(?:published|publication-date|published-date|article-date)(?:\s|$)/i.test(attrs.get('class') ?? '')) {
        save('publishedAt', attrs.get('datetime') ?? attrs.get('content') ?? markedText(node));
      }
      if (properties.includes('image') || properties.includes('thumbnailurl')) {
        const image = attrs.get('content') ?? attrs.get('src') ?? attrs.get('href');
        if (image) scope.images.push(image);
      }
    }
    for (const child of [...node.childNodes].reverse()) stack.push({ node: child, scope });
  }
  const matchedByUrl = scopes.filter(scope => scope.matchesUrl);
  const matchedByTitle = scopes.filter(scope =>
    scope.fields.explicitHeadline.some(title => expectedTitles.includes(title)));
  const ranked = matchedByUrl.length ? matchedByUrl : matchedByTitle.length ? matchedByTitle : scopes;
  const scope = ranked.length === 1 ? ranked[0] : null;
  if (!scope) return {};
  const explicitHeadline = uniqueValue(scope.fields.explicitHeadline);
  return {
    explicitHeadline,
    verifiedHeadline: scope.matchesUrl || matchedByTitle.includes(scope) ? explicitHeadline : null,
    author: uniqueValue(scope.fields.author),
    ...publicationEvidence(scope.fields.publishedAt),
    structuredImages: scope.images,
  };
}

function markedText(element: MarkedElement, preferMarkedName = false): string {
  // Collect text only inside selected metadata elements. An author microdata
  // object may include affiliations and links, so prefer its explicit name.
  const stack = element.childNodes.map(node => ({ node, name: !preferMarkedName })).reverse();
  let value = '';
  while (stack.length > 0 && value.length < 1000) {
    const { node, name } = stack.pop()!;
    if (name && node.nodeName === '#text' && 'value' in node) value += node.value;
    else if ('tagName' in node && !['template', 'script', 'style'].includes(node.tagName)) {
      const nameField = node.attrs.some(attr =>
        attr.name === 'itemprop' && attr.value.toLowerCase().split(/\s+/).includes('name'));
      const content = nameField ? node.attrs.find(attr => attr.name === 'content')?.value : undefined;
      if (content) value += content;
      else stack.push(...node.childNodes.map(child => ({ node: child, name: name || nameField })).reverse());
    }
  }
  return value;
}

const PUBLICATION_LABEL = /^(?:published on|publication date|date published|published)\s*(?::\s*|\s+|$)/i;
const EXACT_PUBLICATION_LABEL = /^(?:published on|publication date|date published|published)\s*:?$/i;
const HEADER_CONTAINER = /(?:^|[\s_-])(?:article|post|news|press[-_]release|blog)[-_ ](?:header|hero|heading|title)(?:$|[\s_-])/i;
const HEADER_TEXT_TAGS = new Set(['div', 'span', 'p', 'time', 'small', 'strong', 'b', 'em']);
const HEADER_SPACING_CLASS = /(?:^|[\s_-])(?:spacer|spacing|space|gap)(?:$|[\s_-])/i;
const MAX_HEADER_FIELD_LENGTH = 600;
const MAX_HEADER_DATE_FIELDS = 3;
const MAX_HEADER_SPACERS = 2;

function attribute(element: MarkedElement, name: string): string | undefined {
  return element.attrs.find(attr => attr.name === name)?.value;
}

function elementChildren(parent: MarkedElement): MarkedElement[] {
  return parent.childNodes.filter((node): node is MarkedElement => 'tagName' in node);
}

function emptyHeaderSpacer(element: MarkedElement): boolean {
  const location = element.sourceCodeLocation;
  const classes = attribute(element, 'class') ?? '';
  return (element.tagName === 'div' || element.tagName === 'span') &&
    Boolean(location?.endTag && location.endOffset - location.startOffset <= MAX_HEADER_FIELD_LENGTH) &&
    HEADER_SPACING_CLASS.test(classes) && !metadataExcluded.test(classes) && !/(?:^|\s)w-dyn-/i.test(classes) &&
    element.attrs.every(({ name, value }) => name === 'class' ||
      name === 'aria-hidden' && value === 'true' || name === 'role' && ['none', 'presentation'].includes(value)) &&
    element.childNodes.every(node => node.nodeName === '#comment' ||
      node.nodeName === '#text' && 'value' in node && node.value.trim() === '');
}

function followingHeaderFields(parent: MarkedElement, heading: MarkedElement): MarkedElement[] {
  const fields: MarkedElement[] = [];
  let spacers = 0;
  // Allow one extra field for a standalone label's adjoining value.
  for (let index = parent.childNodes.indexOf(heading) + 1; fields.length <= MAX_HEADER_DATE_FIELDS; index++) {
    const node = parent.childNodes[index];
    if (!node) break;
    if (!('tagName' in node)) {
      if (node.nodeName === '#text' && 'value' in node && node.value.trim()) break;
      continue;
    }
    if (!emptyHeaderSpacer(node)) fields.push(node);
    else if (++spacers > MAX_HEADER_SPACERS) break;
  }
  return fields;
}

function webflowMarkers(htmlHead: string): boolean {
  const html = /<html\b[^>]*>/i.exec(htmlHead)?.[0];
  if (html) {
    const attrs = metaAttributes(html);
    if (attrs.get('data-wf-page') && attrs.get('data-wf-site')) return true;
  }
  return (htmlHead.match(/<meta\b[^>]*>/gi) ?? []).some(tag => {
    const attrs = metaAttributes(tag);
    return attrs.get('name')?.toLowerCase() === 'generator' && /^webflow$/i.test(attrs.get('content') ?? '');
  });
}

// Restrict text inspection to short, explicitly closed header fields. Larger
// containers, rich text, links, and embedded or hidden components cannot be dates.
function headerFieldText(element: MarkedElement): string | null {
  const location = element.sourceCodeLocation;
  if (!location?.endTag || location.endOffset - location.startOffset > MAX_HEADER_FIELD_LENGTH ||
      !HEADER_TEXT_TAGS.has(element.tagName) || attribute(element, 'hidden') !== undefined ||
      attribute(element, 'aria-hidden') === 'true' ||
      metadataExcluded.test(attribute(element, 'class') ?? '') ||
      elementChildren(element).some(child => headerFieldText(child) === null)) return null;
  return normaliseMetadataText(markedText(element));
}

function labelledHeaderDate(element: MarkedElement, next: MarkedElement | undefined):
  { value: string; consumesNext: boolean } | null {
  const content = headerFieldText(element);
  if (content === null) return null;
  const fields = elementChildren(element);
  const [labelField, dateField] = fields;
  if (fields.length === 2 && labelField && dateField &&
      EXACT_PUBLICATION_LABEL.test(headerFieldText(labelField) ?? '')) {
    return { value: (dateField.tagName === 'time' ? attribute(dateField, 'datetime') : null) ??
      headerFieldText(dateField) ?? '', consumesNext: false };
  }
  const time = fields.length === 1 && labelField?.tagName === 'time' ? labelField : null;
  const directText = time ? element.childNodes.flatMap(node => 'value' in node ? [node.value] : []).join(' ') : '';
  if (time && EXACT_PUBLICATION_LABEL.test(normaliseMetadataText(directText))) {
    return { value: attribute(time, 'datetime') ?? headerFieldText(time) ?? '', consumesNext: false };
  }
  const label = PUBLICATION_LABEL.exec(content);
  if (!label) return null;
  const inline = content.slice(label[0].length);
  if (inline) return publisherPublicationDate(inline) ? { value: inline, consumesNext: false } : null;
  if (!next) return null;
  const nextText = headerFieldText(next);
  if (nextText === null) return null;
  return { value: (next.tagName === 'time' ? attribute(next, 'datetime') : null) ?? nextText, consumesNext: true };
}

function webflowArticleHeader(document: DefaultTreeAdapterTypes.Document, heading: MarkedElement | undefined,
  url: string, head: ArticleHeadMetadata, identity?: ArticleIdentity): NativeMetadata {
  if (!heading?.sourceCodeLocation?.endTag || !sameArticle(url, url, identity)) return {};
  const html = document.childNodes.find((node): node is MarkedElement => 'tagName' in node && node.tagName === 'html');
  const pageHead = html && elementChildren(html).find(node => node.tagName === 'head');
  const declarations = pageHead ? elementChildren(pageHead) : [];
  const markers = html && attribute(html, 'data-wf-page') && attribute(html, 'data-wf-site');
  const generator = declarations.some(node => node.tagName === 'meta' &&
    attribute(node, 'name')?.toLowerCase() === 'generator' && /^webflow$/i.test(attribute(node, 'content') ?? ''));
  if (!markers && !generator) return {};
  const matchingUrls = declarations.flatMap(node => {
    if (node.tagName === 'link' && attribute(node, 'rel')?.toLowerCase().split(/\s+/).includes('canonical')) {
      return [attribute(node, 'href')];
    }
    if (node.tagName === 'meta' && attribute(node, 'property')?.toLowerCase() === 'og:url') {
      return [attribute(node, 'content')];
    }
    return [];
  });
  if (matchingUrls.some(value => !sameArticle(value, url, identity))) return {};
  const articleType = declarations.some(node => node.tagName === 'meta' &&
    attribute(node, 'property')?.toLowerCase() === 'og:type' &&
    attribute(node, 'content')?.toLowerCase().trim() === 'article');
  const page = new URL(url);
  // The contract verifies this collection permalink even when OG type is missing.
  const knownPermalink = ['uk100.org', 'www.uk100.org'].includes(page.hostname) &&
    /^\/press-releases\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(page.pathname);

  let headerContext = false;
  let current = heading;
  const labelledDates: string[] = [];
  for (let depth = 0; depth < 4; depth++) {
    const parent = current.parentNode;
    if (!parent || !('tagName' in parent) || parent.tagName === 'body' && current !== heading) break;
    const classes = attribute(parent, 'class') ?? '';
    if (/(?:^|\s)w-dyn-item(?:\s|$)/i.test(classes)) return {};
    headerContext ||= parent.tagName === 'header' || HEADER_CONTAINER.test(classes);
    const position = elementChildren(parent).indexOf(current);
    // Only contiguous metadata beside the heading or its leading wrapper belongs to this header.
    if (position === 0 || current === heading) {
      const fields = followingHeaderFields(parent, current);
      for (let index = 0; index < MAX_HEADER_DATE_FIELDS && fields[index]; index++) {
        const date = labelledHeaderDate(fields[index]!, fields[index + 1]);
        if (!date) break;
        labelledDates.push(date.value);
        if (date.consumesNext) index++;
      }
    }
    if (position !== 0 && current !== heading) break;
    current = parent;
  }
  const today = new Date().toISOString();
  const dates = labelledDates.map(value => publisherPublicationDate(value));
  const distinct = new Set(dates);
  const value = dates[0];
  const publishedAt = value && distinct.size === 1 && value <= today.slice(0, value.length) ? value : null;
  const primary = Boolean(headerContext || labelledDates.length);
  const article = articleType || head.verifiedHeadline || matchingUrls.length && publishedAt ||
    knownPermalink && (matchingUrls.length || labelledDates.length);
  if (!primary || !article) return {};
  const explicitHeadline = text(markedText(heading));
  return { explicitHeadline, verifiedHeadline: explicitHeadline, publishedAt };
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
  explicitHeadline?: string | null;
  verifiedHeadline?: string | null;
  publishedAtConflict?: boolean;
  structuredImages?: string[];
};

export function extractArticleHeadMetadata(htmlHead: string, requestUrl?: string,
  identity?: ArticleIdentity): ArticleHeadMetadata {
  htmlHead = htmlHead.split(/<body\b/i, 1)[0] ?? '';
  const metadata = new Map<string, string | null>();
  for (const tag of htmlHead.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = metaAttributes(tag);
    const name = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (name && content) {
      const previous = metadata.get(name);
      if (previous === undefined) metadata.set(name, content);
      else if (previous !== content) metadata.set(name, null);
    }
  }
  const title = (name: string): string | null => {
    const value = metadata.get(name);
    return value ? normaliseMetadataText(value) || null : null;
  };
  const htmlTitle = text(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(htmlHead)?.[1]);
  const ogUrl = title('og:url');
  if (requestUrl && (metadata.has('og:url') && !ogUrl || ogUrl && !sameArticle(ogUrl, requestUrl, identity))) {
    for (const key of metadata.keys()) {
      if (/^(?:og:|twitter:|article:)/.test(key)) metadata.delete(key);
    }
  }
  const structured = structuredArticleMetadata(htmlHead, requestUrl, title('og:title') ?? htmlTitle, identity);
  const byline = [structured.author, title('author'), title('article:author'),
    title('og:article:author'), title('dc.creator'), title('dcterms.creator')]
    .find(value => value && !/^(?:https?:|mailto:|\/\/)/i.test(value));
  const dateProperties = ['article:published_time', 'og:article:published_time',
    'dcterms.issued', 'dc.date.issued', 'dc.date.published', 'datepublished'];
  const publication = structured.publishedAt || structured.publishedAtConflict ? structured
    : dateProperties.some(name => metadata.has(name) && metadata.get(name) === null)
      ? { publishedAtConflict: true } : publicationEvidence(dateProperties.map(title));
  return {
    ...(structured.explicitHeadline ? { explicitHeadline: structured.explicitHeadline } : {}),
    ...(structured.verifiedHeadline && requestUrl && sameArticle(requestUrl, requestUrl, identity)
      ? { verifiedHeadline: structured.verifiedHeadline } : {}),
    ...(structured.structuredImages?.length ? { structuredImages: structured.structuredImages } : {}),
    ...(publication.publishedAtConflict ? { publishedAtConflict: true } : {}),
    ogImage: metadata.get('og:image') ?? null,
    twitterImage: metadata.get('twitter:image') ?? null,
    ogTitle: title('og:title'),
    twitterTitle: title('twitter:title'),
    htmlTitle,
    ogDescription: title('og:description'),
    twitterDescription: title('twitter:description'),
    htmlDescription: title('description'),
    publisher: title('og:site_name') ?? structured.publisher ?? null,
    author: byline ?? null,
    publishedAt: publication.publishedAt ?? null,
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

function hasSufficientEarlyMetadata(metadata: ArticleHeadMetadata): boolean {
  return Boolean(
    (metadata.ogImage || metadata.twitterImage) &&
    metadata.publishedAt &&
    (metadata.ogTitle || metadata.twitterTitle || metadata.htmlTitle),
  );
}

export function extractPublisherArticleMetadata(html: string, url: string,
  expectedTitle?: string, head?: ArticleHeadMetadata, identity?: ArticleIdentity): ArticleHeadMetadata {
  head ??= extractArticleHeadMetadata(html, url, identity);
  const titles = [head.explicitHeadline, head.ogTitle, head.htmlTitle, expectedTitle]
    .filter((title): title is string => Boolean(title));
  const webflow = webflowMarkers(html.split(/<\/head\s*>/i, 1)[0] ?? '');
  const document = parse(html, { sourceCodeLocationInfo: webflow });
  const headings: MarkedElement[] = [];
  const marked = markedArticleMetadata(document, url, titles, headings, identity);
  const visible = webflow && headings.length === 1
    ? webflowArticleHeader(document, headings[0], url, head, identity) : {};
  const markedVerified = sameArticle(url, url, identity) ? marked.verifiedHeadline : null;
  const dateConflict = head.publishedAtConflict || !head.publishedAt && marked.publishedAtConflict;
  return {
    ...head,
    explicitHeadline: visible.explicitHeadline ?? marked.explicitHeadline ?? head.explicitHeadline,
    verifiedHeadline: visible.verifiedHeadline ?? markedVerified ?? head.verifiedHeadline,
    author: head.author ?? marked.author ?? null,
    ...(dateConflict ? { publishedAtConflict: true } : {}),
    publishedAt: dateConflict ? null : head.publishedAt ?? marked.publishedAt ?? visible.publishedAt ?? null,
    structuredImages: [...(head.structuredImages ?? []), ...(marked.structuredImages ?? [])],
  };
}

type VisibleOptions = { enabled: true; needAuthor: boolean; needDate: boolean;
  needImage: boolean; needHeadline: boolean; expectedTitle?: string };

export function previewImageFromPublisherMetadata(metadata: ArticleHeadMetadata, url: string,
  source: Pick<Source, 'source_key' | 'canonical_domain'>): string | null {
  for (const candidate of [metadata.ogImage, metadata.twitterImage, ...(metadata.structuredImages ?? [])]) {
    if (!candidate) continue;
    try {
      const raw = decodeHtmlEntities(candidate).trim();
      const absolute = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw
        : raw.startsWith('//') ? 'https:' + raw : new URL(raw, url).href;
      const preview = source.source_key === 'the-guardian'
        ? guardianRemotePreviewUrl(absolute) : remotePreviewUrl(absolute, source);
      if (preview) return preview;
    } catch { /* Invalid preview URL. */ }
  }
  return null;
}

async function readHtmlHead(response: Response, signal: AbortSignal, url: string,
  source: Pick<Source, 'source_key' | 'canonical_domain' | 'image_policy'>,
  canonicalUrl: string, options?: VisibleOptions):
  Promise<{ metadata: ArticleHeadMetadata; visibleImage: string | null; partialFailure: boolean }> {
  if (!response.body) throw new ScanError('article_head_missing_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let html = '';
  let head: ArticleHeadMetadata | undefined;
  let webflow = false;
  let earlyPrefixAt = 32 * 1024;
  const identity = { canonicalUrl, source };
  const finish = (head: ArticleHeadMetadata, prefix = '', partialFailure = false) => {
    const metadata = prefix ? extractPublisherArticleMetadata(prefix, url, options?.expectedTitle, head, identity) : head;
    if (prefix && source.source_key === 'families-for-clean-air' &&
        options?.needDate && options.expectedTitle && !metadata.publishedAt && !metadata.publishedAtConflict) {
      metadata.publishedAt = extractFamiliesForCleanAirPublishedDate(prefix, options.expectedTitle);
    }
    let visibleImage: string | null = null;
    if (options?.needImage && prefix && !previewImageFromPublisherMetadata(metadata, url, source)) {
      visibleImage = extractArticleVisiblePreviewImage(prefix, url, source, false, false);
      if (!visibleImage && source.source_key === 'dsawsp') {
        visibleImage = extractDsawspArticlePreviewImage(prefix, url, source, false);
      }
    }
    return { metadata, visibleImage, partialFailure };
  };
  const hasPartial = (metadata: ArticleHeadMetadata): boolean => Boolean(
    metadata.author || metadata.publishedAt || metadata.explicitHeadline || metadata.ogTitle ||
      metadata.twitterTitle || metadata.htmlTitle || metadata.publisher || previewImageFromPublisherMetadata(metadata, url, source));
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (head) return finish(head, html);
        if (options) {
          const partial = extractArticleHeadMetadata(html, url, identity);
          if (hasPartial(partial)) return finish(partial);
        }
        throw new ScanError('article_head_incomplete');
      }
      const portion = value.subarray(0, MAX_HEAD_BYTES - bytes);
      bytes += portion.byteLength;
      html += decoder.decode(portion, { stream: true });
      if (!head) {
        const closingHead = /<\/head\s*>/i.exec(html);
        const body = /<body\b/i.exec(html);
        const headOnly = body ? html.slice(0, body.index) : html;
        if (closingHead && (!body || closingHead.index < body.index)) {
          const htmlHead = html.slice(0, closingHead.index);
          head = extractArticleHeadMetadata(htmlHead, url, identity);
          webflow = Boolean(options && webflowMarkers(htmlHead));
          if (!options || (!options.needAuthor || head.author) && (!options.needDate || head.publishedAt) &&
              (!options.needHeadline || !webflow && head.explicitHeadline) &&
              (!options.needImage || previewImageFromPublisherMetadata(head, url, source))) return finish(head);
        } else {
          const metadata = extractArticleHeadMetadata(headOnly, url, identity);
          webflow = Boolean(options && webflowMarkers(headOnly));
          if (body && webflow) {
            // HTML may omit the explicit head end tag before opening the body.
            head = metadata;
          } else if (!(webflow && options?.needHeadline) && hasSufficientEarlyMetadata(metadata) &&
              (!options || body || (!options.needAuthor || metadata.author) &&
                (!options.needHeadline || metadata.explicitHeadline))) return finish(metadata);
          if (body && !head) {
            if (options && hasPartial(metadata)) return finish(metadata);
            throw new ScanError('article_head_incomplete');
          }
        }
      }
      if (head && options && !(webflow && options.needHeadline) && bytes >= earlyPrefixAt && bytes < MAX_HEAD_BYTES) {
        earlyPrefixAt = bytes + 64 * 1024;
        const result = finish(head, html);
        if ((!options.needAuthor || result.metadata.author) && (!options.needDate || result.metadata.publishedAt) &&
            (!options.needHeadline || result.metadata.explicitHeadline) &&
            (!options.needImage || result.visibleImage || previewImageFromPublisherMetadata(result.metadata, url, source))) return result;
      }
      if (bytes >= MAX_HEAD_BYTES) {
        if (head) return finish(head, html);
        const partial = extractArticleHeadMetadata(html, url, identity);
        if (options && hasPartial(partial)) return finish(partial);
        throw new ScanError('article_head_too_large');
      }
    }
  } catch (error) {
    if (head && options) return finish(head, html, true);
    if (options) {
      const partial = extractArticleHeadMetadata(html, url, identity);
      if (hasPartial(partial)) return finish(partial, '', true);
    }
    if (error instanceof ScanError) throw error;
    if (signal.aborted) throw new ScanError('article_head_timeout');
    throw new ScanError('article_head_read_failed');
  } finally {
    try { await reader.cancel('Bounded metadata read complete'); } catch { /* best effort */ }
  }
}

export async function fetchArticleHeadMetadata(article: string | PublisherArticleMetadataTarget,
  source: Pick<Source, 'source_key' | 'canonical_domain' | 'image_policy'>,
  requireAllowedUrl?: (url: string) => Promise<void>, options?: VisibleOptions):
  Promise<ArticleHeadMetadata & { previewUrl: string | null; previewError: string | null;
    checkedAt: string; partialFailure: boolean; recovered: boolean }> {
  if (source.image_policy !== 'remote_preview' ||
      ['the-guardian', 'openaq', 'global-action-plan'].includes(source.source_key)) {
    throw new ScanError('article_head_not_permitted');
  }
  let target: PublisherArticleMetadataTarget;
  if (typeof article === 'string') {
    target = { canonical_url: article, original_url: article };
    if (publisherHttpsUrl(article, source)) {
      try { target.canonical_url = canonicalizeUrl(article, source); }
      catch { /* Preserve the legacy HTTPS target when the source cannot canonicalise it. */ }
    }
  } else {
    target = article;
  }
  return fetchPublisherArticleMetadata(target, source, async (response, requestUrl, signal, recovered) => {
    const visible = options ?? (recovered ? {
      enabled: true, needImage: true, needAuthor: false, needDate: false, needHeadline: false,
    } as const : undefined);
    const { metadata, visibleImage, partialFailure } = await readHtmlHead(response,
      signal, requestUrl, source, target.canonical_url, visible);
    const candidates = [metadata.ogImage, metadata.twitterImage, ...(metadata.structuredImages ?? [])]
      .filter((value): value is string => Boolean(value));
    let preview = previewImageFromPublisherMetadata(metadata, requestUrl, source) ?? visibleImage;
    if (!preview && !options && !recovered) {
      try { preview = await fetchArticleVisiblePreviewImage(requestUrl, source, fetch, requireAllowedUrl); }
      catch { /* Legacy preview caller treats visible image as optional. */ }
    }
    if (!preview && !options && !recovered && source.source_key === 'dsawsp') {
      try {
        preview = await fetchDsawspArticlePreviewImage(requestUrl, source, async (input, init) => {
          if (requireAllowedUrl) await requireAllowedUrl(String(input));
          return fetch(input, init);
        });
      } catch { /* Publisher-specific visible image is optional. */ }
    }
    let previewError: string | null = null;
    if (!preview && candidates.length > 0) {
      try { previewError = `invalid_preview_image_host:${new URL(candidates[0]!).hostname}`; }
      catch { previewError = 'invalid_preview_image_url'; }
    } else if (!preview) previewError = 'preview_image_metadata_missing';
    return { ...metadata, previewUrl: preview, previewError,
      checkedAt: new Date().toISOString(), partialFailure, recovered };
  }, { requireAllowedUrl });
}

export async function discoverArticleHeadPreviewMetadata(article: DiscoveredArticle,
  source: Source, requireAllowedUrl?: (url: string) => Promise<void>): Promise<Pick<DiscoveredArticle, 'preview_url' | 'display_title' |
    'display_title_origin' | 'preview_metadata_checked_at' | 'publisher_resolved_urls' |
    'author' | 'published_at'>> {
  const resolvedUrls: string[] = [];
  const metadata = await fetchArticleHeadMetadata(article, source, async url => {
    if (requireAllowedUrl) await requireAllowedUrl(url);
    resolvedUrls.push(url);
  });
  const displayTitle = compactPublisherTitle(article.title,
    [metadata.ogTitle, metadata.twitterTitle]);
  const previewUrl = metadata.previewUrl;
  return {
    preview_url: previewUrl,
    author: article.author ?? normaliseArticleAuthorForStorage(metadata.author, source.name),
    published_at: article.published_at ?? publisherPublicationDate(metadata.publishedAt),
    display_title: displayTitle,
    display_title_origin: displayTitle ? 'publisher' : null,
    preview_metadata_checked_at: metadata.checkedAt,
    publisher_resolved_urls: resolvedUrls,
  };
}
