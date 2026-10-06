// Best-effort wake-up only. The single D1 trigger owns eligibility and durable state.
// Approval never awaits subscriber enumeration or outbound delivery. Scheduler recovery
// handles Queue outages, failed acknowledgements and larger approval batches.
export async function wakeNewsEmailOutbox(env: {
  MEDIA_DB: D1Database; MEDIA_EMAIL_QUEUE?: Queue<{id:string}>;
}):Promise<void> {
  if(!env.MEDIA_EMAIL_QUEUE) return;
  try {
    const {results}=await env.MEDIA_DB.prepare(`SELECT id FROM media_news_email_outbox
      WHERE work_type='approval_dispatch' AND state='pending' ORDER BY created_at,id LIMIT 5`)
      .all<{id:string}>();
    for(const row of results) {
      await env.MEDIA_EMAIL_QUEUE.send({id:row.id});
      await env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='queued',queued_at=?,
        attempt_count=attempt_count+1 WHERE id=? AND state='pending'`)
        .bind(new Date().toISOString(),row.id).run();
    }
  } catch {
    console.error(JSON.stringify({event:'news_email_wakeup_failed'}));
  }
}
