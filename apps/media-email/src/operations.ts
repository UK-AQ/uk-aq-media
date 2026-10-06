import { HttpError, json } from '@uk-aq-media/core';
import { now, queueJob, type Delivery, type Env, type Transport } from './common';
import { fallbackEndpoint, proReceipt } from './transport';

const messageId=/^<news\.[a-f0-9]{64}@ukaq\.co\.uk>$/;
const resolutions=new Set(['accepted','temporary_failure','permanent_failure']);
const evidence=new Set(['workspace_mail_log','recipient_confirmation','provider_result']);
function fields(data:Record<string,unknown>,allowed:string[]):void {
  if(Object.keys(data).some(key=>!allowed.includes(key))) throw new HttpError(400,'invalid_request');
}

// Caller has already authenticated with the independent operator bearer secret.
// No recipients, arbitrary provider text or credentials are accepted/returned here.
export async function deliveryOperation(env:Env,path:string,data:Record<string,unknown>):Promise<Response> {
  if(typeof data.delivery_id!=='string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(data.delivery_id) ||
    typeof data.message_id!=='string' || !messageId.test(data.message_id) ||
    !Number.isSafeInteger(data.attempt_count) || Number(data.attempt_count)<0)
    throw new HttpError(400,'invalid_request');
  const d=await env.MEDIA_DB.prepare('SELECT * FROM media_news_email_deliveries WHERE id=?')
    .bind(data.delivery_id).first<Delivery>();
  if(!d || d.message_id!==data.message_id || d.attempt_count!==data.attempt_count)
    throw new HttpError(409,'delivery_identity_changed');
  if(path==='/operations/reconcile') {
    if(d.state!=='unknown') throw new HttpError(409,'unknown_delivery_required');
    let outcome:string, source:string, reference:string|null=null;
    if(d.attempt_transport==='cloudflare_xoauth2') {
      fields(data,['delivery_id','message_id','attempt_count','outcome','evidence','evidence_reference']);
      if(typeof data.outcome!=='string' || !resolutions.has(data.outcome) ||
        typeof data.evidence!=='string' || !evidence.has(data.evidence) ||
        typeof data.evidence_reference!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.evidence_reference) ||
        (data.evidence==='recipient_confirmation' && data.outcome!=='accepted'))
        throw new HttpError(400,'definite_evidence_required');
      // The operator must establish a definite result externally using this Message-ID.
      // A missing mail-log entry or recipient non-receipt is not proof of failure.
      outcome=data.outcome; source=data.evidence; reference=data.evidence_reference;
    } else if(d.attempt_transport==='pro_app_password') {
      fields(data,['delivery_id','message_id','attempt_count']);
      try { outcome=await proReceipt(env,d.message_id); }
      catch { throw new HttpError(409,'fallback_not_configured'); }
      if(!resolutions.has(outcome)) return json({ok:false,outcome:'unknown'},409);
      source='pro_receipt';
    } else throw new HttpError(409,'attempt_transport_required');
    const stamp=now();
    const updated=await env.MEDIA_DB.batch([
      env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state=?,retry_hold=?,
        last_error='operator_reconciled',reconciled_at=?,reconciliation_evidence=?,reconciliation_reference=?,
        sent_at=CASE WHEN ?='accepted' THEN coalesce(sent_at,claimed_at) ELSE sent_at END,
        failed_at=CASE WHEN ?='accepted' THEN NULL ELSE ? END
        WHERE id=? AND state='unknown' AND attempt_count=? AND attempt_transport=?`)
        .bind(outcome,outcome==='accepted'?0:1,stamp,source,reference,outcome,outcome,stamp,
          d.id,d.attempt_count,d.attempt_transport),
      // Accepted messages only need confirmation/cursor repair. Failure stays held even
      // if an old Queue message or recovery scan arrives. No submit/Queue send here.
      env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='pending',queued_at=NULL,
        attempt_count=attempt_count+1 WHERE id=?
        AND EXISTS (SELECT 1 FROM media_news_email_deliveries WHERE id=? AND state='accepted'
          AND attempt_count=? AND reconciled_at=?)`).bind(d.id,d.id,d.attempt_count,stamp),
    ]);
    if(!updated[0]!.meta.changes) throw new HttpError(409,'delivery_identity_changed');
    return json({ok:true,outcome,transport:d.attempt_transport,retry_held:outcome!=='accepted'});
  }
  fields(data,['delivery_id','message_id','attempt_count','transport']);
  if(!['pending','temporary_failure','permanent_failure'].includes(d.state))
    throw new HttpError(409,'retry_safe_delivery_required');
  if(data.transport!=='cloudflare_xoauth2' && data.transport!=='pro_app_password')
    throw new HttpError(400,'invalid_transport');
  const transport:Transport=data.transport;
  if(transport==='pro_app_password') {
    try { fallbackEndpoint(env,'/send'); } catch { throw new HttpError(409,'fallback_not_configured'); }
  }
  // Expected state/attempt/selection guards a concurrent Queue claim or operator action.
  const updated=await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state='pending',selected_transport=?,
      retry_hold=0,last_error='operator_retry_authorized' WHERE id=? AND state=? AND attempt_count=?
      AND selected_transport=? AND retry_hold=?`)
      .bind(transport,d.id,d.state,d.attempt_count,d.selected_transport,d.retry_hold),
    env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='pending',queued_at=NULL,
      attempt_count=attempt_count+1 WHERE id=?
      AND EXISTS (SELECT 1 FROM media_news_email_deliveries WHERE id=? AND state='pending'
        AND attempt_count=? AND selected_transport=? AND retry_hold=0)`)
      .bind(d.id,d.id,d.attempt_count,transport),
  ]);
  if(!updated[0]!.meta.changes) throw new HttpError(409,'delivery_identity_changed');
  await queueJob(env,d.id); // Eligibility is rechecked by the normal delivery consumer.
  return json({ok:true,transport,message_id:d.message_id});
}
