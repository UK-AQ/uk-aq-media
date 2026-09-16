import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { BLUESKY_POST_BYTES, graphemes, renderBlueskyPost } from '@uk-aq-media/core';
import mediaAdminWorker from '../apps/media-admin/src/index';
import { consumeBluesky } from '../apps/media-discovery/src/bluesky';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private parameters: SqlValue[] = [];

  constructor(private readonly owner: SqliteD1, readonly statement: StatementSync) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.parameters = values as SqlValue[];
    return this as unknown as D1PreparedStatement;
  }

  values(): readonly SqlValue[] { return this.parameters; }

  async first<T>(): Promise<T | null> {
    const row = (this.statement.get(...this.parameters) as T | undefined) ?? null;
    await this.owner.afterRead(this.statement.sourceSQL);
    return row;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.statement.all(...this.parameters) as T[],
      meta: {} as D1Meta & Record<string, unknown> };
  }

  runSync(): D1Result {
    const result = /\bRETURNING\b/iu.test(this.statement.sourceSQL)
      ? this.statement.all(...this.parameters)
      : this.statement.run(...this.parameters);
    return { success: true, results: [],
      meta: result as unknown as D1Meta & Record<string, unknown> };
  }

  async run(): Promise<D1Result> { return this.runSync(); }
}

class SqliteD1 {
  private preflightReadsRemaining = 0;
  private holdFirstPreflightForWinner = false;
  private releasePreflight: (() => void) | null = null;
  private preflightBarrier: Promise<void> = Promise.resolve();
  private preferredPost: boolean | null = null;
  private preferredBatchCommitted = false;
  private releaseLosingBatch: (() => void) | null = null;
  private losingBatchBarrier: Promise<void> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  armConcurrentStatusRace(preferredPost: boolean | null = null,
    holdFirstPreflightForWinner = false): void {
    this.preflightReadsRemaining = 2;
    this.holdFirstPreflightForWinner = holdFirstPreflightForWinner;
    this.preflightBarrier = new Promise(resolve => { this.releasePreflight = resolve; });
    this.preferredPost = preferredPost;
    this.preferredBatchCommitted = false;
    this.losingBatchBarrier = new Promise(resolve => { this.releaseLosingBatch = resolve; });
  }

  async afterRead(sql: string): Promise<void> {
    if (this.preflightReadsRemaining === 0 ||
        !sql.includes('FROM media_article_events WHERE event_key = ?')) return;
    const firstRead = this.preflightReadsRemaining === 2;
    this.preflightReadsRemaining--;
    if (this.holdFirstPreflightForWinner) {
      if (firstRead) await this.losingBatchBarrier;
      return;
    }
    if (this.preflightReadsRemaining === 0) this.releasePreflight?.();
    await this.preflightBarrier;
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, this.database.prepare(sql)) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const sqliteStatements = statements as unknown as SqliteD1Statement[];
    const requestInsert = sqliteStatements[0];
    const isStatusMutation = requestInsert?.statement.sourceSQL
      .includes('INSERT INTO media_admin_status_requests');
    const requestedPost = isStatusMutation && requestInsert
      ? Boolean(requestInsert.values()[3]) : null;
    if (this.preferredPost !== null && requestedPost !== null &&
        requestedPost !== this.preferredPost && !this.preferredBatchCommitted) {
      await this.losingBatchBarrier;
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = sqliteStatements.map(statement => statement.runSync());
      this.database.exec('COMMIT');
      if (requestedPost === this.preferredPost) {
        this.preferredBatchCommitted = true;
        this.releaseLosingBatch?.();
      }
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  for (const filename of readdirSync('migrations').filter(value => /^\d+.*\.sql$/u.test(value)).sort()) {
    database.exec(readFileSync(`migrations/${filename}`, 'utf8'));
  }
}

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

const FIXTURE_ADMIN_TOKEN = 'fixture-admin-token';

function statusRaceDatabase(): { sqlite: DatabaseSync; facade: SqliteD1; env: MediaAdminEnv } {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  const instant = '2026-09-16T12:00:00.000Z';
  sqlite.prepare(`INSERT INTO media_sources
      (source_key, name, canonical_domain, source_type, enabled, publication_policy,
       review_level, priority, discovery_method, discovery_config_json,
       content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
    VALUES ('bluesky-race-fixture', 'Race fixture', 'fixture.example', 'publisher', 1,
      'manual', 'standard', 50, 'deferred', '{}', 'discovery_metadata_only',
      'disabled', 'remote_preview', ?, ?)`)
    .run(instant, instant);
  const facade = new SqliteD1(sqlite);
  const queue = { async send() { /* durable state is asserted below */ } } as unknown as Queue;
  return { sqlite, facade, env: {
    MEDIA_DB: facade as unknown as D1Database,
    MEDIA_BLUESKY_QUEUE: queue,
    MEDIA_ADMIN_TOKEN: FIXTURE_ADMIN_TOKEN,
  } as MediaAdminEnv };
}

function insertStatusFixture(sqlite: DatabaseSync, id: number,
  status: 'rejected' | 'approved'): void {
  const instant = '2026-09-16T12:00:00.000Z';
  const url = `https://fixture.example/article-${id}`;
  sqlite.prepare(`INSERT INTO media_articles
      (id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
       discovered_at, last_seen_at, status, review_level, approval_method, og_image_url,
       image_policy, approved_at, rejected_at, created_at, updated_at)
    VALUES (?, 'bluesky-race-fixture', ?, ?, ?, ?, 'Race fixture', ?, ?, ?, 'standard',
      ?, ?, 'remote_preview', ?, ?, ?, ?)`)
    .run(id, url, id.toString(16).padStart(64, '0'), url, `Fixture article ${id}`,
      instant, instant, status, status === 'approved' ? 'manual' : null,
      `https://fixture.example/image-${id}.jpg`, status === 'approved' ? instant : null,
      status === 'rejected' ? instant : null, instant, instant);
}

function statusRequest(id: number, action: 'approve' | 'reject' | 'hide', key: string,
  postToBluesky: boolean): Request {
  return new Request(`https://media.example/admin/articles/${id}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ post_to_bluesky: postToBluesky }),
  });
}

async function invokeStatus(env: MediaAdminEnv, request: Request): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await mediaAdminWorker.fetch(
    request as Parameters<typeof mediaAdminWorker.fetch>[0], env);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function scalar(sqlite: DatabaseSync, sql: string, ...values: SqlValue[]): number {
  return Number((sqlite.prepare(sql).get(...values) as { value: number }).value);
}

async function checkConcurrentAdminIdempotency(): Promise<void> {
  {
    const { sqlite, facade, env } = statusRaceDatabase();
    insertStatusFixture(sqlite, 101, 'rejected');
    // The first caller captures an absent replay, then resumes only after the
    // second caller has committed. This covers the replay-read/article-read gap.
    facade.armConcurrentStatusRace(true, true);
    const key = 'race_identical_0001';
    const results = await Promise.all([
      invokeStatus(env, statusRequest(101, 'approve', key, true)),
      invokeStatus(env, statusRequest(101, 'approve', key, true)),
    ]);
    assert.deepEqual(results.map(result => result.status), [200, 200]);
    assert.deepEqual(results.map(result => result.body.replayed).sort(), [false, true]);
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_article_events
      WHERE event_key = ?`, `admin:${key}`), 1);
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
      WHERE publication_key = ?`, `admin-request:${key}`), 1);
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_admin_status_requests
      WHERE request_key = ?`, key), 1);
    sqlite.close();
  }

  for (const preferredPost of [false, true]) {
    const { sqlite, facade, env } = statusRaceDatabase();
    insertStatusFixture(sqlite, 102, 'rejected');
    facade.armConcurrentStatusRace(preferredPost);
    const key = `race_social_${preferredPost ? 'true' : 'false'}_01`;
    const results = await Promise.all([
      invokeStatus(env, statusRequest(102, 'approve', key, false)),
      invokeStatus(env, statusRequest(102, 'approve', key, true)),
    ]);
    const winning = results[preferredPost ? 1 : 0];
    const losing = results[preferredPost ? 0 : 1];
    assert.equal(winning?.status, 200);
    assert.equal(winning?.body.replayed, false);
    assert.equal(losing?.status, 409);
    assert.equal(losing?.body.error, 'idempotency_key_conflict');
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_article_events
      WHERE event_key = ?`, `admin:${key}`), 1);
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
      WHERE publication_key = ?`, `admin-request:${key}`), preferredPost ? 1 : 0);
    const identity = sqlite.prepare(`SELECT post_to_bluesky FROM media_admin_status_requests
      WHERE request_key = ?`).get(key) as { post_to_bluesky: number };
    assert.equal(Boolean(identity.post_to_bluesky), preferredPost);
    sqlite.close();
  }

  {
    const { sqlite, facade, env } = statusRaceDatabase();
    insertStatusFixture(sqlite, 103, 'rejected');
    insertStatusFixture(sqlite, 104, 'rejected');
    facade.armConcurrentStatusRace();
    const key = 'race_different_article_01';
    const results = await Promise.all([
      invokeStatus(env, statusRequest(103, 'approve', key, false)),
      invokeStatus(env, statusRequest(104, 'approve', key, false)),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)?.body.error,
      'idempotency_key_conflict');
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_article_events
      WHERE event_key = ?`, `admin:${key}`), 1);
    sqlite.close();
  }

  {
    const { sqlite, facade, env } = statusRaceDatabase();
    insertStatusFixture(sqlite, 105, 'approved');
    facade.armConcurrentStatusRace();
    const key = 'race_different_action_001';
    const results = await Promise.all([
      invokeStatus(env, statusRequest(105, 'hide', key, false)),
      invokeStatus(env, statusRequest(105, 'reject', key, false)),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)?.body.error,
      'idempotency_key_conflict');
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_article_events
      WHERE event_key = ?`, `admin:${key}`), 1);
    sqlite.close();
  }
}

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const workerSubtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
};
const originalTimingSafeEqual = workerSubtle.timingSafeEqual;
let currentNow = Date.parse('2026-09-16T12:00:00.000Z');
let networkCalls = 0;
Date.now = () => currentNow;
Object.defineProperty(workerSubtle, 'timingSafeEqual', { configurable: true,
  value: (left: ArrayBuffer, right: ArrayBuffer) =>
    timingSafeEqual(new Uint8Array(left), new Uint8Array(right)) });
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error('network access forbidden in Bluesky structural check');
}) as typeof fetch;
console.error = () => undefined;

try {
  await checkConcurrentAdminIdempotency();

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

  const hashtags = renderBlueskyPost({
    title: 'Air quality title', publisher: 'Publisher',
    template: '🌍 clean air #InvestInCleanAir #AirQuality', publisherMention: null,
  });
  const tagFacets = hashtags.facets.filter(facet => facet.features[0]?.$type ===
    'app.bsky.richtext.facet#tag');
  assert.deepEqual(tagFacets.map(facet => facet.features[0]), [
    { $type: 'app.bsky.richtext.facet#tag', tag: 'InvestInCleanAir' },
    { $type: 'app.bsky.richtext.facet#tag', tag: 'AirQuality' },
  ], 'each hashtag must produce its own tag facet');
  assert.deepEqual(tagFacets.map(facet => new TextDecoder().decode(
    new TextEncoder().encode(hashtags.text).slice(facet.index.byteStart, facet.index.byteEnd))),
  ['#InvestInCleanAir', '#AirQuality'],
  'tag facets must select the visible hashtags using UTF-8 byte offsets');
  assert.ok(tagFacets[0]!.index.byteStart > hashtags.text.indexOf('#InvestInCleanAir'),
    'multibyte text before a hashtag must increase its byte offset');
  assert.ok(tagFacets[0]!.index.byteStart < tagFacets[1]!.index.byteStart,
    'multiple tag facets must remain ordered');

  const exclusions = renderBlueskyPost({
    title: 'Air quality title', publisher: 'Publisher',
    template: `https://example.com/a#fragment # ${'#' + 'a'.repeat(65)}`,
    publisherMention: null,
  });
  assert.equal(exclusions.facets.filter(facet => facet.features[0]?.$type ===
    'app.bsky.richtext.facet#link').length, 1,
  'a URL containing a fragment must remain one URL facet');
  assert.equal(exclusions.facets.filter(facet => facet.features[0]?.$type ===
    'app.bsky.richtext.facet#tag').length, 0,
  'URL fragments, bare hashes and over-limit tags must not produce tag facets');

  console.log('Bluesky admin idempotency, backlog barrier and post-builder checks passed.');
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  if (originalTimingSafeEqual) {
    Object.defineProperty(workerSubtle, 'timingSafeEqual', { configurable: true,
      value: originalTimingSafeEqual });
  } else {
    Reflect.deleteProperty(workerSubtle, 'timingSafeEqual');
  }
}
