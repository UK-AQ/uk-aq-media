import {
  domainBoundarySql, HttpError, json, normaliseBlockDomain,
  publisherHostnameSql, z,
} from '@uk-aq-media/core';

const BlockBody = z.object({ domain: z.string().max(254), blocked: z.boolean(),
  reason: z.string().trim().max(1000).optional() }).strict();
const CleanupBody = z.object({
  confirm: z.literal('blocked_source_initial_cleanup'),
  preview_id: z.string().uuid(),
  after_id: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(50).default(50),
}).strict();

export async function mutateSourceDomainBlock(db: D1Database, key: string,
  input: unknown): Promise<Response> {
  const parsed = BlockBody.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid_source_domain_block_body');
  const domain = normaliseBlockDomain(parsed.data.domain);
  const reason = parsed.data.reason || null;
  const requestJson = JSON.stringify({ domain, blocked: parsed.data.blocked, reason });
  const eventKey = `admin:domain-block:${key}`;
  const replay = await db.prepare(`SELECT request_json FROM media_source_domain_block_events
    WHERE event_key = ?`).bind(eventKey).first<{ request_json: string }>();
  if (replay && replay.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
  if (!replay) {
    const now = new Date().toISOString();
    try {
      await db.batch([
        // Capture the true prior decision inside the same transaction, including
        // NULL before_json when there has never been a decision for this domain.
        db.prepare(`INSERT INTO media_source_domain_block_events
          (event_key, domain, actor_type, request_json, before_json, after_json, created_at)
          SELECT ?, ?, 'admin', ?, (SELECT json_object('domain', domain, 'blocked',
            json(CASE blocked WHEN 1 THEN 'true' ELSE 'false' END), 'reason', reason,
            'created_at', created_at, 'updated_at', updated_at)
            FROM media_source_domain_blocks WHERE domain = ?),
            json_object('domain', ?, 'blocked', json(?), 'reason', ?,
              'created_at', coalesce((SELECT created_at FROM media_source_domain_blocks
                WHERE domain = ?), ?), 'updated_at', ?), ?`)
          .bind(eventKey, domain, requestJson, domain, domain, String(parsed.data.blocked),
            reason, domain, now, now, now),
        db.prepare(`INSERT INTO media_source_domain_blocks
          (domain, blocked, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET blocked = excluded.blocked,
            reason = excluded.reason, updated_at = excluded.updated_at`)
          .bind(domain, Number(parsed.data.blocked), reason, now, now),
      ]);
    } catch (error) {
      const raced = await db.prepare(`SELECT request_json FROM media_source_domain_block_events
        WHERE event_key = ?`).bind(eventKey).first<{ request_json: string }>();
      if (!raced) throw error;
      if (raced.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
    }
  }
  // Replay never reapplies an old decision over a later deliberate block/unblock.
  const saved = await db.prepare('SELECT * FROM media_source_domain_blocks WHERE domain = ?')
    .bind(domain).first<Record<string, unknown>>();
  return json({ domain_block: { ...saved, blocked: saved?.blocked === 1 }, replayed: Boolean(replay) });
}

const INITIAL_DOMAINS_SQL = `SELECT domain FROM media_source_domain_block_events
  WHERE actor_type = 'initialisation' AND event_key = 'initial-domain-block:' || domain`;
const INITIAL_READY_SQL = `(SELECT count(*) FROM media_source_domain_blocks
  WHERE domain IN (${INITIAL_DOMAINS_SQL}) AND blocked = 1) = 20`;
const INITIAL_MATCH_SQL = `EXISTS (SELECT 1 FROM media_source_domain_blocks initial_block
  WHERE initial_block.domain IN (${INITIAL_DOMAINS_SQL}) AND initial_block.blocked = 1
    AND ${domainBoundarySql(publisherHostnameSql('a.canonical_url'), 'initial_block.domain')})`;

export async function previewInitialDomainCleanup(db: D1Database, key: string,
  input: unknown): Promise<Response> {
  if (!z.object({}).strict().safeParse(input).success) {
    throw new HttpError(400, 'invalid_initial_domain_cleanup_preview_body');
  }
  // Counts and the high-water ID are captured in one SQL snapshot. Reusing a
  // preview key returns that inspected scope, even if newer articles now exist.
  await db.prepare(`INSERT INTO media_source_domain_cleanup_previews
    (preview_id, request_key, through_id, counts_json, all_initial_domains_blocked, created_at)
    SELECT ?, ?, coalesce((SELECT max(id) FROM media_articles), 0),
      (SELECT json_group_array(json_object('domain', domain, 'status', status,
        'article_count', article_count)) FROM (
      SELECT initial_block.domain, a.status, count(a.id) AS article_count
      FROM media_source_domain_blocks initial_block LEFT JOIN media_articles a
        ON ${domainBoundarySql(publisherHostnameSql('a.canonical_url'), 'initial_block.domain')}
      WHERE initial_block.domain IN (${INITIAL_DOMAINS_SQL})
      GROUP BY initial_block.domain, a.status ORDER BY initial_block.domain, a.status)),
      ${INITIAL_READY_SQL}, ? WHERE 1 ON CONFLICT(request_key) DO NOTHING`)
    .bind(crypto.randomUUID(), key, new Date().toISOString()).run();
  const receipt = await db.prepare(`SELECT preview_id, through_id, counts_json,
    all_initial_domains_blocked, created_at FROM media_source_domain_cleanup_previews
    WHERE request_key = ?`).bind(key).first<{
      preview_id: string; through_id: number; counts_json: string;
      all_initial_domains_blocked: number; created_at: string;
    }>();
  if (!receipt) throw new HttpError(503, 'cleanup_preview_unavailable');
  const { counts_json, ...scope } = receipt;
  return json({ reason: 'blocked_source_initial_cleanup', counts: JSON.parse(counts_json), ...scope,
    maximum_batch_size: 50 });
}

export async function executeInitialDomainCleanup(db: D1Database, key: string,
  input: unknown): Promise<Response> {
  const parsed = CleanupBody.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid_initial_domain_cleanup_body');
  const data = parsed.data;
  const requestJson = JSON.stringify(data);
  const replay = await db.prepare(`SELECT request_json, response_json
    FROM media_source_domain_cleanup_requests WHERE request_key = ?`)
    .bind(key).first<{ request_json: string; response_json: string }>();
  if (replay) {
    if (replay.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
    return json({ ...JSON.parse(replay.response_json), replayed: true });
  }
  const preview = await db.prepare(`SELECT through_id FROM media_source_domain_cleanup_previews
    WHERE preview_id = ?`).bind(data.preview_id).first<{ through_id: number }>();
  if (!preview) throw new HttpError(409, 'initial_cleanup_preview_required');
  if (data.after_id > preview.through_id) throw new HttpError(400, 'invalid_initial_cleanup_cursor');
  const ready = await db.prepare(`SELECT ${INITIAL_READY_SQL} AS ready`).first<{ ready: number }>();
  if (!ready?.ready) throw new HttpError(409, 'initial_domains_must_all_be_blocked');
  const now = new Date().toISOString();
  const prefix = `blocked-source-initial-cleanup:${key}:`;
  try {
    await db.batch([
      db.prepare(`INSERT INTO media_source_domain_cleanup_requests
        (request_key, request_json, selected_ids_json, created_at)
        SELECT ?, ?, (SELECT json_group_array(id) FROM (
          SELECT a.id FROM media_articles a WHERE a.id > ? AND a.id <= ?
          ORDER BY a.id LIMIT ?)), ? WHERE ${INITIAL_READY_SQL}`)
        .bind(key, requestJson, data.after_id, preview.through_id, data.limit, now),
      // Normal status transition, revision guard and trigger audit. No outbox SQL.
      db.prepare(`UPDATE media_articles AS a SET status = 'rejected',
        mutation_key = ? || id, revision = revision + 1, rejected_at = ?, updated_at = ?
        WHERE a.status = 'pending' AND ${INITIAL_MATCH_SQL} AND ${INITIAL_READY_SQL}
          AND a.id IN (SELECT value FROM json_each((SELECT selected_ids_json
            FROM media_source_domain_cleanup_requests WHERE request_key = ?)))`)
        .bind(prefix, now, now, key),
      db.prepare(`UPDATE media_source_domain_cleanup_requests SET response_json = json_object(
        'reason', 'blocked_source_initial_cleanup', 'preview_id', ?, 'through_id', ?,
        'scanned_count', json_array_length(selected_ids_json),
        'rejected_count', (SELECT count(*) FROM media_article_events e
          WHERE e.article_id IN (SELECT value FROM json_each(selected_ids_json))
            AND e.event_key = ? || e.article_id AND e.event_type = 'rejected'),
        'next_after_id', coalesce((SELECT max(value) FROM json_each(selected_ids_json)), ?),
        'done', json(CASE WHEN NOT EXISTS (SELECT 1 FROM media_articles a
          WHERE a.id > coalesce((SELECT max(value)
            FROM json_each(selected_ids_json)), ?) AND a.id <= ?)
          THEN 'true' ELSE 'false' END)) WHERE request_key = ?`)
        .bind(data.preview_id, preview.through_id, prefix, data.after_id, data.after_id, preview.through_id, key),
    ]);
  } catch (error) {
    const raced = await db.prepare(`SELECT request_json FROM media_source_domain_cleanup_requests
      WHERE request_key = ?`).bind(key).first<{ request_json: string }>();
    if (!raced) throw error;
    if (raced.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
  }
  const result = await db.prepare(`SELECT response_json FROM media_source_domain_cleanup_requests
    WHERE request_key = ?`).bind(key).first<{ response_json: string }>();
  if (!result?.response_json) throw new HttpError(409, 'initial_domains_must_all_be_blocked');
  return json({ ...JSON.parse(result.response_json), replayed: false });
}
