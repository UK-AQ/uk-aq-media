import {
  SourceSchema, canonicalizeUrl, canonicalUrlHash, publisherHttpsUrl,
  reconcileHomepageLatestSix, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import {
  mediaDeterministicRelevanceFilter,
} from '@uk-aq-media/discovery';
import {
  persistArticle, persistDiscoveryEvidence,
} from '@uk-aq-media/discovery/persistence';
import {
  GdeltChunkSchema, GdeltFileCompleteSchema, GdeltFileStartSchema,
  GdeltRunFailSchema, GdeltRunFinishSchema, dateFromFileStamp, domainMatchesBoundary,
  enumerateFileStamps, gdeltArticleIdentityUrl, gdeltWindow, publisherDomainSuffixes,
  type GdeltCandidateInput,
} from './contracts';

type SourceRow = { discovery_config_json: string; enabled: number; [key: string]: unknown };
type ScopeRow = { publisher_domain: string; publisher_scope: 'uk' | 'non_uk' | 'unknown' };
type RunRow = { id: string; status: string; window_start: string; window_end: string };

function sourceFromRow(row: SourceRow): Source {
  const { discovery_config_json, enabled, ...fields } = row;
  return SourceSchema.parse({ ...fields, enabled: enabled === 1,
    discovery_config: JSON.parse(discovery_config_json) });
}

function validateFileInRun(run: RunRow, stamp: string): void {
  dateFromFileStamp(stamp);
  if (run.status !== 'running' || stamp < run.window_start || stamp > run.window_end) {
    throw new Error('gdelt_file_outside_run');
  }
}

async function loadRun(db: D1Database, runId: string): Promise<RunRow> {
  const run = await db.prepare(`SELECT id, status, window_start, window_end
    FROM media_gdelt_runs WHERE id = ?`).bind(runId).first<RunRow>();
  if (!run) throw new Error('gdelt_run_not_found');
  return run;
}

export async function startGdeltRun(db: D1Database, now = new Date()): Promise<{
  run_id: string; checkpoint_before: string | null; window_start: string; window_end: string;
  processed_file_stamps: string[];
}> {
  const state = await db.prepare(`SELECT checkpoint_minute FROM media_gdelt_state
    WHERE scope = 'global_web_ngrams'`).first<{ checkpoint_minute: string | null }>();
  if (!state) throw new Error('gdelt_state_unavailable');
  const window = gdeltWindow(now, state.checkpoint_minute);
  const runId = crypto.randomUUID();
  const startedAt = now.toISOString();
  const files = await db.prepare(`SELECT file_stamp FROM media_gdelt_files
    WHERE status = 'processed' AND file_stamp BETWEEN ? AND ? ORDER BY file_stamp LIMIT 100`)
    .bind(window.window_start, window.window_end).all<{ file_stamp: string }>();
  await db.prepare(`INSERT INTO media_gdelt_runs
    (id, started_at, status, checkpoint_before, window_start, window_end, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?)`).bind(runId, startedAt, window.checkpoint_before,
      window.window_start, window.window_end, startedAt).run();
  return { run_id: runId, ...window,
    processed_file_stamps: files.results.map(row => row.file_stamp) };
}

export async function startGdeltFile(db: D1Database, input: unknown,
  now = new Date()): Promise<{ ok: true; replayed: boolean }> {
  const data = GdeltFileStartSchema.parse(input);
  const run = await loadRun(db, data.run_id);
  validateFileInRun(run, data.file_stamp);
  const existing = await db.prepare(`SELECT run_id, status, expected_chunks, candidate_count,
    ngram_rows, matches_seen, malformed_ngram_rows, malformed_toc_rows
    FROM media_gdelt_files WHERE file_stamp = ?`)
    .bind(data.file_stamp).first<Record<string, unknown>>();
  if (existing?.status === 'processed') return { ok: true, replayed: true };
  if (existing) {
    for (const key of ['expected_chunks', 'candidate_count', 'ngram_rows', 'matches_seen',
      'malformed_ngram_rows', 'malformed_toc_rows'] as const) {
      if (Number(existing[key]) !== data[key]) throw new Error('gdelt_file_manifest_changed');
    }
    await db.prepare(`UPDATE media_gdelt_files SET run_id = ?, last_processed_at = ?
      WHERE file_stamp = ? AND status = 'processing'`).bind(data.run_id, now.toISOString(),
        data.file_stamp).run();
    return { ok: true, replayed: false };
  }
  const timestamp = now.toISOString();
  await db.prepare(`INSERT INTO media_gdelt_files
    (file_stamp, run_id, status, expected_chunks, candidate_count, ngram_rows, matches_seen,
      malformed_ngram_rows, malformed_toc_rows, first_processed_at, last_processed_at)
    VALUES (?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(data.file_stamp, data.run_id, data.expected_chunks, data.candidate_count,
      data.ngram_rows, data.matches_seen, data.malformed_ngram_rows, data.malformed_toc_rows,
      timestamp, timestamp).run();
  return { ok: true, replayed: false };
}

async function loadPublisherConfiguration(db: D1Database, candidates: GdeltCandidateInput[]):
Promise<{ sources: Source[]; scopes: ScopeRow[] }> {
  const suffixes = [...new Set(candidates.flatMap(candidate => {
    try { return publisherDomainSuffixes(gdeltArticleIdentityUrl(candidate.url).publisher_host); }
    catch { return []; }
  }))];
  if (!suffixes.length) return { sources: [], scopes: [] };
  const placeholders = suffixes.map(() => '?').join(', ');
  const [sourceRows, scopeRows] = await Promise.all([
    db.prepare(`SELECT source_key, name, canonical_domain, source_type, enabled,
      publication_policy, review_level, priority, discovery_method, discovery_config_json,
      content_fetch_policy, ai_content_policy, image_policy FROM media_sources
      WHERE retired_at IS NULL AND (canonical_domain IN (${placeholders})
        OR source_key = 'the-independent')
      ORDER BY length(canonical_domain) DESC, source_key LIMIT 50`).bind(...suffixes)
      .all<SourceRow>(),
    db.prepare(`SELECT publisher_domain, publisher_scope FROM media_publisher_domain_scope
      WHERE publisher_domain IN (${placeholders}) ORDER BY length(publisher_domain) DESC LIMIT 50`)
      .bind(...suffixes).all<ScopeRow>(),
  ]);
  return { sources: sourceRows.results.map(sourceFromRow), scopes: scopeRows.results };
}

function resolveSource(rawUrl: string, host: string, sources: Source[]): Source | null {
  return sources.find(source => publisherHttpsUrl(rawUrl, source) !== null &&
    (domainMatchesBoundary(host, source.canonical_domain) ||
      source.source_key === 'the-independent')) ?? null;
}

function classifyScope(host: string, publisherDomain: string, scopes: ScopeRow[]):
'uk' | 'non_uk' | 'unknown' {
  const explicit = scopes.find(scope => domainMatchesBoundary(host, scope.publisher_domain));
  if (explicit) return explicit.publisher_scope;
  return publisherDomain.endsWith('.uk') ? 'uk' : 'unknown';
}

async function dynamicPublisherSource(domain: string): Promise<Source> {
  return SourceSchema.parse({
    source_key: `discovered-publisher-${await canonicalUrlHash(domain)}`,
    name: domain,
    canonical_domain: domain,
    source_type: 'publisher',
    enabled: false,
    publication_policy: 'manual',
    review_level: 'enhanced',
    priority: 50,
    discovery_method: 'deferred',
    discovery_config: { retain_excerpt: false },
    content_fetch_policy: 'discovery_metadata_only',
    ai_content_policy: 'disabled',
    image_policy: 'remote_preview',
  });
}

type PreparedCandidate = {
  input: GdeltCandidateInput;
  canonical_url: string;
  canonical_url_hash: string;
  publisher_host: string;
  publisher_domain: string;
  publisher_scope: 'uk' | 'non_uk' | 'unknown';
  source: Source | null;
  relevant: boolean;
};

async function prepareCandidate(input: GdeltCandidateInput, sources: Source[], scopes: ScopeRow[]):
Promise<PreparedCandidate> {
  const identity = gdeltArticleIdentityUrl(input.url);
  const source = resolveSource(identity.raw_url, identity.publisher_host, sources);
  let canonical_url: string;
  try { canonical_url = canonicalizeUrl(identity.raw_url, source ?? identity.publisher_host); }
  catch { canonical_url = canonicalizeUrl(identity.raw_url, identity.publisher_host); }
  const publisher_scope = classifyScope(identity.publisher_host, identity.publisher_domain, scopes);
  return { input, canonical_url, canonical_url_hash: await canonicalUrlHash(canonical_url),
    publisher_host: identity.publisher_host, publisher_domain: identity.publisher_domain,
    publisher_scope, source,
    relevant: mediaDeterministicRelevanceFilter.evaluate({ title: input.title,
      canonical_url, categories: [] }).relevant };
}

function insertDynamicSource(db: D1Database, source: Source, now: string): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO media_sources
    (source_key, name, canonical_domain, source_type, enabled, publication_policy,
      review_level, priority, discovery_method, discovery_config_json,
      content_fetch_policy, ai_content_policy, image_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      source.source_key, source.name, source.canonical_domain, source.source_type,
      Number(source.enabled), source.publication_policy, source.review_level, source.priority,
      source.discovery_method, JSON.stringify(source.discovery_config),
      source.content_fetch_policy, source.ai_content_policy, source.image_policy, now, now);
}

function persistCandidate(db: D1Database, candidate: PreparedCandidate, fileStamp: string,
  now: string): D1PreparedStatement {
  const input = candidate.input;
  return db.prepare(`INSERT INTO media_gdelt_candidates
    (canonical_url, canonical_url_hash, title, language, publisher_host, publisher_domain,
      publisher_scope, provider_observed_first_at, provider_observed_last_at, first_seen_at,
      last_seen_at, first_file_stamp, last_file_stamp, observation_count, created_at, updated_at)
    VALUES (?, ?, ?, 'English', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(canonical_url_hash) DO UPDATE SET
      title = CASE WHEN excluded.provider_observed_last_at >= media_gdelt_candidates.provider_observed_last_at
        THEN excluded.title ELSE media_gdelt_candidates.title END,
      publisher_host = excluded.publisher_host,
      publisher_domain = excluded.publisher_domain,
      publisher_scope = excluded.publisher_scope,
      provider_observed_first_at = min(media_gdelt_candidates.provider_observed_first_at,
        excluded.provider_observed_first_at),
      provider_observed_last_at = max(media_gdelt_candidates.provider_observed_last_at,
        excluded.provider_observed_last_at),
      first_seen_at = min(media_gdelt_candidates.first_seen_at, excluded.first_seen_at),
      last_seen_at = max(media_gdelt_candidates.last_seen_at, excluded.last_seen_at),
      first_file_stamp = min(media_gdelt_candidates.first_file_stamp, excluded.first_file_stamp),
      last_file_stamp = max(media_gdelt_candidates.last_file_stamp, excluded.last_file_stamp),
      observation_count = media_gdelt_candidates.observation_count + 1,
      updated_at = max(media_gdelt_candidates.updated_at, excluded.updated_at)`)
    .bind(candidate.canonical_url, candidate.canonical_url_hash, input.title,
      candidate.publisher_host, candidate.publisher_domain, candidate.publisher_scope,
      input.provider_observed_at, input.provider_observed_at, now, now, fileStamp, fileStamp,
      now, now);
}

function persistCandidateFamily(db: D1Database, candidate: PreparedCandidate,
  family: GdeltCandidateInput['families'][number], fileStamp: string, now: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO media_gdelt_candidate_families
    (candidate_id, family_key, matched_phrases_json, first_seen_at, last_seen_at,
      first_file_stamp, last_file_stamp, observation_count)
    VALUES ((SELECT id FROM media_gdelt_candidates WHERE canonical_url_hash = ?), ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(candidate_id, family_key) DO UPDATE SET
      matched_phrases_json = (
        SELECT json_group_array(phrase) FROM (
          SELECT value AS phrase FROM json_each(media_gdelt_candidate_families.matched_phrases_json)
          UNION SELECT value AS phrase FROM json_each(excluded.matched_phrases_json)
          ORDER BY phrase
        )
      ),
      last_seen_at = max(media_gdelt_candidate_families.last_seen_at, excluded.last_seen_at),
      first_seen_at = min(media_gdelt_candidate_families.first_seen_at, excluded.first_seen_at),
      first_file_stamp = min(media_gdelt_candidate_families.first_file_stamp, excluded.first_file_stamp),
      last_file_stamp = max(media_gdelt_candidate_families.last_file_stamp, excluded.last_file_stamp),
      observation_count = media_gdelt_candidate_families.observation_count + 1`)
    .bind(candidate.canonical_url_hash, family.family_key,
      JSON.stringify(family.matched_phrases), now, now, fileStamp, fileStamp);
}

function discoveredArticle(candidate: PreparedCandidate): DiscoveredArticle {
  return { canonical_url: candidate.canonical_url,
    canonical_url_hash: candidate.canonical_url_hash,
    original_url: candidate.input.url,
    title: candidate.input.title,
    author: null,
    published_at: null,
    categories: candidate.input.families.map(family => family.family_key),
    title_context: null,
    preview_url: null,
    display_title: null,
    display_title_origin: null,
    preview_metadata_checked_at: null };
}

export async function ingestGdeltChunk(db: D1Database, input: unknown,
  now = new Date()): Promise<{ ok: true; replayed: boolean; candidate_count: number }> {
  const data = GdeltChunkSchema.parse(input);
  const run = await loadRun(db, data.run_id);
  validateFileInRun(run, data.file_stamp);
  const file = await db.prepare(`SELECT status, run_id, expected_chunks FROM media_gdelt_files
    WHERE file_stamp = ?`).bind(data.file_stamp)
    .first<{ status: string; run_id: string; expected_chunks: number }>();
  if (!file || file.status !== 'processing' || file.run_id !== data.run_id ||
      data.chunk_index >= file.expected_chunks) throw new Error('gdelt_file_not_processing');
  const payloadHash = await canonicalUrlHash(JSON.stringify(data.candidates));
  const existingChunk = await db.prepare(`SELECT payload_hash, uk_promoted FROM media_gdelt_file_chunks
    WHERE file_stamp = ? AND chunk_index = ?`).bind(data.file_stamp, data.chunk_index)
    .first<{ payload_hash: string; uk_promoted: number }>();
  if (existingChunk) {
    if (existingChunk.payload_hash !== payloadHash) throw new Error('gdelt_chunk_payload_changed');
    if (existingChunk.uk_promoted > 0) await reconcileHomepageLatestSix(db);
    return { ok: true, replayed: true, candidate_count: data.candidates.length };
  }

  const configuration = await loadPublisherConfiguration(db, data.candidates);
  const prepared = await Promise.all(data.candidates.map(candidate =>
    prepareCandidate(candidate, configuration.sources, configuration.scopes)));
  const placeholders = prepared.map(() => '?').join(', ');
  const hashes = prepared.map(candidate => candidate.canonical_url_hash);
  const [existingCandidates, existingArticles] = await Promise.all([
    db.prepare(`SELECT canonical_url_hash, promoted_article_id FROM media_gdelt_candidates
      WHERE canonical_url_hash IN (${placeholders})`).bind(...hashes)
      .all<{ canonical_url_hash: string; promoted_article_id: number | null }>(),
    db.prepare(`SELECT canonical_url_hash FROM media_articles WHERE canonical_url_hash IN (${placeholders})`)
      .bind(...hashes).all<{ canonical_url_hash: string }>(),
  ]);
  const existingCandidateMap = new Map(existingCandidates.results.map(row =>
    [row.canonical_url_hash, row.promoted_article_id]));
  const existingArticleHashes = new Set(existingArticles.results.map(row => row.canonical_url_hash));
  const timestamp = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  let uk = 0;
  let nonUk = 0;
  let unknown = 0;
  let promoted = 0;
  let relevanceFiltered = 0;
  for (const candidate of prepared) {
    if (candidate.publisher_scope === 'uk') uk++;
    else if (candidate.publisher_scope === 'non_uk') nonUk++;
    else unknown++;
    let source = candidate.source;
    if (candidate.publisher_scope === 'uk' && !source) {
      source = await dynamicPublisherSource(candidate.publisher_domain);
      statements.push(insertDynamicSource(db, source, timestamp));
    }
    statements.push(persistCandidate(db, candidate, data.file_stamp, timestamp));
    for (const family of candidate.input.families) {
      statements.push(persistCandidateFamily(db, candidate, family, data.file_stamp, timestamp));
    }
    if (candidate.publisher_scope !== 'uk') continue;
    if (!candidate.relevant) { relevanceFiltered++; continue; }
    if (!source) throw new Error('gdelt_uk_source_unavailable');
    const article = discoveredArticle(candidate);
    statements.push(persistArticle(db, source, article, [], null, timestamp));
    for (const family of candidate.input.families) {
      statements.push(persistDiscoveryEvidence(db, source, 'gdelt', family.family_key,
        article, [], null, timestamp));
    }
    statements.push(db.prepare(`UPDATE media_gdelt_candidates SET promoted_article_id =
      (SELECT id FROM media_articles WHERE canonical_url_hash = ?), updated_at = ?
      WHERE canonical_url_hash = ?`).bind(candidate.canonical_url_hash, timestamp,
        candidate.canonical_url_hash));
    if (!existingCandidateMap.get(candidate.canonical_url_hash)) promoted++;
  }
  statements.push(db.prepare(`INSERT INTO media_gdelt_file_chunks
    (file_stamp, chunk_index, payload_hash, candidate_count, candidates_inserted,
      candidates_updated, candidates_uk, candidates_non_uk, candidates_unknown,
      uk_promoted, uk_relevance_filtered, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(data.file_stamp, data.chunk_index, payloadHash, prepared.length,
      prepared.filter(candidate => !existingCandidateMap.has(candidate.canonical_url_hash)).length,
      prepared.filter(candidate => existingCandidateMap.has(candidate.canonical_url_hash)).length,
      uk, nonUk, unknown, promoted, relevanceFiltered, timestamp));
  try { await db.batch(statements); }
  catch (error) {
    const replay = await db.prepare(`SELECT payload_hash, uk_promoted FROM media_gdelt_file_chunks
      WHERE file_stamp = ? AND chunk_index = ?`).bind(data.file_stamp, data.chunk_index)
      .first<{ payload_hash: string; uk_promoted: number }>();
    if (replay?.payload_hash === payloadHash) {
      if (replay.uk_promoted > 0) await reconcileHomepageLatestSix(db);
      return { ok: true, replayed: true, candidate_count: prepared.length };
    }
    throw error;
  }
  if (promoted > 0 || prepared.some(candidate => existingArticleHashes.has(candidate.canonical_url_hash))) {
    await reconcileHomepageLatestSix(db);
  }
  return { ok: true, replayed: false, candidate_count: prepared.length };
}

export async function completeGdeltFile(db: D1Database, input: unknown,
  now = new Date()): Promise<{ ok: true; replayed: boolean }> {
  const data = GdeltFileCompleteSchema.parse(input);
  const run = await loadRun(db, data.run_id);
  validateFileInRun(run, data.file_stamp);
  const file = await db.prepare(`SELECT status, run_id, expected_chunks, candidate_count,
    matches_seen, malformed_ngram_rows, malformed_toc_rows FROM media_gdelt_files WHERE file_stamp = ?`)
    .bind(data.file_stamp).first<{ status: string; run_id: string; expected_chunks: number;
      candidate_count: number; matches_seen: number; malformed_ngram_rows: number;
      malformed_toc_rows: number }>();
  if (!file) throw new Error('gdelt_file_not_found');
  if (file.status === 'processed') return { ok: true, replayed: true };
  if (file.run_id !== data.run_id) throw new Error('gdelt_file_run_mismatch');
  const totals = await db.prepare(`SELECT count(*) AS chunks,
    coalesce(sum(candidate_count), 0) AS candidates,
    coalesce(sum(candidates_inserted), 0) AS inserted,
    coalesce(sum(candidates_updated), 0) AS updated,
    coalesce(sum(candidates_uk), 0) AS uk,
    coalesce(sum(candidates_non_uk), 0) AS non_uk,
    coalesce(sum(candidates_unknown), 0) AS unknown_scope,
    coalesce(sum(uk_promoted), 0) AS promoted,
    coalesce(sum(uk_relevance_filtered), 0) AS filtered
    FROM media_gdelt_file_chunks WHERE file_stamp = ?`).bind(data.file_stamp)
    .first<Record<string, number>>();
  if (!totals || totals.chunks !== file.expected_chunks || totals.candidates !== file.candidate_count) {
    throw new Error('gdelt_file_chunks_incomplete');
  }
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE media_gdelt_files SET status = 'processed', completed_at = ?,
      last_processed_at = ? WHERE file_stamp = ? AND status = 'processing'`)
      .bind(timestamp, timestamp, data.file_stamp),
    db.prepare(`UPDATE media_gdelt_runs SET
      complete_pairs_processed = complete_pairs_processed + 1,
      matches_seen = matches_seen + ?, candidates_inserted = candidates_inserted + ?,
      candidates_updated = candidates_updated + ?, candidates_uk = candidates_uk + ?,
      candidates_non_uk = candidates_non_uk + ?, candidates_unknown = candidates_unknown + ?,
      uk_promoted = uk_promoted + ?, uk_relevance_filtered = uk_relevance_filtered + ?,
      malformed_rows = malformed_rows + ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .bind(file.matches_seen, totals.inserted, totals.updated, totals.uk, totals.non_uk,
        totals.unknown_scope, totals.promoted, totals.filtered,
        file.malformed_ngram_rows + file.malformed_toc_rows,
        timestamp, data.run_id),
  ]);
  return { ok: true, replayed: false };
}

export async function finishGdeltRun(db: D1Database, input: unknown,
  now = new Date()): Promise<Record<string, unknown>> {
  const data = GdeltRunFinishSchema.parse(input);
  const run = await loadRun(db, data.run_id);
  validateFileInRun(run, data.completed_through);
  const minutes = enumerateFileStamps(run.window_start, data.completed_through).length;
  if (data.missing_minutes + data.complete_pairs_replayed > minutes) {
    throw new Error('gdelt_run_counts_invalid');
  }
  const pending = await db.prepare(`SELECT count(*) AS count FROM media_gdelt_files
    WHERE run_id = ? AND status = 'processing'`).bind(data.run_id).first<{ count: number }>();
  if ((pending?.count ?? 0) > 0) throw new Error('gdelt_run_files_incomplete');
  const state = await db.prepare(`SELECT checkpoint_minute FROM media_gdelt_state
    WHERE scope = 'global_web_ngrams'`).first<{ checkpoint_minute: string | null }>();
  if (!state) throw new Error('gdelt_state_unavailable');
  const checkpointAfter = !state.checkpoint_minute || data.completed_through > state.checkpoint_minute
    ? data.completed_through : state.checkpoint_minute;
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE media_gdelt_state SET checkpoint_minute = ?, updated_at = ?
      WHERE scope = 'global_web_ngrams'`).bind(checkpointAfter, timestamp),
    db.prepare(`UPDATE media_gdelt_runs SET status = 'succeeded', finished_at = ?,
      checkpoint_after = ?, completed_through = ?, minutes_checked = ?,
      missing_minutes = ?, complete_pairs_replayed = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`).bind(timestamp, checkpointAfter,
        data.completed_through, minutes, data.missing_minutes,
        data.complete_pairs_replayed, timestamp, data.run_id),
  ]);
  return { ok: true, run_id: data.run_id, checkpoint_after: checkpointAfter,
    completed_through: data.completed_through, minutes_checked: minutes };
}

export async function failGdeltRun(db: D1Database, input: unknown,
  now = new Date()): Promise<{ ok: true }> {
  const data = GdeltRunFailSchema.parse(input);
  await db.prepare(`UPDATE media_gdelt_runs SET status = 'failed', finished_at = ?,
    error_code = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .bind(now.toISOString(), data.error_code, now.toISOString(), data.run_id).run();
  return { ok: true };
}
