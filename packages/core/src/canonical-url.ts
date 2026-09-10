const trackingKeys = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid']);

function isPublisherHostname(hostname: string, sourceDomain: string): boolean {
  const domain = sourceDomain.toLowerCase().replace(/^www\./, '');
  const candidate = hostname.toLowerCase().replace(/^www\./, '');
  return candidate === domain || candidate.endsWith(`.${domain}`);
}

export function canonicalizeUrl(raw: string, sourceDomain: string): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('invalid_article_url');
  }
  // Only known www aliases are collapsed. Meaningful query parameters are kept.
  const domain = sourceDomain.toLowerCase().replace(/^www\./, '');
  if (url.hostname.replace(/^www\./, '') !== domain) throw new Error('off_source_article_url');
  url.hostname = domain;
  url.protocol = 'https:';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || trackingKeys.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  // AQN WordPress permalinks use a trailing slash. Do not rewrite other publishers.
  if (domain === 'airqualitynews.com' && !url.pathname.endsWith('/') &&
      !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += '/';
  return url.href;
}

export async function canonicalUrlHash(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function publisherHttpsUrl(raw: unknown, sourceDomain: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      isPublisherHostname(url.hostname, sourceDomain) ? url.href : null;
  } catch { return null; }
}

export function remotePreviewUrl(raw: unknown, sourceDomain: string): string | null {
  return publisherHttpsUrl(raw, sourceDomain);
}

const guardianImageHostnames = new Set(['i.guim.co.uk']);

export function guardianRemotePreviewUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      guardianImageHostnames.has(url.hostname.toLowerCase()) ? url.href : null;
  } catch { return null; }
}
