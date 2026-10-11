import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configuredPublisherRssRouteKeys, GUARDIAN_ROUTES, mediaDeterministicRelevanceFilter,
  parsePublisherRssFeed, PUBLISHER_RSS_ROUTES,
} from '@uk-aq-media/discovery';
import {
  canonicalizeUrl, initialEditorialState, normaliseArticleAuthorForStorage,
  publisherHttpsUrl, remotePreviewUrl,
  SourceSchema, z,
} from '@uk-aq-media/core';
import { MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES } from
  '../packages/discovery/src/rss';

const sources = z.array(SourceSchema).parse(JSON.parse(
  readFileSync('config/sources.seed.json', 'utf8'),
));
const publisherSources = sources.filter(source =>
  ['bbc-news', 'sky-news', 'the-independent', 'carbon-brief', 'openaq', 'phys-org',
    'university-of-exeter', 'mums-for-lungs']
    .includes(source.source_key));
assert.equal(PUBLISHER_RSS_ROUTES.length, 18);
assert.equal(1 + GUARDIAN_ROUTES.length + PUBLISHER_RSS_ROUTES.length, 30);
for (const configured of publisherSources) {
  assert.deepEqual(configuredPublisherRssRouteKeys(configured),
    PUBLISHER_RSS_ROUTES.filter(route => route.source_key === configured.source_key)
      .map(route => route.route_key));
  assert.deepEqual(initialEditorialState(configured), {
    status: 'pending', approval_method: null, approval_author_rule_key: null,
  });
}
assert.equal(publisherSources.find(source => source.source_key === 'carbon-brief')?.ai_content_policy,
  'metadata_only');
assert.equal(publisherSources.find(source => source.source_key === 'openaq')?.canonical_domain,
  'openaq.medium.com');
assert.equal(publisherSources.find(source => source.source_key === 'phys-org')?.ai_content_policy,
  'disabled');
assert.equal(publisherSources.find(source => source.source_key === 'university-of-exeter')
  ?.canonical_domain, 'news.exeter.ac.uk');
assert.equal(PUBLISHER_RSS_ROUTES.find(route => route.source_key === 'openaq' &&
  route.route_key === 'openaq-medium' && 'content_encoded_preview_scan_bytes' in route)
  ?.content_encoded_preview_scan_bytes, MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES);
assert.equal(PUBLISHER_RSS_ROUTES.filter(route =>
  'content_encoded_preview_scan_bytes' in route).length, 1);
for (const sourceKey of ['carbon-brief', 'openaq', 'phys-org', 'university-of-exeter']) {
  const configured = publisherSources.find(source => source.source_key === sourceKey)!;
  assert.deepEqual(configuredPublisherRssRouteKeys({ ...configured,
    publication_policy: 'auto_approve' }), []);
}
assert.equal(sources.some(source => ['research-news-bioengineer', 'research-news-scienmag']
  .includes(source.source_key)), false);
assert.equal(PUBLISHER_RSS_ROUTES.some(route =>
  route.source_key === 'research-news-bioengineer' ||
  route.source_key === 'research-news-scienmag'), false);
// Keep the useful research-coverage relevance vocabulary independent of the blocked publishers.
for (const [title, relevant] of [
  ['Residential wood smoke exposed as a major urban particulate source', true],
  ['Chemical source apportionment reveals PM10 contributions in Serbia', true],
  ['Researchers analyse black carbon in ambient air', true],
  ['Biomass combustion improves industrial boiler electricity output', false],
  ['New gene discovered in laboratory mice', false],
] as const) {
  assert.equal(mediaDeterministicRelevanceFilter.evaluate({
    title, canonical_url: 'https://example.com/test-story/', categories: [],
  }).relevant, relevant, title);
}

const mumsForLungs = publisherSources.find(candidate => candidate.source_key === 'mums-for-lungs')!;
const mumsImage = 'https://images.squarespace-cdn.com/content/v1/60fe62a6c0eb074f99a31664/' +
  '1783674678917-example/M4L+diesel.png?format=1500w';
const mumsParsed = await parsePublisherRssFeed(`<?xml version="1.0"?>
<rss version="2.0"><channel><item><title>Air pollution affects children</title>
  <link>https://www.mumsforlungs.org/news/air-pollution-affects-children</link>
  <dc:creator>Jane Dutton</dc:creator><pubDate>Fri, 10 Jul 2026 09:12:51 +0000</pubDate>
  <category>Diesel</category><media:content medium="image" type="image/png"
    width="1500" height="847" url="${mumsImage}" />
  <content:encoded><![CDATA[<p>Permission-gated body must be discarded.</p>]]></content:encoded>
</item></channel></rss>`, mumsForLungs, 'mums-for-lungs-news');
assert.equal(mumsParsed.articles[0]?.author, null,
  'Mums for Lungs source policy suppresses RSS bylines');
assert.equal(mumsParsed.articles[0]?.published_at, '2026-07-10T09:12:51.000Z');
assert.deepEqual(mumsParsed.articles[0]?.categories, ['Diesel']);
assert.equal(mumsParsed.articles[0]?.preview_url, mumsImage);
assert.equal(mumsParsed.articles[0]?.feed_body_html, null);
assert.equal(remotePreviewUrl(mumsImage, mumsForLungs), mumsImage);
for (const rejected of [
  'https://images.squarespace-cdn.com/content/v1/another-site/image.png',
  'https://nested.images.squarespace-cdn.com/content/v1/60fe62a6c0eb074f99a31664/image.png',
  'https://images.squarespace-cdn.com:443/content/v1/60fe62a6c0eb074f99a31664/image.png',
]) assert.equal(remotePreviewUrl(rejected, mumsForLungs), null);
const source = publisherSources.find(candidate => candidate.source_key === 'bbc-news')!;
const bbcPreview =
  'https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/example/live/article.jpg';
const parsed = await parsePublisherRssFeed(`<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
  <item><title>Air quality improves</title><link>https://www.bbc.co.uk/news/a?utm_source=rss</link>
  <category>Environment</category><media:thumbnail url="${bbcPreview}" /></item>
  <item><title>Missing link</title></item>
</channel></rss>`, source, 'bbc-news-top');
assert.equal(parsed.items_seen, 2);
assert.equal(parsed.items_invalid, 1);
assert.equal(parsed.articles[0]?.canonical_url, 'https://bbc.co.uk/news/a');
assert.equal(parsed.articles[0]?.preview_url, bbcPreview);
assert.equal(parsed.articles[0]?.title_context, null);
assert.equal(remotePreviewUrl(bbcPreview, source), bbcPreview);
for (const rejected of [
  'https://other.bbci.co.uk/image.jpg',
  'http://ichef.bbci.co.uk/image.jpg',
  'https://user:secret@ichef.bbci.co.uk/image.jpg',
  'https://ichef.bbci.co.uk:443/image.jpg',
  'https://nested.ichef.bbci.co.uk/image.jpg',
]) assert.equal(remotePreviewUrl(rejected, source), null);
assert.deepEqual(configuredPublisherRssRouteKeys({ ...source,
  canonical_domain: 'bbc.com' }), []);
assert.throws(() => canonicalizeUrl('https://regional.bbc.co.uk/news/a', source),
  /off_source_article_url/);

const openaq = publisherSources.find(candidate => candidate.source_key === 'openaq')!;
const openaqPreview =
  'https://cdn-images-1.medium.com/max/960/1*bwG_MoKJs3k3Bn5vQ4vGRw.png';
const openaqContentEncodedHtml = `
  <p>RSS body marker that must not survive discovery.</p>
  <img src="https://cdn-images-1.medium.com/max/10/tracker.png" width="1" height="1">
  <img src="https://medium.com/_/stat?event=post.clientViewed" width="1" height="1">
  <img src="https://ichef.bbci.co.uk/news/content-encoded-check.jpg">
  <img src="https://attacker.example/image.png">
  <img src="http://cdn-images-1.medium.com/image.png">
  <img src="https://user:secret@cdn-images-1.medium.com/image.png">
  <img src="https://cdn-images-1.medium.com:443/image.png">
  <img src="https://cdn-images-2.medium.com/image.png">
  <img src="${openaqPreview}">`;
const openaqParsed = await parsePublisherRssFeed(`<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Open air-quality data</title>
  <link>https://openaq.medium.com/open-air-quality-data-123?source=rss-feed</link>
  <dc:creator>OpenAQ</dc:creator><category>Air Quality</category>
  <content:encoded><![CDATA[${openaqContentEncodedHtml}]]></content:encoded></item>
</channel></rss>`, openaq, 'openaq-medium');
assert.equal(openaqParsed.articles[0]?.canonical_url,
  'https://openaq.medium.com/open-air-quality-data-123');
assert.equal(openaqParsed.articles[0]?.preview_url, openaqPreview);
assert.equal(openaqParsed.articles[0]?.display_title, null);
assert.equal(openaqParsed.articles[0]?.author, 'OpenAQ',
  'raw byline remains available for relevance and author-rule matching');
assert.equal(normaliseArticleAuthorForStorage(openaqParsed.articles[0]?.author, openaq.name), null);
assert.equal(normaliseArticleAuthorForStorage('openaq', openaq.name), null);
assert.equal(normaliseArticleAuthorForStorage(' OpenAQ ', openaq.name), null);
assert.equal(normaliseArticleAuthorForStorage('OpenAQ Team', openaq.name), 'OpenAQ Team');
assert.equal(normaliseArticleAuthorForStorage('Guardian', 'The Guardian'), 'Guardian');
assert.equal('content_encoded_preview_url' in openaqParsed.articles[0]!, false);
assert.doesNotMatch(JSON.stringify(openaqParsed.articles[0]), /RSS body marker/);
assert.equal(remotePreviewUrl(openaqPreview, openaq), openaqPreview);
assert.equal(remotePreviewUrl(bbcPreview, openaq), null);
for (const rejected of [
  'https://medium.com/_/stat?event=post.clientViewed',
  'https://attacker.example/image.png',
  'http://cdn-images-1.medium.com/image.png',
  'https://user:secret@cdn-images-1.medium.com/image.png',
  'https://cdn-images-1.medium.com:443/image.png',
  'https://cdn-images-1.medium.com:8443/image.png',
  'https://cdn-images-2.medium.com/image.png',
  'https://nested.cdn-images-1.medium.com/image.png',
  'not a URL',
]) assert.equal(remotePreviewUrl(rejected, openaq), null);
assert.equal(remotePreviewUrl(openaqPreview, source), null);
assert.throws(() => canonicalizeUrl(openaqPreview, openaq), /off_source_article_url/);

const bbcContentEncoded = await parsePublisherRssFeed(`<?xml version="1.0"?>
<rss version="2.0"><channel><item><title>Air quality remains in focus</title>
  <link>https://www.bbc.co.uk/news/content-encoded-check</link>
  <content:encoded><![CDATA[${openaqContentEncodedHtml}]]></content:encoded>
</item></channel></rss>`, source, 'bbc-news-top');
assert.equal(bbcContentEncoded.articles[0]?.preview_url, null);

const beyondContentEncodedBound = await parsePublisherRssFeed(`<?xml version="1.0"?>
<rss version="2.0"><channel><item><title>Air-quality image beyond scan bound</title>
  <link>https://openaq.medium.com/beyond-scan-bound</link>
  <content:encoded><![CDATA[${'x'.repeat(MAX_CONTENT_ENCODED_PREVIEW_SCAN_BYTES)}
    <img src="${openaqPreview}">]]></content:encoded>
</item></channel></rss>`, openaq, 'openaq-medium');
assert.equal(beyondContentEncodedBound.articles[0]?.preview_url, null);

const independent = publisherSources.find(candidate => candidate.source_key === 'the-independent')!;
assert.equal(canonicalizeUrl('https://www.the-independent.com/news/current?utm_source=rss', independent),
  'https://the-independent.com/news/current');
assert.equal(canonicalizeUrl('https://www.independent.co.uk/news/legacy?utm_source=rss', independent),
  'https://independent.co.uk/news/legacy');
assert.equal(canonicalizeUrl('https://news.independent.co.uk/legacy', independent),
  'https://news.independent.co.uk/legacy');
assert.equal(publisherHttpsUrl('https://independent.co.uk/news/legacy', independent),
  'https://independent.co.uk/news/legacy');
assert.equal(publisherHttpsUrl('https://news.independent.co.uk/legacy', independent),
  'https://news.independent.co.uk/legacy');
assert.equal(remotePreviewUrl('https://static.independent.co.uk/image.jpg', independent),
  'https://static.independent.co.uk/image.jpg');
for (const rejected of [
  'https://independent.co.uk.attacker.example/article',
  'https://not-independent.co.uk/article',
  'https://attacker.example/image.jpg',
]) {
  assert.equal(publisherHttpsUrl(rejected, independent), null);
  assert.equal(remotePreviewUrl(rejected, independent), null);
  assert.throws(() => canonicalizeUrl(rejected, independent), /off_source_article_url/);
}
console.log('Publisher RSS discovery checks passed');
