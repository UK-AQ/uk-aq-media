import { HttpError, json } from '@uk-aq-media/core';
import { addJob, boundedBody, encoder, hash, queueJob, rpc, token, type Env } from './common';
import { normalizeSupportedMailbox } from './mailbox';
import { turnstileHostnames } from './config.mjs';
const neutral={ok:true,message:'If this address can be subscribed, please check the inbox for a confirmation email.'};
async function rateLimit(request:Request,env:Env):Promise<void> {
  const ip=request.headers.get('CF-Connecting-IP');
  if(!ip) throw new HttpError(400,'source_unavailable');
  const stamp=Date.now(); const bucket=Math.floor(stamp/3600000);
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.NEWS_EMAIL_RATE_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const keys=await Promise.all([bucket,bucket-1].map(async b=>{
    const bytes=await crypto.subtle.sign('HMAC',key,encoder.encode(`${b}:${ip}`));
    return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
  }));
  const burst=Number(env.NEWS_EMAIL_IP_BURST_LIMIT), hour=Number(env.NEWS_EMAIL_IP_HOURLY_LIMIT);
  if(!Number.isInteger(burst)||!Number.isInteger(hour)||burst<1||hour<1) throw new Error('rate_config');
  const result=await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare('DELETE FROM media_news_rate_events WHERE occurred_at<?').bind(stamp-3600000),
    env.MEDIA_DB.prepare(`INSERT INTO media_news_rate_events (id,rate_key,occurred_at)
      SELECT ?,?,? WHERE (SELECT count(*) FROM media_news_rate_events WHERE rate_key IN (?,?)
        AND occurred_at>?)<? AND (SELECT count(*) FROM media_news_rate_events
        WHERE rate_key IN (?,?) AND occurred_at>?)<?`)
      .bind(crypto.randomUUID(),keys[0],stamp,...keys,stamp-60000,burst,...keys,stamp-3600000,hour),
  ]);
  if(!result[1]?.meta.changes) throw new HttpError(429,'please_try_later');
}
function preference(body:Record<string,unknown>):void {
  if(!['immediate','daily'].includes(String(body.delivery_mode)) ||
    (body.delivery_mode==='daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.daily_time_local))))
    throw new HttpError(400,'invalid_preference');
}
export async function publicRoute(request:Request,env:Env,path:string):Promise<Response> {
  if(request.method!=='POST') throw new HttpError(405,'method_not_allowed');
  const raw=await boundedBody(request);
  let body:Record<string,unknown>;
  try { body=JSON.parse(raw); if(!body || Array.isArray(body) || typeof body!=='object') throw new Error(); }
  catch { throw new HttpError(400,'invalid_request'); }
  if(path==='/subscribe') {
    preference(body);
    const email=normalizeSupportedMailbox(body.email);
    if(!email) throw new HttpError(400,'invalid_email');
    if(body.consent_text_version!==env.NEWS_EMAIL_CONSENT_VERSION) throw new HttpError(400,'invalid_form');
    await rateLimit(request,env);
    const result=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({secret:env.NEWS_EMAIL_TURNSTILE_SECRET,response:body.turnstile_token,
        remoteip:request.headers.get('CF-Connecting-IP')}),
    });
    const check=await result.json() as {success?:boolean;action?:string;hostname?:string};
    if(!result.ok || !check.success || check.action!==env.NEWS_EMAIL_TURNSTILE_ACTION ||
      !turnstileHostnames(env.NEWS_EMAIL_TURNSTILE_HOSTNAMES).includes(check.hostname??''))
      throw new HttpError(400,'turnstile_failed');
    const generation=crypto.randomUUID();
    const reserved=await rpc<{id?:string;subscription_id?:string}>(env,'subscribe',{
      email,delivery_mode:body.delivery_mode,daily_time_local:body.daily_time_local??'08:00',
      consent_text_version:body.consent_text_version,id:generation,
      token_hash:await hash(await token(env,`confirmation:${generation}`)),
      cooldown_hours:Number(env.NEWS_EMAIL_CONFIRM_COOLDOWN_HOURS),
      max_sends:Number(env.NEWS_EMAIL_CONFIRM_MAX_SENDS),backoff_days:Number(env.NEWS_EMAIL_CONFIRM_BACKOFF_DAYS),
    });
    if(reserved.id && reserved.subscription_id) {
      // Supabase token reservation is itself durable recovery evidence if D1/Queue is unavailable.
      try {
        await addJob(env,`confirmation:${reserved.id}`,'confirmation_email',
          {generation:reserved.id,subscription_id:reserved.subscription_id});
        await queueJob(env,`confirmation:${reserved.id}`);
      } catch { /* Scheduler recreates missing confirmation work from unexpired token generations. */ }
    }
    return json(neutral);
  }
  if(!['/confirm','/manage','/manage/update','/unsubscribe'].includes(path)) throw new HttpError(404,'not_found');
  if(typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token)) throw new HttpError(400,'invalid_link');
  if(path==='/manage/update') preference(body);
  const action=({'/confirm':'confirm','/manage':'manage_get','/manage/update':'manage_update',
    '/unsubscribe':'unsubscribe'} as Record<string,string>)[path]!;
  const result=await rpc<{ok?:boolean}>(env,action,{token_hash:await hash(body.token),
    ...(path==='/manage/update'?{delivery_mode:body.delivery_mode,daily_time_local:body.daily_time_local??'08:00'}:{})});
  if(!result.ok) throw new HttpError(400,'link_expired_or_invalid');
  return json(result);
}
