/**
 * Manual/live integration check for PR #39 research-news feeds.
 * This uses the same RSS fetch, manual-redirect and parser boundaries as
 * the production discovery worker; it is deliberately not run on every
 * routine offline npm check, because publisher feeds are external services.
 *
 * Run: npm run research-news:live-check
 */
import { readFileSync } from 'node:fs';
import { SourceSchema } from '@uk-aq-media/core';
import {
  configuredPublisherRssRouteKeys, discoverPublisherRss, PUBLISHER_RSS_ROUTES,
} from '@uk-aq-media/discovery';

const enabledKeys = ['research-news-bioengineer', 'research-news-scienmag'] as const;
const saved: unknown = JSON.parse(readFileSync('config/sources.seed.json', 'utf8'));
if (!Array.isArray(saved)) throw new Error('source_seed_not_array');
const sources = enabledKeys.map(key => {
  const entry = saved.find((item: unknown) =>
    typeof item === 'object' && item !== null && 'source_key' in item &&
    item.source_key === key);
  if (!entry) throw new Error(`missing_research_news_source:${key}`);
  return SourceSchema.parse(entry);
});

let failures = 0;
let total = 0;
for (const source of sources) {
  const routes = configuredPublisherRssRouteKeys(source);
  if (routes.length !== 5) throw new Error(`research_news_routes_mismatch:${source.source_key}`);
  for (const routeKey of routes) {
    const route = PUBLISHER_RSS_ROUTES.find(entry =>
      entry.source_key === source.source_key && entry.route_key === routeKey);
    if (!route) throw new Error(`unknown_research_news_route:${routeKey}`);
    total++;
    try {
      // Note: externally executed Node fetch does not prove access from
      // Cloudflare Workers; a TEST Worker smoke run is still needed pre-deploy.
      const result = await discoverPublisherRss(source, routeKey);
      const isLatest = routeKey.endsWith('-latest');
      if (isLatest && result.items_seen === 0) {
        throw new Error('latest_feed_has_zero_items');
      }
      console.log(JSON.stringify({
        status: 'ok', source_key: source.source_key, route_key: routeKey,
        url: route.url, items_seen: result.items_seen,
        items_invalid: result.items_invalid,
        relevant_articles: result.articles.length,
        sample_title: result.articles[0]?.title ?? null,
      }));
    } catch (error) {
      failures++;
      console.error(JSON.stringify({
        status: 'failed', source_key: source.source_key,
        route_key: routeKey, url: route.url,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}
console.log(JSON.stringify({ status: failures ? 'failed' : 'ok', total, failures }));
if (failures) process.exitCode = 1;
