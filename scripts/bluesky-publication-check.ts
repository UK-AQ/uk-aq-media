import assert from 'node:assert/strict';
import { BLUESKY_POST_BYTES, graphemes, renderBlueskyPost } from '@uk-aq-media/core';
import { consumeBluesky } from '../apps/media-discovery/src/bluesky';

type PublicationRow = {
  id: number;
  article_id: number;
  publication_key: string;
  status: 'queued' | 'posting' | 'posted' | 'failed' | 'blocked';
  attempt_count: number;
  record_key: string | null;
  created_at: string;
  last_attempted_at: string | null;
  next_attempt_at: string | null;
  last_error_code?: string | null;
};

type Wake = { delaySeconds?: number };

function message() {
  const state = { acked: false, retry: null as { delaySeconds?: number } | null };
  return {
    state,
    value: {
      body: { type: 'bluesky_wakeup' },
      ack() { state.acked = true; },
      retry(options?: { delaySeconds?: number }) { state.retry = options ?? {}; },
    } as unknown as Message<unknown>,
  };
}

function environment(rows: PublicationRow[], now: () => number) {
  const wakes: Wake[] = [];
  const claimedIds: number[] = [];
  const settings = {
    publishing_enabled: 1,
    activation_event_id: 1,
    cooldown_seconds: 600,
    default_message_template: 'From {publisher}',
    last_successful_post_at: null,
  };
  const database = {
    prepare(sql: string) {
      const normal = sql.replace(/\s+/gu, ' ').trim();
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() {
          if (normal.includes('FROM media_bluesky_settings')) return settings;
          if (normal.startsWith('SELECT next_attempt_at FROM media_bluesky_publications')) {
            const queued = rows.filter(row => row.status === 'queued').sort((left, right) => {
              if (left.next_attempt_at === null && right.next_attempt_at !== null) return -1;
              if (left.next_attempt_at !== null && right.next_attempt_at === null) return 1;
              return String(left.next_attempt_at).localeCompare(String(right.next_attempt_at)) || left.id - right.id;
            })[0];
            return queued ? { next_attempt_at: queued.next_attempt_at } : null;
          }
          if (normal.startsWith('SELECT last_attempted_at FROM media_bluesky_publications')) {
            const posting = rows.filter(row => row.status === 'posting').sort((left, right) => {
              if (left.last_attempted_at === null && right.last_attempted_at !== null) return -1;
              if (left.last_attempted_at !== null && right.last_attempted_at === null) return 1;
              return String(left.last_attempted_at).localeCompare(String(right.last_attempted_at)) || left.id - right.id;
            })[0];
            return posting ? { last_attempted_at: posting.last_attempted_at } : null;
          }
          if (normal.startsWith('SELECT id FROM media_bluesky_publications') &&
              normal.includes("WHERE status = 'posting'")) {
            const posting = rows.filter(row => row.status === 'posting')
              .sort((left, right) => String(left.last_attempted_at)
                .localeCompare(String(right.last_attempted_at)) || left.id - right.id)[0];
            return posting ? { id: posting.id } : null;
          }
          if (normal.startsWith('SELECT id, article_id, publication_key, status,')) {
            const instant = new Date(now()).toISOString();
            return rows.filter(row => row.status === 'queued' &&
                (row.next_attempt_at === null || row.next_attempt_at <= instant))
              .sort((left, right) => left.id - right.id)[0] ?? null;
          }
          if (normal.startsWith('SELECT a.canonical_url')) return null;
          throw new Error(`unexpected first SQL: ${normal}`);
        },
        async run() {
          let changes = 0;
          if (normal.includes("SET status = 'queued'") && normal.includes("WHERE status = 'posting'")) {
            const cutoff = String(bindings[1]);
            for (const row of rows) {
              if (row.status === 'posting' &&
                  (row.last_attempted_at === null || row.last_attempted_at <= cutoff)) {
                row.status = 'queued';
                row.next_attempt_at = null;
                row.last_error_code = 'publication_state_conflict';
                changes++;
              }
            }
          } else if (normal.includes("SET status = 'posting'")) {
            const id = Number(bindings[3]);
            const row = rows.find(candidate => candidate.id === id);
            if (row?.status === 'queued' && !rows.some(candidate => candidate.status === 'posting')) {
              row.status = 'posting';
              row.record_key = String(bindings[0]);
              row.last_attempted_at = String(bindings[1]);
              row.next_attempt_at = null;
              claimedIds.push(id);
              changes = 1;
            }
          } else if (normal.includes('SET status = ?, attempt_count = attempt_count + 1')) {
            const id = Number(bindings[4]);
            const row = rows.find(candidate => candidate.id === id);
            if (row?.status === 'posting') {
              row.status = String(bindings[0]) as PublicationRow['status'];
              row.attempt_count++;
              row.last_error_code = String(bindings[1]);
              row.next_attempt_at = bindings[2] === null ? null : String(bindings[2]);
              changes = 1;
            }
          } else {
            throw new Error(`unexpected run SQL: ${normal}`);
          }
          return { meta: { changes } };
        },
      };
      return statement;
    },
    async batch() { throw new Error('unexpected success batch'); },
  } as unknown as D1Database;
  const queue = {
    async send(_body: unknown, options?: Wake) { wakes.push(options ?? {}); },
  } as unknown as Queue;
  return {
    env: { MEDIA_DB: database, MEDIA_BLUESKY_QUEUE: queue } as MediaDiscoveryEnv,
    wakes,
    claimedIds,
  };
}

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
let currentNow = Date.parse('2026-09-16T12:00:00.000Z');
let networkCalls = 0;
Date.now = () => currentNow;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error('network access forbidden in Bluesky structural check');
}) as typeof fetch;
console.error = () => undefined;

try {
  const rows: PublicationRow[] = [
    { id: 1, article_id: 1, publication_key: 'a', status: 'posting', attempt_count: 0,
      record_key: '3m3b2aaaaaaaa', created_at: '2026-09-16T11:55:00.000Z',
      last_attempted_at: '2026-09-16T11:55:00.000Z', next_attempt_at: null },
    { id: 2, article_id: 2, publication_key: 'b', status: 'queued', attempt_count: 0,
      record_key: null, created_at: '2026-09-16T11:56:00.000Z',
      last_attempted_at: null, next_attempt_at: null },
  ];
  const first = environment(rows, () => currentNow);
  const liveMessage = message();
  await consumeBluesky(liveMessage.value, first.env);
  assert.equal(rows[0]?.status, 'posting', 'a five-minute claim must not recover early');
  assert.deepEqual(first.claimedIds, [], 'a live posting claim must block every queued claim');
  assert.equal(rows[1]?.status, 'queued', 'later queued work must remain untouched');
  assert.equal(first.wakes.length, 1);
  assert.ok((first.wakes[0]?.delaySeconds ?? 0) >= 299 &&
    (first.wakes[0]?.delaySeconds ?? 0) <= 300,
  'the barrier wake must target the live claim stale threshold');
  assert.equal(liveMessage.state.acked, true);
  assert.equal(liveMessage.state.retry, null);
  assert.equal(networkCalls, 0, 'the live-claim barrier must prevent remote processing');

  currentNow += 6 * 60 * 1000;
  const staleMessage = message();
  await consumeBluesky(staleMessage.value, first.env);
  assert.deepEqual(first.claimedIds, [1], 'the recovered oldest row must be selected before B');
  assert.equal(rows[1]?.status, 'queued', 'B must stay queued while recovered A is handled');
  assert.equal(staleMessage.state.acked, true);

  const onlyB: PublicationRow[] = [
    { id: 2, article_id: 2, publication_key: 'b', status: 'queued', attempt_count: 0,
      record_key: null, created_at: '2026-09-16T11:56:00.000Z',
      last_attempted_at: null, next_attempt_at: null },
  ];
  const third = environment(onlyB, () => currentNow);
  const queuedMessage = message();
  await consumeBluesky(queuedMessage.value, third.env);
  assert.deepEqual(third.claimedIds, [2], 'eligible B must proceed when no posting barrier exists');
  assert.equal(queuedMessage.state.acked, true);

  const injected = renderBlueskyPost({
    title: 'Air quality title',
    publisher: 'Literal {publisher_mention} Publisher',
    template: 'From {publisher} {publisher_mention}',
    publisherMention: { handle: 'publisher.example', did: 'did:plc:publisher' },
  });
  assert.equal(injected.text,
    'Air quality title\n\nFrom Literal {publisher_mention} Publisher @publisher.example',
  'publisher text must not be reinterpreted as a template token');
  assert.equal(injected.facets.filter(facet => facet.features[0]?.$type ===
    'app.bsky.richtext.facet#mention').length, 1);

  const noMention = renderBlueskyPost({
    title: 'Air quality title', publisher: 'Publisher',
    template: 'From {publisher_mention} {publisher}', publisherMention: null,
  });
  assert.equal(noMention.text, 'Air quality title\n\nFrom Publisher',
    'an empty optional mention must not leave doubled whitespace');

  const byteHeavy = renderBlueskyPost({
    title: '👨‍👩‍👧‍👦'.repeat(200), publisher: 'Publisher',
    template: 'From {publisher}', publisherMention: null,
  });
  assert.ok(new TextEncoder().encode(byteHeavy.text).byteLength <= BLUESKY_POST_BYTES,
    'the rendered post must satisfy the provider byte limit');
  assert.ok(graphemes(byteHeavy.text).length <= 300,
    'the rendered post must satisfy the provider grapheme limit');
  assert.ok(byteHeavy.text.split('\n\n', 1)[0]?.endsWith('…'),
    'only the rendered byte-heavy title should be shortened');

  console.log('Bluesky backlog barrier and post-builder checks passed.');
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
}
