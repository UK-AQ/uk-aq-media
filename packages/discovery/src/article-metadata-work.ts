import {
  indexSyndicationHashes, loadSource, publisherAdmissionSql, reconcileHomepageLatestSix,
  type DiscoveredArticle,
} from '@uk-aq-media/core';
import { normaliseMetadataText } from './article-head-metadata';
import {
  hostnamePublisherLabel, normalisePublisherHeadline, permitsPublisherHtml,
  publisherMetadataFailure, resolvePublisherMetadata, type PublisherMetadata,
  verifiedPublisherHeadline,
} from './publisher-metadata';

export type MetadataOutcome = 'complete' | 'partial' | 'unavailable' | 'disallowed' | 'transient';
type WorkSeed = {
  hash: string;
  status: 'pending' | MetadataOutcome;
  fresh?: boolean;
  force?: boolean;
};

export const metadataEditProtectedSql = (articleId: string,
  field: 'original-title' | 'author' | 'published-at'): string => `EXISTS (
    SELECT 1 FROM media_article_events edit
    WHERE edit.article_id = ${articleId} AND edit.event_type = 'edited'
      AND edit.actor_type = 'admin' AND (edit.event_key GLOB 'admin:${field}:*'
        ${field === 'original-title' ? `OR (edit.event_key GLOB 'admin:metadata:*'
          AND json_extract(edit.metadata_json, '$.before.title') IS NOT
            json_extract(edit.metadata_json, '$.after.title'))` : ''})
  )`;

const RETRY_MINUTES = [15, 120, 720];
const DEFAULT_DISPATCH_LIMIT = 16;
const MAX_DISPATCH_LIMIT = 32;

export function metadataDispatchLimit(configured: string | number | undefined): number {
  if (configured === undefined || configured === '') return DEFAULT_DISPATCH_LIMIT;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DISPATCH_LIMIT) {
    throw new Error('invalid_media_metadata_dispatch_limit');
  }
  return value;
}
const LEASE_MS = 5 * 60_000;

function nextRetry(attempt: number, now: number): string | null {
  const delay = RETRY_MINUTES[attempt - 1];
  return delay === undefined ? null : new Date(now + delay * 60_000).toISOString();
}

export function observedMetadataOutcome(existing: Pick<DiscoveredArticle, 'author' | 'published_at' | 'preview_url'>,
  metadata: PublisherMetadata): MetadataOutcome {
  if (existing.author && existing.published_at && existing.preview_url) return 'complete';
  if (metadata.partial_failure) return 'transient';
  return existing.author || existing.published_at || existing.preview_url || metadata.explicit_headline ? 'partial' : 'unavailable';
}

export function seedArticleMetadataWork(db: D1Database, rows: WorkSeed[], now: string,
  publishedByGdelt = false): D1PreparedStatement {
  return db.prepare(`INSERT INTO media_article_metadata_work
    (article_id, status, attempts, next_at, normalise_new_title, checked_at)
    SELECT a.id, json_extract(seed.value, '$.status'),
      CASE json_extract(seed.value, '$.status') WHEN 'pending' THEN 0 ELSE 1 END,
      CASE json_extract(seed.value, '$.status') WHEN 'pending' THEN ?
        WHEN 'transient' THEN ? ELSE NULL END,
      CASE WHEN json_extract(seed.value, '$.fresh') = 1 AND a.created_at = ? THEN 1 ELSE 0 END,
      CASE json_extract(seed.value, '$.status') WHEN 'pending' THEN NULL ELSE ? END
    FROM json_each(?) seed JOIN media_articles a ON a.canonical_url_hash = json_extract(seed.value, '$.hash')
    WHERE (a.author IS NULL OR a.published_at IS NULL OR a.og_image_url IS NULL
      OR json_extract(seed.value, '$.force') = 1 OR json_extract(seed.value, '$.fresh') = 1)
      AND (? = 0 OR EXISTS (SELECT 1 FROM media_article_discovery_evidence e
        WHERE e.article_id = a.id AND e.provider_key = 'gdelt'))
    ON CONFLICT(article_id) DO NOTHING`)
    .bind(now, nextRetry(1, Date.parse(now)), now, now, JSON.stringify(rows), Number(publishedByGdelt));
}

export async function scheduleArticleMetadata(db: D1Database, queue: Queue<unknown>,
  configuredLimit?: string | number): Promise<void> {
  const limit = metadataDispatchLimit(configuredLimit);
  const { results } = await db.prepare(`SELECT article_id FROM media_article_metadata_work
    WHERE next_at <= ? ORDER BY next_at, article_id LIMIT ?`)
    .bind(new Date().toISOString(), limit).all<{ article_id: number }>();
  if (results.length) await queue.sendBatch(results.map(row => ({
    body: { type: 'article_enrich', article_id: row.article_id },
  })));
}

type Article = {
  id: number; revision: number; source_key: string; canonical_url: string; canonical_url_hash: string;
  original_url: string; image_policy: string; title: string; publisher: string; author: string | null;
  published_at: string | null; og_image_url: string | null; display_title: string | null;
  protection_title: number; protection_author: number; protection_date: number;
  gdelt_title: string | null;
};

async function finishReconciliation(db: D1Database, row: Article, token: string,
  nextAt: string | null): Promise<void> {
  if (!await indexSyndicationHashes(db, [row.canonical_url_hash])) throw new Error('metadata_syndication_failed');
  await reconcileHomepageLatestSix(db);
  await db.prepare(`UPDATE media_article_metadata_work SET
    lease_token = NULL, next_at = ?, reconcile_pending = 0
    WHERE article_id = ? AND lease_token = ? AND reconcile_pending = 1`)
    .bind(nextAt, row.id, token).run();
}

export async function enrichPersistedArticle(db: D1Database, articleId: number): Promise<void> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const claimed = await db.prepare(`UPDATE media_article_metadata_work
    SET lease_token = ?, next_at = ?,
      attempts = attempts + (reconcile_pending = 0)
    WHERE article_id = ? AND next_at <= ?
    RETURNING status, attempts, normalise_new_title, reconcile_pending, checked_at`)
    .bind(token, new Date(now + LEASE_MS).toISOString(), articleId, at)
    .first<{ status: MetadataOutcome | 'pending'; attempts: number; normalise_new_title: number;
      reconcile_pending: number; checked_at: string | null }>();
  if (!claimed) return;

  const finish = async (status: MetadataOutcome, recheckAt: string | null = null) => {
    await db.prepare(`UPDATE media_article_metadata_work SET status = ?, checked_at = ?,
      next_at = ?, lease_token = NULL WHERE article_id = ? AND lease_token = ?`)
      .bind(status, at, recheckAt, articleId, token).run();
  };
  const row = await db.prepare(`SELECT a.id, a.revision, a.source_key, a.canonical_url,
    a.canonical_url_hash, a.original_url, a.image_policy, a.title, a.publisher, a.author,
    a.published_at, a.og_image_url, a.display_title,
    ${metadataEditProtectedSql('a.id', 'original-title')} AS protection_title,
    ${metadataEditProtectedSql('a.id', 'author')} AS protection_author,
    ${metadataEditProtectedSql('a.id', 'published-at')} AS protection_date,
    CASE WHEN ? THEN (SELECT c.title FROM media_gdelt_candidates c
      WHERE c.canonical_url_hash = a.canonical_url_hash) END AS gdelt_title
    FROM media_articles a WHERE a.id = ?`).bind(claimed.normalise_new_title, articleId).first<Article>();
  if (!row) return;
  if (claimed.reconcile_pending) {
    const retryAt = claimed.status === 'transient' && claimed.checked_at
      ? nextRetry(claimed.attempts, Date.parse(claimed.checked_at)) : null;
    await finishReconciliation(db, row, token, retryAt);
    return;
  }

  const source = await loadSource(db, row.source_key);
  // Dynamic GDELT definitions are disabled for discovery by design, but carry
  // an explicit bounded preview capability for persisted promoted articles.
  if (!source || !source.enabled && !source.source_key.startsWith('discovered-publisher-') ||
      row.image_policy !== 'remote_preview' || source.image_policy !== 'remote_preview' ||
      !permitsPublisherHtml(source) && source.source_key !== 'openaq') {
    await finish('disallowed');
    return;
  }
  const allowNewTitle = Boolean(claimed.normalise_new_title && !row.protection_title);
  const needsPublisher = hostnamePublisherLabel(row.publisher) || !row.publisher.trim();
  if (!allowNewTitle && !needsPublisher && (row.author || row.protection_author) &&
      (row.published_at || row.protection_date) && row.og_image_url) {
    await finish('complete');
    return;
  }
  const targets = [row.canonical_url, row.original_url];
  let metadata: PublisherMetadata;
  try {
    // Recheck both stored URLs and every publisher-visible request target.
    const original = await db.prepare(`SELECT ${publisherAdmissionSql(targets)} AS allowed`)
      .first<{ allowed: number }>();
    if (!original?.allowed) { await finish('disallowed'); return; }
    metadata = await resolvePublisherMetadata(db, row.id, row, source, {
      title: row.title, author: row.author, published_at: row.published_at,
      image_url: row.og_image_url, display_title: row.display_title, fresh: allowNewTitle,
    }, url => targets.push(url));
  } catch (error) {
    const status = publisherMetadataFailure(error);
    await finish(status, status === 'transient' ? nextRetry(claimed.attempts, now) : null);
    return;
  }

  const rawTitle = row.gdelt_title;
  const matchesPromotion = rawTitle && (normaliseMetadataText(rawTitle) === row.title ||
    normalisePublisherHeadline(rawTitle, metadata.publisher) === row.title);
  // Configured attribution can clean the TOC title at promotion. Restore the
  // exact raw headline only if explicit first-party markup proves it genuine.
  const title = allowNewTitle
    ? verifiedPublisherHeadline(matchesPromotion ? rawTitle : row.title,
      metadata.publisher, metadata.explicit_headline) : row.title;
  const publisher = needsPublisher && metadata.publisher ? metadata.publisher : row.publisher;
  const author = row.author ?? (row.protection_author ? null : metadata.author);
  const publishedAt = row.published_at ?? (row.protection_date ? null : metadata.published_at);
  const image = row.og_image_url ?? metadata.image_url;
  const compact = row.display_title ?? metadata.compact_title;
  const outcome = observedMetadataOutcome({ author, published_at: publishedAt, preview_url: image }, metadata);
  const retryAt = outcome === 'transient' ? nextRetry(claimed.attempts, now) : null;
  if (title === row.title && publisher === row.publisher && author === row.author &&
      publishedAt === row.published_at && image === row.og_image_url && compact === row.display_title) {
    await finish(outcome, retryAt);
    return;
  }
  const [changed] = await db.batch([
    db.prepare(`UPDATE media_articles SET title = ?, publisher = ?, author = ?, published_at = ?,
      og_image_url = ?, display_title = ?, display_title_origin = CASE
        WHEN display_title IS NULL AND ? IS NOT NULL THEN 'publisher' ELSE display_title_origin END,
      preview_metadata_checked_at = CASE WHEN og_image_url IS NULL AND ? IS NOT NULL THEN ?
        ELSE preview_metadata_checked_at END,
      updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND source_key = ? AND image_policy = 'remote_preview'
        AND title IS ? AND publisher IS ? AND author IS ? AND published_at IS ?
        AND og_image_url IS ? AND display_title IS ?
        AND EXISTS (SELECT 1 FROM media_sources s WHERE s.source_key = media_articles.source_key
          AND s.retired_at IS NULL AND s.image_policy = 'remote_preview' AND s.name = ?
          AND s.canonical_domain = ? AND (s.enabled = 1
            OR s.source_key GLOB 'discovered-publisher-*'))
        AND EXISTS (SELECT 1 FROM media_article_metadata_work w WHERE w.article_id = media_articles.id
          AND w.lease_token = ?)
        AND ${publisherAdmissionSql(targets)} RETURNING id`)
      .bind(title, publisher, author, publishedAt, image, compact, compact, image, at, at,
        row.id, row.revision, row.source_key, row.title, row.publisher, row.author, row.published_at,
        row.og_image_url, row.display_title, source.name, source.canonical_domain, token),
    db.prepare(`UPDATE media_article_metadata_work SET status = ?, reconcile_pending = 1, checked_at = ?
      WHERE article_id = ? AND lease_token = ? AND changes() = 1`)
      .bind(outcome, at, row.id, token),
  ]);
  if (changed?.results.length) {
    await finishReconciliation(db, row, token, retryAt);
  } else {
    // A concurrent metadata or permission edit won. Re-evaluate on a later lease.
    await finish('transient', nextRetry(claimed.attempts, now));
  }
}
