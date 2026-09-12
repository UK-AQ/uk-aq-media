import assert from 'node:assert/strict';
import {
  discoverArticleHeadPreviewMetadata, extractArticleHeadMetadata,
} from '../packages/discovery/src/article-head-metadata';
import type { DiscoveredArticle, Source } from '@uk-aq-media/core';
import { articleHeadHttpError, metadataImageChange } from
  '../apps/media-admin/src/editorial-dashboard';

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
