import {
  canonicalizeUrl, canonicalUrlHash, guardianRemotePreviewUrl, publisherHttpsUrl,
  type AuthorRule, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { parseRssItems, readRssFeed, rssAttribute, ScanError } from './rss';

export const GUARDIAN_ROUTES = [
  { route_key: 'gary-fuller', url: 'https://www.theguardian.com/profile/gary-fuller/rss',
    kind: 'author_profile' },
  { route_key: 'damian-carrington', url: 'https://www.theguardian.com/profile/damiancarrington/rss',
    kind: 'author_profile' },
  { route_key: 'fiona-harvey', url: 'https://www.theguardian.com/profile/fiona-harvey/rss',
    kind: 'author_profile' },
  { route_key: 'guardian-air-pollution',
    url: 'https://www.theguardian.com/environment/air-pollution/rss', kind: 'direct_aq' },
  { route_key: 'guardian-environment', url: 'https://www.theguardian.com/environment/rss',
    fetch_url: 'https://www.theguardian.com/uk/environment/rss', kind: 'filtered' },
  { route_key: 'guardian-pollution', url: 'https://www.theguardian.com/environment/pollution/rss',
    kind: 'filtered' },
  { route_key: 'guardian-uk', url: 'https://www.theguardian.com/uk/rss', kind: 'filtered' },
  { route_key: 'guardian-world', url: 'https://www.theguardian.com/world/rss', kind: 'filtered' },
  { route_key: 'guardian-climate-crisis',
    url: 'https://www.theguardian.com/environment/climate-crisis/rss', kind: 'filtered' },
  { route_key: 'guardian-science', url: 'https://www.theguardian.com/science/rss', kind: 'filtered' },
  { route_key: 'guardian-technology', url: 'https://www.theguardian.com/technology/rss',
    fetch_url: 'https://www.theguardian.com/uk/technology/rss', kind: 'filtered' },
] as const;

export type GuardianRouteKey = typeof GUARDIAN_ROUTES[number]['route_key'];
export type GuardianRouteKind = typeof GUARDIAN_ROUTES[number]['kind'];

export function guardianRouteKind(routeKey: GuardianRouteKey): GuardianRouteKind | null {
  return GUARDIAN_ROUTES.find(route => route.route_key === routeKey)?.kind ?? null;
}

export function guardianProfileRule(rules: AuthorRule[], routeKey: GuardianRouteKey): AuthorRule | null {
  if (guardianRouteKind(routeKey) !== 'author_profile') return null;
  const expectedRoute = GUARDIAN_ROUTES.find(route => route.route_key === routeKey);
  return rules.find(rule => rule.enabled && rule.source_key === 'the-guardian' &&
    rule.profile_rss_route_key === routeKey && rule.profile_rss_url === expectedRoute?.url) ?? null;
}

export function guardianRouteRequiresRelevance(routeKey: GuardianRouteKey): boolean {
  // Profile routes bypass this requirement only while their configured rule is always_include.
  return GUARDIAN_ROUTES.find(route => route.route_key === routeKey)?.kind !== 'direct_aq';
}

function configuredRoute(source: Source, routeKey: string): {
  route_key: GuardianRouteKey;
  url: string;
  max_items: number;
} {
  if (source.source_key !== 'the-guardian' || source.canonical_domain !== 'theguardian.com' ||
      source.discovery_method !== 'rss' || source.publication_policy !== 'manual' ||
      source.review_level !== 'standard' ||
      source.content_fetch_policy !== 'discovery_metadata_only' ||
      source.ai_content_policy !== 'metadata_only' || source.image_policy !== 'remote_preview') {
    throw new ScanError('guardian_policy_mismatch');
  }
  const expected = GUARDIAN_ROUTES.find(route => route.route_key === routeKey);
  const route = source.discovery_config.routes?.find(candidate => candidate.route_key === routeKey);
  if (!expected || !route || route.url !== expected.url || route.max_items > 10) {
    throw new ScanError('guardian_route_config_mismatch');
  }
  return { ...route, route_key: expected.route_key };
}

export function configuredGuardianRouteKeys(source: Source): GuardianRouteKey[] {
  if (source.discovery_config.routes?.length !== GUARDIAN_ROUTES.length) return [];
  try {
    return GUARDIAN_ROUTES.map(route => configuredRoute(source, route.route_key).route_key);
  } catch { return []; }
}

export function scheduledGuardianRouteKeys(source: Source, rules: AuthorRule[]): GuardianRouteKey[] {
  return configuredGuardianRouteKeys(source).filter(routeKey =>
    guardianRouteKind(routeKey) !== 'author_profile' || guardianProfileRule(rules, routeKey) !== null);
}

export async function discoverGuardian(source: Source, routeKey: string): Promise<{
  articles: DiscoveredArticle[];
  items_seen: number;
  items_invalid: number;
}> {
  const route = configuredRoute(source, routeKey);
  const expected = GUARDIAN_ROUTES.find(candidate => candidate.route_key === route.route_key);
  const fetchUrl = expected && 'fetch_url' in expected ? expected.fetch_url : route.url;
  if (!publisherHttpsUrl(fetchUrl, source.canonical_domain)) {
    throw new ScanError('guardian_fetch_url_mismatch');
  }
  return parseGuardianFeed(await readRssFeed(fetchUrl, 'guardian'),
    source, route.max_items);
}

export async function parseGuardianFeed(xml: string, source: Source, maxItems: number): Promise<{
  articles: DiscoveredArticle[];
  items_seen: number;
  items_invalid: number;
}> {
  const parsed = parseRssItems(xml, maxItems, {
    allow_untyped_image_media_content: true,
    title_context: 'guardian_first_paragraph',
  });
  const articles: DiscoveredArticle[] = [];
  let invalid = parsed.items_invalid;
  for (const item of parsed.items) {
    let canonical: string;
    const publisherUrl = publisherHttpsUrl(item.raw_url, source.canonical_domain);
    if (!publisherUrl) { invalid++; continue; }
    try { canonical = canonicalizeUrl(publisherUrl, source.canonical_domain); }
    catch { invalid++; continue; }
    const preview = source.image_policy === 'remote_preview' ? item.preview_candidates
      .map(value => guardianRemotePreviewUrl(rssAttribute(value, 'url')))
      .find((value): value is string => value !== null) ?? null : null;
    articles.push({
      canonical_url: canonical,
      canonical_url_hash: await canonicalUrlHash(canonical),
      original_url: item.raw_url,
      title: item.title,
      author: item.author,
      published_at: item.published_at,
      categories: item.categories,
      title_context: item.title_context,
      preview_url: preview,
      display_title: null,
      display_title_origin: null,
      preview_metadata_checked_at: null,
    });
  }
  return { articles, items_seen: parsed.items_seen, items_invalid: invalid };
}
