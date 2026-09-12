import assert from 'node:assert/strict';
import { configuredPublisherRssRouteKeys, parsePublisherRssFeed } from '@uk-aq-media/discovery';
import { initialEditorialState, type Source } from '@uk-aq-media/core';

const source: Source = {
  source_key: 'bbc-news', name: 'BBC News', canonical_domain: 'bbc.co.uk',
  source_type: 'publisher', enabled: true, publication_policy: 'manual',
  review_level: 'standard', priority: 50, discovery_method: 'rss',
  discovery_config: { routes: [{ route_key: 'bbc-news-top',
    url: 'https://feeds.bbci.co.uk/news/rss.xml', max_items: 10 }], retain_excerpt: false },
  content_fetch_policy: 'discovery_metadata_only', ai_content_policy: 'disabled',
  image_policy: 'remote_preview',
};
assert.deepEqual(configuredPublisherRssRouteKeys(source), ['bbc-news-top']);
assert.deepEqual(initialEditorialState(source), {
  status: 'pending', approval_method: null, approval_author_rule_key: null,
});
const parsed = await parsePublisherRssFeed(`<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Air quality improves</title><link>https://www.bbc.co.uk/news/a?utm_source=rss</link>
  <category>Environment</category></item>
  <item><title>Missing link</title></item>
</channel></rss>`, source, 'bbc-news-top');
assert.equal(parsed.items_seen, 2);
assert.equal(parsed.items_invalid, 1);
assert.equal(parsed.articles[0]?.canonical_url, 'https://bbc.co.uk/news/a');
assert.equal(parsed.articles[0]?.title_context, null);
assert.deepEqual(configuredPublisherRssRouteKeys({ ...source,
  canonical_domain: 'bbc.com' }), []);
console.log('Publisher RSS discovery checks passed');
