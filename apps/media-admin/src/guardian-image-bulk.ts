import { HttpError, loadSource, type Status } from '@uk-aq-media/core';
import {
  discoverGuardianCurrentRssImageView,
  type GuardianPreviewCandidate,
  type GuardianRssArticleImageEvidence,
  type GuardianRssImageView,
  type GuardianRouteKey,
} from '@uk-aq-media/discovery';

const MAX_GUARDIAN_RSS_ARTICLES = 11 * 10;
const D1_URL_QUERY_CHUNK = 50;
const REPAIR_TOKEN_VERSION = 'guardian-image-repair-v1';

export type GuardianImageRepairRow = {
  id: number;
  canonical_url: string;
  title: string;
  status: Status;
  og_image_url: string | null;
};

export type GuardianImageRepairChange = {
  article_id: number;
  title: string;
  status: Status;
  current_url: string | null;
  proposed_url: string;
  current_kind: GuardianPreviewCandidate['kind'] | null;
  current_width: number | null;
  current_height: number | null;
  proposed_kind: GuardianPreviewCandidate['kind'];
  proposed_width: number | null;
  proposed_height: number | null;
  matching_route_keys: GuardianRouteKey[];
  change: 'replace' | 'fill';
};

export type GuardianImageRepairSkip = {
  article_id: number;
  title: string;
  current_url: string | null;
  proposed_url: string | null;
  reason: 'ambiguous_existing_image' | 'ambiguous_proposal' | 'no_permitted_candidate';
  matching_route_keys: GuardianRouteKey[];
};

export type GuardianImageRepairCounts = {
  total_existing_guardian_rows: number;
  eligible_remote_preview_rows: number;
  current_rss_article_observations: number;
  current_rss_articles_encountered: number;
  matched_guardian_rows: number;
  rows_proposed_for_replacement: number;
  null_images_proposed_for_fill: number;
  already_best_rows: number;
  ambiguous_existing_image_rows: number;
  rows_outside_current_rss: number;
  conflicting_proposal_rows: number;
  no_permitted_candidate_rows: number;
};

export type GuardianImageRepairPlan = {
  repair_token: string;
  routes_fetched: GuardianRouteKey[];
  counts: GuardianImageRepairCounts;
  changes: GuardianImageRepairChange[];
  skipped: GuardianImageRepairSkip[];
};

type GuardianRowCounts = {
  total_existing_guardian_rows: number;
  eligible_remote_preview_rows: number;
};

function exactCandidate(evidence: GuardianRssArticleImageEvidence,
  url: string | null) {
  return url === null ? null : evidence.candidates.find(candidate => candidate.url === url) ?? null;
}

function changeFor(row: GuardianImageRepairRow, evidence: GuardianRssArticleImageEvidence,
  proposed: GuardianPreviewCandidate): GuardianImageRepairChange {
  const current = exactCandidate(evidence, row.og_image_url);
  return {
    article_id: row.id,
    title: row.title,
    status: row.status,
    current_url: row.og_image_url,
    proposed_url: proposed.url,
    current_kind: current?.kind ?? null,
    current_width: current?.width ?? null,
    current_height: current?.height ?? null,
    proposed_kind: proposed.kind,
    proposed_width: proposed.width,
    proposed_height: proposed.height,
    matching_route_keys: evidence.route_keys,
    change: row.og_image_url === null ? 'fill' : 'replace',
  };
}

async function repairToken(changes: GuardianImageRepairChange[]): Promise<string> {
  const exactPlan = changes.map(change => ({
    article_id: change.article_id,
    expected_current_url: change.current_url,
    proposed_url: change.proposed_url,
    current_kind: change.current_kind,
    current_width: change.current_width,
    current_height: change.current_height,
    proposed_kind: change.proposed_kind,
    proposed_width: change.proposed_width,
    proposed_height: change.proposed_height,
    matching_route_keys: change.matching_route_keys,
    change: change.change,
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify({ version: REPAIR_TOKEN_VERSION, changes: exactPlan }),
  ));
  const hex = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')).join('');
  return `${REPAIR_TOKEN_VERSION}:${hex}`;
}

export async function planGuardianImageRepairs(view: GuardianRssImageView,
  rows: GuardianImageRepairRow[], totals: GuardianRowCounts): Promise<GuardianImageRepairPlan> {
  if (view.articles.size > MAX_GUARDIAN_RSS_ARTICLES || rows.length > MAX_GUARDIAN_RSS_ARTICLES) {
    throw new HttpError(503, 'guardian_image_repair_bound_exceeded');
  }
  const changes: GuardianImageRepairChange[] = [];
  const skipped: GuardianImageRepairSkip[] = [];
  let alreadyBest = 0;
  let ambiguousExisting = 0;
  let conflictingProposal = 0;
  let noPermittedCandidate = 0;
  for (const row of [...rows].sort((left, right) => left.id - right.id)) {
    const evidence = view.articles.get(row.canonical_url);
    if (!evidence) continue;
    if (evidence.ambiguous_proposal) {
      conflictingProposal++;
      skipped.push({ article_id: row.id, title: row.title,
        current_url: row.og_image_url, proposed_url: null,
        reason: 'ambiguous_proposal', matching_route_keys: evidence.route_keys });
      continue;
    }
    if (!evidence.proposed) {
      noPermittedCandidate++;
      skipped.push({ article_id: row.id, title: row.title,
        current_url: row.og_image_url, proposed_url: null,
        reason: 'no_permitted_candidate', matching_route_keys: evidence.route_keys });
      continue;
    }
    if (row.og_image_url === evidence.proposed.url) {
      alreadyBest++;
      continue;
    }
    if (row.og_image_url !== null && !exactCandidate(evidence, row.og_image_url)) {
      ambiguousExisting++;
      skipped.push({ article_id: row.id, title: row.title,
        current_url: row.og_image_url, proposed_url: evidence.proposed.url,
        reason: 'ambiguous_existing_image', matching_route_keys: evidence.route_keys });
      continue;
    }
    changes.push(changeFor(row, evidence, evidence.proposed));
  }
  const replacementCount = changes.filter(change => change.change === 'replace').length;
  const fillCount = changes.length - replacementCount;
  return {
    repair_token: await repairToken(changes),
    routes_fetched: view.routes_fetched,
    counts: {
      ...totals,
      current_rss_article_observations: view.article_observations,
      current_rss_articles_encountered: view.articles.size,
      matched_guardian_rows: rows.length,
      rows_proposed_for_replacement: replacementCount,
      null_images_proposed_for_fill: fillCount,
      already_best_rows: alreadyBest,
      ambiguous_existing_image_rows: ambiguousExisting,
      rows_outside_current_rss: Math.max(0,
        totals.eligible_remote_preview_rows - rows.length),
      conflicting_proposal_rows: conflictingProposal,
      no_permitted_candidate_rows: noPermittedCandidate,
    },
    changes,
    skipped,
  };
}

export function requireCurrentGuardianImageRepairPlan(plan: GuardianImageRepairPlan,
  suppliedToken: string): void {
  if (plan.repair_token !== suppliedToken) {
    throw new HttpError(409, 'guardian_image_repair_plan_changed');
  }
}

async function loadMatchingGuardianRows(db: D1Database,
  view: GuardianRssImageView): Promise<{ rows: GuardianImageRepairRow[]; totals: GuardianRowCounts }> {
  const urls = [...view.articles.keys()];
  const countsPromise = db.prepare(`SELECT count(*) AS total_existing_guardian_rows,
      coalesce(sum(CASE WHEN image_policy = 'remote_preview' THEN 1 ELSE 0 END), 0)
        AS eligible_remote_preview_rows
    FROM media_articles WHERE source_key = 'the-guardian'`).first<GuardianRowCounts>();
  const rowPromises: Array<Promise<D1Result<GuardianImageRepairRow>>> = [];
  for (let offset = 0; offset < urls.length; offset += D1_URL_QUERY_CHUNK) {
    const chunk = urls.slice(offset, offset + D1_URL_QUERY_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    rowPromises.push(db.prepare(`SELECT id, canonical_url, title, status, og_image_url
      FROM media_articles WHERE source_key = 'the-guardian'
        AND image_policy = 'remote_preview' AND canonical_url IN (${placeholders})
      ORDER BY id`).bind(...chunk).all<GuardianImageRepairRow>());
  }
  const [totals, ...rowResults] = await Promise.all([countsPromise, ...rowPromises]);
  if (!totals) throw new HttpError(503, 'guardian_image_repair_counts_unavailable');
  return { totals, rows: rowResults.flatMap(result => result.results) };
}

export async function buildGuardianImageRepairPlan(
  db: D1Database,
): Promise<GuardianImageRepairPlan> {
  const source = await loadSource(db, 'the-guardian');
  if (!source || !source.enabled || source.image_policy !== 'remote_preview') {
    throw new HttpError(409, 'guardian_image_refresh_blocked');
  }
  const view = await discoverGuardianCurrentRssImageView(source);
  const { rows, totals } = await loadMatchingGuardianRows(db, view);
  return planGuardianImageRepairs(view, rows, totals);
}

export async function applyGuardianImageRepairPlan(db: D1Database,
  plan: GuardianImageRepairPlan): Promise<number[]> {
  if (plan.changes.length === 0) return [];
  if (plan.changes.length > MAX_GUARDIAN_RSS_ARTICLES) {
    throw new HttpError(503, 'guardian_image_repair_bound_exceeded');
  }
  const repairs = JSON.stringify(plan.changes.map(change => ({
    id: change.article_id,
    expected: change.current_url,
    proposed: change.proposed_url,
  })));
  const now = new Date().toISOString();
  const { results } = await db.prepare(`WITH repairs AS (
      SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS id,
        json_extract(value, '$.expected') AS expected,
        json_extract(value, '$.proposed') AS proposed
      FROM json_each(?)
    )
    UPDATE media_articles
    SET og_image_url = (SELECT proposed FROM repairs WHERE repairs.id = media_articles.id),
      preview_metadata_checked_at = ?, updated_at = ?
    WHERE source_key = 'the-guardian' AND image_policy = 'remote_preview'
      AND EXISTS (
        SELECT 1 FROM repairs WHERE repairs.id = media_articles.id
          AND media_articles.og_image_url IS repairs.expected
      )
    RETURNING id`).bind(repairs, now, now).all<{ id: number }>();
  return results.map(row => row.id).sort((left, right) => left - right);
}
