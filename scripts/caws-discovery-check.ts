import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAWS_INDEX_URL, configuredCawsIndex, discoverCaws, extractCawsArticlePreviewImage,
  extractCawsIndexCandidates, fetchCawsArticlePreviewImage,
} from '@uk-aq-media/discovery';
import { initialEditorialState, SourceSchema, z } from '@uk-aq-media/core';
import { ScanError } from '../packages/discovery/src/rss';

const sources = z.array(SourceSchema).parse(JSON.parse(
  readFileSync('config/sources.seed.json', 'utf8'),
));
const source = sources.find(candidate => candidate.source_key ===
  'communities-against-woodsmoke')!;
assert.ok(configuredCawsIndex(source));
assert.deepEqual(initialEditorialState(source), {
  status: 'pending', approval_method: null, approval_author_rule_key: null,
});
const recheckMigration = readFileSync('migrations/0024_caws_preview_image_recheck.sql', 'utf8');
assert.match(recheckMigration, /source_key = 'communities-against-woodsmoke'/);
assert.match(recheckMigration, /image_policy = 'remote_preview'/);
assert.match(recheckMigration, /og_image_url IS NULL/);
assert.match(recheckMigration, /preview_metadata_checked_at IS NOT NULL/);
assert.match(recheckMigration, /1970-01-01T00:00:00\.000Z/);

const html = `<nav><a href="/">Home</a><a href="/contact/">Contact</a></nav>
<section><h1>Blog</h1><p>Check out the latest blog articles below</p>
<article><a href="/blog/first-article/"> First &amp; valid article </a><time>13 May 2026</time></article>
<article><a href="https://www.communitiesagainstwoodsmoke.com/blog/second-article/">Second article</a>
  <div>29 March 2026</div></article>
<article><a href="/health/">Health</a></article>
<article><a href="/blog/no-date/">No date</a></article>
<h2>Other groups campaigning against woodsmoke pollution</h2>
<a href="/blog/after-boundary/">Not an article</a><time>7 February 2026</time></section>
<footer><a href="/privacy-policy/">Privacy Policy</a></footer>`;
assert.deepEqual(extractCawsIndexCandidates(html, source), [
  { canonical_url: 'https://communitiesagainstwoodsmoke.com/blog/first-article/',
    title: 'First & valid article', published_at: '2026-05-13' },
  { canonical_url: 'https://communitiesagainstwoodsmoke.com/blog/second-article/',
    title: 'Second article', published_at: '2026-03-29' },
]);
assert.throws(() => extractCawsIndexCandidates(html.replace(
  'Check out the latest blog articles below', 'Missing start boundary'), source),
error => error instanceof ScanError && error.code === 'caws_listing_start_missing');
assert.throws(() => extractCawsIndexCandidates(html.replace(
  'Other groups campaigning against woodsmoke pollution', 'Missing end boundary'), source),
error => error instanceof ScanError && error.code === 'caws_listing_end_missing');
assert.throws(() => extractCawsIndexCandidates(
  `<p>Check out the latest blog articles below</p>
  <a href="/blog/no-date/">No valid date</a>
  <h2>Other groups campaigning against woodsmoke pollution</h2>`, source),
error => error instanceof ScanError && error.code === 'caws_no_valid_index_candidates');

const requested: string[] = [];
const discovered = await discoverCaws(source, (async (input, init) => {
  requested.push(String(input));
  assert.equal(init?.redirect, 'manual');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}) as typeof fetch);
assert.deepEqual(requested, [CAWS_INDEX_URL]);
assert.equal(discovered.items_seen, 2);
assert.equal(discovered.items_invalid, 0);
assert.deepEqual(discovered.articles.map(article => ({ title: article.title,
  published_at: article.published_at, preview_url: article.preview_url,
  title_context: article.title_context })), [
  { title: 'First & valid article', published_at: '2026-05-13', preview_url: null,
    title_context: null },
  { title: 'Second article', published_at: '2026-03-29', preview_url: null,
    title_context: null },
]);

const articleUrl = 'https://communitiesagainstwoodsmoke.com/blog/first-article/';
const contentImage = 'https://www.communitiesagainstwoodsmoke.com/wp-content/uploads/article.jpg';
const structuredImage =
  'https://communitiesagainstwoodsmoke.com/wp-content/uploads/structured.jpg';
const articleHtml = `<html><head>
  <script type="application/ld+json">{"@type":"BlogPosting","image":"${structuredImage}"}</script>
</head><body>
  <header><img src="https://communitiesagainstwoodsmoke.com/logo.png"></header>
  <nav><img src="https://communitiesagainstwoodsmoke.com/nav.png"></nav>
  <main><article><img src="${contentImage}"></article>
    <aside><img src="https://communitiesagainstwoodsmoke.com/sidebar.png"></aside>
    <section class="related-posts"><img src="https://communitiesagainstwoodsmoke.com/related.png"></section>
  </main><footer><img src="https://communitiesagainstwoodsmoke.com/footer.png"></footer>
</body></html>`;
assert.equal(extractCawsArticlePreviewImage(articleHtml, articleUrl, source), structuredImage);
assert.equal(extractCawsArticlePreviewImage(`<header><img src="${contentImage}"></header>
  <main><article><img src="${contentImage}"></article></main>`, articleUrl, source), contentImage);
assert.equal(extractCawsArticlePreviewImage(`<main><article>
  <img src="https://external.example/image.jpg"></article></main>`, articleUrl, source), null);
assert.equal(extractCawsArticlePreviewImage(`<nav><img src="${contentImage}"></nav>
  <main><section class="related"><img src="${contentImage}"></section></main>
  <footer><img src="${contentImage}"></footer>`, articleUrl, source), null);
assert.equal(extractCawsArticlePreviewImage(articleHtml, articleUrl,
  { ...source, source_key: 'another-publisher' }), null);

let previewCancelled = false;
const encoder = new TextEncoder();
const previewRequests: string[] = [];
const fetchedImage = await fetchCawsArticlePreviewImage(articleUrl, source,
  (async (input, init) => {
    previewRequests.push(String(input));
    assert.equal(init?.redirect, 'manual');
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(encoder.encode(
          `<main><article><img src="${contentImage}">`)); }
        else controller.enqueue(encoder.encode('x'.repeat(512 * 1024)));
      },
      cancel() { previewCancelled = true; },
    }), { headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch);
assert.equal(fetchedImage, contentImage);
assert.deepEqual(previewRequests, [articleUrl]);
assert.equal(previewCancelled, true);

await assert.rejects(fetchCawsArticlePreviewImage(articleUrl, source,
  (async () => new Response(null, { status: 302,
    headers: { Location: 'https://external.example/article' } })) as typeof fetch),
error => error instanceof ScanError && error.code === 'caws_preview_redirect_rejected');
await assert.rejects(fetchCawsArticlePreviewImage(articleUrl, source,
  (async () => new Response('x'.repeat(512 * 1024 + 1),
    { headers: { 'Content-Type': 'text/html' } })) as typeof fetch),
error => error instanceof ScanError && error.code === 'caws_preview_html_too_large');
console.log('CAWS discovery checks passed');
