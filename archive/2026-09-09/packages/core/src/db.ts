import { SourceSchema, type Source, type Status } from './policy';

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
  preview_url: string | null;
}
export interface PublicArticle {
  id: number;
  source_key: string;
  canonical_url: string;
  title: string;
  publisher: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  summary: string | null;
  why_it_matters: string | null;
  featured: number;
  og_image_url: string | null;
  editorial_content_origin: string | null;
}

export async function loadSource(db: D1Database, key: string): Promise<Source | null> {
  const row = await db.prepare(`SELECT source_key, name, canonical_domain, source_type,
    enabled, publication_policy, review_level, priority, discovery_method,
    discovery_config_json, content_fetch_policy, ai_content_policy, image_policy
    FROM media_sources WHERE source_key = ?`).bind(key).first<{
      discovery_config_json: string; enabled: number; [key: string]: unknown;
    }>();
  if (!row) return null;
  const { discovery_config_json, enabled, ...fields } = row;
  return SourceSchema.parse({ ...fields, enabled: enabled === 1,
    discovery_config: JSON.parse(discovery_config_json) });
}
