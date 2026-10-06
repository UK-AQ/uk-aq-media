import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AuthorRule, DiscoveredArticle, Source } from '@uk-aq-media/core';
import {
  persistArticle, persistPossibleDuplicateHold, POSSIBLE_DUPLICATE_REASON,
} from '../packages/discovery/src/persistence';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private parameters: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.parameters = values as SqlValue[];
    return this as unknown as D1PreparedStatement;
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
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database.prepare(sql)) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = (statements as unknown as SqliteD1Statement[])
        .map(statement => statement.runSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  for (const filename of readdirSync('migrations')
    .filter(value => /^\d+.*\.sql$/u.test(value)).sort()) {
    database.exec(readFileSync(`migrations/${filename}`, 'utf8'));
  }
}

const source: Source = {
  source_key: 'air-quality-news',
  name: 'Air Quality News',
  canonical_domain: 'airqualitynews.com',
  source_type: 'publisher',
  enabled: true,
  publication_policy: 'auto_approve',
  review_level: 'standard',
  priority: 100,
  discovery_method: 'rss',
  discovery_config: { url: 'https://airqualitynews.com/feed/', max_items: 20,
    retain_excerpt: false },
  content_fetch_policy: 'article_head_allowed',
  ai_content_policy: 'disabled',
  image_policy: 'remote_preview',
  search_index_policy: 'metadata_only',
};

const authorRule: AuthorRule = {
  author_key: 'air-quality-news:trusted-author',
  source_key: source.source_key,
  display_name: 'Paul Day',
  profile_url: 'https://airqualitynews.com/author/paul-day/',
  profile_rss_url: null,
  profile_rss_route_key: null,
  inclusion_policy: 'normal',
  publication_policy: 'auto_approve',
  enabled: true,
  byline_aliases: ['Paul Day'],
};

const article = (suffix: string, hashCharacter: string, author: string | null,
  publishedAt = '2026-10-05T23:10:00.000Z'): DiscoveredArticle => ({
  canonical_url: `https://airqualitynews.com/${suffix}/same-story/`,
  canonical_url_hash: hashCharacter.repeat(64),
  original_url: `https://airqualitynews.com/${suffix}/same-story/`,
  title: "World's most polluted countries miss out on air quality funding",
  author,
  published_at: publishedAt,
  categories: [],
  title_context: null,
  preview_url: null,
  display_title: null,
  display_title_origin: null,
  preview_metadata_checked_at: null,
});

async function observe(db: SqliteD1, discovered: DiscoveredArticle,
  rules: AuthorRule[], now: string, isNewIdentity: boolean,
  approvalObservationKey: string | null = null): Promise<void> {
  const statements = [persistArticle(db as unknown as D1Database, source, discovered,
    rules, approvalObservationKey, now, isNewIdentity)];
  const hold = persistPossibleDuplicateHold(db as unknown as D1Database, source,
    discovered, rules, now, isNewIdentity);
  if (hold) statements.push(hold);
  await db.batch(statements);
}

const database = new DatabaseSync(':memory:');
applyMigrations(database);
database.prepare(`UPDATE media_sources SET enabled = 1, publication_policy = ?,
  review_level = ?, updated_at = ? WHERE source_key = ?`).run(
  source.publication_policy, source.review_level, '2026-10-06T07:59:00.000Z', source.source_key,
);
database.prepare(`INSERT INTO media_author_rules
  (author_key, source_key, display_name, profile_url, profile_rss_url,
   profile_rss_route_key, inclusion_policy, publication_policy, enabled,
   byline_aliases_json) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?)`)
  .run(authorRule.author_key, authorRule.source_key, authorRule.display_name,
    authorRule.profile_url, authorRule.inclusion_policy, authorRule.publication_policy,
    JSON.stringify(authorRule.byline_aliases));
const db = new SqliteD1(database);

const original = article('legislation', 'a', 'Paul Day', '2026-10-06T00:10:00.000+01:00');
const held = article('health', 'b', 'Paul Day');
await observe(db, original, [], '2026-10-06T08:00:00.000Z', true);
await observe(db, held, [], '2026-10-06T08:01:00.000Z', true);

const heldState = database.prepare(`SELECT a.status, a.approval_method,
  a.approval_author_rule_key, a.approved_at, duplicate.candidate_article_id,
  duplicate.reason_code, duplicate.resolved_at
  FROM media_articles a JOIN media_article_possible_duplicates duplicate
    ON duplicate.article_id = a.id WHERE a.canonical_url_hash = ?`).get(held.canonical_url_hash);
assert.deepEqual({ ...heldState }, {
  status: 'pending', approval_method: null, approval_author_rule_key: null,
  approved_at: null, candidate_article_id: 1,
  reason_code: POSSIBLE_DUPLICATE_REASON, resolved_at: null,
});
assert.deepEqual(database.prepare(`SELECT event_type FROM media_article_events
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .all(held.canonical_url_hash).map(row => ({ ...row })), [{ event_type: 'discovered' }]);

const differentAuthor = article('analysis', 'c', 'Another Author');
await observe(db, differentAuthor, [], '2026-10-06T08:02:00.000Z', true);
assert.deepEqual({ ...database.prepare(`SELECT status, approval_method FROM media_articles
  WHERE canonical_url_hash = ?`).get(differentAuthor.canonical_url_hash) },
{ status: 'approved', approval_method: 'trusted_source_auto' });
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_article_possible_duplicates
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .get(differentAuthor.canonical_url_hash)?.count, 0);

await observe(db, held, [], '2026-10-06T08:02:30.000Z', false);
assert.equal(database.prepare(`SELECT status FROM media_articles
  WHERE canonical_url_hash = ?`).get(held.canonical_url_hash)?.status, 'pending');
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_article_events
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)
    AND event_type = 'auto_approved'`).get(held.canonical_url_hash)?.count, 0);

await observe(db, held, [authorRule], '2026-10-06T08:03:00.000Z', false,
  `author-auto:rediscovery:${held.canonical_url_hash}`);
assert.deepEqual({ ...database.prepare(`SELECT status, approval_method,
  approval_author_rule_key, approved_at, revision FROM media_articles
  WHERE canonical_url_hash = ?`).get(held.canonical_url_hash) }, {
  status: 'pending', approval_method: null, approval_author_rule_key: null,
  approved_at: null, revision: 0,
});
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_article_events
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)
    AND event_type = 'auto_approved'`).get(held.canonical_url_hash)?.count, 0);
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_bluesky_publications
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .get(held.canonical_url_hash)?.count, 0);
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_facebook_publications
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .get(held.canonical_url_hash)?.count, 0);

const sameBatchFirst = article('first-batch-url', 'd', 'Batch Author',
  '2026-10-06T09:00:00.000Z');
const sameBatchSecond = article('second-batch-url', 'e', 'Batch Author',
  '2026-10-06T09:00:00.000Z');
const batchNow = '2026-10-06T09:01:00.000Z';
const sameBatchStatements: D1PreparedStatement[] = [];
for (const discovered of [sameBatchFirst, sameBatchSecond]) {
  sameBatchStatements.push(persistArticle(db as unknown as D1Database, source,
    discovered, [], null, batchNow, true));
  const hold = persistPossibleDuplicateHold(db as unknown as D1Database, source,
    discovered, [], batchNow, true);
  if (hold) sameBatchStatements.push(hold);
}
await db.batch(sameBatchStatements);
assert.deepEqual(database.prepare(`SELECT canonical_url_hash, status FROM media_articles
  WHERE canonical_url_hash IN (?, ?) ORDER BY id`).all(
  sameBatchFirst.canonical_url_hash, sameBatchSecond.canonical_url_hash)
  .map(row => ({ ...row })), [
  { canonical_url_hash: sameBatchFirst.canonical_url_hash, status: 'approved' },
  { canonical_url_hash: sameBatchSecond.canonical_url_hash, status: 'pending' },
]);
assert.equal(database.prepare(`SELECT count(*) AS count FROM media_article_possible_duplicates
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .get(sameBatchSecond.canonical_url_hash)?.count, 1);

database.prepare(`UPDATE media_articles SET status = 'approved', approval_method = 'manual',
  approved_at = ?, revision = revision + 1, mutation_key = ?, updated_at = ?
  WHERE canonical_url_hash = ? AND status = 'pending'`).run(
  '2026-10-06T10:00:00.000Z', 'admin:test-resolution',
  '2026-10-06T10:00:00.000Z', held.canonical_url_hash,
);
assert.deepEqual({ ...database.prepare(`SELECT resolved_at, resolution
  FROM media_article_possible_duplicates WHERE article_id =
    (SELECT id FROM media_articles WHERE canonical_url_hash = ?)`)
  .get(held.canonical_url_hash) }, {
  resolved_at: '2026-10-06T10:00:00.000Z', resolution: 'approved',
});
assert.equal(database.prepare(`SELECT event_type FROM media_article_events
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)
  ORDER BY id DESC LIMIT 1`).get(held.canonical_url_hash)?.event_type, 'approved');

database.close();
console.log('possible duplicate safety-hold checks passed');
