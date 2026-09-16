import { ArticleStatus, bearerMatches, boundedLimit, HttpError, httpFailure, json, reconcileHomepageLatestSix, z,
  BLUESKY_PLACEHOLDERS, BLUESKY_POST_BYTES, BLUESKY_POST_GRAPHEMES,
  BLUESKY_TEMPLATE_LITERAL_GRAPHEMES, validateBlueskyTemplate,
  loadSource, type Status } from '@uk-aq-media/core';
import {
  discoverGuardianPreviewForArticle, GUARDIAN_ROUTES,
  type GuardianPreviewCandidate, type GuardianPreviewLookup,
} from '@uk-aq-media/discovery';
import {
  D1DisplayTitleNeuronLedger, LocalRequestBudget, WorkersAiDisplayTitleProvider,
  displayTitleNeuronRates, suggestDisplayTitleExplicit,
} from '@uk-aq-media/enrichment';
import {
  applyGuardianImageRepairPlan, buildGuardianImageRepairPlan,
  requireCurrentGuardianImageRepairPlan,
} from './guardian-image-bulk';
import { handleEditorialDashboard } from './editorial-dashboard';

type Action = 'approve' | 'reject' | 'hide' | 'unhide';
const transitions: Record<Action, { from: Status[]; to: Status; event: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', event: 'approved' },
  reject: { from: ['pending', 'approved', 'hidden'], to: 'rejected', event: 'rejected' },
  hide: { from: ['approved'], to: 'hidden', event: 'hidden' },
  unhide: { from: ['hidden'], to: 'approved', event: 'unhidden' },
};

const ManualDisplayTitleBody = z.object({ display_title: z.string().nullable() }).strict();
const GuardianImagePreviewBody = z.object({
  route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
}).strict();
const GuardianImageApplyBody = z.object({
  route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  expected_current_image_url: z.string().min(1).max(2048).nullable(),
  proposed_image_url: z.string().min(1).max(2048),
  confirm_replace_existing: z.literal(true),
}).strict();
const GuardianBulkImageApplyBody = z.object({
  confirm_bulk_replace: z.literal(true),
  repair_token: z.string().regex(/^guardian-image-repair-v1:[a-f0-9]{64}$/),
}).strict();
const BlueskySettingsBody = z.object({
  publishing_enabled: z.boolean(),
  default_message_template: z.string().min(1).max(2000),
  cooldown_minutes: z.number().int().min(1).max(1440),
}).strict();
const StatusMutationBody = z.object({ post_to_bluesky: z.boolean().optional() }).strict();
const MAX_ADMIN_BODY_BYTES = 4096;
const MAX_HUMAN_DISPLAY_TITLE_CHARACTERS = 500;
const NEURON_MICRO_UNITS = 1_000_000;

type TitleMutationRow = {
  id: number;
  status: Status;
  title: string;
  display_title: string | null;
  display_title_origin: 'publisher' | 'human' | 'ai' | null;
  ai_title_suggestion: string | null;
  ai_title_suggestion_state: 'pending' | 'accepted' | 'rejected' | null;
  ai_title_decided_at: string | null;
};

type ExplicitTitleArticleRow = TitleMutationRow & {
  publisher: string;
  author: string | null;
  approval_method: string | null;
  approved_at: string | null;
  ai_title_attempted_at: string | null;
  ai_title_model: string | null;
  ai_title_prompt_version: string | null;
  ai_title_generated_at: string | null;
};

type GuardianImageRow = {
  id: number;
  source_key: string;
  canonical_url: string;
  title: string;
  status: Status;
  og_image_url: string | null;
  image_policy: string;
  preview_metadata_checked_at: string | null;
};

export type AiUsageRow = {
  usage_date: string;
  ai_requests: number;
  ai_titles_attempted: number;
  legacy_usage_unknown_requests: number;
  titles_generated_successfully: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calculated_neuron_microunits: number;
  outstanding_reserved_neuron_microunits: number;
  accounted_neuron_microunits: number;
  media_daily_budget_neuron_microunits: number;
  account_free_neuron_microunits: number;
};

function configuredAiUsageLimits(env: MediaAdminEnv): {
  dailyBudgetNeurons: number;
  accountFreeNeurons: number;
  maximumTitlesPerRequest: number;
  model: string;
} {
  const dailyBudgetNeurons = Number(env.MEDIA_AI_DAILY_NEURON_BUDGET);
  const accountFreeNeurons = Number(env.MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY);
  const maximumTitlesPerRequest = Number(env.MEDIA_AI_MAX_TITLES_PER_REQUEST);
  const model = String(env.MEDIA_AI_MODEL).trim();
  if (!Number.isSafeInteger(dailyBudgetNeurons) || dailyBudgetNeurons < 1 ||
      !Number.isSafeInteger(accountFreeNeurons) || accountFreeNeurons < 1 ||
      dailyBudgetNeurons > accountFreeNeurons ||
      !Number.isSafeInteger(dailyBudgetNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(accountFreeNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(maximumTitlesPerRequest) || maximumTitlesPerRequest < 1 ||
      maximumTitlesPerRequest > 5 || !/^@cf\/[a-z0-9._/-]+$/i.test(model) ||
      model.length > 200 || displayTitleNeuronRates(model) === null) {
    throw new HttpError(503, 'ai_usage_configuration_invalid');
  }
  return { dailyBudgetNeurons, accountFreeNeurons, maximumTitlesPerRequest, model };
}

function neurons(microunits: number): number {
  return microunits / NEURON_MICRO_UNITS;
}

export function presentAiUsage(row: AiUsageRow) {
  const mediaRemaining = Math.max(0,
    row.media_daily_budget_neuron_microunits - row.accounted_neuron_microunits);
  const estimatedCloudflareRemaining = Math.max(0,
    row.account_free_neuron_microunits - row.accounted_neuron_microunits);
  return {
    utc_date: row.usage_date,
    ai_requests: row.ai_requests,
    ai_titles_attempted: row.ai_titles_attempted,
    legacy_usage_unknown_requests: row.legacy_usage_unknown_requests,
    titles_generated_successfully: row.titles_generated_successfully,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    calculated_neurons_used: neurons(row.calculated_neuron_microunits),
    outstanding_reserved_neurons: neurons(row.outstanding_reserved_neuron_microunits),
    media_neurons_accounted_or_reserved: neurons(row.accounted_neuron_microunits),
    media_daily_neuron_budget: neurons(row.media_daily_budget_neuron_microunits),
    media_budget_remaining: neurons(mediaRemaining),
    configured_cloudflare_free_allocation_neurons:
      neurons(row.account_free_neuron_microunits),
    estimated_cloudflare_free_neurons_remaining: neurons(estimatedCloudflareRemaining),
    exact_neuron_microunits: {
      calculated_used: row.calculated_neuron_microunits,
      outstanding_reserved: row.outstanding_reserved_neuron_microunits,
      accounted_or_reserved: row.accounted_neuron_microunits,
      media_budget_remaining: mediaRemaining,
      estimated_cloudflare_free_remaining: estimatedCloudflareRemaining,
    },
  };
}

async function aiUsage(env: MediaAdminEnv, limit: number): Promise<Response> {
  const configured = configuredAiUsageLimits(env);
  const { results } = await env.MEDIA_DB.prepare(`SELECT usage_date,
      coalesce(sum(CASE WHEN request_started_at IS NOT NULL THEN request_count ELSE 0 END), 0)
        AS ai_requests,
      coalesce(sum(CASE WHEN request_started_at IS NOT NULL THEN titles_attempted ELSE 0 END), 0)
        AS ai_titles_attempted,
      coalesce(sum(CASE WHEN record_kind = 'legacy_daily_call_counter'
        THEN request_count ELSE 0 END), 0) AS legacy_usage_unknown_requests,
      coalesce(sum(titles_generated), 0) AS titles_generated_successfully,
      coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
      coalesce(sum(completion_tokens), 0) AS completion_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens,
      coalesce(sum(CASE WHEN accounting_state = 'reconciled'
        THEN actual_neuron_microunits ELSE 0 END), 0) AS calculated_neuron_microunits,
      coalesce(sum(CASE WHEN accounting_state = 'reserved'
        THEN reserved_neuron_microunits ELSE 0 END), 0)
        AS outstanding_reserved_neuron_microunits,
      coalesce(sum(CASE WHEN accounting_state = 'reconciled'
        THEN actual_neuron_microunits ELSE reserved_neuron_microunits END), 0)
        AS accounted_neuron_microunits,
      min(media_daily_budget_neuron_microunits) AS media_daily_budget_neuron_microunits,
      min(account_free_neuron_microunits) AS account_free_neuron_microunits
    FROM media_ai_neuron_requests GROUP BY usage_date
    ORDER BY usage_date DESC LIMIT ?`).bind(limit).all<AiUsageRow>();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [...results];
  if (!rows.some(row => row.usage_date === today)) {
    rows.unshift({ usage_date: today, ai_requests: 0, ai_titles_attempted: 0,
      legacy_usage_unknown_requests: 0,
      titles_generated_successfully: 0, prompt_tokens: 0, completion_tokens: 0,
      total_tokens: 0, calculated_neuron_microunits: 0,
      outstanding_reserved_neuron_microunits: 0, accounted_neuron_microunits: 0,
      media_daily_budget_neuron_microunits: configured.dailyBudgetNeurons * NEURON_MICRO_UNITS,
      account_free_neuron_microunits: configured.accountFreeNeurons * NEURON_MICRO_UNITS });
    if (rows.length > limit) rows.pop();
  }
  return json({
    usage_days: rows.map(presentAiUsage),
    configured_limits: {
      media_daily_neuron_budget: configured.dailyBudgetNeurons,
      configured_cloudflare_free_allocation_neurons: configured.accountFreeNeurons,
    },
    accounting: {
      fixed_point_unit: 'one-millionth of a neuron',
      microunits_per_neuron: NEURON_MICRO_UNITS,
      cloudflare_remaining_is_estimate: true,
      cloudflare_estimate_scope: 'Media D1-recorded requests only; unrelated or manual account calls are not visible',
    },
  });
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'json_content_type_required');
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_ADMIN_BODY_BYTES) {
    throw new HttpError(413, 'request_body_too_large');
  }
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ADMIN_BODY_BYTES) throw new HttpError(413, 'request_body_too_large');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json');
  } finally {
    try { await reader.cancel('admin body read complete or rejected'); } catch { /* best effort */ }
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new HttpError(400, 'invalid_json'); }
}

async function boundedOptionalJson(request: Request): Promise<unknown> {
  if (request.body === null || request.headers.get('content-length') === '0') return {};
  return boundedJson(request);
}

function normaliseHumanDisplayTitle(value: string | null): string | null {
  if (value === null) return null;
  if (/[\r\n\u2028\u2029]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, 'invalid_display_title');
  }
  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!title || [...title].length > MAX_HUMAN_DISPLAY_TITLE_CHARACTERS) {
    throw new HttpError(400, 'invalid_display_title');
  }
  return title;
}

async function decideAiTitle(db: D1Database, id: number,
  decision: 'accept' | 'reject'): Promise<Response> {
  const now = new Date().toISOString();
  const changed = decision === 'accept'
    ? await db.prepare(`UPDATE media_articles SET
        display_title = ai_title_suggestion, display_title_origin = 'ai',
        ai_title_suggestion_state = 'accepted', ai_title_decided_at = ?, updated_at = ?
        WHERE id = ? AND ai_title_suggestion_state = 'pending'
          AND ai_title_suggestion IS NOT NULL
        RETURNING id, status, title, display_title, display_title_origin,
          ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
      .bind(now, now, id).first<TitleMutationRow>()
    : await db.prepare(`UPDATE media_articles SET
        ai_title_suggestion_state = 'rejected', ai_title_decided_at = ?, updated_at = ?
        WHERE id = ? AND ai_title_suggestion_state = 'pending'
          AND ai_title_suggestion IS NOT NULL
        RETURNING id, status, title, display_title, display_title_origin,
          ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
      .bind(now, now, id).first<TitleMutationRow>();
  if (changed) {
    await reconcileHomepageLatestSix(db);
    return json({ article: changed });
  }
  const exists = await db.prepare('SELECT id FROM media_articles WHERE id = ?').bind(id).first();
  throw new HttpError(exists ? 409 : 404,
    exists ? 'no_pending_ai_title_suggestion' : 'article_not_found');
}

async function setHumanDisplayTitle(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = ManualDisplayTitleBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_display_title_body');
  const displayTitle = normaliseHumanDisplayTitle(parsed.data.display_title);
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
    display_title = ?,
    display_title_origin = CASE WHEN ? IS NULL THEN NULL ELSE 'human' END,
    ai_title_suggestion_state = CASE
      WHEN ? IS NOT NULL AND ai_title_suggestion_state = 'pending' THEN 'rejected'
      ELSE ai_title_suggestion_state END,
    ai_title_decided_at = CASE
      WHEN ? IS NOT NULL AND ai_title_suggestion_state = 'pending' THEN ?
      ELSE ai_title_decided_at END,
    updated_at = ?
    WHERE id = ?
    RETURNING id, status, title, display_title, display_title_origin,
      ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
    .bind(displayTitle, displayTitle, displayTitle, displayTitle, now, now, id)
    .first<TitleMutationRow>();
  if (!changed) throw new HttpError(404, 'article_not_found');
  await reconcileHomepageLatestSix(db);
  return json({ article: changed });
}

const EXPLICIT_TITLE_RETURNING = `id, status, title, display_title, display_title_origin,
  ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at, publisher, author,
  approval_method, approved_at, ai_title_attempted_at, ai_title_model,
  ai_title_prompt_version, ai_title_generated_at`;

export const EXPLICIT_DISPLAY_TITLE_UPDATE_SQL = `UPDATE media_articles SET
  ai_title_attempted_at = ?, ai_title_suggestion = ?, ai_title_suggestion_state = 'pending',
  ai_title_model = ?, ai_title_prompt_version = ?, ai_title_generated_at = ?,
  ai_title_decided_at = NULL, updated_at = ? WHERE id = ? RETURNING ${EXPLICIT_TITLE_RETURNING}`;

async function explicitTitleArticle(db: D1Database, id: number): Promise<ExplicitTitleArticleRow | null> {
  return db.prepare(`SELECT ${EXPLICIT_TITLE_RETURNING} FROM media_articles WHERE id = ?`)
    .bind(id).first<ExplicitTitleArticleRow>();
}

function presentExplicitGeneration(article: ExplicitTitleArticleRow, replayed: boolean) {
  return json({ article, generation: {
    outcome: article.ai_title_suggestion === article.title
      ? 'no_change' : 'suggested',
    replayed,
  } });
}

async function replayExplicitGeneration(db: D1Database, id: number,
  logicalRequestKey: string): Promise<Response | null> {
  const ledger = await db.prepare(`SELECT request_started_at, completed_at, titles_generated
    FROM media_ai_neuron_requests WHERE logical_request_key = ?`).bind(logicalRequestKey)
    .first<{ request_started_at: string | null; completed_at: string | null;
      titles_generated: number }>();
  if (!ledger) return null;
  if (!ledger.completed_at) throw new HttpError(409, 'ai_title_generation_in_progress');
  const article = await explicitTitleArticle(db, id);
  if (!article) throw new HttpError(404, 'article_not_found');
  if (ledger.titles_generated === 1 && article.ai_title_generated_at === ledger.completed_at &&
      article.ai_title_suggestion) return presentExplicitGeneration(article, true);
  throw new HttpError(409, ledger.titles_generated === 0
    ? 'ai_title_generation_produced_no_valid_suggestion'
    : 'ai_title_generation_replay_result_no_longer_current');
}

async function generateExplicitAiTitle(request: Request, env: MediaAdminEnv,
  id: number): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  const logicalRequestKey = `admin-display-title:${id}:${key}`;
  const replay = await replayExplicitGeneration(env.MEDIA_DB, id, logicalRequestKey);
  if (replay) return replay;
  const article = await explicitTitleArticle(env.MEDIA_DB, id);
  if (!article) throw new HttpError(404, 'article_not_found');
  const configured = configuredAiUsageLimits(env);
  const outcome = await suggestDisplayTitleExplicit({
    publisher: article.publisher,
    title: article.title,
    title_context: null,
    author: article.author,
    categories: [],
  }, new WorkersAiDisplayTitleProvider(env.AI, configured.model),
  new LocalRequestBudget(1),
  new D1DisplayTitleNeuronLedger(env.MEDIA_DB, configured.maximumTitlesPerRequest),
  logicalRequestKey, configured.dailyBudgetNeurons, configured.accountFreeNeurons,
  configured.maximumTitlesPerRequest);
  if (outcome.status === 'skipped' && outcome.reason === 'duplicate_request') {
    const duplicate = await replayExplicitGeneration(env.MEDIA_DB, id, logicalRequestKey);
    if (duplicate) return duplicate;
  }
  if (outcome.status === 'skipped') {
    throw new HttpError(outcome.reason === 'daily_neuron_budget' ? 429 : 503,
      `ai_title_generation_${outcome.reason}`);
  }
  if (outcome.status === 'failed') {
    throw new HttpError(502, `ai_title_generation_${outcome.reason}`);
  }
  const stored = await env.MEDIA_DB.prepare(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL)
    .bind(outcome.provenance.generated_at, outcome.title, outcome.provenance.model,
      outcome.provenance.version, outcome.provenance.generated_at,
      outcome.provenance.generated_at, id).first<ExplicitTitleArticleRow>();
  if (!stored) throw new HttpError(404, 'article_not_found');
  return presentExplicitGeneration(stored, false);
}

function presentGuardianImageCandidate(candidate: GuardianPreviewCandidate | null) {
  return candidate ? {
    url: candidate.url,
    kind: candidate.kind,
    width: candidate.width,
    height: candidate.height,
  } : null;
}

async function guardianImageRefreshProposal(db: D1Database, id: number,
  routeKey: string): Promise<{ row: GuardianImageRow; lookup: GuardianPreviewLookup }> {
  if (!GUARDIAN_ROUTES.some(route => route.route_key === routeKey)) {
    throw new HttpError(400, 'invalid_guardian_route_key');
  }
  const row = await db.prepare(`SELECT id, source_key, canonical_url, title, status,
      og_image_url, image_policy, preview_metadata_checked_at
    FROM media_articles WHERE id = ?`).bind(id).first<GuardianImageRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  if (row.source_key !== 'the-guardian') {
    throw new HttpError(409, 'guardian_image_refresh_requires_guardian_article');
  }
  if (row.image_policy !== 'remote_preview') {
    throw new HttpError(409, 'guardian_image_refresh_blocked');
  }
  const source = await loadSource(db, 'the-guardian');
  if (!source || !source.enabled || source.image_policy !== 'remote_preview') {
    throw new HttpError(409, 'guardian_image_refresh_blocked');
  }
  let lookup: GuardianPreviewLookup;
  try {
    lookup = await discoverGuardianPreviewForArticle(source, routeKey,
      row.canonical_url, row.og_image_url);
  } catch {
    throw new HttpError(502, 'guardian_rss_preview_unavailable');
  }
  if (!lookup.article_found) {
    throw new HttpError(409, 'guardian_article_not_in_current_route');
  }
  if (!lookup.proposed) {
    throw new HttpError(409, 'guardian_rss_preview_unavailable');
  }
  return { row, lookup };
}

function guardianImageRefreshView(row: GuardianImageRow, lookup: GuardianPreviewLookup,
  routeKey: string) {
  const proposed = lookup.proposed;
  const replacementRequired = proposed !== null && row.og_image_url !== proposed.url;
  return {
    article: {
      id: row.id,
      title: row.title,
      canonical_url: row.canonical_url,
      status: row.status,
    },
    route_key: routeKey,
    current_image: row.og_image_url === null ? null : {
      url: row.og_image_url,
      kind: lookup.current?.kind ?? null,
      width: lookup.current?.width ?? null,
      height: lookup.current?.height ?? null,
      present_in_current_rss: lookup.current !== null,
      origin: 'unknown',
    },
    proposed_image: presentGuardianImageCandidate(proposed),
    replacement_required: replacementRequired,
    individual_confirmation_required: row.og_image_url !== null && replacementRequired,
  };
}

async function previewGuardianImageRefresh(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = GuardianImagePreviewBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_image_preview_body');
  const { row, lookup } = await guardianImageRefreshProposal(db, id, parsed.data.route_key);
  return json({ refresh: guardianImageRefreshView(row, lookup, parsed.data.route_key) });
}

async function applyGuardianImageRefresh(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = GuardianImageApplyBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_image_apply_body');
  const input = parsed.data;
  const { row, lookup } = await guardianImageRefreshProposal(db, id, input.route_key);
  if (row.og_image_url !== input.expected_current_image_url) {
    throw new HttpError(409, 'guardian_image_refresh_stale_current_image');
  }
  if (lookup.proposed?.url !== input.proposed_image_url) {
    throw new HttpError(409, 'guardian_image_refresh_stale_proposal');
  }
  if (row.og_image_url === lookup.proposed.url) {
    return json({ changed: false,
      refresh: guardianImageRefreshView(row, lookup, input.route_key) });
  }
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
      og_image_url = ?, preview_metadata_checked_at = ?, updated_at = ?
    WHERE id = ? AND source_key = 'the-guardian' AND image_policy = 'remote_preview'
      AND og_image_url IS ?
    RETURNING id, source_key, canonical_url, title, status, og_image_url, image_policy,
      preview_metadata_checked_at`).bind(lookup.proposed.url, now, now, id,
        input.expected_current_image_url).first<GuardianImageRow>();
  if (!changed) throw new HttpError(409, 'guardian_image_refresh_stale_current_image');
  await reconcileHomepageLatestSix(db);
  return json({ changed: true,
    refresh: guardianImageRefreshView(changed, {
      ...lookup,
      current: lookup.proposed,
    }, input.route_key) });
}

async function previewBulkGuardianImageRefresh(db: D1Database): Promise<Response> {
  return json({ repair: await buildGuardianImageRepairPlan(db) });
}

async function applyBulkGuardianImageRefresh(request: Request,
  db: D1Database): Promise<Response> {
  const parsed = GuardianBulkImageApplyBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_bulk_image_apply_body');
  const plan = await buildGuardianImageRepairPlan(db);
  requireCurrentGuardianImageRepairPlan(plan, parsed.data.repair_token);
  const changedArticleIds = await applyGuardianImageRepairPlan(db, plan);
  await reconcileHomepageLatestSix(db);
  return json({ repair: {
    ...plan,
    apply: {
      changed_rows: changedArticleIds.length,
      changed_article_ids: changedArticleIds,
      unchanged_rows: plan.counts.already_best_rows,
      skipped_rows: plan.counts.ambiguous_existing_image_rows +
        plan.counts.rows_outside_current_rss + plan.counts.conflicting_proposal_rows +
        plan.counts.no_permitted_candidate_rows +
        (plan.changes.length - changedArticleIds.length),
      compare_and_swap_skipped_rows: plan.changes.length - changedArticleIds.length,
    },
  } });
}

async function blueskySettings(request: Request, env: MediaAdminEnv): Promise<Response> {
  const present = (settings: Record<string, unknown> | null, replayed?: boolean) => {
    const template = typeof settings?.default_message_template === 'string'
      ? settings.default_message_template : '';
    let literalGraphemes: number | null = null;
    try { literalGraphemes = validateBlueskyTemplate(template).literalGraphemes; } catch { /* invalid D1 state */ }
    return { account: '@ukaq.co.uk', settings: settings ? { ...settings,
      publishing_enabled: Boolean(settings.publishing_enabled),
      default_message_literal_graphemes: literalGraphemes } : null,
    constraints: { default_message_literal_graphemes: BLUESKY_TEMPLATE_LITERAL_GRAPHEMES,
      post_graphemes: BLUESKY_POST_GRAPHEMES, post_bytes: BLUESKY_POST_BYTES,
      cooldown_minutes_min: 1, cooldown_minutes_max: 1440,
      placeholders: [...BLUESKY_PLACEHOLDERS] },
    example: { title: 'Example display title for an air-quality article',
      publisher: 'Example Publisher', publisher_mention: '@example.bsky.social' },
    ...(replayed === undefined ? {} : { replayed }) };
  };
  if (request.method === 'GET') {
    const settings = await env.MEDIA_DB.prepare(`SELECT publishing_enabled, cooldown_seconds,
      default_message_template, activation_event_id, last_successful_post_at, updated_at
      FROM media_bluesky_settings WHERE id = 1`).first();
    return json(present(settings));
  }
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const parsed = BlueskySettingsBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_bluesky_settings');
  try { validateBlueskyTemplate(parsed.data.default_message_template); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'message_template_invalid'); }
  const requestJson = JSON.stringify(parsed.data);
  const replay = await env.MEDIA_DB.prepare(`SELECT request_json FROM media_bluesky_settings_requests
    WHERE request_key = ?`).bind(key).first<{ request_json: string }>();
  if (replay && replay.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
  const now = new Date().toISOString();
  // COALESCE captures the high watermark once only, in the same D1 statement that enables.
  if (!replay) await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare(`UPDATE media_bluesky_settings SET publishing_enabled = ?,
      cooldown_seconds = ?, default_message_template = ?,
      activation_event_id = CASE WHEN ? = 1 THEN coalesce(activation_event_id,
        (SELECT coalesce(max(id), 0) FROM media_article_events)) ELSE activation_event_id END,
      updated_at = ? WHERE id = 1`).bind(Number(parsed.data.publishing_enabled),
        parsed.data.cooldown_minutes * 60, parsed.data.default_message_template,
        Number(parsed.data.publishing_enabled), now),
    env.MEDIA_DB.prepare(`INSERT INTO media_bluesky_settings_requests
      (request_key, request_json, created_at) VALUES (?, ?, ?)`).bind(key, requestJson, now),
  ]);
  if (!replay && parsed.data.publishing_enabled) {
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed' })); }
  }
  const settings = await env.MEDIA_DB.prepare(`SELECT publishing_enabled, cooldown_seconds,
    default_message_template, activation_event_id, last_successful_post_at, updated_at
    FROM media_bluesky_settings WHERE id = 1`).first();
  return json(present(settings, Boolean(replay)));
}

async function mutate(request: Request, env: MediaAdminEnv, id: number, action: Action): Promise<Response> {
  const db = env.MEDIA_DB;
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const eventKey = `admin:${key}`;
  const transition = transitions[action];
  const parsedBody = StatusMutationBody.safeParse(await boundedOptionalJson(request));
  if (!parsedBody.success) throw new HttpError(400, 'invalid_status_mutation_body');
  const requestedPost = parsedBody.data.post_to_bluesky === true;
  const replay = await db.prepare(`SELECT article_id, event_type, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey)
    .first<{ article_id: number; event_type: string; to_status: Status; revision: number }>();
  if (replay) {
    if (replay.article_id !== id || replay.event_type !== transition.event) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    const publication = await db.prepare(`SELECT id, status FROM media_bluesky_publications
      WHERE publication_key = ?`).bind(`admin-request:${key}`).first();
    if (requestedPost !== Boolean(publication)) throw new HttpError(409, 'idempotency_key_conflict');
    await reconcileHomepageLatestSix(db);
    return json({ article: { id, status: replay.to_status, revision: replay.revision },
      bluesky_publication: publication, replayed: true });
  }
  const before = await db.prepare(`SELECT status, og_image_url, image_policy,
    (SELECT image_policy FROM media_sources WHERE source_key = a.source_key) AS source_image_policy
    FROM media_articles a WHERE id = ?`).bind(id).first<{
      status: Status; og_image_url: string | null; image_policy: string; source_image_policy: string }>();
  if (!before) throw new HttpError(404, 'article_not_found');
  const manualReason = action === 'approve' && before.status === 'rejected' ? 'rejected_repost'
    : action === 'unhide' && before.status === 'hidden' ? 'unhidden_repost' : null;
  if (requestedPost && !manualReason) throw new HttpError(400, 'post_to_bluesky_not_available');
  if (requestedPost && (!before.og_image_url || before.image_policy !== 'remote_preview' ||
      before.source_image_policy !== 'remote_preview')) throw new HttpError(409, 'thumbnail_missing');
  const now = new Date().toISOString();
  const placeholders = transition.from.map(() => '?').join(', ');
  // D1 batch is transactional: the status trigger's event and optional manual
  // outbox row commit together or neither does.
  const statements = [db.prepare(`UPDATE media_articles SET status = ?, mutation_key = ?,
    revision = revision + 1, updated_at = ?,
    approval_method = CASE WHEN ? IN ('approve', 'unhide') THEN 'manual' ELSE approval_method END,
    approval_author_rule_key = CASE WHEN ? IN ('approve', 'unhide') THEN NULL ELSE approval_author_rule_key END,
    approved_at = CASE WHEN ? IN ('approve', 'unhide') THEN ? ELSE approved_at END,
    rejected_at = CASE WHEN ? = 'reject' THEN ? ELSE rejected_at END,
    hidden_at = CASE WHEN ? = 'hide' THEN ? WHEN ? = 'unhide' THEN NULL ELSE hidden_at END
    WHERE id = ? AND status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ?)
    `).bind(transition.to, eventKey, now,
      action, action, action, now, action, now, action, now, action, id,
      ...transition.from, eventKey)];
  if (requestedPost && manualReason) {
    statements.push(db.prepare(`INSERT INTO media_bluesky_publications
        (article_id, approval_event_id, publication_key, publication_reason, status, created_at, updated_at)
        SELECT ?, NULL, ?, ?, 'queued', ?, ?
        WHERE EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ? AND article_id = ?)`)
      .bind(id, `admin-request:${key}`, manualReason, now, now, eventKey, id));
  }
  await db.batch(statements);
  const event = await db.prepare(`SELECT article_id, event_type, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey)
    .first<{ article_id: number; event_type: string; to_status: Status; revision: number }>();
  if (event) {
    await reconcileHomepageLatestSix(db);
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed', article_id: id })); }
    const publication = await db.prepare(`SELECT id, status FROM media_bluesky_publications
      WHERE publication_key = ?`).bind(`admin-request:${key}`).first();
    return json({ article: { id, status: event.to_status, revision: event.revision },
      bluesky_publication: publication, replayed: false });
  }
  const exists = await db.prepare('SELECT id FROM media_articles WHERE id = ?').bind(id).first();
  throw new HttpError(exists ? 409 : 404, exists ? 'invalid_state_transition' : 'article_not_found');
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      // MEDIA_SYNC_TOKEN is reserved for future read-only sync routes; never accepted here.
      if (!await bearerMatches(request, env.MEDIA_ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const url = new URL(request.url);
      if (url.pathname === '/admin/bluesky/settings') return await blueskySettings(request, env);
      const editorialResponse = await handleEditorialDashboard(request, env, url);
      if (editorialResponse) return editorialResponse;
      const bulkImageRefresh = /^\/admin\/guardian-image-refresh\/(preview|apply)$/.exec(url.pathname);
      if (bulkImageRefresh) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return bulkImageRefresh[1] === 'preview'
          ? await previewBulkGuardianImageRefresh(env.MEDIA_DB)
          : await applyBulkGuardianImageRefresh(request, env.MEDIA_DB);
      }
      const imageRefresh = /^\/admin\/articles\/([1-9]\d*)\/guardian-image-refresh\/(preview|apply)$/.exec(url.pathname);
      if (imageRefresh) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(imageRefresh[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return imageRefresh[2] === 'preview'
          ? await previewGuardianImageRefresh(request, env.MEDIA_DB, id)
          : await applyGuardianImageRefresh(request, env.MEDIA_DB, id);
      }
      const titleDecision = /^\/admin\/articles\/([1-9]\d*)\/display-title\/(accept-ai|reject-ai)$/.exec(url.pathname);
      if (titleDecision) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleDecision[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await decideAiTitle(env.MEDIA_DB, id,
          titleDecision[2] === 'accept-ai' ? 'accept' : 'reject');
      }
      const titleGeneration = /^\/admin\/articles\/([1-9]\d*)\/display-title\/generate-ai$/.exec(url.pathname);
      if (titleGeneration) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleGeneration[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await generateExplicitAiTitle(request, env, id);
      }
      const titleEdit = /^\/admin\/articles\/([1-9]\d*)\/display-title$/.exec(url.pathname);
      if (titleEdit) {
        if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleEdit[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await setHumanDisplayTitle(request, env.MEDIA_DB, id);
      }
      if (url.pathname === '/admin/ai-usage') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await aiUsage(env, boundedLimit(url));
      }
      const match = /^\/admin\/articles\/([1-9]\d*)\/(approve|reject|hide|unhide)$/.exec(url.pathname);
      if (match) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await mutate(request, env, id, match[2] as Action);
      }
      if (!['/admin/articles', '/admin/sources', '/admin/runs', '/admin/runs/gdelt'].includes(url.pathname)) {
        return json({ error: 'not_found' }, 404);
      }
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      if (url.pathname === '/admin/articles') {
        const status = url.searchParams.get('status');
        if (status !== null && !ArticleStatus.safeParse(status).success) throw new HttpError(400, 'invalid_status');
        const statement = env.MEDIA_DB.prepare(`SELECT * FROM media_articles
          ${status ? 'WHERE status = ?' : ''} ORDER BY ${status ? 'feed_sort_at DESC' : 'updated_at DESC'}, id DESC LIMIT ?`);
        const { results } = await (status ? statement.bind(status, limit) : statement.bind(limit)).all();
        return json({ articles: results });
      }
      if (url.pathname === '/admin/sources') {
        const { results } = await env.MEDIA_DB.prepare(`SELECT * FROM media_sources
          WHERE retired_at IS NULL ORDER BY source_key LIMIT ?`).bind(limit).all();
        return json({ sources: results });
      }
      if (url.pathname === '/admin/runs/gdelt') {
        const { results } = await env.MEDIA_DB.prepare(
          'SELECT * FROM media_gdelt_runs ORDER BY started_at DESC, id DESC LIMIT ?',
        ).bind(limit).all();
        return json({ runs: results });
      }
      const { results } = await env.MEDIA_DB.prepare(
        'SELECT * FROM media_discovery_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      ).bind(limit).all();
      return json({ runs: results });
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaAdminEnv>;
