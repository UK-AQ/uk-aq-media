import { Buffer } from 'node:buffer';
import { encoder, type Delivery, type Env } from './common';
import { normalizeSupportedMailbox } from './mailbox';
import { inlineBranding } from './branding';

export interface Message { kind:string; text:string; html:string; manage_url?:string; unsubscribe_url?:string }
export interface Submission extends Message { to:string; message_id:string; date:string }
const subjects:Record<string,string> = {
  confirmation:'Confirm your AQ in the News subscription',
  immediate:'AQ in the News: New article', daily:'Your daily AQ in the News update',
};
export const MAX_MIME_BYTES=250000;
export const MAX_FALLBACK_REQUEST_BYTES=200000;
export class MessageSizeError extends Error {
  constructor() { super('news_message_too_large'); }
}

export function submission(delivery:Delivery,recipient:string,message:Message):Submission {
  return {...message,to:recipient,message_id:delivery.message_id,date:delivery.created_at};
}

const crlf = (value:string):string => value.replace(/\r\n|\r|\n/g,'\r\n');
function base64Part(type:string,value:string):string {
  const body=Buffer.from(crlf(value),'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  return `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`;
}
export function fallbackRequest(message:Submission):string {
  const body=JSON.stringify(message);
  if(encoder.encode(body).length>MAX_FALLBACK_REQUEST_BYTES) throw new MessageSizeError();
  return body;
}

// Fixed ASCII headers; all editorial UTF-8 appears only in base64 MIME bodies.
// Alternative plain text / related HTML keeps branding attached to the HTML part.
export function serialize(env:Env,message:Submission):string {
  if(!normalizeSupportedMailbox(message.to)) throw new Error('invalid_news_message');
  const subject=Object.hasOwn(subjects,message.kind)?subjects[message.kind]:undefined;
  const date=new Date(message.date);
  if(!subject || !/^<news\.[a-f0-9]{64}@ukaq\.co\.uk>$/.test(message.message_id) ||
    !Number.isFinite(date.getTime()) || !message.text.startsWith('AQ in the News\n') ||
    !message.html.startsWith('<!doctype html>') || !message.html.includes('AQ in the News'))
    throw new Error('invalid_news_message');
  if(encoder.encode(message.text).length>180000 || encoder.encode(message.html).length>200000)
    throw new MessageSizeError();
  // Bound every message to the optional fallback's existing JSON request envelope.
  fallbackRequest(message);
  const identity=message.message_id.slice(6,46);
  const alternative=`news-alt-${identity}`, related=`news-related-${identity}`;
  const headers=[
    'From: UK AQ News <news@ukaq.co.uk>', 'Reply-To: news@ukaq.co.uk',
    `To: <${message.to}>`, `Subject: ${subject}`,
    `Date: ${date.toUTCString().replace('GMT','+0000')}`, `Message-ID: ${message.message_id}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative;\r\n boundary="${alternative}"`,
  ];
  if(message.kind!=='confirmation') {
    for(const [purpose,link] of [['manage',message.manage_url],['unsubscribe',message.unsubscribe_url]]) {
      const prefix=`${env.NEWS_EMAIL_SITE_ORIGIN}/news/#${purpose}=`;
      if(!link?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(link.slice(prefix.length)) ||
        !message.text.includes(link) || !message.html.includes(`href="${link}"`))
        throw new Error('invalid_news_message');
    }
    const api=new URL(env.NEWS_EMAIL_PUBLIC_API_ORIGIN);
    if(api.protocol!=='https:' || api.origin!==env.NEWS_EMAIL_PUBLIC_API_ORIGIN)
      throw new Error('invalid_news_message');
    const token=message.unsubscribe_url!.split('=')[1]!;
    headers.push(`List-Unsubscribe: <${api.origin}/one-click/${token}>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  let html=message.html;
  const images=inlineBranding.map(asset=>{
    if(!message.html.includes(`src="cid:${asset.content_id}"`)) throw new Error('invalid_news_message');
    const cid=asset.content_id.replace('@',`.${message.message_id.slice(6,70)}@`);
    html=html.replaceAll(`cid:${asset.content_id}`,`cid:${cid}`);
    return `--${related}\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${cid}>\r\nContent-Disposition: inline;\r\n filename="${asset.filename}"\r\n\r\n${asset.base64.match(/.{1,76}/g)!.join('\r\n')}\r\n`;
  }).join('');
  const wire=`${headers.join('\r\n')}\r\n\r\n--${alternative}\r\n${base64Part('text/plain',message.text)}--${alternative}\r\nContent-Type: multipart/related; type="text/html";\r\n boundary="${related}"\r\n\r\n--${related}\r\n${base64Part('text/html',html)}${images}--${related}--\r\n--${alternative}--\r\n`;
  if(encoder.encode(wire).length>MAX_MIME_BYTES) throw new MessageSizeError();
  return wire;
}
