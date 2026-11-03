import { HttpError } from './http';

export const THREADS_TEXT_MAX_BYTES = 500;
export const THREADS_API_VERSION = 'v1.0';
export type ThreadsConfig = {
  UK_AQ_MEDIA_THREADS_CONFIGURED: string;
  UK_AQ_MEDIA_THREADS_USER_ID: string;
  UK_AQ_MEDIA_THREADS_USERNAME: string;
  UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT: string;
};
export type ThreadsSettings = {
  manual_publishing_enabled: number; automatic_publishing_enabled: number; cooldown_seconds: number;
  activation_event_id: number | null; automatic_events_through_id: number | null;
  capture_only_enabled: number; capture_activation_event_id: number | null;
  capture_events_through_id: number | null;
  remote_request_key: string | null; remote_request_lease_until: string | null;
  automatic_intent_error_code: string | null; automatic_intent_error_event_id: number | null;
  last_identity_checked_at: string | null; last_identity_verified_at: string | null;
  last_identity_user_id: string | null; last_identity_username: string | null;
  last_identity_error_code: string | null; last_successful_post_at: string | null;
  updated_at: string;
};

export function threadsConfigurationError(config: ThreadsConfig, now = Date.now()): string | null {
  if (config.UK_AQ_MEDIA_THREADS_CONFIGURED !== 'true') return 'threads_not_configured';
  if (!/^[0-9]{1,100}$/.test(config.UK_AQ_MEDIA_THREADS_USER_ID) ||
      !/^[A-Za-z0-9_.]{1,100}$/.test(config.UK_AQ_MEDIA_THREADS_USERNAME)) {
    return 'threads_identity_configuration_invalid';
  }
  const expiry = config.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT;
  if (expiry && (!Number.isFinite(Date.parse(expiry)) || !expiry.endsWith('Z'))) {
    return 'threads_expiry_configuration_invalid';
  }
  return expiry && Date.parse(expiry) <= now ? 'threads_token_expired' : null;
}

export function threadsAutomaticConfigurationError(config: ThreadsConfig): string | null {
  return threadsConfigurationError(config) ||
    (!config.UK_AQ_MEDIA_THREADS_TOKEN_EXPIRES_AT ? 'threads_token_expiry_required' : null);
}

export function threadsEnablementError(config: ThreadsConfig, settings: ThreadsSettings | null,
  automatic = false): string | null {
  const error = automatic ? threadsAutomaticConfigurationError(config) : threadsConfigurationError(config);
  if (error) return error;
  if (!settings) return 'threads_settings_missing';
  if (!settings.last_identity_verified_at || settings.last_identity_error_code ||
      settings.last_identity_user_id !== config.UK_AQ_MEDIA_THREADS_USER_ID ||
      settings.last_identity_username !== config.UK_AQ_MEDIA_THREADS_USERNAME) {
    return settings.last_identity_error_code ?? 'threads_identity_not_verified';
  }
  return null;
}

export function threadsAvailability(config: ThreadsConfig, settings: ThreadsSettings | null,
  automatic = false): string | null {
  if (settings?.capture_only_enabled) return 'threads_capture_only';
  const error = threadsEnablementError(config, settings, automatic);
  if (error) return error;
  if (!(automatic ? settings!.automatic_publishing_enabled : settings!.manual_publishing_enabled)) {
    return automatic ? 'threads_automatic_publishing_disabled' : 'threads_manual_publishing_disabled';
  }
  return null;
}

export type ThreadsArticle = { id?: number; title: string; publisher: string; canonical_url: string };

export function renderThreadsPost(article: ThreadsArticle): { text: string; link_attachment: string } {
  const clean = (value: string, max: number, code: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max ||
        /[\u0000-\u001f\u007f]/.test(value)) throw new Error(code);
    return value.trim();
  };
  const title = clean(article.title, 10000, 'threads_title_invalid');
  const publisher = clean(article.publisher, 500, 'threads_publisher_invalid');
  const link = clean(article.canonical_url, 2048, 'threads_link_invalid');
  let url: URL;
  try { url = new URL(link); } catch { throw new Error('threads_link_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('threads_link_invalid');
  }
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const attribution = `\nFrom ${publisher}`;
  // UTF-8 byte counting is conservative for Meta's character/emoji rules.
  if (bytes(attribution) + 4 > THREADS_TEXT_MAX_BYTES) throw new Error('threads_attribution_too_long');
  if (bytes(title + attribution) <= THREADS_TEXT_MAX_BYTES) return { text: title + attribution, link_attachment: link };
  let shortened = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(title)) {
    if (bytes(shortened + segment + '…' + attribution) > THREADS_TEXT_MAX_BYTES) break;
    shortened += segment;
  }
  if (!shortened.trim()) throw new Error('threads_title_invalid');
  return { text: shortened.trimEnd() + '…' + attribution, link_attachment: link };
}

export async function threadsEligibility(db: D1Database, config: ThreadsConfig,
  articles: ThreadsArticle[]): Promise<{ failures: { article_id: number | null; error: string }[] }> {
  const settings = await db.prepare('SELECT * FROM media_threads_settings WHERE id = 1').first<ThreadsSettings>();
  const unavailable = threadsAvailability(config, settings);
  const failures: { article_id: number | null; error: string }[] = [];
  for (const article of articles) {
    let error = unavailable;
    if (!error) {
      try { renderThreadsPost(article); } catch (failure) {
        error = failure instanceof Error ? failure.message : 'threads_render_invalid';
      }
    }
    if (!error && article.id) {
      const active = await db.prepare(`SELECT status FROM media_threads_publications
        WHERE article_id = ? AND status IN ('queued', 'posting', 'unknown_remote_state') LIMIT 1`)
        .bind(article.id).first<{ status: string }>();
      if (active) error = active.status === 'unknown_remote_state' ? 'unknown_remote_state' : 'publication_in_progress';
    }
    if (error) failures.push({ article_id: article.id ?? null, error });
  }
  return { failures };
}

export async function requireThreadsEligibility(db: D1Database, config: ThreadsConfig,
  articles: ThreadsArticle[]): Promise<void> {
  const result = await threadsEligibility(db, config, articles);
  if (result.failures[0]) throw new HttpError(409, result.failures[0].error);
}
