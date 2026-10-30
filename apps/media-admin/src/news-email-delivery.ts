import { bearerMatches, HttpError, json } from '@uk-aq-media/core';

const allowedParameters = new Set(['subscription_id', 'limit', 'offset', 'days']);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

interface DeliveryRow {
  id: string;
  subscription_id: string;
  delivery_mode: string;
  state: string;
  created_at: string;
  sent_at: string | null;
  failed_at: string | null;
  attempt_count: number;
  selected_transport: string;
  attempt_transport: string | null;
  retry_hold: number;
  error_class: string | null;
}
interface OutboxRow {
  id: string;
  work_type: string;
  state: string;
  created_at: string;
  queued_at: string | null;
  attempt_count: number;
  error_class: string | null;
}
interface SummaryRow { delivery_mode: string; state: string; count: number }

function integerParameter(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d{0,4})$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return Number(raw);
}

// SQL produces only these fixed codes; no raw SMTP/provider text enters a response.
const deliveryError = `CASE
  WHEN last_error IS NULL THEN NULL
  WHEN last_error IN ('digest_size_requires_operator','stale_smtp_claim',
    'stale_pre_submission_claim','temporary_failure','permanent_failure','unknown') THEN last_error
  ELSE 'unavailable' END AS error_class`;
const outboxError = `CASE
  WHEN last_error IS NULL THEN NULL
  WHEN last_error IN ('temporary_failure','subscription_service_unavailable','work_retry_required') THEN last_error
  ELSE 'unavailable' END AS error_class`;

export async function readNewsEmailDelivery(request: Request, url: URL, env: Pick<MediaAdminEnv,
  'MEDIA_DB' | 'UK_AQ_MEDIA_ADMIN_TOKEN'>): Promise<Response> {
  try {
    if (!env.UK_AQ_MEDIA_ADMIN_TOKEN?.trim() || env.UK_AQ_MEDIA_ADMIN_TOKEN.length > 4096) {
      return json({ available: false, error: 'delivery_read_not_configured' }, 503);
    }
    if (!await bearerMatches(request, env.UK_AQ_MEDIA_ADMIN_TOKEN)) {
      return json({ available: false, error: 'unauthorized' }, 401);
    }
    if (request.method !== 'GET') {
      const response = json({ available: false, error: 'method_not_allowed' }, 405);
      response.headers.set('Allow', 'GET');
      return response;
    }
    if (url.search.length > 256) throw new HttpError(400, 'invalid_query');
    for (const name of url.searchParams.keys()) {
      if (!allowedParameters.has(name) || url.searchParams.getAll(name).length !== 1) {
        throw new HttpError(400, 'invalid_query');
      }
    }
    const subscription = url.searchParams.get('subscription_id');
    if (subscription !== null && !uuid.test(subscription)) throw new HttpError(400, 'invalid_subscription_id');
    const limit = integerParameter(url, 'limit', 25, 1, 100);
    const offset = integerParameter(url, 'offset', 0, 0, 10000);
    const days = integerParameter(url, 'days', 7, 1, 30);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000).toISOString();
    const bounds = [start, end.toISOString()];
    const values = subscription === null ? bounds : [...bounds, subscription.toLowerCase()];
    const deliveryWhere = `created_at >= ? AND created_at <= ?${subscription === null ? '' : ' AND subscription_id = ?'}`;
    // The existing Work JSON has an opaque subscription_id. Never return payload or
    // infer recipient identity from job IDs, tokens, generation IDs or message IDs.
    const outboxWhere = `created_at >= ? AND created_at <= ?${subscription === null ? '' : " AND json_extract(payload,'$.subscription_id') = ?"}`;
    const [summary, deliveries, outbox] = await Promise.all([
      env.MEDIA_DB.prepare(`SELECT delivery_mode,
        CASE WHEN retry_hold = 1 THEN 'held' ELSE state END AS state, count(*) AS count
        FROM media_news_email_deliveries WHERE ${deliveryWhere}
        GROUP BY delivery_mode, CASE WHEN retry_hold = 1 THEN 'held' ELSE state END
        ORDER BY delivery_mode, state LIMIT 24`).bind(...values).all<SummaryRow>(),
      env.MEDIA_DB.prepare(`SELECT id, subscription_id, delivery_mode, state, created_at,
        sent_at, failed_at, attempt_count, selected_transport, attempt_transport, retry_hold,
        ${deliveryError} FROM media_news_email_deliveries WHERE ${deliveryWhere}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .bind(...values, limit + 1, offset).all<DeliveryRow>(),
      env.MEDIA_DB.prepare(`SELECT id, work_type, state, created_at, queued_at, attempt_count,
        ${outboxError} FROM media_news_email_outbox WHERE ${outboxWhere}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .bind(...values, limit + 1, offset).all<OutboxRow>(),
    ]);
    return json({
      available: true,
      summary: summary.results,
      deliveries: deliveries.results.slice(0, limit).map(row => ({ ...row, retry_hold: row.retry_hold === 1 })),
      outbox: outbox.results.slice(0, limit),
      pagination: { limit, offset, has_more: deliveries.results.length > limit || outbox.results.length > limit },
      window_days: days,
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ available: false, error: error.message }, error.status);
    // No exception text, request URLs, subscription UUIDs or database records in logs.
    console.error(JSON.stringify({ event: 'news_email_delivery_read_unavailable' }));
    return json({ available: false, error: 'delivery_read_unavailable' }, 503);
  }
}
