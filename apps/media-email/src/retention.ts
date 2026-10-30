import { bearerMatches, HttpError, json } from '@uk-aq-media/core';
import { boundedBody, now, type Env } from './common';

const DAY=86400000, LIMIT=5;
const phases=['history','pending','tokens','tombstones','inactive'] as const;
type Phase=typeof phases[number];
interface Cursor { after_at?:string; after_id?:string; more?:boolean }
interface Candidate { record_id:string; subscription_id:string; activity_at:string }
interface Status { phase:Phase; cursors:string }
interface History { id:string; subscription_id:string|null; retention_finished_at:string; digest_run_id:string|null }
interface Counts { eligible:number; deleted:number; held:number; initialised:number; minimised:number }
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

async function retentionRpc<T>(env:Env,action:string,data:Record<string,unknown>={}):Promise<T> {
  const base=new URL(env.SUPABASE_URL);
  if(base.protocol!=='https:'||base.username||base.password||base.port||base.pathname!=='/'||base.search||base.hash||!env.SB_SECRET_KEY)
    throw new Error('retention_source_configuration');
  const response=await fetch(new URL('/rest/v1/rpc/uk_aq_news_email_retention',base),{
    method:'POST',headers:{apikey:env.SB_SECRET_KEY,'Content-Type':'application/json','Content-Profile':'uk_aq_public'},
    body:JSON.stringify({p_action:action,p_data:data}),redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(15000),
  });
  if(!response.ok) { await response.body?.cancel(); throw new Error('retention_source_unavailable'); }
  return JSON.parse(await boundedBody(response,8192)) as T;
}

export async function queueRetention(env:Env):Promise<void> {
  const at=now();
  // Queue failures are retried by the existing five-minute scheduler. No separate cron/credential.
  const claim=await env.MEDIA_DB.prepare(`UPDATE media_news_retention_status SET requested_at=?
    WHERE singleton=1 AND (requested_at IS NULL OR requested_at<?)
    AND (lease_until IS NULL OR lease_until<?)`)
    .bind(at,new Date(Date.now()-240000).toISOString(),at).run();
  if(claim.meta.changes) await env.MEDIA_EMAIL_QUEUE.send({id:'news-retention'});
}

async function liveLease(env:Env,lease:string):Promise<void> {
  if(!await env.MEDIA_DB.prepare(`SELECT singleton FROM media_news_retention_status
    WHERE singleton=1 AND lease_id=? AND lease_until>?`).bind(lease,now()).first()) throw new Error('retention_lease_expired');
}

async function hold(env:Env,kind:Phase,id:string,sub:string|null,reason:string,counts:Counts):Promise<void> {
  const at=now();
  await env.MEDIA_DB.prepare(`INSERT INTO media_news_retention_holds
    (kind,record_id,subscription_id,reason,first_seen_at,checked_at,review_after) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(kind,record_id) DO UPDATE SET reason=excluded.reason,checked_at=excluded.checked_at,
      review_after=excluded.review_after`)
    .bind(kind,id,sub,reason,at,at,new Date(Date.now()+DAY).toISOString()).run();
  counts.held++;
}

async function clearHold(env:Env,kind:Phase,id:string):Promise<void> {
  await env.MEDIA_DB.prepare('DELETE FROM media_news_retention_holds WHERE kind=? AND record_id=?').bind(kind,id).run();
}

async function fence(env:Env,sub:string,lease:string):Promise<void> {
  await liveLease(env,lease);
  await env.MEDIA_DB.prepare(`INSERT INTO media_news_retention_fences(subscription_id,lease_id,expires_at)
    SELECT ?,lease_id,lease_until FROM media_news_retention_status WHERE singleton=1 AND lease_id=? AND lease_until>?
    ON CONFLICT(subscription_id) DO UPDATE SET lease_id=excluded.lease_id,expires_at=excluded.expires_at`)
    .bind(sub,lease,now()).run();
}

async function unfence(env:Env,sub:string,lease:string):Promise<void> {
  await env.MEDIA_DB.prepare('DELETE FROM media_news_retention_fences WHERE subscription_id=? AND lease_id=?').bind(sub,lease).run();
}

async function dependency(env:Env,kind:Phase,id:string,sub:string):Promise<boolean> {
  // Tombstone extension requires a specific unresolved confirmation, not ordinary old history.
  const onlyConfirmation=kind==='tombstones'||kind==='tokens'||kind==='pending';
  const deliveryId=kind==='tokens'?`confirmation:${id}`:null;
  const result=await env.MEDIA_DB.prepare(`SELECT EXISTS(
      SELECT 1 FROM media_news_email_deliveries d
      LEFT JOIN media_news_email_outbox o ON o.id=d.id
      LEFT JOIN media_news_digest_runs r ON r.id=d.digest_run_id
      WHERE d.subscription_id=? AND (?=0 OR d.delivery_mode='confirmation') AND (? IS NULL OR d.id=?)
      AND (d.state NOT IN ('accepted','permanent_failure','cancelled') OR d.retry_hold=1
        OR (o.id IS NOT NULL AND o.state<>'completed')
        OR (d.state='accepted' AND d.delivery_mode='daily' AND coalesce(r.state,'')<>'completed'))
    ) OR EXISTS(
      SELECT 1 FROM media_news_email_outbox o WHERE json_extract(o.payload,'$.subscription_id')=?
        AND o.state<>'completed' AND (?=0 OR o.work_type='confirmation_email') AND (? IS NULL OR o.id=?)
    ) AS held`).bind(sub,onlyConfirmation?1:0,deliveryId,deliveryId,sub,onlyConfirmation?1:0,deliveryId,deliveryId)
    .first<{held:number}>();
  if(!result) throw new Error('retention_dependency_unavailable');
  return result.held===1;
}

async function sourcePhase(env:Env,phase:Exclude<Phase,'history'>,cursor:Cursor,lease:string,counts:Counts):Promise<Cursor> {
  const result=await retentionRpc<{items:Candidate[]}>(env,'list',{kind:phase,after_at:cursor.after_at,after_id:cursor.after_id});
  if(!Array.isArray(result.items)||result.items.length>LIMIT) throw new Error('retention_source_invalid');
  for(const row of result.items) {
    if(!uuid.test(row.record_id)||!uuid.test(row.subscription_id)||!Number.isFinite(Date.parse(row.activity_at)))
      throw new Error('retention_source_invalid');
    counts.eligible++;
    await fence(env,row.subscription_id,lease);
    try {
      if(phase!=='inactive'&&await dependency(env,phase,row.record_id,row.subscription_id)) {
        await hold(env,phase,row.record_id,row.subscription_id,'unresolved_confirmation_or_delivery',counts); continue;
      }
      await liveLease(env,lease);
      const applied=await retentionRpc<{deleted:boolean;held?:boolean;reason?:string;minimised?:boolean}>(env,'purge',{
        kind:phase,record_id:row.record_id,activity_at:row.activity_at,dependencies_clear:true,
      });
      if(typeof applied.deleted!=='boolean') throw new Error('retention_source_invalid');
      if(applied.held) await hold(env,phase,row.record_id,row.subscription_id,'source_confirmation_unresolved',counts);
      else { if(applied.deleted) counts.deleted++; if(applied.minimised) counts.minimised++; await clearHold(env,phase,row.record_id); }
    } finally { await unfence(env,row.subscription_id,lease); }
  }
  const last=result.items.at(-1);
  return result.items.length===LIMIT&&last?{after_at:last.activity_at,after_id:last.record_id,more:true}:{};
}

async function historyPhase(env:Env,cursor:Cursor,openCursor:Cursor,deliveryCursor:Cursor,lease:string,counts:Counts):Promise<{closed:Cursor;open:Cursor;deliveries:Cursor}> {
  const at=now(),cutoff=new Date(Date.now()-30*DAY).toISOString();
  // Legacy rows have no authoritative completion time. Observe them once; never infer an early expiry.
  const seeded=await env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET retention_finished_at=? WHERE id IN
    (SELECT id FROM media_news_email_outbox WHERE state='completed' AND retention_finished_at IS NULL ORDER BY id LIMIT 100)`)
    .bind(at).run();
  counts.initialised+=Number(seeded.meta.changes);
  const deliveries=await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET retention_finished_at=? WHERE id IN
    (SELECT id FROM media_news_email_deliveries WHERE retention_finished_at IS NULL
      AND state IN ('accepted','permanent_failure','cancelled') AND retry_hold=0 ORDER BY id LIMIT 100)`)
    .bind(at).run();
  counts.initialised+=Number(deliveries.meta.changes);
  const open=await env.MEDIA_DB.prepare(`SELECT id,json_extract(payload,'$.subscription_id') AS subscription_id,created_at
    FROM media_news_email_outbox WHERE state<>'completed' AND created_at<=?
      AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 2`)
    .bind(cutoff,openCursor.after_at??'',openCursor.after_id??'').all<{id:string;subscription_id:string|null;created_at:string}>();
  for(const row of open.results) await hold(env,'history',row.id,row.subscription_id,'overdue_unresolved_work',counts);
  const unresolved=await env.MEDIA_DB.prepare(`SELECT id,subscription_id,created_at FROM media_news_email_deliveries
    WHERE (state IN ('pending','sending','temporary_failure','unknown') OR retry_hold=1) AND created_at<=?
      AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 2`)
    .bind(cutoff,deliveryCursor.after_at??'',deliveryCursor.after_id??'')
    .all<{id:string;subscription_id:string;created_at:string}>();
  for(const row of unresolved.results) await hold(env,'history',row.id,row.subscription_id,'overdue_unresolved_delivery',counts);
  const rows=await env.MEDIA_DB.prepare(`SELECT o.id,json_extract(o.payload,'$.subscription_id') AS subscription_id,
    o.retention_finished_at,d.digest_run_id FROM media_news_email_outbox o
    LEFT JOIN media_news_email_deliveries d ON d.id=o.id
    WHERE o.state='completed' AND o.retention_finished_at<=? AND (o.retention_finished_at,o.id)>(?,?)
    ORDER BY o.retention_finished_at,o.id LIMIT 100`)
    .bind(cutoff,cursor.after_at??'',cursor.after_id??'').all<History>();
  counts.eligible+=rows.results.length;
  if(rows.results.length) {
    await liveLease(env,lease);
    const ids=JSON.stringify(rows.results.map(row=>row.id));
    // Selection and all FK-ordered deletes are a single D1 transaction. Concurrent retries
    // cannot turn a selected completed root into live work between these statements.
    const removed=await env.MEDIA_DB.batch([
      env.MEDIA_DB.prepare(`INSERT INTO media_news_retention_batch(lease_id,id,digest_run_id)
        SELECT ?,o.id,d.digest_run_id FROM media_news_email_outbox o
        LEFT JOIN media_news_email_deliveries d ON d.id=o.id
        LEFT JOIN media_news_digest_runs r ON r.id=coalesce(d.digest_run_id,o.id)
        WHERE o.id IN (SELECT value FROM json_each(?)) AND o.state='completed' AND o.retention_finished_at<=?
        AND EXISTS(SELECT 1 FROM media_news_retention_status WHERE singleton=1 AND lease_id=? AND lease_until>?)
        AND ((d.id IS NULL AND r.id IS NULL) OR (d.state IN ('accepted','permanent_failure','cancelled') AND d.retry_hold=0
          AND d.retention_finished_at<=? AND (d.digest_run_id IS NULL OR
            ((d.state='cancelled' OR (r.state='completed' AND r.completed_at<=?))
             AND NOT EXISTS(SELECT 1 FROM media_news_email_deliveries shared WHERE shared.digest_run_id=r.id AND shared.id<>d.id)))))`)
        .bind(lease,ids,cutoff,lease,now(),cutoff,cutoff),
      env.MEDIA_DB.prepare(`UPDATE media_news_approval_events SET email_dispatch_closed=1 WHERE id IN
        (SELECT o.approval_event_id FROM media_news_email_outbox o JOIN media_news_retention_batch b ON b.id=o.id
         WHERE b.lease_id=? AND o.work_type='approval_dispatch')`).bind(lease),
      env.MEDIA_DB.prepare(`DELETE FROM media_news_email_deliveries WHERE id IN
        (SELECT id FROM media_news_retention_batch WHERE lease_id=?)`).bind(lease),
      env.MEDIA_DB.prepare(`DELETE FROM media_news_digest_runs WHERE id IN
        (SELECT digest_run_id FROM media_news_retention_batch WHERE lease_id=?)
        AND NOT EXISTS(SELECT 1 FROM media_news_email_deliveries WHERE digest_run_id=media_news_digest_runs.id)`).bind(lease),
      env.MEDIA_DB.prepare(`DELETE FROM media_news_email_outbox WHERE id IN
        (SELECT id FROM media_news_retention_batch WHERE lease_id=?)`).bind(lease),
      env.MEDIA_DB.prepare(`DELETE FROM media_news_retention_holds WHERE kind='history' AND record_id IN
        (SELECT id FROM media_news_retention_batch WHERE lease_id=?)`).bind(lease),
      env.MEDIA_DB.prepare(`INSERT INTO media_news_retention_holds
        (kind,record_id,subscription_id,reason,first_seen_at,checked_at,review_after)
        SELECT 'history',o.id,json_extract(o.payload,'$.subscription_id'),'terminal_dependency_or_revision',?,?,?
        FROM media_news_email_outbox o WHERE o.id IN (SELECT value FROM json_each(?))
        ON CONFLICT(kind,record_id) DO UPDATE SET checked_at=excluded.checked_at,review_after=excluded.review_after`)
        .bind(at,at,new Date(Date.now()+DAY).toISOString(),ids),
      env.MEDIA_DB.prepare('DELETE FROM media_news_retention_batch WHERE lease_id=?').bind(lease),
    ]);
    counts.deleted+=Number(removed[4]!.meta.changes);
    counts.held+=rows.results.length-Number(removed[4]!.meta.changes);
  }
  const last=rows.results.at(-1),lastOpen=open.results.at(-1),lastDelivery=unresolved.results.at(-1);
  return {closed:rows.results.length===100&&last?{after_at:last.retention_finished_at,after_id:last.id,more:true}:{},
    open:open.results.length===2&&lastOpen?{after_at:lastOpen.created_at,after_id:lastOpen.id,more:true}:{},
    deliveries:unresolved.results.length===2&&lastDelivery?{after_at:lastDelivery.created_at,after_id:lastDelivery.id,more:true}:{}};
}

async function reviewHolds(env:Env):Promise<void> {
  const rows=await env.MEDIA_DB.prepare(`SELECT kind,record_id FROM media_news_retention_holds
    WHERE review_after<=? ORDER BY review_after,kind,record_id LIMIT 2`).bind(now()).all<{kind:Phase;record_id:string}>();
  for(const row of rows.results) {
    let needed:boolean;
    if(row.kind==='history') {
      const result=await env.MEDIA_DB.prepare(`SELECT EXISTS(SELECT 1 FROM media_news_email_outbox WHERE id=? AND state<>'completed')
        OR EXISTS(SELECT 1 FROM media_news_email_deliveries d LEFT JOIN media_news_digest_runs r ON r.id=d.digest_run_id
          WHERE d.id=? AND (d.retry_hold=1 OR d.state NOT IN ('accepted','permanent_failure','cancelled')
          OR (d.state='accepted' AND d.delivery_mode='daily' AND coalesce(r.state,'')<>'completed'))) AS held`)
        .bind(row.record_id,row.record_id).first<{held:number}>();
      if(!result) throw new Error('retention_dependency_unavailable');
      needed=result.held===1;
    } else {
      const result=await retentionRpc<{eligible:boolean}>(env,'inspect',{kind:row.kind,record_id:row.record_id});
      if(typeof result.eligible!=='boolean') throw new Error('retention_source_invalid');
      needed=result.eligible;
    }
    if(!needed) await clearHold(env,row.kind,row.record_id);
    else await env.MEDIA_DB.prepare(`UPDATE media_news_retention_holds SET checked_at=?,review_after=?
      WHERE kind=? AND record_id=?`).bind(now(),new Date(Date.now()+DAY).toISOString(),row.kind,row.record_id).run();
  }
}

export async function runRetention(env:Env):Promise<void> {
  const lease=crypto.randomUUID(),at=now();
  const claimed=await env.MEDIA_DB.prepare(`UPDATE media_news_retention_status SET lease_id=?,lease_until=?,
    last_started_at=?,state='running',error_code=NULL WHERE singleton=1 AND (lease_until IS NULL OR lease_until<?)`)
    .bind(lease,new Date(Date.now()+300000).toISOString(),at,at).run();
  if(!claimed.meta.changes) return;
  const counts:Counts={eligible:0,deleted:0,held:0,initialised:0,minimised:0};
  try {
    const probe=await retentionRpc<{ok:boolean}>(env,'probe');
    if(probe.ok!==true) throw new Error('retention_source_invalid');
    await env.MEDIA_DB.prepare(`DELETE FROM media_news_retention_fences WHERE subscription_id IN
      (SELECT subscription_id FROM media_news_retention_fences WHERE expires_at<? ORDER BY expires_at,subscription_id LIMIT 5)`)
      .bind(now()).run();
    const status=await env.MEDIA_DB.prepare('SELECT phase,cursors FROM media_news_retention_status WHERE singleton=1').first<Status>();
    if(!status||!phases.includes(status.phase)) throw new Error('retention_state_invalid');
    const cursors=JSON.parse(status.cursors) as Record<string,Cursor>;
    if(status.phase==='history') {
      const result=await historyPhase(env,cursors.history??{},cursors.open??{},cursors.open_delivery??{},lease,counts);
      cursors.history=result.closed; cursors.open=result.open; cursors.open_delivery=result.deliveries;
    } else cursors[status.phase]=await sourcePhase(env,status.phase,cursors[status.phase]??{},lease,counts);
    await reviewHolds(env);
    const finished=now();
    await env.MEDIA_DB.prepare(`UPDATE media_news_retention_status SET phase=?,cursors=?,state=?,last_success_at=?,
      last_finished_at=?,eligible=?,deleted=?,held=?,initialised=?,minimised=?,lease_id=NULL,lease_until=NULL
      WHERE singleton=1 AND lease_id=?`)
      .bind(phases[(phases.indexOf(status.phase)+1)%phases.length]!,JSON.stringify(cursors),counts.held?'held':'ok',
        finished,finished,counts.eligible,counts.deleted,counts.held,counts.initialised,counts.minimised,lease).run();
    if(Object.values(cursors).some(cursor=>cursor.more===true)) await env.MEDIA_EMAIL_QUEUE.send({id:'news-retention'});
    console.log(JSON.stringify({event:'news_retention',phase:status.phase,...counts}));
  } catch {
    try {
      await env.MEDIA_DB.prepare(`UPDATE media_news_retention_status SET state='error',error_code='retention_unavailable',
        last_finished_at=?,eligible=?,deleted=?,held=?,initialised=?,minimised=?,lease_id=NULL,lease_until=NULL
        WHERE singleton=1 AND lease_id=?`).bind(now(),counts.eligible,counts.deleted,counts.held,counts.initialised,counts.minimised,lease).run();
    } finally { console.error(JSON.stringify({event:'news_retention_failed',code:'retention_unavailable',...counts})); }
    throw new Error('retention_unavailable');
  }
}

export async function retentionStatus(env:Env,url:URL):Promise<Response> {
  const query=url.searchParams;
  for(const key of query.keys()) if(!['after_review','after_kind','after_id'].includes(key)||query.getAll(key).length!==1)
    throw new HttpError(400,'invalid_retention_cursor');
  const after=query.get('after_review')??'',kind=query.get('after_kind')??'',id=query.get('after_id')??'';
  if(query.size&&(query.size!==3||after.length>40||!Number.isFinite(Date.parse(after))||
    !phases.includes(kind as Phase)||!/^[A-Za-z0-9:._-]{1,200}$/.test(id))) throw new HttpError(400,'invalid_retention_cursor');
  const status=await env.MEDIA_DB.prepare(`SELECT phase,state,last_started_at,last_success_at,last_finished_at,
    error_code,eligible,deleted,held,initialised,minimised FROM media_news_retention_status WHERE singleton=1`).first();
  const holds=await env.MEDIA_DB.prepare(`SELECT kind,record_id,reason,first_seen_at,checked_at,review_after
    FROM media_news_retention_holds WHERE (review_after,kind,record_id)>(?,?,?)
    ORDER BY review_after,kind,record_id LIMIT 26`).bind(after,kind,id)
    .all<{kind:Phase;record_id:string;reason:string;first_seen_at:string;checked_at:string;review_after:string}>();
  const last=holds.results[24];
  return json({retention_days:30,status,holds:holds.results.slice(0,25),holds_limit:25,
    next_cursor:holds.results.length>25&&last?{after_review:last.review_after,after_kind:last.kind,after_id:last.record_id}:null});
}

export async function senderRetentionRoute(request:Request,env:Env,path:string):Promise<Response> {
  if(!env.NEWS_EMAIL_SENDER_SECRET||!await bearerMatches(request,env.NEWS_EMAIL_SENDER_SECRET)) throw new HttpError(401,'unauthorized');
  if(request.method!=='POST') throw new HttpError(405,'method_not_allowed');
  const body=JSON.parse(await boundedBody(request,2048)) as {message_id?:unknown;attempt_count?:unknown;message_ids?:unknown};
  if(path==='/sender/eligibility') {
    if(typeof body.message_id!=='string'||!/^<news\.[a-f0-9]{64}@ukaq\.co\.uk>$/.test(body.message_id)||
      !Number.isSafeInteger(body.attempt_count)) throw new HttpError(400,'invalid_request');
    const row=await env.MEDIA_DB.prepare(`SELECT d.id,EXISTS(SELECT 1 FROM media_news_retention_fences f
      WHERE f.subscription_id=d.subscription_id AND f.expires_at>?) AS fenced
      FROM media_news_email_deliveries d WHERE d.message_id=? AND d.attempt_count=?
      AND d.attempt_transport='pro_app_password' AND d.state='sending' AND d.retry_hold=0`)
      .bind(now(),body.message_id,body.attempt_count).first<{id:string;fenced:number}>();
    return json({ok:!!row&&!row.fenced,held:!!row?.fenced});
  }
  if(path!=='/sender/retention'||!Array.isArray(body.message_ids)||body.message_ids.length>LIMIT||
    body.message_ids.some(id=>typeof id!=='string'||!/^<news\.[a-f0-9]{64}@ukaq\.co\.uk>$/.test(id))) throw new HttpError(400,'invalid_request');
  const items=[];
  for(const id of body.message_ids as string[]) {
    const row=await env.MEDIA_DB.prepare(`SELECT d.state,d.retry_hold,d.retention_finished_at,o.state AS work_state
      FROM media_news_email_deliveries d LEFT JOIN media_news_email_outbox o ON o.id=d.id WHERE d.message_id=?`)
      .bind(id).first<{state:string;retry_hold:number;retention_finished_at:string|null;work_state:string|null}>();
    items.push({message_id:id,retire:!row||(['accepted','permanent_failure','cancelled'].includes(row.state)&&row.retry_hold===0&&
      !!row.retention_finished_at&&row.retention_finished_at<=new Date(Date.now()-30*DAY).toISOString()&&row.work_state==='completed')});
  }
  return json({items});
}
