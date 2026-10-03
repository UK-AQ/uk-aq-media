import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import {
  canonicalUrlHash, canonicalizeUrl, type DiscoveredArticle, SourceSchema,
} from '@uk-aq-media/core';
import { persistArticle, persistDiscoveryEvidence } from '@uk-aq-media/discovery/persistence';
import {
  domainMatchesBoundary, GDELT_MAX_NGRAM_LINE_BYTES, GDELT_MAX_UNRESOLVED_DOCID_SAMPLE,
  gdeltArticleIdentityUrl, gdeltSafeTarget, gdeltWindow,
  matchGdeltFamilies,
  registrablePublisherDomain, type GdeltCandidateInput,
} from '@uk-aq-media/gdelt';
import {
  completeGdeltFile, ingestGdeltChunk, startGdeltFile, startGdeltRun,
} from '@uk-aq-media/gdelt/ingest';
import {
  boundedLines, fixtureLines, GdeltCatchupNoProgressError, GdeltTocResolutionError,
  gdeltIngestResponseErrorCode, parseNgramLine, parseTocLine, resolveTocLines, runGdeltCatchup,
  scanNgramLines, warnPartialTocResolution, type GdeltBatchResult,
} from '@uk-aq-media/gdelt/scanner';
import mediaDiscoveryWorker, { assertEmptyGdeltStartBody } from '../apps/media-discovery/src/index';
import { reconcileHomepageLatestSixAfterSourceCommit } from '@uk-aq-media/discovery';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private parameters: SqlValue[] = [];

  constructor(readonly statement: StatementSync) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.parameters = values as SqlValue[];
    return this as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.parameters) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.statement.all(...this.parameters) as T[],
      meta: {} as D1Meta & Record<string, unknown> };
  }

  async run(): Promise<D1Result> {
    const result = /\bRETURNING\b/i.test(this.statement.sourceSQL)
      ? this.statement.all(...this.parameters)
      : this.statement.run(...this.parameters);
    return { success: true, results: [],
      meta: result as unknown as D1Meta & Record<string, unknown> };
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  const facade = {
    prepare(sql: string) {
      return new SqliteD1Statement(database.prepare(sql)) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return facade as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  for (const filename of readdirSync('migrations').filter(value => /^\d+.*\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(`migrations/${filename}`, 'utf8'));
  }
}

function candidate(url: string, title: string, family: GdeltCandidateInput['families'][number],
  observed = '2026-09-13T12:00:00.000Z'): GdeltCandidateInput {
  return { url, title, language: 'English', provider_observed_at: observed, families: [family] };
}

const families = {
  air: { family_key: 'gdelt-air-quality', matched_phrases: ['air quality'] },
  pollution: { family_key: 'gdelt-air-pollution', matched_phrases: ['air pollution'] },
  wildfire: { family_key: 'gdelt-wildfire', matched_phrases: ['wildfires'] },
  wood: { family_key: 'gdelt-wood-burning', matched_phrases: ['wood burning'] },
} as const satisfies Record<string, GdeltCandidateInput['families'][number]>;

function gdeltBatchResult(checkpointBefore: string | null,
  checkpointAfter: string): GdeltBatchResult {
  return { ok: true, run_id: 'fixture-run', checkpoint_before: checkpointBefore,
    checkpoint_after: checkpointAfter, window_start: checkpointAfter,
    window_end: checkpointAfter, completed_through: checkpointAfter, minutes_checked: 1 };
}

await assertEmptyGdeltStartBody(new Request('https://media.example/gdelt/web-ngrams/runs/start', {
  method: 'POST',
}));
const emptyStartStream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
await assertEmptyGdeltStartBody(new Request('https://media.example/gdelt/web-ngrams/runs/start', {
  method: 'POST', body: emptyStartStream, duplex: 'half',
} as unknown as RequestInit));
await assert.rejects(assertEmptyGdeltStartBody(new Request(
  'https://media.example/gdelt/web-ngrams/runs/start', { method: 'POST', body: 'x' },
)), /gdelt_start_body_forbidden/);
await assert.rejects(assertEmptyGdeltStartBody(new Request(
  'https://media.example/gdelt/web-ngrams/runs/start', {
    method: 'POST', headers: { 'content-length': '1' },
  },
)), /gdelt_start_body_forbidden/);
const unauthenticatedStart = await mediaDiscoveryWorker.fetch(new Request(
  'https://media.example/gdelt/web-ngrams/runs/start', { method: 'POST', body: 'forbidden' },
), { UK_AQ_MEDIA_GDELT_INGEST_SECRET: 'fixture-secret' } as MediaDiscoveryEnv);
assert.equal(unauthenticatedStart.status, 401,
  'GDELT authentication must precede protected start-body validation and D1 work');
assert.equal(gdeltIngestResponseErrorCode(400, { error: 'gdelt_start_body_forbidden' }),
  'gdelt_start_body_forbidden');
assert.equal(gdeltIngestResponseErrorCode(400, { error: '<untrusted>' }), 'gdelt_ingest_http_400');
let postCommitReconcileAttempted = false;
await reconcileHomepageLatestSixAfterSourceCommit(async () => {
  postCommitReconcileAttempted = true;
  throw new Error('fixture failure');
}, { run_id: 'fixture-run', source_key: 'fixture-source', route_key: 'fixture-route' });
assert.equal(postCommitReconcileAttempted, true,
  'post-commit reconciliation must be attempted without escaping source success');

// Provider-format and matching fixtures.
assert.deepEqual(parseNgramLine('doc-1\tUK air-quality update today\t2'), {
  doc_id: 'doc-1', quadgram: 'UK air-quality update today', count: 2,
});
assert.throws(() => parseNgramLine('broken\trow'), /gdelt_ngram_tsv_invalid/);
const overlongNgram = `doc-overlong\t${'x'.repeat(4097)}\t1`;
assert.throws(() => parseNgramLine(overlongNgram), /gdelt_ngram_tsv_invalid/,
  'the 4,096-character QUADGRAM bound must remain strict');
const observedSize = 67_673;
const moderatelyOversizedNgram = `doc-observed\t${'x'.repeat(observedSize - 15)}\t1`;
assert.equal(Buffer.byteLength(moderatelyOversizedNgram), observedSize);
const framedNgrams = boundedLines(Readable.from([Buffer.from(
  `${moderatelyOversizedNgram}\ndoc-after\tair quality after malformed row\t1\n`,
)]), '20260915054600', 'ngrams', GDELT_MAX_NGRAM_LINE_BYTES);
const framedScan = await scanNgramLines(framedNgrams);
assert.equal(framedScan.malformed_ngram_rows, 1,
  'a 67 KiB semantically invalid row must be counted after passing framing');
assert.equal(framedScan.ngram_rows, 1, 'a valid row following the malformed row must be processed');
assert.equal(framedScan.matched_docs.has('doc-after'), true);
const fatalRawNgram = 'x'.repeat(GDELT_MAX_NGRAM_LINE_BYTES + 1);
await assert.rejects(async () => {
  for await (const _line of boundedLines(Readable.from([Buffer.from(fatalRawNgram)]),
    '20260915054600', 'ngrams', GDELT_MAX_NGRAM_LINE_BYTES)) { /* consume */ }
}, error => {
  assert.equal((error as { code?: unknown }).code, 'gdelt_line_too_large');
  assert.equal((error as { file_kind?: unknown }).file_kind, 'ngrams');
  assert.equal((error as { configured_limit_bytes?: unknown }).configured_limit_bytes,
    GDELT_MAX_NGRAM_LINE_BYTES);
  return true;
});
const tolerantNgrams = await scanNgramLines(fixtureLines([
  'doc-valid-1\tair quality in London\t1', overlongNgram,
  'doc-valid-2\twildfires affect the region\t1',
]));
assert.equal(tolerantNgrams.ngram_rows, 2);
assert.equal(tolerantNgrams.malformed_ngram_rows, 1);
assert.equal(tolerantNgrams.matches_seen, 2);
assert.deepEqual([...tolerantNgrams.matched_docs.keys()].sort(), ['doc-valid-1', 'doc-valid-2']);
await assert.rejects(scanNgramLines(fixtureLines([overlongNgram])), /gdelt_ngram_empty/,
  'a file with no usable NGRAM rows must remain fatal');
await assert.rejects(scanNgramLines(fixtureLines(['doc-valid\tair quality\t1']), () => {
  throw new Error('unexpected_scanner_failure');
}), /unexpected_scanner_failure/, 'unexpected scanner failures must still escape');
for (const [phrase, key] of [
  ['domestic wood-burning rules', 'gdelt-wood-burning'],
  ['health effects of wildfires', 'gdelt-wildfire'],
  ['latest air-pollution research', 'gdelt-air-pollution'],
  ['local air quality today', 'gdelt-air-quality'],
] as const) assert.equal(matchGdeltFamilies(phrase).has(key), true);
for (const weak of ['smoke', 'fire', 'stove', 'biomass']) {
  assert.equal(matchGdeltFamilies(weak).size, 0, `${weak} must not match alone`);
}

const toc = parseTocLine(JSON.stringify({ ID: 'doc-1', date: '20260913120000', img: 'https://evil.example/i.jpg',
  lang: 'en', title: 'Air quality update', url: 'https://www.example.co.uk/a?utm_source=gdelt' }));
assert.equal(toc?.date, '2026-09-13T12:00:00.000Z');
assert.equal('img' in (toc ?? {}), false, 'GDELT image must not enter the parsed promotion model');
assert.equal(parseTocLine(JSON.stringify({ ID: 2, date: 20260913120100, lang: 'English',
  title: 'Air quality', url: 'https://example.co.uk/two' }))?.date,
'2026-09-13T12:01:00.000Z');
assert.equal(parseTocLine('{not json'), null);

const ngrams = await scanNgramLines(fixtureLines([
  'doc-1\tair quality in London\t1',
  'doc-1\tair pollution in London\t2',
  'doc-2\twildfires affect the region\t1',
  'doc-fr\tair quality en France\t1',
]));
const joined = await resolveTocLines(fixtureLines([
  JSON.stringify({ ID: 'doc-1', date: '20260913120000', img: 'https://evil.example/a.jpg', lang: 'en',
    title: 'Air quality and air pollution in London', url: 'https://www.example.co.uk/story?utm_source=one' }),
  JSON.stringify({ ID: 'doc-1', date: '20260913120100', lang: 'EN',
    title: 'Updated air quality and air pollution in London', url: 'https://example.co.uk/story?utm_source=two' }),
  JSON.stringify({ ID: 'doc-2', date: '20260913120000', lang: 'English',
    title: 'Regional wildfires', url: 'https://elsewhere.com/climate' }),
  JSON.stringify({ ID: 'doc-fr', date: '20260913120000', lang: 'French',
    title: 'Qualite de air', url: 'https://example.fr/article' }),
] ), ngrams.matched_docs, '20260913120000');
assert.equal(joined.candidates.length, 2, 'English filtering and canonical candidate dedupe must apply');
assert.equal(joined.candidates[0]?.language, 'English',
  'live GDELT lang=en must be retained and normalised internally');
assert.equal(joined.candidates[1]?.language, 'English',
  'the English compatibility label must remain accepted');
assert.equal(joined.candidates.some(value => value.url.includes('example.fr')), false,
  'non-English candidates must remain excluded');
assert.equal(joined.candidates[0]?.families.length, 2, 'multiple family evidence must be retained once');
assert.equal(joined.candidates[0]?.provider_observed_at, '2026-09-13T12:01:00.000Z');
assert.deepEqual(joined.toc_resolution, { matched_docid_count: 3,
  unresolved_matched_docid_count: 0, unresolved_matched_docid_sample: [] });
assert.equal(joined.toc_resolution.unresolved_matched_docid_count, 0,
  'a parsed non-English TOC row must resolve its DOCID without becoming a candidate');

const partialNgrams = await scanNgramLines(fixtureLines([
  'doc-valid\tair quality in London\t1',
  'doc-malformed\twildfires affect the region\t1',
]));
const partiallyResolved = await resolveTocLines(fixtureLines([
  JSON.stringify({ ID: 'doc-valid', date: '20260913120000', lang: 'English',
    title: 'Air quality in London', url: 'https://example.co.uk/valid' }),
  JSON.stringify({ ID: 'doc-malformed', date: 'not-a-date', lang: 'English',
    title: 'Regional wildfires', url: 'https://example.co.uk/malformed' }),
]), partialNgrams.matched_docs, '20260913120100');
assert.equal(partiallyResolved.candidates.length, 1,
  'valid candidates must survive a partially unresolved TOC join');
assert.deepEqual(partiallyResolved.toc_resolution, { matched_docid_count: 2,
  unresolved_matched_docid_count: 1, unresolved_matched_docid_sample: ['doc-malformed'] });
const resolutionWarnings: string[] = [];
const originalConsoleWarn = console.warn;
try {
  console.warn = (value?: unknown) => { resolutionWarnings.push(String(value)); };
  warnPartialTocResolution('20260913120100', partiallyResolved.toc_resolution);
} finally { console.warn = originalConsoleWarn; }
assert.deepEqual(resolutionWarnings.map(value => JSON.parse(value)), [{
  event: 'gdelt_toc_partially_unresolved_matched_docids', file_stamp: '20260913120100',
  matched_docid_count: 2, unresolved_matched_docid_count: 1,
  unresolved_matched_docid_sample: ['doc-malformed'],
}], 'partial resolution must emit bounded structured diagnostics');

const unresolvedDocs = new Map(Array.from({ length: GDELT_MAX_UNRESOLVED_DOCID_SAMPLE + 5 },
  (_, index) => [`doc-${String(index).padStart(2, '0')}`,
    new Map([['gdelt-air-quality' as const, new Set(['air quality'])]])] as const));
await assert.rejects(resolveTocLines(fixtureLines([
  JSON.stringify({ ID: 'different-file-doc', date: '20260913120000', lang: 'English',
    title: 'Air quality', url: 'https://example.co.uk/a' }),
]), unresolvedDocs, '20260913120200'), error => {
  assert.equal(error instanceof GdeltTocResolutionError, true);
  const resolutionError = error as GdeltTocResolutionError;
  assert.equal(resolutionError.message, 'gdelt_toc_missing_matched_docids');
  assert.equal(resolutionError.file_stamp, '20260913120200');
  assert.equal(resolutionError.diagnostics.matched_docid_count,
    GDELT_MAX_UNRESOLVED_DOCID_SAMPLE + 5);
  assert.equal(resolutionError.diagnostics.unresolved_matched_docid_count,
    GDELT_MAX_UNRESOLVED_DOCID_SAMPLE + 5);
  assert.equal(resolutionError.diagnostics.unresolved_matched_docid_sample.length,
    GDELT_MAX_UNRESOLVED_DOCID_SAMPLE, 'unresolved diagnostic samples must remain bounded');
  return true;
}, 'DOCIDs must resolve only within their paired file');

assert.throws(() => gdeltArticleIdentityUrl('http://example.co.uk/a'), /unsafe_gdelt_article_url/);
assert.throws(() => gdeltArticleIdentityUrl('https://user:pass@example.co.uk/a'), /unsafe_gdelt_article_url/);
assert.equal(registrablePublisherDomain('news.example.co.uk'), 'example.co.uk');
assert.equal(registrablePublisherDomain('news.example.com.au'), 'example.com.au');
assert.equal(registrablePublisherDomain('news.example.co.nz'), 'example.co.nz');
assert.equal(registrablePublisherDomain('news.example.com'), 'example.com');
assert.deepEqual(gdeltArticleIdentityUrl('https://news.example.com.au/story'), {
  raw_url: 'https://news.example.com.au/story',
  publisher_host: 'news.example.com.au',
  publisher_domain: 'example.com.au',
});
assert.throws(() => registrablePublisherDomain('co.uk'),
  /invalid_registrable_publisher_domain/);
assert.throws(() => registrablePublisherDomain('publisher.not-a-real-tld'),
  /invalid_registrable_publisher_domain/);
assert.equal(domainMatchesBoundary('news.theguardian.com', 'theguardian.com'), true);
assert.equal(domainMatchesBoundary('guardian.com.evil.example', 'guardian.com'), false);
assert.equal(canonicalizeUrl('https://www.example.co.uk/a?utm_source=gdelt', 'example.co.uk'),
  'https://example.co.uk/a');
assert.deepEqual(gdeltWindow(new Date('2026-09-13T12:10:44.000Z'), null), {
  checkpoint_before: null, window_start: '20260913100600', window_end: '20260913120500',
});
assert.equal(gdeltSafeTarget(new Date('2026-09-13T12:10:44.000Z')), '20260913120500');

// Workflow-side catch-up orchestration over normal bounded batch results.
let currentBatchCalls = 0;
const currentCatchup = await runGdeltCatchup(async () => {
  currentBatchCalls++;
  return gdeltBatchResult('20260913120500', '20260913120500');
}, { now: () => new Date('2026-09-13T12:10:44.000Z') });
assert.equal(currentBatchCalls, 1, 'an already-current invocation must still run exactly one batch');
assert.deepEqual(currentCatchup, { checkpoint_before: '20260913120500',
  checkpoint_after: '20260913120500', safe_target: '20260913120500', batches_completed: 1,
  caught_up: true, elapsed_ms: 0, termination_reason: 'caught_up' });

let advancingNow = new Date('2026-09-13T12:10:00.000Z');
let advancingBatch = 0;
const advancingResults = [
  gdeltBatchResult('20260913120000', '20260913120200'),
  gdeltBatchResult('20260913120200', '20260913120600'),
  gdeltBatchResult('20260913120600', '20260913120700'),
];
const advancingCatchup = await runGdeltCatchup(async () => {
  const result = advancingResults[advancingBatch++];
  assert.ok(result, 'catch-up must not request an unexpected extra batch');
  advancingNow = advancingBatch === 1 ? new Date('2026-09-13T12:11:00.000Z') :
    new Date('2026-09-13T12:12:00.000Z');
  return result;
}, { now: () => advancingNow });
assert.equal(advancingBatch, 3,
  'a stale checkpoint must run repeated bounded batches until the moving target is reached');
assert.deepEqual(advancingCatchup, { checkpoint_before: '20260913120000',
  checkpoint_after: '20260913120700', safe_target: '20260913120700', batches_completed: 3,
  caught_up: true, elapsed_ms: 120_000, termination_reason: 'caught_up' });

let budgetNow = new Date('2026-09-13T12:10:00.000Z');
let inFlightCompleted = false;
let budgetBatchCalls = 0;
const budgetCatchup = await runGdeltCatchup(async () => {
  budgetBatchCalls++;
  budgetNow = new Date('2026-09-13T12:10:02.000Z');
  inFlightCompleted = true;
  return gdeltBatchResult('20260913120000', '20260913120100');
}, { now: () => budgetNow, budget_ms: 1_000 });
assert.equal(inFlightCompleted, true, 'a batch that starts within budget must finish normally');
assert.equal(budgetBatchCalls, 1, 'an expired budget must prevent the next batch from starting');
assert.deepEqual(budgetCatchup, { checkpoint_before: '20260913120000',
  checkpoint_after: '20260913120100', safe_target: '20260913120500', batches_completed: 1,
  caught_up: false, elapsed_ms: 2_000, termination_reason: 'budget_exhausted' });

let failingBatchCalls = 0;
await assert.rejects(runGdeltCatchup(async () => {
  failingBatchCalls++;
  if (failingBatchCalls === 2) throw new Error('gdelt_fixture_batch_failed');
  return gdeltBatchResult('20260913120000', '20260913120100');
}, { now: () => new Date('2026-09-13T12:10:00.000Z') }), /gdelt_fixture_batch_failed/);
assert.equal(failingBatchCalls, 2, 'a failed batch must stop catch-up immediately');

await assert.rejects(runGdeltCatchup(async () =>
  gdeltBatchResult('20260913120000', '20260913120000'),
{ now: () => new Date('2026-09-13T12:10:00.000Z') }), error => {
  assert.equal(error instanceof GdeltCatchupNoProgressError, true);
  const noProgress = error as GdeltCatchupNoProgressError;
  assert.equal(noProgress.message, 'gdelt_catchup_no_progress');
  assert.equal(noProgress.safe_target, '20260913120500');
  assert.equal(noProgress.batches_completed, 1);
  return true;
}, 'a stale, non-advancing successful batch must trip the no-progress guard');

const currentNoProgress = await runGdeltCatchup(async () =>
  gdeltBatchResult('20260913120500', '20260913120500'),
{ now: () => new Date('2026-09-13T12:10:00.000Z') });
assert.equal(currentNoProgress.termination_reason, 'caught_up',
  'caught-up state must be checked before applying the no-progress guard');

// Integration fixture: real migrations and the production D1 mutation functions over SQLite.
const sqlite = new DatabaseSync(':memory:');
applyMigrations(sqlite);
sqlite.exec(`INSERT INTO media_publisher_domain_scope
  (publisher_domain, publisher_scope, classification_reason, created_at, updated_at)
  VALUES ('known-non-uk.com', 'non_uk', 'fixture', '2026-09-13T12:00:00.000Z', '2026-09-13T12:00:00.000Z')`);
const db = sqliteD1(sqlite);
const malformedNgramColumn = sqlite.prepare('PRAGMA table_info(media_gdelt_files)')
  .all().find(row => row.name === 'malformed_ngram_rows');
assert.equal(malformedNgramColumn?.notnull, 1);
assert.equal(malformedNgramColumn?.dflt_value, '0');
const run = await startGdeltRun(db, new Date('2026-09-13T12:10:44.000Z'));
const stamp = '20260913120000';
const globalOnly = [
  candidate('https://news.unknown-global.com.au/air-quality',
    'Air quality standards compared', families.air),
  candidate('https://known-non-uk.com/air-pollution', 'Air pollution policy', families.pollution),
];
await startGdeltFile(db, { run_id: run.run_id, file_stamp: stamp, expected_chunks: 1,
  candidate_count: globalOnly.length, ngram_rows: 20, matches_seen: 2,
  malformed_ngram_rows: 2, malformed_toc_rows: 1 });
assert.deepEqual({ ...sqlite.prepare(`SELECT malformed_ngram_rows, malformed_toc_rows
  FROM media_gdelt_files WHERE file_stamp = ?`).get(stamp) }, {
  malformed_ngram_rows: 2, malformed_toc_rows: 1,
});
await assert.rejects(startGdeltFile(db, { run_id: run.run_id, file_stamp: stamp, expected_chunks: 1,
  candidate_count: globalOnly.length, ngram_rows: 20, matches_seen: 2,
  malformed_ngram_rows: 3, malformed_toc_rows: 1 }), /gdelt_file_manifest_changed/,
  'processing-file replay must retain malformed NGRAM manifest evidence');
const generationBefore = sqlite.prepare(`SELECT generation FROM media_public_feed_state
  WHERE scope = 'homepage_latest_6'`).get()!.generation;
await ingestGdeltChunk(db, { run_id: run.run_id, file_stamp: stamp, chunk_index: 0,
  candidates: globalOnly }, new Date('2026-09-13T12:11:00.000Z'));
assert.equal(sqlite.prepare('SELECT count(*) AS count FROM media_gdelt_candidates').get()!.count, 2);
assert.equal(sqlite.prepare('SELECT count(*) AS count FROM media_articles').get()!.count, 0,
  'non-UK and unknown candidates must not become articles');
assert.equal(sqlite.prepare(`SELECT generation FROM media_public_feed_state
  WHERE scope = 'homepage_latest_6'`).get()!.generation, generationBefore,
  'candidate-only writes must not affect the homepage generation');
await completeGdeltFile(db, { run_id: run.run_id, file_stamp: stamp });
assert.equal(sqlite.prepare('SELECT malformed_rows FROM media_gdelt_runs WHERE id = ?')
  .get(run.run_id)!.malformed_rows, 3,
  'run malformed_rows must aggregate distinct NGRAM and TOC evidence once');

const stamp2 = '20260913120100';
const aqnUrl = 'https://airqualitynews.com/2026/09/clean-air-plan?utm_source=gdelt';
const unknownUkUrl = 'https://www.local-paper.co.uk/news/wood-burning-rules?utm_campaign=x';
const irrelevantUkUrl = 'https://regional-paper.co.uk/weather/hottest-august';
const promoted = [
  candidate(aqnUrl, 'New air quality plan announced', families.air),
  candidate(unknownUkUrl, 'Wood burning rules tackle air pollution', families.wood),
  candidate(irrelevantUkUrl, 'Hottest August breaks temperature record', families.wildfire),
];
await startGdeltFile(db, { run_id: run.run_id, file_stamp: stamp2, expected_chunks: 2,
  candidate_count: promoted.length, ngram_rows: 30, matches_seen: 3,
  malformed_ngram_rows: 0, malformed_toc_rows: 0 });
await ingestGdeltChunk(db, { run_id: run.run_id, file_stamp: stamp2, chunk_index: 0,
  candidates: promoted.slice(0, 2) }, new Date('2026-09-13T12:12:00.000Z'));
await ingestGdeltChunk(db, { run_id: run.run_id, file_stamp: stamp2, chunk_index: 1,
  candidates: promoted.slice(2) }, new Date('2026-09-13T12:12:01.000Z'));
await completeGdeltFile(db, { run_id: run.run_id, file_stamp: stamp2 });

assert.equal(sqlite.prepare('SELECT count(*) AS count FROM media_gdelt_candidates').get()!.count, 5);
assert.equal(sqlite.prepare('SELECT count(*) AS count FROM media_articles').get()!.count, 2,
  'only relevant UK candidates must promote');
const aqn = sqlite.prepare(`SELECT source_key, status, published_at, og_image_url FROM media_articles
  WHERE source_key = 'air-quality-news'`).get()!;
assert.deepEqual({ ...aqn }, { source_key: 'air-quality-news', status: 'approved', published_at: null,
  og_image_url: null }, 'configured publisher policy must be reused without TOC date/image promotion');
const dynamic = sqlite.prepare(`SELECT s.enabled, s.publication_policy, s.review_level,
  s.discovery_method, s.content_fetch_policy, s.ai_content_policy, s.image_policy, a.status
  FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
  WHERE a.canonical_url_hash = ?`).get(await canonicalUrlHash(
    'https://local-paper.co.uk/news/wood-burning-rules'))!;
assert.deepEqual({ ...dynamic }, { enabled: 0, publication_policy: 'manual', review_level: 'enhanced',
  discovery_method: 'deferred', content_fetch_policy: 'discovery_metadata_only',
  ai_content_policy: 'disabled', image_policy: 'remote_preview', status: 'pending' });
assert.equal(sqlite.prepare(`SELECT publisher_scope FROM media_gdelt_candidates
  WHERE publisher_domain = 'local-paper.co.uk'`).get()!.publisher_scope, 'uk');
assert.equal(sqlite.prepare(`SELECT publisher_scope FROM media_gdelt_candidates
  WHERE publisher_domain = 'unknown-global.com.au'`).get()!.publisher_scope, 'unknown');
assert.equal(sqlite.prepare(`SELECT publisher_scope FROM media_gdelt_candidates
  WHERE publisher_domain = 'known-non-uk.com'`).get()!.publisher_scope, 'non_uk');
assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM media_article_discovery_evidence
  WHERE provider_key = 'gdelt'`).get()!.count, 2);

// A publisher-native overlap fills genuine metadata but preserves one identity and both providers.
const sourceColumns = `source_key, name, canonical_domain, source_type, enabled, publication_policy,
  review_level, priority, discovery_method, discovery_config_json, content_fetch_policy,
  ai_content_policy, image_policy, search_index_policy`;
const aqnSourceRow = sqlite.prepare(`SELECT ${sourceColumns} FROM media_sources
  WHERE source_key = 'air-quality-news'`).get()!;
const { discovery_config_json: aqnConfig, enabled: aqnEnabled, ...aqnFields } = aqnSourceRow;
const aqnSource = SourceSchema.parse({ ...aqnFields, enabled: aqnEnabled === 1,
  discovery_config: JSON.parse(String(aqnConfig)) });
const directCanonical = canonicalizeUrl(`${aqnUrl}&utm_medium=rss`, aqnSource);
const directArticle: DiscoveredArticle = {
  canonical_url: directCanonical, canonical_url_hash: await canonicalUrlHash(directCanonical),
  original_url: `${aqnUrl}&utm_medium=rss`, title: 'Publisher-native air quality title',
  author: 'Publisher Author', published_at: '2026-09-13T11:45:00.000Z', categories: ['Air Quality'],
  title_context: null, preview_url: null, display_title: null, display_title_origin: null,
  preview_metadata_checked_at: null,
};
await db.batch([
  persistArticle(db, aqnSource, directArticle, [], null, '2026-09-13T12:20:00.000Z'),
  persistDiscoveryEvidence(db, aqnSource, 'publisher_rss', 'air-quality-news-feed', directArticle,
    [], null, '2026-09-13T12:20:00.000Z'),
]);
assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM media_articles
  WHERE canonical_url_hash = ?`).get(directArticle.canonical_url_hash)!.count, 1);
assert.equal(sqlite.prepare(`SELECT published_at FROM media_articles
  WHERE canonical_url_hash = ?`).get(directArticle.canonical_url_hash)!.published_at,
  directArticle.published_at, 'publisher-native publication time must fill the unknown value');
assert.equal(sqlite.prepare(`SELECT title FROM media_articles
  WHERE canonical_url_hash = ?`).get(directArticle.canonical_url_hash)!.title,
  directArticle.title, 'the first publisher-native observation must replace the GDELT title');
assert.deepEqual(sqlite.prepare(`SELECT provider_key FROM media_article_discovery_evidence
  WHERE article_id = (SELECT id FROM media_articles WHERE canonical_url_hash = ?)
  ORDER BY provider_key`).all(directArticle.canonical_url_hash).map(row => row.provider_key),
['gdelt', 'publisher_rss']);

// Existing rejected/hidden decisions survive a later GDELT overlap.
const bbcSourceRow = sqlite.prepare(`SELECT ${sourceColumns} FROM media_sources
  WHERE source_key = 'bbc-news'`).get()!;
const { discovery_config_json: bbcConfig, enabled: bbcEnabled, ...bbcFields } = bbcSourceRow;
const bbcSource = SourceSchema.parse({ ...bbcFields, enabled: bbcEnabled === 1,
  discovery_config: JSON.parse(String(bbcConfig)) });
async function seedEditorialUrl(path: string, status: 'rejected' | 'hidden'): Promise<GdeltCandidateInput> {
  const canonical_url = `https://bbc.co.uk/news/${path}`;
  const article: DiscoveredArticle = { canonical_url,
    canonical_url_hash: await canonicalUrlHash(canonical_url), original_url: canonical_url,
    title: `Air pollution ${path}`, author: null, published_at: null, categories: [],
    title_context: null, preview_url: null, display_title: null, display_title_origin: null,
    preview_metadata_checked_at: null };
  await persistArticle(db, bbcSource, article, [], null, '2026-09-13T12:21:00.000Z').run();
  if (status === 'rejected') sqlite.prepare(`UPDATE media_articles SET status = 'rejected',
    rejected_at = ?, revision = revision + 1, mutation_key = ?, updated_at = ? WHERE canonical_url_hash = ?`)
    .run('2026-09-13T12:22:00.000Z', `reject-${path}`, '2026-09-13T12:22:00.000Z', article.canonical_url_hash);
  else {
    sqlite.prepare(`UPDATE media_articles SET status = 'approved', approved_at = ?, approval_method = 'manual',
      revision = revision + 1, mutation_key = ?, updated_at = ? WHERE canonical_url_hash = ?`)
      .run('2026-09-13T12:22:00.000Z', `approve-${path}`, '2026-09-13T12:22:00.000Z', article.canonical_url_hash);
    sqlite.prepare(`UPDATE media_articles SET status = 'hidden', hidden_at = ?,
      revision = revision + 1, mutation_key = ?, updated_at = ? WHERE canonical_url_hash = ?`)
      .run('2026-09-13T12:23:00.000Z', `hide-${path}`, '2026-09-13T12:23:00.000Z', article.canonical_url_hash);
  }
  return candidate(canonical_url, article.title, families.pollution);
}
const rejected = await seedEditorialUrl('rejected-air', 'rejected');
const hidden = await seedEditorialUrl('hidden-air', 'hidden');
const stamp3 = '20260913120200';
await startGdeltFile(db, { run_id: run.run_id, file_stamp: stamp3, expected_chunks: 1,
  candidate_count: 2, ngram_rows: 10, matches_seen: 2,
  malformed_ngram_rows: 0, malformed_toc_rows: 0 });
await ingestGdeltChunk(db, { run_id: run.run_id, file_stamp: stamp3, chunk_index: 0,
  candidates: [rejected, hidden] }, new Date('2026-09-13T12:24:00.000Z'));
assert.deepEqual(sqlite.prepare(`SELECT status FROM media_articles WHERE canonical_url IN (?, ?)
  ORDER BY status`).all(rejected.url, hidden.url).map(row => row.status), ['hidden', 'rejected']);

sqlite.close();
console.log('GDELT Web NGrams checks passed');
