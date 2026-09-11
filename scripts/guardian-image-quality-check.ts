import assert from 'node:assert/strict';
import { guardianPreviewForArticleFromFeed, guardianRssImageViewFromFeeds,
  selectGuardianPreviewCandidate } from '@uk-aq-media/discovery';
import type { Source } from '@uk-aq-media/core';
import { planGuardianImageRepairs,
  requireCurrentGuardianImageRepairPlan,
  type GuardianImageRepairRow } from '../apps/media-admin/src/guardian-image-bulk';
import { imageCacheVersion,
  versionedArticleImageUrl } from '../apps/media-public/src/image-cache-version';
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

const rssItem = (path: string, candidates: Array<[string, number]>): string => `
  <item><title>${path}</title><link>https://www.theguardian.com/${path}</link>
    ${candidates.map(([suffix, width]) => `<media:content
      url="https://i.guim.co.uk/img/media/${suffix}.jpg" width="${width}" />`).join('')}
  </item>`;
const rssFeed = (items: string[]): string => `<?xml version="1.0"?>
  <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
    <channel>${items.join('')}</channel>
  </rss>`;
const environmentFeed = rssFeed([
  rssItem('environment/2026/sep/11/upgrade', [['upgrade-140', 140], ['upgrade-700', 700]]),
  rssItem('environment/2026/sep/11/ambiguous', [['ambiguous-700', 700]]),
  rssItem('environment/2026/sep/11/fill', [['fill-700', 700]]),
  rssItem('environment/2026/sep/11/best', [['best-700', 700]]),
  rssItem('environment/2026/sep/11/conflict', [['conflict-a', 700]]),
]);
const technologyFeed = rssFeed([
  rssItem('environment/2026/sep/11/upgrade', [['upgrade-140', 140], ['upgrade-700', 700]]),
  rssItem('environment/2026/sep/11/conflict', [['conflict-b', 700]]),
]);
const bulkView = guardianRssImageViewFromFeeds(guardianSource, [
  { route_key: 'guardian-environment', xml: environmentFeed, max_items: 10 },
  { route_key: 'guardian-technology', xml: technologyFeed, max_items: 10 },
]);
assert.equal(bulkView.articles.size, 5);
assert.deepEqual(bulkView.articles.get(
  'https://theguardian.com/environment/2026/sep/11/upgrade',
)?.route_keys, ['guardian-environment', 'guardian-technology']);

const repairRows: GuardianImageRepairRow[] = [
  { id: 1, canonical_url: 'https://theguardian.com/environment/2026/sep/11/upgrade',
    title: 'Upgrade', status: 'approved',
    og_image_url: 'https://i.guim.co.uk/img/media/upgrade-140.jpg' },
  { id: 2, canonical_url: 'https://theguardian.com/environment/2026/sep/11/ambiguous',
    title: 'Ambiguous', status: 'pending',
    og_image_url: 'https://i.guim.co.uk/img/media/manual-or-old.jpg' },
  { id: 3, canonical_url: 'https://theguardian.com/environment/2026/sep/11/fill',
    title: 'Fill', status: 'hidden', og_image_url: null },
  { id: 4, canonical_url: 'https://theguardian.com/environment/2026/sep/11/best',
    title: 'Best', status: 'rejected',
    og_image_url: 'https://i.guim.co.uk/img/media/best-700.jpg' },
  { id: 5, canonical_url: 'https://theguardian.com/environment/2026/sep/11/conflict',
    title: 'Conflict', status: 'approved', og_image_url: null },
];
const repairPlan = await planGuardianImageRepairs(bulkView, repairRows, {
  total_existing_guardian_rows: 7,
  eligible_remote_preview_rows: 6,
});
assert.deepEqual(repairPlan.changes.map(change => [change.article_id, change.change]),
  [[1, 'replace'], [3, 'fill']]);
assert.equal(repairPlan.changes[0]?.current_width, 140);
assert.equal(repairPlan.changes[0]?.proposed_width, 700);
assert.equal(repairPlan.counts.ambiguous_existing_image_rows, 1);
assert.equal(repairPlan.counts.already_best_rows, 1);
assert.equal(repairPlan.counts.conflicting_proposal_rows, 1);
assert.equal(repairPlan.counts.rows_outside_current_rss, 1);
assert.equal(repairPlan.skipped.find(skip => skip.article_id === 2)?.reason,
  'ambiguous_existing_image');

const changedStatePlan = await planGuardianImageRepairs(bulkView, repairRows.map(row =>
  row.id === 1 ? { ...row,
    og_image_url: 'https://i.guim.co.uk/img/media/upgrade-700.jpg' } : row), {
  total_existing_guardian_rows: 7,
  eligible_remote_preview_rows: 6,
});
assert.notEqual(changedStatePlan.repair_token, repairPlan.repair_token);
assert.throws(() => requireCurrentGuardianImageRepairPlan(changedStatePlan,
  repairPlan.repair_token), error => error instanceof Error &&
    'status' in error && error.status === 409 &&
    error.message === 'guardian_image_repair_plan_changed');

const oldImage = 'https://i.guim.co.uk/img/media/example.jpg?width=140';
const newImage = 'https://i.guim.co.uk/img/media/example.jpg?width=700';
assert.equal(await imageCacheVersion(oldImage), await imageCacheVersion(oldImage));
assert.notEqual(await imageCacheVersion(oldImage), await imageCacheVersion(newImage));
const oldPublicImage = await versionedArticleImageUrl('https://media.example', 316, oldImage);
const newPublicImage = await versionedArticleImageUrl('https://media.example', 316, newImage);
assert.match(oldPublicImage, /^https:\/\/media\.example\/article-images\/316\?v=[a-f0-9]{32}$/);
assert.notEqual(newPublicImage, oldPublicImage);

console.log('Guardian image quality checks passed');
