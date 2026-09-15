import { z } from '@uk-aq-media/core';
import { parse } from 'tldts';

export const GDELT_BASE_URL =
  'https://storage.googleapis.com/data.gdeltproject.org/gdeltv5/weblegacy/ngrams/';
export const GDELT_SAFETY_LAG_MINUTES = 5;
export const GDELT_INITIAL_LOOKBACK_MINUTES = 120;
export const GDELT_OVERLAP_MINUTES = 15;
export const GDELT_MAX_CATCHUP_MINUTES = 240;
export const GDELT_MAX_NEW_FILE_PAIRS = 6;
export const GDELT_MAX_MATCHED_CANDIDATES_PER_FILE = 200;
export const GDELT_MAX_MATCHED_CANDIDATES_PER_RUN = 600;
export const GDELT_INGEST_CHUNK_SIZE = 2;
export const GDELT_MAX_NGRAM_COMPRESSED_BYTES = 96 * 1024 * 1024;
export const GDELT_MAX_TOC_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const GDELT_MAX_DECOMPRESSED_BYTES = 768 * 1024 * 1024;
export const GDELT_MAX_NGRAM_LINE_BYTES = 64 * 1024;
// TOC rows contain provider metadata beyond the five fields retained below and can
// legitimately be much larger than the deliberately small three-column NGram rows.
// Keep this independent bound well below the whole decompressed-file allowance.
export const GDELT_MAX_TOC_LINE_BYTES = 1024 * 1024;
export const GDELT_HEAD_TIMEOUT_MS = 15_000;
export const GDELT_FILE_TIMEOUT_MS = 120_000;
export const GDELT_INGEST_TIMEOUT_MS = 30_000;
export const GDELT_MAX_INGEST_BODY_BYTES = 128 * 1024;
export const GDELT_MAX_URL_LENGTH = 2048;
export const GDELT_MAX_TITLE_LENGTH = 1000;

export const GdeltFamilyKey = z.enum([
  'gdelt-wood-burning',
  'gdelt-wildfire',
  'gdelt-air-pollution',
  'gdelt-air-quality',
]);
export type GdeltFamilyKey = z.infer<typeof GdeltFamilyKey>;
export const GDELT_FAMILY_KEYS = GdeltFamilyKey.options;

const familyPhrases: Readonly<Record<GdeltFamilyKey, readonly string[]>> = {
  'gdelt-wood-burning': [
    'wood burning', 'wood burner', 'wood burners', 'log burner', 'log burners',
    'wood burning stove', 'wood burning stoves', 'wood stove', 'wood stoves',
    'domestic wood burning',
  ],
  'gdelt-wildfire': [
    'wildfire', 'wildfires', 'wildfire smoke', 'moorland fire', 'forest fire',
    'grass fire', 'vegetation fire',
  ],
  'gdelt-air-pollution': ['air pollution'],
  'gdelt-air-quality': ['air quality'],
};

function normalisePhraseText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-GB')
    .replace(/[\u2010-\u2015/_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function matchGdeltFamilies(quadgram: string): Map<GdeltFamilyKey, string[]> {
  const value = ` ${normalisePhraseText(quadgram)} `;
  const matches = new Map<GdeltFamilyKey, string[]>();
  for (const key of GDELT_FAMILY_KEYS) {
    const found = familyPhrases[key].filter(phrase => value.includes(` ${phrase} `));
    if (found.length) matches.set(key, [...new Set(found)]);
  }
  return matches;
}

export function domainMatchesBoundary(host: string, domain: string): boolean {
  const normalHost = host.toLowerCase().replace(/^www\./, '');
  const normalDomain = domain.toLowerCase().replace(/^www\./, '');
  return normalHost === normalDomain || normalHost.endsWith(`.${normalDomain}`);
}

export function registrablePublisherDomain(host: string): string {
  const parsed = parse(host.toLowerCase().replace(/^www\./, ''), {
    // Private PSL suffixes preserve distinct hosted publishers such as user.github.io.
    allowPrivateDomains: true,
    extractHostname: false,
    validateHostname: true,
  });
  if (!parsed.domain || !parsed.isIcann && !parsed.isPrivate) {
    throw new Error('invalid_registrable_publisher_domain');
  }
  return parsed.domain;
}

function validHostname(host: string): boolean {
  if (host.length < 1 || host.length > 253 || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) {
    return false;
  }
  const labels = host.split('.');
  return labels.length >= 2 && labels.every(label => label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function gdeltArticleIdentityUrl(raw: string): { raw_url: string; publisher_host: string;
  publisher_domain: string } {
  if (raw.length > GDELT_MAX_URL_LENGTH) throw new Error('gdelt_url_too_long');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('unsafe_gdelt_article_url');
  }
  const publisher_host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!validHostname(publisher_host)) throw new Error('invalid_publisher_host');
  return { raw_url: url.href, publisher_host,
    publisher_domain: registrablePublisherDomain(publisher_host) };
}

export function publisherDomainSuffixes(host: string): string[] {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  const suffixes: string[] = [];
  for (let index = 0; index < labels.length - 1; index++) suffixes.push(labels.slice(index).join('.'));
  return suffixes.slice(0, 10);
}

export function fileStamp(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) +
    iso.slice(14, 16) + '00';
}

export function dateFromFileStamp(value: string): Date {
  if (!/^\d{12}00$/.test(value)) throw new Error('invalid_gdelt_file_stamp');
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00.000Z`);
  if (!Number.isFinite(date.getTime()) || fileStamp(date) !== value) {
    throw new Error('invalid_gdelt_file_stamp');
  }
  return date;
}

export type GdeltWindow = {
  checkpoint_before: string | null;
  window_start: string;
  window_end: string;
};

export function gdeltWindow(now: Date, checkpoint: string | null): GdeltWindow {
  const safeEndMs = Math.floor((now.getTime() - GDELT_SAFETY_LAG_MINUTES * 60_000) / 60_000) * 60_000;
  const safeEnd = new Date(safeEndMs);
  if (!checkpoint) {
    return { checkpoint_before: null,
      window_start: fileStamp(new Date(safeEndMs - (GDELT_INITIAL_LOOKBACK_MINUTES - 1) * 60_000)),
      window_end: fileStamp(safeEnd) };
  }
  const checkpointDate = dateFromFileStamp(checkpoint);
  const firstNewMs = checkpointDate.getTime() + 60_000;
  const boundedEndMs = Math.min(safeEndMs,
    firstNewMs + (GDELT_MAX_CATCHUP_MINUTES - 1) * 60_000);
  const endMs = Math.max(Math.min(checkpointDate.getTime(), safeEndMs), boundedEndMs);
  const startMs = Math.min(endMs,
    checkpointDate.getTime() - (GDELT_OVERLAP_MINUTES - 1) * 60_000);
  return { checkpoint_before: checkpoint, window_start: fileStamp(new Date(startMs)),
    window_end: fileStamp(new Date(endMs)) };
}

export function enumerateFileStamps(start: string, end: string): string[] {
  const startMs = dateFromFileStamp(start).getTime();
  const endMs = dateFromFileStamp(end).getTime();
  if (endMs < startMs) throw new Error('invalid_gdelt_window');
  const count = Math.floor((endMs - startMs) / 60_000) + 1;
  if (count > GDELT_MAX_CATCHUP_MINUTES + GDELT_OVERLAP_MINUTES) {
    throw new Error('gdelt_window_too_large');
  }
  return Array.from({ length: count }, (_, index) => fileStamp(new Date(startMs + index * 60_000)));
}

const MatchedFamilySchema = z.object({
  family_key: GdeltFamilyKey,
  matched_phrases: z.array(z.string().min(1).max(100)).min(1).max(12),
}).strict();

export const GdeltCandidateInputSchema = z.object({
  url: z.string().url().max(GDELT_MAX_URL_LENGTH),
  title: z.string().min(1).max(GDELT_MAX_TITLE_LENGTH),
  language: z.literal('English'),
  provider_observed_at: z.iso.datetime({ offset: true }),
  families: z.array(MatchedFamilySchema).min(1).max(4),
}).strict();
export type GdeltCandidateInput = z.infer<typeof GdeltCandidateInputSchema>;

export const GdeltFileStartSchema = z.object({
  run_id: z.uuid(), file_stamp: z.string().regex(/^\d{12}00$/),
  expected_chunks: z.number().int().min(0).max(100),
  candidate_count: z.number().int().min(0).max(GDELT_MAX_MATCHED_CANDIDATES_PER_FILE),
  ngram_rows: z.number().int().nonnegative(), matches_seen: z.number().int().nonnegative(),
  malformed_ngram_rows: z.number().int().min(0).max(GDELT_MAX_DECOMPRESSED_BYTES),
  malformed_toc_rows: z.number().int().nonnegative(),
}).strict();

export const GdeltChunkSchema = z.object({
  run_id: z.uuid(), file_stamp: z.string().regex(/^\d{12}00$/),
  chunk_index: z.number().int().min(0).max(99),
  candidates: z.array(GdeltCandidateInputSchema).min(1).max(GDELT_INGEST_CHUNK_SIZE),
}).strict();

export const GdeltFileCompleteSchema = z.object({
  run_id: z.uuid(), file_stamp: z.string().regex(/^\d{12}00$/),
}).strict();

export const GdeltRunFinishSchema = z.object({
  run_id: z.uuid(), completed_through: z.string().regex(/^\d{12}00$/),
  missing_minutes: z.number().int().nonnegative(),
  complete_pairs_replayed: z.number().int().nonnegative().max(100),
}).strict();

export const GdeltRunFailSchema = z.object({
  run_id: z.uuid(), error_code: z.string().regex(/^[a-z0-9_]+$/).min(1).max(100),
}).strict();

export function gdeltFileUrls(stamp: string): { ngrams: string; toc: string } {
  dateFromFileStamp(stamp);
  return { ngrams: `${GDELT_BASE_URL}${stamp}.ngrams.txt.gz`,
    toc: `${GDELT_BASE_URL}${stamp}.toc.json.gz` };
}
