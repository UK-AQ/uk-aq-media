import assert from 'node:assert/strict';
import {
  discoverArticleHeadPreviewMetadata, extractArticleHeadMetadata, extractPublisherArticleMetadata, fetchArticleHeadMetadata,
  publisherPublicationDate,
} from '../packages/discovery/src/article-head-metadata';
import { ScanError } from '../packages/discovery/src/rss';
import { normalisePublisherHeadline, resolvePublisherHeadMetadata }
  from '../packages/discovery/src/publisher-metadata';
import {
  canonicalizeUrl, publisherHttpsUrl, remotePreviewUrl, type DiscoveredArticle, type Source,
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
  search_index_policy: 'metadata_only',
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

const wrapped = 'Air pollution and asthma | Publisher';
assert.equal(normalisePublisherHeadline(wrapped, 'Publisher'), 'Air pollution and asthma');
assert.equal(normalisePublisherHeadline(wrapped, 'Publisher', wrapped), wrapped);
assert.equal(normalisePublisherHeadline('In conversation with Publisher', 'Publisher'),
  'In conversation with Publisher');
assert.equal(normalisePublisherHeadline('Air quality | Publisher | Publisher', 'Publisher'),
  'Air quality | Publisher');

let metadataRequests = 0;
globalThis.fetch = async () => {
  metadataRequests++;
  return streamedHtml([
    `<head><title>${wrapped}</title><script type="application/ld+json">
      {"@graph":[{"@type":"NewsArticle","url":"/recommendation","headline":"Other article","author":"Other Author"},
      {"@type":"NewsArticle","url":"/article","datePublished":"2026-09-17T00:00:00","dateModified":"2026-09-20"}]}
    </script></head>`,
    '<body><article><h1>Air pollution and asthma</h1><p class="byline">By Publisher Author</p></article>',
  ]);
};
try {
  const resolved = await resolvePublisherHeadMetadata(article.canonical_url, source, async () => {}, {
    title: wrapped, author: null, published_at: null, fresh: true,
    image_url: 'https://publisher.example/existing.jpg',
  });
  assert.equal(resolved.title, 'Air pollution and asthma');
  assert.equal(resolved.author, 'Publisher Author');
  assert.equal(resolved.published_at, '2026-09-17');
  assert.equal(metadataRequests, 1);
} finally { globalThis.fetch = originalFetch; }
assert.equal(publisherPublicationDate('2026-09-17'), '2026-09-17');
assert.equal(publisherPublicationDate('2026-09-17T00:00:00+01:00'), '2026-09-16T23:00:00.000Z');
assert.equal(publisherPublicationDate('2026-02-29T00:00:00'), null);
assert.equal(publisherPublicationDate('November 18 2026'), '2026-11-18');
assert.equal(publisherPublicationDate('November 31, 2026'), null);
assert.equal(publisherPublicationDate('1 January 9999'), null);

// Regression using the reported UK100 headline, publication label and image markup.
const uk100Source = { ...source, source_key: 'manual-54fe264e4b18', name: 'uk100.org', canonical_domain: 'uk100.org' };
const uk100Url = 'https://uk100.org/press-releases/councils-join-the-call-not-to-slam-on-the-brakes-on-clean-cars';
const uk100Headline = 'Councils join the call not to slam on the brakes on clean cars';
const uk100Wrapper = 'Councils join the call not to slam the brakes on clean cars | UK100';
const uk100Image = 'https://cdn.prod.website-files.com/695fd77a8911373012667194/6afb3c034c7cb1dc48c6283d_uk100-news-ccc-zev-letter-18-nov-2026.png';
globalThis.fetch = async () => streamedHtml([
  `<html data-wf-page="page" data-wf-site="site"><head><title>${uk100Wrapper}</title>
  <meta property="og:image" content="${uk100Image}"></head>`,
  `<body><main><div>
    <h1 class="heading-style-h3">${uk100Headline}</h1>
    <div class="spacer-large"></div>
    <div class="date_wrapper">
      <div class="date">Published on</div>
      <div class="date">18 November 2026</div>
    </div>
  </div></main></body></html>`,
]);
try {
  const resolved = await resolvePublisherHeadMetadata(uk100Url, uk100Source, async () => {}, {
    title: uk100Wrapper, author: null, published_at: null, image_url: null, fresh: true,
  });
  assert.equal(resolved.title, uk100Headline);
  assert.equal(resolved.verified_headline, uk100Headline);
  assert.equal(resolved.publisher, 'UK100');
  assert.equal(resolved.published_at, '2026-11-18');
  assert.equal(resolved.image_url, uk100Image);
  assert.equal(resolved.author, null);
} finally { globalThis.fetch = originalFetch; }

const layoutSpacer = '<span class="layout-gap" role="presentation"> </span>';
const labelledDate = '<div>Publication date: 18 November 2026</div>';
for (const [following, expected] of [
  [`${layoutSpacer}<div class="article_spacing"></div>${labelledDate}`, '2026-11-18'],
  [`${layoutSpacer.repeat(3)}${labelledDate}`, null],
  [`<div class="spacer-large">Article prose</div>${labelledDate}`, null],
  [`<div class="spacer-large related-items"></div>${labelledDate}`, null],
  [`${labelledDate}${layoutSpacer}<div>Published: 17 November 2026</div>`, null],
] as const) {
  const result = extractPublisherArticleMetadata(`<html><head>
    <meta name="generator" content="Webflow"><meta property="og:type" content="article">
    </head><body><main><div><h1>Clean air news</h1>${following}</div></main></body></html>`,
  article.canonical_url);
  assert.equal(result.publishedAt, expected, following);
}

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

assert.equal(publisherHttpsUrl(
  'https://www.bbc.com/future/article/20260917-example', bbcSource),
'https://www.bbc.com/future/article/20260917-example');
assert.equal(canonicalizeUrl(
  'https://www.bbc.com/future/article/20260917-example', bbcSource),
'https://bbc.com/future/article/20260917-example');

const manualBbcSource: Source = {
  ...source,
  source_key: 'manual-bbc',
  name: 'bbc.com',
  canonical_domain: 'bbc.com',
};
assert.equal(remotePreviewUrl(bbcPreview, manualBbcSource), bbcPreview);

let visibleImageRequests = 0;
globalThis.fetch = async () => {
  visibleImageRequests++;
  return visibleImageRequests === 1
    ? new Response('<head><title>Article without social image</title></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response(`<body>
        <header><img src="https://publisher.example/logo.png" width="40" height="40"></header>
        <main><article>
          <picture>
            <source srcset="https://publisher.example/hero-640.jpg 640w, https://publisher.example/hero-1280.jpg 1280w">
            <img src="https://publisher.example/hero.jpg" alt="Article photograph">
          </picture>
        </article></main>
      </body>`, { headers: { 'Content-Type': 'text/html' } });
};
try {
  const visible = await fetchArticleHeadMetadata(article.canonical_url, source);
  assert.equal(visible.previewUrl, 'https://publisher.example/hero-1280.jpg');
  assert.equal(visible.previewError, null);
  assert.equal(visibleImageRequests, 2);
} finally { globalThis.fetch = originalFetch; }

const reclCodeSource: Source = {
  ...source,
  source_key: 'manual-reclamecode',
  name: 'reclamecode.nl',
  canonical_domain: 'reclamecode.nl',
};
let reclCodeRequests = 0;
globalThis.fetch = async () => {
  reclCodeRequests++;
  return reclCodeRequests === 1
    ? new Response('<head><title>Heating responsibly?</title></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response(`<main><div class="article-header">
        <img src="/media/ixsnrzjq/thumb-houtkachel.jpg?height=720&width=1280"
          alt="Houtkachel">
      </div></main>`, { headers: { 'Content-Type': 'text/html' } });
};
try {
  const reclCode = await fetchArticleHeadMetadata(
    'https://www.reclamecode.nl/nieuws-agenda/nieuws/verantwoord-stoken-niet-zonder-onderbouwing/',
    reclCodeSource);
  assert.equal(reclCode.previewUrl,
    'https://www.reclamecode.nl/media/ixsnrzjq/thumb-houtkachel.jpg?height=720&width=1280');
  assert.equal(reclCodeRequests, 2);
} finally { globalThis.fetch = originalFetch; }

let reclCodeRawRequests = 0;
globalThis.fetch = async () => {
  reclCodeRawRequests++;
  return reclCodeRawRequests === 1
    ? new Response('<head><title>Heating responsibly?</title></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response(`<body>
        <div data-background-image="/assets/site-logo.png"></div>
        <script type="application/json">
          {"hero":"/media/ixsnrzjq/thumb-houtkachel.jpg?height=720&amp;width=1280"}
        </script>
      </body>`, { headers: { 'Content-Type': 'text/html' } });
};
try {
  const reclCodeRaw = await fetchArticleHeadMetadata(
    'https://www.reclamecode.nl/nieuws-agenda/nieuws/verantwoord-stoken-niet-zonder-onderbouwing/',
    reclCodeSource);
  assert.equal(reclCodeRaw.previewUrl,
    'https://www.reclamecode.nl/media/ixsnrzjq/thumb-houtkachel.jpg?height=720&width=1280');
  assert.equal(reclCodeRawRequests, 2);
} finally { globalThis.fetch = originalFetch; }

const cleanAirFundSource: Source = {
  ...source,
  source_key: 'manual-clean-air-fund',
  name: 'Clean Air Fund',
  canonical_domain: 'cleanairfund.org',
};
const cleanAirFundPreview =
  'https://s40026.pcdn.co/wp-content/uploads/example-1200x875.jpeg.webp';
assert.equal(remotePreviewUrl(cleanAirFundPreview, cleanAirFundSource), cleanAirFundPreview);

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

const cawsSource: Source = {
  ...source,
  source_key: 'communities-against-woodsmoke',
  name: 'Communities Against Woodsmoke',
  canonical_domain: 'communitiesagainstwoodsmoke.com',
};
const cawsArticle: DiscoveredArticle = {
  ...article,
  canonical_url: 'https://communitiesagainstwoodsmoke.com/blog/article/',
  original_url: 'https://communitiesagainstwoodsmoke.com/blog/article/',
};
let cawsRequests = 0;
globalThis.fetch = async () => {
  cawsRequests++;
  return cawsRequests === 1
    ? new Response('<head><meta name="twitter:image" content="https://communitiesagainstwoodsmoke.com/wp-content/uploads/twitter.jpg"></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response('<main><article><img src="https://communitiesagainstwoodsmoke.com/wp-content/uploads/body.jpg"></article></main>',
      { headers: { 'Content-Type': 'text/html' } });
};
try {
  const normalWins = await discoverArticleHeadPreviewMetadata(cawsArticle, cawsSource);
  assert.equal(normalWins.preview_url,
    'https://communitiesagainstwoodsmoke.com/wp-content/uploads/twitter.jpg');
  assert.equal(cawsRequests, 1);
} finally { globalThis.fetch = originalFetch; }

cawsRequests = 0;
globalThis.fetch = async () => {
  cawsRequests++;
  return cawsRequests === 1
    ? new Response('<head><title>No normal image</title></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response('<main><article><img src="https://communitiesagainstwoodsmoke.com/wp-content/uploads/body.jpg"></article></main>',
      { headers: { 'Content-Type': 'text/html' } });
};
try {
  const fallback = await discoverArticleHeadPreviewMetadata(cawsArticle, cawsSource);
  assert.equal(fallback.preview_url,
    'https://communitiesagainstwoodsmoke.com/wp-content/uploads/body.jpg');
  assert.ok(fallback.preview_metadata_checked_at);
  assert.equal(cawsRequests, 2);
} finally { globalThis.fetch = originalFetch; }

cawsRequests = 0;
globalThis.fetch = async () => {
  cawsRequests++;
  return cawsRequests === 1
    ? new Response('<head><title>No normal image</title></head>',
      { headers: { 'Content-Type': 'text/html' } })
    : new Response(null, { status: 403 });
};
try {
  const optionalFailure = await discoverArticleHeadPreviewMetadata(cawsArticle, cawsSource);
  assert.equal(optionalFailure.preview_url, null);
  assert.ok(optionalFailure.preview_metadata_checked_at);
  assert.equal(cawsRequests, 2);
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

const finalHtml = () => new Response(
  '<head><title>Redirected article</title><meta property="og:image" content="https://publisher.example/redirected.jpg"></head>',
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

const canonicalTarget = 'https://publisher.example/article?edition=uk';
const originalTarget = 'https://www.publisher.example/article?edition=uk';
const requests: string[] = [];
const signals = new Set<AbortSignal | null | undefined>();
let location = 'http://www.publisher.example/article?edition=uk#publisher';
let alternateRedirect = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push(url);
  signals.add(init?.signal);
  assert.equal(init?.redirect, 'manual');
  if (url === canonicalTarget || alternateRedirect) {
    return new Response(null, { status: 301, headers: { Location: location } });
  }
  assert.match(url, /^https:\/\/www\.publisher\.example\//);
  return new Response(`<head><meta property="og:url" content="${canonicalTarget}">
    <meta property="og:image" content="/preview.jpg"></head>`,
  { headers: { 'Content-Type': 'text/html' } });
};
try {
  const preferred = originalTarget + '&utm_source=feed#original';
  const direct = await fetchArticleHeadMetadata({ canonical_url: canonicalTarget, original_url: preferred }, source);
  assert.equal(direct.previewUrl, 'https://www.publisher.example/preview.jpg');
  assert.deepEqual(requests.splice(0), [preferred.split('#')[0]]);
  signals.clear();
  const checked: string[] = [];
  const recovered = await fetchArticleHeadMetadata(canonicalTarget, source, async url => { checked.push(url); });
  assert.equal(recovered.previewUrl, 'https://www.publisher.example/preview.jpg');
  assert.deepEqual(requests.splice(0), [canonicalTarget, originalTarget]);
  assert.deepEqual(checked, [canonicalTarget, originalTarget]);
  assert.equal(signals.size, 1);

  alternateRedirect = true;
  await assert.rejects(fetchArticleHeadMetadata(canonicalTarget, source), /article_head_redirect_not_permitted/);
  assert.deepEqual(requests.splice(0), [canonicalTarget, originalTarget]);
  location = 'http://www.publisher.example/article?edition=other';
  await assert.rejects(fetchArticleHeadMetadata(canonicalTarget, source), /article_head_redirect_not_permitted/);
  assert.deepEqual(requests, [canonicalTarget]);
} finally { globalThis.fetch = originalFetch; }

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
