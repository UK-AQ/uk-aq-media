import { digestCursorRequest, digestRunStateAfterCursor, hash, iso, newDelivery, now,
  recordConfirmationOutcome, rpc, token, type CursorAdvanceReceipt, type Delivery,
  type DigestCursorReason, type Env, type Subscription, type Work } from './common';
import { dailyWorkStillMatches, digestRequiresOperator } from './delivery-policy';
import { MessageSizeError, serialize, submission, type Message } from './message';
import { articleMessage, confirmationMessage, type EmailArticle } from './presentation';
import { publicPreviewImageUrl, type PublicPreviewSelection } from '@uk-aq-media/core';
import { submit } from './transport';
type Article = Omit<EmailArticle,'preview_image_url'> & PublicPreviewSelection;
// Current standalone Media public origin from the system Media contract. This
// serves images for both TEST and future public-site links, independent of tokens.
const MEDIA_PUBLIC_ORIGIN='https://uk-aq-media-public.uk-aq-media.workers.dev';
const articleColumns=`a.id,a.source_key,coalesce(a.display_title,a.title) AS title,
  a.publisher,a.canonical_url,a.published_at,a.og_image_url,
  a.image_policy AS article_image_policy,s.image_policy AS source_image_policy,
  li.source_image_url AS local_image_source_url,li.content_sha256 AS local_image_content_sha256`;
const imageJoins=`JOIN media_sources s ON s.source_key=a.source_key
  LEFT JOIN media_article_local_images li ON li.article_id=a.id`;
const terminal=new Set(['accepted','unknown','permanent_failure','cancelled']);
export async function cancel(env:Env,id:string):Promise<void> {
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state='cancelled'
    WHERE id=? AND state IN ('pending','temporary_failure')`).bind(id).run();
}
async function send(env:Env,delivery:Delivery,sub:Subscription,message:Message):Promise<string> {
  if(terminal.has(delivery.state)) return delivery.state;
  if(delivery.retry_hold || delivery.state==='sending') throw new Error('delivery_claim_unavailable');
  const claim=await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state='sending',
    claimed_at=?,attempt_count=attempt_count+1,attempt_transport=selected_transport,submission_started=0
    WHERE id=? AND state IN ('pending','temporary_failure') AND retry_hold=0
    AND selected_transport=? AND attempt_count=?`)
    .bind(now(),delivery.id,delivery.selected_transport,delivery.attempt_count).run();
  if(!claim.meta.changes) throw new Error('delivery_claim_changed');
  const attempt=delivery.attempt_count+1;
  const {outcome,error}=await submit(env,delivery.selected_transport,submission(delivery,sub.email,message),async()=>{
    const marked=await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET submission_started=1
      WHERE id=? AND state='sending' AND attempt_count=? AND attempt_transport=? AND retry_hold=0`)
      .bind(delivery.id,attempt,delivery.selected_transport).run();
    if(!marked.meta.changes) throw new Error('submission_claim_unavailable');
  });
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state=?,
    sent_at=CASE WHEN ?='accepted' THEN ? ELSE sent_at END,
    failed_at=CASE WHEN ?!='accepted' THEN ? ELSE NULL END,last_error=?
    WHERE id=? AND state='sending' AND attempt_count=? AND attempt_transport=?`)
    .bind(outcome,outcome,now(),outcome,now(),error,delivery.id,attempt,delivery.selected_transport).run();
  if(outcome==='temporary_failure') throw new Error('temporary_failure');
  return outcome;
}
async function links(env:Env,sub:Subscription):Promise<{manage_url:string;unsubscribe_url:string}|null> {
  const scope=`${sub.id}:${iso(sub.confirmed_at)}`;
  const manage=await token(env,`manage:${scope}`), unsubscribe=await token(env,`unsubscribe:${scope}`);
  const result=await rpc<{ok?:boolean}>(env,'issue_links',{subscription_id:sub.id,confirmed_at:sub.confirmed_at,
    manage_hash:await hash(manage),unsubscribe_hash:await hash(unsubscribe)});
  if(!result.ok) return null;
  return {manage_url:`${env.NEWS_EMAIL_SITE_ORIGIN}/news/#manage=${manage}`,
    unsubscribe_url:`${env.NEWS_EMAIL_SITE_ORIGIN}/news/#unsubscribe=${unsubscribe}`};
}
async function activeMessage(env:Env,sub:Subscription,articles:Article[],kind:'immediate'|'daily',
  date:string):Promise<Message|null> {
  const urls=await links(env,sub); if(!urls) return null;
  const presentation=await Promise.all(articles.map(async article=>({...article,
    preview_image_url:await publicPreviewImageUrl(MEDIA_PUBLIC_ORIGIN,article)})));
  return articleMessage(env.NEWS_EMAIL_SITE_ORIGIN,presentation,kind,urls,date);
}
export async function confirmation(env:Env,id:string,w:Work):Promise<void> {
  const sub=await rpc<Subscription>(env,'get',{subscription_id:w.subscription_id});
  const valid=await rpc<{ok:boolean}>(env,'confirmation_valid',{id:w.generation,subscription_id:w.subscription_id});
  const delivery=await newDelivery(env,id,w.subscription_id!,'confirmation');
  if(terminal.has(delivery.state)) {
    await recordConfirmationOutcome(env,id,w.generation!,delivery.state); return;
  }
  if(sub.status!=='pending'||!valid.ok) {
    await cancel(env,id);
    await recordConfirmationOutcome(env,id,w.generation!,delivery.state==='sending'?'unknown':'cancelled'); return;
  }
  const link=`${env.NEWS_EMAIL_SITE_ORIGIN}/news/#confirm=${await token(env,`confirmation:${w.generation}`)}`;
  const outcome=await send(env,delivery,sub,confirmationMessage(env.NEWS_EMAIL_SITE_ORIGIN,link));
  await recordConfirmationOutcome(env,id,w.generation!,outcome);
}
export async function immediate(env:Env,id:string,w:Work):Promise<void> {
  const delivery=await newDelivery(env,id,w.subscription_id!,'immediate',w.event_id!);
  if(terminal.has(delivery.state)) return;
  const sub=await rpc<Subscription>(env,'get',{subscription_id:w.subscription_id});
  const article=await env.MEDIA_DB.prepare(`SELECT ${articleColumns},e.approved_at FROM media_news_approval_events e
    JOIN media_articles a ON a.id=e.article_id ${imageJoins} WHERE e.id=? AND a.status='approved'`)
    .bind(w.event_id).first<Article & {approved_at:string}>();
  if(sub.status!=='active'||sub.delivery_mode!=='immediate'||!article ||
      Date.parse(sub.mode_since_at)>=Date.parse(article.approved_at)) { await cancel(env,id); return; }
  const message=await activeMessage(env,sub,[article],'immediate',delivery.created_at);
  if(!message) { await cancel(env,id); return; }
  // Resolve both authorities again immediately before final submission.
  const current=await rpc<Subscription>(env,'get',{subscription_id:sub.id});
  const eligible=await env.MEDIA_DB.prepare(`SELECT e.id FROM media_news_approval_events e
    JOIN media_articles a ON a.id=e.article_id WHERE e.id=? AND a.status='approved'`)
    .bind(w.event_id).first();
  if(!eligible||current.status!=='active'||current.delivery_mode!=='immediate'||
    current.mode_since_at!==sub.mode_since_at) { await cancel(env,id); return; }
  await send(env,delivery,current,message);
}
export async function digest(env:Env,id:string,w:Work):Promise<void> {
  await env.MEDIA_DB.prepare(`INSERT INTO media_news_digest_runs
    (id,subscription_id,scheduled_for_utc,window_start_utc,window_end_utc,created_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(id,w.subscription_id,w.cutoff,w.start,w.cutoff,now()).run();
  const delivery=await newDelivery(env,id,w.subscription_id!,'daily',null,id);
  const run=await env.MEDIA_DB.prepare('SELECT state FROM media_news_digest_runs WHERE id=?').bind(id).first<{state:string}>();
  if(run?.state==='completed') return;
  // SMTP acceptance and cursor repair are separate durable steps.
  if(delivery.state==='accepted') { await finishDigest(env,id,w,'accepted'); return; }
  if(run?.state==='empty') { await finishDigest(env,id,w,'empty'); return; }
  if(terminal.has(delivery.state)) return;
  const sub=await rpc<Subscription>(env,'get',{subscription_id:w.subscription_id});
  if(!dailyWorkStillMatches(w,sub)) { await cancel(env,id); return; }
  const {results:articles}=await env.MEDIA_DB.prepare(`SELECT ${articleColumns} FROM media_news_approval_events e
    JOIN media_articles a ON a.id=e.article_id ${imageJoins} WHERE e.approved_at>? AND e.approved_at<=?
    AND a.status='approved' ORDER BY a.feed_sort_at DESC,a.id DESC LIMIT 501`)
    .bind(w.start,w.cutoff).all<Article>();
  // Fail closed instead of silently dropping part of a large window or sending a partial digest.
  if(digestRequiresOperator(articles.length,0)) { await holdDigest(env,id,articles.length); return; }
  if(!articles.length) {
    const current=await rpc<Subscription>(env,'get',{subscription_id:sub.id});
    if(!dailyWorkStillMatches(w,current)) { await cancel(env,id); return; }
    await env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET state='empty',item_count=0 WHERE id=?`).bind(id).run();
    await cancel(env,id); await finishDigest(env,id,w,'empty'); return;
  }
  const message=await activeMessage(env,sub,articles,'daily',w.cutoff!);
  if(!message) { await cancel(env,id); return; }
  try {
    // Includes UTF-8, both base64 alternatives, CID assets, headers/boundaries,
    // and the fallback JSON envelope. Never deliver a truncated article window.
    serialize(env,submission(delivery,sub.email,message));
  } catch(error) {
    if(!(error instanceof MessageSizeError)) throw error;
    await holdDigest(env,id,articles.length); return;
  }
  const current=await rpc<Subscription>(env,'get',{subscription_id:sub.id});
  if(!dailyWorkStillMatches(w,current)) { await cancel(env,id); return; }
  await env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET item_count=?,message_id=? WHERE id=?`)
    .bind(articles.length,delivery.message_id,id).run();
  const outcome=await send(env,delivery,current,message);
  await env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET state=?,sent_at=? WHERE id=?`)
    .bind(outcome,outcome==='accepted'?now():null,id).run();
  if(outcome==='accepted') await finishDigest(env,id,w,'accepted');
}
async function holdDigest(env:Env,id:string,itemCount:number):Promise<void> {
  const stamp=now();
  await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare(`UPDATE media_news_email_deliveries SET state='permanent_failure',retry_hold=1,
      failed_at=?,last_error='digest_size_requires_operator' WHERE id=?
      AND state IN ('pending','temporary_failure')`).bind(stamp,id),
    env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET state='operator_hold',item_count=?,
      last_error='digest_size_requires_operator' WHERE id=?`).bind(itemCount,id),
  ]);
}
async function finishDigest(env:Env,id:string,w:Work,reason:DigestCursorReason):Promise<void> {
  const receipt=await rpc<CursorAdvanceReceipt>(env,'cursor',digestCursorRequest(w,reason));
  if(digestRunStateAfterCursor(reason,receipt)==='cancelled') {
    // The empty window became stale after its final application-level check. Retire it
    // without consuming the cursor so the subscriber's new Daily preference can reuse it.
    await env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET state='cancelled',completed_at=?,
      last_error='stale_daily_work' WHERE id=? AND state='empty'`).bind(now(),id).run();
    return;
  }
  // Accepted SMTP submission remains authoritative even if a later cursor CAS no longer
  // matches; in particular, preference revision changes never block its repair attempt.
  await env.MEDIA_DB.prepare(`UPDATE media_news_digest_runs SET state='completed',completed_at=? WHERE id=?`)
    .bind(now(),id).run();
}
