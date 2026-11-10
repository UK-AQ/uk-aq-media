import { HttpError, json, z, populateSyndicationMetadata, publicSyndicationVisibilitySql,
  reconcileHomepageLatestSixStatement, SYNDICATION_NORMALISATION } from '@uk-aq-media/core';

const MemberDecision = z.object({
  article_id: z.number().int().positive(), metadata_revision: z.number().int().nonnegative(),
  classification: z.enum(['candidate', 'confirmed_syndicated', 'confirmed_same_text', 'not_duplicate', 'insufficient_evidence']),
  suppress: z.boolean(), reviewed_publisher_urls: z.boolean(), rationale: z.string().trim().min(1).max(500),
}).strict();
const Decision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), representative_article_id: z.number().int().positive(),
    representative_metadata_revision: z.number().int().nonnegative(),
    confirm_visibility_change: z.literal(true),
    decisions: z.array(MemberDecision).min(1).max(20) }).strict(),
  z.object({ action: z.literal('reset'), confirm_visibility_change: z.literal(true),
    rationale: z.string().trim().min(1).max(500) }).strict(),
]);
type Group = { id: number; normalised_title: string; representative_article_id: number | null;
  epoch: number; revision: number; created_at: string; updated_at: string };
type Member = { id: number; title: string; publisher: string; canonical_url: string;
  original_url: string; canonical_url_hash: string; published_at: string | null;
  discovered_at: string; status: string; metadata_revision: number; publisher_domain: string;
  classification: string | null; suppress: number | null; evidence_type: string | null;
  rationale: string | null; reviewed_at: string | null; decision_current: number; public_suppressed: number };
type Receipt = { id: number; group_id: number; revision: number; request_json: string;
  action: string; before_json: string; after_json: string; created_at: string };

function integer(value: string | null, fallback = 0): number {
  if (value === null) return fallback;
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, 'invalid_syndication_cursor');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'invalid_syndication_cursor');
  return parsed;
}
function parameters(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, 'invalid_syndication_parameters');
    }
  }
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError(415, 'json_content_type_required');
  }
  if (!request.body) throw new HttpError(400, 'syndication_body_required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12_000) throw new HttpError(413, 'syndication_body_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}
async function group(db: D1Database, id: number): Promise<Group> {
  const row = await db.prepare(`SELECT id, normalised_title, representative_article_id,
    epoch, revision, created_at, updated_at FROM media_syndication_groups WHERE id = ?`)
    .bind(id).first<Group>();
  if (!row) throw new HttpError(404, 'syndication_group_not_found');
  return row;
}
const MEMBER_SQL = `SELECT a.id, a.title, a.publisher, a.canonical_url, a.original_url,
  a.canonical_url_hash, a.published_at, a.discovered_at, a.status,
  m.revision AS metadata_revision, m.publisher_domain,
  CASE WHEN a.status = 'approved' AND NOT (${publicSyndicationVisibilitySql('a')})
    THEN 1 ELSE 0 END AS public_suppressed,
  r.classification, r.suppress, r.evidence_type, r.rationale, r.reviewed_at,
  CASE WHEN r.member_metadata_revision = m.revision AND rm.valid = 1
    AND rm.group_id = g.id AND r.representative_metadata_revision = rm.revision
    THEN 1 ELSE 0 END AS decision_current
  FROM media_syndication_metadata m JOIN media_articles a ON a.id = m.article_id
  JOIN media_syndication_groups g ON g.id = m.group_id
  LEFT JOIN media_syndication_reviews r ON r.group_id = g.id AND r.epoch = g.epoch
    AND r.article_id = a.id AND r.representative_article_id = g.representative_article_id
  LEFT JOIN media_syndication_metadata rm ON rm.article_id = g.representative_article_id
  WHERE m.group_id = ? AND m.valid = 1`;

async function list(db: D1Database, url: URL): Promise<Response> {
  parameters(url, ['after', 'view']);
  const after = integer(url.searchParams.get('after'));
  const view = url.searchParams.get('view') ?? 'open';
  if (!['open', 'all'].includes(view)) throw new HttpError(400, 'invalid_syndication_view');
  // Bound the key scan BEFORE candidate filtering, so even empty result pages
  // have a continuation. No normal dashboard request scans all article titles.
  const { results: keys } = await db.prepare(`SELECT id FROM media_syndication_groups
    WHERE id > ? ORDER BY id LIMIT 11`).bind(after).all<{ id: number }>();
  const ids = keys.slice(0, 10).map(key => key.id);
  const groups: unknown[] = [];
  for (const id of ids) {
    const domains = await db.prepare(`SELECT
      (SELECT publisher_domain FROM media_syndication_metadata
        WHERE group_id = ? AND valid = 1 ORDER BY publisher_domain LIMIT 1) AS first_domain,
      (SELECT publisher_domain FROM media_syndication_metadata
        WHERE group_id = ? AND valid = 1 ORDER BY publisher_domain DESC LIMIT 1) AS last_domain`)
      .bind(id, id).first<{ first_domain: string | null; last_domain: string | null }>();
    if (!domains?.first_domain || domains.first_domain === domains.last_domain) continue;
    const g = await group(db, id);
    if (view === 'open' && g.representative_article_id !== null) {
      const pending = await db.prepare(`${MEMBER_SQL} AND a.id <> ?
        AND m.publisher_domain <> (SELECT publisher_domain FROM media_syndication_metadata WHERE article_id = ?)
        AND (r.classification IS NULL OR r.classification <> 'not_duplicate'
          OR r.member_metadata_revision <> m.revision OR r.representative_metadata_revision <> rm.revision
          OR rm.valid <> 1 OR rm.group_id <> g.id) LIMIT 1`)
        .bind(id, g.representative_article_id, g.representative_article_id).first();
      if (!pending) continue;
    }
    groups.push(g);
  }
  return json({ groups, scanned_title_groups: ids.length,
    next_after: keys.length > 10 ? ids.at(-1) : null,
    match_reason: 'normalised_exact_publisher_title_different_publisher_domain',
    normalisation: SYNDICATION_NORMALISATION, text_comparison: 'unavailable' });
}

async function detail(db: D1Database, id: number, url: URL): Promise<Response> {
  parameters(url, ['after', 'history_after']);
  const g = await group(db, id);
  const { results } = await db.prepare(`${MEMBER_SQL} AND a.id > ? ORDER BY a.id LIMIT 21`)
    .bind(id, integer(url.searchParams.get('after'))).all<Member>();
  const representative = g.representative_article_id === null ? null
    : await db.prepare(`SELECT a.id, a.title, a.publisher, a.canonical_url, a.original_url,
      a.status, a.published_at, a.discovered_at, m.revision AS metadata_revision,
      m.valid, m.group_id, m.publisher_domain FROM media_articles a
      LEFT JOIN media_syndication_metadata m ON m.article_id = a.id WHERE a.id = ?`)
      .bind(g.representative_article_id).first<{ status: string; valid: number; group_id: number }>();
  const { results: history } = await db.prepare(`SELECT id, revision, actor_type, action,
    before_json, after_json, created_at FROM media_syndication_events
    WHERE group_id = ? AND id > ? ORDER BY id LIMIT 21`)
    .bind(id, integer(url.searchParams.get('history_after'))).all<{ id: number }>();
  return json({ group: g, representative,
    needs_representative_review: representative !== null &&
      (representative.status !== 'approved' || representative.valid !== 1 || representative.group_id !== id),
    members: results.slice(0, 20), next_after: results.length > 20 ? results[19]?.id : null,
    history: history.slice(0, 20), history_next_after: history.length > 20 ? history[19]?.id : null,
    text_comparison: 'unavailable',
    text_comparison_reason: 'No complete permitted text or reproducible text comparison is available.' });
}

async function decide(db: D1Database, request: Request, id: number): Promise<Response> {
  const key = request.headers.get('Idempotency-Key') ?? '';
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const rawRevision = request.headers.get('If-Match')?.replace(/^"(\d+)"$/, '$1') ?? '';
  if (!/^\d{1,15}$/.test(rawRevision)) throw new HttpError(428, 'syndication_revision_required');
  const expected = integer(rawRevision);
  const parsed = Decision.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_syndication_decision');
  const data = parsed.data;
  if (data.action === 'review') data.decisions.sort((a, b) => a.article_id - b.article_id);
  const requestJson = JSON.stringify({ group_id: id, expected_revision: expected, ...data });
  const receipt = (): Promise<Receipt | null> => db.prepare(`SELECT * FROM media_syndication_events
    WHERE request_key = ?`).bind(key).first<Receipt>();
  const replay = await receipt();
  if (replay) {
    if (replay.request_json !== requestJson) throw new HttpError(409, 'syndication_idempotency_conflict');
    return json({ decision: replay, replayed: true });
  }
  const g = await group(db, id);
  if (g.revision !== expected) throw new HttpError(409, 'syndication_revision_conflict');
  const now = new Date().toISOString();
  let representative: number | null = null;
  let epoch = g.epoch + 1;
  let guard = '';
  let guardValues: unknown[] = [];
  const statements: D1PreparedStatement[] = [];
  let priorReviews: unknown[] = [];
  let metadataEvidence: unknown[] = [];
  if (data.action === 'review') {
    representative = data.representative_article_id;
    epoch = representative === g.representative_article_id ? g.epoch : g.epoch + 1;
    const ids = data.decisions.map(d => d.article_id);
    if (new Set(ids).size !== ids.length || ids.includes(representative)) {
      throw new HttpError(400, 'invalid_syndication_members');
    }
    for (const d of data.decisions) {
      if (d.classification === 'confirmed_same_text') throw new HttpError(422, 'same_text_comparison_unavailable');
      if (d.classification === 'confirmed_syndicated' && !d.reviewed_publisher_urls ||
          d.suppress && d.classification !== 'confirmed_syndicated') {
        throw new HttpError(400, 'syndication_confirmation_evidence_required');
      }
    }
    // Check current metadata again INSIDE the transaction. Source keys and dates
    // are not publisher-identity or candidate-equality gates.
    guard = `AND EXISTS (SELECT 1 FROM media_syndication_metadata rm
      WHERE rm.article_id = ? AND rm.group_id = g.id AND rm.valid = 1 AND rm.revision = ?
      AND (SELECT count(*) FROM json_each(?) d JOIN media_syndication_metadata mm
        ON mm.article_id = json_extract(d.value, '$.article_id')
        JOIN media_articles ma ON ma.id = mm.article_id
        JOIN media_articles ra ON ra.id = rm.article_id
        WHERE mm.group_id = g.id AND mm.valid = 1
          AND mm.revision = json_extract(d.value, '$.metadata_revision')
          AND mm.publisher_domain <> rm.publisher_domain
          AND ma.canonical_url_hash <> ra.canonical_url_hash) = ?)`;
    guardValues = [representative, data.representative_metadata_revision, JSON.stringify(data.decisions), ids.length];
    priorReviews = (await db.prepare(`SELECT * FROM media_syndication_reviews
      WHERE group_id = ? AND epoch = ? AND article_id IN (SELECT value FROM json_each(?))`)
      .bind(id, g.epoch, JSON.stringify(ids)).all()).results;
    // Retain bounded original metadata at decision time, not just mutable row
    // references. This preserves a reproducible audit when a publisher title/date
    // is later corrected. No excerpts, bodies or copied comparison text.
    metadataEvidence = (await db.prepare(`SELECT a.id, substr(a.title, 1, 2000) AS title,
      length(a.title) > 2000 AS title_truncated, substr(a.canonical_url, 1, 2048) AS canonical_url,
      length(a.canonical_url) > 2048 AS canonical_url_truncated, a.canonical_url_hash,
      substr(a.original_url, 1, 2048) AS original_url,
      length(a.original_url) > 2048 AS original_url_truncated,
      substr(a.publisher, 1, 200) AS publisher, a.published_at, a.discovered_at, a.status,
      m.publisher_domain, m.fingerprint, m.revision AS metadata_revision
      FROM media_articles a JOIN media_syndication_metadata m ON m.article_id = a.id
      WHERE m.group_id = ? AND m.valid = 1
        AND a.id IN (SELECT value FROM json_each(?)) ORDER BY a.id LIMIT 21`)
      .bind(id, JSON.stringify([representative, ...ids])).all()).results;
  }
  const afterJson = JSON.stringify({ representative_article_id: representative, epoch,
    normalisation: SYNDICATION_NORMALISATION, metadata_evidence: metadataEvidence, ...data });
  statements.push(db.prepare(`INSERT INTO media_syndication_events
    (request_key, request_json, group_id, revision, actor_type, action, before_json, after_json, created_at)
    SELECT ?, ?, g.id, g.revision + 1, 'authenticated_admin', ?, ?, ?, ?
    FROM media_syndication_groups g WHERE g.id = ? AND g.revision = ? ${guard}
    ON CONFLICT(request_key) DO NOTHING`)
    .bind(key, requestJson, data.action, JSON.stringify({ group: g, affected_reviews: priorReviews }),
      afterJson, now, id, expected, ...guardValues));
  statements.push(db.prepare(`UPDATE media_syndication_groups SET representative_article_id = ?,
    epoch = ?, revision = revision + 1, mutation_key = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM media_syndication_events
      WHERE request_key = ? AND group_id = ? AND revision = ? AND request_json = ?)`)
    .bind(representative, epoch, key, now, id, expected, key, id, expected + 1, requestJson));
  if (data.action === 'review') {
    for (const d of data.decisions) {
      statements.push(db.prepare(`INSERT INTO media_syndication_reviews
        (group_id, epoch, article_id, representative_article_id, member_metadata_revision,
          representative_metadata_revision, classification, suppress, evidence_type, rationale, decision_key, reviewed_at)
        SELECT id, epoch, ?, representative_article_id, ?, ?, ?, ?, ?, ?, ?, ?
          FROM media_syndication_groups WHERE id = ? AND mutation_key = ? AND revision = ?
            AND EXISTS (SELECT 1 FROM media_syndication_events
              WHERE request_key = ? AND request_json = ? AND group_id = media_syndication_groups.id
                AND revision = media_syndication_groups.revision)
        ON CONFLICT(group_id, epoch, article_id) DO UPDATE SET
          member_metadata_revision = excluded.member_metadata_revision,
          representative_metadata_revision = excluded.representative_metadata_revision,
          classification = excluded.classification, suppress = excluded.suppress,
          evidence_type = excluded.evidence_type, rationale = excluded.rationale,
          decision_key = excluded.decision_key, reviewed_at = excluded.reviewed_at`)
        .bind(d.article_id, d.metadata_revision, data.representative_metadata_revision,
          d.classification, Number(d.suppress), d.reviewed_publisher_urls ? 'manual_publisher_url_review' : 'metadata_only',
          d.rationale, key, now, id, key, expected + 1, key, requestJson));
    }
  }
  // Publication intent/outbox tables and media_articles are deliberately absent.
  // Homepage snapshot/generation changes atomically with visibility decisions.
  statements.push(reconcileHomepageLatestSixStatement(db));
  await db.batch(statements);
  const saved = await receipt();
  if (!saved) throw new HttpError(409, 'syndication_revision_or_metadata_conflict');
  if (saved.request_json !== requestJson) throw new HttpError(409, 'syndication_idempotency_conflict');
  return json({ decision: saved, replayed: false });
}

// Caller MUST have verified the existing Media admin bearer credential first.
export async function handleSyndicationAdmin(request: Request, url: URL, db: D1Database):
Promise<Response | null> {
  if (!url.pathname.startsWith('/admin/syndication')) return null;
  if (url.pathname === '/admin/syndication') {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    return list(db, url);
  }
  if (url.pathname === '/admin/syndication/metadata-populate') {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    parameters(url, []);
    const parsed = z.object({ after_id: z.number().int().nonnegative(),
      through_id: z.number().int().nonnegative().optional(),
      confirm_metadata_only: z.literal(true) }).strict().safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, 'invalid_syndication_population_request');
    const through = parsed.data.through_id ?? (await db.prepare(`SELECT coalesce(max(id), 0) AS id
      FROM media_articles`).first<{ id: number }>())!.id;
    if (parsed.data.after_id > through) throw new HttpError(400, 'invalid_syndication_population_range');
    return json(await populateSyndicationMetadata(db, parsed.data.after_id, through));
  }
  const match = /^\/admin\/syndication\/([1-9]\d*)(\/decisions)?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'not_found');
  const id = integer(match[1]!);
  if (match[2]) {
    parameters(url, []);
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    return decide(db, request, id);
  }
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
  return detail(db, id, url);
}
