import {
  ArticleStatus, AuthorRuleSchema, fetchRemotePreviewImage, HttpError, ImagePolicy,
  PublicationPolicy,
  canonicalizeUrl, canonicalUrlHash, guardianRemotePreviewUrl, json,
  hasPermittedPresentationImage, loadSource, MAX_LOCAL_IMAGE_BYTES,
  normaliseArticleAuthorForStorage, publisherHttpsUrl,
  readBoundedImageResponse, reconcileHomepageLatestSix, sourcePresentationPlaceholderPath,
  remotePreviewUrl, storeLocalImage, validateLocalImageBytes, z,
  SourceSchema,
  type Status,
} from '@uk-aq-media/core';
import { directPublishState, facebookEligibility } from './direct-publish-eligibility';
import {
  configuredCawsIndex, configuredDsawspIndex, configuredNcasRouteKeys,
  configuredPublisherRssRouteKeys, discoverPublisherRss, fetchArticleHeadMetadata,
} from '@uk-aq-media/discovery';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = MAX_LOCAL_IMAGE_BYTES;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LIMIT = 50;

const ArticleSort = z.enum([
  'published_desc', 'published_asc', 'approved_desc', 'approved_asc',
  'discovered_desc', 'updated_desc',
]);
const SourceType = z.enum(['publisher', 'government']);
const PermissionBasis = z.string().trim().min(1).max(1000);
export const SourceMutation = z.object({
  publication_policy: PublicationPolicy.optional(),
  enabled: z.boolean().optional(),
  image_policy: ImagePolicy.optional(),
  permission_basis: PermissionBasis.optional(),
  confirm_local_copy_permitted: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.publication_policy === undefined && value.enabled === undefined &&
      value.image_policy === undefined) {
    context.addIssue({ code: 'custom', message: 'source_mutation_required' });
  }
  if (value.image_policy === undefined &&
      (value.permission_basis !== undefined || value.confirm_local_copy_permitted !== undefined)) {
    context.addIssue({ code: 'custom', message: 'image_policy_required_for_permission_evidence' });
  }
});
export const ArticleImagePolicyBody = z.object({
  image_policy: ImagePolicy,
  permission_basis: PermissionBasis.optional(),
  confirm_local_copy_permitted: z.boolean().optional(),
}).strict();
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
const ArticleAuthorBody = z.object({ author: z.string().max(500).nullable() }).strict();
const DATE_ONLY_PUBLISHED_AT = /^(\d{4})-(\d{2})-(\d{2})$/;
const DateOnlyPublishedAt = z.string().regex(DATE_ONLY_PUBLISHED_AT).refine(value => {
  const match = DATE_ONLY_PUBLISHED_AT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!;
});
const StoredPublishedAt = z.union([DateOnlyPublishedAt, z.iso.datetime({ offset: true })]);
const ArticlePublishedAtBody = z.object({ published_at: StoredPublishedAt.nullable() }).strict();
const ManualArticleBody = z.object({
  initial_status: z.enum(['pending', 'approved']),
  url: z.url().max(2048),
  title: z.string().min(1).max(1000),
  publisher: z.string().min(1).max(200),
  author: z.string().max(500).nullable().optional(),
  published_at: z.iso.datetime({ offset: true }).nullable().optional(),
  preview_image_url: z.url().max(2048).nullable().optional(),
}).strict();
export const MetadataApplyBody = z.object({
  expected_current_image_url: z.string().max(2048).nullable(),
  expected_proposed_image_url: z.url().max(2048).nullable(),
  replace_existing_image: z.boolean(),
  apply_publisher_display_title: z.boolean().default(true),
  expected_current_published_at: StoredPublishedAt.nullable().optional(),
  expected_proposed_published_at: z.iso.datetime({ offset: true }).nullable().optional(),
  apply_publisher_published_at: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.apply_publisher_published_at &&
      (value.expected_current_published_at !== null ||
       !value.expected_proposed_published_at)) {
    context.addIssue({ code: 'custom', message: 'invalid_published_at_apply' });
  }
});

type SourceRow = {
  source_key: string; name: string; canonical_domain: string; source_type: 'publisher' | 'government';
  enabled: number; publication_policy: 'manual' | 'auto_approve'; review_level: 'standard' | 'enhanced';
  priority: number; discovery_method: 'rss' | 'sitemap' | 'deferred'; discovery_config_json: string;
  content_fetch_policy: 'discovery_metadata_only' | 'article_head_allowed' | 'article_body_allowed';
  ai_content_policy: string;
  image_policy: 'remote_preview' | 'blocked' | 'local_copy_permitted';
  search_index_policy: 'metadata_only' | 'feed_body_text';
  created_at: string; updated_at: string;
};

type PermissionEvidence = { permission_basis: string; recorded_at: string };

export function validateImagePolicyEvidence(imagePolicy: z.infer<typeof ImagePolicy>,
  permissionBasis: string | undefined, confirmed: boolean | undefined): string | null {
  const basis = permissionBasis?.trim() || null;
  if (imagePolicy === 'local_copy_permitted') {
    if (!basis) throw new HttpError(400, 'local_copy_permission_basis_required');
    if (confirmed !== true) throw new HttpError(400, 'local_copy_confirmation_required');
  }
  return basis;
}

export function validateArticleImagePolicyEvidence(imagePolicy: z.infer<typeof ImagePolicy>,
  permissionBasis: string | undefined, confirmed: boolean | undefined): string | null {
  const basis = permissionBasis?.trim() || null;
  if (imagePolicy === 'local_copy_permitted' && confirmed !== true) {
    throw new HttpError(400, 'local_copy_confirmation_required');
  }
  return basis;
}

function permissionEvidence(createdAt: unknown, metadataJson: unknown): PermissionEvidence | null {
  if (typeof createdAt !== 'string' || typeof metadataJson !== 'string') return null;
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const basis = typeof metadata.permission_basis === 'string'
      ? metadata.permission_basis.trim() : '';
    if (metadata.operation !== 'image_policy' ||
        metadata.new_image_policy !== 'local_copy_permitted' ||
        basis.length < 1 || basis.length > 1000) return null;
    return { permission_basis: basis, recorded_at: createdAt };
  } catch { return null; }
}

export function sourceImagePolicyDisplay(sourceKey: string,
  imagePolicy: SourceRow['image_policy']): string {
  if (sourceKey.startsWith('discovered-publisher-') && imagePolicy === 'remote_preview') {
    return 'remote preview permitted / GDELT-discovered source';
  }
  if (imagePolicy === 'remote_preview') return 'remote preview permitted';
  if (imagePolicy === 'blocked') return 'preview images blocked';
  return 'local image copy permitted';
}

function presentSource(row: Record<string, unknown>): Record<string, unknown> {
  const { local_copy_permission_event_json: evidenceJson,
    local_copy_permission_recorded_at: evidenceRecordedAt, ...source } = row;
  const evidence = row.image_policy === 'local_copy_permitted'
    ? permissionEvidence(evidenceRecordedAt, evidenceJson) : null;
  return {
    ...source,
    image_policy_display: sourceImagePolicyDisplay(
      String(row.source_key), row.image_policy as SourceRow['image_policy']),
    local_copy_permission_evidence: evidence,
  };
}

type HeadMetadata = {
  publisher: string | null; title: string | null; compact_title: string | null;
  author: string | null; published_at: string | null; image_url: string | null;
  image_error: string | null;
  checked_at: string;
};

export type MetadataProvider = 'article_head' | 'publisher_rss';

export function metadataProviderFor(sourceKey: string): MetadataProvider {
  return sourceKey === 'openaq' ? 'publisher_rss' : 'article_head';
}

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

export function normaliseManualPublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const stored = StoredPublishedAt.safeParse(value);
  if (!stored.success) throw new HttpError(400, 'invalid_article_published_at_body');
  return DATE_ONLY_PUBLISHED_AT.test(stored.data) ? stored.data : new Date(stored.data).toISOString();
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

function normaliseArticleAuthor(value: string | null): string | null {
  if (value === null) return null;
  if (/[\r\n\u2028\u2029]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, 'invalid_article_author');
  }
  const author = value.trim();
  if ([...author].length > 500) throw new HttpError(400, 'invalid_article_author');
  return author || null;
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
    throw articleHeadHttpError(error);
  }
  const originalTitle = cleanText(metadata.ogTitle ?? metadata.twitterTitle ?? metadata.htmlTitle, 1000);
  const compact = cleanText(metadata.twitterTitle, 1000);
  const published = normalisePublisherPublishedAt(metadata.publishedAt);
  return {
    publisher: cleanText(metadata.publisher, 200), title: originalTitle,
    compact_title: compact && originalTitle && compact.length < originalTitle.length ? compact : null,
    author: cleanText(metadata.author, 500), published_at: published,
    image_url: metadata.previewUrl, image_error: metadata.previewError,
    checked_at: metadata.checkedAt,
  };
}

export function metadataFromOpenAqRss(canonicalUrl: string, publisher: string,
  articles: ReadonlyArray<{
    canonical_url: string;
    title: string;
    author: string | null;
    published_at: string | null;
    preview_url: string | null;
  }>, checkedAt: string): HeadMetadata | null {
  const article = articles.find(candidate => candidate.canonical_url === canonicalUrl);
  if (!article) return null;
  return {
    publisher: cleanText(publisher, 200), title: cleanText(article.title, 1000),
    compact_title: null, author: cleanText(article.author, 500),
    published_at: article.published_at && !Number.isNaN(Date.parse(article.published_at))
      ? new Date(article.published_at).toISOString() : null,
    image_url: article.preview_url,
    image_error: article.preview_url ? null : 'preview_image_metadata_missing',
    checked_at: checkedAt,
  };
}

export function requireOpenAqRssMetadata(canonicalUrl: string, publisher: string,
  articles: Parameters<typeof metadataFromOpenAqRss>[2], checkedAt: string): HeadMetadata {
  const metadata = metadataFromOpenAqRss(canonicalUrl, publisher, articles, checkedAt);
  if (!metadata) throw new HttpError(409, 'metadata_rss_article_not_found');
  return metadata;
}

async function fetchOpenAqRssMetadata(db: D1Database, canonicalUrl: string,
  sourceName: string): Promise<HeadMetadata> {
  const source = await loadSource(db, 'openaq');
  if (!source) throw new HttpError(409, 'metadata_rss_source_not_available');
  let observation: Awaited<ReturnType<typeof discoverPublisherRss>>;
  try {
    observation = await discoverPublisherRss(source, 'openaq-medium');
  } catch {
    throw new HttpError(502, 'metadata_rss_unavailable');
  }
  return requireOpenAqRssMetadata(canonicalUrl, sourceName, observation.articles,
    new Date().toISOString());
}

async function fetchMetadata(db: D1Database, canonicalUrl: string,
  source: Pick<SourceRow, 'source_key' | 'name' | 'canonical_domain' |
    'content_fetch_policy' | 'image_policy'>): Promise<HeadMetadata> {
  return metadataProviderFor(source.source_key) === 'publisher_rss'
    ? fetchOpenAqRssMetadata(db, canonicalUrl, source.name)
    : fetchHeadMetadata(canonicalUrl, source);
}

export function articleHeadHttpError(error: unknown): HttpError {
  const code = error instanceof Error ? error.message : 'metadata_unavailable';
  const status = code === 'article_head_not_permitted' ? 409
    : code === 'invalid_article_head_url' ? 400
    : code === 'article_head_too_large' ? 413
    : code === 'article_head_timeout' ? 504
    : code === 'article_head_not_html' ? 415
    : 502;
  return new HttpError(status, code);
}

export function metadataImageChange(currentImage: unknown, expectedProposal: string | null,
  fetchedProposal: string | null, replaceExisting: boolean): boolean {
  // A null proposal, or declining an existing-image replacement, makes this title-only;
  // do not couple that operation to unrelated image metadata drift.
  if (expectedProposal === null || currentImage !== null && !replaceExisting) return false;
  if (fetchedProposal !== expectedProposal) {
    throw new HttpError(409, 'metadata_proposal_changed');
  }
  return fetchedProposal !== currentImage;
}

export function normalisePublisherPublishedAt(value: string | null): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function metadataPublishedAtProposal(currentPublishedAt: unknown,
  publisherPublishedAt: string | null): { current: null; proposed: string } | null {
  return currentPublishedAt === null && publisherPublishedAt
    ? { current: null, proposed: publisherPublishedAt }
    : null;
}

export function metadataPublishedAtChange(currentPublishedAt: unknown,
  expectedCurrent: string | null | undefined, expectedProposal: string | null | undefined,
  fetchedProposal: string | null, apply: boolean): boolean {
  if (!apply) return false;
  if (expectedCurrent !== null || currentPublishedAt !== null) {
    throw new HttpError(409, 'metadata_current_published_at_changed');
  }
  if (expectedProposal === null || fetchedProposal !== expectedProposal) {
    throw new HttpError(409, 'metadata_published_at_proposal_changed');
  }
  return true;
}

async function sourceForUrl(db: D1Database, rawUrl: string): Promise<{
  source: SourceRow | null; domain: string; canonicalUrl: string; hash: string;
}> {
  const domain = safeHostname(rawUrl);

  // Only load sources whose configured domain can own this hostname. Explicit
  // configured sources win same-domain ties over GDELT/manual definitions, while
  // publisherHttpsUrl remains the final source/domain authority (including the
  // existing Independent legacy-domain alias).
  const { results } = await db.prepare(`SELECT * FROM media_sources
    WHERE retired_at IS NULL
      AND (? = lower(canonical_domain)
        OR ? LIKE '%.' || lower(canonical_domain)
        OR source_key IN ('the-independent', 'bbc-news'))
    ORDER BY length(canonical_domain) DESC,
      CASE WHEN source_key LIKE 'manual-%' THEN 2
        WHEN source_key LIKE 'discovered-publisher-%' THEN 1 ELSE 0 END,
      source_key`)
    .bind(domain, domain).all<SourceRow>();
  const source = results.find(candidate => publisherHttpsUrl(rawUrl, candidate)) ?? null;
  let canonicalUrl: string;
  try { canonicalUrl = canonicalizeUrl(rawUrl, source ?? domain); }
  catch { throw new HttpError(400, 'invalid_article_url'); }
  return { source, domain, canonicalUrl, hash: await canonicalUrlHash(canonicalUrl) };
}

function conservativeManualSource(domain: string, name: string, sourceKey: string): SourceRow {
  const now = new Date().toISOString();
  return { source_key: sourceKey, name, canonical_domain: domain, source_type: 'publisher', enabled: 0,
    publication_policy: 'manual', review_level: 'enhanced', priority: 50,
    discovery_method: 'deferred', discovery_config_json: '{"retain_excerpt":false}',
    content_fetch_policy: 'article_head_allowed', ai_content_policy: 'disabled',
    image_policy: 'remote_preview', search_index_policy: 'metadata_only',
    created_at: now, updated_at: now };
}

async function articleDetail(db: D1Database, id: number): Promise<Response> {
  const article = await db.prepare(`SELECT a.*, s.name AS source_name,
      s.canonical_domain, s.publication_policy AS source_publication_policy,
      s.content_fetch_policy AS source_content_fetch_policy,
      s.ai_content_policy AS source_ai_content_policy,
      s.image_policy AS source_image_policy,
      li.source_image_url AS local_image_source_url,
      li.content_sha256 AS local_image_content_sha256,
      li.content_type AS local_image_content_type,
      li.byte_size AS local_image_byte_size,
      li.acquisition_method AS local_image_acquisition_method,
      li.stored_at AS local_image_stored_at
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    LEFT JOIN media_article_local_images li ON li.article_id = a.id
    WHERE a.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!article) throw new HttpError(404, 'article_not_found');
  const [events, evidence, bluesky, blueskyCount, facebook, facebookCount,
    localCopyPermissionEvent] = await Promise.all([
    db.prepare(`SELECT id, event_type, actor_type, from_status, to_status, revision,
      created_at, metadata_json FROM media_article_events WHERE article_id = ?
      ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT provider_key, route_key, matched_author_keys_json,
      always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
      observation_count FROM media_article_discovery_evidence WHERE article_id = ?
      ORDER BY last_seen_at DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT id, publication_reason, status, post_uri, posted_at, last_error_code,
      next_attempt_at, created_at FROM media_bluesky_publications WHERE article_id = ?
      ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT count(*) AS publication_count,
      count(*) FILTER (WHERE status = 'posted') AS post_count,
      count(*) FILTER (WHERE status IN ('queued', 'posting')) AS in_progress_count
      FROM media_bluesky_publications WHERE article_id = ?`)
      .bind(id).first<{ publication_count: number; post_count: number; in_progress_count: number }>(),
    db.prepare(`SELECT id, publication_reason, status, attempt_count, facebook_post_id,
      facebook_permalink_url, last_error_code, next_attempt_at, remote_request_started_at,
      unknown_at, reconciled_at, reconciliation_method, created_at, last_attempted_at,
      posted_at, updated_at FROM media_facebook_publications WHERE article_id = ?
      ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare(`SELECT count(*) AS publication_count,
      count(*) FILTER (WHERE status = 'posted') AS post_count,
      count(*) FILTER (WHERE status IN ('queued', 'posting')) AS in_progress_count,
      count(*) FILTER (WHERE status = 'unknown_remote_state') AS unknown_remote_count
      FROM media_facebook_publications WHERE article_id = ?`)
      .bind(id).first<{ publication_count: number; post_count: number;
        in_progress_count: number; unknown_remote_count: number }>(),
    db.prepare(`SELECT created_at, metadata_json FROM media_article_events
      WHERE article_id = ? AND event_type = 'edited'
        AND json_extract(metadata_json, '$.operation') = 'image_policy'
      ORDER BY id DESC LIMIT 1`).bind(id)
      .first<{ created_at: string; metadata_json: string }>(),
  ]);
  const blueskyPublications: Array<Record<string, unknown>> = bluesky.results.map(row => ({ ...row,
    post_url: typeof row.post_uri === 'string' && row.post_uri.startsWith('at://')
      ? `https://bsky.app/profile/ukaq.co.uk/post/${row.post_uri.split('/').at(-1)}` : null }));
  const retainedLocalImage = article.image_policy === 'local_copy_permitted' &&
    article.source_image_policy === 'local_copy_permitted' &&
    article.local_image_source_url === article.og_image_url &&
    typeof article.local_image_content_sha256 === 'string';
  const thumbnailEligible = article.og_image_url !== null && (
    (article.image_policy === 'remote_preview' && article.source_image_policy === 'remote_preview') ||
    (article.image_policy === 'local_copy_permitted' &&
      article.source_image_policy === 'local_copy_permitted'));
  const manualPostReason = article.status === 'pending' ? 'pending_approved'
    : article.status === 'rejected' ? 'rejected_repost'
    : article.status === 'hidden' ? 'unhidden_repost' : null;
  const facebookCheck = article.status === 'approved'
    ? await facebookEligibility(db, [{ id, title: String(article.title),
      publisher: String(article.publisher), canonical_url: String(article.canonical_url) }])
    : null;
  const blueskyDirect = directPublishState('bluesky', article.status as Status,
    { hasInProgress: (blueskyCount?.in_progress_count ?? 0) > 0,
      hasUnknownRemoteState: false, postCount: blueskyCount?.post_count ?? 0 },
    thumbnailEligible ? null : 'thumbnail_missing');
  const facebookDirect = directPublishState('facebook', article.status as Status,
    { hasInProgress: (facebookCount?.in_progress_count ?? 0) > 0,
      hasUnknownRemoteState: (facebookCount?.unknown_remote_count ?? 0) > 0,
      postCount: facebookCount?.post_count ?? 0 },
    facebookCheck?.failures[0]?.error ?? null);
  const presentationImage = hasPermittedPresentationImage({
    source_key: String(article.source_key),
    og_image_url: typeof article.og_image_url === 'string' ? article.og_image_url : null,
    article_image_policy: String(article.image_policy),
    source_image_policy: String(article.source_image_policy),
    local_image_source_url: typeof article.local_image_source_url === 'string'
      ? article.local_image_source_url : null,
    local_image_content_sha256: typeof article.local_image_content_sha256 === 'string'
      ? article.local_image_content_sha256 : null,
  });
  const articleResponse = { ...article };
  for (const key of ['local_image_source_url', 'local_image_content_sha256',
    'local_image_content_type', 'local_image_byte_size', 'local_image_acquisition_method',
    'local_image_stored_at']) delete articleResponse[key];
  return json({ article: { ...articleResponse, local_image: {
      exists: retainedLocalImage,
      content_type: retainedLocalImage ? article.local_image_content_type : null,
      byte_size: retainedLocalImage ? article.local_image_byte_size : null,
      stored_at: retainedLocalImage ? article.local_image_stored_at : null,
      acquisition_method: retainedLocalImage ? article.local_image_acquisition_method : null,
    }, local_copy_permission_evidence: article.image_policy === 'local_copy_permitted'
      ? permissionEvidence(localCopyPermissionEvent?.created_at,
        localCopyPermissionEvent?.metadata_json) : null,
    admin_preview_image_path: presentationImage ? `/admin/articles/${id}/image` : null,
    admin_preview_image_version: retainedLocalImage
      ? article.local_image_content_sha256 : article.updated_at }, events: events.results,
    discovery_evidence: evidence.results,
    bluesky: { post_count: blueskyCount?.post_count ?? 0,
      publication_count: blueskyCount?.publication_count ?? 0,
      latest_status: blueskyPublications[0]?.status ?? null,
      ...blueskyDirect,
      manual_post_available: manualPostReason !== null && thumbnailEligible,
      manual_post_reason: manualPostReason,
      manual_post_unavailable_reason: manualPostReason && !thumbnailEligible ? 'thumbnail_missing' : null,
      thumbnail_eligible: thumbnailEligible, publications: blueskyPublications },
    facebook: { post_count: facebookCount?.post_count ?? 0,
      publication_count: facebookCount?.publication_count ?? 0,
      latest_status: facebook.results[0]?.status ?? null,
      ...facebookDirect,
      manual_post_reason: manualPostReason,
      publications: facebook.results } });
}

async function setArticleAuthor(request: Request, db: D1Database, id: number): Promise<Response> {
  const eventKey = `admin:author:${requireIdempotencyKey(request)}`;
  const parsed = ArticleAuthorBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_article_author_body');
  const requestedAuthor = normaliseArticleAuthor(parsed.data.author);
  const replay = await db.prepare(`SELECT article_id, event_type, to_status, revision, metadata_json
    FROM media_article_events WHERE event_key = ?`).bind(eventKey).first<{
      article_id: number; event_type: string; to_status: string; revision: number;
      metadata_json: string;
    }>();
  if (replay) {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(replay.metadata_json) as Record<string, unknown>; }
    catch { throw new HttpError(409, 'idempotency_key_conflict'); }
    const recordedRequest = Object.hasOwn(metadata, 'requested_author')
      ? metadata.requested_author : metadata.after;
    if (replay.article_id !== id || replay.event_type !== 'edited' ||
        metadata.field !== 'author' ||
        (typeof recordedRequest !== 'string' && recordedRequest !== null) ||
        (typeof metadata.after !== 'string' && metadata.after !== null) ||
        recordedRequest !== requestedAuthor) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    return json({ article: { id, status: replay.to_status, author: metadata.after,
      revision: replay.revision },
      replayed: true, changed: true });
  }
  const current = await db.prepare(`SELECT id, status, publisher, author, revision
    FROM media_articles WHERE id = ?`).bind(id).first<{
      id: number; status: string; publisher: string; author: string | null; revision: number;
    }>();
  if (!current) throw new HttpError(404, 'article_not_found');
  const author = normaliseArticleAuthorForStorage(requestedAuthor, current.publisher);
  if (current.author === author) {
    return json({ article: { id: current.id, status: current.status, author: current.author,
      revision: current.revision }, replayed: false, changed: false });
  }
  const now = new Date().toISOString();
  const nextRevision = current.revision + 1;
  const metadata = JSON.stringify({ field: 'author', requested_author: requestedAuthor,
    before: current.author, after: author });
  await db.batch([
    db.prepare(`UPDATE media_articles SET author = ?, mutation_key = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND author IS ?`)
      .bind(author, eventKey, nextRevision, now, id, current.revision, current.author),
    db.prepare(`INSERT INTO media_article_events
      (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
       created_at, metadata_json)
      SELECT id, ?, 'edited', 'admin', status, status, revision, ?, ?
      FROM media_articles WHERE id = ? AND revision = ? AND mutation_key = ?`)
      .bind(eventKey, now, metadata, id, nextRevision, eventKey),
  ]);
  const event = await db.prepare(`SELECT article_id, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey).first<{
      article_id: number; to_status: string; revision: number;
    }>();
  if (!event || event.article_id !== id) throw new HttpError(409, 'article_changed');
  return json({ article: { id, status: event.to_status, author, revision: event.revision },
    replayed: false, changed: true });
}

async function setArticlePublishedAt(request: Request, db: D1Database, id: number): Promise<Response> {
  const eventKey = `admin:published-at:${requireIdempotencyKey(request)}`;
  const parsed = ArticlePublishedAtBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_article_published_at_body');
  const publishedAt = normaliseManualPublishedAt(parsed.data.published_at);
  const replay = await db.prepare(`SELECT article_id, event_type, to_status, revision, metadata_json
    FROM media_article_events WHERE event_key = ?`).bind(eventKey).first<{
      article_id: number; event_type: string; to_status: string; revision: number;
      metadata_json: string;
    }>();
  if (replay) {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(replay.metadata_json) as Record<string, unknown>; }
    catch { throw new HttpError(409, 'idempotency_key_conflict'); }
    if (replay.article_id !== id || replay.event_type !== 'edited' ||
        metadata.field !== 'published_at' ||
        (typeof metadata.requested_published_at !== 'string' &&
          metadata.requested_published_at !== null) ||
        (typeof metadata.after !== 'string' && metadata.after !== null) ||
        metadata.requested_published_at !== publishedAt) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    return json({ article: { id, status: replay.to_status, published_at: metadata.after,
      revision: replay.revision }, replayed: true, changed: true });
  }
  const current = await db.prepare(`SELECT id, status, published_at, revision
    FROM media_articles WHERE id = ?`).bind(id).first<{
      id: number; status: string; published_at: string | null; revision: number;
    }>();
  if (!current) throw new HttpError(404, 'article_not_found');
  if (current.published_at === publishedAt) {
    return json({ article: { id: current.id, status: current.status,
      published_at: current.published_at, revision: current.revision },
      replayed: false, changed: false });
  }
  const now = new Date().toISOString();
  const nextRevision = current.revision + 1;
  const metadata = JSON.stringify({ field: 'published_at', requested_published_at: publishedAt,
    before: current.published_at, after: publishedAt });
  await db.batch([
    db.prepare(`UPDATE media_articles SET published_at = ?, mutation_key = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND published_at IS ?`)
      .bind(publishedAt, eventKey, nextRevision, now, id, current.revision, current.published_at),
    db.prepare(`INSERT INTO media_article_events
      (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
       created_at, metadata_json)
      SELECT id, ?, 'edited', 'admin', status, status, revision, ?, ?
      FROM media_articles WHERE id = ? AND revision = ? AND mutation_key = ?`)
      .bind(eventKey, now, metadata, id, nextRevision, eventKey),
  ]);
  const event = await db.prepare(`SELECT article_id, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(eventKey).first<{
      article_id: number; to_status: string; revision: number;
    }>();
  if (!event || event.article_id !== id) throw new HttpError(409, 'article_changed');
  await reconcileHomepageLatestSix(db);
  return json({ article: { id, status: event.to_status, published_at: publishedAt,
    revision: event.revision }, replayed: false, changed: true });
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
      if (state === 'original') return "(a.display_title IS NULL AND coalesce(a.ai_title_suggestion_state, '') NOT IN ('pending', 'rejected'))";
      if (state === 'publisher') return "a.display_title_origin = 'publisher' AND a.display_title IS NOT NULL AND coalesce(a.ai_title_suggestion_state, '') NOT IN ('pending', 'rejected')";
      if (state === 'human') return "a.display_title_origin = 'human'";
      if (state === 'ai') return "a.display_title_origin = 'ai'";
      if (state === 'pending_ai') return "a.display_title_origin IS NOT 'human' AND a.display_title_origin IS NOT 'ai' AND a.ai_title_suggestion_state = 'pending'";
      if (state === 'rejected_ai') return "a.display_title_origin IS NOT 'human' AND a.display_title_origin IS NOT 'ai' AND a.ai_title_suggestion_state = 'rejected'";
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
      a.display_title_origin, a.ai_title_suggestion, a.ai_title_suggestion_state,
      a.ai_title_model, a.ai_title_prompt_version, a.ai_title_generated_at,
      a.ai_title_decided_at, a.publisher, a.author,
      a.published_at, a.discovered_at, a.approved_at, a.updated_at, a.status,
      a.revision, a.approval_method, a.approval_author_rule_key, a.og_image_url,
      a.image_policy, s.image_policy AS source_image_policy,
      li.source_image_url AS local_image_source_url,
      li.content_sha256 AS local_image_content_sha256,
      (SELECT count(*) FROM media_bluesky_publications bp
        WHERE bp.article_id = a.id AND bp.status = 'posted')
        AS bluesky_post_count,
      (SELECT count(*) FROM media_bluesky_publications bp WHERE bp.article_id = a.id)
        AS bluesky_publication_count,
      (SELECT status FROM media_bluesky_publications bp WHERE bp.article_id = a.id
        ORDER BY bp.id DESC LIMIT 1) AS bluesky_latest_status,
      (SELECT count(*) FROM media_facebook_publications fp
        WHERE fp.article_id = a.id AND fp.status = 'posted') AS facebook_post_count,
      (SELECT count(*) FROM media_facebook_publications fp WHERE fp.article_id = a.id)
        AS facebook_publication_count,
      (SELECT status FROM media_facebook_publications fp WHERE fp.article_id = a.id
        ORDER BY fp.id DESC LIMIT 1) AS facebook_latest_status,
      ${spec.expression} AS cursor_value
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    LEFT JOIN media_article_local_images li ON li.article_id = a.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${spec.expression} ${spec.direction}, a.id ${spec.direction} LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit + 1).all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const rows: Array<Record<string, unknown>> = results.slice(0, limit).map(row => {
    const { local_image_source_url: localSourceUrl,
      local_image_content_sha256: localContentSha256, ...publicRow } = row;
    return { ...publicRow, admin_preview_image_path: hasPermittedPresentationImage({
      source_key: String(row.source_key),
      og_image_url: typeof row.og_image_url === 'string' ? row.og_image_url : null,
      article_image_policy: String(row.image_policy),
      source_image_policy: String(row.source_image_policy),
      local_image_source_url: typeof localSourceUrl === 'string' ? localSourceUrl : null,
      local_image_content_sha256: typeof localContentSha256 === 'string'
        ? localContentSha256 : null,
    }) ? `/admin/articles/${row.id}/image` : null,
    local_image_exists: row.image_policy === 'local_copy_permitted' &&
      row.source_image_policy === 'local_copy_permitted' &&
      localSourceUrl === row.og_image_url && typeof localContentSha256 === 'string',
    admin_preview_image_version: row.image_policy === 'local_copy_permitted' &&
      row.source_image_policy === 'local_copy_permitted' &&
      localSourceUrl === row.og_image_url ? localContentSha256 : row.updated_at };
  });
  const last = rows.at(-1);
  return json({ articles: rows, page: { limit, has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(String(last.cursor_value ?? ''), Number(last.id)) : null,
    sort } });
}

async function listSelectors(db: D1Database): Promise<Response> {
  const [sources, authors] = await Promise.all([
    db.prepare(`SELECT source_key, name FROM media_sources WHERE retired_at IS NULL
      ORDER BY name, source_key LIMIT 100`).all(),
    db.prepare(`SELECT DISTINCT author FROM media_articles WHERE author IS NOT NULL AND trim(author) != ''
      ORDER BY author COLLATE NOCASE LIMIT 250`).all(),
  ]);
  return json({ publications: sources.results, authors: authors.results.map(row => row.author) });
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
        ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS recent_run_started_at,
      (SELECT e.after_json FROM media_configuration_events e
        WHERE e.entity_type = 'source' AND e.entity_key = s.source_key
          AND json_extract(e.after_json, '$.operation') = 'image_policy'
        ORDER BY e.id DESC LIMIT 1) AS local_copy_permission_event_json,
      (SELECT e.created_at FROM media_configuration_events e
        WHERE e.entity_type = 'source' AND e.entity_key = s.source_key
          AND json_extract(e.after_json, '$.operation') = 'image_policy'
        ORDER BY e.id DESC LIMIT 1) AS local_copy_permission_recorded_at
    FROM media_sources s WHERE s.retired_at IS NULL
    ORDER BY s.name, s.source_key LIMIT 100`).all<Record<string, unknown>>();
  const rules = await db.prepare(`SELECT ar.* FROM media_author_rules ar
    JOIN media_sources s ON s.source_key = ar.source_key WHERE s.retired_at IS NULL
    ORDER BY ar.source_key, ar.display_name, ar.author_key LIMIT 250`)
    .all<Record<string, unknown>>();
  return json({ sources: results.map(presentSource), author_rules: rules.results.map(rule => ({
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
      : remotePreviewUrl(parsed.data.preview_image_url, source)) : null;
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
       content_fetch_policy, ai_content_policy, image_policy, search_index_policy,
       created_at, updated_at)
      VALUES (?, ?, ?, 'publisher', 0, 'manual', 'enhanced', 50, 'deferred',
        '{"retain_excerpt":false}', 'article_head_allowed', 'disabled', 'remote_preview',
        'metadata_only', ?, ?)`)
      .bind(sourceKey, parsed.data.publisher, identity.domain, now, now));
  }
  const approved = parsed.data.initial_status === 'approved';
  const publisher = cleanText(parsed.data.publisher, 200);
  const author = normaliseArticleAuthorForStorage(cleanText(parsed.data.author, 500),
    publisher ?? '');
  statements.push(db.prepare(`INSERT INTO media_articles
    (source_key, canonical_url, canonical_url_hash, original_url, title, publisher, author,
     published_at, discovered_at, last_seen_at, status, review_level, approval_method,
     approval_author_rule_key, og_image_url, image_policy, approved_at, revision,
     mutation_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?)`)
    .bind(sourceKey, identity.canonicalUrl, identity.hash, parsed.data.url,
      cleanText(parsed.data.title, 1000), publisher, author,
      parsed.data.published_at ?? null, now, now,
      parsed.data.initial_status, source.review_level, approved ? 'manual' : null,
      preview, source.image_policy, approved ? now : null, eventKey, now, now));
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
  await reconcileHomepageLatestSix(db);
  return articleDetail(db, created.id);
}

async function previewMetadata(db: D1Database, id: number): Promise<Response> {
  const row = await db.prepare(`SELECT a.id, a.canonical_url, a.title, a.display_title,
      a.display_title_origin, a.og_image_url, a.published_at, a.status, a.revision, s.*
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ?`).bind(id).first<Record<string, unknown> & SourceRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  const metadata = await fetchMetadata(db, String(row.canonical_url), row);
  const changes = {
    image: metadata.image_url && metadata.image_url !== row.og_image_url
      ? { current: row.og_image_url ?? null, proposed: metadata.image_url,
          expected_proposed_image_url: metadata.image_url,
          replacement_required: row.og_image_url !== null } : null,
    publisher_display_title: metadata.compact_title && row.display_title === null
      ? { current: null, proposed: metadata.compact_title } : null,
    published_at: metadataPublishedAtProposal(row.published_at, metadata.published_at),
  };
  return json({ article: { id, title: row.title, status: row.status, revision: row.revision },
    metadata, changes, has_useful_change: Boolean(changes.image || changes.publisher_display_title ||
      changes.published_at) });
}

async function applyMetadata(request: Request, db: D1Database, id: number): Promise<Response> {
  requireIdempotencyKey(request);
  const parsed = MetadataApplyBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_metadata_apply_body');
  const row = await db.prepare(`SELECT a.id, a.canonical_url, a.og_image_url, a.published_at,
      a.display_title, a.display_title_origin, s.* FROM media_articles a JOIN media_sources s
      ON s.source_key = a.source_key WHERE a.id = ?`).bind(id)
    .first<Record<string, unknown> & SourceRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  if (row.og_image_url !== parsed.data.expected_current_image_url) {
    throw new HttpError(409, 'metadata_current_image_changed');
  }
  const metadata = await fetchMetadata(db, String(row.canonical_url), row);
  const mayChangeImage = metadataImageChange(row.og_image_url,
    parsed.data.expected_proposed_image_url, metadata.image_url,
    parsed.data.replace_existing_image);
  const maySetTitle = Boolean(parsed.data.apply_publisher_display_title && metadata.compact_title &&
    row.display_title === null);
  const maySetPublishedAt = metadataPublishedAtChange(row.published_at,
    parsed.data.expected_current_published_at, parsed.data.expected_proposed_published_at,
    metadata.published_at, parsed.data.apply_publisher_published_at);
  if (!mayChangeImage && !maySetTitle && !maySetPublishedAt) {
    return json({ changed: false, reason: 'no_useful_change' });
  }
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
      og_image_url = CASE WHEN ? THEN ? ELSE og_image_url END,
      preview_metadata_checked_at = ?,
      display_title = CASE WHEN ? AND display_title IS NULL THEN ? ELSE display_title END,
      display_title_origin = CASE WHEN ? AND display_title IS NULL THEN 'publisher' ELSE display_title_origin END,
      published_at = CASE WHEN ? AND published_at IS NULL THEN ? ELSE published_at END,
      updated_at = ?
    WHERE id = ? AND og_image_url IS ? AND (? = 0 OR published_at IS ?)
    RETURNING id`).bind(Number(mayChangeImage), metadata.image_url, metadata.checked_at,
      Number(maySetTitle), metadata.compact_title, Number(maySetTitle),
      Number(maySetPublishedAt), metadata.published_at, now, id,
      parsed.data.expected_current_image_url, Number(maySetPublishedAt),
      parsed.data.expected_current_published_at ?? null).first<{ id: number }>();
  if (!changed) throw new HttpError(409, 'metadata_article_changed');
  await reconcileHomepageLatestSix(db);
  return articleDetail(db, id);
}

function requiredArticleRevision(request: Request): number {
  const raw = request.headers.get('If-Match')?.trim() ?? '';
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  if (!/^\d+$/.test(unquoted)) throw new HttpError(428, 'article_revision_required');
  const revision = Number(unquoted);
  if (!Number.isSafeInteger(revision)) throw new HttpError(400, 'invalid_article_revision');
  return revision;
}

async function setArticleImagePolicy(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const eventKey = `admin:image-policy:${requireIdempotencyKey(request)}`;
  const requestedRevision = requiredArticleRevision(request);
  const parsed = ArticleImagePolicyBody.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_article_image_policy_body');
  const permissionBasis = validateArticleImagePolicyEvidence(parsed.data.image_policy,
    parsed.data.permission_basis, parsed.data.confirm_local_copy_permitted);
  const sourcePermissionConfirmed = parsed.data.image_policy === 'local_copy_permitted' &&
    parsed.data.confirm_local_copy_permitted === true;
  const replay = await db.prepare(`SELECT article_id, event_type, revision, metadata_json
    FROM media_article_events WHERE event_key = ?`).bind(eventKey).first<{
      article_id: number; event_type: string; revision: number; metadata_json: string;
    }>();
  if (replay) {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(replay.metadata_json) as Record<string, unknown>; }
    catch { throw new HttpError(409, 'idempotency_key_conflict'); }
    if (replay.article_id !== id || replay.event_type !== 'edited' ||
        metadata.operation !== 'image_policy' ||
        metadata.requested_revision !== requestedRevision ||
        metadata.new_image_policy !== parsed.data.image_policy ||
        (metadata.permission_basis ?? null) !== permissionBasis ||
        Boolean(metadata.source_permission_confirmed) !== sourcePermissionConfirmed) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    return articleDetail(db, id);
  }
  const current = await db.prepare(`SELECT a.id, a.status, a.image_policy, a.revision,
      s.image_policy AS source_image_policy
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ?`).bind(id).first<{
      id: number; status: string; image_policy: z.infer<typeof ImagePolicy>;
      revision: number; source_image_policy: z.infer<typeof ImagePolicy>;
    }>();
  if (!current) throw new HttpError(404, 'article_not_found');
  if (current.revision !== requestedRevision) {
    throw new HttpError(409, 'article_revision_changed');
  }
  if (parsed.data.image_policy === 'local_copy_permitted' &&
      current.source_image_policy !== 'local_copy_permitted') {
    throw new HttpError(409, 'source_local_copy_not_permitted');
  }
  const changed = current.image_policy !== parsed.data.image_policy;
  if (!changed && current.image_policy !== 'local_copy_permitted') return articleDetail(db, id);
  const now = new Date().toISOString();
  const nextRevision = changed ? current.revision + 1 : current.revision;
  const metadata = JSON.stringify({ operation: 'image_policy',
    requested_revision: requestedRevision, previous_image_policy: current.image_policy,
    new_image_policy: parsed.data.image_policy, permission_basis: permissionBasis,
    source_permission_confirmed: sourcePermissionConfirmed, evidence_only: !changed });
  if (changed) {
    await db.batch([
      db.prepare(`UPDATE media_articles SET image_policy = ?, mutation_key = ?,
          revision = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND image_policy = ?
          AND (? != 'local_copy_permitted' OR EXISTS (
            SELECT 1 FROM media_sources s WHERE s.source_key = media_articles.source_key
              AND s.image_policy = 'local_copy_permitted'))`)
        .bind(parsed.data.image_policy, eventKey, nextRevision, now, id, current.revision,
          current.image_policy, parsed.data.image_policy),
      db.prepare(`INSERT INTO media_article_events
        (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
         created_at, metadata_json)
        SELECT id, ?, 'edited', 'admin', status, status, revision, ?, ?
        FROM media_articles WHERE id = ? AND revision = ? AND mutation_key = ?`)
        .bind(eventKey, now, metadata, id, nextRevision, eventKey),
    ]);
  } else {
    await db.prepare(`INSERT INTO media_article_events
      (article_id, event_key, event_type, actor_type, from_status, to_status, revision,
       created_at, metadata_json)
      SELECT a.id, ?, 'edited', 'admin', a.status, a.status, a.revision, ?, ?
      FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
      WHERE a.id = ? AND a.revision = ? AND a.image_policy = 'local_copy_permitted'
        AND s.image_policy = 'local_copy_permitted'`)
      .bind(eventKey, now, metadata, id, current.revision).run();
  }
  const event = await db.prepare(`SELECT article_id FROM media_article_events
    WHERE event_key = ?`).bind(eventKey).first<{ article_id: number }>();
  if (!event || event.article_id !== id) throw new HttpError(409, 'article_revision_changed');
  if (changed) await reconcileHomepageLatestSix(db);
  return articleDetail(db, id);
}

function localImageFailure(error: unknown): never {
  const code = error instanceof Error ? error.message : '';
  if (code === 'local_image_stale_write') throw new HttpError(409, code);
  if (code === 'local_copy_not_permitted') throw new HttpError(409, code);
  if (code === 'image_too_large') throw new HttpError(413, code);
  if (['invalid_image_content_type', 'image_signature_mismatch', 'image_empty'].includes(code)) {
    throw new HttpError(415, code);
  }
  throw error;
}

async function uploadLocalImage(request: Request, env: MediaAdminEnv, id: number): Promise<Response> {
  const requestKey = requireIdempotencyKey(request);
  const revision = requiredArticleRevision(request);
  let bytes: Uint8Array;
  try { bytes = await readBoundedImageResponse(request); }
  catch (error) { return localImageFailure(error); }
  let image;
  try { image = await validateLocalImageBytes(bytes, request.headers.get('Content-Type')); }
  catch (error) { return localImageFailure(error); }
  const existingOperation = await env.MEDIA_DB.prepare(`SELECT article_id, operation,
      article_revision, content_sha256 FROM media_article_local_image_operations
    WHERE request_key = ?`).bind(requestKey).first<{
      article_id: number; operation: string; article_revision: number; content_sha256: string | null;
    }>();
  if (existingOperation) {
    if (existingOperation.article_id !== id || existingOperation.operation !== 'upload' ||
        existingOperation.article_revision !== revision ||
        existingOperation.content_sha256 !== image.contentSha256) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    return articleDetail(env.MEDIA_DB, id);
  }
  const article = await env.MEDIA_DB.prepare(`SELECT a.revision, a.og_image_url,
      a.image_policy AS article_image_policy, s.image_policy AS source_image_policy
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ?`).bind(id).first<{
      revision: number; og_image_url: string | null;
      article_image_policy: string; source_image_policy: string;
    }>();
  if (!article) throw new HttpError(404, 'article_not_found');
  if (article.revision !== revision) throw new HttpError(409, 'article_revision_changed');
  if (!article.og_image_url || article.article_image_policy !== 'local_copy_permitted' ||
      article.source_image_policy !== 'local_copy_permitted') {
    throw new HttpError(409, 'local_copy_not_permitted');
  }
  try {
    await storeLocalImage(env.MEDIA_DB, env.MEDIA_IMAGES, {
      articleId: id, articleRevision: revision, sourceImageUrl: article.og_image_url,
      articleImagePolicy: article.article_image_policy,
      sourceImagePolicy: article.source_image_policy, image,
      acquisitionMethod: 'admin_upload', requestKey,
    });
  } catch (error) {
    const raced = await env.MEDIA_DB.prepare(`SELECT article_id, operation,
        article_revision, content_sha256 FROM media_article_local_image_operations
      WHERE request_key = ?`).bind(requestKey).first<{
        article_id: number; operation: string; article_revision: number;
        content_sha256: string | null;
      }>();
    if (!raced || raced.article_id !== id || raced.operation !== 'upload' ||
        raced.article_revision !== revision || raced.content_sha256 !== image.contentSha256) {
      if (raced) throw new HttpError(409, 'idempotency_key_conflict');
      localImageFailure(error);
    }
  }
  await reconcileHomepageLatestSix(env.MEDIA_DB);
  return articleDetail(env.MEDIA_DB, id);
}

async function removeLocalImage(request: Request, env: MediaAdminEnv, id: number): Promise<Response> {
  const requestKey = requireIdempotencyKey(request);
  const revision = requiredArticleRevision(request);
  const existingOperation = await env.MEDIA_DB.prepare(`SELECT article_id, operation,
      article_revision FROM media_article_local_image_operations WHERE request_key = ?`)
    .bind(requestKey).first<{ article_id: number; operation: string; article_revision: number }>();
  if (existingOperation) {
    if (existingOperation.article_id !== id || existingOperation.operation !== 'remove' ||
        existingOperation.article_revision !== revision) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
    return articleDetail(env.MEDIA_DB, id);
  }
  const current = await env.MEDIA_DB.prepare(`SELECT a.revision, li.object_key
    FROM media_articles a LEFT JOIN media_article_local_images li ON li.article_id = a.id
    WHERE a.id = ?`).bind(id).first<{ revision: number; object_key: string | null }>();
  if (!current) throw new HttpError(404, 'article_not_found');
  if (current.revision !== revision) throw new HttpError(409, 'article_revision_changed');
  const now = new Date().toISOString();
  let batchError: unknown = null;
  try {
    await env.MEDIA_DB.batch([
      env.MEDIA_DB.prepare(`INSERT INTO media_article_local_image_operations
          (request_key, article_id, operation, article_revision, created_at)
        SELECT ?, id, 'remove', revision, ? FROM media_articles
        WHERE id = ? AND revision = ?`).bind(requestKey, now, id, revision),
      env.MEDIA_DB.prepare(`DELETE FROM media_article_local_images WHERE article_id = ?
        AND EXISTS (SELECT 1 FROM media_article_local_image_operations
          WHERE request_key = ? AND article_id = ? AND operation = 'remove'
            AND article_revision = ?)`).bind(id, requestKey, id, revision),
      env.MEDIA_DB.prepare(`UPDATE media_articles SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND ? IS NOT NULL
          AND EXISTS (SELECT 1 FROM media_article_local_image_operations
            WHERE request_key = ? AND article_id = ? AND operation = 'remove'
              AND article_revision = ?)`)
        .bind(now, id, revision, current.object_key, requestKey, id, revision),
    ]);
  } catch (error) { batchError = error; }
  const recorded = await env.MEDIA_DB.prepare(`SELECT article_id, operation, article_revision
    FROM media_article_local_image_operations WHERE request_key = ?`).bind(requestKey)
    .first<{ article_id: number; operation: string; article_revision: number }>();
  if (!recorded) {
    if (batchError) throw batchError;
    throw new HttpError(409, 'article_revision_changed');
  }
  if (recorded.article_id !== id || recorded.operation !== 'remove' ||
      recorded.article_revision !== revision) throw new HttpError(409, 'idempotency_key_conflict');
  await reconcileHomepageLatestSix(env.MEDIA_DB);
  if (current.object_key) {
    try { await env.MEDIA_IMAGES.delete(current.object_key); }
    catch { /* authoritative D1 removal makes an R2 orphan unreachable */ }
  }
  return articleDetail(env.MEDIA_DB, id);
}

async function adminImage(env: MediaAdminEnv, id: number): Promise<Response> {
  const row = await env.MEDIA_DB.prepare(`SELECT a.source_key, a.og_image_url,
      a.image_policy AS article_image_policy, s.image_policy AS source_image_policy,
      s.canonical_domain, li.object_key, li.source_image_url, li.content_type,
      li.byte_size FROM media_articles a JOIN media_sources s
      ON s.source_key = a.source_key LEFT JOIN media_article_local_images li
      ON li.article_id = a.id WHERE a.id = ?`).bind(id).first<{
        source_key: string; og_image_url: string | null; article_image_policy: string;
        source_image_policy: string; canonical_domain: string; object_key: string | null;
        source_image_url: string | null; content_type: string | null; byte_size: number | null;
      }>();
  if (!row) throw new HttpError(404, 'image_not_found');
  if (row.article_image_policy === 'local_copy_permitted' &&
      row.source_image_policy === 'local_copy_permitted') {
    if (!row.object_key || row.source_image_url !== row.og_image_url || !row.content_type) {
      throw new HttpError(404, 'image_not_found');
    }
    const object = await env.MEDIA_IMAGES.get(row.object_key);
    if (!object) throw new HttpError(404, 'image_not_found');
    return new Response(object.body, { headers: {
      'Content-Type': row.content_type,
      'Content-Length': String(row.byte_size ?? object.size),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff',
    } });
  }
  if (row.article_image_policy !== 'remote_preview' ||
      row.source_image_policy !== 'remote_preview') throw new HttpError(404, 'image_not_found');
  const imageUrl = row.source_key === 'the-guardian' ? guardianRemotePreviewUrl(row.og_image_url)
    : remotePreviewUrl(row.og_image_url, row);
  if (!imageUrl) {
    const placeholderPath = sourcePresentationPlaceholderPath(row);
    if (!placeholderPath) throw new HttpError(404, 'image_not_found');
    const assetRequest = new Request(new URL(placeholderPath, 'https://media-assets.invalid'));
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (!assetResponse.ok) throw new HttpError(404, 'image_not_found');
    const headers = new Headers(assetResponse.headers);
    headers.set('Cache-Control', 'private, max-age=300');
    headers.set('Content-Security-Policy', "default-src 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(assetResponse.body, { status: 200, headers });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const imageFetch = await fetchRemotePreviewImage(imageUrl, row, controller.signal);
    if (!imageFetch.response) {
      throw new HttpError(imageFetch.failure === 'timeout' ? 504 : 502, 'image_upstream_failed');
    }
    const upstream = imageFetch.response;
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

function sourceCanEnable(source: SourceRow,
  mutation: z.infer<typeof SourceMutation>): boolean {
  try {
    const config = JSON.parse(source.discovery_config_json) as Record<string, unknown>;
    const parsed = SourceSchema.safeParse({
      source_key: source.source_key, name: source.name,
      canonical_domain: source.canonical_domain, source_type: source.source_type,
      enabled: true, publication_policy: mutation.publication_policy ?? source.publication_policy,
      review_level: source.review_level, priority: source.priority,
      discovery_method: source.discovery_method, discovery_config: config,
      content_fetch_policy: source.content_fetch_policy,
      ai_content_policy: source.ai_content_policy,
      image_policy: mutation.image_policy ?? source.image_policy,
      search_index_policy: source.search_index_policy,
    });
    if (!parsed.success) return false;
    if (parsed.data.discovery_method === 'rss') {
      return parsed.data.source_key === 'air-quality-news'
        ? parsed.data.discovery_config.url === 'https://airqualitynews.com/feed/'
        : parsed.data.source_key === 'the-guardian'
          ? (parsed.data.discovery_config.routes?.length ?? 0) > 0
          : configuredPublisherRssRouteKeys(parsed.data).length > 0;
    }
    if (parsed.data.discovery_method === 'sitemap') {
      if (parsed.data.source_key === 'communities-against-woodsmoke') {
        return configuredCawsIndex(parsed.data);
      }
      if (parsed.data.source_key === 'dsawsp') return configuredDsawspIndex(parsed.data);
      if (parsed.data.source_key === 'ncas') {
        return configuredNcasRouteKeys(parsed.data).length > 0;
      }
    }
    return false;
  } catch { return false; }
}

async function mutateSource(request: Request, db: D1Database, sourceKey: string): Promise<Response> {
  const eventKey = `admin:source:${requireIdempotencyKey(request)}`;
  const parsed = SourceMutation.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_source_mutation');
  const permissionBasis = parsed.data.image_policy === undefined ? null
    : validateImagePolicyEvidence(parsed.data.image_policy, parsed.data.permission_basis,
      parsed.data.confirm_local_copy_permitted);
  const existing = await db.prepare(`SELECT * FROM media_sources
    WHERE source_key = ? AND retired_at IS NULL`)
    .bind(sourceKey).first<SourceRow>();
  if (!existing) throw new HttpError(404, 'source_not_found');
  if (parsed.data.enabled === true && !Boolean(existing.enabled) &&
      !sourceCanEnable(existing, parsed.data)) {
    throw new HttpError(409, 'unsupported_source_adapter');
  }
  const replay = await db.prepare(`SELECT entity_key, after_json
    FROM media_configuration_events WHERE event_key = ?`).bind(eventKey)
    .first<{ entity_key: string; after_json: string }>();
  if (replay) {
    let recorded: Record<string, unknown>;
    try { recorded = JSON.parse(replay.after_json) as Record<string, unknown>; }
    catch { throw new HttpError(409, 'idempotency_key_conflict'); }
    if (replay.entity_key !== sourceKey ||
        (parsed.data.publication_policy !== undefined &&
          recorded.publication_policy !== parsed.data.publication_policy) ||
        (parsed.data.enabled !== undefined && recorded.enabled !== parsed.data.enabled) ||
        (parsed.data.image_policy !== undefined &&
          (recorded.operation !== 'image_policy' ||
           recorded.new_image_policy !== parsed.data.image_policy ||
           (recorded.permission_basis ?? null) !== permissionBasis))) {
      throw new HttpError(409, 'idempotency_key_conflict');
    }
  } else {
    const nextPublicationPolicy = parsed.data.publication_policy ?? existing.publication_policy;
    const nextEnabled = parsed.data.enabled === undefined ? existing.enabled : Number(parsed.data.enabled);
    const nextImagePolicy = parsed.data.image_policy ?? existing.image_policy;
    const imagePolicyChanged = nextImagePolicy !== existing.image_policy;
    const before: Record<string, unknown> = {
      publication_policy: existing.publication_policy,
      enabled: Boolean(existing.enabled),
      image_policy: existing.image_policy,
    };
    const after: Record<string, unknown> = {
      publication_policy: nextPublicationPolicy,
      enabled: Boolean(nextEnabled),
      image_policy: nextImagePolicy,
    };
    if (parsed.data.image_policy !== undefined) {
      Object.assign(after, { operation: 'image_policy',
        previous_image_policy: existing.image_policy,
        new_image_policy: nextImagePolicy, permission_basis: permissionBasis });
    }
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE media_sources SET publication_policy = ?, enabled = ?,
          image_policy = ?, updated_at = ?
        WHERE source_key = ? AND retired_at IS NULL`)
        .bind(nextPublicationPolicy, nextEnabled, nextImagePolicy, now, sourceKey),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'source', ?, 'updated', 'admin', ?, ?, ?)`)
        .bind(eventKey, sourceKey, JSON.stringify(before), JSON.stringify(after), now),
    ]);
    if (imagePolicyChanged) await reconcileHomepageLatestSix(db);
  }
  const source = await db.prepare(`SELECT s.*,
      (SELECT e.after_json FROM media_configuration_events e
        WHERE e.entity_type = 'source' AND e.entity_key = s.source_key
          AND json_extract(e.after_json, '$.operation') = 'image_policy'
        ORDER BY e.id DESC LIMIT 1) AS local_copy_permission_event_json,
      (SELECT e.created_at FROM media_configuration_events e
        WHERE e.entity_type = 'source' AND e.entity_key = s.source_key
          AND json_extract(e.after_json, '$.operation') = 'image_policy'
        ORDER BY e.id DESC LIMIT 1) AS local_copy_permission_recorded_at
    FROM media_sources s WHERE s.source_key = ? AND s.retired_at IS NULL`)
    .bind(sourceKey).first();
  return json({ source: source ? presentSource(source) : source, replayed: Boolean(replay) });
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
        content_fetch_policy, ai_content_policy, image_policy, search_index_policy,
        created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 'manual', 'standard', 50, 'deferred',
          '{"retain_excerpt":false}', 'discovery_metadata_only', 'disabled',
          CASE WHEN ? = 'publisher' THEN 'remote_preview' ELSE 'blocked' END,
          'metadata_only', ?, ?)`)
        .bind(parsed.data.source_key, cleanText(parsed.data.name, 200), host,
          parsed.data.source_type, parsed.data.source_type, now, now),
      db.prepare(`INSERT INTO media_configuration_events
        (event_key, entity_type, entity_key, action, actor_type, before_json, after_json, created_at)
        VALUES (?, 'source', ?, 'created', 'admin', NULL, ?, ?)`)
        .bind(eventKey, parsed.data.source_key, JSON.stringify({ ...parsed.data,
          canonical_domain: host, enabled: false, publication_policy: 'manual',
          review_level: 'standard', discovery_method: 'deferred',
          content_fetch_policy: 'discovery_metadata_only', ai_content_policy: 'disabled',
          image_policy: parsed.data.source_type === 'publisher' ? 'remote_preview' : 'blocked',
          search_index_policy: 'metadata_only' }), now),
    ]);
  }
  const source = await db.prepare('SELECT * FROM media_sources WHERE source_key = ?')
    .bind(replay?.entity_key ?? parsed.data.source_key).first();
  return json({ source: source ? presentSource(source) : source,
    replayed: Boolean(replay) }, replay ? 200 : 201);
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
  const articleAuthorMatch = /^\/admin\/articles\/([1-9]\d*)\/author$/.exec(url.pathname);
  if (articleAuthorMatch) {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    return setArticleAuthor(request, env.MEDIA_DB, Number(articleAuthorMatch[1]));
  }
  const articlePublishedAtMatch = /^\/admin\/articles\/([1-9]\d*)\/published-at$/.exec(url.pathname);
  if (articlePublishedAtMatch) {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    return setArticlePublishedAt(request, env.MEDIA_DB, Number(articlePublishedAtMatch[1]));
  }
  const articleImagePolicyMatch = /^\/admin\/articles\/([1-9]\d*)\/image-policy$/.exec(url.pathname);
  if (articleImagePolicyMatch) {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    return setArticleImagePolicy(request, env.MEDIA_DB, Number(articleImagePolicyMatch[1]));
  }
  const imageMatch = /^\/admin\/articles\/([1-9]\d*)\/image$/.exec(url.pathname);
  if (imageMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return adminImage(env, Number(imageMatch[1]));
  }
  const localImageMatch = /^\/admin\/articles\/([1-9]\d*)\/local-image$/.exec(url.pathname);
  if (localImageMatch) {
    const id = Number(localImageMatch[1]);
    if (request.method === 'PUT') return uploadLocalImage(request, env, id);
    if (request.method === 'DELETE') return removeLocalImage(request, env, id);
    return json({ error: 'method_not_allowed' }, 405);
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
