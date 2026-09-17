import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker, { publicPreviewImageUrl } from '../apps/media-public/src/index';
import {
  homepageLatestSixSnapshot,
  reconciledHomepageLatestSixState,
  type HomepageLatestSixSnapshotRow,
  type HomepageLatestSixState,
} from '@uk-aq-media/core';

function article(id: number, overrides: Partial<HomepageLatestSixSnapshotRow> = {}): HomepageLatestSixSnapshotRow {
  return {
    id,
    canonical_url: `https://publisher.example/articles/${id}`,
    title: `Publisher title ${id}`,
    display_title: null,
    publisher: 'Publisher',
    published_at: '2026-09-13T12:00:00.000Z',
    preview_image_url: null,
    ...overrides,
  };
}

const baseline = [6, 5, 4, 3, 2, 1].map(id => article(id));
const previous: HomepageLatestSixState = {
  generation: 10,
  snapshot_json: homepageLatestSixSnapshot(baseline),
  updated_at: '2026-09-13T12:00:00.000Z',
};
const nextUpdatedAt = '2026-09-13T12:01:00.000Z';

const previewSelection = {
  id: 42,
  source_key: 'ordinary-publisher',
  og_image_url: 'https://publisher.example/preview.jpg',
  article_image_policy: 'remote_preview',
  source_image_policy: 'remote_preview',
};
const ordinaryPublisherImage = await publicPreviewImageUrl('https://media.test', previewSelection);
assert.match(ordinaryPublisherImage ?? '',
  /^https:\/\/media\.test\/article-images\/42\?v=[a-f0-9]{32}$/,
  'ordinary publisher images must use the versioned article-image route');
assert.match(await publicPreviewImageUrl('https://media.test', {
  ...previewSelection, source_key: 'communities-against-woodsmoke',
}) ?? '', /^https:\/\/media\.test\/article-images\/42\?v=[a-f0-9]{32}$/,
'a real CAWS publisher image must take precedence over the static default');
const cawsDefaultUrl = 'https://media.test/source-images/communities-against-woodsmoke-default.png';
assert.equal(await publicPreviewImageUrl('https://media.test', {
  ...previewSelection, source_key: 'communities-against-woodsmoke', og_image_url: null,
}), cawsDefaultUrl, 'an image-less permitted CAWS article must receive the static default');
assert.equal(await publicPreviewImageUrl('https://media.test', {
  ...previewSelection, og_image_url: null,
}), null, 'an image-less non-CAWS article must not receive a default');
assert.equal(await publicPreviewImageUrl('https://media.test', {
  ...previewSelection, source_key: 'communities-against-woodsmoke', og_image_url: null,
  article_image_policy: 'blocked',
}), null, 'article image policy must block the CAWS default');
assert.equal(await publicPreviewImageUrl('https://media.test', {
  ...previewSelection, source_key: 'communities-against-woodsmoke', og_image_url: null,
  source_image_policy: 'blocked',
}), null, 'source image policy must block the CAWS default');

const presentationImageSource = readFileSync(resolve('packages/core/src/presentation-image.ts'), 'utf8');
assert.equal([...presentationImageSource.matchAll(/communities-against-woodsmoke-default\.png/g)].length, 1,
  'the placeholder path must remain a presentation constant, not a stored og_image_url value');
assert.ok(existsSync(resolve(
  'apps/media-public/public/source-images/communities-against-woodsmoke-default.png')),
'the bundled CAWS default image must exist');
const mediaPublicWrangler = readFileSync(
  resolve('apps/media-public/wrangler.jsonc'), 'utf8');
assert.match(mediaPublicWrangler, /"assets"\s*:\s*\{\s*"directory"\s*:\s*"\.\/public"\s*\}/,
  'media-public must deploy its public directory as Workers Static Assets');

assert.equal(reconciledHomepageLatestSixState(previous, baseline, nextUpdatedAt).generation, 10,
  'unchanged current six must not bump generation');
assert.equal(reconciledHomepageLatestSixState(previous,
  [article(7), ...baseline.slice(0, 5)], nextUpdatedAt).generation, 11,
  'a new latest article must bump generation');
assert.equal(reconciledHomepageLatestSixState(previous,
  baseline.map(item => item.id === 4 ? { ...item, display_title: 'Editorial title' } : item),
  nextUpdatedAt).generation, 11, 'a visible title change must bump generation');
assert.equal(reconciledHomepageLatestSixState(previous,
  baseline.map(item => item.id === 4 ? { ...item, preview_image_url: 'https://images.example/4.jpg' } : item),
  nextUpdatedAt).generation, 11, 'a visible preview-image change must bump generation');
assert.equal(reconciledHomepageLatestSixState(previous,
  [baseline[1]!, baseline[0]!, ...baseline.slice(2)], nextUpdatedAt).generation, 11,
  'a latest-six ordering change must bump generation');
assert.equal(reconciledHomepageLatestSixState(previous, baseline, nextUpdatedAt).snapshot_json,
  previous.snapshot_json, 'changes outside the current six do not alter the snapshot');

const state = { ...previous, generation: 11 };
const rows = baseline.map((item, index) => ({
  ...item,
  source_key: index === 0 ? 'communities-against-woodsmoke' : 'ordinary-publisher',
  og_image_url: item.preview_image_url,
  article_image_policy: 'remote_preview',
  source_image_policy: 'remote_preview',
}));
const database = {
  prepare(sql: string) {
    const statement = {
      bind: () => statement,
      first: async () => sql.includes('media_public_feed_state') ? state : null,
      all: async () => ({ results: sql.includes('FROM media_articles') ? rows : [] }),
    };
    return statement;
  },
} as unknown as D1Database;
const background: Promise<unknown>[] = [];
const context = ({ waitUntil(promise: Promise<unknown>) { background.push(promise); } } as unknown as ExecutionContext);
const writes: string[] = [];
const cacheGlobal = globalThis as unknown as { caches?: CacheStorage };
const originalCaches = cacheGlobal.caches;
Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
  match: async () => undefined,
  put: async (request: Request) => { writes.push(request.url); },
} } });

try {
  const env = { MEDIA_DB: database } as MediaPublicEnv;
  const version = await worker.fetch(new Request('https://media.test/articles/homepage/version'), env, context);
  assert.equal(version.status, 200);
  assert.equal(version.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await version.json(), { generation: 11 });

  const stale = await worker.fetch(new Request('https://media.test/articles/homepage?generation=10'), env, context);
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('Cache-Control'), 'no-store');
  assert.equal(writes.length, 0, 'stale generations must not populate a cache entry');

  const feed = await worker.fetch(new Request('https://media.test/articles/homepage?generation=11'), env, context);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('Cache-Control') ?? '', /max-age=86400/);
  assert.match(feed.headers.get('Cache-Control') ?? '', /immutable/);
  const homepageArticles = (await feed.json() as {
    articles: Array<{ preview_image_url: string | null }>;
  }).articles;
  assert.equal(homepageArticles.length, 6);
  assert.equal(homepageArticles[0]?.preview_image_url, cawsDefaultUrl,
    'the homepage endpoint must use the shared CAWS fallback selection');
  await Promise.all(background);
  assert.deepEqual(writes, ['https://media.test/articles/homepage?generation=11']);

  const imageOnlyDatabase = {
    prepare() {
      return { bind() { return this; }, first: async () => ({
        source_key: 'communities-against-woodsmoke',
        og_image_url: null,
        canonical_domain: 'communitiesagainstwoodsmoke.com',
        article_image_policy: 'remote_preview',
        source_image_policy: 'remote_preview',
      }) };
    },
  } as unknown as D1Database;
  const missingPublisherImage = await worker.fetch(
    new Request('https://media.test/article-images/42'),
    { MEDIA_DB: imageOnlyDatabase } as MediaPublicEnv, context);
  assert.equal(missingPublisherImage.status, 404,
    '/article-images/:id must remain unavailable when CAWS has no real publisher image');

  const publicFeedDatabase = {
    prepare() {
      return { bind() { return this; }, all: async () => ({ results: [{
        id: 42,
        source_key: 'communities-against-woodsmoke',
        canonical_url: 'https://communitiesagainstwoodsmoke.com/example/',
        title: 'CAWS article',
        display_title: null,
        display_title_origin: null,
        publisher: 'Communities Against Woodsmoke',
        author: null,
        published_at: '2026-09-17T12:00:00.000Z',
        discovered_at: '2026-09-17T12:00:00.000Z',
        feed_sort_at: '2026-09-17T12:00:00.000Z',
        summary: null,
        why_it_matters: null,
        editorial_content_origin: null,
        featured: 0,
        topics_json: '[]',
        pollutants_json: '[]',
        locations_json: '[]',
        og_image_url: null,
        article_image_policy: 'remote_preview',
        source_image_policy: 'remote_preview',
      }] }) };
    },
  } as unknown as D1Database;
  const publicFeed = await worker.fetch(new Request('https://media.test/articles?limit=1'),
    { MEDIA_DB: publicFeedDatabase } as MediaPublicEnv, context);
  assert.equal(publicFeed.status, 200);
  const publicArticles = (await publicFeed.json() as {
    articles: Array<{ preview_image_url: string | null }>;
  }).articles;
  assert.equal(publicArticles[0]?.preview_image_url, cawsDefaultUrl,
    '/articles must use the same shared CAWS fallback selection as the homepage endpoint');
} finally {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches });
  else Reflect.deleteProperty(globalThis, 'caches');
}

console.log('Homepage latest-six checks passed');
