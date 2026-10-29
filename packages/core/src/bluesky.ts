export const BLUESKY_HANDLE = 'ukaq.co.uk';
export const BLUESKY_POST_GRAPHEMES = 300;
export const BLUESKY_POST_BYTES = 3000;
export const BLUESKY_TEMPLATE_LITERAL_GRAPHEMES = 120;
export const BLUESKY_THUMBNAIL_BYTES = 1_000_000;
export const BLUESKY_PLACEHOLDERS = ['publisher', 'publisher_mention'] as const;
export const DEFAULT_BLUESKY_MESSAGE =
  'From {publisher} {publisher_mention}\n\nLive and historical UK air quality data:\nhttps://ukaq.co.uk/';

const segmenter = new Intl.Segmenter('en-GB', { granularity: 'grapheme' });

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map(part => part.segment);
}

export function validateBlueskyTemplate(template: string): { literalGraphemes: number } {
  if (!template || template.length > 2000) throw new Error('message_template_invalid');
  const withoutKnown = template.replace(/\{(?:publisher|publisher_mention)\}/g, '');
  if (/\{[^{}]*\}/.test(withoutKnown) || withoutKnown.includes('{') || withoutKnown.includes('}')) {
    throw new Error('message_template_unknown_placeholder');
  }
  if ((template.match(/\{publisher_mention\}/g) ?? []).length > 1) {
    throw new Error('message_template_multiple_mentions');
  }
  const literalGraphemes = graphemes(withoutKnown).length;
  if (literalGraphemes > BLUESKY_TEMPLATE_LITERAL_GRAPHEMES) {
    throw new Error('message_template_too_long');
  }
  return { literalGraphemes };
}

export type BlueskyFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string } |
    { $type: 'app.bsky.richtext.facet#mention'; did: string } |
    { $type: 'app.bsky.richtext.facet#tag'; tag: string }>;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function expandBlueskyTemplate(template: string, publisher: string, mention: string): {
  text: string; mentionIndex: number | null;
} {
  const token = /\{publisher(?:_mention)?\}/g;
  let text = '';
  let cursor = 0;
  let mentionIndex: number | null = null;
  for (const match of template.matchAll(token)) {
    text += template.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0] === '{publisher}') {
      text += publisher;
      continue;
    }
    if (mention) {
      mentionIndex = text.length;
      text += mention;
      continue;
    }

    // Remove only horizontal whitespace adjacent to the empty optional token.
    // If the token joined two pieces of text, retain one separating space.
    text = text.replace(/[ \t]+$/u, '');
    while (cursor < template.length && /[ \t]/u.test(template[cursor]!)) cursor++;
    const left = text.at(-1);
    const right = template[cursor];
    if (left && left !== '\n' && right && right !== '\n') text += ' ';
  }
  text += template.slice(cursor);
  return { text, mentionIndex };
}

export function renderBlueskyPost(input: { title: string; publisher: string;
  template: string; publisherMention?: { handle: string; did: string } | null }):
  { text: string; facets: BlueskyFacet[] } {
  validateBlueskyTemplate(input.template);
  const mention = input.publisherMention?.handle ? `@${input.publisherMention.handle}` : '';
  const expanded = expandBlueskyTemplate(input.template, input.publisher, mention);
  const separator = '\n';
  const remaining = BLUESKY_POST_GRAPHEMES - graphemes(separator + expanded.text).length;
  if (remaining < 1) throw new Error('post_text_too_long');
  const titleParts = graphemes(input.title.trim());
  if (!titleParts.length) throw new Error('post_text_too_long');
  let truncated = titleParts.length > remaining;
  let prefixLength = truncated ? Math.max(0, remaining - 1) : titleParts.length;
  let title = truncated ? `${titleParts.slice(0, prefixLength).join('')}…` : titleParts.join('');
  let text = `${title}${separator}${expanded.text}`;
  while (utf8Length(text) > BLUESKY_POST_BYTES) {
    if (!truncated) {
      truncated = true;
      prefixLength = Math.min(Math.max(0, remaining - 1), titleParts.length - 1);
    } else if (prefixLength > 0) {
      prefixLength--;
    } else {
      throw new Error('post_text_too_long');
    }
    title = `${titleParts.slice(0, prefixLength).join('')}…`;
    text = `${title}${separator}${expanded.text}`;
  }

  const facets: BlueskyFacet[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const add = (start: number, raw: string, feature: BlueskyFacet['features'][number]) => {
    ranges.push({ start, end: start + raw.length });
    facets.push({ index: { byteStart: utf8Length(text.slice(0, start)),
      byteEnd: utf8Length(text.slice(0, start + raw.length)) }, features: [feature] });
  };
  for (const match of text.matchAll(/https:\/\/[^\s]+/g)) {
    add(match.index, match[0], { $type: 'app.bsky.richtext.facet#link', uri: match[0] });
  }
  if (mention && input.publisherMention && expanded.mentionIndex !== null) {
    const start = title.length + separator.length + expanded.mentionIndex;
    if (text.slice(start, start + mention.length) === mention) add(start, mention,
      { $type: 'app.bsky.richtext.facet#mention', did: input.publisherMention.did });
  }
  for (const match of text.matchAll(/#[\p{L}\p{N}\p{M}_]+/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(0, start).match(/[\s\S]$/u)?.[0];
    if (before && /[\p{L}\p{N}\p{M}_#]/u.test(before)) continue;
    if (ranges.some(range => start < range.end && end > range.start)) continue;
    const tag = match[0].slice(1);
    if (graphemes(tag).length > 64 || utf8Length(tag) > 640) continue;
    add(start, match[0], { $type: 'app.bsky.richtext.facet#tag', tag });
  }
  return { text, facets: facets.sort((a, b) => a.index.byteStart - b.index.byteStart) };
}

// AT Protocol TIDs are 64-bit values encoded as 13 s32 characters. The high
// 53 bits are microseconds and the low 10 bits are a clock id. Persisting this
// value before createRecord makes an at-least-once retry address the same record.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
export function deterministicTid(createdAt: string, publicationId: number): string {
  const millis = Date.parse(createdAt);
  if (!Number.isFinite(millis) || !Number.isSafeInteger(publicationId) || publicationId < 1) {
    throw new Error('publication_state_conflict');
  }
  let value = BigInt(millis) * 1000n * 1024n + BigInt(publicationId % 1024);
  let result = '';
  for (let index = 0; index < 13; index++) {
    result = S32[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export type BlueskyWakeup = { type: 'bluesky_wakeup'; publication_id?: number };

// Use in single-table publication subqueries (including aliased tables).
export const BLUESKY_IN_PROGRESS_SQL = `(status IN ('queued', 'posting') OR
  (publication_reason = 'auto_approved' AND status = 'blocked'
    AND last_error_code = 'thumbnail_pending'))`;

export function blueskyPublicationStatusLabel(status: string, error: unknown): string {
  if (status === 'blocked' && error === 'thumbnail_pending') return 'Waiting for thumbnail';
  if (status === 'blocked' && error === 'operator_cancelled') return 'Cancelled';
  const labels: Record<string, string> = {
    queued: 'Queued', posting: 'Posting', posted: 'Posted', failed: 'Failed', blocked: 'Blocked',
  };
  return labels[status] ?? status;
}

export async function releaseBlueskyThumbnailPending(db: D1Database): Promise<number> {
  // Only release intent already created by the forward-only auto-approval trigger.
  // The view keeps outbox creation and recovery on the same image-policy boundary;
  // the consumer still validates the actual URL and bytes before any remote write.
  const result = await db.prepare(`UPDATE media_bluesky_publications
    SET status = 'queued', last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
    WHERE publication_reason = 'auto_approved' AND status = 'blocked'
      AND last_error_code = 'thumbnail_pending'
      AND EXISTS (
        SELECT 1 FROM media_bluesky_thumbnail_eligible_articles ready
        WHERE ready.article_id = media_bluesky_publications.article_id
      )`)
    .bind(new Date().toISOString()).run();
  return Number(result.meta.changes ?? 0);
}

// One durable scheduling slot is shared by admin, discovery and GDELT producers.
// A lease spans the requested delivery time and allows scheduled recovery of
// a lost Queue message. UPDATE ... RETURNING atomically elects one producer.
type BlueskyWakeSettings = {
  publishing_enabled: number; activation_event_id: number | null;
  cooldown_seconds: number; last_successful_post_at: string | null;
};
const WAKE_RECOVERY_MS = 10 * 60 * 1000;
const WAKE_POSTING_STALE_MS = 10 * 60 * 1000;
const MAX_WAKE_DELAY_SECONDS = 43_200;

export async function scheduleBlueskyWake(db: D1Database, queue: Pick<Queue, 'send'>,
  settings?: BlueskyWakeSettings): Promise<boolean> {
  const configured = settings ?? await db.prepare(
    'SELECT publishing_enabled, activation_event_id, cooldown_seconds, ' +
    'last_successful_post_at FROM media_bluesky_settings WHERE id = 1'
  ).first<BlueskyWakeSettings>();
  if (!configured || !configured.publishing_enabled ||
    configured.activation_event_id === null) return false;
  const [queued, posting] = await Promise.all([
    db.prepare(`SELECT next_attempt_at FROM media_bluesky_publications
      WHERE status = 'queued'
      ORDER BY CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END,
        next_attempt_at, id LIMIT 1`)
      .first<{ next_attempt_at: string | null }>(),
    db.prepare(`SELECT last_attempted_at FROM media_bluesky_publications
      WHERE status = 'posting'
      ORDER BY CASE WHEN last_attempted_at IS NULL THEN 0 ELSE 1 END,
        last_attempted_at, id LIMIT 1`)
      .first<{ last_attempted_at: string | null }>(),
  ]);
  if (!queued && !posting) return false;
  const now = Date.now();
  const timestamp = (date: string | null): number =>
    date && Number.isFinite(Date.parse(date)) ? Date.parse(date) : now;
  const queuedAt = queued ? timestamp(queued.next_attempt_at) : Number.POSITIVE_INFINITY;
  const postingAt = posting ? timestamp(posting.last_attempted_at) +
    (posting.last_attempted_at ? WAKE_POSTING_STALE_MS : 0) : now;
  const cooldownAt = configured.last_successful_post_at
    ? timestamp(configured.last_successful_post_at) + configured.cooldown_seconds * 1000 : now;
  const desiredAt = Math.max(now, cooldownAt, posting ? postingAt : queuedAt);
  const delaySeconds = Math.min(MAX_WAKE_DELAY_SECONDS,
    Math.max(0, Math.ceil((desiredAt - now) / 1000)));
  // Use stable requested time to avoid millisecond rounding causing a new
  // delayed wake-up on every repeated discovery reconciliation.
  const dueAt = new Date(Math.min(desiredAt, now + MAX_WAKE_DELAY_SECONDS * 1000)).toISOString();
  const nowIso = new Date(now).toISOString();
  const leaseUntil = new Date(now + delaySeconds * 1000 + WAKE_RECOVERY_MS).toISOString();
  const claimed = await db.prepare(`UPDATE media_bluesky_wakeup_schedule
    SET generation = generation + 1, state = 'scheduled', due_at = ?,
      lease_expires_at = ?, updated_at = ?
    WHERE id = 1 AND (
      state = 'idle' OR lease_expires_at <= ?
      OR (state = 'scheduled' AND due_at > ?)
    ) RETURNING generation`)
    .bind(dueAt, leaseUntil, nowIso, nowIso, dueAt).first<{ generation: number }>();
  if (!claimed) return false;
  try {
    await queue.send({ type: 'bluesky_wakeup' } satisfies BlueskyWakeup,
      delaySeconds ? { delaySeconds } : undefined);
    return true;
  } catch (error) {
    // D1 is authoritative. If the send outcome is unknown, a later re-send is
    // safe because only one consumer can acquire the singleton processing slot.
    await db.prepare(`UPDATE media_bluesky_wakeup_schedule
      SET state = 'idle', due_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = 1 AND generation = ? AND state = 'scheduled'`)
      .bind(new Date(Date.now()).toISOString(), claimed.generation).run();
    throw error;
  }
}

export async function claimBlueskyWake(db: D1Database): Promise<number | null> {
  const now = new Date(Date.now());
  const row = await db.prepare(`UPDATE media_bluesky_wakeup_schedule
    SET state = 'processing', lease_expires_at = ?, updated_at = ?
    WHERE id = 1 AND state = 'scheduled' AND due_at <= ?
    RETURNING generation`)
    .bind(new Date(now.getTime() + WAKE_RECOVERY_MS).toISOString(),
      now.toISOString(), now.toISOString()).first<{ generation: number }>();
  return row?.generation ?? null;
}

export async function completeBlueskyWake(db: D1Database, generation: number): Promise<void> {
  await db.prepare(`UPDATE media_bluesky_wakeup_schedule
    SET state = 'idle', due_at = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = 1 AND generation = ? AND state = 'processing'`)
    .bind(new Date(Date.now()).toISOString(), generation).run();
}

export async function reconcileBlueskyPublications(db: D1Database,
  queue: Pick<Queue, 'send'>): Promise<void> {
  await releaseBlueskyThumbnailPending(db);
  await scheduleBlueskyWake(db, queue);
}

export function isBlueskyWakeup(value: unknown): value is BlueskyWakeup {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.type === 'bluesky_wakeup' && (body.publication_id === undefined ||
    Number.isSafeInteger(body.publication_id) && Number(body.publication_id) > 0) &&
    Object.keys(body).every(key => key === 'type' || key === 'publication_id');
}
