import {
  canonicalizeUrl, canonicalUrlHash, guardianRemotePreviewUrl, publisherHttpsUrl,
  type AuthorRule, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import {
  parseRssItems, readRssFeed, ScanError,
  type RssPreviewCandidate, type RssPreviewCandidateKind,
} from './rss';

export type GuardianPreviewCandidate = {
  url: string;
  kind: RssPreviewCandidateKind;
  width: number | null;
  height: number | null;
  rss_order: number;
};

export type GuardianPreviewLookup = {
  article_found: boolean;
  proposed: GuardianPreviewCandidate | null;
  current: GuardianPreviewCandidate | null;
};

export type GuardianRssCandidateEvidence = GuardianPreviewCandidate & {
  route_keys: GuardianRouteKey[];
};

export type GuardianRssArticleImageEvidence = {
  canonical_url: string;
  route_keys: GuardianRouteKey[];
  candidates: GuardianRssCandidateEvidence[];
  proposed: GuardianPreviewCandidate | null;
  ambiguous_proposal: boolean;
};

export type GuardianRssImageView = {
  routes_fetched: GuardianRouteKey[];
  article_observations: number;
  articles: Map<string, GuardianRssArticleImageEvidence>;
};

export type GuardianRouteFeed = {
  route_key: GuardianRouteKey;
  xml: string;
  max_items: number;
};

const guardianCandidateKindPriority: Record<RssPreviewCandidateKind, number> = {
  'media:content': 3,
  enclosure: 2,
  'media:thumbnail': 1,
};

function positiveDimension(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function permittedGuardianPreviewCandidates(
  candidates: RssPreviewCandidate[],
): GuardianPreviewCandidate[] {
  const permitted: GuardianPreviewCandidate[] = [];
  for (const candidate of candidates) {
    const url = guardianRemotePreviewUrl(candidate.url);
    if (!url) continue;
    permitted.push({
      url,
      kind: candidate.kind,
      width: positiveDimension(candidate.width),
      height: positiveDimension(candidate.height),
      rss_order: candidate.rss_order,
    });
  }
  return permitted;
}

function compareDimension(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left > right ? -1 : 1;
}

function compareGuardianPreviewQuality(left: GuardianPreviewCandidate,
  right: GuardianPreviewCandidate): number {
  const width = compareDimension(left.width, right.width);
  if (width !== 0) return width;
  const height = compareDimension(left.height, right.height);
  if (height !== 0) return height;
  return guardianCandidateKindPriority[right.kind] - guardianCandidateKindPriority[left.kind];
}

function compareGuardianPreviewCandidates(left: GuardianPreviewCandidate,
  right: GuardianPreviewCandidate): number {
  return compareGuardianPreviewQuality(left, right) || left.rss_order - right.rss_order;
}

export function selectGuardianPreviewCandidate(
  candidates: RssPreviewCandidate[],
): GuardianPreviewCandidate | null {
  return permittedGuardianPreviewCandidates(candidates)
    .sort(compareGuardianPreviewCandidates)[0] ?? null;
}

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

async function configuredGuardianFeed(source: Source, routeKey: string): Promise<{
  xml: string;
  max_items: number;
}> {
  const route = configuredRoute(source, routeKey);
  const expected = GUARDIAN_ROUTES.find(candidate => candidate.route_key === route.route_key);
  const fetchUrl = expected && 'fetch_url' in expected ? expected.fetch_url : route.url;
  if (!publisherHttpsUrl(fetchUrl, source.canonical_domain)) {
    throw new ScanError('guardian_fetch_url_mismatch');
  }
  return {
    xml: await readRssFeed(fetchUrl, 'guardian'),
    max_items: route.max_items,
  };
}

type MutableGuardianRssArticleEvidence = {
  route_keys: Set<GuardianRouteKey>;
  candidates: Map<string, {
    candidate: GuardianPreviewCandidate;
    route_keys: Set<GuardianRouteKey>;
  }>;
  route_proposals: Map<GuardianRouteKey, GuardianPreviewCandidate>;
};

const guardianRouteOrder = new Map(GUARDIAN_ROUTES.map((route, index) =>
  [route.route_key, index]));

function orderedRouteKeys(keys: Iterable<GuardianRouteKey>): GuardianRouteKey[] {
  return [...keys].sort((left, right) =>
    (guardianRouteOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (guardianRouteOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
}

export function guardianRssImageViewFromFeeds(source: Source,
  feeds: GuardianRouteFeed[]): GuardianRssImageView {
  const feedKeys = new Set(feeds.map(feed => feed.route_key));
  if (feedKeys.size !== feeds.length) throw new ScanError('duplicate_guardian_route_feed');
  const builders = new Map<string, MutableGuardianRssArticleEvidence>();
  let articleObservations = 0;
  const orderedFeeds = [...feeds].sort((left, right) =>
    (guardianRouteOrder.get(left.route_key) ?? Number.MAX_SAFE_INTEGER) -
    (guardianRouteOrder.get(right.route_key) ?? Number.MAX_SAFE_INTEGER));
  for (const feed of orderedFeeds) {
    const parsed = parseRssItems(feed.xml, feed.max_items, {
      allow_untyped_image_media_content: true,
    });
    articleObservations += parsed.items.length;
    for (const item of parsed.items) {
      const publisherUrl = publisherHttpsUrl(item.raw_url, source.canonical_domain);
      if (!publisherUrl) continue;
      let canonicalUrl: string;
      try { canonicalUrl = canonicalizeUrl(publisherUrl, source.canonical_domain); }
      catch { continue; }
      let builder = builders.get(canonicalUrl);
      if (!builder) {
        builder = { route_keys: new Set(), candidates: new Map(), route_proposals: new Map() };
        builders.set(canonicalUrl, builder);
      }
      builder.route_keys.add(feed.route_key);
      const permitted = permittedGuardianPreviewCandidates(item.preview_candidates);
      const routeProposal = selectGuardianPreviewCandidate(item.preview_candidates);
      if (routeProposal) {
        const previous = builder.route_proposals.get(feed.route_key);
        if (!previous || compareGuardianPreviewCandidates(routeProposal, previous) < 0) {
          builder.route_proposals.set(feed.route_key, routeProposal);
        }
      }
      for (const candidate of permitted) {
        const existing = builder.candidates.get(candidate.url);
        if (!existing) {
          builder.candidates.set(candidate.url, {
            candidate,
            route_keys: new Set([feed.route_key]),
          });
          continue;
        }
        existing.route_keys.add(feed.route_key);
        if (compareGuardianPreviewCandidates(candidate, existing.candidate) < 0) {
          existing.candidate = candidate;
        }
      }
    }
  }

  const articles = new Map<string, GuardianRssArticleImageEvidence>();
  for (const [canonicalUrl, builder] of [...builders.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const proposals = [...builder.route_proposals.values()].sort((left, right) =>
      compareGuardianPreviewQuality(left, right) || left.url.localeCompare(right.url));
    const leading = proposals[0] ?? null;
    const ambiguousProposal = leading !== null && proposals.some(candidate =>
      candidate.url !== leading.url && compareGuardianPreviewQuality(candidate, leading) === 0);
    const candidates = [...builder.candidates.values()].map(evidence => ({
      ...evidence.candidate,
      route_keys: orderedRouteKeys(evidence.route_keys),
    })).sort((left, right) =>
      compareGuardianPreviewQuality(left, right) || left.url.localeCompare(right.url));
    articles.set(canonicalUrl, {
      canonical_url: canonicalUrl,
      route_keys: orderedRouteKeys(builder.route_keys),
      candidates,
      proposed: ambiguousProposal ? null : leading,
      ambiguous_proposal: ambiguousProposal,
    });
  }
  return {
    routes_fetched: orderedFeeds.map(feed => feed.route_key),
    article_observations: articleObservations,
    articles,
  };
}

export async function discoverGuardianCurrentRssImageView(
  source: Source,
): Promise<GuardianRssImageView> {
  const routeKeys = configuredGuardianRouteKeys(source);
  if (routeKeys.length !== GUARDIAN_ROUTES.length) {
    throw new ScanError('guardian_route_config_mismatch');
  }
  const feeds = await Promise.all(routeKeys.map(async routeKey => {
    const feed = await configuredGuardianFeed(source, routeKey);
    return { route_key: routeKey, ...feed };
  }));
  return guardianRssImageViewFromFeeds(source, feeds);
}

export async function guardianPreviewForArticleFromFeed(xml: string, source: Source,
  maxItems: number, canonicalUrl: string, currentImageUrl: string | null): Promise<GuardianPreviewLookup> {
  const parsed = parseRssItems(xml, maxItems, {
    allow_untyped_image_media_content: true,
  });
  for (const item of parsed.items) {
    const publisherUrl = publisherHttpsUrl(item.raw_url, source.canonical_domain);
    if (!publisherUrl) continue;
    let canonical: string;
    try { canonical = canonicalizeUrl(publisherUrl, source.canonical_domain); }
    catch { continue; }
    if (canonical !== canonicalUrl) continue;
    const permitted = permittedGuardianPreviewCandidates(item.preview_candidates);
    const proposed = selectGuardianPreviewCandidate(item.preview_candidates);
    const current = currentImageUrl === null ? null :
      permitted.find(candidate => candidate.url === currentImageUrl) ?? null;
    return { article_found: true, proposed, current };
  }
  return { article_found: false, proposed: null, current: null };
}

export async function discoverGuardianPreviewForArticle(source: Source, routeKey: string,
  canonicalUrl: string, currentImageUrl: string | null): Promise<GuardianPreviewLookup> {
  const feed = await configuredGuardianFeed(source, routeKey);
  return guardianPreviewForArticleFromFeed(feed.xml, source, feed.max_items,
    canonicalUrl, currentImageUrl);
}

export async function discoverGuardian(source: Source, routeKey: string): Promise<{
  articles: DiscoveredArticle[];
  items_seen: number;
  items_invalid: number;
}> {
  const feed = await configuredGuardianFeed(source, routeKey);
  return parseGuardianFeed(feed.xml, source, feed.max_items);
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
    const preview = source.image_policy === 'remote_preview'
      ? selectGuardianPreviewCandidate(item.preview_candidates)?.url ?? null : null;
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
