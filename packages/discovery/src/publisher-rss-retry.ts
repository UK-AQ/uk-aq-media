import { PUBLISHER_RSS_ROUTES } from './publisher-rss';
import { MAX_FEED_RETRY_SECONDS, ScanError, type ScanRetry } from './rss';

export function isPublisherRssWork(sourceKey: string, routeKey?: string): boolean {
  return PUBLISHER_RSS_ROUTES.some(route =>
    route.source_key === sourceKey && route.route_key === routeKey);
}

/** Keep the three existing retries, with no extra messages or in-Worker sleeps. */
export function publisherRssRetry(sourceKey: string, routeKey: string | undefined,
  error: unknown, attempt: number, now = Date.now()): ScanRetry | undefined {
  if (!isPublisherRssWork(sourceKey, routeKey) || !(error instanceof ScanError) ||
      !error.details.feed) return undefined;
  const throttled = error.code === 'feed_http_429';
  if (!throttled && !['feed_http_522', 'feed_timeout', 'feed_fetch_failed'].includes(error.code)) {
    return undefined;
  }
  const hint = throttled ? error.details.feed.retry_after.delay_seconds : null;
  // No hint: 429 waits 15/30/60 minutes; transient origin/network failures 10/20/40.
  // A short valid hint still waits at least the existing five minutes.
  const exponent = Math.min(2, Math.max(0, Math.floor(attempt) - 1));
  const delaySeconds = Math.min(MAX_FEED_RETRY_SECONDS,
    hint === null ? (throttled ? 900 : 600) * 2 ** exponent : Math.max(300, hint));
  return { delaySeconds, notBefore: new Date(now + delaySeconds * 1000).toISOString(),
    reason: hint === null ? 'backoff' : 'retry_after' };
}

/** One read per scheduling pass; cooldowns are shared by a publisher's RSS routes. */
export async function publisherRssCooldowns(db: D1Database): Promise<Map<string, string>> {
  const keys = [...new Set(PUBLISHER_RSS_ROUTES.map(route => route.source_key))];
  const { results } = await db.prepare(`SELECT source_key, max(retry_not_before) AS retry_not_before
    FROM media_discovery_runs WHERE source_key IN (${keys.map(() => '?').join(',')})
      AND retry_not_before > ? GROUP BY source_key`)
    .bind(...keys, new Date().toISOString())
    .all<{ source_key: string; retry_not_before: string }>();
  return new Map(results.map(row => [row.source_key, row.retry_not_before]));
}

export type PublisherRssDeliveryGate =
  | { kind: 'superseded'; run_id: string }
  | { kind: 'cooldown'; run_id: string; delaySeconds: number; notBefore: string };

/** Recheck at consumption: work may already have been queued before a 429 arrived. */
export async function publisherRssDeliveryGate(db: D1Database, sourceKey: string,
  routeKey: string | undefined, queuedAt: Date): Promise<PublisherRssDeliveryGate | null> {
  if (!isPublisherRssWork(sourceKey, routeKey)) return null;
  // Only supersede work when the SAME route was fetched successfully after it was enqueued.
  // The earlier failed attempt remains failed; no new successful run is invented.
  const success = await db.prepare(`SELECT id FROM media_discovery_runs
    WHERE source_key = ? AND discovery_route_key = ? AND status = 'succeeded'
      AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 1`)
    .bind(sourceKey, routeKey, queuedAt.toISOString()).first<{ id: string }>();
  if (success) return { kind: 'superseded', run_id: success.id };
  const now = Date.now();
  const cooldown = await db.prepare(`SELECT id, retry_not_before FROM media_discovery_runs
    WHERE source_key = ? AND retry_not_before > ?
    ORDER BY retry_not_before DESC LIMIT 1`).bind(sourceKey, new Date(now).toISOString())
    .first<{ id: string; retry_not_before: string }>();
  return cooldown ? { kind: 'cooldown', run_id: cooldown.id, notBefore: cooldown.retry_not_before,
    delaySeconds: Math.min(MAX_FEED_RETRY_SECONDS,
      Math.max(1, Math.ceil((Date.parse(cooldown.retry_not_before) - now) / 1000))) } : null;
}
