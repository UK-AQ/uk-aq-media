import { z } from 'zod';

export const ArticleStatus = z.enum(['pending', 'approved', 'rejected', 'hidden']);
export const ReviewLevel = z.enum(['standard', 'enhanced']);
export const PublicationPolicy = z.enum(['manual', 'auto_approve']);
export const ContentFetchPolicy = z.enum([
  'discovery_metadata_only', 'article_head_allowed', 'article_body_allowed',
]);
export const AiContentPolicy = z.enum(['disabled', 'metadata_only', 'article_body_allowed']);
export const ImagePolicy = z.enum(['remote_preview', 'blocked', 'local_copy_permitted']);

export const SourceSchema = z.object({
  source_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  canonical_domain: z.string().regex(/^[a-z0-9.-]+$/),
  source_type: z.enum(['publisher', 'government']),
  enabled: z.boolean(),
  publication_policy: PublicationPolicy,
  review_level: ReviewLevel,
  priority: z.number().int().min(0).max(100),
  discovery_method: z.enum(['rss', 'sitemap', 'deferred']),
  discovery_config: z.object({
    url: z.url().optional(),
    max_items: z.number().int().min(1).max(20).optional(),
    retain_excerpt: z.literal(false),
  }).strict(),
  content_fetch_policy: ContentFetchPolicy,
  ai_content_policy: AiContentPolicy,
  image_policy: ImagePolicy,
}).strict();
export type Source = z.infer<typeof SourceSchema>;
export type Status = z.infer<typeof ArticleStatus>;

export interface RelevanceInput {
  title: string;
  canonical_url: string;
  categories: string[];
}
export interface DeterministicRelevanceFilter {
  evaluate(input: RelevanceInput): { relevant: boolean; reason: string };
}

export function initialEditorialState(source: Source): {
  status: Status; approval_method: 'trusted_source_auto' | null;
} {
  // Only AQN has an operational trusted-source exception in this slice.
  if (source.source_key === 'air-quality-news' && source.publication_policy === 'auto_approve') {
    return { status: 'approved', approval_method: 'trusted_source_auto' };
  }
  return { status: 'pending', approval_method: null };
}

export function permitsAi(source: Source, kind: 'metadata' | 'article_body'): boolean {
  if (source.ai_content_policy === 'disabled') return false;
  return kind === 'metadata' || (
    source.ai_content_policy === 'article_body_allowed' &&
    source.content_fetch_policy === 'article_body_allowed'
  );
}
