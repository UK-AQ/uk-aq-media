import {
  z, deleteArticleBodyTerms, feedBodySearchTerms, loadAuthorRules, loadSource, permitsAi,
  replaceArticleBodyTerms,
  reconcileHomepageLatestSix, type AuthorRule, type Source, type DiscoveredArticle,
} from '@uk-aq-media/core';
import {
  D1DisplayTitleNeuronLedger, DISPLAY_TITLE_AI_THRESHOLD, LocalRequestBudget,
  WorkersAiDisplayTitleProvider, displayTitleNeuronRates,
  suggestDisplayTitlePermitted,
} from '@uk-aq-media/enrichment';
import { discoverArticleHeadPreviewMetadata } from './article-head-metadata';
import { discoverAqn } from './aqn';
import { CAWS_INDEX_ROUTE_KEY, configuredCawsIndex, discoverCaws } from './caws';
import { configuredDsawspIndex, discoverDsawsp } from './dsawsp';
import {
  configuredPublisherRssRouteKeys, discoverPublisherRss,
} from './publisher-rss';
import {
  configuredGuardianRouteKeys, discoverGuardian, guardianProfileRule, guardianRouteKind,
  guardianRouteRequiresRelevance,
  type GuardianRouteKey,
} from './guardian';
import { mediaDeterministicRelevanceFilter } from './relevance';
import { ScanError } from './rss';
import {
  persistArticle, persistDiscoveryEvidence, publicationAuthorRule,
} from './persistence';

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
export {
  configuredCawsIndex, discoverCaws, extractCawsIndexCandidates,
  CAWS_INDEX_ROUTE_KEY, CAWS_INDEX_URL, CAWS_MAX_ITEMS,
} from './caws';
export {
  configuredDsawspIndex, discoverDsawsp, extractDsawspArticleMetadata,
  extractDsawspIndexUrls, extractDsawspNextIndexUrl, DSAWSP_INDEX_ROUTE_KEY,
  DSAWSP_INDEX_URL, DSAWSP_MAX_INDEX_PAGES, DSAWSP_MAX_ITEMS,
} from './dsawsp';
export {
  configuredPublisherRssRouteKeys, discoverPublisherRss, parsePublisherRssFeed,
  PUBLISHER_RSS_ROUTES,
} from './publisher-rss';
export type { PublisherRssSourceKey } from './publisher-rss';
export {
  discoverArticleHeadPreviewMetadata, extractArticleHeadMetadata, fetchArticleHeadMetadata,
} from './article-head-metadata';
export { extractCawsArticlePreviewImage, fetchCawsArticlePreviewImage } from './caws-preview-image';
export type { ArticleHeadMetadata } from './article-head-metadata';
export {
  configuredGuardianRouteKeys, discoverGuardianCurrentRssImageView,
  discoverGuardianPreviewForArticle, GUARDIAN_ROUTES, guardianPreviewForArticleFromFeed,
  guardianRssImageViewFromFeeds, parseGuardianFeed, scheduledGuardianRouteKeys,
  selectGuardianPreviewCandidate,
} from './guardian';
export type {
  GuardianPreviewCandidate, GuardianPreviewLookup, GuardianRouteFeed, GuardianRouteKey,
  GuardianRssArticleImageEvidence, GuardianRssCandidateEvidence, GuardianRssImageView,
} from './guardian';
export { displayTitleNeuronRates };
export { mediaDeterministicRelevanceFilter } from './relevance';

export async function reconcileHomepageLatestSixAfterSourceCommit(
  reconcile: () => Promise<unknown>, context: {
    run_id: string; source_key: string; route_key?: string;
  },
): Promise<void> {
  try { await reconcile(); }
  catch {
    console.warn(JSON.stringify({ event: 'homepage_latest_six_reconcile_failed',
      run_id: context.run_id, source_key: context.source_key,
      ...(context.route_key ? { route_key: context.route_key } : {}) }));
  }
}

function exactAliasInByline(byline: string, alias: string): boolean {
  const normalise = (value: string): string => value.normalize('NFKC')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
  const escaped = normalise(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u')
    .test(normalise(byline));
}

function guardianAuthorRules(rules: AuthorRule[], routeKey: GuardianRouteKey,
  byline: string | null): AuthorRule[] {
  const profileRule = guardianProfileRule(rules, routeKey);
  if (guardianRouteKind(routeKey) === 'author_profile' && !profileRule) {
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

export function evaluateGuardianArticle(rules: AuthorRule[], routeKey: GuardianRouteKey,
  article: Pick<DiscoveredArticle, 'author' | 'title' | 'canonical_url' | 'categories'>): {
    matchedRules: AuthorRule[];
    accepted: boolean;
  } {
  const matchedRules = guardianAuthorRules(rules, routeKey, article.author);
  const alwaysIncluded = matchedRules.some(rule => rule.inclusion_policy === 'always_include');
  const accepted = !guardianRouteRequiresRelevance(routeKey) || alwaysIncluded ||
    mediaDeterministicRelevanceFilter.evaluate({ title: article.title,
      canonical_url: article.canonical_url, categories: article.categories }).relevant;
  return { matchedRules, accepted };
}

type ExistingPreviewState = {
  canonical_url_hash: string;
  og_image_url: string | null;
  image_policy: string;
  preview_metadata_checked_at: string | null;
};

const CAWS_PREVIEW_RECHECK_SENTINEL = '1970-01-01T00:00:00.000Z';

export type DisplayTitleAiRuntime = {
  binding: Ai;
  model: string;
  maximum_requests_per_run: number;
  daily_neuron_budget: number;
  account_free_neurons_per_day: number;
  maximum_titles_per_request: number;
};

type ClaimedTitleArticle = {
  id: number;
  title: string;
  author: string | null;
};

async function claimEligibleTitleArticle(db: D1Database, sourceKey: string,
  article: DiscoveredArticle, claimedAt: string): Promise<ClaimedTitleArticle | null> {
  return db.prepare(`UPDATE media_articles SET ai_title_attempted_at = ?
    WHERE canonical_url_hash = ?
      AND source_key = ?
      AND status IN ('pending', 'approved')
      AND display_title IS NULL
      AND ai_title_suggestion IS NULL
      AND ai_title_suggestion_state IS NULL
      AND ai_title_attempted_at IS NULL
      AND length(title) > ?
    RETURNING id, title, author`).bind(claimedAt, article.canonical_url_hash, sourceKey,
      DISPLAY_TITLE_AI_THRESHOLD)
    .first<ClaimedTitleArticle>();
}

async function releaseUnusedTitleClaim(db: D1Database, id: number,
  claimedAt: string): Promise<void> {
  await db.prepare(`UPDATE media_articles SET ai_title_attempted_at = NULL
    WHERE id = ? AND ai_title_attempted_at = ? AND ai_title_suggestion IS NULL`)
    .bind(id, claimedAt).run();
}

async function generateDisplayTitleSuggestions(db: D1Database, source: Source,
  articles: DiscoveredArticle[], runtime: DisplayTitleAiRuntime): Promise<boolean> {
  // Automatic inference remains explicitly limited to the two already-authorised sources.
  // Other metadata-only sources may use the authenticated editorial generation path, but a
  // routine discovery observation must not itself spend AI budget.
  if (!['air-quality-news', 'the-guardian'].includes(source.source_key) ||
      !permitsAi(source, 'metadata')) return false;
  const localBudget = new LocalRequestBudget(runtime.maximum_requests_per_run);
  const ledger = new D1DisplayTitleNeuronLedger(db, runtime.maximum_titles_per_request);
  const provider = new WorkersAiDisplayTitleProvider(runtime.binding, runtime.model);
  let displayTitleChanged = false;

  for (const article of articles) {
    const claimedAt = new Date().toISOString();
    let claimed: ClaimedTitleArticle | null;
    try {
      claimed = await claimEligibleTitleArticle(db, source.source_key, article, claimedAt);
    } catch {
      console.warn(JSON.stringify({ event: 'display_title_ai_claim_failed',
        article_hash: article.canonical_url_hash }));
      return displayTitleChanged;
    }
    if (!claimed) continue;

    const outcome = await suggestDisplayTitlePermitted(source, {
      publisher: source.name,
      title: claimed.title,
      title_context: article.title_context,
      author: claimed.author ?? article.author,
      categories: article.categories,
    }, provider, localBudget, ledger, `display-title:${claimed.id}`,
    runtime.daily_neuron_budget, runtime.account_free_neurons_per_day,
    runtime.maximum_titles_per_request);
    if (outcome.status === 'skipped') {
      // A duplicate durable request means an earlier inference was already admitted; retaining
      // the claim prevents a replay from sending it again. Other pre-inference skips may retry.
      if (outcome.reason !== 'duplicate_request') {
        try { await releaseUnusedTitleClaim(db, claimed.id, claimedAt); }
        catch {
          console.warn(JSON.stringify({ event: 'display_title_ai_claim_release_failed',
            article_id: claimed.id }));
        }
      }
      console.info(JSON.stringify({ event: 'display_title_ai_skipped', article_id: claimed.id,
        reason: outcome.reason }));
      if (outcome.reason === 'local_budget' || outcome.reason === 'storage_failure') {
        return displayTitleChanged;
      }
      continue;
    }
    if (outcome.status === 'failed') {
      console.warn(JSON.stringify({ event: 'display_title_ai_failed', article_id: claimed.id,
        reason: outcome.reason }));
      continue;
    }

    try {
      const acceptedAt = new Date().toISOString();
      const stored = await db.prepare(`UPDATE media_articles SET
        display_title = ?, display_title_origin = 'ai',
        ai_title_suggestion = ?, ai_title_suggestion_state = 'accepted',
        ai_title_model = ?, ai_title_prompt_version = ?, ai_title_generated_at = ?,
        ai_title_decided_at = ?, updated_at = ?
        WHERE id = ? AND ai_title_attempted_at = ?
          AND status IN ('pending', 'approved')
          AND display_title IS NULL AND ai_title_suggestion IS NULL
          AND ai_title_suggestion_state IS NULL
        RETURNING id`).bind(outcome.title, outcome.title, outcome.provenance.model,
          outcome.provenance.version, outcome.provenance.generated_at, acceptedAt,
          acceptedAt, claimed.id, claimedAt).first<{ id: number }>();
      if (stored) displayTitleChanged = true;
      else {
        console.warn(JSON.stringify({ event: 'display_title_ai_store_skipped',
          article_id: claimed.id }));
      }
    } catch {
      console.warn(JSON.stringify({ event: 'display_title_ai_store_failed',
        article_id: claimed.id }));
    }
  }
  return displayTitleChanged;
}

async function fillArticleHeadPreviewMetadata(db: D1Database, source: Source,
  articles: DiscoveredArticle[]): Promise<void> {
  if (source.image_policy !== 'remote_preview' || articles.length === 0) return;
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
    const cawsRecheck = source.source_key === 'communities-against-woodsmoke' &&
      state?.preview_metadata_checked_at === CAWS_PREVIEW_RECHECK_SENTINEL;
    if (hasPreview || !articleAllowsPreview ||
        state?.preview_metadata_checked_at && !cawsRecheck) continue;
    try {
      Object.assign(article, await discoverArticleHeadPreviewMetadata(article, source));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'article_head_metadata_failed',
        source_key: source.source_key,
        article_hash: article.canonical_url_hash,
        error_code: error instanceof ScanError ? error.code : 'article_head_failed',
      }));
    }
  }
}

export async function runSourceScan(db: D1Database, sourceKey: string, routeKey: string | undefined,
  messageId: string, attempt: number, displayTitleAi?: DisplayTitleAiRuntime): Promise<void> {
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

    let result: { articles: DiscoveredArticle[]; items_seen: number; items_invalid: number };
    let rules: AuthorRule[] = [];
    if (sourceKey === 'air-quality-news' && routeKey === undefined) {
      result = await discoverAqn(source);
    } else if (sourceKey === 'the-guardian' && routeKey &&
        configuredGuardianRouteKeys(source).includes(routeKey as GuardianRouteKey)) {
      rules = await loadAuthorRules(db, sourceKey);
      if (guardianRouteKind(routeKey as GuardianRouteKey) === 'author_profile' &&
          !guardianProfileRule(rules, routeKey as GuardianRouteKey)) {
        await finishRun(db, runId, 'skipped', 0, 0, 0,
          'guardian_profile_author_rule_disabled_or_missing');
        return;
      }
      result = await discoverGuardian(source, routeKey);
    } else if (sourceKey === 'communities-against-woodsmoke' &&
        routeKey === CAWS_INDEX_ROUTE_KEY &&
        configuredCawsIndex(source)) {
      result = await discoverCaws(source);
    } else if (sourceKey === 'dsawsp' && routeKey && configuredDsawspIndex(source)) {
      result = await discoverDsawsp(source);
    } else if (routeKey && configuredPublisherRssRouteKeys(source).includes(routeKey)) {
      result = await discoverPublisherRss(source, routeKey);
    } else {
      await finishRun(db, runId, 'skipped', 0, 0, 0, 'unsupported_adapter_or_route');
      return;
    }

    seen = result.items_seen;
    invalid = result.items_invalid;
    if (seen > 0 && result.articles.length === 0) throw new ScanError('no_valid_feed_entries');
    const unique = new Map(result.articles.map(article => [article.canonical_url_hash, article]));
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    const acceptedArticles: DiscoveredArticle[] = [];
    const acceptedRules = new Map<string, AuthorRule[]>();
    // AQN and generic publisher routes remain at <=20 items; Guardian is <=10 per route.
    // One article and one provider-evidence statement per item remains below D1's batch bound.
    for (const article of unique.values()) {
      const guardianEvaluation = sourceKey === 'the-guardian' && routeKey
        ? evaluateGuardianArticle(rules, routeKey as GuardianRouteKey, article) : null;
      const matchedRules = guardianEvaluation?.matchedRules ?? [];
      const publisherRelevant = ![
        'air-quality-news', 'the-guardian', 'mums-for-lungs', 'dsawsp', 'communities-against-woodsmoke',
      ].includes(sourceKey)
        ? mediaDeterministicRelevanceFilter.evaluate({ title: article.title,
          canonical_url: article.canonical_url, categories: article.categories }).relevant : true;
      if ((guardianEvaluation && !guardianEvaluation.accepted) || !publisherRelevant) {
        filtered++;
        continue;
      }
      acceptedArticles.push(article);
      acceptedRules.set(article.canonical_url_hash, matchedRules);
    }
    const acceptedHashes = acceptedArticles.map(article => article.canonical_url_hash);
    const existingHashes = acceptedHashes.length === 0 ? new Set<string>() : new Set(
      (await db.prepare(`SELECT canonical_url_hash FROM media_articles
        WHERE canonical_url_hash IN (${acceptedHashes.map(() => '?').join(', ')})`)
        .bind(...acceptedHashes).all<{ canonical_url_hash: string }>()).results
        .map(row => row.canonical_url_hash),
    );
    await fillArticleHeadPreviewMetadata(db, source, acceptedArticles);
    for (const article of acceptedArticles) {
      const matchedRules = acceptedRules.get(article.canonical_url_hash) ?? [];
      const publicationRule = publicationAuthorRule(matchedRules);
      const selectedAutoRule = publicationRule?.publication_policy === 'auto_approve'
        ? publicationRule : null;
      const approvalObservationKey = selectedAutoRule
        ? `author-auto:${runId}:${article.canonical_url_hash}` : null;
      statements.push(persistArticle(db, source, article, matchedRules, approvalObservationKey, now));
      const providerKey = ['dsawsp', 'communities-against-woodsmoke'].includes(sourceKey)
        ? 'publisher_web_index' : 'publisher_rss';
      statements.push(persistDiscoveryEvidence(db, source, providerKey, routeKey ?? sourceKey,
        article, matchedRules, approvalObservationKey, now));
    }
    statements.push(db.prepare(`UPDATE media_discovery_runs SET status = 'succeeded',
      finished_at = ?, updated_at = ?, items_seen = ?, items_inserted = ?, items_updated = ?,
      items_invalid = ?, items_filtered = ? WHERE id = ?`).bind(now, now, seen,
        acceptedHashes.filter(hash => !existingHashes.has(hash)).length,
        acceptedHashes.filter(hash => existingHashes.has(hash)).length,
        invalid, filtered, runId));
    // D1 batch is atomic: articles, trigger events, evidence and successful run state commit together.
    await db.batch(statements);
    // Body indexing is separately permission-gated and best effort: discovery remains valid if
    // derived-index refresh fails. Feed HTML is never written to durable storage.
    if (source.search_index_policy === 'feed_body_text') {
      for (const article of acceptedArticles) {
        if (article.feed_body_html === null || article.feed_body_html === undefined) continue;
        try {
          const row = await db.prepare('SELECT id FROM media_articles WHERE canonical_url_hash = ?')
            .bind(article.canonical_url_hash).first<{ id: number }>();
          if (row) await replaceArticleBodyTerms(db, row.id, source.source_key,
            feedBodySearchTerms(article.feed_body_html));
        } catch {
          console.warn(JSON.stringify({ event: 'article_body_search_index_failed',
            source_key: source.source_key, article_hash: article.canonical_url_hash }));
        }
      }
    } else {
      try { await deleteArticleBodyTerms(db, { source_key: source.source_key }); }
      catch {
        console.warn(JSON.stringify({ event: 'article_body_search_index_revoke_failed',
          source_key: source.source_key }));
      }
    }
    await reconcileHomepageLatestSixAfterSourceCommit(() => reconcileHomepageLatestSix(db), {
      run_id: runId, source_key: sourceKey, route_key: routeKey,
    });
    // Discovery is already committed and authoritative. Title AI is best-effort enrichment;
    // its context remains only in these in-memory feed items and no failure escapes this helper.
    if (displayTitleAi) {
      let displayTitleChanged = false;
      try {
        displayTitleChanged = await generateDisplayTitleSuggestions(
          db, source, acceptedArticles, displayTitleAi,
        );
      } catch {
        console.warn(JSON.stringify({ event: 'display_title_ai_run_failed', run_id: runId }));
      }
      if (displayTitleChanged) {
        await reconcileHomepageLatestSixAfterSourceCommit(() => reconcileHomepageLatestSix(db), {
          run_id: runId, source_key: sourceKey, route_key: routeKey,
        });
      }
    }
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
