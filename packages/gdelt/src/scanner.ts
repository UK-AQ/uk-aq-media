import { createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { canonicalizeUrl } from '@uk-aq-media/core';
import {
  GDELT_FILE_TIMEOUT_MS, GDELT_HEAD_TIMEOUT_MS, GDELT_INGEST_CHUNK_SIZE,
  GDELT_INGEST_TIMEOUT_MS, GDELT_MAX_DECOMPRESSED_BYTES,
  GDELT_MAX_INGEST_BODY_BYTES, GDELT_MAX_LINE_BYTES,
  GDELT_MAX_MATCHED_CANDIDATES_PER_FILE, GDELT_MAX_MATCHED_CANDIDATES_PER_RUN,
  GDELT_MAX_NEW_FILE_PAIRS, GDELT_MAX_NGRAM_COMPRESSED_BYTES,
  GDELT_MAX_TOC_COMPRESSED_BYTES, GDELT_MAX_TITLE_LENGTH, GdeltCandidateInputSchema,
  enumerateFileStamps, gdeltArticleIdentityUrl, gdeltFileUrls,
  matchGdeltFamilies, type GdeltCandidateInput, type GdeltFamilyKey,
} from './contracts';

type NgramMatch = Map<GdeltFamilyKey, Set<string>>;
export type GdeltFileScan = {
  candidates: GdeltCandidateInput[];
  ngram_rows: number;
  matches_seen: number;
  malformed_toc_rows: number;
};

function cleanText(value: string, maximum: number): string | null {
  const clean = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return clean && [...clean].length <= maximum ? clean : null;
}

export function parseNgramLine(line: string): { doc_id: string; quadgram: string; count: number } {
  const fields = line.split('\t');
  if (fields.length !== 3) throw new Error('gdelt_ngram_tsv_invalid');
  const [rawDocId, rawQuadgram, rawCount] = fields;
  const doc_id = rawDocId ? cleanText(rawDocId, 200) : null;
  const quadgram = rawQuadgram ? cleanText(rawQuadgram, 4096) : null;
  const count = rawCount && /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  if (!doc_id || !quadgram || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('gdelt_ngram_tsv_invalid');
  }
  return { doc_id, quadgram, count };
}

function mergeFamilyMatches(target: NgramMatch, incoming: Map<GdeltFamilyKey, string[]>): void {
  for (const [family, phrases] of incoming) {
    const values = target.get(family) ?? new Set<string>();
    for (const phrase of phrases) values.add(phrase);
    target.set(family, values);
  }
}

export async function scanNgramLines(lines: AsyncIterable<string>): Promise<{
  matched_docs: Map<string, NgramMatch>; ngram_rows: number; matches_seen: number;
}> {
  const matched_docs = new Map<string, NgramMatch>();
  let ngram_rows = 0;
  let matches_seen = 0;
  for await (const line of lines) {
    if (!line) continue;
    ngram_rows++;
    const parsed = parseNgramLine(line);
    const families = matchGdeltFamilies(parsed.quadgram);
    if (!families.size) continue;
    matches_seen++;
    const current = matched_docs.get(parsed.doc_id) ?? new Map<GdeltFamilyKey, Set<string>>();
    mergeFamilyMatches(current, families);
    matched_docs.set(parsed.doc_id, current);
    if (matched_docs.size > GDELT_MAX_MATCHED_CANDIDATES_PER_FILE) {
      throw new Error('gdelt_file_candidate_limit');
    }
  }
  if (ngram_rows === 0) throw new Error('gdelt_ngram_empty');
  return { matched_docs, ngram_rows, matches_seen };
}

function providerObservationDate(value: unknown): string | null {
  const text = typeof value === 'string' ||
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
  if (text === null) return null;
  if (/^\d{14}$/.test(text)) {
    const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}.000Z`;
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

type ParsedToc = { id: string; date: string; lang: string; title: string; url: string };

export function gdeltIngestResponseErrorCode(status: number, body: unknown): string {
  const error = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).error : null;
  return typeof error === 'string' && /^gdelt_[a-z0-9_]+$/.test(error) && error.length <= 100
    ? error : `gdelt_ingest_http_${status}`;
}

function normalisedEnglishLanguage(value: string): 'English' | null {
  const language = value.normalize('NFKC').toLocaleLowerCase('en-GB').trim();
  return language === 'en' || language === 'english' ? 'English' : null;
}

export function parseTocLine(line: string): ParsedToc | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.ID === 'string' || typeof record.ID === 'number'
    ? cleanText(String(record.ID), 200) : null;
  const date = providerObservationDate(record.date);
  const lang = typeof record.lang === 'string' ? cleanText(record.lang, 50) : null;
  const title = typeof record.title === 'string'
    ? cleanText(record.title, GDELT_MAX_TITLE_LENGTH) : null;
  const url = typeof record.url === 'string' ? record.url : null;
  return id && date && lang && title && url ? { id, date, lang, title, url } : null;
}

export async function resolveTocLines(lines: AsyncIterable<string>, matchedDocs: Map<string, NgramMatch>):
Promise<{ candidates: GdeltCandidateInput[]; malformed_toc_rows: number }> {
  const unresolved = new Set(matchedDocs.keys());
  const candidates = new Map<string, GdeltCandidateInput>();
  let malformed_toc_rows = 0;
  let tocRows = 0;
  for await (const line of lines) {
    if (!line) continue;
    tocRows++;
    const parsed = parseTocLine(line);
    if (!parsed) { malformed_toc_rows++; continue; }
    const families = matchedDocs.get(parsed.id);
    if (!families) continue;
    unresolved.delete(parsed.id);
    const language = normalisedEnglishLanguage(parsed.lang);
    if (!language) continue;
    let identity: ReturnType<typeof gdeltArticleIdentityUrl>;
    let canonicalUrl: string;
    try {
      identity = gdeltArticleIdentityUrl(parsed.url);
      canonicalUrl = canonicalizeUrl(identity.raw_url, identity.publisher_host);
    } catch { malformed_toc_rows++; continue; }
    const incomingFamilies = [...families.entries()].map(([family_key, phrases]) => ({
      family_key, matched_phrases: [...phrases].sort(),
    }));
    const existing = candidates.get(canonicalUrl);
    if (existing) {
      const merged = new Map(existing.families.map(family =>
        [family.family_key, new Set(family.matched_phrases)]));
      for (const family of incomingFamilies) {
        const phrases = merged.get(family.family_key) ?? new Set<string>();
        for (const phrase of family.matched_phrases) phrases.add(phrase);
        merged.set(family.family_key, phrases);
      }
      existing.families = [...merged.entries()].map(([family_key, phrases]) => ({
        family_key, matched_phrases: [...phrases].sort(),
      })).sort((left, right) => left.family_key.localeCompare(right.family_key));
      if (parsed.date > existing.provider_observed_at) {
        existing.provider_observed_at = parsed.date;
        existing.title = parsed.title;
      }
    } else {
      candidates.set(canonicalUrl, GdeltCandidateInputSchema.parse({
        url: identity.raw_url, title: parsed.title, language,
        provider_observed_at: parsed.date,
        families: incomingFamilies.sort((left, right) => left.family_key.localeCompare(right.family_key)),
      }));
    }
  }
  if (tocRows === 0) throw new Error('gdelt_toc_empty');
  if (unresolved.size) throw new Error('gdelt_toc_missing_matched_docids');
  if (candidates.size > GDELT_MAX_MATCHED_CANDIDATES_PER_FILE) {
    throw new Error('gdelt_file_candidate_limit');
  }
  return { candidates: [...candidates.values()], malformed_toc_rows };
}

function byteGuard(maximum: number, code: string): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.byteLength;
    callback(bytes > maximum ? new Error(code) : null, chunk);
  } });
}

async function* boundedLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      let line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line) > GDELT_MAX_LINE_BYTES) throw new Error('gdelt_line_too_large');
      yield line;
    }
    if (Buffer.byteLength(pending) > GDELT_MAX_LINE_BYTES) throw new Error('gdelt_line_too_large');
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

async function gzipLines(url: string, compressedLimit: number): Promise<AsyncGenerator<string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GDELT_FILE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/gzip, application/octet-stream',
        'User-Agent': 'UK-AQ-Media-GDELT/1.0' } });
    if (response.status >= 300 && response.status < 400) throw new Error('gdelt_redirect_rejected');
    if (!response.ok || !response.body) throw new Error(`gdelt_file_http_${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > compressedLimit) throw new Error('gdelt_compressed_too_large');
    const input = Readable.fromWeb(response.body as never);
    const output = input.pipe(byteGuard(compressedLimit, 'gdelt_compressed_too_large'))
      .pipe(createGunzip()).pipe(byteGuard(GDELT_MAX_DECOMPRESSED_BYTES, 'gdelt_decompressed_too_large'));
    return (async function* () {
      try {
        yield* boundedLines(output);
      } catch (error) {
        if (controller.signal.aborted) throw new Error('gdelt_file_timeout');
        throw error;
      } finally {
        clearTimeout(timeout);
        if (!output.destroyed) output.destroy();
      }
    })();
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new Error('gdelt_file_timeout');
    throw error;
  }
}

async function scanFilePair(stamp: string): Promise<GdeltFileScan> {
  const urls = gdeltFileUrls(stamp);
  const ngrams = await gzipLines(urls.ngrams, GDELT_MAX_NGRAM_COMPRESSED_BYTES);
  const matched = await scanNgramLines(ngrams);
  const toc = await gzipLines(urls.toc, GDELT_MAX_TOC_COMPRESSED_BYTES);
  const resolved = await resolveTocLines(toc, matched.matched_docs);
  return { candidates: resolved.candidates, ngram_rows: matched.ngram_rows,
    matches_seen: matched.matches_seen, malformed_toc_rows: resolved.malformed_toc_rows };
}

type PairState = 'missing' | 'complete';

async function objectState(url: string, maximum: number): Promise<'missing' | 'present'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GDELT_HEAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': 'UK-AQ-Media-GDELT/1.0' } });
    if (response.status === 404) return 'missing';
    if (response.status >= 300 && response.status < 400) throw new Error('gdelt_redirect_rejected');
    if (!response.ok) throw new Error(`gdelt_head_http_${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > maximum) throw new Error('gdelt_compressed_too_large');
    return 'present';
  } catch (error) {
    if (controller.signal.aborted) throw new Error('gdelt_head_timeout');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function pairState(stamp: string): Promise<PairState> {
  const urls = gdeltFileUrls(stamp);
  const [ngram, toc] = await Promise.all([
    objectState(urls.ngrams, GDELT_MAX_NGRAM_COMPRESSED_BYTES),
    objectState(urls.toc, GDELT_MAX_TOC_COMPRESSED_BYTES),
  ]);
  if (ngram === 'missing' && toc === 'missing') return 'missing';
  if (ngram !== 'present' || toc !== 'present') throw new Error('gdelt_incomplete_file_pair');
  return 'complete';
}

class IngestClient {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  private async post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GDELT_INGEST_TIMEOUT_MS);
    const json = body === undefined ? '' : JSON.stringify(body);
    if (Buffer.byteLength(json) > GDELT_MAX_INGEST_BODY_BYTES) throw new Error('gdelt_ingest_body_too_large');
    try {
      const response = await fetch(new URL(path, this.baseUrl), { method: 'POST', redirect: 'manual',
        signal: controller.signal, headers: { 'x-uk-aq-gdelt-ingest-secret': this.secret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: json || undefined });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 64 * 1024) throw new Error('gdelt_ingest_response_too_large');
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
      catch {
        throw new Error(response.ok ? 'gdelt_ingest_invalid_json' :
          `gdelt_ingest_http_${response.status}`);
      }
      if (!response.ok) throw new Error(gdeltIngestResponseErrorCode(response.status, parsed));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`gdelt_ingest_http_${response.status}`);
      }
      return parsed as Record<string, unknown>;
    } finally { clearTimeout(timeout); }
  }

  start(): Promise<Record<string, unknown>> { return this.post('/gdelt/web-ngrams/runs/start'); }
  startFile(body: unknown): Promise<Record<string, unknown>> {
    return this.post('/gdelt/web-ngrams/files/start', body);
  }
  chunk(body: unknown): Promise<Record<string, unknown>> {
    return this.post('/gdelt/web-ngrams/files/chunk', body);
  }
  completeFile(body: unknown): Promise<Record<string, unknown>> {
    return this.post('/gdelt/web-ngrams/files/complete', body);
  }
  finish(body: unknown): Promise<Record<string, unknown>> {
    return this.post('/gdelt/web-ngrams/runs/finish', body);
  }
  async fail(body: unknown): Promise<void> { try { await this.post('/gdelt/web-ngrams/runs/fail', body); } catch {} }
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'gdelt_batch_failed';
  return /^gdelt_[a-z0-9_]+$/.test(value) ? value.slice(0, 100) : 'gdelt_batch_failed';
}

export async function runGdeltBatch(baseUrl: string, secret: string): Promise<Record<string, unknown>> {
  if (!baseUrl.startsWith('https://') || secret.length < 32) throw new Error('gdelt_batch_config_invalid');
  const client = new IngestClient(baseUrl, secret);
  const started = await client.start();
  const runId = String(started.run_id ?? '');
  const start = String(started.window_start ?? '');
  const end = String(started.window_end ?? '');
  const processed = new Set(Array.isArray(started.processed_file_stamps)
    ? started.processed_file_stamps.map(String) : []);
  if (!runId || !start || !end) throw new Error('gdelt_ingest_start_invalid');
  let missing = 0;
  let replayed = 0;
  let newFiles = 0;
  let runCandidates = 0;
  let completedThrough = start;
  try {
    for (const stamp of enumerateFileStamps(start, end)) {
      if (processed.has(stamp)) { replayed++; completedThrough = stamp; continue; }
      const state = await pairState(stamp);
      if (state === 'missing') { missing++; completedThrough = stamp; continue; }
      if (newFiles >= GDELT_MAX_NEW_FILE_PAIRS) break;
      const scan = await scanFilePair(stamp);
      if (runCandidates + scan.candidates.length > GDELT_MAX_MATCHED_CANDIDATES_PER_RUN) break;
      runCandidates += scan.candidates.length;
      const expectedChunks = Math.ceil(scan.candidates.length / GDELT_INGEST_CHUNK_SIZE);
      const fileStart = await client.startFile({ run_id: runId, file_stamp: stamp,
        expected_chunks: expectedChunks, candidate_count: scan.candidates.length,
        ngram_rows: scan.ngram_rows, matches_seen: scan.matches_seen,
        malformed_toc_rows: scan.malformed_toc_rows });
      if (fileStart.replayed === true) { replayed++; completedThrough = stamp; continue; }
      for (let index = 0; index < expectedChunks; index++) {
        await client.chunk({ run_id: runId, file_stamp: stamp, chunk_index: index,
          candidates: scan.candidates.slice(index * GDELT_INGEST_CHUNK_SIZE,
            (index + 1) * GDELT_INGEST_CHUNK_SIZE) });
      }
      await client.completeFile({ run_id: runId, file_stamp: stamp });
      newFiles++;
      completedThrough = stamp;
    }
    return await client.finish({ run_id: runId, completed_through: completedThrough,
      missing_minutes: missing, complete_pairs_replayed: replayed });
  } catch (error) {
    await client.fail({ run_id: runId, error_code: errorCode(error) });
    throw error;
  }
}

export function fixtureLines(values: readonly string[]): AsyncIterable<string> {
  return (async function* () { for (const value of values) yield value; })();
}
