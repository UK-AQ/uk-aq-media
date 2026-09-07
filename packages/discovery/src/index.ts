import { z, initialEditorialState, loadSource, type Source, type DiscoveredArticle } from '@uk-aq-media/core';
import { discoverAqn, ScanError } from './aqn';

export const DiscoveryMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('source_scan'), source_key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('article_enrich'), article_id: z.number().int().positive() }).strict(),
]);
export type DiscoveryMessage = z.infer<typeof DiscoveryMessageSchema>;
export { parseAqnFeed } from './aqn';

function persistArticle(db: D1Database, source: Source, article: DiscoveredArticle,
  now: string): D1PreparedStatement {
  const editorial = initialEditorialState(source);
  // Conflict updates intentionally touch observation timestamps only, preserving editorial state,
  // provenance and image blocks. The creation trigger writes exactly one initial event.
  return db.prepare(`INSERT INTO media_articles (source_key, canonical_url, canonical_url_hash,
    original_url, title, publisher, author, published_at, discovered_at, last_seen_at,
    topics_json, status, review_level, approval_method, og_image_url, image_policy,
    approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_url_hash) DO UPDATE SET
      last_seen_at = max(media_articles.last_seen_at, excluded.last_seen_at),
      updated_at = max(media_articles.updated_at, excluded.updated_at)
    RETURNING id, revision`).bind(source.source_key, article.canonical_url,
      article.canonical_url_hash, article.original_url, article.title, source.name, article.author,
      article.published_at, now, now, JSON.stringify(article.categories), editorial.status,
      source.review_level, editorial.approval_method, article.preview_url, source.image_policy,
      editorial.status === 'approved' ? now : null, now, now);
}

export async function runSourceScan(db: D1Database, sourceKey: string,
  messageId: string, attempt: number): Promise<void> {
  const runId = crypto.randomUUID();
  const started = new Date().toISOString();
  // Resolve the FK inside SQL, so malformed/unknown source messages can still have diagnostics.
  await db.prepare(`INSERT INTO media_discovery_runs
    (id, source_key, queue_message_id, attempt, started_at, status, updated_at)
    VALUES (?, (SELECT source_key FROM media_sources WHERE source_key = ?), ?, ?, ?, 'running', ?)`)
    .bind(runId, sourceKey, messageId, attempt, started, started).run();
  let seen = 0;
  let invalid = 0;
  try {
    const source = await loadSource(db, sourceKey);
    if (!source || !source.enabled || sourceKey !== 'air-quality-news') {
      await finishRun(db, runId, 'skipped', 0, 0, source ? 'source_disabled_or_deferred' : 'unknown_source');
      return;
    }
    const result = await discoverAqn(source);
    seen = result.items_seen;
    invalid = result.items_invalid;
    if (seen > 0 && result.articles.length === 0) throw new ScanError('no_valid_feed_entries');
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    // Deduplicate within this response too. Each item contributes at most two statements;
    // with <=20 entries the complete scan stays below the Free D1 query boundary.
    const unique = new Map(result.articles.map(article => [article.canonical_url_hash, article]));
    for (const article of unique.values()) {
      statements.push(db.prepare(`UPDATE media_discovery_runs SET
        items_inserted = items_inserted + CASE WHEN EXISTS
          (SELECT 1 FROM media_articles WHERE canonical_url_hash = ?) THEN 0 ELSE 1 END,
        items_updated = items_updated + CASE WHEN EXISTS
          (SELECT 1 FROM media_articles WHERE canonical_url_hash = ?) THEN 1 ELSE 0 END
        WHERE id = ?`).bind(article.canonical_url_hash, article.canonical_url_hash, runId));
      statements.push(persistArticle(db, source, article, now));
    }
    statements.push(db.prepare(`UPDATE media_discovery_runs SET status = 'succeeded',
      finished_at = ?, updated_at = ?, items_seen = ?, items_invalid = ? WHERE id = ?`)
      .bind(now, now, seen, invalid, runId));
    // D1 batch is atomic: articles, trigger events and successful run evidence commit together.
    await db.batch(statements);
  } catch (error) {
    const code = error instanceof ScanError ? error.code : 'source_scan_failed';
    try { await finishRun(db, runId, 'failed', seen, invalid, code); }
    catch { console.error(JSON.stringify({ event: 'run_evidence_unavailable', run_id: runId })); }
    throw error;
  }
}

async function finishRun(db: D1Database, id: string, status: 'failed' | 'skipped',
  seen: number, invalid: number, code: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE media_discovery_runs SET status = ?, finished_at = ?, updated_at = ?,
    items_seen = ?, items_invalid = ?, error_code = ? WHERE id = ?`)
    .bind(status, now, now, seen, invalid, code, id).run();
}

/** Best-effort bounded evidence for enqueue/unsupported-work failures. D1 outages can only log. */
export async function recordQueueFailure(db: D1Database, code: string,
  messageId: string | null = null, attempt = 1): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO media_discovery_runs
      (id, queue_message_id, attempt, started_at, finished_at, status, error_code, updated_at)
      VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`).bind(crypto.randomUUID(), messageId,
        attempt, now, now, code.slice(0, 100), now).run();
  } catch {
    console.error(JSON.stringify({ event: 'queue_evidence_unavailable' }));
  }
}
