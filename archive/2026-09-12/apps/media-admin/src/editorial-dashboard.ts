import {
  ArticleStatus, AuthorRuleSchema, HttpError, PublicationPolicy,
  canonicalizeUrl, canonicalUrlHash, guardianRemotePreviewUrl, json,
  loadSource, publisherHttpsUrl, remotePreviewUrl, z,
} from '@uk-aq-media/core';
import { fetchArticleHeadMetadata } from '@uk-aq-media/discovery';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LIMIT = 50;

const ArticleSort = z.enum([
  'published_desc', 'published_asc', 'approved_desc', 'approved_asc',
  'discovered_desc', 'updated_desc',
]);
const AiTitleState = z.enum(['pending', 'accepted', 'rejected']);
const SourceType = z.enum(['publisher', 'government']);
const SourceMutation = z.object({
  publication_policy: PublicationPolicy.optional(),
  enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const AddSourceBody = z.object({
  source_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  name: z.string().min(1).max(200),
  canonical_domain: z.string().regex(/^[a-z0-9.-]+$/).max(253),
  source_type: SourceType,
}).strict();
const AuthorRuleMutation = z.object({
  display_name: z.string().min(1).max(200).optional(),
  profile_url: z.url().max(2048).optional(),
  profile_rss_url: z.url().max(2048).nullable().optional(),
  profile_rss_route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).nullable().optional(),
  inclusion_policy: z.enum(['normal', 'always_include']).optional(),
  publication_policy: z.enum(['inherit_source', 'pending', 'auto_approve']).optional(),
  enabled: z.boolean().optional(),
  byline_aliases: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
}).strict().refine(value => Object.keys(value).length > 0);
const AddAuthorRuleBody = z.object({
  author_key: z.string().regex(/^[a-z0-9]+:[a-z0-9]+(?:-[a-z0-9]+)*$/).max(150),
  source_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  display_name: z.string().min(1).max(200),
  profile_url: z.url().max(2048),
  profile_rss_url: z.url().max(2048).nullable(),
  profile_rss_route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).nullable(),
  inclusion_policy: z.enum(['normal', 'always_include']),
  publication_policy: z.enum(['inherit_source', 'pending', 'auto_approve']),
  enabled: z.boolean(),
  byline_aliases: z.array(z.string().min(1).max(200)).min(1).max(10),
}).strict();
const LookupBody = z.object({ url: z.url().max(2048) }).strict();
const ManualArticleBody = z.object({
  url: z.url().max(2048),
  title: z.string().min(1).max(1000),
  publisher: z.string().min(1).max(200),
  author: z.string().max(500).nullable().optional(),
  published_at: z.iso.datetime({ offset: true }).nullable().optional(),
  preview_image_url: z.url().max(2048).nullable().optional(),
}).strict();
const MetadataApplyBody = z.object({
  expected_current_image_url: z.string().max(2048).nullable(),
  replace_existing_image: z.boolean(),
  apply_publisher_display_title: z.boolean().default(true),
}).strict();

type SourceRow = {
  source_key: string; name: string; canonical_domain: string; source_type: 'publisher' | 'government';
  enabled: number; publication_policy: 'manual' | 'auto_approve'; review_level: 'standard' | 'enhanced';
  priority: number; discovery_method: 'rss' | 'sitemap' | 'deferred'; discovery_config_json: string;
  content_fetch_policy: 'discovery_metadata_only' | 'article_head_allowed' | 'article_body_allowed';
  ai_content_policy: string;
  image_policy: 'remote_preview' | 'blocked' | 'local_copy_permitted';
  created_at: string; updated_at: string;
};

type HeadMetadata = {
  publisher: string | null; title: string | null; compact_title: string | null;
  author: string | null; published_at: string | null; image_url: string | null;
  image_error: string | null;
  checked_at: string;
};

function limitFrom(search: URLSearchParams, fallback = 20): number {
  const raw = Number(search.get('limit') ?? fallback);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
    throw new HttpError(400, 'invalid_limit');
  }
  return raw;
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'json_content_type_required');
  }
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'request_body_too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'request_body_too_large');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  return key;
}

function csvValues(search: URLSearchParams, key: string, max = 20): string[] {
  const values = search.getAll(key).flatMap(value => value.split(','))
    .map(value => value.trim()).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length > max) throw new HttpError(400, `too_many_${key}`);
  return unique;
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function encodeCursor(value: string, id: number): string {
  return btoa(JSON.stringify([value, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string | null): [string, number] | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4);
    const value = JSON.parse(atob(padded)) as unknown;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' ||
        !Number.isSafeInteger(value[1]) || Number(value[1]) < 1) throw new Error();
    return [value[0], Number(value[1])];
  } catch { throw new HttpError(400, 'invalid_cursor'); }
}

function encodeRunCursor(startedAt: string, id: string): string {
  return btoa(JSON.stringify([startedAt, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeRunCursor(raw: string | null): [string, string] | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4);
    const value = JSON.parse(atob(padded)) as unknown;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' ||
        typeof value[1] !== 'string' || !value[0] || !value[1] || value[1].length > 200) throw new Error();
    return [value[0], value[1]];
  } catch { throw new HttpError(400, 'invalid_cursor'); }
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (_all, key: string) => {
    const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? ' ';
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : ' '; } catch { return ' '; }
  }).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return result ? result.slice(0, max) : null;
}

function safeHostname(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'invalid_article_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new HttpError(400, 'invalid_article_url');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) {
    throw new HttpError(400, 'unsafe_article_host');
  }
  return host;
}

async function fetchHeadMetadata(canonicalUrl: string, source: Pick<SourceRow,
  'source_key' | 'canonical_domain' | 'content_fetch_policy' | 'image_policy'>): Promise<HeadMetadata> {
  let metadata: Awaited<ReturnType<typeof fetchArticleHeadMetadata>>;
  try {
    metadata = await fetchArticleHeadMetadata(canonicalUrl, source);
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : 'metadata_unavailable');
  }
  const originalTitle = cleanText(metadata.ogTitle ?? metadata.twitterTitle ?? metadata.htmlTitle, 1000);
  const compact = cleanText(metadata.twitterTitle, 1000);
  const published = metadata.publishedAt && !Number.isNaN(Date.parse(metadata.publishedAt))
    ? new Date(metadata.publishedAt).toISOString() : null;
  return {
    publisher: cleanText(metadata.publisher, 200), title: originalTitle,
    compact_title: compact && originalTitle && compact.length < originalTitle.length ? compact : null,
    author: cleanText(metadata.author, 500), published_at: published,
    image_url: metadata.previewUrl, image_error: metadata.previewError,
    checked_at: metadata.checkedAt,
  };
}

async function sourceForUrl(db: D1Database, rawUrl: string): Promise<{
  source: SourceRow | null; domain: string; canonicalUrl: string; hash: string;
}> {
  const domain = safeHostname(rawUrl);
  const { results } = await db.prepare(`SELECT * FROM media_sources
    WHERE canonical_domain = ? OR ? LIKE '%.' || canonical_domain
    ORDER BY length(canonical_domain) DESC LIMIT 1`).bind(domain, domain).all<SourceRow>();
  const source = results[0] ?? null;
  let canonicalUrl: string;
  try { canonicalUrl = canonicalizeUrl(rawUrl, source?.canonical_domain ?? domain); }
  catch { throw new HttpError(400, 'invalid_article_url'); }
  return { source, domain, canonicalUrl, hash: await canonicalUrlHash(canonicalUrl) };
}

function conservativeManualSource(domain: string, name: string, sourceKey: string): SourceRow {
  const now = new Date().toISOString();
  return { source_key: sourceKey, name, canonical_domain: domain, source_type: 'publisher', enabled: 0,
    publication_policy: 'manual', review_level: 'enhanced', priority: 50,
    discovery_method: 'deferred', discovery_config_json: '{"retain_excerpt":false}',
    content_fetch_policy: 'article_head_allowed', ai_content_policy: 'disabled',
    image_policy: 'remote_preview', created_at: now, updated_at: now };
}

async function articleDetail(db: D1Database, id: number): Promise<Response> {
  const article = await db.prepare(`SELECT a.*, s.name AS source_name,
      s.canonical_domain, s.publication_policy AS source_publication_policy,
      s.content_fetch_policy AS source_content_fetch_policy,
      s.ai_content_policy AS source_ai_content_policy,
      s.image_policy AS source_image_policy
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!article) throw new HttpError(404, 'article_not_found');
  const [events, evidence] = await Promise.all([
    db.prepare(`SELECT id, event_type, actor_type, from_status, to_status, revision,
      created_at, metadata_json FROM media_article_events WHERE article_id = ?
      ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT provider_key, route_key, matched_author_keys_json,
      always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
      observation_count FROM media_article_discovery_evidence WHERE article_id = ?
      ORDER BY last_seen_at DESC LIMIT 25`).bind(id).all(),
  ]);
  return json({ article: { ...article, admin_preview_image_path: article.og_image_url
    ? `/admin/articles/${id}/image` : null }, events: events.results, discovery_evidence: evidence.results });
}

async function listArticles(db: D1Database, search: URLSearchParams): Promise<Response> {
  const limit = limitFrom(search);
  const parsedSort = ArticleSort.safeParse(search.get('sort') ?? 'published_desc');
  if (!parsedSort.success) throw new HttpError(400, 'invalid_sort');
  const sort = parsedSort.data;
  const sortSpec: Record<z.infer<typeof ArticleSort>, { expression: string; direction: 'ASC' | 'DESC' }> = {
    published_desc: { expression: 'a.feed_sort_at', direction: 'DESC' },
    published_asc: { expression: 'a.feed_sort_at', direction: 'ASC' },
    approved_desc: { expression: "coalesce(a.approved_at, '')", direction: 'DESC' },
    approved_asc: { expression: "coalesce(a.approved_at, '')", direction: 'ASC' },
    discovered_desc: { expression: 'a.discovered_at', direction: 'DESC' },
    updated_desc: { expression: 'a.updated_at', direction: 'DESC' },
  };
  const spec = sortSpec[sort];
  const where: string[] = [];
  const binds: unknown[] = [];
  const statuses = csvValues(search, 'status').map(value => {
    const parsed = ArticleStatus.safeParse(value);
    if (!parsed.success) throw new HttpError(400, 'invalid_status');
    return parsed.data;
  });
  if (statuses.length) { where.push(`a.status IN (${placeholders(statuses)})`); binds.push(...statuses); }
  const sources = csvValues(search, 'source');
  if (sources.length) { where.push(`a.source_key IN (${placeholders(sources)})`); binds.push(...sources); }
  const authors = csvValues(search, 'author', 50);
  if (authors.length) { where.push(`a.author IN (${placeholders(authors)})`); binds.push(...authors); }
  const hasImage = search.get('has_image');
  if (hasImage !== null) {
    if (!['yes', 'no'].includes(hasImage)) throw new HttpError(400, 'invalid_has_image');
    where.push(hasImage === 'yes' ? 'a.og_image_url IS NOT NULL' : 'a.og_image_url IS NULL');
  }
  const titleStates = csvValues(search, 'title_state');
  if (titleStates.length) {
    const clauses = titleStates.map(state => {
      if (state === 'original') return "(a.display_title IS NULL AND coalesce(a.ai_title_suggestion_state, '') != 'pending')";
      if (state === 'human') return "a.display_title_origin = 'human'";
      if (state === 'ai') return "a.display_title_origin = 'ai'";
      if (state === 'pending_ai') return "a.ai_title_suggestion_state = 'pending'";
      throw new HttpError(400, 'invalid_title_state');
    });
    where.push(`(${clauses.join(' OR ')})`);
  }
  const query = cleanText(search.get('q'), 200);
  if (query) {
    const like = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    where.push("(a.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR a.display_title LIKE ? ESCAPE '\\' COLLATE NOCASE OR a.canonical_url LIKE ? ESCAPE '\\' COLLATE NOCASE OR a.author LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    binds.push(like, like, like, like);
  }
  const cursor = decodeCursor(search.get('cursor'));
  if (cursor) {
    const comparison = spec.direction === 'DESC' ? '<' : '>';
    where.push(`(${spec.expression} ${comparison} ? OR (${spec.expression} = ? AND a.id ${comparison} ?))`);
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const sql = `SELECT a.id, a.source_key, a.canonical_url, a.title, a.display_title,
      a.display_title_origin, a.ai_title_suggestion_state, a.publisher, a.author,
      a.published_at, a.discovered_at, a.approved_at, a.updated_at, a.status,
      a.revision, a.approval_method, a.approval_author_rule_key, a.og_image_url,
      a.image_policy, ${spec.expression} AS cursor_value
    FROM media_articles a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${spec.expression} ${spec.direction}, a.id ${spec.direction} LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit + 1).all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const rows: Array<Record<string, unknown>> = results.slice(0, limit).map(row => ({ ...row,
    admin_preview_image_path: row.og_image_url ? `/admin/articles/${row.id}/image` : null }));
  const last = rows.at(-1);
  return json({ articles: rows, page: { limit, has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(String(last.cursor_value ?? ''), Number(last.id)) : null,
    sort } });
}

async function listSelectors(db: D1Database): Promise<Response> {
  const [sources, authors] = await Promise.all([
    db.prepare('SELECT source_key, name FROM media_sources ORDER BY name, source_key LIMIT 100').all(),
    db.prepare(`SELECT DISTINCT author FROM media_articles WHERE author IS NOT NULL AND trim(author) != ''
      ORDER BY author COLLATE NOCASE LIMIT 250`).all(),
  ]);
  return json({ publications: sources.results, authors: authors.results.map(row => row.author) });
}

async function listAiTitles(db: D1Database, search: URLSearchParams): Promise<Response> {
  const limit = limitFrom(search);
  const parsedState = AiTitleState.safeParse(search.get('state') ?? 'pending');
  if (!parsedState.success) throw new HttpError(400, 'invalid_ai_title_state');
  const state = parsedState.data;
  const cursor = decodeCursor(search.get('cursor'));
  const where = ["a.ai_title_suggestion_state = ?", 'a.ai_title_suggestion IS NOT NULL'];
  const binds: unknown[] = [state];
  if (cursor) {
    where.push("(coalesce(a.ai_title_generated_at, '') < ? OR (coalesce(a.ai_title_generated_at, '') = ? AND a.id < ?))");
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const { results } = await db.prepare(`SELECT a.id, a.source_key, a.publisher, a.title,
      a.display_title, a.display_title_origin, a.ai_title_suggestion,
      a.ai_title_suggestion_state, a.ai_title_model, a.ai_title_prompt_version,
      a.ai_title_generated_at, a.ai_title_decided_at, a.status
    FROM media_articles a WHERE ${where.join(' AND ')}
    ORDER BY coalesce(a.ai_title_generated_at, '') DESC, a.id DESC LIMIT ?`)
    .bind(...binds, limit + 1).all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return json({ suggestions: rows, page: { limit, has_more: hasMore,
    next_cursor: hasMore && last
      ? encodeCursor(String(last.ai_title_generated_at ?? ''), Number(last.id)) : null } });
}

async function listRuns(db: D1Database, search: URLSearchParams): Promise<Response> {
  const limit = limitFrom(search);
  const cursor = decodeRunCursor(search.get('cursor'));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (cursor) {
    where.push('(r.started_at < ? OR (r.started_at = ? AND r.id < ?))');
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const { results } = await db.prepare(`SELECT r.*, s.name AS source_name
    FROM media_discovery_runs r LEFT JOIN media_sources s ON s.source_key = r.source_key
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).bind(...binds, limit + 1)
    .all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return json({ runs: rows, page: { limit, has_more: hasMore,
    next_cursor: hasMore && last
      ? encodeRunCursor(String(last.started_at), String(last.id)) : null } });
}

async function listSources(db: D1Database): Promise<Response> {
  const { results } = await db.prepare(`SELECT s.*,
      (SELECT r.status FROM media_discovery_runs r WHERE r.source_key = s.source_key
        ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS recent_run_status,
      (SELECT r.started_at FROM media_discovery_runs r WHERE r.source_key = s.source_key
        ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS recent_run_started_at
    FROM media_sources s ORDER BY s.name, s.source_key LIMIT 100`).all<Record<string, unknown>>();
  const rules = await db.prepare(`SELECT * FROM media_author_rules
    ORDER BY source_key, display_name, author_key LIMIT 250`).all<Record<string, unknown>>();
  return json({ sources: results, author_rules: rules.results.map(rule => ({
    ...rule,
    byline_aliases: JSON.parse(String(rule.byline_aliases_json)),
  })) });
}

async function lookupArticle(request: Request, db: D1Database): Promise<Response> {
  const parsed = LookupBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_lookup_body');
  const identity = await sourceForUrl(db, parsed.data.url);
  const existing = await db.prepare('SELECT id FROM media_articles WHERE canonical_url_hash = ?')
    .bind(identity.hash).first<{ id: number }>();
  if (existing) return articleDetail(db, existing.id);
  const sourceKey = identity.source?.source_key ?? `manual-${(await canonicalUrlHash(identity.domain)).slice(0, 12)}`;
  const source = identity.source ?? conservativeManualSource(identity.domain, identity.domain, sourceKey);
  let metadata: HeadMetadata | null = null;
  let metadataError: string | null = null;
  try { metadata = await fetchHeadMetadata(identity.canonicalUrl, source); }
  catch (error) { metadataError = error instanceof HttpError ? error.message : 'metadata_unavailable'; }
  return json({ existing: false, canonical_url: identity.canonicalUrl,
    source: { source_key: source.source_key, name: source.name, canonical_domain: source.canonical_domain,
      known: identity.source !== null, will_create_disabled_definition: identity.source === null },
    metadata, metadata_error: metadataError, can_add_approved: true });
}

async function createManualArticle(request: Request, db: D1Database): Promise<Response> {
  const idempotency = requireIdempotencyKey(request);
  const parsed = ManualArticleBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_manual_article_body');
  const identity = await sourceForUrl(db, parsed.data.url);
  const existing = await db.prepare('SELECT id FROM media_articles WHERE canonical_url_hash = ?')
    .bind(identity.hash).first<{ id: number }>();
  if (existing) return articleDetail(db, existing.id);
  const sourceKey = identity.source?.source_key ?? `manual-${(await canonicalUrlHash(identity.domain)).slice(0, 12)}`;
  const source = identity.source ?? conservativeManualSource(identity.domain, parsed.data.publisher, sourceKey);
  const preview = parsed.data.preview_image_url
    ? (source.source_key === 'the-guardian'
      ? guardianRemotePreviewUrl(parsed.data.preview_image_url)
      : remotePreviewUrl(parsed.data.preview_image_url, source.canonical_domain)) : null;
  if (parsed.data.preview_image_url && !preview) throw new HttpError(400, 'invalid_preview_image_url');
  const now = new Date().toISOString();
  const eventKey = `admin:add:${idempotency}`;
  const replay = await db.prepare('SELECT article_id FROM media_article_events WHERE event_key = ?')
    .bind(eventKey).first<{ article_id: number }>();
  if (replay) return articleDetail(db, replay.article_id);
  const statements: D1PreparedStatement[] = [];
  if (!identity.source) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO media_sources
      (source_key, name, canonical_domain, source_type, enabled, publication_policy,
       review_level, priority, discovery_method, discovery_config_json,
       content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
      VALUES (?, ?, ?, 'publisher', 0, 'manual', 'enhanced', 50, 'deferred',
        '{"retain_excerpt":false}', 'article_head_allowed', 'disabled', 'remote_preview', ?, ?)`)
      .bind(sourceKey, parsed.data.publisher, identity.domain, now, now));
  }
  statements.push(db.prepare(`INSERT INTO media_articles
    (source_key, canonical_url, canonical_url_hash, original_url, title, publisher, author,
     published_at, discovered_at, last_seen_at, status, review_level, approval_method,
     og_image_url, image_policy, approved_at, revision, mutation_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'manual', ?, ?, ?, 0, ?, ?, ?)`)
    .bind(sourceKey, identity.canonicalUrl, identity.hash, parsed.data.url,
      cleanText(parsed.data.title, 1000), cleanText(parsed.data.publisher, 200),
      cleanText(parsed.data.author, 500), parsed.data.published_at ?? null, now, now,
      source.review_level, preview, source.image_policy, now, eventKey, now, now));
  try { await db.batch(statements); }
  catch (error) {
    const duplicate = await db.prepare('SELECT id FROM media_articles WHERE canonical_url_hash = ?')
      .bind(identity.hash).first<{ id: number }>();
    if (duplicate) return articleDetail(db, duplicate.id);
    throw error;
  }
  const created = await db.prepare('SELECT id FROM media_articles WHERE canonical_url_hash = ?')
    .bind(identity.hash).first<{ id: number }>();
  if (!created) throw new HttpError(500, 'manual_article_create_failed');
  return articleDetail(db, created.id);
}

async function previewMetadata(db: D1Database, id: number): Promise<Response> {
  const row = await db.prepare(`SELECT a.id, a.canonical_url, a.title, a.display_title,
      a.display_title_origin, a.og_image_url, a.status, a.revision, s.*
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ?`).bind(id).first<Record<string, unknown> & SourceRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  const metadata = await fetchHeadMetadata(String(row.canonical_url), row);
  const changes = {
    image: metadata.image_url && metadata.image_url !== row.og_image_url
      ? { current: row.og_image_url ?? null, proposed: metadata.image_url,
          replacement_required: row.og_image_url !== null } : null,
    publisher_display_title: metadata.compact_title && row.display_title === null
      ? { current: null, proposed: metadata.compact_title } : null,
  };
  return json({ article: { id, title: row.title, status: row.status, revision: row.revision },
    metadata, changes, has_useful_change: Boolean(changes.image || changes.publisher_display_title) });
}

async function applyMetadata(request: Request, db: D1Database, id: number): Promise<Response> {
  requireIdempotencyKey(request);
  const parsed = MetadataApplyBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_metadata_apply_body');
  const row = await db.prepare(`SELECT a.id, a.canonical_url, a.og_image_url, a.display_title,
      a.display_title_origin, s.* FROM media_articles a JOIN media_sources s
      ON s.source_key = a.source_key WHERE a.id = ?`).bind(id)
    .first<Record<string, unknown> & SourceRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  if (row.og_image_url !== parsed.data.expected_current_image_url) {
    throw new HttpError(409, 'metadata_current_image_changed');
  }
  const metadata = await fetchHeadMetadata(String(row.canonical_url), row);
  const mayChangeImage = Boolean(metadata.image_url && metadata.image_url !== row.og_image_url &&
    (row.og_image_url === null || parsed.data.replace_existing_image));
  const maySetTitle = Boolean(parsed.data.apply_publisher_display_title && metadata.compact_title &&
    row.display_title === null);
  if (!mayChangeImage && !maySetTitle) return json({ changed: false, reason: 'no_useful_change' });
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
      og_image_url = CASE WHEN ? THEN ? ELSE og_image_url END,
      preview_metadata_checked_at = ?,
      display_title = CASE WHEN ? AND display_title IS NULL THEN ? ELSE display_title END,
      display_title_origin = CASE WHEN ? AND display_title IS NULL THEN 'publisher' ELSE display_title_origin END,
      updated_at = ?
    WHERE id = ? AND og_image_url IS ?
    RETURNING id`).bind(Number(mayChangeImage), metadata.image_url, metadata.checked_at,
      Number(maySetTitle), metadata.compact_title, Number(maySetTitle), now, id,
      parsed.data.expected_current_image_url).first<{ id: number }>();
  if (!changed) throw new HttpError(409, 'metadata_article_changed');
  return articleDetail(db, id);
}

async function adminImage(db: D1Database, id: number): Promise<Response> {
  const row = await db.prepare(`SELECT a.source_key, a.og_image_url,
      a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
      s.canonical_domain FROM media_articles a JOIN media_sources s
      ON s.source_key = a.source_key WHERE a.id = ?`).bind(id).first<{
        source_key: string; og_image_url: string | null; article_image_policy: string;
        source_image_policy: string; canonical_domain: string;
      }>();
  if (!row || row.article_image_policy !== 'remote_preview' ||
      row.source_image_policy !== 'remote_preview') throw new HttpError(404, 'image_not_found');
  const imageUrl = row.source_key === 'the-guardian' ? guardianRemotePreviewUrl(row.og_image_url)
    : remotePreviewUrl(row.og_image_url, row.canonical_domain);
  if (!imageUrl) throw new HttpError(404, 'image_not_found');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let upstream: Response;
    try { upstream = await fetch(imageUrl, { method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'image/*', 'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' } }); }
    catch { throw new HttpError(controller.signal.aborted ? 504 : 502, 'image_upstream_failed'); }
    if (!upstream.ok || (upstream.status >= 300 && upstream.status < 400)) {
      await upstream.body?.cancel(); throw new HttpError(502, 'image_upstream_failed');
    }
    const type = upstream.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!type?.startsWith('image/')) { await upstream.body?.cancel(); throw new HttpError(415, 'invalid_image_content_type'); }
    const declared = Number(upstream.headers.get('Content-Length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) { await upstream.body?.cancel(); throw new HttpError(413, 'image_too_large'); }
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large');
    return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' } });
  } finally { clearTimeout(timer); }
}

function sourceCanEnable(source: SourceRow): boolean {
  if (!['air-quality-news', 'the-guardian'].includes(source.source_key) ||
      source.discovery_method !== 'rss') return false;
  try {
    const config = JSON.parse(source.discovery_config_json) as Record<string, unknown>;
    return source.source_key === 'air-quality-news'
      ? config.url === 'https://airqualitynews.com/feed/'
      : Array.isArray(config.routes) && config.routes.length > 0;
  } catch { return false; }
}

async function mutateSource(request: Request, db: D1Database, sourceKey: string): Promise<Response> {
  const eventKey = `admin:source:${requireIdempotencyKey(request)}`;
  const parsed = SourceMutation.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_source_mutation');
  const existing = await db.prepare('SELECT * FROM media_sources WHERE source_key = ?')
    .bind(sourceKey).first<SourceRow>();
  if (!existing) throw new HttpError(404, 'source_not_found');
  if (parsed.data.enabled === true && !sourceCanEnable(existing)) {
    throw new HttpError(409, 'unsupported_source_adapter');
  }
  const replay = await db.prepare('SELECT event_key FROM media_configuration_events WHERE event_key = ?')
    .bind(eventKey).first();
  if (!replay) {
    const nextPolicy = parsed.data.publication_policy ?? existing.publication_policy;
    const nextEnabled = parsed.data.enabled === undefined ? existing.enabled : Number(parsed.data.enabled);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE media_sources SET publication_policy = ?, enabled = ?, updated_at = ?
        WHERE source_key = ?`).bind(nextPolicy, nextEnabled, now, sourceKey),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'source', ?, 'updated', 'admin', ?, ?, ?)`)
        .bind(eventKey, sourceKey, JSON.stringify({ publication_policy: existing.publication_policy,
          enabled: Boolean(existing.enabled) }), JSON.stringify({ publication_policy: nextPolicy,
          enabled: Boolean(nextEnabled) }), now),
    ]);
  }
  const source = await db.prepare('SELECT * FROM media_sources WHERE source_key = ?')
    .bind(sourceKey).first();
  return json({ source, replayed: Boolean(replay) });
}

async function addSource(request: Request, db: D1Database): Promise<Response> {
  const eventKey = `admin:source:${requireIdempotencyKey(request)}`;
  const parsed = AddSourceBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_source_definition');
  const host = safeHostname(`https://${parsed.data.canonical_domain}/`);
  if (host !== parsed.data.canonical_domain.replace(/^www\./, '')) throw new HttpError(400, 'invalid_canonical_domain');
  const now = new Date().toISOString();
  const replay = await db.prepare('SELECT entity_key FROM media_configuration_events WHERE event_key = ?')
    .bind(eventKey).first<{ entity_key: string }>();
  if (!replay) {
    await db.batch([
      db.prepare(`INSERT INTO media_sources
        (source_key, name, canonical_domain, source_type, enabled, publication_policy,
         review_level, priority, discovery_method, discovery_config_json,
        content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 'manual', 'standard', 50, 'deferred',
          '{"retain_excerpt":false}', 'discovery_metadata_only', 'disabled',
          CASE WHEN ? = 'publisher' THEN 'remote_preview' ELSE 'blocked' END, ?, ?)`)
        .bind(parsed.data.source_key, cleanText(parsed.data.name, 200), host,
          parsed.data.source_type, parsed.data.source_type, now, now),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'source', ?, 'created', 'admin', NULL, ?, ?)`)
        .bind(eventKey, parsed.data.source_key, JSON.stringify({ ...parsed.data,
          canonical_domain: host, enabled: false, publication_policy: 'manual',
          review_level: 'standard', discovery_method: 'deferred',
          content_fetch_policy: 'discovery_metadata_only', ai_content_policy: 'disabled',
          image_policy: parsed.data.source_type === 'publisher' ? 'remote_preview' : 'blocked' }), now),
    ]);
  }
  const source = await db.prepare('SELECT * FROM media_sources WHERE source_key = ?')
    .bind(replay?.entity_key ?? parsed.data.source_key).first();
  return json({ source, replayed: Boolean(replay) }, replay ? 200 : 201);
}

async function mutateAuthorRule(request: Request, db: D1Database, authorKey: string): Promise<Response> {
  const eventKey = `admin:author-rule:${requireIdempotencyKey(request)}`;
  const parsed = AuthorRuleMutation.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_author_rule_mutation');
  const existing = await db.prepare('SELECT * FROM media_author_rules WHERE author_key = ?')
    .bind(authorKey).first<Record<string, unknown>>();
  if (!existing) throw new HttpError(404, 'author_rule_not_found');
  const next = {
    display_name: parsed.data.display_name ?? existing.display_name,
    profile_url: parsed.data.profile_url ?? existing.profile_url,
    profile_rss_url: parsed.data.profile_rss_url === undefined ? existing.profile_rss_url : parsed.data.profile_rss_url,
    profile_rss_route_key: parsed.data.profile_rss_route_key === undefined ? existing.profile_rss_route_key : parsed.data.profile_rss_route_key,
    inclusion_policy: parsed.data.inclusion_policy ?? existing.inclusion_policy,
    publication_policy: parsed.data.publication_policy ?? existing.publication_policy,
    enabled: parsed.data.enabled === undefined ? Boolean(existing.enabled) : parsed.data.enabled,
    byline_aliases: parsed.data.byline_aliases ?? JSON.parse(String(existing.byline_aliases_json)),
  };
  const validated = AuthorRuleSchema.safeParse({ author_key: authorKey, source_key: existing.source_key, ...next });
  if (!validated.success) throw new HttpError(400, 'invalid_author_rule_mutation');
  const source = await loadSource(db, String(existing.source_key));
  if (!source || source.source_key !== 'the-guardian') throw new HttpError(409, 'unsupported_author_rule_adapter');
  if (!publisherHttpsUrl(next.profile_url as string, source.canonical_domain) ||
      (next.profile_rss_url && !publisherHttpsUrl(next.profile_rss_url as string, source.canonical_domain))) {
    throw new HttpError(400, 'off_source_author_profile');
  }
  const replay = await db.prepare('SELECT event_key FROM media_configuration_events WHERE event_key = ?')
    .bind(eventKey).first();
  if (!replay) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE media_author_rules SET display_name = ?, profile_url = ?,
        profile_rss_url = ?, profile_rss_route_key = ?, inclusion_policy = ?,
        publication_policy = ?, enabled = ?, byline_aliases_json = ?, updated_at = ?
        WHERE author_key = ?`).bind(next.display_name, next.profile_url, next.profile_rss_url,
          next.profile_rss_route_key, next.inclusion_policy, next.publication_policy,
          Number(next.enabled), JSON.stringify(next.byline_aliases), now, authorKey),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'author_rule', ?, 'updated', 'admin', ?, ?, ?)`)
        .bind(eventKey, authorKey, JSON.stringify(existing), JSON.stringify(validated.data), now),
    ]);
  }
  const rule = await db.prepare('SELECT * FROM media_author_rules WHERE author_key = ?')
    .bind(authorKey).first();
  return json({ author_rule: rule, replayed: Boolean(replay) });
}

async function addAuthorRule(request: Request, db: D1Database): Promise<Response> {
  const eventKey = `admin:author-rule:${requireIdempotencyKey(request)}`;
  const parsed = AddAuthorRuleBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_author_rule_definition');
  const source = await loadSource(db, parsed.data.source_key);
  if (!source || source.source_key !== 'the-guardian' ||
      !publisherHttpsUrl(parsed.data.profile_url, source.canonical_domain) ||
      (parsed.data.profile_rss_url && !publisherHttpsUrl(parsed.data.profile_rss_url, source.canonical_domain))) {
    throw new HttpError(409, 'unsupported_author_rule_adapter');
  }
  if (!parsed.data.author_key.startsWith(`${source.source_key.replace('the-', '')}:`)) {
    throw new HttpError(400, 'author_key_source_mismatch');
  }
  const now = new Date().toISOString();
  const replay = await db.prepare('SELECT entity_key FROM media_configuration_events WHERE event_key = ?')
    .bind(eventKey).first<{ entity_key: string }>();
  if (!replay) {
    await db.batch([
      db.prepare(`INSERT INTO media_author_rules
        (author_key, source_key, display_name, profile_url, profile_rss_url,
         profile_rss_route_key, inclusion_policy, publication_policy, enabled,
         byline_aliases_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(parsed.data.author_key, parsed.data.source_key, parsed.data.display_name,
          parsed.data.profile_url, parsed.data.profile_rss_url ?? null,
          parsed.data.profile_rss_route_key ?? null, parsed.data.inclusion_policy,
          parsed.data.publication_policy, Number(parsed.data.enabled),
          JSON.stringify(parsed.data.byline_aliases), now, now),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'author_rule', ?, 'created', 'admin', NULL, ?, ?)`)
        .bind(eventKey, parsed.data.author_key, JSON.stringify(parsed.data), now),
    ]);
  }
  const rule = await db.prepare('SELECT * FROM media_author_rules WHERE author_key = ?')
    .bind(replay?.entity_key ?? parsed.data.author_key).first();
  return json({ author_rule: rule, replayed: Boolean(replay) }, replay ? 200 : 201);
}

export async function handleEditorialDashboard(request: Request, env: MediaAdminEnv,
  url: URL): Promise<Response | null> {
  if (url.pathname === '/admin/articles/selectors') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return listSelectors(env.MEDIA_DB);
  }
  if (url.pathname === '/admin/articles/lookup') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return lookupArticle(request, env.MEDIA_DB);
  }
  if (url.pathname === '/admin/ai-titles') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return listAiTitles(env.MEDIA_DB, url.searchParams);
  }
  if (url.pathname === '/admin/runs') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return listRuns(env.MEDIA_DB, url.searchParams);
  }
  if (url.pathname === '/admin/sources') {
    if (request.method === 'GET') return listSources(env.MEDIA_DB);
    if (request.method === 'POST') return addSource(request, env.MEDIA_DB);
    return json({ error: 'method_not_allowed' }, 405);
  }
  const sourceMatch = /^\/admin\/sources\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname);
  if (sourceMatch) {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    return mutateSource(request, env.MEDIA_DB, sourceMatch[1]!);
  }
  if (url.pathname === '/admin/author-rules') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return addAuthorRule(request, env.MEDIA_DB);
  }
  const authorMatch = /^\/admin\/author-rules\/([a-z0-9]+:[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname);
  if (authorMatch) {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    return mutateAuthorRule(request, env.MEDIA_DB, authorMatch[1]!);
  }
  if (url.pathname === '/admin/articles') {
    if (request.method === 'GET') return listArticles(env.MEDIA_DB, url.searchParams);
    if (request.method === 'POST') return createManualArticle(request, env.MEDIA_DB);
    return json({ error: 'method_not_allowed' }, 405);
  }
  const articleMatch = /^\/admin\/articles\/([1-9]\d*)$/.exec(url.pathname);
  if (articleMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return articleDetail(env.MEDIA_DB, Number(articleMatch[1]));
  }
  const imageMatch = /^\/admin\/articles\/([1-9]\d*)\/image$/.exec(url.pathname);
  if (imageMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return adminImage(env.MEDIA_DB, Number(imageMatch[1]));
  }
  const metadataMatch = /^\/admin\/articles\/([1-9]\d*)\/metadata\/(preview|apply)$/.exec(url.pathname);
  if (metadataMatch) {
    const id = Number(metadataMatch[1]);
    if (metadataMatch[2] === 'preview' && request.method === 'POST') return previewMetadata(env.MEDIA_DB, id);
    if (metadataMatch[2] === 'apply' && request.method === 'PUT') return applyMetadata(request, env.MEDIA_DB, id);
    return json({ error: 'method_not_allowed' }, 405);
  }
  return null;
}
