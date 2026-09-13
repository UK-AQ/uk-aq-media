import assert from 'node:assert/strict';
import worker from '../apps/media-public/src/index';
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
const rows = baseline.map(item => ({
  ...item,
  og_image_url: item.preview_image_url,
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
  assert.equal((await feed.json() as { articles: unknown[] }).articles.length, 6);
  await Promise.all(background);
  assert.deepEqual(writes, ['https://media.test/articles/homepage?generation=11']);
} finally {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches });
  else Reflect.deleteProperty(globalThis, 'caches');
}

console.log('Homepage latest-six checks passed');
