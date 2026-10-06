import { connect } from 'cloudflare:sockets';
import { Buffer } from 'node:buffer';
import { boundedBody, encoder, type Env } from './common';

export type Outcome = 'accepted'|'temporary_failure'|'permanent_failure'|'unknown';
export interface Result { outcome:Outcome; error:string|null }
export const result = (outcome:Outcome,error:string|null=null):Result => ({outcome,error});
class Failure extends Error {
  constructor(readonly outcome:Outcome,code:string) { super(code); }
}

async function accessToken(env:Env):Promise<string> {
  if(!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN ||
    !env.GOOGLE_SMTP_USERNAME || /[\s\x00-\x1f\x7f]/.test(env.GOOGLE_SMTP_USERNAME) ||
    env.GOOGLE_SMTP_USERNAME.length>254) throw new Failure('permanent_failure','oauth_configuration_invalid');
  try {
    // The offline refresh token must have been provisioned for https://mail.google.com/.
    // Access tokens exist only in this invocation's memory, never in durable state.
    const response=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',client_id:env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret:env.GOOGLE_OAUTH_CLIENT_SECRET,refresh_token:env.GOOGLE_OAUTH_REFRESH_TOKEN}),
    });
    if(response.status===408 || response.status===429 || response.status>=500)
      throw new Failure('temporary_failure','oauth_refresh_unavailable');
    // Invalid/revoked credentials and redirects fail closed. Do not store Google's body.
    if(!response.ok) {
      // OAuth may return a transient protocol error even with an HTTP 400 status.
      let providerError:unknown;
      try { providerError=(JSON.parse(await boundedBody(response,16384)) as {error?:unknown})?.error; }
      catch { /* Non-JSON rejection remains a definite configuration failure. */ }
      if(providerError==='temporarily_unavailable' || providerError==='server_error')
        throw new Failure('temporary_failure','oauth_refresh_unavailable');
      throw new Failure('permanent_failure','oauth_configuration_rejected');
    }
    const data=JSON.parse(await boundedBody(response,16384)) as Record<string,unknown>;
    if(typeof data.access_token!=='string' || !data.access_token || data.access_token.length>8192 ||
      /[\s\x00-\x1f\x7f]/.test(data.access_token) || data.token_type!=='Bearer' ||
      typeof data.expires_in!=='number' || data.expires_in<=0)
      throw new Failure('temporary_failure','oauth_refresh_invalid_response');
    if(typeof data.scope==='string' && !data.scope.split(' ').includes('https://mail.google.com/'))
      throw new Failure('permanent_failure','oauth_scope_invalid');
    return data.access_token;
  } catch(error) {
    if(error instanceof Failure) throw error;
    throw new Failure('temporary_failure','oauth_refresh_unavailable');
  }
}

interface Reply { code:number; lines:string[] }
class Session {
  private socket:Socket;
  private reader:ReadableStreamDefaultReader<Uint8Array>;
  private writer:WritableStreamDefaultWriter<Uint8Array>;
  private buffer='';
  private decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  private expired=false;
  private deadline:Promise<never>;
  private timer!:ReturnType<typeof setTimeout>;
  constructor() {
    this.socket=connect({hostname:'smtp-relay.gmail.com',port:587},{secureTransport:'starttls',allowHalfOpen:false});
    this.reader=this.socket.readable.getReader(); this.writer=this.socket.writable.getWriter();
    this.observeSocket();
    this.deadline=new Promise((_,reject)=>{
      this.timer=setTimeout(()=>{
        this.expired=true; reject(new Error('smtp_timeout')); this.close();
      },60000);
    });
    // The deadline can fire while the durable pre-submission marker is being saved.
    void this.deadline.catch(()=>{});
  }
  private observeSocket():void {
    void this.socket.closed.catch(()=>{}); void this.socket.opened.catch(()=>{});
  }
  assertOpen():void { if(this.expired) throw new Error('smtp_timeout'); }
  async wait<T>(operation:Promise<T>):Promise<T> { this.assertOpen(); return Promise.race([operation,this.deadline]); }
  async write(value:string):Promise<void> { this.assertOpen(); await this.wait(this.writer.write(encoder.encode(value))); }
  async reply():Promise<Reply> {
    const lines:string[]=[]; let code:number|undefined; let size=0;
    while(lines.length<100) {
      let end=this.buffer.indexOf('\r\n');
      while(end<0) {
        if(this.buffer.length>1000) throw new Error('smtp_reply_invalid');
        const chunk=await this.wait(this.reader.read());
        if(chunk.done) throw new Error('smtp_disconnected');
        this.buffer+=this.decoder.decode(chunk.value,{stream:true});
        if(this.buffer.length>16384) throw new Error('smtp_reply_invalid');
        end=this.buffer.indexOf('\r\n');
      }
      const line=this.buffer.slice(0,end); this.buffer=this.buffer.slice(end+2);
      size+=line.length+2;
      const match=/^([2-5][0-9]{2})(?:([- ])([^\r\n]*))?$/.exec(line);
      if(!match || line.length>1000 || size>16384) throw new Error('smtp_reply_invalid');
      const next=Number(match[1]);
      if(code!==undefined && next!==code) throw new Error('smtp_reply_invalid');
      code=next; lines.push(match[3]??'');
      if(match[2]!=='-') return {code,lines};
    }
    throw new Error('smtp_reply_invalid');
  }
  async command(command:string):Promise<Reply> { await this.write(`${command}\r\n`); return this.reply(); }
  upgrade():void {
    this.assertOpen();
    if(this.buffer) throw new Error('smtp_reply_invalid');
    this.reader.releaseLock(); this.writer.releaseLock();
    this.socket=this.socket.startTls({expectedServerHostname:'smtp-relay.gmail.com'});
    this.reader=this.socket.readable.getReader(); this.writer=this.socket.writable.getWriter();
    this.decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}); this.observeSocket();
  }
  close():void { try { void this.socket.close().catch(()=>{}); } catch { /* best effort */ } }
  finish():void { clearTimeout(this.timer); this.close(); }
  async quit():Promise<void> {
    // A failed/delayed QUIT cannot change a definite final DATA outcome.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { await Promise.race([this.command('QUIT'),new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]); }
    catch { /* best effort only */ }
    finally { clearTimeout(timer); }
  }
}
function expect(reply:Reply,codes:number[],error:string):Reply {
  if(codes.includes(reply.code)) return reply;
  if(reply.code>=400 && reply.code<500) throw new Failure('temporary_failure',error);
  if(reply.code>=500) throw new Failure('permanent_failure',error);
  throw new Error('smtp_reply_unexpected');
}

export async function smtpSubmit(env:Env,to:string,wire:string,beforeSubmit:()=>Promise<void>):Promise<Result> {
  let access:string;
  try { access=await accessToken(env); }
  catch(error) { return error instanceof Failure?result(error.outcome,error.message):result('temporary_failure','oauth_refresh_unavailable'); }
  let session:Session|undefined; let uncertain=false;
  try {
    session=new Session();
    expect(await session.reply(),[220],'smtp_greeting_rejected');
    const hello=expect(await session.command('EHLO ukaq.co.uk'),[250],'smtp_ehlo_rejected');
    if(!hello.lines.some(line=>/^STARTTLS(?: |$)/i.test(line)))
      throw new Failure('permanent_failure','smtp_starttls_required');
    expect(await session.command('STARTTLS'),[220],'smtp_starttls_rejected');
    session.upgrade();
    const secureHello=expect(await session.command('EHLO ukaq.co.uk'),[250],'smtp_ehlo_rejected');
    if(!secureHello.lines.some(line=>/^AUTH[ =].*\bXOAUTH2\b/i.test(line)))
      throw new Failure('permanent_failure','smtp_xoauth2_required');
    const sasl=Buffer.from(`user=${env.GOOGLE_SMTP_USERNAME}\x01auth=Bearer ${access}\x01\x01`,'utf8').toString('base64');
    let auth=await session.command(`AUTH XOAUTH2 ${sasl}`);
    // Google uses a 334 challenge for OAuth errors; terminate it without logging it.
    if(auth.code===334) auth=await session.command('');
    expect(auth,[235],'smtp_auth_rejected');
    expect(await session.command('MAIL FROM:<news@ukaq.co.uk>'),[250],'smtp_envelope_rejected');
    expect(await session.command(`RCPT TO:<${to}>`),[250,251],'smtp_recipient_rejected');
    expect(await session.command('DATA'),[354],'smtp_data_rejected');
    await beforeSubmit(); // Durable ambiguity marker precedes every possibly accepted body.
    session.assertOpen();
    const body=wire.replace(/\r\n|\r|\n/g,'\r\n').replace(/(^|\r\n)\./g,'$1..');
    uncertain=true;
    await session.write(`${body.endsWith('\r\n')?body:`${body}\r\n`}.\r\n`);
    const final=await session.reply();
    let outcome:Result;
    if(final.code>=200 && final.code<300) outcome=result('accepted');
    else if(final.code>=400 && final.code<500) outcome=result('temporary_failure','smtp_data_rejected');
    else if(final.code>=500) outcome=result('permanent_failure','smtp_data_rejected');
    else return result('unknown','smtp_acceptance_unknown');
    await session.quit();
    return outcome;
  } catch(error) {
    if(error instanceof Failure) return result(error.outcome,error.message);
    return uncertain?result('unknown','smtp_acceptance_unknown'):result('temporary_failure','smtp_pre_submission_failure');
  } finally { session?.finish(); }
}
