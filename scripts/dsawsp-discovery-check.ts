import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configuredDsawspIndex, discoverDsawsp, DSAWSP_INDEX_URL,
  extractDsawspArticleMetadata, extractDsawspIndexUrls, extractDsawspNextIndexUrl,
} from '@uk-aq-media/discovery';
import { initialEditorialState, remotePreviewUrl, SourceSchema, z } from '@uk-aq-media/core';

const sources = z.array(SourceSchema).parse(JSON.parse(
  readFileSync('config/sources.seed.json', 'utf8'),
));
const source = sources.find(candidate => candidate.source_key === 'dsawsp')!;
assert.ok(configuredDsawspIndex(source));
assert.deepEqual(initialEditorialState(source), {
  status: 'pending', approval_method: null, approval_author_rule_key: null,
});

const articleUrl = 'https://dsawsp.org/blog/wood-stoves-as-home-garbage-incinerators';
const canonicalArticleUrl = 'https://dsawsp.org/blog/wood-stoves-as-home-garbage-incinerators';
const image = 'https://cdn.prod.website-files.com/5ea15130788281225d2c434e/example.jpg';
assert.deepEqual(extractDsawspIndexUrls(`<a href="/contact">Contact</a>
  <a href="${articleUrl}">Article</a><a href="https://attacker.example/blog/no">No</a>`, source),
  [canonicalArticleUrl]);
const secondIndexUrl = `${DSAWSP_INDEX_URL}?abc123_page=2`;
assert.equal(extractDsawspNextIndexUrl(
  `<a class="w-pagination-next" href="?abc123_page=2">Next</a>`, DSAWSP_INDEX_URL, source),
secondIndexUrl);
for (const rejected of [
  'https://attacker.example/resources/blog?abc123_page=2',
  '/contact?abc123_page=2',
  '?abc123_page=3',
  '?abc123_page=2&extra=1',
]) assert.equal(extractDsawspNextIndexUrl(
  `<a href="${rejected}" class="w-pagination-next">Next</a>`, DSAWSP_INDEX_URL, source), null);
const metadataHtml = `<head><title>Wood stoves as trash incinerators</title>
  <meta property="og:title" content="Wood stoves as trash incinerators">
  <meta property="og:image" content="${image}"></head><body>
  <!-- Last Published: Fri Sep 11 2026 14:45:12 GMT+0000 -->
  <div class="date-and-category-block"><a href="/categories/commentary"
    class="category-link">Commentary</a><div class="blog-date">September 9, 2026</div></div>`;
assert.deepEqual(extractDsawspArticleMetadata(metadataHtml, source), {
  title: 'Wood stoves as trash incinerators', publishedAt: '2026-09-09',
  category: 'Commentary', previewUrl: image,
});
assert.equal(remotePreviewUrl(image, source), image);
assert.equal(remotePreviewUrl(image, sources.find(candidate => candidate.source_key === 'bbc-news')!), null);
for (const rejected of [
  'http://cdn.prod.website-files.com/image.jpg',
  'https://cdn.prod.website-files.com:443/image.jpg',
  'https://nested.cdn.prod.website-files.com/image.jpg',
  'https://cdn.prod.website-files.com.attacker.example/image.jpg',
]) assert.equal(remotePreviewUrl(rejected, source), null);

const requested: string[] = [];
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requested.push(url);
  assert.equal(init?.redirect, 'manual');
  if (url === DSAWSP_INDEX_URL) return new Response(`<a href="${articleUrl}">Article</a>
    <a class="w-pagination-next" href="?abc123_page=2">Next</a>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (url === secondIndexUrl) return new Response(`<a href="${articleUrl}">Duplicate</a>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (url === canonicalArticleUrl) return new Response(null,
    { status: 301, headers: { Location: `https://www.dsawsp.org${new URL(url).pathname}` } });
  if (url === `https://www.dsawsp.org${new URL(articleUrl).pathname}`) {
    return new Response(metadataHtml, { headers: { 'Content-Type': 'text/html' } });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;
const discovered = await discoverDsawsp(source, fetcher);
assert.equal(discovered.items_seen, 1);
assert.equal(discovered.items_invalid, 0);
assert.equal(discovered.articles[0]?.published_at, '2026-09-09');
assert.deepEqual(discovered.articles[0]?.categories, ['Commentary']);
assert.equal(discovered.articles[0]?.preview_url, image);
assert.deepEqual(requested, [DSAWSP_INDEX_URL, secondIndexUrl, canonicalArticleUrl,
  `https://www.dsawsp.org${new URL(articleUrl).pathname}`]);
console.log('DSAWSP discovery checks passed');
