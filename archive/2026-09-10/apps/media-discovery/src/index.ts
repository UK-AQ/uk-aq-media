import { DiscoveryMessageSchema, recordQueueFailure, runSourceScan, type DiscoveryMessage } from '@uk-aq-media/discovery';
import { json, secretMatches } from '@uk-aq-media/core';

async function enqueueScheduledDiscovery(env: MediaDiscoveryEnv): Promise<0 | 1> {
  try {
    // An adapter allowlist prevents enabling an unfinished publisher through D1 alone.
    const source = await env.MEDIA_DB.prepare(`SELECT source_key FROM media_sources
      WHERE source_key = 'air-quality-news' AND enabled = 1`).first<{ source_key: string }>();
    if (!source) return 0;
    const message: DiscoveryMessage = { type: 'source_scan', source_key: source.source_key };
    await env.MEDIA_DISCOVERY_QUEUE.send(message);
    return 1;
  } catch {
    await recordQueueFailure(env.MEDIA_DB, 'discovery_schedule_failed');
    console.error(JSON.stringify({ event: 'discovery_schedule_failed' }));
    throw new Error('discovery_schedule_failed');
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/scheduler/run') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') {
      const response = json({ error: 'method_not_allowed' }, 405);
      response.headers.set('Allow', 'POST');
      return response;
    }
    const suppliedSecret = request.headers.get('x-uk-aq-worker-http-secret');
    if (!await secretMatches(suppliedSecret, env.UK_AQ_MEDIA_WORKER_HTTP_SECRET)) {
      return json({ error: 'unauthorized' }, 401);
    }
    try {
      const queued = await enqueueScheduledDiscovery(env);
      return json({ ok: true, queued }, 202);
    } catch {
      return json({ error: 'discovery_schedule_failed' }, 503);
    }
  },
  async scheduled(_controller, env): Promise<void> {
    await enqueueScheduledDiscovery(env);
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const parsed = DiscoveryMessageSchema.safeParse(message.body);
      if (!parsed.success || parsed.data.type === 'article_enrich') {
        // Not operational in this phase: never acknowledge unimplemented work as completed.
        await recordQueueFailure(env.MEDIA_DB, 'unsupported_discovery_message', message.id, message.attempts);
        console.error(JSON.stringify({ event: 'unsupported_discovery_message', message_id: message.id }));
        message.retry({ delaySeconds: 300 });
        continue;
      }
      try {
        await runSourceScan(env.MEDIA_DB, parsed.data.source_key, message.id, message.attempts);
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: 'discovery_message_failed', message_id: message.id }));
        message.retry({ delaySeconds: 300 });
      }
    }
  },
} satisfies ExportedHandler<MediaDiscoveryEnv, unknown>;
