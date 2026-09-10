import {
  z, initialEditorialState, loadAuthorRules, loadSource,
  type AuthorRule, type Source, type DiscoveredArticle,
} from '@uk-aq-media/core';
import { discoverAqn, discoverAqnPreviewMetadata } from './aqn';
import {
  configuredGuardianRouteKeys, discoverGuardian, guardianRouteRequiresRelevance, GUARDIAN_ROUTES,
  type GuardianRouteKey,
} from './guardian';
import { mediaDeterministicRelevanceFilter } from './relevance';
import { ScanError } from './rss';

export const DiscoveryMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('source_scan'),
    source_key: z.string().min(1).max(100),
    route_key: z.string().min(1).max(100).optional(),
  }).strict(),
  z.object({ type: z.literal('article_enrich'), article_id: z.number().int().positive() }).strict(),
]);
export type DiscoveryMessage = z.infer<typeof DiscoveryMessageSchema>;
export { parseAqnFeed } from './aqn';
export { configuredGuardianRouteKeys, GUARDIAN_ROUTES, parseGuardianFeed } from './guardian';

function exactAliasInByline(byline: string, alias: string): boolean {
  const normalise = (value: string): string => value.normalize('NFKC')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
  const escaped = normalise(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u')
    .test(normalise(byline));
}

function guardianAuthorRules(rules: AuthorRule[], routeKey: GuardianRouteKey,
  byline: string | null): AuthorRule[] {
  const expectedRoute = GUARDIAN_ROUTES.find(route => route.route_key === routeKey);
  const profileRule = rules.find(rule => rule.profile_rss_route_key === routeKey &&
    rule.profile_rss_url === expectedRoute?.url);
  if (routeKey !== 'guardian-air-pollution' && !profileRule) {
    throw new ScanError('guardian_profile_author_rule_missing');
  }
  const matches = new Map<string, AuthorRule>();
  if (profileRule) matches.set(profileRule.author_key, profileRule);
  if (byline) {
    for (const rule of rules) {
      if (rule.byline_aliases.some(alias => exactAliasInByline(byline, alias))) {
        matches.set(rule.author_key, rule);
      }
    }
  }
  return [...matches.values()].sort((left, right) => left.author_key.localeCompare(right.author_key));
}

function publicationAuthorRule(rules: AuthorRule[]): AuthorRule | null {
  return rules.find(rule => rule.publication_policy === 'auto_approve') ??
    rules.find(rule => rule.publication_policy === 'pending') ?? null;
}

function persistArticle(db: D1Database, source: Source, article: DiscoveredArticle,
  matchedRules: AuthorRule[], now: string): D1PreparedStatement {
  const editorial = initialEditorialState(source, publicationAuthorRule(matchedRules));
  // Conflict updates preserve editorial decisions. Only Pending can be promoted by a later,
  // positively identified trusted-author observation; Rejected/Hidden always win.
  return db.prepare(`INSERT INTO media_articles (source_key, canonical_url, canonical_url_hash,
    original_url, title, publisher, author, published_at, discovered_at, last_seen_at,
    topics_json, status, review_level, approval_method, approval_author_rule_key,
    og_image_url, image_policy, display_title, display_title_origin, preview_metadata_checked_at,
    approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_url_hash) DO UPDATE SET
      last_seen_at = max(media_articles.last_seen_at, excluded.last_seen_at),
      updated_at = max(media_articles.updated_at, excluded.updated_at),
      author = coalesce(media_articles.author, excluded.author),
      og_image_url = CASE
        WHEN media_articles.og_image_url IS NULL AND media_articles.image_policy = 'remote_preview'
          THEN excluded.og_image_url ELSE media_articles.og_image_url END,
      display_title = coalesce(media_articles.display_title, excluded.display_title),
      display_title_origin = CASE
        WHEN media_articles.display_title IS NULL AND excluded.display_title IS NOT NULL
          THEN excluded.display_title_origin ELSE media_articles.display_title_origin END,
      preview_metadata_checked_at = coalesce(media_articles.preview_metadata_checked_at,
        excluded.preview_metadata_checked_at),
      status = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto' THEN 'approved'
        ELSE media_articles.status END,
      approval_method = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto' THEN excluded.approval_method
        ELSE media_articles.approval_method END,
      approval_author_rule_key = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto' THEN excluded.approval_author_rule_key
        ELSE media_articles.approval_author_rule_key END,
      approved_at = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto' THEN excluded.approved_at
        ELSE media_articles.approved_at END,
      revision = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto' THEN media_articles.revision + 1
        ELSE media_articles.revision END,
      mutation_key = CASE WHEN media_articles.status = 'pending'
        AND excluded.approval_method = 'trusted_author_auto'
        THEN 'author-auto:' || media_articles.id || ':' || excluded.approval_author_rule_key
        ELSE media_articles.mutation_key END
    RETURNING id, revision`).bind(source.source_key, article.canonical_url,
      article.canonical_url_hash, article.original_url, article.title, source.name, article.author,
      article.published_at, now, now, JSON.stringify(article.categories), editorial.status,
      source.review_level, editorial.approval_method, editorial.approval_author_rule_key,
      article.preview_url, source.image_policy, article.display_title, article.display_title_origin,
      article.preview_metadata_checked_at, editorial.status === 'approved' ? now : null, now, now);
}

function persistDiscoveryEvidence(db: D1Database, source: Source, routeKey: string,
  article: DiscoveredArticle, matchedRules: AuthorRule[], now: string): D1PreparedStatement {
  const ruleKeys = matchedRules.map(rule => rule.author_key);
  const selectedAutoRule = matchedRules.find(rule => rule.publication_policy === 'auto_approve') ?? null;
  return db.prepare(`INSERT INTO media_article_discovery_evidence
    (article_id, source_key, provider_key, route_key, matched_author_keys_json,
      always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
      observation_count)
    VALUES ((SELECT id FROM media_articles WHERE canonical_url_hash = ?), ?, 'publisher_rss', ?, ?, ?,
      CASE WHEN ? IS NOT NULL AND EXISTS (
        SELECT 1 FROM media_article_events
        WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)
          AND event_type = 'auto_approved'
          AND json_extract(metadata_json, '$.author_rule_key') = ?
      ) THEN 1 ELSE 0 END, ?, ?, 1)
    ON CONFLICT(article_id, provider_key, route_key) DO UPDATE SET
      matched_author_keys_json = (
        SELECT json_group_array(author_key) FROM (
          SELECT value AS author_key FROM json_each(media_article_discovery_evidence.matched_author_keys_json)
          UNION
          SELECT value AS author_key FROM json_each(excluded.matched_author_keys_json)
          ORDER BY author_key
        )
      ),
      always_include_applied = max(media_article_discovery_evidence.always_include_applied,
        excluded.always_include_applied),
      author_auto_approval_applied = max(
        media_article_discovery_evidence.author_auto_approval_applied,
        excluded.author_auto_approval_applied),
      last_seen_at = max(media_article_discovery_evidence.last_seen_at, excluded.last_seen_at),
      observation_count = media_article_discovery_evidence.observation_count + 1`)
    .bind(article.canonical_url_hash, source.source_key, routeKey, JSON.stringify(ruleKeys),
      Number(matchedRules.some(rule => rule.inclusion_policy === 'always_include')),
      selectedAutoRule?.author_key ?? null, article.canonical_url_hash,
      selectedAutoRule?.author_key ?? null, now, now);
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

export async function runSourceScan(db: D1Database, sourceKey: string, routeKey: string | undefined,
  messageId: string, attempt: number): Promise<void> {
  const runId = crypto.randomUUID();
  const started = new Date().toISOString();
  // Resolve the FK inside SQL, so malformed/unknown source messages can still have diagnostics.
  await db.prepare(`INSERT INTO media_discovery_runs
    (id, source_key, discovery_route_key, queue_message_id, attempt, started_at, status, updated_at)
    VALUES (?, (SELECT source_key FROM media_sources WHERE source_key = ?), ?, ?, ?, ?, 'running', ?)`)
    .bind(runId, sourceKey, routeKey ?? null, messageId, attempt, started, started).run();
  let seen = 0;
  let invalid = 0;
  let filtered = 0;
  try {
    const source = await loadSource(db, sourceKey);
    if (!source || !source.enabled) {
      await finishRun(db, runId, 'skipped', 0, 0, 0,
        source ? 'source_disabled_or_deferred' : 'unknown_source');
      return;
    }

    let result: Awaited<ReturnType<typeof discoverAqn>>;
    let rules: AuthorRule[] = [];
    if (sourceKey === 'air-quality-news' && routeKey === undefined) {
      result = await discoverAqn(source);
    } else if (sourceKey === 'the-guardian' && routeKey &&
        configuredGuardianRouteKeys(source).includes(routeKey as GuardianRouteKey)) {
      rules = await loadAuthorRules(db, sourceKey);
      result = await discoverGuardian(source, routeKey);
    } else {
      await finishRun(db, runId, 'skipped', 0, 0, 0, 'unsupported_adapter_or_route');
      return;
    }

    seen = result.items_seen;
    invalid = result.items_invalid;
    if (seen > 0 && result.articles.length === 0) throw new ScanError('no_valid_feed_entries');
    const unique = new Map(result.articles.map(article => [article.canonical_url_hash, article]));
    if (sourceKey === 'air-quality-news') await fillAqnPreviewMetadata(db, source, [...unique.values()]);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    // AQN remains at <=20 items. Guardian is <=10 items per route, so its extra route-evidence
    // statement still keeps every Queue invocation comfortably bounded.
    for (const article of unique.values()) {
      const matchedRules = sourceKey === 'the-guardian' && routeKey
        ? guardianAuthorRules(rules, routeKey as GuardianRouteKey, article.author) : [];
      const alwaysIncluded = matchedRules.some(rule => rule.inclusion_policy === 'always_include');
      if (sourceKey === 'the-guardian' && routeKey &&
          guardianRouteRequiresRelevance(routeKey as GuardianRouteKey) && !alwaysIncluded &&
          !mediaDeterministicRelevanceFilter.evaluate({ title: article.title,
            canonical_url: article.canonical_url, categories: article.categories }).relevant) {
        filtered++;
        continue;
      }
      statements.push(db.prepare(`UPDATE media_discovery_runs SET
        items_inserted = items_inserted + CASE WHEN EXISTS
          (SELECT 1 FROM media_articles WHERE canonical_url_hash = ?) THEN 0 ELSE 1 END,
        items_updated = items_updated + CASE WHEN EXISTS
          (SELECT 1 FROM media_articles WHERE canonical_url_hash = ?) THEN 1 ELSE 0 END
        WHERE id = ?`).bind(article.canonical_url_hash, article.canonical_url_hash, runId));
      statements.push(persistArticle(db, source, article, matchedRules, now));
      if (sourceKey === 'the-guardian' && routeKey) {
        statements.push(persistDiscoveryEvidence(db, source, routeKey, article, matchedRules, now));
      }
    }
    statements.push(db.prepare(`UPDATE media_discovery_runs SET status = 'succeeded',
      finished_at = ?, updated_at = ?, items_seen = ?, items_invalid = ?, items_filtered = ?
      WHERE id = ?`).bind(now, now, seen, invalid, filtered, runId));
    // D1 batch is atomic: articles, trigger events, evidence and successful run state commit together.
    await db.batch(statements);
  } catch (error) {
    const code = error instanceof ScanError ? error.code : 'source_scan_failed';
    try { await finishRun(db, runId, 'failed', seen, invalid, filtered, code); }
    catch { console.error(JSON.stringify({ event: 'run_evidence_unavailable', run_id: runId })); }
    throw error;
  }
}

async function finishRun(db: D1Database, id: string, status: 'failed' | 'skipped',
  seen: number, invalid: number, filtered: number, code: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE media_discovery_runs SET status = ?, finished_at = ?, updated_at = ?,
    items_seen = ?, items_invalid = ?, items_filtered = ?, error_code = ? WHERE id = ?`)
    .bind(status, now, now, seen, invalid, filtered, code, id).run();
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
