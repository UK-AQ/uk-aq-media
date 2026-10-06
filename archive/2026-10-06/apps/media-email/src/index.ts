import { bearerMatches, HttpError, httpFailure, json, secretMatches } from '@uk-aq-media/core';
import { addJob, boundedBody, complete, hash, iso, now, queueJob, rpc,
  type Env, type Job, type Subscription, type Work } from './common';
import { confirmation, digest, immediate } from './delivery';
import { publicRoute } from './public';
import { cutoffAt } from './schedule';

async function scheduler(env:Env):Promise<Response> {
  const at=now(), slot=String(Math.floor(Date.now()/300000));
  await addJob(env,`daily-scan:${slot}`,'daily_scan',{after:'',at});
  await addJob(env,`confirmation-scan:${slot}`,'confirmation_scan',{after:''});
  // Stale SMTP claims are quarantined, never returned to the retry pool.
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state='unknown',last_error='stale_smtp_claim'
    WHERE state='sending' AND claimed_at<?`).bind(new Date(Date.now()-300000).toISOString()).run();
  const {results}=await env.MEDIA_DB.prepare(`SELECT id FROM media_news_email_outbox
    WHERE state='pending' OR (state='queued' AND queued_at<?) ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,coalesce(queued_at,created_at),id LIMIT 10`)
    .bind(new Date(Date.now()-600000).toISOString()).all<{id:string}>();
  for(const row of results) await queueJob(env,row.id);
  return json({ok:true,queued:results.length});
}
async function continuation(env:Env,job:Job,work:Work,after:string):Promise<void> {
  // Persist the page checkpoint only after each child's durable job has been written.
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET payload=?,state='pending' WHERE id=?`)
    .bind(JSON.stringify({...work,after}),job.id).run();
  await queueJob(env,job.id);
}
async function processJob(env:Env,job:Job):Promise<void> {
  if(job.state==='completed') return;
  const w=JSON.parse(job.payload) as Work;
  if(job.work_type==='confirmation_email') await confirmation(env,job.id,w);
  else if(job.work_type==='immediate_delivery') await immediate(env,job.id,w);
  else if(job.work_type==='daily_digest') await digest(env,job.id,w);
  else if(job.work_type==='confirmation_scan') {
    const rows=await rpc<Array<{id:string;subscription_id:string}>>(env,'confirmations',{after:w.after});
    for(const row of rows) {
      const id=`confirmation:${row.id}`;
      await addJob(env,id,'confirmation_email',{generation:row.id,subscription_id:row.subscription_id});
      await queueJob(env,id);
    }
    if(rows.length===5) { await continuation(env,job,w,rows[4]!.id); return; }
  } else if(job.work_type==='approval_dispatch'||job.work_type==='daily_scan') {
    const mode=job.work_type==='approval_dispatch'?'immediate':'daily';
    const rows=await rpc<Subscription[]>(env,'list',{delivery_mode:mode,after:w.after});
    for(const sub of rows) {
      if(mode==='immediate') {
        const id=`immediate:${w.event_id}:${sub.id}`;
        await addJob(env,id,'immediate_delivery',{subscription_id:sub.id,event_id:w.event_id},w.event_id);
        await queueJob(env,id);
      } else {
        const cutoff=cutoffAt(w.at!,sub.daily_time_local);
        if(Date.parse(cutoff)<=Date.parse(sub.digest_cursor_at)) continue;
        // One unfinished run per subscription: repair accepted cursors before creating another cutoff.
        const open=await env.MEDIA_DB.prepare(`SELECT id FROM media_news_email_outbox
          WHERE work_type='daily_digest' AND json_extract(payload,'$.subscription_id')=?
          AND state!='completed' ORDER BY created_at LIMIT 1`).bind(sub.id).first<{id:string}>();
        if(open) { await queueJob(env,open.id); continue; }
        // Unknown/permanent outcomes freeze this mode's window pending explicit reconciliation.
        const blocked=await env.MEDIA_DB.prepare(`SELECT r.id FROM media_news_digest_runs r
          JOIN media_news_email_deliveries d ON d.id=r.id WHERE r.subscription_id=?
          AND r.window_start_utc=? AND d.state IN ('unknown','sending','permanent_failure') LIMIT 1`)
          .bind(sub.id,iso(sub.digest_cursor_at)).first();
        if(blocked) continue;
        const id=`daily:${sub.id}:${cutoff}`;
        await addJob(env,id,'daily_digest',{subscription_id:sub.id,cutoff,start:iso(sub.digest_cursor_at),
          mode_since_at:iso(sub.mode_since_at)});
        await queueJob(env,id);
      }
    }
    if(rows.length===5) { await continuation(env,job,w,rows[4]!.id); return; }
  } else throw new Error('invalid_work_type');
  await complete(env,job.id);
}
async function fetchRoute(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url);
  if(url.pathname==='/scheduler/run') {
    if(!await secretMatches(request.headers.get('x-uk-aq-worker-http-secret'),env.UK_AQ_MEDIA_EMAIL_WORKER_HTTP_SECRET))
      throw new HttpError(401,'unauthorized');
    if(request.method!=='POST') throw new HttpError(405,'method_not_allowed');
    if(env.NEWS_EMAIL_ENABLED!=='true') return json({ok:true,enabled:false});
    return scheduler(env);
  }
  if(url.pathname.startsWith('/operations/')) {
    if(!await bearerMatches(request,env.NEWS_EMAIL_OPERATOR_SECRET)) throw new HttpError(401,'unauthorized');
    if(request.method!=='POST') throw new HttpError(405,'method_not_allowed');
    const data=JSON.parse(await boundedBody(request)) as Record<string,string>;
    if(url.pathname==='/operations/activate') {
      await env.MEDIA_DB.prepare(`UPDATE media_news_email_settings SET activated_at=?
        WHERE singleton=1 AND activated_at IS NULL`).bind(now()).run();
      return json(await env.MEDIA_DB.prepare('SELECT activated_at FROM media_news_email_settings WHERE singleton=1').first());
    }
    if(url.pathname==='/operations/reconcile') {
      if(!data.delivery_id || data.delivery_id.length>200) throw new HttpError(400,'invalid_request');
      const d=await env.MEDIA_DB.prepare(`SELECT id,message_id FROM media_news_email_deliveries
        WHERE id=? AND state='unknown'`).bind(data.delivery_id).first<{id:string;message_id:string}>();
      if(!d) throw new HttpError(409,'unknown_delivery_required');
      const endpoint=new URL('/receipt',env.NEWS_EMAIL_SENDER_URL);
      if(endpoint.protocol!=='https:') throw new Error('sender_https_required');
      const receipt=await fetch(endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${env.NEWS_EMAIL_SENDER_SECRET}`,'Content-Type':'application/json'},
        body:JSON.stringify({message_id:d.message_id})});
      if(!receipt.ok) throw new Error('receipt_unavailable');
      const outcome=(await receipt.json() as {outcome:string}).outcome;
      if(!['accepted','temporary_failure','permanent_failure'].includes(outcome)) return json({ok:false,outcome:'unknown'},409);
      await env.MEDIA_DB.batch([
        env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state=?,last_error='operator_reconciled',
          sent_at=CASE WHEN ?='accepted' THEN coalesce(sent_at,claimed_at) ELSE sent_at END WHERE id=? AND state='unknown'`)
          .bind(outcome,outcome,d.id),
        env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='pending',queued_at=NULL WHERE id=?`).bind(d.id),
      ]);
      await queueJob(env,d.id);
      return json({ok:true,outcome});
    }
    if(url.pathname!=='/operations/suppress') throw new HttpError(404,'not_found');
    if(!/^[a-f0-9-]{36}$/.test(data.subscription_id??'')||typeof data.reason!=='string'||!data.reason.trim())
      throw new HttpError(400,'invalid_request');
    await rpc(env,'suppress',data); return json({ok:true});
  }
  // RFC 8058 endpoint: opaque token in path; no request URL/access logging is enabled.
  const oneClick=/^\/one-click\/([a-f0-9]{64})$/.exec(url.pathname);
  if(oneClick) {
    if(request.method!=='POST') throw new HttpError(405,'method_not_allowed');
    if(new URLSearchParams(await boundedBody(request)).get('List-Unsubscribe')!=='One-Click')
      throw new HttpError(400,'invalid_request');
    await rpc(env,'unsubscribe',{token_hash:await hash(oneClick[1]!)});
    return json({ok:true}); // Idempotent and neutral for revoked/expired credentials.
  }
  const origin=request.headers.get('Origin');
  if(origin!==env.NEWS_EMAIL_SITE_ORIGIN) throw new HttpError(403,'origin_not_allowed');
  if(request.method==='OPTIONS') return new Response(null,{status:204});
  if(env.NEWS_EMAIL_ENABLED!=='true' && url.pathname==='/subscribe') throw new HttpError(503,'temporarily_unavailable');
  return publicRoute(request,env,url.pathname);
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    let response:Response;
    try { response=await fetchRoute(request,env); } catch(error) { response=httpFailure(error); }
    const headers=new Headers(response.headers);
    headers.set('Referrer-Policy','no-referrer'); headers.set('Cache-Control','no-store');
    if(request.headers.get('Origin')===env.NEWS_EMAIL_SITE_ORIGIN) {
      headers.set('Access-Control-Allow-Origin',env.NEWS_EMAIL_SITE_ORIGIN);
      headers.set('Vary','Origin');headers.set('Access-Control-Allow-Methods','POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers','Content-Type');
    }
    return new Response(response.body,{status:response.status,headers});
  },
  async queue(batch:MessageBatch<{id:string}>,env:Env):Promise<void> {
    for(const message of batch.messages) {
      if(env.NEWS_EMAIL_ENABLED!=='true') { message.retry({delaySeconds:300}); continue; }
      try {
        if(typeof message.body?.id!=='string'||message.body.id.length>200) { message.ack(); continue; }
        const job=await env.MEDIA_DB.prepare('SELECT * FROM media_news_email_outbox WHERE id=?')
          .bind(message.body.id).first<Job>();
        if(job) await processJob(env,job);
        message.ack();
      } catch(error) {
        // Only known fixed codes; never persist raw external errors or request payloads.
        const allowed=['temporary_failure','digest_size_requires_operator','subscription_service_unavailable'];
        const code=error instanceof Error && allowed.includes(error.message)?error.message:'work_retry_required';
        try {
          await env.MEDIA_DB.prepare('UPDATE media_news_email_outbox SET last_error=? WHERE id=?')
            .bind(code,message.body.id).run();
        } catch { /* The durable outbox remains the recovery source if D1 is unavailable. */ }
        message.retry({delaySeconds:300});
      }
    }
  },
} satisfies ExportedHandler<Env,{id:string}>;
