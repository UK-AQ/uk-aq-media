import {
  initialEditorialState, normaliseArticleAuthorForStorage, publisherAdmissionSql,
  type AuthorRule, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';

export function publicationAuthorRule(rules: AuthorRule[]): AuthorRule | null {
  return rules.find(rule => rule.publication_policy === 'auto_approve') ??
    rules.find(rule => rule.publication_policy === 'pending') ?? null;
}

export const POSSIBLE_DUPLICATE_REASON =
  'same_source_exact_title_same_published_at' as const;

const POSSIBLE_DUPLICATE_CANDIDATE_WHERE_SQL = `
  candidate.source_key = ?
  AND candidate.canonical_url_hash <> ?
  AND candidate.title = ?
  AND candidate.published_at IS NOT NULL
  AND instr(candidate.published_at, 'T') > 0
  AND instr(?, 'T') > 0
  AND julianday(candidate.published_at) = julianday(?)
  AND (? IS NULL OR candidate.author IS NULL OR candidate.author = ?)`;

function possibleDuplicateBindings(source: Source, article: DiscoveredArticle,
  storedAuthor: string | null): unknown[] {
  return [source.source_key, article.canonical_url_hash, article.title,
    article.published_at, article.published_at, storedAuthor, storedAuthor];
}

export const ARTICLE_CONFLICT_UPDATE_SQL = `
  ON CONFLICT(canonical_url_hash) DO UPDATE SET
    last_seen_at = max(media_articles.last_seen_at, excluded.last_seen_at),
    updated_at = max(media_articles.updated_at, excluded.updated_at),
    source_key = CASE WHEN EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
    ) AND NOT EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id
        AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
    ) THEN excluded.source_key ELSE media_articles.source_key END,
    original_url = CASE WHEN EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
    ) AND NOT EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id
        AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
    ) THEN excluded.original_url ELSE media_articles.original_url END,
    title = CASE WHEN EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
    ) AND NOT EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id
        AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
    ) THEN excluded.title ELSE media_articles.title END,
    publisher = CASE WHEN EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
    ) AND NOT EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id
        AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
    ) THEN excluded.publisher ELSE media_articles.publisher END,
    published_at = coalesce(media_articles.published_at, excluded.published_at),
    author = coalesce(media_articles.author, excluded.author),
    og_image_url = CASE
      WHEN media_articles.og_image_url IS NULL AND excluded.image_policy = 'remote_preview'
        AND (media_articles.image_policy = 'remote_preview' OR (EXISTS (
          SELECT 1 FROM media_article_discovery_evidence e
          WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
        ) AND NOT EXISTS (
          SELECT 1 FROM media_article_discovery_evidence e
          WHERE e.article_id = media_articles.id
            AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
        )))
        THEN excluded.og_image_url ELSE media_articles.og_image_url END,
    image_policy = CASE WHEN EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id AND e.provider_key = 'gdelt'
    ) AND NOT EXISTS (
      SELECT 1 FROM media_article_discovery_evidence e
      WHERE e.article_id = media_articles.id
        AND e.provider_key IN ('publisher_rss', 'publisher_web_index')
    ) THEN excluded.image_policy ELSE media_articles.image_policy END,
    topics_json = CASE WHEN media_articles.topics_json = '[]' AND excluded.topics_json != '[]'
      THEN excluded.topics_json ELSE media_articles.topics_json END,
    display_title = coalesce(media_articles.display_title, excluded.display_title),
    display_title_origin = CASE
      WHEN media_articles.display_title IS NULL AND excluded.display_title IS NOT NULL
        THEN excluded.display_title_origin ELSE media_articles.display_title_origin END,
    preview_metadata_checked_at = CASE
      WHEN media_articles.source_key = 'communities-against-woodsmoke'
        AND media_articles.preview_metadata_checked_at = '1970-01-01T00:00:00.000Z'
        AND excluded.preview_metadata_checked_at IS NOT NULL
      THEN excluded.preview_metadata_checked_at
      ELSE coalesce(media_articles.preview_metadata_checked_at,
        excluded.preview_metadata_checked_at) END,
    status = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN 'approved'
      ELSE media_articles.status END,
    approval_method = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN excluded.approval_method
      ELSE media_articles.approval_method END,
    approval_author_rule_key = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN excluded.approval_author_rule_key
      ELSE media_articles.approval_author_rule_key END,
    approved_at = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN excluded.approved_at
      ELSE media_articles.approved_at END,
    revision = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN media_articles.revision + 1
      ELSE media_articles.revision END,
    mutation_key = CASE WHEN media_articles.status = 'pending'
      AND excluded.approval_method = 'trusted_author_auto'
      AND NOT EXISTS (SELECT 1 FROM media_article_possible_duplicates possible_duplicate_hold
        WHERE possible_duplicate_hold.article_id = media_articles.id
          AND possible_duplicate_hold.resolved_at IS NULL)
      THEN excluded.mutation_key
      ELSE media_articles.mutation_key END`;

export function persistArticle(db: D1Database, source: Source, article: DiscoveredArticle,
  matchedRules: AuthorRule[], approvalObservationKey: string | null,
  now: string, isNewIdentity: boolean): D1PreparedStatement {
  const editorial = initialEditorialState(source, publicationAuthorRule(matchedRules));
  const storedAuthor = normaliseArticleAuthorForStorage(article.author, source.name);
  const possibleDuplicateCheck = isNewIdentity && editorial.status === 'approved';
  // Conflict updates preserve editorial decisions. Only Pending can be promoted by a later,
  // positively identified trusted-author observation; Rejected/Hidden always win.
  return db.prepare(`WITH possible_duplicate AS (
    SELECT candidate.id FROM media_articles candidate
    WHERE ? = 1 AND ${POSSIBLE_DUPLICATE_CANDIDATE_WHERE_SQL}
    ORDER BY candidate.id LIMIT 1
  )
  INSERT INTO media_articles (source_key, canonical_url, canonical_url_hash,
    original_url, title, publisher, author, published_at, discovered_at, last_seen_at,
    topics_json, status, review_level, approval_method, approval_author_rule_key,
    og_image_url, image_policy, display_title, display_title_origin, preview_metadata_checked_at,
    approved_at, mutation_key, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN EXISTS (SELECT 1 FROM possible_duplicate) THEN 'pending' ELSE ? END,
      ?,
      CASE WHEN EXISTS (SELECT 1 FROM possible_duplicate) THEN NULL ELSE ? END,
      CASE WHEN EXISTS (SELECT 1 FROM possible_duplicate) THEN NULL ELSE ? END,
      ?, ?, ?, ?, ?,
      CASE WHEN EXISTS (SELECT 1 FROM possible_duplicate) THEN NULL ELSE ? END,
      CASE WHEN EXISTS (SELECT 1 FROM possible_duplicate) THEN NULL ELSE ? END,
      ?, ?
    WHERE ${publisherAdmissionSql([article.canonical_url, article.original_url, ...(article.publisher_resolved_urls ?? [])])}
    ${ARTICLE_CONFLICT_UPDATE_SQL}
    RETURNING id, revision`).bind(Number(possibleDuplicateCheck),
      ...possibleDuplicateBindings(source, article, storedAuthor),
      source.source_key, article.canonical_url,
      article.canonical_url_hash, article.original_url, article.title, source.name, storedAuthor,
      article.published_at, now, now, JSON.stringify(article.categories), editorial.status,
      source.review_level, editorial.approval_method, editorial.approval_author_rule_key,
      article.preview_url, source.image_policy, article.display_title, article.display_title_origin,
      article.preview_metadata_checked_at, editorial.status === 'approved' ? now : null,
      approvalObservationKey, now, now);
}

export function persistPossibleDuplicateHold(db: D1Database, source: Source,
  article: DiscoveredArticle, matchedRules: AuthorRule[], now: string,
  isNewIdentity: boolean): D1PreparedStatement | null {
  const editorial = initialEditorialState(source, publicationAuthorRule(matchedRules));
  if (!isNewIdentity || editorial.status !== 'approved') return null;
  const storedAuthor = normaliseArticleAuthorForStorage(article.author, source.name);
  return db.prepare(`INSERT INTO media_article_possible_duplicates
    (article_id, candidate_article_id, reason_code, hold_created_at)
    SELECT held.id, candidate.id, ?, ?
    FROM media_articles held JOIN media_articles candidate
      ON ${POSSIBLE_DUPLICATE_CANDIDATE_WHERE_SQL}
    WHERE ${publisherAdmissionSql([article.canonical_url, article.original_url, ...(article.publisher_resolved_urls ?? [])])}
      AND held.canonical_url_hash = ? AND held.created_at = ?
      AND held.status = 'pending' AND held.approval_method IS NULL
      AND held.approval_author_rule_key IS NULL AND held.approved_at IS NULL
    ORDER BY candidate.id LIMIT 1
    ON CONFLICT(article_id) DO NOTHING`).bind(POSSIBLE_DUPLICATE_REASON, now,
      ...possibleDuplicateBindings(source, article, storedAuthor),
      article.canonical_url_hash, now);
}

export function persistDiscoveryEvidence(db: D1Database, source: Source, providerKey: string,
  routeKey: string, article: DiscoveredArticle, matchedRules: AuthorRule[],
  approvalObservationKey: string | null, now: string): D1PreparedStatement {
  const ruleKeys = matchedRules.map(rule => rule.author_key);
  const selectedAutoRule = matchedRules.find(rule => rule.publication_policy === 'auto_approve') ?? null;
  return db.prepare(`INSERT INTO media_article_discovery_evidence
    (article_id, source_key, provider_key, route_key, matched_author_keys_json,
      always_include_applied, author_auto_approval_applied, first_seen_at, last_seen_at,
      observation_count)
    SELECT (SELECT id FROM media_articles WHERE canonical_url_hash = ?), ?, ?, ?, ?, ?,
      CASE WHEN ? IS NOT NULL AND EXISTS (
        SELECT 1 FROM media_articles
        WHERE canonical_url_hash = ? AND mutation_key = ?
          AND approval_method = 'trusted_author_auto'
          AND approval_author_rule_key = ?
      ) THEN 1 ELSE 0 END, ?, ?, 1
    WHERE ${publisherAdmissionSql([article.canonical_url, article.original_url, ...(article.publisher_resolved_urls ?? [])])}
      AND EXISTS (SELECT 1 FROM media_articles WHERE canonical_url_hash = ?)
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
    .bind(article.canonical_url_hash, source.source_key, providerKey, routeKey,
      JSON.stringify(ruleKeys),
      Number(matchedRules.some(rule => rule.inclusion_policy === 'always_include')),
      approvalObservationKey, article.canonical_url_hash, approvalObservationKey,
      selectedAutoRule?.author_key ?? null, now, now, article.canonical_url_hash);
}
