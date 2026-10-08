import {
  canonicalizeUrl, canonicalUrlHash, remotePreviewUrl, type DiscoveredArticle, type Source,
} from '@uk-aq-media/core';
import { parseRssItems, readRssFeed, ScanError } from './rss';

export { ScanError } from './rss';

export const AQN_FEED = 'https://airqualitynews.com/feed/';

export async function discoverAqn(source: Source): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  if (source.source_key !== 'air-quality-news' || source.discovery_method !== 'rss' ||
      source.discovery_config.url !== AQN_FEED || source.canonical_domain !== 'airqualitynews.com') {
    throw new ScanError('aqn_config_mismatch');
  }
  // This adapter entry point fetches only the configured feed. The source-scan
  // persistence layer separately requests missing, policy-permitted head metadata.
  return parseAqnFeed(await readRssFeed(AQN_FEED, 'aqn'), source);
}

export async function parseAqnFeed(xml: string, source: Source): Promise<{
  articles: DiscoveredArticle[]; items_seen: number; items_invalid: number;
}> {
  const parsed = parseRssItems(xml, source.discovery_config.max_items ?? 20,
    { title_context: 'aqn_leading_600' });
  const articles: DiscoveredArticle[] = [];
  let invalid = parsed.items_invalid;
  for (const item of parsed.items) {
    let canonical: string;
    try { canonical = canonicalizeUrl(item.raw_url, source.canonical_domain); }
    catch { invalid++; continue; }
    const preview = source.image_policy === 'remote_preview' ? item.preview_candidates
      .map(candidate => remotePreviewUrl(candidate.url, source.canonical_domain))
      .find(Boolean) ?? null : null;
    articles.push({ canonical_url: canonical, canonical_url_hash: await canonicalUrlHash(canonical),
      original_url: item.raw_url, title: item.title, author: item.author,
      published_at: item.published_at, categories: item.categories,
      title_context: item.title_context,
      preview_url: preview, display_title: null, display_title_origin: null,
      preview_metadata_checked_at: null });
  }
  return { articles, items_seen: parsed.items_seen, items_invalid: invalid };
}
