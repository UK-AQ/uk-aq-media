import { DiscoveryMessageSchema, recordQueueFailure, runSourceScan, type DiscoveryMessage } from '@uk-aq-media/discovery';

export default {
  async scheduled(_controller, env): Promise<void> {
    try {
      // An adapter allowlist prevents enabling an unfinished publisher through D1 alone.
      const source = await env.MEDIA_DB.prepare(`SELECT source_key FROM media_sources
        WHERE source_key = 'air-quality-news' AND enabled = 1`).first<{ source_key: string }>();
      if (source) {
        const message: DiscoveryMessage = { type: 'source_scan', source_key: source.source_key };
        await env.MEDIA_DISCOVERY_QUEUE.send(message);
      }
    } catch {
      await recordQueueFailure(env.MEDIA_DB, 'discovery_schedule_failed');
      console.error(JSON.stringify({ event: 'discovery_schedule_failed' }));
      throw new Error('discovery_schedule_failed');
    }
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
