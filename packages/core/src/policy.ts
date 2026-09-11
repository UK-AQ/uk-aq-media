import { z } from 'zod';

export const ArticleStatus = z.enum(['pending', 'approved', 'rejected', 'hidden']);
export const ReviewLevel = z.enum(['standard', 'enhanced']);
export const PublicationPolicy = z.enum(['manual', 'auto_approve']);
export const ContentFetchPolicy = z.enum([
  'discovery_metadata_only', 'article_head_allowed', 'article_body_allowed',
]);
export const AiContentPolicy = z.enum(['disabled', 'metadata_only', 'article_body_allowed']);
export const ImagePolicy = z.enum(['remote_preview', 'blocked', 'local_copy_permitted']);

export const DiscoveryRouteSchema = z.object({
  route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  url: z.url(),
  max_items: z.number().int().min(1).max(20),
}).strict();

const DiscoveryConfigSchema = z.object({
  url: z.url().optional(),
  max_items: z.number().int().min(1).max(20).optional(),
  routes: z.array(DiscoveryRouteSchema).min(1).max(16).optional(),
  retain_excerpt: z.literal(false),
}).strict().superRefine((config, context) => {
  if (config.url && config.routes) {
    context.addIssue({ code: 'custom', message: 'discovery_config_url_and_routes_conflict' });
  }
  if (config.routes && new Set(config.routes.map(route => route.route_key)).size !== config.routes.length) {
    context.addIssue({ code: 'custom', message: 'duplicate_discovery_route_key' });
  }
});

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
  discovery_config: DiscoveryConfigSchema,
  content_fetch_policy: ContentFetchPolicy,
  ai_content_policy: AiContentPolicy,
  image_policy: ImagePolicy,
}).strict().superRefine((source, context) => {
  const hasRssConfig = Boolean(source.discovery_config.url || source.discovery_config.routes);
  if (source.discovery_method === 'rss' && !hasRssConfig) {
    context.addIssue({ code: 'custom', path: ['discovery_config'], message: 'rss_config_required' });
  }
  if (source.discovery_method === 'deferred' && hasRssConfig) {
    context.addIssue({ code: 'custom', path: ['discovery_config'], message: 'deferred_config_must_be_empty' });
  }
});
export type Source = z.infer<typeof SourceSchema>;
export type Status = z.infer<typeof ArticleStatus>;

export const AuthorRuleSchema = z.object({
  author_key: z.string().regex(/^[a-z0-9]+:[a-z0-9]+(?:-[a-z0-9]+)*$/),
  source_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  display_name: z.string().min(1).max(200),
  profile_url: z.url(),
  profile_rss_url: z.url().nullable(),
  profile_rss_route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable(),
  inclusion_policy: z.enum(['normal', 'always_include']),
  publication_policy: z.enum(['inherit_source', 'pending', 'auto_approve']),
  enabled: z.boolean(),
  byline_aliases: z.array(z.string().min(1).max(200)).min(1).max(10),
}).strict();
export type AuthorRule = z.infer<typeof AuthorRuleSchema>;

export interface RelevanceInput {
  title: string;
  canonical_url: string;
  categories: string[];
}
export interface DeterministicRelevanceFilter {
  evaluate(input: RelevanceInput): { relevant: boolean; reason: string };
}

export function initialEditorialState(source: Source, authorRule: AuthorRule | null = null): {
  status: Status;
  approval_method: 'trusted_source_auto' | 'trusted_author_auto' | null;
  approval_author_rule_key: string | null;
} {
  if (authorRule?.enabled && authorRule.publication_policy === 'auto_approve') {
    return { status: 'approved', approval_method: 'trusted_author_auto',
      approval_author_rule_key: authorRule.author_key };
  }
  if (authorRule?.enabled && authorRule.publication_policy === 'pending') {
    return { status: 'pending', approval_method: null, approval_author_rule_key: null };
  }
  if (source.publication_policy === 'auto_approve') {
    return { status: 'approved', approval_method: 'trusted_source_auto',
      approval_author_rule_key: null };
  }
  return { status: 'pending', approval_method: null, approval_author_rule_key: null };
}

export function permitsAi(source: Source, kind: 'metadata' | 'article_body'): boolean {
  if (source.ai_content_policy === 'disabled') return false;
  return kind === 'metadata' || (
    source.ai_content_policy === 'article_body_allowed' &&
    source.content_fetch_policy === 'article_body_allowed'
  );
}
