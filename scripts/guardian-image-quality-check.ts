import assert from 'node:assert/strict';
import { guardianPreviewForArticleFromFeed,
  selectGuardianPreviewCandidate } from '@uk-aq-media/discovery';
import type { Source } from '@uk-aq-media/core';
import { parseRssItems, type RssPreviewCandidate,
  type RssPreviewCandidateKind } from '../packages/discovery/src/rss';

const guardianImage = (kind: RssPreviewCandidateKind, suffix: string,
  width: unknown, height: unknown, rssOrder: number): RssPreviewCandidate => ({
  kind,
  url: `https://i.guim.co.uk/img/media/example.jpg?${suffix}`,
  width,
  height,
  rss_order: rssOrder,
});

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:content', 'width=460', '460', '300', 0),
  guardianImage('media:thumbnail', 'width=700', '700', '200', 1),
])?.url, 'https://i.guim.co.uk/img/media/example.jpg?width=700');

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:content', 'malformed=true', '700px', '500', 0),
  guardianImage('media:thumbnail', 'valid=true', '140', null, 1),
])?.url, 'https://i.guim.co.uk/img/media/example.jpg?valid=true');

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:thumbnail', 'kind=thumbnail', '0', '-1', 0),
  guardianImage('enclosure', 'kind=enclosure', null, null, 1),
  guardianImage('media:content', 'kind=content', null, null, 2),
])?.kind, 'media:content');

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:thumbnail', 'kind=thumbnail', null, null, 0),
  guardianImage('enclosure', 'kind=enclosure', null, null, 1),
])?.kind, 'enclosure');

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:content', 'height=300', '700', '300', 0),
  guardianImage('media:content', 'height=400', '700', '400', 1),
])?.height, 400);

assert.equal(selectGuardianPreviewCandidate([
  guardianImage('media:content', 'later=true', null, null, 5),
  guardianImage('media:content', 'earlier=true', null, null, 3),
])?.url, 'https://i.guim.co.uk/img/media/example.jpg?earlier=true');

assert.equal(selectGuardianPreviewCandidate([{
  kind: 'media:content',
  url: 'https://images.example.invalid/image.jpg?width=9999',
  width: '9999',
  height: '9999',
  rss_order: 0,
}, guardianImage('media:thumbnail', 'signed=abc&width=140', '140', null, 1)])?.url,
  'https://i.guim.co.uk/img/media/example.jpg?signed=abc&width=140');

assert.equal(selectGuardianPreviewCandidate([guardianImage(
  'media:content', 'signed=abc&width=700&quality=85', '700', null, 0,
)])?.url, 'https://i.guim.co.uk/img/media/example.jpg?signed=abc&width=700&quality=85');

const sharedParsed = parseRssItems(`<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
    <channel><item><title>Example article</title>
      <link>https://airqualitynews.com/example/</link>
      <media:thumbnail url="https://airqualitynews.com/thumbnail.jpg" width="140" />
      <media:content url="https://airqualitynews.com/content.jpg" type="image/jpeg"
        width="700" height="400" />
      <enclosure url="https://airqualitynews.com/enclosure.jpg" type="image/jpeg" />
    </item></channel>
  </rss>`, 1);
assert.deepEqual(sharedParsed.items[0]?.preview_candidates.map(candidate => candidate.kind),
  ['media:thumbnail', 'media:content', 'enclosure']);
assert.deepEqual(sharedParsed.items[0]?.preview_candidates.map(candidate => candidate.width),
  ['140', '700', undefined]);

const guardianSource: Source = {
  source_key: 'the-guardian',
  name: 'The Guardian',
  canonical_domain: 'theguardian.com',
  source_type: 'publisher',
  enabled: true,
  publication_policy: 'manual',
  review_level: 'standard',
  priority: 50,
  discovery_method: 'rss',
  discovery_config: { retain_excerpt: false, routes: [{
    route_key: 'guardian-environment',
    url: 'https://www.theguardian.com/environment/rss',
    max_items: 10,
  }] },
  content_fetch_policy: 'discovery_metadata_only',
  ai_content_policy: 'metadata_only',
  image_policy: 'remote_preview',
};
const lookup = await guardianPreviewForArticleFromFeed(`<?xml version="1.0"?>
  <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
    <channel>
      <item><title>Different article</title>
        <link>https://www.theguardian.com/environment/2026/sep/11/different</link>
        <media:content url="https://i.guim.co.uk/img/media/different.jpg" width="9999" />
      </item>
      <item><title>Target article</title>
        <link>https://www.theguardian.com/environment/2026/sep/11/target</link>
        <media:content url="https://i.guim.co.uk/img/media/target.jpg?width=140" width="140" />
        <media:content url="https://i.guim.co.uk/img/media/target.jpg?width=700" width="700" />
      </item>
    </channel>
  </rss>`, guardianSource, 10,
  'https://theguardian.com/environment/2026/sep/11/target',
  'https://i.guim.co.uk/img/media/target.jpg?width=140');
assert.equal(lookup.article_found, true);
assert.equal(lookup.current?.width, 140);
assert.equal(lookup.proposed?.width, 700);

console.log('Guardian image quality checks passed');
