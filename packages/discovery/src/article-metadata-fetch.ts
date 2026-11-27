import {
  canonicalizeUrl, HttpError, publisherDomains, publisherHttpsUrl, type Source,
} from '@uk-aq-media/core';
import { ScanError } from './rss';

type PublisherDomain = Pick<Source, 'source_key' | 'canonical_domain'>;
export type PublisherArticleMetadataTarget = { canonical_url: string; original_url?: string | null };
type FetchOptions = {
  requireAllowedUrl?: (url: string) => Promise<void>;
  fetcher?: typeof fetch;
  maxRedirects?: number;
};

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function publisherRequestUrl(raw: string, source: PublisherDomain): string | null {
  const permitted = publisherHttpsUrl(raw, source);
  if (!permitted) return null;
  const url = new URL(permitted);
  url.hash = '';
  return url.href;
}

function equivalentHttpsUrl(raw: string, canonical: string, source: PublisherDomain): string | null {
  const permitted = publisherRequestUrl(raw, source);
  if (!permitted) return null;
  try { return canonicalizeUrl(permitted, source) === canonical ? permitted : null; }
  catch { return null; }
}

function recoveryUrl(requestUrl: string, destination: URL, canonical: string,
  source: PublisherDomain): string | null {
  if (destination.protocol !== 'http:' || destination.username || destination.password || destination.port) {
    return null;
  }
  const requested = new URL(requestUrl);
  if (destination.pathname !== requested.pathname || destination.search !== requested.search ||
      !publisherDomains(source).some(domain => requested.hostname === domain && destination.hostname === `www.${domain}` ||
        requested.hostname === `www.${domain}` && destination.hostname === domain)) return null;
  const https = new URL(destination);
  https.protocol = 'https:';
  return equivalentHttpsUrl(https.href, canonical, source);
}

function redirectRejection(destination: URL, source: PublisherDomain): string {
  if (destination.username || destination.password) return 'credentials';
  if (destination.port) return 'custom_port';
  if (destination.protocol === 'http:') return 'http_scheme';
  if (destination.protocol !== 'https:') return 'unsupported_scheme';
  return publisherDomains(source).some(domain => destination.hostname === domain ||
    destination.hostname.endsWith(`.${domain}`)) ? 'invalid_https_url' : 'off_publisher';
}

function domainBlocked(error: unknown): boolean {
  return error instanceof HttpError && error.message.startsWith('publisher_domain_blocked:');
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

export async function fetchPublisherArticleMetadata<T>(target: PublisherArticleMetadataTarget,
  source: PublisherDomain, read: (response: Response, url: string, signal: AbortSignal,
    recovered: boolean) => Promise<T>, options: FetchOptions = {}): Promise<T> {
  const canonical = publisherRequestUrl(target.canonical_url, source);
  if (!canonical) throw new ScanError('invalid_article_head_url');
  const original = target.original_url && equivalentHttpsUrl(target.original_url, target.canonical_url, source);
  const { requireAllowedUrl, fetcher = fetch } = options;
  const maxRedirects = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
  const controller = new AbortController();
  const signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let requestUrl = original || canonical;
  let redirects = 0;
  let recovery: { from_host: string; https_host: string; attempted: boolean } | undefined;
  let rejectedRedirect: string | undefined;
  const rejectRedirect = (code: string, reason: string): never => {
    console.info('article_metadata_redirect', { code, reason, recovery_attempted: false, recovery_succeeded: false });
    throw new ScanError(code);
  };
  try {
    for (;;) {
      try { await requireAllowedUrl?.(requestUrl); }
      catch (error) {
        if (domainBlocked(error)) {
          if (redirects === 0 && !recovery && requestUrl !== canonical) {
            requestUrl = canonical;
            continue;
          }
          if (redirects > 0 && !recovery) console.info('article_metadata_redirect', {
            code: 'publisher_domain_blocked', reason: 'publisher_domain_blocked',
            recovery_attempted: false, recovery_succeeded: false,
          });
        }
        throw error;
      }
      if (signal.aborted) throw new ScanError('article_head_timeout');
      if (recovery) recovery.attempted = true;
      let response: Response;
      try {
        response = await fetcher(requestUrl, { method: 'GET', redirect: 'manual', signal,
          headers: { Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)' } });
      } catch {
        throw new ScanError(signal.aborted ? 'article_head_timeout' : 'article_head_fetch_failed');
      }
      if (response.status < 300 || response.status >= 400) {
        if (!response.ok) {
          await cancelBody(response);
          throw new ScanError(`article_head_http_${response.status}`);
        }
        const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (type !== 'text/html' && type !== 'application/xhtml+xml') {
          await cancelBody(response);
          throw new ScanError('article_head_not_html');
        }
        const result = await read(response, requestUrl, signal, Boolean(recovery));
        if (recovery) console.info('article_metadata_redirect', {
          code: 'article_head_redirect_not_permitted', reason: rejectedRedirect,
          from_host: recovery.from_host, https_host: recovery.https_host,
          recovery_attempted: true, recovery_succeeded: true,
        });
        return result;
      }

      await cancelBody(response);
      // The alternate is one direct HTTPS request. It never starts another redirect chain.
      if (recovery) throw new ScanError('article_head_recovery_redirect');
      if (!REDIRECT_STATUSES.has(response.status)) {
        rejectRedirect('article_head_redirect_unsupported', 'unsupported_status');
      }
      if (redirects >= maxRedirects) rejectRedirect('article_head_redirect_limit', 'redirect_limit');
      const location = response.headers.get('Location')?.trim();
      if (!location) return rejectRedirect('article_head_redirect_missing_location', 'missing_location');
      let destination: URL;
      try { destination = new URL(location, requestUrl); }
      catch { return rejectRedirect('article_head_redirect_malformed_location', 'malformed_location'); }
      const permitted = publisherRequestUrl(destination.href, source);
      if (permitted) {
        requestUrl = permitted;
        redirects++;
        continue;
      }
      rejectedRedirect = redirectRejection(destination, source);
      const alternate = recoveryUrl(requestUrl, destination, target.canonical_url, source);
      if (!alternate) return rejectRedirect('article_head_redirect_not_permitted', rejectedRedirect);
      recovery = { from_host: new URL(requestUrl).hostname, https_host: new URL(alternate).hostname, attempted: false };
      requestUrl = alternate;
    }
  } catch (error) {
    if (!recovery) throw error;
    console.info('article_metadata_redirect', {
      code: 'article_head_redirect_not_permitted', reason: rejectedRedirect,
      from_host: recovery.from_host, https_host: recovery.https_host,
      recovery_attempted: recovery.attempted, recovery_succeeded: false,
      recovery_error: error instanceof ScanError ? error.code
        : domainBlocked(error) ? 'publisher_domain_blocked' : 'article_head_recovery_failed',
    });
    throw new ScanError('article_head_redirect_not_permitted');
  } finally { clearTimeout(timeout); }
}
