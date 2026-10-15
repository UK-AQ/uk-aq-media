const trackingKeys = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid']);

export type PublisherDomainIdentity = {
  source_key: string;
  canonical_domain: string;
};

type PublisherDomainInput = string | PublisherDomainIdentity;

// Alternate publisher domains accepted for article URLs. Image URLs are still validated
// through remotePreviewUrl and the publisher/CDN allow-list below.
const sourceDomainAliases: Readonly<Record<string, readonly string[]>> = {
  'the-independent': ['independent.co.uk'],
  'bbc-news': ['bbc.com'],
};

function normaliseDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '');
}

export function publisherDomains(source: PublisherDomainInput): readonly string[] {
  const canonicalDomain = normaliseDomain(
    typeof source === 'string' ? source : source.canonical_domain,
  );
  if (typeof source === 'string') return [canonicalDomain];
  const aliases = sourceDomainAliases[source.source_key] ?? [];
  return [canonicalDomain, ...aliases];
}

// Trusted SQL expressions only. Keep dashboard domain decisions aligned with
// the same existing alias catalogue used for article ownership validation.
export function publisherDomainsSql(sourceKey: string, canonicalDomain: string): string {
  return `(CASE ${sourceKey} ${Object.entries(sourceDomainAliases).map(([key, aliases]) =>
    `WHEN '${key}' THEN json_array(${canonicalDomain}, ${aliases.map(domain => `'${domain}'`).join(', ')})`)
    .join(' ')} ELSE json_array(${canonicalDomain}) END)`;
}

function matchedPublisherDomain(hostname: string, source: PublisherDomainInput): string | null {
  const candidate = hostname.toLowerCase().replace(/^www\./, '');
  return publisherDomains(source).find(domain =>
    candidate === domain || candidate.endsWith(`.${domain}`)) ?? null;
}

export function canonicalizeUrl(raw: string, source: PublisherDomainInput): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('invalid_article_url');
  }
  // Collapse only the www form of the matched current/legacy publisher domain. Other
  // publisher subdomains retain their identity, as do meaningful query parameters.
  const canonicalDomain = publisherDomains(source)[0]!;
  const candidateDomain = normaliseDomain(url.hostname);
  const matchedDomain = candidateDomain === canonicalDomain ? canonicalDomain
    : publisherDomains(source).slice(1).find(domain =>
      candidateDomain === domain || candidateDomain.endsWith(`.${domain}`)) ?? null;
  if (!matchedDomain) throw new Error('off_source_article_url');
  if (normaliseDomain(url.hostname) === matchedDomain) url.hostname = matchedDomain;
  url.protocol = 'https:';
  url.hash = '';
  const sourceKey = typeof source === 'string' ? null : source.source_key;
  for (const key of [...url.searchParams.keys()]) {
    const normalisedKey = key.toLowerCase();
    if (normalisedKey.startsWith('utm_') || trackingKeys.has(normalisedKey) ||
        (sourceKey === 'openaq' && normalisedKey === 'source')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  // AQN WordPress permalinks use a trailing slash. Do not rewrite other publishers.
  if (canonicalDomain === 'airqualitynews.com' && !url.pathname.endsWith('/') &&
      !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += '/';
  return url.href;
}

export async function canonicalUrlHash(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function publisherHttpsUrl(raw: unknown, source: PublisherDomainInput): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      matchedPublisherDomain(url.hostname, source) !== null ? url.href : null;
  } catch { return null; }
}

const sourcePreviewImageHostnames: Readonly<Record<string, readonly string[]>> = {
  'bbc-news': ['ichef.bbci.co.uk'],
  'sky-news': ['e3.365dm.com'],
  'the-guardian': ['i.guim.co.uk'],
  openaq: ['cdn-images-1.medium.com'],
  'phys-org': ['scx2.b-cdn.net'],
  dsawsp: ['cdn.prod.website-files.com'],
};

const publisherDomainPreviewImageHostnames: Readonly<Record<string, readonly string[]>> = {
  'cambridge-news.co.uk': ['i2-prod.liverpoolecho.co.uk'],
  'bbc.co.uk': ['ichef.bbci.co.uk'],
  'bbc.com': ['ichef.bbci.co.uk'],
  'cleanairfund.org': ['s40026.pcdn.co'],
};

function exactPreviewImageUrl(raw: unknown, hostnames: readonly string[]): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  const hostAndPort = authority?.slice(authority.lastIndexOf('@') + 1);
  if (hostAndPort && (hostAndPort.startsWith('[')
    ? /^\[[^\]]+\]:\d+$/.test(hostAndPort) : /:\d+$/.test(hostAndPort))) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      hostnames.includes(url.hostname.toLowerCase()) ? url.href : null;
  } catch { return null; }
}

export function remotePreviewUrl(raw: unknown, source: PublisherDomainInput): string | null {
  const publisherUrl = publisherHttpsUrl(raw, source);
  if (publisherUrl || typeof source === 'string') return publisherUrl;
  const additionalHostnames = [
    ...(sourcePreviewImageHostnames[source.source_key] ?? []),
    ...(publisherDomainPreviewImageHostnames[normaliseDomain(source.canonical_domain)] ?? []),
  ];
  const external = exactPreviewImageUrl(raw, additionalHostnames);
  if (source.source_key === 'mums-for-lungs') {
    const squarespace = exactPreviewImageUrl(raw, ['images.squarespace-cdn.com']);
    if (!squarespace) return external;
    return new URL(squarespace).pathname.startsWith('/content/v1/60fe62a6c0eb074f99a31664/')
      ? squarespace : null;
  }
  return external;
}

export function guardianRemotePreviewUrl(raw: unknown): string | null {
  return exactPreviewImageUrl(raw, sourcePreviewImageHostnames['the-guardian']!);
}
