import { SourceSchema, loadAuthorRules, type Source } from '@uk-aq-media/core';
import {
  AQN_FEED, configuredPublisherRssRouteKeys, scheduledGuardianRouteKeys,
  configuredCawsIndex, CAWS_INDEX_ROUTE_KEY, configuredDsawspIndex,
  DSAWSP_INDEX_ROUTE_KEY, configuredNcasRouteKeys,
} from '@uk-aq-media/discovery';

// Mirror the explicit source allow-list in media-discovery's scheduler.
// This endpoint is read-only and must never enqueue scans or alter publications.
const DIRECT_SOURCE_KEYS = [
  'air-quality-news', 'the-guardian', 'bbc-news', 'sky-news', 'the-independent',
  'carbon-brief', 'openaq', 'phys-org', 'university-of-exeter', 'see-the-air',
  'mums-for-lungs', 'dsawsp', 'communities-against-woodsmoke', 'ncas',
] as const;
const STALE_AFTER_MS = 5 * 60 * 60 * 1000;
const LOG_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
type SourceRow = { source_key: string; enabled: number; discovery_config_json: string; [key: string]: unknown };
type RunStat = {
  source_key: string; route_key: string; last_attempt_at: string | null;
  last_success_at: string | null; last_failed_at: string | null;
  latest_status: string | null; latest_error_code: string | null;
  failures_in_window: number;
};
type HealthRoute = RunStat & { status: 'healthy' | 'warning' | 'critical'; reason: string | null };
type SocialRow = {
  channel: string; article_id: number; status: string; publication_reason: string;
  last_error_code: string | null; updated_at: string;
};

function ageMs(date: string | null, now: number): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

function configuredRoutes(source: Source, guardianAuto: string[]): string[] {
  if (source.source_key === 'air-quality-news') {
    return source.discovery_method === 'rss' &&
      source.discovery_config.url === AQN_FEED && source.canonical_domain === 'airqualitynews.com'
      ? [''] : [];
  }
  if (source.source_key === 'the-guardian') return guardianAuto;
  if (source.source_key === 'dsawsp') {
    return configuredDsawspIndex(source) ? [DSAWSP_INDEX_ROUTE_KEY] : [];
  }
  if (source.source_key === 'communities-against-woodsmoke') {
    return configuredCawsIndex(source) ? [CAWS_INDEX_ROUTE_KEY] : [];
  }
  if (source.source_key === 'ncas') return configuredNcasRouteKeys(source);
  return configuredPublisherRssRouteKeys(source);
}

function healthForRoute(stat: RunStat | undefined, now: number): HealthRoute {
  const source = stat || {
    source_key: '', route_key: '', last_attempt_at: null, last_success_at: null,
    last_failed_at: null, latest_status: null, latest_error_code: null, failures_in_window: 0,
  };
  const successAge = ageMs(source.last_success_at, now);
  const attemptAge = ageMs(source.last_attempt_at, now);
  let status: HealthRoute['status'] = 'healthy';
  let reason: string | null = null;
  if (!source.last_attempt_at) {
    status = 'critical'; reason = 'no_discovery_runs';
  } else if (successAge > STALE_AFTER_MS) {
    status = 'critical';
    reason = source.latest_status === 'failed' ? 'repeated_discovery_failure' : 'no_recent_success';
  } else if (source.latest_status === 'failed') {
    status = 'warning'; reason = 'latest_run_failed';
  } else if (source.latest_status === 'running' && attemptAge > 20 * 60 * 1000) {
    status = 'warning'; reason = 'stalled_run';
  } else if (source.latest_status === 'skipped') {
    status = 'warning'; reason = 'latest_run_skipped';
  }
  return { ...source, status, reason };
}

export async function readMediaHealth(db: D1Database): Promise<unknown> {
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const start = new Date(now - LOG_WINDOW_MS).toISOString();
  const runSql = [
    'WITH ranked AS (',
    'SELECT source_key, coalesce(discovery_route_key, \'\') AS route_key,',
    'started_at, status, error_code,',
    'row_number() OVER (PARTITION BY source_key, coalesce(discovery_route_key, \'\')',
    'ORDER BY started_at DESC, id DESC) AS rn',
    'FROM media_discovery_runs WHERE started_at >= ?',
    ') SELECT source_key, route_key, max(started_at) AS last_attempt_at,',
    "max(CASE WHEN status = 'succeeded' THEN started_at END) AS last_success_at,",
    "max(CASE WHEN status = 'failed' THEN started_at END) AS last_failed_at,",
    'max(CASE WHEN rn = 1 THEN status END) AS latest_status,',
    'max(CASE WHEN rn = 1 THEN error_code END) AS latest_error_code,',
    "sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures_in_window",
    'FROM ranked GROUP BY source_key, route_key',
  ].join(' ');
  const sourceKeys = new Set<string>(DIRECT_SOURCE_KEYS);
  const [sourceData, runData, blueskyData, facebookData, guardianRules] = await Promise.all([
    db.prepare('SELECT source_key, name, canonical_domain, source_type, enabled, ' +
      'publication_policy, review_level, priority, discovery_method, discovery_config_json, ' +
      'content_fetch_policy, ai_content_policy, image_policy, search_index_policy ' +
      'FROM media_sources WHERE enabled = 1 AND retired_at IS NULL')
      .all<SourceRow>(),
    db.prepare(runSql).bind(start).all<RunStat>(),
    db.prepare("SELECT 'bluesky' AS channel, article_id, status, publication_reason, " +
      'last_error_code, updated_at FROM media_bluesky_publications ' +
      "WHERE publication_reason = 'auto_approved' AND status != 'posted' " +
      'ORDER BY updated_at DESC LIMIT 30').all<SocialRow>(),
    db.prepare("SELECT 'facebook' AS channel, article_id, status, publication_reason, " +
      'last_error_code, updated_at FROM media_facebook_publications ' +
      "WHERE publication_reason = 'auto_approved' AND status != 'posted' " +
      'ORDER BY updated_at DESC LIMIT 30').all<SocialRow>(),
    loadAuthorRules(db, 'the-guardian'),
  ]);
  const stats = new Map(runData.results.map(r => [r.source_key + ':' + r.route_key, r]));
  const sources = [];
  for (const raw of sourceData.results) {
    if (!sourceKeys.has(raw.source_key)) continue;
    const { discovery_config_json, enabled, ...fields } = raw;
    let source: Source | null = null;
    try {
      const candidate = SourceSchema.safeParse({ ...fields, enabled: enabled === 1,
        discovery_config: JSON.parse(discovery_config_json) });
      if (candidate.success) source = candidate.data;
    } catch { /* Invalid source configuration is an operational health error. */ }
    const isAuto = raw.publication_policy === 'auto_approve' ||
      raw.source_key === 'the-guardian' &&
        guardianRules.some(rule => rule.publication_policy === 'auto_approve');
    const routeKeys = source ? configuredRoutes(source, source.source_key === 'the-guardian'
      ? scheduledGuardianRouteKeys(source, guardianRules) : []) : [];
    const routes = routeKeys.map(route_key => {
      const result = healthForRoute(stats.get(raw.source_key + ':' + route_key), now);
      return { ...result, source_key: raw.source_key, route_key };
    });
    const invalidConfig = !routeKeys.length;
    sources.push({
      source_key: raw.source_key, name: raw.name, publication_policy: raw.publication_policy,
      auto_approval: isAuto, status: invalidConfig || routes.some(r => r.status === 'critical')
        ? 'critical' : routes.some(r => r.status === 'warning') ? 'warning' : 'healthy',
      reason: invalidConfig ? 'not_scheduled_configuration_mismatch' : null,
      routes,
    });
  }
  const social = [...blueskyData.results, ...facebookData.results]
    .map(row => ({
      ...row, severity: row.status === 'failed' || row.status === 'unknown_remote_state'
        ? 'critical' : row.status === 'blocked' ? 'warning' :
          ageMs(row.updated_at, now) > STALE_AFTER_MS ? 'warning' : 'healthy',
    })).filter(row => row.severity !== 'healthy');
  return { generated_at: generatedAt, stale_after_minutes: STALE_AFTER_MS / 60000,
    sources, social };
}
