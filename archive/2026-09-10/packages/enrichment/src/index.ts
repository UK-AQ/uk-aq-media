import { permitsAi, z, type Source } from '@uk-aq-media/core';

export const EnrichmentResultSchema = z.object({
  relevant: z.boolean(),
  uk_relevance: z.enum(['uk', 'international', 'uncertain']),
  topics: z.array(z.string().max(100)).max(20),
  pollutants: z.array(z.string().max(100)).max(20),
  locations: z.array(z.string().max(200)).max(20),
  summary: z.string().max(2000).optional(),
  why_it_matters: z.string().max(2000).optional(),
  key_claims: z.array(z.string().max(500)).max(10),
}).strict();
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

export type EnrichmentInput = {
  kind: 'metadata'; title: string; canonical_url: string; categories: string[];
} | {
  kind: 'article_body'; title: string; canonical_url: string; categories: string[]; body: string;
};
export interface EnrichmentProvider {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  enrich(input: EnrichmentInput): Promise<unknown>;
}
export interface AiBudgetGuard {
  /** Must reserve before inference; deny on capacity/storage failure. No paid fallback. */
  reserve(): Promise<boolean>;
}

/** Per-run supplement only, never presented as a cross-isolate/daily quota. Default denies all.
 * A durable daily guard must be added before enabling live AI in a future phase. */
export class LocalCallBudget implements AiBudgetGuard {
  private calls = 0;
  constructor(private readonly maximumCalls = 0) {}
  async reserve(): Promise<boolean> {
    if (!Number.isSafeInteger(this.maximumCalls) || this.maximumCalls < 1 ||
        this.calls >= this.maximumCalls) return false;
    this.calls++;
    return true;
  }
}

export type EnrichmentOutcome = {
  status: 'enriched'; result: EnrichmentResult;
  provenance: { provider: string; model: string; version: string; enriched_at: string };
} | { status: 'skipped' | 'failed'; reason: string };

export async function enrichPermitted(source: Source, input: EnrichmentInput,
  provider: EnrichmentProvider, budget: AiBudgetGuard): Promise<EnrichmentOutcome> {
  // AQN never reaches a provider in this phase, even if a future policy is prematurely changed.
  if (source.source_key === 'air-quality-news' || !permitsAi(source, input.kind)) {
    return { status: 'skipped', reason: 'source_policy' };
  }
  try {
    if (!await budget.reserve()) return { status: 'skipped', reason: 'local_budget' };
    // Reconstruct metadata input explicitly: a caller cannot smuggle a body in extra properties.
    const metadata = { title: input.title.slice(0, 1000), canonical_url: input.canonical_url.slice(0, 2048),
      categories: input.categories.slice(0, 20).map(c => c.slice(0, 100)) };
    const permitted: EnrichmentInput = input.kind === 'metadata' ? { kind: 'metadata', ...metadata } :
      { kind: 'article_body', ...metadata, body: input.body.slice(0, 20_000) };
    const result = EnrichmentResultSchema.parse(await provider.enrich(permitted));
    return { status: 'enriched', result, provenance: { provider: provider.provider,
      model: provider.model, version: provider.version, enriched_at: new Date().toISOString() } };
  } catch {
    // Caller retains existing D1 candidate; this package owns no editorial state.
    return { status: 'failed', reason: 'provider_budget_or_output_failure' };
  }
}

/** Binding/model seam only. Deliberately contains no AI.run() call or paid fallback. */
export class WorkersAiSkeleton implements EnrichmentProvider {
  readonly provider = 'cloudflare-workers-ai';
  readonly version = 'media-enrichment-v1';
  constructor(_binding: Ai, readonly model: string) {}
  async enrich(_input: EnrichmentInput): Promise<unknown> {
    throw new Error('workers_ai_not_enabled_in_phase_1');
  }
}
