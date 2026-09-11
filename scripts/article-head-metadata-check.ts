import assert from 'node:assert/strict';
import {
  discoverArticleHeadPreviewMetadata, extractArticleHeadMetadata,
} from '../packages/discovery/src/article-head-metadata';
import type { DiscoveredArticle, Source } from '@uk-aq-media/core';

const metadata = extractArticleHeadMetadata(`<head>
  <meta content='https://publisher.example/og.jpg' property='og:image'>
  <meta name="twitter:image" content="https://publisher.example/twitter.jpg">
  <meta content="Short &amp; useful &#x2014; title" property="og:title">
  <meta name=twitter:title content='Fallback title'>
</head><body>not retained</body>`);
assert.deepEqual(metadata, {
  ogImage: 'https://publisher.example/og.jpg',
  twitterImage: 'https://publisher.example/twitter.jpg',
  ogTitle: 'Short & useful — title',
  twitterTitle: 'Fallback title',
  htmlTitle: null,
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

console.log('Article head metadata checks passed');
