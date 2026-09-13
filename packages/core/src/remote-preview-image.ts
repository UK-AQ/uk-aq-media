import { remotePreviewUrl, type PublisherDomainIdentity } from './canonical-url';

export const REMOTE_PREVIEW_IMAGE_HEADERS = {
  Accept: 'image/*',
  'User-Agent': 'UK-AQ-Media/0.1 (+https://github.com/TEST-uk-aq/uk-aq-media)',
};

export type RemotePreviewImageFetchResult =
  | { response: Response; failure: null }
  | { response: null; failure: 'timeout' | 'failed' | 'redirect' };

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

async function requestImage(url: string, signal: AbortSignal,
  fetcher: typeof fetch): Promise<RemotePreviewImageFetchResult> {
  try {
    const response = await fetcher(url, {
      method: 'GET', redirect: 'manual', signal, headers: REMOTE_PREVIEW_IMAGE_HEADERS,
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

// OpenAQ's permitted Medium image CDN currently emits one relative resize redirect.
// Keep this exception source-specific and revalidate its resolved target before fetch.
export async function fetchRemotePreviewImage(imageUrl: string, source: PublisherDomainIdentity,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RemotePreviewImageFetchResult> {
  const initialUrl = source.source_key === 'openaq' ? remotePreviewUrl(imageUrl, source) : imageUrl;
  if (!initialUrl) return { response: null, failure: 'redirect' };
  const first = await requestImage(initialUrl, signal, fetcher);
  if (!first.response || first.failure) return first;
  if (first.response.status < 300 || first.response.status >= 400) return first;
  if (source.source_key !== 'openaq') {
    await cancel(first.response);
    return { response: null, failure: 'redirect' };
  }

  const location = first.response.headers.get('Location');
  if (!location || location.trim() !== location || location.startsWith('//') || hasExplicitPort(location)) {
    await cancel(first.response);
    return { response: null, failure: 'redirect' };
  }
  let redirectedUrl: string | null;
  try {
    redirectedUrl = remotePreviewUrl(new URL(location, initialUrl).href, source);
  } catch {
    redirectedUrl = null;
  }
  await cancel(first.response);
  if (!redirectedUrl) return { response: null, failure: 'redirect' };

  const second = await requestImage(redirectedUrl, signal, fetcher);
  if (!second.response || second.failure) return second;
  if (second.response.status >= 300 && second.response.status < 400) {
    await cancel(second.response);
    return { response: null, failure: 'redirect' };
  }
  return second;
}
