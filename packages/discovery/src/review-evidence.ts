import { reviewHeadlineClass, publisherAdmissionSql, type DiscoveredArticle } from '@uk-aq-media/core';
import { countReviewWords, fetchReviewCounts, ReviewScanError } from './review-text';

const permitted = "s.review_text_scan_policy = 'counts_only' AND s.retired_at IS NULL";
const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const dueGuard = `article_id = ? AND due_at <= unixepoch() AND EXISTS (
  SELECT 1 FROM media_articles a WHERE a.id = article_id AND a.status = 'pending'
    AND a.title = ? AND a.source_key = ?)`;

export async function recordReviewExcerpts(db: D1Database, sourceKey: string, articles: DiscoveredArticle[]) {
  const candidates = articles.filter(article => article.review_excerpt &&
    article.review_excerpt !== article.title && reviewHeadlineClass(article.title) === 'ambiguous');
  if (!candidates.length) return;
  // Duplicates and automatic approvals have already been resolved by admission.
  // Only inspect an excerpt when the committed identity still needs partial evidence.
  const pending = await db.prepare(`SELECT a.canonical_url_hash, a.title FROM media_articles a
    JOIN media_article_relevance_evidence e ON e.article_id = a.id JOIN media_sources s USING (source_key)
    WHERE a.status = 'pending' AND e.status IN ('not_checked','not_permitted')
      AND s.review_text_scan_policy = 'disabled' AND s.retired_at IS NULL AND s.source_key = ?
      AND a.canonical_url_hash IN (${candidates.map(() => '?').join(',')})`)
    .bind(sourceKey, ...candidates.map(article => article.canonical_url_hash))
    .all<{ canonical_url_hash: string; title: string }>();
  const titles = new Map(pending.results.map(row => [row.canonical_url_hash, row.title]));
  const statements: D1PreparedStatement[] = [];
  for (const article of candidates) {
    if (!article.review_excerpt || titles.get(article.canonical_url_hash) !== article.title) continue;
    const counts = countReviewWords(article.review_excerpt);
    statements.push(db.prepare(`UPDATE media_article_relevance_evidence SET
      classification = 'ambiguous', status = 'partial', method = 'rss_description',
      air = ?, quality = ?, pollution = ?, health = ?, word_count = ?, checked_at = ${nowSql},
      due_at = NULL, failure_code = NULL
      WHERE status IN ('not_checked','not_permitted') AND article_id = (
        SELECT a.id FROM media_articles a JOIN media_sources s USING (source_key)
        WHERE a.canonical_url_hash = ? AND a.title = ? AND a.status = 'pending'
          AND s.source_key = ? AND s.retired_at IS NULL
          AND s.review_text_scan_policy = 'disabled'
          AND ${publisherAdmissionSql([article.canonical_url, article.original_url])})`)
      .bind(counts.air, counts.quality, counts.pollution, counts.health, counts.word_count,
        article.canonical_url_hash, article.title, sourceKey));
  }
  if (statements.length) await db.batch(statements);
}

export async function scheduleReviewEvidence(db: D1Database, queue: Queue) {
  const { results } = await db.prepare(`SELECT e.article_id, e.attempts, a.title, a.source_key,
      (${permitted}) AS permitted
    FROM media_article_relevance_evidence e INDEXED BY media_relevance_due
    CROSS JOIN media_articles a ON a.id = e.article_id
    CROSS JOIN media_sources s ON s.source_key = a.source_key
    WHERE e.due_at <= unixepoch() AND a.status = 'pending'
    ORDER BY e.due_at, e.article_id LIMIT 20`).all<{
      article_id: number; attempts: number; title: string; source_key: string; permitted: number;
    }>();
  if (!results.length) return;
  const statements = results.map(row => {
    const classification = reviewHeadlineClass(row.title);
    const guard = [row.article_id, row.title, row.source_key];
    if (classification === 'clear' || !row.permitted || row.attempts >= 3) {
      const status = classification === 'clear' ? 'not_checked' : row.permitted ? 'unavailable' : 'not_permitted';
      const failure = classification === 'clear' ? null : row.permitted ? 'attempt_limit' : 'source_policy';
      return db.prepare(`UPDATE media_article_relevance_evidence SET classification = ?, status = ?,
        failure_code = ?, due_at = NULL, token = NULL, checked_at = ${nowSql}
        WHERE ${dueGuard}`).bind(classification, status, failure, ...guard);
    }
    return db.prepare(`UPDATE media_article_relevance_evidence SET classification = 'ambiguous',
      status = 'queued', token = ?, attempts = attempts + 1, due_at = unixepoch() + 1800
      WHERE ${dueGuard} AND attempts < 3 RETURNING article_id, token`)
      .bind(crypto.randomUUID(), ...guard);
  });
  const reservations = await db.batch<{ article_id: number; token: string }>(statements);
  const messages = reservations.flatMap(r => r.results.map(row =>
    ({ body: { type: 'article_review_evidence', article_id: row.article_id, token: row.token } })));
  if (messages.length) await queue.sendBatch(messages);
}

export async function processReviewEvidence(db: D1Database, id: number, deliveryToken: string) {
  // Each delivery token can start at most one fetch. A crash leaves an expiring
  // reservation for the scheduler, including when Queue.sendBatch itself failed.
  const claim = crypto.randomUUID();
  const won = await db.prepare(`UPDATE media_article_relevance_evidence SET token = ?
    WHERE article_id = ? AND token = ? AND status = 'queued' RETURNING article_id`)
    .bind(claim, id, deliveryToken).first();
  if (!won) return;
  const select = `FROM media_article_relevance_evidence e JOIN media_articles a ON a.id = e.article_id
    JOIN media_sources s USING (source_key) WHERE e.article_id = ? AND e.token = ?
      AND a.status = 'pending' AND ${permitted}`;
  const article = await db.prepare(`SELECT a.source_key, s.canonical_domain, a.canonical_url, a.title ${select}`)
    .bind(id, claim).first<{ source_key: string; canonical_domain: string; canonical_url: string; title: string }>();
  try {
    if (!article) throw new ReviewScanError('source_policy');
    const counts = await fetchReviewCounts(db, article, async () =>
      Boolean(await db.prepare(`SELECT 1 ${select}`).bind(id, claim).first()));
    const saved = await db.prepare(`UPDATE media_article_relevance_evidence SET status = 'verified',
      method = 'jsonld_article_body', air = ?, quality = ?, pollution = ?, health = ?, word_count = ?,
      checked_at = ${nowSql}, due_at = NULL, token = NULL, failure_code = NULL
      WHERE article_id = ? AND token = ? AND EXISTS (SELECT 1 ${select})`)
      .bind(counts.air, counts.quality, counts.pollution, counts.health, counts.word_count,
        id, claim, id, claim).run();
    if (saved.meta.changes) return;
    throw new ReviewScanError('source_policy');
  } catch (error) {
    if (!(error instanceof ReviewScanError)) throw error;
    const denied = error.code === 'source_policy' || error.code === 'publisher_access';
    // Transient failures use a fresh scheduled attempt. Terminal extraction/permission
    // results and completed counts never cause a refetch on ordinary rediscovery.
    const transient = error.code === 'fetch_failed' || error.code === 'timeout';
    await db.prepare(`UPDATE media_article_relevance_evidence SET
      status = CASE WHEN ? AND attempts < 3 THEN 'queued' ELSE ? END,
      due_at = CASE WHEN ? AND attempts < 3 THEN unixepoch() + 300 ELSE NULL END,
      token = NULL, failure_code = ?, checked_at = ${nowSql} WHERE article_id = ? AND token = ?`)
      .bind(Number(transient), denied ? 'not_permitted' : 'unavailable', Number(transient),
        error.code, id, claim).run();
  }
}
