import { HttpError } from '@uk-aq-media/core';
export interface Env {
  MEDIA_DB: D1Database; MEDIA_EMAIL_QUEUE: Queue<{id:string}>;
  NEWS_EMAIL_ENABLED: string; NEWS_EMAIL_SITE_ORIGIN: string;
  NEWS_EMAIL_TURNSTILE_HOSTNAMES: string; NEWS_EMAIL_TURNSTILE_ACTION: string;
  NEWS_EMAIL_CONSENT_VERSION: string; NEWS_EMAIL_TURNSTILE_SECRET: string;
  NEWS_EMAIL_TOKEN_SECRET: string; NEWS_EMAIL_RATE_SECRET: string;
  NEWS_EMAIL_CONFIRM_COOLDOWN_HOURS: string; NEWS_EMAIL_CONFIRM_MAX_SENDS: string;
  NEWS_EMAIL_CONFIRM_BACKOFF_DAYS: string; NEWS_EMAIL_IP_BURST_LIMIT: string;
  NEWS_EMAIL_IP_HOURLY_LIMIT: string; UK_AQ_MEDIA_EMAIL_WORKER_HTTP_SECRET: string;
  NEWS_EMAIL_OPERATOR_SECRET: string; NEWS_EMAIL_PUBLIC_API_ORIGIN: string;
  GOOGLE_SMTP_USERNAME: string; GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string; GOOGLE_OAUTH_REFRESH_TOKEN: string;
  // Optional Pro fallback only; never needed by the default direct transport.
  NEWS_EMAIL_SENDER_URL?: string; NEWS_EMAIL_SENDER_SECRET?: string;
  SUPABASE_URL: string; SB_SECRET_KEY: string;
}
export interface Subscription {
  id: string; email: string; status: string; delivery_mode: string; daily_time_local: string;
  confirmed_at: string; digest_cursor_at: string; mode_since_at: string; updated_at:string;
}
export interface Work {
  event_id?: number; subscription_id?: string; generation?: string; after?: string;
  cutoff?: string; start?: string; mode_since_at?: string; daily_time_local?: string;
  preference_updated_at?:string; at?: string;
}
export interface Job { id:string; work_type:string; payload:string; state:string; attempt_count:number }
export type Transport = 'cloudflare_xoauth2' | 'pro_app_password';
export interface Delivery {
  id:string; state:string; message_id:string; created_at:string; claimed_at:string|null; sent_at:string|null;
  delivery_mode:string; subscription_id:string;
  selected_transport:Transport; attempt_transport:Transport|null; attempt_count:number; retry_hold:number;
  reconciliation_target:string|null;
}
export const now = ():string => new Date().toISOString();
export const iso = (value:string):string => new Date(value).toISOString();
export const encoder = new TextEncoder();
const hex = (value:ArrayBuffer):string => Array.from(new Uint8Array(value), b=>b.toString(16).padStart(2,'0')).join('');
export async function hash(value:string):Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
}
// A cryptographic PRF over a random generation UUID permits durable recovery without
// storing a bearer token. Only SHA-256 hashes enter Supabase; the key remains a secret.
export async function token(env:Env, scope:string):Promise<string> {
  const key = await crypto.subtle.importKey('raw',encoder.encode(env.NEWS_EMAIL_TOKEN_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(scope)));
}
export async function rpc<T>(env:Env, action:string, data:Record<string,unknown> = {}):Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/uk_aq_news_email_service`, {
    method:'POST',headers:{apikey:env.SB_SECRET_KEY,
      'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_data:data}),
    signal:AbortSignal.timeout(15000),redirect:'manual',
  });
  if (!response.ok) throw new Error('subscription_service_unavailable');
  return await response.json() as T;
}
export function reconciliationTargetAllows(current:string|null,requested:string):boolean {
  return current===null || current===requested;
}
export interface ConfirmationOutcomeReceipt { ok?:boolean; conflict?:boolean; outcome?:string }
export function reconciliationOutcomeCommitted(receipt:ConfirmationOutcomeReceipt,requested:string):boolean {
  return receipt.ok===true && receipt.conflict!==true && receipt.outcome===requested;
}
export async function recordConfirmationOutcome(env:Env,id:string,generation:string,
  outcome:string):Promise<ConfirmationOutcomeReceipt> {
  const receipt=await env.MEDIA_DB.prepare(`SELECT claimed_at,sent_at
    FROM media_news_email_deliveries WHERE id=?`).bind(id)
    .first<{claimed_at:string|null;sent_at:string|null}>();
  const sentAt=receipt?.sent_at??receipt?.claimed_at??null;
  if(outcome==='accepted'&&!sentAt) throw new Error('confirmation_acceptance_time_required');
  return rpc<ConfirmationOutcomeReceipt>(env,'confirmation_outcome',{id:generation,outcome,sent_at:sentAt,
    max_sends:Number(env.NEWS_EMAIL_CONFIRM_MAX_SENDS),
    backoff_days:Number(env.NEWS_EMAIL_CONFIRM_BACKOFF_DAYS)});
}
export async function boundedBody(request:Request|Response, limit=8192):Promise<string> {
  if (Number(request.headers.get('content-length'))>limit) throw new HttpError(413,'request_too_large');
  if (!request.body) return '';
  const reader=request.body.getReader(); let size=0; const chunks:Uint8Array[]=[];
  while (true) {
    const {value,done}=await reader.read(); if(done) break;
    size+=value.byteLength;
    if(size>limit) { await reader.cancel(); throw new HttpError(413,'request_too_large'); }
    chunks.push(value);
  }
  const bytes=new Uint8Array(size); let offset=0;
  for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function addJob(env:Env,id:string,type:string,work:Work,event:number|null=null):Promise<void> {
  await env.MEDIA_DB.prepare(`INSERT INTO media_news_email_outbox
    (id,approval_event_id,work_type,payload,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(id,event,type,JSON.stringify(work),now()).run();
}
export async function queueJob(env:Env,id:string):Promise<void> {
  const pending=await env.MEDIA_DB.prepare(`SELECT o.state,coalesce(d.retry_hold,0) AS retry_hold
    FROM media_news_email_outbox o LEFT JOIN media_news_email_deliveries d ON d.id=o.id WHERE o.id=?`)
    .bind(id).first<{state:string;retry_hold:number}>();
  if(!pending || pending.state==='completed' || pending.retry_hold) return;
  // Sending first leaves a recoverable row if either the Queue or acknowledgement fails.
  await env.MEDIA_EMAIL_QUEUE.send({id});
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='queued',queued_at=?,
    attempt_count=attempt_count+1 WHERE id=? AND state!='completed'`).bind(now(),id).run();
}
export async function complete(env:Env,job:Job):Promise<void> {
  // A concurrent operator release/reconciliation must not be consumed by an older job.
  await env.MEDIA_DB.prepare(`UPDATE media_news_email_outbox SET state='completed',last_error=NULL
    WHERE id=? AND attempt_count=?`).bind(job.id,job.attempt_count).run();
}
export async function newDelivery(env:Env,id:string,sub:string,mode:string,event:number|null=null,
  digest:string|null=null):Promise<Delivery> {
  const messageId=`<news.${await hash(id)}@ukaq.co.uk>`;
  await env.MEDIA_DB.prepare(`INSERT INTO media_news_email_deliveries
    (id,subscription_id,approval_event_id,digest_run_id,delivery_mode,message_id,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,sub,event,digest,mode,messageId,now()).run();
  return (await env.MEDIA_DB.prepare('SELECT * FROM media_news_email_deliveries WHERE id=?')
    .bind(id).first<Delivery>())!;
}
