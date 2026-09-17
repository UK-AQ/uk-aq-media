import assert from 'node:assert/strict';
import {
  discoverArticleHeadPreviewMetadata, extractArticleHeadMetadata, fetchArticleHeadMetadata,
} from '../packages/discovery/src/article-head-metadata';
import { ScanError } from '../packages/discovery/src/rss';
import {
  canonicalizeUrl, remotePreviewUrl, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { articleHeadHttpError, metadataImageChange } from
  '../apps/media-admin/src/editorial-dashboard';

const metadata = extractArticleHeadMetadata(`<head>
  <meta content='https://publisher.example/og.jpg' property='og:image'>
  <meta name="twitter:image" content="https://publisher.example/twitter.jpg">
  <meta content="Short &amp; useful &#x2014; title" property="og:title">
  <meta name=twitter:title content='Fallback title'>
  <meta property="og:description" content="Primary &amp; bounded description">
  <meta name="twitter:description" content="Social fallback">
  <meta name="description" content="HTML fallback">
</head><body>not retained</body>`);
assert.deepEqual(metadata, {
  ogImage: 'https://publisher.example/og.jpg',
  twitterImage: 'https://publisher.example/twitter.jpg',
  ogTitle: 'Short & useful — title',
  twitterTitle: 'Fallback title',
  htmlTitle: null,
  ogDescription: 'Primary & bounded description',
  twitterDescription: 'Social fallback',
  htmlDescription: 'HTML fallback',
  publisher: null,
  author: null,
  publishedAt: null,
});

const source: Source = {
  source_key: 'publisher', name: 'Publisher', canonical_domain: 'publisher.example',
  source_type: 'publisher', enabled: true, publication_policy: 'manual',
  review_level: 'standard', priority: 1, discovery_method: 'rss',
  discovery_config: { url: 'https://publisher.example/feed', max_items: 1,
    retain_excerpt: false },
  content_fetch_policy: 'discovery_metadata_only', ai_content_policy: 'disabled',
  image_policy: 'remote_preview',
};
const article: DiscoveredArticle = {
  canonical_url: 'https://publisher.example/article', canonical_url_hash: 'hash',
  original_url: 'https://publisher.example/article', title: 'A much longer publisher feed title',
  author: null, published_at: null, categories: [], title_context: null,
  preview_url: null, display_title: null, display_title_origin: null,
  preview_metadata_checked_at: null,
};
const originalFetch = globalThis.fetch;

function streamedHtml(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() { onCancel?.(); },
  }), { headers: { 'Content-Type': 'text/html' } });
}

let earlyStreamCancelled = false;
globalThis.fetch = async () => streamedHtml([
  `<head><meta property="og:image" content="https://images.publisher.example/early.jpg">
    <meta property="article:published_time" content="2026-09-13T13:08:11Z">
    <title>Complete early metadata</title>`,
  'x'.repeat(256 * 1024),
], () => { earlyStreamCancelled = true; });
try {
  const early = await fetchArticleHeadMetadata(article.canonical_url, source);
  assert.equal(early.previewUrl, 'https://images.publisher.example/early.jpg');
  assert.equal(early.publishedAt, '2026-09-13T13:08:11Z');
  assert.equal(early.htmlTitle, 'Complete early metadata');
  assert.equal(earlyStreamCancelled, true);
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async () => new Response(
  `<head><title>Insufficient metadata</title>
    <meta property="og:image" content="https://images.publisher.example/invalid-date.jpg">
    <meta property="article:published_time" content="not-a-date">${'x'.repeat(256 * 1024)}`,
  { headers: { 'Content-Type': 'text/html' } });
try {
  await assert.rejects(fetchArticleHeadMetadata(article.canonical_url, source),
    (error: unknown) => error instanceof ScanError && error.code === 'article_head_too_large');
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async () => new Response(`<head><title>Head title only</title><body>
  <meta property="og:image" content="https://images.publisher.example/body.jpg">
  <meta property="article:published_time" content="2026-09-13T13:08:11Z"></head>`,
{ headers: { 'Content-Type': 'text/html' } });
try {
  await assert.rejects(fetchArticleHeadMetadata(article.canonical_url, source),
    (error: unknown) => error instanceof ScanError && error.code === 'article_head_incomplete');
} finally { globalThis.fetch = originalFetch; }

const bbcSource: Source = {
  ...source,
  source_key: 'bbc-news',
  name: 'BBC News',
  canonical_domain: 'bbc.co.uk',
};
const bbcPreview =
  'https://ichef.bbci.co.uk/ace/branded_news/1200/cpsprodpb/example/live/article.jpg';
globalThis.fetch = async () => new Response(`<head>
  <meta property="og:image" content="${bbcPreview}">
</head>`, { headers: { 'Content-Type': 'text/html' } });
try {
  const bbcMetadata = await fetchArticleHeadMetadata(
    'https://www.bbc.co.uk/news/articles/example', bbcSource);
  assert.equal(bbcMetadata.previewUrl, bbcPreview);
} finally { globalThis.fetch = originalFetch; }

const physOrgSource: Source = {
  ...source,
  source_key: 'phys-org',
  name: 'Phys.org',
  canonical_domain: 'phys.org',
  ai_content_policy: 'disabled',
};
const physOrgPreview = 'https://scx2.b-cdn.net/gfx/news/hires/2026/article.jpg';
assert.equal(remotePreviewUrl(physOrgPreview, physOrgSource), physOrgPreview);
assert.equal(remotePreviewUrl(physOrgPreview, source), null);
assert.equal(remotePreviewUrl('https://other.b-cdn.net/gfx/article.jpg', physOrgSource), null);
assert.equal(remotePreviewUrl('http://scx2.b-cdn.net/gfx/article.jpg', physOrgSource), null);
assert.equal(canonicalizeUrl('https://www.phys.org/news/article.html', physOrgSource),
  'https://phys.org/news/article.html');
assert.throws(() => canonicalizeUrl(physOrgPreview, physOrgSource), /off_source_article_url/);

globalThis.fetch = async () => new Response(`<head>
  <meta property="og:image" content="https://cdn.example/rejected.jpg">
  <meta name="twitter:image" content="https://images.publisher.example/accepted.jpg">
  <meta property="og:title" content="Compact publisher title">
</head><body>must not be read</body>`, { headers: { 'Content-Type': 'text/html' } });
try {
  const discovered = await discoverArticleHeadPreviewMetadata(article, source);
  assert.equal(discovered.preview_url, 'https://images.publisher.example/accepted.jpg');
  assert.equal(discovered.display_title, 'Compact publisher title');
  assert.ok(discovered.preview_metadata_checked_at);
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async () => new Response(`<head>
  <meta property="og:image" content="${physOrgPreview}">
</head>`, { headers: { 'Content-Type': 'text/html' } });
try {
  const physMetadata = await fetchArticleHeadMetadata(
    'https://phys.org/news/2026-09/article.html', physOrgSource);
  assert.equal(physMetadata.previewUrl, physOrgPreview);
} finally { globalThis.fetch = originalFetch; }

async function checkRedirects(responses: Map<string, Response>, startUrl: string):
  Promise<string[]> {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Accept'), 'text/html,application/xhtml+xml');
    assert.match(new Headers(init?.headers).get('User-Agent') ?? '', /^UK-AQ-Media\//);
    const response = responses.get(url);
    assert.ok(response, `Unexpected article-head request: ${url}`);
    return response;
  };
  try {
    await fetchArticleHeadMetadata(startUrl, source);
    return requests;
  } finally { globalThis.fetch = originalFetch; }
}

const finalHtml = () => new Response('<head><title>Redirected article</title></head>',
  { headers: { 'Content-Type': 'text/html' } });
assert.deepEqual(await checkRedirects(new Map([
  ['https://publisher.example/www', new Response(null,
    { status: 301, headers: { Location: 'https://www.publisher.example/article' } })],
  ['https://www.publisher.example/article', finalHtml()],
]), 'https://publisher.example/www'), [
  'https://publisher.example/www', 'https://www.publisher.example/article',
]);
assert.deepEqual(await checkRedirects(new Map([
  ['https://publisher.example/path/start', new Response(null,
    { status: 302, headers: { Location: '../article' } })],
  ['https://publisher.example/article', finalHtml()],
]), 'https://publisher.example/path/start'), [
  'https://publisher.example/path/start', 'https://publisher.example/article',
]);

const independentSource: Source = {
  ...source,
  source_key: 'the-independent',
  name: 'The Independent',
  canonical_domain: 'the-independent.com',
};
const independentRequests: string[] = [];
globalThis.fetch = async input => {
  const url = String(input);
  independentRequests.push(url);
  if (url === 'https://independent.co.uk/news/legacy') {
    return new Response(null, { status: 301,
      headers: { Location: 'https://www.the-independent.com/news/current' } });
  }
  assert.equal(url, 'https://www.the-independent.com/news/current');
  return new Response(`<head>
    <meta property="og:image" content="https://static.independent.co.uk/legacy-image.jpg">
  </head>`, { headers: { 'Content-Type': 'text/html' } });
};
try {
  const independentMetadata = await fetchArticleHeadMetadata(
    'https://independent.co.uk/news/legacy', independentSource);
  assert.equal(independentMetadata.previewUrl,
    'https://static.independent.co.uk/legacy-image.jpg');
  assert.deepEqual(independentRequests, [
    'https://independent.co.uk/news/legacy',
    'https://www.the-independent.com/news/current',
  ]);
} finally { globalThis.fetch = originalFetch; }

globalThis.fetch = async () => new Response(null,
  { status: 307, headers: { Location: 'https://attacker.example/article' } });
try {
  await assert.rejects(fetchArticleHeadMetadata('https://publisher.example/start', source),
    (error: unknown) => error instanceof ScanError &&
      error.code === 'article_head_redirect_not_permitted');
} finally { globalThis.fetch = originalFetch; }

let redirectRequestCount = 0;
globalThis.fetch = async () => {
  redirectRequestCount += 1;
  return new Response(null, { status: 308, headers: { Location: `/hop-${redirectRequestCount}` } });
};
try {
  await assert.rejects(fetchArticleHeadMetadata('https://publisher.example/start', source),
    (error: unknown) => error instanceof ScanError && error.code === 'article_head_redirect_limit');
  assert.equal(redirectRequestCount, 4);
} finally { globalThis.fetch = originalFetch; }

assert.throws(() => metadataImageChange(null, 'https://publisher.example/a.jpg',
  'https://publisher.example/b.jpg', false), (error: unknown) =>
  error instanceof Error && error.message === 'metadata_proposal_changed' &&
  'status' in error && error.status === 409);
assert.equal(metadataImageChange(null, 'https://publisher.example/a.jpg',
  'https://publisher.example/a.jpg', false), true);
assert.equal(metadataImageChange('https://publisher.example/old.jpg',
  'https://publisher.example/a.jpg', 'https://publisher.example/changed.jpg', false), false);
assert.equal(metadataImageChange('https://publisher.example/old.jpg',
  'https://publisher.example/a.jpg', 'https://publisher.example/a.jpg', true), true);
assert.equal(metadataImageChange(null, null, 'https://publisher.example/unrelated.jpg', false), false);

for (const [code, status] of [
  ['invalid_article_head_url', 400], ['article_head_not_permitted', 409],
  ['article_head_too_large', 413], ['article_head_not_html', 415],
  ['article_head_timeout', 504], ['article_head_fetch_failed', 502],
] as const) {
  const translated = articleHeadHttpError(new Error(code));
  assert.equal(translated.status, status);
  assert.equal(translated.message, code);
}

console.log('Article head metadata checks passed');
