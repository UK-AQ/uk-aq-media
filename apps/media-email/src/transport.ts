import { boundedBody, type Env, type Transport } from './common';
import { fallbackRequest, serialize, type Submission } from './message';
import { result, smtpSubmit, type Outcome, type Result } from './smtp';
import { classifyDefiniteProRejection } from './transport-policy';

const outcomes=new Set(['accepted','temporary_failure','permanent_failure','unknown']);
export function fallbackEndpoint(env:Env,path:'/send'|'/receipt'):URL {
  if(!env.NEWS_EMAIL_SENDER_URL || !env.NEWS_EMAIL_SENDER_SECRET || env.NEWS_EMAIL_SENDER_SECRET.length<32)
    throw new Error('fallback_not_configured');
  const url=new URL(env.NEWS_EMAIL_SENDER_URL);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/send')
    throw new Error('fallback_not_configured');
  return new URL(path,url);
}
async function proRequest(env:Env,url:URL,body:string,allowDefiniteRejection=false):Promise<Outcome> {
  const response=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(45000),
    headers:{Authorization:`Bearer ${env.NEWS_EMAIL_SENDER_SECRET}`,'Content-Type':'application/json'},body});
  const data=JSON.parse(await boundedBody(response,4096)) as {outcome?:unknown;error?:unknown};
  if(!response.ok) return allowDefiniteRejection?
    classifyDefiniteProRejection(response.status,data?.error)??'unknown':'unknown';
  return typeof data?.outcome==='string' && outcomes.has(data.outcome)?data.outcome as Outcome:'unknown';
}
export async function proReceipt(env:Env,messageId:string):Promise<Outcome> {
  const url=fallbackEndpoint(env,'/receipt');
  try { return await proRequest(env,url,JSON.stringify({message_id:messageId})); }
  catch { return 'unknown'; }
}
export async function submit(env:Env,transport:Transport,message:Submission,beforeSubmit:()=>Promise<void>):Promise<Result> {
  let wire:string;
  try { wire=serialize(env,message); }
  catch { return result('permanent_failure','invalid_news_message'); }
  if(transport==='cloudflare_xoauth2') return smtpSubmit(env,message.to,wire,beforeSubmit);
  if(transport!=='pro_app_password') return result('permanent_failure','invalid_transport');
  let url:URL;
  try { url=fallbackEndpoint(env,'/send'); }
  catch { return result('permanent_failure','fallback_not_configured'); }
  // serialize already bounded the complete MIME and this exact JSON envelope.
  const body=fallbackRequest(message);
  try { await beforeSubmit(); }
  catch { return result('temporary_failure','submission_claim_unavailable'); }
  // The HTTP request may reach Pro SMTP even when no HTTP receipt comes back.
  // Unclassified HTTP failures, malformed replies and transport errors remain unknown.
  try {
    const outcome=await proRequest(env,url,body,true);
    return result(outcome,outcome==='accepted'?null:`fallback_${outcome}`);
  } catch { return result('unknown','fallback_acceptance_unknown'); }
}
