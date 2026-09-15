import { GdeltLineTooLargeError, runGdeltBatch } from '@uk-aq-media/gdelt/scanner';

const baseUrl = process.env.UK_AQ_MEDIA_GDELT_INGEST_URL?.trim() ?? '';
const secret = process.env.UK_AQ_MEDIA_GDELT_INGEST_SECRET?.trim() ?? '';

try {
  const result = await runGdeltBatch(baseUrl, secret);
  console.log(JSON.stringify({ event: 'gdelt_web_ngrams_batch_succeeded', ...result }));
} catch (error) {
  console.error(JSON.stringify({ event: 'gdelt_web_ngrams_batch_failed',
    error_code: error instanceof Error && /^gdelt_[a-z0-9_]+$/.test(error.message)
      ? error.message.slice(0, 100) : 'gdelt_batch_failed',
    ...(error instanceof GdeltLineTooLargeError ? {
      file_stamp: error.file_stamp,
      file_kind: error.file_kind,
      configured_limit_bytes: error.configured_limit_bytes,
      observed_bytes: error.observed_bytes,
    } : {}),
  }));
  process.exitCode = 1;
}
