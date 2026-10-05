import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { BLUESKY_POST_BYTES, blueskyPublicationStatusLabel, graphemes,
  reconcileBlueskyPublications, releaseBlueskyThumbnailPending, renderBlueskyPost } from '@uk-aq-media/core';
import mediaAdminWorker from '../apps/media-admin/src/index';
import {
  consumeBluesky, externalCardText, thumbnailFetchDiagnostic,
} from '../apps/media-discovery/src/bluesky';

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
  private bulkRaceWinner: { key: string; idsJson: string; post: boolean } | null = null;
  private directPublishRace: { articleId: number; platform: 'bluesky' | 'facebook' } | null = null;

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

  armBulkIdentityRace(key: string, ids: number[], post: boolean): void {
    this.bulkRaceWinner = { key, idsJson: JSON.stringify([...ids].sort((a, b) => a - b)), post };
  }

  armDirectPublishGuardRace(articleId: number, platform: 'bluesky' | 'facebook'): void {
    this.directPublishRace = { articleId, platform };
  }

  async afterRead(sql: string): Promise<void> {
    if (this.bulkRaceWinner &&
        sql.includes('FROM media_admin_bulk_status_requests WHERE request_key = ?')) {
      const winner = this.bulkRaceWinner;
      this.bulkRaceWinner = null;
      this.database.prepare(`INSERT INTO media_admin_bulk_status_requests
        (request_key, article_ids_json, post_to_bluesky, created_at) VALUES (?, ?, ?, ?)`)
        .run(winner.key, winner.idsJson, Number(winner.post), '2026-09-17T12:00:00.000Z');
    }
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
    if (this.directPublishRace && requestInsert?.statement.sourceSQL
      .includes('INSERT INTO media_admin_publish_requests')) {
      const { articleId, platform } = this.directPublishRace;
      this.directPublishRace = null;
      const insert = this.database.prepare(`INSERT INTO media_${platform}_publications
        (article_id, publication_key, publication_reason, status, created_at, updated_at)
        VALUES (?, ?, 'pending_approved', ?, ?, ?)`);
      const now = '2026-09-20T12:00:00.000Z';
      insert.run(articleId, `guard-race-active-${platform}-${articleId}`,
        platform === 'facebook' ? 'unknown_remote_state' : 'queued', now, now);
      insert.run(articleId, `guard-race-terminal-${platform}-${articleId}`, 'failed', now, now);
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

function applyMigrations(database: DatabaseSync, through = '9999'): void {
  database.exec('PRAGMA foreign_keys = ON');
  for (const filename of readdirSync('migrations').filter(value =>
    /^\d+.*\.sql$/u.test(value) && value.slice(0, 4) <= through).sort()) {
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

function statusRaceDatabase(through = '9999'): { sqlite: DatabaseSync; facade: SqliteD1; env: MediaAdminEnv;
  wakes: unknown[] } {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, through);
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
  const wakes: unknown[] = [];
  const queue = { async send(body: unknown) { wakes.push(body); } } as unknown as Queue;
  return { sqlite, facade, env: {
    MEDIA_DB: facade as unknown as D1Database,
    MEDIA_BLUESKY_QUEUE: queue,
    MEDIA_FACEBOOK_QUEUE: queue,
    MEDIA_ADMIN_TOKEN: FIXTURE_ADMIN_TOKEN,
  } as MediaAdminEnv, wakes };
}

function insertStatusFixture(sqlite: DatabaseSync, id: number,
  status: 'pending' | 'rejected' | 'approved' | 'hidden', image = true,
  approvalMethod = 'manual'): void {
  const instant = '2026-09-16T12:00:00.000Z';
  const url = `https://fixture.example/article-${id}`;
  sqlite.prepare(`INSERT INTO media_articles
      (id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
       discovered_at, last_seen_at, status, review_level, approval_method, og_image_url,
       image_policy, approved_at, rejected_at, created_at, updated_at)
    VALUES (?, 'bluesky-race-fixture', ?, ?, ?, ?, 'Race fixture', ?, ?, ?, 'standard',
      ?, ?, 'remote_preview', ?, ?, ?, ?)`)
    .run(id, url, id.toString(16).padStart(64, '0'), url, `Fixture article ${id}`,
      instant, instant, status, ['approved', 'hidden'].includes(status) ? approvalMethod : null,
      image ? `https://fixture.example/image-${id}.jpg` : null,
      ['approved', 'hidden'].includes(status) ? instant : null,
      status === 'rejected' ? instant : null, instant, instant);
}

function statusRequest(id: number, action: 'approve' | 'reject' | 'hide', key: string,
  postToBluesky?: boolean): Request {
  return new Request(`https://media.example/admin/articles/${id}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(postToBluesky === undefined ? {} : { post_to_bluesky: postToBluesky }),
  });
}

function bulkRequest(ids: number[], key: string, postToBluesky?: boolean): Request {
  return new Request('https://media.example/admin/articles/bulk/approve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ article_ids: ids, ...(postToBluesky === undefined
      ? {} : { post_to_bluesky: postToBluesky }) }),
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

function checkPopulatedManualPublishMigration(): void {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, '0027');
  const now = '2026-09-20T12:00:00.000Z';
  sqlite.prepare(`INSERT INTO media_sources
    (source_key, name, canonical_domain, source_type, enabled, publication_policy,
     review_level, priority, discovery_method, discovery_config_json,
     content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
    VALUES ('bluesky-race-fixture', 'Fixture', 'fixture.example', 'publisher', 1,
      'manual', 'standard', 50, 'deferred', '{}', 'discovery_metadata_only',
      'disabled', 'remote_preview', ?, ?)`).run(now, now);
  insertStatusFixture(sqlite, 300, 'approved');
  sqlite.prepare(`INSERT INTO media_bluesky_publications
    (id, article_id, publication_key, publication_reason, status, attempt_count,
     record_key, last_error_code, next_attempt_at, created_at, last_attempted_at, updated_at)
    VALUES (11, 300, 'migration-blue', 'pending_approved', 'failed', 2,
      'record-key', 'fixture_error', ?, ?, ?, ?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO media_facebook_publications
    (id, article_id, publication_key, publication_reason, status, attempt_count,
     remote_request_started_at, unknown_at, last_error_code, created_at, updated_at)
    VALUES (12, 300, 'migration-facebook', 'pending_approved',
      'unknown_remote_state', 1, ?, ?, 'ambiguous', ?, ?)`).run(now, now, now, now);
  for (const table of ['media_bluesky_publications', 'media_facebook_publications']) {
    sqlite.prepare(`INSERT INTO ${table}
      (id, article_id, publication_key, publication_reason, status, created_at, updated_at)
      VALUES (40, 300, ?, 'pending_approved', 'failed', ?, ?)`)
      .run(`deleted-${table}`, now, now);
    sqlite.prepare(`DELETE FROM ${table} WHERE id = 40`).run();
  }
  const rows = ['media_bluesky_publications', 'media_facebook_publications'].map(table =>
    sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const columns = ['media_bluesky_publications', 'media_facebook_publications'].map(table =>
    sqlite.prepare(`PRAGMA table_info(${table})`).all());
  const indexes = ['media_bluesky_publications', 'media_facebook_publications'].map(table =>
    sqlite.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
      ORDER BY name`).all(table).map(row => String(row.name)));
  const trigger = (sqlite.prepare(`SELECT sql FROM sqlite_master
    WHERE name = 'media_bluesky_automatic_outbox'`).get() as { sql: string }).sql;
  sqlite.exec(readFileSync('migrations/0028_manual_social_publish.sql', 'utf8'));
  for (const [index, table] of ['media_bluesky_publications', 'media_facebook_publications'].entries()) {
    assert.deepEqual(sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows[index]);
    assert.deepEqual(sqlite.prepare(`PRAGMA table_info(${table})`).all(), columns[index]);
    assert.deepEqual(sqlite.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? ORDER BY name`).all(table)
      .map(row => String(row.name)), indexes[index]);
    assert.equal(scalar(sqlite, `SELECT seq AS value FROM sqlite_sequence WHERE name = ?`, table), 40);
    const result = sqlite.prepare(`INSERT INTO ${table}
      (article_id, publication_key, publication_reason, status, created_at, updated_at)
      VALUES (300, ?, 'manual_repost', 'queued', ?, ?)`).run(`new-${table}`, now, now);
    assert.equal(Number(result.lastInsertRowid), 41);
  }
  const afterTrigger = (sqlite.prepare(`SELECT sql FROM sqlite_master
    WHERE name = 'media_bluesky_automatic_outbox'`).get() as { sql: string }).sql;
  assert.equal(afterTrigger.replace(/\s+/gu, ' '), trigger.replace(/\s+/gu, ' '));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  sqlite.close();
}

function checkFacebookAutomaticMigration(): void {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, '0028');
  const now = '2026-09-20T12:00:00.000Z';
  sqlite.prepare(`INSERT INTO media_sources
    (source_key, name, canonical_domain, source_type, enabled, publication_policy,
     review_level, priority, discovery_method, discovery_config_json,
     content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
    VALUES ('facebook-auto-fixture', 'Fixture', 'fixture.example', 'publisher', 1,
      'auto_approve', 'standard', 50, 'deferred', '{}', 'discovery_metadata_only',
      'disabled', 'blocked', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO media_articles
    (id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
     discovered_at, last_seen_at, status, review_level, approval_method, image_policy,
     approved_at, created_at, updated_at)
    VALUES (350, 'facebook-auto-fixture', 'https://fixture.example/350', ?,
      'https://fixture.example/350', 'Fixture 350', 'Fixture', ?, ?, 'approved',
      'standard', 'trusted_source_auto', 'blocked', ?, ?, ?)`).run(
      'a'.repeat(64), now, now, now, now, now);
  const migrationWatermark = scalar(sqlite,
    'SELECT max(id) AS value FROM media_article_events');
  sqlite.exec('UPDATE media_facebook_settings SET publishing_enabled = 1');
  sqlite.prepare(`INSERT INTO media_facebook_publications
    (id, article_id, publication_key, publication_reason, status, attempt_count,
     facebook_post_id, facebook_permalink_url, last_error_code, next_attempt_at,
     remote_request_started_at, unknown_at, reconciled_at, reconciliation_method,
     created_at, last_attempted_at, posted_at, updated_at)
    VALUES (12, 350, 'preserved-facebook', 'pending_approved', 'posted', 3,
      'page_post', 'https://facebook.example/post', 'old_error', ?, ?, ?, ?,
      'exact_post_id', ?, ?, ?, ?)`).run(now, now, now, now, now, now, now, now);
  sqlite.prepare(`INSERT INTO media_facebook_publications
    (id, article_id, publication_key, publication_reason, status, created_at, updated_at)
    VALUES (40, 350, 'deleted-facebook', 'pending_approved', 'failed', ?, ?)`).run(now, now);
  sqlite.exec(`DELETE FROM media_facebook_publications WHERE id = 40`);
  const before = sqlite.prepare(`SELECT * FROM media_facebook_publications ORDER BY id`).all();
  const indexes = sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'media_facebook_publications' ORDER BY name`).all();
  sqlite.exec(readFileSync('migrations/0029_facebook_automatic_publications.sql', 'utf8'));
  assert.deepEqual(sqlite.prepare(`SELECT * FROM media_facebook_publications ORDER BY id`).all(), before);
  assert.deepEqual(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'media_facebook_publications' ORDER BY name`).all(), indexes);
  assert.equal(scalar(sqlite, `SELECT seq AS value FROM sqlite_sequence
    WHERE name = 'media_facebook_publications'`), 40);
  assert.equal(scalar(sqlite, `SELECT activation_event_id AS value
    FROM media_facebook_settings WHERE id = 1`), migrationWatermark);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE publication_reason = 'auto_approved'`), 0,
  'migration must not backfill historical automatic approvals');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  const inserted = sqlite.prepare(`INSERT INTO media_facebook_publications
    (article_id, publication_key, publication_reason, status, created_at, updated_at)
    VALUES (350, 'after-migration', 'auto_approved', 'queued', ?, ?)`).run(now, now);
  assert.equal(Number(inserted.lastInsertRowid), 41);
  sqlite.close();
}

function facebookSettingsRequest(key: string, publishingEnabled: boolean): Request {
  return new Request('https://media.example/admin/facebook/settings', {
    method: 'PUT', headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ publishing_enabled: publishingEnabled, cooldown_minutes: 10,
      default_message_template: 'From {publisher}' }),
  });
}

async function checkFacebookAutomaticContract(): Promise<void> {
  const { sqlite, env } = statusRaceDatabase();
  assert.equal((sqlite.prepare(`SELECT activation_event_id FROM media_facebook_settings
    WHERE id = 1`).get() as { activation_event_id: number | null }).activation_event_id, null);
  insertStatusFixture(sqlite, 351, 'pending', false);
  const watermark = scalar(sqlite, 'SELECT max(id) AS value FROM media_article_events');
  sqlite.exec(`UPDATE media_facebook_settings SET last_identity_verified_at =
    '2026-09-20T12:00:00.000Z', last_identity_error_code = NULL`);
  let result = await invokeStatus(env, facebookSettingsRequest('facebook-settings-enable-001', true));
  assert.equal(result.status, 200);
  assert.equal((result.body.settings as { activation_event_id: number }).activation_event_id, watermark);
  result = await invokeStatus(env, facebookSettingsRequest('facebook-settings-enable-001', true));
  assert.equal(result.body.replayed, true);
  assert.equal((result.body.settings as { activation_event_id: number }).activation_event_id, watermark);

  insertStatusFixture(sqlite, 352, 'approved', false);
  sqlite.prepare(`INSERT INTO media_article_events
    (article_id, event_key, event_type, actor_type, from_status, to_status,
     revision, created_at) VALUES (352, 'author-auto:facebook-automatic-352',
      'auto_approved', 'discovery', 'pending', 'approved', 2,
      '2026-09-20T12:01:00.000Z')`).run();
  const event = sqlite.prepare(`SELECT id, created_at FROM media_article_events
    WHERE article_id = 352 AND event_type = 'auto_approved'`).get() as { id: number; created_at: string };
  const automatic = { ...sqlite.prepare(`SELECT approval_event_id, publication_key,
    publication_reason, status, created_at, updated_at FROM media_facebook_publications
    WHERE article_id = 352`).get() as Record<string, unknown> };
  assert.deepEqual(automatic, { approval_event_id: event.id,
    publication_key: `approval-event:${event.id}`, publication_reason: 'auto_approved',
    status: 'queued', created_at: event.created_at, updated_at: event.created_at });
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id = 352`), 1, 'approval-event publication key must remain idempotent');
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE approval_event_id <= ?`, watermark), 0);

  for (const [id, type, fromStatus] of [[353, 'approved', 'pending'],
    [354, 'approved', 'rejected'], [355, 'unhidden', 'hidden']] as const) {
    insertStatusFixture(sqlite, id, fromStatus === 'pending' ? 'pending' :
      fromStatus === 'rejected' ? 'rejected' : 'hidden', false);
    sqlite.prepare(`INSERT INTO media_article_events
      (article_id, event_key, event_type, actor_type, from_status, to_status,
       revision, created_at) VALUES (?, ?, ?, 'admin', ?, 'approved', 2, ?)`)
      .run(id, `manual-facebook-${id}`, type, fromStatus, '2026-09-20T12:01:00.000Z');
  }
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id IN (353, 354, 355)`), 0);

  await invokeStatus(env, facebookSettingsRequest('facebook-settings-disable-01', false));
  await invokeStatus(env, facebookSettingsRequest('facebook-settings-reenable-1', true));
  assert.equal(scalar(sqlite, `SELECT activation_event_id AS value
    FROM media_facebook_settings WHERE id = 1`), watermark,
  'disable and re-enable must preserve the original activation watermark');
  sqlite.close();
}

function directRequest(ids: number[], key: string, bluesky: boolean, facebook: boolean,
  bulk = false): Request {
  return new Request(`https://media.example/admin/articles/${bulk ? 'bulk' : ids[0]}/publish`, {
    method: 'POST', headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ ...(bulk ? { article_ids: ids } : {}),
      post_to_bluesky: bluesky, post_to_facebook: facebook }),
  });
}

async function checkDirectPublishContract(): Promise<void> {
  const { sqlite, facade, env, wakes } = statusRaceDatabase();
  sqlite.exec('UPDATE media_facebook_settings SET publishing_enabled = 1');
  insertStatusFixture(sqlite, 301, 'approved');
  insertStatusFixture(sqlite, 302, 'approved', false);
  insertStatusFixture(sqlite, 303, 'pending');
  insertStatusFixture(sqlite, 304, 'approved', false);
  insertStatusFixture(sqlite, 305, 'approved', false);
  insertStatusFixture(sqlite, 306, 'approved');
  insertStatusFixture(sqlite, 307, 'approved');
  insertStatusFixture(sqlite, 308, 'approved', false);
  insertStatusFixture(sqlite, 309, 'approved', false);
  insertStatusFixture(sqlite, 310, 'approved');
  insertStatusFixture(sqlite, 311, 'approved');
  insertStatusFixture(sqlite, 312, 'approved');
  insertStatusFixture(sqlite, 313, 'approved', false);
  const initialEvents = scalar(sqlite,
    'SELECT count(*) AS value FROM media_article_events WHERE article_id = 301');
  const initialRevision = scalar(sqlite, 'SELECT revision AS value FROM media_articles WHERE id = 301');

  const key = 'direct-publish-301-a';
  const first = await invokeStatus(env, directRequest([301], key, true, true));
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal((first.body.bluesky_publication as { publication_reason: string }).publication_reason,
    'manual_post');
  assert.equal((first.body.facebook_publication as { publication_reason: string }).publication_reason,
    'manual_post');
  assert.equal(scalar(sqlite, 'SELECT count(*) AS value FROM media_article_events WHERE article_id = 301'),
    initialEvents);
  assert.equal(scalar(sqlite, 'SELECT revision AS value FROM media_articles WHERE id = 301'),
    initialRevision);
  assert.equal(wakes.length, 2);
  const replay = await invokeStatus(env, directRequest([301], key, true, true));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.bluesky_publication, first.body.bluesky_publication);
  assert.equal(scalar(sqlite, 'SELECT count(*) AS value FROM media_bluesky_publications WHERE article_id = 301'), 1);
  assert.equal((await invokeStatus(env, directRequest([301], key, true, false))).body.error,
    'idempotency_key_conflict');
  assert.equal((await invokeStatus(env, directRequest([301], key, true, true, true))).body.error,
    'idempotency_key_conflict');
  const noKey = directRequest([301], 'direct-publish-301-no-key', true, false);
  noKey.headers.delete('Idempotency-Key');
  assert.equal((await invokeStatus(env, noKey)).body.error, 'idempotency_key_required');
  assert.equal((await invokeStatus(env, directRequest([301], 'direct-publish-301-b', true, false))).body.error,
    'publication_in_progress');
  sqlite.exec(`UPDATE media_bluesky_publications SET status = 'posted',
    post_uri = 'at://did:plc:fixture/app.bsky.feed.post/301', post_cid = 'cid-301',
    posted_at = '2026-09-20T12:00:00.000Z' WHERE article_id = 301`);
  sqlite.exec(`UPDATE media_facebook_publications SET status = 'posted',
    facebook_post_id = 'fixture_301', posted_at = '2026-09-20T12:00:00.000Z'
    WHERE article_id = 301`);
  const repost = await invokeStatus(env, directRequest([301], 'direct-publish-301-c', true, true));
  assert.equal(repost.status, 200);
  assert.equal((repost.body.bluesky_publication as { publication_reason: string }).publication_reason,
    'manual_repost');
  assert.equal((repost.body.facebook_publication as { publication_reason: string }).publication_reason,
    'manual_repost');
  sqlite.prepare(`INSERT INTO media_bluesky_publications
    (article_id, publication_key, publication_reason, status, post_uri, post_cid,
     created_at, posted_at, updated_at)
    VALUES (306, 'prior-blue-306', 'pending_approved', 'posted',
      'at://did:plc:fixture/app.bsky.feed.post/306', 'cid-306', ?, ?, ?)`).run(
      '2026-09-20T12:00:00.000Z', '2026-09-20T12:00:00.000Z', '2026-09-20T12:00:00.000Z');
  const readyDetail = await invokeStatus(env,
    new Request('https://media.example/admin/articles/306', {
      headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    }));
  assert.equal((readyDetail.body.bluesky as { direct_publish_reason: string })
    .direct_publish_reason, 'manual_repost');
  assert.equal((readyDetail.body.facebook as { direct_publish_reason: string })
    .direct_publish_reason, 'manual_post');
  const mixed = await invokeStatus(env, directRequest([306], 'direct-publish-306-a', true, true));
  assert.equal(mixed.status, 200);
  assert.equal((mixed.body.bluesky_publication as { publication_reason: string }).publication_reason,
    'manual_repost');
  assert.equal((mixed.body.facebook_publication as { publication_reason: string }).publication_reason,
    'manual_post');
  sqlite.prepare(`INSERT INTO media_bluesky_publications
    (article_id, publication_key, publication_reason, status, created_at, updated_at)
    VALUES (307, 'prior-failed-307', 'pending_approved', 'failed', ?, ?)`).run(
      '2026-09-20T12:00:00.000Z', '2026-09-20T12:00:00.000Z');
  const failedPrior = await invokeStatus(env, directRequest([307], 'direct-publish-307-a',
    true, false));
  assert.equal((failedPrior.body.bluesky_publication as { publication_reason: string })
    .publication_reason, 'manual_post');

  const facebookOnly = await invokeStatus(env, directRequest([302], 'direct-publish-302-a', false, true));
  assert.equal(facebookOnly.status, 200, 'Facebook must not require a thumbnail');
  assert.equal(facebookOnly.body.bluesky_publication, null);
  assert.equal((await invokeStatus(env, directRequest([302], 'direct-publish-302-b', true, false)))
    .body.error, 'thumbnail_missing');
  assert.equal((await invokeStatus(env, directRequest([303], 'direct-publish-303-a', false, true)))
    .body.error, 'article_not_approved');
  sqlite.exec(`UPDATE media_facebook_publications SET status = 'unknown_remote_state'
    WHERE article_id = 302`);
  assert.equal((await invokeStatus(env, directRequest([302], 'direct-publish-302-c', false, true)))
    .body.error, 'unknown_remote_state');
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id = 302`), 1);

  const bulkKey = 'direct-bulk-304-a';
  const rejectedBulk = await invokeStatus(env, directRequest([304, 305], bulkKey, true, true, true));
  assert.equal(rejectedBulk.status, 409);
  assert.equal(rejectedBulk.body.error, 'bulk_publish_ineligible');
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_admin_publish_requests
    WHERE request_key = ?`, bulkKey), 0);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id IN (304, 305)`), 0);
  const bulk = await invokeStatus(env, directRequest([305, 304], bulkKey, false, true, true));
  assert.equal(bulk.status, 200);
  assert.deepEqual((bulk.body.facebook_publications as Array<{ article_id: number }> )
    .map(row => row.article_id), [304, 305]);
  assert.equal((await invokeStatus(env, directRequest([304, 305], bulkKey, false, true, true)))
    .body.replayed, true);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id IN (304, 305)`), 2);
  assert.equal((await invokeStatus(env, directRequest([304, 304], 'direct-bulk-304-b',
    false, true, true))).body.error, 'duplicate_article_id');
  assert.equal((await invokeStatus(env, directRequest([304], 'direct-no-platform-a',
    false, false))).body.error, 'invalid_publish_body');

  const detail = await invokeStatus(env, new Request('https://media.example/admin/articles/302', {
    headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
  }));
  assert.equal(detail.status, 200);
  assert.equal((detail.body.bluesky as { direct_publish_unavailable_reason: string })
    .direct_publish_unavailable_reason, 'thumbnail_missing');
  assert.equal((detail.body.facebook as { direct_publish_unavailable_reason: string })
    .direct_publish_unavailable_reason, 'unknown_remote_state');
  const availableDetail = await invokeStatus(env,
    new Request('https://media.example/admin/articles/306', {
      headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    }));
  assert.equal((availableDetail.body.bluesky as { direct_publish_unavailable_reason: string })
    .direct_publish_unavailable_reason, 'publication_in_progress');
  assert.equal((availableDetail.body.facebook as { direct_publish_unavailable_reason: string })
    .direct_publish_unavailable_reason, 'publication_in_progress');

  const now = '2026-09-20T12:00:00.000Z';
  for (const [key, status] of ([
    ['older-facebook-unknown-309', 'unknown_remote_state'],
    ['middle-facebook-queued-309', 'queued'],
    ['newest-facebook-failed-309', 'failed'],
  ] as const)) {
    sqlite.prepare(`INSERT INTO media_facebook_publications
      (article_id, publication_key, publication_reason, status, created_at, updated_at)
      VALUES (309, ?, 'pending_approved', ?, ?, ?)`).run(key, status, now, now);
  }
  const facebookOlderHoldDetail = await invokeStatus(env,
    new Request('https://media.example/admin/articles/309', {
      headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    }));
  const facebookOlderHold = facebookOlderHoldDetail.body.facebook as {
    latest_status: string; direct_publish_available: boolean;
    direct_publish_unavailable_reason: string;
  };
  assert.equal(facebookOlderHold.latest_status, 'failed');
  assert.equal(facebookOlderHold.direct_publish_available, false);
  assert.equal(facebookOlderHold.direct_publish_unavailable_reason, 'unknown_remote_state');
  assert.equal((await invokeStatus(env, directRequest([309], 'direct-older-facebook-309',
    false, true))).body.error, 'unknown_remote_state');
  const olderHoldBulkKey = 'direct-older-facebook-bulk-309';
  const olderHoldBulk = await invokeStatus(env, directRequest([308, 309], olderHoldBulkKey,
    false, true, true));
  assert.equal(olderHoldBulk.status, 409);
  assert.deepEqual(olderHoldBulk.body.failures, [{ article_id: 309, platform: 'facebook',
    error: 'unknown_remote_state' }]);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id = 309`), 3);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_facebook_publications
    WHERE article_id = 308`), 0);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_admin_publish_requests
    WHERE request_key IN (?, ?)`, 'direct-older-facebook-309', olderHoldBulkKey), 0);

  for (const [key, status] of ([
    ['older-bluesky-posting-310', 'posting'],
    ['newest-bluesky-blocked-310', 'blocked'],
  ] as const)) {
    sqlite.prepare(`INSERT INTO media_bluesky_publications
      (article_id, publication_key, publication_reason, status, created_at, updated_at)
      VALUES (310, ?, 'pending_approved', ?, ?, ?)`).run(key, status, now, now);
  }
  const blueskyOlderHoldDetail = await invokeStatus(env,
    new Request('https://media.example/admin/articles/310', {
      headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    }));
  const blueskyOlderHold = blueskyOlderHoldDetail.body.bluesky as {
    latest_status: string; direct_publish_available: boolean;
    direct_publish_unavailable_reason: string;
  };
  assert.equal(blueskyOlderHold.latest_status, 'blocked');
  assert.equal(blueskyOlderHold.direct_publish_available, false);
  assert.equal(blueskyOlderHold.direct_publish_unavailable_reason, 'publication_in_progress');
  assert.equal((await invokeStatus(env, directRequest([310], 'direct-older-bluesky-310',
    true, false))).body.error, 'publication_in_progress');
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id = 310`), 2);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_admin_publish_requests
    WHERE request_key = ?`, 'direct-older-bluesky-310'), 0);

  for (const table of ['media_bluesky_publications', 'media_facebook_publications']) {
    sqlite.prepare(`INSERT INTO ${table}
      (article_id, publication_key, publication_reason, status, created_at, updated_at)
      VALUES (311, ?, 'pending_approved', 'blocked', ?, ?)`)
      .run(`prior-blocked-${table}-311`, now, now);
  }
  const terminalOnly = await invokeStatus(env, directRequest([311], 'direct-terminal-only-311',
    true, true));
  assert.equal(terminalOnly.status, 200);
  assert.equal((terminalOnly.body.bluesky_publication as { publication_reason: string })
    .publication_reason, 'manual_post');
  assert.equal((terminalOnly.body.facebook_publication as { publication_reason: string })
    .publication_reason, 'manual_post');

  for (const [articleId, platform] of ([
    [312, 'bluesky'], [313, 'facebook'],
  ] as const)) {
    facade.armDirectPublishGuardRace(articleId, platform);
    const requestKey = `direct-guard-race-${platform}-${articleId}`;
    const raced = await invokeStatus(env, directRequest([articleId], requestKey,
      platform === 'bluesky', platform === 'facebook'));
    assert.equal(raced.status, 409);
    assert.equal(raced.body.error, 'direct_publish_state_conflict');
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_${platform}_publications
      WHERE article_id = ?`, articleId), 2);
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_admin_publish_requests
      WHERE request_key = ?`, requestKey), 0);
  }

  sqlite.exec('UPDATE media_facebook_settings SET publishing_enabled = 0');
  assert.equal((await invokeStatus(env, directRequest([308], 'direct-publish-308-a',
    false, true))).body.error, 'facebook_publishing_disabled');
  const disabledDetail = await invokeStatus(env,
    new Request('https://media.example/admin/articles/308', {
      headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    }));
  assert.equal((disabledDetail.body.facebook as { direct_publish_unavailable_reason: string })
    .direct_publish_unavailable_reason, 'facebook_publishing_disabled');
  sqlite.close();
}

async function checkConcurrentAdminIdempotency(): Promise<void> {
  {
    const { sqlite, facade, env } = statusRaceDatabase();
    insertStatusFixture(sqlite, 99, 'pending');
    insertStatusFixture(sqlite, 100, 'pending');
    const key = 'bulk_identity_race_001';
    // Inject the competing winner after the caller's absent preflight read and
    // before its batch, deterministically reproducing the narrow race window.
    facade.armBulkIdentityRace(key, [100], true);
    const losing = await invokeStatus(env, bulkRequest([99], key, false));
    assert.equal(losing.status, 409);
    assert.equal(losing.body.error, 'idempotency_key_conflict');
    assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_article_events
      WHERE event_key GLOB ?`, `admin-bulk:${key}:*`), 0);
    sqlite.close();
  }

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

async function checkManualApprovalContract(): Promise<void> {
  const { sqlite, env, wakes } = statusRaceDatabase();
  sqlite.prepare(`UPDATE media_bluesky_settings SET activation_event_id = 0 WHERE id = 1`).run();

  insertStatusFixture(sqlite, 201, 'pending');
  let result = await invokeStatus(env, statusRequest(201, 'approve', 'pending_without_social_01'));
  assert.equal(result.status, 200);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id = 201`), 0, 'manual Pending approval must not use the automatic trigger');
  assert.equal(wakes.length, 0, 'approval without a durable publication must not wake Bluesky');

  insertStatusFixture(sqlite, 202, 'pending');
  const explicitKey = 'pending_with_social_001';
  result = await invokeStatus(env, statusRequest(202, 'approve', explicitKey, true));
  assert.equal(result.status, 200);
  assert.equal((sqlite.prepare(`SELECT publication_reason FROM media_bluesky_publications
    WHERE article_id = 202`).get() as { publication_reason: string }).publication_reason,
  'pending_approved');
  result = await invokeStatus(env, statusRequest(202, 'approve', explicitKey, true));
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, true);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id = 202`), 1, 'identical explicit retries must stay idempotent');

  insertStatusFixture(sqlite, 203, 'pending', false);
  assert.equal((await invokeStatus(env,
    statusRequest(203, 'approve', 'pending_no_thumbnail_01'))).status, 200);
  insertStatusFixture(sqlite, 204, 'pending', false);
  result = await invokeStatus(env, statusRequest(204, 'approve', 'pending_thumbnail_fail', true));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'thumbnail_missing');
  assert.equal((sqlite.prepare('SELECT status FROM media_articles WHERE id = 204').get() as
    { status: string }).status, 'pending');

  insertStatusFixture(sqlite, 205, 'rejected');
  assert.equal((await invokeStatus(env,
    statusRequest(205, 'approve', 'rejected_with_social_1', true))).status, 200);
  insertStatusFixture(sqlite, 206, 'hidden');
  assert.equal((await invokeStatus(env, new Request(
    'https://media.example/admin/articles/206/unhide', { method: 'POST', headers: {
      Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`, 'Content-Type': 'application/json',
      'Idempotency-Key': 'hidden_with_social_0001' },
    body: JSON.stringify({ post_to_bluesky: true }) }))).status, 200);

  insertStatusFixture(sqlite, 207, 'pending');
  insertStatusFixture(sqlite, 208, 'rejected');
  result = await invokeStatus(env, bulkRequest([208, 207], 'bulk_without_social_001'));
  assert.equal(result.status, 200);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id IN (207, 208)`), 0);

  insertStatusFixture(sqlite, 209, 'pending');
  insertStatusFixture(sqlite, 210, 'hidden');
  const bulkKey = 'bulk_with_social_00001';
  result = await invokeStatus(env, bulkRequest([209, 210], bulkKey, true));
  assert.equal(result.status, 200);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id IN (209, 210)`), 2);
  result = await invokeStatus(env, bulkRequest([210, 209], bulkKey, true));
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, true);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id IN (209, 210)`), 2);

  insertStatusFixture(sqlite, 211, 'pending');
  insertStatusFixture(sqlite, 212, 'pending', false);
  result = await invokeStatus(env, bulkRequest([211, 212], 'bulk_thumbnail_failure', true));
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.failures, [{ article_id: 212, error: 'thumbnail_missing' }]);
  assert.deepEqual(sqlite.prepare(`SELECT status FROM media_articles WHERE id IN (211, 212)
    ORDER BY id`).all().map(row => row.status), ['pending', 'pending'],
  'bulk social validation must fail before any approval');

  sqlite.prepare(`INSERT INTO media_bluesky_publications
    (article_id, publication_key, publication_reason, status, last_error_code, created_at, updated_at)
    VALUES (201, 'cancelled-audit-fixture', 'pending_approved', 'blocked',
      'operator_cancelled', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`).run();
  insertStatusFixture(sqlite, 213, 'pending');
  await invokeStatus(env, statusRequest(213, 'approve', 'unrelated_after_cancel_1'));
  const blocked = sqlite.prepare(`SELECT status, last_error_code FROM media_bluesky_publications
    WHERE publication_key = 'cancelled-audit-fixture'`).get() as
    { status: string; last_error_code: string };
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.last_error_code, 'operator_cancelled');

  // A newly inserted genuinely automatic approval still creates exactly one outbox row.
  const instant = '2026-09-17T12:00:00.000Z';
  sqlite.prepare(`INSERT INTO media_articles
    (id, source_key, canonical_url, canonical_url_hash, original_url, title, publisher,
     discovered_at, last_seen_at, status, review_level, approval_method, og_image_url,
     image_policy, approved_at, created_at, updated_at)
    VALUES (214, 'bluesky-race-fixture', 'https://fixture.example/auto-214', ?,
      'https://fixture.example/auto-214', 'Automatic fixture', 'Race fixture', ?, ?,
      'approved', 'standard', 'trusted_source_auto', 'https://fixture.example/auto.jpg',
      'remote_preview', ?, ?, ?)`).run('f'.repeat(64), instant, instant, instant, instant, instant);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id = 214 AND publication_reason = 'auto_approved'`), 1);
  sqlite.close();
}

async function checkThumbnailWaitingCorrection(): Promise<void> {
  const { sqlite, facade, env, wakes } = statusRaceDatabase('0034');
  const db = facade as unknown as D1Database;
  sqlite.exec('UPDATE media_bluesky_settings SET activation_event_id = 0, publishing_enabled = 1');
  insertStatusFixture(sqlite, 601, 'approved', false, 'trusted_source_auto');
  insertStatusFixture(sqlite, 602, 'approved', true, 'trusted_source_auto');
  const priorRows = sqlite.prepare('SELECT * FROM media_bluesky_publications ORDER BY id').all();
  const priorColumns = sqlite.prepare('PRAGMA table_info(media_bluesky_publications)').all();
  sqlite.exec(readFileSync('migrations/0035_bluesky_thumbnail_waiting.sql', 'utf8'));
  assert.deepEqual(sqlite.prepare('SELECT * FROM media_bluesky_publications ORDER BY id').all(), priorRows);
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(media_bluesky_publications)').all(), priorColumns);
  assert.equal(scalar(sqlite, 'SELECT count(*) AS value FROM media_bluesky_publications WHERE article_id = 601'), 0);

  insertStatusFixture(sqlite, 603, 'approved', false, 'trusted_source_auto');
  insertStatusFixture(sqlite, 604, 'approved', true, 'trusted_source_auto');
  const publication = (id: number) => sqlite.prepare(
    'SELECT * FROM media_bluesky_publications WHERE article_id = ?').get(id)!;
  const waiting = { ...publication(603) };
  assert.equal(waiting.status, 'blocked');
  assert.equal(waiting.last_error_code, 'thumbnail_pending');
  assert.equal(waiting.next_attempt_at, null);
  assert.equal(publication(604).status, 'queued');
  assert.equal(await releaseBlueskyThumbnailPending(db), 0);
  assert.equal(blueskyPublicationStatusLabel('blocked', 'thumbnail_pending'), 'Waiting for thumbnail');
  assert.equal(blueskyPublicationStatusLabel('blocked', 'operator_cancelled'), 'Cancelled');
  const detail = await invokeStatus(env, new Request('https://media.example/admin/articles/603', {
    headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
  }));
  const social = detail.body.bluesky as Record<string, unknown>;
  assert.equal(social.latest_status_label, 'Waiting for thumbnail');
  assert.equal(social.direct_publish_unavailable_reason, 'publication_in_progress');

  // Waiting intent takes precedence while the thumbnail is still absent, for
  // both direct publication endpoints and the manual approval endpoints.
  const noImageDirect = await invokeStatus(env,
    directRequest([603], 'waiting-direct-single-603', true, false));
  assert.equal(noImageDirect.status, 409);
  assert.equal(noImageDirect.body.error, 'publication_in_progress');
  const noImageBulkDirect = await invokeStatus(env,
    directRequest([603], 'waiting-direct-bulk-603', true, false, true));
  assert.equal(noImageBulkDirect.status, 409);
  assert.deepEqual(noImageBulkDirect.body.failures,
    [{ article_id: 603, platform: 'bluesky', error: 'publication_in_progress' }]);

  const manualCases = [
    { id: 607, status: 'pending', action: 'approve', publicationStatus: 'blocked' },
    { id: 608, status: 'rejected', action: 'approve', publicationStatus: 'queued' },
    { id: 609, status: 'hidden', action: 'unhide', publicationStatus: 'posting' },
  ] as const;
  for (const item of manualCases) {
    insertStatusFixture(sqlite, item.id, 'approved', false, 'trusted_source_auto');
    sqlite.prepare(`UPDATE media_articles SET status = ?, mutation_key = ?,
      revision = revision + 1 WHERE id = ?`).run(item.status, `fixture-state-${item.id}`, item.id);
    sqlite.prepare(`UPDATE media_bluesky_publications SET status = ?, last_error_code = ?
      WHERE article_id = ?`).run(item.publicationStatus,
      item.publicationStatus === 'blocked' ? 'thumbnail_pending' : null, item.id);
    const request = new Request(`https://media.example/admin/articles/${item.id}/${item.action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}`,
        'Content-Type': 'application/json', 'Idempotency-Key': `waiting-manual-${item.id}` },
      body: JSON.stringify({ post_to_bluesky: true }),
    });
    const result = await invokeStatus(env, request);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'publication_in_progress');
    assert.equal(sqlite.prepare('SELECT status FROM media_articles WHERE id = ?')
      .get(item.id)!.status, item.status);
  }
  const noImageBulkApproval = await invokeStatus(env,
    bulkRequest(manualCases.map(item => item.id), 'waiting-bulk-approval', true));
  assert.equal(noImageBulkApproval.status, 409);
  assert.deepEqual(noImageBulkApproval.body.failures, manualCases.map(item =>
    ({ article_id: item.id, error: 'publication_in_progress' })));

  // Later metadata does not manufacture a row for the historical missing decision.
  sqlite.exec(`UPDATE media_articles SET og_image_url = 'https://fixture.example/later.jpg'
    WHERE id IN (601, 603)`);
  const direct = await invokeStatus(env, directRequest([603], 'thumbnail-direct-603', true, false));
  assert.equal(direct.status, 409);
  assert.equal(direct.body.error, 'publication_in_progress');
  assert.throws(() => sqlite.prepare(`INSERT INTO media_bluesky_publications
    (article_id, publication_key, publication_reason, status, created_at, updated_at)
    VALUES (603, 'racing-manual', 'manual_post', 'queued', 'now', 'now')`).run(),
  /bluesky_publication_in_progress/);
  await reconcileBlueskyPublications(db, env.MEDIA_BLUESKY_QUEUE);
  const released = publication(603);
  assert.equal(released.status, 'queued');
  assert.equal(released.last_error_code, null);
  assert.equal(released.next_attempt_at, null);
  for (const field of ['id', 'article_id', 'approval_event_id', 'publication_key', 'created_at']) {
    assert.equal(released[field], waiting[field]);
  }
  assert.equal(await releaseBlueskyThumbnailPending(db), 0, 'recovery is idempotent');
  assert.equal(wakes.length, 1);
  assert.equal(scalar(sqlite, 'SELECT count(*) AS value FROM media_bluesky_publications WHERE article_id = 601'), 0);

  // Queue delivery failure leaves durable recovery intact for scheduler retry.
  sqlite.exec(`UPDATE media_bluesky_publications SET status = 'blocked',
    last_error_code = 'thumbnail_pending' WHERE article_id = 603`);
  await assert.rejects(reconcileBlueskyPublications(db, {
    async send() { throw new Error('fixture_queue_failure'); },
  }), /fixture_queue_failure/);
  assert.equal(publication(603).status, 'queued');

  // Process only the oldest row with lost image identity: no network/post call.
  sqlite.exec(`UPDATE media_articles SET og_image_url = NULL WHERE id = 602`);
  const wake = message();
  await consumeBluesky(wake.value, { ...env } as unknown as MediaDiscoveryEnv);
  assert.equal(wake.state.acked, true);
  assert.equal(publication(602).last_error_code, 'thumbnail_pending');
  assert.equal(publication(602).status, 'blocked');
  assert.equal(publication(602).next_attempt_at, null);

  sqlite.exec(`UPDATE media_bluesky_publications SET status = 'blocked',
    last_error_code = 'operator_cancelled' WHERE article_id = 604`);
  await releaseBlueskyThumbnailPending(db);
  assert.equal(publication(604).last_error_code, 'operator_cancelled');
  assert.equal(publication(604).status, 'blocked');

  // Local-copy readiness still uses the existing matched policy pair; recovery
  // never requires or authorises a publisher-image copy by itself.
  sqlite.exec(`UPDATE media_sources SET image_policy = 'local_copy_permitted'
    WHERE source_key = 'bluesky-race-fixture'`);
  insertStatusFixture(sqlite, 605, 'approved', true, 'trusted_source_auto');
  assert.equal(publication(605).last_error_code, 'thumbnail_pending');
  sqlite.exec("UPDATE media_articles SET image_policy = 'local_copy_permitted' WHERE id = 605");
  assert.equal(await releaseBlueskyThumbnailPending(db), 1);
  assert.equal(publication(605).status, 'queued');

  sqlite.exec('UPDATE media_bluesky_settings SET activation_event_id = NULL');
  insertStatusFixture(sqlite, 606, 'approved', false, 'trusted_source_auto');
  assert.equal(scalar(sqlite, 'SELECT count(*) AS value FROM media_bluesky_publications WHERE article_id = 606'), 0);

  // An actual posted automatic intent permits a deliberate repost, and the
  // no-social approval path still ignores in-progress social intent.
  sqlite.exec(`UPDATE media_sources SET image_policy = 'remote_preview'
    WHERE source_key = 'bluesky-race-fixture';
    UPDATE media_bluesky_publications SET status = 'posted', last_error_code = NULL,
      post_uri = 'at://did:plc:fixture/app.bsky.feed.post/603', post_cid = 'cid-603',
      posted_at = '2026-10-05T12:00:00.000Z' WHERE article_id = 603`);
  const repost = await invokeStatus(env,
    directRequest([603], 'posted-auto-repost-603', true, false));
  assert.equal(repost.status, 200);
  assert.equal((repost.body.bluesky_publication as { publication_reason: string })
    .publication_reason, 'manual_repost');
  assert.equal((await invokeStatus(env,
    bulkRequest([607, 608, 609], 'waiting-approval-no-social', false))).status, 200);
  assert.equal(scalar(sqlite, `SELECT count(*) AS value FROM media_bluesky_publications
    WHERE article_id IN (607, 608, 609)`), 3);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  sqlite.close();
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
  checkPopulatedManualPublishMigration();
  checkFacebookAutomaticMigration();
  await checkFacebookAutomaticContract();
  await checkManualApprovalContract();
  await checkConcurrentAdminIdempotency();
  await checkDirectPublishContract();
  await checkThumbnailWaitingCorrection();

  const publisherSource = readFileSync('apps/media-discovery/src/bluesky.ts', 'utf8');
  assert.match(publisherSource,
    /renderBlueskyPost\(\{ title: article\.title,/,
    'the publication path must render the stored original publisher title');
  assert.match(publisherSource,
    /createOrReadPost\(auth, recordKey, \{[\s\S]*?\$type: 'app\.bsky\.feed\.post',[\s\S]*?langs: \['en-GB'\],/u,
    'new Bluesky post records must declare exactly UK English language metadata');

  assert.deepEqual(externalCardText('Stored publisher title', {
    ogImage: null, twitterImage: null, ogTitle: 'Open Graph title',
    twitterTitle: 'Twitter title', htmlTitle: 'HTML title',
    ogDescription: 'Open Graph description', twitterDescription: 'Twitter description',
    htmlDescription: 'HTML description', publisher: null, author: null, publishedAt: null,
  }), { title: 'Open Graph title', description: 'Open Graph description' });
  assert.deepEqual(externalCardText('Stored publisher title', {
    ogImage: null, twitterImage: null, ogTitle: null,
    twitterTitle: 'Twitter title', htmlTitle: 'HTML title',
    ogDescription: null, twitterDescription: null,
    htmlDescription: 'HTML description', publisher: null, author: null, publishedAt: null,
  }), { title: 'Twitter title', description: 'HTML description' });
  assert.deepEqual(externalCardText('Stored publisher title'),
    { title: 'Stored publisher title', description: '' });

  assert.deepEqual(thumbnailFetchDiagnostic('redirect', null),
    { code: 'thumbnail_redirect_rejected', transient: false });
  assert.deepEqual(thumbnailFetchDiagnostic('timeout', null),
    { code: 'thumbnail_timeout', transient: true });
  assert.deepEqual(thumbnailFetchDiagnostic('failed', null),
    { code: 'thumbnail_network_failed', transient: true });
  assert.deepEqual(thumbnailFetchDiagnostic(null, 403),
    { code: 'thumbnail_http_403', transient: true });
  assert.deepEqual(thumbnailFetchDiagnostic(null, 429),
    { code: 'thumbnail_http_429', transient: true });
  assert.deepEqual(thumbnailFetchDiagnostic(null, 503),
    { code: 'thumbnail_http_503', transient: true });
  assert.equal(thumbnailFetchDiagnostic(null, null), null);

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
    'Air quality title\nFrom Literal {publisher_mention} Publisher @publisher.example',
  'publisher text must not be reinterpreted as a template token');
  assert.equal(injected.facets.filter(facet => facet.features[0]?.$type ===
    'app.bsky.richtext.facet#mention').length, 1);

  const noMention = renderBlueskyPost({
    title: 'Air quality title', publisher: 'Publisher',
    template: 'From {publisher_mention} {publisher}', publisherMention: null,
  });
  assert.equal(noMention.text, 'Air quality title\nFrom Publisher',
    'an empty optional mention must not leave doubled whitespace');

  const byteHeavy = renderBlueskyPost({
    title: '👨‍👩‍👧‍👦'.repeat(200), publisher: 'Publisher',
    template: 'From {publisher}', publisherMention: null,
  });
  assert.ok(new TextEncoder().encode(byteHeavy.text).byteLength <= BLUESKY_POST_BYTES,
    'the rendered post must satisfy the provider byte limit');
  assert.ok(graphemes(byteHeavy.text).length <= 300,
    'the rendered post must satisfy the provider grapheme limit');
  assert.ok(byteHeavy.text.split('\n', 1)[0]?.endsWith('…'),
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
