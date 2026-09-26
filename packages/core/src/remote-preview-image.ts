import { remotePreviewUrl, type PublisherDomainIdentity } from './canonical-url';

export const REMOTE_PREVIEW_IMAGE_HEADERS = {
  Accept: 'image/*',
  'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
};

function publisherImageReferer(source: PublisherDomainIdentity): string | null {
  const domain = source.canonical_domain.toLowerCase().replace(/^www\./, '');
  return domain === 'le.ac.uk' ? 'https://le.ac.uk/' : null;
}

export type RemotePreviewImageFetchResult =
  | { response: Response; failure: null }
  | { response: null; failure: 'timeout' | 'failed' | 'redirect' };

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

async function requestImage(url: string, source: PublisherDomainIdentity, signal: AbortSignal,
  fetcher: typeof fetch): Promise<RemotePreviewImageFetchResult> {
  try {
    const headers = new Headers(REMOTE_PREVIEW_IMAGE_HEADERS);
    const referer = publisherImageReferer(source);
    if (referer) headers.set('Referer', referer);
    const response = await fetcher(url, {
      method: 'GET', redirect: 'manual', signal, headers,
    });
    return { response, failure: null };
  } catch {
    return { response: null, failure: signal.aborted ? 'timeout' : 'failed' };
  }
}

function hasExplicitPort(raw: string): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  const hostAndPort = authority?.slice(authority.lastIndexOf('@') + 1);
  return Boolean(hostAndPort && (hostAndPort.startsWith('[')
    ? /^\[[^\]]+\]:\d+$/.test(hostAndPort) : /:\d+$/.test(hostAndPort)));
}

// Follow at most three image redirects only when every hop remains inside the
// source's existing publisher/CDN allow-list. This permits normal same-publisher image
// canonicalisation without weakening the remote-preview boundary.
export async function fetchRemotePreviewImage(imageUrl: string, source: PublisherDomainIdentity,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RemotePreviewImageFetchResult> {
  let requestUrl = remotePreviewUrl(imageUrl, source);
  if (!requestUrl) return { response: null, failure: 'redirect' };

  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = await requestImage(requestUrl, source, signal, fetcher);
    if (!result.response || result.failure) return result;
    const response = result.response;
    if (response.status < 300 || response.status >= 400) return result;

    const location = response.headers.get('Location');
    if (!location || location.trim() !== location || location.startsWith('//') ||
        hasExplicitPort(location) || redirects === 3) {
      await cancel(response);
      return { response: null, failure: 'redirect' };
    }

    let redirectedUrl: string | null;
    try {
      redirectedUrl = remotePreviewUrl(new URL(location, requestUrl).href, source);
    } catch {
      redirectedUrl = null;
    }
    await cancel(response);
    if (!redirectedUrl) return { response: null, failure: 'redirect' };
    requestUrl = redirectedUrl;
  }

  return { response: null, failure: 'redirect' };
}
