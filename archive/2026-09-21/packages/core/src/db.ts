import { AuthorRuleSchema, SourceSchema, type AuthorRule, type Source, type Status } from './policy';

export interface ArticleIdentity {
  id: number;
  status: Status;
  canonical_url: string;
}
export interface DiscoveredArticle {
  canonical_url: string;
  canonical_url_hash: string;
  original_url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  categories: string[];
  title_context: string | null;
  preview_url: string | null;
  display_title: string | null;
  display_title_origin: 'publisher' | null;
  preview_metadata_checked_at: string | null;
}

export interface DiscoveryRoute {
  route_key: string;
  url: string;
  max_items: number;
}
export interface PublicArticle {
  id: number;
  source_key: string;
  canonical_url: string;
  title: string;
  display_title: string | null;
  display_title_origin: 'publisher' | 'human' | 'ai' | null;
  publisher: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  summary: string | null;
  why_it_matters: string | null;
  featured: number;
  og_image_url: string | null;
  preview_image_url: string | null;
  editorial_content_origin: string | null;
}

export async function loadSource(db: D1Database, key: string): Promise<Source | null> {
  const row = await db.prepare(`SELECT source_key, name, canonical_domain, source_type,
    enabled, publication_policy, review_level, priority, discovery_method,
    discovery_config_json, content_fetch_policy, ai_content_policy, image_policy
    FROM media_sources WHERE source_key = ? AND retired_at IS NULL`).bind(key).first<{
      discovery_config_json: string; enabled: number; [key: string]: unknown;
    }>();
  if (!row) return null;
  const { discovery_config_json, enabled, ...fields } = row;
  return SourceSchema.parse({ ...fields, enabled: enabled === 1,
    discovery_config: JSON.parse(discovery_config_json) });
}

export async function loadAuthorRules(db: D1Database, sourceKey: string): Promise<AuthorRule[]> {
  const { results } = await db.prepare(`SELECT author_key, source_key, display_name, profile_url,
    profile_rss_url, profile_rss_route_key, inclusion_policy, publication_policy, enabled,
    byline_aliases_json FROM media_author_rules WHERE source_key = ? AND enabled = 1
    ORDER BY author_key`).bind(sourceKey).all<{
      enabled: number;
      byline_aliases_json: string;
      [key: string]: unknown;
    }>();
  return results.map(({ enabled, byline_aliases_json, ...fields }) => AuthorRuleSchema.parse({
    ...fields,
    enabled: enabled === 1,
    byline_aliases: JSON.parse(byline_aliases_json),
  }));
}
