import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpError, SourceSchema, z } from '@uk-aq-media/core';
import { parsePublisherRssFeed } from '@uk-aq-media/discovery';
import {
  metadataFromOpenAqRss, metadataProviderFor, metadataPublishedAtChange,
  metadataPublishedAtProposal, normalisePublisherPublishedAt, requireOpenAqRssMetadata,
} from '../apps/media-admin/src/editorial-dashboard';

const sources = z.array(SourceSchema).parse(JSON.parse(
  readFileSync('config/sources.seed.json', 'utf8'),
));
const openaq = sources.find(source => source.source_key === 'openaq')!;
const previewUrl = 'https://cdn-images-1.medium.com/max/1024/1*SzapuwhysObdfvnB2Es4rw.png';
const rssBodyMarker = 'RSS body HTML must not appear in metadata output';
const parsed = await parsePublisherRssFeed(`<?xml version="1.0"?><rss version="2.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
  <title>OpenAQ RSS title</title>
  <link>https://openaq.medium.com/open-air-quality-data?source=rss-feed</link>
  <dc:creator>OpenAQ author</dc:creator><pubDate>Fri, 12 Sep 2026 10:00:00 GMT</pubDate>
  <content:encoded><![CDATA[<p>${rssBodyMarker}</p><img src="${previewUrl}">]]></content:encoded>
  </item></channel></rss>`, openaq, 'openaq-medium');

assert.equal(metadataProviderFor('openaq'), 'publisher_rss');
assert.equal(metadataProviderFor('phys-org'), 'article_head');
const metadata = metadataFromOpenAqRss('https://openaq.medium.com/open-air-quality-data',
  'OpenAQ', parsed.articles, '2026-09-13T10:00:00.000Z');
assert.deepEqual(metadata, {
  publisher: 'OpenAQ', title: 'OpenAQ RSS title', compact_title: null,
  author: 'OpenAQ author', published_at: '2026-09-12T10:00:00.000Z',
  image_url: previewUrl, image_error: null, checked_at: '2026-09-13T10:00:00.000Z',
});
assert.doesNotMatch(JSON.stringify(metadata), new RegExp(rssBodyMarker));
assert.equal(metadataFromOpenAqRss('https://openaq.medium.com/not-in-current-feed',
  'OpenAQ', parsed.articles, '2026-09-13T10:00:00.000Z'), null);
assert.throws(() => requireOpenAqRssMetadata('https://openaq.medium.com/not-in-current-feed',
  'OpenAQ', parsed.articles, '2026-09-13T10:00:00.000Z'),
error => error instanceof HttpError && error.status === 409 && error.message === 'metadata_rss_article_not_found');

const publisherPublishedAt = normalisePublisherPublishedAt('2026-09-13T13:08:11Z');
assert.equal(publisherPublishedAt, '2026-09-13T13:08:11.000Z');
assert.equal(normalisePublisherPublishedAt('not-a-date'), null);
assert.deepEqual(metadataPublishedAtProposal(null, publisherPublishedAt), {
  current: null, proposed: '2026-09-13T13:08:11.000Z',
});
assert.equal(metadataPublishedAtProposal('2026-09-12T10:00:00.000Z', publisherPublishedAt), null);
assert.equal(metadataPublishedAtChange(null, null, publisherPublishedAt,
  publisherPublishedAt, true), true);
assert.equal(metadataPublishedAtChange(null, null, publisherPublishedAt,
  publisherPublishedAt, false), false);
assert.equal(metadataPublishedAtChange(null, undefined, undefined,
  publisherPublishedAt, false), false);
assert.throws(() => metadataPublishedAtChange(null, null, publisherPublishedAt,
  '2026-09-13T13:09:00.000Z', true),
error => error instanceof HttpError && error.status === 409 &&
  error.message === 'metadata_published_at_proposal_changed');
assert.throws(() => metadataPublishedAtChange('2026-09-12T10:00:00.000Z', null,
  publisherPublishedAt, publisherPublishedAt, true),
error => error instanceof HttpError && error.status === 409 &&
  error.message === 'metadata_current_published_at_changed');
const dashboardSource = readFileSync('apps/media-admin/src/editorial-dashboard.ts', 'utf8');
assert.match(dashboardSource,
  /published_at = CASE WHEN \? AND published_at IS NULL THEN \? ELSE published_at END/);
console.log('Admin metadata provider checks passed');
