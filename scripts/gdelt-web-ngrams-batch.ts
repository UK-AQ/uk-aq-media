import {
  GdeltCatchupNoProgressError, GdeltLineTooLargeError, GdeltTocResolutionError,
  runGdeltBatch, runGdeltCatchup,
} from '@uk-aq-media/gdelt/scanner';


/**
 * Log only reviewed diagnostic codes and exception types. Native error messages,
 * stacks and URLs can contain credentials or request details, so never emit them.
 */
const SAFE_EXCEPTION_TYPES = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError',
  'SocketError', 'ZlibError', 'AggregateError',
]);
const SAFE_CAUSE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'ERR_STREAM_PREMATURE_CLOSE',
  'Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_STREAM_ERROR',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

function safeExceptionType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && SAFE_EXCEPTION_TYPES.has(name) ? name : 'OtherError';
}

function safeUnderlyingDiagnostics(error: unknown): Record<string, string> {
  const chain: object[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  const exceptionType = safeExceptionType(chain[0]);
  const causeType = safeExceptionType(chain[1]);
  const causeCode = chain.map(value => (value as { code?: unknown }).code)
    .find(value => typeof value === 'string' && SAFE_CAUSE_CODES.has(value));

  const message = error instanceof Error ? error.message : null;
  const failureKind = message === 'fetch failed' ? 'fetch_failed'
    : message === 'terminated' ? 'stream_terminated'
    : (exceptionType === 'AbortError' ? 'request_aborted' : null);

  return {
    ...(exceptionType ? { exception_type: exceptionType } : {}),
    ...(causeType ? { cause_exception_type: causeType } : {}),
    ...(typeof causeCode === 'string' ? { cause_code: causeCode } : {}),
    ...(failureKind ? { failure_kind: failureKind } : {}),
  };
}

function safeFailureStage(error: unknown, errorCode: string): string {
  if (error instanceof GdeltCatchupNoProgressError) return 'catchup';
  if (error instanceof GdeltTocResolutionError) return 'scan_toc';
  if (error instanceof GdeltLineTooLargeError) return error.file_kind === 'toc' ? 'scan_toc' : 'scan_ngrams';
  if (errorCode === 'gdelt_batch_config_invalid') return 'configuration';
  if (errorCode.startsWith('gdelt_head_') || errorCode === 'gdelt_incomplete_file_pair') {
    return 'file_pair_check';
  }
  if (errorCode === 'gdelt_ngram_empty') return 'scan_ngrams';
  if (errorCode === 'gdelt_toc_empty') return 'scan_toc';
  if (errorCode.startsWith('gdelt_file_http_') || errorCode === 'gdelt_file_timeout') {
    return 'file_download';
  }
  if (errorCode.startsWith('gdelt_ingest_')) return 'ingest_api';
  return 'undetermined';
}

const baseUrl = process.env.UK_AQ_MEDIA_GDELT_INGEST_URL?.trim() ?? '';
const secret = process.env.UK_AQ_MEDIA_GDELT_INGEST_SECRET?.trim() ?? '';

try {
  const result = await runGdeltCatchup(async () => {
    const batch = await runGdeltBatch(baseUrl, secret);
    console.log(JSON.stringify({ event: 'gdelt_web_ngrams_batch_succeeded', ...batch }));
    return batch;
  });
  console.log(JSON.stringify({ event: 'gdelt_web_ngrams_catchup_completed', ...result }));
} catch (error) {
  const errorCode = error instanceof Error && /^gdelt_[a-z0-9_]+$/.test(error.message)
    ? error.message.slice(0, 100) : 'gdelt_batch_failed';
  console.error(JSON.stringify({ event: 'gdelt_web_ngrams_batch_failed',
    error_code: errorCode,
    failure_stage: safeFailureStage(error, errorCode),
    ...safeUnderlyingDiagnostics(error),
    ...(error instanceof GdeltLineTooLargeError ? {
      file_stamp: error.file_stamp,
      file_kind: error.file_kind,
      configured_limit_bytes: error.configured_limit_bytes,
      observed_bytes: error.observed_bytes,
    } : {}),
    ...(error instanceof GdeltTocResolutionError ? {
      file_stamp: error.file_stamp,
      ...error.diagnostics,
    } : {}),
    catchup_failure_reason: error instanceof GdeltCatchupNoProgressError
      ? 'no_progress' : 'batch_failed',
    ...(error instanceof GdeltCatchupNoProgressError ? {
      checkpoint_before: error.checkpoint_before,
      checkpoint_after: error.checkpoint_after,
      safe_target: error.safe_target,
      batches_completed: error.batches_completed,
    } : {}),
  }));
  process.exitCode = 1;
}
