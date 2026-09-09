import { z, initialEditorialState, loadSource, type Source, type DiscoveredArticle } from '@uk-aq-media/core';
import { discoverAqn, discoverAqnPreviewMetadata, ScanError } from './aqn';

export const DiscoveryMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('source_scan'), source_key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('article_enrich'), article_id: z.number().int().positive() }).strict(),
]);
export type DiscoveryMessage = z.infer<typeof DiscoveryMessageSchema>;
export { parseAqnFeed } from './aqn';

function persistArticle(db: D1Database, source: Source, article: DiscoveredArticle,
  now: string): D1PreparedStatement {
  const editorial = initialEditorialState(source);
  // Conflict updates preserve editorial state/provenance and non-null image/title choices;
  // only observation timestamps and previously absent preview metadata may be filled.
  return db.prepare(`INSERT INTO media_articles (source_key, canonical_url, canonical_url_hash,
    original_url, title, publisher, author, published_at, discovered_at, last_seen_at,
    topics_json, status, review_level, approval_method, og_image_url, image_policy,
    display_title, display_title_origin, preview_metadata_checked_at,
    approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_url_hash) DO UPDATE SET
      last_seen_at = max(media_articles.last_seen_at, excluded.last_seen_at),
      updated_at = max(media_articles.updated_at, excluded.updated_at),
      og_image_url = CASE
        WHEN media_articles.og_image_url IS NULL AND media_articles.image_policy = 'remote_preview'
          THEN excluded.og_image_url ELSE media_articles.og_image_url END,
      display_title = coalesce(media_articles.display_title, excluded.display_title),
      display_title_origin = CASE
        WHEN media_articles.display_title IS NULL AND excluded.display_title IS NOT NULL
          THEN excluded.display_title_origin ELSE media_articles.display_title_origin END,
      preview_metadata_checked_at = coalesce(media_articles.preview_metadata_checked_at,
        excluded.preview_metadata_checked_at)
    RETURNING id, revision`).bind(source.source_key, article.canonical_url,
      article.canonical_url_hash, article.original_url, article.title, source.name, article.author,
      article.published_at, now, now, JSON.stringify(article.categories), editorial.status,
      source.review_level, editorial.approval_method, article.preview_url, source.image_policy,
      article.display_title, article.display_title_origin, article.preview_metadata_checked_at,
      editorial.status === 'approved' ? now : null, now, now);
}

type ExistingPreviewState = {
  canonical_url_hash: string;
  og_image_url: string | null;
  image_policy: string;
  preview_metadata_checked_at: string | null;
};

async function fillAqnPreviewMetadata(db: D1Database, source: Source,
  articles: DiscoveredArticle[]): Promise<void> {
  if (source.content_fetch_policy !== 'article_head_allowed' ||
      source.image_policy !== 'remote_preview' || articles.length === 0) return;
  const placeholders = articles.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT canonical_url_hash, og_image_url, image_policy,
    preview_metadata_checked_at FROM media_articles WHERE canonical_url_hash IN (${placeholders})`)
    .bind(...articles.map(article => article.canonical_url_hash)).all<ExistingPreviewState>();
  const existing = new Map(results.map(row => [row.canonical_url_hash, row]));
  for (const article of articles) {
    const state = existing.get(article.canonical_url_hash);
    const hasPreview = article.preview_url !== null || state?.og_image_url !== null &&
      state?.og_image_url !== undefined;
    const articleAllowsPreview = !state || state.image_policy === 'remote_preview';
    if (hasPreview || !articleAllowsPreview || state?.preview_metadata_checked_at) continue;
    try {
      Object.assign(article, await discoverAqnPreviewMetadata(article, source));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'aqn_article_head_metadata_failed',
        article_hash: article.canonical_url_hash,
        error_code: error instanceof ScanError ? error.code : 'article_head_failed',
      }));
    }
  }
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
    const unique = new Map(result.articles.map(article => [article.canonical_url_hash, article]));
    await fillAqnPreviewMetadata(db, source, [...unique.values()]);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    // Deduplicate within this response too. Each item contributes at most two statements;
    // with <=20 entries the complete scan stays below the Free D1 query boundary.
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
