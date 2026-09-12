import { ArticleStatus, bearerMatches, boundedLimit, HttpError, httpFailure, json, z,
  loadSource, type Status } from '@uk-aq-media/core';
import {
  discoverGuardianPreviewForArticle, GUARDIAN_ROUTES,
  type GuardianPreviewCandidate, type GuardianPreviewLookup,
} from '@uk-aq-media/discovery';
import {
  applyGuardianImageRepairPlan, buildGuardianImageRepairPlan,
  requireCurrentGuardianImageRepairPlan,
} from './guardian-image-bulk';
import { handleEditorialDashboard } from './editorial-dashboard';

type Action = 'approve' | 'reject' | 'hide' | 'unhide';
const transitions: Record<Action, { from: Status[]; to: Status; event: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', event: 'approved' },
  reject: { from: ['pending', 'approved', 'hidden'], to: 'rejected', event: 'rejected' },
  hide: { from: ['pending', 'approved', 'rejected'], to: 'hidden', event: 'hidden' },
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
} {
  const dailyBudgetNeurons = Number(env.MEDIA_AI_DAILY_NEURON_BUDGET);
  const accountFreeNeurons = Number(env.MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY);
  if (!Number.isSafeInteger(dailyBudgetNeurons) || dailyBudgetNeurons < 1 ||
      !Number.isSafeInteger(accountFreeNeurons) || accountFreeNeurons < 1 ||
      dailyBudgetNeurons > accountFreeNeurons ||
      !Number.isSafeInteger(dailyBudgetNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(accountFreeNeurons * NEURON_MICRO_UNITS)) {
    throw new HttpError(503, 'ai_usage_configuration_invalid');
  }
  return { dailyBudgetNeurons, accountFreeNeurons };
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
  if (changed) return json({ article: changed });
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
  return json({ article: changed });
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

async function mutate(request: Request, db: D1Database, id: number, action: Action): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const eventKey = `admin:${key}`;
  const transition = transitions[action];
  const now = new Date().toISOString();
  const placeholders = transition.from.map(() => '?').join(', ');
  // One UPDATE plus its trigger is atomic, including the unique idempotency event key.
  const changed = await db.prepare(`UPDATE media_articles SET status = ?, mutation_key = ?,
    revision = revision + 1, updated_at = ?,
    approval_method = CASE WHEN ? = 'approve' THEN 'manual' ELSE approval_method END,
    approval_author_rule_key = CASE WHEN ? = 'approve' THEN NULL ELSE approval_author_rule_key END,
    approved_at = CASE WHEN ? = 'approve' THEN ? ELSE approved_at END,
    rejected_at = CASE WHEN ? = 'reject' THEN ? ELSE rejected_at END,
    hidden_at = CASE WHEN ? = 'hide' THEN ? WHEN ? = 'unhide' THEN NULL ELSE hidden_at END
    WHERE id = ? AND status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ?)
    RETURNING id, status, revision`).bind(transition.to, eventKey, now,
      action, action, action, now, action, now, action, now, action, id,
      ...transition.from, eventKey)
    .first<{ id: number; status: Status; revision: number }>();
  if (changed) return json({ article: changed, replayed: false });
  const event = await db.prepare(`SELECT article_id, event_type, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey)
    .first<{ article_id: number; event_type: string; to_status: Status; revision: number }>();
  if (event) {
    if (event.article_id !== id || event.event_type !== transition.event) throw new HttpError(409, 'idempotency_key_conflict');
    // Return the original mutation receipt; it need not be the article's current state.
    return json({ article: { id, status: event.to_status, revision: event.revision }, replayed: true });
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
        return await mutate(request, env.MEDIA_DB, id, match[2] as Action);
      }
      if (!['/admin/articles', '/admin/sources', '/admin/runs'].includes(url.pathname)) {
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
      const { results } = await env.MEDIA_DB.prepare(
        'SELECT * FROM media_discovery_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      ).bind(limit).all();
      return json({ runs: results });
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaAdminEnv>;
